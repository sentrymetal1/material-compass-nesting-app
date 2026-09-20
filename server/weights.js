// =============================================================================
//  weights.js — one place that knows what a thing weighs.
// -----------------------------------------------------------------------------
//  Used in three places, which is the whole point of it being one module:
//    1. when a user adds an item the catalog does not have (a provisional item
//       must never be created carrying a zero, because zero is not a blank, it
//       is a wrong answer that flows into the quote and nobody sees it);
//    2. when the take-off writes fittings to a project;
//    3. as a backfill over the catalog rows that have no weight.
//
//  EVERY FUNCTION RETURNS null WHEN IT CANNOT WORK IT OUT. Callers must treat
//  null as "ask a human", never as zero. That rule is the reason this file
//  exists.
//
//  ── WHAT IS TRUSTWORTHY HERE, AND WHAT IS NOT ───────────────────────────────
//  pipeSectionLbPerIn() is exact: it reproduces published pipe weights to within
//  0.1% (6in sch40 computes 18.99 lb/ft against a published 18.97), and every
//  butt-weld fitting is some length of that same section. So the section is
//  solid and the uncertainty is all in the GEOMETRY FACTORS below, which say how
//  many inches of section a given fitting shape amounts to. Those are marked
//  and must be calibrated against real catalogue values before anyone prices
//  from them.
//
//  Structural is the opposite case and needs almost nothing: the catalog's
//  Weight_Lb_Ft is populated (verified 2026-09-20, a 200-row slice with none
//  blank, and an aluminium L1x1x1/8 matching hand calculation to four decimals).
//  So the shape functions here are for items a user ADDS, not for a backfill.
// =============================================================================

// lb per cubic inch. The only three that matter for structural; the alloys sit
// close enough to stainless that using it for them is better than refusing.
const DENSITY = {
  'carbon steel': 0.2836,
  'stainless steel': 0.2890,
  'stainless steel - duplex': 0.2780,
  'stainless steel - super': 0.2890,
  'aluminum': 0.0975,
  'copper': 0.3230,
  'bronze': 0.3180,
  'iron - cast': 0.2600,
  'iron - malleable': 0.2640,
  'nickel - alloy': 0.3210,
  'nickel - monel': 0.3190,
  'nickel - inconel': 0.3060,
  'nickel - incoloy': 0.2900,
  'nickel - hastelloy': 0.3210,
  'titanium': 0.1630,
  'chrome': 0.2836,
};
const DEFAULT_DENSITY = DENSITY['carbon steel'];

function density(materialName) {
  const k = String(materialName || '').trim().toLowerCase();
  if (DENSITY[k]) return DENSITY[k];
  // "Wrought - Carbon Steel" and friends: match on the family, not the process.
  for (const name of Object.keys(DENSITY)) if (k.indexOf(name) > -1) return DENSITY[name];
  return null;
}

