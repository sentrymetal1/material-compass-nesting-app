require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const FormData = require('form-data');
const { takeoffHandler, reviseHandler, chatHandler, indexHandler, askHandler } = require('./takeoff/route');
const takeoffSnap = require('./takeoff/snap');   // size matching shared with the post-run snapper

const app = express();
app.use(cors());
app.use('/api/takeoff', express.json({ limit: '60mb' })); // AI take-off: base64 PDFs are large; must precede the 10mb global json
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'client', 'build')));

// AI TAKE-OFF WIDGET — served from this app so the URL the user sees is Material Compass's own,
// not a github.io address belonging to a personal account. Same origin as /api/takeoff too, so the
// widget's calls stop being cross-origin, and a deploy is live immediately instead of waiting on a
// CDN cache. The GitHub Pages copy still works while the launcher button points at it.
app.get('/takeoff', (req, res, next) => {
  // Express matches '/takeoff' and '/takeoff/' on the same route, so only the slash-less form gets
  // redirected — otherwise this bounces forever. The slash matters: review.html is linked relatively.
  const p = req.originalUrl.split('?')[0];
  if (p.endsWith('/')) return next();
  const q = req.originalUrl.indexOf('?');
  res.redirect(301, '/takeoff/' + (q > -1 ? req.originalUrl.slice(q) : ''));
});
app.use('/takeoff', express.static(path.join(__dirname, 'takeoff', 'public')));

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

