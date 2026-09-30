// =============================================================================
//  labor/estimate.js — suggested shop hours for a take-off, per component.
// -----------------------------------------------------------------------------
//  Input is what the take-off already produces: BOM rows (form, size, length,
//  quantity, component) and fitting rows. Output is hours in the 8 labour
//  buckets per component, where EVERY hour names the standard it came from, and
//  every piece of work that could not be estimated is listed as missing.
//
//  WHAT v1 ESTIMATES, AND WHY ONLY THIS
//  Only work driven by things the take-off counts deterministically — pieces,
//  lengths, plate size, weight, fitting ends. It does NOT invent weld lengths:
//  the drawings rarely state them and an AI guess at one would be presented as
//  a number (see the AI-counts-need-an-anchor rule). So:
//    rolled members (beam/channel/tee/angle) — "welded frame member, square
//        cut and welded all around", per piece, banded by depth (Sentry 1997).
//        That is cut + fit + weld in ONE figure, so it lands in Assy_Hrs;
//    plate — burning the perimeter, per piece, banded by thickness;
//    every row with a weight — unloading, storing and loading out, per ton;
//    butt-weld fittings — one joint per weld end, hours from the SHOP's
//        reference joints (pipeJoint.js).
//  Plate fit/weld, tube, bar and pipe members have no count-driven standard
//  yet and come back as missing, never as zero.
//
//  UNITS: hours are per ONE unit of the component, the same convention as the
//  take-off's quantities. Multiplying up to the job is done downstream.
// =============================================================================
const { resolve, libraryForm, libraryMaterial, BUCKETS } = require('./standards');
const { jointHours, pipeDims } = require('./pipeJoint');
const { weldHoursPerFt } = require('./weldTime');
const { toNumber, rolledShapeLbPerFt, plateLbPerSqFt, structuralLbPerFt, pipeSectionLbPerIn } = require('../weights');

// The Sentry frame-member rows are written for welded skid/frame work — the bulk of this shop's
// jobs. A bolted building frame would use the 'Framed member complete' rows instead; that choice
// belongs to the shop form, so it is a setting here rather than a guess.
const DEFAULTS = {
  memberMethod: /^Welded frame member - square cut and welded all around$/,
  plateCutProcess: 'Oxy-Fuel',
  plateCutOperation: 'Flame cut square',
};