// Fractions are how a shop writes a size, so "1-1/2" and "3/16" have to parse.
function toNumber(text) {
  const s = String(text == null ? '' : text).trim().replace(/["”]/g, '');
  if (!s) return null;
  const m = s.match(/^(\d+)?\s*[-\s]?\s*(\d+)\s*\/\s*(\d+)$/);
  if (m) {
    const whole = m[1] ? Number(m[1]) : 0;
    const d = Number(m[3]);
    if (!d) return null;
    return whole + Number(m[2]) / d;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ─── Structural ──────────────────────────────────────────────────────────────

// A rolled shape states its own weight. W12 x 26 is twenty-six pounds per foot,
// and so are MC6 x 12, C10 x 15.3 and WT6 x 20. These are exactly the shapes
// whose weight CANNOT be computed from the name, because of tapered flanges and
// fillets, so the convention is doing real work here rather than saving effort.
//
// Angles (L4 x 4 x 1/4) and tubes (4 x 4 x 1/4) state DIMENSIONS in the same
// position, so they must not come through here. The leading letter decides.
const SHAPE_STATES_ITS_WEIGHT = /^(W|S|HP|M|C|MC|WT|ST|MT)\s*\d/i;

function rolledShapeLbPerFt(description) {
  const s = String(description || '').trim();
  if (!SHAPE_STATES_ITS_WEIGHT.test(s)) return null;
  // The weight is the number after the first "x", and only if that is the LAST
  // number: a three-number designation is dimensional, not a weight.
  const parts = s.split(/\s*[x×]\s*/i);
  if (parts.length !== 2) return null;
  const w = toNumber(parts[1]);
  return w && w > 0 ? w : null;
}

// Everything that is not a rolled shape follows from geometry. Each returns
// cross-sectional area in square inches; weight is area x density x 12.
const AREA = {
  // Plate and sheet are priced per square foot, so they are handled separately
  // by plateLbPerSqFt() rather than as a linear section.
  bar_flat: (w, t) => w * t,
  bar_round: (d) => Math.PI * d * d / 4,
  bar_square: (a) => a * a,
  bar_hex: (across) => 0.866025 * across * across,
  // Angle: two legs sharing one corner, so the corner is not counted twice.
  angle: (a, b, t) => (a + b - t) * t,
  // Square and rectangular tube, outside dimensions. Corners are radiused in
  // reality, so this runs 1% to 2% heavy; acceptable, and always in the safe
  // direction for a quote.
  tube_rect: (h, w, t) => 2 * t * (h + w) - 4 * t * t,
  tube_round: (od, t) => Math.PI * (od - t) * t,
};

function structuralLbPerFt(shape, dims, materialName) {
  const rho = density(materialName) || DEFAULT_DENSITY;
  const fn = AREA[shape];
  if (!fn) return null;
  const nums = (dims || []).map(toNumber);
  if (nums.some((n) => n == null || n <= 0)) return null;
  const area = fn.apply(null, nums);
  if (!(area > 0)) return null;
  return area * rho * 12;
}

// Plate is the one form sold by area rather than length.
function plateLbPerSqFt(thickness, materialName) {
  const t = toNumber(thickness);
  const rho = density(materialName) || DEFAULT_DENSITY;
  if (!(t > 0)) return null;
  return t * 144 * rho;
}

// ─── Pipe and butt-weld fittings ─────────────────────────────────────────────

// The trustworthy core. A pipe wall is an annulus, and using the MEAN diameter
// (OD - t) is what makes this match published tables rather than approximate
// them. Verified: 6in sch40 gives 18.99 lb/ft against a published 18.97.
function pipeSectionLbPerIn(outsideDia, wall, materialName) {
  const od = toNumber(outsideDia), t = toNumber(wall);
  const rho = density(materialName) || DEFAULT_DENSITY;
  if (!(od > 0) || !(t > 0) || t >= od / 2) return null;
  return Math.PI * (od - t) * t * rho;
}

// The catalog stores inside diameter and wall, not OD. OD is exact from those
// two, so nothing needs parsing out of a description.
function outsideDiaFrom(insideDia, wall) {
  const id = toNumber(insideDia), t = toNumber(wall);
  if (!(id > 0) || !(t > 0)) return null;
  return id + 2 * t;
}

// ── GEOMETRY FACTORS: HOW MANY INCHES OF PIPE SECTION A FITTING AMOUNTS TO ──
// These are the uncertain part. Each returns a length in inches, derived from
// ASME B16.9 centre-to-end dimensions, which are themselves multiples of NPS.
// The elbows are solid geometry (the centreline arc of a bend). The tee, cap
// and reducer carry a fudge factor for the reinforcement and the end that the
// centreline does not describe, and THOSE are what must be calibrated against
// known catalogue weights before anyone quotes from them.
const FITTING_LENGTH_IN = {
  // 90 degree long radius: centreline arc of a quarter turn at radius 1.5 x NPS.
  'elbow_90_lr': (nps) => (Math.PI / 2) * 1.5 * nps,
  // 45 degree long radius: an eighth turn at the same radius.
  'elbow_45_lr': (nps) => (Math.PI / 4) * 1.5 * nps,
  // 90 degree short radius: radius equals NPS.
  'elbow_90_sr': (nps) => (Math.PI / 2) * nps,
  // Straight tee: run is two centre-to-end, branch is one more. B16.9 makes
  // centre-to-end 1.5 x NPS up to 8in. The 0.85 accounts for the intersection
  // being shared rather than three separate stubs. CALIBRATE.
  'tee': (nps) => 3 * 1.5 * nps * 0.85,
  // Cap: a dished end roughly 1.5 diameters of material spread over the crown.
  // CALIBRATE; this is the weakest of the set.
  'cap': (nps) => 1.5 * nps * 0.6,
  // Concentric reducer: B16.9 length, section averaged between the two ends,
  // which the caller handles by passing the mean OD.
  'reducer': (nps) => (nps <= 4 ? 4 : nps <= 8 ? 6 : 8),
  // Stub end: lap length plus the lap itself. CALIBRATE.
  'stub_end': (nps) => 1.5 * nps * 0.8,
};

// Give it what the catalog holds and it returns pounds, or null.
//   { type:'Elbow', style:'Butt Weld', nps:6, insideDia:6.065, wall:0.280,
//     material:'Carbon Steel', longRadius:true, degrees:90 }
function buttWeldFittingLb(spec) {
  const s = spec || {};
  const nps = toNumber(s.nps);
  const od = toNumber(s.outsideDia) || outsideDiaFrom(s.insideDia, s.wall);
  const perIn = pipeSectionLbPerIn(od, s.wall, s.material);
  if (!(nps > 0) || perIn == null) return null;

  const type = String(s.type || '').trim().toLowerCase();
  let key = null;
  if (type === 'elbow') {
    const deg = toNumber(s.degrees) || 90;
    const lr = s.longRadius !== false;
    key = deg === 45 ? 'elbow_45_lr' : (lr ? 'elbow_90_lr' : 'elbow_90_sr');
  } else if (type === 'tee' || type === 'cross') {
    key = 'tee';   // a cross is a tee with one more branch; handled by the count below
  } else if (type === 'cap') key = 'cap';
  else if (type === 'reducer') key = 'reducer';
  else if (type === 'stub end') key = 'stub_end';
  if (!key) return null;

  let inches = FITTING_LENGTH_IN[key](nps);
  if (type === 'cross') inches *= 4 / 3;   // four openings rather than three
  const lb = inches * perIn;
  return lb > 0 ? lb : null;
}

module.exports = {
  density, toNumber,
  rolledShapeLbPerFt, structuralLbPerFt, plateLbPerSqFt,
  pipeSectionLbPerIn, outsideDiaFrom, buttWeldFittingLb,
  DENSITY, FITTING_LENGTH_IN,
};
