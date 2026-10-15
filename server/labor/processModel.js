// =============================================================================
//  labor/processModel.js — labour from how the work is physically done, for any
//  material and any process a shop runs.
// -----------------------------------------------------------------------------
//  The 1962/1997 library is carbon steel, MIG and stick almost throughout: ~200
//  carbon rows, 12 stainless (MIG only), 1 aluminum, no TIG, no laser, no
//  waterjet, no machining. A shop that welds stainless handrail with TIG or
//  cuts aluminum on a waterjet got carbon-steel MIG hours (Mark, 2026-10-14:
//  "There are no parameters for stainless or aluminum or any other sources").
//
//  So the time comes from the work itself, with a few numbers per process and
//  material that a shop can set:
//    weld  hr/ft  = weld metal lb/ft ÷ deposition lb/hr (arc on) ÷ arc-on share
//                   × (1 + post-weld cleanup %)                 [Lincoln method]
//    cut   hr     = cut length ÷ speed(material, thickness) + pierces
//                   + handling per piece (load, mark, unload, deburr)
//    saw   hr     = (setup per cut + section area ÷ sq in per min) per cut
//    fit, handle  = per piece / per ton, by material
//
//  WHERE THE DEFAULTS COME FROM. Carbon-steel MIG keeps Sentry's own figures
//  (weldTime.js). Everything else is a TYPICAL starting value — machine-maker cut
//  charts and welding-handbook deposition ranges, rounded — and is marked
//  "typical — check" everywhere it shows until the shop enters its own. A process
//  that cannot do a material (oxy-fuel on stainless or aluminum, stick on
//  aluminum) has no default at all, so it can never be picked silently.
//
//  CARBON STEEL STAYS WHERE IT WAS. Frame members are priced from Sentry's 1997
//  "square cut and welded all around" rows, which bundle cut + fit + weld. Those
//  hours are now SPLIT into the three (shop-editable shares) so cutting shows as
//  cutting, and each share is scaled by the member's material and routed process
//  against carbon-steel MIG. For carbon steel at library defaults the factors are
//  1 and the total is unchanged.
// =============================================================================
const { density, toNumber } = require('../weights');

// ---- MATERIALS ----------------------------------------------------------------
// Order matters in match(): duplex before stainless, nickel alloys before "alloy".
const MATERIALS = [
  { key: 'CS',  label: 'Carbon steel',          rho: 'carbon steel',      re: /carbon|mild|a36\b|a572|a992|a500|a53\b|a106|galv|weathering|a588/i },
  { key: 'DSS', label: 'Duplex stainless',      rho: 'stainless steel',   re: /duplex|2205|2507|s3180|s3275/i },
  { key: 'SS',  label: 'Stainless steel',       rho: 'stainless steel',   re: /stainless|\b30[0-9]\b|\b31[0-9]\b|\b4[0-9]{2}\b ss|\b17-4/i },
  { key: 'AL',  label: 'Aluminum',              rho: 'aluminum',          re: /alumin|\b(1100|2024|3003|5052|5083|5086|6061|6063|7075)\b/i },   // named grades only: 1018 is steel
  { key: 'NI',  label: 'Nickel alloys',         rho: 'nickel - inconel',  re: /nickel|inconel|monel|hastelloy|incoloy|alloy 6\d\d|c-?276/i },
  { key: 'CU',  label: 'Copper / brass / bronze', rho: 'copper',          re: /copper|brass|bronze/i },
  { key: 'TI',  label: 'Titanium',              rho: 'titanium',          re: /titan/i },
];
const MAT = Object.fromEntries(MATERIALS.map((m) => [m.key, m]));
const DENSITY_FALLBACK = { CS: 0.2836, DSS: 0.282, SS: 0.289, AL: 0.0975, NI: 0.306, CU: 0.323, TI: 0.163 };
const matDensity = (k) => density((MAT[k] || MAT.CS).rho) || DENSITY_FALLBACK[k] || DENSITY_FALLBACK.CS;

// Row → material key. Material type first, then the spec; unknown is carbon steel, said so.
function materialKey(materialType, specification) {
  const t = String(materialType || ''), s = String(specification || '');
  for (const m of MATERIALS) if (m.re.test(t)) return m.key;
  for (const m of MATERIALS) if (m.key !== 'CS' && m.re.test(s)) return m.key;
  return 'CS';
}

