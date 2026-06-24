require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const FormData = require('form-data');
const { takeoffHandler, reviseHandler, chatHandler } = require('./takeoff/route');

const app = express();
app.use(cors());
app.use('/api/takeoff', express.json({ limit: '60mb' })); // AI take-off: base64 PDFs are large; must precede the 10mb global json
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'client', 'build')));

const ZOHO = {
  clientId: process.env.ZOHO_CLIENT_ID,
  clientSecret: process.env.ZOHO_CLIENT_SECRET,
  refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  accountOwner: process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal',
  appLinkName: process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21',
};
const NESTING_API_URL = process.env.NESTING_API_URL || 'https://metal-nesting-api-production.up.railway.app/nest';

console.log('Zoho Config:', { clientId: ZOHO.clientId ? ZOHO.clientId.substring(0,10)+'...' : 'MISSING', clientSecret: ZOHO.clientSecret ? ZOHO.clientSecret.substring(0,6)+'...' : 'MISSING', refreshToken: ZOHO.refreshToken ? ZOHO.refreshToken.substring(0,10)+'...'+ZOHO.refreshToken.slice(-6) : 'MISSING', accountOwner: ZOHO.accountOwner, appLinkName: ZOHO.appLinkName });

let cachedToken = null, tokenExpiry = 0, lastTokenError = null, tokenObtainedAt = null;

async function getAccessToken(forceRefresh) {
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiry) return cachedToken;
  try {
    const resp = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, { params: { refresh_token: ZOHO.refreshToken, client_id: ZOHO.clientId, client_secret: ZOHO.clientSecret, grant_type: 'refresh_token' } });
    if (resp.data.error) { lastTokenError = resp.data.error; cachedToken = null; tokenExpiry = 0; throw new Error('Zoho token error: ' + resp.data.error); }
    if (!resp.data.access_token) { lastTokenError = 'No access_token'; cachedToken = null; tokenExpiry = 0; throw new Error('No access_token'); }
    cachedToken = resp.data.access_token;
    tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
    tokenObtainedAt = Date.now();
    lastTokenError = null;
    console.log('Token obtained, expires in', resp.data.expires_in, 's');
    return cachedToken;
  } catch (err) { lastTokenError = err.response?.data || err.message; cachedToken = null; tokenExpiry = 0; throw err; }
}

function zohoHeaders(token) { return { Authorization: 'Zoho-oauthtoken ' + token, Accept: 'application/json' }; }
function creatorApiBase() { return 'https://www.zohoapis.com/creator/v2.1/data/' + ZOHO.accountOwner + '/' + ZOHO.appLinkName; }
function safeNum(val, dec) { dec = dec || 4; const n = parseFloat(val); if (!Number.isFinite(n)) return 0; return Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec); }

getAccessToken().then(() => console.log('Startup token warm-up successful')).catch(e => console.error('Startup token warm-up failed:', e.message));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── AI take-off PREPAID METER (Phase 0: visual only, no real charges) ────────
// VISUAL price the customer's banked balance draws down per take-off. This is NOT
// your Anthropic cost — Anthropic only ever bills the real token usage. Changeable.
const TAKEOFF_PRICE = { premium: 3, basic: 1.5 };
const F_TAKEOFF_BALANCE = 'Takeoff_Balance';   // Decimal(2) on Customer_Entry_Form (add + seed e.g. 100)
function takeoffPrice(tier) { return tier === 'basic' ? TAKEOFF_PRICE.basic : TAKEOFF_PRICE.premium; }

async function getManufacturerRec(mfgId) {
  const token = await getAccessToken();
  const resp = await axios.get(`${creatorApiBase()}/report/Customer_Entry_Report?limit=200`, { headers: zohoHeaders(token) });
  return (resp.data.data || []).find(r => String(r.ID) === String(mfgId)) || null;
}
async function getTakeoffBalance(mfgId) {
  const rec = await getManufacturerRec(mfgId);
  return rec ? { balance: Number(rec[F_TAKEOFF_BALANCE] || 0), found: true } : { balance: 0, found: false };
}
async function deductTakeoffBalance(mfgId, price) {
  const { balance, found } = await getTakeoffBalance(mfgId);
  const newBal = Math.max(0, Number((balance - price).toFixed(2)));
  if (found) {
    try {
      const token = await getAccessToken();
      const patch = {}; patch[F_TAKEOFF_BALANCE] = newBal;
      const r = await axios.patch(`${creatorApiBase()}/report/Customer_Entry_Report/${mfgId}`, { data: patch }, { headers: zohoHeaders(token) });
      if (r.data && r.data.code && r.data.code !== 3000) console.error('balance patch non-3000', r.data.code, r.data.message);
    } catch (e) { console.error('balance write failed (is Takeoff_Balance field added?)', e.message); }
  }
  return { balance: newBal, was: balance, found: found };
}

