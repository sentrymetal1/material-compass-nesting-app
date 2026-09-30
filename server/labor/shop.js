// =============================================================================
//  labor/shop.js — one shop's labour setup: its own numbers and reference jobs.
// -----------------------------------------------------------------------------
//  Stored on the Railway volume as labor-shop-<manufacturer id>.json. Nothing
//  here touches Zoho, so saving a shop's setup costs no API calls.
//
//  PRIVATE TO THE SHOP. A shop's hours per ton reveal how it prices, so one
//  shop's reference jobs must never reach another shop's estimate. The file is
//  keyed by manufacturer id and the routes take that id from the tenant token
//  when one is present (tenantToken.js); the shared library is the only thing
//  every shop sees.
//
//  REFERENCE JOBS are the main source of accuracy. Checked on Keller 40778: the
//  library alone gives ~17 hr/ton for that skid, the actual was ~103. One real
//  job per type fixes that; several average out the odd one.
// =============================================================================
const { readJson, writeJson } = require('../filestore');
const { STANDARD } = require('./components');

const JOB_TYPES = {
  skid_frame: 'Welded skid / frame',
  platform_stairs: 'Platform & stairs',
  plate_tank: 'Plate / tank',
  pipe_spool: 'Pipe spool',
  structural: 'Structural (beams & columns)',
  misc: 'Misc. / other',
};
const WELD_PROCESSES = ['GMAW (MIG)', 'SMAW', 'FCAW', 'GTAW'];
const PLATE_CUT = ['Oxy-Fuel', 'Plasma'];

const fileFor = (mfg) => {
  if (!/^\d{6,25}$/.test(String(mfg || ''))) throw new Error('manufacturer id must be a record id');
  return 'labor-shop-' + mfg + '.json';
};

function empty(mfg) {
  return { manufacturer_id: String(mfg), settings: {}, rates: {}, pipe_anchors: [], reference_jobs: [], updated: null };
}

function load(mfg) {
  return Object.assign(empty(mfg), readJson(fileFor(mfg), {}) || {});
}

const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 120);

// Everything from the page is re-checked here. A bad value is dropped, never stored as zero —
// a zero would be read as "this takes no time".
function clean(input, mfg) {
  const i = input || {};
  const s = i.settings || {};
  const settings = {
    weld_process: WELD_PROCESSES.indexOf(s.weld_process) > -1 ? s.weld_process : 'GMAW (MIG)',
    smaw_amps: pos(s.smaw_amps),
    deposition_lb_hr: pos(s.deposition_lb_hr),
    operating_factor: pos(s.operating_factor) && pos(s.operating_factor) <= 1 ? pos(s.operating_factor) : null,
    plate_cut_process: PLATE_CUT.indexOf(s.plate_cut_process) > -1 ? s.plate_cut_process : 'Oxy-Fuel',
    member_method: s.member_method === 'framed' ? 'framed' : 'welded',
    start_from_sentry: s.start_from_sentry === true,   // Mark + partner to decide; off until they do
  };
  const rates = {};
  for (const key of Object.keys(STANDARD)) { const v = pos((i.rates || {})[key]); if (v != null) rates[key] = v; }
  const pipe_anchors = (Array.isArray(i.pipe_anchors) ? i.pipe_anchors : []).slice(0, 4)
    .map((a) => ({ size: txt(a.size, 12), schedule: txt(a.schedule, 16), hours: pos(a.hours) }))
    .filter((a) => a.size && a.schedule && a.hours != null);
  const reference_jobs = (Array.isArray(i.reference_jobs) ? i.reference_jobs : []).slice(0, 200)
    .map((j, n) => ({
      id: txt(j.id, 40) || ('rj' + Date.now().toString(36) + n),
      type: JOB_TYPES[j.type] ? j.type : 'misc',
      name: txt(j.name, 120),
      tons: pos(j.tons),
      hours: pos(j.hours),
      pieces: pos(j.pieces),
      job_number: txt(j.job_number, 40),
      date: txt(j.date, 10),
      source: j.source === 'workorder' ? 'workorder' : 'entered',
    }))
    .filter((j) => j.tons != null && j.hours != null);
  return { manufacturer_id: String(mfg), settings, rates, pipe_anchors, reference_jobs, updated: new Date().toISOString() };
}

function save(mfg, input) {
  const profile = clean(input, mfg);
  writeJson(fileFor(mfg), profile);
  return profile;
}

// Hours per ton per job type, weighted by tonnage so one tiny job cannot swing a big type.
function referenceRates(profile) {
  const out = {};
  for (const j of (profile && profile.reference_jobs) || []) {
    const r = out[j.type] = out[j.type] || { type: j.type, label: JOB_TYPES[j.type], hours: 0, tons: 0, jobs: 0 };
    r.hours += j.hours; r.tons += j.tons; r.jobs += 1;
  }
  for (const r of Object.values(out)) r.hr_per_ton = Math.round((r.hours / r.tons) * 10) / 10;
  return out;
}

// What the estimate needs from a shop, in the shapes estimate.js and resolve() take.
function estimateContext(profile) {
  const s = (profile && profile.settings) || {};
  return {
    pipeAnchors: (profile && profile.pipe_anchors) || [],
    plateCutProcess: s.plate_cut_process || 'Oxy-Fuel',
    plateCutOperation: s.plate_cut_process === 'Plasma' ? 'Plasma cut - mild steel' : 'Flame cut square',
    memberMethod: s.member_method === 'framed' ? /^Framed member complete$/ : /^Welded frame member - square cut and welded all around$/,
    weldSettings: s,
    referenceRates: referenceRates(profile),
  };
}

module.exports = { load, save, clean, referenceRates, estimateContext, JOB_TYPES, WELD_PROCESSES, PLATE_CUT };