// ---- PROCESSES ----------------------------------------------------------------
// family: weld | cut (plate/sheet profiles) | saw (members, bar) | form | machine | finish
const PROCESSES = [
  { key: 'MIG',      family: 'weld', label: 'MIG (GMAW)' },
  { key: 'TIG',      family: 'weld', label: 'TIG (GTAW)' },
  { key: 'STICK',    family: 'weld', label: 'Stick (SMAW)' },
  { key: 'FCAW',     family: 'weld', label: 'Flux-core (FCAW)' },
  { key: 'SAW',      family: 'weld', label: 'Sub-arc (SAW)' },
  { key: 'PLASMA',   family: 'cut',  label: 'Plasma, CNC table' },
  { key: 'PLASMA_H', family: 'cut',  label: 'Plasma, by hand' },
  { key: 'OXY',      family: 'cut',  label: 'Oxy-fuel, CNC table' },
  { key: 'OXY_H',    family: 'cut',  label: 'Oxy-fuel, by hand' },
  { key: 'LASER',    family: 'cut',  label: 'Laser' },
  { key: 'WATERJET', family: 'cut',  label: 'Waterjet' },
  { key: 'BANDSAW',  family: 'saw',  label: 'Band saw' },
  { key: 'COLDSAW',  family: 'saw',  label: 'Cold saw / abrasive' },
  { key: 'SHEAR',    family: 'saw',  label: 'Shear' },
  { key: 'IRONWORKER', family: 'saw', label: 'Ironworker (punch / notch / shear)' },
  { key: 'BRAKE',    family: 'form', label: 'Press brake' },
  { key: 'ROLL',     family: 'form', label: 'Plate / angle roll' },
  { key: 'PUNCH',    family: 'form', label: 'Punch / turret' },
  { key: 'DRILL',    family: 'machine', label: 'Drill / mag drill' },
  { key: 'MILL',     family: 'machine', label: 'Mill (manual)' },
  { key: 'LATHE',    family: 'machine', label: 'Lathe (manual)' },
  { key: 'CNC_MILL', family: 'machine', label: 'CNC mill / machining center' },
  { key: 'CNC_LATHE', family: 'machine', label: 'CNC lathe' },
  { key: 'BLAST',    family: 'finish', label: 'Blast' },
  { key: 'PAINT',    family: 'finish', label: 'Paint' },
  { key: 'POWDER',   family: 'finish', label: 'Powder coat' },
  { key: 'PASSIVATE', family: 'finish', label: 'Pickle / passivate' },
];
const PROC = Object.fromEntries(PROCESSES.map((p) => [p.key, p]));

// ---- TYPICAL STARTING VALUES ---------------------------------------------------
// Welding: deposition lb/hr with the arc on, and the share of the shift the arc is on.
// Carbon-steel MIG is Sentry's own (1/4" fillet at 6 in/min; 0.0714 hr/ft applied).
// A missing cell = that process does not weld that material.
const SENTRY_MIG_DEP = 0.375 * 0.2836 / (12 / 6 / 60);     // 3.19 lb/hr, as weldTime.js
const SENTRY_MIG_OF = (12 / 6 / 60) / 0.0714;               // ≈ 0.467
const WELD = {
  MIG:   { CS: [SENTRY_MIG_DEP, SENTRY_MIG_OF, 'sentry'], SS: [3.0, 0.40], DSS: [2.6, 0.35], AL: [1.6, 0.35], NI: [2.4, 0.35], CU: [2.0, 0.30] },
  // Hand TIG lays roughly 1-1.5 lb/hr of steel; aluminum is a third the weight for the same bead.
  TIG:   { CS: [1.3, 0.35], SS: [1.2, 0.35], DSS: [1.0, 0.33], AL: [0.5, 0.30], NI: [1.0, 0.33], CU: [0.9, 0.30], TI: [0.8, 0.30] },
  STICK: { CS: [3.1, 0.30], SS: [2.2, 0.30], DSS: [2.0, 0.28], NI: [1.8, 0.28] },
  FCAW:  { CS: [6.0, 0.40], SS: [5.0, 0.40], DSS: [4.5, 0.38] },
  SAW:   { CS: [12, 0.50], SS: [10, 0.50], DSS: [9, 0.50] },
};
// Cleanup after welding (grind, brush, pickle/passivate), as a share of the weld time. Carbon
// steel 0: Sentry's 0.0714 hr/ft is an APPLIED rate that already carries its cleanup.
const CLEANUP = { CS: 0, SS: 0.35, DSS: 0.35, AL: 0.20, NI: 0.35, CU: 0.20, TI: 0.40 };
// Fit-up per piece relative to carbon steel: protecting a finish, purging, cleanliness.
const FIT_FACTOR = { CS: 1, SS: 1.15, DSS: 1.2, AL: 1.2, NI: 1.25, CU: 1.15, TI: 1.4 };

