// ── Supplier platform (off-Zoho strangler) ────────────────────────────────
// v1: suppliers still log into the Zoho portal; the new UI is embedded there and
// passes the logged-in email to Railway. Zoho remains the data store; Railway is
// the API. The ONE place that turns an identity into "which supplier" is
// resolveSupplier() below — every supplier route goes through the withSupplier
// middleware. When auth later moves to Supabase, only resolveSupplier/withSupplier
// change; no route or screen does.

const { matchFittingsForSupplier } = require('./fittingMatch');
const { matchStructuralForSupplier, SUPPLY_REPORT: STRUCT_STOCK_REPORT } = require('./structuralMatch');
const { fetchCatalogs, computeAlteredLine, LineCalcError } = require('./lineCalc');
const filestore = require('./filestore');

const SUPPLIER_REPORT = 'Supplier_Entry_Report';
// Unfiltered reports for a supplier's locations and reps. All_Supplier_Locations /
// All_Supplier_Representatives carry a portal-user filter that hides other users' rows from
// these API reads, so every supplier looked like it had none (2026-11-04) — even though
// registration had created a "Headquarters/Main Location" and the main contact as a rep.
const LOC_REPORT = 'API_Supplier_Locations';
const REP_REPORT = 'API_Supplier_Representatives';

// The Profile shows phones as 716-545-6465; Zoho stores them as +17165456465 (what
// registration writes). Turn a typed US number back into that; leave anything else as typed.
function phoneForZoho(v) {
  const s = String(v == null ? '' : v).trim();
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return s;
}

// Lead-time choices — must mirror the Zoho Lead_Time_For_Ship_Complete (header) dropdown
// EXACTLY (a choice field blanks any non-matching value). "1 Day", then "N Days".
// (Per-line SVD_Lead_Time is a separate NUMERIC "in weeks" field, handled below.)
// Extend this list if the Zoho field carries options beyond 14 days.
const LEAD_TIME_CHOICES = ['1 Day'].concat(
  Array.from({ length: 13 }, (_, i) => (i + 2) + ' Days'));
// Fallback lead time written when a supplier leaves it blank, so the MFG close-out's
// mandatory Lead Time never sees an empty value. Must be one of LEAD_TIME_CHOICES.
const LEAD_TIME_FALLBACK = '7 Days';

// Quote_Is_Valid_For (header) — business days the quote stays valid; drives valid_until.
// Mirror the Zoho choice list (the API doesn't strictly enforce it, but keep values clean).
const QUOTE_VALID_CHOICES = [1, 2, 3, 4, 5, 15, 30, 45];

// Quote_Requirements_Selection (header multi-select) — the MFG's requirements the supplier
// confirms. Mirror the Zoho choice list exactly (alphabetical, as the field is configured).
const QUOTE_REQUIREMENTS_CHOICES = [
  'AIS - Made & Melted in USA', 'API Q1', 'API Q2', 'ASME', 'DFARS 252.225-7009',
  'ISO 14000', 'ISO 14001', 'ISO 17025', 'ISO 22000', 'ISO 45001', 'ISO 50001',
  'ISO 9000', 'ISO 9001', 'MIL-STD-129', 'MTRs Required',
];
// Per-line Item_Requirements (SVD multi-select). Pre-filled from the MFG's per-line
// values; the supplier can edit, and any change is noted in the line comments.
const ITEM_REQUIREMENTS_CHOICES = [
  'Cut To Size', 'Laser Cut', 'Plasma Cut', 'Random Drop', 'See Attached File',
  'See Notes', 'Stock Size', 'Sufficient To Cut', 'Water Jet Cut',
];

// OPEN-RFQ gate: a match only surfaces while its project is in one of these
// Project_Quote_Status values (actively being sourced). Allowlist by design —
// anything else (Awarded/Not Awarded/Canceled/Postpone/Quoted/blank) is hidden.
const OPEN_PROJECT_STATUSES = new Set(['Open', 'Project Not Quoted', 'Project Revise']);
// Account_User_Email is a multi-email field (admin + reps). It is split into its addresses and
// the login must EQUAL one of them, case-insensitive. It used to be a substring test, so
// ?email=a or ?email=@theirdomain.com resolved to some supplier and acted as them (2026-09-28).
// Supplier_Entry's ID is the value stock rows store in Supplier_ID — so this id flows straight
// into the fitting matcher.
function emailMatches(accountUserEmail, email) {
  const want = String(email || '').trim().toLowerCase();
  if (!accountUserEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(want)) return false;
  return String(accountUserEmail).toLowerCase().split(/[\s,;|]+/).some((e) => e === want);
}

// Composite Zoho fields (Name, URL) come back as objects; flatten to a display string.
function flatten(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.zc_display_value || v.display_value || v.value || v.url || '');
  return String(v);
}

const round = (n, dp) => { const f = Math.pow(10, dp); return Math.round((Number(n) || 0) * f) / f; };
// Strip a leading "Item No N" (/ "Item Number N" / "Item #N") prefix from a line
// description — it's redundant on the line records (the row already shows the line #).
const stripItemNo = s => String(s || '').replace(/^\s*item\s*(?:no\.?|number|#)\s*\d+\s*[-–—:.)]*\s*/i, '').trim();
// Coerce a Zoho multi-select (array) OR comma-string into a clean string array.
const asArr = v => Array.isArray(v) ? v.filter(Boolean) : (v == null || v === '' ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean));
// Coerce a possibly-object/array field to a trimmed string.
const asStr = v => (v == null ? '' : (typeof v === 'string' ? v : (Array.isArray(v) ? v.join(', ') : String(v.display_value || v.value || v)))).trim();
// The MFG's per-line "Supplier Notes" arrives under a dot-walked key (Jeffs_Calcs_LU.Supplier_Notes)
// whose exact name varies — find whichever key holds "supplier notes" (but NOT the supplier's own
// "Supplier Comments"), so we don't depend on the precise link name.
const pickNote = row => { const k = Object.keys(row).find(kk => /supplier[_ ]?notes/i.test(kk) && !/comment/i.test(kk)); return k ? asStr(row[k]) : ''; };

// Zoho date fields want the form's display format (MMM dd,yyyy, e.g. "Jul 30,2026").
// The browser date input sends ISO "2026-07-30"; convert, or pass through if unexpected.
function toZohoDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (months[parseInt(m[2], 10) - 1] || m[2]) + ' ' + m[3] + ',' + m[1];
}

