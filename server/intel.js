// =============================================================================
//  intel.js — Material Intelligence for one project: what this job needs, and
//  what the shop (and, anonymously, the market) has paid for it before.
// -----------------------------------------------------------------------------
//  GET /api/intel/project/:id
//
//  One call gives the widget everything for its default view, so it never
//  queries Zoho per material (the old widget did, and polled every 3 s):
//    - the project's BOM, grouped by material, with job weight;
//    - its fittings, grouped by type / make / spec / size;
//    - THIS SHOP's quote history for each (avg, last paid, min/max, 30-day
//      average, trend, the previous quotes themselves) — the reference an
//      estimator wants beside the quote;
//    - INDUSTRY figures: averages only, never a supplier, project or company,
//      and only where at least MIN_SHOPS other shops have quoted it;
//    - alerts when a price has moved sharply in the last 30 days.
//
//  WHOSE PRICES ARE "MINE": the shop that owns the project (its MANUFACTURE),
//  never a value the caller sends.
//
//  MATCHING. A quote names its material by catalog id when it has one; many
//  rows only carry form · type · spec (the specific size is blank). So a BOM
//  material matches its exact catalog item first, then falls back to "same
//  form · type · spec", and the result says which ('exact' | 'similar').
//
//  FITTING QUOTES carry no price column in RFQs_Sent_Fittings_Report (checked
//  2026-10-01) and no size, so fittings show how often and when they were
//  quoted, and by whom; a price appears as soon as the report exposes one of
//  FITTING_PRICE_FIELDS.
// =============================================================================

const MIN_SHOPS = 3;            // other shops needed before an industry figure is shown
const ALERT_PCT = 10;           // 30-day move that raises an alert
const FITTING_PRICE_FIELDS = ['Unit_Price', 'Price_Each', 'Price_Per_Unit', 'Unit_Cost', 'Price'];

const idOf = (v) => (v && typeof v === 'object') ? String(v.ID || v.zc_display_value || '') : String(v == null ? '' : v);
const txt = (v) => (v && typeof v === 'object') ? String(v.zc_display_value || '') : String(v == null ? '' : v);
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const DAY = 86400000;

// Zoho dates: "Sep 07,2026 14:42:52" / "Sep 06,2026". Unparseable → null (never "now").
function parseDate(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const d = new Date(t.replace(/,(\d)/, ', $1'));
  return isNaN(d.getTime()) ? null : d;
}

// ── Structural quote history ────────────────────────────────────────────────────────────────
function normQuote(r) {
  return {
    mfg: idOf(r.Customer_LU),
    material: idOf(r.Material),
    form: idOf(r.Form_Type) || String(r['Form_Type.ID'] || ''),
    type: idOf(r.Material_Type),
    spec: idOf(r.Material_Form_Detail),
    price: num(r.Price_Per_Lb),
    date: parseDate(r.Price_Last_Updated) || parseDate(r.Quote_Date) || parseDate(r.RFQSent_Timestamp),
    supplier: String(r.Supplier_Name || txt(r.Supplier_LU) || '').trim(),
    project: (r.MCP_Customer_Project_Form && (r.MCP_Customer_Project_Form.Project_Quote_Number || r.MCP_Customer_Project_Form.ID)) || '',
    project_id: idOf(r.MCP_Customer_Project_Form),
    lead: String(r.Lead_Time_Drop_Down || '').trim(),
  };
}

