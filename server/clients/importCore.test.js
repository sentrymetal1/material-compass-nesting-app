// Run: node --test server/clients/importCore.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('./importCore');

test('QuickBooks Online export: title lines skipped, headers mapped', () => {
  const csv = 'Customer Contact List\n\n"Customer","Phone Numbers","Email","Full Name","Billing Address"\n' +
    '"Ace Contracting, Inc.","(716) 555-1212","bob@ace.com","Bob Jones","12 Main St, Buffalo, NY 14221"\n';
  const { headers, rows } = C.splitHeader(C.parseDelimited(csv));
  assert.deepStrictEqual(headers, ['Customer', 'Phone Numbers', 'Email', 'Full Name', 'Billing Address']);
  const { mapping, unknown } = C.autoMap(headers);
  assert.deepStrictEqual(mapping, ['company', 'phone', 'contact_email', 'contact_name', 'address_full']);
  assert.deepStrictEqual(unknown, []);
  const [it] = C.buildPreview(rows, mapping, { clients: [], reps: [] });
  assert.strictEqual(it.client.company, 'Ace Contracting, Inc.');
  assert.strictEqual(it.client.address1, '12 Main St');
  assert.strictEqual(it.client.city, 'Buffalo');
  assert.strictEqual(it.client.state, 'NY');
  assert.strictEqual(it.client.zip, '14221');
  assert.strictEqual(it.client.phone, '+17165551212');
  assert.strictEqual(it.client.email, 'bob@ace.com');          // only email column -> client's too
  assert.deepStrictEqual([it.contacts[0].first, it.contacts[0].last, it.contacts[0].email], ['Bob', 'Jones', 'bob@ace.com']);
  assert.strictEqual(it.status, 'new');
});

test('Outlook export headers', () => {
  const h = ['First Name', 'Last Name', 'Company', 'Business Street', 'Business City', 'Business State', 'Business Postal Code',
    'Business Phone', 'Mobile Phone', 'E-mail Address'];
  assert.deepStrictEqual(C.autoMap(h).mapping, ['contact_first', 'contact_last', 'company', 'address1', 'city', 'state', 'zip',
    'phone', 'contact_mobile', 'contact_email']);
});

test('unknown headers are reported, not guessed', () => {
  const { mapping, unknown } = C.autoMap(['Cust Nm', 'Addr', 'City', 'Fax']);
  assert.deepStrictEqual(mapping, ['', '', 'city', '']);
  assert.deepStrictEqual(unknown, [0, 1, 3]);
});

test('paste from Excel (tabs), quoted newlines', () => {
  const rows = C.parseDelimited('Company\tCity\nAce\tBuffalo\n"Two\nLines"\tLockport');
  assert.deepStrictEqual(rows, [['Company', 'City'], ['Ace', 'Buffalo'], ['Two\nLines', 'Lockport']]);
});

test('cleaning: phones, states, zips, emails, names', () => {
  assert.deepStrictEqual(C.cleanPhone('716.555.1212 x204'), { value: '+17165551212', ext: '204' });
  assert.strictEqual(C.cleanPhone('1-716-555-1212').value, '+17165551212');
  assert.strictEqual(C.cleanPhone('call office').bad, 'call office');
  assert.strictEqual(C.cleanState('New York'), 'NY');
  assert.strictEqual(C.cleanState('n.y.'), 'NY');
  assert.strictEqual(C.cleanZip('1234'), '01234');
  assert.strictEqual(C.cleanEmail('Bob@Ace.com; sue@ace.com').value, 'bob@ace.com');
  assert.ok(C.cleanEmail('bob at ace').bad);
  assert.deepStrictEqual(C.splitName('Smith, John'), { first: 'John', last: 'Smith' });
  assert.deepStrictEqual(C.splitName('Mr. John Q Smith'), { first: 'John Q', last: 'Smith' });
  assert.deepStrictEqual(C.parseFullAddress('12 Main St\nSuite 4\nBuffalo NY 14221'),
    { state: 'NY', zip: '14221', city: 'Buffalo', address1: '12 Main St', address2: 'Suite 4' });
});

test('duplicates: name + city, suffixes ignored; same client twice in the file = one client, two contacts', () => {
  const map = ['company', 'city', 'address1', 'contact_first', 'contact_email', 'zip'];
  const rows = [
    ['ACE CONTRACTING CO.', 'Buffalo', '1 A St', 'Bob', 'bob@ace.com', '14201'],
    ['Ace Contracting', 'Buffalo', '1 A St', 'Sue', 'sue@ace.com', '14201'],
    ['Ace Contracting', 'Rochester', '9 B St', 'Tim', 'tim@ace.com', '14604'],
    ['Capital Steel', 'Lockport', '', '', '', '14094'],
  ];
  const existing = { clients: [{ id: '11', company: 'Ace Contracting, Inc.', city: 'Buffalo' }], reps: [{ client_id: '11', email: 'bob@ace.com' }] };
  const items = C.buildPreview(rows, map, existing);
  assert.strictEqual(items.length, 3);
  const [buf, roc, cap] = items;
  assert.strictEqual(buf.status, 'exists');
  assert.strictEqual(buf.existing_id, '11');
  assert.strictEqual(buf.client.company, 'Ace Contracting Co.');    // ALL CAPS tidied
  assert.deepStrictEqual(buf.contacts.map((k) => [k.first, !!k.exists]), [['Bob', true], ['Sue', false]]);
  assert.strictEqual(buf.contacts_to_add, 1);
  assert.strictEqual(roc.status, 'new');
  assert.match(roc.similar, /different city/);
  assert.strictEqual(cap.status, 'fix');
  assert.deepStrictEqual(cap.fix, ['No street address']);   // has a city
  const [nz] = C.buildPreview([['Nozip Co', 'Erie', '1 A St', '', '', '']], map, null);
  assert.deepStrictEqual(nz.fix, ['No zip code']);         // its location would be refused without one
});

