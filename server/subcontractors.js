// =============================================================================
//  subcontractors.js — one shop's subcontractors and item suppliers (off-Zoho page, phase 1).
// -----------------------------------------------------------------------------
//  Plan: docs/SUBCONTRACTORS_PAGE_PLAN.md (Mark approved 2026-11-15). The page edits the existing
//  Zoho records; nothing is stored here.
//
//    Subcontractor_and_Item_Suppliers_Form  (report API_Subcontractors, unfiltered)
//      Supplier (company name), Manufacture (shop), Item_Types (multi lookup to the 37 Item Types),
//      Active, Preferred, Company_Phone, Company_Email, Website {value,url}, Notes, Address.
//    Subcontractors_and_Item_Representatives (report API_Subcontractor_Reps, unfiltered)
//      Subcontractor_and_Item_Suppliers_Form (parent), Supplier_Representative {first_name,last_name},
//      Phone_Number1, Cell_Number, Email, Primary_Contact.
//
//  PER SHOP. The shop comes from the tenant token (else manufacturer_id while tokens are in warn
//  mode); every read is filtered to it and every write re-checks that the record belongs to it.
//
//  Price history: priced project rows (report API_Project_Outsource_Rows) whose
//  Subcontractor_Supplier is one of this shop's records. If that report does not exist yet the
//  page says so instead of showing nothing.
// =============================================================================
const axios = require('axios');

const SUB_REPORT = 'API_Subcontractors';
const REP_REPORT = 'API_Subcontractor_Reps';
const ROW_REPORT = 'API_Project_Outsource_Rows';
const TYPE_REPORT = 'Project_Items_and_Subcontracting_List_Report';
const SUB_FORM = 'Subcontractor_and_Item_Suppliers_Form';
const REP_FORM = 'Subcontractors_and_Item_Representatives';

const enc = encodeURIComponent;
const s = (v) => (v == null ? '' : String(v)).trim();
const idOf = (v) => (v && typeof v === 'object' ? s(v.ID) : s(v));
const isTrue = (v) => v === true || /^(true|yes|1)$/i.test(String(v));
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const nameKey = (v) => s(v).toLowerCase().replace(/[^a-z0-9]+/g, '');

