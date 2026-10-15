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
//
// Carbon steel at library defaults gives the same TOTAL as before (2026-10-14); what changed is
// that the work is split by what it is, and scaled for any other material or process:
//   members — Sentry's "square cut and welded all around" rate (cut + fit + weld in one number)
//             split by the shop's shares into a saw cut, a fit and a weld line, each scaled by
//             processModel.memberFactors (this material on its routed process ÷ carbon steel on
//             MIG and a band saw);
//   plate   — burning from the routed cutter's own speed at this thickness, plus pierces, plus
//             handling per cut part; fit per piece × the material's fit factor; the perimeter
//             weld at the library's carbon-steel rate × the same weld factor;
//   every row with a weight — handling per ton.
const pm = require('./processModel');
const PM_DEFAULT = pm.params({});

function modelLine(bucket, hours, units, unitLabel, what, standard, basis, note, derived) {
  return { bucket, hours, what, standard, operation: what, source: derived ? 'Derived' : 'Shop Model', source_ref: basis,
    per_unit: units > 0 ? hours / units : hours, unit_basis: 'Hr/' + unitLabel, units, unit_label: unitLabel,
    derived: !!derived, note: note || null };
}
const pct = (x) => (x >= 10 ? x.toFixed(1) : x.toFixed(2));
const procLabel = (k) => (pm.PROC[k] || { label: k }).label;

// Wall / flange / thickness that decides thin vs thick for welding a member: the last number in
// the size for angle, tube and pipe-like sizes; 1/4" when the name carries none (rolled shapes).
function memberThickness(row) {
  const n = sizeNumbers(row.size);
  if (/bar/i.test(String(row.form_type || ''))) return n.length ? Math.min.apply(null, n) : 0.25;
  return n.length >= 3 ? n[n.length - 1] : 0.25;
}

