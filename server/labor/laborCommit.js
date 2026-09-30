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

  // body: { project_id, manufacturer_id, components: [{ name, items:[{bucket,hours}] }], prior_ids: [] }
  app.post('/api/takeoff/commit-labor', async (req, res) => {
    try {
      const b = req.body || {};
      const projectId = String(b.project_id || '').trim();
      const mfg = String((req.tenant && req.tenant.kind === 'm' && req.tenant.id) || b.manufacturer_id || '').trim();
      if (!/^\d{6,25}$/.test(projectId)) return res.status(400).json({ ok: false, error: 'project_id required' });
      if (!/^\d{6,25}$/.test(mfg)) return res.status(400).json({ ok: false, error: 'manufacturer_id required for labor rates' });
      const comps = (Array.isArray(b.components) ? b.components : []).filter((c) => c && c.name);

      const [rateRows, compRows, laborRows] = await Promise.all([
        fetchAllZohoPages('/report/All_Manufacture_Labor_Rates?criteria=' + crit('(Manufacture==' + mfg + ')')),
        fetchAllZohoPages('/report/All_Project_Components?criteria=' + crit('(MCP_Customer_Project_Form==' + projectId + ')')),
        (b.prior_ids || []).length ? fetchAllZohoPages('/report/All_Project_Labor_Details?criteria=' + crit('(Project_LU==' + projectId + ')')) : Promise.resolve([]),
      ]);
      const { rates, estimated } = pickRates(rateRows);
      if (!rates) return res.status(400).json({ ok: false, error: 'This shop has no labor rates in its profile (Labor Rates tab). Add them, then approve again — nothing was written.' });

      const byName = {};
      (compRows || []).forEach((r) => { const n = norm(r.Project_Component); if (n) byName[n] = String(r.ID); });

      const token = await getAccessToken();
      const base = creatorApiBase();
      const written = [], skipped = [], failed = [];
      for (const c of comps) {
        const hours = bucketHours(c.items);
        const total = BUCKETS.reduce((a, k) => a + hours[k], 0);
        if (!(total > 0)) { skipped.push({ what: c.name, why: 'no hours' }); continue; }
        const cid = byName[norm(c.name)];
        if (!cid) { skipped.push({ what: c.name, why: 'not a component on this project — add it (Scope Reconciliation) and approve again' }); continue; }
        try {
          const id = await insert(base, token, buildRecord(projectId, cid, hours, rates));
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
      res.json({ ok: true, written, skipped, failed, replaced: removed.length, not_removed: keep,
        rates_estimated: estimated, total_hours: r2(written.reduce((a, w) => a + w.hours, 0)) });
    } catch (err) {
      console.error('[labor] commit failed:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });
}

module.exports = { registerLaborCommit, buildRecord, pickRates, bucketHours };
