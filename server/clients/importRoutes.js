// =============================================================================
//  clients/importRoutes.js — the client import page's server side (page: takeoff/public/clients-import.html).
// -----------------------------------------------------------------------------
//    POST /api/clients/import/read     { file:{name,b64} | text }  -> headers, rows, auto mapping,
//                                      AI-suggested mapping for headers the code does not know
//    POST /api/clients/import/preview  { headers, rows, mapping }  -> items (new / exists / fix)
//    POST /api/clients/import/commit   { items }                   -> creates clients, locations, contacts
//
//  Zoho forms (Mark, 2026-11-19):
//    MFG_Client_Form            (report API_Clients)          Manufacturer, Client_Company_Name, Client_Address ...
//    MFG_Client_Locations       (report API_Client_Locations) CLIENT, MANUFACTURE, Location_Name, Address
//    MFG_Client_Representatives (report API_Client_Reps)      CLIENT, MANUFACTURE, Client_Locations, Name, Email
//  No Zoho workflow creates a location or contact for a new client, so the import makes them.
//  PER SHOP: the shop comes from the tenant token (else manufacturer_id while tokens are in warn mode).
// =============================================================================
const axios = require('axios');
const C = require('./importCore');

const MAX_ROWS = 5000;
const BATCH = 200;
const enc = encodeURIComponent;
const s = (v) => (v == null ? '' : String(v)).trim();
const idOf = (v) => (v && typeof v === 'object' ? s(v.ID) : s(v));