function estimateRow(row, ctx) {
  const c = Object.assign({}, DEFAULTS, ctx || {});
  const P = c.model || PM_DEFAULT;
  const out = { lines: [], missing: [] };
  const disp = String(row.disposition || 'fabricate').toLowerCase();
  if (disp !== 'fabricate') return out;                 // bought complete or by others — not our hours

  const form = libraryForm(row.form_type);
  const material = libraryMaterial(row.material_type, row.specification);
  const mat = pm.materialKey(row.material_type, row.specification);
  const matLabel = pm.MAT[mat].label.toLowerCase();
  const qty = toNumber(row.quantity);
  const label = [row.form_type, row.size, row.member_mark].filter(Boolean).join(' ');
  if (!(qty > 0)) { out.missing.push({ what: label, reason: 'no quantity' }); return out; }
  const overrides = c.overrides;
  const G = P.general;
  // Library rows are carbon steel; a stainless or aluminum row still finds its CS row and is scaled.
  const libMat = mat === 'CS' ? material : 'Carbon Steel';

  if (form !== 'Plate') {
    const { found, proxy } = frameMember(form, libMat, bandDepth(row.size), c, overrides);
    if (found.missing) { out.missing.push({ what: label, reason: found.missing }); }
    else {
      const each = found.row.hours;                      // hr per piece, cut + fit + weld, carbon steel
      const lbFt = rolledShapeLbPerFt(row.size) || sectionLbPerFt(row.form_type, row.size, row.material_type);
      const area = lbFt ? lbFt / (pm.matDensity(mat) * 12) : 0;
      const f = pm.memberFactors(P, mat, memberThickness(row), area);
      const why = (proxy ? 'no row for ' + (row.form_type || 'this form') + ' — ' + proxy + ' welded-frame rate; ' : '') +
        'Sentry "square cut and welded all around" ' + each + ' hr/pc split ' + Math.round(G.share_cut.value * 100) + '/' +
        Math.round(G.share_fit.value * 100) + '/' + Math.round(G.share_weld.value * 100) + ' cut/fit/weld';
      const part = (bucket, share, factor, verb, procKey, missingWhy) => {
        if (factor == null) { out.missing.push({ what: label, reason: missingWhy }); return; }
        const hrs = each * share * factor * qty;
        const scaled = Math.abs(factor - 1) > 1e-9;
        const note = why + (scaled ? '; × ' + pct(factor) + ' for ' + matLabel + (procKey ? ' on ' + procLabel(procKey) : '') + ' vs carbon steel on MIG / band saw' : '');
        out.lines.push(Object.assign(modelLine(bucket, hrs, qty, 'pcs', verb + ' ' + label, found.row.code, found.row.sourceRef, note,
          !!proxy || scaled), { process: procKey || null, material: mat }));
      };
      part('Cutting_Hrs', G.share_cut.value, f.cut, (f.cut_process ? procLabel(f.cut_process).toLowerCase() + ' cut' : 'cut'), f.cut_process, f.cut_missing);
      part('Assy_Hrs', G.share_fit.value, f.fit, 'fit', null, null);
      if (!scheduled(c, row)) part('Weld_Hrs', G.share_weld.value, f.weld, (f.weld_process ? procLabel(f.weld_process).split(' ')[0] + ' weld' : 'weld'), f.weld_process, f.weld_missing);
      if (f.substituted.length) out.missing.push({ what: label, reason: 'routed process not in your shop, used ' + f.substituted.join(', ') + ' — check your routing' });
    }
  } else {
    const len = toNumber(row.length_ft), w = toNumber(row.width_ft);
    const t = toNumber(row.size);
    if (!(len > 0) || !(w > 0) || !(t > 0)) {
      out.missing.push({ what: label, reason: 'plate needs thickness, length and width to price the burning' });
    } else {
      const perimFt = 2 * (len + w) * qty;
      const cp = pm.plateCutProcessFor(P, mat, t);
      if (cp.missing) out.missing.push({ what: label, reason: cp.missing });
      else {
        const r = pm.cutRate(P, mat, cp.process, t);
        if (r.missing) out.missing.push({ what: label, reason: r.missing });
        else {
          const hrs = perimFt * r.hr_per_ft + qty * r.hr_per_pierce;
          out.lines.push(Object.assign(modelLine('Cutting_Hrs', hrs, perimFt, 'ft of cut', procLabel(cp.process).split(',')[0].toLowerCase() + ' cut ' + label,
            'CUT-' + cp.process + '-' + mat, r.basis + ' + one pierce per part', cp.substituted ? 'routed ' + cp.routed + ' is not in your shop — ' + cp.process + ' used' : null,
            r.source === 'typical'), { process: cp.process, material: mat }));
          const hh = pm.cutHandlingHr(P, cp.process);
          if (hh > 0) out.lines.push(Object.assign(modelLine('Cutting_Hrs', hh * qty, qty, 'pcs', 'load, mark & unload ' + label,
            'CUT-HANDLE-' + cp.process, Math.round(hh * 60 * 10) / 10 + ' min per cut part', null, (P.cut_handling_min[cp.process] || {}).source !== 'yours'),
            { process: cp.process, material: mat }));
        }
      }
    }
    // Fit & weld. The take-off does not measure weld length, so this ASSUMES each plate is fitted
    // once and intermittently welded along its full perimeter, fillet sized to the plate (3/16"
    // up to 3/8" from 1/2" plate on). Carbon steel keeps the library row; other materials and
    // processes scale it by the weld model.
    if (len > 0 && w > 0 && t > 0) {
      const fitF = (P.fit_factor[mat] || { value: 1 }).value;
      out.lines.push(Object.assign(modelLine('Assy_Hrs', G.fit_hr_piece.value * fitF * qty, qty, 'pcs', 'fit & tack ' + label, 'FIT-CLIP-TACK',
        G.fit_hr_piece.value + ' hr/pc (' + (G.fit_hr_piece.source === 'yours' ? 'yours' : 'Sentry 1997 clip fit-up') + ')' + (fitF !== 1 ? ' × ' + fitF + ' for ' + matLabel : ''),
        'clip fit-up rate applied per plate', true), { material: mat }));
      const leg = Math.min(0.75, Math.max(0.1875, t >= 0.5 ? 0.375 : t));
      if (!scheduled(c, row)) {
      const weld = resolve({ category: 'Welding', operation: /^Fillet weld intermittent - clips base plates gussets$/,
        size: { 'Weld Size (in)': leg } }, { overrides });
      const wp = pm.weldProcessFor(P, mat, t);
      if (!weld.row) out.missing.push({ what: label, reason: 'no fillet weld row for ' + leg + '" — plate weld not estimated' });
      else if (wp.missing) out.missing.push({ what: label, reason: wp.missing });
      else {
        const mine = pm.weldHrPerFt(P, mat, wp.process, leg), base = pm.weldHrPerFt(PM_DEFAULT, 'CS', 'MIG', leg);
        const factor = mine.missing ? null : mine.value / base.value;
        if (factor == null) out.missing.push({ what: label, reason: mine.missing });
        else {
          const ft = 2 * (len + w) * qty;
          out.lines.push(Object.assign(modelLine('Weld_Hrs', weld.row.hours * factor * ft, ft, 'ft of weld',
            procLabel(wp.process).split(' ')[0] + ' weld ' + label, weld.row.code,
            weld.row.sourceRef + (Math.abs(factor - 1) > 1e-9 ? '; × ' + pct(factor) + ' (' + mine.basis + ')' : ''),
            'assumes intermittent fillet along the full perimeter — check', true), { process: wp.process, material: mat }));
        }
      }
      }
    }
  }

  // Handling applies to everything we fabricate, by weight.
  const lb = rowPounds(row);
  if (lb == null) {
    out.missing.push({ what: label, reason: 'weight unknown, so handling (per ton) not estimated' });
  } else {
    const h = G.handling_hr_ton;
    out.lines.push(Object.assign(modelLine('Labor_Hrs', h.value * lb / 2000, lb / 2000, 'tons', 'handle ' + label, 'HANDLE-TON',
      h.value + ' hr/ton (' + (h.source === 'yours' ? 'yours' : 'library') + ')', null, false), { material: mat }));
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
// ---- WELDS FROM THE DRAWINGS -----------------------------------------------------------------
// When the take-off read a drawing's weld symbols, that drawing's welding is priced from them and
// the assumed welds (a member's weld share, a plate's perimeter fillet) are dropped for its rows —
// never both. Drawings with no weld schedule keep the assumptions.
const sheetKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const scheduled = (c, row) => !!(c.weldSheets && c.weldSheets.has(sheetKey(row.source_sheet)));
const liveWeld = (w) => w && !w.deleted && Number(w.count) > 0;

// Length round a member, in inches, from its own section — the deterministic anchor for an
// all-around weld. Pipe and round bar by OD, tube, angle and flat bar by their sides. null when
// the size can't be read (rolled shapes are not measured; their weld length must be given).
function perimeterIn(member) {
  const m = String(member || '');
  const low = m.toLowerCase();
  const pipe = m.match(/(\d+-\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)"?\s*(SCH\s*\d+|STD|XXS|XS)/i);
  if (/pipe/.test(low) && pipe) {
    const sch = /^std$/i.test(pipe[2]) ? 'STD' : /^xxs$/i.test(pipe[2]) ? 'SCH 160' : /^xs$/i.test(pipe[2]) ? 'XS' : pipe[2].toUpperCase().replace(/\s+/g, ' ');
    const d = pipeDims(pipe[1] + '"', sch);
    return d ? Math.PI * d.od : null;
  }
  const sizePart = m.replace(/^[^0-9]*?(?=L?\s*\d)/i, '');
  const n = sizeNumbers(sizePart);
  if (/bar\s*-\s*round|round bar/.test(low) && n.length) return Math.PI * n[0];
  if (/bar\s*-\s*square|square bar/.test(low) && n.length) return 4 * n[0];
  if (/tube|hss/.test(low)) {
    if (/round/.test(low) && n.length) return Math.PI * n[0];
    if (n.length >= 3) return 2 * (n[0] + n[1]);
    if (n.length === 2) return 4 * n[0];
  }
  if ((/angle/.test(low) || /\bL\s*\d/.test(m)) && n.length >= 2) return 2 * (n[0] + (n.length >= 3 ? n[1] : n[0]));
  if ((/bar\s*-\s*flat|flat bar/.test(low)) && n.length >= 2) return 2 * (n[0] + n[1]);
  return null;
}

const JOINT_OF = { fillet: 'FILLET', flare_bevel: 'FLARE_BEVEL', pjp: 'PJP_BEVEL' };
function jointKey(w) {
  const j = String(w.joint || '').toLowerCase();
  if (j === 'cjp') {
    const g = String(w.groove || '').toLowerCase();
    return g === 'double_v' || g === 'double_bevel' ? 'CJP_DV' : g === 'single_v' ? 'CJP_SV' : 'CJP_BEVEL';
  }
  return JOINT_OF[j] || null;
}

// One schedule entry -> { lines, missing }, hours per ONE unit of the component.
function estimateWeld(w, ctx, matOfSheet) {
  const P = (ctx && ctx.model) || PM_DEFAULT;
  const out = { lines: [], missing: [] };
  const label = [w.symbol || w.joint, w.member_mark].filter(Boolean).join(' — ') + (w.source_sheet ? ' (' + w.source_sheet + ')' : '');
  if (w.field_weld) { out.missing.push({ what: label, reason: 'field weld — made on site, not shop hours' }); return out; }
  const joint = jointKey(w);
  if (!joint) { out.missing.push({ what: label, reason: (w.joint || 'unknown') + ' weld — enter its hours by hand' }); return out; }
  const size = Number(w.size_in) || 0;
  if (!(size > 0)) { out.missing.push({ what: label, reason: 'weld size not given — set it on the Welds tab' }); return out; }
  let len = 0, basis = '';
  if (w.all_around) {
    const p = perimeterIn(w.around_member);
    if (p) { len = p; basis = 'all around ' + w.around_member + ' = ' + p.toFixed(2) + '" measured from the section'; }
    else if (Number(w.length_in) > 0) { len = Number(w.length_in); basis = 'all around, ' + len + '" from the drawing (section not measured)'; }
    else { out.missing.push({ what: label, reason: 'all-around weld but "' + (w.around_member || '?') + '" could not be measured — enter a length' }); return out; }
  } else if (Number(w.length_in) > 0) { len = Number(w.length_in); basis = len + '" per weld'; }
  else { out.missing.push({ what: label, reason: 'weld length not given — set it on the Welds tab' }); return out; }
  const lp = String(w.pitch || '').match(/^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/);
  const share = lp && Number(lp[2]) > 0 ? Math.min(1, Number(lp[1]) / Number(lp[2])) : 1;
  const ft = len / 12 * share * (w.both_sides ? 2 : 1) * (Number(w.count) || 0);
  const mat = matOfSheet(w) || 'CS';
  const wp = pm.weldProcessFor(P, mat, size);
  if (wp.missing) { out.missing.push({ what: label, reason: wp.missing }); return out; }
  const POS = ['flat', 'horizontal', 'vertical', 'overhead'];
  const pos = POS.indexOf(String(w.position || '').toLowerCase()) > -1 ? String(w.position).toLowerCase() : 'flat';
  const r = pm.jointHrPerFt(P, mat, wp.process, joint, size, pos);
  if (r.missing) { out.missing.push({ what: label, reason: r.missing }); return out; }
  const sizeTxt = (joint.indexOf('CJP') === 0 ? size + '" plate ' : size + '" ') + pm.JOINTS[joint].label.toLowerCase();
  const how = basis + (share < 1 ? ', intermittent ' + w.pitch : '') + (w.both_sides ? ', both sides' : '') + ' × ' + w.count + (pos !== 'flat' ? ', ' + pos : '');
  const low = Number(w.confidence) < 0.5;
  const common = { process: wp.process, material: mat, from_drawing: true, weld_symbol: w.symbol || '' };
  out.lines.push(Object.assign(modelLine('Weld_Hrs', r.weld * ft, ft, 'ft of weld', procLabel(wp.process).split(' ')[0] + ' ' + sizeTxt + ' — ' + label,
    'WELD-' + joint, how, low ? 'from the drawing, low confidence — check on the Welds tab' : 'from the drawing', low), common));
  if (r.prep > 0) out.lines.push(Object.assign(modelLine('Fab_Hrs', r.prep * ft, ft, 'ft of joint', 'prep (bevel / back-gouge / backing) ' + sizeTxt + ' — ' + label,
    'PREP-' + joint, 'joint prep ' + r.prep.toFixed(3) + ' hr/ft', null, true), Object.assign({}, common, { labor_type: 'FAB_GRIND' })));
  if (r.nde > 0) out.lines.push(Object.assign(modelLine('Inspection_Hrs', r.nde * ft, ft, 'ft of joint', 'NDE ' + sizeTxt + ' — ' + label,
    'NDE-' + joint, 'NDE allowance ' + r.nde.toFixed(3) + ' hr/ft', null, true), Object.assign({}, common, { labor_type: 'NDE' })));
  return out;
}

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
  const welds = ((takeoff && takeoff.welds) || []).filter(liveWeld);
  const weldSheets = new Set(welds.map((w) => sheetKey(w.source_sheet)).filter(Boolean));
  const rctx = Object.assign({}, ctx || {}, { weldSheets });
  // A weld's material is the main material of the fabricated rows on its drawing and component.
  const matOfSheet = (w) => {
    const tally = {};
    for (const r of (takeoff && takeoff.rows) || []) {
      if (sheetKey(r.source_sheet) !== sheetKey(w.source_sheet)) continue;
      if (w.component && r.component && String(r.component).trim().toLowerCase() !== String(w.component).trim().toLowerCase()) continue;
      const k = pm.materialKey(r.material_type, r.specification); tally[k] = (tally[k] || 0) + (Number(r.quantity) || 0);
    }
    return Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || null;
  };
  for (const row of (takeoff && takeoff.rows) || []) add(row.component, estimateRow(row, rctx));
  for (const w of welds) add(w.component, estimateWeld(w, rctx, matOfSheet));
  for (const f of (takeoff && takeoff.fittings) || []) add(f.component, estimateFitting(f, ctx));

  let total = 0, missing = 0;
  for (const comp of Object.values(components)) {
    for (const b of BUCKETS) comp.hours[b] = Math.round(comp.hours[b] * 100) / 100;
    comp.total = Math.round(BUCKETS.reduce((s, b) => s + comp.hours[b], 0) * 100) / 100;
    total += comp.total; missing += comp.missing.length;
  }
  return { components, total_hours: Math.round(total * 100) / 100, missing_count: missing, per: 'one unit of each component' };
}

module.exports = { estimateTakeoff, estimateRow, estimateFitting, estimateWeld, perimeterIn, memberDepth, rowPounds, WELD_ENDS, DEFAULTS };
