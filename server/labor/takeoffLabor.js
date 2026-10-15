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
const pm = require('./processModel');
const { typeForLine } = require('./laborTypes');

const r2 = (n) => Math.round(n * 100) / 100;
const unitsOf = (x) => Math.max(1, Math.round(Number(x && x.units) || 1));
const compKey = (name) => String(name || '').trim() || '(no component)';

// Repeat units: the n-th identical unit takes pct^log2(n) of the first one's time (a learning curve);
// u units together take the sum. pct = 1 is no learning — u × the first unit, the old rule.
function learnFactor(u, pct) {
  if (!(u > 1) || !(pct > 0) || pct >= 1) return u;
  const b = Math.log(pct) / Math.log(2);
  let t = 0; for (let i = 1; i <= u; i++) t += Math.pow(i, b);
  return t;
}

// takeoff = { rows, fittings, welds, features, extras } exactly as the review page holds them.
function laborForTakeoff(takeoff, profile, jobType) {
  const live = (r) => r && !r.deleted && Number(r.quantity) > 0;
  const rows = ((takeoff && takeoff.rows) || []).filter(live);
  const fittings = ((takeoff && takeoff.fittings) || []).filter(live);
  // The weld schedule read off the drawings; a weld counts when it has a count, like a row a quantity.
  const welds = ((takeoff && takeoff.welds) || []).filter((w) => w && !w.deleted && Number(w.count) > 0);
  const ctx = shop.estimateContext(profile);
  const features = ((takeoff && takeoff.features) || []).filter((f) => f && !f.deleted && Number(f.count) > 0);
  const extras = (takeoff && takeoff.extras) || {};
  const est = estimateTakeoff({ rows, fittings, welds, features, extras }, ctx);
  const learnPct = pm.opv(ctx.model, 'LEARNING', 'pct') || 1;

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
    const lf = learnFactor(units, learnPct);       // hours for all units, in first-unit multiples
    return {
      name, units, learning: units > 1 && lf < units ? { pct: learnPct, factor: r2(lf), of: units } : null,
      tons: r2(((meta[name] || {}).lb || 0) * units / 2000),
      items: c.lines.map((l) => ({
        what: l.what, bucket: l.bucket, standard: l.standard, source_ref: l.source_ref,
        // A per-job line (setup, paperwork) is done once, not once per unit.
        per_unit: r2(l.hours), hours: r2(l.hours * (l.per_job ? 1 : lf)),
        // What the hours were counted from, so the review can show Qty x Hrs each = Total and
        // recompute when either is edited: pieces, ft of cut, ft of weld, tons or joints (job qty).
        qty: l.units != null ? Math.round(Number(l.units) * (l.per_job ? 1 : units) * 1000) / 1000 : null,
        unit_label: l.unit_label || '',
        // Hrs each so that Qty x Hrs each = Total, the learning curve included.
        each: l.units > 0 ? (l.hours * (l.per_job ? 1 : lf)) / (Number(l.units) * (l.per_job ? 1 : units)) : (l.per_unit != null ? Number(l.per_unit) : null),
        derived: !!l.derived, note: l.note || null,
        // The detail under the broad bucket (MIG, TIG, plasma, band saw…), laborTypes.js.
        labor_type: typeForLine(l), process: l.process || null, material: l.material || null,
        from_drawing: !!l.from_drawing,
      })),
      missing: c.missing,
    };
  });

  let lb = 0, unweighed = 0;
  for (const m of Object.values(meta)) { lb += m.lb * m.units; unweighed += m.unweighed; }
  const tons = r2(lb / 2000);
  const bottomUp = r2(components.reduce((s, c) => s + c.items.reduce((a, i) => a + i.hours, 0), 0));

  // The take-off's main material by weight, so the ballpark compares like with like: stainless
  // handrail against the shop's stainless handrail jobs when it has any, else the type overall.
  const byMat = {};
  for (const r of rows) {
    if (String(r.disposition || 'fabricate').toLowerCase() !== 'fabricate') continue;
    const p = rowPounds(r); if (p == null) continue;
    const k = pm.materialKey(r.material_type, r.specification); byMat[k] = (byMat[k] || 0) + p * unitsOf(r);
  }
  const mainMat = Object.keys(byMat).sort((a, b) => byMat[b] - byMat[a])[0] || 'CS';
  const rates = shop.referenceRates(profile);
  const type = shop.JOB_TYPES[jobType] ? jobType : null;
  const exact = type && rates[type + '|' + mainMat];
  const ref = exact || (type && rates[type]);
  const ballpark = ref && tons > 0
    ? { hours: r2(ref.hr_per_ton * tons), hr_per_ton: ref.hr_per_ton, jobs: ref.jobs, type, material: mainMat,
        matched: exact ? 'type and material' : 'type only (no ' + pm.MAT[mainMat].label.toLowerCase() + ' reference jobs of this type)' }
    : { hours: null, type, reason: !type ? 'pick a job type' : !ref ? 'no reference jobs of this type yet' : 'no weight on this take-off' };

  return {
    buckets: BUCKETS, components, tons, unweighed_rows: unweighed,
    bottom_up: bottomUp, ballpark, reference_rates: rates, job_types: shop.JOB_TYPES, main_material: mainMat,
  };
}

module.exports = { laborForTakeoff };
