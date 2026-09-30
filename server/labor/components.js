// =============================================================================
//  labor/components.js — standard components priced per unit.
// -----------------------------------------------------------------------------
//  Handrail per foot, stringers per foot, ladders, typical details each. These
//  are the pieces an estimator prices by the foot or by the each rather than by
//  member, and where hours per POUND vary most by type: the library puts pipe
//  handrail at 4.5 hr/cwt (90 hr/ton) and a welded truss at 1.15 (23 hr/ton).
//
//  Every default is BUILT from a library row plus a weight, and says so. Where
//  there is nothing to build from (treads, lugs), the default is null and the
//  estimate asks the shop. The shop's own number, when entered, replaces it.
// =============================================================================
const { resolve } = require('./standards');
const { pipeDims } = require('./pipeJoint');
const { pipeSectionLbPerIn, rolledShapeLbPerFt } = require('../weights');

const cwt = (operation) => resolve({ category: 'Assembly', operation });

// Sentry's 1997 note on the pipe-handrail row: "8 lb/ft w/o toe plate, 12 lb/ft with" for a
// standard 2-line 1-1/4" rail with posts. A third line adds one more run of the same pipe.
const RAIL_2_LB_FT = 8;
const RAIL_2_KICK_LB_FT = 12;
function extraRailLbFt() {
  const d = pipeDims('1-1/4"', 'SCH 40');
  return d ? pipeSectionLbPerIn(d.od, d.wall, 'Carbon Steel') * 12 : null;
}

function perFtFromCwt(op, lbPerFt, how) {
  const r = cwt(op);
  if (!r.row || !(lbPerFt > 0)) return { value: null, ref: r.missing || 'weight unknown' };
  return { value: r.row.hours * lbPerFt / 100, ref: r.row.hours + ' hr/cwt (' + r.row.sourceRef + ') × ' + lbPerFt.toFixed(2) + ' lb/ft' + (how ? ' — ' + how : ''), code: r.row.code };
}

// key → { label, unit, group, default() }
const STANDARD = {
  handrail_pipe_2:      { group: 'Handrail', label: 'Pipe rail, 2-line', unit: 'hr/ft',
    default: () => perFtFromCwt('Pipe handrails', RAIL_2_LB_FT, 'Sentry 1997 weight') },
  handrail_pipe_2_kick: { group: 'Handrail', label: 'Pipe rail, 2-line + kickplate', unit: 'hr/ft',
    default: () => perFtFromCwt('Pipe handrails', RAIL_2_KICK_LB_FT, 'Sentry 1997 weight with toe plate') },
  handrail_pipe_3:      { group: 'Handrail', label: 'Pipe rail, 3-line', unit: 'hr/ft', derived: true,
    default: () => perFtFromCwt('Pipe handrails', RAIL_2_LB_FT + (extraRailLbFt() || 0), 'derived: 2-line + one 1-1/4" Sch 40 rail — check this') },
  handrail_pipe_3_kick: { group: 'Handrail', label: 'Pipe rail, 3-line + kickplate', unit: 'hr/ft', derived: true,
    default: () => perFtFromCwt('Pipe handrails', RAIL_2_KICK_LB_FT + (extraRailLbFt() || 0), 'derived: 2-line + kick + one more rail — check this') },
  handrail_angle:       { group: 'Handrail', label: 'Angle rail', unit: 'hr/cwt',
    default: () => { const r = cwt('Angle handrails'); return r.row ? { value: r.row.hours, ref: r.row.sourceRef, code: r.row.code } : { value: null, ref: r.missing }; } },
  stringer:             { group: 'Stairs & ladders', label: 'Stair stringers', unit: 'hr/cwt',
    default: () => { const r = cwt('Stair stringers'); return r.row ? { value: r.row.hours, ref: r.row.sourceRef, code: r.row.code } : { value: null, ref: r.missing }; } },
  tread:                { group: 'Stairs & ladders', label: 'Stair tread', unit: 'hr/each',
    default: () => ({ value: null, ref: 'no standard — the 1997 sheet priced treads bought-in with labor included' }) },
  ladder_cage:          { group: 'Stairs & ladders', label: 'Ladder with cage', unit: 'hr/cwt',
    default: () => { const r = cwt('Ladders and cages'); return r.row ? { value: r.row.hours, ref: r.row.sourceRef, code: r.row.code } : { value: null, ref: r.missing }; } },
  clip_angle:           { group: 'Typical details', label: 'Connection clip angle', unit: 'hr/each',
    default: () => { const r = cwt(/^Connection angle clip/); return r.row ? { value: r.row.hours, ref: r.row.sourceRef, code: r.row.code } : { value: null, ref: r.missing }; } },
  base_plate:           { group: 'Typical details', label: 'Base plate, complete', unit: 'hr/each',
    default: () => { const r = resolve({ category: 'Assembly', operation: /^Base plate - complete/, size: { 'Member Depth (in)': 8 } });
      return r.row ? { value: r.row.hours, ref: r.row.sourceRef + ' (W8 column; varies by depth)', code: r.row.code } : { value: null, ref: r.missing }; } },
  lifting_lug:          { group: 'Typical details', label: 'Lifting lug', unit: 'hr/each',
    default: () => ({ value: null, ref: 'no standard' }) },
};

// A stringer is priced by weight; this turns it into hours per foot for a given channel.
function stringerPerFt(size, rate) {
  const lb = rolledShapeLbPerFt(size);
  return lb && rate > 0 ? rate * lb / 100 : null;
}

// Library default and the shop's own value side by side, for the setup screen and the estimate.
// shopRates: { [key]: number } from the shop profile.
function catalog(shopRates) {
  const mine = shopRates || {};
  return Object.entries(STANDARD).map(([key, s]) => {
    const d = s.default();
    const yours = Number(mine[key]) > 0 ? Number(mine[key]) : null;
    return {
      key, group: s.group, label: s.label, unit: s.unit, derived: !!s.derived,
      library: d.value == null ? null : Math.round(d.value * 10000) / 10000, library_ref: d.ref,
      yours, value: yours != null ? yours : (d.value == null ? null : d.value),
      source: yours != null ? 'yours' : (d.value == null ? 'missing' : 'library'),
    };
  });
}

module.exports = { catalog, stringerPerFt, STANDARD };
