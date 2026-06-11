// ============================================================================
// Quote Triage poller — Quote Triage / RFQ intake (Step 4)
// ----------------------------------------------------------------------------
// For each connected mailbox (Mail_Connection rows): read recent mail via
// Microsoft Graph using the stored refresh token, cheaply PRE-FILTER to
// bid-like emails, run Claude extraction ONLY on those, and write each genuine
// opportunity as a Quote_Opportunity row (deduped on Email_Message_ID, with
// addendum-merge by project name).
//
// Trigger: GET /api/triage/poll  (manual, browser-friendly — returns a summary).
// A scheduler (interval / external cron) gets added once this is proven.
//
// Claude: official @anthropic-ai/sdk with forced tool-use, matching the
// take-off engine's pattern. Model = Haiku (cheap; pre-filter gates volume).
// ============================================================================

const _Anthropic = require('@anthropic-ai/sdk');
const Anthropic = _Anthropic.default || _Anthropic;   // 0.40.x CJS interop
const axios = require('axios');
const { getGraphAccessToken, effectiveConfig } = require('./outlook');

const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';     // bump to 'claude-sonnet-4-6' if extraction quality lags

const OPP_FORM   = 'Quote_Opportunity';
const OPP_REPORT = 'Quote_Opportunity_Report';         // confirm this report link name in Zoho
const MC_REPORT  = 'Mail_Connection_Report';

// ---- Cheap pre-filter --------------------------------------------------------
// Only emails that smell like a bid invite reach Claude. Keeps cost down and
// avoids running extraction on newsletters/invoices/etc. Inclusive on purpose.
const BID_SIGNALS = [
  'invitation to bid', 'invite to bid', 'itb', 'request for quote', 'rfq',
  'request for proposal', 'rfp', 'addendum', 'bid date', 'bid due', 'bid time',
  'due date', 'prequalification', 'pre-qualification', 'plans and specs',
  'plans & specs', 'takeoff', 'take-off', 'estimate', 'estimating', 'bid invitation',
  'project documents', 'view documents', 'trades', 'scope of work',
  // common bid platforms / GC senders
  'constructconnect', 'buildingconnected', 'isqft', 'smartbid', 'pipelinesuite',
  'planhub', 'procore', 'dodge', 'bidmail', 'buildingconnected.com',
];
function looksLikeBid(subject, fromAddr, preview) {
  const hay = ((subject || '') + ' ' + (fromAddr || '') + ' ' + (preview || '')).toLowerCase();
  return BID_SIGNALS.some(s => hay.indexOf(s) >= 0);
}

// ---- Claude extraction -------------------------------------------------------
const EXTRACT_SYSTEM =
  "You are a quote-triage assistant for a STRUCTURAL & MISCELLANEOUS STEEL FABRICATOR (Sentry Metal). " +
  "You read one email and decide whether it is a genuine quote/bid opportunity that a steel fabricator could bid, " +
  "then extract key fields via the submit_opportunity tool.\n" +
  "RELEVANT = invitations to bid, RFQs/RFPs, or addendums for construction projects that include steel scope " +
  "(structural steel framing, miscellaneous metals, railings, stairs, ladders, embeds, plate, lintels, bollards, etc.).\n" +
  "NOT RELEVANT (set is_rfq=false, low confidence) = newsletters, invoices, payment notices, purchase orders to us, " +
  "spam, scheduling, or projects with NO steel scope at all.\n" +
  "EXTRACTION RULES:\n" +
  "- customer_name = the company REQUESTING the quote (the GC / EOR / owner), NOT the bid platform (e.g. NOT 'ConstructConnect').\n" +
  "- due_date = the bid/quote due date as YYYY-MM-DD. CRITICAL: if a note, addendum, or 'note to bidders' OVERRIDES the " +
  "labeled bid date (e.g. 'bid date changed from 6/16 to 6/24'), use the OVERRIDE date. Empty string if no due date.\n" +
  "- material_scope = ONLY the steel-relevant trades/scope; omit unrelated divisions (concrete, electrical, painting, etc.).\n" +
  "- notification_type = 'addendum' if this is an addendum to an existing bid, 'new' for a first invitation, else 'other'.\n" +
  "- confidence = 0..1 that this is a genuine steel-relevant opportunity.\n" +
  "Always call submit_opportunity. No prose.";

