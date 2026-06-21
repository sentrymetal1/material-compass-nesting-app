// ── Fitting RFQ matching (off-Zoho brick #1) ───────────────────────────────
// Pull model: a supplier-side widget hits GET /api/supplier/:supplierId/fitting-rfqs;
// Railway reads the supplier's fitting stock + all open MFG fitting RFQ lines from
// Zoho, matches them here (NOT in Deluge), and returns the scored matches. No
// write-back to Zoho — that's what keeps the logic portable when the supplier
// platform later moves to Supabase/Next.js.
//
// WHY match on lookup .ID: both the demand side (Fittings_Quote_Subform) and the
// supply side (Supplier_Fitting_Stock) reference the SAME master catalog tables
// (Fitting Type / Fitting Make / End Type / Connection Type / Fitting Specification).
// So the same fitting = the same record ID on both sides. Matching IDs is immune
// to any text/spelling/format drift. Zoho's v2.1 API returns a lookup field as
// { ID, display_value } (see index.js:410), so we get both the id (to match) and
// the name (to display) for free.

const DEMAND_REPORT = 'Fittings_Quote_Subform_Report';
// NOTE: the default Supplier_Fitting_Stock_Report carries a report-level filter
// `Supplier_ID.Account_User_Email.contains(zoho.loginuserid)`. Read via the
// integration OAuth user, that filter would scope to ONLY the API account's own
// supplier and hide everyone else — so we MUST read an UNFILTERED report. Mark to
// create `Supplier_Fitting_Stock_All` (no filter) exposing the five lookups +
// Supplier_ID + Fitting_Stocked_Checkbox as columns. Override via env if renamed.
const SUPPLY_REPORT = process.env.FITTING_STOCK_REPORT || 'Supplier_Fitting_Stock_All';
const STOCKED_VALUE = 'Stocked'; // Fitting_Stocked_Checkbox choice (NOT boolean true)

// Match tiers, most → least specific. score is what the widget sorts/badges on.
const TIERS = [
  { level: 'exact',    score: 100, keys: ['type', 'make', 'end', 'conn', 'spec'] },
  { level: 'strong',   score: 80,  keys: ['type', 'make', 'end', 'spec'] },
  { level: 'spec',     score: 60,  keys: ['type', 'make', 'end'] },
  { level: 'category', score: 40,  keys: ['type', 'make'] },
];

// Normalize a Zoho field that may be a lookup object { ID, display_value },
// an alternate { ID, zc_display_value }, or a plain string → { id, name }.
function lk(v) {
  if (v == null) return { id: '', name: '' };
  if (typeof v === 'object') {
    return {
      id: String(v.ID || v.id || ''),
      name: String(v.display_value || v.zc_display_value || ''),
    };
  }
  return { id: String(v), name: String(v) };
}

// The five match axes of one row (demand or supply), as ids + readable names.
function axes(row) {
  return {
    type: lk(row.Fitting_Type),
    make: lk(row.Fitting_Make),
    end:  lk(row.End_Type),
    conn: lk(row.Connection_Type),
    spec: lk(row.Fitting_Specification),
  };
}

// Build a lookup key for a given tier from an axes object, using the .id of each
// axis. Returns null if any required axis is missing an id (can't match on blanks).
function tierKey(ax, keys) {
  const parts = [];
  for (const k of keys) {
    const id = ax[k] && ax[k].id;
    if (!id) return null;
    parts.push(id);
  }
  return parts.join('|');
}

// Index a supplier's stocked rows into one Set of keys per tier, so each demand
// row is matched with O(1) lookups instead of scanning the whole stock list.
function indexStock(stockRows) {
  const sets = TIERS.map(() => new Set());
  for (const row of stockRows) {
    const ax = axes(row);
    TIERS.forEach((tier, i) => {
      const key = tierKey(ax, tier.keys);
      if (key) sets[i].add(key);
    });
  }
  return sets;
}

