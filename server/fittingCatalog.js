// =============================================================================
//  fittingCatalog.js — the five fittings cascade tables. ONE loader.
// -----------------------------------------------------------------------------
//  There were two. The supplier stock tab loaded them at
//  /api/supplier/me/fitting-catalog, and the take-off loaded the same five
//  reports again at /api/takeoff/fittings-catalog, written separately months
//  apart. Same query, different field names (`type_id` vs `typeId`), different
//  cache keys, different TTLs, and only one of them bothered to sort.
//
//  Two copies of one catalog drift, and the drift shows up as a screen that
//  disagrees with another screen about what the shop sells. So: one loader, one
//  cache entry, both screens.
//
//  It emits BOTH naming conventions on purpose. The supplier UI is in production
//  reading `type_id`/`make_id`; the take-off editor reads `typeId`/`makeId`.
//  Renaming either would be a pointless risk, and carrying two keys on a few
//  hundred small objects costs nothing.
// =============================================================================

// Alphabetical, numeric-aware: the reports come back in creation order, which reads as
// random once a list is longer than a handful. ("2 inch" sorts before "10 inch".)
const az = (arr) => arr.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

function makeFittingCatalogLoader(deps) {
  const { fetchAllZohoPages, cachedLookup } = deps;
  const lkId = (r, key) => String((r && r[key] && (r[key].ID || r[key].id)) || r[key + '.ID'] || '');

  // Cached 12h to match the other catalogs. These five tables are platform-level vocabulary,
  // not per-tenant data — they change when Mark edits them, which is rarely, and rebuilding
  // costs five paged reads against a tight daily budget.
  return function loadFittingCatalog() {
    return cachedLookup('fitting-catalog', 12 * 60 * 60 * 1000, async () => {
      const [types, makes, ends, conns, specs] = await Promise.all([
        fetchAllZohoPages('/report/Fitting_Type_Report'),
        fetchAllZohoPages('/report/Fitting_Make_Report'),
        fetchAllZohoPages('/report/End_Type_Report'),
        fetchAllZohoPages('/report/Connection_Type_Report'),
        fetchAllZohoPages('/report/Fitting_Specification_Report'),
      ]);
      // A child carries its parent's id under both spellings, so either caller can filter.
      const child = (rows, nameField, parentField, parentKeyA, parentKeyB) =>
        az((rows || []).map((r) => {
          const pid = lkId(r, parentField);
          const o = { id: String(r.ID), name: String(r[nameField] || '').trim() };
          o[parentKeyA] = pid; o[parentKeyB] = pid;
          return o;
        }).filter((x) => x.name));

      return {
        types: az((types || []).map((r) => ({ id: String(r.ID), name: String(r.Fitting_Type || '').trim() })).filter((x) => x.name)),
        makes: az((makes || []).map((r) => ({ id: String(r.ID), name: String(r.Fitting_Make || '').trim() })).filter((x) => x.name)),
        ends: child(ends, 'End_Type', 'Fitting_Type', 'type_id', 'typeId'),
        connections: child(conns, 'Connection_Type', 'Fitting_Type', 'type_id', 'typeId'),
        specs: child(specs, 'Fitting_Specification', 'Fitting_Make', 'make_id', 'makeId'),
      };
    });
  };
}

module.exports = { makeFittingCatalogLoader };
