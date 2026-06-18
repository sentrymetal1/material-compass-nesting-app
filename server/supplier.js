// ── Supplier platform (off-Zoho strangler) ────────────────────────────────
// v1: suppliers still log into the Zoho portal; the new UI is embedded there and
// passes the logged-in email to Railway. Zoho remains the data store; Railway is
// the API. The ONE place that turns an identity into "which supplier" is
// resolveSupplier() below — every supplier route goes through the withSupplier
// middleware. When auth later moves to Supabase, only resolveSupplier/withSupplier
// change; no route or screen does.

const { matchFittingsForSupplier } = require('./fittingMatch');

const SUPPLIER_REPORT = 'Supplier_Entry_Report';
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

  // Dashboard — the supplier's home. v1 returns fitting matches (live). Structural
  // matches + quote statuses get added here next (Phase 1 continued) so the UI has
  // one call for its home screen.
  app.get('/api/supplier/me/dashboard', withSupplier, async (req, res) => {
    try {
      const fittings = await matchFittingsForSupplier(req.supplier.id, deps);
      const pmap = await getProjectInfo(fittings.matches.map(m => m.project_id));
      fittings.matches.forEach(m => { m.project = pmap[m.project_id] || null; });
      res.json({
        ok: true,
        supplier: req.supplier,
        matches: {
          fittings: fittings.matches,
          structural: [], // TODO Phase 1: bridge from the existing Zoho structural matcher
        },
        counts: {
          fitting_matches: fittings.match_count,
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