const EXTRACT_TOOL = {
  name: 'submit_opportunity',
  description: 'Record the triage decision and extracted fields for one email.',
  input_schema: {
    type: 'object',
    properties: {
      is_rfq:            { type: 'boolean', description: 'true if a genuine steel-relevant quote/bid opportunity' },
      confidence:        { type: 'number',  description: '0..1 confidence it is a genuine steel-relevant opportunity' },
      notification_type: { type: 'string',  enum: ['new', 'addendum', 'other'] },
      customer_name:     { type: 'string',  description: 'company requesting the quote (GC/EOR/owner), not the bid platform' },
      project_name:      { type: 'string' },
      due_date:          { type: 'string',  description: 'bid/quote due date YYYY-MM-DD, honoring any override note; empty if none' },
      location:          { type: 'string',  description: 'project location (city, state) or address' },
      material_scope:    { type: 'string',  description: 'steel-relevant scope only' },
      summary:           { type: 'string',  description: '2-3 sentence triage summary' },
    },
    required: ['is_rfq', 'confidence', 'summary'],
  },
};

async function extractOpportunity(client, email) {
  const body = (email.body || '').slice(0, 8000);
  const userText =
    'FROM: ' + (email.fromName || '') + ' <' + (email.fromAddr || '') + '>\n' +
    'RECEIVED: ' + (email.received || '') + '\n' +
    'SUBJECT: ' + (email.subject || '') + '\n\n' +
    'BODY:\n' + body;
  const resp = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 1024,
    system: EXTRACT_SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_opportunity' },
    messages: [{ role: 'user', content: userText }],
  });
  const toolUse = resp.content.find(b => b.type === 'tool_use');
  return { out: toolUse ? toolUse.input : null, usage: resp.usage };
}

