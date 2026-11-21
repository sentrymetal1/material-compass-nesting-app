// =============================================================================
//  clients/importCore.js — a shop's customer list, from whatever it exported, into clients.
// -----------------------------------------------------------------------------
//  Pure functions (tested in importCore.test.js); clients/importRoutes.js does the I/O.
//
//    read    file or pasted text -> header row + data rows (CSV, TSV/paste, .xlsx)
//    autoMap header names -> our fields, from the names QuickBooks, Sage, Xero, Outlook,
//            Gmail and common CRMs export. Headers it does not know are left for the AI to
//            SUGGEST and the admin to confirm; nothing is mapped silently.
//    preview mapped rows -> one item per client: cleaned values, contacts, and a status:
//            new | exists (already in this shop's list) | fix (cannot be saved as is).
//
//  Values only ever come from the shop's own file. Nothing is invented: a value that cannot be
//  read (a phone that is not a phone) is dropped with a note, never guessed.
//  Duplicates (Mark, 2026-11-19): same company name AND same city; name alone when either side
//  has no city. Rows of the file that are the same client become one client with its contacts.
// =============================================================================

const FIELDS = [
  { key: 'company', label: 'Company name' },
  { key: 'address1', label: 'Address line 1' },
  { key: 'address2', label: 'Address line 2' },
  { key: 'address_full', label: 'Full address (one cell)' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'Zip / postal code' },
  { key: 'country', label: 'Country' },
  { key: 'phone', label: 'Company phone' },
  { key: 'email', label: 'Company email' },
  { key: 'notes', label: 'Notes' },
  { key: 'contact_name', label: 'Contact full name' },
  { key: 'contact_first', label: 'Contact first name' },
  { key: 'contact_last', label: 'Contact last name' },
  { key: 'contact_email', label: 'Contact email' },
  { key: 'contact_phone', label: 'Contact phone' },
  { key: 'contact_mobile', label: 'Contact mobile' },
  { key: 'contact_ext', label: 'Contact phone ext' },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

// Header spellings -> field. Compared after hkey(): lowercase, letters and digits only.
const SYN = {
  company: ['company', 'companyname', 'customer', 'customername', 'customerfullname', 'client', 'clientname', 'nameofclient',
    'organization', 'organisation', 'organizationname', 'organization1name', 'contactname', 'account', 'accountname', 'business',
    'businessname', 'name', 'displayname', 'customerdisplayname'],
  address1: ['address', 'address1', 'addressline1', 'street', 'street1', 'streetaddress', 'billingstreet', 'billingaddress1',
    'billingaddressline1', 'billtostreet1', 'billtostreet', 'businessstreet', 'address1street', 'poaddressline1',
    'mailingstreet', 'billingaddressstreet', 'addressstreet'],
  address2: ['address2', 'addressline2', 'street2', 'billingstreet2', 'billingaddress2', 'billtostreet2', 'businessstreet2',
    'poaddressline2', 'suite', 'unit'],
  address_full: ['billingaddress', 'fulladdress', 'billto', 'mailingaddress', 'address1formatted', 'businessaddress',
    'billto1', 'billto2', 'billto3', 'billto4', 'billto5'],   // QuickBooks Desktop: one address line per column
  city: ['city', 'town', 'billingcity', 'billtocity', 'businesscity', 'address1city', 'pocity', 'mailingcity'],
  state: ['state', 'province', 'stateprovince', 'region', 'stateregion', 'billingstate', 'billtostate', 'businessstate',
    'address1region', 'poregion', 'mailingstate', 'st'],
  zip: ['zip', 'zipcode', 'postalcode', 'postcode', 'billingzip', 'billingpostalcode', 'billtozip', 'businesspostalcode',
    'address1postalcode', 'popostalcode', 'mailingzip', 'mailingpostalcode'],
  country: ['country', 'countryregion', 'billingcountry', 'billtocountry', 'businesscountryregion', 'address1country', 'pocountry'],
  phone: ['phone', 'phonenumber', 'mainphone', 'companyphone', 'businessphone', 'officephone', 'workphone', 'phonenumbers',
    'phone1value', 'telephone', 'tel', 'clientphonenumber'],
  email: ['companyemail', 'mainemail', 'clientemail', 'generalemail', 'officeemail'],
  notes: ['notes', 'note', 'memo', 'comments', 'description'],
  contact_name: ['fullname', 'primarycontact', 'contact', 'contactperson', 'attention', 'attn', 'maincontact'],
  contact_first: ['firstname', 'first', 'givenname', 'contactfirstname', 'fname'],
  contact_last: ['lastname', 'last', 'familyname', 'surname', 'contactlastname', 'lname'],
  contact_email: ['email', 'emailaddress', 'email1value', 'contactemail', 'emailaddress1', 'primaryemail', 'workemail'],
  contact_phone: ['contactphone', 'directphone', 'directline', 'phone2value', 'altphone', 'alternatephone'],
  contact_mobile: ['mobile', 'mobilephone', 'cell', 'cellphone', 'cellular'],
  contact_ext: ['ext', 'extension', 'phoneext', 'phoneextension'],
};
const hkey = (h) => String(h == null ? '' : h).toLowerCase().replace(/^\*/, '').replace(/[^a-z0-9]/g, '');
const SYN_INDEX = (() => { const m = {}; for (const k of Object.keys(SYN)) for (const h of SYN[k]) if (!m[h]) m[h] = k; return m; })();

// headers -> { mapping: [field|''] per column, unknown: [column indexes] }. Each field is used
// once (the first column that claims it), except that a second "phone" goes to contact phone.
const MULTI = { address_full: 1, notes: 1 };   // fields several columns may feed (joined in order)
function autoMap(headers) {
  const used = {}, mapping = [], unknown = [];
  headers.forEach((h, i) => {
    let f = SYN_INDEX[hkey(h)] || '';
    if (f && used[f] && !MULTI[f]) f = (f === 'phone' && !used.contact_phone) ? 'contact_phone' : (f === 'contact_email' && !used.email ? 'email' : '');
    if (f) used[f] = 1;
    mapping.push(f);
    if (!f && String(h || '').trim()) unknown.push(i);
  });
  return { mapping, unknown };
}

// ---------- reading ----------------------------------------------------------------------------
// CSV/TSV text -> rows of cells (quotes, doubled quotes, newlines inside quotes).
function parseDelimited(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const firstLine = t.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t'
    : ((firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// The header row: the first of the first 10 rows with 2+ cells that look like labels (QuickBooks
// puts a report title and a blank line above the real headers).
function splitHeader(rows) {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i] || [];
    const filled = r.filter((c) => String(c).trim() !== '');
    const known = r.filter((c) => SYN_INDEX[hkey(c)]).length;
    if (filled.length >= 2 && (known >= 1 || filled.every((c) => /[a-z]/i.test(c) && String(c).length < 40))) {
      return { headers: r.map((c) => String(c).trim()), rows: rows.slice(i + 1) };
    }
  }
  return { headers: (rows[0] || []).map((c) => String(c).trim()), rows: rows.slice(1) };
}

// ---------- cleaning --------------------------------------------------------------------------
const s = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN',
  iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  ontario: 'ON', quebec: 'QC', 'british columbia': 'BC', alberta: 'AB', manitoba: 'MB', saskatchewan: 'SK', 'nova scotia': 'NS',
  'new brunswick': 'NB', 'prince edward island': 'PE', 'newfoundland and labrador': 'NL' };
function cleanState(v) {
  const t = s(v).replace(/\./g, '');
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return STATES[t.toLowerCase()] || t;
}
// -> { value, bad } ; US/Canada 10 digits (or 11 with leading 1) -> +1XXXXXXXXXX, ext split off.
function cleanPhone(v) {
  let t = s(v);
  if (!t) return { value: '', ext: '' };
  let ext = '';
  const m = /\s*(?:x|ext\.?|extension|#)\s*(\d{1,6})\s*$/i.exec(t);
  if (m) { ext = m[1]; t = t.slice(0, m.index); }
  const d = t.replace(/\D/g, '');
  if (d.length === 10) return { value: '+1' + d, ext };
  if (d.length === 11 && d[0] === '1') return { value: '+' + d, ext };
  if (t.trim().startsWith('+') && d.length >= 8 && d.length <= 15) return { value: '+' + d, ext };
  return { value: '', ext, bad: s(v) };
}
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
function cleanEmail(v) {
  const t = s(v).replace(/^mailto:/i, '');
  if (!t) return { value: '' };
  const first = t.split(/[;,\s]+/).find((x) => x.includes('@')) || t;   // "a@x.com; b@x.com" -> first
  return EMAIL_RE.test(first) ? { value: first.toLowerCase() } : { value: '', bad: t };
}
function cleanZip(v) {
  const t = s(v);
  if (/^\d{4}$/.test(t)) return '0' + t;          // Excel ate the leading zero of 01234
  if (/^\d{9}$/.test(t)) return t.slice(0, 5) + '-' + t.slice(5);
  return t;
}
// "12 Main St, Suite 4, Buffalo, NY 14221" / "12 Main St\nBuffalo NY 14221" -> parts
function parseFullAddress(v) {
  const t = String(v == null ? '' : v).replace(/\r/g, '').trim();
  if (!t) return {};
  const parts = t.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
  const out = {};
  // last part may be "NY 14221", "Buffalo NY 14221" or "USA"
  if (parts.length && /^(usa|us|united states( of america)?|canada)$/i.test(parts[parts.length - 1])) out.country = parts.pop();
  // "New York 14094" -> "NY 14094" (longest names first, so West Virginia is not read as Virginia)
  let last = parts[parts.length - 1] || '';
  for (const nm of Object.keys(STATES).sort((a, b) => b.length - a.length)) {
    const re = new RegExp('(^|\\s)' + nm.replace(/ /g, '\\s+') + '(?=\\s+[0-9A-Za-z]{3,}$)', 'i');
    if (re.test(last)) { last = last.replace(re, '$1' + STATES[nm]); break; }
  }
  let m = /^(?:(.*?)\s+)?([A-Za-z]{2}|[A-Za-z][A-Za-z ]+?)\s+(\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d)$/.exec(last);
  if (m && (m[2].length === 2 || STATES[m[2].toLowerCase()])) {
    parts.pop();
    out.state = m[2]; out.zip = m[3];
    if (m[1]) out.city = m[1];
    else if (parts.length > 1) out.city = parts.pop();
  }
  if (parts.length) out.address1 = parts.shift();
  if (parts.length) out.address2 = parts.join(', ');
  return out;
}
function splitName(v) {
  let t = s(v);
  if (!t) return { first: '', last: '' };
  if (t.includes(',')) { const [a, b] = t.split(',', 2).map(s); t = (b + ' ' + a).trim(); }   // "Smith, John"
  t = t.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '');
  const p = t.split(' ');
  return p.length === 1 ? { first: p[0], last: '' } : { first: p.slice(0, -1).join(' '), last: p[p.length - 1] };
}
const tidyCase = (t) => (t && t === t.toUpperCase() && /[A-Z]{4}/.test(t) ? t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : t);

// For duplicates: "The ABC Construction Co., Inc." == "abc construction"
function nameKey(v) {
  return s(v).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|inc|incorporated|llc|l l c|co|corp|corporation|company|ltd|limited|lp|llp|pllc|pc)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const cityKey = (v) => s(v).toLowerCase().replace(/[^a-z]/g, '');

// ---------- preview ---------------------------------------------------------------------------
// One row of the file, through the mapping -> raw field values (several columns on one field join).
function rowValues(row, mapping) {
  const v = {};
  mapping.forEach((f, i) => {
    if (!f) return;
    const c = s(row[i]);
    if (!c) return;
    v[f] = v[f] ? v[f] + ', ' + c : c;
  });
  return v;
}

// Cleaned client + contact from one row's values.
function cleanRow(v) {
  const notes = [];
  // A full-address block often starts with the company name (QuickBooks "Bill to 1"); drop that line.
  let full = v.address_full || '';
  if (full && v.company) {
    const parts = full.split(/\n|,\s*/);
    while (parts.length > 1 && nameKey(parts[0]) && nameKey(parts[0]) === nameKey(v.company)) parts.shift();
    full = parts.join(', ');
  }
  const a = full ? parseFullAddress(full) : {};
  const client = {
    company: tidyCase(s(v.company)),
    address1: s(v.address1) || a.address1 || '',
    address2: s(v.address2) || a.address2 || '',
    city: tidyCase(s(v.city) || a.city || ''),
    state: cleanState(v.state || a.state || ''),
    zip: cleanZip(v.zip || a.zip || ''),
    country: s(v.country) || a.country || '',
    phone: '', email: '', notes: s(v.notes),
  };
  const ph = cleanPhone(v.phone);
  client.phone = ph.value;
  const phoneExt = ph.ext;
  if (ph.bad) notes.push('Company phone not recognized: ' + ph.bad);
  const em = cleanEmail(v.email);
  client.email = em.value;
  if (em.bad) notes.push('Company email not recognized: ' + em.bad);

  let first = s(v.contact_first), last = s(v.contact_last);
  if (!first && !last && v.contact_name) ({ first, last } = splitName(v.contact_name));
  if (!first && last) { first = last; last = ''; }
  let contact = null;
  const cem = cleanEmail(v.contact_email);
  if (first || cem.value || cem.bad) {
    const cph = cleanPhone(v.contact_phone), cmo = cleanPhone(v.contact_mobile);
    contact = { first, last, email: cem.value, phone: cph.value, mobile: cmo.value,
      ext: s(v.contact_ext).replace(/\D/g, '') || cph.ext || '' };
    if (cem.bad) notes.push('Contact email not recognized: ' + cem.bad);
    if (cph.bad) notes.push('Contact phone not recognized: ' + cph.bad);
    if (cmo.bad) notes.push('Contact mobile not recognized: ' + cmo.bad);
  }
  // The client has no extension field: an extension on the company phone goes to the contact
  // (with that phone) when the contact has neither; otherwise it is noted, never dropped silently.
  if (phoneExt) {
    if (contact && !contact.phone && !contact.ext) { contact.phone = client.phone; contact.ext = phoneExt; }
    else notes.push('Company phone extension x' + phoneExt + ' is not kept (clients have no extension field)');
  }
  // A list with one email column and no company email: that email is the client's too.
  if (!client.email && contact && contact.email) client.email = contact.email;
  // ...and the other way round: a list with only a company email column (QuickBooks "Main Email") and a
  // contact name: that email is how the contact is reached.
  if (contact && !contact.email && !v.contact_email && client.email) contact.email = client.email;
  return { client, contact, notes };
}

// The status of one item, from its (possibly edited) values. Used again after inline edits.
function itemStatus(it) {
  const c = it.client;
  const fix = [];
  if (!c.company) fix.push('No company name');
  if (!c.address1) fix.push('No street address');
  if (!c.city) fix.push('No city');                       // Zoho requires the address city
  if (!c.zip) fix.push('No zip code');                    // ...and the location's zip (2026-11-21: a location without one is refused)
  const warn = [];
  if (!c.phone) warn.push('No phone');
  if (!c.email) warn.push('No email');
  const contacts = it.contacts || [];
  const skipped = contacts.filter((k) => !k.exists && (!k.first || !EMAIL_RE.test(k.email || '')));
  return { fix, warn, contactsToAdd: contacts.filter((k) => !k.exists && k.first && EMAIL_RE.test(k.email || '')).length,
    contactsSkipped: skipped.length };
}

// existing: { clients: [{id, company, city, address1}], reps: [{client_id, email}] }
// -> items [{ key, rows:[file row numbers], client, contacts:[{first,last,email,phone,mobile,ext,exists}],
//            notes, status: 'new'|'exists'|'fix', existing_id, fix, warn, similar }]
function buildPreview(rows, mapping, existing) {
  const ex = existing || { clients: [], reps: [] };
  const exByName = {};
  for (const c of ex.clients) (exByName[nameKey(c.company)] = exByName[nameKey(c.company)] || []).push(c);
  const repEmails = {};
  for (const r of ex.reps || []) if (r.email) repEmails[r.client_id + '|' + r.email.toLowerCase()] = 1;

  const items = [], byKey = {};
  rows.forEach((row, i) => {
    const { client, contact, notes } = cleanRow(rowValues(row, mapping));
    if (!client.company && !client.address1 && !contact) return;            // blank / subtotal line
    const nk = nameKey(client.company), ck = cityKey(client.city);
    // Same client within the file: same name, and same city when both have one.
    const key = nk ? (Object.keys(byKey).find((k) => k.split('|')[0] === nk && (!ck || !k.split('|')[1] || k.split('|')[1] === ck)) || nk + '|' + ck) : 'row' + i;
    let it = byKey[key];
    if (!it) {
      it = byKey[key] = { key, rows: [], client, contacts: [], notes: [] };
      items.push(it);
    } else {
      for (const f of Object.keys(client)) if (!it.client[f] && client[f]) it.client[f] = client[f];   // fill gaps
    }
    it.rows.push(i + 1);
    it.notes.push(...notes);
    if (contact && !it.contacts.some((k) => (k.email && k.email === contact.email) || (!k.email && !contact.email && k.first === contact.first && k.last === contact.last))) {
      it.contacts.push(contact);
    }
  });

  for (const it of items) {
    const nk = nameKey(it.client.company), ck = cityKey(it.client.city);
    const same = (exByName[nk] || []);
    const match = same.find((c) => !ck || !cityKey(c.city) || cityKey(c.city) === ck);
    if (match) {
      it.existing_id = match.id;
      for (const k of it.contacts) k.exists = !!(k.email && repEmails[match.id + '|' + k.email]);
    } else if (same.length) {
      it.similar = 'A client named ' + same[0].company + ' is already in your list' + (same[0].city ? ' (' + same[0].city + ')' : '') + '. This one is in a different city, so it is added as a new client.';
    }
    finish(it);
  }
  return items;
}
// Edited items from the page, matched again against the shop's list as it is NOW (another tab or
// person may have added clients since the preview), so the import never creates a duplicate.
function rematch(items, existing) {
  const ex = existing || { clients: [], reps: [] };
  const exByName = {};
  for (const c of ex.clients) (exByName[nameKey(c.company)] = exByName[nameKey(c.company)] || []).push(c);
  const repEmails = {};
  for (const r of ex.reps || []) if (r.email) repEmails[r.client_id + '|' + r.email.toLowerCase()] = 1;
  return items.map((raw) => {
    const it = { key: raw.key, rows: raw.rows || [], notes: raw.notes || [], client: Object.assign({}, raw.client),
      contacts: (raw.contacts || []).map((k) => Object.assign({}, k, { email: cleanEmail(k.email).value || '' })) };
    const c = it.client;
    for (const f of ['company', 'address1', 'address2', 'city', 'country', 'notes']) c[f] = s(c[f]);
    c.state = cleanState(c.state); c.zip = cleanZip(c.zip);
    c.phone = cleanPhone(c.phone).value; c.email = cleanEmail(c.email).value;
    for (const k of it.contacts) { k.first = s(k.first); k.last = s(k.last); k.phone = cleanPhone(k.phone).value; k.mobile = cleanPhone(k.mobile).value; k.ext = s(k.ext).replace(/\D/g, ''); }
    const nk = nameKey(c.company), ck = cityKey(c.city);
    const match = (exByName[nk] || []).find((x) => !ck || !cityKey(x.city) || cityKey(x.city) === ck);
    if (match) { it.existing_id = match.id; for (const k of it.contacts) k.exists = !!(k.email && repEmails[match.id + '|' + k.email]); }
    else for (const k of it.contacts) k.exists = false;
    return finish(it);
  });
}
function finish(it) {
  const st = itemStatus(it);
  it.fix = st.fix; it.warn = st.warn;
  it.contacts_to_add = st.contactsToAdd; it.contacts_skipped = st.contactsSkipped;
  it.status = it.existing_id ? 'exists' : (st.fix.length ? 'fix' : 'new');
  return it;
}

// ---------- Zoho records -------------------------------------------------------------------------
function zDate(d) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return M[d.getMonth()] + ' ' + String(d.getDate()).padStart(2, '0') + ',' + d.getFullYear();
}
const zAddress = (c) => ({ address_line_1: c.address1, address_line_2: c.address2 || '', district_city: c.city || '',
  state_province: c.state || '', postal_code: c.zip || '', country: c.country || '' });