// Profile cutting: speed (in/min) at 1/2" thick, how fast it falls off with thickness
// (speed = ipm × (0.5 / t)^k), the thickest it cuts, seconds to pierce once.
const CUT = {
  PLASMA:   { CS: [55, 1.1, 1.5, 3], SS: [45, 1.2, 1.25, 3], DSS: [40, 1.2, 1, 3], AL: [70, 1.0, 1.5, 2], NI: [35, 1.2, 1, 3], CU: [30, 1.2, 0.75, 3], TI: [45, 1.1, 1, 3] },
  PLASMA_H: { CS: [25, 1.0, 1, 4], SS: [20, 1.1, 0.75, 4], DSS: [18, 1.1, 0.75, 4], AL: [30, 1.0, 1, 3], NI: [15, 1.1, 0.5, 4], CU: [14, 1.1, 0.5, 4], TI: [20, 1.0, 0.75, 4] },
  OXY:      { CS: [18, 0.45, 12, 45] },
  OXY_H:    { CS: [10, 0.45, 8, 60] },
  LASER:    { CS: [40, 1.4, 1, 2], SS: [30, 1.5, 1, 2], DSS: [25, 1.5, 0.75, 2], AL: [35, 1.5, 0.75, 2], NI: [20, 1.5, 0.5, 2], CU: [10, 1.5, 0.375, 2], TI: [30, 1.4, 0.5, 2] },
  WATERJET: { CS: [6, 1.15, 8, 15], SS: [5, 1.15, 8, 15], DSS: [4.5, 1.15, 8, 15], AL: [15, 1.15, 8, 10], NI: [4, 1.15, 6, 15], CU: [9, 1.15, 6, 12], TI: [6, 1.15, 6, 15] },
};
// Minutes per cut part for the work around the cut: load/nest share, mark, unload, deburr.
const CUT_HANDLING_MIN = { PLASMA: 4, PLASMA_H: 8, OXY: 5, OXY_H: 10, LASER: 2, WATERJET: 4 };

// Sawing members and bar: square inches of section per minute, and minutes per cut around it.
const SAW = {
  BANDSAW: { CS: 4, SS: 1.5, DSS: 1.2, AL: 12, NI: 0.8, CU: 5, TI: 1 },
  COLDSAW: { CS: 6, SS: 2.5, DSS: 2, AL: 20, NI: 1.2, CU: 8, TI: 1.5 },
};
const SAW_SETUP_MIN = { BANDSAW: 3, COLDSAW: 2 };
const SHEAR_MIN = 0.75;                                             // per cut, flat bar / sheet
const SHEAR_MAX_T = { CS: 0.5, SS: 0.375, DSS: 0.25, AL: 0.75, CU: 0.5, NI: 0.25, TI: 0.25 };

// Forming and machining: stored for the shop now, used as soon as the take-off counts bends,
// holes and machined parts. Minutes.
const FORM = {
  BRAKE: { setup_min: 15, per_hit_sec: 20 },
  ROLL:  { setup_min: 30, per_ft_min: 2 },
  PUNCH: { setup_min: 10, per_hit_sec: 4 },
  DRILL: { setup_min: 5, per_hole_min: 1.5 },
  MILL:  { setup_min: 45, per_part_min: 20 },
  LATHE: { setup_min: 30, per_part_min: 15 },
  CNC_MILL: { setup_min: 60, per_part_min: 10 },
  CNC_LATHE: { setup_min: 45, per_part_min: 6 },
};

// Welding position, as a share of flat speed (1962 Estimating Standards 0.1.6 p.14).
const POSITION = { flat: 1, horizontal: 0.9, vertical: 0.8, overhead: 0.6 };

