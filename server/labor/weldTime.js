// =============================================================================
//  labor/weldTime.js — welding hours from the weld itself (the Lincoln method).
// -----------------------------------------------------------------------------
//    hours per ft = weld metal lb/ft  ÷  deposition lb/hr (arc on)
//                                     ÷  operating factor (share of the shift the arc is on)
//                                     ÷  position factor
//
//  This is the method in Lincoln's Procedure Handbook of Arc Welding and every
//  welding-cost text since. The METHOD is free to use; no copyrighted hours
//  table is carried here. The three numbers it needs come from, in order:
//    1. the shop's own setup (always wins);
//    2. the shop's own documents:
//       - SMAW deposition: 1962 Estimating Standards 0.1.6 p.14, "Manual welding,
//         flat position, pounds per hour deposit chart". Its 100% arc-time line
//         is straight: 0.0223 lb/hr per amp above ~9 A (read off the chart at
//         202 A = 4.30 lb/hr and 321 A = 6.94 lb/hr; the 15% and 60% lines check
//         against it within the chart's grid). Position factors from the same page.
//       - GMAW deposition: Sentry's handwritten note, 1/4" fillet at 6 in/min
//         arc travel, turned into lb/hr through the fillet's own weld metal.
//       - Operating factor: Sentry 1997 applied 1/4" fillet (0.0714 hr/ft) against
//         that same arc time — about 47%. Inside the 15–60% range the 1962 chart
//         draws, and the number the shop should replace first.
//    3. nothing — returns missing.
//
//  Weld metal is the theoretical section (no convexity). The operating factor is
//  derived with the same formula, so the two stay consistent.
// =============================================================================
const { resolve } = require('./standards');
const { grooveArea } = require('./pipeJoint');
const { density, toNumber } = require('../weights');

const SMAW_LB_PER_AMP = 0.0223;
const SMAW_ZERO_AMPS = 9;
const SMAW_DEFAULT_AMPS = 150;
const POSITION = { flat: 1, horizontal: 0.9, vertical: 0.8, overhead: 0.6 };   // 0.1.6 p.14
const SENTRY_MIG_IPM = 6;                                                       // handwritten note, 1/4" fillet

// Weld metal, lb per foot of weld.
function filletLbPerFt(leg, material) {
  const s = toNumber(leg);
  if (!(s > 0)) return null;
  return (s * s / 2) * 12 * (density(material) || density('carbon steel'));
}
function grooveLbPerFt(thickness, material) {
  const t = toNumber(thickness);
  if (!(t > 0)) return null;
  return grooveArea(t) * 12 * (density(material) || density('carbon steel'));
}

// GMAW lb/hr arc-on implied by Sentry's own floor: a 1/4" fillet laid at 6 in/min.
function sentryMigDeposition() {
  const lbPerFt = filletLbPerFt(0.25);
  const hrPerFt = 12 / SENTRY_MIG_IPM / 60;
  return lbPerFt / hrPerFt;
}

// Sentry 1997 applied rate for the same weld, over its arc time.
function sentryOperatingFactor() {
  const r = resolve({ category: 'Welding', operation: /^Fillet weld 1\/4 in - large weldment/, process: 'GMAW (MIG)',
    material: 'Carbon Steel', size: { 'Weld Size (in)': 0.25 } });
  if (!r.row) return null;
  const arcHrPerFt = 12 / SENTRY_MIG_IPM / 60;
  return { value: arcHrPerFt / r.row.hours, ref: r.row.code + ' (' + r.row.hours + ' hr/ft) vs ' + SENTRY_MIG_IPM + ' in/min arc travel' };
}

// settings: { weld_process, smaw_amps, deposition_lb_hr, operating_factor }
function deposition(settings) {
  const s = settings || {};
  if (Number(s.deposition_lb_hr) > 0) return { value: Number(s.deposition_lb_hr), source: 'yours', ref: 'shop setup' };
  const proc = String(s.weld_process || 'GMAW (MIG)');
  if (proc === 'SMAW') {
    // No amperage entered: 150 A, mid-range for 5/32" E7018 flat, read off the same chart. Said so.
    const mine = Number(s.smaw_amps) > SMAW_ZERO_AMPS;
    const a = mine ? Number(s.smaw_amps) : SMAW_DEFAULT_AMPS;
    return { value: SMAW_LB_PER_AMP * (a - SMAW_ZERO_AMPS), source: 'library',
      ref: '1962 Std 0.1.6 p.14 deposit chart at ' + a + ' A' + (mine ? '' : ' (default — enter your usual amperage)') };
  }
  if (proc === 'GMAW (MIG)') return { value: sentryMigDeposition(), source: 'library', ref: 'Sentry handwritten, 1/4" fillet at ' + SENTRY_MIG_IPM + ' in/min' };
  // Flux-core runs at or above MIG; TIG well below. Scaled from the MIG figure until the shop
  // enters its own lb/hr: FCAW same, GTAW one third (TIG deposits roughly 1-2 lb/hr by hand).
  if (proc === 'FCAW') return { value: sentryMigDeposition(), source: 'library', ref: 'MIG rate applied to flux-core (enter your own lb/hr)' };
  if (proc === 'GTAW') return { value: sentryMigDeposition() / 3, source: 'library', ref: 'one third of the MIG rate for TIG (enter your own lb/hr)' };
  return { missing: 'no deposition rate for ' + proc + ' — enter your lb/hr in shop setup' };
}

function operatingFactor(settings) {
  const s = settings || {};
  const of = Number(s.operating_factor);
  if (of > 0 && of <= 1) return { value: of, source: 'yours', ref: 'shop setup' };
  const d = sentryOperatingFactor();
  return d ? { value: d.value, source: 'library', ref: 'derived: ' + d.ref } : { missing: 'no operating factor' };
}

// weld: { kind: 'fillet'|'groove', size (leg or plate thickness, in), position, material }
// Returns { hours_per_ft, basis[], source } or { missing }.
function weldHoursPerFt(weld, settings) {
  const w = weld || {};
  const lb = w.kind === 'groove' ? grooveLbPerFt(w.size, w.material) : filletLbPerFt(w.size, w.material);
  if (lb == null) return { missing: 'weld size needed' };
  const dep = deposition(settings);
  if (dep.missing) return { missing: dep.missing };
  const of = operatingFactor(settings);
  if (of.missing) return { missing: of.missing };
  const pos = POSITION[String(w.position || 'flat').toLowerCase()] || 1;
  return {
    hours_per_ft: lb / dep.value / of.value / pos,
    source: dep.source === 'yours' && of.source === 'yours' ? 'yours' : 'library',
    basis: [
      lb.toFixed(4) + ' lb/ft weld metal (' + (w.kind === 'groove' ? 'single-V groove' : 'fillet') + ' ' + w.size + '")',
      dep.value.toFixed(2) + ' lb/hr arc on — ' + dep.ref,
      Math.round(of.value * 100) + '% arc time — ' + of.ref,
      pos === 1 ? 'flat position' : w.position + ' position × ' + pos + ' (0.1.6 p.14)',
    ],
  };
}

module.exports = { weldHoursPerFt, filletLbPerFt, grooveLbPerFt, deposition, operatingFactor, sentryMigDeposition, POSITION };
