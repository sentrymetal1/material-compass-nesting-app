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
const { jointHours } = require('./pipeJoint');
const { toNumber, rolledShapeLbPerFt, plateLbPerSqFt } = require('../weights');

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

// Weight of the whole row for ONE unit of the component, or null. Rolled shapes state their weight
// in their name; plate follows from thickness and area. Anything else is left for the catalog.
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
  const lbFt = rolledShapeLbPerFt(row.size);
  return lbFt && len > 0 ? lbFt * len * qty : null;
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

  if (form === 'Beam' || form === 'Channel' || form === 'Tee' || form === 'Angle') {
    const found = resolve({ category: 'Assembly', operation: c.memberMethod, form, material,
      size: { 'Member Depth (in)': memberDepth(row.size) } }, { overrides });
    if (found.missing) out.missing.push({ what: label, reason: found.missing });
    else out.lines.push(line(found.bucket, found.row.hours * qty, found, qty, 'pcs', 'cut, fit & weld ' + label));
  } else if (form === 'Plate') {
    const len = toNumber(row.length_ft), w = toNumber(row.width_ft);
    const t = toNumber(row.size);
    if (!(len > 0) || !(w > 0) || !(t > 0)) {
      out.missing.push({ what: label, reason: 'plate needs thickness, length and width to price the burning' });
    } else {
      const perimeter = 2 * (len + w) * qty;
      const found = resolve({ category: 'Cutting', operation: c.plateCutOperation, process: c.plateCutProcess,
        form, material, size: { 'Plate Thickness (in)': t } }, { overrides });
      if (found.missing) out.missing.push({ what: label, reason: found.missing });
      else out.lines.push(line(found.bucket, found.row.hours * perimeter, found, perimeter, 'ft of cut', 'burn ' + label));
    }
    out.missing.push({ what: label, reason: 'plate fit & weld not estimated — needs weld length, which the take-off does not measure' });
  } else {
    out.missing.push({ what: label, reason: 'no count-driven labour standard for ' + (row.form_type || 'this form') + ' yet' });
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
  if (end.indexOf('butt') < 0) {
    out.missing.push({ what: label, reason: (f.end_type || 'unstated end type') + ' joint hours are not in the library yet' });
    return out;
  }
  const ends = WELD_ENDS[String(f.fitting_type || '').trim()];
  if (!ends) { out.missing.push({ what: label, reason: 'unknown number of weld ends for ' + f.fitting_type }); return out; }
  // A reducer's two ends are different sizes; the larger governs, as it does for the weight.
  const size = String(f.size || '').split(/\s*x\s*/i)[0];
  const j = jointHours(size, f.schedule_or_class, ctx && ctx.pipeAnchors);
  if (j.missing) { out.missing.push({ what: label, reason: j.missing }); return out; }
  const joints = ends * qty;
  out.lines.push({
    bucket: 'Weld_Hrs', hours: j.hours * joints, what: 'butt-weld ' + joints + ' joint(s) ' + label,
    standard: 'PIPE-JOINT', operation: 'Pipe butt weld per joint', source: 'Shop Anchor', source_ref: j.basis,
    per_unit: j.hours, unit_basis: 'Hr/Joint', units: joints, unit_label: 'joints', note: j.note,
  });
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
