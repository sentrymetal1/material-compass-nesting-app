// Run: node --test server/suppliers/claim.test.js
const test = require('node:test');
const assert = require('node:assert');
process.env.MC_TOKEN_SECRET = process.env.MC_TOKEN_SECRET || 'y'.repeat(40);
const C = require('./claim');

test('claim token: round trip, tamper (other supplier), expiry', () => {
  const t = C.makeClaimToken('4111484000006566011', '4111484000006566008', 1000);
  assert.deepStrictEqual(C.readClaimToken(t, 2000), { repId: '4111484000006566011', supId: '4111484000006566008' });
  assert.strictEqual(C.readClaimToken(t.replace('6566008', '6566009'), 2000).error, 'bad_signature');
  assert.strictEqual(C.readClaimToken(t, 1000 + 31 * 86400000).error, 'expired');
  assert.strictEqual(C.readClaimToken('x.y').error, 'malformed');
});

test('login emails: added once, case-insensitive, list kept', () => {
  assert.deepStrictEqual(C.addEmail('a@x.com, B@x.com', 'b@X.com'), { value: 'a@x.com, B@x.com', added: false });
  assert.deepStrictEqual(C.addEmail('a@x.com', 'Nate@TT.com'), { value: 'a@x.com,nate@tt.com', added: true });
  assert.deepStrictEqual(C.addEmail('', 'n@t.com'), { value: 'n@t.com', added: true });
});

test('invite email: names shop, supplier and link; no vendor names', () => {
  const m = C.inviteEmail('Black Rock Fabrication', { name: 'Lancaster Metal Services' }, { first: 'Bill', email: 'bill@lms.com' }, 'https://x/claim?c=1');
  assert.match(m.subject, /Black Rock Fabrication invited you/);
  assert.ok(m.html.includes('Claim Lancaster Metal Services') && m.html.includes('https://x/claim?c=1') && m.text.includes('https://x/claim?c=1'));
  assert.ok(!/zoho/i.test(m.html));
});

test('admin token carries the main email; tamper and expiry refused', () => {
  const t = C.makeAdminToken('4111484000006566008', 'Sales@LancasterMetal.com', 1000);
  assert.deepStrictEqual(C.readAdminToken(t, 2000), { supId: '4111484000006566008', email: 'sales@lancastermetal.com' });
  const parts = t.split('.');
  const other = Buffer.from('bill@lancastermetal.com').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(C.readAdminToken([parts[0], other, parts[2], parts[3]].join('.'), 2000).error, 'bad_signature');
  assert.strictEqual(C.readAdminToken(t, 1000 + 31 * 86400000).error, 'expired');
});

test('personal mailbox warning', () => {
  assert.ok(C.looksPersonal('bill.myers@gmail.com'));
  assert.ok(C.looksPersonal('x@yahoo.co.uk'));
  assert.ok(!C.looksPersonal('sales@lancastermetal.com'));
});

test('company notice: stop warning first, admin = this mailbox', () => {
  const n = C.companyNotice({ name: 'Lancaster Metal Services' }, { name: 'Bill Myers', email: 'bill@lms.com' }, 'Black Rock Fabrication', 'https://x/a?c=1');
  assert.ok(n.html.indexOf('Do not continue') < n.html.indexOf('Become your company'));
  assert.match(n.html, /administrator login will be <b>this mailbox<\/b>/);
  assert.match(n.text, /^ONLY FOR THE PERSON WHO MANAGES LANCASTER METAL SERVICES/);
});
