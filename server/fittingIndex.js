// =============================================================================
//  fittingIndex.js — every real fitting the shop can buy, in one searchable list.
// -----------------------------------------------------------------------------
//  WHY THIS EXISTS, AND WHY IT INVERTS THE OLD MODEL.
//
//  The editor used to ask for six attributes across two independent cascades:
//  type -> end/connection, make -> specification, with size and schedule loose
//  text. Nothing cross-checked them, so you could assemble a fitting that exists
//  nowhere — which is exactly what happened: Elbow + Butt Weld +
//  "Wrought - Carbon Steel" is a combination with zero rows in either detail
//  table, so it could never resolve a size or a weight.
//
//  But the detail tables ARE the answer. Between them,
//    Tee_Reducing_NPS_Dimensions              (butt weld, ~3,027 rows)
//    Fittings_Socket_Weld_and_Threaded_Details (socket/threaded, ~7,406 rows)
//  hold every real combination the shop stocks, each already carrying its type,
//  make, end, connection, size, schedule-or-class AND its weight.
//
//  So a fitting is not six choices. It is ONE row. Pick the row and all six
//  fields follow, the weight comes with it, and an impossible combination
//  becomes unrepresentable rather than merely discouraged.
//
//  COST. Building this is ~53 paged Zoho reads, which is real money against a
//  1,000/day budget, so it is cached for 12 hours and searched in the browser.
//  Filtering live per dropdown change would be a Zoho call per keystroke.
// =============================================================================

const ALIAS_SEED = {
  // The take-off assigns "Wrought - Carbon Steel" to butt-weld fittings, which is defensible —
  // A234 WPB IS wrought carbon steel, and it is a valid row in Fitting_Make. The detail tables
  // simply file those under "Carbon Steel", so the strict name has no rows at all and every
  // size lookup came back empty. Mark's call: treat it as an alias.
  make: { 'wrought carbon steel': 'Carbon Steel' },
  type: {},
  end: {},
};

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const disp = (x) => (x && typeof x === 'object' ? (x.zc_display_value || '') : (x == null ? '' : String(x)));
const lkId = (r, f) => String((r && r[f] && (r[f].ID || r[f].id)) || r[f + '.ID'] || '');

// The builder on its own, so the take-off prompt can use it too rather than the routes owning it.
function makeFittingIndexBuilder(deps) {
  return internals(deps).buildIndex;
}

// The volume-backed append, so an added fitting shows up without a 53-call rebuild.
function makeFittingIndexAppender(deps) {
  return internals(deps).appendToIndex;
}

