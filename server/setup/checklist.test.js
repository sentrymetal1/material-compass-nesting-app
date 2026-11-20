// Run: node --test server/setup/checklist.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buildSteps } = require('./checklist');

const full = { markup: true, projectTypes: true, shipping: true, laborTypes: true, laborRates: true };
const by = (r, k) => r.steps.find((s) => s.key === k);

test('a finished shop', () => {
  const r = buildSteps({ profile: full, people: 3, clients: 40, suppliers: 6, subs: 5, lessons: 4 });
  assert.strictEqual(r.done, 6);
  assert.ok(r.ready);
  assert.match(by(r, 'team').detail, /3 of 4 seats/);
});

test('a new shop: profile partial lists what is missing, not ready', () => {
  const r = buildSteps({ profile: Object.assign({}, full, { shipping: false, laborRates: false }), people: 1, clients: 0, suppliers: 0, subs: 0, lessons: 0 });
  assert.strictEqual(by(r, 'profile').status, 'partial');
  assert.match(by(r, 'profile').detail, /A shipping location, A labor rate/);
  assert.strictEqual(by(r, 'team').status, 'todo');
  assert.ok(!r.ready);
});

test('unknown facts are not guessed; Onboarding_Done settles the profile', () => {
  const r = buildSteps({ profile: { markup: null, shipping: null, projectTypes: true, laborTypes: true, laborRates: true }, people: null, clients: 2 });
  assert.strictEqual(by(r, 'profile').status, 'partial');          // 3 known, all ok, 2 unknown
  assert.strictEqual(by(r, 'team').status, 'unknown');
  const r2 = buildSteps({ profile: { markup: null, shipping: null, onboardingDone: true }, clients: 2 });
  assert.strictEqual(by(r2, 'profile').status, 'done');
});

test('skipping a required step makes the shop ready; a done step cannot be skipped', () => {
  const r = buildSteps({ profile: full, people: 1, clients: 0, suppliers: 0, subs: 0, lessons: 0, skipped: { clients: 'x', profile: 'x' } });
  assert.ok(by(r, 'clients').skipped);
  assert.ok(!by(r, 'profile').skipped);
  assert.ok(!by(r, 'profile').can_skip);
  assert.ok(r.ready);
});
