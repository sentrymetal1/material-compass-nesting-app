// =============================================================================
//  labor/routes.js — shop labour setup, and the shared library it sits on.
// -----------------------------------------------------------------------------
//  GET  /api/labor/library                       shared, same for every shop
//  GET  /api/labor/shop?manufacturer_id=…        one shop's setup + its catalog
//  POST /api/labor/shop   { manufacturer_id, … } save it
//  POST /api/labor/estimate { manufacturer_id, job_type, rows, fittings }  take-off → job hours
//  POST /api/labor/weld-time { weld, manufacturer_id, settings? }  hours/ft for one weld;
//       `settings` previews unsaved numbers from the setup page, cleaned as a save would be
//
//  The shop routes are in TENANT_ROUTES, so the tenant token is checked (warn
//  mode today, enforce later). When a valid manufacturer token is present its
//  id is used over whatever the page sent — the page can only ever read or
//  write the shop it was opened for.
// =============================================================================
const { library, nonHoursRows, BUCKETS } = require('./standards');
const shop = require('./shop');
const { catalog } = require('./components');
const { weldHoursPerFt, deposition, operatingFactor } = require('./weldTime');
const { laborForTakeoff } = require('./takeoffLabor');
const pm = require('./processModel');
const laborTypes = require('./laborTypes');

function shopId(req) {
  if (req.tenant && req.tenant.kind === 'm') return req.tenant.id;
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  return String((req.query && req.query.manufacturer_id) || b.manufacturer_id || '').trim();
}

// What a set of process parameters works out to, for the setup page to show beside each input:
// a 1/4" fillet per weld process and material, cut speeds at three thicknesses, the factor a
// frame member in each material carries against carbon steel, and where routing really lands.
// hr/ft for one process + material + joint at every common size, in all four positions.
function weldGrid(P, g) {
  const proc = (g && g.proc) || 'MIG', mat = (g && g.mat) || 'CS', joint = (g && g.joint) || 'FILLET';
  const rows = pm.WELD_SIZES.map((size) => {
    const cell = {};
    for (const p of Object.keys(pm.POSITION)) { const r = pm.jointHrPerFt(P, mat, proc, joint, size, p); cell[p] = r.missing ? null : r.total; }
    const flat = pm.jointHrPerFt(P, mat, proc, joint, size, 'flat');
    return { size, cells: cell, prep: flat.missing ? null : flat.prep, nde: flat.missing ? null : flat.nde,
      lb_per_ft: flat.missing ? null : flat.parts.lb_per_ft, missing: flat.missing || null };
  });
  return { proc, mat, joint, rows };
}

function modelPreview(P, grid) {
  const weld = {}, cut = {}, member = {}, routing = {};
  for (const mat of P.materials) {
    for (const p of pm.PROCESSES.filter((x) => x.family === 'weld')) {
      const w = pm.weldHrPerFt(P, mat, p.key, 0.25);
      if (!w.missing) weld[p.key + '|' + mat] = { hr_per_ft: w.value, source: w.source };
    }
    for (const p of pm.PROCESSES.filter((x) => x.family === 'cut')) {
      const row = {};
      for (const t of [0.25, 0.5, 1]) { const c = pm.cutRate(P, mat, p.key, t); row[t] = c.missing ? null : Math.round(c.ipm * 10) / 10; }
      if (Object.values(row).some((v) => v != null)) cut[p.key + '|' + mat] = row;
    }
    const thin = pm.memberFactors(P, mat, 0.125, 1), thick = pm.memberFactors(P, mat, 0.5, 4);
    const tot = (f) => f.weld == null || f.cut == null ? null :
      P.general.share_cut.value * f.cut + P.general.share_fit.value * f.fit + P.general.share_weld.value * f.weld;
    member[mat] = { thin: tot(thin), thick: tot(thick), thin_weld: thin.weld_process, thick_weld: thick.weld_process,
      missing: thin.weld_missing || thin.cut_missing || thick.weld_missing || null };
    const wt = pm.weldProcessFor(P, mat, 0.125), wk = pm.weldProcessFor(P, mat, 0.75);
    const ct = pm.plateCutProcessFor(P, mat, 0.25), ck = pm.plateCutProcessFor(P, mat, 1.5);
    routing[mat] = { weld_thin: wt.process || null, weld_thick: wk.process || null, plate_thin: ct.process || null, plate_thick: ck.process || null,
      notes: [wt, wk, ct, ck].filter((x) => x.missing || x.substituted).map((x) => x.missing || ('routed ' + x.routed + ' is not in your shop — ' + x.process + ' used')) };
  }
  return { weld, cut, member, routing, weld_grid: weldGrid(P, grid) };
}

function view(profile) {
  const P = pm.params(shop.modelOf(profile));
  return Object.assign({}, profile, {
    catalog: catalog(profile.rates, P, P.materials),
    model_params: P,
    model_input: shop.modelOf(profile),   // what the page edits: the saved model, or the old settings mapped onto it
    model_defaults: pm.defaults(),
    model_preview: modelPreview(P),
    reference_rates: shop.referenceRates(profile),
    weld: { deposition: deposition(profile.settings), operating_factor: operatingFactor(profile.settings) },
    job_types: shop.JOB_TYPES,
    weld_processes: shop.WELD_PROCESSES,
    plate_cut: shop.PLATE_CUT,
    pipe_choices: shop.pipeChoices(),
  });
}

// The setup page previews what it has not saved yet. Draft settings go through the same
// clean() as a save, so the preview can never show a number the save would drop.
function weldSettings(id, body) {
  const draft = body && body.settings && typeof body.settings === 'object' ? body.settings : null;
  if (draft) return shop.clean({ settings: draft }, id).settings;
  return id ? shop.load(id).settings : {};
}

function registerLaborRoutes(app) {
  // The two levels of labour: 8 broad buckets and the detail types under them. Same for every shop.
  app.get('/api/labor/types', (req, res) => {
    res.json({ ok: true, buckets: laborTypes.BUCKET_LABEL, types: laborTypes.TYPES });
  });

  app.get('/api/labor/library', (req, res) => {
    res.json({ ok: true, buckets: BUCKETS, standards: library(), not_hours: nonHoursRows().map((r) => r.code), catalog: catalog({}) });
  });

  app.get('/api/labor/shop', (req, res) => {
    try { res.json({ ok: true, shop: view(shop.load(shopId(req))) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/labor/shop', (req, res) => {
    try { res.json({ ok: true, shop: view(shop.save(shopId(req), req.body || {})) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // The take-off review's labour step: { manufacturer_id, job_type, rows, fittings } → job hours.
  app.post('/api/labor/estimate', (req, res) => {
    try {
      const b = req.body || {};
      const id = shopId(req);
      const profile = id ? shop.load(id) : null;
      res.json({ ok: true, labor: laborForTakeoff({ rows: b.rows, fittings: b.fittings, welds: b.welds }, profile, b.job_type) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // Unsaved setup → what it would work out to. Cleaned exactly as a save would be.
  app.post('/api/labor/model-preview', (req, res) => {
    try {
      const P = pm.params(pm.cleanModel((req.body || {}).model || {}));
      res.json({ ok: true, params: P, preview: modelPreview(P, (req.body || {}).grid), catalog: catalog((req.body || {}).rates || {}, P, P.materials) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post('/api/labor/weld-time', (req, res) => {
    try {
      const b = req.body || {};
      res.json({ ok: true, result: weldHoursPerFt(b.weld, weldSettings(shopId(req), b)) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}

module.exports = { registerLaborRoutes, weldSettings, modelPreview };