// Read-only dependent count — lets the widget label the delete button before you click it.
// MUST stay above the /:project_id route below: Express matches in registration order, so the
// param route would otherwise swallow "dependents" and treat it as a project id.
app.get('/api/takeoff/project-scope/dependents', async (req, res) => {
  try {
    const { kind, id } = req.query || {};
    if (!SCOPE_FORMS[kind]) return res.status(400).json({ ok: false, error: "kind must be 'component' or 'drawing'" });
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    res.json({ ok: true, ...(await scopeDependents(kind, id)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// SCOPE RECONCILIATION — the project's ENTERED components + drawings (with IDs), for the
// take-off's reconciliation panel to compare against what the AI read. Same reads as
// fetchProjectContext, but returns arrays with IDs instead of a prompt string.
app.get('/api/takeoff/project-scope/:project_id', async (req, res) => {
  try {
    const pid = req.params.project_id;
    const token = await getAccessToken();
    const base = creatorApiBase();
    let components = [], drawings = [];
    // Each read is guarded: a zero-match report query throws (Zoho 400/9280) — treat as empty.
    try {
      const rc = await axios.get(base + '/report/All_Project_Components?criteria=(MCP_Customer_Project_Form==' + pid + ')&limit=200', { headers: zohoHeaders(token) });
      components = ((rc.data && rc.data.data) || [])
        // Quantity = HOW MANY OF THIS COMPONENT the job builds. The drawings detail ONE of them, so
        // the take-off reads per-unit and the BOM is multiplied up — the project's own rollups
        // divide BOM sums by this number to get per-unit cost, so it has to travel with the scope.
        .map(function (x) { return { id: x.ID, name: String(x.Project_Component || '').trim(),
                                     quantity: Math.max(1, Math.round(Number(x.Quantity) || 1)) }; })
        .filter(function (c) { return c.name; });
    } catch (e) { /* none entered */ }
    try {
      const rd = await axios.get(base + '/report/All_Project_Drawing_Details?criteria=(MCP_Customer_Project_Form==' + pid + ')&limit=200', { headers: zohoHeaders(token) });
      drawings = ((rd.data && rd.data.data) || [])
        // Components is the lookup to the parent component; v2.1 returns it as {ID, display_value}
        // WHEN the report exposes that column. If it doesn't, component_id is '' and we backfill below.
        .map(function (x) { return { id: x.ID, number: String(x.Drawing_Number || '').trim(),
                                     component_id: (x.Components && x.Components.ID) ? String(x.Components.ID) : '' }; })
        .filter(function (d) { return d.number; });
    } catch (e) { /* none entered */ }

    // BACKFILL the parent link when the flat read didn't surface Components (report column not
    // configured — see [[feedback_zoho_report_api_columns]]). One query per component: the drawings
    // a component owns are Drawing_Details[Components==<component id>]. Only runs if NO drawing came
    // back with a parent, so a properly-columned report costs zero extra calls.
    if (components.length && drawings.length && !drawings.some(function (d) { return d.component_id; })) {
      for (const c of components) {
        try {
          const rr = await axios.get(base + '/report/All_Project_Drawing_Details?criteria=(Components==' + c.id + ')&limit=200', { headers: zohoHeaders(token) });
          ((rr.data && rr.data.data) || []).forEach(function (x) {
            const d = drawings.find(function (z) { return String(z.id) === String(x.ID); });
            if (d) d.component_id = String(c.id);
          });
        } catch (e) { /* this component has no drawings, or query 400'd on zero match */ }
      }
    }

    // Nest drawings under their component; drawings with no/unknown parent go to unassigned.
    const byId = {};
    components.forEach(function (c) { byId[String(c.id)] = { component_id: String(c.id), component: c.name,
                                                             quantity: c.quantity, drawings: [] }; });
    const unassigned = [];
    drawings.forEach(function (d) {
      const node = d.component_id ? byId[String(d.component_id)] : null;
      if (node) node.drawings.push({ id: d.id, number: d.number });
      else unassigned.push({ id: d.id, number: d.number });
    });
    const tree = components.map(function (c) { return byId[String(c.id)]; });

    // Keep the flat components/drawings arrays (review.html's reconciliation reads them);
    // tree + unassigned_drawings are the new nested view the intake UI pre-fills from.
    res.json({ ok: true, components: components, drawings: drawings, tree: tree, unassigned_drawings: unassigned });
  } catch (e) { res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
});

// SCOPE RECONCILIATION — add a component/drawing the AI read but the user hadn't entered.
// Component: set Project_LU (the field the staging validator resolves on) at create; the
// MCP_Customer_Project_Form link goes on as a best-effort patch (mirrors /save) so a lookup
// rejection can never fail the add. Drawing: MCP_Customer_Project_Form is the direct link.
app.post('/api/takeoff/project-scope/add', async (req, res) => {
  try {
    const { project_id, kind, value, component_id } = req.body || {};
    if (!project_id) return res.status(400).json({ ok: false, error: 'project_id required' });
    const v = String(value || '').trim();
    if (!v) return res.status(400).json({ ok: false, error: 'value required' });
    const token = await getAccessToken();
    const base = creatorApiBase();

    let form, report, data, mcpBestEffort = false;
    if (kind === 'component') {
      form = 'Project_Components_Form'; report = 'All_Project_Components';
      // THREE project links, all required. Project_LU is what the staging validator resolves on.
      // Project_Bi_Directional_Lookup is what the project page's OnLoad dot-walks per component —
      // native records have it, API records without it were BLANK, and the page threw a generic
      // "Error occurred please contact application owner" on the null. MCP is the native subform
      // link (best-effort patch below). Setting only the first two is what broke the page.
      // A natively-entered component carries Quantity 1 and zeroed money/weight fields. Left blank,
      // anything that multiplies by Quantity or sums those columns is working from nothing.
      data = {
        Project_Component: v, Project_LU: project_id, Project_Bi_Directional_Lookup: project_id,
        Quantity: 1,
        Material_Cost_Estimated_Per_Unit: 0,
        Total_Structural_Allocate_Amt: 0,
        Total_Structural_Est_Matl_Amt: 0,
        Unit_Weight_Of_Component: 0,
      };
      mcpBestEffort = true;
    } else if (kind === 'drawing') {
      form = 'Project_Drawing_Details_Form'; report = 'All_Project_Drawing_Details';
      // A drawing record needs the SAME project links a natively-entered one gets, or it shows up
      // on the project report with half its columns blank: Project_ID_Number and
      // Project_ID_Relationship were both empty on every row the widget wrote.
      data = {
        Drawing_Number: v,
        MCP_Customer_Project_Form: project_id,
        Project_ID_Number: project_id,
        Project_ID_Relationship: project_id,
      };
      // The sheet title read off the title block — the Drawing Description column, which is how
      // these records are read by a human. We have it; there's no reason to write the row without it.
      const desc = String((req.body && req.body.description) || '').trim();
      if (desc) data.Drawing_Description = desc;
      // Native rows carry a date. A null date is the classic crash for a project page that formats
      // or compares it in Deluge ("Error occurred please contact application owner"), so give the
      // record one. Format must match the field's display format — see zohoDateToday().
      data.Date_field = zohoDateToday();
      // Components ties the drawing to its parent component (the field /api/bom-lookups/drawings
      // filters on). Without it the drawing is orphaned — present on the project, invisible per
      // component. The caller supplies it because the take-off knows the pairing (a BOM row carries
      // both `component` and `source_sheet`); add components first, then pass the new/known id here.
      const cid = String(component_id || '').trim();
      if (cid) data.Components = cid;
    } else {
      return res.status(400).json({ ok: false, error: "kind must be 'component' or 'drawing'" });
    }

    const postForm = function (d) {
      return axios.post(base + '/form/' + form, { data: d }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
    };
    let zr = await postForm(data), bidiWarning = null;
    // If the bidirectional link name is wrong, Zoho rejects the whole create. Rather than break every
    // add, retry without it and SURFACE the miss — a silent fallback would just re-create the exact
    // blank-link records that crashed the project page.
    // Some of those columns may be formula/rollup fields on this tenant's form, which Zoho refuses
    // to be written. Step back one field-set at a time rather than failing the add.
    if (kind === 'component' && zr.data && zr.data.code !== 3000 && 'Quantity' in data) {
      const keep = { Project_Component: data.Project_Component, Project_LU: project_id,
                     Project_Bi_Directional_Lookup: project_id, Quantity: 1 };
      bidiWarning = 'The cost/weight columns were rejected and omitted (' +
        ((zr.data && zr.data.message) || 'no message') + ') — they are probably formula fields.';
      data = keep;
      zr = await postForm(data);
    }
    if (kind === 'component' && zr.data && zr.data.code !== 3000 && 'Project_Bi_Directional_Lookup' in data) {
      delete data.Project_Bi_Directional_Lookup;
      bidiWarning = 'Project_Bi_Directional_Lookup was rejected and omitted — the project page may error on this record. Confirm the field link name.';
      zr = await postForm(data);
    }
    // Same idea for a drawing: the extra project columns are worth having, but not at the cost of
    // failing the add. Retry with just the fields that always worked, and say what was dropped.
    if (kind === 'drawing' && zr.data && zr.data.code !== 3000) {
      const bare = { Drawing_Number: data.Drawing_Number, MCP_Customer_Project_Form: project_id };
      if (data.Components) bare.Components = data.Components;
      bidiWarning = 'The data service rejected one of Project_ID_Number / Project_ID_Relationship / ' +
        'Drawing_Description, so the drawing was written without them (' +
        ((zr.data && zr.data.message) || 'no message') + '). Confirm those field link names.';
      data = bare;
      zr = await postForm(data);
    }
    if (zr.data && zr.data.code !== 3000) return res.status(502).json({ ok: false, error: 'The data service rejected the add', detail: zr.data });
    const id = zr.data && zr.data.data && zr.data.data.ID;

    if (id && mcpBestEffort) {
      try {
        await axios.patch(base + '/report/' + report + '/' + id, { data: { MCP_Customer_Project_Form: project_id } }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      } catch (e) { /* the native-subform link is optional; Project_LU already ties it for staging */ }
    }
    res.json({ ok: true, id: id, warning: bidiWarning });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('project-scope add error:', detail);
    res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// Zoho takes a date in the FIELD'S display format, not ISO. This form displays "Jul 21,2026", so
// that's what's sent; the repair endpoint below proves the format against a real record and the
// alternatives are there because a different tenant's form may be set up differently.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function zohoDateFormats(d) {
  const dt = d || new Date();
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = dt.getFullYear();
  const mon = MONTHS[dt.getMonth()];
  return [mon + ' ' + dd + ',' + yy, mm + '/' + dd + '/' + yy, dd + '-' + mon + '-' + yy, yy + '-' + mm + '-' + dd];
}
function zohoDateToday() { return zohoDateFormats()[0]; }

// REPAIR — drawing records written before the project links were being set come back on the
// project report with Project ID Number, Project ID Relationship and Drawing Description blank.
// Patch them in place: same project, same numbers, nothing created or deleted.
// Body: { project_id, descriptions?: { "<drawing number>": "<title>" } }
app.post('/api/takeoff/project-scope/repair', async (req, res) => {
  try {
    const { project_id } = req.body || {};
    if (!project_id) return res.status(400).json({ ok: false, error: 'project_id required' });
    const desc = (req.body && req.body.descriptions) || {};
    const key = function (s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); };
    const descByKey = {};
    Object.keys(desc).forEach(function (k) { descByKey[key(k)] = String(desc[k] || '').trim(); });

    let rows = [];
    try {
      rows = await fetchAllZohoPages('/report/All_Project_Drawing_Details?criteria=(MCP_Customer_Project_Form==' + project_id + ')');
    } catch (e) { rows = []; }

    const token = await getAccessToken();
    const base = creatorApiBase();
    const out = { checked: rows.length, patched: 0, skipped: 0, failed: [] };

    // Work out which date format this form accepts, once, using the first row that needs one.
    let dateFmt = null;
    out.date_format = null;
    for (const r of rows) {
      if (String(r.Date_field || '').trim()) continue;
      for (const cand of zohoDateFormats()) {
        try {
          const zr = await axios.patch(base + '/report/All_Project_Drawing_Details/' + r.ID,
            { data: { Date_field: cand } }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
          if (zr.data && zr.data.code === 3000) { dateFmt = cand; break; }
        } catch (e) { /* try the next format */ }
      }
      break;
    }
    out.date_format = dateFmt;

    for (const r of rows) {
      const patch = {};
      if (!String(r.Project_ID_Number || '').trim()) patch.Project_ID_Number = String(project_id);
      if (!(r.Project_ID_Relationship && r.Project_ID_Relationship.ID)) patch.Project_ID_Relationship = String(project_id);
      const d = descByKey[key(r.Drawing_Number)];
      if (d && !String(r.Drawing_Description || '').trim()) patch.Drawing_Description = d;
      // A null date is the classic cause of "Error occurred please contact application owner" on a
      // page that formats it — fill it with today's date where it's missing.
      if (dateFmt && !String(r.Date_field || '').trim()) patch.Date_field = dateFmt;
      if (!Object.keys(patch).length) { out.skipped++; continue; }
      try {
        const zr = await axios.patch(base + '/report/All_Project_Drawing_Details/' + r.ID, { data: patch },
          { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
        if (zr.data && zr.data.code !== 3000) out.failed.push({ number: r.Drawing_Number, detail: zr.data.message || zr.data.code });
        else out.patched++;
      } catch (err) {
        out.failed.push({ number: r.Drawing_Number, detail: (err.response && err.response.data && err.response.data.message) || err.message });
      }
    }
    // Components written the same way are missing Quantity (and the zeroed cost/weight columns a
    // native entry starts with), so anything multiplying by Quantity works from a blank.
    const comps = { checked: 0, patched: 0, skipped: 0, failed: [] };
    let crows = [];
    try {
      crows = await fetchAllZohoPages('/report/All_Project_Components?criteria=(MCP_Customer_Project_Form==' + project_id + ')');
    } catch (e) { crows = []; }
    comps.checked = crows.length;
    for (const c of crows) {
      const patch = {};
      if (!(Number(c.Quantity) > 0)) patch.Quantity = 1;
      ['Material_Cost_Estimated_Per_Unit', 'Total_Structural_Allocate_Amt',
       'Total_Structural_Est_Matl_Amt', 'Unit_Weight_Of_Component'].forEach(function (f) {
        if (String(c[f] == null ? '' : c[f]).trim() === '') patch[f] = 0;
      });
      if (!Object.keys(patch).length) { comps.skipped++; continue; }
      try {
        const zr = await axios.patch(base + '/report/All_Project_Components/' + c.ID, { data: patch },
          { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
        if (zr.data && zr.data.code !== 3000) {
          // Retry with just Quantity — the rest are likely formula fields on this form.
          if (patch.Quantity) {
            const z2 = await axios.patch(base + '/report/All_Project_Components/' + c.ID, { data: { Quantity: patch.Quantity } },
              { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
            if (z2.data && z2.data.code === 3000) { comps.patched++; continue; }
          }
          comps.failed.push({ component: c.Project_Component, detail: zr.data.message || zr.data.code });
        } else comps.patched++;
      } catch (err) {
        comps.failed.push({ component: c.Project_Component, detail: (err.response && err.response.data && err.response.data.message) || err.message });
      }
    }

    res.json({ ok: true, drawings: out, components: comps });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('project-scope repair error:', detail);
    res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// Field map for the two scope records — used by update/delete below.
const SCOPE_FORMS = {
  component: { report: 'All_Project_Components',       field: 'Project_Component' },
  drawing:   { report: 'All_Project_Drawing_Details',  field: 'Drawing_Number' },
};

// SCOPE RECONCILIATION — rename an entered component/drawing to the value the AI read.
// Staging resolves components BY NAME, so renaming to the take-off's exact wording is what
// converts a near-miss into a real link. Rename before committing: imported BOM rows keep a
// `Component` name copy alongside Component_ID, and that copy does not follow a later rename.
app.post('/api/takeoff/project-scope/update', async (req, res) => {
  try {
    const { kind, id, value } = req.body || {};
    const spec = SCOPE_FORMS[kind];
    if (!spec) return res.status(400).json({ ok: false, error: "kind must be 'component' or 'drawing'" });
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    // How many of this component the job builds — sent on its own (no rename) when the estimator
    // changes the unit count on the intake screen.
    const qtyOnly = (kind === 'component' && req.body.quantity != null && (value == null || value === ''));
    const v = String(value || '').trim();
    if (!v && !qtyOnly) return res.status(400).json({ ok: false, error: 'value required' });

    const token = await getAccessToken();
    const data = {};
    if (v) data[spec.field] = v;
    if (kind === 'component' && req.body.quantity != null) {
      const q = Math.round(Number(req.body.quantity));
      if (!(q >= 1)) return res.status(400).json({ ok: false, error: 'quantity must be 1 or more' });
      data.Quantity = q;                       // whole units — the field takes no decimals
    }
    // A drawing can also be RE-PARENTED here: the intake screen lets the estimator pick a drawing
    // that sits on the project with no component and file it under one, which is the same PATCH.
    if (kind === 'drawing' && req.body.component_id) data.Components = String(req.body.component_id);
    const zr = await axios.patch(creatorApiBase() + '/report/' + spec.report + '/' + id,
      { data: data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
    if (zr.data && zr.data.code !== 3000) return res.status(502).json({ ok: false, error: 'The data service rejected the update', detail: zr.data });
    res.json({ ok: true, id: String(id), value: v, quantity: data.Quantity });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('project-scope update error:', detail);
    res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// Dependents of a component: linked drawings (Components == id) and imported BOM rows
// (Component_ID == id). A probe that THROWS returns null, not 0 — "we could not check" must never
// be reported to the caller as "nothing is linked", or delete would look safe when it isn't.
async function scopeDependents(kind, id) {
  if (kind !== 'component') return { drawings: 0, bomRows: 0, unchecked: [] };
  const out = { drawings: null, bomRows: null, unchecked: [] };
  try {
    out.drawings = (await fetchAllZohoPages('/report/All_Project_Drawing_Details?criteria=(Components==' + id + ')')).length;
  } catch (e) { out.unchecked.push('drawings'); }
  try {
    out.bomRows = (await fetchAllZohoPages('/report/Project_Bill_Of_Material_Detail_Form_Report?criteria=(Component_ID==' + id + ')')).length;
  } catch (e) { out.unchecked.push('BOM rows'); }
  return out;
}

// SCOPE RECONCILIATION — delete an entered component/drawing the take-off did not find.
// BLOCKS when anything is linked (drawings or BOM rows) and reports what, rather than cascading:
// "the AI didn't read it" is not evidence the scope is unused, so a review screen must never be
// able to silently orphan records. An unchecked probe also blocks — unknown is not zero.
app.post('/api/takeoff/project-scope/delete', async (req, res) => {
  try {
    const { kind, id } = req.body || {};
    const spec = SCOPE_FORMS[kind];
    if (!spec) return res.status(400).json({ ok: false, error: "kind must be 'component' or 'drawing'" });
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const dep = await scopeDependents(kind, id);
    const blockers = [];
    if (dep.drawings) blockers.push(dep.drawings + ' drawing' + (dep.drawings === 1 ? '' : 's'));
    if (dep.bomRows)  blockers.push(dep.bomRows  + ' BOM row' + (dep.bomRows  === 1 ? '' : 's'));
    dep.unchecked.forEach(function (w) { blockers.push('could not check ' + w); });
    if (blockers.length) {
      return res.status(409).json({ ok: false, blocked: true, dependents: dep,
        error: 'Still linked: ' + blockers.join(' + ') + '. Clear these on the project page first.' });
    }

    const token = await getAccessToken();
    // Delete the single record by ID. The criteria form ("?criteria=(ID==123)") that was here is
    // rejected by v2.1 with code 1060 "Invalid request parameter found - criteria" — so this
    // endpoint had never actually deleted anything. Criteria is kept only as a fallback.
    let zr;
    try {
      zr = await axios.delete(creatorApiBase() + '/report/' + spec.report + '/' + encodeURIComponent(id),
        { headers: zohoHeaders(token) });
    } catch (e) {
      zr = await axios.delete(creatorApiBase() + '/report/' + spec.report +
        '?criteria=' + encodeURIComponent('ID==' + id), { headers: zohoHeaders(token) });
    }
    if (zr.data && zr.data.code !== 3000) return res.status(502).json({ ok: false, error: 'The data service rejected the delete', detail: zr.data });
    res.json({ ok: true, id: String(id) });
  } catch (err) {
    const detail = err.response ? err.response.data : (err.message || String(err));
    console.error('project-scope delete error:', detail);
    res.status(500).json({ ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  }
});

// AI material take-off — PDFs in, BOM + project synopsis out. Injects this shop's prior
// corrections (Tier-3 per-manufacturer learning) so the take-off pre-applies their preferences.
app.post('/api/takeoff', async (req, res) => {
  let shopLearning = '', universalKnowledge = '', projectContext = '';
  const mfgId = req.body && req.body.manufacturer_id;
  const tier = (req.body && req.body.tier) || ((req.body && req.body.include_synopsis === false) ? 'basic' : 'premium');
  try { if (mfgId) shopLearning = await fetchShopLearning(mfgId); } catch (e) {}
  try { universalKnowledge = await getUniversalKnowledge(); } catch (e) {}
  // Scope: a user-CONFIRMED Component→Drawing tree in the body wins over the Zoho-read fallback.
  // This is the intake redesign — the tree is arranged before the take-off so rows come back tagged
  // against names the user approved, instead of the AI guessing and reconciling afterward.
  try {
    const tree = req.body && req.body.scope_tree;
    // reference_drawings is the current name; excluded_drawings is the old one, kept so an older
    // cached copy of the widget keeps working.
    const refs = (req.body && (req.body.reference_drawings || req.body.excluded_drawings)) || [];
    const treeCtx = buildScopeTreeContext(tree, refs, req.body && req.body.drawing_aliases,
                                          req.body && req.body.attached_documents);
    if (treeCtx) { projectContext = treeCtx; }
    else { const pid = req.body && req.body.project_id; if (pid) projectContext = await fetchProjectContext(pid); }
  } catch (e) {}

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

  // The shop's real size list. Best-effort: if the lookup read fails the take-off still runs on
  // knowledge.md's format rules — degraded, not blocked.
  let liveCatalog = '', catalogGroups = null, fittingsCatalog = '';
  try {
    liveCatalog = await buildLiveCatalogContext();
    catalogGroups = await buildCatalogGroups();   // same cached object; used to snap sizes post-run
  } catch (e) { console.error('live catalog unavailable, falling back to knowledge.md formats:', e.message || e); }
  // Fittings are a separate vocabulary and a separate destination on the project. Best-effort like
  // the size catalog: no fittings catalog just means no fittings stream, not a failed take-off.
  try { fittingsCatalog = await buildFittingsCatalogContext(); }
  catch (e) { console.error('fittings catalog unavailable — fittings will not be extracted:', e.message || e); }

  return takeoffHandler(req, res, { shopLearning: shopLearning, universalKnowledge: universalKnowledge,
    projectContext: projectContext, liveCatalog: liveCatalog, catalogGroups: catalogGroups,
    fittingsCatalog: fittingsCatalog });
});

// LIVE MATERIAL CATALOG for the take-off prompt — the shop's ACTUAL Form Type × Material Type ×
// size list, so the AI copies a real size instead of composing one from a format rule (composed
// sizes are what arrive with an empty/unresolvable Material). Cached for an hour and prompt-cached
// downstream, so the Zoho cost is one refresh per hour, not per take-off.
// TTL is 12h on purpose: the table is thousands of rows, so a rebuild is dozens of paged Zoho
// reads and the daily API budget is tight ([[feedback_zoho_api_call_budget]]). The size catalog
// changes rarely — twice a day is plenty, and every take-off in between is free.
// The grouped catalog itself: { "Form Type|Material Type": [size, ...] }. Built once and used BOTH
// for the model's prompt block and for the review page's material check, so the validator and the
// model can never disagree about what a valid size is.
async function buildCatalogGroups() {
  return cachedLookup('takeoff:catalog-groups', 12 * 60 * 60 * 1000, async () => {
    // Same reports the BOM-editor lookups use — proven link names, don't guess new ones.
    const ftRows = await fetchAllZohoPages('/report/Form_Types_Report?criteria=(Active==true)');
    const mtRows = await fetchAllZohoPages('/report/Material_Types_Report');
    const sizes = await fetchAllZohoPages('/report/Beam_Channel_Tee_Lookup_Report');

    const ft = {}, mt = {};
    ftRows.forEach(function (r) { ft[String(r.ID)] = String(r.Form_Type || '').trim(); });
    mtRows.forEach(function (r) { mt[String(r.ID)] = String(r.Material_Type || '').trim(); });

    const groups = {};
    sizes.forEach(function (r) {
      const desc = String(r.Description || '').trim();
      if (!desc) return;
      const f = ft[String((r.Form_Types && r.Form_Types.ID) || '')] || '';
      const m = mt[String((r.Material_Types && r.Material_Types.ID) || '')] || '';
      if (!f) return;
      const key = f + '|' + (m || 'any material');
      if (!groups[key]) groups[key] = [];
      if (groups[key].indexOf(desc) < 0) groups[key].push(desc);
    });
    return groups;
  });
}

// THE VALID SPECIFICATIONS for each Form × Material, from Material_Form_Detail — the same table the
// staging validator checks against. Sizes were a closed list to the model but SPECS were not, so it
// defaulted to the carbon-steel spec it knew: three 10 ga Sheet rows came back as "A36", which is a
// PLATE spec, and staging rejected all three with "Spec 'A36' not found for Sheet / Carbon Steel".
// 482 rows across 109 pairs ≈ 1,500 tokens — cheap, cached, and it closes the last open field.
async function buildSpecGroups() {
  return cachedLookup('takeoff:spec-groups', 12 * 60 * 60 * 1000, async () => {
    const ftRows = await fetchAllZohoPages('/report/Form_Types_Report?criteria=(Active==true)');
    const mtRows = await fetchAllZohoPages('/report/Material_Types_Report');
    const specs = await fetchAllZohoPages('/report/Material_Form_Detail_Report');
    const ft = {}, mt = {};
    ftRows.forEach(function (r) { ft[String(r.ID)] = String(r.Form_Type || '').trim(); });
    mtRows.forEach(function (r) { mt[String(r.ID)] = String(r.Material_Type || '').trim(); });
    const groups = {};
    specs.forEach(function (r) {
      const d = String(r.Type_Detail || '').trim();
      if (!d) return;
      const f = ft[String((r.Form_Type && r.Form_Type.ID) || '')] || '';
      const m = mt[String((r.Material_Type && r.Material_Type.ID) || '')] || '';
      if (!f) return;
      const key = f + '|' + (m || 'any material');
      if (!groups[key]) groups[key] = [];
      if (groups[key].indexOf(d) < 0) groups[key].push(d);
    });
    return groups;
  });
}

// The same catalog rendered for the model.
async function buildLiveCatalogContext() {
  const groups = await buildCatalogGroups();
  let specs = {};
  try { specs = await buildSpecGroups(); } catch (e) { console.error('spec groups unavailable:', e.message || e); }
  const keys = Object.keys(groups).sort();
  if (!keys.length) return '';
  const body = keys.map(function (k) {
    const s = specs[k] || specs[k.split('|')[0] + '|any material'];
    return '### ' + k.replace('|', ' | ') +
      (s && s.length ? '\n  valid specifications: ' + s.join(' · ') : '') +
      '\n  sizes: ' + groups[k].join(' · ');
  }).join('\n\n');
  // A pair can have specs but no sizes (or vice versa) — list those too, or the model has no way to
  // know the combination is even allowed.
  const extra = Object.keys(specs).filter(function (k) { return keys.indexOf(k) < 0; }).sort()
    .map(function (k) { return '### ' + k.replace('|', ' | ') + '\n  valid specifications: ' + specs[k].join(' · '); });
  const total = keys.reduce(function (n, k) { return n + groups[k].length; }, 0);
  const specTotal = Object.keys(specs).reduce(function (n, k) { return n + specs[k].length; }, 0);
  return "THIS SHOP'S LIVE MATERIAL CATALOG — " + total + " sizes and " + specTotal + " specifications across " +
    keys.length + " Form Type × Material Type combinations. BOTH the `size` AND the `specification` on a " +
    "row MUST be copied verbatim from the group that matches that row's Form Type and Material Type. " +
    "A specification is NOT interchangeable between forms: A36 is a Plate spec and is not valid for " +
    "Sheet; sheet gauges take sheet specs (A1011 CS Type B and the like). If the group below lists no " +
    "specification you can justify, say so in the row's `note` and lower confidence rather than " +
    "borrowing one from another form.\n\n" + body +
    (extra.length ? '\n\n' + extra.join('\n\n') : '') + '\n';
}

// THE SHOP'S FITTING VOCABULARY, rendered for the take-off prompt. Unlike the size catalog this is
// small (12 types, 18 makes, ~54 ends, ~45 connections, 192 specs), so the whole thing goes in and
// the model can copy values verbatim instead of inventing "90 ELL BW". Ends and connections are
// listed under the fitting type they belong to, and specs under their make, because that is how the
// project's own cascade filters them — offering the full list flat would invite invalid combinations.
async function buildFittingsCatalogContext() {
  const cat = await cachedLookup('takeoff:fittings-catalog', 12 * 60 * 60 * 1000, async () => {
    const lkId = (r, f) => String((r && r[f] && (r[f].ID || r[f].id)) || '');
    const [types, makes, ends, conns, specs] = await Promise.all([
      fetchAllZohoPages('/report/Fitting_Type_Report'),
      fetchAllZohoPages('/report/Fitting_Make_Report'),
      fetchAllZohoPages('/report/End_Type_Report'),
      fetchAllZohoPages('/report/Connection_Type_Report'),
      fetchAllZohoPages('/report/Fitting_Specification_Report'),
    ]);
    return {
      types: (types || []).map(r => ({ id: String(r.ID), name: String(r.Fitting_Type || '').trim() })).filter(x => x.name),
      makes: (makes || []).map(r => ({ id: String(r.ID), name: String(r.Fitting_Make || '').trim() })).filter(x => x.name),
      ends: (ends || []).map(r => ({ name: String(r.End_Type || '').trim(), typeId: lkId(r, 'Fitting_Type') })).filter(x => x.name),
      connections: (conns || []).map(r => ({ name: String(r.Connection_Type || '').trim(), typeId: lkId(r, 'Fitting_Type') })).filter(x => x.name),
      specs: (specs || []).map(r => ({ name: String(r.Fitting_Specification || '').trim(), makeId: lkId(r, 'Fitting_Make') })).filter(x => x.name),
    };
  });
  if (!cat.types.length) return '';
  const uniq = a => Array.from(new Set(a));
  const perType = cat.types.map(t => {
    const e = uniq(cat.ends.filter(x => x.typeId === t.id).map(x => x.name));
    const c = uniq(cat.connections.filter(x => x.typeId === t.id).map(x => x.name));
    if (!e.length && !c.length) return '- ' + t.name;
    return '- ' + t.name + '\n    end types: ' + (e.join(' · ') || '(none listed)') +
           '\n    connections: ' + (c.join(' · ') || '(none listed)');
  }).join('\n');
  const perMake = cat.makes.map(m => {
    const s = uniq(cat.specs.filter(x => x.makeId === m.id).map(x => x.name));
    return '- ' + m.name + (s.length ? ': ' + s.join(' · ') : ': (no specifications listed)');
  }).join('\n');
  return "THIS SHOP'S FITTING CATALOG — the ONLY values allowed in a `fittings` entry. Copy them verbatim.\n\n" +
    'FITTING TYPES, each with the end types and connections that belong to it:\n' + perType + '\n\n' +
    'FITTING MAKES, each with its specifications:\n' + perMake + '\n\n' +
    'If a fitting on the drawings fits none of these combinations, choose the closest, set confidence ≤ 0.3, ' +
    'and say what the drawing actually called for in the `note` — a flagged near-miss can be corrected, an ' +
    'invented value cannot.\n';
}

// What the take-off is told about fittings — checkable without spending a run. Plain text by
// default because the point is to READ it: this is the exact vocabulary the model is held to, and
// a wrong or missing end type here is a wrong fitting on a quote. ?json=1 for the machine version.
app.get('/api/takeoff/fittings-catalog-check', async (req, res) => {
  try {
    const txt = await buildFittingsCatalogContext();
    if (req.query.json) {
      return res.json({ ok: true, built: !!txt, approx_tokens: Math.round(txt.length / 4), text: txt });
    }
    res.type('text/plain; charset=utf-8').send(
      (txt ? '' : '(EMPTY — the fittings catalog could not be read, so no fittings will be extracted.)\n\n') +
      '# This is exactly what the AI is told about fittings.\n' +
      '# A fitting it reads off a drawing must be described using these values and no others.\n' +
      '# ~' + Math.round(txt.length / 4) + ' tokens, cached 12h and prompt-cached — it costs almost nothing per run.\n' +
      '# Add ?json=1 for JSON.\n\n' + txt);
  } catch (err) {
    res.status(500).type('text/plain').send('Could not build the fittings catalog: ' + String((err && err.message) || err));
  }
});

// WHAT HAS IT LEARNED? Readable in a browser, per shop. Learning you can't inspect is learning you
// can't trust — and if the Zoho side was never built, this says so plainly instead of the corrections
// silently going nowhere.
//   /api/takeoff/learning-check?manufacturer_id=123
app.get('/api/takeoff/learning-check', async (req, res) => {
  const mfg = String(req.query.manufacturer_id || '').trim();
  const out = [];
  let records = [];
  try {
    records = await fetchAllZohoPages('/report/Takeoff_Correction_Report' +
      (mfg ? '?criteria=(Manufacture_ID=="' + mfg + '")' : ''));
  } catch (err) {
    const code = err && err.response && err.response.status;
    return res.type('text/plain; charset=utf-8').send(
      'THE LEARNING STORE IS NOT READABLE.\n\n' +
      'Tried: /report/Takeoff_Correction_Report' + (mfg ? ' for manufacturer ' + mfg : '') + '\n' +
      'The data service said: ' + (code || '') + ' ' + String((err && err.message) || err) + '\n\n' +
      'If the form or report does not exist yet, corrections are being posted and dropped. It needs a\n' +
      'form `Takeoff_Correction` with fields: Manufacture_ID, Context, AI_Value, Human_Value,\n' +
      'Project_Type, Source, Created — and a report `Takeoff_Correction_Report` exposing all of them\n' +
      'as columns (a v2.1 report only returns the columns it is configured with).');
  }
  const by = {};
  records.forEach(function (r) {
    const s = String(r.Source || 'decision').toLowerCase().trim();
    by[s] = (by[s] || 0) + 1;
  });
  out.push('# What this take-off has learned' + (mfg ? ' from manufacturer ' + mfg : ' (all manufacturers)'));
  out.push('# ' + records.length + ' correction' + (records.length === 1 ? '' : 's') + ' stored' +
    (Object.keys(by).length ? ' — ' + Object.keys(by).map(function (k) { return by[k] + ' ' + k; }).join(', ') : '') + '\n');
  if (mfg) {
    let text = '';
    try { text = await fetchShopLearning(mfg); } catch (e) { text = '(could not build: ' + (e.message || e) + ')'; }
    out.push('---- INJECTED INTO EVERY TAKE-OFF FOR THIS SHOP ----\n');
    out.push(text || '(nothing yet — this shop has made no corrections)');
  } else {
    out.push('Add ?manufacturer_id=… to see what a particular shop\'s take-offs are told.');
  }
  let uk = '';
  try { uk = await getUniversalKnowledge(); } catch (e) {}
  out.push('\n---- SHARED WITH EVERY SHOP (approved patterns) ----\n');
  out.push(uk || '(none approved yet — approve rows in Takeoff_Knowledge to promote a pattern)');
  res.type('text/plain; charset=utf-8').send(out.join('\n'));
});

// The same for the STRUCTURAL size catalog, in the same readable form — the two are checked together.
app.get('/api/takeoff/catalog-check-text', async (req, res) => {
  try {
    const txt = await buildLiveCatalogContext();
    res.type('text/plain; charset=utf-8').send(
      '# This is exactly what the AI is told about material sizes.\n' +
      '# ~' + Math.round(txt.length / 4) + ' tokens, cached 12h and prompt-cached.\n\n' + txt);
  } catch (err) {
    res.status(500).type('text/plain').send('Could not build the size catalog: ' + String((err && err.message) || err));
  }
});

// The review page's material check reads the SAME list the model was given.
app.get('/api/takeoff/catalog-index', async (req, res) => {
  try {
    res.json({ ok: true, groups: await buildCatalogGroups() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

// What the take-off is actually told the shop stocks — counts + a sample, so the catalog can be
// checked without spending a take-off. Builds (and caches) the same block the run uses.
app.get('/api/takeoff/catalog-check', async (req, res) => {
  try {
    const txt = await buildLiveCatalogContext();
    const groups = (txt.match(/^### /gm) || []).length;
    res.json({
      ok: true, built: !!txt, groups: groups,
      approx_tokens: Math.round(txt.length / 4),
      head: txt.slice(0, 600),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

// CONFIRMED SCOPE TREE — the user-arranged Component→Drawing breakdown, passed in the request body
// as scope_tree = [{ component: "Upper Frame weldment", drawings: ["RIS-48300-S1-A-1", ...] }, ...].
// Turns it into an AUTHORITATIVE prompt block: stronger than fetchProjectContext because the user
// confirmed it, and it shows the nesting (which drawings belong to which component) so the AI tags
// `component` and `source_sheet` consistently. Returns '' if the tree is absent/empty/malformed,
// so the mount falls back to the Zoho-read context.
function buildScopeTreeContext(tree, excluded, aliases, documents) {
  // NON-DRAWING DOCUMENTS in the same upload — a bill of material, a parts/cut list, a spec section.
  // They used to be invisible to the prompt: the model still received the PDF, but nothing told it
  // what the file was, so a 34-page parts list read as unlabelled pages between drawings. Named
  // here, a BOM becomes what it should be — the authoritative count the drawings are checked against.
  const docLines = (Array.isArray(documents) ? documents : []).map(function (d) {
    const num = String((d && d.number) == null ? '' : d.number).trim();
    if (!num) return null;
    const kind = String((d && d.kind) || 'other').toLowerCase();
    const what = kind === 'bom' ? 'BILL OF MATERIAL / PARTS LIST'
               : kind === 'spec' ? 'SPECIFICATION'
               : kind === 'drawings' ? 'DRAWING SET' : 'REFERENCE DOCUMENT';
    const bits = [];
    if (d && d.file) bits.push('file "' + String(d.file).trim() + '"');
    if (d && d.pages) bits.push(String(d.pages) + ' pages');
    if (d && d.component) bits.push('component: ' + String(d.component).trim());
    const sum = String((d && (d.summary || d.title)) || '').trim();
    return '- ' + num + '  [' + what + (bits.length ? ' — ' + bits.join(', ') : '') + ']' + (sum ? '\n    ' + sum : '');
  }).filter(Boolean);
  const docBlock = docLines.length
    ? 'DOCUMENTS IN THIS PACKAGE THAT ARE NOT DRAWINGS — they are part of the scope and are listed on the ' +
      'project alongside the drawings:\n' + docLines.join('\n') + '\n\n' +
      'HOW TO USE THEM:\n' +
      '- READ EVERY ONE of them. A bill of material, parts list or cut list is the most reliable source in ' +
      'the package: it gives marks, sizes, lengths and quantities that a drawing only implies. Take material ' +
      'off it directly.\n' +
      '- DO NOT DOUBLE-COUNT. A member listed in a parts list AND drawn on a sheet is ONE row, not two. Where ' +
      'the two disagree, follow the parts list for quantity and length, follow the drawing for how it is used, ' +
      'and say so once in `notes`.\n' +
      '- CITE THE DRAWING WHEN THERE IS ONE. If a member is on a parts list AND detailed on a drawing, set ' +
      '`source_sheet` to the DRAWING — that is the sheet the shop fabricates from, and it is what makes the row ' +
      'traceable — and set `cross_check` to "both" to record that the list confirmed it. Cite a parts list in ' +
      '`source_sheet` ONLY when it is the sole place the member appears. Tagging every row to the parts list ' +
      'because that is where the quantity came from leaves every drawing looking unused.\n' +
      '- Set `component` from the component the item is listed under above (or the best-fitting component if the ' +
      'document covers several).\n' +
      '- A SUB-ASSEMBLY parts list whose items are already included in a top-level parts list is NOT a second ' +
      'source of material: count each member once, from whichever list is authoritative, and say in `notes` which ' +
      'you treated as the parent.\n' +
      '- A specification is read for grades, finishes and requirements — raise no rows from it.\n\n'
    : '';

  if (!Array.isArray(tree) || !tree.length) {
    return docBlock ? "THIS PROJECT'S CONFIRMED SCOPE:\n\n" + docBlock : '';
  }
  const seenC = {}, nodes = [];
  tree.forEach(function (n) {
    const name = String((n && n.component) == null ? '' : n.component).trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seenC[key]) return;                 // dedupe components by name
    seenC[key] = 1;
    const seenD = {}, draws = [];
    (Array.isArray(n && n.drawings) ? n.drawings : []).forEach(function (d) {
      const dv = String(d == null ? '' : d).trim(); if (!dv) return;
      const dk = dv.toLowerCase(); if (seenD[dk]) return; seenD[dk] = 1; draws.push(dv);
    });
    const units = Math.max(1, Math.round(Number((n && (n.units != null ? n.units : n.quantity))) || 1));
    nodes.push({ name: name, draws: draws, units: units });
  });
  if (!nodes.length) return docBlock ? "THIS PROJECT'S CONFIRMED SCOPE:\n\n" + docBlock : '';
  const allDraws = [];
  const body = nodes.map(function (n) {
    n.draws.forEach(function (d) { if (allDraws.indexOf(d) < 0) allDraws.push(d); });
    return '- ' + n.name + (n.units > 1 ? '  — the job builds ' + n.units + ' of these' : '') +
      (n.draws.length ? '  [drawings: ' + n.draws.join(', ') + ']' : '  [no drawings listed]');
  }).join('\n');
  // Multiplying up is arithmetic and belongs in code, not in a model's head: it does it silently,
  // inconsistently, and the per-unit figure is then unrecoverable. So the model reads ONE unit and
  // the server multiplies.
  const multi = nodes.filter(function (n) { return n.units > 1; });
  const unitsRule = multi.length
    ? '\nHOW MANY OF EACH — READ ONE, NEVER MULTIPLY:\n' +
      multi.map(function (n) { return '- ' + n.name + ': the job builds ' + n.units + ' of them'; }).join('\n') +
      '\nThe drawings detail ONE unit of a component. Report `quantity` for a SINGLE unit — if one platform ' +
      'takes 4 angles, that row is quantity 4, NOT ' + (4 * (multi[0].units || 2)) + '. The multiplication to the ' +
      'job total is done downstream, so multiplying here double-counts the whole component. The ONLY exception ' +
      'is a member the drawing itself states is shared across all units (a common base frame) — put that in its ' +
      'own row, use the real count, and say so in the row `note`.\n'
    : '';
  // Reference-only sheets. They are ON the project like every other drawing — nothing is dropped —
  // but they carry no material to take off (layouts, sections, general notes). READ them for
  // context; just don't raise BOM rows from them.
  const skips = (Array.isArray(excluded) ? excluded : [])
    .map(function (x) {
      const num = String((x && x.number) == null ? '' : x.number).trim();
      if (!num) return null;
      const why = String((x && x.reason) == null ? '' : x.reason).trim();
      return '- ' + num + (why ? '  — ' + why : '');
    }).filter(Boolean);

  // The number printed on the sheet vs. the number this project files it under. The estimator
  // confirmed the two are the same drawing, so tag rows with THEIR number — no guessing.
  const alias = (Array.isArray(aliases) ? aliases : [])
    .map(function (a) {
      const from = String((a && a.pdf_number) == null ? '' : a.pdf_number).trim();
      const to = String((a && a.use_number) == null ? '' : a.use_number).trim();
      return (from && to && from !== to) ? '- the sheet printed "' + from + '" is this project\'s drawing "' + to + '" — use "' + to + '"' : null;
    }).filter(Boolean);

  return "THIS PROJECT'S CONFIRMED SCOPE BREAKDOWN (the estimator arranged and approved this — it is AUTHORITATIVE):\n\n" +
    "COMPONENTS / ASSEMBLIES, each with the drawings it is detailed on:\n" + body + '\n' +
    unitsRule + '\n' +
    docBlock +
    (skips.length ?"REFERENCE-ONLY SHEETS — part of the package and on the project, but no material comes off them:\n" + skips.join('\n') + '\n\n' : '') +
    (alias.length ? "DRAWING NUMBER MAPPING — same drawing, different number printed on the sheet:\n" + alias.join('\n') + '\n\n' : '') +
    "RULES:\n" +
    "- Assign EVERY quantified member's `component` to the single best-fitting name above, spelled EXACTLY as shown.\n" +
    "- Set `source_sheet` to the EXACT drawing number the member is read from; prefer a drawing listed under that member's component.\n" +
    "- Do NOT invent new component names or drawing numbers. If a member genuinely fits none of the above, leave `component` empty and note it in the top-level `notes` — do not force-fit it.\n" +
    (skips.length ? "- READ the reference-only sheets above for context (dimensions, layouts, finishes, connections) but raise NO rows from them. If one clearly carries a fabricated member the estimator may have misjudged, say so once in `notes` rather than adding the row.\n" : '') +
    (alias.length ? "- Apply the drawing number mapping above to `source_sheet` — report the project's number, never the one printed on the sheet.\n" : '') +
    (docLines.length ? "- Every file in this upload is listed above — drawings AND non-drawings. Use all of them; if you find content that fits none of the entries listed, take it off anyway and flag it in `notes`.\n" : '') +
    "- The scope above covers every sheet in the documents. If you find a sheet that is neither listed nor excluded, take it off and flag it in `notes` — it means the intake missed it.\n" +
    (allDraws.length ? "- The full confirmed drawing set: " + allDraws.join(', ') + '.\n' : '');
}

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
// ---------------------------------------------------------------------------
//  BOM PREVIEW — take-off rows, shaped exactly like the BOM records the BOM
//  Editor already knows how to render and edit.
// ---------------------------------------------------------------------------
//  The take-off's rows are NAMES ("Angle", "A36", "L4 x 4 x 1/4"); the editor's
//  grid is bound to record IDs. This resolves one to the other against the same
//  lookups the editor loads, so the estimator can work the take-off in the real
//  BOM grid — with live weights, the catalog cascade and bulk apply — BEFORE
//  anything is written to Zoho. Nothing here writes: it is a read-and-map.
//
//  Names are matched loosely (case, spacing and punctuation ignored) because a
//  model writes "Beam - W" where the catalog says "Beam- W"; anything that does
//  not resolve comes back in `unresolved` and lands in the grid as a blank cell
//  the estimator picks from the dropdown — never as a silent wrong ID.
const _rk = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
function _pickBy(list, name, keyFn) {
  const k = _rk(name);
  if (!k) return null;
  return list.find(x => _rk(keyFn(x)) === k) || null;
}
// Mirrors the editor's computeBomCalcs so the grid opens with weights already in it.
function _bomCalcs(o) {
  const wpf = Number(o.weightPerFt) || 0;
  if (!wpf) return { unitWt: 0, totWt: 0, area: 0, galvLb: 0 };
  const lenFt = (Number(o.ftL) || 0) + (Number(o.inchLres) || 0) / 12;
  const qty = Number(o.qty) || 0;
  let unitWt, oneSide = 0;
  if (o.panel) {
    const lengthIn = (Number(o.ftL) || 0) * 12 + (Number(o.inchLres) || 0);
    const widthIn = (Number(o.ftWres) || 0) * 12 + (Number(o.inchWres) || 0);
    unitWt = wpf * (lengthIn * widthIn) / 144;
    oneSide = (lengthIn * widthIn) / 144;
  } else {
    unitWt = wpf * lenFt;
  }
  const totWt = unitWt * qty;
  let area = 0;
  if (o.sa) area = o.panel ? oneSide * 2 * qty : qty * (Number(o.saPerFt) || 0) * lenFt;
  return { unitWt: Math.round(unitWt * 100) / 100, totWt: Math.round(totWt * 100) / 100,
           area: Math.round(area * 100) / 100, galvLb: o.galv ? Math.round(totWt) : 0 };
}
// feet+inches out of a decimal-feet length, the way the BOM stores it (INCH is a lookup).
function _splitFt(n) {
  const raw = Number(n) || 0;
  const ft = Math.max(0, Math.floor(raw));
  const inch = Math.round((raw - ft) * 12);
  return inch >= 12 ? [ft + 1, 0] : [ft, inch];
}
const _lk = (id, label) => (id ? { ID: String(id), display_value: String(label || ''), zc_display_value: String(label || '') } : '');

app.post('/api/takeoff/bom-preview', async (req, res) => {
  try {
    const body = req.body || {};
    const pid = body.project_id;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!pid) return res.status(400).json({ ok: false, error: 'project_id required' });

    const token = await getAccessToken();
    const [formTypes, matTypes, specs, materials, comps, draws, tables] = await Promise.all([
      cachedLookup('bom-lookups:form-types', 60 * 60 * 1000, async () => {
        const r = await fetchAllZohoPages('/report/Form_Types_Report?criteria=(Active==true)');
        return r.map(x => ({ id: String(x.ID), name: String(x.Form_Type || '').trim(),
                             measurement: String(x.Measurement || '').trim() }));
      }),
      cachedLookup('bom-lookups:material-types', 60 * 60 * 1000, async () => {
        const r = await fetchAllZohoPages('/report/Material_Types_Report');
        return r.map(x => ({ id: String(x.ID), name: String(x.Material_Type || '').trim() }));
      }),
      cachedLookup('bom-lookups:material-form-detail:*|*', 15 * 60 * 1000, async () => {
        const r = await fetchAllZohoPages('/report/Material_Form_Detail_Report');
        return r.map(x => ({ id: String(x.ID), formTypeId: String((x.Form_Type && x.Form_Type.ID) || ''),
                             matTypeId: String((x.Material_Type && x.Material_Type.ID) || ''),
                             typeDetail: String(x.Type_Detail || '').trim() }));
      }),
      cachedLookup('bom-lookups:materials:*|*', 15 * 60 * 1000, async () => {
        const r = await fetchAllZohoPages('/report/Beam_Channel_Tee_Lookup_Report');
        return r.map(x => ({ id: String(x.ID), description: String(x.Description || '').trim(),
                             formTypeId: String((x.Form_Types && x.Form_Types.ID) || ''),
                             matTypeId: String((x.Material_Types && x.Material_Types.ID) || ''),
                             specId: String((x.Specification && x.Specification.ID) || ''),
                             weightPerFt: parseFloat(x.Weight_Lb_Ft) || 0,
                             saPerFt: parseFloat(x.Surface_Area_Per_FT) || 0 }));
      }),
      fetchAllZohoPages('/report/All_Project_Components?criteria=(MCP_Customer_Project_Form==' + pid + ')')
        .then(r => r.map(x => ({ id: String(x.ID), name: String(x.Project_Component || '').trim() })))
        .catch(() => []),
      fetchAllZohoPages('/report/All_Project_Drawing_Details?criteria=(MCP_Customer_Project_Form==' + pid + ')')
        .then(r => r.map(x => ({ id: String(x.ID), number: String(x.Drawing_Number || '').trim() })))
        .catch(() => []),
      fetchLookupTables(token),
    ]);

    const unresolved = [];
    const note = (i, what, value) => { if (value) unresolved.push({ row: i + 1, field: what, value: String(value) }); };

    const records = rows.map(function (r, i) {
      const ft = _pickBy(formTypes, r.form_type, x => x.name);
      const mt = _pickBy(matTypes, r.material_type, x => x.name);
      if (!ft) note(i, 'Form', r.form_type);
      if (!mt) note(i, 'Mat Type', r.material_type);
      // Spec and Material are only meaningful within their Form × Material Type pair — the same
      // string exists under several, and picking the wrong one is what breaks the cascade.
      const specPool = specs.filter(s => (!ft || s.formTypeId === ft.id) && (!mt || s.matTypeId === mt.id));
      const sp = _pickBy(specPool.length ? specPool : specs, r.specification, x => x.typeDetail);
      if (!sp) note(i, 'Spec', r.specification);
      const matPool = materials.filter(m => (!ft || m.formTypeId === ft.id) && (!mt || m.matTypeId === mt.id));
      const pool = matPool.length ? matPool : materials;
      // Exact text first, then MEANING — the same signature match the post-run snapper uses, so a
      // size the model wrote its own way ("1.5 x 1/8", or square tube as "6 x 6 x 3/16" where the
      // catalog says "6 x 3/16") still finds its record instead of arriving as a blank cell.
      let mat = _pickBy(pool, r.size, x => x.description);
      if (!mat && r.size) {
        const want = takeoffSnap.signature(r.size);
        let hits = pool.filter(x => takeoffSnap.sameSig(takeoffSnap.signature(x.description), want));
        if (!hits.length) {
          const collapsed = takeoffSnap.squareTubeCollapse(r.size, r.form_type);
          if (collapsed) {
            const cs = takeoffSnap.signature(collapsed);
            hits = pool.filter(x => takeoffSnap.sameSig(takeoffSnap.signature(x.description), cs));
          }
        }
        if (hits.length === 1) mat = hits[0];      // one unambiguous match only — never a guess
      }
      if (!mat) note(i, 'Material', r.size);

      const comp = _pickBy(comps, r.component, x => x.name);
      if (!comp) note(i, 'Component', r.component);
      const dwg = _pickBy(draws, r.source_sheet, x => x.number);
      if (!dwg) note(i, 'Drawing', r.source_sheet);

      const L = _splitFt(r.length_ft), W = _splitFt(r.width_ft);
      const inchL = findLengthInchId(tables.lengthInch, L[1]);
      const inchW = findLengthInchId(tables.lengthInch, W[1]);
      const ftW = W[0] ? findWidthFtId(tables.plateWidthFt, W[0]) : null;
      const inchLres = L[1], inchWres = W[1];
      const panel = /plate|sheet/i.test(String(r.form_type || ''));
      const qty = Number(r.quantity_total) > 0 ? Number(r.quantity_total) : (Number(r.quantity) || 0);
      const calcs = _bomCalcs({ weightPerFt: mat ? mat.weightPerFt : 0, saPerFt: mat ? mat.saPerFt : 0,
        ftL: L[0], inchLres: inchLres, ftWres: W[0], inchWres: inchWres, qty: qty,
        panel: panel, sa: false, galv: !!r.galvanized });

      return {
        ID: 'T' + (i + 1),                       // preview id — no Zoho record exists yet
        Line_Item: i + 1,
        BOM_Item: String(r.member_mark || '').trim() || ('AI-' + String(i + 1).padStart(3, '0')),
        Component: _lk(comp && comp.id, (comp && comp.name) || r.component),
        Scope_LU: _lk(dwg && dwg.id, (dwg && dwg.number) || r.source_sheet),
        Form_Type: _lk(ft && ft.id, (ft && ft.name) || r.form_type),
        Material_Type: _lk(mt && mt.id, (mt && mt.name) || r.material_type),
        Specification: _lk(sp && sp.id, (sp && sp.typeDetail) || r.specification),
        Material: _lk(mat && mat.id, (mat && mat.description) || r.size),
        Quantity: qty,
        Length_FT: L[0],
        Length_INCH: _lk(inchL, String(inchL ? L[1] : '')),
        Width_FT: _lk(ftW, ftW ? String(W[0]) : ''),
        Width_INCH: _lk(inchW, String(inchW ? W[1] : '')),
        Material_Description_And_Dimension: [String(r.size || ''), String(r.specification || '')].filter(Boolean).join(' '),
        Unit_Weight: calcs.unitWt,
        CalcWeight: calcs.totWt,
        Weight_Per_Ft: mat ? mat.weightPerFt : 0,
        Area: calcs.area,
        Plate_SA: false,
        Galv: !!r.galvanized,
        Galv_LB: calcs.galvLb,
        Supplied: 'Manufacture',
        Finish: r.galvanized ? 'Galvanize' : 'Plain',
        Total_Allotted_Line_Amount: 0,
        DELETE_field: false,
        // carried through so the review page can map an edited row back to the take-off package
        _takeoff_index: i,
        _cross_check: String(r.cross_check || ''),
        _units: Math.max(1, Math.round(Number(r.units) || 1)),
        _qty_per_unit: Number(r.qty_per_unit != null ? r.qty_per_unit : r.quantity) || 0,
      };
    });

    res.json({ ok: true, records: records, unresolved: unresolved,
               counts: { rows: records.length, unresolved: unresolved.length } });
  } catch (err) {
    console.error('bom-preview error', err && (err.message || err));
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

app.post('/api/takeoff/index', (req, res) => indexHandler(req, res)); // intake: read sheet numbers + page ranges
app.post('/api/takeoff/ask', (req, res) => askHandler(req, res));     // intake: ask about the uploaded documents

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
    // Replace, not Append: the widget holds the COMPLETE BOM and re-sends it whole on every
    // commit (incl. the "Add drawings" flow, which merges in-browser first). With the import's
    // Append mode now live (2026-07), 'Append' here would duplicate the BOM on any re-commit.
    const createResp = await axios.post(base + '/form/Import_BOM_Form',
      { data: { Project_ID: project_id, BOM_Import_Mode: 'Replace' } },
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
      return res.status(502).json({ ok: false, error: 'The data service rejected the save', detail: zr.data });
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
  // THREE KINDS OF CORRECTION, used three different ways. Lumping them together made an
  // instruction ("weight per foot IS the size designation") read as if the estimator had "chosen"
  // it from a menu, which is not what it is and not how the model should apply it.
  const kind = function (r) {
    const s = String(r.Source || '').toLowerCase().trim();
    return (s === 'instruction' || s === 'material') ? s : 'decision';
  };

  // 1. DECISIONS — tally the human's choice per judgment call; the prevailing one is the default.
  const byCtx = {};
  recs.filter(function (r) { return kind(r) === 'decision'; }).forEach(function (r) {
    const ctx = String(r.Context || '').trim(); const hv = String(r.Human_Value || '').trim();
    if (!ctx || !hv) return;
    byCtx[ctx] = byCtx[ctx] || {};
    byCtx[ctx][hv] = (byCtx[ctx][hv] || 0) + 1;
  });
  const decision = [];
  Object.keys(byCtx).forEach(function (ctx) {
    const choices = byCtx[ctx]; let best = '', bestN = 0, total = 0;
    Object.keys(choices).forEach(function (c) { total += choices[c]; if (choices[c] > bestN) { best = c; bestN = choices[c]; } });
    decision.push('- "' + ctx + '"  ->  this shop chose: "' + best + '"' + (total > 1 ? ' (' + bestN + '/' + total + ')' : ''));
  });

  // 2. INSTRUCTIONS — what the estimator told the AI to change after reading a take-off. These are
  // rules about how THIS customer's documents are written and they hold for the next package too:
  // "the parts list gives WEIGHT PER FOOT, and that number IS the channel designation". Newest
  // first, deduped, capped — a standing rule stops being useful if it's buried in fifty of them.
  const seenIns = {}, instruction = [];
  recs.filter(function (r) { return kind(r) === 'instruction'; })
    .sort(function (a, b) { return String(b.Created || '').localeCompare(String(a.Created || '')); })
    .forEach(function (r) {
      const ctx = String(r.Context || '').trim();
      const k = ctx.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!ctx || seenIns[k] || instruction.length >= 25) return;
      seenIns[k] = 1;
      const did = String(r.Human_Value || '').trim();
      instruction.push('- ' + ctx + (did ? '\n    (last time, this produced: ' + did.slice(0, 180) + ')' : ''));
    });

  // 3. MATERIAL WORDING — what the AI wrote vs what this shop's catalog actually calls it.
  const seenMat = {}, material = [];
  recs.filter(function (r) { return kind(r) === 'material'; }).forEach(function (r) {
    const av = String(r.AI_Value || '').trim(), hv = String(r.Human_Value || '').trim();
    const k = (av + '=>' + hv).toLowerCase();
    if (!av || !hv || seenMat[k] || material.length >= 40) return;
    seenMat[k] = 1;
    material.push('- ' + String(r.Context || '').replace(/ · [^·]*$/, '').trim() + ': "' + av + '" should be written "' + hv + '"');
  });

  const out = [];
  if (decision.length) {
    out.push("THIS FABRICATOR'S PAST DECISIONS (apply as standing preferences): when the SAME judgment call " +
      "appears in this take-off, pre-resolve it to this shop's prior choice and set that decision's " +
      "ai_recommendation accordingly. A repeated choice is a strong default. Their history:\n" + decision.join('\n'));
  }
  if (instruction.length) {
    out.push("STANDING INSTRUCTIONS FROM THIS FABRICATOR — corrections they have made to previous take-offs. " +
      "These are how THIS customer's drawings and parts lists are written, so APPLY THEM AGAIN from the " +
      "start unless the documents in front of you plainly contradict them. Say in `notes` where you applied " +
      "one:\n" + instruction.join('\n'));
  }
  if (material.length) {
    out.push("SIZES THIS SHOP HAS RE-SPELLED BEFORE — the left side is what a take-off wrote, the right side " +
      "is what their catalog calls the same steel. Use the right-hand spelling:\n" + material.join('\n'));
  }
  return out.join('\n\n');
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
    if (resp.data?.code === 4000) return res.status(429).json({ error: 'Daily data limit reached. This resets overnight; try again then.', code: 4000 });
    if (!resp.data.data?.length) {
      console.log('Project not found on first attempt, forcing token refresh and retrying...');
      token = await getAccessToken(true);
      resp = await axios.get(creatorApiBase()+'/report/All_Projects?criteria=(ID=='+req.params.id+')', { headers: zohoHeaders(token) });
    }
    if (resp.data?.code === 4000) return res.status(429).json({ error: 'Daily data limit reached. This resets overnight; try again then.', code: 4000 });
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
// The single most expensive read in the app: it paginates the WHOLE material
// catalog at 200 rows a call, and every BOM load needs it. At a 30-minute TTL,
// per process, across multiple Railway instances, it rebuilt itself all day and
// dominated the 1,000/day developer allowance.
//
// The catalog only changes when it is deliberately regenerated, so it is cached
// for a working day instead. POST /api/cache-clear flushes it immediately after
// a regeneration — that is the release valve that makes the long TTL safe.
const MATERIAL_WEIGHT_TTL_MS = 12 * 60 * 60 * 1000;

async function getMaterialWeightMap() {
  return cachedLookup('material-weight-map', MATERIAL_WEIGHT_TTL_MS, async () => {
    const startedAt = Date.now();
    const rows = await fetchAllZohoPages('/report/Beam_Channel_Tee_Lookup_Report');
    const map = {};
    rows.forEach(r => { map[String(r.ID)] = parseFloat(r.Weight_Lb_Ft) || 0; });
    console.log('material-weight-map built: ' + Object.keys(map).length + ' materials from '
      + rows.length + ' rows (~' + Math.ceil(rows.length / 200) + ' API calls, '
      + (Date.now() - startedAt) + 'ms) — cached for ' + (MATERIAL_WEIGHT_TTL_MS / 3600000) + 'h');
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

// The cap is a runaway guard, not a size limit — it exists so a bad criteria can't page forever.
// It was 5000, which the material catalog quietly outgrew (8,858 sizes and climbing): every read
// silently returned the first 5000, so real sizes looked invalid and weights came back 0. Raised
// well past any current table, and truncation is now recorded and reported instead of being a
// console warning nobody sees. Reads that hit this are all cached, so the paging cost is rare.
const PAGE_CAP = 40000;                 // 200/page → 200 calls worst case, on a cache miss only
const TRUNCATED = {};                   // reportPath → { rows, cap, at } for /api/lookups/truncation

async function fetchAllZohoPages(reportPath, capOverride) {
  const token = await getAccessToken();
  let all = [];
  const pageSize = 200;  // Zoho v2.1 API rejects > 200 with code 2945 MORE_THAN_MAX_LENGTH
  const hardCap = Number(capOverride) > 0 ? Number(capOverride) : PAGE_CAP;
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
      // Hitting the cap means the caller is holding an INCOMPLETE table and doesn't know it —
      // that's how "the catalog doesn't have this size" and "weight 0" bugs start. Make it loud
      // and queryable rather than a warning in a log nobody reads.
      TRUNCATED[reportPath] = { rows: all.length, cap: hardCap, at: new Date().toISOString() };
      console.error('[zoho] TRUNCATED read — hit the ' + hardCap + '-row cap on ' + reportPath +
        '. The caller is working from an incomplete table; raise PAGE_CAP.');
      break;
    }
  }
  return all;
}

// Any table read since boot that came back incomplete. Empty = every lookup is whole.
app.get('/api/lookups/truncation', (req, res) => {
  const list = Object.keys(TRUNCATED).map(function (k) { return Object.assign({ report: k }, TRUNCATED[k]); });
  res.json({ ok: true, cap: PAGE_CAP, truncated: list, healthy: list.length === 0 });
});

// Backend errors get shown to tenants verbatim and they name the data platform.
// The product is Material Compass, so rewrite them on the way out. The raw text
// still goes to the server log, where it's needed for debugging. Mirrors
// takeoff/route.js `outward()`, which does the same for the model vendor.
function outward(text) {
  if (text == null) return text;
  return String(text)
    .replace(/\bZoho (?:Creator |Developer )?API\b/gi, 'the data service')
    .replace(/\bZoho Creator\b/gi, 'the data service')
    .replace(/\bZoho\b/gi, 'the data service');
}

function sendZohoAwareError(res, err) {
  if (err instanceof ZohoApiError) {
    // 503 Service Unavailable is the closest HTTP semantic for "the platform
    // exhausted my daily quota"
    const status = err.zohoCode === 4000 ? 503 : 502;
    if (err.zohoCode === 4000) console.error('Zoho quota exhausted (code 4000):', err.zohoMessage);
    return res.status(status).json({
      error: err.zohoCode === 4000 ? 'Daily data limit reached' : 'Data service error',
      zoho_code: err.zohoCode,
      zoho_message: outward(err.zohoMessage),
      hint: err.zohoCode === 4000
        ? 'The daily read/write allowance is used up. It resets overnight — try again then.'
        : null,
    });
  }
  // Keep `details` the same type callers already handle — scrub strings in place,
  // leave the platform's own JSON body as an object.
  const details = err.response?.data ?? err.message;
  res.status(500).json({ error: 'Failed', details: typeof details === 'string' ? outward(details) : details });
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
// A report only returns the columns it's configured with, so a field can exist on the form and be
// invisible here — which is exactly how a null slips through unnoticed. This asks Creator for the
// form's real field list. GET /api/bom-lookups/__fields?form=Project_Components_Form
app.get('/api/bom-lookups/__fields', async (req, res) => {
  try {
    const token = await getAccessToken();
    const form = req.query.form || 'Project_Components_Form';
    const url = 'https://www.zohoapis.com/creator/v2.1/meta/' + ZOHO.accountOwner + '/' + ZOHO.appLinkName +
      '/form/' + form + '/fields';
    const r = await axios.get(url, { headers: zohoHeaders(token) });
    res.json({ ok: true, form: form, fields: r.data && r.data.fields });
  } catch (err) {
    res.status(500).json({ ok: false, zoho_status: err.response && err.response.status,
      zoho_body: err.response && err.response.data, message: err.message });
  }
});

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

    // Superseding the previous approved run happens LAST, once the replacement
    // exists and its rows are written. It used to run first, so any failure
    // after it — an exhausted allowance being the obvious one — left the project
    // with its good run demoted and no new one to replace it. That is how a
    // project ends up with runs on file and none approved.
    const approvedRuns = existingRuns.filter(r => r.Run_Status === 'Approved');

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
    // An exhausted allowance answers HTTP 200 with code 4000 and no record, so
    // reading .data.data.ID blind threw a TypeError and surfaced as a generic
    // "Failed to save results" — the user was told nothing useful and the run
    // silently did not exist. Check before dereferencing.
    if (hr.data && hr.data.code === 4000) {
      console.error('Quota exhausted creating the run header for project ' + projectId);
      return res.status(429).json({ error: 'Daily data limit reached — the nesting run was NOT saved. This resets overnight; try again then.', code: 4000 });
    }
    const nestRunID = hr.data && hr.data.data && hr.data.data.ID;
    if (!nestRunID) {
      console.error('Run header not created:', JSON.stringify(hr.data));
      return res.status(502).json({ error: 'The nesting run header could not be created, so nothing was saved.', detail: hr.data });
    }

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

    // Only now is it safe to demote the previous run. If nothing was written,
    // leave the old one approved — a stale plan beats no plan at all.
    let superseded = 0;
    if (s1d + s2d > 0) {
      for (const pr of approvedRuns) {
        try {
          await axios.patch(creatorApiBase()+'/report/Nesting_Run_Header_Report/'+pr.ID,
            { data: { Run_Status: 'Superseded' } }, { headers: zohoHeaders(token) });
          superseded++;
        } catch (e) { console.error('Supersede failed for run ' + pr.ID); }
      }
    } else {
      console.warn('No stock results written — leaving ' + approvedRuns.length + ' prior run(s) approved');
    }

    res.json({ success: true, nest_run_id: nestRunID, run_number: existingRuns.length + 1, run_status: 'Approved', saved_1d: s1d, saved_2d: s2d, superseded_runs: superseded, wrote_nothing: (s1d + s2d) === 0 });
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
      widthFt: parseFloat(row.Width) || 0
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
    const r = await axios.get(creatorApiBase()+'/report/Material_Types_Report?limit=200', { headers: zohoHeaders(token) });
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
      // These land in tight decimal fields on the form. Buy sizes now round to
      // 1/8", and half the eighths (.125/.375/.625/.875) need THREE decimals —
      // more than the fields hold, which rejects the whole row with code 3001
      // ("has exceeded its maximum digits"). Clamp to 2dp: the ~0.005" it costs
      // is meaningless on a purchase line, and losing the line is not.
      var lengthInchResult = safeNum(lengthInchId ? findLengthInchResult(lookups.lengthInch, lengthInchId) : lenInchRem, 2);
      var widthFtResult = safeNum(widthFtId ? findWidthFtResult(lookups.plateWidthFt, widthFtId) : widFt, 2);
      var widthInchResult = safeNum(widthInchId ? findLengthInchResult(lookups.lengthInch, widthInchId) : widInchRem, 2);
      var unitWt = Math.round((parseFloat(line.unit_weight) || 0) * 100) / 100;
      var qty = safeNum(line.quantity, 0);
      var totalWt = Math.round(unitWt * qty * 100) / 100;
      var area = is2D ? safeNum((stockLenIn * stockWidIn) / 144, 2) : 0;
      var totalLength = is2D ? 0 : safeNum((lenFt * 12) + lengthInchResult, 2);
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
        Total_Plate_Width: safeNum(totalPlateWidth, 2),
        Material_Size: safeNum(line.material_size, 2),
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
      // Inventory plumbing. Material_Source lets the Purchase view exclude shop
      // stock while the allotted totals stay whole; Stock_Reference is the heat
      // number / bin the user typed, which is the only link from a consumed piece
      // back to a physical one. Both are stripped automatically if the form does
      // not carry them yet — see the retry in the insert loop.
      row.Material_Source = line.on_hand ? 'On Hand' : 'Purchase';
      if (line.stock_reference) row.Stock_Reference = String(line.stock_reference).slice(0, 255);
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
        return res.status(429).json({ error: 'Daily data limit reached — purchase list NOT saved. This resets overnight; try again then.', code: 4000 });
      }
      var existingRows = (existingResp.data && existingResp.data.data) || [];
      console.log('Deleting ' + existingRows.length + ' existing rows before re-insert...');
      for (var d = 0; d < existingRows.length; d++) {
        try {
          await axios.delete(creatorApiBase()+'/report/Project_Material_Allocated_Detail_Form_Report/'+existingRows[d].ID, { headers: zohoHeaders(token) });
        } catch (delErr) {
          var dd = delErr.response && delErr.response.data;
          if (dd && dd.code === 4000) {
            return res.status(429).json({ error: 'Daily data limit reached while clearing old rows — purchase list NOT saved (would duplicate). This resets overnight; try again then.', code: 4000 });
          }
          deleteFailed = true;
          console.error('Failed to delete row ' + existingRows[d].ID + ':', dd || delErr.message);
        }
      }
    } catch (fetchErr) {
      var fd = fetchErr.response && fetchErr.response.data;
      if (fd && fd.code === 4000) {
        return res.status(429).json({ error: 'Daily data limit reached — purchase list NOT saved. This resets overnight; try again then.', code: 4000 });
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
    var dropNewFields = false;
    function stripNewFields(r) {
      var c = Object.assign({}, r);
      delete c.Material_Source; delete c.Stock_Reference;
      return c;
    }
    // Zoho has no single code for "no such field", so match on the message. Only
    // treat it as such when NO row succeeded — a genuine per-row rejection must
    // not silently strip the new fields from everything.
    function looksLikeUnknownField(body) {
      var rows = (body && body.result) || [];
      if (rows.some(function(r) { return r && (r.code === 3000 || (r.data && r.data.ID)); })) return false;
      var text = JSON.stringify(body || {}).toLowerCase();
      return text.indexOf('material_source') > -1 || text.indexOf('stock_reference') > -1
        || text.indexOf('no such field') > -1 || text.indexOf('invalid field') > -1;
    }
    for (var c = 0; c < subformRows.length; c += CHUNK) {
      var batch = subformRows.slice(c, c + CHUNK);
      try {
        if (dropNewFields) batch = batch.map(stripNewFields);
        var postResp = await axios.post(creatorApiBase()+'/form/Project_Material_Allocated_Detail_Form', { data: batch }, { headers: zohoHeaders(token) });
        var body = postResp.data || {};
        // A form without the two new fields rejects every row. Rather than lose
        // the whole list, drop them and send the batch again, then report it.
        if (!dropNewFields && looksLikeUnknownField(body)) {
          console.warn('Project_Material_Allocated_Detail_Form has no Material_Source/Stock_Reference — retrying without them');
          dropNewFields = true;
          batch = batch.map(stripNewFields);
          postResp = await axios.post(creatorApiBase()+'/form/Project_Material_Allocated_Detail_Form', { data: batch }, { headers: zohoHeaders(token) });
          body = postResp.data || {};
        }
        // Whole-request failure (e.g. quota 4000) — no per-record result array.
        if (body.code === 4000) {
          return res.status(429).json({ error: 'Daily data limit reached — purchase list partially saved (' + saved + '). This resets overnight; try again then.', code: 4000, items_saved: saved, items_attempted: subformRows.length });
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
          return res.status(429).json({ error: 'Daily data limit reached — purchase list partially saved (' + saved + '). This resets overnight; try again then.', code: 4000, items_saved: saved, items_attempted: subformRows.length });
        }
        for (var j = 0; j < batch.length; j++) {
          failures.push({ line: c + j + 1, description: batch[j].Item_Description || ('row ' + (c + j + 1)), code: ed && ed.code, message: ed ? JSON.stringify(ed) : postErr.message });
        }
        console.error('Bulk insert batch failed:', ed || postErr.message);
      }
    }

    console.log('Purchase list save complete: ' + saved + ' rows written, ' + failures.length + ' failed of ' + subformRows.length);
    res.json({ success: true, items_saved: saved, items_attempted: subformRows.length, items_failed: failures.length, failures: failures,
      material_source_written: !dropNewFields,
      on_hand_rows: purchase_lines.filter(function(l) { return l.on_hand; }).length });
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

/**
 * Cut details for many stock results in as few calls as possible.
 *
 * One request per stock result burned the daily allowance fast: a 16-piece run
 * cost 16 calls just to open the results, and the project page auto-loads them
 * on every visit. Criteria accept an OR chain, so ids are batched.
 *
 * A full batch (limit reached) can't be trusted not to have truncated, so those
 * fall back to per-id fetches — correctness first, savings where they're safe.
 */
async function fetchCutDetailsBatched(token, stockResultIds) {
  const BATCH = 10, LIMIT = 200;
  let out = [];
  const stamp = (rows, chunk) => {
    const wanted = new Set(chunk.map(String));
    rows.forEach(c => {
      const lk = c.Nesting_Stock_Result_Lookup;
      let id = String((lk && (lk.ID || lk.id)) || lk || '');
      if (!wanted.has(id) && chunk.length === 1) id = String(chunk[0]);
      c._stock_result_id = id;
    });
    return rows;
  };
  for (let i = 0; i < stockResultIds.length; i += BATCH) {
    const chunk = stockResultIds.slice(i, i + BATCH);
    const crit = '(' + chunk.map(id => 'Nesting_Stock_Result_Lookup==' + id).join('%7C%7C') + ')';
    let rows = null;
    try {
      const resp = await axios.get(
        creatorApiBase() + '/report/All_Nesting_Cut_Details?criteria=' + crit + '&limit=' + LIMIT,
        { headers: zohoHeaders(token) });
      rows = resp.data.data || [];
    } catch (e) {
      if (e.response?.data?.code === 9280) rows = [];   // zero matches
      else { console.error('Cut detail batch error:', e.response?.data || e.message); rows = null; }
    }
    if (rows !== null && rows.length < LIMIT) { out = out.concat(stamp(rows, chunk)); continue; }
    // Batch failed, or came back full and may be truncated — redo it one at a time.
    if (rows !== null) console.warn('Cut detail batch hit the ' + LIMIT + ' row limit; refetching ' + chunk.length + ' individually');
    for (const id of chunk) {
      try {
        const r = await axios.get(
          creatorApiBase() + '/report/All_Nesting_Cut_Details?criteria=(Nesting_Stock_Result_Lookup==' + id + ')&limit=' + LIMIT,
          { headers: zohoHeaders(token) });
        out = out.concat(stamp(r.data.data || [], [id]));
      } catch (e) {
        if (e.response?.data?.code !== 9280) console.error('Cut detail fetch error for SR', id, ':', e.response?.data || e.message);
      }
    }
  }
  return out;
}

/**
 * Ground truth for "why is my saved run not showing". Costs one Zoho read and
 * reports exactly what the lookup saw: the project id the app is using, the
 * response code, and every run header row with its status and its own
 * Project_Lookup — so a mismatched id or a report-level filter is visible
 * rather than inferred.
 */
app.get('/api/project/:id/nesting-runs-debug', async (req, res) => {
  const projectId = req.params.id;
  try {
    const token = await getAccessToken();
    const url = creatorApiBase() + '/report/Nesting_Run_Header_Report?criteria=(Project_Lookup==' + projectId + ')&limit=50';
    let status = null, code = null, rows = [], errBody = null;
    try {
      const r = await axios.get(url, { headers: zohoHeaders(token) });
      status = r.status; code = r.data?.code ?? null; rows = r.data?.data || [];
    } catch (e) {
      status = e.response?.status ?? null;
      code = e.response?.data?.code ?? null;
      errBody = e.response?.data || String(e.message);
    }
    // Decisive second probe: read the SAME report with no criteria at all.
    // A v2.1 report only returns the columns configured on it, so if
    // Project_Lookup is not a column the filtered read can never match and
    // always looks like "no runs" — regardless of how many exist. Comparing
    // filtered against unfiltered separates "none saved" from "cannot see it".
    let anyRows = [], anyCode = null, anyErr = null;
    try {
      const r2 = await axios.get(
        creatorApiBase() + '/report/Nesting_Run_Header_Report?limit=5',
        { headers: zohoHeaders(token) });
      anyCode = r2.data?.code ?? null; anyRows = r2.data?.data || [];
    } catch (e) {
      anyCode = e.response?.data?.code ?? null;
      anyErr = e.response?.data || String(e.message);
    }

    res.json({
      project_id_used: projectId,
      report: 'Nesting_Run_Header_Report',
      criteria: 'Project_Lookup==' + projectId,
      http_status: status,
      zoho_code: code,
      row_count: rows.length,
      quota_exhausted: code === 4000,
      zero_match: code === 9280,
      error: errBody,
      unfiltered_probe: {
        row_count: anyRows.length,
        zoho_code: anyCode,
        error: anyErr,
        // If rows come back here but the filtered read found none, compare these
        // ids against project_id_used — and if Project_Lookup is absent from the
        // sample, it is not a column on the report and that is the whole problem.
        project_lookup_field_present: anyRows.length > 0
          ? Object.prototype.hasOwnProperty.call(anyRows[0], 'Project_Lookup') : null,
        columns_returned: anyRows.length > 0 ? Object.keys(anyRows[0]) : [],
        sample: anyRows.map(r => ({
          id: r.ID,
          run_number: r.Run_Number,
          run_status: r.Run_Status,
          project_lookup: (r.Project_Lookup && (r.Project_Lookup.ID || r.Project_Lookup.zc_display_value)) || r.Project_Lookup || null,
        })),
      },
      runs: rows.map(r => ({
        id: r.ID,
        run_number: r.Run_Number,
        run_status: r.Run_Status,
        run_date: r.Run_Date,
        project_lookup: (r.Project_Lookup && (r.Project_Lookup.ID || r.Project_Lookup.zc_display_value)) || r.Project_Lookup || null,
        total_stock_pieces: r.Total_Stock_Pieces,
      })),
    });
  } catch (err) {
    res.status(500).json({ project_id_used: projectId, error: err.response?.data || err.message });
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
        return res.json({ found: false, message: 'No nesting run has been saved for this project yet.' });
      }
      throw e;
    }
    // A used-up daily allowance answers HTTP 200 with code 4000 and an empty
    // data array, which is indistinguishable from "no records" unless the code
    // is checked. Reporting that as "nothing saved" tells the user their work is
    // gone when it is simply unreadable right now.
    if (runResp.data && runResp.data.code === 4000) {
      console.error('Quota exhausted (code 4000) reading nesting runs for project ' + projectId);
      return res.status(429).json({
        found: false, code: 4000,
        message: 'Daily data limit reached — saved runs cannot be read right now. This resets overnight; your run is not lost.',
      });
    }
    var allRuns = (runResp.data.data || []);
    var runs = allRuns.filter(function(r) { return r.Run_Status === 'Approved'; });
    var supersededOnly = false;
    if (runs.length === 0 && allRuns.length > 0) {
      // Saving marks the previous approved run Superseded BEFORE writing the new
      // one, so an interrupted save (daily quota, network drop) can leave a
      // project with runs on file but none approved. Showing the newest one beats
      // telling the user their work is gone and sending them off to re-nest.
      runs = allRuns.slice();
      supersededOnly = true;
      console.warn('Project ' + projectId + ': no Approved run, falling back to newest of ' + allRuns.length);
    }
    if (runs.length === 0) {
      return res.json({
        found: false,
        message: 'No nesting run has been saved for this project yet. Running a nest does not save it — '
          + 'use "Import Patterns to Project" on the Results step to save one.',
      });
    }
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
      return res.json({ found: true, run_header: { id: nestRunID, run_number: parseInt(runHeader.Run_Number) || 1, run_date: safeStr(runHeader.Run_Date), superseded_only: supersededOnly, run_status: safeStr(runHeader.Run_Status), run_by: safeStr(runHeader.Run_By), notes: safeStr(runHeader.Notes) }, results_1d: [], results_2d: [], summary: { total_stock_pieces: 0, avg_waste_pct_1d: 0, errors: [] }, _nameLookup: {} });
    }
    var stockResultIds = stockResults.map(function(sr) { return sr.ID; });
    var allCutDetails = await fetchCutDetailsBatched(token, stockResultIds);
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
    res.json({ found: true, run_header: { id: nestRunID, run_number: parseInt(runHeader.Run_Number) || 1, run_date: safeStr(runHeader.Run_Date), superseded_only: supersededOnly, run_status: safeStr(runHeader.Run_Status), run_by: safeStr(runHeader.Run_By), kerf_1d: parseFloat(runHeader.Kerf_1D) || 0, kerf_2d: parseFloat(runHeader.Kerf_2D) || 0, notes: (typeof runHeader.Notes === 'object') ? '' : (runHeader.Notes || ''), total_stock_pieces: parseInt(runHeader.Total_Stock_Pieces) || (results_1d.length + results_2d.length) }, results_1d: results_1d, results_2d: results_2d, summary: { total_stock_pieces: results_1d.length + results_2d.length, avg_waste_pct_1d: Math.round(avgWaste1d * 10) / 10, errors: [] }, _nameLookup: nameLookup });
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
    var allCutDetails = await fetchCutDetailsBatched(token, stockResultIds);
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
