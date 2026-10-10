// =============================================================================
//  zohoMeter.js — every Zoho REST call the server makes, counted and attributed.
// -----------------------------------------------------------------------------
//  One Zoho account serves every tenant, and its Developer API allowance is
//  1,000 calls a day for all of them together. It ran out on 2026-10-07, -08 and
//  -09, and each time the cause had to be dug out of a log that a deploy wipes.
//  This hooks the shared axios instance (every module requires the same one), so
//  each call to zohoapis.com is counted by the server route that caused it and by
//  the Zoho report or form it touched, per day, on the volume. It also notes the
//  moment Zoho answers code 4000 (allowance gone).
//
//  today() lets background work stand down before the allowance is spent, so the
//  calls left are kept for people using the pages.
// =============================================================================

const axios = require('axios');
const { AsyncLocalStorage } = require('async_hooks');
const filestore = require('./filestore');

const DAILY_LIMIT = Number(process.env.ZOHO_DAILY_API_LIMIT) || 1000;
const ctx = new AsyncLocalStorage();
const fileOf = function (day) { return 'zoho-calls-' + day + '.json'; };
// Zoho resets the allowance on its own clock; the counter rolls over at midnight US Eastern,
// which is where every shop on the platform works.
const dayNow = function () {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
};

let day = dayNow();
let state = filestore.readJson(fileOf(day), null) || { day: day, total: 0, by_route: {}, by_target: {}, exhausted_at: '' };
let dirty = false;

function roll() {
  const d = dayNow();
  if (d !== day) {
    flush();
    day = d;
    state = filestore.readJson(fileOf(day), null) || { day: day, total: 0, by_route: {}, by_target: {}, exhausted_at: '' };
  }
}
function flush() {
  if (!dirty) return;
  dirty = false;
  try { filestore.writeJson(fileOf(state.day), state); } catch (e) { console.error('[zoho-meter] write failed:', e.message); }
}
setInterval(flush, 30000).unref();
process.on('SIGTERM', flush);

// "GET /api/project/4111484000006294004/nesting-results" → "GET /api/project/:id/nesting-results"
function routeLabel(req) {
  return req.method + ' ' + String(req.path || '').replace(/\/\d{6,}(?=\/|$)/g, '/:id');
}
// ".../report/All_Projects/4111...?criteria=..." → "GET report/All_Projects"
function targetLabel(cfg) {
  const m = String(cfg.url || '').match(/\/creator\/v2(?:\.1)?\/(?:data|meta)\/[^/]+\/[^/]+\/(report|form)\/([A-Za-z0-9_]+)/);
  return String(cfg.method || 'get').toUpperCase() + ' ' + (m ? m[1] + '/' + m[2] : 'other');
}

axios.interceptors.request.use(function (cfg) {
  if (/zohoapis\.com\/creator\//.test(String(cfg.url || ''))) {
    roll();
    const store = ctx.getStore();
    const route = (store && store.route) || 'background';
    const target = targetLabel(cfg);
    state.total++;
    state.by_route[route] = (state.by_route[route] || 0) + 1;
    state.by_target[target] = (state.by_target[target] || 0) + 1;
    dirty = true;
  }
  return cfg;
});
axios.interceptors.response.use(function (resp) {
  if (resp && resp.data && resp.data.code === 4000 && /zohoapis\.com\/creator\//.test(String(resp.config && resp.config.url || ''))) {
    roll();
    if (!state.exhausted_at) {
      state.exhausted_at = new Date().toISOString();
      dirty = true;
      flush();
      console.error('[zoho-meter] DAILY ALLOWANCE EXHAUSTED after ' + state.total + ' counted calls');
    }
  }
  return resp;
});

// Express middleware: every Zoho call made while handling a request is put down to that route.
function middleware(req, res, next) {
  ctx.run({ route: routeLabel(req) }, next);
}
// Run background work (scheduled scans, cache warm-ups) under a label of its own.
function runAs(label, fn) { return ctx.run({ route: 'background: ' + label }, fn); }

function today() { roll(); return { day: state.day, total: state.total, limit: DAILY_LIMIT, exhausted_at: state.exhausted_at }; }
// Background work should stand down once this much of the day is gone.
function lowOnCalls(share) { roll(); return state.total >= DAILY_LIMIT * (share || 0.7) || !!state.exhausted_at; }

function report(days) {
  flush();
  const n = Math.max(1, Math.min(31, Number(days) || 1));
  const out = [];
  const top = function (m) { return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).slice(0, 25).map(function (k) { return { name: k, calls: m[k] }; }); };
  for (let i = 0; i < n; i++) {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - i * 86400000));
    const s = d === state.day ? state : filestore.readJson(fileOf(d), null);
    if (!s) continue;
    out.push({ day: d, total: s.total, limit: DAILY_LIMIT, exhausted_at: s.exhausted_at || '', by_route: top(s.by_route || {}), by_zoho: top(s.by_target || {}) });
  }
  return out;
}

module.exports = { middleware, runAs, today, lowOnCalls, report, DAILY_LIMIT };