// Best (highest-scoring) tier this demand row matches against the indexed stock.
function bestMatch(demandAx, stockSets) {
  for (let i = 0; i < TIERS.length; i++) {
    const key = tierKey(demandAx, TIERS[i].keys);
    if (key && stockSets[i].has(key)) return TIERS[i];
  }
  return null;
}

// All open MFG fitting RFQ lines. Cached briefly — the same demand list is
// re-scanned for every supplier that polls, so one read serves many requests.
function fetchFittingDemand(deps) {
  const { fetchAllZohoPages, cachedLookup } = deps;
  return cachedLookup('fitting-demand', 60 * 1000, async () => {
    return fetchAllZohoPages('/report/' + DEMAND_REPORT);
  });
}

// One supplier's STOCKED fitting rows. Cached 60s to spare the Zoho API budget
// (a stock edit shows up within a minute).
function fetchSupplierStock(supplierId, deps) {
  // && encodes as %26%26 in Creator criteria; the choice value is quoted.
  const criteria =
    '(Supplier_ID==' + encodeURIComponent(supplierId) +
    '%26%26Fitting_Stocked_Checkbox=="' + STOCKED_VALUE + '")';
  return deps.cachedLookup('fitting-stock:' + supplierId, 60 * 1000, () =>
    deps.fetchAllZohoPages('/report/' + SUPPLY_REPORT + '?criteria=' + criteria));
}

// Core matcher — reusable by both the standalone route and the supplier dashboard
// (no HTTP round-trip). Returns the same shape the route responds with.
async function matchFittingsForSupplier(supplierId, deps) {
  const [stockRows, demandRows] = await Promise.all([
    fetchSupplierStock(supplierId, deps),
    fetchFittingDemand(deps),
  ]);

  if (!stockRows.length) {
    return {
      ok: true, supplier_id: supplierId, stock_count: 0,
      demand_count: demandRows.length, match_count: 0, matches: [],
      note: 'Supplier has no stocked fittings, or the unfiltered stock report ('
        + SUPPLY_REPORT + ') is missing / has no matching columns.',
    };
  }

  const stockSets = indexStock(stockRows);
  const matches = [];

  for (const d of demandRows) {
    const ax = axes(d);
    const tier = bestMatch(ax, stockSets);
    if (!tier) continue;
    matches.push({
      quote_id: lk(d.Quote_ID).id,
      quote_id_number: lk(d.Quote_ID).name || null,   // demand has Quote_ID (lookup), not Quote_ID_Number
      project_id: lk(d.MCP_Customer_Project_Form).id,
      project_name: lk(d.MCP_Customer_Project_Form).name,
      line_item: d.Line_Item_Fitting || null,          // real column is Line_Item_Fitting
      qty: d.Quantity != null ? Number(d.Quantity) : null,
      fitting: {
        type: ax.type.name,
        make: ax.make.name,
        end: ax.end.name,
        connection: ax.conn.name,
        specification: ax.spec.name,
      },
      description: d.Full_Fitting_Item_Description || d.Fitting_Description_Text || '',
      match_level: tier.level,
      score: tier.score,
      rfq_row_id: String(d.ID),
    });
  }

  matches.sort((a, b) => b.score - a.score); // highest-confidence first
  return {
    ok: true, supplier_id: supplierId,
    stock_count: stockRows.length, demand_count: demandRows.length,
    match_count: matches.length, matches,
  };
}

function registerFittingMatchRoutes(app, deps) {
  // GET /api/supplier/:supplierId/fitting-rfqs → scored matches for one supplier.
  app.get('/api/supplier/:supplierId/fitting-rfqs', async (req, res) => {
    try {
      res.json(await matchFittingsForSupplier(req.params.supplierId, deps));
    } catch (err) {
      if (deps.sendZohoAwareError) return deps.sendZohoAwareError(res, err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

module.exports = { registerFittingMatchRoutes, matchFittingsForSupplier };