function clientRecord(mfg, c, today) {
  const r = { Manufacturer: mfg, Manufacture_ID: mfg, Client_Company_Name: c.company, Client_Address: zAddress(c),
    Client_Status: 'Active', Date_Account_Created: today };
  if (c.phone) r.Client_Phone_Number = c.phone;
  if (c.email) r.Client_Email = c.email;
  if (c.notes) r.Notes_Paste_Information = c.notes;
  return r;
}
// Location named after the city, like the shop's existing ones ("Buffalo"); "Main" without a city.
function locationRecord(mfg, clientId, c) {
  const r = { CLIENT: clientId, MANUFACTURE: mfg, Location_Name: c.city || 'Main', Address: zAddress(c) };
  if (c.phone) r.Phone_Number = c.phone;
  return r;
}
function repRecord(mfg, clientId, locId, k, today) {
  const r = { MANUFACTURE: mfg, CLIENT: clientId, Client_Locations: [locId], Name: { first_name: k.first, last_name: k.last || '' },
    Email: k.email, Client_Representative_Created: today };
  if (k.phone) r.Phone_Number = k.phone;
  if (k.mobile) r.Mobile = k.mobile;
  if (k.ext) r.Phone_Ext = k.ext;
  return r;
}

// The downloadable template.
const TEMPLATE_HEADERS = ['Company name', 'Address line 1', 'Address line 2', 'City', 'State', 'Zip', 'Company phone', 'Company email',
  'Contact first name', 'Contact last name', 'Contact email', 'Contact phone', 'Contact mobile', 'Notes'];

module.exports = { FIELDS, FIELD_KEYS, autoMap, parseDelimited, splitHeader, cleanPhone, cleanEmail, cleanState, cleanZip,
  parseFullAddress, splitName, nameKey, rematch, rowValues, cleanRow, buildPreview, itemStatus, finish, clientRecord, locationRecord,
  repRecord, zDate, EMAIL_RE, TEMPLATE_HEADERS, hkey };
