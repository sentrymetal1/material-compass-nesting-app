// =============================================================================
//  triageScope.test.js — "What this quote includes" pills on Quote Triage.
//  Run: node --test server/triageScope.test.js
// =============================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sc = require('./triageScope');

// What the AI would return for Mark's own note:
// "quote to fabricate per instructions. Include material and elbows. this project is galvanized."
const AI = {
  material: 'included', fittings: 'included', fabrication: 'included',
  delivery: 'not_mentioned', installation: 'not_mentioned', shop_drawings: 'not_mentioned', field_measure: 'not_mentioned',
  finish: 'galvanize', finish_by: 'outside',
  evidence: { material: 'Include material', fittings: 'and elbows', fabrication: 'quote to fabricate', finish: 'this project is galvanized' },
};

test('the AI reading becomes pills, with the words it came from', () => {
  const s = sc.fromAi(AI);
  assert.deepStrictEqual(s.items.material, { v: 'yes', src: 'ai', why: 'Include material' });
  assert.strictEqual(s.items.fittings.v, 'yes');
  assert.strictEqual(s.items.delivery.v, '', 'not_mentioned must stay NOT DECIDED, never "no"');
  assert.strictEqual(s.finish.type, 'galvanize');
  assert.strictEqual(s.finish.by, 'outside');
  assert.strictEqual(s.finish.why, 'this project is galvanized');
});

test('the user\'s answers win; the AI only fills what the user left undecided', () => {
  const user = { items: { fittings: { v: 'no' }, delivery: { v: 'yes' } }, finish: { type: 'powder_coat' } };
  const m = sc.merge(user, sc.fromAi(AI));
  assert.strictEqual(m.items.fittings.v, 'no');
  assert.strictEqual(m.items.fittings.src, 'user');
  assert.strictEqual(m.items.delivery.v, 'yes');
  assert.strictEqual(m.items.material.src, 'ai');
  assert.strictEqual(m.finish.type, 'powder_coat');
  assert.strictEqual(m.finish.by, 'outside', 'a finish-by the user did not answer is still filled by the AI');
});

test('skipping everything is allowed and stays blank', () => {
  const m = sc.merge(null, sc.fromAi(null));
  assert.ok(sc.isBlank(m));
  assert.strictEqual(sc.toText(m), '');
});

test('junk from the page is dropped, not stored', () => {
  const s = sc.sanitize({ items: { material: { v: 'maybe' }, hacker: { v: 'yes' } }, finish: { type: 'gold_leaf', by: 'outside' } });
  assert.strictEqual(s.items.material.v, '');
  assert.ok(!('hacker' in s.items));
  assert.strictEqual(s.finish.type, '');
  assert.strictEqual(s.finish.by, 'outside');
});

test('the take-off gets the scope in words: includes, excludes, not decided', () => {
  const s = sc.merge({ items: { installation: { v: 'no' } } }, sc.fromAi(AI));
  const t = sc.toText(s);
  assert.match(t, /^SCOPE: Includes: material, fittings, shop fabrication, galvanize \(by an outside vendor\)\./);
  assert.match(t, /Excludes: field installation\./);
  assert.match(t, /Not decided yet: grating, fasteners, anchor bolts, welding, delivery, shop drawings, field measuring\./);
});

test('scope is read back from an opportunity row, email or manual', () => {
  assert.strictEqual(sc.fromExtractedJson(JSON.stringify({ scope: AI })).items.material.v, 'yes');
  assert.strictEqual(sc.fromExtractedJson(JSON.stringify({ extraction: { scope: AI } })).finish.type, 'galvanize');
  assert.strictEqual(sc.fromExtractedJson(JSON.stringify({ summary: 'older row' })), null);
  assert.strictEqual(sc.fromExtractedJson('not json'), null);
});

