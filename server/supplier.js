// ── Supplier platform (off-Zoho strangler) ────────────────────────────────
// v1: suppliers still log into the Zoho portal; the new UI is embedded there and
// passes the logged-in email to Railway. Zoho remains the data store; Railway is
// the API. The ONE place that turns an identity into "which supplier" is
// resolveSupplier() below — every supplier route goes through the withSupplier
// middleware. When auth later moves to Supabase, only resolveSupplier/withSupplier
// change; no route or screen does.

const { matchFittingsForSupplier } = require('./fittingMatch');

const SUPPLIER_REPORT = 'Supplier_Entry_Report';

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

// Zoho date fields want the form's display format (MMM dd,yyyy, e.g. "Jul 30,2026").
// The browser date input sends ISO "2026-07-30"; convert, or pass through if unexpected.
function toZohoDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (months[parseInt(m[2], 10) - 1] || m[2]) + ' ' + m[3] + ',' + m[1];
}

function registerSupplierRoutes(app, deps) {
  const { fetchAllZohoPages, cachedLookup, sendZohoAwareError, getAccessToken, creatorApiBase, zohoHeaders, axios } = deps;

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
  async function fetchSentRfqs(supplierId) {
    // Cache per supplier (60s) so a supplier refreshing the Quotes tab doesn't
    // re-hit Zoho each time — keeps Developer-API usage low.
    const rows = await cachedLookup('sent-rfqs:' + supplierId, 60 * 1000, async () =>
      fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=(Supplier_LU==' + encodeURIComponent(supplierId) + ')'));
    const byQuote = new Map();
    for (const r of rows) {
      const qid = lkid(r.Quote_LU) || lkid(r.Quote_LU_ID) || ('q' + (r.Quote_Number || ''));
      if (!byQuote.has(qid)) {
        byQuote.set(qid, {
          quote_id: qid,
          quote_number: r.Quote_Number || '',
          quote_description: r.Quote_Description || '',
          manufacturer: r['Customer_LU.Company_Name'] || flatten(r.Manufacturer) || '',
          status: r['Quote_LU.Status'] || '',
          quote_date: r.Quote_Date || r.RFQSent_Timestamp || '',
          lines: [],
        });
      }
      byQuote.get(qid).lines.push({
        rfqs_sent_id: String(r.ID),
        sv_detail_id: lkid(r.Supplier_Verify_Detail),
        sv_form_id: lkid(r.Supplier_Verify_Form),
        line: r.Line_Item || '',
        description: r.Full_Item_Description || r.Description_And_Dimension_Text || '',
        qty: r.Quantity != null ? Number(r.Quantity) : null,
        unit_weight: r.Unit_Weight != null ? Number(r.Unit_Weight) : null,
        item_requirements: Array.isArray(r.Item_Requirements) ? r.Item_Requirements : [],
        price_per_lb: r.Price_Per_Lb != null && r.Price_Per_Lb !== '' ? Number(r.Price_Per_Lb) : null,
        unit_price: r.Unit_Price != null && r.Unit_Price !== '' ? Number(r.Unit_Price) : null,
        total_price: r.Total_Price != null && r.Total_Price !== '' ? Number(r.Total_Price) : null,
        line_status: r.RFQ_Sent_Status || '',
        quote_option: r.Item_Verification_Status || '',
      });
    }
    const out = [...byQuote.values()];
    out.forEach(q => q.lines.sort((a, b) => (Number(a.line) || 0) - (Number(b.line) || 0)));
    return out;
  }

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
        quote_requirements: ['MTRs Required', 'AIS - Made & Melted in USA'],
      };
    });
  }

  // GET /api/supplier/me/rfqs — the supplier's sent RFQs grouped into quotes + tiles.
  app.get('/api/supplier/me/rfqs', withSupplier, async (req, res) => {
    try {
      const [quotes, lookups] = await Promise.all([
        fetchSentRfqs(req.supplier.id),
        fetchSupplierLookups(req.supplier.id),
      ]);
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
      res.json({ ok: true, supplier: req.supplier, tiles, quote_count: quotes.length, quotes, lookups });
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
      const rawRows = await cachedLookup('sent-rfqs-raw:' + supplierId, 30 * 1000, async () =>
        fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=(Supplier_LU==' + encodeURIComponent(supplierId) + ')'));
      const rowById = new Map(rawRows.map(r => [String(r.ID), r]));

      // money/format helpers for the PDF snapshot strings the reference doc reads
      const money = n => '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
      const num = (n, d = 2) => (Math.round((Number(n) || 0) * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);

      // derive manufacturer from any row (Customer_LU = the MFG on RFQs_Sent)
      const firstRow = rowById.get(String(lines[0] && lines[0].rfqs_sent_id)) || rawRows[0];
      const mfgId = firstRow ? lkid(firstRow.Customer_LU) : '';

      const detailRows = [];
      let missing = 0;
      for (const l of lines) {
        const r = rowById.get(String(l.rfqs_sent_id));
        if (!r) { missing++; continue; }
        const noQuote = l.quote_option === 'No Quote';
        const opt = l.quote_option || 'Quote As Is';
        const ppl = noQuote ? 0 : Number(l.price_per_lb) || 0;
        const up = noQuote ? 0 : Number(l.unit_price) || 0;
        const tp = noQuote ? 0 : Number(l.total_price) || 0;
        const cmt = l.comments || '';
        const desc = r.Description_And_Dimension_Text || r.Full_Item_Description || '';
        const itemReq = Array.isArray(r.Item_Requirements) ? r.Item_Requirements : [];
        const reqStr = itemReq.join(', ');
        const uw = Number(r.Unit_Weight) || 0;
        const tw = Number(r.CalcWeight) || 0;
        const leadTxt = l.lead_time || '';

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
          SVD_Material_Form_Detail: lkid(r.Material_Form_Detail),
          // descriptive + dimensional snapshot
          SVD_Material_Description: desc,
          Line_Item: r.Line_Item || '',
          Reference_Quote_Number: svQuoteNum,
          SVD_Quantity: r.Quantity != null ? r.Quantity : '',
          SVD_Total_Length: r.Total_Length != null ? r.Total_Length : '',
          SVD_Unit_Weight: uw,
          SVD_Calc_Weight: tw,
          Item_Requirements: itemReq,
          // pricing
          SVD_Item_Verification_Status: opt,
          SVD_Price_Per_Lb: ppl,
          SVD_Unit_Price: up,
          SVD_Total_Price: tp,
          SVD_Price_Per_Lb_Counter: (opt === 'Quote As Is' && tp > 0) ? 1 : 0,
          SVD_Supplier_Comments: cmt,
          // PDF snapshot fields (feed the reference document)
          PDF_Quote_Option: opt,
          PDF_Item_Description_and_Measurement: desc,
          PDF_Item_Description_and_Measurement_Multi_Line: reqStr ? (desc + '\n' + reqStr) : desc,
          PDF_Item_Requirements: itemReq,
          PDF_Quantity: r.Quantity != null ? r.Quantity : '',
          PDF_Unit_Weight: uw,
          PDF_Total_Weight: tw,
          PDF_Weight_Multi_Line: 'Unit WT ' + num(uw, 2) + '\nTotal WT ' + num(tw, 2),
          PDF_Price_Per_LB: ppl,
          PDF_Unit_Amount: up,
          PDF_Total_Amount: tp,
          PDF_Price_Multi_Line: noQuote ? 'No Quote' : ('Per Lb ' + money(ppl) + '\nUnit Price ' + money(up)),
          PDF_Lead_Time: leadTxt,
          PDF_Supplier_Comments: cmt,
        });
      }

      if (!detailRows.length) {
        return res.status(400).json({ ok: false, error: 'none of the submitted lines matched current RFQ rows', missing });
      }

      // header — supplier inputs + derived lookups. Totals/status/derived fields are
      // computed by the SV form workflow (as on a native submit), so we don't set them.
      const validDays = Number(header.valid_days) || 0;
      const data = {
        SV_Supplier_Entry_Form: supplierId,
        SV_Quote_Form: String(quote_id),
        MANUFACTURER: mfgId,
        Supplier_Locations: header.location ? String(header.location) : '',
        Supplier_Representatives: header.rep ? String(header.rep) : '',
        Auto_Number_or_Quote_Number_Selection: svQuoteNum.startsWith('AUTO-') ? 'Use Auto Number for Quote Number' : 'Input Internal Quote Number',
        REFERENCE_QUOTE_NUMBER: svQuoteNum,
        Supplier_Quote_Meets_MFG_Requirements: header.meets_requirements || '',
        Quote_Is_Valid_For: validDays ? (validDays + (validDays === 1 ? ' Day' : ' Days')) : '',
        Valid_Until_Date: toZohoDate(header.valid_until),
        SV_Radio_For_Submit: header.ready ? 'Ready for submission' : 'Not ready for submit',
        Shipping_Amount: header.shipping != null ? String(header.shipping) : '0',
        Miscellaneous_Charges: header.misc != null ? String(header.misc) : '0',
        Supplier_Notes_To_Buyer: header.notes || '',
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

      res.json({
        ok: true,
        sv_form_id: svFormId,
        lines: detailRows.length,
        skipped: missing,
        message: 'Quote submitted (SV record ' + svFormId + ', ' + detailRows.length + ' lines). The SV workflow handles email + write-back.',
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
      const fittings = await matchFittingsForSupplier(req.supplier.id, deps);
      const pmap = await getProjectInfo(fittings.matches.map(m => m.project_id));
      const withProject = fittings.matches.map(m => ({ ...m, project: pmap[m.project_id] || null }));

      // OPEN-RFQ GATE: only show matches whose project is actively being quoted.
      // Allowlist (not blocklist) so future/blank statuses default to hidden — never
      // leak an awarded/lost project to a supplier. Confirmed set 2026-06-18.
      const openFittings = withProject.filter(m => m.project && OPEN_PROJECT_STATUSES.has(m.project.status));

      res.json({
        ok: true,
        supplier: req.supplier,
        matches: {
          fittings: openFittings,
          structural: [], // TODO Phase 1: bridge from the existing Zoho structural matcher
        },
        counts: {
          fitting_matches: openFittings.length,
          fitting_matches_closed_hidden: withProject.length - openFittings.length,
          fitting_stock: fittings.stock_count,
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