// Joint shapes: weld metal cross-section (sq in) from the size — the fillet leg, or for a groove the
// plate thickness (PJP: the effective throat). Square-groove root gaps and 60°/45° preparations as
// drawn in AWS D1.1 prequalified joints; reinforcement left out, as for the fillet, so every shape is
// on the same footing. 'bevels' = prepared faces per ft of joint; 'gouge' = back-gouged and rewelded
// from the second side; 'backing' = steel backing bar fitted and tacked; 'nde' = inspected.
const JOINTS = {
  FILLET:      { label: 'Fillet', size: 'leg', area: (t) => t * t / 2, bevels: 0 },
  CJP_SV:      { label: 'CJP single-V groove, back-gouged', size: 'thickness', area: (t) => 0.577 * t * t + 0.125 * t, bevels: 2, gouge: true, nde: true },
  CJP_DV:      { label: 'CJP double-V groove, back-gouged', size: 'thickness', area: (t) => 0.289 * t * t + 0.125 * t, bevels: 4, gouge: true, nde: true },
  CJP_BEVEL:   { label: 'CJP single-bevel on backing bar', size: 'thickness', area: (t) => 0.5 * t * t + 0.25 * t, bevels: 1, backing: true, nde: true },
  PJP_BEVEL:   { label: 'PJP single-bevel', size: 'throat', area: (t) => 0.5 * t * t, bevels: 1 },
  FLARE_BEVEL: { label: 'Flare-bevel (pipe or round bar to flat)', size: 'leg', area: (t) => 0.4 * t * t, bevels: 0 },
};
// The work around the weld, hr per ft of joint. Bevel prep grows with thickness: a + b·t per face.
const JOINT_PREP = { bevel_a: 0.03, bevel_b: 0.10, gouge: 0.10, backing: 0.05, nde: 0.05 };
const WELD_SIZES = [0.1875, 0.25, 0.3125, 0.375, 0.5, 0.625, 0.75, 1];

const GENERAL = {
  fit_hr_piece: 0.22,          // Sentry 1997 "fitting and tacking clips", per plate
  handling_hr_ton: 1.25,       // library handling row, per ton
  member_cuts_per_piece: 1,    // a member cut from stock: one cut each
  share_cut: 0.15, share_fit: 0.35, share_weld: 0.50,   // split of the bundled frame-member rate
};

// Routing: which process does which job for each material. TIG below the split thickness,
// the main process above it; plate up to the split on the first cutter, thicker on the second.
const ROUTING = {
  CS:  { weld: 'MIG', weld_thin: 'MIG', weld_split: 0,    plate: 'PLASMA', plate_thick: 'OXY',      plate_split: 1,   member: 'BANDSAW' },
  SS:  { weld: 'MIG', weld_thin: 'TIG', weld_split: 0.25, plate: 'PLASMA', plate_thick: 'WATERJET', plate_split: 1,   member: 'BANDSAW' },
  DSS: { weld: 'MIG', weld_thin: 'TIG', weld_split: 0.25, plate: 'PLASMA', plate_thick: 'WATERJET', plate_split: 1,   member: 'BANDSAW' },
  AL:  { weld: 'MIG', weld_thin: 'TIG', weld_split: 0.25, plate: 'PLASMA', plate_thick: 'WATERJET', plate_split: 1.5, member: 'BANDSAW' },
  NI:  { weld: 'TIG', weld_thin: 'TIG', weld_split: 0,    plate: 'PLASMA', plate_thick: 'WATERJET', plate_split: 1,   member: 'BANDSAW' },
  CU:  { weld: 'TIG', weld_thin: 'TIG', weld_split: 0,    plate: 'PLASMA', plate_thick: 'WATERJET', plate_split: 0.75, member: 'BANDSAW' },
  TI:  { weld: 'TIG', weld_thin: 'TIG', weld_split: 0,    plate: 'WATERJET', plate_thick: 'WATERJET', plate_split: 6, member: 'BANDSAW' },
};

const DEFAULT_CAPS = ['MIG', 'TIG', 'STICK', 'FCAW', 'PLASMA', 'PLASMA_H', 'OXY', 'OXY_H', 'BANDSAW', 'SHEAR', 'DRILL'];

// ---- THE SHOP'S PARAMETERS ----------------------------------------------------
// The stored v2 section of a profile (shop.js) merged over the typical values. Every value
// carries where it came from: 'yours' | 'sentry' (the library's own) | 'typical'.
const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const frac = (v) => { const n = pos(v); return n != null && n <= 1 ? n : null; };
const val = (mine, dflt, src) => mine != null ? { value: mine, source: 'yours' } : dflt != null ? { value: dflt, source: src || 'typical' } : null;