// 7165551212 / (716) 555-1212 / 1-716-555-1212 -> +17165551212. Anything else is kept as typed.
function phone(v) {
  const t = s(v);
  if (!t) return '';
  const d = t.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
  return t.charAt(0) === '+' ? '+' + d : t;
}
function website(v) {
  const t = s(v);
  return t ? { value: t, url: /^https?:\/\//i.test(t) ? t : 'https://' + t } : { value: '', url: '' };
}
const flatUrl = (w) => (w && typeof w === 'object' ? s(w.url || w.value) : s(w));

function shopOf(req) {
  if (req.tenant && req.tenant.kind === 'm') return s(req.tenant.id);
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  return s((req.query && req.query.manufacturer_id) || b.manufacturer_id);
}

function subOut(r) {
  const a = r.Address || {};
  return {
    id: s(r.ID), name: s(r.Supplier),
    item_types: (Array.isArray(r.Item_Types) ? r.Item_Types : []).map(idOf).filter(Boolean),
    active: isTrue(r.Active), preferred: isTrue(r.Preferred),
    phone: s(r.Company_Phone), email: s(r.Company_Email), website: flatUrl(r.Website), notes: s(r.Notes),
    address: { line1: s(a.address_line_1), line2: s(a.address_line_2), city: s(a.district_city),
      state: s(a.state_province), zip: s(a.postal_code), country: s(a.country),
      lat: num(a.latitude) || null, lng: num(a.longitude) || null },
    reps: [],
  };
}
function repOut(r) {
  const n = r.Supplier_Representative || {};
  return { id: s(r.ID), first: s(n.first_name), last: s(n.last_name), phone: s(r.Phone_Number1),
    cell: s(r.Cell_Number), email: s(r.Email), primary: isTrue(r.Primary_Contact) };
}

function registerSubcontractors(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages, cachedLookup } = deps;
  const H = async () => ({ headers: { ...zohoHeaders(await getAccessToken()), 'Content-Type': 'application/json' } });
  const check = (r, what) => {
    const b = r && r.data ? r.data : {};
    if (b.code !== 3000) throw new Error(what + ' was refused (code ' + b.code + '): ' + (b.message || JSON.stringify(b).slice(0, 200)));
    return b;
  };

  const types = () => cachedLookup('subc-types', 10 * 60 * 1000, async () =>
    (await fetchAllZohoPages('/report/' + TYPE_REPORT)).map((t) => ({
      id: s(t.ID), code: s(t.Code), name: s(t.Item_Type), bucket: s(t.Category_of_Item) || 'Miscellaneous', unit: s(t.Default_Unit),
    })));

  async function shopSubs(shop) {
    const subs = (await fetchAllZohoPages('/report/' + SUB_REPORT + '?criteria=' + enc('(Manufacture == ' + shop + ')'))).map(subOut);
    const byId = {};
    subs.forEach((x) => { byId[x.id] = x; });
    // Reps: the table is small and dot-walk criteria are unreliable, so read it whole and keep ours.
    const reps = await fetchAllZohoPages('/report/' + REP_REPORT);
    reps.forEach((r) => { const p = byId[idOf(r.Subcontractor_and_Item_Suppliers_Form)]; if (p) p.reps.push(repOut(r)); });
    return { subs, byId };
  }

  // MCP number per project id, for this shop (the row's project lookup only carries the record id).
  const projNumbers = (shop) => cachedLookup('subc-proj-' + shop, 10 * 60 * 1000, async () => {
    const m = {};
    (await fetchAllZohoPages('/report/All_Projects?criteria=' + enc('(MANUFACTURE == ' + shop + ')'))).forEach((p) => { m[s(p.ID)] = s(p.Project_Quote_Number); });
    return m;
  });

  // { available, by_sub: { subId: { typeId: { jobs, total, last{unit,qty,total,date,project}, avg_unit } } }, used: { subId: rows } }
  // Rows are priced per lb, per sq ft, per load or as one lump sum, and nothing on the row says which.
  // So the LAST price is shown as qty x unit = total, and an average only when the unit prices are
  // alike (within 3x of each other); a mix of $0.60/lb and $4,125 lots has no meaningful average.
  async function history(byId, shop) {
    let rows;
    try { rows = await fetchAllZohoPages('/report/' + ROW_REPORT); }
    catch (e) { return { available: false, reason: 'Price history needs the report ' + ROW_REPORT + '.' }; }
    let numbers = {};
    try { numbers = await projNumbers(shop); } catch (e) {}
    const acc = {}, used = {};
    for (const r of rows) {
      const sid = idOf(r.Subcontractor_Supplier);
      if (!byId[sid]) continue;
      used[sid] = (used[sid] || 0) + 1;
      const tot = num(r.Total_Amount);
      if (!(tot > 0)) continue;
      const qty = num(r.QTY), unit = num(r.Unit_Amt) || (qty ? tot / qty : 0);
      const d = new Date(s(r.Date_field).replace(/,(d)/, ', $1'));
      const pid = idOf(r.MCP_Customer_Project_Form);
      const tid = idOf(r.Item_Type) || 'none';
      ((acc[sid] = acc[sid] || {})[tid] = acc[sid][tid] || []).push({ t: isNaN(d.getTime()) ? 0 : d.getTime(), unit, qty, tot, project: numbers[pid] || '' });
    }
    const out = {};
    for (const sid of Object.keys(acc)) for (const tid of Object.keys(acc[sid])) {
      const L = acc[sid][tid].sort((a, b) => b.t - a.t), last = L[0];
      const units = L.map((x) => x.unit).filter((u) => u > 0);
      const lo = Math.min(...units), hi = Math.max(...units);
      (out[sid] = out[sid] || {})[tid] = {
        jobs: L.length, total: r2(L.reduce((a, x) => a + x.tot, 0)),
        last: { unit: r2(last.unit), qty: last.qty, total: r2(last.tot), date: last.t ? new Date(last.t).toISOString().slice(0, 10) : null, project: last.project },
        avg_unit: units.length > 1 && lo > 0 && hi / lo <= 3 ? r2(units.reduce((a, u) => a + u, 0) / units.length) : null,
      };
    }
    return { available: true, by_sub: out, used };
  }

  app.get('/api/subcontractors', async (req, res) => {
    try {
      const shop = shopOf(req);
      if (!/^\d+$/.test(shop)) return res.status(400).json({ ok: false, error: 'Please reopen this page from Material Compass.' });
      const [t, { subs, byId }] = await Promise.all([types(), shopSubs(shop)]);
      const hist = await history(byId, shop);
      res.json({ ok: true, types: t, subs, history: hist });
    } catch (e) {
      console.error('[subcontractors] load', e.message);
      res.status(502).json({ ok: false, error: 'Subcontractors could not be loaded. Please try again.' });
    }
  });

  // body: { sub: {id?, name, item_types[], active, preferred, phone, email, website, notes, address{}}, reps: [{id?, first, last, phone, cell, email, primary, remove}] }
  app.post('/api/subcontractors/save', async (req, res) => {
    try {
      const shop = shopOf(req);
      if (!/^\d+$/.test(shop)) return res.status(400).json({ ok: false, error: 'Please reopen this page from Material Compass.' });
      const b = req.body || {}, sub = b.sub || {}, reps = Array.isArray(b.reps) ? b.reps : [];
      const name = s(sub.name);
      if (!name) return res.status(400).json({ ok: false, error: 'Company name is required.' });
      const tids = (Array.isArray(sub.item_types) ? sub.item_types : []).map(s).filter((x) => /^\d+$/.test(x));
      if (!tids.length) return res.status(400).json({ ok: false, error: 'Pick at least one type of work.' });
      const known = new Set((await types()).map((t) => t.id));
      if (tids.some((x) => !known.has(x))) return res.status(400).json({ ok: false, error: 'An unknown type of work was picked. Reload the page.' });

      const { byId, subs } = await shopSubs(shop);
      const id = s(sub.id);
      if (id && !byId[id]) return res.status(404).json({ ok: false, error: 'That subcontractor is not on your list.' });
      const dup = subs.find((x) => x.id !== id && nameKey(x.name) === nameKey(name));
      if (dup) return res.status(409).json({ ok: false, error: '"' + dup.name + '" is already on your list.' + (dup.active ? '' : ' It is inactive; turn it back on instead.') });

      const a = sub.address || {};
      const data = {
        Supplier: name, Manufacture: shop, Item_Types: tids,
        Active: sub.active !== false, Preferred: !!sub.preferred,
        Company_Phone: phone(sub.phone), Company_Email: s(sub.email), Website: website(sub.website), Notes: s(sub.notes),
        Address: { address_line_1: s(a.line1), address_line_2: s(a.line2), district_city: s(a.city),
          state_province: s(a.state), postal_code: s(a.zip), country: s(a.country) },
      };
      const base = creatorApiBase(), h = await H();
      let subId = id;
      if (id) check(await axios.patch(base + '/report/' + SUB_REPORT + '/' + id, { data }, h), 'The subcontractor update');
      else subId = s(check(await axios.post(base + '/form/' + SUB_FORM, { data }, h), 'The new subcontractor').data.ID);

      // Reps: only ones that belong to THIS subcontractor can be changed or removed.
      const mine = new Set(((byId[id] && byId[id].reps) || []).map((r) => r.id));
      const problems = [];
      for (const r of reps) {
        const rid = s(r.id);
        if (rid && !mine.has(rid)) { problems.push('a contact that is not on this company was skipped'); continue; }
        if (r.remove) {
          if (rid) check(await axios.delete(base + '/report/' + REP_REPORT + '/' + rid, h), 'Removing ' + s(r.first) + ' ' + s(r.last));
          continue;
        }
        if (!s(r.first) && !s(r.last) && !s(r.email)) continue;
        const rd = { Subcontractor_and_Item_Suppliers_Form: subId,
          Supplier_Representative: { first_name: s(r.first), last_name: s(r.last) },
          Phone_Number1: phone(r.phone), Cell_Number: phone(r.cell), Email: s(r.email), Primary_Contact: !!r.primary };
        try {
          if (rid) check(await axios.patch(base + '/report/' + REP_REPORT + '/' + rid, { data: rd }, h), 'Contact ' + s(r.first));
          else check(await axios.post(base + '/form/' + REP_FORM, { data: rd }, h), 'Contact ' + s(r.first));
        } catch (e) { problems.push(e.message); }
      }
      res.json({ ok: true, id: subId, problems });
    } catch (e) {
      console.error('[subcontractors] save', e.response ? JSON.stringify(e.response.data) : e.message);
      const msg = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      res.status(502).json({ ok: false, error: 'The save did not go through: ' + msg });
    }
  });

  // Delete only if no project row uses it; otherwise it is made inactive (kept for the old projects).
  app.post('/api/subcontractors/delete', async (req, res) => {
    try {
      const shop = shopOf(req);
      if (!/^\d+$/.test(shop)) return res.status(400).json({ ok: false, error: 'Please reopen this page from Material Compass.' });
      const id = s((req.body || {}).id);
      const { byId } = await shopSubs(shop);
      if (!byId[id]) return res.status(404).json({ ok: false, error: 'That subcontractor is not on your list.' });
      const hist = await history(byId, shop);
      if (!hist.available) return res.status(409).json({ ok: false, error: 'Can\'t check whether projects use this company yet. Make it inactive instead.' });
      const base = creatorApiBase(), h = await H();
      if (hist.used[id]) {
        check(await axios.patch(base + '/report/' + SUB_REPORT + '/' + id, { data: { Active: false } }, h), 'Making it inactive');
        return res.json({ ok: true, deactivated: true, used_on: hist.used[id] });
      }
      for (const r of byId[id].reps) check(await axios.delete(base + '/report/' + REP_REPORT + '/' + r.id, h), 'Removing a contact');
      check(await axios.delete(base + '/report/' + SUB_REPORT + '/' + id, h), 'The delete');
      res.json({ ok: true, deleted: true });
    } catch (e) {
      console.error('[subcontractors] delete', e.response ? JSON.stringify(e.response.data) : e.message);
      res.status(502).json({ ok: false, error: 'The delete did not go through. Please try again.' });
    }
  });
}

module.exports = { registerSubcontractors, phone, website, nameKey };
