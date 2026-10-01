// Run: node --test server/intel.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buildIntel, stats, industry, parseDate, normQuote } = require('./intel');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000);
const ME = '111', P = '999';
const q = (o) => Object.assign({ mfg: ME, material: 'M1', form: 'F', type: 'T', spec: 'S', price: 1, date: daysAgo(10), supplier: 'Sup A', project: 'MCP-1', project_id: 'X', lead: '' }, o);

test('Zoho dates parse; junk is null, never "now"', () => {
  assert.strictEqual(parseDate('Sep 07,2026 14:42:52').getMonth(), 8);
  assert.strictEqual(parseDate('Sep 06,2026').getDate(), 6);
  assert.strictEqual(parseDate(''), null);
  assert.strictEqual(parseDate('nonsense'), null);
});

test('normQuote reads the report row shape', () => {
  const n = normQuote({ Customer_LU: { ID: '7' }, Material: {}, Form_Type: { ID: 'F' }, Material_Type: { ID: 'T' },
    Material_Form_Detail: { ID: 'S' }, Price_Per_Lb: '1.80000', Price_Last_Updated: 'Sep 07,2026 14:42:52', Supplier_Name: 'Mark Supply',
    MCP_Customer_Project_Form: { ID: 'P1', Project_Quote_Number: 'MCP-10005' } });
  assert.deepStrictEqual([n.mfg, n.material, n.form, n.price, n.supplier, n.project], ['7', '', 'F', 1.8, 'Mark Supply', 'MCP-10005']);
});

test('stats: last paid is the newest, 30-day vs prior 90 gives the trend', () => {
  const s = stats([q({ price: 1.0, date: daysAgo(100) }), q({ price: 1.0, date: daysAgo(60) }), q({ price: 1.2, date: daysAgo(5) }), q({ price: 1.2, date: daysAgo(2) })], { now: NOW, detail: true });
  assert.strictEqual(s.last, 1.2);
  assert.strictEqual(s.avg_30d, 1.2);
  assert.strictEqual(s.change_pct, 20);
  assert.strictEqual(s.trend, 'up');
  assert.strictEqual(s.previous.length, 4);
  assert.strictEqual(s.series[s.series.length - 1].p, 1.2, 'series runs oldest → newest');
});

test('industry: hidden below 3 other shops; above it, averages only — no names', () => {
  const two = [q({ mfg: 'a' }), q({ mfg: 'b' })];
  assert.strictEqual(industry(two, ME, NOW).available, false);
  const three = [q({ mfg: 'a', price: 1 }), q({ mfg: 'b', price: 2 }), q({ mfg: 'c', price: 3 }), q({ mfg: ME, price: 100 })];
  const ind = industry(three, ME, NOW);
  assert.strictEqual(ind.available, true);
  assert.strictEqual(ind.avg, 2, 'my own quotes are not in the market figure');
  const s = JSON.stringify(ind);
  assert.ok(!/Sup A|MCP-1|supplier|project|previous|series/.test(s), 'no supplier, project or company leaks: ' + s);
});

test('project view: exact match first, else similar; est cost; alerts; my history only', () => {
  const bom = [
    { Material_ID: 'M1', Form_Type: 'Channel', Material_Type: 'Carbon Steel', Specification: 'A36', Material: 'C6 x 8.2',
      Form_Type_ID: 'F', Material_Type_ID: 'T', Specification_ID: 'S', CalcWeight: '1000', Quantity: '2' },
    { Material_ID: 'M2', Form_Type: 'Channel', Material_Type: 'Carbon Steel', Specification: 'A36', Material: 'C8 x 11.5',
      Form_Type_ID: 'F', Material_Type_ID: 'T', Specification_ID: 'S', CalcWeight: '500', Quantity: '1' },
    { Material_ID: 'M3', Form_Type: 'Plate', Material_Type: 'Stainless', Specification: '316', Material: '1/4"',
      Form_Type_ID: 'PF', Material_Type_ID: 'ST', Specification_ID: '316', CalcWeight: '200', Quantity: '1' },
  ];
  const quotes = [
    q({ price: 1.0, date: daysAgo(90) }), q({ price: 1.0, date: daysAgo(70) }), q({ price: 1.3, date: daysAgo(5) }), q({ price: 1.3, date: daysAgo(3), project_id: P }),
    q({ material: '', price: 0.9, date: daysAgo(20) }),        // same form/type/spec, no size → "similar" for M2
    q({ mfg: 'other', supplier: 'Secret Supplier', price: 5 }), // another shop: never in "mine"
  ];
  const out = buildIntel({ projectId: P, myMfg: ME, bom, fittings: [], quotes, fittingQuotes: [], now: NOW });
  const [c6, c8, ss] = [out.structural.find((s) => s.key === 'M1'), out.structural.find((s) => s.key === 'M2'), out.structural.find((s) => s.key === 'M3')];
  assert.strictEqual(c6.match, 'exact');
  assert.strictEqual(c8.match, 'similar', 'no exact quote → same form/type/spec');
  assert.strictEqual(ss.match, 'none');
  assert.strictEqual(ss.est_cost, null);
  assert.strictEqual(c6.est_cost, 1300, '1000 lb × your 30-day avg 1.30');
  assert.ok(c6.mine.previous.some((p) => p.this_project), 'a quote on this project is marked');
  assert.ok(!JSON.stringify(out.structural).includes('Secret Supplier'), "another shop's supplier never appears");
  assert.ok(out.alerts.some((a) => a.scope === 'mine' && a.direction === 'up' && /C6 x 8.2/.test(a.text)), 'a 30% jump raises an alert');
  assert.strictEqual(out.summary.unpriced, 1);
  assert.strictEqual(out.structural[0].key, 'M1', 'sorted by dollar impact');
});

test('fittings: grouped, quoted history counted; price absent says so', () => {
  const fittings = [{ Fitting_Type: 'Elbow', Fitting_Make: 'Carbon Steel', Fitting_Specification: 'A105', Fitting_Description_Text: '3/4" | 3000 PSI', Quantity: '2', Total_Weight: '0.4' },
                    { Fitting_Type: 'Elbow', Fitting_Make: 'Carbon Steel', Fitting_Specification: 'A105', Fitting_Description_Text: '3/4" | 3000 PSI', Quantity: '3', Total_Weight: '0.6' }];
  const fq = [{ mfg: ME, type: 'Elbow', make: 'Carbon Steel', spec: 'A105', price: 0, date: daysAgo(8), supplier: 'Sup A' },
              { mfg: 'other', type: 'Elbow', make: 'Carbon Steel', spec: 'A105', price: 0, date: daysAgo(1), supplier: 'Hidden' }];
  const out = buildIntel({ projectId: P, myMfg: ME, bom: [], fittings, quotes: [], fittingQuotes: fq, now: NOW });
  assert.strictEqual(out.fittings.length, 1);
  assert.strictEqual(out.fittings[0].qty, 5);
  assert.strictEqual(out.fittings[0].quoted, 1, "only this shop's quotes");
  assert.deepStrictEqual(out.fittings[0].suppliers, ['Sup A']);
  assert.strictEqual(out.fittings[0].price, null);
  assert.ok(out.notes.fittings_price, 'says why there is no fitting price');
});