function params(model) {
  const m = model || {};
  const caps = Array.isArray(m.capabilities) && m.capabilities.length ? m.capabilities.filter((k) => PROC[k]) : DEFAULT_CAPS.slice();
  const mats = Array.isArray(m.materials) && m.materials.length ? m.materials.filter((k) => MAT[k]) : ['CS', 'SS', 'AL'];
  const weld = {}, cut = {}, saw = {};
  for (const p of Object.keys(WELD)) for (const k of Object.keys(MAT)) {
    const d = WELD[p][k], s = ((m.weld || {})[p + '|' + k]) || {};
    const dep = val(pos(s.dep), d && d[0], d && d[2]), of = val(frac(s.of), d && d[1], d && d[2]);
    if (dep && of) weld[p + '|' + k] = { dep, of };
  }
  for (const p of Object.keys(CUT)) for (const k of Object.keys(MAT)) {
    const d = CUT[p][k], s = ((m.cut || {})[p + '|' + k]) || {};
    const ipm = val(pos(s.ipm), d && d[0]), k_ = val(pos(s.k), d && d[1]), max = val(pos(s.max_t), d && d[2]), pierce = val(pos(s.pierce_s), d && d[3]);
    if (ipm && k_ && max && pierce) cut[p + '|' + k] = { ipm, k: k_, max_t: max, pierce_s: pierce };
  }
  for (const p of Object.keys(SAW)) for (const k of Object.keys(MAT)) {
    const s = ((m.saw || {})[p + '|' + k]) || {};
    const r = val(pos(s.sqin_min), SAW[p][k]);
    if (r) saw[p + '|' + k] = { sqin_min: r };
  }
  const cutHandling = {}; for (const p of Object.keys(CUT_HANDLING_MIN)) cutHandling[p] = val(pos((m.cut_handling_min || {})[p]), CUT_HANDLING_MIN[p]);
  const sawSetup = {}; for (const p of Object.keys(SAW_SETUP_MIN)) sawSetup[p] = val(pos((m.saw_setup_min || {})[p]), SAW_SETUP_MIN[p]);
  const cleanup = {}, fitF = {}, shearMax = {};
  for (const k of Object.keys(MAT)) {
    const c = (m.cleanup || {})[k];   // 0% is a real answer here, unlike a rate
    cleanup[k] = c != null && c !== '' && Number(c) >= 0 ? { value: Number(c), source: 'yours' } : { value: CLEANUP[k], source: k === 'CS' ? 'sentry' : 'typical' };
    fitF[k] = val(pos((m.fit_factor || {})[k]), FIT_FACTOR[k]);
    shearMax[k] = val(pos((m.shear_max_t || {})[k]), SHEAR_MAX_T[k]);
  }
  const g = m.general || {};
  const general = {
    fit_hr_piece: val(pos(g.fit_hr_piece), GENERAL.fit_hr_piece, 'sentry'),
    handling_hr_ton: val(pos(g.handling_hr_ton), GENERAL.handling_hr_ton, 'sentry'),
    member_cuts_per_piece: val(pos(g.member_cuts_per_piece), GENERAL.member_cuts_per_piece),
    shear_min: val(pos(g.shear_min), SHEAR_MIN),
  };
  // Shares must add to 1; a shop's set is used only when all three are given.
  const sh = [frac(g.share_cut), frac(g.share_fit), frac(g.share_weld)];
  const mineShares = sh.every((x) => x != null) && Math.abs(sh[0] + sh[1] + sh[2] - 1) < 0.02;
  general.share_cut = mineShares ? { value: sh[0], source: 'yours' } : { value: GENERAL.share_cut, source: 'typical' };
  general.share_fit = mineShares ? { value: sh[1], source: 'yours' } : { value: GENERAL.share_fit, source: 'typical' };
  general.share_weld = mineShares ? { value: sh[2], source: 'yours' } : { value: GENERAL.share_weld, source: 'typical' };
  const form = {};
  for (const p of Object.keys(FORM)) { form[p] = {}; for (const f of Object.keys(FORM[p])) form[p][f] = val(pos(((m.form || {})[p] || {})[f]), FORM[p][f]); }
  const routing = {};
  for (const k of Object.keys(MAT)) {
    const d = ROUTING[k], s = (m.routing || {})[k] || {};
    const pick = (f, fam) => (PROC[s[f]] && PROC[s[f]].family === fam) ? s[f] : d[f];
    routing[k] = {
      weld: pick('weld', 'weld'), weld_thin: pick('weld_thin', 'weld'),
      weld_split: Number(s.weld_split) >= 0 && s.weld_split !== '' && s.weld_split != null ? Number(s.weld_split) : d.weld_split,
      plate: pick('plate', 'cut'), plate_thick: pick('plate_thick', 'cut'),
      plate_split: pos(s.plate_split) != null ? pos(s.plate_split) : d.plate_split,
      member: pick('member', 'saw'),
      mine: Object.keys(s).length > 0,
    };
  }
  const position = {}; for (const k of Object.keys(POSITION)) position[k] = val(frac((m.position || {})[k]) || (Number((m.position || {})[k]) > 1 && Number((m.position || {})[k]) <= 1.5 ? Number(m.position[k]) : null), POSITION[k], 'sentry');
  const jointPrep = {}; for (const k of Object.keys(JOINT_PREP)) jointPrep[k] = val(pos((m.joint_prep || {})[k]), JOINT_PREP[k]);
  return { position, joint_prep: jointPrep, capabilities: caps, materials: mats, weld, cut, saw, cut_handling_min: cutHandling, saw_setup_min: sawSetup,
    cleanup, fit_factor: fitF, shear_max_t: shearMax, general, form, routing };
}