// Price statistics for a set of quotes. series/previous are for the shop's own view only.
function stats(quotes, opts) {
  const q = quotes.filter((x) => x.price > 0).sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
  if (!q.length) return null;
  const now = (opts && opts.now) || Date.now();
  const avg = (xs) => xs.length ? xs.reduce((s, x) => s + x.price, 0) / xs.length : null;
  const recent = q.filter((x) => x.date && now - x.date.getTime() <= 30 * DAY);
  const prior = q.filter((x) => x.date && now - x.date.getTime() > 30 * DAY && now - x.date.getTime() <= 120 * DAY);
  const a30 = avg(recent), aPrior = avg(prior);
  const change = (a30 != null && aPrior) ? (a30 - aPrior) / aPrior * 100 : null;
  const out = {
    quotes: q.length,
    avg: r4(avg(q)), min: r4(Math.min(...q.map((x) => x.price))), max: r4(Math.max(...q.map((x) => x.price))),
    last: r4(q[0].price), last_date: q[0].date ? q[0].date.toISOString().slice(0, 10) : null,
    avg_30d: a30 == null ? null : r4(a30), quotes_30d: recent.length,
    avg_prior_90d: aPrior == null ? null : r4(aPrior),
    change_pct: change == null ? null : Math.round(change * 10) / 10,
    trend: change == null ? 'insufficient' : change > 2 ? 'up' : change < -2 ? 'down' : 'flat',
  };
  if (opts && opts.detail) {
    out.series = q.filter((x) => x.date).slice(0, 24).reverse().map((x) => ({ d: x.date.toISOString().slice(0, 10), p: r4(x.price) }));
    out.previous = q.slice(0, 8).map((x) => ({ date: x.date ? x.date.toISOString().slice(0, 10) : null, price: r4(x.price),
      supplier: x.supplier || '—', project: x.project || '', this_project: !!opts.projectId && x.project_id === opts.projectId }));
    const sup = {};
    q.forEach((x) => { const k = x.supplier || 'Unknown'; (sup[k] = sup[k] || { supplier: k, n: 0, sum: 0, last: null, last_date: null });
      sup[k].n++; sup[k].sum += x.price; if (!sup[k].last_date && x.date) { sup[k].last = r4(x.price); sup[k].last_date = x.date.toISOString().slice(0, 10); } });
    out.suppliers = Object.values(sup).map((s) => ({ supplier: s.supplier, quotes: s.n, avg: r4(s.sum / s.n), last: s.last, last_date: s.last_date }))
      .sort((a, b) => a.avg - b.avg);
    const lt = {};
    q.forEach((x) => { if (x.lead) lt[x.lead] = (lt[x.lead] || 0) + 1; });
    out.lead_times = Object.entries(lt).map(([lead_time, count]) => ({ lead_time, count })).sort((a, b) => b.count - a.count);
  }
  return out;
}

// Industry: other shops only, averages only, and only with MIN_SHOPS of them behind the number.
function industry(quotes, myMfg, now) {
  const others = quotes.filter((x) => x.mfg && x.mfg !== myMfg && x.price > 0);
  const shops = new Set(others.map((x) => x.mfg)).size;
  if (shops < MIN_SHOPS) return { available: false, reason: 'needs quotes from ' + MIN_SHOPS + '+ other shops' };
  const s = stats(others, { now });
  return { available: true, shops: MIN_SHOPS + '+', quotes: s.quotes, avg: s.avg, avg_30d: s.avg_30d,
    avg_prior_90d: s.avg_prior_90d, change_pct: s.change_pct, trend: s.trend };
}

function alertFor(label, s, scope) {
  if (!s || s.change_pct == null || Math.abs(s.change_pct) < ALERT_PCT) return null;
  return { scope, label, change_pct: s.change_pct, direction: s.change_pct > 0 ? 'up' : 'down',
    text: label + ' ' + (s.change_pct > 0 ? 'up ' : 'down ') + Math.abs(s.change_pct) + '% in the last 30 days' + (scope === 'industry' ? ' (market)' : ' (your quotes)') };
}

// ── The project's own material ──────────────────────────────────────────────────────────────
function groupBom(rows) {
  const g = {};
  for (const r of rows || []) {
    const key = String(r.Material_ID || '') || [r.Form_Type_ID, r.Material_Type_ID, r.Specification_ID, r.Material].join('|');
    const label = [txt(r.Form_Type), txt(r.Material_Type), txt(r.Specification), txt(r.Material)].filter(Boolean).join(' | ');
    const x = g[key] = g[key] || { key, label, material: String(r.Material_ID || ''), form: String(r.Form_Type_ID || ''),
      type: String(r.Material_Type_ID || ''), spec: String(r.Specification_ID || ''), weight: 0, rows: 0, qty: 0 };
    x.weight += num(r.CalcWeight); x.rows += 1; x.qty += num(r.Quantity);
  }
  return Object.values(g);
}

function groupFittings(rows) {
  const g = {};
  for (const r of rows || []) {
    const type = txt(r.Fitting_Type), make = txt(r.Fitting_Make), spec = txt(r.Fitting_Specification);
    const size = String(r.Fitting_Description_Text || txt(r.Fitting_Description) || '').trim();
    const key = [type, make, spec, size].join('|');
    const x = g[key] = g[key] || { key, label: [type, size].filter(Boolean).join(' · '), sub: [make, spec].filter(Boolean).join(' · '),
      type, make, spec, size, qty: 0, weight: 0 };
    x.qty += num(r.Quantity); x.weight += num(r.Total_Weight);
  }
  return Object.values(g);
}

