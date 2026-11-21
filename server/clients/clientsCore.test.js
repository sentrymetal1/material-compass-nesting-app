// Run: node --test server/clients/clientsCore.test.js
const test = require('node:test');
const assert = require('node:assert');
const K = require('./clientsCore');

const ZCLIENT = { ID: '11', Client_Company_Name: 'Resolute Grid, Inc.', Client_Status: '', Client_Phone_Number: '+17134122882', Client_Email: 'john@rg.com',
  Client_Address: { address_line_1: '104 Manor Drive', address_line_2: '', district_city: 'Heath', state_province: 'Texas', postal_code: '75032', country: '' },
  Notes_Paste_Information: 'n' };

test('shapes a Zoho client; blank status counts as active', () => {
  const c = K.shapeClient(ZCLIENT);
  assert.strictEqual(c.company, 'Resolute Grid, Inc.');
  assert.strictEqual(c.phone, '(713) 412-2882');
  assert.strictEqual(c.city, 'Heath');
  assert.strictEqual(c.line, '104 Manor Drive, Heath, Texas 75032');
  assert.strictEqual(c.active, true);
  assert.strictEqual(K.shapeClient({ ...ZCLIENT, Client_Status: 'Not Active' }).active, false);
});

test('shapes a contact with its location', () => {
  const r = K.shapeRep({ ID: '9', CLIENT: { ID: '11' }, Name: { first_name: 'Alexander', last_name: 'Cesna', zc_display_value: 'Alexander Cesna' },
    Email: 'a@rg.com', Mobile: '+13025475936', Client_Locations: [{ ID: '5', Location_Name: 'Heath, TX' }] });
  assert.deepStrictEqual([r.client_id, r.name, r.mobile, r.location_id, r.location], ['11', 'Alexander Cesna', '(302) 547-5936', '5', 'Heath, TX']);
});

test('project dates read plainly', () => {
  const p = K.shapeProject({ ID: '1', Project_Quote_Number: 'MCP-10115', Quote_Due_Date: 'Nov 06,2026 14:53', Project_Quote_Status: '' });
  assert.strictEqual(p.due, 'Nov 6, 2026');
  assert.strictEqual(p.status, 'Open');
});

test('client checks: company, street and city needed; phone and email cleaned', () => {
  assert.deepStrictEqual(K.checkClient({}).errors, ['Company name is needed.', 'Address: street is needed.', 'Address: city is needed.', 'Address: zip code is needed.']);
  assert.deepStrictEqual(K.checkClient({ client_id: '5', company: 'x', address1: 'a', city: 'b' }).errors, []);   // an older client without a zip can still be edited
  const { errors, value } = K.checkClient({ company: ' Ace  Contracting ', address1: '12 Main', city: 'Buffalo', zip: '14221', state: 'new york', phone: '716.555.1212', email: 'Bob@Ace.com' });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual([value.company, value.state, value.phone, value.email], ['Ace Contracting', 'NY', '+17165551212', 'bob@ace.com']);
  assert.match(K.checkClient({ client_id: '5', company: 'x', address1: 'a', city: 'b', phone: '555' }).errors[0], /phone number/);
  assert.match(K.checkClient({ client_id: '5', company: 'x', address1: 'a', city: 'b', email: 'bob@' }).errors[0], /email address/);
});

test('client fields: full set, so clearing a field clears it; inactive written as Not Active', () => {
  const f = K.clientFields(K.checkClient({ company: 'Ace', address1: '1 A St', city: 'Buffalo', zip: '14201', active: false }).value);
  assert.strictEqual(f.Client_Phone_Number, '');
  assert.strictEqual(f.Client_Email, '');
  assert.strictEqual(f.Client_Status, 'Not Active');
  assert.strictEqual(f.Client_Address.district_city, 'Buffalo');
});

test('contact checks: first name and email needed; ext taken from the phone', () => {
  assert.deepStrictEqual(K.checkRep({}).errors, ['First name is needed.', 'Email is needed.']);
  const v = K.checkRep({ first: 'Zack', email: 'z@ace.com', phone: '716-555-1212 x 204', location_id: '5' }).value;
  assert.deepStrictEqual([v.phone, v.ext], ['+17165551212', '204']);
  assert.deepStrictEqual(K.repFields(v).Client_Locations, ['5']);
});

test('location name defaults to the city; zip needed', () => {
  assert.match(K.checkLocation({ address1: '1 A St', city: 'Heath' }).errors[0], /zip/);
  assert.strictEqual(K.checkLocation({ address1: '1 A St', city: 'Heath', zip: '75032' }).value.name, 'Heath');
});

test('duplicates: same name ignoring Inc/punctuation, same or unknown city', () => {
  const list = [{ id: '1', company: 'Ace Contracting, Inc.', city: 'Buffalo' }];
  assert.strictEqual(K.duplicateOf(list, 'ACE Contracting', 'Buffalo').id, '1');
  assert.strictEqual(K.duplicateOf(list, 'Ace Contracting', 'Erie'), null);
  assert.strictEqual(K.duplicateOf(list, 'Ace Contracting', 'Buffalo', '1'), null);   // editing itself
  const reps = [{ id: '7', client_id: '1', email: 'z@ace.com', name: 'Zack' }];
  assert.strictEqual(K.sameRepEmail(reps, '1', 'Z@ACE.com').id, '7');
  assert.strictEqual(K.sameRepEmail(reps, '1', 'z@ace.com', '7'), null);
});
