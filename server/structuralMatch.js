// ── Structural RFQ matching (parallel to fittingMatch.js) ──────────────────────
// Pull model, same as fittings: match a supplier's STOCKED structural material against
// open manufacturer sourcing demand. Demand = All_RFQs_Sent_Report rows that are still
// "In Process" and the latest version for the supplier (the active structural lines any
// MFG is sourcing). Supply = Stocked_Material_List rows flagged Material_Stocked.
//
// Both sides reference the SAME catalog (Form Type / Material Type / spec), so the same
// material = the same record id on both — matching ids is immune to text drift. Demand
// spec lives in Material_Form_Detail; supply spec in Type_Detail_LU (same Type_Detail
// catalog). Deduped by project|line so one requirement shows once even if sent to many
// suppliers. The dashboard gates these by open-project status, like fittings.

const DEMAND_REPORT = 'All_RFQs_Sent_Report';
const SUPPLY_REPORT = 'Stocked_Material_List';

const TIERS = [
  { level: 'exact',  score: 100, keys: ['form', 'mat', 'spec'] },
  { level: 'strong', score: 70,  keys: ['form', 'mat'] },
];

function lk(v) {
  if (v == null) return { id: '', name: '' };
  if (typeof v === 'object') return { id: String(v.ID || v.id || ''), name: String(v.display_value || v.zc_display_value || '') };
  return { id: String(v), name: String(v) };
}
const demandAxes = r => ({ form: lk(r.Form_Type), mat: lk(r.Material_Type), spec: lk(r.Material_Form_Detail) });
const supplyAxes = r => ({ form: lk(r.Form_Type), mat: lk(r.Material_Type), spec: lk(r.Type_Detail_LU) });
function tierKey(ax, keys) { const p = []; for (const k of keys) { const id = ax[k] && ax[k].id; if (!id) return null; p.push(id); } return p.join('|'); }
function indexStock(rows) { const sets = TIERS.map(() => new Set()); for (const r of rows) { const ax = supplyAxes(r); TIERS.forEach((t, i) => { const k = tierKey(ax, t.keys); if (k) sets[i].add(k); }); } return sets; }
function bestMatch(ax, sets) { for (let i = 0; i < TIERS.length; i++) { const k = tierKey(ax, TIERS[i].keys); if (k && sets[i].has(k)) return TIERS[i]; } return null; }
const isStocked = v => Array.isArray(v) ? v.includes('Stocked') : (v === 'Stocked' || v === true || v === 'true');

// Option A: only lines the manufacturer SENT to this supplier (so every match is
// quotable). Per-supplier cache; %26%26 = && and %20 = space in the quoted value.
const fetchDemand = (sid, deps) => deps.cachedLookup('structural-demand:' + sid, 60 * 1000, async () => {
  const sup = encodeURIComponent(sid);
  try {
    return await deps.fetchAllZohoPages('/report/' + DEMAND_REPORT + '?criteria=(Supplier_LU==' + sup + '%26%26RFQ_Sent_Status=="In%20Process"%26%26Latest_Item_for_Supplier==true)');
  } catch (e) {
    // Fall back to the supplier's latest lines if the quoted/space criteria is rejected
    // (we re-filter to "In Process" in JS below either way).
    return await deps.fetchAllZohoPages('/report/' + DEMAND_REPORT + '?criteria=(Supplier_LU==' + sup + '%26%26Latest_Item_for_Supplier==true)');
  }
});
const fetchStock = (sid, deps) => deps.cachedLookup('struct-stock-match:' + sid, 60 * 1000, () =>
  deps.fetchAllZohoPages('/report/' + SUPPLY_REPORT + '?criteria=(Supplier_ID==' + encodeURIComponent(sid) + ')'));

async function matchStructuralForSupplier(supplierId, deps) {
  const [stockAll, demand] = await Promise.all([fetchStock(supplierId, deps), fetchDemand(supplierId, deps)]);
  const stock = (stockAll || []).filter(r => isStocked(r.Material_Stocked));
  if (!stock.length) {
    return { ok: true, supplier_id: supplierId, stock_count: 0, demand_count: (demand || []).length, match_count: 0, matches: [] };
  }
  const sets = indexStock(stock);
  const seen = new Set();
  const matches = [];
  for (const d of (demand || [])) {
    if (String(d.RFQ_Sent_Status || '') !== 'In Process') continue; // active sourcing only
    const ax = demandAxes(d);
    const tier = bestMatch(ax, sets);
    if (!tier) continue;
    const projectId = lk(d.MCP_Customer_Project_Form).id;
    const key = projectId + '|' + (d.Line_Item || '') + '|' + ax.form.id + '|' + ax.mat.id + '|' + ax.spec.id;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      quote_id: lk(d.Quote_LU).id,
      quote_id_number: d.Quote_Reference_Number || d.Quote_Number || null,
      project_id: projectId,
      project_name: lk(d.MCP_Customer_Project_Form).name,
      line_item: d.Line_Item || null,
      qty: d.Quantity != null ? Number(d.Quantity) : null,
      material: { form: ax.form.name, material: ax.mat.name, spec: ax.spec.name },
      description: d.Full_Item_Description || d.Description_And_Dimension_Text || '',
      match_level: tier.level, score: tier.score,
      rfq_row_id: String(d.ID),
    });
  }
  matches.sort((a, b) => b.score - a.score);
  return { ok: true, supplier_id: supplierId, stock_count: stock.length, demand_count: (demand || []).length, match_count: matches.length, matches };
}

module.exports = { matchStructuralForSupplier };
