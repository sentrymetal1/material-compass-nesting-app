// =============================================================================
//  costLedger.js — what every AI call cost, kept on the Railway volume.
// -----------------------------------------------------------------------------
//  The [ai-cost] lines in the server log were the only record, and the log is
//  wiped on every deploy: on a day with several deploys "what did today cost"
//  had no answer (2026-10-07, about $15-18, reconstructed by hand). Each call is
//  now also appended to one file per day (ai-cost-YYYY-MM-DD.json) that survives
//  restarts, and summarize() totals any range by kind, project and shop.
// =============================================================================

const filestore = require('./filestore');

const DAY_FILE = function (day) { return 'ai-cost-' + day + '.json'; };
const today = function () { return new Date().toISOString().slice(0, 10); };

// Writes are batched: a busy chat session must not do a disk write per message, and a crash
// loses at most a few seconds of entries.
let pending = [], timer = null;
function flush() {
  timer = null;
  if (!pending.length) return;
  const byDay = {};
  pending.forEach(function (e) { (byDay[e.at.slice(0, 10)] = byDay[e.at.slice(0, 10)] || []).push(e); });
  pending = [];
  Object.keys(byDay).forEach(function (day) {
    try {
      const have = filestore.readJson(DAY_FILE(day), []) || [];
      filestore.writeJson(DAY_FILE(day), have.concat(byDay[day]));
    } catch (e) { console.error('[ai-cost] ledger write failed:', e.message); }
  });
}

// kind: 'takeoff part', 'chat', 'preview read', 'ask', 'revise', 'addenda', 'triage email', ...
// meta: { project_id, manufacturer_id, detail }
function record(kind, usd, meta) {
  meta = meta || {};
  const cost = Math.round((Number(usd) || 0) * 10000) / 10000;
  console.log('[ai-cost] ' + kind + ' $' + cost + (meta.detail ? ' (' + meta.detail + ')' : ''));
  pending.push({ at: new Date().toISOString(), kind: kind, usd: cost,
                 project_id: meta.project_id ? String(meta.project_id) : '', manufacturer_id: meta.manufacturer_id ? String(meta.manufacturer_id) : '' });
  if (!timer) timer = setTimeout(flush, 5000);
}

// Totals for the last `days` days (today included): per day, per kind, per project, per shop.
function summarize(days) {
  flush();
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const out = { days: [], by_kind: {}, by_project: {}, by_manufacturer: {}, total_usd: 0, calls: 0 };
  for (let d = n - 1; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const list = filestore.readJson(DAY_FILE(day), []) || [];
    const dayTotal = list.reduce(function (s, e) { return s + (Number(e.usd) || 0); }, 0);
    out.days.push({ day: day, usd: Math.round(dayTotal * 100) / 100, calls: list.length });
    list.forEach(function (e) {
      const add = function (map, key) { if (!key) return; map[key] = map[key] || { usd: 0, calls: 0 }; map[key].usd += Number(e.usd) || 0; map[key].calls++; };
      add(out.by_kind, e.kind); add(out.by_project, e.project_id); add(out.by_manufacturer, e.manufacturer_id);
      out.total_usd += Number(e.usd) || 0; out.calls++;
    });
  }
  [out.by_kind, out.by_project, out.by_manufacturer].forEach(function (m) { Object.keys(m).forEach(function (k) { m[k].usd = Math.round(m[k].usd * 100) / 100; }); });
  out.total_usd = Math.round(out.total_usd * 100) / 100;
  return out;
}

module.exports = { record, summarize, flush, today };