function registerClientImport(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages } = deps;
  const hdr = async () => ({ headers: zohoHeaders(await getAccessToken()) });

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
  // The shop's clients (+ the city of their address) and contacts, for duplicate checks.
  async function existingOf(mfg) {
    const [cl, reps, locs] = await Promise.all([
      some('/report/API_Clients?criteria=' + enc('(Manufacturer == ' + mfg + ')')),
      some('/report/API_Client_Reps?criteria=' + enc('(MANUFACTURE == ' + mfg + ')')),
      some('/report/API_Client_Locations?criteria=' + enc('(MANUFACTURE == ' + mfg + ')')),
    ]);
    const firstLoc = {};
    for (const l of locs) { const c = idOf(l.CLIENT); if (c && !firstLoc[c]) firstLoc[c] = s(l.ID); }
    return {
      clients: cl.map((c) => ({ id: s(c.ID), company: s(c.Client_Company_Name), city: s(c.Client_Address && c.Client_Address.district_city) })),
      reps: reps.map((r) => ({ client_id: idOf(r.CLIENT), email: s(r.Email).toLowerCase() })),
      firstLoc,
    };
  }
  const bad = (res, msg, code) => res.status(code || 400).json({ ok: false, error: msg });
  const fail = (res, e) => {
    console.error('[clients-import]', e && e.response ? JSON.stringify(e.response.data).slice(0, 400) : (e && e.stack) || e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  };

  // ---------- read -------------------------------------------------------------------------------
  async function rowsOf(b) {
    if (b.text) return C.parseDelimited(String(b.text));
    const f = b.file || {};
    const name = s(f.name);
    const buf = Buffer.from(String(f.b64 || ''), 'base64');
    if (!buf.length) throw Object.assign(new Error('The file is empty.'), { user: true });
    if (/\.xls$/i.test(name)) throw Object.assign(new Error('This is an old Excel file (.xls). In Excel, use File > Save As > Excel Workbook (.xlsx) or CSV, then upload that.'), { user: true });
    if (/\.xlsx$/i.test(name)) {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      try { await wb.xlsx.load(buf); } catch (e) { throw Object.assign(new Error('This file could not be opened as an Excel workbook. Save it as .xlsx or .csv and try again.'), { user: true }); }
      // The sheet with the most rows (exports often have a title sheet).
      let best = null;
      wb.eachSheet((ws) => { if (!best || ws.rowCount > best.rowCount) best = ws; });
      const rows = [];
      if (best) best.eachRow({ includeEmpty: false }, (row) => {
        const cells = [];
        for (let i = 1; i <= row.cellCount; i++) {
          let v = row.getCell(i).value;
          if (v && typeof v === 'object') v = v.result != null ? v.result : (v.text != null ? v.text : (v.richText ? v.richText.map((r) => r.text).join('') : (v instanceof Date ? v.toISOString().slice(0, 10) : '')));
          cells.push(v == null ? '' : String(v).trim());
        }
        if (cells.some((c) => c !== '')) rows.push(cells);
      });
      return rows;
    }
    return C.parseDelimited(buf.toString('utf8'));
  }

  // The AI only SUGGESTS which of our fields an unknown column is; the admin confirms on the page.
  async function suggest(headers, rows, unknown, taken) {
    if (!unknown.length || !process.env.ANTHROPIC_API_KEY) return {};
    try {
      const _A = require('@anthropic-ai/sdk'); const Anthropic = _A.default || _A;
      const ai = new Anthropic();
      const free = C.FIELDS.filter((f) => !taken.includes(f.key));
      const cols = unknown.map((i) => ({ column: i, header: headers[i], examples: rows.slice(0, 5).map((r) => s(r[i]).slice(0, 60)).filter(Boolean) }));
      const tool = { name: 'map_columns', description: 'Say which field each column holds.',
        input_schema: { type: 'object', properties: { columns: { type: 'array', items: { type: 'object',
          properties: { column: { type: 'integer' }, field: { type: 'string', enum: free.map((f) => f.key).concat(['']) } }, required: ['column', 'field'] } } },
          required: ['columns'] } };
      const resp = await ai.messages.create({
        model: process.env.CLIENT_IMPORT_MODEL || 'claude-haiku-5-5', max_tokens: 1000,
        system: 'You map spreadsheet columns from a metal fabrication shop\'s customer list to fields. Use "" when a column fits no field or you are unsure; never force a match. Answer only by calling map_columns.',
        tools: [tool], tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: 'Fields:\n' + free.map((f) => f.key + ' = ' + f.label).join('\n') +
          '\n\nColumns (header and example values):\n' + JSON.stringify(cols) }],
      });
      const tu = resp.content.find((b) => b.type === 'tool_use');
      const out = {}, used = {};
      for (const c of (tu && tu.input && tu.input.columns) || []) {
        if (unknown.includes(c.column) && c.field && C.FIELD_KEYS.includes(c.field) && !taken.includes(c.field) && !used[c.field]) {
          out[c.column] = c.field; used[c.field] = 1;
        }
      }
      return out;
    } catch (e) { console.warn('[clients-import] suggest failed', e.message); return {}; }
  }

  app.post('/api/clients/import/read', async (req, res) => {
    const mfg = shopOf(req), b = req.body || {};
    if (!/^\d{6,25}$/.test(mfg)) return bad(res, 'Open this page from Material Compass.');
    try {
      const all = await rowsOf(b);
      if (!all.length) return bad(res, 'No rows found. Check that the file or pasted text has a header row and data.');
      const { headers, rows } = C.splitHeader(all);
      if (rows.length > MAX_ROWS) return bad(res, 'This list has ' + rows.length + ' rows. Import up to ' + MAX_ROWS + ' at a time; split the file and import each part.');
      const { mapping, unknown } = C.autoMap(headers);
      const sug = await suggest(headers, rows, unknown, mapping.filter(Boolean));
      res.json({ ok: true, headers, rows, mapping, suggested: sug, fields: C.FIELDS });
    } catch (e) { if (e.user) return bad(res, e.message); fail(res, e); }
  });

  app.post('/api/clients/import/preview', async (req, res) => {
    const mfg = shopOf(req), b = req.body || {};
    if (!/^\d{6,25}$/.test(mfg)) return bad(res, 'Open this page from Material Compass.');
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, MAX_ROWS) : [];
    const mapping = (Array.isArray(b.mapping) ? b.mapping : []).map((f) => (C.FIELD_KEYS.includes(f) ? f : ''));
    if (!mapping.includes('company')) return bad(res, 'Pick which column is the company name.');
    try {
      const ex = await existingOf(mfg);
      res.json({ ok: true, items: C.buildPreview(rows, mapping, ex) });
    } catch (e) { fail(res, e); }
  });

  // Zoho bulk insert -> [{ ok, id, error }] in the order sent.
  async function insertAll(form, records) {
    const out = [];
    for (let i = 0; i < records.length; i += BATCH) {
      const chunk = records.slice(i, i + BATCH);
      const r = await axios.post(creatorApiBase() + '/form/' + form, { data: chunk }, Object.assign(await hdr(), { validateStatus: () => true }));
      const d = r.data || {};
      const list = Array.isArray(d.result) ? d.result : (chunk.length === 1 ? [d] : null);
      if (!list) { chunk.forEach(() => out.push({ ok: false, error: d.message || 'Not saved' })); continue; }
      list.forEach((x) => out.push(x && x.code === 3000 && x.data && x.data.ID ? { ok: true, id: s(x.data.ID) }
        : { ok: false, error: x && (x.error ? (typeof x.error === 'string' ? x.error : Object.values(x.error).join('; ')) : x.message) || 'Not saved' }));
    }
    return out;
  }

  app.post('/api/clients/import/commit', async (req, res) => {
    const mfg = shopOf(req), b = req.body || {};
    if (!/^\d{6,25}$/.test(mfg)) return bad(res, 'Open this page from Material Compass.');
    const sent = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ROWS);
    if (!sent.length) return bad(res, 'Nothing selected to import.');
    try {
      const ex = await existingOf(mfg);
      const items = C.rematch(sent, ex);
      const today = C.zDate(new Date(new Date().toLocaleString('en-US', { timeZone: process.env.ZOHO_TZ || 'America/New_York' })));
      const result = items.map((it) => ({ key: it.key, company: it.client.company, client: '', contacts_added: 0, problems: [] }));

      // 1) new clients
      const toCreate = items.map((it, i) => ({ it, i })).filter((x) => x.it.status === 'new');
      const made = await insertAll('MFG_Client_Form', toCreate.map((x) => C.clientRecord(mfg, x.it.client, today)));
      const clientId = {};
      toCreate.forEach((x, n) => {
        if (made[n].ok) { clientId[x.i] = made[n].id; result[x.i].client = 'added'; }
        else { result[x.i].client = 'failed'; result[x.i].problems.push('Client not saved: ' + made[n].error); }
      });
      items.forEach((it, i) => {
        if (it.status === 'exists') { clientId[i] = it.existing_id; result[i].client = 'exists'; }
        if (it.status === 'fix') { result[i].client = 'skipped'; result[i].problems.push(...it.fix); }
      });

      // 2) a location for each new client, and for an existing one that has none but gets contacts
      const wantsContacts = (it) => it.contacts.some((k) => !k.exists && k.first && C.EMAIL_RE.test(k.email || ''));
      const locId = {};
      items.forEach((it, i) => { if (it.status === 'exists' && ex.firstLoc[it.existing_id]) locId[i] = ex.firstLoc[it.existing_id]; });
      const needLoc = items.map((it, i) => ({ it, i })).filter((x) => clientId[x.i] && !locId[x.i] && (x.it.status === 'new' || wantsContacts(x.it)));
      const locs = await insertAll('MFG_Client_Locations', needLoc.map((x) => C.locationRecord(mfg, clientId[x.i], x.it.client)));
      needLoc.forEach((x, n) => { if (locs[n].ok) locId[x.i] = locs[n].id; else result[x.i].problems.push('Location not saved: ' + locs[n].error); });

      // 3) contacts
      const reps = [];
      items.forEach((it, i) => {
        if (!clientId[i]) return;
        for (const k of it.contacts) {
          if (k.exists) continue;
          if (!k.first || !C.EMAIL_RE.test(k.email || '')) { result[i].problems.push('Contact ' + ((k.first + ' ' + (k.last || '')).trim() || '(no name)') + ' skipped: needs a first name and email'); continue; }
          if (!locId[i]) { result[i].problems.push('Contact ' + k.first + ' skipped: the client has no location'); continue; }
          reps.push({ i, k, rec: C.repRecord(mfg, clientId[i], locId[i], k, today) });
        }
      });
      const rr = await insertAll('MFG_Client_Representatives', reps.map((x) => x.rec));
      reps.forEach((x, n) => { if (rr[n].ok) result[x.i].contacts_added++; else result[x.i].problems.push('Contact ' + x.k.first + ' not saved: ' + rr[n].error); });

      const sum = {
        clients_added: result.filter((r) => r.client === 'added').length,
        already: result.filter((r) => r.client === 'exists').length,
        skipped: result.filter((r) => r.client === 'skipped').length,
        failed: result.filter((r) => r.client === 'failed').length,
        contacts_added: result.reduce((n, r) => n + r.contacts_added, 0),
      };
      res.json({ ok: true, summary: sum, results: result });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/clients/import/template.csv', (req, res) => {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="client-list-template.csv"');
    res.send(C.TEMPLATE_HEADERS.join(',') + '\r\n' +
      'Example Construction Inc.,12 Main St,Suite 4,Buffalo,NY,14221,716-555-1212,office@example.com,Jane,Doe,jane@example.com,716-555-1213,716-555-1214,Delete this example row\r\n');
  });
}

module.exports = { registerClientImport };