// Valid_Until_Date has "Allowed Days = Mon-Fri" — a weekend value is rejected with
// "Choose only available days", failing the whole addRecord. Roll a Sat/Sun ISO date
// forward to the next Monday so the quote's validity never lands on a non-allowed day.
function nextBusinessDayIso(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// Current datetime in the form's display format, e.g. "Jun 20,2026 10:42:03".
function zohoNow() {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return months[d.getMonth()] + ' ' + p(d.getDate()) + ',' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function registerSupplierRoutes(app, deps) {
  const { fetchAllZohoPages, cachedLookup, cacheBust, sendZohoAwareError, getAccessToken, creatorApiBase, zohoHeaders, axios } = deps;
  // The five fittings cascade tables, shared with the take-off rather than loaded twice.
  const loadFittingCatalog = require('./fittingCatalog').makeFittingCatalogLoader({ fetchAllZohoPages, cachedLookup });
  const bust = k => { if (typeof cacheBust === 'function') cacheBust(k); };

  // PATCH one Zoho record; returns {ok, code, message}. Surfaces per-record errors
  // (per the "don't silently drop rows" rule) so a partial submit is visible.
  async function patchRecord(report, id, data) {
    const token = await getAccessToken();
    try {
      const r = await axios.patch(creatorApiBase() + '/report/' + report + '/' + id, { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      const code = r.data && r.data.code;
      return { ok: code === 3000 || code == null, code, message: r.data && r.data.message };
    } catch (e) {
      return { ok: false, code: e.response && e.response.data && e.response.data.code, message: (e.response && JSON.stringify(e.response.data)) || e.message };
    }
  }

  // Resolve a login email → supplier record. Cached (the supplier list is small
  // and changes rarely); short TTL so a newly-registered supplier resolves soon.
  const supplierDirectory = () => cachedLookup('supplier-directory', 5 * 60 * 1000, async () =>
    fetchAllZohoPages('/report/' + SUPPLIER_REPORT));

  async function resolveSupplier(email) {
    if (!email) return null;
    const rows = await supplierDirectory();
    return shapeSupplier(rows.find(r => emailMatches(r.Account_User_Email, email)));
  }

  function shapeSupplier(rec) {
    if (!rec) return null;
    return {
      id: String(rec.ID),
      company_name: rec.Company_Name || '',
      contact_name: flatten(rec.Main_Contact_Name),   // Name field → object
      email: rec.Email || '',
      account_emails: rec.Account_User_Email || '',
      phone: rec.Phone_Number || '',
      website: flatten(rec.Company_Website),           // URL field → object
      account_type: rec.Select_Account_Type || '',
    };
  }

  // Identity seam. v1 reads the email asserted by the embedding Zoho page
  // (?email= or X-Supplier-Email). LATER: verify a Supabase session here instead —
  // this is the only spot that changes.
  async function withSupplier(req, res, next) {
    try {
      const email = req.query.email || req.get('X-Supplier-Email') || '';
      const supplier = await resolveSupplier(email);
      if (!supplier) {
        return res.status(404).json({
          ok: false, error: 'No supplier found for this login.',
          // Generic on purpose: echoing which address missed helps someone probe for real ones.
          hint: email ? 'Sign in with the email on your supplier account.' : 'No email supplied.',
        });
      }
      req.supplier = supplier;
      next();
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  }

  // Manufacturer entering a quote a supplier sent them off-platform (email, PDF, phone).
  // The MFG works the SAME quote card the supplier uses, acting for one supplier, so the
  // record that lands in Zoho is identical to a supplier's own submit. req.onBehalfOf
  // holds the MFG id, and every handler below that sees it narrows to that MFG's RFQ
  // lines: a supplier's other customers never show, and can't be written.
  async function withMfgOnBehalf(req, res, next) {
    try {
      const mfg = String(req.query.manufacturer_id || '').trim();
      const sid = String(req.query.supplier_id || '').trim();
      if (!/^\d+$/.test(mfg)) return res.status(400).json({ ok: false, error: 'Please reopen this page from Material Compass.' });
      // A valid token for another shop is refused outright, even in warn mode.
      if (req.tenant && req.tenant.kind === 'm' && String(req.tenant.id) !== mfg) {
        return res.status(403).json({ ok: false, error: 'Please reopen this page from Material Compass.' });
      }
      if (!/^\d+$/.test(sid)) return res.status(400).json({ ok: false, error: 'Choose a supplier first.' });
      const supplier = shapeSupplier((await supplierDirectory()).find(r => String(r.ID) === sid));
      if (!supplier) return res.status(404).json({ ok: false, error: 'Supplier not found.' });
      req.supplier = supplier;
      req.onBehalfOf = mfg;
      next();
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  }
  // Supplier without a login, on the "Price this quote online" link from the RFQ email.
  // The token (kind "q", minted for <supplier id>_<quote id>) is the whole identity: it
  // opens ONE quote for ONE supplier and nothing else. Same handlers as on-behalf, plus
  // req.onlyQuote, so every list and write below narrows to that quote.
  async function withQuoteLink(req, res, next) {
    try {
      const v = require('./tenantToken').verify(req.get('X-MC-Token') || req.query.t || '');
      if (v.error === 'expired') return res.status(401).json({ ok: false, error: 'This link has expired. Reply to the RFQ email or ask the manufacturer for a new link.' });
      if (v.error || v.kind !== 'q') return res.status(401).json({ ok: false, error: 'This link is not valid. Please use the link in your RFQ email.' });
      const [sid, qid] = v.id.split('_');
      const supplier = shapeSupplier((await supplierDirectory()).find(r => String(r.ID) === sid));
      if (!supplier) return res.status(404).json({ ok: false, error: 'This quote request is no longer available.' });
      const [sent, fit] = await Promise.all([fetchSentRfqs(sid), fetchSentFittingRfqs(sid).catch(() => [])]);
      const q = sent.quotes.find(x => String(x.quote_id) === qid) || fit.find(x => String(x.quote_id) === qid);
      if (!q || !q.manufacturer_id) return res.status(404).json({ ok: false, error: 'This quote request is no longer open.' });
      req.supplier = supplier;
      req.onBehalfOf = String(q.manufacturer_id);
      req.onlyQuote = qid;
      next();
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  }

  // '' on the supplier's own path; the MFG id on the on-behalf and quote-link paths.
  const scopeOf = req => (req.onBehalfOf ? String(req.onBehalfOf) : '');
  // On the quote link, also only that one quote (quoteId required there: no id = out of scope).
  const inScope = (req, mfgId, quoteId) => (!scopeOf(req) || String(mfgId || '') === scopeOf(req))
    && (!req.onlyQuote || String(quoteId || '') === req.onlyQuote);

  // Who am I? — lets the UI greet the supplier + confirm the seam works.
  app.get('/api/supplier/me', withSupplier, (req, res) => {
    res.json({ ok: true, supplier: req.supplier });
  });

  // Resolve project IDs → human info (quote number, client, status, due date) so
  // the UI shows "MCP-10081 · Premier Contracting" instead of a raw record ID.
  // Cached: projects change slowly relative to a dashboard poll.
  async function getProjectInfo(ids) {
    const want = new Set((ids || []).map(String).filter(Boolean));
    if (!want.size) return {};
    const rows = await cachedLookup('projects-directory', 5 * 60 * 1000, async () => {
      return fetchAllZohoPages('/report/All_Projects');
    });
    const map = {};
    for (const r of rows) {
      const id = String(r.ID);
      if (!want.has(id)) continue;
      map[id] = {
        quote_number: r.Project_Quote_Number || '',
        description: r.Project_Description || '',
        client: r['MFG_Client_Form.Client_Company_Name'] || '',
        status: r.Project_Quote_Status || '',
        due_date: r.Quote_Due_Date || '',
      };
    }
    return map;
  }

  // SENT RFQs (structural pipeline) — read the real per-line bridge All_RFQs_Sent_Report
  // scoped to this supplier, grouped into quotes. This is what the MFG actually sent
  // (vs the fitting matcher, which is potential matches). Read-only; safe.
  const lkid = v => (v && typeof v === 'object' ? String(v.ID || v.id || '') : (v != null ? String(v) : ''));

  // Quote-level reference files (Quote_Form.File_upload, exposed on the All_Quotes report as
  // an array of download-path strings). Map quote record ID → [{name, filepath}]. Cached 5 min.
  async function fetchQuoteFiles() {
    return cachedLookup('quote-files', 30 * 60 * 1000, async () => {
      const rows = await fetchAllZohoPages('/report/All_Quotes');
      const map = {};
      for (const q of rows) {
        const arr = Array.isArray(q.File_upload) ? q.File_upload : [];
        const files = arr.map(u => {
          const m = /[?&]filepath=([^&]+)/.exec(String(u));
          const fp = m ? decodeURIComponent(m[1]) : '';
          return fp ? { name: fp.replace(/^\d+_+/, ''), filepath: fp } : null;
        }).filter(Boolean);
        if (files.length) map[String(q.ID)] = files;
      }
      return map;
    });
  }

  // MFG per-line "Supplier Notes" live on Jeffs_Calcs (Jeffs_Calcs_Report), joined to a line by
  // quote + line number. Not reliably exposed on the RFQ report, so fetch them scoped to the
  // supplier's quotes. Best-effort; cached 5 min per supplier.
  async function fetchQuoteNotes(supplierId, quoteIds) {
    // Numeric record IDs only — a non-numeric fallback id (e.g. "q") in a chunk makes
    // Zoho reject the whole OR criteria, blanking valid quotes batched with it.
    const ids = [...new Set((quoteIds || []).map(String).filter(id => /^\d+$/.test(id)))];
    if (!ids.length) return {};
    return cachedLookup('jeffs-notes:' + supplierId, 30 * 60 * 1000, async () => {
      const map = {};
      const CHUNK = 20;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const crit = '(' + ids.slice(i, i + CHUNK).map(id => 'Quote_Form==' + id).join(' || ') + ')';
        let rows = [];
        try { rows = await fetchAllZohoPages('/report/Jeffs_Calcs_Report?criteria=' + encodeURIComponent(crit)); } catch (e) { rows = []; }
        for (const jc of rows) {
          const note = asStr(jc.Supplier_Notes);
          if (!note) continue;
          const qid = lkid(jc.Quote_Form), ln = String(jc.Quote_Line_Item || '');
          if (qid && ln) map[qid + '|' + ln] = note;
        }
      }
      return map;
    });
  }

  // Human-readable "before" values, for the SUPPLIER ALTERED comment on a changed line.
  const origLengthText = r => {
    const ft = Number(r.Length_FT) || 0, inch = Number(r.Length_INCH_Result) || 0;
    return ft + "'" + (inch > 0 ? inch + '"' : '');
  };
  const origSpecName = (r, catalogs) => {
    const s = catalogs.specById[lkid(r.Material_Form_Detail)];
    return s ? s.typeDetail : '';
  };

  // Per-line alteration metadata for the revise UI: what the line currently is and
  // whether its geometry can be recomputed at all. Weight/description are NEVER computed
  // here — that's computeAlteredLine's job on preview + submit.
  //
  // Deliberately TINY. This rides on every line of /rfqs, which returns ~1400 lines for an
  // active supplier; the selectable spec lists are hoisted to a shared top-level catalog
  // (only ~40 distinct lists exist) and referenced by spec_key. Inlining them per line
  // added 727 KB to a 596 KB response.
  function alterationMeta(r, catalogs) {
    const ftId = lkid(r.Form_Type);
    const meta = catalogs.formTypeById[ftId];
    const matTypeId = lkid(r.Material_Type);
    const widFt = Number(r.Width_FT && r.Width_FT.zc_display_value) || 0;
    const weightPerFt = Number(r.Weight_Per_FT) || 0;
    // A line with no weight basis (or a panel with no width) can't have its geometry
    // recomputed — some rows carry a correct Unit_Weight alongside blank inputs, and
    // recomputing would zero it. Those lines allow QTY only. See lineCalc's guard.
    const canAlterLength = weightPerFt > 0 && (!meta || !meta.isPanel || widFt > 0);
    return {
      can_alter_length: canAlterLength,
      is_panel: !!(meta && meta.isPanel),
      length_ft: Number(r.Length_FT) || 0,
      length_inch: Number(r.Length_INCH_Result) || 0,
      spec_id: lkid(r.Material_Form_Detail),
      spec_key: ftId + '|' + matTypeId,     // -> alteration_catalog.specs[spec_key]
    };
  }

  // The selectable Specifications for one form-type + material-type pair. Specs are only
  // valid within the same pair, or the line would stop describing the same product.
  function specOptionsFor(spec_key, catalogs) {
    const [ftId, matTypeId] = String(spec_key).split('|');
    const out = [];
    for (const id of Object.keys(catalogs.specById)) {
      const s = catalogs.specById[id];
      if (s.formTypeId === ftId && s.matTypeId === matTypeId && s.typeDetail) out.push({ id, label: s.typeDetail });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  // ── Saved-quote snapshots ────────────────────────────────────────────────────────────
  // What the card held when a quote was saved: header + every line's option, price and
  // alteration, keyed supplier × MFG quote, on our own disk. Reopening a saved quote reads
  // this instead of the RFQs_Sent rows. Those rows are written by Zoho's SV success
  // workflow and can't be trusted to match: on MMQ-100478 it wrote $0 on every altered
  // line and swapped lines 8/10 with 13/14. Reading the copy costs no Zoho API call.
  // Each save overwrites it, so it is always the latest revision.
  const snapName = (sid, qid) => 'svq-' + String(sid).replace(/\D/g, '') + '-' + String(qid).replace(/\D/g, '') + '.json';
  function saveQuoteSnapshot(sid, qid, snap) {
    try { filestore.writeJson(snapName(sid, qid), snap); }
    catch (e) { console.error('[quote-snapshot] save failed:', e.message); }
  }
  function readQuoteSnapshot(sid, qid) {
    if (!/^\d+$/.test(String(qid))) return null;
    try { return filestore.readJson(snapName(sid, qid), null); } catch (e) { return null; }
  }

  // The supplier's CURRENT RFQ rows (raw). One cache shared by the quote list, line
  // previews and submit, so pricing an altered line never triggers its own Zoho fetch.
  // Scoped to Latest_Item_for_Supplier==true — the report holds every superseded revision's
  // rows too (~1800 for an active supplier), and we only ever use the current version of
  // each line. That cuts the fetch from ~10 pages to ~1-2.
  function sentRowsLatest(supplierId) {
    const crit = encodeURIComponent('(Supplier_LU==' + supplierId + ' && Latest_Item_for_Supplier==true)');
    return cachedLookup('sent-rfqs:' + supplierId, 3 * 60 * 1000, async () =>
      fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=' + crit));
  }

  async function fetchSentRfqs(supplierId) {
    const [rows, catalogs] = await Promise.all([
      sentRowsLatest(supplierId),
      // Cached 1h inside lineCalc — ~6 API calls/hour total, shared across suppliers.
      fetchCatalogs({ fetchAllZohoPages, cachedLookup }),
    ]);
    const byQuote = new Map();
    for (const r of rows) {
      // Skip RFQ lines from superseded MFG quote revisions (the revision workflow
      // flags them MFG_Revision_Cancel_Entry=true) so the supplier only sees current ones.
      if (r.MFG_Revision_Cancel_Entry === true || r.MFG_Revision_Cancel_Entry === 'true') continue;
      // Lines whose quote was deleted (a failed test setup left 27 of them) have no quote,
      // number, description or weight — nothing a supplier can price. Don't show them.
      if (!lkid(r.Quote_LU) && !lkid(r.Quote_LU_ID) && !r.Quote_Number) continue;
      const qid = lkid(r.Quote_LU) || lkid(r.Quote_LU_ID) || ('q' + (r.Quote_Number || ''));
      if (!byQuote.has(qid)) {
        byQuote.set(qid, {
          quote_id: qid,
          quote_number: r.Quote_Reference_Number || r.Quote_Number || '',
          internal_quote_number: r.Quote_Number || '',
          quote_description: r.Quote_Description || '',
          manufacturer_id: lkid(r.Customer_LU),   // scopes the manufacturer-on-behalf path
          manufacturer: r['Customer_LU.Company_Name'] || flatten(r.Manufacturer) || '',
          status: r['Quote_LU.Status'] || '',
          quote_date: r.Quote_Date || r.RFQSent_Timestamp || '',
          // MFG's quote requirements (Quote_Form.Quote_Requirements, dot-walked via Quote_LU on
          // this report) — prepopulates the supplier's Quote_Requirements_Selection.
          mfg_requirements: Array.isArray(r['Quote_LU.Quote_Requirements']) ? r['Quote_LU.Quote_Requirements'] : [],
          lines: [],
        });
      }
      byQuote.get(qid).lines.push({
        rfqs_sent_id: String(r.ID),
        sv_detail_id: lkid(r.Supplier_Verify_Detail),
        sv_form_id: lkid(r.Supplier_Verify_Form),
        line: r.Line_Item || '',
        description: stripItemNo(r.Full_Item_Description || r.Description_And_Dimension_Text || ''),
        qty: r.Quantity != null ? Number(r.Quantity) : null,
        unit_weight: r.Unit_Weight != null ? Number(r.Unit_Weight) : null,
        item_requirements: asArr(r.Item_Requirements),
        // MFG's per-line note to the supplier ("Supplier Notes" col = Jeffs_Calcs_LU.Supplier_Notes).
        mfg_note: pickNote(r),
        price_per_lb: r.Price_Per_Lb != null && r.Price_Per_Lb !== '' ? Number(r.Price_Per_Lb) : null,
        unit_price: r.Unit_Price != null && r.Unit_Price !== '' ? Number(r.Unit_Price) : null,
        total_price: r.Total_Price != null && r.Total_Price !== '' ? Number(r.Total_Price) : null,
        line_status: r.RFQ_Sent_Status || '',
        quote_option: r.Item_Verification_Status || '',
        // revise UI: current geometry + what may change (see alterationMeta)
        alteration: alterationMeta(r, catalogs),
      });
    }
    const out = [...byQuote.values()];
    out.forEach(q => q.lines.sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0)));
    // Shared spec catalog: built once for the spec_keys actually present, not per line.
    const alterationCatalog = { specs: {} };
    for (const q of out) {
      for (const l of q.lines) {
        const k = l.alteration && l.alteration.spec_key;
        if (k && !alterationCatalog.specs[k]) alterationCatalog.specs[k] = specOptionsFor(k, catalogs);
      }
    }
    // Attach the manufacturer's quote-level reference files (best-effort; never block the list).
    try {
      const fileMap = await fetchQuoteFiles();
      out.forEach(q => { q.files = fileMap[String(q.quote_id)] || []; });
    } catch (e) { out.forEach(q => { if (!q.files) q.files = []; }); }
    // Attach the MFG's per-line Supplier Notes from Jeffs_Calcs (best-effort).
    try {
      const notesMap = await fetchQuoteNotes(supplierId, out.map(q => q.quote_id));
      out.forEach(q => q.lines.forEach(l => { if (!l.mfg_note) l.mfg_note = notesMap[q.quote_id + '|' + String(l.line)] || ''; }));
    } catch (e) { /* keep whatever mfg_note the row already had */ }
    // Returns an OBJECT, not the bare array: a property hung off the array would be
    // silently dropped by JSON.stringify.
    return { quotes: out, alteration_catalog: alterationCatalog };
  }

  // FITTING RFQs sent to this supplier (PUSH model — the bridge RFQs_Sent_Fittings,
  // fitting twin of All_RFQs_Sent). One row per supplier × fitting line; the supplier
  // prices each line directly on its bridge row (no separate response form). Grouped
  // into quotes for the UI. Read-only here; the price PATCH is a separate endpoint.
  const FIT_RFQ_REPORT = process.env.FITTING_RFQ_REPORT || 'RFQs_Sent_Fittings_Report';

  // A fitting's SIZE (`4" | Class 300 | SCH 40`) lives on the MFG's demand line in
  // Fitting_Description / Fitting_Description_Text — NOT in Dim1_Drop_Down/Dim2_Drop_Down,
  // which are populated on 0 of 9 live rows and appear vestigial. The bridge doesn't carry
  // the size at all, so we join demand-line-id -> size here rather than add a bridge field
  // (that would need a re-send to backfill; this fixes existing rows immediately).
  //
  // WEIGHT lives on the demand line too (`Weight`, per-each). Unlike size it also gets
  // COPIED onto the bridge at submit — Zoho only aggregates native fields of a report's
  // base form, so a dot-walked weight column has no Total in the close-out footer. This
  // join is what feeds that copy.
  //
  // Prefer the _Text mirror: it's populated where the lookup isn't (8/9 vs 5/9 live).
  // "Redo Selection" is the cascade's reset sentinel, not a size — never show it.
  async function fetchFittingDemandLines() {
    return cachedLookup('fitting-demand-lines', 30 * 60 * 1000, async () => {
      const map = {};
      try {
        const rows = await fetchAllZohoPages('/report/Fittings_Quote_Subform_Report');
        for (const r of rows) {
          const txt = String(r.Fitting_Description_Text || '').trim();
          const lk = flatten(r.Fitting_Description).trim();
          const size = (txt && txt !== 'Redo Selection') ? txt : ((lk && lk !== 'Redo Selection') ? lk : '');
          const weight = r.Weight != null && r.Weight !== '' ? Number(r.Weight) : 0;
          if (size || weight) map[String(r.ID)] = { size, weight };
        }
      } catch (e) {
        // Best-effort: a demand-line outage must not blank the whole fittings list.
        console.error('Fitting demand-line fetch failed:', (e.response && e.response.data) || e.message);
      }
      return map;
    });
  }

  async function fetchSentFittingRfqs(supplierId) {
    // fetchAllZohoPages returns [] on an empty criteria result (Zoho 9280), so no guard here.
    const [rows, demandLineById] = await Promise.all([
      cachedLookup('fit-rfqs:' + supplierId, 60 * 1000, async () =>
        // field_config=all: the report's columns leave out the response fields (Unit_Price,
        // Total_Price, lead time, comments), so without it every saved fitting price read as blank.
        fetchAllZohoPages('/report/' + FIT_RFQ_REPORT + '?field_config=all&criteria=(Supplier_LU==' + encodeURIComponent(supplierId) + ')')),
      fetchFittingDemandLines(),
    ]);
    const byQuote = new Map();
    for (const r of rows) {
      // only the supplier's current/active sent lines
      if (r.Latest_Item_for_Supplier === false || r.Latest_Item_for_Supplier === 'false') continue;
      const qid = lkid(r.Quote_LU) || ('q' + (r.Quote_Number || ''));
      if (!byQuote.has(qid)) {
        byQuote.set(qid, {
          quote_id: qid,
          quote_number: r.Quote_Reference_Number || r.Quote_Number || '',
          internal_quote_number: r.Quote_Number || '',
          quote_description: r.Quote_Description || '',
          manufacturer_id: lkid(r.Customer_LU),
          manufacturer: r['Customer_LU.Company_Name'] || r.Customer_Name || '',
          quote_date: r.Quote_Date || r.Quote_Timestamp || '',
          status: r.RFQ_Fitting_Sent_Status || '',
          lines: [],
        });
      }
      const type = flatten(r.Fitting_Type), make = flatten(r.Fitting_Make);
      const end = flatten(r.End_Type), conn = flatten(r.Connection_Type), spec = flatten(r.Fitting_Specification);
      const demandLineId = lkid(r.Fittings_Quote_Subform);
      // Size and weight come from the demand line (see fetchFittingDemandLines). Fall back
      // to the bridge's Dim1/Dim2 for size in case they're ever populated, but the demand
      // line is the source of truth.
      const demand = demandLineById[demandLineId] || {};
      const size = demand.size
        || [r.Dim1_Drop_Down, r.Dim2_Drop_Down].filter(Boolean).join(' | ')
        || '';
      byQuote.get(qid).lines.push({
        rfq_row_id: String(r.ID),
        demand_line_id: demandLineId,
        line: r.Line_Item_Fitting || '',
        fitting: { type, make, end, connection: conn, specification: spec },
        size,
        description: [type, make].filter(Boolean).join(' — ')
          + (end || conn || spec ? '  ·  ' + [end, conn, spec].filter(Boolean).join(' · ') : '')
          + (size ? '  ·  ' + size : ''),
        qty: r.Quantity != null && r.Quantity !== '' ? Number(r.Quantity) : null,
        // Per-each weight, joined from the demand line. The bridge's own Unit_Weight is
        // only written at submit, so this join is the authority for both the UI and that
        // write — and it works on rows submitted before the fields existed.
        unit_weight: Number(demand.weight) || 0,
        // response (may be blank until the supplier prices it). Defensive reads —
        // these fields are being added; absent = undefined → null.
        quote_option: r.Item_Verification_Status || '',
        unit_price: r.Unit_Price != null && r.Unit_Price !== '' ? Number(r.Unit_Price) : null,
        total_price: r.Total_Price != null && r.Total_Price !== '' ? Number(r.Total_Price) : null,
        lead_time: r.Supplier_Lead_Time || '',
        comments: r.Supplier_Comments || '',
      });
    }
    const out = [...byQuote.values()];
    out.forEach(q => q.lines.sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0)));
    return out;
  }

  // GET /api/supplier/me/sent-fitting-rfqs — fitting RFQs the MFG sent this supplier,
  // grouped into quotes with per-line response state. (Distinct from the PULL matcher
  // at /api/supplier/:id/fitting-rfqs, which scores stock vs all open demand.)
  const sentFittingRfqsHandler = async (req, res) => {
    try {
      const quotes = (await fetchSentFittingRfqs(req.supplier.id)).filter(q => inScope(req, q.manufacturer_id, q.quote_id));
      const lineCount = quotes.reduce((n, q) => n + q.lines.length, 0);
      const respondedCount = quotes.reduce((n, q) => n + q.lines.filter(l => l.quote_option).length, 0);
      res.json({ ok: true, supplier: req.supplier, quote_count: quotes.length, line_count: lineCount, responded_count: respondedCount, quotes });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  };
  app.get('/api/supplier/me/sent-fitting-rfqs', withSupplier, sentFittingRfqsHandler);
  app.get('/api/mfg/supplier-quotes/sent-fitting-rfqs', withMfgOnBehalf, sentFittingRfqsHandler);

  // POST /api/supplier/me/sent-fitting-rfqs/submit — price fitting RFQ lines. Writes the
  // response directly onto each RFQs_Sent_Fittings bridge row (the "bridge = response"
  // model, no Supplier_Alter_Form). Per-each pricing: total = unit × qty (server is
  // authoritative on qty, read from the bridge row). Ownership is verified against the
  // supplier's own cached bridge rows before any write.
  const fittingSubmitHandler = async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const lines = (req.body && req.body.lines) || [];
      // SV record the structural half of this submit just created. Stamping it on
      // each bridge row is the ONLY link fittings get to the Supplier_Verify_Form —
      // without it the MFG side cannot dot-walk to anything held there (the
      // supplier's REFERENCE_QUOTE_NUMBER, the review form's fittings subform).
      // Empty on a fittings-only quote, where no SV record was created at all.
      const svFormId = String((req.body && req.body.sv_form_id) || '').trim();
      if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ ok: false, error: 'no lines to submit' });

      // Index the supplier's own bridge rows for ownership + qty (no extra API call).
      const quotes = (await fetchSentFittingRfqs(sid)).filter(q => inScope(req, q.manufacturer_id, q.quote_id));
      const mine = new Map();
      quotes.forEach(q => q.lines.forEach(l => mine.set(String(l.rfq_row_id), l)));

      const results = [];
      for (const l of lines) {
        const id = String(l.rfq_row_id || '');
        const row = mine.get(id);
        if (!row) { results.push({ rfq_row_id: id, ok: false, error: 'not an open RFQ for this supplier' }); continue; }
        const noQuote = l.quote_option === 'No Quote';
        const opt = l.quote_option || 'Quote As Is';
        const qty = row.qty != null ? row.qty : 0;
        const unit = noQuote ? 0 : round(Number(l.unit_price) || 0, 3);
        const total = noQuote ? 0 : round(unit * qty, 2);
        // Weight is copied from the demand line so the close-out report can Total it —
        // Zoho won't aggregate a dot-walked column. Unit_Weight is a property of the ITEM
        // so it's written either way; only the line total follows the response, mirroring
        // Total_Price. That's what makes the footer read "weight actually quoted", so a
        // gap against the weight sent is the coverage signal.
        const unitWt = Number(row.unit_weight) || 0;
        const data = {
          Item_Verification_Status: opt,
          Unit_Price: unit,
          Total_Price: total,
          Unit_Weight: unitWt,
          Total_Weight: noQuote ? 0 : round(unitWt * qty, 2),
          Supplier_Lead_Time: l.lead_time || '',
          Supplier_Comments: l.comments || '',
          Responded_Timestamp: zohoNow(),
        };
        // Only sent when we have one: an empty lookup value can be rejected, and a
        // rejected PATCH would take the price down with it.
        if (svFormId) data.Supplier_Verify_Form = svFormId;
        const r = await patchRecord(FIT_RFQ_REPORT, id, data);
        results.push({ rfq_row_id: id, ok: r.ok, code: r.code, message: r.ok ? undefined : r.message, unit_price: unit, total_price: total });
      }
      bust('fit-rfqs:' + sid);
      if (scopeOf(req)) bust('mfg-sent-fit:' + scopeOf(req));
      const saved = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok);
      res.json({ ok: failed.length === 0, saved, failed: failed.length, results });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  };
  app.post('/api/supplier/me/sent-fitting-rfqs/submit', withSupplier, fittingSubmitHandler);
  app.post('/api/mfg/supplier-quotes/sent-fitting-rfqs/submit', withMfgOnBehalf, fittingSubmitHandler);

  // Supplier-level dropdown data for the quote-submit form (locations, reps, choices).
  async function fetchSupplierLookups(supplierId) {
    // Locations/reps change rarely — cache 10 min to spare the API budget.
    return cachedLookup('supplier-lookups:' + supplierId, 10 * 60 * 1000, async () => {
      const [loc, rep] = await Promise.all([
        fetchAllZohoPages('/report/' + LOC_REPORT + '?criteria=(Supplier_Entry_Form==' + encodeURIComponent(supplierId) + ')'),
        fetchAllZohoPages('/report/' + REP_REPORT + '?criteria=(Supplier_Entry_Form==' + encodeURIComponent(supplierId) + ')'),
      ]);
      return {
        locations: loc.map(l => ({ id: String(l.ID), name: l.Name_of_Location || '' })),
        reps: rep.map(r => ({ id: String(r.ID), name: flatten(r.Name) || r.Email || '' })),
        quote_requirements: QUOTE_REQUIREMENTS_CHOICES,
        item_requirements_choices: ITEM_REQUIREMENTS_CHOICES,
        // Must match the Zoho Lead_Time_For_Ship_Complete (header) choice list EXACTLY
        // (a choice field silently blanks any value that isn't an allowed option). Extend here
        // if the Zoho field has more options than are listed.
        lead_time_choices: LEAD_TIME_CHOICES,
        quote_valid_choices: QUOTE_VALID_CHOICES,
      };
    });
  }

  // GET /api/supplier/me/rfqs — the supplier's sent RFQs grouped into quotes + tiles.
  const rfqsHandler = async (req, res) => {
    try {
      const [sent, lookups] = await Promise.all([
        fetchSentRfqs(req.supplier.id),
        fetchSupplierLookups(req.supplier.id),
      ]);
      const { alteration_catalog } = sent;
      const quotes = sent.quotes.filter(q => inScope(req, q.manufacturer_id, q.quote_id));
      // A quote already saved reopens as saved (disk copy, no Zoho call).
      quotes.forEach(q => { const s = readQuoteSnapshot(req.supplier.id, q.quote_id); if (s) q.saved = s; });
      // Map the full Quote_Form.Status pipeline into the 4 supplier tiles.
      const tile = s => {
        if (/^Open|Quote Revised/i.test(s)) return 'open';            // not submitted / past due / revised
        if (/^Submitted/i.test(s)) return 'submitted';                 // waiting on responses
        if (/Sourcing|Purchase Order/i.test(s)) return 'awarded';      // post-award / in progress
        if (/^Closed|Cancel/i.test(s)) return 'closed';
        return 'other';
      };
      const tiles = { open: 0, submitted: 0, awarded: 0, closed: 0, other: 0 };
      quotes.forEach(q => { tiles[tile(q.status)]++; });
      res.json({ ok: true, supplier: req.supplier, tiles, quote_count: quotes.length, quotes, lookups, alteration_catalog });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  };
  app.get('/api/supplier/me/rfqs', withSupplier, rfqsHandler);
  app.get('/api/mfg/supplier-quotes/rfqs', withMfgOnBehalf, rfqsHandler);

  // POST /api/…/autofill { quote_id, file_b64, media_type, file_name } — read the supplier's
  // quote PDF/photo and return values to PRE-FILL the card (see quoteAutofill.js). The lines
  // are re-read here from our own data, scoped like every other handler, so a client can
  // only ever fill lines it could already see. Nothing is written to Zoho.
  const autofillHandler = async (req, res) => {
    try {
      const { quote_id, file_b64, media_type, file_name } = req.body || {};
      const qid = String(quote_id || '');
      if (!qid) return res.status(400).json({ ok: false, error: 'No quote chosen.' });
      const [sent, fitQuotes] = await Promise.all([
        fetchSentRfqs(req.supplier.id),
        fetchSentFittingRfqs(req.supplier.id).catch(() => []),
      ]);
      const sq = sent.quotes.find(q => String(q.quote_id) === qid && inScope(req, q.manufacturer_id, q.quote_id));
      const fq = fitQuotes.find(q => String(q.quote_id) === qid && inScope(req, q.manufacturer_id, q.quote_id));
      if (!sq && !fq) return res.status(404).json({ ok: false, error: 'That quote isn\'t open for this supplier.' });
      const quote = {
        quote_id: qid,
        quote_number: (sq || fq).quote_number,
        quote_description: (sq || fq).quote_description,
        structural_lines: sq ? sq.lines : [],
        fitting_lines: fq ? fq.lines : [],
      };
      const out = await require('./quoteAutofill').autofillQuote({
        b64: String(file_b64 || '').replace(/^data:[^,]*,/, ''),
        mediaType: media_type, name: file_name, quote,
        catalog: sent.alteration_catalog, leadChoices: LEAD_TIME_CHOICES, validChoices: QUOTE_VALID_CHOICES,
        // A spec the supplier quoted that the catalog lacks is added (guarded in quoteAutofill).
        addSpec: async (specKey, label) => {
          const [ft, mt] = String(specKey).split('|');
          const catalogs = await fetchCatalogs({ fetchAllZohoPages, cachedLookup });
          return addCatalogSpec(ft, mt, label, catalogs);
        },
      });
      res.json(out);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ ok: false, error: err.message });
      console.error('[autofill]', (err && err.message) || err);
      res.status(500).json({ ok: false, error: 'The quote could not be read: ' + String((err && err.message) || err) });
    }
  };
  app.post('/api/supplier/me/autofill', withSupplier, autofillHandler);
  app.post('/api/mfg/supplier-quotes/autofill', withMfgOnBehalf, autofillHandler);

  // GET /api/supplier/me/quote-file — stream a manufacturer reference file (Quote_Form.File_upload)
  // from Zoho using the server's token, so the supplier can download it without Zoho auth.
  const quoteFileHandler = async (req, res) => {
    try {
      const record = String(req.query.record || '').replace(/[^0-9]/g, '');
      const filepath = String(req.query.filepath || '');
      if (!record || !filepath) return res.status(400).send('record and filepath required');
      // On-behalf: only a quote of this MFG's that went to this supplier.
      if (scopeOf(req)) {
        const { quotes } = await fetchSentRfqs(req.supplier.id);
        if (!quotes.some(q => q.quote_id === record && inScope(req, q.manufacturer_id, q.quote_id))) return res.status(404).send('file not found');
      }
      const token = await getAccessToken();
      const url = creatorApiBase() + '/report/All_Quotes/' + record + '/File_upload/download?filepath=' + encodeURIComponent(filepath);
      const zr = await axios.get(url, { headers: zohoHeaders(token), responseType: 'stream' });
      const name = filepath.replace(/^\d+_+/, '').replace(/"/g, '');
      res.setHeader('Content-Disposition', 'inline; filename="' + name + '"');
      if (zr.headers['content-type']) res.setHeader('Content-Type', zr.headers['content-type']);
      zr.data.pipe(res);
    } catch (err) {
      res.status(502).send('file fetch failed: ' + String((err.response && err.response.status) || '') + ' ' + String((err && err.message) || err));
    }
  };
  app.get('/api/supplier/me/quote-file', withSupplier, quoteFileHandler);
  app.get('/api/mfg/supplier-quotes/quote-file', withMfgOnBehalf, quoteFileHandler);

  // Load this supplier's RFQ rows raw + the catalogs, for the alteration paths. The rows
  // are the authority: an alteration is always applied to the SERVER's copy of the line,
  // never to client-sent geometry.
  async function loadAlterationContext(supplierId, specIds) {
    const [rawRows, catalogs] = await Promise.all([
      sentRowsLatest(supplierId),
      fetchCatalogs({ fetchAllZohoPages, cachedLookup }),
    ]);
    await ensureSpecs(catalogs, specIds);
    return { rowById: new Map(rawRows.map(r => [String(r.ID), r])), catalogs };
  }

  // ── Specs added from a supplier's quote ─────────────────────────────────────────────
  // A spec row is only a label (Type_Detail) under a Form × Material pair: weight comes from
  // the size, never the spec, so a new one changes no number anywhere downstream.
  // Railway runs several instances, each holding the catalog for an hour, so a spec added on
  // one is unknown to the others. Rather than fail "Unknown Specification", an instance that
  // meets an id it hasn't seen reads that one row and keeps it.
  async function ensureSpecs(catalogs, specIds) {
    const missing = [...new Set((specIds || []).filter(Boolean).map(String))].filter(id => /^\d+$/.test(id) && !catalogs.specById[id]);
    for (const id of missing) {
      try {
        const rows = await fetchAllZohoPages('/report/Material_Form_Detail_Report?criteria=' + encodeURIComponent('(ID==' + id + ')'));
        const r = rows[0];
        if (r) catalogs.specById[id] = { typeDetail: r.Type_Detail || '', formTypeId: lkid(r.Form_Type), matTypeId: lkid(r.Material_Type) };
      } catch (e) { /* leave it unknown; computeAlteredLine reports it */ }
    }
  }

  // Add a spec to the shared catalog, or return the one already there. Checked against LIVE
  // rows for the pair (not the cache), normalised, so "A-252 GR 3" never duplicates "A252 Gr 3".
  const normSpecLabel = s => String(s || '').toUpperCase().replace(/ASTM|GRADE|\bGR\b|[\s\-.]/g, '');
  async function addCatalogSpec(formTypeId, matTypeId, label, catalogs) {
    const crit = encodeURIComponent('(Form_Type==' + formTypeId + ' && Material_Type==' + matTypeId + ')');
    const rows = await fetchAllZohoPages('/report/Material_Form_Detail_Report?criteria=' + crit);
    const have = rows.find(r => normSpecLabel(r.Type_Detail) === normSpecLabel(label));
    let id, created = false;
    if (have) id = String(have.ID);
    else {
      const token = await getAccessToken();
      const resp = await axios.post(creatorApiBase() + '/form/Material_Form_Detail',
        { data: { Form_Type: formTypeId, Material_Type: matTypeId, Type_Detail: label } },
        { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      id = resp.data && resp.data.data && String(resp.data.data.ID || '');
      if (!resp.data || resp.data.code !== 3000 || !id) throw new Error('The new specification could not be added: ' + JSON.stringify(resp.data).slice(0, 200));
      created = true;
      console.log('[autofill] added spec "' + label + '" (' + id + ') to Form ' + formTypeId + ' / Material ' + matTypeId);
    }
    if (catalogs) catalogs.specById[id] = { typeDetail: have ? have.Type_Detail : label, formTypeId: String(formTypeId), matTypeId: String(matTypeId) };
    bust('line-calc:catalogs'); bust('takeoff:spec-groups');
    return { id, label: have ? have.Type_Detail : label, created };
  }

  // Turn a LineCalcError into a 422 the UI can show verbatim. Anything else is a real fault.
  function alterationError(res, e) {
    if (e instanceof LineCalcError) return res.status(422).json({ ok: false, error: e.message, code: e.code });
    throw e;
  }

  // POST /api/supplier/me/line-preview — recompute ONE altered line without writing.
  // The revise UI calls this as the supplier edits, so the description/weight it shows
  // come from the same code that will run at submit. The client never does this math.
  const linePreviewHandler = async (req, res) => {
    try {
      const { rfqs_sent_id, length_ft, length_inch, quantity, spec_id } = req.body || {};
      if (!rfqs_sent_id) return res.status(400).json({ ok: false, error: 'rfqs_sent_id required' });
      const { rowById, catalogs } = await loadAlterationContext(String(req.supplier.id), [spec_id]);
      const row = rowById.get(String(rfqs_sent_id));
      // Scoped to THIS supplier's rows, so an unknown id is either stale or not theirs.
      if (!row || !inScope(req, lkid(row.Customer_LU), lkid(row.Quote_LU))) return res.status(404).json({ ok: false, error: 'Line not found for this supplier' });
      try {
        const out = computeAlteredLine(row, { length_ft, length_inch, quantity, spec_id }, catalogs);
        res.json({ ok: true, preview: out });
      } catch (e) { return alterationError(res, e); }
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  };
  app.post('/api/supplier/me/line-preview', withSupplier, linePreviewHandler);
  app.post('/api/mfg/supplier-quotes/line-preview', withMfgOnBehalf, linePreviewHandler);

  // POST /api/supplier/me/quote-submit — submit a priced quote (off-Zoho path).
  // Creates ONE Supplier_Verify_Form record with its Supplier_Verify_Detail rows passed
  // as a nested subform array — the exact mechanism the native "Submit Quote" widget uses
  // (a standalone Deluge function can't build that subform; the addRecord API can). The
  // SV form's own "Successful form submission" workflow then fires and does the RFQs_Sent
  // write-back, the MFG email, and the dashboard status — same path as a human submit.
  const quoteSubmitHandler = async (req, res) => {
    try {
      const { quote_id, header = {}, lines = [] } = req.body || {};
      const supplierId = String(req.supplier.id);
      if (!quote_id) return res.status(400).json({ ok: false, error: 'quote_id required' });
      if (!lines.length) return res.status(400).json({ ok: false, error: 'no priced lines' });

      // supplier quote number (their input) or an auto placeholder
      let svQuoteNum = (header.supplier_quote_number || '').trim();
      if (!svQuoteNum) svQuoteNum = 'AUTO-' + quote_id;

      // Pull the authoritative RFQs_Sent rows for this supplier and index by ID — we build
      // the subform from these (not from client-sent data) so lookups/weights are correct.
      // Catalogs come along for any altered lines; both are cached.
      const ctx = await loadAlterationContext(supplierId, lines.map(l => l && l.alteration && l.alteration.spec_id));
      const { catalogs } = ctx;
      // On-behalf: only this MFG's lines of THIS quote exist as far as the submit is concerned.
      const rowById = scopeOf(req)
        ? new Map([...ctx.rowById].filter(([, r]) => inScope(req, lkid(r.Customer_LU), lkid(r.Quote_LU)) && lkid(r.Quote_LU) === String(quote_id)))
        : ctx.rowById;
      const rawRows = [...rowById.values()];

      // money/format helpers for the PDF snapshot strings the reference doc reads
      const money = n => '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
      const num = (n, d = 2) => (Math.round((Number(n) || 0) * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);

      // derive manufacturer from any row (Customer_LU = the MFG on RFQs_Sent)
      const firstRow = rowById.get(String(lines[0] && lines[0].rfqs_sent_id)) || rawRows[0];
      const mfgId = firstRow ? lkid(firstRow.Customer_LU) : '';

      // MFG_Representative is mandatory on the SV form — resolve one rep for this MFG.
      let mfgRep = '';
      if (mfgId) {
        try {
          const reps = await cachedLookup('mfg-reps:' + mfgId, 10 * 60 * 1000, async () =>
            fetchAllZohoPages('/report/All_Company_Representatives?criteria=(Manufacture==' + encodeURIComponent(mfgId) + ')'));
          if (reps && reps[0]) mfgRep = String(reps[0].ID);
        } catch (e) { /* leave blank; addRecord will surface the mandatory error */ }
      }

      // Revision supersede: if this supplier already has an ACTIVE quote for this MFG quote,
      // this submit replaces it. Capture the prior(s) so we can mark them "Revised" and link
      // the new SV back via Original_Supplier_Quote. (RFQs_Sent doesn't carry the SV link, so
      // we look it up on the SV report.)
      let priorSvIds = [];
      try {
        const priors = await fetchAllZohoPages('/report/All_Supplier_Verify_Form_Report?criteria=(SV_Supplier_Entry_Form==' + encodeURIComponent(supplierId) + ' && SV_Quote_Form==' + encodeURIComponent(quote_id) + ')');
        priorSvIds = (priors || []).filter(p => p.SV_Status === 'Submitted - Waiting Responses').map(p => String(p.ID));
      } catch (e) { /* non-fatal — revision link is best-effort */ }
      const priorSvId = priorSvIds.length ? priorSvIds.slice().sort().reverse()[0] : '';

      const detailRows = [];
      const snapLines = {};   // what the card showed, per RFQ line — see saveQuoteSnapshot
      let missing = 0;
      const lineErrors = [];  // per-line alteration failures — surfaced, never silently dropped
      let sumMaterial = 0;  // Σ line total price — feeds the header material/grand totals
      let sumWeight = 0;    // Σ line calc weight — feeds Response_Total_Weight
      let alteredCount = 0;
      for (const l of lines) {
        const r = rowById.get(String(l.rfqs_sent_id));
        if (!r) { missing++; continue; }
        const noQuote = l.quote_option === 'No Quote';
        const opt = l.quote_option || 'Quote As Is';
        const ppl = noQuote ? 0 : Number(l.price_per_lb) || 0;
        const up = noQuote ? 0 : Number(l.unit_price) || 0;
        const tp = noQuote ? 0 : Number(l.total_price) || 0;

        // ── Alteration ────────────────────────────────────────────────────────
        // Recompute from the SERVER's row + the supplier's requested change. The
        // client's own preview values are never trusted — this is the authority.
        let alt = null;
        if (l.alteration && (l.alteration.length_ft != null || l.alteration.length_inch != null
            || l.alteration.quantity != null || l.alteration.spec_id)) {
          try {
            const out = computeAlteredLine(r, l.alteration, catalogs);
            if (out.changed.length || out.changed.quantity || out.changed.spec) { alt = out; alteredCount++; }
          } catch (e) {
            if (!(e instanceof LineCalcError)) throw e;
            // Refuse the whole submit rather than quietly quoting the unaltered line —
            // the supplier would be bound to a price for something they didn't offer.
            lineErrors.push({ rfqs_sent_id: String(l.rfqs_sent_id), line: r.Line_Item || '', error: e.message, code: e.code });
            continue;
          }
        }
        const desc = alt ? stripItemNo(alt.description)
                         : stripItemNo(r.Description_And_Dimension_Text || r.Full_Item_Description || '');
        const itemReq = Array.isArray(r.Item_Requirements) ? r.Item_Requirements : [];   // MFG's per-line requirement
        // Supplier may edit item requirements (pre-filled with the MFG's set). If they changed
        // it, write the supplier's selection AND note the change in the line comments.
        const supReq = Array.isArray(l.item_requirements) ? l.item_requirements.filter(Boolean) : itemReq;
        const reqChanged = supReq.slice().sort().join('|') !== itemReq.slice().sort().join('|');
        const reqStr = supReq.join(', ');
        let cmt = l.comments || '';
        if (reqChanged) {
          cmt = (cmt ? cmt + ' | ' : '') + 'Item requirements changed to: ' + (supReq.length ? supReq.join(', ') : '(none)');
        }
        // An altered line no longer matches what the MFG asked for, so say so in plain
        // words on the line itself — the MFG's close-out reads these comments, and a
        // silently-changed length/qty/spec would otherwise look like a normal quote.
        if (alt) {
          const notes = [];
          if (alt.changed.length) notes.push('length ' + origLengthText(r) + ' → ' + alt.length_ft + "'" + (alt.length_inch > 0 ? alt.length_inch + '"' : ''));
          if (alt.changed.quantity) notes.push('qty ' + (r.Quantity != null ? r.Quantity : '?') + ' → ' + alt.quantity);
          if (alt.changed.spec) notes.push('spec ' + (origSpecName(r, catalogs) || '?') + ' → ' + alt.spec_name);
          cmt = (cmt ? cmt + ' | ' : '') + 'SUPPLIER ALTERED: ' + notes.join(', ');
        }
        const uw = alt ? alt.unit_weight : (Number(r.Unit_Weight) || 0);
        const tw = alt ? alt.calc_weight : (Number(r.CalcWeight) || 0);
        const qtyVal = alt ? alt.quantity : (r.Quantity != null ? r.Quantity : '');
        sumMaterial += tp;
        if (!noQuote) sumWeight += tw;
        const leadTxt = l.lead_time || '';
        // SVD_Lead_Time is the NUMERIC "Lead Time (in weeks)" field (not a choice) — convert the
        // supplier's "N Days" pick to whole weeks; omit when none so we never send a non-number.
        const leadDays = parseInt(leadTxt, 10);
        const svLeadWeeks = (Number.isFinite(leadDays) && leadDays > 0) ? Math.ceil(leadDays / 7) : null;
        snapLines[String(r.ID)] = {
          quote_option: opt, total_price: round(tp, 2), price_per_lb: round(ppl, 3),
          lead_time: leadTxt, comments: l.comments || '', item_requirements: supReq,
          alteration: alt ? l.alteration : null, preview: alt || null,
        };

        detailRows.push({
          // links back to the source RFQ line + master records
          SVD_RFQs_Sent: String(r.ID),
          RFQ_Sent_ID_Number: String(r.ID),
          SVD_Supplier_LU: lkid(r.Supplier_LU),
          SVD_Customer_LU: lkid(r.Customer_LU),
          SVD_Quote_LU: lkid(r.Quote_LU),
          SVD_Jeffs_Calcs_LU: lkid(r.Jeffs_Calcs_LU),
          SVD_Project_ID: lkid(r.MCP_Customer_Project_Form),
          SVD_Form_Types: lkid(r.Form_Type),
          SVD_Material_Types: lkid(r.Material_Type),
          // Specification is alterable — write the supplier's pick, not the MFG's.
          SVD_Material_Form_Detail: alt ? alt.spec_id : lkid(r.Material_Form_Detail),
          // descriptive + dimensional snapshot (altered values when the supplier revised)
          SVD_Material_Description: desc,
          Line_Item: r.Line_Item || '',
          Reference_Quote_Number: svQuoteNum,
          SVD_Quantity: qtyVal,
          SVD_Total_Length: alt ? alt.total_length
                                : (r.Total_Length != null ? round(Number(r.Total_Length) || 0, 4) : ''),
          SVD_Unit_Weight: round(uw, 2),
          SVD_Calc_Weight: round(tw, 2),
          Item_Requirements: supReq,
          // pricing — match each field's configured precision (else "maximum digits")
          SVD_Item_Verification_Status: opt,
          SVD_Price_Per_Lb: round(ppl, 3),
          SVD_Unit_Price: round(up, 3),
          SVD_Total_Price: round(tp, 2),
          SVD_Price_Per_Lb_Counter: (opt === 'Quote As Is' && tp > 0) ? 1 : 0,
          ...(svLeadWeeks != null ? { SVD_Lead_Time: svLeadWeeks } : {}),
          SVD_Supplier_Comments: cmt,
          // PDF snapshot fields (feed the reference document). These are tight number
          // fields (~6 digits) — round to 2 places so larger amounts fit, like the widget.
          PDF_Quote_Option: opt,
          PDF_Item_Description_and_Measurement: desc,
          PDF_Item_Description_and_Measurement_Multi_Line: reqStr ? (desc + '\n' + reqStr) : desc,
          PDF_Item_Requirements: supReq,
          PDF_Quantity: qtyVal,
          PDF_Unit_Weight: round(uw, 2),
          PDF_Total_Weight: round(tw, 2),
          PDF_Weight_Multi_Line: 'Unit WT ' + num(uw, 2) + '\nTotal WT ' + num(tw, 2),
          PDF_Price_Per_LB: round(ppl, 2),
          PDF_Unit_Amount: round(up, 2),
          PDF_Total_Amount: round(tp, 2),
          PDF_Price_Multi_Line: noQuote ? 'No Quote' : ('Per Lb ' + money(ppl) + '\nUnit Price ' + money(up)),
          // PDF_Lead_Time is a CHOICE field (rejects "5 Days"/numbers) — leave blank; the lead
          // time is carried on the header (Lead_Time_For_Ship_Complete) + SVD_Lead_Time (weeks).
          PDF_Lead_Time: '',
          PDF_Supplier_Comments: cmt,
        });
      }

      // An alteration that can't be computed fails the WHOLE submit. Quoting the
      // unaltered line instead would bind the supplier to a price for something they
      // didn't offer, and dropping the line silently under-reports the quote.
      if (lineErrors.length) {
        return res.status(422).json({
          ok: false,
          error: 'Cannot submit: ' + lineErrors.length + ' altered line(s) could not be recomputed. Nothing was saved.',
          line_errors: lineErrors,
        });
      }
      if (!detailRows.length) {
        return res.status(400).json({ ok: false, error: 'none of the submitted lines matched current RFQ rows', missing });
      }

      // header — supplier inputs + derived lookups. The SV form workflow computes header
      // totals but never STORES them on the API-add path, so the report columns (Total Amount
      // of Quote / Total Weight Quoted) land blank — set them explicitly here from the line sums.
      const validDays = Number(header.valid_days) || 0;
      const shipAmt = Number(header.shipping) || 0;
      const miscAmt = Number(header.misc) || 0;
      // Fittings are priced down a SEPARATE path (RFQs_Sent_Fittings), so they never reach
      // detailRows and never touch sumMaterial -- but they ARE part of what the supplier
      // quoted. Without this the MFG's review form reads a grand total short by exactly the
      // fittings amount ($14,878.88 against a quoted $15,933.88 on MMQ-10000). The client
      // sends the figure it displayed as "Fittings total"; older clients omit it and land
      // on 0, i.e. today's behaviour.
      const fittingsTotal = Number(header.fittings_total) || 0;
      const materialTotal = sumMaterial + fittingsTotal;
      const grandTotal = materialTotal + shipAmt + miscAmt;  // material + fittings + shipping + misc
      // Header lead time (Lead_Time_For_Ship_Complete, a CHOICE field): use the supplier's
      // header value if valid, else the first valid per-line value, else the fallback.
      const hdrLeadRaw = (header.lead_time || '').trim();
      const firstLineLead = (lines.find(x => LEAD_TIME_CHOICES.includes((x.lead_time || '').trim())) || {}).lead_time;
      const headerLead = LEAD_TIME_CHOICES.includes(hdrLeadRaw) ? hdrLeadRaw : (firstLineLead || LEAD_TIME_FALLBACK);
      const data = {
        SV_Supplier_Entry_Form: supplierId,
        SV_Quote_Form: String(quote_id),
        Quote_LU: String(quote_id),          // native workflow keys the assignment link-back + report dot-walks off this
        Lead_Time_For_Ship_Complete: headerLead,
        MANUFACTURER: mfgId,
        // The three fields a Zoho-side submit fills and reports/filters read. Off-Zoho saves
        // left them blank from Aug 2026 (every such SV showed no manufacturer).
        ...(mfgId ? {
          SV_Customer_Entry_Form: mfgId,
          Manufacture_ID: mfgId,
          Manufacture_Name: String(firstRow['Customer_LU.Company_Name'] || ''),
        } : {}),
        MFG_Representative: mfgRep,
        SV_TimeStamp: zohoNow(),
        Supplier_Locations: header.location ? String(header.location) : '',
        Supplier_Representatives: header.rep ? String(header.rep) : '',
        Auto_Number_or_Quote_Number_Selection: svQuoteNum.startsWith('AUTO-') ? 'Use Auto Number for Quote Number' : 'Input Internal Quote Number',
        REFERENCE_QUOTE_NUMBER: svQuoteNum,
        Supplier_Quote_Meets_MFG_Requirements: header.meets_requirements || '',
        Quote_Is_Valid_For: validDays ? (validDays + (validDays === 1 ? ' Day' : ' Days')) : '',
        Valid_Until_Date: toZohoDate(nextBusinessDayIso(header.valid_until)),
        SV_Radio_For_Submit: header.ready ? 'Ready for submission' : 'Not ready for submit',
        // Email choices from the card; omitted by older clients -> the form defaults (checked) apply.
        // Once Material Compass sends email itself, Zoho's copies are off: the card calls
        // quote-notify after the fittings are saved too, so the email has the whole quote.
        ...(require('./mailer').live() ? { Email_Manufacturer: false, Email_Supplier: false } : {
          ...(typeof header.email_mfg === 'boolean' ? { Email_Manufacturer: header.email_mfg } : {}),
          ...(typeof header.email_supplier === 'boolean' ? { Email_Supplier: header.email_supplier } : {}),
        }),
        Shipping_Amount: header.shipping != null ? String(header.shipping) : '0',
        Miscellaneous_Charges: header.misc != null ? String(header.misc) : '0',
        Supplier_Notes_To_Buyer: header.notes || '',
        // header rollups — set explicitly (workflow computes but doesn't store on API-add)
        Total_Material_Amount_Currency: round(materialTotal, 2),
        Response_Total_Material_Price: round(materialTotal, 2),
        Response_Total_Price: round(grandTotal, 2),
        Total_Amount_Currency: round(grandTotal, 2),
        Response_Total_Weight: round(sumWeight, 2),
        Quote_Requirements_Selection: Array.isArray(header.requirements) ? header.requirements : [],
        Original_Supplier_Quote: priorSvId,
        Supplier_Verify_Detail_Subform: detailRows,
      };
      // Drop empty optional scalars — sending '' to a lookup/date/choice field can be
      // rejected. The subform array and required header fields always carry a value.
      for (const k of Object.keys(data)) {
        if (k !== 'Supplier_Verify_Detail_Subform' && (data[k] === '' || data[k] == null)) delete data[k];
      }

      const token = await getAccessToken();
      let addResp;
      try {
        addResp = await axios.post(creatorApiBase() + '/form/Supplier_Verify_Form', { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'Supplier_Verify_Form addRecord failed', detail: (e.response && JSON.stringify(e.response.data)) || e.message });
      }
      const code = addResp.data && addResp.data.code;
      if (code !== 3000) {
        // Zoho's per-field reasons ({Field: "Select a value for …"}) or workflow alerts, in words.
        const e = addResp.data && addResp.data.error;
        const reasons = Array.isArray(e)
          ? e.map(x => [].concat(x.alert_message || []).join(' ')).filter(Boolean)
          : (e && typeof e === 'object' ? Object.values(e).map(String) : []);
        return res.status(502).json({ ok: false, error: 'addRecord rejected', code,
          message: (addResp.data && addResp.data.message) || reasons.join(' ') || undefined, detail: addResp.data });
      }
      const svFormId = (addResp.data.data && addResp.data.data.ID) || '';

      // Supersede prior active quotes for this supplier+MFG-quote → "Revised".
      // A PATCH re-runs the SV form's "Created or Edited" validation, and Zoho answers a
      // refusal with HTTP 200 + a non-3000 code — so check the code, and report a failure
      // instead of counting it (three Alro saves on MMQ-100478 all stayed "Submitted").
      let superseded = 0;
      const supersedeErrors = [];
      for (const pid of priorSvIds) {
        try {
          const pr = await axios.patch(creatorApiBase() + '/report/All_Supplier_Verify_Form_Report/' + pid, { data: { SV_Status: 'Revised' } }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
          const pc = pr.data && (pr.data.code != null ? pr.data.code : (pr.data.result && pr.data.result[0] && pr.data.result[0].code));
          if (pc === 3000 || pc == null) superseded++;
          else supersedeErrors.push({ sv: pid, code: pc, detail: JSON.stringify(pr.data).slice(0, 300) });
        } catch (e) {
          supersedeErrors.push({ sv: pid, detail: (e.response && JSON.stringify(e.response.data).slice(0, 300)) || e.message });
        }
      }
      if (supersedeErrors.length) console.error('[quote-submit] could not mark prior quotes Revised:', JSON.stringify(supersedeErrors));
      saveQuoteSnapshot(supplierId, quote_id, {
        sv_form_id: String(svFormId), saved_at: new Date().toISOString(),
        header: { ...header, attachment_name: '', fittings_total: undefined },
        lines: snapLines,
      });
      // The next load should show what was just saved, not a 3-minute-old copy.
      bust('sent-rfqs:' + supplierId);
      bust('sent-rfqs-raw:' + supplierId);
      if (scopeOf(req)) bust('mfg-sent-rfqs:' + scopeOf(req));

      res.json({
        ok: true,
        sv_form_id: svFormId,
        lines: detailRows.length,
        skipped: missing,
        altered: alteredCount,
        revised_prior: superseded,
        ...(supersedeErrors.length ? { revise_failed: supersedeErrors } : {}),
        message: 'Quote submitted (SV record ' + svFormId + ', ' + detailRows.length + ' lines'
          + (alteredCount ? ', ' + alteredCount + ' altered' : '')
          + (superseded ? ', superseded ' + superseded + ' prior' : '') + '). The SV workflow handles email + write-back.',
      });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  };
  app.post('/api/supplier/me/quote-submit', withSupplier, quoteSubmitHandler);
  app.post('/api/mfg/supplier-quotes/quote-submit', withMfgOnBehalf, quoteSubmitHandler);

  // POST /api/…/quote-attachment { sv_form_id, file_b64, file_name, media_type } — attach the
  // supplier's quote PDF to the SV record a submit just created (Supplier_Internal_Quote, the
  // form's "Internal quote" upload). Separate from the submit so a refused file never costs the
  // prices. The record must be THIS supplier's, and on-behalf, this MFG's quote.
  const SV_FILE_FIELD = process.env.SV_QUOTE_FILE_FIELD || 'Supplier_Internal_Quote';
  const quoteAttachmentHandler = async (req, res) => {
    try {
      const { sv_form_id, file_b64, file_name, media_type } = req.body || {};
      const id = String(sv_form_id || '');
      if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'No saved quote to attach to.' });
      const rows = await fetchAllZohoPages('/report/All_Supplier_Verify_Form_Report?criteria=' +
        encodeURIComponent('(ID==' + id + ' && SV_Supplier_Entry_Form==' + req.supplier.id + ')'));
      const sv = rows[0];
      if (!sv) return res.status(404).json({ ok: false, error: 'That quote isn\'t this supplier\'s.' });
      if (scopeOf(req)) {
        const sent = await fetchSentRfqs(req.supplier.id);
        if (!sent.quotes.some(q => String(q.quote_id) === lkid(sv.SV_Quote_Form) && inScope(req, q.manufacturer_id, q.quote_id))) {
          return res.status(403).json({ ok: false, error: 'That quote isn\'t yours.' });
        }
      }
      const buf = Buffer.from(String(file_b64 || '').replace(/^data:[^,]*,/, ''), 'base64');
      if (!buf.length) return res.status(400).json({ ok: false, error: 'No file was sent.' });
      const FormData = require('form-data');
      const fd = new FormData();
      fd.append('file', buf, { filename: String(file_name || 'supplier-quote.pdf').replace(/[\\/:*?"<>|]/g, '_'), contentType: media_type || 'application/pdf' });
      const token = await getAccessToken();
      const r = await axios.post(creatorApiBase() + '/report/All_Supplier_Verify_Form_Report/' + id + '/' + SV_FILE_FIELD + '/upload', fd,
        { headers: { ...zohoHeaders(token), ...fd.getHeaders() }, maxBodyLength: Infinity });
      if (r.data && r.data.code && r.data.code !== 3000) return res.status(502).json({ ok: false, error: 'The file could not be attached: ' + (r.data.message || r.data.code) });
      res.json({ ok: true, attached: file_name || 'file' });
    } catch (err) {
      const z = err.response && err.response.data;
      console.error('[quote-attachment]', z ? JSON.stringify(z).slice(0, 300) : err.message);
      res.status(502).json({ ok: false, error: 'The file could not be attached: ' + ((z && (z.message || z.description)) || err.message) });
    }
  };
  app.post('/api/supplier/me/quote-attachment', withSupplier, quoteAttachmentHandler);
  app.post('/api/mfg/supplier-quotes/quote-attachment', withMfgOnBehalf, quoteAttachmentHandler);

  // POST …/quote-notify { quote_id } — after a quote's structural AND fitting parts are saved,
  // email the manufacturer ("quote received") and the supplier (copy), each if the card asked
  // for it. Live: Material Compass is the only sender. Testing: a [TEST] copy next to Zoho's.
  const quoteNotifyHandler = async (req, res) => {
    const mailer = require('./mailer');
    const qid = String((req.body && req.body.quote_id) || '');
    const sid = String(req.supplier.id);
    const live = mailer.live(), testing = mailer.testing();
    const snap = qid ? readQuoteSnapshot(sid, qid) : null;
    if ((!live && !testing) || !snap) return res.json({ ok: true, sent: false });
    res.json({ ok: true, sent: live });
    try {
      const h = snap.header || {};
      bust('sent-rfqs:' + sid); bust('fit-rfqs:' + sid);
      const [sent, fits] = await Promise.all([fetchSentRfqs(sid), fetchSentFittingRfqs(sid).catch(() => [])]);
      const sq = sent.quotes.find(q => String(q.quote_id) === qid && inScope(req, q.manufacturer_id, q.quote_id)) || { lines: [] };
      const fq = fits.find(q => String(q.quote_id) === qid && inScope(req, q.manufacturer_id, q.quote_id));
      const mfg = sq.manufacturer_id || (fq && fq.manufacturer_id);
      if (!mfg) return;
      const token = await getAccessToken();
      const qr = await axios.get(creatorApiBase() + '/report/All_Quotes?criteria=' + encodeURIComponent('(ID==' + qid + ')'), { headers: zohoHeaders(token) });
      const qh = (qr.data && qr.data.data && qr.data.data[0]) || {};
      const reps = await cachedLookup('mfg-reps:' + mfg, 10 * 60 * 1000, () =>
        fetchAllZohoPages('/report/All_Company_Representatives?criteria=' + encodeURIComponent('(Manufacture==' + mfg + ')')));
      const rep = reps.find(r => String(r.ID) === lkid(qh.Contact_Name)) || {};
      // What was submitted (snapshot) wins over the rows, which the write-back may still be filling.
      const snapL = snap.lines || {};
      const sqNum = String(h.supplier_quote_number || '').trim();
      const fmtD = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : String(s || ''); };
      const d = {
        quote_number: qh.Reference_Number || sq.quote_number || (fq && fq.quote_number) || '',
        description: qh.Quote_Description || sq.quote_description || '',
        manufacturer: sq.manufacturer || (fq && fq.manufacturer) || qh.Manufacture_Name || '',
        supplier: { name: req.supplier.company_name, email: req.supplier.email, phone: req.supplier.phone },
        supplier_quote_number: sqNum && !/^AUTO-/.test(sqNum) ? sqNum : '—',
        valid_until: fmtD(h.valid_until), lead_time: h.lead_time || '',
        shipping: parseFloat(String(h.shipping || '0').replace(/[$,]/g, '')) || 0,
        misc: parseFloat(String(h.misc || '0').replace(/[$,]/g, '')) || 0,
        notes: h.notes || '',
        lines: sq.lines.map(l => { const s = snapL[l.rfqs_sent_id] || {}; return { line: l.line, description: String(l.description || '').replace(/^\s*\|\s*/, ''), qty: l.qty,
          status: s.quote_option || l.quote_option, total: s.total_price != null ? s.total_price : l.total_price }; }),
        fittings: fq ? fq.lines.map(l => ({ line: l.line, description: l.description, qty: l.qty, status: l.quote_option, unit: l.unit_price, total: l.total_price })) : [],
      };
      const accountEmails = String(qh['Customer_Entry_Form.Account_User_Email'] || '').split(',').map(s => s.trim()).filter(Boolean);
      const mfgTo = rep.Email ? [rep.Email] : accountEmails;
      if (h.email_mfg !== false && mfgTo.length) {
        const m = mailer.quoteReceivedEmail(d, { copy: false });
        const r = await mailer.send({ to: mfgTo, subject: m.subject, html: m.html, replyTo: req.supplier.email || undefined });
        console.log('[quote-notify]', live ? 'SENT' : 'test copy', 'mfg', qid, sid, r.ok ? r.id : r.error);
      }
      if (h.email_supplier !== false && req.supplier.email) {
        const m = mailer.quoteReceivedEmail(d, { copy: true });
        const r = await mailer.send({ to: req.supplier.email, subject: m.subject, html: m.html, replyTo: rep.Email || undefined });
        console.log('[quote-notify]', live ? 'SENT' : 'test copy', 'supplier', qid, sid, r.ok ? r.id : r.error);
      }
    } catch (e) { console.error('[quote-notify]', qid, sid, e.message); }
  };
  app.post('/api/supplier/me/quote-notify', withSupplier, quoteNotifyHandler);
  app.post('/api/mfg/supplier-quotes/quote-notify', withMfgOnBehalf, quoteNotifyHandler);
  app.post('/api/q/quote-notify', withQuoteLink, quoteNotifyHandler);

  // The no-login quote link (/quote-online?t=…): the supplier's own card, for one quote.
  app.get('/api/q/rfqs', withQuoteLink, rfqsHandler);
  app.get('/api/q/sent-fitting-rfqs', withQuoteLink, sentFittingRfqsHandler);
  app.post('/api/q/sent-fitting-rfqs/submit', withQuoteLink, fittingSubmitHandler);
  app.post('/api/q/autofill', withQuoteLink, autofillHandler);
  app.get('/api/q/quote-file', withQuoteLink, quoteFileHandler);
  app.post('/api/q/line-preview', withQuoteLink, linePreviewHandler);
  app.post('/api/q/quote-submit', withQuoteLink, quoteSubmitHandler);
  app.post('/api/q/quote-attachment', withQuoteLink, quoteAttachmentHandler);

  // ---------- RFQ email sent by Material Compass (Resend; see mailer.js) ----------
  // Built from the supplier's own RFQ rows (what they were actually sent) plus the quote
  // header (1 call) and the MFG contact (cached). opts: { due: 'Mon DD,YYYY', firstTime }.
  async function buildRfqMessage(mfg, supplier, qid, opts) {
    const o = opts || {};
    const sid = String(supplier.id);
    const [sent, fitQuotes] = await Promise.all([fetchSentRfqs(sid), fetchSentFittingRfqs(sid).catch(() => [])]);
    const mine = x => String(x.quote_id) === String(qid) && String(x.manufacturer_id) === String(mfg);
    const sq = sent.quotes.find(mine) || { lines: [], mfg_requirements: [] };
    const fq = fitQuotes.find(mine);
    if (!sq.lines.length && !(fq && fq.lines.length)) return null;
    const token = await getAccessToken();
    // o.cache (one hook = one quote, several suppliers): header and drawings fetched once.
    const cache = o.cache || {};
    if (!cache.qh) {
      const qr = await axios.get(creatorApiBase() + '/report/All_Quotes?criteria=' + encodeURIComponent('(ID==' + qid + ')'), { headers: zohoHeaders(token) });
      cache.qh = (qr.data && qr.data.data && qr.data.data[0]) || {};
    }
    const qh = cache.qh;
    const reps = await cachedLookup('mfg-reps:' + mfg, 10 * 60 * 1000, () =>
      fetchAllZohoPages('/report/All_Company_Representatives?criteria=' + encodeURIComponent('(Manufacture==' + mfg + ')')));
    const rep = reps.find(r => String(r.ID) === lkid(qh.Contact_Name)) || {};
    const t = require('./tenantToken').mint('q', sid + '_' + qid, 60 * 24 * 3600 * 1000);
    const base = process.env.PUBLIC_BASE_URL || 'https://material-compass-nesting-app-production.up.railway.app';
    const rev = Number(qh.Revision_Number) || 0;
    // Zoho writes "Nov 14,2026"; show it like the sent date ("Nov 14, 2026").
    const niceDate = s => String(s || '').replace(/,(\d{4})$/, ', $1');
    // The MFG's drawings (Quote_Form.File_upload), attached like the old email did. Up to
    // 35 MB in all (Resend's cap is 40); a file that fails or doesn't fit is left to the
    // online page, which lists every file.
    const attachments = cache.attachments || [];
    let attBytes = 0;
    for (const u of (o.attach && !cache.attachments && Array.isArray(qh.File_upload) ? qh.File_upload : [])) {
      const mm = /[?&]filepath=([^&]+)/.exec(String(u));
      const fp = mm ? decodeURIComponent(mm[1]) : '';
      if (!fp) continue;
      try {
        const fr = await axios.get(creatorApiBase() + '/report/All_Quotes/' + qid + '/File_upload/download?filepath=' + encodeURIComponent(fp),
          { headers: zohoHeaders(token), responseType: 'arraybuffer', timeout: 60000 });
        const buf = Buffer.from(fr.data);
        if (attBytes + buf.length > 35 * 1024 * 1024) continue;
        attBytes += buf.length;
        attachments.push({ filename: fp.replace(/^\d+_+/, ''), content: buf });
      } catch (e) { console.error('[rfq-email] drawing not attached', fp, e.message); }
    }
    if (o.attach) cache.attachments = attachments;
    const q = {
      quote_number: qh.Reference_Number || sq.quote_number || (fq && fq.quote_number) || '',
      revision: rev,
      sent_date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: process.env.MAIL_TZ || 'America/New_York' }),
      due_date: niceDate(o.due || qh.Requested_Responses_Due || ''),
      manufacturer: sq.manufacturer || (fq && fq.manufacturer) || qh.Manufacture_Name || '',
      mfg_contact: { name: flatten(rep.Name) || (qh.Contact_Name && String(qh.Contact_Name.zc_display_value || '').trim()) || '',
                     email: rep.Email || '', phone: rep.Direct_Phone_Number || rep.Phone_Number || '' },
      requirements: sq.mfg_requirements || [],
      lines: sq.lines.map(l => ({ line: l.line, description: String(l.description || '').replace(/^\s*\|\s*/, ''), qty: l.qty, note: l.mfg_note,
        total_weight: (Number(l.unit_weight) || 0) * (Number(l.qty) || 0) })),
      fittings: fq ? fq.lines.map(l => ({ line: l.line, description: l.description, qty: l.qty,
        total_weight: (Number(l.unit_weight) || 0) * (Number(l.qty) || 0) })) : [],
    };
    // "Revised" wording only for a supplier who was sent the revision this one replaces;
    // anyone else is seeing this quote for the first time (1 call, revisions only).
    let firstTime = !!o.firstTime;
    const origId = lkid(qh.Original_Quote_Revised) || lkid(qh.Quote_To_Be_Revised);
    if (rev > 0 && !firstTime && origId && origId !== String(qid)) {
      try {
        const pr = await axios.get(creatorApiBase() + '/report/All_RFQs_Sent_Report?criteria=' +
          encodeURIComponent('(Quote_LU==' + origId + ' && Supplier_LU==' + sid + ')'), { headers: zohoHeaders(token) });
        firstTime = !(pr.data && pr.data.data && pr.data.data.length);
      } catch (e) { firstTime = true; }   // 9280 = no rows = never sent the earlier one
    }
    const mail = require('./mailer').rfqEmail(q, { supplierName: supplier.company_name, link: base + '/quote-online?t=' + encodeURIComponent(t),
      revised: rev > 0, firstTime });
    cache.contactEmail = q.mfg_contact.email; cache.quoteNumber = q.quote_number;
    return { ...mail, attachments, replyTo: q.mfg_contact.email || undefined, to: supplier.email, quote: q };
  }

  // GET /api/mfg/supplier-quotes/rfq-email?manufacturer_id=&supplier_id=&quote_id=[&first=1][&due=][&send=me]
  // Preview the email a supplier gets (HTML). send=me mails it to the quote's MFG contact
  // instead of the supplier, to check how it lands in a real inbox.
  app.get('/api/mfg/supplier-quotes/rfq-email', withMfgOnBehalf, async (req, res) => {
    try {
      const m = await buildRfqMessage(req.onBehalfOf, req.supplier, String(req.query.quote_id || ''),
        { firstTime: req.query.first === '1', due: req.query.due ? String(req.query.due) : '', attach: req.query.send === 'me' });
      if (!m) return res.status(404).json({ ok: false, error: 'That quote was not sent to this supplier.' });
      if (req.query.send !== 'me') return res.type('html').send(m.html);
      if (!m.replyTo) return res.status(400).json({ ok: false, error: 'The quote has no contact email to send the test to.' });
      const r = await require('./mailer').send({ to: m.replyTo, subject: '[Preview for ' + req.supplier.company_name + '] ' + m.subject, html: m.html, replyTo: m.replyTo, attachments: m.attachments });
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error === 'not_configured' ? 'Email sending is not set up yet.' : 'The test email could not be sent.', detail: r.error });
      res.json({ ok: true, sent_to: m.replyTo, id: r.id });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // POST /api/hooks/rfq-sent?t=<mcToken of the quote's MFG>
  //   { quote_id, manufacturer_id, recipients: { <supplier id>: "a@x.com,b@y.com", ... } }
  // Called by Zoho's "Execute Matching and Send Emails" in place of its per-supplier sendmail,
  // for the suppliers that save just gave NEW lines. Replies { ok, sent_ids }; Zoho sends its
  // own email to every supplier NOT in sent_ids, so a supplier is never left without one.
  // Live only with RFQ_EMAIL_LIVE=1 and no MAIL_TEST_TO; until then it mails a test copy
  // (redirected by MAIL_TEST_TO) and returns sent_ids [] so Zoho still sends the real ones.
  const recentlyMailed = new Map();   // "<qid>_<sid>" -> ms; a second hook within 2 min is a repeat
  app.post('/api/hooks/rfq-sent', async (req, res) => {
    const b = req.body || {};
    const qid = String(b.quote_id || '').trim(), mfg = String(b.manufacturer_id || '').trim();
    const v = require('./tenantToken').verify(req.get('X-MC-Token') || req.query.t || '');
    if (v.error || v.kind !== 'm' || String(v.id) !== mfg || !/^\d+$/.test(qid)) {
      console.warn('[rfq-hook] refused', v.error || v.kind, mfg, qid);
      return res.status(401).json({ ok: false, sent_ids: [], error: 'not authorized' });
    }
    let recipients = b.recipients || {};
    if (typeof recipients === 'string') { try { recipients = JSON.parse(recipients); } catch (e) { recipients = {}; } }
    const mailer = require('./mailer');
    const live = mailer.configured() && process.env.RFQ_EMAIL_LIVE === '1' && !process.env.MAIL_TEST_TO;
    const testing = !live && mailer.configured() && !!process.env.MAIL_TEST_TO;
    // Quick checks only (cached directory): Zoho waits ~40 s for this reply, so the emails
    // themselves go out after it, with retries.
    const dir = await supplierDirectory().catch(() => []);
    const jobs = [], sent_ids = [];
    for (const [sid, to] of Object.entries(recipients)) {
      if (!/^\d+$/.test(sid)) continue;
      const supplier = shapeSupplier(dir.find(r => String(r.ID) === sid));
      const toList = String(to || (supplier && supplier.email) || '').split(/[,;]/).map(s => s.trim()).filter(s => /@/.test(s));
      if (!supplier || !toList.length) continue;          // Zoho sends this one
      const key = qid + '_' + sid;
      if (live && recentlyMailed.has(key) && Date.now() - recentlyMailed.get(key) < 120000) { sent_ids.push(sid); continue; }
      if (live) { sent_ids.push(sid); recentlyMailed.set(key, Date.now()); }
      if (live || testing) jobs.push({ sid, supplier, toList });
    }
    // Manufacturer notices (also optional in the body):
    //   summary: { to: "a@x,b@y", suppliers: { <sid>: "<lines>|<weight>" } }
    //   nomatch: { to: "a@x", lines: [{ line, form, material, spec, weight }] }
    //   quote:   { number, revision, date, due }
    const parse = v => { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } } return v || null; };
    const summary = parse(b.summary), nomatch = parse(b.nomatch), qinfo = parse(b.quote) || {};
    const addrs = s => String(s || '').split(/[,;]/).map(x => x.trim()).filter(x => /@/.test(x));
    const sumTo = summary ? addrs(summary.to) : [], nmTo = nomatch ? addrs(nomatch.to) : [];
    const nmLines = nomatch && Array.isArray(nomatch.lines) ? nomatch.lines : [];
    const sumSuppliers = summary && summary.suppliers && typeof summary.suppliers === 'object' ? Object.entries(summary.suppliers) : [];
    const doSummary = sumTo.length > 0 && sumSuppliers.length > 0 && (live || testing);
    const doNomatch = nmTo.length > 0 && nmLines.length > 0 && (live || testing);
    res.json({ ok: true, live, sent_ids, summary_sent: live && doSummary, nomatch_sent: live && doNomatch });

    const niceD = s => String(s || '').replace(/,(\d{4})$/, ', $1');
    const qq = { quote_number: String(qinfo.number || ''), revision: Number(qinfo.revision) || 0, quote_date: niceD(qinfo.date), due_date: niceD(qinfo.due) };
    // The summary goes out AFTER the supplier emails, so it can count what each supplier was
    // actually sent: structural lines and fittings separately, weight of both. (Zoho's
    // per-supplier figures lump fittings into the line count and leave their weight out.)
    const stats = {};
    const sendSummary = async () => {
      try {
        const outside = new Set(dir.filter(r => /^no$/i.test(String(r.Register || '').trim())).map(r => String(r.ID)));
        const rowsS = sumSuppliers.map(([sid, v]) => {
          const [lines, weight] = String(v || '').split('|');
          const rec = dir.find(r => String(r.ID) === sid);
          const s = stats[sid];
          return { name: (rec && rec.Company_Name) || 'Supplier', email_only: outside.has(sid),
            lines: s ? s.lines : (Number(lines) || 0), fittings: s ? s.fittings : null, weight: s ? s.weight : (Number(weight) || 0) };
        }).sort((a, b) => a.name.localeCompare(b.name));
        const notes = sumSuppliers.map(([sid]) => filestore.readJson('rfqadd-' + qid + '-' + sid + '.json', null)).filter(Boolean);
        const added = notes.length > 0;
        // Added suppliers were given their own date on the Add Other Suppliers screen.
        const addedDue = (notes.find(n => n.due) || {}).due;
        const m = mailer.mfgSentEmail(addedDue ? { ...qq, due_date: addedDue } : qq, rowsS, { added });
        const r = await mailer.send({ to: sumTo, subject: m.subject, html: m.html });
        console.log('[rfq-hook]', live ? 'SENT' : 'test copy', 'summary', qid, r.ok ? r.id : r.error);
      } catch (e) { console.error('[rfq-hook] summary', e.message); }
    };
    if (doNomatch) {
      try {
        const m = mailer.noMatchEmail(qq, nmLines.map(l => ({ line: l.line, form: l.form, material: l.material, spec: l.spec, weight: Number(l.weight) || 0 })));
        const r = await mailer.send({ to: nmTo, subject: m.subject, html: m.html });
        console.log('[rfq-hook]', live ? 'SENT' : 'test copy', 'no-match', qid, r.ok ? r.id : r.error);
      } catch (e) { console.error('[rfq-hook] no-match', e.message); }
    }

    // ---- after the reply: build and send, quote header + drawings fetched once ----
    const cache = {};
    const failedNames = [];
    for (const j of jobs) {
      let done = false, lastErr = '';
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        try {
          bust('sent-rfqs:' + j.sid); bust('fit-rfqs:' + j.sid);   // rows created moments ago
          const added = filestore.readJson('rfqadd-' + qid + '-' + j.sid + '.json', null);
          const m = await buildRfqMessage(mfg, j.supplier, qid, { attach: true, cache, firstTime: !!added, due: added && added.due });
          if (!m) throw new Error('no lines for this supplier yet');
          const wt = arr => arr.reduce((s, l) => s + (Number(l.total_weight) || 0), 0);
          stats[j.sid] = { lines: m.quote.lines.length, fittings: m.quote.fittings.length, weight: wt(m.quote.lines) + wt(m.quote.fittings) };
          const r = await mailer.send({ to: j.toList, subject: m.subject, html: m.html, replyTo: m.replyTo, attachments: m.attachments });
          if (!r.ok) throw new Error(r.error);
          done = true;
          console.log('[rfq-hook]', live ? 'SENT' : 'test copy', qid, j.sid, j.supplier.company_name, '->', j.toList.join(','), r.id);
        } catch (e) {
          lastErr = e.message;
          if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 15000));
        }
      }
      if (!done) {
        console.error('[rfq-hook] FAILED', qid, j.sid, j.supplier.company_name, lastErr);
        if (live) failedNames.push(j.supplier.company_name);
      }
    }
    // Live and still failed: Zoho already skipped its copy, so tell the MFG who to chase.
    if (failedNames.length && cache.contactEmail) {
      await mailer.send({ to: cache.contactEmail, subject: 'Action needed: RFQ ' + (cache.quoteNumber || '') + ' was not emailed to ' + failedNames.join(', '),
        html: '<p>Material Compass could not email quote <b>' + mailer.esc(cache.quoteNumber || '') + '</b> to: <b>' + failedNames.map(mailer.esc).join(', ') +
          '</b>.</p><p>Their lines are on the quote. Open <b>Enter Supplier Quote</b>, choose the supplier, and use <b>Copy link to price this quote online</b> to send it to them yourself.</p>' }).catch(() => {});
    }
    if (doSummary) await sendSummary();
  });

  // GET /api/mfg/supplier-quotes/quote-link?manufacturer_id=&supplier_id=&quote_id= — the
  // manufacturer's copy of a supplier's "price this quote online" link, to paste into an
  // email. Only for a quote of this MFG's that went to that supplier. Valid 60 days.
  app.get('/api/mfg/supplier-quotes/quote-link', withMfgOnBehalf, async (req, res) => {
    try {
      const qid = String(req.query.quote_id || '').trim();
      const sid = String(req.supplier.id);
      const [sent, fit] = await Promise.all([fetchSentRfqs(sid), fetchSentFittingRfqs(sid).catch(() => [])]);
      const ok = [...sent.quotes, ...fit].some(q => String(q.quote_id) === qid && inScope(req, q.manufacturer_id, q.quote_id));
      if (!ok) return res.status(404).json({ ok: false, error: 'That quote was not sent to this supplier.' });
      const t = require('./tenantToken').mint('q', sid + '_' + qid, 60 * 24 * 3600 * 1000);
      const base = process.env.PUBLIC_BASE_URL || ('https://' + req.get('host'));
      res.json({ ok: true, url: base + '/quote-online?t=' + encodeURIComponent(t) });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // GET /api/mfg/supplier-quotes/list?manufacturer_id= — the picker for the MFG's
  // "enter a supplier's quote" screen: every current quote this MFG sent out, with the
  // suppliers it went to and whether each has answered yet.
  app.get('/api/mfg/supplier-quotes/list', async (req, res) => {
    try {
      const mfg = String(req.query.manufacturer_id || '').trim();
      if (!/^\d+$/.test(mfg) || (req.tenant && req.tenant.kind === 'm' && String(req.tenant.id) !== mfg)) {
        return res.status(400).json({ ok: false, error: 'Please reopen this page from Material Compass.' });
      }
      const [rows, fitRows, dir] = await Promise.all([
        cachedLookup('mfg-sent-rfqs:' + mfg, 2 * 60 * 1000, async () =>
          fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=' + encodeURIComponent('(Customer_LU==' + mfg + ' && Latest_Item_for_Supplier==true)'))),
        // Fittings are best-effort: an outage there must not hide the structural quotes.
        cachedLookup('mfg-sent-fit:' + mfg, 2 * 60 * 1000, async () =>
          fetchAllZohoPages('/report/' + FIT_RFQ_REPORT + '?criteria=' + encodeURIComponent('(Customer_LU==' + mfg + ')'))).catch(() => []),
        supplierDirectory(),
      ]);
      const nameOf = new Map(dir.map(r => [String(r.ID), r.Company_Name || '']));
      const byQuote = new Map();
      const add = (r, kind) => {
        const qid = lkid(r.Quote_LU);
        const sid = lkid(r.Supplier_LU);
        if (!qid || !sid) return;
        if (!byQuote.has(qid)) {
          byQuote.set(qid, {
            quote_id: qid,
            quote_number: r.Quote_Reference_Number || r.Quote_Number || '',
            quote_description: r.Quote_Description || '',
            status: r['Quote_LU.Status'] || '',
            quote_date: r.Quote_Date || r.RFQSent_Timestamp || '',
            suppliers: new Map(),
          });
        }
        const q = byQuote.get(qid);
        if (!q.status && r['Quote_LU.Status']) q.status = r['Quote_LU.Status'];
        if (!q.suppliers.has(sid)) q.suppliers.set(sid, { supplier_id: sid, name: nameOf.get(sid) || flatten(r.Supplier_Name) || 'Supplier', structural: 0, fitting: 0, answered: 0 });
        const s = q.suppliers.get(sid);
        s[kind]++;
        if (String(r.Item_Verification_Status || '').trim()) s.answered++;
      };
      rows.forEach(r => {
        if (r.MFG_Revision_Cancel_Entry === true || r.MFG_Revision_Cancel_Entry === 'true') return;
        add(r, 'structural');
      });
      fitRows.forEach(r => {
        if (r.Latest_Item_for_Supplier === false || r.Latest_Item_for_Supplier === 'false') return;
        add(r, 'fitting');
      });
      const quotes = [...byQuote.values()]
        .filter(q => !/^Closed|Cancel/i.test(q.status))
        .map(q => ({ ...q, suppliers: [...q.suppliers.values()].sort((a, b) => a.name.localeCompare(b.name)) }))
        .sort((a, b) => Number(b.quote_id) - Number(a.quote_id));   // newest record first
      res.json({ ok: true, quotes });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // Starter location + rep from the registration record — a FALLBACK only. Registration
  // normally creates both; this ran on 2026-11-02/03 only because the filtered report hid
  // them, and made duplicates. Once per supplier per server start, and only when the
  // supplier has neither. Returns the rows in the report's shape for this same load.
  const starterMade = new Set();
  async function makeStarterLocationAndRep(sid, rec) {
    const out = {};
    const a = (rec.Address && typeof rec.Address === 'object') ? rec.Address : {};
    if (!(a.address_line_1 || a.district_city || a.postal_code)) return out;
    const address = {};
    ['address_line_1', 'address_line_2', 'district_city', 'state_province', 'postal_code'].forEach(k => { if (a[k]) address[k] = a[k]; });
    address.country = a.country || 'United States';
    const locName = a.district_city || rec.Company_Name || 'Main location';
    const loc = await addRecord('Supplier_Locations', {
      Supplier_Entry_Form: sid, Name_of_Location: locName, Phone_Number: rec.Phone_Number || '', Address: address, Timestamp: zohoNow(),
    });
    if (!loc.ok) { console.error('[starter] location refused for supplier ' + sid + ': ' + loc.message); return out; }
    out.location = { ID: loc.id, Name_of_Location: locName, Phone_Number: rec.Phone_Number || '', Address: address };
    const nm = rec.Main_Contact_Name || {};
    if (!rec.Email || !(nm.first_name || nm.last_name)) return out;
    const repData = {
      Supplier_Entry_Form: sid, Supplier_Company_Name: rec.Company_Name || '',
      Name: { first_name: nm.first_name || '', last_name: nm.last_name || '' },
      Email: rec.Email, Phone_Number: rec.Phone_Number || '', Supplier_Locations: loc.id, Timestamp: zohoNow(),
    };
    const shownName = { ...repData.Name, zc_display_value: [nm.first_name, nm.last_name].filter(Boolean).join(' ') };
    let rep = await addRecord('Supplier_Representatives', repData);
    // A phone in a format the rep form won't take shouldn't cost them the rep.
    if (!rep.ok && repData.Phone_Number) { repData.Phone_Number = ''; rep = await addRecord('Supplier_Representatives', repData); }
    if (!rep.ok) { console.error('[starter] rep refused for supplier ' + sid + ': ' + rep.message); return out; }
    out.rep = { ...repData, ID: rep.id, Name: shownName, Supplier_Locations: { ID: loc.id, zc_display_value: locName } };
    return out;
  }

  // GET /api/supplier/me/profile — company profile + locations + reps for the Profile tab.
  app.get('/api/supplier/me/profile', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      let [supRows, locs, reps] = await Promise.all([
        cachedLookup('supplier-directory', 5 * 60 * 1000, async () => fetchAllZohoPages('/report/' + SUPPLIER_REPORT)),
        fetchAllZohoPages('/report/' + LOC_REPORT + '?criteria=(Supplier_Entry_Form==' + encodeURIComponent(sid) + ')'),
        fetchAllZohoPages('/report/' + REP_REPORT + '?criteria=(Supplier_Entry_Form==' + encodeURIComponent(sid) + ')'),
      ]);
      const rec = supRows.find(r => String(r.ID) === sid) || {};
      const nm = rec.Main_Contact_Name || {};
      const addr = a => (a && typeof a === 'object') ? a : {};
      // A new registration has no locations or reps yet, though registration already gave us
      // the company address and main contact. Turn those into the first location and rep.
      if (!(locs || []).length && !(reps || []).length && !starterMade.has(sid)) {
        starterMade.add(sid);
        const made = await makeStarterLocationAndRep(sid, rec);
        if (made.location) locs = [made.location];
        if (made.rep) reps = [made.rep];
      }
      res.json({
        ok: true,
        profile: {
          id: sid,
          company_name: rec.Company_Name || '',
          contact_first: nm.first_name || '',
          contact_last: nm.last_name || '',
          email: rec.Email || '',
          phone: rec.Phone_Number || '',
          fax: rec.Fax || '',
          website: flatten(rec.Company_Website) || '',
          account_type: rec.Select_Account_Type || '',
          material_serviced: rec.Type_Of_Material_Serviced || '',
          certifications: Array.isArray(rec.Disadvantage) ? rec.Disadvantage : [],
          address: addr(rec.Address),
          login_emails: rec.Account_User_Email || '',
          registered: rec.Registration_Date || '',
        },
        locations: (locs || []).map(l => ({ id: String(l.ID), name: l.Name_of_Location || '', phone: l.Phone_Number || '', address: addr(l.Address) })),
        reps: (reps || []).map(r => ({
          id: String(r.ID), name: flatten(r.Name),
          first: (r.Name && r.Name.first_name) || '', last: (r.Name && r.Name.last_name) || '',
          position: r.Position || '',
          email: r.Email || '', phone: r.Phone_Number || '', ext: r.Extension || '',
          location: (r.Supplier_Locations && r.Supplier_Locations.zc_display_value) || '',
          location_id: (r.Supplier_Locations && String(r.Supplier_Locations.ID)) || '',
        })),
      });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // PATCH /api/supplier/me/profile — update the company's core profile fields.
  app.patch('/api/supplier/me/profile', withSupplier, async (req, res) => {
    try {
      const b = req.body || {};
      const data = {};
      if (b.company_name != null) data.Company_Name = b.company_name;
      if (b.email != null) data.Email = b.email;
      if (b.phone != null) data.Phone_Number = phoneForZoho(b.phone);
      if (b.fax != null) data.Fax = phoneForZoho(b.fax);
      // A URL field refuses a plain "" (3001 "Invalid column value"), which sank the whole
      // save. It takes {value, url}; {value:'', url:''} clears it (verified 2026-11-04).
      if (b.website != null) {
        let site = String(b.website).trim();
        if (/^https?:\/\/$/i.test(site)) site = '';
        data.Company_Website = site ? { value: site, url: /^https?:\/\//i.test(site) ? site : 'https://' + site } : { value: '', url: '' };
      }
      if (b.contact_first != null || b.contact_last != null) {
        data.Main_Contact_Name = { first_name: b.contact_first || '', last_name: b.contact_last || '' };
      }
      if (!Object.keys(data).length) return res.status(400).json({ ok: false, error: 'no editable fields supplied' });
      const result = await patchRecord(SUPPLIER_REPORT, req.supplier.id, data);
      if (!result.ok) return res.status(502).json({ ok: false, error: 'update rejected', code: result.code, message: result.message });
      res.json({ ok: true });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // ---- Locations & Representatives CRUD (Profile tab) ----
  function addrObj(b) {
    const a = {};
    if (b.street != null) a.address_line_1 = b.street;
    if (b.city != null) a.district_city = b.city;
    if (b.state != null) a.state_province = b.state;
    if (b.zip != null) a.postal_code = b.zip;
    a.country = b.country || 'United States';
    return a;
  }
  // Ownership guard — only let a supplier mutate its own child rows.
  async function supplierOwns(report, supplierId, id) {
    try {
      const rows = await fetchAllZohoPages('/report/' + report + '?criteria=(Supplier_Entry_Form==' + encodeURIComponent(supplierId) + ')');
      return (rows || []).some(r => String(r.ID) === String(id));
    } catch (e) { return false; }
  }
  async function addRecord(form, data) {
    const token = await getAccessToken();
    try {
      const r = await axios.post(creatorApiBase() + '/form/' + form, { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      const code = r.data && r.data.code;
      return { ok: code === 3000, code, id: r.data && r.data.data && r.data.data.ID, message: r.data && r.data.message };
    } catch (e) {
      return { ok: false, message: (e.response && JSON.stringify(e.response.data)) || e.message };
    }
  }
  // Bulk add (v2.1 accepts an array in data, ≤200/call). Returns count actually added.
  async function bulkAdd(form, rows) {
    const token = await getAccessToken();
    let added = 0; const errors = [];
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      try {
        const r = await axios.post(creatorApiBase() + '/form/' + form, { data: chunk }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
        const result = (r.data && (r.data.result || r.data.data));
        if (Array.isArray(result)) {
          added += result.filter(x => !x.code || x.code === 3000 || x.code === '3000').length;
          result.filter(x => x.code && x.code !== 3000 && x.code !== '3000').forEach(x => errors.push(JSON.stringify(x.error || x)));
        } else added += chunk.length; // 2xx with no per-row breakdown → treat as added
      } catch (e) { errors.push((e.response && JSON.stringify(e.response.data)) || e.message); }
    }
    return { added, errors };
  }
  // NOTE: there is no bulk delete-by-criteria here on purpose. Creator v2.1 accepts a
  // criteria string on GET but rejects the identical string on DELETE:
  //   DELETE /report/X?criteria=(A==1&&B==2) -> HTTP 401 {"code":1060,"criteria"} and
  //   deletes nothing. Verified 2026-08-03 against Supplier_Fitting_Stock_All.
  // Deletes must go one record ID at a time. Keep call counts down by diffing (see the
  // group sync below), not by batching the delete.
  async function deleteRecords(report, ids) {
    let removed = 0; const errors = [];
    for (const id of ids) {
      const r = await deleteRecord(report, id);
      if (r.ok) removed++; else errors.push(id + ': ' + (r.message || 'delete failed'));
    }
    return { removed, errors };
  }
  async function deleteRecord(report, id) {
    const token = await getAccessToken();
    try {
      const r = await axios.delete(creatorApiBase() + '/report/' + report + '/' + id, { headers: zohoHeaders(token) });
      const code = r.data && r.data.code;
      return { ok: code === 3000 || code == null, code, message: r.data && r.data.message };
    } catch (e) {
      return { ok: false, message: (e.response && JSON.stringify(e.response.data)) || e.message };
    }
  }

  // Locations
  app.post('/api/supplier/me/locations', withSupplier, async (req, res) => {
    const b = req.body || {};
    const r = await addRecord('Supplier_Locations', {
      Supplier_Entry_Form: req.supplier.id, Name_of_Location: b.name || '', Phone_Number: phoneForZoho(b.phone), Address: addrObj(b), Timestamp: zohoNow(),
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: 'add failed', message: r.message });
    res.json({ ok: true, id: r.id });
  });
  app.patch('/api/supplier/me/locations/:id', withSupplier, async (req, res) => {
    if (!(await supplierOwns(LOC_REPORT, req.supplier.id, req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
    const b = req.body || {}; const data = {};
    if (b.name != null) data.Name_of_Location = b.name;
    if (b.phone != null) data.Phone_Number = phoneForZoho(b.phone);
    if (b.street != null || b.city != null || b.state != null || b.zip != null || b.country != null) data.Address = addrObj(b);
    const r = await patchRecord(LOC_REPORT, req.params.id, data);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'update failed', message: r.message });
    res.json({ ok: true });
  });
  app.delete('/api/supplier/me/locations/:id', withSupplier, async (req, res) => {
    if (!(await supplierOwns(LOC_REPORT, req.supplier.id, req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
    const r = await deleteRecord(LOC_REPORT, req.params.id);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'delete failed', message: r.message });
    res.json({ ok: true });
  });

  // Representatives
  app.post('/api/supplier/me/reps', withSupplier, async (req, res) => {
    const b = req.body || {};
    const data = {
      Supplier_Entry_Form: req.supplier.id, Supplier_Company_Name: req.supplier.company_name || '',
      Name: { first_name: b.first || '', last_name: b.last || '' },
      Position: b.position || '', Email: b.email || '', Phone_Number: phoneForZoho(b.phone), Extension: b.ext || '', Timestamp: zohoNow(),
    };
    if (b.location_id) data.Supplier_Locations = b.location_id;
    const r = await addRecord('Supplier_Representatives', data);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'add failed', message: r.message });
    res.json({ ok: true, id: r.id });
  });
  app.patch('/api/supplier/me/reps/:id', withSupplier, async (req, res) => {
    if (!(await supplierOwns(REP_REPORT, req.supplier.id, req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
    const b = req.body || {}; const data = {};
    if (b.first != null || b.last != null) data.Name = { first_name: b.first || '', last_name: b.last || '' };
    if (b.position != null) data.Position = b.position;
    if (b.email != null) data.Email = b.email;
    if (b.phone != null) data.Phone_Number = phoneForZoho(b.phone);
    if (b.ext != null) data.Extension = b.ext;
    if (b.location_id != null) data.Supplier_Locations = b.location_id;
    const r = await patchRecord(REP_REPORT, req.params.id, data);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'update failed', message: r.message });
    res.json({ ok: true });
  });
  app.delete('/api/supplier/me/reps/:id', withSupplier, async (req, res) => {
    if (!(await supplierOwns(REP_REPORT, req.supplier.id, req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
    const r = await deleteRecord(REP_REPORT, req.params.id);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'delete failed', message: r.message });
    res.json({ ok: true });
  });

  // ---- Stock (Structural + Fittings) ----
  const STRUCT_REPORT = STRUCT_STOCK_REPORT;
  const FIT_STOCK_REPORT = process.env.FITTING_STOCK_REPORT || 'Supplier_Fitting_Stock_All';
  const isStocked = v => Array.isArray(v) ? v.includes('Stocked') : (v === 'Stocked' || v === true || v === 'true');
  // 10 min: the tick route keeps the cached rows current, so a short life only re-buys the list.
  const structStock = sid => cachedLookup('struct-stock:' + sid, 10 * 60 * 1000, () =>
    fetchAllZohoPages('/report/' + STRUCT_REPORT + '?criteria=(Supplier_ID==' + encodeURIComponent(sid) + ')'));
  const fitStock = sid => cachedLookup('fit-stock-all:' + sid, 60 * 1000, () =>
    fetchAllZohoPages('/report/' + FIT_STOCK_REPORT + '?criteria=(Supplier_ID==' + encodeURIComponent(sid) + ')'));

  // A supplier's structural stock list is one row per catalog spec (Material_Form_Detail),
  // each with a Stocked checkbox they tick. Zoho used to create that set when a supplier
  // registered; registrations since no longer do, which left new suppliers with nothing to
  // tick. So the Stock tab fills in any spec a supplier has no row for — unticked — from
  // the catalog. Also picks up specs added to the catalog later. Form = TestRecords.
  const seeding = new Map();
  // One fill per supplier per server start. On 2026-11-01 the stock report couldn't see the
  // rows it had just written, so every Stock open re-added the full set; this caps any repeat
  // of that to a single set until the next deploy.
  const filledOnce = new Set();
  async function fillMissingStructural(sid, rows) {
    // Without the spec column every row looks "missing" and we'd add a whole duplicate set.
    if (rows.length && !rows.some(r => lkid(r.Type_Detail_LU))) {
      console.error('[stock seed] ' + STRUCT_REPORT + ' has no Type_Detail_LU column; skipping fill for supplier ' + sid);
      return 0;
    }
    const { specById } = await fetchCatalogs({ fetchAllZohoPages, cachedLookup });
    const have = new Set(rows.map(r => lkid(r.Type_Detail_LU)).filter(Boolean));
    const missing = Object.keys(specById).filter(id => !have.has(id) && specById[id].formTypeId && specById[id].matTypeId);
    if (!missing.length) return 0;
    const token = await getAccessToken();
    const now = zohoNow();
    let added = 0;
    for (let i = 0; i < missing.length; i += 200) {
      const data = missing.slice(i, i + 200).map(id => ({
        Supplier_ID: sid,
        Form_Type: specById[id].formTypeId,
        Material_Type: specById[id].matTypeId,
        Type_Detail_LU: id,
        Type_Detail: specById[id].typeDetail,
        Timestamp: now,
      }));
      try {
        const r = await axios.post(creatorApiBase() + '/form/TestRecords', { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
        const results = (r.data && r.data.result) || [];
        added += results.filter(x => x && x.code === 3000).length;
        const bad = results.filter(x => x && x.code !== 3000);
        if (bad.length) console.error('[stock seed] ' + bad.length + ' rows refused for supplier ' + sid + ': ' + JSON.stringify(bad[0]).slice(0, 300));
      } catch (e) {
        console.error('[stock seed] batch failed for supplier ' + sid + ':', (e.response && JSON.stringify(e.response.data)) || e.message);
      }
    }
    return added;
  }

  // GET /api/supplier/me/stock — structural + fittings stock lists for the Stock tab.
  app.get('/api/supplier/me/stock', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      let [struct, fit] = await Promise.all([structStock(sid), fitStock(sid)]);
      // One fill at a time per supplier: a double-loaded tab must not add the set twice.
      // STOCK_SEED=off is the kill switch.
      if (process.env.STOCK_SEED !== 'off' && !seeding.has(sid) && !filledOnce.has(sid)) {
        filledOnce.add(sid);
        seeding.set(sid, fillMissingStructural(sid, struct || []).finally(() => seeding.delete(sid)));
        const added = await seeding.get(sid);
        if (added) { bust('struct-stock:' + sid); struct = await structStock(sid); }
      } else if (seeding.has(sid)) {
        await seeding.get(sid);
        bust('struct-stock:' + sid); struct = await structStock(sid);
      }
      res.json({
        ok: true,
        structural: (struct || []).map(r => ({
          id: String(r.ID),
          form_type: flatten(r.Form_Type),
          material_type: flatten(r.Material_Type),
          spec: r.Type_Detail || flatten(r.Type_Detail_LU) || '',
          stocked: isStocked(r.Material_Stocked),
        })),
        fittings: (fit || []).map(r => ({
          id: String(r.ID),
          type: flatten(r.Fitting_Type), make: flatten(r.Fitting_Make),
          end: flatten(r.End_Type), connection: flatten(r.Connection_Type),
          spec: flatten(r.Fitting_Specification), stocked: isStocked(r.Fitting_Stocked_Checkbox),
          type_id: lkid(r.Fitting_Type), make_id: lkid(r.Fitting_Make), end_id: lkid(r.End_Type),
          connection_id: lkid(r.Connection_Type), spec_id: lkid(r.Fitting_Specification),
        })),
      });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // PATCH /api/supplier/me/stock/structural/:id — toggle a structural item stocked/not.
  // Ownership verified against the supplier's cached stock list (no extra API call).
  app.patch('/api/supplier/me/stock/structural/:id', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const rows = await structStock(sid);
      if (!rows.some(r => String(r.ID) === String(req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
      const stocked = !!(req.body && req.body.stocked);
      const r = await patchRecord(STRUCT_REPORT, req.params.id, { Material_Stocked: stocked ? ['Stocked'] : [] });
      if (!r.ok) return res.status(502).json({ ok: false, error: 'update failed', message: r.message });
      // Update the cached row instead of busting it. Busting made the NEXT tick re-read the
      // whole list (~500 rows = 3 calls), so each box cost ~4 Zoho calls and one supplier
      // ticking their list ran the daily allowance out on 2026-11-03.
      const row = rows.find(x => String(x.ID) === String(req.params.id));
      if (row) row.Material_Stocked = stocked ? ['Stocked'] : [];
      res.json({ ok: true });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // Set one field on many records. Tries Zoho's multi-record update (criteria in the body,
  // one call per 50 ids); if Zoho doesn't confirm every record, re-applies that chunk one
  // record at a time (setting the same value twice is harmless). Stops on quota (4000).
  async function patchMany(report, ids, data) {
    let done = 0, failed = [], bulkCalls = 0, singleCalls = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      let confirmed = false;
      try {
        const token = await getAccessToken();
        bulkCalls++;
        const r = await axios.patch(creatorApiBase() + '/report/' + report,
          // Only criteria + data: an extra key (process_until_limit) is refused with 2945.
          // Verified 2026-11-04: updates exactly the listed ids, result[] has one entry each.
          { criteria: '(' + chunk.map(id => 'ID == ' + id).join(' || ') + ')', data },
          { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
        const b = r.data || {};
        if (b.code === 4000) return { done, failed: failed.concat(ids.slice(i)), quota: true, bulkCalls, singleCalls };
        const res = Array.isArray(b.result) ? b.result : null;
        if (res && res.length > chunk.length) console.error('[patchMany] ' + report + ': Zoho updated ' + res.length + ' records for ' + chunk.length + ' ids — check criteria handling');
        confirmed = res ? res.length === chunk.length && res.every(x => x.code === 3000) : false;
      } catch (e) {
        if (e.response && e.response.data && e.response.data.code === 4000) return { done, failed: failed.concat(ids.slice(i)), quota: true, bulkCalls, singleCalls };
      }
      if (confirmed) { done += chunk.length; continue; }
      for (let j = 0; j < chunk.length; j++) {
        singleCalls++;
        const one = await patchRecord(report, chunk[j], data);
        if (one.ok) done++;
        else if (one.code === 4000) return { done, failed: failed.concat(chunk.slice(j), ids.slice(i + 50)), quota: true, bulkCalls, singleCalls };
        else failed.push(chunk[j]);
      }
    }
    return { done, failed, quota: false, bulkCalls, singleCalls };
  }

  // POST /api/supplier/me/stock/structural/save — the Stock tab's Save button.
  // body { stocked: [ids], unstocked: [ids] }. ~2 Zoho calls for any number of ticks,
  // instead of one call per box. Only ids on this supplier's own list are written.
  app.post('/api/supplier/me/stock/structural/save', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const rows = await structStock(sid);
      const mine = new Map(rows.map(r => [String(r.ID), r]));
      const pick = k => [...new Set(((req.body && req.body[k]) || []).map(String))].filter(id => /^\d+$/.test(id) && mine.has(id));
      const on = pick('stocked'), off = pick('unstocked').filter(id => !on.includes(id));
      const out = { saved: [], failed: [], quota: false };
      for (const [ids, val] of [[on, ['Stocked']], [off, []]]) {
        if (!ids.length || out.quota) { if (out.quota) out.failed.push(...ids); continue; }
        const r = await patchMany(STRUCT_REPORT, ids, { Material_Stocked: val });
        console.log('[stock save] supplier ' + sid + ' ' + (val.length ? 'stock' : 'unstock') + ' ' + ids.length +
          ' → ' + r.done + ' ok, ' + r.failed.length + ' failed (' + r.bulkCalls + ' bulk + ' + r.singleCalls + ' single calls)');
        const bad = new Set(r.failed.map(String));
        for (const id of ids) {
          if (bad.has(id)) continue;
          mine.get(id).Material_Stocked = val;   // keep the cached list current — no re-read
          out.saved.push(id);
        }
        out.failed.push(...r.failed.map(String));
        if (r.quota) out.quota = true;
      }
      res.status(out.failed.length ? (out.quota ? 429 : 502) : 200).json({
        ok: !out.failed.length, ...out,
        error: out.quota ? 'Daily data limit reached — ' + out.saved.length + ' saved, ' + out.failed.length + ' not. Try again after it resets overnight.'
             : out.failed.length ? out.failed.length + ' item(s) could not be saved.' : undefined,
      });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // GET /api/supplier/me/fitting-catalog — the 5 cascade tables (global, cached 1h).
  // End/Connection carry a type_id (filter by Fitting Type); Spec carries make_id.
  const lkId = (r, key) => (r[key] && r[key].ID) || r[key + '.ID'] || '';
  app.get('/api/supplier/me/fitting-catalog', withSupplier, async (req, res) => {
    try {
      const cat = await loadFittingCatalog();   // shared loader — see server/fittingCatalog.js
      res.json({ ok: true, catalog: cat });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // POST /api/supplier/me/stock/fittings — add a stocked fitting (dedupes on the 5 axes).
  app.post('/api/supplier/me/stock/fittings', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const b = req.body || {};
      for (const k of ['type_id', 'make_id', 'end_id', 'connection_id', 'spec_id']) {
        if (!b[k]) return res.status(400).json({ ok: false, error: 'missing ' + k });
      }
      const existing = await fitStock(sid);
      const dup = (existing || []).some(r =>
        String((r.Fitting_Type || {}).ID) === b.type_id && String((r.Fitting_Make || {}).ID) === b.make_id &&
        String((r.End_Type || {}).ID) === b.end_id && String((r.Connection_Type || {}).ID) === b.connection_id &&
        String((r.Fitting_Specification || {}).ID) === b.spec_id);
      if (dup) return res.json({ ok: true, duplicate: true });
      const r = await addRecord('Supplier_Fitting_Stock', {
        Supplier_ID: sid, Fitting_Type: b.type_id, Fitting_Make: b.make_id,
        End_Type: b.end_id, Connection_Type: b.connection_id, Fitting_Specification: b.spec_id,
        Fitting_Stocked_Checkbox: ['Stocked'], Timestamp: zohoNow(),
      });
      if (!r.ok) return res.status(502).json({ ok: false, error: 'add failed', message: r.message });
      bust('fit-stock-all:' + sid); bust('fitting-stock:' + sid);
      res.json({ ok: true, id: r.id });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // POST /api/supplier/me/stock/fittings/bulk — add every (connection × spec) combo
  // for the chosen Type/Make/End at once. Dedupes against existing stock.
  app.post('/api/supplier/me/stock/fittings/bulk', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const b = req.body || {};
      if (!b.type_id || !b.make_id || !b.end_id) return res.status(400).json({ ok: false, error: 'type, make, and end required' });
      const connIds = Array.isArray(b.connection_ids) ? b.connection_ids.filter(Boolean) : [];
      const specIds = Array.isArray(b.spec_ids) ? b.spec_ids.filter(Boolean) : [];
      if (!connIds.length || !specIds.length) return res.status(400).json({ ok: false, error: 'pick at least one connection and one specification' });
      const existing = await fitStock(sid);
      const have = new Set((existing || []).map(r => [
        String((r.Fitting_Type || {}).ID), String((r.Fitting_Make || {}).ID), String((r.End_Type || {}).ID),
        String((r.Connection_Type || {}).ID), String((r.Fitting_Specification || {}).ID)].join('|')));
      const rows = [];
      for (const c of connIds) for (const s of specIds) {
        if (have.has([b.type_id, b.make_id, b.end_id, c, s].join('|'))) continue;
        rows.push({ Supplier_ID: sid, Fitting_Type: b.type_id, Fitting_Make: b.make_id, End_Type: b.end_id, Connection_Type: c, Fitting_Specification: s, Fitting_Stocked_Checkbox: ['Stocked'], Timestamp: zohoNow() });
      }
      const attempted = connIds.length * specIds.length;
      if (!rows.length) return res.json({ ok: true, added: 0, duplicates: attempted });
      const result = await bulkAdd('Supplier_Fitting_Stock', rows);
      if (!result.added && result.errors.length) return res.status(502).json({ ok: false, error: 'add failed', message: result.errors[0] });
      bust('fit-stock-all:' + sid); bust('fitting-stock:' + sid);
      res.json({ ok: true, added: result.added, attempted, duplicates: attempted - rows.length });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // PUT /api/supplier/me/stock/fittings/group — sync one Type/Make/End group's stock to
  // the chosen connections × specs (adds new combos, removes deselected ones).
  app.put('/api/supplier/me/stock/fittings/group', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const b = req.body || {};
      if (!b.type_id || !b.make_id || !b.end_id) return res.status(400).json({ ok: false, error: 'type, make, and end required' });
      const connIds = Array.isArray(b.connection_ids) ? b.connection_ids.filter(Boolean).map(String) : [];
      const specIds = Array.isArray(b.spec_ids) ? b.spec_ids.filter(Boolean).map(String) : [];
      // Diff against what's already stocked rather than clearing and re-adding the whole
      // group: checking one more spec writes one row instead of rewriting all 102. (Clearing
      // first is also not an option — Zoho rejects criteria on DELETE; see deleteRecords.)
      // Re-read rather than trust the 60s cache: diffing against a stale list duplicates rows.
      bust('fit-stock-all:' + sid);
      const all = await fitStock(sid);
      const inGroup = (all || []).filter(r =>
        lkid(r.Fitting_Type) === String(b.type_id) &&
        lkid(r.Fitting_Make) === String(b.make_id) &&
        lkid(r.End_Type) === String(b.end_id));

      const combo = (c, s) => c + '|' + s;
      const wanted = new Set();
      for (const c of connIds) for (const s of specIds) wanted.add(combo(c, s));

      const seen = new Set(); const staleIds = [];
      for (const r of inGroup) {
        const k = combo(lkid(r.Connection_Type), lkid(r.Fitting_Specification));
        // drop anything deselected, plus any duplicate rows for a combo we're keeping
        if (!wanted.has(k) || seen.has(k)) staleIds.push(String(r.ID)); else seen.add(k);
      }

      const rows = [];
      for (const k of wanted) {
        if (seen.has(k)) continue;
        const [c, s] = k.split('|');
        rows.push({ Supplier_ID: sid, Fitting_Type: b.type_id, Fitting_Make: b.make_id, End_Type: b.end_id, Connection_Type: c, Fitting_Specification: s, Fitting_Stocked_Checkbox: ['Stocked'], Timestamp: zohoNow() });
      }

      const del = await deleteRecords(FIT_STOCK_REPORT, staleIds);
      const add = rows.length ? await bulkAdd('Supplier_Fitting_Stock', rows) : { added: 0, errors: [] };
      bust('fit-stock-all:' + sid); bust('fitting-stock:' + sid);

      // Surface partial failures instead of reporting a clean save (a save that silently
      // drops rows is worse than one that says what it couldn't do).
      const errors = [...del.errors, ...add.errors];
      if (errors.length) {
        return res.status(502).json({
          ok: false, error: 'saved partially', added: add.added, removed: del.removed,
          message: errors.length + ' of ' + (staleIds.length + rows.length) + ' changes failed: ' + errors.slice(0, 3).join('; '),
        });
      }
      res.json({ ok: true, added: add.added, removed: del.removed, total: wanted.size });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // DELETE /api/supplier/me/stock/fittings/:id — remove a stocked fitting.
  app.delete('/api/supplier/me/stock/fittings/:id', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const rows = await fitStock(sid);
      if (!rows.some(r => String(r.ID) === String(req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
      const r = await deleteRecord(FIT_STOCK_REPORT, req.params.id);
      if (!r.ok) return res.status(502).json({ ok: false, error: 'delete failed', message: r.message });
      bust('fit-stock-all:' + sid); bust('fitting-stock:' + sid);
      res.json({ ok: true });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // GET /api/supplier/me/quote-detail?quote_id=X — the FULL quote (all lines, all
  // suppliers) with each line's coverage for THIS supplier: sent-to-me, stock match,
  // and whether it's been quoted. Lets the dashboard show "you covered what you could"
  // including the lines the MFG didn't send you (not-a-match).
  app.get('/api/supplier/me/quote-detail', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const quoteId = String(req.query.quote_id || '');
      if (!quoteId) return res.status(400).json({ ok: false, error: 'quote_id required' });
      const [rows, stockAll] = await Promise.all([
        cachedLookup('quote-detail:' + quoteId, 60 * 1000, () =>
          fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=(Quote_LU==' + encodeURIComponent(quoteId) + ')')),
        structStock(sid),
      ]);
      // stock match sets from the supplier's stocked structural rows
      const exact = new Set(), strong = new Set();
      for (const r of (stockAll || [])) {
        if (!isStocked(r.Material_Stocked)) continue;
        const f = lkid(r.Form_Type), m = lkid(r.Material_Type), s = lkid(r.Type_Detail_LU);
        if (f && m && s) exact.add(f + '|' + m + '|' + s);
        if (f && m) strong.add(f + '|' + m);
      }
      const matchOf = (f, m, s) => (f && m && s && exact.has(f + '|' + m + '|' + s)) ? 'exact' : ((f && m && strong.has(f + '|' + m)) ? 'strong' : null);

      // group all rows by line (same line sent to N suppliers = N rows)
      const byLine = new Map();
      for (const r of (rows || [])) {
        const ln = String(r.Line_Item || ('row-' + r.ID));
        if (!byLine.has(ln)) byLine.set(ln, []);
        byLine.get(ln).push(r);
      }
      const lines = [];
      for (const group of byLine.values()) {
        const any = group[0];
        const mine = group.find(r => lkid(r.Supplier_LU) === sid);
        const f = lkid(any.Form_Type), mt = lkid(any.Material_Type), sp = lkid(any.Material_Form_Detail);
        const responded = mine ? (!!(mine.Item_Verification_Status && String(mine.Item_Verification_Status).trim()) || (mine.Price_Per_Lb != null && String(mine.Price_Per_Lb).trim() !== '' && Number(mine.Price_Per_Lb) > 0)) : false;
        lines.push({
          line_item: any.Line_Item || '',
          description: stripItemNo(any.Description_And_Dimension_Text || any.Full_Item_Description || ''),
          qty: any.Quantity != null ? Number(any.Quantity) : null,
          sent_to_me: !!mine,
          stock_match: matchOf(f, mt, sp), // 'exact' | 'strong' | null
          responded,
          my_row_id: mine ? String(mine.ID) : null,
        });
      }
      lines.sort((a, b) => (Number(a.line_item) || 0) - (Number(b.line_item) || 0));
      const meta = rows && rows[0] ? rows[0] : {};
      res.json({
        ok: true,
        quote: {
          quote_id: quoteId,
          quote_number: meta.Quote_Reference_Number || meta.Quote_Number || '',
          project: flatten(meta.MCP_Customer_Project_Form) || '',
          client: (meta.MFG_Client_Form && meta.MFG_Client_Form.Client_Company_Name) || flatten(meta.Customer_LU) || '',
        },
        counts: {
          total: lines.length,
          sent_to_me: lines.filter(l => l.sent_to_me).length,
          matched: lines.filter(l => l.sent_to_me && l.stock_match).length,
          quoted: lines.filter(l => l.responded).length,
        },
        lines,
      });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // ---- Manufacturer matches (who may send this supplier RFQs) ----
  // Junction form Quote_Sent_To_Manufacture_Supplier_Status: one row per MFG↔supplier pair, with a
  // YES/NO radio for each side. The MFG's Match Hub writes Manufacture_Accept_…; until 2026-10-29
  // nothing let the supplier write Supplier_Accept_…, so new manufacturers sat unanswered.
  // MATCH_REPORT must be UNFILTERED (the Match Hub's own report filters to the logged-in MFG) —
  // ownership is enforced here by SUPPLIER == this supplier.
  const MATCH_REPORT = process.env.SUPPLIER_MATCH_REPORT || 'All_Supplier_Manufacture_Matches';
  const ACCEPT_YES = 'YES - ACCEPT QUOTES';
  // Radio value — must match the Zoho choice exactly or the write is refused.
  const ACCEPT_NO = process.env.SUPPLIER_MATCH_NO_VALUE || 'NO - DO NOT ACCEPT QUOTES';
  const decisionOf = v => { const s = String(v || '').trim().toUpperCase(); return s.startsWith('YES') ? 'yes' : (s.startsWith('NO') ? 'no' : ''); };
  const matchRows = sid => cachedLookup('mfg-matches:' + sid, 60 * 1000, () =>
    fetchAllZohoPages('/report/' + MATCH_REPORT + '?criteria=(SUPPLIER==' + encodeURIComponent(sid) + ')'));

  function shapeMatch(r) {
    const mfg = r.MANUFACTURE || {};
    const addr = r['MANUFACTURE.Address'] || {};
    const sup = decisionOf(r.Supplier_Accept_Quotes_From_Manufacture);
    const man = decisionOf(r.Manufacture_Accept_Quotes_From_Supplier);
    // pending = waiting on THIS supplier; waiting = supplier said yes, MFG hasn't; active = both yes.
    let status;
    if (sup === 'no') status = 'declined';
    else if (man === 'no') status = 'mfg_declined';
    else if (sup === 'yes') status = man === 'yes' ? 'active' : 'waiting';
    else status = 'pending';
    return {
      id: String(r.ID),
      manufacture_id: mfg.ID ? String(mfg.ID) : '',
      company_name: r['MANUFACTURE.Company_Name'] || flatten(mfg),
      email: r['MANUFACTURE.Email'] || '',
      phone: r['MANUFACTURE.Phone_Number'] || '',
      website: flatten(r['MANUFACTURE.Company_Website']),
      city: [addr.district_city, addr.state_province].filter(Boolean).join(', '),
      address: addr.zc_display_value || '',
      supplier_decision: sup,
      manufacturer_decision: man,
      status,
    };
  }

  // Rep assignments (form Manufacture_Supplier_Representative_Matching): which MFG reps work with
  // which of this supplier's locations. Report is unfiltered; scoped here by Supplier_Entry_Form.
  const REP_MATCH_REPORT = process.env.SUPPLIER_REP_MATCH_REPORT || 'All_Rep_Matches_Admin';
  const repMatchRows = sid => cachedLookup('mfg-rep-matches:' + sid, 60 * 1000, () =>
    fetchAllZohoPages('/report/' + REP_MATCH_REPORT + '?criteria=(Supplier_Entry_Form==' + encodeURIComponent(sid) + ')'));

  // contacts keyed by manufacturer id, and by junction id for older rows whose Manufacture lookup is
  // blank but whose Supplier_Manufacture_Match_ID still points at the junction row.
  const arr = v => (Array.isArray(v) ? v : []);
  const cleanName = x => flatten(x).replace(/\s+/g, ' ').trim();
  // Registration names every manufacturer's first location "Headquarters/Main Location" — show "Headquarters".
  const locName = x => flatten(x).replace(/\s*\/\s*Main Location\s*$/i, '').trim();
  // One rep-match row as the supplier's editor sees it: their side is read-only, ours is editable.
  function shapeAssignment(r) {
    const theirEmails = arr(r['Manufacture_Reps_Allocated_For_Supplier.Email']);
    return {
      id: String(r.ID),
      their_location: locName(r.Company_Locations),
      their_location_id: r.Company_Locations && r.Company_Locations.ID ? String(r.Company_Locations.ID) : '',
      their_reps: arr(r.Manufacture_Reps_Allocated_For_Supplier).map((x, i) => ({ name: cleanName(x), email: theirEmails[i] || '' })).filter(c => c.name),
      their_rep_ids: arr(r.Manufacture_Reps_Allocated_For_Supplier).map(x => String(x.ID)).filter(Boolean),
      your_location: flatten(r.Supplier_Locations),
      your_location_id: r.Supplier_Locations && r.Supplier_Locations.ID ? String(r.Supplier_Locations.ID) : '',
      your_rep_ids: arr(r.Supplier_Reps_Allocated_For_Manufacture).map(x => String(x.ID)).filter(Boolean),
      your_reps: arr(r.Supplier_Reps_Allocated_For_Manufacture).map(cleanName).filter(Boolean),
    };
  }
  const repRowMfgKey = r => (r.Manufacture && r.Manufacture.ID ? 'm:' + r.Manufacture.ID : 'j:' + (r.Supplier_Manufacture_Match_ID || ''));

  function contactsIndex(rows) {
    const byMfg = new Map(), byMatch = new Map();
    const add = (map, k, a) => { const e = map.get(k) || { contacts: [], assignments: [] }; e.assignments.push(a); map.set(k, e); return e; };
    for (const r of rows || []) {
      const a = shapeAssignment(r);
      const contacts = a.their_reps.map(c => ({
        name: c.name, email: c.email, their_location: a.their_location, your_location: a.your_location, your_reps: a.your_reps,
      }));
      const mid = r.Manufacture && r.Manufacture.ID ? String(r.Manufacture.ID) : '';
      const jid = r.Supplier_Manufacture_Match_ID ? String(r.Supplier_Manufacture_Match_ID) : '';
      if (mid) add(byMfg, mid, a).contacts.push(...contacts);
      if (jid) add(byMatch, jid, a).contacts.push(...contacts);
    }
    return { byMfg, byMatch };
  }

  // A manufacturer's registration pairs it with every existing supplier, but a supplier's
  // registration stopped pairing it with existing manufacturers (Supplier1, 2026-11-01, got
  // none — same break that left new suppliers with no stock list). So on the Manufacturers tab,
  // add a pending pair for each live manufacturer this supplier has no row with. "Live" =
  // Supplier_Matches_Populated true, i.e. it went through matching setup (skips test shops).
  // Once per supplier per server start; one batched insert.
  const MATCH_FORM = process.env.SUPPLIER_MATCH_FORM || 'Quote_Sent_To_Manufacture_Supplier_Status';
  const pairsFilled = new Set();
  async function fillMissingPairs(sid, rows) {
    if (pairsFilled.has(sid) || process.env.MATCH_SEED === 'off') return false;
    pairsFilled.add(sid);
    // Only real, registered suppliers. "Material Compass ADMIN" has a supplier record (Register
    // blank) for viewing the portal; opening it on 2026-11-04 put it in every MFG's New Matches.
    const me = ((await supplierDirectory()) || []).find(r => String(r.ID) === sid);
    if (!me || String(me.Register || '').trim().toLowerCase() !== 'yes') return false;
    const mfgs = await cachedLookup('mfg-directory-live', 10 * 60 * 1000, async () =>
      (await fetchAllZohoPages('/report/Customer_Entry_Report'))
        .filter(m => String(m.Supplier_Matches_Populated) === 'true' && String(m.Registered || '').toUpperCase() === 'YES')
        .map(m => ({ ID: String(m.ID), Company_Name: m.Company_Name })));
    const have = new Set((rows || []).map(r => r.MANUFACTURE && String(r.MANUFACTURE.ID)).filter(Boolean));
    const add = mfgs.filter(m => !have.has(m.ID)).map(m => ({
      SUPPLIER: sid, MANUFACTURE: m.ID,
      Supplier_New_Entry: 'true', Manufacture_New_Entry: 'true', Hide_Supplier_From_Matching: 'false',
    }));
    if (!add.length) return false;
    const r = await bulkAdd(MATCH_FORM, add);
    console.log('[match fill] supplier ' + sid + ': added ' + r.added + ' of ' + add.length + ' pending manufacturer pairs' +
      (r.errors.length ? ' — ' + r.errors[0] : ''));
    return r.added > 0;
  }

  async function loadManufacturers(sid) {
    let [rows, repRows] = await Promise.all([matchRows(sid), repMatchRows(sid).catch(() => [])]);
    if (await fillMissingPairs(sid, rows).catch(e => { console.error('[match fill] ' + sid + ': ' + e.message); return false; })) {
      bust('mfg-matches:' + sid);
      rows = await matchRows(sid);
    }
    const idx = contactsIndex(repRows);
    // Rows whose manufacturer was deleted keep an empty MANUFACTURE lookup — nothing to show or answer.
    const shaped = (rows || []).map(shapeMatch).filter(m => m.manufacture_id);
    // A pair can have more than one junction row; show each manufacturer once, preferring the row
    // that already carries a supplier decision, so an old blank duplicate can't re-ask a question.
    const byMfg = new Map();
    for (const m of shaped) {
      const prev = byMfg.get(m.manufacture_id);
      if (!prev || (!prev.supplier_decision && m.supplier_decision)) byMfg.set(m.manufacture_id, m);
    }
    const seen = new Set();
    for (const m of byMfg.values()) {
      const e = idx.byMfg.get(m.manufacture_id) || idx.byMatch.get(m.id) || { contacts: [], assignments: [] };
      m.assignments = e.assignments;
      m.contacts = e.contacts.filter(c => {
        const k = m.manufacture_id + '|' + c.name.toLowerCase() + '|' + c.your_location;
        if (seen.has(k)) return false; seen.add(k); return true;
      });
    }
    return [...byMfg.values()].sort((a, b) => a.company_name.localeCompare(b.company_name));
  }

  // GET /api/supplier/me/manufacturers — every manufacturer matched to this supplier, by status.
  app.get('/api/supplier/me/manufacturers', withSupplier, async (req, res) => {
    try {
      const list = await loadManufacturers(String(req.supplier.id));
      const counts = { pending: 0, active: 0, waiting: 0, declined: 0, mfg_declined: 0 };
      list.forEach(m => { counts[m.status] = (counts[m.status] || 0) + 1; });
      res.json({ ok: true, manufacturers: list, counts });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // POST /api/supplier/me/manufacturers/:id/decision {accept: true|false}
  // Writes this supplier's answer onto the junction row. :id must be one of this supplier's rows.
  app.post('/api/supplier/me/manufacturers/:id/decision', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const rows = await matchRows(sid);
      if (!(rows || []).some(r => String(r.ID) === String(req.params.id))) {
        return res.status(404).json({ ok: false, error: 'not found for this supplier' });
      }
      const accept = !!(req.body && req.body.accept);
      const r = await patchRecord(MATCH_REPORT, req.params.id, {
        Supplier_Accept_Quotes_From_Manufacture: accept ? ACCEPT_YES : ACCEPT_NO,
        Supplier_New_Entry: false,
      });
      bust('mfg-matches:' + sid);
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Could not save your answer.', message: r.message });
      res.json({ ok: true });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // ---- Supplier edits its side of the rep assignments ----
  // The manufacturer's side (their location + reps) is read-only here; the supplier picks which of
  // its own locations and reps pair with it. Writes go to the same Manufacture_Supplier_Representative_
  // Matching rows the Zoho form edits, so both sides stay in step.
  const REP_MATCH_FORM = process.env.SUPPLIER_REP_MATCH_FORM || 'Manufacture_Supplier_Representative_Matching';

  // Checks a {location_id, rep_ids} choice against this supplier's own locations and reps.
  // Reps are stored per location (the same person can have a record at each), so every rep must
  // belong to the chosen location, or have no location at all.
  async function checkMySide(sid, body) {
    const location_id = String((body && body.location_id) || '');
    const rep_ids = [...new Set(arr(body && body.rep_ids).map(String))];
    if (!location_id) return { error: 'Pick one of your locations.' };
    if (!rep_ids.length) return { error: 'Pick at least one of your reps.' };
    const [locs, reps] = await Promise.all([
      fetchAllZohoPages('/report/' + LOC_REPORT + '?criteria=(Supplier_Entry_Form==' + encodeURIComponent(sid) + ')'),
      fetchAllZohoPages('/report/' + REP_REPORT + '?criteria=(Supplier_Entry_Form==' + encodeURIComponent(sid) + ')'),
    ]);
    if (!(locs || []).some(l => String(l.ID) === location_id)) return { error: 'That location is not one of yours.' };
    const repLoc = new Map((reps || []).map(r => [String(r.ID), r.Supplier_Locations && r.Supplier_Locations.ID ? String(r.Supplier_Locations.ID) : '']));
    const bad = rep_ids.filter(id => !repLoc.has(id) || (repLoc.get(id) && repLoc.get(id) !== location_id));
    if (bad.length) return { error: 'Some of the reps picked do not work at that location.' };
    return { location_id, rep_ids };
  }

  // A manufacturer's locations + active reps, so a supplier can pick who they work with while the
  // manufacturer hasn't set anything up (Mark, 2026-11-04: supplier matches rep to rep while
  // waiting on the MFG to accept). Both reports are unfiltered. A rep's location comes from its
  // Location column when the report carries it; without it every rep is offered at every location.
  const theirTeam = mfgId => cachedLookup('mfg-team:' + mfgId, 10 * 60 * 1000, async () => {
    const [locs, reps] = await Promise.all([
      fetchAllZohoPages('/report/All_Company_Locations?criteria=(Manaufacture==' + encodeURIComponent(mfgId) + ')').catch(() => []),
      fetchAllZohoPages('/report/All_Company_Representatives?criteria=(Manufacture==' + encodeURIComponent(mfgId) + ')').catch(() => []),
    ]);
    return {
      locations: (locs || []).map(l => ({ id: String(l.ID), name: locName(l.Location_Name || l), city: [l.Address && l.Address.district_city, l.Address && l.Address.state_province].filter(Boolean).join(', ') })),
      reps: (reps || []).filter(r => String(r.ACTIVE || 'YES').toUpperCase() !== 'NO').map(r => ({
        id: String(r.ID), name: cleanName(r.Name), position: r.Position || '', email: r.Email || '',
        // Location is a multi-select (a rep can cover several locations); [] = not set → offered everywhere.
        phone: r.Direct_Phone_Number || '',
        location_ids: (Array.isArray(r.Location) ? r.Location : r.Location ? [r.Location] : []).map(x => String(x.ID || '')).filter(Boolean),
      })),
    };
  });
  async function checkTheirSide(mfgId, body) {
    const their_location_id = String((body && body.their_location_id) || '');
    const their_rep_ids = [...new Set(arr(body && body.their_rep_ids).map(String))];
    if (!their_location_id) return { error: 'Pick one of their locations.' };
    if (!their_rep_ids.length) return { error: 'Pick at least one of their reps.' };
    const team = await theirTeam(mfgId);
    if (!team.locations.some(l => l.id === their_location_id)) return { error: 'That location is not one of theirs.' };
    const bad = their_rep_ids.filter(id => { const r = team.reps.find(x => x.id === id); return !r || (r.location_ids.length && !r.location_ids.includes(their_location_id)); });
    if (bad.length) return { error: 'Some of their reps picked do not work at that location.' };
    return { their_location_id, their_rep_ids };
  }
  // The manufacturer's login emails — the match form copies them so the MFG's portal shows the row.
  const mfgLoginEmails = async mfgId => {
    const all = await cachedLookup('mfg-directory-all', 10 * 60 * 1000, () => fetchAllZohoPages('/report/Customer_Entry_Report'));
    const m = (all || []).find(x => String(x.ID) === String(mfgId));
    return (m && m.Account_User_Email) || '';
  };

  // Another row for the same manufacturer already pairs these two locations → edit that one instead.
  function duplicatePair(rows, src, location_id, their_location_id, exceptId) {
    const key = repRowMfgKey(src);
    return (rows || []).find(r => String(r.ID) !== String(exceptId) && repRowMfgKey(r) === key
      && r.Supplier_Locations && String(r.Supplier_Locations.ID) === location_id
      && r.Company_Locations && String(r.Company_Locations.ID) === their_location_id);
  }

  // GET /api/supplier/me/manufacturers/:id/team — :id = this supplier's match row. The
  // manufacturer's locations and reps, for picking who to pair with.
  app.get('/api/supplier/me/manufacturers/:id/team', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const row = (await matchRows(sid) || []).find(r => String(r.ID) === String(req.params.id));
      if (!row || !(row.MANUFACTURE && row.MANUFACTURE.ID)) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
      res.json({ ok: true, ...(await theirTeam(String(row.MANUFACTURE.ID))) });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // POST /api/supplier/me/rep-matches/pair {match_id, their_location_id, their_rep_ids[], location_id, rep_ids[]}
  // The supplier sets up a contact pairing themselves — their location/reps ↔ ours — with no
  // manufacturer-made row to copy from. Allowed before the manufacturer accepts.
  app.post('/api/supplier/me/rep-matches/pair', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const b = req.body || {};
      const match = (await matchRows(sid) || []).find(r => String(r.ID) === String(b.match_id));
      if (!match || !(match.MANUFACTURE && match.MANUFACTURE.ID)) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
      const mfgId = String(match.MANUFACTURE.ID);
      const [mine, theirs] = await Promise.all([checkMySide(sid, b), checkTheirSide(mfgId, b)]);
      if (mine.error || theirs.error) return res.status(400).json({ ok: false, error: mine.error || theirs.error });
      const rows = await repMatchRows(sid);
      const dupe = (rows || []).find(r => repRowMfgKey(r) === 'm:' + mfgId
        && r.Supplier_Locations && String(r.Supplier_Locations.ID) === mine.location_id
        && r.Company_Locations && String(r.Company_Locations.ID) === theirs.their_location_id);
      if (dupe) return res.status(409).json({ ok: false, error: 'You already paired that location of yours with that location of theirs. Edit that one instead.' });
      const r = await addRecord(REP_MATCH_FORM, {
        Supplier_Entry_Form: sid, Manufacture: mfgId,
        Supplier_Locations: mine.location_id, Supplier_Reps_Allocated_For_Manufacture: mine.rep_ids,
        Company_Locations: theirs.their_location_id, Manufacture_Reps_Allocated_For_Supplier: theirs.their_rep_ids,
        Manufacture_Location_ID: theirs.their_location_id, Supplier_Manufacture_Match_ID: String(match.ID),
        Manufacture_Rep_Account_User_Email: await mfgLoginEmails(mfgId),
      });
      bust('mfg-rep-matches:' + sid);
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Could not save the contacts.', message: r.message });
      res.json({ ok: true, id: r.id });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // PATCH /api/supplier/me/rep-matches/:id {location_id, rep_ids[], their_location_id?, their_rep_ids?}
  // Their side changes only when sent (the supplier may now pick the manufacturer's people too).
  app.patch('/api/supplier/me/rep-matches/:id', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const rows = await repMatchRows(sid);
      const row = (rows || []).find(r => String(r.ID) === String(req.params.id));
      if (!row) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
      const mine = await checkMySide(sid, req.body);
      if (mine.error) return res.status(400).json({ ok: false, error: mine.error });
      let theirLoc = row.Company_Locations && row.Company_Locations.ID ? String(row.Company_Locations.ID) : '';
      const data = { Supplier_Locations: mine.location_id, Supplier_Reps_Allocated_For_Manufacture: mine.rep_ids };
      if (req.body && req.body.their_location_id && row.Manufacture && row.Manufacture.ID) {
        const theirs = await checkTheirSide(String(row.Manufacture.ID), req.body);
        if (theirs.error) return res.status(400).json({ ok: false, error: theirs.error });
        theirLoc = theirs.their_location_id;
        Object.assign(data, { Company_Locations: theirLoc, Manufacture_Location_ID: theirLoc, Manufacture_Reps_Allocated_For_Supplier: theirs.their_rep_ids });
      }
      if (duplicatePair(rows, row, mine.location_id, theirLoc, row.ID)) {
        return res.status(409).json({ ok: false, error: 'You already have contacts set for that location with this manufacturer. Edit that one instead.' });
      }
      const r = await patchRecord(REP_MATCH_REPORT, row.ID, data);
      bust('mfg-rep-matches:' + sid);
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Could not save your contacts.', message: r.message });
      res.json({ ok: true });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // POST /api/supplier/me/rep-matches {from_id, location_id, rep_ids[]}
  // Adds another of the supplier's locations to a manufacturer, pairing it with the same MFG location
  // and reps as the existing row from_id (the supplier can't pick the manufacturer's people).
  app.post('/api/supplier/me/rep-matches', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const rows = await repMatchRows(sid);
      const src = (rows || []).find(r => String(r.ID) === String(req.body && req.body.from_id));
      if (!src) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
      const mine = await checkMySide(sid, req.body);
      if (mine.error) return res.status(400).json({ ok: false, error: mine.error });
      const theirLoc = src.Company_Locations && src.Company_Locations.ID ? String(src.Company_Locations.ID) : '';
      if (duplicatePair(rows, src, mine.location_id, theirLoc, null)) {
        return res.status(409).json({ ok: false, error: 'You already have contacts set for that location with this manufacturer. Edit that one instead.' });
      }
      const data = {
        Supplier_Entry_Form: sid,
        Supplier_Locations: mine.location_id,
        Supplier_Reps_Allocated_For_Manufacture: mine.rep_ids,
        Company_Locations: theirLoc,
        Manufacture_Reps_Allocated_For_Supplier: arr(src.Manufacture_Reps_Allocated_For_Supplier).map(x => String(x.ID)).filter(Boolean),
        Supplier_Manufacture_Match_ID: src.Supplier_Manufacture_Match_ID || '',
        Manufacture_Location_ID: src.Manufacture_Location_ID || theirLoc,
        Manufacture_Rep_Account_User_Email: src.Manufacture_Rep_Account_User_Email || '',
      };
      if (src.Manufacture && src.Manufacture.ID) data.Manufacture = String(src.Manufacture.ID);
      const r = await addRecord(REP_MATCH_FORM, data);
      bust('mfg-rep-matches:' + sid);
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Could not add the location.', message: r.message });
      res.json({ ok: true, id: r.id });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // DELETE /api/supplier/me/rep-matches/:id — drop one of the supplier's locations from a manufacturer.
  // The last row for a manufacturer can't go: it's the only record of who their contacts are.
  app.delete('/api/supplier/me/rep-matches/:id', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const rows = await repMatchRows(sid);
      const row = (rows || []).find(r => String(r.ID) === String(req.params.id));
      if (!row) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
      const key = repRowMfgKey(row);
      if ((rows || []).filter(r => repRowMfgKey(r) === key).length < 2) {
        return res.status(400).json({ ok: false, error: 'This is your only location set up with this manufacturer. Change it instead of removing it.' });
      }
      const r = await deleteRecord(REP_MATCH_REPORT, row.ID);
      bust('mfg-rep-matches:' + sid);
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Could not remove the location.', message: r.message });
      res.json({ ok: true });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // Dashboard — the supplier's home. v1 returns fitting matches (live). Structural
  // matches + quote statuses get added here next (Phase 1 continued) so the UI has
  // one call for its home screen.
  app.get('/api/supplier/me/dashboard', withSupplier, async (req, res) => {
    try {
      const [fittings, structural] = await Promise.all([
        matchFittingsForSupplier(req.supplier.id, deps),
        matchStructuralForSupplier(req.supplier.id, deps),
      ]);
      // Resolve every matched project once (cached) for the open-RFQ gate + display.
      const pmap = await getProjectInfo([...fittings.matches, ...structural.matches].map(m => m.project_id));
      const withProj = arr => arr.map(m => ({ ...m, project: pmap[m.project_id] || null }));

      // OPEN-RFQ GATE: only show matches whose project is actively being quoted.
      // Allowlist (not blocklist) so future/blank statuses default to hidden — never
      // leak an awarded/lost project to a supplier. Confirmed set 2026-06-18.
      const fAll = withProj(fittings.matches);
      const sAll = withProj(structural.matches);
      const openFittings = fAll.filter(m => m.project && OPEN_PROJECT_STATUSES.has(m.project.status));
      const openStructural = sAll.filter(m => m.project && OPEN_PROJECT_STATUSES.has(m.project.status));

      res.json({
        ok: true,
        supplier: req.supplier,
        matches: {
          fittings: openFittings,
          structural: openStructural,
        },
        counts: {
          fitting_matches: openFittings.length,
          fitting_matches_closed_hidden: fAll.length - openFittings.length,
          fitting_stock: fittings.stock_count,
          structural_matches: openStructural.length,
          structural_matches_closed_hidden: sAll.length - openStructural.length,
          structural_stock: structural.stock_count,
        },
        quote_statuses: [], // TODO Phase 1: read this supplier's quotes
      });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

module.exports = { registerSupplierRoutes };
