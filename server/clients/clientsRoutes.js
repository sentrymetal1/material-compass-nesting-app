// =============================================================================
//  clients/clientsRoutes.js — the Clients page off Zoho (page: takeoff/public/clients.html).
// -----------------------------------------------------------------------------
//    GET  /api/clients                 -> the shop's clients (+ location and contact counts)
//    GET  /api/clients/detail?id=      -> one client: profile, locations, contacts, projects
//    POST /api/clients/save            { client_id?, company, address..., phone, email, active, notes,
//                                        contact?{first,last,email,phone,mobile} }   (add or edit)
//    POST /api/clients/location/save   { client_id, location_id?, name, address..., phone }
//    POST /api/clients/rep/save        { client_id, rep_id?, first, last, email, phone, mobile, ext, location_id, notes }
//
//  The records stay in Zoho: MFG_Client_Form (API_Clients), MFG_Client_Locations (API_Client_Locations),
//  MFG_Client_Representatives (API_Client_Reps). Projects: All_Projects, MFG_Client_Form lookup.
//  Nothing is deleted from here: projects and leads point at clients. "Not active" hides a client instead.
//  PER SHOP: the shop comes from the tenant token, and every write first checks the record is the shop's.
// =============================================================================
const axios = require('axios');
const C = require('./importCore');
const K = require('./clientsCore');

const enc = encodeURIComponent;
const s = (v) => (v == null ? '' : String(v)).trim();
const ID_RE = /^\d{6,25}$/;
const CACHE_MS = 30 * 1000;