// ---- ROUTING ----------------------------------------------------------------------
// The process a shop would use, among the ones it HAS and that can do the material.
// Returns { process, routed (what the routing said), substituted (bool) } or { missing }.
function pickProcess(P, family, mat, wanted, thickness) {
  const can = (p) => P.capabilities.indexOf(p) > -1 && PROC[p] && PROC[p].family === family &&
    (family === 'weld' ? !!P.weld[p + '|' + mat]
      : family === 'cut' ? !!P.cut[p + '|' + mat] && !(thickness > P.cut[p + '|' + mat].max_t.value)
      : family === 'saw' ? (p === 'SHEAR' ? !(thickness > (P.shear_max_t[mat] || {}).value) : p === 'IRONWORKER' ? false : !!P.saw[p + '|' + mat])
      : true);
  if (wanted && can(wanted)) return { process: wanted, routed: wanted, substituted: false };
  const order = { weld: ['MIG', 'TIG', 'FCAW', 'STICK', 'SAW'], cut: ['PLASMA', 'LASER', 'OXY', 'WATERJET', 'PLASMA_H', 'OXY_H'], saw: ['BANDSAW', 'COLDSAW'] }[family] || [];
  const alt = order.find(can);
  if (alt) return { process: alt, routed: wanted, substituted: true };
  return { missing: 'no ' + family + ' process in your shop setup can do ' + (MAT[mat] || MAT.CS).label.toLowerCase() + (thickness ? ' at ' + thickness + '"' : '') };
}
function weldProcessFor(P, mat, thickness) {
  const r = P.routing[mat] || P.routing.CS;
  const wanted = thickness > 0 && thickness <= r.weld_split ? r.weld_thin : r.weld;
  return pickProcess(P, 'weld', mat, wanted);
}
function plateCutProcessFor(P, mat, thickness) {
  const r = P.routing[mat] || P.routing.CS;
  const wanted = thickness > r.plate_split ? r.plate_thick : r.plate;
  return pickProcess(P, 'cut', mat, wanted, thickness);
}
function memberCutProcessFor(P, mat) {
  const r = P.routing[mat] || P.routing.CS;
  return pickProcess(P, 'saw', mat, r.member);
}

// ---- TIME --------------------------------------------------------------------------
// Weld metal of a fillet, lb per ft (theoretical section, no convexity — as weldTime.js).
function filletLbPerFt(leg, mat) { const s = toNumber(leg); return s > 0 ? (s * s / 2) * 12 * matDensity(mat) : null; }

// hr per ft of fillet with cleanup, or { missing }.
function weldHrPerFt(P, mat, proc, leg) {
  const w = P.weld[proc + '|' + mat];
  if (!w) return { missing: PROC[proc].label + ' has no rate for ' + MAT[mat].label.toLowerCase() };
  const lb = filletLbPerFt(leg, mat);
  if (lb == null) return { missing: 'weld size needed' };
  const clean = (P.cleanup[mat] || { value: 0 }).value;
  const arc = lb / w.dep.value / w.of.value;
  return { value: arc * (1 + clean), arc, source: srcOf(w.dep, w.of, P.cleanup[mat]),
    basis: lb.toFixed(4) + ' lb/ft weld metal ÷ ' + w.dep.value.toFixed(2) + ' lb/hr ÷ ' + Math.round(w.of.value * 100) + '% arc on' + (clean ? ' + ' + Math.round(clean * 100) + '% cleanup' : '') };
}