function normFittingQuote(r) {
  const pf = FITTING_PRICE_FIELDS.find((f) => num(r[f]) > 0);
  return { mfg: idOf(r.Customer_LU), type: txt(r.Fitting_Type), make: txt(r.Fitting_Make), spec: txt(r.Fitting_Specification),
    price: pf ? num(r[pf]) : 0, qty: num(r.Quantity),
    date: parseDate(r.Quote_Timestamp) || parseDate(r.Quote_Date) || parseDate(r.Price_Last_Updated),
    supplier: String(r.Supplier_Name || '').trim(), status: String(r.RFQ_Fitting_Sent_Status || '').trim(), project: String(r.Quote_Description || '').trim() };
}

// Everything for one project. Pure — the route feeds it rows, tests feed it fixtures.
function buildIntel({ projectId, myMfg, bom, fittings, quotes, fittingQuotes, now }) {
  now = now || Date.now();
  const mine = quotes.filter((q) => q.mfg && q.mfg === myMfg);
  const alerts = [];

  const structural = groupBom(bom).map((m) => {
    const exactAll = m.material ? quotes.filter((q) => q.material === m.material) : [];
    const similarAll = quotes.filter((q) => q.form === m.form && q.type === m.type && q.spec === m.spec);
    const exactMine = exactAll.filter((q) => q.mfg === myMfg), similarMine = similarAll.filter((q) => q.mfg === myMfg);
    const useExact = exactMine.length > 0;
    const myQ = useExact ? exactMine : similarMine;
    const indQ = exactAll.filter((q) => q.mfg !== myMfg).length ? exactAll : similarAll;
    const mineStats = stats(myQ, { now, detail: true, projectId });
    const ind = industry(indQ, myMfg, now);
    const a1 = alertFor(m.label, mineStats, 'mine'); if (a1) alerts.push(a1);
    const a2 = ind.available ? alertFor(m.label, ind, 'industry') : null; if (a2) alerts.push(a2);
    const price = mineStats ? (mineStats.avg_30d || mineStats.avg) : (ind.available ? (ind.avg_30d || ind.avg) : null);
    return {
      key: m.key, label: m.label, weight: r2(m.weight), rows: m.rows,
      match: myQ.length ? (useExact ? 'exact' : 'similar') : 'none',
      mine: mineStats, industry: ind,
      est_cost: price ? r2(price * m.weight) : null,
      est_basis: mineStats ? (mineStats.avg_30d ? 'your 30-day avg' : 'your avg') : (ind.available ? 'market avg' : null),
    };
  }).sort((a, b) => (b.est_cost || 0) - (a.est_cost || 0) || b.weight - a.weight);

  const fitMine = (fittingQuotes || []).filter((q) => q.mfg === myMfg);
  const fittingRows = groupFittings(fittings).map((f) => {
    const hits = fitMine.filter((q) => q.type === f.type && (!q.make || q.make === f.make) && (!q.spec || q.spec === f.spec));
    const priced = hits.filter((q) => q.price > 0);
    const dated = hits.filter((q) => q.date).sort((a, b) => b.date - a.date);
    return { key: f.key, label: f.label, sub: f.sub, qty: f.qty, weight: r2(f.weight),
      quoted: hits.length, last_quoted: dated[0] ? dated[0].date.toISOString().slice(0, 10) : null,
      suppliers: Array.from(new Set(hits.map((q) => q.supplier).filter(Boolean))).slice(0, 5),
      price: priced.length ? stats(priced, { now }) : null };
  }).sort((a, b) => b.qty - a.qty);

  // Overall: weight-weighted change across the project's own priced materials.
  let wSum = 0, cSum = 0;
  structural.forEach((s) => { if (s.mine && s.mine.change_pct != null) { wSum += s.weight; cSum += s.weight * s.mine.change_pct; } });
  const bomWeight = structural.reduce((s, x) => s + x.weight, 0);
  const estCost = structural.reduce((s, x) => s + (x.est_cost || 0), 0);
  return {
    summary: {
      bom_weight: r2(bomWeight), materials: structural.length,
      priced: structural.filter((s) => s.mine).length, priced_market_only: structural.filter((s) => !s.mine && s.est_cost).length,
      unpriced: structural.filter((s) => !s.est_cost).length,
      est_material_cost: r2(estCost), est_avg_per_lb: bomWeight && estCost ? r4(estCost / structural.filter((s) => s.est_cost).reduce((a, s) => a + s.weight, 0)) : null,
      trend_change_pct: wSum ? Math.round(cSum / wSum * 10) / 10 : null,
      fittings: fittingRows.length, fitting_qty: fittingRows.reduce((s, f) => s + f.qty, 0),
      your_quotes_on_file: mine.length,
    },
    alerts: alerts.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 8),
    structural, fittings: fittingRows,
    notes: {
      industry: 'Averages from at least ' + MIN_SHOPS + ' other shops. No supplier, project or company is ever shown.',
      fittings_price: (fittingQuotes || []).some((q) => q.price > 0) ? null
        : 'Fitting quotes have no price column in RFQs_Sent_Fittings_Report yet — add one and prices appear here.',
    },
  };
}

