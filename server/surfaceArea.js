// Paintable surface area, square feet.
//
// Why this exists: finishing is normally OUTSOURCED, so surface area is not a labour driver -
// it is the quantity the coater quotes against. Today the BOM editor's AREA / SA columns are
// all 0.00, so component Unit Surface Area rolls up zero and every coating RFQ goes out with
// no quantity on it.
//
// Same shape as weights.js and deliberately so: geometry where the dimensions are known, a
// DOCUMENTED allowance where they are not, and null where neither. Never zero - a zero is an
// answer, and it would be summed into a job total with nothing to show it was never known
// (the failure this codebase keeps meeting).
//
// The formulas are the closed forms of Manual Tables 1-4, verified exact against every
// published value when the tables were digitised.
const { toNumber, density } = require('./weights');

// Square feet of surface per LINEAL FOOT. Each takes inches.
const PER_FT = {
  // Beam, channel, tee: both faces of both flanges plus both sides of the web, which reduces
  // to (2d + 4bf). The flange edges and fillets are a fraction of a percent and are ignored.
  rolled: (d, bf) => (2 * d + 4 * bf) / 12,
  // Angle: the full perimeter of both legs. The thickness ends are negligible.
  angle: (a, b) => 2 * (a + b) / 12,
  // Square and rectangular tube: outside perimeter only. The inside is not painted.
  tube_rect: (h, w) => 2 * (h + w) / 12,
  // Pipe and round tube: outside circumference only, same reasoning.
  tube_round: (od) => Math.PI * od / 12,
  bar_flat:   (w, t) => 2 * (w + t) / 12,
  bar_round:  (d) => Math.PI * d / 12,
  bar_square: (a) => 4 * a / 12,
  // Across FLATS, so the side is a/sqrt(3) and the perimeter is 6 sides.
  bar_hex:    (across) => (6 * across / Math.sqrt(3)) / 12,
};

// Plate is the one form sold by area, and it is painted on BOTH faces. Edges are ignored;
// on anything thinner than about 1" they are under a percent.
function plateSqFt(lengthIn, widthIn) {
  const L = toNumber(lengthIn), W = toNumber(widthIn);
  if (!(L > 0) || !(W > 0)) return null;
  return { sqft: 2 * L * W / 144, basis: 'geometry', note: 'both faces, edges ignored' };
}

// A linear section: shape + its dimensions + length in FEET.
function sectionSqFt(shape, dims, lengthFt) {
  const fn = PER_FT[shape];
  if (!fn) return null;
  const nums = (dims || []).map(toNumber);
  if (nums.length < fn.length || nums.slice(0, fn.length).some((n) => n == null || n <= 0)) return null;
  const L = toNumber(lengthFt);
  if (!(L > 0)) return null;
  const perFt = fn.apply(null, nums.slice(0, fn.length));
  if (!(perFt > 0)) return null;
  return { sqft: perFt * L, per_ft: perFt, basis: 'geometry', note: shape };
}

// ── WHEN THE DIMENSIONS ARE NOT KNOWN ───────────────────────────────────────────────────────
// A rolled shape states its WEIGHT in its designation ("W12 x 26") and nothing else, so depth
// and flange width are not available from the name alone. The 1962 standard anticipated exactly
// this and published an allowance in square feet per ton - which is what the three AREA-*-TON
// rows in the labour seed are, and why they must never be read as hours.
//
// This is an ALLOWANCE, not a measurement, and it says so in what it returns. A coater quoting
// from it should know that.
//
// AND IT IS A WEAK ONE. Checked against the geometry for a spread of rolled shapes, the
// allowance runs roughly 35-47% HIGH on heavy sections (W14x90, W24x104, W36x150) and about
// 50% LOW on light ones (W6x9, W8x10); it is only close in the middle of the range, where the
// tables were presumably fitted. So it is a stop-gap for getting a coating RFQ out with a
// quantity on it, not a number to price against.
//
// The real fix is depth and flange width per designation - an AISC dimension table, which this
// repo does not carry because weights.js never needed it (a rolled shape states its weight in
// its name). Source that table before anyone leans on rolled-shape area.
const PER_TON = { heavy: 250, medium: 300, light: 350 };

// Under ~20 lb/ft is light, over ~50 is heavy - the bands the 1962 tables assume.
function bandFor(lbPerFt) {
  const w = toNumber(lbPerFt);
  if (w == null || w <= 0) return null;
  if (w >= 50) return 'heavy';
  if (w <= 20) return 'light';
  return 'medium';
}

function allowanceSqFt(totalLb, lbPerFt) {
  const lb = toNumber(totalLb);
  if (!(lb > 0)) return null;
  const band = bandFor(lbPerFt) || 'medium';
  return { sqft: (lb / 2000) * PER_TON[band], basis: 'allowance',
    note: PER_TON[band] + ' sq ft/ton, ' + band + ' structural (1962 Std 0.1.3) - an allowance, not a measurement' };
}

module.exports = { sectionSqFt, plateSqFt, allowanceSqFt, bandFor, PER_FT, PER_TON, density };