// Profile cutting: hr per ft of cut at thickness t, and hr per pierce; or { missing }.
function cutRate(P, mat, proc, t) {
  const c = P.cut[proc + '|' + mat];
  if (!c) return { missing: PROC[proc].label + ' cannot cut ' + MAT[mat].label.toLowerCase() };
  if (t > c.max_t.value) return { missing: PROC[proc].label + ' tops out at ' + c.max_t.value + '" in ' + MAT[mat].label.toLowerCase() };
  const ipm = c.ipm.value * Math.pow(0.5 / Math.max(t, 0.04), c.k.value);
  return { hr_per_ft: 12 / ipm / 60, hr_per_pierce: c.pierce_s.value / 3600, ipm, source: srcOf(c.ipm, c.k, c.max_t),
    basis: Math.round(ipm * 10) / 10 + ' in/min at ' + t + '" (' + c.ipm.value + ' in/min at 1/2")' };
}
// One ft of any joint, any size, any position, on a process and material: the weld itself (with the
// material's cleanup) and the work around it — bevelling, back-gouging, backing bar — and NDE.
// Returns { weld, prep, nde, total, parts } hr per ft, or { missing }.
function jointHrPerFt(P, mat, proc, joint, size, position) {
  const j = JOINTS[joint]; if (!j) return { missing: 'unknown joint ' + joint };
  const w = P.weld[proc + '|' + mat];
  if (!w) return { missing: (PROC[proc] || { label: proc }).label + ' has no rate for ' + (MAT[mat] || MAT.CS).label.toLowerCase() };
  const t = toNumber(size); if (!(t > 0)) return { missing: 'weld size needed' };
  const posF = (P.position[position || 'flat'] || P.position.flat).value;
  const lb = j.area(t) * 12 * matDensity(mat);
  const clean = (P.cleanup[mat] || { value: 0 }).value;
  const weld = lb / w.dep.value / w.of.value / posF * (1 + clean);
  const jp = P.joint_prep;
  const bevel = j.bevels ? j.bevels * (jp.bevel_a.value + jp.bevel_b.value * t) : 0;
  const gouge = j.gouge ? jp.gouge.value : 0, backing = j.backing ? jp.backing.value : 0;
  const nde = j.nde ? jp.nde.value : 0;
  return { weld, prep: bevel + gouge + backing, nde, total: weld + bevel + gouge + backing + nde,
    parts: { lb_per_ft: lb, bevel, gouge, backing } };
}

const cutHandlingHr = (P, proc) => ((P.cut_handling_min[proc] || { value: 0 }).value) / 60;

// Sawing one cut through a section of `area` sq in; or { missing }.
function sawHrPerCut(P, mat, proc, area) {
  if (proc === 'SHEAR') return { value: P.general.shear_min.value / 60, source: P.general.shear_min.source, basis: P.general.shear_min.value + ' min per shear' };
  const r = P.saw[proc + '|' + mat];
  if (!r) return { missing: PROC[proc].label + ' has no rate for ' + MAT[mat].label.toLowerCase() };
  const setup = (P.saw_setup_min[proc] || { value: 3 }).value;
  const a = area > 0 ? area : 1;
  return { value: (setup + a / r.sqin_min.value) / 60, source: srcOf(r.sqin_min, P.saw_setup_min[proc]),
    basis: setup + ' min setup + ' + a.toFixed(2) + ' sq in ÷ ' + r.sqin_min.value + ' sq in/min' };
}

// How much longer this material/process takes than carbon steel on Sentry's MIG and band saw —
// the factors that scale the bundled frame-member rate. Both sides use the same 1/4" fillet and
// the same section, so only the material and process change.
const LIB = params({ capabilities: DEFAULT_CAPS });
function memberFactors(P, mat, thickness, area) {
  const wp = weldProcessFor(P, mat, thickness);
  const cp = memberCutProcessFor(P, mat);
  const base = weldHrPerFt(LIB, 'CS', 'MIG', 0.25).value;
  const w = wp.missing ? null : weldHrPerFt(P, mat, wp.process, 0.25);
  const sBase = sawHrPerCut(LIB, 'CS', 'BANDSAW', area).value;
  const s = cp.missing ? null : sawHrPerCut(P, mat, cp.process, area);
  return {
    weld: w && !w.missing ? w.value / base : null, weld_process: wp.process || null, weld_missing: wp.missing || (w && w.missing) || null,
    cut: s && !s.missing ? s.value / sBase : null, cut_process: cp.process || null, cut_missing: cp.missing || (s && s.missing) || null,
    fit: (P.fit_factor[mat] || { value: 1 }).value,
    substituted: (wp.substituted ? [wp.routed + '→' + wp.process] : []).concat(cp.substituted ? [cp.routed + '→' + cp.process] : []),
  };
}

function srcOf() {
  const xs = Array.from(arguments).filter(Boolean);
  if (xs.length && xs.every((x) => x.source === 'yours')) return 'yours';
  if (xs.some((x) => x.source === 'typical')) return 'typical';
  return xs.some((x) => x.source === 'yours') ? 'mixed' : 'sentry';
}