function internals(deps) {
  const { fetchAllZohoPages, cachedLookup, filestore, cacheBust } = deps;

  // One normalised entry per real fitting.
  function entry(r, tbl) {
    const type = disp(r.Fitting_Type), make = disp(r.Fitting_Make);
    const end = disp(r.End_Type), conn = disp(r.Connection_Type);
    const size = tbl === 'bw' ? (disp(r.NPS) || disp(r.NPS_Dimension))
                              : (String(r.NPS_Inch_Text || '') || disp(r['NPS_Dimensions.NPS_Inch']));
    const sched = tbl === 'bw' ? disp(r.NPS_Schedule)
                               : [String(r.Class || ''), disp(r.Class_Type)].filter(Boolean).join(' ');
    const label = tbl === 'bw' ? String(r.NPS_Dim_And_SCH_Text || '') : String(r.NPS_Dim_and_Class || '');
    // Weight is blank on most butt-weld rows (the June audit put it at ~95%). That is expected,
    // not an error — the size is still right, and the weight engine fills it later. A blank must
    // stay blank; a zero would be read as an answer.
    const w = String(r.Weight == null ? '' : r.Weight).trim();
    return {
      id: String(r.ID), tbl: tbl,
      type: type, typeId: lkId(r, 'Fitting_Type'),
      make: make, makeId: lkId(r, 'Fitting_Make'),
      end: end,   endId: lkId(r, 'End_Type'),
      conn: conn, connId: lkId(r, 'Connection_Type'),
      size: size, sched: sched,
      // The small end of a reducing fitting. The older rows put ONLY the run size in
      // their description, so three different reducing couplings can read "1/2" |
      // 3000 PSI" and be indistinguishable in a picker. This is the field that tells
      // them apart, and without it the estimator is choosing at random.
      rdims: String(r.Reducer_Dims_Text || '').trim(),
      label: label || [size, sched].filter(Boolean).join(' | '),
      weight: w === '' ? null : Number(w),
      // What the search matches on: everything about the row, flattened. The style is in here
      // too, because a drawing says "BW" or "forged" as often as it names the end type.
      hay: norm([type, make, end, conn, size, sched, disp(r.Fitting_Style), label].join(' ')),
    };
  }

  // ON DISK, not just in memory. Building this is ~53 paged reads against a 1,000/day ceiling,
  // and an in-memory cache dies with every deploy — so a day of ordinary deploys silently cost
  // hundreds of calls, and on 2026-09-21 a rebuild near the limit spent the last of the budget
  // and returned nothing. The volume survives restarts, so this is at most one build a day.
  const DISK = 'fitting-index.json';
  const DISK_MAX_AGE = 24 * 60 * 60 * 1000;

  // force=true skips BOTH caches. Needed because the volume copy is good for 24h, so
  // rows added to the detail tables are invisible here for up to a day — which from
  // the estimator's seat looks like the catalog is missing them. It costs ~53 Zoho
  // calls against a 1,000/day ceiling, so it is opt-in and never automatic.
  async function buildIndex(force) {
    if (force && typeof cacheBust === 'function') cacheBust('takeoff:fitting-index');
    return cachedLookup('takeoff:fitting-index', 12 * 60 * 60 * 1000, async () => {
      // A recent copy on the volume is worth far more than a fresh one: these tables change when
      // Mark edits them, which is rarely, and the alternative is 53 calls.
      if (filestore && !force) {
        const saved = filestore.readJson(DISK, null);
        if (saved && Array.isArray(saved.items) && saved.items.length &&
            Date.now() - Date.parse(saved.built_at || 0) < DISK_MAX_AGE) {
          console.log('[fittings] index loaded from the volume (' + saved.items.length + ' items, built ' +
            saved.built_at + ') — no Zoho calls spent');
          return saved;
        }
      }
      const [bw, sw] = await Promise.all([
        fetchAllZohoPages('/report/Tee_Reducing_NPS_Dimensions_Report'),
        fetchAllZohoPages('/report/Fittings_Socket_Weld_and_Threaded_Details_Report'),
      ]);
      const items = []
        .concat((bw || []).map((r) => entry(r, 'bw')))
        .concat((sw || []).map((r) => entry(r, 'sw')))
        .filter((x) => x.type && x.size);
      const withWeight = items.filter((x) => x.weight != null).length;
      const built = { items: items, built_at: new Date().toISOString(), with_weight: withWeight };
      console.log('[fittings] index built from Zoho: ' + items.length + ' items (' + (bw || []).length +
        ' butt weld, ' + (sw || []).length + ' socket/threaded), ' + withWeight + ' with a weight');
      // Written even if the caller later fails — the calls have been spent either way, and
      // throwing the result away is how the same 53 calls get spent twice.
      if (filestore) { try { filestore.writeJson(DISK, built); } catch (e) { console.error('[fittings] index not saved to volume:', e.message); } }
      return built;
    });
  }

  // A row added through the add-flow can be folded in without a rebuild, so the picker sees it
  // immediately and the next restart still does not cost 53 calls.
  function appendToIndex(item) {
    if (!filestore) return false;
    try {
      const saved = filestore.readJson(DISK, null);
      if (!saved || !Array.isArray(saved.items)) return false;
      saved.items.push(item);
      filestore.writeJson(DISK, saved);
      return true;
    } catch (e) { return false; }
  }

  return { buildIndex: buildIndex, entry: entry, appendToIndex: appendToIndex };
}

function registerFittingIndex(app, deps) {
  const buildIndex = internals(deps).buildIndex;

  // The whole index, for the review page to search in the browser. Big, but fetched once per
  // page and cached server-side for 12h, so it costs nothing per keystroke.
  app.get('/api/takeoff/fitting-index', async (req, res) => {
    try {
      const idx = await buildIndex(String(req.query.rebuild || '') === '1');
      res.json({ ok: true, built_at: idx.built_at, count: idx.items.length,
        with_weight: idx.with_weight, aliases: ALIAS_SEED, items: idx.items });
    } catch (err) {
      console.error('[fittings] index build failed:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });

  // A count-only view, so the index can be checked without shipping megabytes.
  app.get('/api/takeoff/fitting-index-check', async (req, res) => {
    try {
      const idx = await buildIndex(String(req.query.rebuild || '') === '1');
      const byType = {};
      idx.items.forEach((x) => {
        const k = x.type + ' · ' + x.make;
        byType[k] = byType[k] || { n: 0, weighed: 0 };
        byType[k].n++; if (x.weight != null) byType[k].weighed++;
      });
      res.json({ ok: true, built_at: idx.built_at, total: idx.items.length, with_weight: idx.with_weight,
        combinations: Object.keys(byType).length,
        sample: Object.keys(byType).sort().slice(0, 40).map((k) => k + ' — ' + byType[k].n + ' sizes, ' + byType[k].weighed + ' weighed') });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });

  return { buildIndex: buildIndex, ALIAS_SEED: ALIAS_SEED };
}

// A row appended by the add-flow has to normalise its search text the SAME way a built row
// does, or it is in the index and still unfindable by typing its own name.
module.exports = { registerFittingIndex, makeFittingIndexBuilder, makeFittingIndexAppender, ALIAS_SEED, indexHay: norm };
