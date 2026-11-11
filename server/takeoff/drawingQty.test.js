// =============================================================================
//  drawingQty.test.js — how many of each DRAWING one unit needs ("QTY 2 REQ'D").
//  Mark 2026-11-11: a Handrail component with 43 drawings, two of them "2 ea" assemblies. The
//  quantity is read at the quick index read, shown on the drawing chip, editable, and sent with
//  the run, where a confirmed quantity beats what the run itself read.
//  Run: node --test server/takeoff/drawingQty.test.js
// =============================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let engine = null;
try { engine = require('./engine'); } catch (e) { /* SDK missing locally: the source checks below still run */ }

test('the quick read asks each sheet for its own quantity, and never to infer one', () => {
  const src = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  const i = src.indexOf('const SHEET_INDEX_TOOL');
  const tool = src.slice(i, i + 6000);
  assert.match(tool, /sheet_qty:\s+\{ type: "integer"/);
  assert.match(tool, /Never infer it/);
  assert.match(tool, /qty_evidence:/);
});

test('a drawing over two pages keeps the quantity it printed', { skip: !engine && 'engine not loadable here' }, () => {
  const sheets = engine.groupPagesIntoSheets([
    { doc: 1, page: 1, number: '8071', title: 'Handrail Item 8071', sheet_qty: 1 },
    { doc: 1, page: 2, number: '8071', title: 'Handrail Item 8071', sheet_qty: 2, qty_evidence: "QTY 2 REQ'D" },
    { doc: 1, page: 3, number: '8073', title: 'Handrail Item 8073', sheet_qty: 1 },
  ]);
  const list = Array.isArray(sheets) ? sheets : (sheets.sheets || []);
  const s71 = list.find(s => s.number === '8071'), s73 = list.find(s => s.number === '8073');
  assert.strictEqual(s71.qty, 2);
  assert.strictEqual(s71.qty_evidence, "QTY 2 REQ'D");
  assert.strictEqual(s73.qty, 1);
});

test('the run applies the confirmed quantity before multiplying', () => {
  const r = fs.readFileSync(path.join(__dirname, 'route.js'), 'utf8');
  const a = r.indexOf('const confirmedQty'), b = r.indexOf('const sheetQtyOf');
  assert.ok(a > 0 && b > a, 'confirmed drawing quantities must be applied BEFORE rows are multiplied');
  assert.match(r.slice(a, b), /body\.drawing_qty/);
  assert.match(r.slice(a, b), /r\.sheet_qty = confirmedQty\[k\]/);
});

test('the intake page shows the quantity, warns, and sends it', () => {
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  assert.match(html, /function dqtyBox\(/);
  assert.match(html, /class="dqb/, 'chips lost their compact "N ea" tag');
  assert.match(html, /drawQtyNotice\(\) \+ cards/, 'the notice above the components is gone');
  assert.match(html, /drawing_qty: drawingQtyPayload\(\)/, 'the run no longer sends drawing quantities');
  assert.match(html, /seedDrawQty\(detected\)/, 'the quick read no longer fills the chips');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, n) => assert.doesNotThrow(() => new Function(s), 'inline script #' + n + ' does not parse'));
});
