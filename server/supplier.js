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

function registerSupplierRoutes(app, deps) {
  const { fetchAllZohoPages, cachedLookup, sendZohoAwareError } = deps;

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
    const rows = await fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=(Supplier_LU==' + encodeURIComponent(supplierId) + ')');
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
    return [...byQuote.values()];
  }

  // Supplier-level dropdown data for the quote-submit form (locations, reps, choices).
  async function fetchSupplierLookups(supplierId) {
    const [loc, rep] = await Promise.all([
      fetchAllZohoPages('/report/All_Supplier_Locations?criteria=(Supplier_Entry_Form==' + encodeURIComponent(supplierId) + ')'),
      fetchAllZohoPages('/report/All_Supplier_Representatives?criteria=(Supplier_Entry_Form==' + encodeURIComponent(supplierId) + ')'),
    ]);
    return {
      locations: loc.map(l => ({ id: String(l.ID), name: l.Name_of_Location || '' })),
      reps: rep.map(r => ({ id: String(r.ID), name: flatten(r.Name) || r.Email || '' })),
      quote_requirements: ['MTRs Required', 'AIS - Made & Melted in USA'],
    };
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
