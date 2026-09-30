// =============================================================================
//  labor/routes.js — shop labour setup, and the shared library it sits on.
// -----------------------------------------------------------------------------
//  GET  /api/labor/library                       shared, same for every shop
//  GET  /api/labor/shop?manufacturer_id=…        one shop's setup + its catalog
//  POST /api/labor/shop   { manufacturer_id, … } save it
//  POST /api/labor/weld-time { weld, manufacturer_id }  hours/ft for one weld
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

function shopId(req) {
  if (req.tenant && req.tenant.kind === 'm') return req.tenant.id;
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  return String((req.query && req.query.manufacturer_id) || b.manufacturer_id || '').trim();
}

function view(profile) {
  return Object.assign({}, profile, {
    catalog: catalog(profile.rates),
    reference_rates: shop.referenceRates(profile),
    weld: { deposition: deposition(profile.settings), operating_factor: operatingFactor(profile.settings) },
    job_types: shop.JOB_TYPES,
  });
}

function registerLaborRoutes(app) {
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

  app.post('/api/labor/weld-time', (req, res) => {
    try {
      const id = shopId(req);
      const settings = id ? shop.load(id).settings : {};
      res.json({ ok: true, result: weldHoursPerFt((req.body || {}).weld, settings) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}

module.exports = { registerLaborRoutes };
