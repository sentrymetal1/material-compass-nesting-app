// =============================================================================
//  setup/checklist.js — a new shop's setup checklist (plan: docs/SHOP_SETUP_PLAN.md).
// -----------------------------------------------------------------------------
//    GET  /api/setup/status?manufacturer_id=   -> every step with its live status and where to do it
//    POST /api/setup/skip { step, skip }        -> "skip for now" / undo
//
//  Status is read from the shop's real records every time, nothing is ticked by hand:
//    profile        markup >= 10%, a project type, a shipping location, labor types, a labor rate
//                   (the same 5 checks as the profile's onboarding panel)
//    team           people on the shop (not cancelled), out of the early-access seats
//    clients        clients in the shop's list
//    suppliers      material suppliers matched to the shop
//    subcontractors active subcontractors / item suppliers
//    teach          take-off lessons from old quotes (Takeoff_Correction, Source = history)
//  A step the admin skips counts as done for "ready", and says so. Skips are kept on the server
//  volume (setup-<shop>.json), per shop.
// =============================================================================
const { readJson, writeJson } = require('../filestore');

const PORTAL = process.env.MC_PORTAL_URL || 'https://customer.materialcompassportal.com';
const SEATS = 4;
const s = (v) => (v == null ? '' : String(v)).trim();
const idOf = (v) => (v && typeof v === 'object' ? s(v.ID) : s(v));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const STEP_KEYS = ['profile', 'team', 'clients', 'suppliers', 'subcontractors', 'teach'];

// facts -> steps. facts: { profile:{markup, projectTypes, shipping, laborTypes, laborRates, onboardingDone},
//   people, clients, suppliers, subs, lessons, skipped:{key:true}, links:{...} }
// A fact that could not be read is null: the step says "can't check" instead of guessing.
function buildSteps(f) {
  const sk = f.skipped || {};
  const L = f.links || {};
  const steps = [];
  const p = f.profile || {};
  const checks = [
    ['Markup of 10% or more', p.markup], ['A project type', p.projectTypes], ['A shipping location', p.shipping],
    ['Labor types', p.laborTypes], ['A labor rate', p.laborRates],
  ];
  const known = checks.filter((c) => c[1] !== null && c[1] !== undefined);
  const missing = known.filter((c) => !c[1]).map((c) => c[0]);
  const unread = checks.filter((c) => c[1] === null || c[1] === undefined).map((c) => c[0].toLowerCase());
  let pStatus;
  if (p.onboardingDone === true || (known.length === checks.length && !missing.length)) pStatus = 'done';
  else if (known.length && missing.length < known.length) pStatus = 'partial';
  else pStatus = 'todo';
  steps.push({ key: 'profile', title: 'Company profile', required: true,
    why: 'Markup, project types, shipping and labor rates are used by every quote.',
    status: pStatus,
    detail: pStatus === 'done' ? 'Markup, project types, shipping and labor are set.'
      : (missing.length ? 'Still needed: ' + missing.join(', ') + '.' : (unread.length ? "Couldn't check: " + unread.join(', ') + '.' : 'Not started.')),
    action: { label: pStatus === 'done' ? 'Review' : 'Finish profile', url: L.profile, portal: true } });

  const team = f.people;
  steps.push({ key: 'team', title: 'Your team', why: 'Each person who quotes or buys gets their own login.',
    status: team == null ? 'unknown' : (team >= 2 ? 'done' : 'todo'),
    detail: team == null ? "Couldn't check right now." : (team >= 2 ? plural(team, 'person', 'people') + ' on the team (' + team + ' of ' + SEATS + ' seats).' : 'Only you so far. Invite the people who quote, buy or run jobs.'),
    action: { label: team >= 2 ? 'Manage team' : 'Invite team', url: L.team } });

  steps.push({ key: 'clients', title: 'Clients', required: true, why: 'Your customers, so a new quote starts from a list, not from typing.',
    status: f.clients == null ? 'unknown' : (f.clients > 0 ? 'done' : 'todo'),
    detail: f.clients == null ? "Couldn't check right now." : (f.clients > 0 ? plural(f.clients, 'client') + ' in your list.' : 'No clients yet. Import your customer list from QuickBooks, Outlook or a spreadsheet, or add them one at a time.'),
    action: f.clients > 0 ? { label: 'Your clients', url: L.clientsPage } : { label: 'Import clients', url: L.clients },
    action2: f.clients > 0 ? { label: 'Import more', url: L.clients } : { label: 'Add one at a time', url: L.clientsPage } });

  steps.push({ key: 'suppliers', title: 'Material suppliers', why: 'Who you send material RFQs to.',
    status: f.suppliers == null ? 'unknown' : (f.suppliers > 0 ? 'done' : 'todo'),
    detail: f.suppliers == null ? "Couldn't check right now." : (f.suppliers > 0 ? plural(f.suppliers, 'supplier') + ' on your list. Add the suppliers you already buy from, and invite them to quote online.' : 'None yet. Add the suppliers you buy material from.'),
    action: { label: f.suppliers > 0 ? 'Manage suppliers' : 'Add suppliers', url: L.suppliers } });

  steps.push({ key: 'subcontractors', title: 'Subcontractors', why: 'Galvanizers, painters, machine shops and other outside work, with their prices.',
    status: f.subs == null ? 'unknown' : (f.subs > 0 ? 'done' : 'todo'),
    detail: f.subs == null ? "Couldn't check right now." : (f.subs > 0 ? plural(f.subs, 'active subcontractor') + '.' : 'None yet. Add the shops you send outside work to.'),
    action: { label: f.subs > 0 ? 'Manage' : 'Add subcontractors', url: L.subs } });

  // Done at 3 reviewed past jobs (Mark: "3 to start, 10 is better").
  const tj = f.teachJobs || 0;
  steps.push({ key: 'teach', title: 'Teach the take-off', why: 'Your past jobs teach the AI how your shop scopes and prices work.',
    status: tj >= 3 ? 'done' : (tj > 0 ? 'partial' : 'todo'),
    detail: tj >= 3 ? plural(tj, 'past job') + ' reviewed' + (tj < 10 ? '. 10 is better; add more any time.' : '.') + (f.lessons > 0 ? ' ' + plural(f.lessons, 'lesson') + ' learned.' : '')
      : (tj > 0 ? plural(tj, 'past job') + ' reviewed. Add ' + (3 - tj) + ' more to start (10 is better).'
        : 'Add 3 past jobs (any quotes, estimates, cost reports) so the take-off learns your scope and pricing. 10 is better.'),
    action: { label: tj > 0 ? 'Add past jobs' : 'Start', url: L.teach } });

  for (const st of steps) {
    st.skipped = !!sk[st.key] && st.status !== 'done';
    st.can_skip = st.status !== 'done';
  }
  const doneish = (st) => st.status === 'done' || st.skipped;
  const ready = steps.filter((st) => st.required).every(doneish);
  return { steps, done: steps.filter((st) => st.status === 'done').length, total: steps.length, ready };
}

