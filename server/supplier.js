// ── Supplier platform (off-Zoho strangler) ────────────────────────────────
// v1: suppliers still log into the Zoho portal; the new UI is embedded there and
// passes the logged-in email to Railway. Zoho remains the data store; Railway is
// the API. The ONE place that turns an identity into "which supplier" is
// resolveSupplier() below — every supplier route goes through the withSupplier
// middleware. When auth later moves to Supabase, only resolveSupplier/withSupplier
// change; no route or screen does.

const { matchFittingsForSupplier } = require('./fittingMatch');
const { matchStructuralForSupplier } = require('./structuralMatch');
const { fetchCatalogs, computeAlteredLine, LineCalcError } = require('./lineCalc');

const SUPPLIER_REPORT = 'Supplier_Entry_Report';

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
// Account_User_Email is a multi-email field (admin + reps), so we match by
// "contains", case-insensitive. Supplier_Entry's ID is the value stock rows store
// in Supplier_ID — so this id flows straight into the fitting matcher.
function emailMatches(accountUserEmail, email) {
  if (!accountUserEmail || !email) return false;
  return String(accountUserEmail).toLowerCase().includes(String(email).toLowerCase());
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
  async function resolveSupplier(email) {
    if (!email) return null;
    const rows = await cachedLookup('supplier-directory', 5 * 60 * 1000, async () => {
      return fetchAllZohoPages('/report/' + SUPPLIER_REPORT);
    });
    const rec = rows.find(r => emailMatches(r.Account_User_Email, email));
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
          hint: email ? 'Email "' + email + '" is not in any Supplier_Entry Account_User_Email.' : 'No email supplied (?email= or X-Supplier-Email header).',
        });
      }
      req.supplier = supplier;
      next();
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  }

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

  async function fetchSentRfqs(supplierId) {
    // Cache per supplier (3 min) so a supplier refreshing the Quotes tab doesn't re-hit Zoho.
    // Scope to Latest_Item_for_Supplier==true — the report holds every superseded revision's
    // rows too (~1800 for an active supplier), and we only ever show the current version of
    // each line. This cuts the fetch from ~10 pages to ~1-2, saving Developer-API calls.
    const crit = encodeURIComponent('(Supplier_LU==' + supplierId + ' && Latest_Item_for_Supplier==true)');
    const [rows, catalogs] = await Promise.all([
      cachedLookup('sent-rfqs:' + supplierId, 3 * 60 * 1000, async () =>
        fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=' + crit)),
      // Cached 1h inside lineCalc — ~6 API calls/hour total, shared across suppliers.
      fetchCatalogs({ fetchAllZohoPages, cachedLookup }),
    ]);
    const byQuote = new Map();
    for (const r of rows) {
      // Skip RFQ lines from superseded MFG quote revisions (the revision workflow
      // flags them MFG_Revision_Cancel_Entry=true) so the supplier only sees current ones.
      if (r.MFG_Revision_Cancel_Entry === true || r.MFG_Revision_Cancel_Entry === 'true') continue;
      const qid = lkid(r.Quote_LU) || lkid(r.Quote_LU_ID) || ('q' + (r.Quote_Number || ''));
      if (!byQuote.has(qid)) {
        byQuote.set(qid, {
          quote_id: qid,
          quote_number: r.Quote_Reference_Number || r.Quote_Number || '',
          internal_quote_number: r.Quote_Number || '',
          quote_description: r.Quote_Description || '',
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
  // Prefer the _Text mirror: it's populated where the lookup isn't (8/9 vs 5/9 live).
  // "Redo Selection" is the cascade's reset sentinel, not a size — never show it.
  async function fetchFittingSizes() {
    return cachedLookup('fitting-sizes', 30 * 60 * 1000, async () => {
      const map = {};
      try {
        const rows = await fetchAllZohoPages('/report/Fittings_Quote_Subform_Report');
        for (const r of rows) {
          const txt = String(r.Fitting_Description_Text || '').trim();
          const lk = flatten(r.Fitting_Description).trim();
          const size = (txt && txt !== 'Redo Selection') ? txt : ((lk && lk !== 'Redo Selection') ? lk : '');
          if (size) map[String(r.ID)] = size;
        }
      } catch (e) {
        // Best-effort: a size outage must not blank the whole fittings list.
        console.error('Fitting sizes fetch failed:', (e.response && e.response.data) || e.message);
      }
      return map;
    });
  }

  async function fetchSentFittingRfqs(supplierId) {
    // fetchAllZohoPages returns [] on an empty criteria result (Zoho 9280), so no guard here.
    const [rows, sizeByDemandLine] = await Promise.all([
      cachedLookup('fit-rfqs:' + supplierId, 60 * 1000, async () =>
        fetchAllZohoPages('/report/' + FIT_RFQ_REPORT + '?criteria=(Supplier_LU==' + encodeURIComponent(supplierId) + ')')),
      fetchFittingSizes(),
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
          manufacturer: r['Customer_LU.Company_Name'] || r.Customer_Name || '',
          quote_date: r.Quote_Date || r.Quote_Timestamp || '',
          status: r.RFQ_Fitting_Sent_Status || '',
          lines: [],
        });
      }
      const type = flatten(r.Fitting_Type), make = flatten(r.Fitting_Make);
      const end = flatten(r.End_Type), conn = flatten(r.Connection_Type), spec = flatten(r.Fitting_Specification);
      const demandLineId = lkid(r.Fittings_Quote_Subform);
      // Size comes from the demand line (see fetchFittingSizes). Fall back to the bridge's
      // Dim1/Dim2 in case they're ever populated, but the demand line is the source of truth.
      const size = sizeByDemandLine[demandLineId]
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
  app.get('/api/supplier/me/sent-fitting-rfqs', withSupplier, async (req, res) => {
    try {
      const quotes = await fetchSentFittingRfqs(req.supplier.id);
      const lineCount = quotes.reduce((n, q) => n + q.lines.length, 0);
      const respondedCount = quotes.reduce((n, q) => n + q.lines.filter(l => l.quote_option).length, 0);
      res.json({ ok: true, supplier: req.supplier, quote_count: quotes.length, line_count: lineCount, responded_count: respondedCount, quotes });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // POST /api/supplier/me/sent-fitting-rfqs/submit — price fitting RFQ lines. Writes the
  // response directly onto each RFQs_Sent_Fittings bridge row (the "bridge = response"
  // model, no Supplier_Alter_Form). Per-each pricing: total = unit × qty (server is
  // authoritative on qty, read from the bridge row). Ownership is verified against the
  // supplier's own cached bridge rows before any write.
  app.post('/api/supplier/me/sent-fitting-rfqs/submit', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const lines = (req.body && req.body.lines) || [];
      if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ ok: false, error: 'no lines to submit' });

      // Index the supplier's own bridge rows for ownership + qty (no extra API call).
      const quotes = await fetchSentFittingRfqs(sid);
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
        const data = {
          Item_Verification_Status: opt,
          Unit_Price: unit,
          Total_Price: total,
          Supplier_Lead_Time: l.lead_time || '',
          Supplier_Comments: l.comments || '',
          Responded_Timestamp: zohoNow(),
        };
        const r = await patchRecord(FIT_RFQ_REPORT, id, data);
        results.push({ rfq_row_id: id, ok: r.ok, code: r.code, message: r.ok ? undefined : r.message, unit_price: unit, total_price: total });
      }
      bust('fit-rfqs:' + sid);
      const saved = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok);
      res.json({ ok: failed.length === 0, saved, failed: failed.length, results });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // Supplier-level dropdown data for the quote-submit form (locations, reps, choices).
  async function fetchSupplierLookups(supplierId) {
    // Locations/reps change rarely — cache 10 min to spare the API budget.
    return cachedLookup('supplier-lookups:' + supplierId, 10 * 60 * 1000, async () => {
      const [loc, rep] = await Promise.all([
        fetchAllZohoPages('/report/All_Supplier_Locations?criteria=(Supplier_Entry_Form==' + encodeURIComponent(supplierId) + ')'),
        fetchAllZohoPages('/report/All_Supplier_Representatives?criteria=(Supplier_Entry_Form==' + encodeURIComponent(supplierId) + ')'),
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
  app.get('/api/supplier/me/rfqs', withSupplier, async (req, res) => {
    try {
      const [sent, lookups] = await Promise.all([
        fetchSentRfqs(req.supplier.id),
        fetchSupplierLookups(req.supplier.id),
      ]);
      const { quotes, alteration_catalog } = sent;
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
  });

  // GET /api/supplier/me/quote-file — stream a manufacturer reference file (Quote_Form.File_upload)
  // from Zoho using the server's token, so the supplier can download it without Zoho auth.
  app.get('/api/supplier/me/quote-file', withSupplier, async (req, res) => {
    try {
      const record = String(req.query.record || '').replace(/[^0-9]/g, '');
      const filepath = String(req.query.filepath || '');
      if (!record || !filepath) return res.status(400).send('record and filepath required');
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
  });

  // Load this supplier's RFQ rows raw + the catalogs, for the alteration paths. The rows
  // are the authority: an alteration is always applied to the SERVER's copy of the line,
  // never to client-sent geometry.
  async function loadAlterationContext(supplierId) {
    const [rawRows, catalogs] = await Promise.all([
      cachedLookup('sent-rfqs-raw:' + supplierId, 30 * 1000, async () =>
        fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=(Supplier_LU==' + encodeURIComponent(supplierId) + ')')),
      fetchCatalogs({ fetchAllZohoPages, cachedLookup }),
    ]);
    return { rowById: new Map(rawRows.map(r => [String(r.ID), r])), catalogs };
  }

  // Turn a LineCalcError into a 422 the UI can show verbatim. Anything else is a real fault.
  function alterationError(res, e) {
    if (e instanceof LineCalcError) return res.status(422).json({ ok: false, error: e.message, code: e.code });
    throw e;
  }

  // POST /api/supplier/me/line-preview — recompute ONE altered line without writing.
  // The revise UI calls this as the supplier edits, so the description/weight it shows
  // come from the same code that will run at submit. The client never does this math.
  app.post('/api/supplier/me/line-preview', withSupplier, async (req, res) => {
    try {
      const { rfqs_sent_id, length_ft, length_inch, quantity, spec_id } = req.body || {};
      if (!rfqs_sent_id) return res.status(400).json({ ok: false, error: 'rfqs_sent_id required' });
      const { rowById, catalogs } = await loadAlterationContext(String(req.supplier.id));
      const row = rowById.get(String(rfqs_sent_id));
      // Scoped to THIS supplier's rows, so an unknown id is either stale or not theirs.
      if (!row) return res.status(404).json({ ok: false, error: 'Line not found for this supplier' });
      try {
        const out = computeAlteredLine(row, { length_ft, length_inch, quantity, spec_id }, catalogs);
        res.json({ ok: true, preview: out });
      } catch (e) { return alterationError(res, e); }
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // POST /api/supplier/me/quote-submit — submit a priced quote (off-Zoho path).
  // Creates ONE Supplier_Verify_Form record with its Supplier_Verify_Detail rows passed
  // as a nested subform array — the exact mechanism the native "Submit Quote" widget uses
  // (a standalone Deluge function can't build that subform; the addRecord API can). The
  // SV form's own "Successful form submission" workflow then fires and does the RFQs_Sent
  // write-back, the MFG email, and the dashboard status — same path as a human submit.
  app.post('/api/supplier/me/quote-submit', withSupplier, async (req, res) => {
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
      const { rowById, catalogs } = await loadAlterationContext(supplierId);
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
      const grandTotal = sumMaterial + shipAmt + miscAmt;  // material + shipping + misc
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
        Shipping_Amount: header.shipping != null ? String(header.shipping) : '0',
        Miscellaneous_Charges: header.misc != null ? String(header.misc) : '0',
        Supplier_Notes_To_Buyer: header.notes || '',
        // header rollups — set explicitly (workflow computes but doesn't store on API-add)
        Total_Material_Amount_Currency: round(sumMaterial, 2),
        Response_Total_Material_Price: round(sumMaterial, 2),
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
        return res.status(502).json({ ok: false, error: 'addRecord rejected', code, message: addResp.data && addResp.data.message, detail: addResp.data });
      }
      const svFormId = (addResp.data.data && addResp.data.data.ID) || '';

      // Supersede prior active quotes for this supplier+MFG-quote → "Revised".
      let superseded = 0;
      for (const pid of priorSvIds) {
        try {
          await axios.patch(creatorApiBase() + '/report/All_Supplier_Verify_Form_Report/' + pid, { data: { SV_Status: 'Revised' } }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
          superseded++;
        } catch (e) { /* non-fatal */ }
      }

      res.json({
        ok: true,
        sv_form_id: svFormId,
        lines: detailRows.length,
        skipped: missing,
        altered: alteredCount,
        revised_prior: superseded,
        message: 'Quote submitted (SV record ' + svFormId + ', ' + detailRows.length + ' lines'
          + (alteredCount ? ', ' + alteredCount + ' altered' : '')
          + (superseded ? ', superseded ' + superseded + ' prior' : '') + '). The SV workflow handles email + write-back.',
      });
    } catch (err) {
      if (sendZohoAwareError) return sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });

  // GET /api/supplier/me/profile — company profile + locations + reps for the Profile tab.
  app.get('/api/supplier/me/profile', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const [supRows, locs, reps] = await Promise.all([
        cachedLookup('supplier-directory', 5 * 60 * 1000, async () => fetchAllZohoPages('/report/' + SUPPLIER_REPORT)),
        fetchAllZohoPages('/report/All_Supplier_Locations?criteria=(Supplier_Entry_Form==' + encodeURIComponent(sid) + ')'),
        fetchAllZohoPages('/report/All_Supplier_Representatives?criteria=(Supplier_Entry_Form==' + encodeURIComponent(sid) + ')'),
      ]);
      const rec = supRows.find(r => String(r.ID) === sid) || {};
      const nm = rec.Main_Contact_Name || {};
      const addr = a => (a && typeof a === 'object') ? a : {};
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
      if (b.phone != null) data.Phone_Number = b.phone;
      if (b.fax != null) data.Fax = b.fax;
      if (b.website != null) data.Company_Website = b.website;
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
      Supplier_Entry_Form: req.supplier.id, Name_of_Location: b.name || '', Phone_Number: b.phone || '', Address: addrObj(b), Timestamp: zohoNow(),
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: 'add failed', message: r.message });
    res.json({ ok: true, id: r.id });
  });
  app.patch('/api/supplier/me/locations/:id', withSupplier, async (req, res) => {
    if (!(await supplierOwns('All_Supplier_Locations', req.supplier.id, req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
    const b = req.body || {}; const data = {};
    if (b.name != null) data.Name_of_Location = b.name;
    if (b.phone != null) data.Phone_Number = b.phone;
    if (b.street != null || b.city != null || b.state != null || b.zip != null || b.country != null) data.Address = addrObj(b);
    const r = await patchRecord('All_Supplier_Locations', req.params.id, data);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'update failed', message: r.message });
    res.json({ ok: true });
  });
  app.delete('/api/supplier/me/locations/:id', withSupplier, async (req, res) => {
    if (!(await supplierOwns('All_Supplier_Locations', req.supplier.id, req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
    const r = await deleteRecord('All_Supplier_Locations', req.params.id);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'delete failed', message: r.message });
    res.json({ ok: true });
  });

  // Representatives
  app.post('/api/supplier/me/reps', withSupplier, async (req, res) => {
    const b = req.body || {};
    const data = {
      Supplier_Entry_Form: req.supplier.id, Supplier_Company_Name: req.supplier.company_name || '',
      Name: { first_name: b.first || '', last_name: b.last || '' },
      Position: b.position || '', Email: b.email || '', Phone_Number: b.phone || '', Extension: b.ext || '', Timestamp: zohoNow(),
    };
    if (b.location_id) data.Supplier_Locations = b.location_id;
    const r = await addRecord('Supplier_Representatives', data);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'add failed', message: r.message });
    res.json({ ok: true, id: r.id });
  });
  app.patch('/api/supplier/me/reps/:id', withSupplier, async (req, res) => {
    if (!(await supplierOwns('All_Supplier_Representatives', req.supplier.id, req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
    const b = req.body || {}; const data = {};
    if (b.first != null || b.last != null) data.Name = { first_name: b.first || '', last_name: b.last || '' };
    if (b.position != null) data.Position = b.position;
    if (b.email != null) data.Email = b.email;
    if (b.phone != null) data.Phone_Number = b.phone;
    if (b.ext != null) data.Extension = b.ext;
    if (b.location_id != null) data.Supplier_Locations = b.location_id;
    const r = await patchRecord('All_Supplier_Representatives', req.params.id, data);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'update failed', message: r.message });
    res.json({ ok: true });
  });
  app.delete('/api/supplier/me/reps/:id', withSupplier, async (req, res) => {
    if (!(await supplierOwns('All_Supplier_Representatives', req.supplier.id, req.params.id))) return res.status(404).json({ ok: false, error: 'not found for this supplier' });
    const r = await deleteRecord('All_Supplier_Representatives', req.params.id);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'delete failed', message: r.message });
    res.json({ ok: true });
  });

  // ---- Stock (Structural + Fittings) ----
  const STRUCT_REPORT = 'Stocked_Material_List';
  const FIT_STOCK_REPORT = process.env.FITTING_STOCK_REPORT || 'Supplier_Fitting_Stock_All';
  const isStocked = v => Array.isArray(v) ? v.includes('Stocked') : (v === 'Stocked' || v === true || v === 'true');
  const structStock = sid => cachedLookup('struct-stock:' + sid, 60 * 1000, () =>
    fetchAllZohoPages('/report/' + STRUCT_REPORT + '?criteria=(Supplier_ID==' + encodeURIComponent(sid) + ')'));
  const fitStock = sid => cachedLookup('fit-stock-all:' + sid, 60 * 1000, () =>
    fetchAllZohoPages('/report/' + FIT_STOCK_REPORT + '?criteria=(Supplier_ID==' + encodeURIComponent(sid) + ')'));

  // GET /api/supplier/me/stock — structural + fittings stock lists for the Stock tab.
  app.get('/api/supplier/me/stock', withSupplier, async (req, res) => {
    try {
      const sid = String(req.supplier.id);
      const [struct, fit] = await Promise.all([structStock(sid), fitStock(sid)]);
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
      bust('struct-stock:' + sid);
      res.json({ ok: true });
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