// Quote history takes ~11 Zoho reads (2,098 rows) and 10–20 s. Served stale-while-refreshing: once
// loaded, a request NEVER waits for it — an old copy is returned and a fresh one fetched behind it.
// Only the very first request after a deploy waits. A refresh happens only when someone asks, so an
// idle server spends nothing.
function staleWhileRefresh(fetchFn, maxAgeMs) {
  let value = null, at = 0, inflight = null;
  const refresh = () => {
    if (!inflight) inflight = fetchFn().then((v) => { value = v; at = Date.now(); return v; })
      .finally(() => { inflight = null; });
    return inflight;
  };
  return async () => {
    if (value === null) return refresh();
    if (Date.now() - at > maxAgeMs) refresh().catch((e) => console.error('[intel] background refresh failed:', e.message));
    return value;
  };
}

function registerIntel(app, deps) {
  const { fetchAllZohoPages, cachedLookup, projectHeader } = deps;
  const enc = (s) => encodeURIComponent(s);
  // Market prices move over days, not minutes. At 30 minutes the shared refresh (~13 reads) could
  // run 20 times in a working day — about a quarter of the 1,000-call allowance every tenant shares.
  const QUOTES_MAX_AGE = 4 * 60 * 60 * 1000;
  const structuralQuotes = staleWhileRefresh(async () =>
    (await fetchAllZohoPages('/report/All_RFQs_Sent_Report?criteria=' + enc('(Price_Per_Lb > 0)'))).map(normQuote), QUOTES_MAX_AGE);
  const fittingQuoteRows = staleWhileRefresh(async () =>
    (await fetchAllZohoPages('/report/RFQs_Sent_Fittings_Report')).map(normFittingQuote), QUOTES_MAX_AGE);
  // Deliberately NOT warmed at start-up: that would spend ~13 Zoho reads per instance on every deploy
  // against the 1,000/day allowance. The first panel opened after a deploy waits; nobody after it does.

  app.get('/api/intel/project/:id', async (req, res) => {
    try {
      const pid = String(req.params.id || '').trim();
      if (!/^\d{6,25}$/.test(pid)) return res.status(400).json({ ok: false, error: 'project id required' });
      const project = await projectHeader(pid);
      if (!project) return res.status(404).json({ ok: false, error: 'project not found' });
      const myMfg = String(project.manufacture || '');
      const [bom, fittings, quotes, fittingQuotes] = await Promise.all([
        // 10 minutes: the panel is opened every time the project page is, often several times in a row.
        cachedLookup('intel:bom:' + pid, 10 * 60 * 1000, () =>
          fetchAllZohoPages('/report/Project_Bill_Of_Material_Detail_Form_Report?criteria=' + enc('(MCP_Customer_Project_Form==' + pid + ')'))),
        cachedLookup('intel:fit:' + pid, 10 * 60 * 1000, () =>
          fetchAllZohoPages('/report/Project_BOM_Fittings_Quote_Form_Report?criteria=' + enc('(MCP_Customer_Project_Form==' + pid + ')'))),
        // Every shop's priced structural quotes, trimmed, shared by every project.
        structuralQuotes(),
        fittingQuoteRows(),
      ]);
      const out = buildIntel({ projectId: pid, myMfg, bom, fittings, quotes, fittingQuotes });
      res.json(Object.assign({ ok: true, project }, out));
    } catch (e) {
      console.error('[intel] failed:', e.response?.data || e.message);
      const quota = e.zohoQuota || (e.response && e.response.data && e.response.data.code === 4000) || /4000/.test(String(e.code || ''));
      res.status(quota ? 503 : 500).json({ ok: false, error: quota ? 'Daily Zoho data limit reached — resets overnight.' : (e.message || 'failed') });
    }
  });
}

module.exports = { registerIntel, buildIntel, staleWhileRefresh, normQuote, normFittingQuote, stats, industry, parseDate, MIN_SHOPS, ALERT_PCT };