function registerSetupChecklist(app, deps) {
  const { fetchAllZohoPages } = deps;
  const enc = encodeURIComponent;
  function shopOf(req) {
    if (req.tenant && req.tenant.kind === 'm') return s(req.tenant.id);
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    return s((req.query && req.query.manufacturer_id) || b.manufacturer_id);
  }
  // rows, [] when the report is empty, null when it cannot be read (missing report / column).
  const rows = (p) => fetchAllZohoPages(p).catch((e) => {
    const d = e.response && e.response.data;
    if (d && /9220|9280/.test(JSON.stringify(d))) return [];
    console.warn('[setup] read failed', p.split('?')[0], d ? JSON.stringify(d).slice(0, 160) : e.message);
    return null;
  });
  const fileOf = (mfg) => 'setup-' + mfg + '.json';
  // Zoho refuses many reads at once ("too many requests continuously"), and every read counts against
  // the daily API allowance: read 3 at a time, and keep a shop's answer for 30 s (the page refreshes
  // whenever its tab is shown again).
  const CACHE_MS = 30 * 1000, cache = new Map();
  async function limited(tasks, n) {
    const out = new Array(tasks.length); let next = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); } }));
    return out;
  }

  app.get('/api/setup/status', async (req, res) => {
    const mfg = shopOf(req);
    if (!/^\d{6,25}$/.test(mfg)) return res.status(400).json({ ok: false, error: 'Open this page from Material Compass.' });
    try {
      const q = (crit) => '?criteria=' + enc(crit);
      const hit = cache.get(mfg);
      if (hit && Date.now() - hit.at < CACHE_MS && !req.query.fresh) return res.json(hit.body);
      const [shop, types, rates, ship, reps, clients, matches, subs, lessons] = await limited([
        () => rows('/report/Customer_Entry_Report' + q('(ID == ' + mfg + ')')),
        () => rows('/report/Type_Of_Projects_Report' + q('(Manufacture == ' + mfg + ')')),
        () => rows('/report/All_Manufacture_Labor_Rates' + q('(Manufacture == ' + mfg + ')')),
        () => rows('/report/API_Shipping_Locations' + q('(Customer_Entry_Form == ' + mfg + ')')),
        () => rows('/report/All_Company_Representatives' + q('(Manufacture == ' + mfg + ')')),
        () => rows('/report/API_Clients' + q('(Manufacturer == ' + mfg + ')')),
        () => rows('/report/All_Supplier_Manufacture_Matches' + q('(MANUFACTURE == ' + mfg + ')')),
        () => rows('/report/API_Subcontractors' + q('(Manufacture == ' + mfg + ')')),
        () => rows('/report/Takeoff_Correction_Report' + q('(Manufacture_ID == "' + mfg + '" && Source == "history")')),
      ], 3);
      const me = shop && shop[0];
      const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
      const profile = {
        markup: has(me, 'Mark_Up_Percent') ? Number(me.Mark_Up_Percent) >= 0.10 : null,
        laborTypes: has(me, 'Labor_Types') ? (Array.isArray(me.Labor_Types) ? me.Labor_Types.length > 0 : !!s(me.Labor_Types)) : null,
        onboardingDone: has(me, 'Onboarding_Done') ? (me.Onboarding_Done === true || /^true$/i.test(String(me.Onboarding_Done))) : null,
        projectTypes: types == null ? null : types.length > 0,
        laborRates: rates == null ? null : rates.length > 0,
        shipping: ship == null ? null : ship.length > 0,
      };
      const people = reps == null ? null : reps.filter((r) => !/^cancel/i.test(s(r.Invite_Status)) && !/^delete/i.test(s(r.Employee_Status))).length;
      const activeSubs = subs == null ? null : subs.filter((x) => x.Active === undefined || x.Active === true || /^(true|yes)$/i.test(String(x.Active))).length;
      const t = req.query.t || (req.get('X-MC-Token') || '');
      const rail = (page) => '/takeoff/' + page + '?manufacturer_id=' + enc(mfg) + (t ? '&t=' + enc(t) : '');
      const links = {
        profile: PORTAL + '/#Page:Manufacture_Profile?tab=tab1',
        clientList: PORTAL + '/#Page:Client_List_Page',
        team: rail('team.html'), clients: rail('clients-import.html'), clientsPage: rail('clients.html'), subs: rail('subcontractors.html'), teach: rail('teach.html'), suppliers: rail('suppliers.html'),
      };
      const st = buildSteps({ profile, people, clients: clients == null ? null : clients.length, suppliers: matches == null ? null : matches.length,
        subs: activeSubs, lessons: lessons == null ? null : lessons.length, teachJobs: require('../teach/teachRoutes').reviewedCount(mfg), skipped: (readJson(fileOf(mfg), {}) || {}).skipped || {}, links });
      const body = Object.assign({ ok: true, shop: { id: mfg, name: s(me && me.Company_Name) || 'Your shop' }, first_project: PORTAL + '/#Page:Manufacture_Main_Dashboard' }, st);
      cache.set(mfg, { at: Date.now(), body });
      res.json(body);
    } catch (e) {
      console.error('[setup]', e && e.stack || e);
      res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
    }
  });

  app.post('/api/setup/skip', (req, res) => {
    const mfg = shopOf(req), b = req.body || {};
    if (!/^\d{6,25}$/.test(mfg)) return res.status(400).json({ ok: false, error: 'Open this page from Material Compass.' });
    if (!STEP_KEYS.includes(b.step)) return res.status(400).json({ ok: false, error: 'Unknown step.' });
    const cur = readJson(fileOf(mfg), {}) || {};
    cur.skipped = cur.skipped || {};
    if (b.skip) cur.skipped[b.step] = new Date().toISOString(); else delete cur.skipped[b.step];
    writeJson(fileOf(mfg), cur);
    cache.delete(mfg);
    res.json({ ok: true });
  });
}

module.exports = { registerSetupChecklist, buildSteps, STEP_KEYS };
