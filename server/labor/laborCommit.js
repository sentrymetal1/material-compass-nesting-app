// =============================================================================
//  labor/laborCommit.js — the take-off's labour onto the project, on approve.
// -----------------------------------------------------------------------------
//  One Project_Labor_Details_Form record per component, JOB hours in the 8
//  buckets (the project divides by Component.Quantity for per-unit cost —
//  reference_component_quantity_convention).
//
//  PROBED 2026-09-30 on Viking's Melody Fair Expansion: an API insert stores
//  hours and rates but leaves every _Amt, Total_Hours and Total_Amount BLANK —
//  the form computes them in user-input Deluge, which the API never runs. So
//  this writes them itself. Without that, labour lands on the project looking
//  free rather than missing.
//
//  RATES come from the shop's Manufacture_Labor_Rates row marked Default (else
//  the first "Standard", else the first). The report only returns the columns it
//  is configured with; a bucket whose rate it does not show gets the average of
//  the rates it does, and the response names those buckets so the report can
//  be fixed — a named stand-in, never a silent $0.
//
//  RE-APPROVE replaces what the take-off wrote last time (ids the page kept),
//  and only those: the new rows go in FIRST and the old ones are deleted after,
//  so a failed write never leaves the project with less labour than before.
//  Rows entered by hand are never touched.
// =============================================================================
const axios = require('axios');
const { BUCKETS } = require('./standards');

const STEM = (b) => b.replace(/_Hrs$/, '');          // Cutting_Hrs -> Cutting
const r2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

// rows from All_Manufacture_Labor_Rates -> { rates: {Cutting: 90, ...}, row, estimated: [stems] }
function pickRates(rows) {
  const list = rows || [];
  const isTrue = (v) => v === true || /^(true|yes|1)$/i.test(String(v));
  const row = list.find((r) => isTrue(r.Default)) || list.find((r) => /standard/i.test(String(r.Type_Of_Rate || ''))) || list[0];
  if (!row) return { rates: null, row: null, estimated: [] };
  const rates = {}, seen = [];
  for (const b of BUCKETS) { const v = num(row[STEM(b) + '_Rate']); if (v != null) { rates[STEM(b)] = v; seen.push(v); } }
  if (!seen.length) return { rates: null, row, estimated: [] };
  const avg = r2(seen.reduce((a, v) => a + v, 0) / seen.length);
  const estimated = [];
  for (const b of BUCKETS) if (rates[STEM(b)] == null) { rates[STEM(b)] = avg; estimated.push(STEM(b)); }
  return { rates, row, estimated };
}

// One component -> the record. hours: { Cutting_Hrs: n, ... } JOB hours.
function buildRecord(projectId, componentId, hours, rates) {
  const data = {
    Project_LU: String(projectId), MCP_Customer_Project_Form: String(projectId), Project_Bi_Directional_Lookup: String(projectId),
    Component: String(componentId), Component_ID: String(componentId),
  };
  let totH = 0, totA = 0;
  for (const b of BUCKETS) {
    const h = r2(Number(hours && hours[b]) || 0), rate = (rates && rates[STEM(b)]) || 0, amt = r2(h * rate);
    data[b] = h; data[STEM(b) + '_Rate'] = rate; data[STEM(b) + '_Amt'] = amt;
    totH += h; totA += amt;
  }
  data.Total_Hours = r2(totH); data.Total_Amount = r2(totA);
  return data;
}

// The shop's Labor_Types chips (Customer_Entry_Form) -> buckets. A bucket whose type the shop does
// not perform is HIDDEN on the project's labour subform — Viking has no "Assemble", so 26 hrs of
// Assy_Hrs landed in a column nobody could see while still counting in the totals (2026-09-30).
// Those hours move to the nearest type the shop does perform, and the move is reported.
const TYPE_OF = { Cutting_Hrs: 'Cut', CNC_Hrs: 'CNC', Assy_Hrs: 'Assemble', Fab_Hrs: 'Fabricate',
  Weld_Hrs: 'Weld', Labor_Hrs: 'Labor', Inspection_Hrs: 'Inspect', Misc_Hrs: 'Other' };
const FOLD_ORDER = ['Fab_Hrs', 'Assy_Hrs', 'Weld_Hrs', 'Cutting_Hrs', 'Labor_Hrs', 'Misc_Hrs', 'CNC_Hrs', 'Inspection_Hrs'];
// hours: {bucket: n}; types: ['Cut', ...] or empty (unknown → nothing moves). -> { hours, moved: [{from,to,hours}] }
function foldToShopTypes(hours, types) {
  const does = new Set((types || []).map(String));
  if (!does.size) return { hours, moved: [] };
  const out = Object.assign({}, hours), moved = [];
  const target = FOLD_ORDER.find((b) => does.has(TYPE_OF[b]));
  if (!target) return { hours, moved: [] };
  for (const b of BUCKETS) {
    if (does.has(TYPE_OF[b]) || !(out[b] > 0)) continue;
    const to = b === 'CNC_Hrs' && does.has('Cut') ? 'Cutting_Hrs' : target;
    out[to] += out[b]; moved.push({ from: TYPE_OF[b], to: TYPE_OF[to], hours: r2(out[b]) }); out[b] = 0;
  }
  return { hours: out, moved };
}

