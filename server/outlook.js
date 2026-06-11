// ============================================================================
// Outlook / Microsoft 365 inbox connect — Quote Triage / RFQ intake (Step 2)
// ----------------------------------------------------------------------------
// Delegated OAuth (auth-code flow). A user clicks "Connect Inbox", signs into
// their own Outlook, and we store a per-mailbox REFRESH TOKEN so the poller
// (Step 4) can read that mailbox later via Microsoft Graph. No admin consent,
// no app-only mailbox access — each user consents to only their own mail.
//
// WHY a separate module: index.js is a single ~1600-line file. Keeping the
// OAuth surface here means the only change to index.js is one registration
// line (placed BEFORE the catch-all `app.get('*')`, else React eats /connect/*).
//
// STORAGE: this app has no database — Zoho is the datastore. Mailbox
// connections live in a Zoho form `Mail_Connection`. All timestamp/bookkeeping
// fields are plain text (ISO strings) on purpose, to dodge Zoho's date-format
// rejection traps for an internal table. The MS refresh token sits in a
// multi-line field. That's fine for your own inbox; before onboarding OTHER
// manufacturers, move tokens to a real secret store (Railway Postgres) — see
// memory project-quote-triage-intake.
// ============================================================================

const crypto = require('crypto');

const MS_CLIENT_ID     = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_TENANT        = process.env.MS_TENANT || 'common';     // 'common' = multitenant + personal
const MS_REDIRECT_URI  = process.env.MS_REDIRECT_URI;
const MS_SCOPES        = 'offline_access User.Read Mail.Read';   // delegated; space-separated

const AUTH_BASE  = 'https://login.microsoftonline.com/' + MS_TENANT + '/oauth2/v2.0/authorize';
const TOKEN_BASE = 'https://login.microsoftonline.com/' + MS_TENANT + '/oauth2/v2.0/token';

// Zoho form + report link names for the connection store. The default report
// Creator auto-creates when you build the form is "<Form>_Report".
const MC_FORM   = 'Mail_Connection';
const MC_REPORT = 'Mail_Connection_Report';

