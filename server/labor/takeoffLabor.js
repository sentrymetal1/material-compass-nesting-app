// =============================================================================
//  labor/takeoffLabor.js — the labour step of the take-off review, server side.
// -----------------------------------------------------------------------------
//  estimate.js works per ONE unit of a component. The review page works in JOB
//  hours, because that is what the estimator quotes and what goes on the
//  project (Component Quantity = job totals). This multiplies up by the
//  component's units, adds the tonnage, and puts the shop's own reference jobs
//  beside it as the ballpark:
//
//    bottom-up   = standards × what the take-off counted (always low: it only
//                  prices what it can count — see the missing list);
//    ballpark    = the shop's hr/ton for this job type × the job's tons.
//
//  Keller 40778 is why both are shown: bottom-up ~17 hr/ton, actual ~103.
// =============================================================================
const { estimateTakeoff, rowPounds } = require('./estimate');
const { BUCKETS } = require('./standards');
const shop = require('./shop');

const r2 = (n) => Math.round(n * 100) / 100;
const unitsOf = (x) => Math.max(1, Math.round(Number(x && x.units) || 1));
const compKey = (name) => String(name || '').trim() || '(no component)';

// takeoff = { rows, fittings } exactly as the review page holds them.
function laborForTakeoff(takeoff, profile, jobType) {
  const live = (r) => r && !r.deleted && Number(r.quantity) > 0;
  const rows = ((takeoff && takeoff.rows) || []).filter(live);
  const fittings = ((takeoff && takeoff.fittings) || []).filter(live);
  const ctx = shop.estimateContext(profile);
  const est = estimateTakeoff({ rows, fittings }, ctx);

  // Units and weight per component. A component's units are the most any of its rows carries,
  // the same rule the review page uses for its group headers.
  const meta = {};
  const touch = (name) => (meta[compKey(name)] = meta[compKey(name)] || { units: 1, lb: 0, unweighed: 0 });
  for (const r of rows) {
    const m = touch(r.component);
    m.units = Math.max(m.units, unitsOf(r));
    const disp = String(r.disposition || 'fabricate').toLowerCase();
    if (disp !== 'fabricate') continue;
    const lb = rowPounds(r);
    if (lb == null) m.unweighed++; else m.lb += lb;
  }
  for (const f of fittings) touch(f.component).units = Math.max(touch(f.component).units, unitsOf(f));

  const components = Object.entries(est.components).map(([name, c]) => {
    const units = (meta[name] || {}).units || 1;
    return {
      name, units,
      tons: r2(((meta[name] || {}).lb || 0) * units / 2000),
      items: c.lines.map((l) => ({
        what: l.what, bucket: l.bucket, standard: l.standard, source_ref: l.source_ref,
        per_unit: r2(l.hours), hours: r2(l.hours * units),
      })),
      missing: c.missing,
    };
  });

  let lb = 0, unweighed = 0;
  for (const m of Object.values(meta)) { lb += m.lb * m.units; unweighed += m.unweighed; }
  const tons = r2(lb / 2000);
  const bottomUp = r2(components.reduce((s, c) => s + c.items.reduce((a, i) => a + i.hours, 0), 0));

  const rates = shop.referenceRates(profile);
  const type = shop.JOB_TYPES[jobType] ? jobType : null;
  const ref = type && rates[type];
  const ballpark = ref && tons > 0
    ? { hours: r2(ref.hr_per_ton * tons), hr_per_ton: ref.hr_per_ton, jobs: ref.jobs, type }
    : { hours: null, type, reason: !type ? 'pick a job type' : !ref ? 'no reference jobs of this type yet' : 'no weight on this take-off' };

  return {
    buckets: BUCKETS, components, tons, unweighed_rows: unweighed,
    bottom_up: bottomUp, ballpark, reference_rates: rates, job_types: shop.JOB_TYPES,
  };
}

module.exports = { laborForTakeoff };