test('the AI is asked for the scope, and told not to guess', () => {
  const t = fs.readFileSync(path.join(__dirname, 'triage.js'), 'utf8');
  assert.match(t, /scope:\s+triageScope\.SCOPE_SCHEMA/, 'the extraction tool no longer asks for scope');
  assert.match(t, /triageScope\.SCOPE_PROMPT_RULE/, 'the prompt lost the scope rule');
  assert.match(sc.SCOPE_PROMPT_RULE, /never guess/);
  assert.match(t, /app\.post\('\/api\/triage\/scope'/, 'POST /api/triage/scope is gone');
  assert.match(t, /app\.get\('\/api\/triage\/clients'/, 'GET /api/triage/clients is gone');
  assert.match(t, /scope_text: triageScope\.toText\(projScope, /, 'source-files no longer hands the scope to the take-off');
  assert.match(t, /app\.get\('\/api\/triage\/scope-def'/, 'GET /api/triage/scope-def is gone');
});

test('the quote-note save keeps the pills and the client stored beside it', () => {
  const t = fs.readFileSync(path.join(__dirname, 'triage.js'), 'utf8');
  const i = t.indexOf("app.post('/api/triage/quote-note'");
  const body = t.slice(i, i + 1200);
  assert.match(body, /\{ \.\.\.cur, note: note/, 'saving a note would wipe the scope pills');
});

test('how it gets made: welding defaults to MIG and says so', () => {
  const d = sc.shopDefaults('anything');
  assert.strictEqual(d.weld_process, 'mig');
  assert.strictEqual(sc.toText(null, d), 'HOW IT GETS MADE: Welding: MIG (GMAW) (shop default).');
  assert.strictEqual(sc.toText(null), '', 'without defaults nothing is said');
});

test('how it gets made: choices in words, user picks beat the default', () => {
  const s = sc.sanitize({ ops: { cut_saw: 'in', end_notch: 'out', cut_torch: 'no', weld_grind_smooth: 'yes', hole_vent_drain: 'yes' },
                          picks: { weld_process: 'smaw', blast: 'sp6' } });
  const t = sc.methodsText(s, sc.shopDefaults());
  assert.match(t, /Cutting: saw \(in house\); not needed: torch \(oxy-fuel\)\./);
  assert.match(t, /Holes: vent & drain holes \(galvanizing\)\./);
  assert.match(t, /Pipe & tube ends: notch \(outside\)\./);
  assert.match(t, /Welding: Stick \(SMAW\), grind welds smooth \(handrail\)\./);
  assert.doesNotMatch(t, /shop default/);
  assert.match(t, /Surface prep: SP6 commercial\./);
});

test('how it gets made: junk is dropped and a card save cannot invent options', () => {
  const s = sc.sanitize({ ops: { cut_saw: 'yes', end_notch: 'maybe', made_up: 'in', hole_vent_drain: 'in' }, picks: { weld_process: 'laser', weld_code: 'd1_1' } });
  assert.deepStrictEqual(s.ops, {}, 'a "where" option takes in/out/no only; a "yes" option yes/no only');
  assert.deepStrictEqual(s.picks, { weld_code: 'd1_1' });
  const m = sc.merge({ ops: { cut_saw: 'in' } }, sc.fromAi(AI));
  assert.strictEqual(m.ops.cut_saw, 'in', 'merge keeps the user\'s drill-down');
});

test('the take-off draws the pills and drill-down, and sends them with the notes', () => {
  const idx = fs.readFileSync(path.join(__dirname, 'takeoff/public/index.html'), 'utf8');
  assert.match(idx, /<script src="scope-pills\.js"><\/script>/);
  assert.match(idx, /id="scopePanel"/);
  assert.match(idx, /quote_brief: briefText\(\)/);
  assert.match(idx, /quote_note: briefText\(\)/);
  const js = fs.readFileSync(path.join(__dirname, 'takeoff/public/scope-pills.js'), 'utf8');
  assert.doesNotThrow(() => new Function(js), 'scope-pills.js does not parse');
  const defs = sc.definitions();
  assert.ok(defs.ops_groups.length >= 8 && defs.ops_picks.weld_process);
});

test('the triage page renders the optional note, fields and pills, and its script parses', () => {
  const html = String(require('./triagePage.js').renderTriagePage());
  assert.match(html, /Everything here is optional, but it pays off\./);
  assert.match(html, /id="intakeJob"/);
  assert.match(html, /id="intakeClient"/);
  assert.match(html, /id="intakeBid"/);
  assert.match(html, /id="intakeScope"/);
  assert.match(html, /function scopeHtml\(/);
  assert.match(html, /scope:intakeScope/, 'Read it no longer sends the pills');
  assert.match(html, /class="scopebox">'\+scopeHtml\(o\.scope/, 'cards lost their pills');
  // The page is one big template string. A stray backtick or ${ breaks it silently, so make sure
  // the browser would actually be able to run every inline script.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 1);
  scripts.forEach((s, n) => assert.doesNotThrow(() => new Function(s), 'inline script #' + n + ' does not parse'));
});