// ---- Stateless CSRF-safe `state` ------------------------------------------
// No session store here, so we carry the manufacturer id + a nonce in `state`
// and HMAC-sign it with the client secret. On callback we re-verify the
// signature, so a tampered/forged state is rejected.
function signState(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const body = Buffer.from(json, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', MS_CLIENT_SECRET || 'no-secret').update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyState(state) {
  if (!state || state.indexOf('.') < 0) return null;
  const [body, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', MS_CLIENT_SECRET || 'no-secret').update(body).digest('base64url');
  const a = Buffer.from(sig || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (e) { return null; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function htmlPage(title, bodyHtml) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escapeHtml(title) + '</title>'
    + '<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#222}'
    + '.card{border:1px solid #e3e3e3;border-radius:12px;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,.06)}'
    + 'h1{font-size:20px;margin:0 0 12px}.ok{color:#1a7f37}.err{color:#b42318}'
    + 'code{background:#f4f4f5;padding:2px 6px;border-radius:5px}</style></head>'
    + '<body><div class="card">' + bodyHtml + '</div></body></html>';
}

// ---- Microsoft token helpers ----------------------------------------------
const axiosLib = require('axios');

// Exchange an authorization code for tokens (initial connect).
async function exchangeCodeForTokens(code) {
  const form = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: MS_REDIRECT_URI,
    scope: MS_SCOPES,
  });
  const resp = await axiosLib.post(TOKEN_BASE, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return resp.data; // { access_token, refresh_token, expires_in, ... }
}

// Trade a stored refresh token for a fresh access token (used by the poller).
// Microsoft may rotate the refresh token — if a new one comes back, the caller
// should persist it. Exported for Step 4.
async function getGraphAccessToken(refreshToken) {
  const form = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: MS_REDIRECT_URI,
    scope: MS_SCOPES,
  });
  const resp = await axiosLib.post(TOKEN_BASE, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return resp.data; // { access_token, refresh_token?, expires_in, ... }
}

async function getMailboxIdentity(accessToken) {
  const resp = await axiosLib.get('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  const me = resp.data || {};
  return {
    email: (me.mail || me.userPrincipalName || '').toLowerCase(),
    name: me.displayName || '',
  };
}

// ---- Route registration ----------------------------------------------------
// deps = { axios, getAccessToken, creatorApiBase, zohoHeaders } from index.js,
// so we reuse the existing Zoho token machinery instead of duplicating it.
function registerOutlookRoutes(app, deps) {
  const { axios, getAccessToken, creatorApiBase, zohoHeaders } = deps;

  // Upsert a connection row by mailbox email (one row per mailbox).
  async function saveConnection(fields) {
    const token = await getAccessToken();
    const base = creatorApiBase();
    const email = fields.Mailbox_Email;
    // Look for an existing row for this mailbox.
    let existingId = null;
    try {
      const r = await axios.get(base + '/report/' + MC_REPORT + '?criteria=(Mailbox_Email=="' + email + '")&limit=1',
        { headers: zohoHeaders(token) });
      const rows = (r.data && r.data.data) || [];
      if (rows.length) existingId = rows[0].ID;
    } catch (e) {
      // 9280 = "no records" on some reports; treat as not-found, anything else rethrow-ish
      if (!(e.response && e.response.data && e.response.data.code === 9280)) {
        console.error('[outlook] connection lookup error:', e.response?.data || e.message);
      }
    }
    if (existingId) {
      await axios.patch(base + '/report/' + MC_REPORT + '/' + existingId, { data: fields },
        { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      return { id: existingId, mode: 'updated' };
    } else {
      const resp = await axios.post(base + '/form/' + MC_FORM, { data: fields },
        { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      return { id: resp.data?.data?.ID || null, mode: 'created' };
    }
  }

  // 1) START — build the Microsoft consent URL and redirect the user there.
  //    Pass ?manufacture=<Customer_Entry_Form record id> to scope the inbox to
  //    a manufacturer. Optional for a quick self-test (stored blank if absent).
  app.get('/connect/outlook/start', (req, res) => {
    if (!MS_CLIENT_ID || !MS_REDIRECT_URI) {
      return res.status(500).send(htmlPage('Not configured',
        '<h1 class="err">Outlook connect not configured</h1><p>Missing <code>MS_CLIENT_ID</code> or <code>MS_REDIRECT_URI</code> in Railway.</p>'));
    }
    const manufacture = (req.query.manufacture || '').toString();
    const nonce = crypto.randomBytes(8).toString('hex');
    const state = signState({ m: manufacture, n: nonce });
    const url = AUTH_BASE
      + '?client_id=' + encodeURIComponent(MS_CLIENT_ID)
      + '&response_type=code'
      + '&redirect_uri=' + encodeURIComponent(MS_REDIRECT_URI)
      + '&response_mode=query'
      + '&scope=' + encodeURIComponent(MS_SCOPES)
      + '&prompt=select_account'              // lets the user pick the right (work) account
      + '&state=' + encodeURIComponent(state);
    res.redirect(url);
  });

  // 2) CALLBACK — Microsoft redirects back here with ?code & ?state.
  app.get('/connect/outlook/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    if (error) {
      return res.status(400).send(htmlPage('Connect failed',
        '<h1 class="err">Sign-in failed</h1><p>' + escapeHtml(error) + ': ' + escapeHtml(error_description || '') + '</p>'));
    }
    const st = verifyState(state);
    if (!st) {
      return res.status(400).send(htmlPage('Connect failed',
        '<h1 class="err">Invalid state</h1><p>The sign-in response could not be verified. Please start over.</p>'));
    }
    try {
      const tok = await exchangeCodeForTokens(code);
      if (!tok.refresh_token) {
        return res.status(400).send(htmlPage('Connect failed',
          '<h1 class="err">No refresh token returned</h1><p>Make sure <code>offline_access</code> is granted on the app.</p>'));
      }
      const who = await getMailboxIdentity(tok.access_token);
      const nowIso = new Date().toISOString();
      const fields = {
        Mailbox_Email: who.email,
        Mailbox_Name: who.name,
        Provider: 'M365',
        Refresh_Token: tok.refresh_token,
        Connection_Status: 'Connected',
        Connected_On: nowIso,
        Last_Synced: '',
        Last_Seen_Message: '',
        Sync_Error: '',
      };
      if (st.m) fields.Manufacture = st.m; // Zoho lookup accepts the record id
      const saved = await saveConnection(fields);
      return res.send(htmlPage('Inbox connected',
        '<h1 class="ok">&#10003; Inbox connected</h1>'
        + '<p><strong>' + escapeHtml(who.email) + '</strong> is now connected to Material Compass.</p>'
        + '<p>Quote opportunities from this inbox will start appearing in your triage list.</p>'
        + '<p style="color:#888;font-size:13px">Connection ' + escapeHtml(saved.mode) + '.</p>'));
    } catch (err) {
      console.error('[outlook] callback error:', err.response?.data || err.message);
      return res.status(500).send(htmlPage('Connect failed',
        '<h1 class="err">Something went wrong</h1><p>' + escapeHtml(err.response?.data?.error_description || err.message) + '</p>'));
    }
  });

  // 3) STATUS — quick JSON check of connected mailboxes (token never returned).
  app.get('/connect/outlook/status', async (req, res) => {
    try {
      const token = await getAccessToken();
      const base = creatorApiBase();
      let path = '/report/' + MC_REPORT + '?limit=200';
      if (req.query.manufacture) path = '/report/' + MC_REPORT + '?criteria=(Manufacture==' + req.query.manufacture + ')&limit=200';
      const r = await axios.get(base + path, { headers: zohoHeaders(token) });
      const rows = (r.data && r.data.data) || [];
      res.json({
        count: rows.length,
        connections: rows.map(x => ({
          id: x.ID,
          mailbox: x.Mailbox_Email,
          name: x.Mailbox_Name,
          status: x.Connection_Status,
          connected_on: x.Connected_On,
          last_synced: x.Last_Synced,
          manufacture: x.Manufacture?.zc_display_value || x.Manufacture?.display_value || x.Manufacture || '',
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed', details: err.response?.data || err.message });
    }
  });

  console.log('[outlook] connect routes registered: /connect/outlook/start, /callback, /status');
}

module.exports = { registerOutlookRoutes, getGraphAccessToken };
