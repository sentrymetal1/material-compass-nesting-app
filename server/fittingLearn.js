// =============================================================================
//  fittingLearn.js — what this shop has already taught us about fitting names.
// -----------------------------------------------------------------------------
//  Structural has had this since it was built: the estimator corrects a row, the
//  correction is stored per shop, and the next take-off does not make the same
//  mistake. Fittings never had it. This is that, and deliberately the SAME
//  mechanism rather than a second one:
//
//    · the same Zoho form, `Takeoff_Correction`, with Source = "fitting"
//    · the same capture endpoint, POST /api/takeoff/learn
//    · Context says which vocabulary — "fitting make", "fitting type", …
//    · AI_Value is what the take-off wrote, Human_Value is what the estimator
//      picked out of the catalog
//
//  No new table, no new endpoint, and Material Compass reviews these in the same
//  place it already reviews the structural ones.
//
//  A correction outranks every other rule in fittingResolve.js, including the
//  alias table, because it is this shop saying what their own drawings mean.
// =============================================================================
const txt = (v) => String(v == null ? '' : v).trim();
const norm = (s) => txt(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Context → the vocabulary it teaches. Anything else is ignored rather than guessed at.
const KINDS = {
  'fitting type': 'type', 'fitting make': 'make', 'fitting end type': 'end',
  'fitting connection': 'connection', 'fitting specification': 'specification',
  'fitting size': 'size', 'fitting detail': 'detail',
};
const kindOf = (context) => KINDS[norm(context)] || '';

function makeFittingLearning(deps) {
  const { fetchAllZohoPages, cachedLookup } = deps;

  // Cached 10 minutes. Long enough that a commit of sixty fittings reads it once, short enough
  // that a correction made in the editor is in force by the time that take-off is approved.
  async function loadFittingLearning(manufacturerId) {
    const mfg = txt(manufacturerId);
    if (!mfg) return {};
    try {
      return await cachedLookup('fitting-learning:' + mfg, 10 * 60 * 1000, async () => {
        const rows = await fetchAllZohoPages('/report/Takeoff_Correction_Report?criteria=' +
          encodeURIComponent('(Manufacture_ID=="' + mfg + '" && Source=="fitting")'));
        return shape(rows);
      });
    } catch (e) {
      // Learning is an improvement, never a dependency. A take-off must commit whether or not
      // this read succeeded — the resolver simply falls back to alias, exact and fuzzy.
      console.error('[fittings] learning unavailable (resolving without it):', e.response?.data?.message || e.message);
      return {};
    }
  }

  // Rows → { kind: { normalised ai value: the catalog name } }. Newest wins: a shop that
  // changes its mind has changed its mind.
  function shape(rows) {
    const out = {};
    (rows || []).slice()
      .sort((a, b) => String(a.Created || '').localeCompare(String(b.Created || '')))
      .forEach((r) => {
        const k = kindOf(r.Context);
        const ai = norm(r.AI_Value), human = txt(r.Human_Value);
        if (!k || !ai || !human) return;
        out[k] = out[k] || {};
        out[k][ai] = human;
      });
    return out;
  }

  return { loadFittingLearning: loadFittingLearning, shape: shape, kindOf: kindOf };
}

module.exports = { makeFittingLearning, KINDS };