// 'W12 x 26' -> 12, 'C10 x 15.3' -> 10, 'MC8 x 20' -> 8, 'C 12 x 8.274' -> 12.
function memberDepth(size) {
  const m = String(size || '').trim().match(/^[A-Z]+\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

// The numbers in a size, in order: 'L3 x 3 x 1/4' -> [3, 3, 0.25], 'HSS4x2x3/8' -> [4, 2, 0.375].
function sizeNumbers(size) {
  return String(size || '').replace(/^[A-Za-z]+\s*/, '').replace(/["”]/g, '')
    .split(/\s*[xX×]\s*/).map((s) => toNumber(s.trim())).filter((n) => n > 0);
}

// lb/ft for sections whose name does not carry their weight: angle, tube, bar, pipe.
// Geometry from weights.js, so a take-off weighs these the same way the catalog does.
function sectionLbPerFt(formType, size, material) {
  const f = String(formType || '').toLowerCase();
  const n = sizeNumbers(size);
  if (/pipe/.test(f)) {
    const m = String(size || '').match(/^\s*([\d\-\/]+)"?\s*(.*)$/);
    const d = m && pipeDims(m[1] + '"', m[2] || 'STD');
    return d ? pipeSectionLbPerIn(d.od, d.wall, material) * 12 : null;
  }
  if (/angle/.test(f) || /^\s*L\s*\d/i.test(String(size))) {
    if (n.length === 3) return structuralLbPerFt('angle', n, material);
    if (n.length === 2) return structuralLbPerFt('angle', [n[0], n[0], n[1]], material);
    return null;
  }
  if (/tube|hss/.test(f)) {
    if (/round/.test(f)) return n.length === 2 ? structuralLbPerFt('tube_round', n, material) : null;
    if (n.length === 3) return structuralLbPerFt('tube_rect', n, material);
    if (n.length === 2) return structuralLbPerFt('tube_rect', [n[0], n[0], n[1]], material);
    return null;
  }
  if (/bar/.test(f)) {
    if (/round/.test(f)) return n.length ? structuralLbPerFt('bar_round', [n[0]], material) : null;
    if (/square/.test(f)) return n.length ? structuralLbPerFt('bar_square', [n[0]], material) : null;
    if (/hex/.test(f)) return n.length ? structuralLbPerFt('bar_hex', [n[0]], material) : null;
    return n.length === 2 ? structuralLbPerFt('bar_flat', n, material) : null;
  }
  return null;
}

// Weight of the whole row for ONE unit of the component, or null. Rolled shapes state their weight
// in their name; angle, tube, bar and pipe follow from their section; plate from thickness and area.
function rowPounds(row) {
  const qty = toNumber(row.quantity);
  const len = toNumber(row.length_ft);
  if (!(qty > 0)) return null;
  const form = libraryForm(row.form_type);
  if (form === 'Plate') {
    const w = toNumber(row.width_ft);
    const perSqFt = plateLbPerSqFt(row.size, row.material_type);
    return perSqFt && len > 0 && w > 0 ? perSqFt * len * w * qty : null;
  }
  const lbFt = rolledShapeLbPerFt(row.size) || sectionLbPerFt(row.form_type, row.size, row.material_type);
  return lbFt && len > 0 ? lbFt * len * qty : null;
}

// Depth that bands a member: the depth in the name for rolled shapes, else the first dimension
// (tube height, bar width, pipe NPS).
function bandDepth(size) {
  return memberDepth(size) || sizeNumbers(size)[0] || null;
}

// A member priced from the welded-frame rows. Forms with no row of their own (tube, bar, pipe) use
// the Channel rows at the same depth; anything below the smallest channel band uses the Angle row.
// Both are Sentry 1997 "square cut and welded all around", and the line says which row stood in.
function frameMember(form, material, depth, c, overrides) {
  const q = (f) => resolve({ category: 'Assembly', operation: c.memberMethod, form: f, material,
    size: { 'Member Depth (in)': depth } }, { overrides });
  const own = ['Beam', 'Channel', 'Tee', 'Angle'].indexOf(form) > -1;
  let found = own ? q(form) : { missing: 'no row' };
  let proxy = null;
  if (found.missing && !own) { found = q('Channel'); proxy = 'Channel'; }
  if (found.missing) {
    const a = resolve({ category: 'Assembly', operation: /^Welded frame member - square cut and welded all around$/, form: 'Angle', material }, { overrides });
    if (a.row) { found = a; proxy = 'Angle'; }
  }
  return { found, proxy };
}

function line(bucket, hours, found, units, unitLabel, what) {
  return {
    bucket, hours,
    what,
    standard: found.row.code,
    operation: found.row.operation,
    source: found.row.source,
    source_ref: found.row.sourceRef,
    per_unit: found.row.hours,
    unit_basis: found.row.unitBasis,
    units, unit_label: unitLabel,
  };
}

// One BOM row -> { lines, missing }.
function estimateRow(row, ctx) {
  const c = Object.assign({}, DEFAULTS, ctx || {});
  const out = { lines: [], missing: [] };
  const disp = String(row.disposition || 'fabricate').toLowerCase();
  if (disp !== 'fabricate') return out;                 // bought complete or by others — not our hours

  const form = libraryForm(row.form_type);
  const material = libraryMaterial(row.material_type, row.specification);
  const qty = toNumber(row.quantity);
  const label = [row.form_type, row.size, row.member_mark].filter(Boolean).join(' ');
  if (!(qty > 0)) { out.missing.push({ what: label, reason: 'no quantity' }); return out; }
  const overrides = c.overrides;

  if (form !== 'Plate') {
    const { found, proxy } = frameMember(form, material, bandDepth(row.size), c, overrides);
    if (found.missing) out.missing.push({ what: label, reason: found.missing });
    else {
      const l = line(found.bucket, found.row.hours * qty, found, qty, 'pcs', 'cut, fit & weld ' + label);
      if (proxy) { l.derived = true; l.note = 'no row for ' + (row.form_type || 'this form') + ' — ' + proxy + ' welded-frame rate applied'; }
      out.lines.push(l);
    }
  } else {
    const len = toNumber(row.length_ft), w = toNumber(row.width_ft);
    const t = toNumber(row.size);
    if (!(len > 0) || !(w > 0) || !(t > 0)) {
      out.missing.push({ what: label, reason: 'plate needs thickness, length and width to price the burning' });
    } else {
      const perimeter = 2 * (len + w) * qty;
      let found = resolve({ category: 'Cutting', operation: c.plateCutOperation, process: c.plateCutProcess,
        form, material, size: { 'Plate Thickness (in)': t } }, { overrides });
      let fallback = false;
      // The plasma row stops short of heavy plate; burn that with the flame-cut row for its thickness.
      if (found.missing && c.plateCutProcess !== 'Oxy-Fuel') {
        const f = resolve({ category: 'Cutting', operation: 'Flame cut square', process: 'Oxy-Fuel',
          form, material, size: { 'Plate Thickness (in)': t } }, { overrides });
        if (f.row) { found = f; fallback = true; }
      }
      if (found.missing) out.missing.push({ what: label, reason: found.missing });
      else {
        const l = line(found.bucket, found.row.hours * perimeter, found, perimeter, 'ft of cut', 'burn ' + label);
        if (fallback) { l.derived = true; l.note = c.plateCutProcess + ' row does not cover ' + row.size + ' — flame-cut rate applied'; }
        out.lines.push(l);
      }
    }
    // Fit & weld. The take-off does not measure weld length, so this ASSUMES each plate is fitted
    // once and intermittently welded along its full perimeter, fillet sized to the plate (3/16"
    // up to 3/8" from 1/2" plate on). Both rows are library rows; the assumption is on the line.
    if (len > 0 && w > 0 && t > 0) {
      const fit = resolve({ category: 'Fitup', operation: /^Fitting and tacking clips$/ }, { overrides });
      if (fit.row) {
        const l = line(fit.bucket, fit.row.hours * qty, fit, qty, 'pcs', 'fit & tack ' + label);
        l.derived = true; l.note = 'clip fit-up rate applied per plate';
        out.lines.push(l);
      }
      const leg = Math.min(0.75, Math.max(0.1875, t >= 0.5 ? 0.375 : t));
      const weld = resolve({ category: 'Welding', operation: /^Fillet weld intermittent - clips base plates gussets$/,
        size: { 'Weld Size (in)': leg } }, { overrides });
      if (weld.row) {
        const ft = 2 * (len + w) * qty;
        const l = line(weld.bucket, weld.row.hours * ft, weld, ft, 'ft of weld', 'weld ' + label);
        l.derived = true; l.note = 'assumes intermittent fillet along the full perimeter — check';
        out.lines.push(l);
      } else out.missing.push({ what: label, reason: 'no fillet weld row for ' + leg + '" — plate weld not estimated' });
    }
  }

  // Handling applies to everything we fabricate, by weight.
  const lb = rowPounds(row);
  if (lb == null) {
    out.missing.push({ what: label, reason: 'weight unknown, so handling (per ton) not estimated' });
  } else {
    const found = resolve({ category: 'Handling', form, material }, { overrides });
    if (found.missing) out.missing.push({ what: label, reason: found.missing });
    else out.lines.push(line(found.bucket, found.row.hours * lb / 2000, found, lb / 2000, 'tons', 'handle ' + label));
  }
  return out;
}

// How many weld ends a butt-weld fitting brings to a spool. Counted per fitting, so a fitting welded
// straight to another fitting is counted twice — stated on the result, and small against the
// uncertainty of the anchors themselves.
const WELD_ENDS = { 'Elbow': 2, 'Tee': 3, 'Cross': 4, 'Reducer': 2, 'Cap': 1, 'Stub End': 1,
  'Coupling': 2, 'Lateral / Y': 3, 'Swage Nipple': 2 };

function estimateFitting(f, ctx) {
  const out = { lines: [], missing: [] };
  const qty = toNumber(f.quantity);
  const label = [f.size, f.schedule_or_class, f.fitting_type].filter(Boolean).join(' ');
  if (!(qty > 0)) { out.missing.push({ what: label, reason: 'no quantity' }); return out; }
  const end = String(f.end_type || '').toLowerCase();
  const butt = end.indexOf('butt') > -1, socket = end.indexOf('socket') > -1;
  if (!butt && !socket) {
    out.missing.push({ what: label, reason: (f.end_type || 'unstated end type') + ' joint hours are not in the library yet' });
    return out;
  }
  const ends = WELD_ENDS[String(f.fitting_type || '').trim()];
  if (!ends) { out.missing.push({ what: label, reason: 'unknown number of weld ends for ' + f.fitting_type }); return out; }
  // A reducer's two ends are different sizes; the larger governs, as it does for the weight.
  const size = String(f.size || '').split(/\s*x\s*/i)[0];
  const joints = ends * qty;
  const push = (hrs, standard, operation, source, ref, note, derived) => out.lines.push({
    bucket: 'Weld_Hrs', hours: hrs * joints, what: (socket ? 'socket-weld ' : 'butt-weld ') + joints + ' joint(s) ' + label,
    standard, operation, source, source_ref: ref, per_unit: hrs, unit_basis: 'Hr/Joint', units: joints,
    unit_label: 'joints', note, derived: !!derived,
  });

  if (butt) {
    const j = jointHours(size, f.schedule_or_class, ctx && ctx.pipeAnchors);
    if (!j.missing) { push(j.hours, 'PIPE-JOINT', 'Pipe butt weld per joint', 'Shop Anchor', j.basis, j.note); return out; }
  }
  // No reference joint from the shop (or a socket weld): the Lincoln method on the joint itself.
  // Butt: single-V groove through the wall, all the way round. Socket: fillet round the pipe OD,
  // leg ~1.25 × wall (B31.3 minimum), 1/8" to 3/8". Horizontal position factor, between rolled and
  // fixed pipe. Uses the shop's own weld settings when it has them.
  const d = pipeDims(size, f.schedule_or_class || 'STD');
  if (!d) { out.missing.push({ what: label, reason: 'pipe size/schedule not recognised, so the joint cannot be sized' }); return out; }
  const weld = butt
    ? { kind: 'groove', size: d.wall, position: 'horizontal' }
    : { kind: 'fillet', size: Math.min(0.375, Math.max(0.125, Math.round(d.wall * 1.25 * 16) / 16)), position: 'horizontal' };
  const w = weldHoursPerFt(weld, ctx && ctx.weldSettings);
  if (w.missing) { out.missing.push({ what: label, reason: w.missing }); return out; }
  const circFt = Math.PI * d.od / 12;
  push(w.hours_per_ft * circFt, 'LINCOLN-' + (butt ? 'GROOVE' : 'FILLET'), (butt ? 'Pipe butt weld' : 'Socket weld') + ' per joint — weld-time method',
    w.source === 'yours' ? 'Shop Settings' : 'Derived', w.basis.join('; ') + '; × ' + circFt.toFixed(2) + ' ft round',
    butt ? 'no reference joint in shop setup — enter one to replace this' : null, true);
  return out;
}

// The whole take-off -> hours per component.
//   takeoff = { rows: [...BOM rows], fittings: [...fitting rows] }
//   ctx = { overrides, pipeAnchors, memberMethod, plateCutProcess, plateCutOperation }
function estimateTakeoff(takeoff, ctx) {
  const components = {};
  const bucketFor = (name) => {
    const key = String(name || '').trim() || '(no component)';
    if (!components[key]) {
      components[key] = { hours: Object.fromEntries(BUCKETS.map((b) => [b, 0])), lines: [], missing: [] };
    }
    return components[key];
  };
  // A component made only of buyout / by-others rows has no shop hours and does not appear at all.
  const add = (name, res) => {
    if (!res.lines.length && !res.missing.length) return;
    const comp = bucketFor(name);
    for (const l of res.lines) { comp.hours[l.bucket] += l.hours; comp.lines.push(l); }
    comp.missing.push(...res.missing);
  };
  for (const row of (takeoff && takeoff.rows) || []) add(row.component, estimateRow(row, ctx));
  for (const f of (takeoff && takeoff.fittings) || []) add(f.component, estimateFitting(f, ctx));

  let total = 0, missing = 0;
  for (const comp of Object.values(components)) {
    for (const b of BUCKETS) comp.hours[b] = Math.round(comp.hours[b] * 100) / 100;
    comp.total = Math.round(BUCKETS.reduce((s, b) => s + comp.hours[b], 0) * 100) / 100;
    total += comp.total; missing += comp.missing.length;
  }
  return { components, total_hours: Math.round(total * 100) / 100, missing_count: missing, per: 'one unit of each component' };
}

module.exports = { estimateTakeoff, estimateRow, estimateFitting, memberDepth, rowPounds, WELD_ENDS, DEFAULTS };