// ── THE PROJECT'S LABOUR TOTALS ROW ─────────────────────────────────────────────────────────
// The project header (LABOR AMT / LABOR HRS) and the Labor Totals bar read ONE
// Project_Quote_Labor_Totals record per project. Entering labour in the form builds it; an API
// insert never does — Gamma Lube got its labour rows and a blank header (2026-09-30), while
// Melody Fair, keyed by hand, has the record. So the commit rebuilds it from EVERY labour row on
// the project (hand-entered included), and the header always equals the Labor tab.
// Field names read from Melody Fair's record: Cut_ (not Cutting_), then CNC/Assy/Fab/Weld/Labor/
// Inspection/Misc, each _Total_Hrs and _Total_Amt, plus Total_Hrs / Total_Amt.
const TOTAL_STEM = (b) => (b === 'Cutting_Hrs' ? 'Cut' : STEM(b));
function projectTotals(laborRows) {
  const t = { Total_Hrs: 0, Total_Amt: 0 };
  for (const b of BUCKETS) { t[TOTAL_STEM(b) + '_Total_Hrs'] = 0; t[TOTAL_STEM(b) + '_Total_Amt'] = 0; }
  for (const r of laborRows || []) {
    for (const b of BUCKETS) {
      const h = Number(r[b]) || 0, a = Number(r[STEM(b) + '_Amt']) || 0;
      t[TOTAL_STEM(b) + '_Total_Hrs'] += h; t[TOTAL_STEM(b) + '_Total_Amt'] += a;
      t.Total_Hrs += h; t.Total_Amt += a;
    }
  }
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  return t;
}

// Sum a labour card component's items into buckets.
function bucketHours(items) {
  const out = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const i of items || []) if (out[i.bucket] != null) out[i.bucket] += Number(i.hours) || 0;
  return out;
}