function registerClients(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages } = deps;
  const hdr = async () => ({ headers: zohoHeaders(await getAccessToken()), validateStatus: () => true });

  function shopOf(req) {
    if (req.tenant && req.tenant.kind === 'm') return s(req.tenant.id);
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    return s((req.query && req.query.manufacturer_id) || b.manufacturer_id);
  }
  const some = (p) => fetchAllZohoPages(p).catch((e) => {
    const d = e.response && e.response.data;
    if (d && /9220|9280/.test(JSON.stringify(d))) return [];
    throw e;
  });
  const bad = (res, msg, extra) => res.status(400).json(Object.assign({ ok: false, error: msg }, extra || {}));
  const fail = (res, e) => {
    console.error('[clients]', e && e.response ? JSON.stringify(e.response.data).slice(0, 400) : (e && e.stack) || e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  };

  // The shop's clients, locations and contacts: 3 reads, kept 30 s and dropped on every write.
  const cache = new Map();
  async function bookOf(mfg, fresh) {
    const hit = cache.get(mfg);
    if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit;
    const cl = await some('/report/API_Clients?criteria=' + enc('(Manufacturer == ' + mfg + ')'));
    const lo = await some('/report/API_Client_Locations?criteria=' + enc('(MANUFACTURE == ' + mfg + ')'));
    const rp = await some('/report/API_Client_Reps?criteria=' + enc('(MANUFACTURE == ' + mfg + ')'));
    const book = { at: Date.now(), clients: cl.map(K.shapeClient), locs: lo.map(K.shapeLoc), reps: rp.map(K.shapeRep) };
    cache.set(mfg, book);
    return book;
  }

  // Zoho answers -> { ok, id } | { ok:false, error }
  const zres = (r) => {
    const d = r.data || {};
    if (d.code === 3000) return { ok: true, id: s(d.data && d.data.ID) };
    const e = d.error ? (typeof d.error === 'string' ? d.error : Object.entries(d.error).map(([k, v]) => k.replace(/_/g, ' ') + ': ' + v).join('; ')) : d.message;
    return { ok: false, error: e || 'Not saved' };
  };
  const insert = async (form, data) => zres(await axios.post(creatorApiBase() + '/form/' + form, { data }, await hdr()));
  const patch = async (report, id, data) => zres(await axios.patch(creatorApiBase() + '/report/' + report + '/' + id, { data }, await hdr()));
  const today = () => C.zDate(new Date(new Date().toLocaleString('en-US', { timeZone: process.env.ZOHO_TZ || 'America/New_York' })));
  const notSaved = (res, what, r) => { console.warn('[clients] ' + what + ' not saved:', r.error); bad(res, what + ' was not saved: ' + r.error); };

  // ---------- read ------------------------------------------------------------------------------
  app.get('/api/clients', async (req, res) => {
    const mfg = shopOf(req);
    if (!ID_RE.test(mfg)) return bad(res, 'Open this page from Material Compass.');
    try {
      const b = await bookOf(mfg, !!req.query.fresh);
      const nLoc = {}, nRep = {};
      b.locs.forEach((l) => { nLoc[l.client_id] = (nLoc[l.client_id] || 0) + 1; });
      b.reps.forEach((r) => { nRep[r.client_id] = (nRep[r.client_id] || 0) + 1; });
      const clients = b.clients.map((c) => ({ id: c.id, company: c.company, city: c.city, state: c.state, phone: c.phone, email: c.email,
        active: c.active, locations: nLoc[c.id] || 0, contacts: nRep[c.id] || 0 }))
        .sort((x, y) => x.company.localeCompare(y.company, 'en', { sensitivity: 'base' }));
      res.json({ ok: true, clients });
    } catch (e) { fail(res, e); }
  });

  const projCache = new Map();
  async function projectsOf(mfg, cid) {
    const k = mfg + '|' + cid, hit = projCache.get(k);
    if (hit && Date.now() - hit.at < 60 * 1000) return hit.list;
    const rows = await some('/report/All_Projects?criteria=' + enc('(MANUFACTURE == ' + mfg + ' && MFG_Client_Form == ' + cid + ')'));
    const list = rows.map(K.shapeProject).sort((a, b) => Number(b.id) - Number(a.id));
    projCache.set(k, { at: Date.now(), list });
    return list;
  }

  app.get('/api/clients/detail', async (req, res) => {
    const mfg = shopOf(req), id = s(req.query.id);
    if (!ID_RE.test(mfg)) return bad(res, 'Open this page from Material Compass.');
    try {
      const b = await bookOf(mfg, !!req.query.fresh);
      const client = b.clients.find((c) => c.id === id);
      if (!client) return bad(res, 'That client is not in your list.');
      let projects = null;
      try { projects = await projectsOf(mfg, id); } catch (e) { console.warn('[clients] projects read failed', e.message); }
      res.json({ ok: true, client, locations: b.locs.filter((l) => l.client_id === id), contacts: b.reps.filter((r) => r.client_id === id), projects });
    } catch (e) { fail(res, e); }
  });

  // ---------- write -----------------------------------------------------------------------------
  app.post('/api/clients/save', async (req, res) => {
    const mfg = shopOf(req), body = req.body || {};
    if (!ID_RE.test(mfg)) return bad(res, 'Open this page from Material Compass.');
    const id = s(body.client_id);
    const { errors, value } = K.checkClient(body);
    let contact = null;
    const ct = body.contact || {};
    if (!id && (s(ct.first) || s(ct.last) || s(ct.email))) {
      const r = K.checkRep(ct);
      errors.push(...r.errors.map((e) => 'Contact: ' + e));
      contact = r.value;
    }
    if (errors.length) return bad(res, 'Please fix:', { reasons: errors });
    try {
      const b = await bookOf(mfg, true);
      if (id && !b.clients.some((c) => c.id === id)) return bad(res, 'That client is not in your list.');
      const dup = K.duplicateOf(b.clients, value.company, value.city, id);
      if (dup) return bad(res, dup.company + (dup.city ? ' in ' + dup.city : '') + ' is already in your client list.', { duplicate_id: dup.id });

      if (id) {
        const r = await patch('API_Clients', id, K.clientFields(value));
        cache.delete(mfg);
        if (!r.ok) return notSaved(res, 'The client', r);
        return res.json({ ok: true, id, message: 'Saved.' });
      }

      // New client, its first location (named after the city, like the import), and the optional contact.
      const made = await insert('MFG_Client_Form', Object.assign({ Manufacturer: mfg, Manufacture_ID: mfg, Date_Account_Created: today() }, K.clientFields(value)));
      if (!made.ok) { cache.delete(mfg); return notSaved(res, 'The client', made); }
      const problems = [];
      const loc = await insert('MFG_Client_Locations', Object.assign({ CLIENT: made.id, MANUFACTURE: mfg },
        K.locationFields({ name: value.city || 'Main', ...value })));
      if (!loc.ok) problems.push('Its location was not saved (' + loc.error + '). Add it on the Locations tab.');
      if (contact && loc.ok) {
        contact.location_id = loc.id;
        const rep = await insert('MFG_Client_Representatives', Object.assign({ MANUFACTURE: mfg, CLIENT: made.id, Client_Representative_Created: today() }, K.repFields(contact)));
        if (!rep.ok) problems.push('The contact was not saved (' + rep.error + '). Add them on the Contacts tab.');
      } else if (contact) problems.push('The contact was not saved because the client has no location yet.');
      cache.delete(mfg);
      res.json({ ok: true, id: made.id, message: value.company + ' added.', problems });
    } catch (e) { cache.delete(mfg); fail(res, e); }
  });

  app.post('/api/clients/location/save', async (req, res) => {
    const mfg = shopOf(req), body = req.body || {};
    if (!ID_RE.test(mfg)) return bad(res, 'Open this page from Material Compass.');
    const cid = s(body.client_id), lid = s(body.location_id);
    const { errors, value } = K.checkLocation(body);
    if (errors.length) return bad(res, 'Please fix:', { reasons: errors });
    try {
      const b = await bookOf(mfg, true);
      if (!b.clients.some((c) => c.id === cid)) return bad(res, 'That client is not in your list.');
      if (lid && !b.locs.some((l) => l.id === lid && l.client_id === cid)) return bad(res, 'That location is not on this client.');
      const r = lid ? await patch('API_Client_Locations', lid, K.locationFields(value))
        : await insert('MFG_Client_Locations', Object.assign({ CLIENT: cid, MANUFACTURE: mfg }, K.locationFields(value)));
      cache.delete(mfg);
      if (!r.ok) return notSaved(res, 'The location', r);
      res.json({ ok: true, id: lid || r.id, message: 'Saved.' });
    } catch (e) { cache.delete(mfg); fail(res, e); }
  });

  app.post('/api/clients/rep/save', async (req, res) => {
    const mfg = shopOf(req), body = req.body || {};
    if (!ID_RE.test(mfg)) return bad(res, 'Open this page from Material Compass.');
    const cid = s(body.client_id), rid = s(body.rep_id);
    const { errors, value } = K.checkRep(body);
    if (errors.length) return bad(res, 'Please fix:', { reasons: errors });
    try {
      const b = await bookOf(mfg, true);
      if (!b.clients.some((c) => c.id === cid)) return bad(res, 'That client is not in your list.');
      if (rid && !b.reps.some((r) => r.id === rid && r.client_id === cid)) return bad(res, 'That contact is not on this client.');
      const locs = b.locs.filter((l) => l.client_id === cid);
      if (value.location_id && !locs.some((l) => l.id === value.location_id)) return bad(res, 'Pick one of this client\'s locations.');
      if (!value.location_id) {
        if (!locs.length) return bad(res, 'Add a location for this client first (Locations tab), then add the contact.');
        value.location_id = locs[0].id;
      }
      const same = K.sameRepEmail(b.reps, cid, value.email, rid);
      if (same) return bad(res, same.name + ' already has ' + value.email + ' on this client.');
      const r = rid ? await patch('API_Client_Reps', rid, K.repFields(value))
        : await insert('MFG_Client_Representatives', Object.assign({ MANUFACTURE: mfg, CLIENT: cid, Client_Representative_Created: today() }, K.repFields(value)));
      cache.delete(mfg);
      if (!r.ok) return notSaved(res, 'The contact', r);
      res.json({ ok: true, id: rid || r.id, message: 'Saved.' });
    } catch (e) { cache.delete(mfg); fail(res, e); }
  });
}

module.exports = { registerClients };
