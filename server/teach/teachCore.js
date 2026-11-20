// =============================================================================
//  teach/teachCore.js — learn a shop's habits from its past jobs (plan: docs/TEACH_TAKEOFF_PLAN.md).
// -----------------------------------------------------------------------------
//  Pure functions (tested in teachCore.test.js). teachRoutes.js does the files, the AI and the writes.
//
//  A past JOB holds any documents the shop has: proposal, estimate sheet, material list, supplier
//  quote, specification, job cost / actual hours report, drawings. The AI reads each FILE into one
//  EXTRACT (shape: EXTRACT_TOOL below). buildProposals() turns a job's extracts into PROPOSALS the
//  admin confirms or rejects; nothing is saved unconfirmed.
//
//  Every proposed number carries the document and place it came from ("where"). A value with no
//  document behind it is never proposed. Where documents disagree (tons on the estimate vs the
//  material list) the proposal shows every value with its source and asks; it never averages.
// =============================================================================

const KINDS = {
  proposal: 'Quote / proposal',
  estimate: 'Estimate or take-off sheet',
  material_list: 'Material list',
  supplier_quote: 'Supplier quote',
  specification: 'Specification',
  job_cost: 'Job cost / actual hours',
  drawings: 'Drawings',
  other: 'Other',
};
const KIND_KEYS = Object.keys(KINDS);

// Labor categories: the same keys as labor/shop.js JOB_TYPES (reference jobs).
const LABOR_CATS = ['skid_frame', 'platform_stairs', 'plate_tank', 'pipe_spool', 'structural', 'handrail', 'stairs_ladders',
  'vessel', 'sheet_metal', 'machined', 'misc'];
const MATS = ['CS', 'SS', 'AL', 'DSS', 'NI', 'CU', 'TI'];   // labor/processModel MAT keys

const valWhere = (desc) => ({ type: 'object', description: desc + ' Only when the document states it.',
  properties: { value: { type: 'number' }, where: { type: 'string', description: 'Page, sheet/cell or line it was read from.' } },
  required: ['value', 'where'] });
const textWhere = { type: 'object', properties: { text: { type: 'string' }, where: { type: 'string' } }, required: ['text', 'where'] };

const EXTRACT_TOOL = {
  name: 'record_document',
  description: 'Record what this one document from a past fabrication job states. Leave out anything it does not state; never estimate or infer a number.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KIND_KEYS, description: 'What this document is.' },
      summary: { type: 'string', description: 'One sentence: what the document is and what job it is for.' },
      job_name: { type: 'string' }, job_number: { type: 'string' }, customer: { type: 'string' },
      date: { type: 'string', description: 'Date on the document, as YYYY-MM-DD or YYYY-MM.' },
      project_type_guess: { type: 'string', description: 'Short project type in shop words, e.g. "Structural platform", "Stairs & handrail", "Pipe rack", "Equipment skid".' },
      labor_category_guess: { type: 'string', enum: LABOR_CATS },
      main_material: { type: 'string', enum: MATS, description: 'CS carbon steel, SS stainless, AL aluminum, DSS duplex, NI nickel alloy, CU copper alloys, TI titanium.' },
      price: valWhere('Total price quoted to the customer, in dollars.'),
      tons: valWhere('Total steel weight in short tons.'),
      lbs: valWhere('Total steel weight in pounds.'),
      est_hours: valWhere('Total ESTIMATED shop labor hours.'),
      actual_hours: valWhere('Total ACTUAL shop labor hours (job cost / time records).'),
      material_cost: valWhere('Total material cost in dollars.'),
      labor_cost: valWhere('Total labor cost in dollars.'),
      markup_pct: valWhere('Markup or margin percent stated, e.g. 15 for 15%.'),
      hours_by_trade: { type: 'array', items: { type: 'object', properties: {
        trade: { type: 'string' }, est_hours: { type: 'number' }, actual_hours: { type: 'number' }, rate: { type: 'number' }, where: { type: 'string' } },
        required: ['trade', 'where'] } },
      scope_included: { type: 'array', items: textWhere, description: 'Work the shop says it includes.' },
      scope_excluded: { type: 'array', items: textWhere, description: 'Work the shop says it excludes / by others.' },
      finish: { type: 'array', items: textWhere, description: 'Finish: galvanize, prime, paint system, powder coat, bare.' },
      buyouts: { type: 'array', items: textWhere, description: 'Items bought out complete (grating, stair treads, bolts, castings).' },
      requirements: { type: 'array', items: textWhere, description: 'Spec requirements that drive cost: coatings, NDE, welding code, certifications.' },
      outside_costs: { type: 'array', items: { type: 'object', properties: {
        what: { type: 'string' }, vendor: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string', description: 'lot, lb, cwt, ton, ea, hr' },
        where: { type: 'string' } }, required: ['what', 'where'] } },
      material_prices: { type: 'array', items: { type: 'object', properties: {
        item: { type: 'string', description: 'Shape/size or material as written, e.g. "W8x31", "1/4 plate A36".' },
        vendor: { type: 'string' }, weight_lbs: { type: 'number' }, price: { type: 'number', description: 'Extended price for that line.' },
        unit_price: { type: 'number' }, unit: { type: 'string', description: 'lb, cwt, ft, ea' }, where: { type: 'string' } },
        required: ['item', 'where'] } },
    },
    required: ['kind', 'summary'],
  },
};