test('contact without a valid email is skipped, client still imports', () => {
  const [it] = C.buildPreview([['Ace', '1 A St', 'Buffalo', 'Bob', 'nope', '14201']], ['company', 'address1', 'city', 'contact_first', 'contact_email', 'zip'], null);
  assert.strictEqual(it.status, 'new');
  assert.strictEqual(it.contacts_skipped, 1);
  assert.strictEqual(it.contacts_to_add, 0);
  assert.ok(it.notes.some((n) => /Contact email not recognized/.test(n)));
});

test('Zoho records', () => {
  const c = { company: 'Ace', address1: '1 A St', address2: '', city: 'Buffalo', state: 'NY', zip: '14221', country: '', phone: '+17165551212', email: '', notes: '' };
  const r = C.clientRecord('99', c, 'Nov 19,2026');
  assert.strictEqual(r.Manufacturer, '99');
  assert.ok(!('Client_Email' in r));                                 // optional now, never blank-filled
  assert.strictEqual(r.Client_Address.district_city, 'Buffalo');
  assert.strictEqual(C.locationRecord('99', '5', c).Location_Name, 'Buffalo');
  assert.strictEqual(C.locationRecord('99', '5', Object.assign({}, c, { city: '' })).Location_Name, 'Main');
  const rep = C.repRecord('99', '5', '7', { first: 'Bob', last: 'Jones', email: 'b@a.com', phone: '', mobile: '+1716', ext: '' }, 'Nov 19,2026');
  assert.deepStrictEqual(rep.Client_Locations, ['7']);
  assert.strictEqual(rep.Mobile, '+1716');
  assert.strictEqual(C.zDate(new Date(2026, 10, 9)), 'Nov 09,2026');
});

test('rematch: edited items are cleaned and checked against the current list', () => {
  const items = [{ client: { company: 'Ace Contracting', address1: '1 A St', city: 'Buffalo', state: 'new york', phone: '716 555 1212' },
    contacts: [{ first: 'Bob', email: 'BOB@ace.com', ext: 'x 204' }, { first: 'Sue', email: 'sue@ace.com' }] },
  { client: { company: 'New Co', address1: '' }, contacts: [] }];
  const out = C.rematch(items, { clients: [{ id: '11', company: 'ACE Contracting LLC', city: 'buffalo' }], reps: [{ client_id: '11', email: 'bob@ace.com' }] });
  assert.strictEqual(out[0].status, 'exists');
  assert.strictEqual(out[0].client.state, 'NY');
  assert.strictEqual(out[0].client.phone, '+17165551212');
  assert.deepStrictEqual(out[0].contacts.map((k) => k.exists), [true, false]);
  assert.strictEqual(out[0].contacts[0].ext, '204');
  assert.strictEqual(out[1].status, 'fix');
});

test('QuickBooks Desktop "Bill to" lines: company line dropped, city/state/zip read', () => {
  const h = ['Customer', 'Bill to 1', 'Bill to 2', 'Bill to 3', 'Main Phone', 'Main Email', 'First Name', 'Last Name', 'Fax'];
  const { mapping } = C.autoMap(h);
  assert.deepStrictEqual(mapping, ['company', 'address_full', 'address_full', 'address_full', 'phone', 'email', 'contact_first', 'contact_last', '']);
  const [it] = C.buildPreview([['Ace Contracting', 'Ace Contracting Inc.', '12 Main St', 'Buffalo, NY 14221', '716-555-1212', 'office@ace.com', 'Bob', 'Jones', '']], mapping, null);
  assert.deepStrictEqual([it.client.address1, it.client.city, it.client.state, it.client.zip], ['12 Main St', 'Buffalo', 'NY', '14221']);
  assert.strictEqual(it.client.email, 'office@ace.com');
  assert.strictEqual(it.contacts[0].email, 'office@ace.com');   // the only email column reaches the contact too
  assert.strictEqual(it.contacts_to_add, 1);
});

test('spelled-out states and company-phone extensions', () => {
  assert.deepStrictEqual(C.parseFullAddress('40 River Rd, Lockport, New York 14094'), { state: 'NY', zip: '14094', city: 'Lockport', address1: '40 River Rd' });
  assert.strictEqual(C.parseFullAddress('1 A St, Wheeling, West Virginia 26003').state, 'WV');
  assert.deepStrictEqual(C.parseFullAddress('9 B St, New York, NY 10001'), { state: 'NY', zip: '10001', city: 'New York', address1: '9 B St' });
  const [it] = C.buildPreview([['N', '40 River Rd', 'Lockport', '716.555.3333 x12', 'Tim']], ['company', 'address1', 'city', 'phone', 'contact_first'], null);
  assert.deepStrictEqual([it.contacts[0].phone, it.contacts[0].ext], ['+17165553333', '12']);
  const [it2] = C.buildPreview([['N', '40 River Rd', '716.555.3333 x12']], ['company', 'address1', 'phone'], null);
  assert.ok(it2.notes.some((n) => /extension x12/.test(n)));
});