// Current banked balance + price (widget green-bar display).
app.get('/api/takeoff/account/:manufacturer_id', async (req, res) => {
  try {
    const { balance, found } = await getTakeoffBalance(req.params.manufacturer_id);
    res.json({ ok: true, balance: Number(balance.toFixed(2)), price: TAKEOFF_PRICE, found: found });
  } catch (e) { res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
});

// AI material take-off — PDFs in, BOM + project synopsis out. Injects this shop's prior
// corrections (Tier-3 per-manufacturer learning) so the take-off pre-applies their preferences.
app.post('/api/takeoff', async (req, res) => {
  let shopLearning = '', universalKnowledge = '', projectContext = '';
  const mfgId = req.body && req.body.manufacturer_id;
  const tier = (req.body && req.body.tier) || ((req.body && req.body.include_synopsis === false) ? 'basic' : 'premium');
  try { if (mfgId) shopLearning = await fetchShopLearning(mfgId); } catch (e) {}
  try { universalKnowledge = await getUniversalKnowledge(); } catch (e) {}
  try { const pid = req.body && req.body.project_id; if (pid) projectContext = await fetchProjectContext(pid); } catch (e) {}

  // Phase 0 meter: deduct the visual price after a successful run, attach balance to the response.
  const origJson = res.json.bind(res);
  res.json = function (payload) {
    if (payload && payload.ok && Array.isArray(payload.rows) && payload.rows.length && mfgId) {
      const price = takeoffPrice(tier);
      deductTakeoffBalance(mfgId, price)
        .then(acct => { payload.price = price; payload.balance = acct.balance; origJson(payload); })
        .catch(e => { console.error('meter err', e); origJson(payload); });
      return res;
    }
    return origJson(payload);
  };

  return takeoffHandler(req, res, { shopLearning: shopLearning, universalKnowledge: universalKnowledge, projectContext: projectContext });
});

// PROJECT CONTEXT — feed the take-off this project's pre-defined Components + Drawings so the AI
// tags each member to the right component and cites the exact drawing numbers (clean staging match).
async function fetchProjectContext(projectId) {
  let comps = [], draws = [];
  try {
    const r = await fetchAllZohoPages('/report/All_Project_Components?criteria=(MCP_Customer_Project_Form==' + projectId + ')');
    comps = r.map(function (x) { return String(x.Project_Component || '').trim(); }).filter(Boolean);
  } catch (e) {}
  try {
    const r = await fetchAllZohoPages('/report/All_Project_Drawing_Details?criteria=(MCP_Customer_Project_Form==' + projectId + ')');
    draws = r.map(function (x) { return String(x.Drawing_Number || '').trim(); }).filter(Boolean);
  } catch (e) {}
  comps = Array.from(new Set(comps));
  draws = Array.from(new Set(draws));
  if (!comps.length && !draws.length) return '';
  let out = "THIS PROJECT'S PRE-DEFINED RECORDS — match the BOM to these EXACT values so it ties to the project cleanly:\n";
  if (comps.length) out += "\nCOMPONENTS / ASSEMBLIES — assign each member's `component` to the single best-fitting name below (EXACT spelling; empty only if none applies):\n" + comps.map(function (c) { return '- ' + c; }).join('\n') + '\n';
  if (draws.length) out += "\nDRAWINGS — when a member appears on one of these sheets, set its `source_sheet` to the EXACT drawing number below:\n" + draws.map(function (d) { return '- ' + d; }).join('\n') + '\n';
  return out;
}
// AI take-off revise (3c) — current package + instruction in, revised package out.
app.post('/api/takeoff/revise', (req, res) => reviseHandler(req, res, {}));
app.post('/api/takeoff/chat', (req, res) => chatHandler(req, res, {}));

// AI take-off COMMIT — write the reviewed BOM CSV into Import_BOM_Form (Zoho) server-side.
// The widget runs standalone (no Creator SDK context), so the Zoho write happens here using the
// app's existing OAuth. Flow: create record -> upload CSV file -> set Run_Import (fires the import).
app.post('/api/takeoff/commit', async (req, res) => {
  try {
    const { project_id, manufacturer_id, import_csv } = req.body || {};
    if (!project_id) return res.status(400).json({ ok: false, error: 'project_id required' });
    if (!import_csv) return res.status(400).json({ ok: false, error: 'import_csv required' });
    const token = await getAccessToken();
    const base = creatorApiBase();

    // 1. create the Import_BOM_Form record (no file yet — guarded submission workflow no-ops).
    //    MFG_Client_Form is a lookup the import doesn't use; omit it (the mfg id doesn't match it).
    const createResp = await axios.post(base + '/form/Import_BOM_Form',
      { data: { Project_ID: project_id, BOM_Import_Mode: 'Append' } },
      { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
    const recId = createResp.data && createResp.data.data && createResp.data.data.ID;
    if (!recId) return res.status(502).json({ ok: false, error: 'create returned no record ID', detail: createResp.data });

    // 2. upload the CSV to the BOM_CSV_File field
    const fd = new FormData();
    fd.append('file', Buffer.from(import_csv, 'utf8'), { filename: 'takeoff-bom-' + project_id + '.csv', contentType: 'text/csv' });
    await axios.post(base + '/report/Import_BOM_Form_Report/' + recId + '/BOM_CSV_File/upload', fd,
      { headers: { ...zohoHeaders(token), ...fd.getHeaders() } });

    // 3. set Run_Import -> the edit fires the import workflow with the file present
    await axios.patch(base + '/report/Import_BOM_Form_Report/' + recId,
      { data: { Run_Import: 'true' } },
      { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });

    return res.json({ ok: true, import_id: recId });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('takeoff commit error:', detail);
    return res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// AI take-off SAVE — persist the take-off package on a per-project Zoho record so it survives
// the browser, re-opens from any device, and feeds the learning loop. Upsert by Project_ID.
app.post('/api/takeoff/save', async (req, res) => {
  try {
    const { project_id } = req.body || {};
    const pkg = req.body && req.body.package;
    if (!project_id) return res.status(400).json({ ok: false, error: 'project_id required' });
    if (!pkg) return res.status(400).json({ ok: false, error: 'package required' });
    const token = await getAccessToken();
    const base = creatorApiBase();
    const json = typeof pkg === 'string' ? pkg : JSON.stringify(pkg);
    const rows = (pkg && Array.isArray(pkg.rows)) ? pkg.rows : [];
    const rowCount = rows.filter(function (r) { return (Number(r.quantity) || 0) > 0; }).length;
    const data = {
      Project_ID: project_id, Package: json, Row_Count: rowCount,
      Cost_USD: Math.round((Number(pkg && pkg.cost_usd) || 0) * 10000) / 10000, Updated_At: new Date().toISOString(), Status: 'draft',
    };
    // upsert: find an existing record for this project
    let existing = null;
    try {
      const q = await axios.get(base + '/report/AI_Takeoff_Saved_Report?criteria=(Project_ID=="' + project_id + '")&limit=1', { headers: zohoHeaders(token) });
      existing = q.data && q.data.data && q.data.data[0];
    } catch (e) { /* none yet */ }
    let zr;
    if (existing && existing.ID) {
      zr = await axios.patch(base + '/report/AI_Takeoff_Saved_Report/' + existing.ID, { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
    } else {
      zr = await axios.post(base + '/form/AI_Takeoff_Saved', { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
    }
    if (zr.data && zr.data.code !== 3000) {
      return res.status(502).json({ ok: false, error: 'Zoho rejected the save', detail: zr.data });
    }
    const recId = (zr.data && zr.data.data && zr.data.data.ID) || (existing && existing.ID) || null;
    // best-effort: set the relational lookup so the take-off relates to the project natively.
    // Done separately so a lookup rejection can never break the (text-keyed) save.
    if (recId) {
      try {
        await axios.patch(base + '/report/AI_Takeoff_Saved_Report/' + recId,
          { data: { Project_ID_Look_Up: project_id } },
          { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      } catch (e) { /* lookup is optional */ }
    }
    return res.json({ ok: true, id: recId });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('takeoff save error:', detail);
    return res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// AI take-off LOAD — fetch the saved package for a project (for re-opening the take-off).
app.get('/api/takeoff/saved/:project_id', async (req, res) => {
  try {
    const project_id = req.params.project_id;
    const token = await getAccessToken();
    const base = creatorApiBase();
    let rec = null;
    try {
      const q = await axios.get(base + '/report/AI_Takeoff_Saved_Report?criteria=(Project_ID=="' + project_id + '")&limit=1', { headers: zohoHeaders(token) });
      rec = q.data && q.data.data && q.data.data[0];
    } catch (e) { /* no records */ }
    if (!rec || !rec.Package) return res.json({ ok: true, found: false });
    let pkg;
    try { pkg = JSON.parse(rec.Package); } catch (e) { return res.json({ ok: true, found: false }); }
    return res.json({ ok: true, found: true, package: pkg, updated_at: rec.Updated_At || null, id: rec.ID });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('takeoff load error:', detail);
    return res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// LEARNING — build this shop's prior-decisions prompt block (Tier-3). Returns '' if none.
async function fetchShopLearning(mfg) {
  const token = await getAccessToken();
  const base = creatorApiBase();
  let recs = [];
  try {
    const q = await axios.get(base + '/report/Takeoff_Correction_Report?criteria=(Manufacture_ID=="' + mfg + '")&limit=200', { headers: zohoHeaders(token) });
    recs = (q.data && q.data.data) || [];
  } catch (e) { return ''; }
  if (!recs.length) return '';
  // Tally human choices per decision-context → the shop's prevailing preference.
  const byCtx = {};
  recs.forEach(function (r) {
    const ctx = String(r.Context || '').trim(); const hv = String(r.Human_Value || '').trim();
    if (!ctx || !hv) return;
    byCtx[ctx] = byCtx[ctx] || {};
    byCtx[ctx][hv] = (byCtx[ctx][hv] || 0) + 1;
  });
  const lines = [];
  Object.keys(byCtx).forEach(function (ctx) {
    const choices = byCtx[ctx]; let best = '', bestN = 0, total = 0;
    Object.keys(choices).forEach(function (c) { total += choices[c]; if (choices[c] > bestN) { best = c; bestN = choices[c]; } });
    lines.push('- "' + ctx + '"  ->  this shop chose: "' + best + '"' + (total > 1 ? ' (' + bestN + '/' + total + ')' : ''));
  });
  if (!lines.length) return '';
  return "THIS FABRICATOR'S PAST DECISIONS (apply as standing preferences): when the SAME judgment call " +
    "appears in this take-off, pre-resolve it to this shop's prior choice and set that decision's " +
    "ai_recommendation accordingly. A repeated choice is a strong default. Their history:\n" + lines.join('\n');
}

// CAPTURE — store this shop's corrections (decisions etc.) for future personalization.
app.post('/api/takeoff/learn', async (req, res) => {
  try {
    const { manufacturer_id, project_type } = req.body || {};
    const corrections = (req.body && req.body.corrections) || [];
    if (!manufacturer_id) return res.status(400).json({ ok: false, error: 'manufacturer_id required' });
    if (!Array.isArray(corrections) || !corrections.length) return res.json({ ok: true, stored: 0 });
    const token = await getAccessToken();
    const base = creatorApiBase();
    const now = new Date().toISOString();
    let stored = 0;
    for (const c of corrections) {
      const data = {
        Manufacture_ID: manufacturer_id,
        Context: String(c.context || '').slice(0, 250),
        AI_Value: String(c.ai_value || '').slice(0, 250),
        Human_Value: String(c.human_value || '').slice(0, 250),
        Project_Type: String(project_type || '').slice(0, 250),
        Source: String(c.source || 'decision').slice(0, 250),
        Created: now,
      };
      try {
        const r = await axios.post(base + '/form/Takeoff_Correction', { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
        if (r.data && r.data.code === 3000) stored++;
      } catch (e) { /* skip one bad row */ }
    }
    return res.json({ ok: true, stored: stored });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('takeoff learn error:', detail);
    return res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// UNIVERSAL knowledge (Tier 1) — approved cross-shop patterns, cached 30 min, injected into every take-off.
let _ukCache = { text: '', at: 0 };
async function getUniversalKnowledge() {
  if (_ukCache.at > 0 && Date.now() - _ukCache.at < 30 * 60 * 1000) return _ukCache.text;
  const token = await getAccessToken();
  const base = creatorApiBase();
  let recs = [];
  try {
    const q = await axios.get(base + '/report/Takeoff_Knowledge_Report?criteria=(Status=="approved")&limit=200', { headers: zohoHeaders(token) });
    recs = (q.data && q.data.data) || [];
  } catch (e) { return _ukCache.text || ''; }
  const lines = recs.map(function (r) { return '- ' + String(r.Pattern || '').trim(); }).filter(function (l) { return l.length > 2; });
  const text = lines.length ? ("LEARNED ESTIMATING KNOWLEDGE (patterns confirmed across multiple fabricators — apply as general guidance):\n" + lines.join('\n')) : '';
  _ukCache = { text: text, at: Date.now() };
  return text;
}

// MINER — aggregate corrections across ALL shops; a (context,choice) backed by >=2 distinct shops
// becomes a CANDIDATE universal pattern for Mark to approve. Single-shop edges never qualify (firewall).
app.post('/api/takeoff/mine', async (req, res) => {
  try {
    const token = await getAccessToken();
    const base = creatorApiBase();
    let recs = [];
    try {
      recs = await fetchAllZohoPages('/report/Takeoff_Correction_Report');  // paginated (200/page)
    } catch (e) { return res.status(502).json({ ok: false, error: 'could not read corrections', detail: e.response && e.response.data }); }
    // group: context -> chosen value -> set of distinct manufacturers
    const groups = {};
    recs.forEach(function (r) {
      const ctx = String(r.Context || '').trim(), val = String(r.Human_Value || '').trim(), mfg = String(r.Manufacture_ID || '').trim();
      if (!ctx || !val || !mfg) return;
      groups[ctx] = groups[ctx] || {}; groups[ctx][val] = groups[ctx][val] || {}; groups[ctx][val][mfg] = true;
    });
    const candidates = [];
    Object.keys(groups).forEach(function (ctx) {
      Object.keys(groups[ctx]).forEach(function (val) {
        const shops = Object.keys(groups[ctx][val]).length;
        if (shops >= 2) candidates.push({ pattern: 'When "' + ctx + '", fabricators typically choose "' + val + '".', support: shops });
      });
    });
    // refresh: delete prior 'candidate' rows (keep approved/rejected), then write fresh candidates
    try {
      const cq = await axios.get(base + '/report/Takeoff_Knowledge_Report?criteria=(Status=="candidate")&limit=200', { headers: zohoHeaders(token) });
      const olds = (cq.data && cq.data.data) || [];
      for (const o of olds) { try { await axios.delete(base + '/report/Takeoff_Knowledge_Report/' + o.ID, { headers: zohoHeaders(token) }); } catch (e) {} }
    } catch (e) {}
    const now = new Date().toISOString();
    let written = 0;
    for (const c of candidates) {
      const data = { Pattern: c.pattern.slice(0, 2000), Status: 'candidate', Support: c.support, Source: 'miner', Created: now };
      try { const r = await axios.post(base + '/form/Takeoff_Knowledge', { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } }); if (r.data && r.data.code === 3000) written++; } catch (e) {}
    }
    return res.json({ ok: true, corrections: recs.length, candidates: candidates.length, written: written, patterns: candidates.map(function (c) { return { pattern: c.pattern, support: c.support }; }) });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('takeoff mine error:', detail);
    return res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

app.get('/api/token-status', async (req, res) => {
  const now = Date.now();
  const hasToken = !!cachedToken;
  const expiresInMs = hasToken ? Math.max(0, tokenExpiry - now) : 0;
  const expiresInMinutes = Math.round(expiresInMs / 60000);
  const obtainedAgo = tokenObtainedAt ? Math.round((now - tokenObtainedAt) / 60000) : null;
  let freshTest = null;
  try { await getAccessToken(); freshTest = true; } catch(e) { freshTest = false; }
  res.json({ token_valid: hasToken && now < tokenExpiry, expires_in_minutes: expiresInMinutes, obtained_minutes_ago: obtainedAgo, last_error: lastTokenError || null, refresh_test: freshTest });
});

app.get('/api/debug', async (req, res) => {
  const info = { config: { accountOwner: ZOHO.accountOwner, appLinkName: ZOHO.appLinkName }, tokenCache: { hasToken: !!cachedToken }, lastTokenError, apiBase: creatorApiBase() };
  try { await getAccessToken(); info.tokenTest = { success: true }; } catch(e) { info.tokenTest = { success: false, error: e.message }; }
  res.json(info);
});

app.get('/api/project/:id', async (req, res) => {
  try {
    let token = await getAccessToken();
    let resp = await axios.get(creatorApiBase()+'/report/All_Projects?criteria=(ID=='+req.params.id+')', { headers: zohoHeaders(token) });
    // Zoho returns HTTP 200 with {code:4000} when the daily API quota is gone,
    // and no data[] — which otherwise reads as a misleading "Project not found".
    if (resp.data?.code === 4000) return res.status(429).json({ error: 'Zoho API daily quota exhausted — try again after it resets (midnight in your Zoho data-center timezone).', code: 4000 });
    if (!resp.data.data?.length) {
      console.log('Project not found on first attempt, forcing token refresh and retrying...');
      token = await getAccessToken(true);
      resp = await axios.get(creatorApiBase()+'/report/All_Projects?criteria=(ID=='+req.params.id+')', { headers: zohoHeaders(token) });
    }
    if (resp.data?.code === 4000) return res.status(429).json({ error: 'Zoho API daily quota exhausted — try again after it resets (midnight in your Zoho data-center timezone).', code: 4000 });
    if (!resp.data.data?.length) return res.status(404).json({ error: 'Project not found' });
    res.json(resp.data.data[0]);
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.response?.data || err.message }); }
});

// Authoritative per-foot material weights, keyed by Material record ID.
// WHY: the BOM detail report returns the Material lookup as {ID, display_value}
// only (no dot-walk to Weight_Lb_Ft), and the BOM's own snapshot field
// Weight_Per_Ft is left BLANK by the BOM workflow (it computes Unit_Weight/
// CalcWeight but never persists the per-foot value). Reading row.Weight_Per_Ft
// therefore yields 0 and zeroes out every downstream purchase/quote weight.
// Joining Material.ID -> material library here is immune to that blank field.
// Cached 30 min: material weights essentially never change.
async function getMaterialWeightMap() {
  return cachedLookup('material-weight-map', 30 * 60 * 1000, async () => {
    const rows = await fetchAllZohoPages('/report/Beam_Channel_Tee_Lookup_Report');
    const map = {};
    rows.forEach(r => { map[String(r.ID)] = parseFloat(r.Weight_Lb_Ft) || 0; });
    console.log('material-weight-map built: ' + Object.keys(map).length + ' materials');
    return map;
  });
}

app.get('/api/project/:id/bom', async (req, res) => {
  try { const token = await getAccessToken();
    const [resp, matWeights] = await Promise.all([
      axios.get(creatorApiBase()+'/report/Project_Bill_Of_Material_Detail_Form_Report?criteria=(MCP_Customer_Project_Form=='+req.params.id+')&limit=200', { headers: zohoHeaders(token) }),
      getMaterialWeightMap(),
    ]);
    res.json((resp.data.data || []).map(row => { const matId = row.Material?.ID ? String(row.Material.ID) : null; return ({ id: row.ID, bom_item: row.BOM_Item, nest_type: row.Nest_Type, form_type_id: row.Form_Type?.ID, form_type_name: row.Form_Type?.zc_display_value || row.Form_Type?.display_value, material_type_id: row.Material_Type?.ID, material_type_name: row.Material_Type?.zc_display_value || row.Material_Type?.display_value, specification_id: row.Specification?.ID, spec_name: row.Specification?.zc_display_value || row.Specification?.display_value, material_type_origin: row.Specification?.Material_Type_Origin || '', material_id: row.Material?.ID, material_name: row.Material?.zc_display_value || row.Material?.display_value, material_dim1: row.Material?.Dim1, quantity: row.Quantity, length_nest: row.Length_Nest, width_nest: row.Width_Nest, density: row.Density, weight_per_ft: (matId && matWeights[matId]) || parseFloat(row.Weight_Per_Ft) || 0 }); }));
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.response?.data || err.message }); }
});

app.get('/api/stock', async (req, res) => {
  try { const token = await getAccessToken();
    const resp = await axios.get(creatorApiBase()+'/report/Nesting_Stock_Library_Report?criteria=(Is_Active=="Yes")&limit=200', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => ({ id: row.ID, form_type: row.Form_Type?.ID || row.Form_Type, form_type_name: row.Form_Type?.zc_display_value || row.Form_Type, material_type: row.Material_Type?.ID || row.Material_Type, material_type_name: row.Material_Type?.zc_display_value || row.Material_Type, stock_length: row.Stock_Length, stock_width: row.Stock_Width, density: row.Density_LBS_per_Culin, is_standard: row.Is_Standard })));
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.response?.data || err.message }); }
});

// ---- BOM Editor lookup endpoints (added 2026-05-21) ----
// Public reference data proxy for the BOM Editor widget. Bypasses Zoho's
// portal API perm wall on Form_Types_Report et al.
// Scoped under /api/bom-lookups/* to avoid collision with the Nesting
// App's /api/lookups/* family which uses different response shapes.
// CORS open via app.use(cors()) at the top of this file.
// See memory: feedback_widget_perm_wall_proxy_route.

// ---- Simple in-memory TTL cache for Zoho lookup responses ----
// Reduces Developer API quota burn dramatically. Form/Material Types essentially never
// change minute-to-minute; even per-combo Spec/Material lists are stable for hours.
// Cache is per-process; Railway restart flushes it (acceptable).
const lookupResponseCache = new Map(); // key -> { value, expiresAt }
const lookupInflight = new Map();      // key -> Promise (dedupe concurrent fetches)

function cacheBust(prefix) {
  for (const k of lookupResponseCache.keys()) { if (k === prefix || k.startsWith(prefix)) lookupResponseCache.delete(k); }
}

async function cachedLookup(cacheKey, ttlMs, fetchFn) {
  const now = Date.now();
  const hit = lookupResponseCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.value;
  if (lookupInflight.has(cacheKey)) return lookupInflight.get(cacheKey);
  const p = (async () => {
    try {
      const value = await fetchFn();
      lookupResponseCache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      lookupInflight.delete(cacheKey);
    }
  })();
  lookupInflight.set(cacheKey, p);
  return p;
}

app.get('/api/cache-status', (req, res) => {
  const now = Date.now();
  const entries = Array.from(lookupResponseCache.entries()).map(([key, v]) => ({
    key,
    expires_in_seconds: Math.max(0, Math.round((v.expiresAt - now) / 1000)),
  }));
  res.json({ size: entries.length, entries, inflight: lookupInflight.size });
});

app.post('/api/cache-clear', (req, res) => {
  const cleared = lookupResponseCache.size;
  lookupResponseCache.clear();
  lookupInflight.clear();
  res.json({ ok: true, cleared });
});

// Zoho returns HTTP 200 even for API-quota errors. The actual error is in resp.data.code:
//   3000 = success with data
//   3100 = success but no records matching criteria (treat as empty, not error)
//   4000 = "Developer API limit reached" (daily quota exhausted)
//   Other non-3000 codes = various failures
// Easy to misdiagnose code 4000 as "the report is empty" — surface it explicitly.
class ZohoApiError extends Error {
  constructor(code, message, url) {
    super('Zoho API code ' + code + ': ' + message);
    this.zohoCode = code;
    this.zohoMessage = message;
    this.url = url;
  }
}

async function fetchAllZohoPages(reportPath) {
  const token = await getAccessToken();
  let all = [];
  const pageSize = 200;  // Zoho v2.1 API rejects > 200 with code 2945 MORE_THAN_MAX_LENGTH
  const hardCap = 5000;  // safety stop; 200/page → max 25 calls
  // Creator API v2.1 paginates via the `record_cursor` response header, NOT the
  // v2-style `from` param (v2.1 ignores `from`, re-returning the first page every
  // time). Pass the cursor back as a request header to fetch the next batch; it's
  // absent on the response once there are no more records.
  let cursor = null;
  while (true) {
    const sep = reportPath.includes('?') ? '&' : '?';
    const url = creatorApiBase() + reportPath + sep + 'limit=' + pageSize;
    const headers = zohoHeaders(token);
    if (cursor) headers.record_cursor = cursor;
    let resp;
    try {
      resp = await axios.get(url, { headers });
    } catch (err) {
      // Zoho v2.1 returns HTTP 400 / code 9280 ("No records found matching the given
      // criteria") for an EMPTY criteria result instead of []. That's not an error —
      // return whatever we've collected (typically []) so callers don't have to guard.
      if (err.response?.status === 400 && err.response.data?.code === 9280) break;
      console.error('[bom-lookups] Zoho HTTP error:', url, '→', err.response?.status, JSON.stringify(err.response?.data || err.message));
      throw err;
    }
    // Detect Zoho-level error returned with HTTP 200
    const code = resp.data?.code;
    if (code && code !== 3000 && code !== 3100 && !Array.isArray(resp.data?.data)) {
      console.error('[bom-lookups] Zoho error code', code, 'on', url, '→', resp.data?.message);
      throw new ZohoApiError(code, resp.data.message || 'Unknown', url);
    }
    const rows = resp.data?.data || [];
    all.push(...rows);
    // axios lowercases response header names. No cursor → last page.
    cursor = resp.headers['record_cursor'] || resp.headers['Record_Cursor'] || null;
    if (!cursor) break;
    if (all.length >= hardCap) {
      console.warn('[bom-lookups] fetchAllZohoPages hit hardCap', hardCap, 'for', reportPath);
      break;
    }
  }
  return all;
}

function sendZohoAwareError(res, err) {
  if (err instanceof ZohoApiError) {
    // 503 Service Unavailable is the closest HTTP semantic for "Zoho exhausted my daily quota"
    const status = err.zohoCode === 4000 ? 503 : 502;
    return res.status(status).json({
      error: 'Zoho API error',
      zoho_code: err.zohoCode,
      zoho_message: err.zohoMessage,
      hint: err.zohoCode === 4000 ? 'Daily Zoho Developer API quota exhausted. Resets at midnight UTC. Upgrade plan for higher limits.' : null,
    });
  }
  res.status(500).json({ error: 'Failed', details: err.response?.data || err.message });
}

app.get('/api/bom-lookups/form-types', async (req, res) => {
  try {
    const data = await cachedLookup('bom-lookups:form-types', 60 * 60 * 1000, async () => {
      const rows = await fetchAllZohoPages('/report/Form_Types_Report?criteria=(Active==true)');
      return rows.map(r => ({
        id: String(r.ID),
        label: r.Form_Type || '',
        measurement: r.Measurement || '',  // "Linear" or "Panel" — drives whether width fields are editable
      }));
    });
    res.json(data);
  } catch (err) {
    sendZohoAwareError(res, err);
  }
});

// Diagnostic: force token refresh + raw Zoho call. Returns whatever Zoho responded.
app.get('/api/bom-lookups/__debug', async (req, res) => {
  try {
    const token = await getAccessToken(true); // force refresh
    const report = req.query.report || 'Form_Types_Report';
    const criteria = req.query.criteria ? '&criteria=' + req.query.criteria : '';
    const url = creatorApiBase() + '/report/' + report + '?from=1&limit=3' + criteria;
    const r = await axios.get(url, { headers: zohoHeaders(token) });
    res.json({ ok: true, url, status: r.status, body: r.data });
  } catch (err) {
    res.status(500).json({
      ok: false,
      zoho_status: err.response?.status,
      zoho_body: err.response?.data,
      message: err.message,
    });
  }
});

app.get('/api/bom-lookups/material-types', async (req, res) => {
  try {
    const data = await cachedLookup('bom-lookups:material-types', 60 * 60 * 1000, async () => {
      const rows = await fetchAllZohoPages('/report/Material_Types_Report');
      return rows.map(r => ({ id: String(r.ID), label: r.Material_Type || '' }));
    });
    res.json(data);
  } catch (err) {
    sendZohoAwareError(res, err);
  }
});

app.get('/api/bom-lookups/material-form-detail', async (req, res) => {
  try {
    const { form_type_id, material_type_id } = req.query;
    const cacheKey = 'bom-lookups:material-form-detail:' + (form_type_id || '*') + '|' + (material_type_id || '*');
    const data = await cachedLookup(cacheKey, 15 * 60 * 1000, async () => {
      let path = '/report/Material_Form_Detail_Report';
      if (form_type_id && material_type_id) {
        path += '?criteria=(Form_Type==' + form_type_id + '%26%26Material_Type==' + material_type_id + ')';
      } else if (form_type_id) {
        path += '?criteria=(Form_Type==' + form_type_id + ')';
      }
      const rows = await fetchAllZohoPages(path);
      return rows.map(r => ({
        id: String(r.ID),
        formTypeId: String(r.Form_Type?.ID || ''),
        matTypeId:  String(r.Material_Type?.ID || ''),
        typeDetail: r.Type_Detail || ''
      }));
    });
    res.json(data);
  } catch (err) {
    sendZohoAwareError(res, err);
  }
});

// Per-project components list. Filter: MCP_Customer_Project_Form == project_id
app.get('/api/bom-lookups/components', async (req, res) => {
  try {
    const { project_id } = req.query;
    if (!project_id) return res.status(400).json({ error: 'project_id query param required' });
    const data = await cachedLookup('bom-lookups:components:' + project_id, 5 * 60 * 1000, async () => {
      const rows = await fetchAllZohoPages('/report/All_Project_Components?criteria=(MCP_Customer_Project_Form==' + project_id + ')');
      return rows.map(r => ({
        id: String(r.ID),
        label: r.Project_Component || '',  // Field link name on Project_Components_Form is Project_Component (display name "Component")
      }));
    });
    res.json(data);
  } catch (err) {
    sendZohoAwareError(res, err);
  }
});

// Per-component drawings list. Filter: Components == component_id
app.get('/api/bom-lookups/drawings', async (req, res) => {
  try {
    const { component_id } = req.query;
    if (!component_id) return res.status(400).json({ error: 'component_id query param required' });
    const data = await cachedLookup('bom-lookups:drawings:' + component_id, 5 * 60 * 1000, async () => {
      const rows = await fetchAllZohoPages('/report/All_Project_Drawing_Details?criteria=(Components==' + component_id + ')');
      return rows.map(r => ({
        id: String(r.ID),
        label: r.Drawing_Number || '',
      }));
    });
    res.json(data);
  } catch (err) {
    sendZohoAwareError(res, err);
  }
});

app.get('/api/bom-lookups/materials', async (req, res) => {
  try {
    const { form_type_id, material_type_id } = req.query;
    const cacheKey = 'bom-lookups:materials:' + (form_type_id || '*') + '|' + (material_type_id || '*');
    const data = await cachedLookup(cacheKey, 15 * 60 * 1000, async () => {
      let path = '/report/Beam_Channel_Tee_Lookup_Report';
      if (form_type_id && material_type_id) {
        path += '?criteria=(Form_Types==' + form_type_id + '%26%26Material_Types==' + material_type_id + ')';
      } else if (form_type_id) {
        path += '?criteria=(Form_Types==' + form_type_id + ')';
      }
      const rows = await fetchAllZohoPages(path);
      return rows.map(r => ({
        id: String(r.ID),
        formTypeId: String(r.Form_Types?.ID || ''),
        matTypeId:  String(r.Material_Types?.ID || ''),
        specId:     String(r.Specification?.ID || ''),
        description: r.Description || '',
        weightPerFt: parseFloat(r.Weight_Lb_Ft) || 0,
        dim1: parseFloat(r.Dim1) || 0,
        surfaceAreaPerFt: parseFloat(r.Surface_Area_Per_FT) || 0,
      }));
    });
    res.json(data);
  } catch (err) {
    sendZohoAwareError(res, err);
  }
});

app.post('/api/nest', async (req, res) => {
  try { console.log('NEST REQUEST:', JSON.stringify(req.body));
    const resp = await axios.post(NESTING_API_URL, req.body, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
    console.log('NEST RESPONSE:', JSON.stringify(resp.data)); res.json(resp.data);
  } catch (err) { res.status(500).json({ error: 'Nesting failed', details: err.response?.data || err.message }); }
});

app.post('/api/project/:id/save-results', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { results_1d, results_2d, summary, kerf_1d, kerf_2d, run_by, created_by, run_title, run_notes } = req.body;

    let bomItems = [];
    try {
      const matWeights = await getMaterialWeightMap();
      const bomResp = await axios.get(creatorApiBase()+'/report/Project_Bill_Of_Material_Detail_Form_Report?criteria=(MCP_Customer_Project_Form=='+projectId+')&limit=200', { headers: zohoHeaders(token) });
      bomItems = (bomResp.data.data || []).map(row => { const matId = row.Material?.ID ? String(row.Material.ID) : null; return ({ id: row.ID, form_type_id: row.Form_Type?.ID, material_type_id: row.Material_Type?.ID, specification_id: row.Specification?.ID, material_id: row.Material?.ID, dim1: parseFloat(row.Material?.Dim1) || parseFloat(row.Dim1) || 0, weight_per_ft: (matId && matWeights[matId]) || parseFloat(row.Weight_Per_Ft) || 0, density: parseFloat(row.Density) || 0 }); });
    } catch (e) { console.error('BOM fetch failed for weights'); }

    function getBomData(result) {
      const id = result.cuts?.[0]?.bom_line_id;
      if (!id) return { weight_per_ft: 0, thickness: 0, form_type_id: null, material_type_id: null, specification_id: null, material_id: null };
      const b = bomItems.find(x => x.id === id);
      return b ? { weight_per_ft: b.weight_per_ft, thickness: b.dim1, density: b.density, form_type_id: b.form_type_id, material_type_id: b.material_type_id, specification_id: b.specification_id, material_id: b.material_id } : { weight_per_ft: 0, thickness: 0, form_type_id: null, material_type_id: null, specification_id: null, material_id: null };
    }
    function calcStockWt(r, wpf) {
      if (!wpf || !r.stock_length_in) return 0;
      return r.stock_width_in ? Math.round((r.stock_length_in * r.stock_width_in / 144) * wpf * 100) / 100 : Math.round(wpf * (r.stock_length_in / 12) * 100) / 100;
    }

    let existingRuns = [];
    try {
      const rr = await axios.get(creatorApiBase()+'/report/Nesting_Run_Header_Report?criteria=(Project_Lookup=='+projectId+')', { headers: zohoHeaders(token) });
      existingRuns = rr.data.data || [];
    } catch (e) { if (e.response?.data?.code === 9280) existingRuns = []; else throw e; }

    const approvedRuns = existingRuns.filter(r => r.Run_Status === 'Approved');
    for (const pr of approvedRuns) { try { await axios.patch(creatorApiBase()+'/report/Nesting_Run_Header_Report/'+pr.ID, { data: { Run_Status: 'Superseded' } }, { headers: zohoHeaders(token) }); } catch(e) {} }

    let mfg = '';
    try { const pr = await axios.get(creatorApiBase()+'/report/All_Projects/'+projectId, { headers: zohoHeaders(token) }); const m = pr.data.data?.MANUFACTURE; mfg = m?.ID || m?.zc_display_value || m || ''; } catch(e) {}

    const now = new Date();
    const rd = (now.getMonth()+1).toString().padStart(2,'0')+'/'+now.getDate().toString().padStart(2,'0')+'/'+now.getFullYear()+' '+now.toTimeString().slice(0,8);
    const hd = { Project_Lookup: projectId, Run_Number: existingRuns.length + 1, Run_Date: rd, Run_Status: 'Approved', Added_User: created_by || 'web_app' };
    if (run_by) hd.Run_By = run_by; else if (mfg) hd.Run_By = mfg;
    if (created_by) hd.Created_By = created_by;
    if (run_title) hd.Run_Title = run_title;
    if (run_notes) hd.Run_Notes = run_notes;
    if (kerf_1d !== undefined) hd.Kerf_1D = kerf_1d;
    if (kerf_2d !== undefined) hd.Kerf_2D = kerf_2d;

    const hr = await axios.post(creatorApiBase()+'/form/Nesting_Run_Header', { data: hd }, { headers: zohoHeaders(token) });
    const nestRunID = hr.data.data.ID;

    let s1d = 0;
    for (const result of results_1d || []) {
      if (result.error || !result.cuts?.length) continue;
      try {
        const bd = getBomData(result);
        const cuts = result.cuts.map((c, i) => ({ BOM_Line_Lookup: c.bom_line_id, Part_Mark: c.part_mark, Cut_Length: c.cut_length, Cut_Weight: c.cut_length ? Math.round(bd.weight_per_ft * (c.cut_length / 12) * 10000) / 10000 : 0, Quantity_On_This_Stock: c.quantity_on_this_stock, Cut_Sequence: i + 1 }));
        const saveData1d = { Nesting_Run_Header: nestRunID, Nesting_Type: '1D - Linear', Form_Type: bd.form_type_id || result.form_type, Material_Type: bd.material_type_id || result.material_origin, Specification: bd.specification_id || result.cuts[0].spec_name, Material: bd.material_id || result.cuts[0].material_type, Stock_Size_Label: result.stock_label || '', Stock_Length: result.stock_length_in, Stock_Thickness: bd.thickness || 0, Remnant_Length: Math.round((result.remnant_length_in || 0) * 100) / 100, Waste_Percentage: result.waste_percentage, Stock_Weight_LBS: calcStockWt(result, bd.weight_per_ft), Stock_Sequence: s1d + 1, Nesting_Cut_Detail: cuts };
        await axios.post(creatorApiBase()+'/form/Nesting_Stock_Result', { data: saveData1d }, { headers: zohoHeaders(token) });
        s1d++;
      } catch (e) { console.error('1D save error:', e.response?.data || e.message); }
    }

    let s2d = 0;
    for (const result of results_2d || []) {
      if (result.error || !result.cuts?.length) continue;
      try {
        const bd = getBomData(result);
        const degreeSign = String.fromCharCode(176);
        const cuts = result.cuts.map((c, i) => ({ BOM_Line_Lookup: c.bom_line_id, Part_Mark: c.part_mark, Cut_Length: c.cut_length, Cut_Width: c.cut_width, Cut_Weight: (c.cut_length && c.cut_width) ? Math.round((c.cut_length * c.cut_width / 144) * bd.weight_per_ft * 10000) / 10000 : 0, Quantity_On_This_Stock: c.quantity_on_this_stock, X_Position: c.x_position || 0, Y_Position: c.y_position || 0, Rotation: c.rotation === 90 ? '90'+degreeSign : '0'+degreeSign, Cut_Sequence: i + 1 }));
        const saveData2d = { Nesting_Run_Header: nestRunID, Nesting_Type: '2D - Panel', Form_Type: bd.form_type_id || result.form_type, Material_Type: bd.material_type_id || result.material_origin, Specification: bd.specification_id || result.cuts[0].spec_name, Material: bd.material_id || result.cuts[0].material_type, Stock_Size_Label: result.stock_label || '', Stock_Length: result.stock_length_in, Stock_Width: result.stock_width_in, Stock_Thickness: bd.thickness || 0, Grain_Direction: result.grain_direction || '', Remnant_Area: result.remnant_area_in2 || 0, Waste_Percentage: result.waste_percentage, Stock_Weight_LBS: calcStockWt(result, bd.weight_per_ft), Stock_Sequence: s2d + 1, Nesting_Cut_Detail: cuts };
        await axios.post(creatorApiBase()+'/form/Nesting_Stock_Result', { data: saveData2d }, { headers: zohoHeaders(token) });
        s2d++;
      } catch (e) { console.error('2D save error:', e.response?.data || e.message); }
    }

    try {
      await axios.patch(creatorApiBase()+'/report/Nesting_Run_Header_Report/'+nestRunID, { data: { Total_Stock_Pieces: s1d + s2d, Total_Waste_Inches: Math.round((summary?.total_remnant_length_in || 0) * 10000) / 10000, Notes: 'Saved '+s1d+' 1D + '+s2d+' 2D | Waste: '+(summary?.avg_waste_pct_1d || 0)+'%' } }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
    } catch (e) { console.error('Header patch failed'); }

    res.json({ success: true, nest_run_id: nestRunID, run_number: existingRuns.length + 1, run_status: 'Approved', saved_1d: s1d, saved_2d: s2d, superseded_runs: approvedRuns.length });
  } catch (err) { console.error('Save error:', err.response?.data || err.message); res.status(500).json({ error: 'Failed to save results', details: err.response?.data || err.message }); }
});

let lookupCache = { lengthInch: null, plateWidthFt: null, materialTypes: null, cacheTime: 0 };

async function fetchLookupTables(token) {
  const CACHE_TTL = 5 * 60 * 1000;
  if (lookupCache.lengthInch && (Date.now() - lookupCache.cacheTime) < CACHE_TTL) return lookupCache;
  console.log('Fetching lookup tables for purchase list...');
  let lengthInch = [], plateWidthFt = [], materialTypes = [];

  try {
    const r = await axios.get(creatorApiBase()+'/report/All_Length_Inch_Lookups?limit=200', { headers: zohoHeaders(token) });
    lengthInch = (r.data.data || []).map(row => ({ id: row.ID, description: row.Description || '', result: parseFloat(row.Result) || 0 }));
    console.log('Length INCH Lookups:', lengthInch.length);
  } catch (e) { console.error('Failed Length INCH fetch:', e.response?.data || e.message); }

  try {
    const r = await axios.get(creatorApiBase()+'/report/All_Plate_Standard_Sizes?limit=200', { headers: zohoHeaders(token) });
    plateWidthFt = (r.data.data || []).map(row => ({
      id: row.ID,
      description: row.Description || '',
      widthFt: parseFloat(row.Width_Ft) || parseFloat(row.Width_ft) || parseFloat(row['Width (ft)']) || 0
    }));
    console.log('Plate Standard Sizes:', plateWidthFt.length);
    if (plateWidthFt.length > 0 && plateWidthFt.every(r => r.widthFt === 0)) {
      console.log('widthFt all zero, parsing from Description...');
      plateWidthFt.forEach(r => {
        const m = (r.description || '').match(/^(\d+)/);
        if (m) r.widthFt = parseInt(m[1]);
      });
    }
  } catch (e) { console.error('Failed Plate Sizes fetch:', e.response?.data || e.message); }

  try {
    const r = await axios.get(creatorApiBase()+'/report/All_Material_Types?limit=200', { headers: zohoHeaders(token) });
    materialTypes = (r.data.data || []).map(row => ({
      id: row.ID,
      name: row.Material_Type || row.zc_display_value || row.display_value || ''
    }));
    console.log('Material Types:', materialTypes.length);
  } catch (e) { console.error('Failed Material Types fetch:', e.response?.data || e.message); }

  lookupCache = { lengthInch, plateWidthFt, materialTypes, cacheTime: Date.now() };
  return lookupCache;
}

function findLengthInchId(table, inchVal) {
  if (!table || !table.length) return null;
  const target = parseFloat(inchVal) || 0;
  let best = null, bestDiff = Infinity;
  for (const rec of table) {
    const d = Math.abs(rec.result - target);
    if (d < bestDiff) { bestDiff = d; best = rec; }
  }
  return (best && bestDiff <= 0.05) ? best.id : null;
}

function findWidthFtId(table, ftVal) {
  if (!table || !table.length) return null;
  const target = Math.floor(parseFloat(ftVal) || 0);
  const byNum = table.find(r => r.widthFt === target);
  if (byNum) return byNum.id;
  const byDesc = table.find(r => r.description === target + "'" || r.description === String(target));
  return byDesc ? byDesc.id : null;
}

function findMaterialTypeId(table, name) {
  if (!table || !table.length || !name) return null;
  const exact = table.find(r => r.name === name);
  if (exact) return exact.id;
  const lower = name.toLowerCase();
  const fuzzy = table.find(r => r.name.toLowerCase() === lower);
  return fuzzy ? fuzzy.id : null;
}

function findLengthInchResult(table, inchId) {
  if (!table || !table.length || !inchId) return 0;
  const rec = table.find(r => r.id === inchId);
  return rec ? rec.result : 0;
}

function findWidthFtResult(table, ftId) {
  if (!table || !table.length || !ftId) return 0;
  const rec = table.find(r => r.id === ftId);
  return rec ? rec.widthFt : 0;
}

app.post('/api/project/:id/generate-purchase-list', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { purchase_lines } = req.body;
    if (!purchase_lines || purchase_lines.length === 0) return res.status(400).json({ error: 'No purchase lines' });

    console.log('Purchase list: ' + purchase_lines.length + ' lines for project ' + projectId);

    const lookups = await fetchLookupTables(token);

    const subformRows = purchase_lines.map(function(line, idx) {
      var stockLenIn = parseFloat(line.stock_length_in) || 0;
      var stockWidIn = parseFloat(line.stock_width_in) || 0;
      var is2D = stockWidIn > 0;
      var lenFt = Math.floor(stockLenIn / 12);
      var lenInchRem = safeNum(stockLenIn % 12, 4);
      var widFt = is2D ? Math.floor(stockWidIn / 12) : 0;
      var widInchRem = is2D ? safeNum(stockWidIn % 12, 4) : 0;
      var lengthInchId = findLengthInchId(lookups.lengthInch, lenInchRem);
      var widthFtId = is2D ? findWidthFtId(lookups.plateWidthFt, widFt) : findWidthFtId(lookups.plateWidthFt, 0);
      var widthInchId = findLengthInchId(lookups.lengthInch, widInchRem);
      var matTypeId = findMaterialTypeId(lookups.materialTypes, line.material_type_name);
      var lengthInchResult = lengthInchId ? findLengthInchResult(lookups.lengthInch, lengthInchId) : lenInchRem;
      var widthFtResult = widthFtId ? findWidthFtResult(lookups.plateWidthFt, widthFtId) : widFt;
      var widthInchResult = widthInchId ? findLengthInchResult(lookups.lengthInch, widthInchId) : widInchRem;
      var unitWt = Math.round((parseFloat(line.unit_weight) || 0) * 100) / 100;
      var qty = safeNum(line.quantity, 0);
      var totalWt = Math.round(unitWt * qty * 100) / 100;
      var area = is2D ? safeNum((stockLenIn * stockWidIn) / 144, 2) : 0;
      var totalLength = is2D ? 0 : safeNum((lenFt * 12) + lengthInchResult, 4);
      var totalPlateWidth = is2D ? safeNum(stockWidIn, 4) : 0;
      var descParts = [line.form_type_name, line.material_type_name, line.spec_name, line.material_name].filter(Boolean);
      var lenStr = lenFt + "'-" + (lenInchRem > 0 ? Math.round(lenInchRem) + '"' : '0"');
      var sizeStr = is2D ? lenStr + ' x ' + widFt + "'-" + (widInchRem > 0 ? Math.round(widInchRem) + '"' : '0"') : lenStr;
      var fullDesc = descParts.join(' | ') + ' | ' + sizeStr;
      var row = {
        Line_Item: idx + 1,
        Form_Type: line.form_type_id,
        Specification: line.specification_id,
        Material: line.material_id,
        MCP_Customer_Project_Form: projectId,
        Project_Bi_Directional_Lookup: projectId,
        // Project_LU is the field the BOM-side Allotted workflow uses to
        // join Project_Material_Allocated_Detail_Form rows back to the BOM
        // (NEW PROJECT SUBMITTAL → Update Component Form workflow). Without
        // it, the workflow's criteria Project_LU == BOM.MCP_Customer_Project_Form
        // returns no matches and Total_Amount_Of_Allotted_Material stays 0.
        Project_LU: projectId,
        Item_Description: fullDesc,
        Item_QTY_and_Description: line.description || fullDesc,
        Description: fullDesc,
        QTY: qty,
        Feet_Length: safeNum(lenFt, 0),
        // Weight_Per_FT is a tight decimal field on the form — 4-decimal values
        // (calculated weights for tubes/bars/odd angles, e.g. 8.1667) trip
        // "Weight_Per_FT has exceeded its maximum digits" and the row is rejected.
        // Round to 2 decimals to match the field config (all saved rows fit this).
        Weight_Per_FT: safeNum(line.weight_per_ft, 2),
        Unit_Weight: unitWt,
        CalcWeight: totalWt,
        Area: area,
        Total_Length: totalLength,
        Total_Plate_Width: totalPlateWidth,
        Material_Size: safeNum(line.material_size, 4),
        Price_Per_LB: 0,
        Unit_Price: 0,
        Unit_Total: 0,
        Input_of_Material: "Add Material",
        Density: 0,
        Dim1_Result: lengthInchResult,
        Length_INCH_Result: lengthInchResult,
        Dim2_Result: widthFtResult,
        Dim3_Result: widthInchResult,
      };
      if (matTypeId) row.Material_Type = matTypeId;
      else if (line.material_type_id) row.Material_Type = line.material_type_id;
      if (lengthInchId) row.Length_INCH = lengthInchId;
      if (widthFtId) row.Width_FT = widthFtId;
      if (widthInchId) row.Width_INCH = widthInchId;
      return row;
    });

    console.log('Subform rows to write:', subformRows.length);

    // ── Delete existing rows for this project before inserting fresh ones ──
    // v1.4 tried a single delete-by-criteria call to save API calls, but it
    // silently failed and left the old rows in place — the insert then stacked
    // on top, producing DUPLICATES (same Line_Item appearing twice). Revert to
    // the proven approach: fetch existing IDs, delete each by ID. If we CANNOT
    // clear the old rows, abort BEFORE inserting so we never duplicate again.
    // (The insert is still bulked below — that was the bigger quota win.)
    var deleteFailed = false;
    try {
      var existingResp = await axios.get(creatorApiBase()+'/report/Project_Material_Allocated_Detail_Form_Report?criteria=(MCP_Customer_Project_Form=='+projectId+')&limit=200', { headers: zohoHeaders(token) });
      if (existingResp.data && existingResp.data.code === 4000) {
        return res.status(429).json({ error: 'Zoho API daily quota exhausted — purchase list NOT saved. Try again after the quota resets.', code: 4000 });
      }
      var existingRows = (existingResp.data && existingResp.data.data) || [];
      console.log('Deleting ' + existingRows.length + ' existing rows before re-insert...');
      for (var d = 0; d < existingRows.length; d++) {
        try {
          await axios.delete(creatorApiBase()+'/report/Project_Material_Allocated_Detail_Form_Report/'+existingRows[d].ID, { headers: zohoHeaders(token) });
        } catch (delErr) {
          var dd = delErr.response && delErr.response.data;
          if (dd && dd.code === 4000) {
            return res.status(429).json({ error: 'Zoho API daily quota exhausted while clearing old rows — purchase list NOT saved (would duplicate). Try again after the quota resets.', code: 4000 });
          }
          deleteFailed = true;
          console.error('Failed to delete row ' + existingRows[d].ID + ':', dd || delErr.message);
        }
      }
    } catch (fetchErr) {
      var fd = fetchErr.response && fetchErr.response.data;
      if (fd && fd.code === 4000) {
        return res.status(429).json({ error: 'Zoho API daily quota exhausted — purchase list NOT saved. Try again after the quota resets.', code: 4000 });
      }
      if (!fd || fd.code !== 9280) { deleteFailed = true; console.error('Error fetching existing rows:', fd || fetchErr.message); }
    }
    // Guard against duplicates: if some old rows could not be removed, do NOT
    // insert on top of them — surface the problem instead.
    if (deleteFailed) {
      return res.status(409).json({ error: 'Could not fully clear existing purchase rows — save aborted to avoid duplicates. Re-try, or delete the rows manually and re-save.', code: 'DELETE_INCOMPLETE' });
    }

    // ── Bulk insert all rows in chunks of up to 100 per call ──
    // (was: a POST per row = M Developer API calls). Creator v2.1 accepts an
    // array under `data` (max 200) and returns a per-record result[] with its
    // own code, so per-row failure reporting is preserved.
    var saved = 0;
    var failures = [];
    var CHUNK = 100;
    for (var c = 0; c < subformRows.length; c += CHUNK) {
      var batch = subformRows.slice(c, c + CHUNK);
      try {
        var postResp = await axios.post(creatorApiBase()+'/form/Project_Material_Allocated_Detail_Form', { data: batch }, { headers: zohoHeaders(token) });
        var body = postResp.data || {};
        // Whole-request failure (e.g. quota 4000) — no per-record result array.
        if (body.code === 4000) {
          return res.status(429).json({ error: 'Zoho API daily quota exhausted — purchase list partially saved (' + saved + '). Try again after the quota resets.', code: 4000, items_saved: saved, items_attempted: subformRows.length });
        }
        var result = body.result || [];
        for (var i = 0; i < batch.length; i++) {
          var rowDesc = batch[i].Item_Description || ('row ' + (c + i + 1));
          var rr = result[i];
          var rc = rr && rr.code;
          // Count as saved on success code OR when a record ID came back (some
          // bulk responses return data.ID without an explicit 3000 per row).
          if (rc === 3000 || (rr && rr.data && rr.data.ID)) {
            saved++;
          } else {
            var detail = (rr && (rr.error || rr.message)) || body.message || rr || body;
            failures.push({ line: c + i + 1, description: rowDesc, code: rc != null ? rc : body.code, message: typeof detail === 'string' ? detail : JSON.stringify(detail) });
            console.error('Row ' + (c + i + 1) + ' rejected (code ' + rc + '):', JSON.stringify(rr || body));
          }
        }
      } catch (postErr) {
        var ed = postErr.response && postErr.response.data;
        if (ed && ed.code === 4000) {
          return res.status(429).json({ error: 'Zoho API daily quota exhausted — purchase list partially saved (' + saved + '). Try again after the quota resets.', code: 4000, items_saved: saved, items_attempted: subformRows.length });
        }
        for (var j = 0; j < batch.length; j++) {
          failures.push({ line: c + j + 1, description: batch[j].Item_Description || ('row ' + (c + j + 1)), code: ed && ed.code, message: ed ? JSON.stringify(ed) : postErr.message });
        }
        console.error('Bulk insert batch failed:', ed || postErr.message);
      }
    }

    console.log('Purchase list save complete: ' + saved + ' rows written, ' + failures.length + ' failed of ' + subformRows.length);
    res.json({ success: true, items_saved: saved, items_attempted: subformRows.length, items_failed: failures.length, failures: failures });
  } catch (err) {
    console.error('Purchase list error:', JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: 'Failed to save purchase list', details: err.response?.data || err.message });
  }
});

app.get('/api/project/:id/purchase-list', async (req, res) => {
  try {
    var token = await getAccessToken();
    var projectId = req.params.id;
    console.log('Fetching purchase list for project:', projectId);
    var reportName = 'Project_Material_Allocated_Detail_Form_Report';
    var url = creatorApiBase() + '/report/' + reportName + '?criteria=(MCP_Customer_Project_Form==' + projectId + ')&limit=200';
    var resp = await axios.get(url, { headers: zohoHeaders(token) });
    var rawRows = resp.data.data || [];
    console.log('Purchase list rows found:', rawRows.length);
    var lines = rawRows.map(function(row, idx) {
      var formType = row.Form_Type || {};
      var materialType = row.Material_Type || {};
      var specification = row.Specification || {};
      var material = row.Material || {};
      var lengthInch = row.Length_INCH || {};
      var widthFt = row.Width_FT || {};
      var widthInch = row.Width_INCH || {};
      return {
        line_item: row.Line_Item || idx + 1,
        form_type_id: formType.ID || formType,
        form_type_name: formType.zc_display_value || formType.display_value || '',
        material_type_id: materialType.ID || materialType,
        material_type_name: materialType.zc_display_value || materialType.display_value || '',
        specification_id: specification.ID || specification,
        spec_name: specification.zc_display_value || specification.display_value || '',
        material_id: material.ID || material,
        material_name: material.zc_display_value || material.display_value || '',
        item_description: row.Item_Description || '',
        item_qty_and_description: row.Item_QTY_and_Description || '',
        description: row.Description || '',
        quantity: parseFloat(row.QTY) || 0,
        feet_length: parseFloat(row.Feet_Length) || 0,
        length_inch_id: lengthInch.ID || lengthInch || '',
        length_inch_display: lengthInch.zc_display_value || lengthInch.display_value || '',
        width_ft_id: widthFt.ID || widthFt || '',
        width_ft_display: widthFt.zc_display_value || widthFt.display_value || '',
        width_inch_id: widthInch.ID || widthInch || '',
        width_inch_display: widthInch.zc_display_value || widthInch.display_value || '',
        weight_per_ft: parseFloat(row.Weight_Per_FT) || 0,
        unit_weight: parseFloat(row.Unit_Weight) || 0,
        total_weight: parseFloat(row.CalcWeight) || parseFloat(row.Total_Weight) || 0,
        price_per_lb: parseFloat(row.Price_Per_LB) || 0,
        unit_price: parseFloat(row.Unit_Price) || 0,
        unit_total: parseFloat(row.Unit_Total) || 0,
        area: parseFloat(row.Area) || 0,
        total_length: parseFloat(row.Total_Length) || 0,
        total_plate_width: parseFloat(row.Total_Plate_Width) || 0,
        material_size: parseFloat(row.Material_Size) || 0,
        row_id: row.ID || null,
      };
    });
    res.json({ project_id: projectId, line_count: lines.length, purchase_lines: lines.sort(function(a, b) { return (a.line_item || 0) - (b.line_item || 0); }) });
  } catch (err) {
    console.error('Error fetching purchase list:', err.response?.data || err.message);
    if (err.response?.data?.code === 9280 || err.response?.status === 404) {
      return res.json({ project_id: req.params.id, line_count: 0, purchase_lines: [] });
    }
    res.status(500).json({ error: 'Failed to fetch purchase list', details: err.response?.data || err.message });
  }
});

app.get('/api/project/:id/nesting-results', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    var runResp;
    try {
      runResp = await axios.get(creatorApiBase()+'/report/Nesting_Run_Header_Report?criteria=(Project_Lookup=='+projectId+')&limit=10', { headers: zohoHeaders(token) });
    } catch (e) {
      if (e.response?.data?.code === 9280 || e.response?.status === 404) {
        return res.json({ found: false, message: 'No approved nesting run found' });
      }
      throw e;
    }
    var runs = (runResp.data.data || []).filter(function(r) { return r.Run_Status === 'Approved'; });
    if (runs.length === 0) { return res.json({ found: false, message: 'No approved nesting run found' }); }
    runs.sort(function(a, b) { return (parseInt(b.Run_Number) || 0) - (parseInt(a.Run_Number) || 0); });
    var runHeader = runs[0];
    var nestRunID = runHeader.ID;
    console.log('Loading nesting run:', nestRunID, 'Run #'+runHeader.Run_Number);
    var stockResults = [];
    var startIndex = 0;
    var hasMore = true;
    while (hasMore) {
      try {
        var srUrl = creatorApiBase()+'/report/Nesting_Stock_Results?criteria=(Nesting_Run_Header=='+nestRunID+')&limit=200';
        if (startIndex > 0) srUrl += '&from='+startIndex;
        var srResp = await axios.get(srUrl, { headers: zohoHeaders(token) });
        var batch = srResp.data.data || [];
        stockResults = stockResults.concat(batch);
        hasMore = batch.length === 200;
        startIndex += 200;
      } catch (e) {
        if (e.response?.data?.code === 9280) hasMore = false;
        else throw e;
      }
    }
    function safeStr(val) { if (val === null || val === undefined) return ''; if (typeof val === 'object') return val.zc_display_value || val.display_value || val.ID || ''; return String(val); }
    function safeId(val) { if (val === null || val === undefined) return ''; if (typeof val === 'object') return val.ID || val.zc_display_value || ''; return String(val); }
    if (stockResults.length === 0) {
      return res.json({ found: true, run_header: { id: nestRunID, run_number: parseInt(runHeader.Run_Number) || 1, run_date: safeStr(runHeader.Run_Date), run_status: safeStr(runHeader.Run_Status), run_by: safeStr(runHeader.Run_By), notes: safeStr(runHeader.Notes) }, results_1d: [], results_2d: [], summary: { total_stock_pieces: 0, avg_waste_pct_1d: 0, errors: [] }, _nameLookup: {} });
    }
    var stockResultIds = stockResults.map(function(sr) { return sr.ID; });
    var allCutDetails = [];
    for (var i = 0; i < stockResultIds.length; i++) {
      try {
        var cdResp = await axios.get(creatorApiBase()+'/report/All_Nesting_Cut_Details?criteria=(Nesting_Stock_Result_Lookup=='+stockResultIds[i]+')&limit=200', { headers: zohoHeaders(token) });
        var cuts = cdResp.data.data || [];
        cuts.forEach(function(c) { c._stock_result_id = stockResultIds[i]; });
        allCutDetails = allCutDetails.concat(cuts);
      } catch (e) { if (e.response?.data?.code !== 9280) { console.error('Cut detail fetch error for SR', stockResultIds[i], ':', e.response?.data || e.message); } }
    }
    var cutsByStock = {};
    allCutDetails.forEach(function(cd) { var srId = cd._stock_result_id; if (!cutsByStock[srId]) cutsByStock[srId] = []; cutsByStock[srId].push(cd); });
    var results_1d = [];
    var results_2d = [];
    var nameLookup = {};
    var totalWaste1d = 0;
    var count1d = 0;
    stockResults.forEach(function(sr) {
      var nestType = safeStr(sr.Nesting_Type);
      var formType = sr.Form_Type || {};
      var materialType = sr.Material_Type || {};
      var specification = sr.Specification || {};
      var material = sr.Material || {};
      var formTypeId = safeId(formType);
      var materialTypeId = safeId(materialType);
      var specId = safeId(specification);
      var materialId = safeId(material);
      var ftName = (typeof formType === 'object') ? (formType.zc_display_value || formType.display_value || '') : '';
      var mtName = (typeof materialType === 'object') ? (materialType.zc_display_value || materialType.display_value || '') : '';
      var spName = (typeof specification === 'object') ? (specification.zc_display_value || specification.display_value || '') : '';
      var matName = (typeof material === 'object') ? (material.zc_display_value || material.display_value || '') : '';
      if (formTypeId && ftName) nameLookup[formTypeId] = ftName;
      if (materialTypeId && mtName) nameLookup[materialTypeId] = mtName;
      if (specId && spName) nameLookup[specId] = spName;
      if (materialId && matName) nameLookup[materialId] = matName;
      var srCuts = cutsByStock[sr.ID] || [];
      srCuts.sort(function(a, b) { return (parseInt(a.Cut_Sequence) || 0) - (parseInt(b.Cut_Sequence) || 0); });
      var cuts = srCuts.map(function(cd) {
        var bomLineLookup = cd.BOM_Line_Lookup || {};
        var rotationStr = safeStr(cd.Rotation) || '0';
        var rotation = parseInt(rotationStr) || 0;
        return { bom_line_id: safeId(bomLineLookup), part_mark: safeStr(cd.Part_Mark), cut_length: parseFloat(cd.Cut_Length) || 0, cut_width: parseFloat(cd.Cut_Width) || 0, cut_weight: parseFloat(cd.Cut_Weight) || 0, quantity_on_this_stock: parseInt(cd.Quantity_On_This_Stock) || 1, x_position: parseFloat(cd.X_Position) || 0, y_position: parseFloat(cd.Y_Position) || 0, rotation: rotation, cut_sequence: parseInt(cd.Cut_Sequence) || 0, spec_name: specId, material_type: materialId };
      });
      var stockLength = parseFloat(sr.Stock_Length) || 0;
      var stockWidth = parseFloat(sr.Stock_Width) || 0;
      var wastePercentage = parseFloat(sr.Waste_Percentage) || 0;
      var remnantLength = parseFloat(sr.Remnant_Length) || 0;
      var remnantArea = parseFloat(sr.Remnant_Area) || 0;
      var resultObj = { stock_result_id: safeStr(sr.ID), form_type: formTypeId, material_origin: materialTypeId, stock_length_in: stockLength, stock_label: safeStr(sr.Stock_Size_Label) || (ftName + ' | ' + mtName), waste_percentage: wastePercentage, stock_weight_lbs: parseFloat(sr.Stock_Weight_LBS) || 0, stock_sequence: parseInt(sr.Stock_Sequence) || 0, grain_direction: safeStr(sr.Grain_Direction), cuts: cuts };
      if (nestType.indexOf('1D') >= 0 || nestType.indexOf('Linear') >= 0) { resultObj.remnant_length_in = remnantLength; results_1d.push(resultObj); totalWaste1d += wastePercentage; count1d++; }
      else if (nestType.indexOf('2D') >= 0 || nestType.indexOf('Panel') >= 0) { resultObj.stock_width_in = stockWidth; resultObj.remnant_area_in2 = remnantArea; results_2d.push(resultObj); }
    });
    results_1d.sort(function(a, b) { return a.stock_sequence - b.stock_sequence; });
    results_2d.sort(function(a, b) { return a.stock_sequence - b.stock_sequence; });
    var avgWaste1d = count1d > 0 ? totalWaste1d / count1d : 0;
    res.json({ found: true, run_header: { id: nestRunID, run_number: parseInt(runHeader.Run_Number) || 1, run_date: safeStr(runHeader.Run_Date), run_status: safeStr(runHeader.Run_Status), run_by: safeStr(runHeader.Run_By), kerf_1d: parseFloat(runHeader.Kerf_1D) || 0, kerf_2d: parseFloat(runHeader.Kerf_2D) || 0, notes: (typeof runHeader.Notes === 'object') ? '' : (runHeader.Notes || ''), total_stock_pieces: parseInt(runHeader.Total_Stock_Pieces) || (results_1d.length + results_2d.length) }, results_1d: results_1d, results_2d: results_2d, summary: { total_stock_pieces: results_1d.length + results_2d.length, avg_waste_pct_1d: Math.round(avgWaste1d * 10) / 10, errors: [] }, _nameLookup: nameLookup });
  } catch (err) {
    console.error('Error fetching nesting results:', err.response?.data || err.message);
    if (err.response?.data?.code === 9280 || err.response?.status === 404) { return res.json({ found: false, message: 'No nesting results found' }); }
    res.status(500).json({ error: 'Failed to fetch nesting results', details: err.response?.data || err.message });
  }
});

// Debug MFG
app.get('/api/debug-mfg', async (req, res) => {
  try {
    const token = await getAccessToken();
    const base  = creatorApiBase();
    const hdrs  = zohoHeaders(token);
    const resp  = await axios.get(`${base}/report/Customer_Entry_Report?limit=5`, { headers: hdrs });
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Match Suggestions
const geoCache = {};

async function getLatLng(postalCode, country) {
  if (!postalCode) return null;
  const key = postalCode.trim();
  if (geoCache[key]) return geoCache[key];
  try {
    const cc = (country && country.toLowerCase().includes('canada')) ? 'ca' : 'us';
    const resp = await axios.get(`https://api.zippopotam.us/${cc}/${key}`, { timeout: 5000 });
    if (resp.data.places && resp.data.places.length > 0) {
      const result = {
        lat: parseFloat(resp.data.places[0].latitude),
        lng: parseFloat(resp.data.places[0].longitude)
      };
      geoCache[key] = result;
      return result;
    }
    return null;
  } catch (e) {
    console.log('Geocode failed for zip:', key, e.message);
    return null;
  }
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreMatch({ mode, supplierStock, supplierFitStock, mfgShape, mfgMaterial, mfgSpec, ftType, ftMake, ftEnd, ftConn, ftSpec, supplierCaps, distanceMi, radius, quoteCount, checkedCaps }) {
  const norm = v => String(v == null ? '' : v).trim().toLowerCase();
  const lid  = f => (f && typeof f === 'object') ? String(f.ID || f.id || '') : String(f == null ? '' : f);
  const lname = f => (f && typeof f === 'object') ? String(f.zc_display_value || f.display_value || f.Form_Type || f.Material_Type || f.Type_Detail || f.Fitting_Type || f.Fitting_Make || f.End_Type || f.Connection_Type || f.Fitting_Specification || f.value || '') : String(f == null ? '' : f);
  // search value matches a lookup field if it equals the field's ID OR display name;
  // an empty search axis is a wildcard (don't filter on it).
  const eqW = (search, field) => { const s = norm(search); return s === '' || s === norm(lid(field)) || s === norm(lname(field)); };
  const provided = (...vals) => vals.some(v => norm(v) !== '');

  let stockScore = 0;
  if (mode === 'fittings') {
    const isStkF = s => Array.isArray(s.Fitting_Stocked_Checkbox) ? s.Fitting_Stocked_Checkbox.includes('Stocked') : (s.Fitting_Stocked_Checkbox === 'Stocked' || s.Fitting_Stocked_Checkbox === true);
    const stocked = (supplierFitStock || []).filter(isStkF);
    if (provided(ftType, ftMake, ftEnd, ftConn, ftSpec)) {
      const exact = stocked.some(s => eqW(ftType, s.Fitting_Type) && eqW(ftMake, s.Fitting_Make) && eqW(ftEnd, s.End_Type) && eqW(ftConn, s.Connection_Type) && eqW(ftSpec, s.Fitting_Specification));
      const cat   = stocked.some(s => eqW(ftType, s.Fitting_Type) && eqW(ftMake, s.Fitting_Make));
      stockScore = exact ? 1.0 : cat ? 0.5 : 0;
    }
  } else {
    const isStk = s => Array.isArray(s.Material_Stocked) ? s.Material_Stocked.includes('Stocked') : (s.Material_Stocked === 'Stocked' || s.Material_Stocked === true);
    const stocked = (supplierStock || []).filter(isStk);
    if (provided(mfgShape, mfgMaterial, mfgSpec)) {
      const exact = stocked.some(s => eqW(mfgShape, s.Form_Type) && eqW(mfgMaterial, s.Material_Type) && eqW(mfgSpec, s.Type_Detail_LU));
      const cat   = stocked.some(s => eqW(mfgShape, s.Form_Type) && eqW(mfgMaterial, s.Material_Type));
      stockScore = exact ? 1.0 : cat ? 0.5 : 0;
    }
  }
  const supCapNames = supplierCaps.map(c => (c.Supplier_Process?.Capabilities || '').toLowerCase()).filter(Boolean);
  let capScore = 0;
  if (checkedCaps.length > 0) {
    const matches = checkedCaps.filter(c => supCapNames.indexOf(c) !== -1).length;
    capScore = matches / checkedCaps.length;
  }
  const distanceScore = Math.max(0, 1 - (distanceMi / radius));
  const historyScore = quoteCount > 0 ? Math.min(Math.log10(quoteCount + 1) / Math.log10(11), 1) : 0;
  const total = (stockScore * 0.50) + (capScore * 0.20) + (distanceScore * 0.15) + (historyScore * 0.15);
  return {
    total: Math.round(total * 100),
    breakdown: {
      stockMatch:   Math.round(stockScore    * 100),
      capabilities: Math.round(capScore      * 100),
      distance:     Math.round(distanceScore * 100),
      history:      Math.round(historyScore  * 100)
    }
  };
}

// Public fitting catalog for the Match Hub widget (MFG-side, no supplier auth).
// Returns the 5 cascade tables; shares the 'fitting-catalog' cache key with the
// supplier endpoint so a warm cache costs zero extra Zoho calls.
app.get('/api/fitting-catalog', async (req, res) => {
  const lkId = (r, key) => (r[key] && r[key].ID) || r[key + '.ID'] || '';
  try {
    const cat = await cachedLookup('fitting-catalog', 60 * 60 * 1000, async () => {
      const [types, makes, ends, conns, specs] = await Promise.all([
        fetchAllZohoPages('/report/Fitting_Type_Report'),
        fetchAllZohoPages('/report/Fitting_Make_Report'),
        fetchAllZohoPages('/report/End_Type_Report'),
        fetchAllZohoPages('/report/Connection_Type_Report'),
        fetchAllZohoPages('/report/Fitting_Specification_Report'),
      ]);
      return {
        types: (types || []).map(r => ({ id: String(r.ID), name: r.Fitting_Type || '' })).filter(x => x.name),
        makes: (makes || []).map(r => ({ id: String(r.ID), name: r.Fitting_Make || '' })).filter(x => x.name),
        ends: (ends || []).map(r => ({ id: String(r.ID), name: r.End_Type || '', type_id: String(lkId(r, 'Fitting_Type')) })),
        connections: (conns || []).map(r => ({ id: String(r.ID), name: r.Connection_Type || '', type_id: String(lkId(r, 'Fitting_Type')) })),
        specs: (specs || []).map(r => ({ id: String(r.ID), name: r.Fitting_Specification || '', make_id: String(lkId(r, 'Fitting_Make')) })),
      };
    });
    res.json({ ok: true, catalog: cat });
  } catch (err) {
    console.error('Fitting catalog error:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/match-suggestions', async (req, res) => {
  const { mfg_id, radius = 150, shape = '', material = '', spec = '', caps = '' } = req.query;
  const mode = req.query.mode === 'fittings' ? 'fittings' : 'structural';
  const ft_type = req.query.ft_type || '', ft_make = req.query.ft_make || '', ft_end = req.query.ft_end || '', ft_conn = req.query.ft_conn || '', ft_spec = req.query.ft_spec || '';
  const checkedCaps = caps ? caps.split(',').map(c => c.trim().toLowerCase()).filter(Boolean) : [];
  if (!mfg_id) return res.status(400).json({ error: 'mfg_id required' });
  try {
    const token = await getAccessToken();
    const base  = creatorApiBase();
    const hdrs  = zohoHeaders(token);

    // 1. MFG record — fetch all and find by ID (criteria filter unreliable on this report)
    const mfgResp = await axios.get(
      `${base}/report/Customer_Entry_Report?limit=200`,
      { headers: hdrs }
    );
    const mfg = (mfgResp.data.data || []).find(r => String(r.ID) === String(mfg_id));
    if (!mfg) return res.status(404).json({ error: 'MFG not found — ID: ' + mfg_id });

    // 2. Geocode MFG by zip
    const mfgZip = mfg.Address?.postal_code;
    const mfgCountry = mfg.Address?.country;
    const mfgGeo = await getLatLng(mfgZip, mfgCountry);
    if (!mfgGeo) return res.status(400).json({ error: 'Could not geocode MFG zip: ' + mfgZip });

    // 3. Quote history
    const rfqResp = await axios.get(
      `${base}/report/All_RFQs_Sent_Report?criteria=(Customer_LU==${mfg_id})&limit=200`,
      { headers: hdrs }
    ).catch(() => ({ data: { data: [] } }));
    const quoteHistory = {};
    for (const rfq of (rfqResp.data.data || [])) {
      const sid = rfq.Supplier_LU?.ID;
      if (sid) quoteHistory[sid] = (quoteHistory[sid] || 0) + 1;
    }

    // 4. All registered suppliers
    const supResp = await axios.get(
      `${base}/report/All_Suppliers_Entry_Report?criteria=(Register=="Yes")&limit=200`,
      { headers: hdrs }
    );
    const suppliers = supResp.data.data || [];

    // 5. Fetch data for each supplier in radius (no scoring yet)
    const rawResults = await Promise.all(suppliers.map(async (sup) => {
      const supZip     = sup.Address?.postal_code;
      const supCountry = sup.Address?.country;
      const supGeo     = await getLatLng(supZip, supCountry);
      if (!supGeo) return null;

      const distanceMi = haversine(mfgGeo.lat, mfgGeo.lng, supGeo.lat, supGeo.lng);
      if (distanceMi > parseFloat(radius)) return null;

      // Stock fetch via fetchAllZohoPages (cursor pagination). The previous raw
      // `&limit=1000` was REJECTED by Zoho v2.1 (code 2945 MORE_THAN_MAX_LENGTH,
      // max 200/page) and the .catch swallowed it → empty stock for every supplier
      // → 0% stock match in both modes. fetchAllZohoPages pages at 200 correctly.
      const stockReport = mode === 'fittings'
        ? `Supplier_Fitting_Stock_All?criteria=(Supplier_ID==${sup.ID})`
        : `Stocked_Material_List?criteria=(Supplier_ID==${sup.ID})`;
      const [supplierStock, capResp] = await Promise.all([
        fetchAllZohoPages(`/report/${stockReport}`).catch(() => []),
        axios.get(
          `${base}/report/Capabilities_Processes_Per_Supplier_Report?criteria=(Supplier_Entry_Form==${sup.ID})&limit=200`,
          { headers: hdrs }
        ).catch(() => ({ data: { data: [] } }))
      ]);

      const supplierCaps  = capResp.data.data  || [];

      return { sup, distanceMi, supplierStock, supplierCaps };
    }));

    // 6. Score each supplier
    const inRadius = rawResults.filter(Boolean);
    const results = inRadius.map(({ sup, distanceMi, supplierStock, supplierCaps }) => {
      const supCapNames = supplierCaps.map(c => (c.Supplier_Process?.Capabilities || '').toLowerCase()).filter(Boolean);
      const score = scoreMatch({
        mode,
        supplierStock:    mode === 'structural' ? supplierStock : [],
        supplierFitStock: mode === 'fittings' ? supplierStock : [],
        mfgShape:     shape,
        mfgMaterial:  material,
        mfgSpec:      spec,
        ftType: ft_type, ftMake: ft_make, ftEnd: ft_end, ftConn: ft_conn, ftSpec: ft_spec,
        supplierCaps,
        distanceMi,
        radius:       parseFloat(radius),
        quoteCount:   quoteHistory[sup.ID] || 0,
        checkedCaps
      });

      return {
        id:          sup.ID,
        name:        sup.Company_Name,
        address:     sup.Address,
        distanceMi:  Math.round(distanceMi),
        score:       score.total,
        breakdown:   score.breakdown,
        mainContact: sup.Main_Contact_Name,
        phone:       sup.Phone,
        email:       sup.Email,
        stockCount:  supplierStock.length,
        capCount:    supplierCaps.length,
        capNames:    supCapNames
      };
    });

    const filtered = results.sort((a, b) => b.score - a.score);

    res.json({
      mfg_id,
      radius,
      mode,
      searchCriteria: { mode, shape, material, spec, ft_type, ft_make, ft_end, ft_conn, ft_spec },
      count: filtered.length,
      results: filtered
    });

  } catch (err) {
    console.error('Match suggestions error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Debug Stock
app.get('/api/debug-stock', async (req, res) => {
  try {
    const token = await getAccessToken();
    const resp = await axios.get(
      `${creatorApiBase()}/report/Stocked_Material_List?criteria=(Supplier_ID==4111484000000994005)&limit=3`,
      { headers: zohoHeaders(token) }
    );
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// ============================================================
// Standalone Nesting Tool endpoints
// ============================================================

// Cascade lookup endpoints — feed the manual-entry dropdowns
app.get('/api/lookups/length-inch', async (req, res) => {
  try {
    const token = await getAccessToken();
    const resp = await axios.get(creatorApiBase()+'/report/All_Length_Inch_Lookups?limit=200', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => ({
      id: row.ID,
      description: row.Description || '',
      result: parseFloat(row.Result) || 0
    })).sort((a, b) => a.result - b.result));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch length inch lookup', details: err.response?.data || err.message }); }
});

app.get('/api/lookups/plate-widths', async (req, res) => {
  try {
    const token = await getAccessToken();
    const resp = await axios.get(creatorApiBase()+'/report/All_Plate_Standard_Sizes?limit=200', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => {
      let widthFt = parseFloat(row.Width_Ft) || parseFloat(row.Width_ft) || 0;
      if (!widthFt && row.Description) {
        const m = (row.Description || '').match(/^(\d+)/);
        if (m) widthFt = parseInt(m[1]);
      }
      return { id: row.ID, description: row.Description || '', width_ft: widthFt };
    }).sort((a, b) => a.width_ft - b.width_ft));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch plate widths', details: err.response?.data || err.message }); }
});

app.get('/api/lookups/form-types', async (req, res) => {
  try {
    const token = await getAccessToken();
    const resp = await axios.get(creatorApiBase()+'/report/Form_Types_Report?limit=200', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => ({
      id: row.ID,
      name: row.Form_Type || row.zc_display_value || row.display_value || '',
      category: row.Category || '',
      measurement: row.Measurement || '' // 'Linear' or 'Panel' — drives nest_type default in standalone widget
    })));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch form types', details: err.response?.data || err.message }); }
});

app.get('/api/lookups/material-types', async (req, res) => {
  try {
    const token = await getAccessToken();
    const resp = await axios.get(creatorApiBase()+'/report/Material_Types_Report?limit=200', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => ({ id: row.ID, name: row.Material_Type || row.zc_display_value || row.display_value || '' })));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch material types', details: err.response?.data || err.message }); }
});

app.get('/api/lookups/specifications', async (req, res) => {
  try {
    const { form_type_id, material_type_id } = req.query;
    if (!form_type_id || !material_type_id) return res.status(400).json({ error: 'form_type_id and material_type_id required' });
    const token = await getAccessToken();
    const criteria = '(Form_Type=='+form_type_id+'%26%26Material_Type=='+material_type_id+')';
    const resp = await axios.get(creatorApiBase()+'/report/Material_Form_Detail_Report?criteria='+criteria+'&limit=200', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => ({ id: row.ID, name: row.Type_Detail || row.zc_display_value || row.display_value || '' })));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch specifications', details: err.response?.data || err.message }); }
});

app.get('/api/lookups/materials', async (req, res) => {
  try {
    const { form_type_id, material_type_id } = req.query;
    if (!form_type_id || !material_type_id) return res.status(400).json({ error: 'form_type_id and material_type_id required' });
    const token = await getAccessToken();
    const criteria = '(Form_Types=='+form_type_id+'%26%26Material_Types=='+material_type_id+')';
    const resp = await axios.get(creatorApiBase()+'/report/Beam_Channel_Tee_Lookup_Report?criteria='+criteria+'&limit=500', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => ({
      id: row.ID,
      name: row.Description || row.zc_display_value || row.display_value || '',
      weight_per_ft: parseFloat(row.Weight_Lb_Ft) || 0,
      dim1: parseFloat(row.Dim1) || 0,
      density: parseFloat(row.Density) || 0
    })));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch materials', details: err.response?.data || err.message }); }
});

// POST standalone save-results — mirrors /api/project/:id/save-results but no project context
app.post('/api/standalone/save-results', async (req, res) => {
  try {
    const token = await getAccessToken();
    const {
      manufacturer_id,
      nest_source,
      parts,
      results_1d,
      results_2d,
      summary,
      kerf_1d,
      kerf_2d,
      run_title,
      run_notes,
      created_by
    } = req.body;

    if (!manufacturer_id) return res.status(400).json({ error: 'manufacturer_id required' });
    if (!nest_source || !['Manual', 'CSV'].includes(nest_source)) return res.status(400).json({ error: 'nest_source must be "Manual" or "CSV"' });
    if (!Array.isArray(parts) || parts.length === 0) return res.status(400).json({ error: 'parts array required' });

    // Build a map of parts by client-side temp id (used as bom_line_id in cuts)
    const partsByClientId = {};
    parts.forEach(p => { if (p.client_part_id) partsByClientId[p.client_part_id] = p; });

    function getPartData(result) {
      const id = result.cuts?.[0]?.bom_line_id;
      if (!id) return { weight_per_ft: 0, thickness: 0, form_type_id: null, material_type_id: null, specification_id: null, material_id: null };
      const p = partsByClientId[id];
      if (!p) return { weight_per_ft: 0, thickness: 0, form_type_id: null, material_type_id: null, specification_id: null, material_id: null };
      return {
        weight_per_ft: parseFloat(p.weight_per_ft) || 0,
        thickness: parseFloat(p.dim1) || 0,
        density: parseFloat(p.density) || 0,
        form_type_id: p.form_type_id || null,
        material_type_id: p.material_type_id || null,
        specification_id: p.specification_id || null,
        material_id: p.material_id || null
      };
    }
    function calcStockWt(r, wpf) {
      if (!wpf || !r.stock_length_in) return 0;
      return r.stock_width_in ? Math.round((r.stock_length_in * r.stock_width_in / 144) * wpf * 100) / 100 : Math.round(wpf * (r.stock_length_in / 12) * 100) / 100;
    }

    // Count existing standalone runs for this manufacturer to set Run_Number
    let existingRuns = [];
    try {
      const rr = await axios.get(creatorApiBase()+'/report/Nesting_Run_Header_Report?criteria=(Run_By=='+manufacturer_id+'%26%26(Nest_Source="Manual"%7C%7CNest_Source="CSV"))&limit=200', { headers: zohoHeaders(token) });
      existingRuns = rr.data.data || [];
    } catch (e) { if (e.response?.data?.code === 9280) existingRuns = []; else throw e; }

    const now = new Date();
    const rd = (now.getMonth()+1).toString().padStart(2,'0')+'/'+now.getDate().toString().padStart(2,'0')+'/'+now.getFullYear()+' '+now.toTimeString().slice(0,8);
    const hd = {
      Run_Number: existingRuns.length + 1,
      Run_Date: rd,
      Run_Status: 'Approved',
      Run_By: manufacturer_id,
      Nest_Source: nest_source,
      Added_User: created_by || 'web_app'
    };
    if (run_title) hd.Run_Title = run_title;
    if (run_notes) hd.Run_Notes = run_notes;
    if (created_by) hd.Created_By = created_by;
    if (kerf_1d !== undefined) hd.Kerf_1D = kerf_1d;
    if (kerf_2d !== undefined) hd.Kerf_2D = kerf_2d;

    const hr = await axios.post(creatorApiBase()+'/form/Nesting_Run_Header', { data: hd }, { headers: zohoHeaders(token) });
    const nestRunID = hr.data.data.ID;

    // Save Nesting_Run_Part records (one per input part)
    let savedParts = 0;
    for (const p of parts) {
      try {
        const pd = {
          Nesting_Run: nestRunID,
          Tag: p.tag || '',
          Component: p.component || '',
          Drawing: p.drawing || '',
          QTY: parseFloat(p.quantity) || 0,
          Length_FT: parseFloat(p.length_ft) || 0,
          Galv: p.galv ? 'true' : 'false',
          Plate_SA: p.plate_sa ? 'true' : 'false',
          Nest_Type: p.nest_type || 'Linear'
        };
        if (p.form_type_id) pd.Form_Type = p.form_type_id;
        if (p.material_type_id) pd.Material_Type = p.material_type_id;
        if (p.specification_id) pd.Specification = p.specification_id;
        if (p.material_id) pd.Material = p.material_id;
        if (p.length_inch_id) pd.Length_INCH = p.length_inch_id;
        if (p.width_ft_id) pd.Width_FT = p.width_ft_id;
        if (p.width_inch_id) pd.Width_INCH = p.width_inch_id;
        await axios.post(creatorApiBase()+'/form/Nesting_Run_Part', { data: pd }, { headers: zohoHeaders(token) });
        savedParts++;
      } catch (e) { console.error('Run_Part save error:', e.response?.data || e.message); }
    }

    let s1d = 0;
    for (const result of results_1d || []) {
      if (result.error || !result.cuts?.length) continue;
      try {
        const pd = getPartData(result);
        const cuts = result.cuts.map((c, i) => ({
          Part_Mark: c.part_mark,
          Cut_Length: c.cut_length,
          Cut_Weight: c.cut_length ? Math.round(pd.weight_per_ft * (c.cut_length / 12) * 10000) / 10000 : 0,
          Quantity_On_This_Stock: c.quantity_on_this_stock,
          Cut_Sequence: i + 1
        }));
        const saveData1d = {
          Nesting_Run_Header: nestRunID,
          Nesting_Type: '1D - Linear',
          Form_Type: pd.form_type_id || result.form_type,
          Material_Type: pd.material_type_id || result.material_origin,
          Specification: pd.specification_id || result.cuts[0].spec_name,
          Material: pd.material_id || result.cuts[0].material_type,
          Stock_Size_Label: result.stock_label || '',
          Stock_Length: result.stock_length_in,
          Stock_Thickness: pd.thickness || 0,
          Remnant_Length: Math.round((result.remnant_length_in || 0) * 100) / 100,
          Waste_Percentage: result.waste_percentage,
          Stock_Weight_LBS: calcStockWt(result, pd.weight_per_ft),
          Stock_Sequence: s1d + 1,
          Nesting_Cut_Detail: cuts
        };
        await axios.post(creatorApiBase()+'/form/Nesting_Stock_Result', { data: saveData1d }, { headers: zohoHeaders(token) });
        s1d++;
      } catch (e) { console.error('Standalone 1D save error:', e.response?.data || e.message); }
    }

    let s2d = 0;
    for (const result of results_2d || []) {
      if (result.error || !result.cuts?.length) continue;
      try {
        const pd = getPartData(result);
        const degreeSign = String.fromCharCode(176);
        const cuts = result.cuts.map((c, i) => ({
          Part_Mark: c.part_mark,
          Cut_Length: c.cut_length,
          Cut_Width: c.cut_width,
          Cut_Weight: (c.cut_length && c.cut_width) ? Math.round((c.cut_length * c.cut_width / 144) * pd.weight_per_ft * 10000) / 10000 : 0,
          Quantity_On_This_Stock: c.quantity_on_this_stock,
          X_Position: c.x_position || 0,
          Y_Position: c.y_position || 0,
          Rotation: c.rotation === 90 ? '90'+degreeSign : '0'+degreeSign,
          Cut_Sequence: i + 1
        }));
        const saveData2d = {
          Nesting_Run_Header: nestRunID,
          Nesting_Type: '2D - Panel',
          Form_Type: pd.form_type_id || result.form_type,
          Material_Type: pd.material_type_id || result.material_origin,
          Specification: pd.specification_id || result.cuts[0].spec_name,
          Material: pd.material_id || result.cuts[0].material_type,
          Stock_Size_Label: result.stock_label || '',
          Stock_Length: result.stock_length_in,
          Stock_Width: result.stock_width_in,
          Stock_Thickness: pd.thickness || 0,
          Grain_Direction: result.grain_direction || '',
          Remnant_Area: result.remnant_area_in2 || 0,
          Waste_Percentage: result.waste_percentage,
          Stock_Weight_LBS: calcStockWt(result, pd.weight_per_ft),
          Stock_Sequence: s2d + 1,
          Nesting_Cut_Detail: cuts
        };
        await axios.post(creatorApiBase()+'/form/Nesting_Stock_Result', { data: saveData2d }, { headers: zohoHeaders(token) });
        s2d++;
      } catch (e) { console.error('Standalone 2D save error:', e.response?.data || e.message); }
    }

    try {
      await axios.patch(creatorApiBase()+'/report/Nesting_Run_Header_Report/'+nestRunID, { data: {
        Total_Stock_Pieces: s1d + s2d,
        Total_Waste_Inches: Math.round((summary?.total_remnant_length_in || 0) * 10000) / 10000,
        Notes: 'Standalone ('+nest_source+') — Saved '+s1d+' 1D + '+s2d+' 2D | '+savedParts+' input parts | Waste: '+(summary?.avg_waste_pct_1d || 0)+'%'
      } }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
    } catch (e) { console.error('Standalone header patch failed'); }

    res.json({
      success: true,
      nest_run_id: nestRunID,
      run_number: existingRuns.length + 1,
      run_status: 'Approved',
      nest_source: nest_source,
      saved_parts: savedParts,
      saved_1d: s1d,
      saved_2d: s2d
    });
  } catch (err) {
    console.error('Standalone save error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to save standalone results', details: err.response?.data || err.message });
  }
});

// GET previous standalone nest runs for this manufacturer (shared across users)
app.get('/api/standalone/nesting-results', async (req, res) => {
  try {
    const { manufacturer_id, run_id } = req.query;
    if (!manufacturer_id) return res.status(400).json({ error: 'manufacturer_id required' });
    const token = await getAccessToken();

    var runHeader = null;
    var nestRunID = null;

    if (run_id) {
      // Load a specific saved run by ID
      try {
        const rr = await axios.get(creatorApiBase()+'/report/Nesting_Run_Header_Report/'+run_id, { headers: zohoHeaders(token) });
        runHeader = rr.data.data;
        nestRunID = runHeader?.ID;
      } catch (e) {
        if (e.response?.data?.code === 9280 || e.response?.status === 404) return res.json({ found: false, message: 'Run not found' });
        throw e;
      }
    } else {
      // Load most recent standalone run for this manufacturer
      var runResp;
      try {
        runResp = await axios.get(creatorApiBase()+'/report/Nesting_Run_Header_Report?criteria=(Run_By=='+manufacturer_id+'%26%26(Nest_Source="Manual"%7C%7CNest_Source="CSV")%26%26Run_Status="Approved")&limit=10', { headers: zohoHeaders(token) });
      } catch (e) {
        if (e.response?.data?.code === 9280 || e.response?.status === 404) return res.json({ found: false, message: 'No standalone nest runs found' });
        throw e;
      }
      var runs = runResp.data.data || [];
      if (runs.length === 0) return res.json({ found: false, message: 'No standalone nest runs found' });
      runs.sort(function(a, b) { return (parseInt(b.Run_Number) || 0) - (parseInt(a.Run_Number) || 0); });
      runHeader = runs[0];
      nestRunID = runHeader.ID;
    }

    function safeStr(val) { if (val === null || val === undefined) return ''; if (typeof val === 'object') return val.zc_display_value || val.display_value || val.ID || ''; return String(val); }
    function safeId(val) { if (val === null || val === undefined) return ''; if (typeof val === 'object') return val.ID || val.zc_display_value || ''; return String(val); }

    // Load input parts (Nesting_Run_Part)
    var inputParts = [];
    try {
      const pResp = await axios.get(creatorApiBase()+'/report/All_Nesting_Run_Parts?criteria=(Nesting_Run=='+nestRunID+')&limit=500', { headers: zohoHeaders(token) });
      inputParts = (pResp.data.data || []).map(function(row) {
        return {
          id: row.ID,
          tag: safeStr(row.Tag),
          component: safeStr(row.Component),
          drawing: safeStr(row.Drawing),
          form_type_id: safeId(row.Form_Type),
          form_type_name: safeStr(row.Form_Type),
          material_type_id: safeId(row.Material_Type),
          material_type_name: safeStr(row.Material_Type),
          specification_id: safeId(row.Specification),
          spec_name: safeStr(row.Specification),
          material_id: safeId(row.Material),
          material_name: safeStr(row.Material),
          quantity: parseFloat(row.QTY) || 0,
          length_ft: parseFloat(row.Length_FT) || 0,
          length_inch_id: safeId(row.Length_INCH),
          length_inch_display: safeStr(row.Length_INCH),
          width_ft_id: safeId(row.Width_FT),
          width_ft_display: safeStr(row.Width_FT),
          width_inch_id: safeId(row.Width_INCH),
          width_inch_display: safeStr(row.Width_INCH),
          galv: safeStr(row.Galv) === 'true',
          plate_sa: safeStr(row.Plate_SA) === 'true',
          nest_type: safeStr(row.Nest_Type)
        };
      });
    } catch (e) { if (e.response?.data?.code !== 9280) console.error('Input parts fetch error:', e.response?.data || e.message); }

    // Load stock results + cuts (mirrors project nesting-results)
    var stockResults = [];
    var startIndex = 0, hasMore = true;
    while (hasMore) {
      try {
        var srUrl = creatorApiBase()+'/report/Nesting_Stock_Results?criteria=(Nesting_Run_Header=='+nestRunID+')&limit=200';
        if (startIndex > 0) srUrl += '&from='+startIndex;
        var srResp = await axios.get(srUrl, { headers: zohoHeaders(token) });
        var batch = srResp.data.data || [];
        stockResults = stockResults.concat(batch);
        hasMore = batch.length === 200;
        startIndex += 200;
      } catch (e) {
        if (e.response?.data?.code === 9280) hasMore = false;
        else throw e;
      }
    }

    var stockResultIds = stockResults.map(function(sr) { return sr.ID; });
    var allCutDetails = [];
    for (var i = 0; i < stockResultIds.length; i++) {
      try {
        var cdResp = await axios.get(creatorApiBase()+'/report/All_Nesting_Cut_Details?criteria=(Nesting_Stock_Result_Lookup=='+stockResultIds[i]+')&limit=200', { headers: zohoHeaders(token) });
        var cuts = cdResp.data.data || [];
        cuts.forEach(function(c) { c._stock_result_id = stockResultIds[i]; });
        allCutDetails = allCutDetails.concat(cuts);
      } catch (e) { if (e.response?.data?.code !== 9280) console.error('Cut detail fetch error for SR', stockResultIds[i], ':', e.response?.data || e.message); }
    }
    var cutsByStock = {};
    allCutDetails.forEach(function(cd) { var srId = cd._stock_result_id; if (!cutsByStock[srId]) cutsByStock[srId] = []; cutsByStock[srId].push(cd); });

    var results_1d = [];
    var results_2d = [];
    var nameLookup = {};
    var totalWaste1d = 0, count1d = 0;
    stockResults.forEach(function(sr) {
      var nestType = safeStr(sr.Nesting_Type);
      var formType = sr.Form_Type || {}, materialType = sr.Material_Type || {}, specification = sr.Specification || {}, material = sr.Material || {};
      var formTypeId = safeId(formType), materialTypeId = safeId(materialType), specId = safeId(specification), materialId = safeId(material);
      var ftName = (typeof formType === 'object') ? (formType.zc_display_value || formType.display_value || '') : '';
      var mtName = (typeof materialType === 'object') ? (materialType.zc_display_value || materialType.display_value || '') : '';
      var spName = (typeof specification === 'object') ? (specification.zc_display_value || specification.display_value || '') : '';
      var matName = (typeof material === 'object') ? (material.zc_display_value || material.display_value || '') : '';
      if (formTypeId && ftName) nameLookup[formTypeId] = ftName;
      if (materialTypeId && mtName) nameLookup[materialTypeId] = mtName;
      if (specId && spName) nameLookup[specId] = spName;
      if (materialId && matName) nameLookup[materialId] = matName;
      var srCuts = cutsByStock[sr.ID] || [];
      srCuts.sort(function(a, b) { return (parseInt(a.Cut_Sequence) || 0) - (parseInt(b.Cut_Sequence) || 0); });
      var cuts = srCuts.map(function(cd) {
        var rotationStr = safeStr(cd.Rotation) || '0';
        var rotation = parseInt(rotationStr) || 0;
        return { part_mark: safeStr(cd.Part_Mark), cut_length: parseFloat(cd.Cut_Length) || 0, cut_width: parseFloat(cd.Cut_Width) || 0, cut_weight: parseFloat(cd.Cut_Weight) || 0, quantity_on_this_stock: parseInt(cd.Quantity_On_This_Stock) || 1, x_position: parseFloat(cd.X_Position) || 0, y_position: parseFloat(cd.Y_Position) || 0, rotation: rotation, cut_sequence: parseInt(cd.Cut_Sequence) || 0, spec_name: specId, material_type: materialId };
      });
      var stockLength = parseFloat(sr.Stock_Length) || 0, stockWidth = parseFloat(sr.Stock_Width) || 0, wastePercentage = parseFloat(sr.Waste_Percentage) || 0;
      var resultObj = { stock_result_id: safeStr(sr.ID), form_type: formTypeId, material_origin: materialTypeId, stock_length_in: stockLength, stock_label: safeStr(sr.Stock_Size_Label) || (ftName + ' | ' + mtName), waste_percentage: wastePercentage, stock_weight_lbs: parseFloat(sr.Stock_Weight_LBS) || 0, stock_sequence: parseInt(sr.Stock_Sequence) || 0, grain_direction: safeStr(sr.Grain_Direction), cuts: cuts };
      if (nestType.indexOf('1D') >= 0 || nestType.indexOf('Linear') >= 0) { resultObj.remnant_length_in = parseFloat(sr.Remnant_Length) || 0; results_1d.push(resultObj); totalWaste1d += wastePercentage; count1d++; }
      else if (nestType.indexOf('2D') >= 0 || nestType.indexOf('Panel') >= 0) { resultObj.stock_width_in = stockWidth; resultObj.remnant_area_in2 = parseFloat(sr.Remnant_Area) || 0; results_2d.push(resultObj); }
    });
    results_1d.sort(function(a, b) { return a.stock_sequence - b.stock_sequence; });
    results_2d.sort(function(a, b) { return a.stock_sequence - b.stock_sequence; });
    var avgWaste1d = count1d > 0 ? totalWaste1d / count1d : 0;

    res.json({
      found: true,
      run_header: {
        id: nestRunID,
        run_number: parseInt(runHeader.Run_Number) || 1,
        run_date: safeStr(runHeader.Run_Date),
        run_status: safeStr(runHeader.Run_Status),
        run_by: safeStr(runHeader.Run_By),
        nest_source: safeStr(runHeader.Nest_Source),
        run_title: safeStr(runHeader.Run_Title),
        run_notes: safeStr(runHeader.Run_Notes),
        created_by: safeStr(runHeader.Created_By) || safeStr(runHeader.Added_User),
        project_id: safeId(runHeader.Project_Lookup),
        project_name: (typeof runHeader.Project_Lookup === 'object') ? (runHeader.Project_Lookup?.zc_display_value || runHeader.Project_Lookup?.display_value || '') : '',
        kerf_1d: parseFloat(runHeader.Kerf_1D) || 0,
        kerf_2d: parseFloat(runHeader.Kerf_2D) || 0,
        notes: (typeof runHeader.Notes === 'object') ? '' : (runHeader.Notes || ''),
        total_stock_pieces: parseInt(runHeader.Total_Stock_Pieces) || (results_1d.length + results_2d.length)
      },
      input_parts: inputParts,
      results_1d: results_1d,
      results_2d: results_2d,
      summary: { total_stock_pieces: results_1d.length + results_2d.length, avg_waste_pct_1d: Math.round(avgWaste1d * 10) / 10, errors: [] },
      _nameLookup: nameLookup
    });
  } catch (err) {
    console.error('Standalone nesting-results fetch error:', err.response?.data || err.message);
    if (err.response?.data?.code === 9280 || err.response?.status === 404) return res.json({ found: false, message: 'No nesting results found' });
    res.status(500).json({ error: 'Failed to fetch standalone nesting results', details: err.response?.data || err.message });
  }
});

// GET list of nest runs for the recall panel (standalone + project)
// status: "Active" (default — Approved only), "Archived", or "All"
// source: "All" (default), "Manual", "CSV", or "Project" — done client-side
//   because Zoho criteria's NULL handling makes "Project = anything not Manual/CSV"
//   filter exclude records with empty Nest_Source (which is what legacy project
//   runs have). Server filters status only; client filters by source.
app.get('/api/standalone/nesting-runs', async (req, res) => {
  try {
    const { manufacturer_id, status } = req.query;
    if (!manufacturer_id) return res.status(400).json({ error: 'manufacturer_id required' });
    const token = await getAccessToken();
    let statusClause;
    if (status === 'Archived') statusClause = 'Run_Status="Archived"';
    else if (status === 'All') statusClause = '(Run_Status="Approved"%7C%7CRun_Status="Archived")';
    else statusClause = 'Run_Status="Approved"'; // default Active

    const resp = await axios.get(
      creatorApiBase()+'/report/Nesting_Run_Header_Report?criteria=(Run_By=='+manufacturer_id+'%26%26'+statusClause+')&limit=200',
      { headers: zohoHeaders(token) }
    );
    function safeStr(val) { if (val === null || val === undefined) return ''; if (typeof val === 'object') return val.zc_display_value || val.display_value || val.ID || ''; return String(val); }
    function safeId(val) { if (val === null || val === undefined) return ''; if (typeof val === 'object') return val.ID || ''; return String(val); }
    const runs = (resp.data.data || []).map(r => {
      const projId = safeId(r.Project_Lookup);
      const projName = (typeof r.Project_Lookup === 'object') ? (r.Project_Lookup?.zc_display_value || r.Project_Lookup?.display_value || '') : '';
      const ns = safeStr(r.Nest_Source);
      // Effective source for display: Manual/CSV if set, otherwise "Project" if Project_Lookup populated
      const effectiveSource = (ns === 'Manual' || ns === 'CSV') ? ns : (projId ? 'Project' : (ns || ''));
      return {
        id: r.ID,
        run_number: parseInt(r.Run_Number) || 0,
        run_date: safeStr(r.Run_Date),
        nest_source: effectiveSource,
        run_status: safeStr(r.Run_Status),
        run_title: safeStr(r.Run_Title),
        run_notes: safeStr(r.Run_Notes),
        created_by: safeStr(r.Created_By) || safeStr(r.Added_User),
        project_id: projId,
        project_name: projName,
        total_stock_pieces: parseInt(r.Total_Stock_Pieces) || 0,
        notes: (typeof r.Notes === 'object') ? '' : (r.Notes || '')
      };
    });
    runs.sort((a, b) => b.run_number - a.run_number);
    res.json({ count: runs.length, runs });
  } catch (err) {
    console.error('Standalone runs list error:', err.response?.data || err.message);
    if (err.response?.data?.code === 9280 || err.response?.status === 404) return res.json({ count: 0, runs: [] });
    res.status(500).json({ error: 'Failed to fetch standalone runs', details: err.response?.data || err.message });
  }
});

// PATCH a standalone run's status (archive / unarchive)
app.patch('/api/standalone/runs/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['Approved', 'Archived'].includes(status)) {
      return res.status(400).json({ error: 'status must be Approved or Archived' });
    }
    const token = await getAccessToken();
    await axios.patch(
      creatorApiBase()+'/report/Nesting_Run_Header_Report/'+id,
      { data: { Run_Status: status } },
      { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, id, status });
  } catch (err) {
    console.error('Standalone runs PATCH error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to update run status', details: err.response?.data || err.message });
  }
});

// ---- Outlook inbox connect (Quote Triage / RFQ intake, Step 2) ----
// Registers /connect/outlook/start, /callback, /status. MUST be before the
// catch-all below or the React index.html swallows these routes. Reuses this
// file's Zoho token helpers so there's no duplicate auth machinery.
require('./outlook').registerOutlookRoutes(app, { axios, getAccessToken, creatorApiBase, zohoHeaders });
// ---- TEMP diag #5: recent fitting bridge rows. REMOVE after. ----
app.get('/api/_diag/bridge-recent', async (req, res) => {
  try {
    const rows = await fetchAllZohoPages('/report/RFQs_Sent_Fittings_Report');
    const recent = rows.sort((a, b) => Number(b.ID) - Number(a.ID)).slice(0, 12).map(r => ({
      id: r.ID, quote: r.Quote_Number, supplier: r.Supplier_Name, supEmail: r.Supplier_Email,
      type: (r.Fitting_Type && r.Fitting_Type.zc_display_value) || '',
      make: (r.Fitting_Make && r.Fitting_Make.zc_display_value) || '',
      sent: r.RFQ_Fitting_Sent_Status, ts: r.Quote_Timestamp,
    }));
    res.json({ ok: true, total: rows.length, recent });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- Quote Triage poller (Step 4): GET /api/triage/poll ----
require('./triage').registerTriageRoutes(app, { getAccessToken, creatorApiBase, zohoHeaders });
// ---- Fitting RFQ matching (off-Zoho brick #1): GET /api/supplier/:id/fitting-rfqs ----
require('./fittingMatch').registerFittingMatchRoutes(app, { fetchAllZohoPages, cachedLookup, sendZohoAwareError });
// ---- Supplier platform (off-Zoho): identity seam + /api/supplier/me, /me/dashboard ----
require('./supplier').registerSupplierRoutes(app, { fetchAllZohoPages, cachedLookup, cacheBust, sendZohoAwareError, getAccessToken, creatorApiBase, zohoHeaders, axios });

// Catch-all: serve React app
app.get('*', function(req, res) { res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html')); });

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Material Compass Nesting server running on port ' + PORT); });
