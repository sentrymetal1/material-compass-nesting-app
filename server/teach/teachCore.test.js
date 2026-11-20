// Run: node --test server/teach/teachCore.test.js
const test = require('node:test');
const assert = require('node:assert');
const T = require('./teachCore');

const file = (name, kind, extract) => ({ id: name, name, kind, status: 'read', extract: Object.assign({ kind }, extract) });

test('reference job prefers actual hours and estimate tons; disagreement is shown, not averaged', () => {
  const job = { id: 'j1', name: 'Mill platform', number: '2291', labor_cat: 'platform_stairs', files: [
    file('estimate.xlsx', 'estimate', { tons: { value: 12.4, where: 'Summary!B4' }, est_hours: { value: 410, where: 'Summary!B9' }, main_material: 'CS', date: '2025-03-02' }),
    file('matlist.pdf', 'material_list', { lbs: { value: 28000, where: 'p.2 total' } }),
    file('jobcost.pdf', 'job_cost', { actual_hours: { value: 455, where: 'p.1 Labor total' } }),
  ] };
  const { proposals, checks } = T.buildProposals(job);
  const rj = proposals.find((p) => p.type === 'reference_job');
  assert.strictEqual(rj.fields.tons, 12.4);
  assert.strictEqual(rj.fields.hours, 455);
  assert.strictEqual(rj.fields.hours_kind, 'actual');
  assert.strictEqual(rj.fields.date, '2025-03-02');
  assert.ok(rj.accept);
  assert.match(checks.find((c) => c.what === 'Weight').text, /12\.4 \(estimate\.xlsx · Summary!B4\) vs 14 \(matlist\.pdf/);
  assert.match(checks.find((c) => c.what === 'Hours').text, /11% over/);
  const row = T.referenceJob(job, rj);
  assert.deepStrictEqual([row.type, row.tons, row.hours, row.source, row.job_number], ['platform_stairs', 12.4, 455, 'history', '2291']);
});

test('no number without a document: missing hours -> unticked, referenceJob refuses', () => {
  const job = { files: [file('prop.pdf', 'proposal', { tons: { value: 3, where: 'p.1' } })] };
  const rj = T.buildProposals(job).proposals.find((p) => p.type === 'reference_job');
  assert.strictEqual(rj.fields.hours, null);
  assert.ok(!rj.accept);
  assert.match(rj.note, /Needs both/);
  assert.strictEqual(T.referenceJob(job, rj), null);
});

test('scope habits deduped across files; outside costs and material prices only from stated values', () => {
  const job = { files: [
    file('prop.pdf', 'proposal', { scope_excluded: [{ text: 'Anchor bolts and grout', where: 'p.2' }], finish: [{ text: 'Hot-dip galvanize', where: 'p.2' }] }),
    file('prop2.pdf', 'proposal', { scope_excluded: [{ text: 'anchor bolts & grout', where: 'p.1' }, { text: 'Anchor bolts and grout.', where: 'p.3' }] }),
    file('sq.pdf', 'supplier_quote', { date: '2025-02', material_prices: [
      { item: 'W8x31', vendor: 'Ryerson', unit_price: 62, unit: 'cwt', where: 'line 1' },
      { item: '1/4 PL', price: 500, weight_lbs: 800, where: 'line 2' },
      { item: 'HSS 4x4', price: 300, where: 'line 3' }],
      outside_costs: [{ what: 'Galvanizing', vendor: 'Valley', amount: 0.42, unit: 'lb', where: 'line 9' }] }),
  ] };
  const { proposals } = T.buildProposals(job);
  const ex = proposals.filter((p) => p.type === 'scope' && p.title === 'Excludes');
  assert.strictEqual(ex.length, 2);          // "Anchor bolts and grout" vs "anchor bolts & grout" differ in words; trailing dot deduped
  const mp = proposals.filter((p) => p.type === 'material_price');
  assert.deepStrictEqual(mp.map((p) => p.fields.per_lb), [0.62, 0.625]);   // HSS line has no weight -> not proposed
  assert.strictEqual(T.lessonText(mp[0]), 'Material price paid: W8x31 $0.62/lb from Ryerson, 2025-02');
  const oc = proposals.find((p) => p.type === 'outside_cost');
  assert.strictEqual(T.lessonText(oc), 'Outside cost: Galvanizing (Valley) $0.42 per lb, 2025-02');
  assert.strictEqual(T.lessonText(proposals.find((p) => p.title === 'Finish')), 'Finish: Hot-dip galvanize');
});

test('markup is information only', () => {
  const { proposals } = T.buildProposals({ files: [file('est.xlsx', 'estimate', { markup_pct: { value: 18, where: 'B20' } })] });
  const mk = proposals.find((p) => p.type === 'markup');
  assert.ok(mk.info && !mk.accept);
});

test('files not read are ignored', () => {
  const { proposals } = T.buildProposals({ files: [{ name: 'x', kind: 'proposal', status: 'failed', extract: { tons: { value: 9, where: 'p1' } } }] });
  assert.strictEqual(proposals.length, 0);
});

test('scope only from proposal/spec; the same outside cost on two documents is one card', () => {
  const { proposals } = T.buildProposals({ files: [
    file('est.xlsx', 'estimate', { finish: [{ text: 'Galvanizing (cost line)', where: 'A18' }], outside_costs: [{ what: 'Galvanizing, 11,700 lb', vendor: 'Valley', amount: 4914, where: 'A18' }] }),
    file('cost.csv', 'job_cost', { outside_costs: [{ what: 'Galvanizing', amount: 4914, where: 'line 8' }] }),
    file('prop.pdf', 'proposal', { finish: [{ text: 'Hot-dip galvanized after fabrication', where: 'p.1' }] }),
  ] });
  assert.deepStrictEqual(proposals.filter((p) => p.type === 'scope').map((p) => p.fields.text), ['Hot-dip galvanized after fabrication']);
  const oc = proposals.filter((p) => p.type === 'outside_cost');
  assert.strictEqual(oc.length, 1);
  assert.match(oc[0].source, /est\.xlsx · A18 · also cost\.csv · line 8/);
});
