// =============================================================================
//  labor/pipeJoint.js — hours per pipe butt-weld joint, scaled from the SHOP.
// -----------------------------------------------------------------------------
//  The standards library has no pipe butt-weld rows, Sentry has no numbers of
//  its own (little pipe work), and the published piping manuals are
//  copyrighted. So this does NOT carry an hours table. It carries geometry,
//  and takes the hours from the shop:
//
//    - the shop enters hours for one or two reference joints (the shop labour
//      form, e.g. 4" SCH 40 and 8" SCH 40);
//    - every other size and schedule is scaled from those by what actually
//      changes between joints: the length of the joint (fit-up, root pass)
//      and the volume of weld metal in the groove (fill and cap passes).
//
//  With TWO anchors:  hours = a * circumference + b * weld volume, solved
//  exactly through both. With ONE: hours scale by weld volume alone, which
//  runs LOW on small thin-wall pipe (fit-up time does not shrink with the
//  groove) — the result says so. With NONE: null, and the caller flags it.
//  Never a made-up default.
//
//  The groove is the standard B31.3 / B16.25 single-V: 37.5 deg bevel each
//  side, 1/16" land, 1/8" root gap, 1/16" cap reinforcement. Pipe OD and wall
//  come from the same NPS table the fitting weights use (buttWeldWeight.js).
// =============================================================================
const { NPS_DIM } = require('../buttWeldWeight');

const BEVEL = 37.5 * Math.PI / 180;
const LAND = 1 / 16;
const GAP = 1 / 8;
const CAP_H = 1 / 16;

// ASME B36.10: STD matches SCH 40 through 10", then stays at .375. XS matches SCH 80 through 8",
// then stays at .500. These two are the only schedule names the table does not key directly.
const STD_WALL_ABOVE_10 = 0.375;
const XS_WALL_ABOVE_8 = 0.5;

const clean = (s) => String(s == null ? '' : s).trim().replace(/[”“]/g, '"');

function npsNumber(size) {
  const s = clean(size).replace(/"/g, '');
  const m = s.match(/^(\d+)(?:-(\d+)\/(\d+))?$|^(\d+)\/(\d+)$/);
  if (!m) return null;
  if (m[4]) return Number(m[4]) / Number(m[5]);
  return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
}

// '4"' + 'SCH 40' -> { od: 4.5, wall: 0.237 }. Accepts 'STD', 'XS', 'SCH 40 (STD)', '40'.
function pipeDims(size, schedule) {
  const sz = clean(size);
  const nps = npsNumber(sz);
  if (!(nps > 0)) return null;
  const sch = clean(schedule).toUpperCase().replace(/\(.*\)/, '').trim();
  const keys = Object.keys(NPS_DIM).filter((k) => k.indexOf(sz + ' | ') === 0);
  if (!keys.length) return null;
  const od = NPS_DIM[keys[0]][0];
  const bySch = (label) => {
    const k = keys.find((x) => x.indexOf(sz + ' | SCH ' + label + ' (') === 0);
    return k ? { od, wall: NPS_DIM[k][1] } : null;
  };
  if (sch === 'STD') return nps <= 10 ? bySch('40') : { od, wall: STD_WALL_ABOVE_10 };
  if (sch === 'XS') return nps <= 8 ? bySch('80') : { od, wall: XS_WALL_ABOVE_8 };
  const label = sch.replace(/^SCH(EDULE)?\s*/, '');
  return label ? bySch(label) : null;
}

// Cross-section of the weld groove, square inches.
function grooveArea(wall) {
  const depth = Math.max(0, wall - LAND);
  const vee = depth * depth * Math.tan(BEVEL);
  const capWidth = GAP + 2 * depth * Math.tan(BEVEL) + 1 / 8;
  return GAP * wall + vee + (2 / 3) * capWidth * CAP_H;
}

// The two things a joint's hours are made of: its length and its weld metal.
function jointGeometry(size, schedule) {
  const d = pipeDims(size, schedule);
  if (!d) return null;
  return {
    od: d.od, wall: d.wall,
    circumference: Math.PI * d.od,                          // inches of joint
    volume: grooveArea(d.wall) * Math.PI * (d.od - d.wall), // cubic inches of weld metal
  };
}

// anchors: [{ size:'4"', schedule:'SCH 40', hours: 2.5 }, ...] from the shop form.
// Returns { hours, basis, note } or { missing }.
function jointHours(size, schedule, anchors) {
  const g = jointGeometry(size, schedule);
  if (!g) return { missing: 'no pipe dimensions for ' + clean(size) + ' ' + clean(schedule) };
  const good = (anchors || [])
    .map((a) => ({ a, g: jointGeometry(a.size, a.schedule) }))
    .filter((x) => x.g && Number(x.a.hours) > 0);
  if (!good.length) return { missing: 'no shop pipe-weld hours entered — add a reference joint on the shop labour form' };

  if (good.length >= 2) {
    const [p, q] = good;
    const det = p.g.circumference * q.g.volume - q.g.circumference * p.g.volume;
    if (Math.abs(det) > 1e-9) {
      const a = (Number(p.a.hours) * q.g.volume - Number(q.a.hours) * p.g.volume) / det;
      const b = (p.g.circumference * Number(q.a.hours) - q.g.circumference * Number(p.a.hours)) / det;
      // Both terms must be real work. A negative one means the two anchors contradict the model
      // (e.g. the smaller joint entered with more hours) — fall back rather than extrapolate it.
      if (a >= 0 && b >= 0) {
        return {
          hours: a * g.circumference + b * g.volume,
          basis: 'shop anchors ' + p.a.size + ' ' + p.a.schedule + ' & ' + q.a.size + ' ' + q.a.schedule + ', scaled by joint length + weld volume',
        };
      }
    }
  }
  const ref = good[0];
  return {
    hours: Number(ref.a.hours) * g.volume / ref.g.volume,
    basis: 'shop anchor ' + ref.a.size + ' ' + ref.a.schedule + ', scaled by weld volume',
    note: good.length >= 2 ? 'the two reference joints disagree with each other; used the first only'
      : 'one reference joint only — small thin-wall joints will read low; add a second reference size',
  };
}

module.exports = { jointHours, jointGeometry, pipeDims, grooveArea, npsNumber };