function registerLaborCommit(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages } = deps;
  const crit = (s) => encodeURIComponent(s);

  // Zoho refuses with HTTP 200 and a code in the body — check it, always (see fittingsCommit.js).
  async function insert(base, token, data) {
    const r = await axios.post(base + '/form/Project_Labor_Details_Form', { data }, { headers: zohoHeaders(token) });
    const body = r.data || {};
    if (body.code !== 3000) {
      const why = [].concat(body.error || [], body.message || []).filter(Boolean).join('; ') || JSON.stringify(body).slice(0, 200);
      throw new Error('Zoho refused the labor row (code ' + body.code + '): ' + why);
    }
    const rec = Array.isArray(body.data) ? (body.data[0] || {}) : (body.data || {});
    return String(rec.ID || '');
  }

  // One totals row per project: update it if it exists, create it if not. Returns the sums written.
  async function upsertTotals(base, token, projectId, mfg) {
    const [rows, existing] = await Promise.all([
      fetchAllZohoPages('/report/All_Project_Labor_Details?criteria=' + crit('(Project_LU==' + projectId + ')')),
      fetchAllZohoPages('/report/Project_Quote_Labor_Totals_Report?criteria=' + crit('(Project_ID_Number==' + projectId + ')')),
    ]);
    // Project_Bi_Directional_Lookup is what puts an externally written row into the project form's
    // subform (the Labor Totals bar) — not visible in the report, accepted on PATCH 2026-09-30.
    const data = Object.assign(projectTotals(rows), {
      Project_ID_Number: String(projectId), MCP_Customer_Project_Form: String(projectId),
      Project_Bi_Directional_Lookup: String(projectId), Customer_Entry_Form: String(mfg) });
    const check = (r) => {
      const body = r.data || {};
      if (body.code !== 3000) throw new Error('Zoho refused the labor totals (code ' + body.code + '): ' + (body.message || JSON.stringify(body).slice(0, 200)));
      return body;
    };
    if (existing && existing[0]) {
      check(await axios.patch(base + '/report/Project_Quote_Labor_Totals_Report/' + existing[0].ID, { data }, { headers: zohoHeaders(token) }));
      return { ok: true, id: String(existing[0].ID), created: false, Total_Hrs: data.Total_Hrs, Total_Amt: data.Total_Amt };
    }
    const body = check(await axios.post(base + '/form/Project_Quote_Labor_Totals', { data }, { headers: zohoHeaders(token) }));
    const rec = Array.isArray(body.data) ? (body.data[0] || {}) : (body.data || {});
    return { ok: true, id: String(rec.ID || ''), created: true, Total_Hrs: data.Total_Hrs, Total_Amt: data.Total_Amt };
  }

  // body: { project_id, manufacturer_id, components: [{ name, items:[{bucket,hours}] }], prior_ids: [] }
  app.post('/api/takeoff/commit-labor', async (req, res) => {
    try {
      const b = req.body || {};
      const projectId = String(b.project_id || '').trim();
      const mfg = String((req.tenant && req.tenant.kind === 'm' && req.tenant.id) || b.manufacturer_id || '').trim();
      if (!/^\d{6,25}$/.test(projectId)) return res.status(400).json({ ok: false, error: 'project_id required' });
      if (!/^\d{6,25}$/.test(mfg)) return res.status(400).json({ ok: false, error: 'manufacturer_id required for labor rates' });
      const comps = (Array.isArray(b.components) ? b.components : []).filter((c) => c && c.name);

      const [shopRows, rateRows, compRows, laborRows] = await Promise.all([
        // Labor_Types only arrive if Customer_Entry_Report shows that column; missing = no fold.
        fetchAllZohoPages('/report/Customer_Entry_Report?criteria=' + crit('(ID==' + mfg + ')')).catch(() => []),
        fetchAllZohoPages('/report/All_Manufacture_Labor_Rates?criteria=' + crit('(Manufacture==' + mfg + ')')),
        fetchAllZohoPages('/report/All_Project_Components?criteria=' + crit('(MCP_Customer_Project_Form==' + projectId + ')')),
        (b.prior_ids || []).length ? fetchAllZohoPages('/report/All_Project_Labor_Details?criteria=' + crit('(Project_LU==' + projectId + ')')) : Promise.resolve([]),
      ]);
      const { rates, estimated } = pickRates(rateRows);
      const lt = shopRows && shopRows[0] && shopRows[0].Labor_Types;
      const shopTypes = Array.isArray(lt) ? lt.map(String) : (lt ? String(lt).split(',').map((s) => s.trim()).filter(Boolean) : []);
      if (!rates) return res.status(400).json({ ok: false, error: 'This shop has no labor rates in its profile (Labor Rates tab). Add them, then approve again — nothing was written.' });

      const byName = {};
      (compRows || []).forEach((r) => { const n = norm(r.Project_Component); if (n) byName[n] = String(r.ID); });

      const token = await getAccessToken();
      const base = creatorApiBase();
      const written = [], skipped = [], failed = [], folded = [];
      for (const c of comps) {
        const f = foldToShopTypes(bucketHours(c.items), shopTypes);
        const hours = f.hours;
        f.moved.forEach((m) => folded.push(Object.assign({ component: c.name }, m)));
        const total = BUCKETS.reduce((a, k) => a + hours[k], 0);
        if (!(total > 0)) { skipped.push({ what: c.name, why: 'no hours' }); continue; }
        const cid = byName[norm(c.name)];
        if (!cid) { skipped.push({ what: c.name, why: 'not a component on this project — add it (Scope Reconciliation) and approve again' }); continue; }
        const rec = buildRecord(projectId, cid, hours, rates);
        // Hand-entered rows carry the shop's types; set them too. Not worth losing hours over:
        // if Zoho refuses the multi-select, the row goes in without it.
        if (shopTypes.length) rec.View_Labor_Type = shopTypes;
        try {
          let id;
          try { id = await insert(base, token, rec); }
          catch (e) {
            if (!rec.View_Labor_Type || !/View_Labor_Type/i.test(e.message)) throw e;
            delete rec.View_Labor_Type; id = await insert(base, token, rec);
          }
          written.push({ name: c.name, id, hours: r2(total) });
        } catch (e) { failed.push({ what: c.name, why: e.message }); }
      }

      // Only now remove what the last approve wrote — and only rows that really are on this project.
      const onProject = new Set((laborRows || []).map((r) => String(r.ID)));
      const removed = [], keep = [];
      for (const id of (b.prior_ids || []).map(String)) {
        if (!onProject.has(id)) continue;
        try {
          const r = await axios.delete(base + '/report/All_Project_Labor_Details/' + id, { headers: zohoHeaders(token) });
          if (r.data && r.data.code === 3000) removed.push(id); else keep.push(id);
        } catch (e) { keep.push(id); }
      }
      // Rebuild the project's labour totals row from every labour row now on the project.
      let totals = null;
      try { totals = await upsertTotals(base, token, projectId, mfg); }
      catch (e) { totals = { ok: false, error: e.message }; console.error('[labor] totals row failed:', e.message); }

      res.json({ ok: true, written, skipped, failed, replaced: removed.length, not_removed: keep, totals,
        rates_estimated: estimated, folded, shop_types_known: shopTypes.length > 0,
        total_hours: r2(written.reduce((a, w) => a + w.hours, 0)) });
    } catch (err) {
      console.error('[labor] commit failed:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });
}

module.exports = { registerLaborCommit, buildRecord, pickRates, bucketHours, foldToShopTypes, projectTotals };
