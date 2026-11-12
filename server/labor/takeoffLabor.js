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
const WeldRules = require('../takeoff/public/weld-rules');   // shared with the review page
const Rail = require('../takeoff/public/rail-pricing');      // shared with the review page
const { catalog } = require('./components');

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
  const rawRows = ((takeoff && takeoff.rows) || []).filter(live);
  const rawFittings = ((takeoff && takeoff.fittings) || []).filter(live);
  // The weld schedule read off the drawings; a weld counts when it has a count, like a row a quantity.
  // Typical-weld rules (weld-rules.js), counted per drawing from its labelled pieces. A component
  // with rules has its AI-read weld schedule replaced by them — the same welds, never both.
  const ruled = WeldRules.expandAll({ rows: (takeoff && takeoff.rows) || [], fittings: (takeoff && takeoff.fittings) || [],
    weld_rules: (takeoff && takeoff.weld_rules) || [], drawing_counts: (takeoff && takeoff.drawing_counts) || {} });
  const rawWelds = ((takeoff && takeoff.welds) || [])
    .filter((w) => w && !w.deleted && Number(w.count) > 0 && !ruled.ruleComps[WeldRules.compKey(w.component)])
    .concat(ruled.welds);
  const ctx = Object.assign({}, shop.estimateContext(profile), { elbowComps: ruled.elbowComps });
  const rawFeatures = ((takeoff && takeoff.features) || []).filter((f) => f && !f.deleted && Number(f.count) > 0);

  // UNITS vs DRAWING QTY. A row's `units` is the component count when that is above 1, otherwise
  // its own drawing's QTY REQ'D (sheet_qty) — the review page's compCountOf rule. Taking the most
  // units on any row as the component count priced MCP-10013 (2026-11-11) as TWO whole handrails,
  // 1,293 h, because two of its 43 drawings are built twice. Now the component count comes from
  // rows whose units differ from their sheet qty, and a drawing built more than once is multiplied
  // into its own rows (and its welds and features) before the per-unit estimate.
  const sheetQty = (r) => Math.max(1, Math.round(Number(r && r.sheet_qty) || 1));
  const compUnits = {};
  for (const r of rawRows.concat(rawFittings)) {
    const k = compKey(r.component), u = unitsOf(r);
    compUnits[k] = Math.max(compUnits[k] || 1, u !== sheetQty(r) ? u : 1);
  }
  const multOf = (r) => { const cu = compUnits[compKey(r.component)] || 1; return Math.max(1, Math.round(unitsOf(r) / cu)); };
  const sheetMult = {};
  for (const r of rawRows) {
    const k = compKey(r.component) + '|' + String(r.source_sheet || '').trim().toUpperCase();
    sheetMult[k] = Math.max(sheetMult[k] || 1, multOf(r));
  }
  const multOfSheet = (x) => sheetMult[compKey(x.component) + '|' + String(x.source_sheet || '').trim().toUpperCase()] || 1;
  const scaleQty = (r) => { const m = multOf(r); return Object.assign({}, r, { quantity: Number(r.quantity) * m, units: compUnits[compKey(r.component)] || 1 }); };

  // HANDRAIL BY THE FOOT (rail-pricing.js, Mark 2026-11-11). A component priced per foot has its
  // rail pieces, its fittings and the welds that only join rail taken out of the member-by-member
  // estimate — the shop's hr/ft covers cutting, fitting and welding them — and gets cut / fit / weld
  // lines of feet × that rate instead. Plates, brackets and their welds stay priced on top.
  const methods = (takeoff && takeoff.labor_methods) || {};
  const rail = {};
  for (const r of rawRows) {
    const lk = Rail.compKey(r.component); if (lk in rail) continue;
    const m = Rail.methodOf({ labor_methods: methods }, r.component);
    if (m.mode !== 'per_ft') { rail[lk] = null; continue; }
    const sheets = Rail.sheetsOf({ rows: rawRows }, r.component, m);
    rail[lk] = { name: compKey(r.component), method: m, sheets, bySheet: Object.fromEntries(sheets.map((s) => [Rail.sheetKey(s.sheet), s])),
      dropped: { pieces: 0, fittings: 0, welds: 0 } };
  }
  const railOf = (x) => rail[Rail.compKey(x && x.component)] || null;
  const railSheet = (x) => { const c = railOf(x); return c ? c.bySheet[Rail.sheetKey(x.source_sheet)] : null; };
  const isRail = (r) => { const c = railOf(r); return !!c && Rail.covers(r, railSheet(r)); };

  // Covered rows still go in (weight, load-out, drawing count) — flagged so they get no member hours.
  const rows = rawRows.map((r) => { const s = scaleQty(r); if (isRail(r)) { s._rail = true; railOf(r).dropped.pieces++; } return s; });
  const fittings = rawFittings.filter((f) => { if (railOf(f)) { railOf(f).dropped.fittings++; return false; } return true; }).map(scaleQty);
  const welds = rawWelds.filter((w) => {
    const c = railOf(w); if (!c) return true;
    // An AI-read schedule weld or a typical weld that only joins rail is inside the per-foot rate.
    if (!w.from_rule || Rail.weldCovered(w.joins, railSheet(w))) { c.dropped.welds++; return false; }
    return true;
  }).map((w) => Object.assign({}, w, { count: Number(w.count) * multOfSheet(w) }));
  const features = rawFeatures.map((f) => Object.assign({}, f, { count: Number(f.count) * multOfSheet(f) }));
  const extras = (takeoff && takeoff.extras) || {};
  const est = estimateTakeoff({ rows, fittings, welds, features, extras }, ctx);

  // The per-foot lines. Feet are job feet (each drawing × how many times it is built), carried per
  // unit like every other line so the mapping below multiplies them back the same way.
  const railInfo = {};
  const railComps = Object.values(rail).filter(Boolean);
  if (railComps.length) {
    const P = ctx.model, G = P.general;
    const cat = Object.fromEntries(catalog((profile && profile.rates) || {}, P, P.materials).map((c) => [c.key, c]));
    for (const c of railComps) {
      const comp = est.components[c.name] || (est.components[c.name] = { hours: Object.fromEntries(BUCKETS.map((b) => [b, 0])), lines: [], missing: [] });
      const cu = compUnits[c.name] || 1;
      // The rail's material: the most pieces among the rail it covers (stainless rail → the stainless rate).
      const tally = {};
      for (const r of rawRows) if (railOf(r) === c && isRail(r)) { const k = pm.materialKey(r.material_type, r.specification); tally[k] = (tally[k] || 0) + Number(r.quantity); }
      const mat = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || 'CS';
      const byStd = {};
      let coveredLb = 0;
      for (const r of rows) if (r._rail && railOf(r) === c) { const p = rowPounds(r); if (p != null) coveredLb += p * cu; }
      for (const s of c.sheets) {
        s.mult = multOfSheet({ component: c.name, source_sheet: s.sheet });
        if (s.feet_from === 'none') comp.missing.push({ what: 'feet of rail — drawing ' + s.sheet, reason: 'no top rail labelled on this drawing — type its feet on the Labor tab' });
        if (s.feet > 0) byStd[s.std] = (byStd[s.std] || 0) + s.feet * s.mult;
      }
      const add = [], rates = {};
      for (const [std, jobFt] of Object.entries(byStd)) {
        const label = Rail.STD_SET[std], row = cat[std];
        const cell = row && ((row.by_material || {})[mat] || (row.by_material || {}).CS);
        if (!cell || cell.value == null) { comp.missing.push({ what: 'Handrail ' + label + ' — ' + Math.round(jobFt) + ' ft', reason: 'no hr/ft for it in your Labor setup' }); continue; }
        const rate = cell.value, mine = cell.source === 'yours';
        rates[std] = { label, rate, source: cell.source, ref: mine ? 'your Labor setup' : 'library: ' + (cell.ref || row.library_ref || ''), feet: r2(jobFt), hours: r2(rate * jobFt) };
        const ft = jobFt / cu;
        for (const [bucket, share, verb] of [['Cutting_Hrs', G.share_cut.value, 'cut'], ['Assy_Hrs', G.share_fit.value, 'fit'], ['Weld_Hrs', G.share_weld.value, 'weld']]) {
          if (!(share > 0)) continue;
          add.push({ bucket, hours: rate * share * ft, units: ft, unit_label: 'ft of rail', per_unit: rate * share,
            what: 'Handrail ' + label + ' — ' + verb + ' (' + Math.round(share * 100) + '% of ' + rate.toFixed(3).replace(/0+$/, '') + ' hr/ft)',
            standard: std, source_ref: rate + ' hr/ft of rail (' + rates[std].ref + ') × ' + Math.round(share * 100) + '% ' + verb + ' share (Labor setup cut/fit/weld split)',
            derived: !mine && !!cell.derived, note: mine ? null : 'library rate — put your own in Labor setup → Handrail', rail: true, op: 'rail:' + std });
        }
      }
      for (const l of add) comp.hours[l.bucket] += l.hours;
      comp.lines = add.concat(comp.lines);
      railInfo[c.name] = { material: mat, units: cu, rates, covered_lb: Math.round(coveredLb), dropped: c.dropped, auto: !!c.method.auto,
        total_ft: r2(c.sheets.reduce((a, s) => a + (s.feet > 0 ? s.feet * s.mult : 0), 0) * cu),
        sheets: c.sheets.map((s) => ({ sheet: s.sheet, feet: s.feet, feet_from: s.feet_from, top_ft: s.top_ft, top_pieces: s.top_pieces,
          std: s.std, std_auto: s.std_auto, std_from: s.std_from, kick: s.kick, mult: s.mult, covered: s.covered, on_top: s.on_top })) };
    }
  }
  // What a rule could not count (pieces not labelled, no length) is listed, never zero-filled.
  for (const m of ruled.missing) {
    const comp = Object.keys(est.components).find((n) => n.trim().toLowerCase() === WeldRules.compKey(m.component || '')) ||
      Object.keys(est.components).find((n) => n !== 'Whole job');
    if (comp) est.components[comp].missing.push(m);
  }
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
        from_drawing: !!l.from_drawing, op: l.op || null, rail: !!l.rail,
      })),
      missing: c.missing,
      rail: railInfo[name] || null,
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
