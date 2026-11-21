// =============================================================================
//  clients/clientsCore.js — pure helpers for the Clients page (server: clientsRoutes.js,
//  page: takeoff/public/clients.html). No I/O here, so it is all unit-tested (clientsCore.test.js).
//
//  The records stay in Zoho (MFG_Client_Form, MFG_Client_Locations, MFG_Client_Representatives),
//  because projects, leads and RFQ triage point at them. Only the page moved off Zoho.
// =============================================================================
const C = require('./importCore');

const s = (v) => (v == null ? '' : String(v)).trim();
const idOf = (v) => (v && typeof v === 'object' ? s(v.ID) : s(v));
const disp = (v) => (v && typeof v === 'object' ? s(v.zc_display_value) : s(v));

// Client_Status is a radio, Active / Not Active. Most older clients have it blank: those are active.
const INACTIVE = 'Not Active';
const isActive = (status) => !/^not\s*active$/i.test(s(status));

// "+17134122882" -> "(713) 412-2882"; anything else as stored.
function showPhone(v) {
  const t = s(v), d = t.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return t;
}

function addr(a) {
  a = a && typeof a === 'object' ? a : {};
  return { address1: s(a.address_line_1), address2: s(a.address_line_2), city: s(a.district_city),
    state: s(a.state_province), zip: s(a.postal_code), country: s(a.country) };
}
const addrLine = (a) => [a.address1, a.address2, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

function shapeClient(c) {
  const a = addr(c.Client_Address);
  return { id: s(c.ID), company: s(c.Client_Company_Name), ...a, line: addrLine(a), phone: showPhone(c.Client_Phone_Number),
    email: s(c.Client_Email), active: isActive(c.Client_Status), notes: s(c.Notes_Paste_Information), created: s(c.Date_Account_Created) };
}
function shapeLoc(l) {
  const a = addr(l.Address);
  return { id: s(l.ID), client_id: idOf(l.CLIENT), name: s(l.Location_Name), ...a, line: addrLine(a), phone: showPhone(l.Phone_Number) };
}
function shapeRep(r) {
  const n = r.Name && typeof r.Name === 'object' ? r.Name : {};
  const locs = Array.isArray(r.Client_Locations) ? r.Client_Locations : (r.Client_Locations ? [r.Client_Locations] : []);
  return { id: s(r.ID), client_id: idOf(r.CLIENT), first: s(n.first_name), last: s(n.last_name),
    name: s(n.zc_display_value) || (s(n.first_name) + ' ' + s(n.last_name)).trim(),
    email: s(r.Email), phone: showPhone(r.Phone_Number), mobile: showPhone(r.Mobile), ext: s(r.Phone_Ext),
    location_id: locs.length ? idOf(locs[0]) : '', location: locs.length ? (s(locs[0].Location_Name) || disp(locs[0])) : '',
    notes: s(r.Contact_Information_Additional) };
}
// "Nov 06,2026 14:53" -> "Nov 6, 2026"
const showDate = (v) => s(v).replace(/\s+\d{1,2}:\d{2}.*$/, '').replace(/^([A-Za-z]{3}) 0?(\d{1,2}),\s*(\d{4})$/, '$1 $2, $3');
function shapeProject(p) {
  return { id: s(p.ID), number: s(p.Project_Quote_Number), name: s(p.Project_Description), status: s(p.Project_Quote_Status) || 'Open',
    due: showDate(p.Quote_Due_Date), rfq: s(p.Client_RFQ_Reference_Number), award: showDate(p.Expected_Award_Date) };
}

// ---------- validation: page input -> clean values, or the problems to fix ----------------------
function phoneField(v, label, errors) {
  if (!s(v)) return { value: '', ext: '' };
  const p = C.cleanPhone(v);
  if (p.bad) errors.push(label + ' "' + s(v) + '" doesn\'t look like a phone number. Use 10 digits, e.g. 716-555-1212.');
  return p;
}
function emailField(v, label, errors, required) {
  const e = s(v).replace(/^mailto:/i, '').toLowerCase();
  if (!e) { if (required) errors.push(label + ' is needed.'); return ''; }
  if (!C.EMAIL_RE.test(e)) errors.push(label + ' "' + s(v) + '" doesn\'t look like an email address.');
  return e;
}
// Zoho requires street and city on a client, and the zip as well on a location. A new client gets a
// location from its address, so new clients need the zip too; an older client being edited does not.
function addressFields(b, errors, what, needZip) {
  const a = { address1: s(b.address1), address2: s(b.address2), city: s(b.city), state: C.cleanState(b.state), zip: s(b.zip), country: s(b.country) };
  if (!a.address1) errors.push(what + ': street is needed.');
  if (!a.city) errors.push(what + ': city is needed.');
  if (needZip && !a.zip) errors.push(what + ': zip code is needed.');
  return a;
}

function checkClient(b) {
  b = b || {};
  const errors = [];
  const company = s(b.company).replace(/\s+/g, ' ');
  if (!company) errors.push('Company name is needed.');
  const a = addressFields(b, errors, 'Address', !s(b.client_id));
  const phone = phoneField(b.phone, 'Phone', errors);
  const email = emailField(b.email, 'Email', errors, false);
  return { errors, value: { company, ...a, phone: phone.value, email, active: b.active !== false, notes: s(b.notes) } };
}
// Clean values -> Zoho fields (a full set, so clearing a field on the page clears it in Zoho).
function clientFields(v) {
  return { Client_Company_Name: v.company, Client_Address: zAddr(v), Client_Phone_Number: v.phone, Client_Email: v.email,
    Client_Status: v.active ? 'Active' : INACTIVE, Notes_Paste_Information: v.notes };
}
const zAddr = (v) => ({ address_line_1: v.address1, address_line_2: v.address2 || '', district_city: v.city || '',
  state_province: v.state || '', postal_code: v.zip || '', country: v.country || '' });

function checkLocation(b) {
  b = b || {};
  const errors = [];
  const a = addressFields(b, errors, 'Location address', true);
  const name = s(b.name) || a.city || 'Main';
  const phone = phoneField(b.phone, 'Location phone', errors);
  return { errors, value: { name, ...a, phone: phone.value } };
}
const locationFields = (v) => ({ Location_Name: v.name, Address: zAddr(v), Phone_Number: v.phone });

function checkRep(b) {
  b = b || {};
  const errors = [];
  const first = s(b.first), last = s(b.last);
  if (!first) errors.push('First name is needed.');
  const email = emailField(b.email, 'Email', errors, true);
  const phone = phoneField(b.phone, 'Phone', errors);
  const mobile = phoneField(b.mobile, 'Mobile', errors);
  const ext = s(b.ext) || phone.ext || '';
  if (ext && !/^\d{1,6}$/.test(ext)) errors.push('Extension should be digits only.');
  return { errors, value: { first, last, email, phone: phone.value, mobile: mobile.value, ext, location_id: s(b.location_id), notes: s(b.notes) } };
}
const repFields = (v) => ({ Name: { first_name: v.first, last_name: v.last }, Email: v.email, Phone_Number: v.phone, Mobile: v.mobile,
  Phone_Ext: v.ext, Client_Locations: v.location_id ? [v.location_id] : [], Contact_Information_Additional: v.notes });

// Another client of this shop with the same name in the same city (the import's duplicate rule).
function duplicateOf(clients, company, city, exceptId) {
  const nk = C.nameKey(company), ck = s(city).toLowerCase().replace(/[^a-z]/g, '');
  if (!nk) return null;
  return clients.find((c) => c.id !== exceptId && C.nameKey(c.company) === nk &&
    (!ck || !c.city || c.city.toLowerCase().replace(/[^a-z]/g, '') === ck)) || null;
}
const sameRepEmail = (reps, clientId, email, exceptId) =>
  reps.find((r) => r.client_id === clientId && r.id !== exceptId && r.email.toLowerCase() === s(email).toLowerCase()) || null;

module.exports = { isActive, showPhone, shapeClient, shapeLoc, shapeRep, shapeProject, checkClient, clientFields,
  checkLocation, locationFields, checkRep, repFields, duplicateOf, sameRepEmail, INACTIVE };