// What the setup page draws: the lists and the typical value of every cell.
function defaults() {
  return { materials: MATERIALS.map((m) => ({ key: m.key, label: m.label })), processes: PROCESSES, weld: WELD, cut: CUT,
    cut_handling_min: CUT_HANDLING_MIN, saw: SAW, saw_setup_min: SAW_SETUP_MIN, shear_min: SHEAR_MIN, shear_max_t: SHEAR_MAX_T,
    cleanup: CLEANUP, fit_factor: FIT_FACTOR, form: FORM, general: GENERAL, routing: ROUTING, capabilities: DEFAULT_CAPS,
    position: POSITION, joint_prep: JOINT_PREP, weld_sizes: WELD_SIZES,
    joints: Object.fromEntries(Object.entries(JOINTS).map(([k, j]) => [k, { label: j.label, size: j.size, bevels: j.bevels, gouge: !!j.gouge, backing: !!j.backing, nde: !!j.nde }])) };
}

// The v2 block from the page, re-checked. Unknown keys dropped, non-numbers dropped (never 0,
// which would read as "takes no time") — except cleanup, where 0% is a real answer.
function cleanModel(input) {
  const i = input || {};
  const out = {};
  out.capabilities = (Array.isArray(i.capabilities) ? i.capabilities : DEFAULT_CAPS).filter((k) => PROC[k]);
  out.materials = (Array.isArray(i.materials) ? i.materials : ['CS', 'SS', 'AL']).filter((k) => MAT[k]);
  const pair = (obj, procs, fields) => {
    const o = {};
    for (const key of Object.keys(obj || {})) {
      const [p, k] = key.split('|');
      if (procs.indexOf(p) < 0 || !MAT[k]) continue;
      const row = {};
      for (const [f, fn] of fields) { const v = fn(obj[key][f]); if (v != null) row[f] = v; }
      if (Object.keys(row).length) o[key] = row;
    }
    return o;
  };
  out.weld = pair(i.weld, Object.keys(WELD), [['dep', pos], ['of', frac]]);
  out.cut = pair(i.cut, Object.keys(CUT), [['ipm', pos], ['k', pos], ['max_t', pos], ['pierce_s', pos]]);
  out.saw = pair(i.saw, Object.keys(SAW), [['sqin_min', pos]]);
  const keyed = (obj, keys, fn) => { const o = {}; for (const k of keys) { const v = fn((obj || {})[k]); if (v != null) o[k] = v; } return o; };
  out.cut_handling_min = keyed(i.cut_handling_min, Object.keys(CUT_HANDLING_MIN), pos);
  out.saw_setup_min = keyed(i.saw_setup_min, Object.keys(SAW_SETUP_MIN), pos);
  out.cleanup = keyed(i.cleanup, Object.keys(MAT), (v) => v === '' || v == null ? null : (Number(v) >= 0 && Number(v) <= 2 ? Number(v) : null));
  out.fit_factor = keyed(i.fit_factor, Object.keys(MAT), pos);
  out.shear_max_t = keyed(i.shear_max_t, Object.keys(MAT), pos);
  const g = i.general || {};
  out.general = keyed(g, ['fit_hr_piece', 'handling_hr_ton', 'member_cuts_per_piece', 'shear_min'], pos);
  Object.assign(out.general, keyed(g, ['share_cut', 'share_fit', 'share_weld'], frac));
  out.form = {};
  for (const p of Object.keys(FORM)) { const r = keyed((i.form || {})[p], Object.keys(FORM[p]), pos); if (Object.keys(r).length) out.form[p] = r; }
  out.position = keyed(i.position, Object.keys(POSITION), (v) => { const n = Number(v); return v !== '' && v != null && n > 0 && n <= 1.5 ? n : null; });
  out.joint_prep = keyed(i.joint_prep, Object.keys(JOINT_PREP), pos);
  out.routing = {};
  for (const k of Object.keys(MAT)) {
    const s = (i.routing || {})[k]; if (!s) continue;
    const r = {};
    for (const [f, fam] of [['weld', 'weld'], ['weld_thin', 'weld'], ['plate', 'cut'], ['plate_thick', 'cut'], ['member', 'saw']]) if (PROC[s[f]] && PROC[s[f]].family === fam) r[f] = s[f];
    if (Number(s.weld_split) >= 0 && s.weld_split !== '' && s.weld_split != null) r.weld_split = Number(s.weld_split);
    if (pos(s.plate_split) != null) r.plate_split = pos(s.plate_split);
    if (Object.keys(r).length) out.routing[k] = r;
  }
  return out;
}

module.exports = { MATERIALS, PROCESSES, MAT, PROC, materialKey, params, defaults, cleanModel,
  weldProcessFor, plateCutProcessFor, memberCutProcessFor, weldHrPerFt, cutRate, cutHandlingHr, sawHrPerCut,
  memberFactors, filletLbPerFt, matDensity, DEFAULT_CAPS, jointHrPerFt, JOINTS, POSITION, WELD_SIZES };