// ---- Microsoft Graph ---------------------------------------------------------
async function listRecentMessages(accessToken, top) {
  const url = 'https://graph.microsoft.com/v1.0/me/messages'
    + '?$select=id,internetMessageId,subject,from,receivedDateTime,bodyPreview,hasAttachments,webLink'
    + '&$top=' + (top || 25) + '&$orderby=receivedDateTime desc';
  const resp = await axios.get(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  return (resp.data && resp.data.value) || [];
}
async function fetchMessageText(accessToken, id) {
  // Prefer plain-text body so we don't have to strip HTML.
  const url = 'https://graph.microsoft.com/v1.0/me/messages/' + id + '?$select=subject,body,from,receivedDateTime';
  const resp = await axios.get(url, {
    headers: { Authorization: 'Bearer ' + accessToken, Prefer: 'outlook.body-content-type="text"' },
  });
  return (resp.data && resp.data.body && resp.data.body.content) || '';
}
async function listMessageAttachments(accessToken, id) {
  try {
    const url = 'https://graph.microsoft.com/v1.0/me/messages/' + id + '/attachments?$select=name,contentType,size';
    const resp = await axios.get(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    return ((resp.data && resp.data.value) || []).map(a => a.name).filter(Boolean);
  } catch (e) { return []; }
}

// ---- Zoho date formatting ----------------------------------------------------
// MaterialCompass forms display dates as "MMM dd, yyyy". Writing the wrong
// format gets the row rejected, so we match it — and the insert has a
// retry-without-dates fallback so a format mismatch can never lose a row.
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(isoOrYmd) {
  if (!isoOrYmd) return '';
  const d = new Date(isoOrYmd);
  if (isNaN(d.getTime())) return '';
  return MON[d.getMonth()] + ' ' + String(d.getDate()).padStart(2, '0') + ', ' + d.getFullYear();
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return fmtDate(iso) + ' ' + hh + ':' + mm + ':' + ss;
}

// ---- Route registration ------------------------------------------------------
function registerTriageRoutes(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders } = deps;

  function zCriteria(field, value) {
    // Exact-match text criteria, URL-encoded; strip quotes that would break it.
    const safe = String(value == null ? '' : value).replace(/"/g, '');
    return encodeURIComponent('(' + field + '=="' + safe + '")');
  }

  async function getConnectedMailboxes(mailboxFilter) {
    const token = await getAccessToken();
    const base = creatorApiBase();
    let path = '/report/' + MC_REPORT + '?criteria=' + zCriteria('Connection_Status', 'Connected') + '&limit=200';
    try {
      const r = await axios.get(base + path, { headers: zohoHeaders(token) });
      let rows = (r.data && r.data.data) || [];
      if (mailboxFilter) rows = rows.filter(x => (x.Mailbox_Email || '').toLowerCase() === mailboxFilter.toLowerCase());
      return rows;
    } catch (e) {
      if (e.response && e.response.data && e.response.data.code === 9220) return []; // empty report
      throw e;
    }
  }

  async function opportunityExistsByMessageId(messageId) {
    const token = await getAccessToken();
    const base = creatorApiBase();
    try {
      const r = await axios.get(base + '/report/' + OPP_REPORT + '?criteria=' + zCriteria('Email_Message_ID', messageId) + '&limit=1',
        { headers: zohoHeaders(token) });
      return ((r.data && r.data.data) || []).length > 0;
    } catch (e) {
      if (e.response && e.response.data && e.response.data.code === 9220) return false;
      throw e;
    }
  }

  async function findOpenOpportunityByProject(projectName) {
    if (!projectName) return null;
    const token = await getAccessToken();
    const base = creatorApiBase();
    try {
      const r = await axios.get(base + '/report/' + OPP_REPORT + '?criteria=' + zCriteria('Project', projectName) + '&limit=5',
        { headers: zohoHeaders(token) });
      const rows = (r.data && r.data.data) || [];
      // Prefer a still-open one (not Decline/Archived).
      return rows.find(x => x.Status !== 'Decline' && x.Status !== 'Archived') || rows[0] || null;
    } catch (e) {
      if (e.response && e.response.data && e.response.data.code === 9220) return null;
      throw e;
    }
  }

  // Insert with a retry-without-dates fallback (date-format mismatch never drops the row).
  async function insertOpportunity(fields) {
    const token = await getAccessToken();
    const base = creatorApiBase();
    try {
      const resp = await axios.post(base + '/form/' + OPP_FORM, { data: fields },
        { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      return { id: resp.data?.data?.ID || null, dateDropped: false };
    } catch (e) {
      const code = e.response?.data?.code;
      // 3002 = value/format error (often a date field). Retry without the date fields.
      const retry = { ...fields };
      delete retry.Received_Date; delete retry.Due_Date;
      console.error('[triage] insert failed (code ' + code + '), retrying without dates:', JSON.stringify(e.response?.data || e.message));
      const resp = await axios.post(base + '/form/' + OPP_FORM, { data: retry },
        { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      return { id: resp.data?.data?.ID || null, dateDropped: true };
    }
  }

  async function patchOpportunity(id, fields) {
    const token = await getAccessToken();
    const base = creatorApiBase();
    await axios.patch(base + '/report/' + OPP_REPORT + '/' + id, { data: fields },
      { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
  }

  async function updateConnection(id, fields) {
    const token = await getAccessToken();
    const base = creatorApiBase();
    await axios.patch(base + '/report/' + MC_REPORT + '/' + id, { data: fields },
      { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
  }

  async function pollMailbox(conn, opts) {
    const summary = {
      mailbox: conn.Mailbox_Email, scanned: 0, prefiltered: 0, extracted: 0,
      written: 0, updated: 0, skipped_dupe: 0, not_rfq: 0, errors: [],
    };
    const manufactureId = conn.Manufacture?.ID || conn.Manufacture || '';
    let accessToken;
    try {
      const tok = await getGraphAccessToken(conn.Refresh_Token);
      accessToken = tok.access_token;
      // Microsoft may rotate the refresh token — persist the new one.
      if (tok.refresh_token && tok.refresh_token !== conn.Refresh_Token) {
        await updateConnection(conn.ID, { Refresh_Token: tok.refresh_token });
      }
    } catch (e) {
      const detail = e.response?.data?.error_description || e.message;
      summary.errors.push('token: ' + detail);
      await updateConnection(conn.ID, { Connection_Status: 'Error', Sync_Error: String(detail).slice(0, 2000) });
      return summary;
    }

    const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from env
    let messages = [];
    try { messages = await listRecentMessages(accessToken, opts.top); }
    catch (e) { summary.errors.push('list: ' + (e.response?.data?.error?.message || e.message)); return summary; }

    summary.scanned = messages.length;
    let newestSeen = conn.Last_Seen_Message || '';

    for (const m of messages) {
      try {
        const fromAddr = m.from?.emailAddress?.address || '';
        const fromName = m.from?.emailAddress?.name || '';
        if (m.receivedDateTime > newestSeen) newestSeen = m.receivedDateTime;

        if (!looksLikeBid(m.subject, fromAddr, m.bodyPreview)) continue;
        summary.prefiltered++;

        const messageId = m.internetMessageId || m.id;
        if (await opportunityExistsByMessageId(messageId)) { summary.skipped_dupe++; continue; }

        const body = await fetchMessageText(accessToken, m.id);
        const { out } = await extractOpportunity(anthropic, {
          fromName, fromAddr, received: m.receivedDateTime, subject: m.subject, body,
        });
        summary.extracted++;
        if (!out || !out.is_rfq) { summary.not_rfq++; continue; }

        const attachments = m.hasAttachments ? await listMessageAttachments(accessToken, m.id) : [];
        const extractedJson = JSON.stringify({
          ...out, attachments, source: fromAddr, webLink: m.webLink, message_id: messageId,
        });

        // Addendum merge: if a still-open opportunity for this project exists, update it.
        const existing = (out.notification_type === 'addendum')
          ? await findOpenOpportunityByProject(out.project_name) : null;

        if (existing) {
          await patchOpportunity(existing.ID, {
            Summary: (out.summary || '') + '\n\n[Addendum ' + (m.receivedDateTime || '') + '] ' + (existing.Summary || ''),
            Due_Date: fmtDate(out.due_date) || existing.Due_Date,
            Extracted_JSON: extractedJson,
          });
          summary.updated++;
          continue;
        }

        const fields = {
          Source_inbox: conn.Mailbox_Email,
          Email_Message_ID: messageId,
          Received_Date: fmtDateTime(m.receivedDateTime),
          From_Name: fromName,
          From_Email: fromAddr,
          Subject_field: m.subject || '',
          Summary: out.summary || '',
          Customer_Name: out.customer_name || '',
          Project: out.project_name || '',
          Due_Date: fmtDate(out.due_date),
          Location: out.location || '',
          Material_Scope: out.material_scope || '',
          Confidence: typeof out.confidence === 'number' ? Math.round(out.confidence * 100) / 100 : 0,
          Status: 'New',
          Extracted_JSON: extractedJson,
        };
        if (manufactureId) fields.Manufacture = manufactureId;

        const res = await insertOpportunity(fields);
        summary.written++;
        if (res.dateDropped) summary.errors.push('dates dropped on ' + (m.subject || messageId) + ' (format mismatch)');
      } catch (e) {
        summary.errors.push('msg ' + (m.subject || m.id) + ': ' + (e.response?.data?.message || e.response?.data?.error?.message || e.message));
      }
    }

    await updateConnection(conn.ID, {
      Last_Synced: new Date().toISOString(),
      Last_Seen_Message: newestSeen,
      Connection_Status: 'Connected',
      Sync_Error: '',
    });
    return summary;
  }

  // Manual trigger. ?mailbox=<email> to limit; ?top=N to cap messages scanned.
  app.get('/api/triage/poll', async (req, res) => {
    try {
      const opts = { top: Math.min(parseInt(req.query.top, 10) || 25, 50) };
      const conns = await getConnectedMailboxes(req.query.mailbox);
      if (!conns.length) return res.json({ ok: true, message: 'No connected mailboxes', results: [] });
      const results = [];
      for (const c of conns) results.push(await pollMailbox(c, opts));
      res.json({ ok: true, mailboxes: conns.length, results });
    } catch (err) {
      console.error('[triage] poll error:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data || err.message });
    }
  });

  // Diagnostic: what does Graph actually see in this mailbox?
  app.get('/api/triage/debug', async (req, res) => {
    try {
      const conns = await getConnectedMailboxes(req.query.mailbox);
      if (!conns.length) return res.json({ ok: false, message: 'No connected mailboxes' });
      const conn = conns[0];
      const tok = await getGraphAccessToken(conn.Refresh_Token);
      const at = tok.access_token;
      const h = { Authorization: 'Bearer ' + at };

      const inbox = await axios.get('https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount', { headers: h }).then(r => r.data).catch(e => ({ error: e.response?.data || e.message }));
      const folders = await axios.get('https://graph.microsoft.com/v1.0/me/mailFolders?$top=30&$select=displayName,totalItemCount', { headers: h }).then(r => (r.data.value || []).map(f => ({ name: f.displayName, count: f.totalItemCount }))).catch(e => ({ error: e.response?.data || e.message }));
      const allMsgs = await axios.get('https://graph.microsoft.com/v1.0/me/messages?$top=10&$select=subject,receivedDateTime,from', { headers: h }).then(r => (r.data.value || []).map(m => ({ subject: m.subject, received: m.receivedDateTime, from: m.from?.emailAddress?.address }))).catch(e => ({ error: e.response?.data || e.message }));
      const inboxMsgs = await axios.get('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=10&$select=subject,receivedDateTime,from', { headers: h }).then(r => (r.data.value || []).map(m => ({ subject: m.subject, received: m.receivedDateTime, from: m.from?.emailAddress?.address }))).catch(e => ({ error: e.response?.data || e.message }));

      res.json({ ok: true, oauth_config: effectiveConfig(), mailbox: conn.Mailbox_Email, inbox_folder: inbox, folders, me_messages_sample: allMsgs, inbox_messages_sample: inboxMsgs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.response?.data || err.message });
    }
  });

  console.log('[triage] poll route registered: GET /api/triage/poll (+ /debug)');
}

module.exports = { registerTriageRoutes };