// ---------- helpers ---------------------------------------------------------------------------
const s = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const tkey = (t) => s(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const srcOf = (f, where) => (f.name || 'document') + (s(where) ? ' · ' + s(where) : '');
let seq = 0;
const pid = (p) => p + '_' + (++seq).toString(36);

// A value list [{value, src, kind}] -> agreement check. Values within 10% of each other agree.
function agreement(list) {
  const vals = list.filter((x) => x.value);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals.map((x) => x.value)), hi = Math.max(...vals.map((x) => x.value));
  return hi > lo * 1.1 ? 'Documents disagree: ' + vals.map((x) => x.value.toLocaleString('en-US') + ' (' + x.src + ')').join(' vs ') : null;
}

// job: { name, number, project_type:{name}, labor_cat, files:[{id, name, kind, extract}] }
// -> { proposals:[...], checks:[...] }
function buildProposals(job) {
  const files = (job.files || []).filter((f) => f.extract && f.status === 'read');
  const ex = (f) => f.extract || {};
  const proposals = [], checks = [];

  // ---- reference job: tons + hours ----
  const tonsList = [];
  for (const f of files) {
    const e = ex(f);
    if (e.tons && num(e.tons.value)) tonsList.push({ value: r2(num(e.tons.value)), src: srcOf(f, e.tons.where), kind: f.kind });
    else if (e.lbs && num(e.lbs.value)) tonsList.push({ value: r2(num(e.lbs.value) / 2000), src: srcOf(f, e.lbs.where) + ' (' + Math.round(num(e.lbs.value)).toLocaleString('en-US') + ' lb)', kind: f.kind });
  }
  const actual = files.filter((f) => ex(f).actual_hours && num(ex(f).actual_hours.value)).map((f) => ({ value: r1(num(ex(f).actual_hours.value)), src: srcOf(f, ex(f).actual_hours.where), kind: f.kind }));
  const est = files.filter((f) => ex(f).est_hours && num(ex(f).est_hours.value)).map((f) => ({ value: r1(num(ex(f).est_hours.value)), src: srcOf(f, ex(f).est_hours.where), kind: f.kind }));
  const tonsCheck = agreement(tonsList);
  if (tonsCheck) checks.push({ what: 'Weight', text: tonsCheck });
  if (actual.length && est.length) {
    const a = actual[0].value, e = est[0].value;
    checks.push({ what: 'Hours', text: 'Estimated ' + e.toLocaleString('en-US') + ' h (' + est[0].src + '), actual ' + a.toLocaleString('en-US') + ' h (' + actual[0].src + '): ' +
      (a > e ? Math.round((a / e - 1) * 100) + '% over' : Math.round((1 - a / e) * 100) + '% under') + ' the estimate.' });
  }
  // Preference for the default shown: estimate/material list for tons, actual hours over estimated.
  const pick = (list, order) => list.slice().sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind))[0] || null;
  const tons = pick(tonsList, ['estimate', 'material_list', 'job_cost', 'proposal', 'drawings', 'specification', 'other', 'supplier_quote']);
  const hours = actual[0] || est[0] || null;
  const mats = files.map((f) => ex(f).main_material).filter(Boolean);
  const material = mats.length ? mats.sort((a, b) => mats.filter((m) => m === b).length - mats.filter((m) => m === a).length)[0] : 'CS';
  const firstDate = files.map((f) => s(ex(f).date)).find(Boolean) || '';
  if (tonsList.length || actual.length || est.length) {
    proposals.push({ id: pid('rj'), type: 'reference_job', title: 'Reference job (tons and hours)',
      fields: { tons: tons ? tons.value : null, hours: hours ? hours.value : null, hours_kind: actual.length ? 'actual' : (est.length ? 'estimated' : ''),
        material, labor_cat: job.labor_cat || '', date: firstDate.slice(0, 10) },
      options: { tons: tonsList, hours: actual.concat(est) },
      source: [tons && tons.src, hours && hours.src].filter(Boolean).join(' · '),
      note: !tons || !hours ? 'Needs both tons and hours to be used. Type the missing one from your records, or leave this unticked.' : (actual.length ? '' : 'Hours are the ESTIMATE; actual hours (a job cost report) teach more.'),
      accept: !!(tons && hours) });
  }

  // ---- scope habits ----
  const seen = {};
  const habit = (label, list, f) => {
    for (const it of list || []) {
      const t = s(it && it.text); if (!t) continue;
      const k = label + '|' + tkey(t); if (seen[k]) continue; seen[k] = 1;
      // "Includes" is mostly what THIS job was ("two platforms per S-101"), not a habit: opt in. Exclusions,
      // finish, buyouts and spec requirements are how the shop works: opt out.
      proposals.push({ id: pid('sc'), type: 'scope', title: label, fields: { text: t }, source: srcOf(f, it.where), accept: label !== 'Includes',
        note: label === 'Includes' ? 'Tick only if your shop includes this on every job of this type.' : '' });
    }
  };
  // Scope habits come from what the shop TOLD the customer (proposal) or was held to (spec). An
  // estimate or job cost report lists cost lines, and read as scope they produced "Galvanizing (cost
  // line present)"; their money is proposed below as outside costs instead.
  for (const f of files) {
    if (!['proposal', 'specification', 'other'].includes(f.kind)) continue;
    const e = ex(f);
    habit('Includes', e.scope_included, f);
    habit('Excludes', e.scope_excluded, f);
    habit('Finish', e.finish, f);
    habit('Bought out', e.buyouts, f);
    habit('Spec requirement', e.requirements, f);
  }

  // ---- outside costs: the same cost on two documents (estimate + job cost) is one card, both sources ----
  const ocSeen = {};
  for (const f of files) {
    for (const o of ex(f).outside_costs || []) {
      if (!s(o.what)) continue;
      const k = tkey(o.what).split(' ')[0] + '|' + (num(o.amount) || '');
      if (ocSeen[k]) { ocSeen[k].source += ' · also ' + srcOf(f, o.where); if (!ocSeen[k].fields.vendor && s(o.vendor)) ocSeen[k].fields.vendor = s(o.vendor); continue; }
      ocSeen[k] = { id: pid('oc'), type: 'outside_cost', title: 'Outside cost',
        fields: { what: s(o.what), vendor: s(o.vendor), amount: num(o.amount), unit: s(o.unit) || 'lot', date: s(ex(f).date).slice(0, 10) },
        source: srcOf(f, o.where), accept: num(o.amount) != null };
      proposals.push(ocSeen[k]);
    }
  }

  // ---- material prices: only what a line states ($/unit, or its own price and weight) ----
  for (const f of files) {
    for (const m of ex(f).material_prices || []) {
      let perLb = null, how = '';
      const u = s(m.unit).toLowerCase();
      if (num(m.unit_price) && /^(lb|lbs|#)$/.test(u)) { perLb = num(m.unit_price); how = 'per lb as quoted'; }
      else if (num(m.unit_price) && /^cwt$/.test(u)) { perLb = num(m.unit_price) / 100; how = 'from $/cwt'; }
      else if (num(m.price) && num(m.weight_lbs)) { perLb = num(m.price) / num(m.weight_lbs); how = 'line price / line weight'; }
      if (perLb == null) continue;
      proposals.push({ id: pid('mp'), type: 'material_price', title: 'Material price paid',
        fields: { item: s(m.item), vendor: s(m.vendor), per_lb: Math.round(perLb * 1000) / 1000, date: s(ex(f).date).slice(0, 10), how },
        source: srcOf(f, m.where), accept: true });
    }
  }

  // ---- markup: information only ----
  for (const f of files) {
    const e = ex(f);
    if (e.markup_pct && num(e.markup_pct.value)) {
      proposals.push({ id: pid('mk'), type: 'markup', title: 'Markup used on this job', info: true,
        fields: { pct: r1(num(e.markup_pct.value)) }, source: srcOf(f, e.markup_pct.where), accept: false,
        note: 'For your information; it does not change the markup in your profile.' });
    }
  }
  return { proposals, checks };
}

// A confirmed (possibly edited) proposal -> the lesson text stored in Takeoff_Correction (Source=history).
function lessonText(p) {
  const f = p.fields || {};
  if (p.type === 'scope') return (p.title + ': ' + s(f.text)).slice(0, 250);
  if (p.type === 'outside_cost') return ('Outside cost: ' + s(f.what) + (f.vendor ? ' (' + s(f.vendor) + ')' : '') +
    (num(f.amount) ? ' $' + num(f.amount).toLocaleString('en-US') + (f.unit ? ' per ' + s(f.unit) : '') : '') + (f.date ? ', ' + s(f.date) : '')).slice(0, 250);
  if (p.type === 'material_price') return ('Material price paid: ' + s(f.item) + ' $' + num(f.per_lb) + '/lb' + (f.vendor ? ' from ' + s(f.vendor) : '') + (f.date ? ', ' + s(f.date) : '')).slice(0, 250);
  return '';
}

// Confirmed reference job -> labor/shop.js reference_jobs row. null when tons or hours are missing.
function referenceJob(job, p) {
  const f = p.fields || {};
  if (!num(f.tons) || !num(f.hours)) return null;
  return { type: LABOR_CATS.includes(f.labor_cat) ? f.labor_cat : (LABOR_CATS.includes(job.labor_cat) ? job.labor_cat : 'misc'),
    material: MATS.includes(f.material) ? f.material : 'CS', name: s(job.name).slice(0, 120) || 'Past job',
    tons: num(f.tons), hours: num(f.hours), job_number: s(job.number).slice(0, 40), date: s(f.date).slice(0, 10), source: 'history',
    teach_job: job.id, hours_kind: s(f.hours_kind) };
}

module.exports = { KINDS, KIND_KEYS, LABOR_CATS, MATS, EXTRACT_TOOL, buildProposals, lessonText, referenceJob, agreement };
