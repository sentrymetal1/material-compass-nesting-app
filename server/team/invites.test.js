// Run: node --test server/team/invites.test.js
const test = require('node:test');
const assert = require('node:assert');
process.env.MC_TOKEN_SECRET = process.env.MC_TOKEN_SECRET || 'x'.repeat(40);
const T = require('./invites');

const rep = (email, extra) => Object.assign({ ID: String(Math.floor(Math.random() * 1e15) + 1e15), Email: email, Manufacture: { ID: '111111' } }, extra);
const ok = { first: 'Ann', last: 'Lee', email: 'ann@shop.com', position: 'Estimator' };

test('join token round trip, tamper, expiry', () => {
  const t = T.makeJoinToken('4111484000006629012', 1000);
  assert.strictEqual(T.readJoinToken(t, 2000).repId, '4111484000006629012');
  assert.strictEqual(T.readJoinToken(t.replace('6629012', '6629013'), 2000).error, 'bad_signature');
  assert.strictEqual(T.readJoinToken(t, 1000 + 15 * 86400000).error, 'expired');
  assert.strictEqual(T.readJoinToken('junk').error, 'malformed');
});

test('blank Invite_Status is an existing rep (Joined) and takes a seat', () => {
  assert.strictEqual(T.statusOf({}), 'Joined');
  assert.ok(T.takesSeat({}));
  assert.ok(!T.takesSeat({ Invite_Status: 'Cancelled' }));
  assert.ok(!T.takesSeat({ Invite_Status: 'Cancel' }));
  assert.strictEqual(T.statusOf({ Invite_Status: 'Cancel' }), 'Cancelled');
  assert.ok(!T.takesSeat({ Employee_Status: 'Delete Employee on Platform' }));
  assert.ok(T.takesSeat({ Invite_Status: 'Invited' }));
});

test('cap: admin + 3 = 4, cancelled frees a seat', () => {
  const three = [rep('a@x.com'), rep('b@x.com', { Invite_Status: 'Invited' }), rep('c@x.com')];
  assert.deepStrictEqual(T.checkInvite(three, [], ok), { reuse: null });
  const four = three.concat(rep('d@x.com', { Invite_Status: 'Joined' }));
  assert.strictEqual(T.checkInvite(four, [], ok).error, 'cap');
  four[3].Invite_Status = 'Cancelled';
  assert.deepStrictEqual(T.checkInvite(four, [], ok), { reuse: null });
});

test('duplicates and validation', () => {
  assert.match(T.checkInvite([rep('ann@shop.com', { Invite_Status: 'Invited' })], [], ok).error, /Resend/);
  assert.match(T.checkInvite([rep('ANN@shop.com')], [], ok).error, /already on your team/);
  const old = rep('ann@shop.com', { Invite_Status: 'Cancelled' });
  assert.strictEqual(T.checkInvite([old], [], ok).reuse, old);
  assert.match(T.checkInvite([], [rep('ann@shop.com')], ok).error, /another company/);
  assert.deepStrictEqual(T.checkInvite([], [rep('ann@shop.com', { Invite_Status: 'Cancelled' })], ok), { reuse: null });
  assert.match(T.checkInvite([], [], Object.assign({}, ok, { position: 'Boss' })).error, /position/);
  assert.match(T.checkInvite([], [], Object.assign({}, ok, { email: 'nope' })).error, /email/);
  assert.match(T.checkInvite([], [], Object.assign({}, ok, { last: ' ' })).error, /name/);
});

test('zoho date-time format', () => {
  assert.strictEqual(T.zDateTime(new Date(2026, 10, 18, 9, 5, 7)), 'Nov 18,2026 09:05:07');
});

test('email names the shop and the link', () => {
  const m = T.inviteEmail('Black Rock Fabrication', { first: 'Ann', email: 'ann@shop.com', position: 'Estimator' }, 'https://x/join?i=1');
  assert.match(m.subject, /Black Rock Fabrication/);
  assert.ok(m.html.includes('https://x/join?i=1') && m.text.includes('https://x/join?i=1'));
  assert.ok(!/zoho/i.test(m.html));
});

test('default location: admin first, else any rep, else none', () => {
  const reps = [
    { Position: 'Estimator', Location: [{ ID: '222', zc_display_value: 'Yard' }] },
    { Position: 'Administrator', Location: [{ ID: '111', zc_display_value: 'HQ' }] },
  ];
  assert.strictEqual(T.defaultLocation(reps), '111');
  assert.strictEqual(T.defaultLocation([reps[0]]), '222');
  assert.strictEqual(T.defaultLocation([{ Position: 'Administrator', Location: [] }]), '');
});

test('a "+" address is refused (the portal will not accept it as a login)', () => {
  assert.match(T.checkInvite([], [], { first: 'A', last: 'B', email: 'mark+test@x.com', position: 'Estimator' }).error, /\+/);
});
