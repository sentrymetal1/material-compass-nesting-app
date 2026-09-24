// =============================================================================
//  fittingResolve.js — turn a take-off fitting's NAMES into catalog IDS, and
//  find the detail row it already has, before anything is created.
// -----------------------------------------------------------------------------
//  WHY THIS EXISTS. A take-off fitting arrives with names and no ids: the review
//  page only stores an id when a human picks from a dropdown (review.html:684).
//  Commit refused anything with no `fitting_type_id` — so on a straight take-off
//  that nobody hand-edited row by row, the fittings were DROPPED at approve.
//  Not mispriced: absent from the project. That is the last thing standing
//  between the fittings chain and being 100% linked.
//
//  The matching rules are the review page's own, deliberately, so the page and
//  the server cannot disagree about what a fitting is:
//
//   · An id already on the row always wins.
//   · A name is matched exactly first, then through the alias table, then
//     normalised (case and punctuation only). A normalised match that hits more
//     than one catalog record is NOT a match — ambiguity is left for a human.
//   · End types and connections are resolved WITHIN the fitting type. The same
//     name is a different record per type — "Threaded - NPT" exists separately
//     for Bushing, Elbow, Tee and Cap — so a global name match returns a real id
//     belonging to the wrong fitting. Where the type has no children at all, the
//     id is LEFT BLANK rather than borrowed from another type: blank is honest,
//     wrong is the silent orphan this whole module exists to prevent.
//   · A name that is set and cannot be resolved means "match nothing", never
//     "match everything" — otherwise a cast-iron bushing matches 30" pipe.
//
//  THE ALIASES WERE DEAD. `ALIAS_SEED` has been sent to the browser by the index
//  route since it was written and is not read there — grep review.html. So the
//  one alias that matters has never been applied anywhere: the take-off assigns
//  "Wrought - Carbon Steel" to butt-weld fittings and the detail tables file
//  those under "Carbon Steel", so that make resolved to nothing and every
//  butt-weld size lookup came back empty. It is applied here.
// =============================================================================
const { ALIAS_SEED } = require('./fittingIndex');

const txt = (v) => String(v == null ? '' : v).trim();
const norm = (s) => txt(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// '2"', '2 in', '2' all have to compare equal, because the drawing, the model and the
// catalog each write a size differently. Same rule as review.html's fitSizeKey.
const sizeKey = (s) => txt(s).toLowerCase().replace(/inch(es)?/g, '').replace(/[^0-9a-z/.-]/g, '');

// A name that IS set but resolves to nothing. Carried rather than dropped, because
// "unknown" has to narrow the candidates to none — the opposite of "unconstrained".
const NO_MATCH = '__no_match__';

// '1-1/2"' → 1.5, '3/4 in' → 0.75, '2' → 2. Returns 0 for anything that is not a size, so a
// zero never compares equal to a real one.
function npsNum(s) {
  const v = txt(s).replace(/["”]/g, '').replace(/inch(es)?|in\b/gi, '').trim();
  const mixed = v.match(/^(\d+)[\s-](\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = v.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function aliasFor(kind, name) {
  const map = (ALIAS_SEED && ALIAS_SEED[kind]) || {};
  const hit = map[norm(name)];
  return hit ? txt(hit) : '';
}

// ── ONE FUZZY SCORE, USED FOR ALL FIVE VOCABULARIES ─────────────────────────────────────────
// Word overlap first, because these names are re-orderings of each other far more often than
// they are misspellings: the catalog says "Iron - Malleable" and a take-off writes "Malleable
// Iron", which is a perfect token match and a terrible character match. Prefix and containment
// cover the rest ("Carbon Steel" inside "Wrought - Carbon Steel").
function score(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const ta = A.split(' '), tb = B.split(' ');
  const setB = new Set(tb);
  let inter = 0;
  new Set(ta).forEach((w) => { if (setB.has(w)) inter++; });
  const union = new Set(ta.concat(tb)).size;
  const jaccard = union ? inter / union : 0;
  const prefix = (A.indexOf(B) === 0 || B.indexOf(A) === 0) ? 0.9 : 0;
  const contains = (A.indexOf(B) > -1 || B.indexOf(A) > -1) ? 0.8 : 0;
  return Math.max(jaccard, prefix, contains);
}

// Good enough to adopt without asking, AND clearly better than the runner-up. The margin is the
// important half: two catalog names that score the same are a question for a human, not a coin
// toss. Same rule the page uses for detail rows — one candidate or none.
const FUZZY_MIN = 0.75, FUZZY_MARGIN = 0.15;

// learned → alias → exact → normalised → fuzzy. In that order, and the order is the whole point:
//
//  · LEARNED is this shop correcting the take-off in their own words, so it outranks everything.
//  · ALIAS outranks an exact match on purpose. "Wrought - Carbon Steel" is a real Fitting_Make
//    record AND the make the take-off puts on every butt-weld fitting, but the detail tables
//    file those rows under "Carbon Steel" — so matching it to itself is how you get a fitting
//    joined to a make that has no rows, which prices at nothing.
//  · FUZZY last, and only when it is both good and unambiguous.
//
// Returns { id, how, suggestions } — `how` says which rule fired, which is what makes a wrong
// auto-match explainable instead of mysterious.
function resolveName(list, name, kind, learned) {
  const v = txt(name);
  const out = { id: '', how: '', suggestions: [] };
  if (!v || !Array.isArray(list) || !list.length) return out;

  const byName = (target) => {
    const t = txt(target);
    const exact = list.find((o) => txt(o.name) === t);
    if (exact) return String(exact.id);
    const loose = list.filter((o) => norm(o.name) === norm(t));
    return loose.length === 1 ? String(loose[0].id) : '';
  };

  const taught = learned && learned[kind] ? txt(learned[kind][norm(v)]) : '';
  if (taught) { const id = byName(taught); if (id) return { id: id, how: 'learned', suggestions: [] }; }

  const al = kind ? aliasFor(kind, v) : '';
  if (al) { const id = byName(al); if (id) return { id: id, how: 'alias', suggestions: [] }; }

  const exact = byName(v);
  if (exact) return { id: exact, how: 'exact', suggestions: [] };

  const ranked = list.map((o) => ({ o: o, s: score(o.name, v) })).sort((x, y) => y.s - x.s);
  out.suggestions = ranked.slice(0, 3).filter((r) => r.s > 0.3).map((r) => r.o.name);
  if (ranked.length && ranked[0].s >= FUZZY_MIN &&
      (ranked.length === 1 || ranked[0].s - ranked[1].s >= FUZZY_MARGIN)) {
    return { id: String(ranked[0].o.id), how: 'fuzzy', suggestions: out.suggestions };
  }
  out.id = NO_MATCH;        // set, and either unknown or too close to call
  return out;
}

// Back-compat shim: the id alone, for callers that do not care how it was found.
function idByName(list, name, kind, learned) {
  return resolveName(list, name, kind, learned).id;
}

// The children of a parent, STRICTLY. review.html's fitChildren falls back to the whole
// list when a parent has no children, which is right for offering a human options and
// wrong for picking an id — that fallback is how a Bushing ends up with a Tee's end type.
function childrenOf(list, key, parentId) {
  if (!Array.isArray(list) || !parentId || parentId === NO_MATCH) return [];
  return list.filter((o) => String(o[key] || '') === String(parentId));
}

// ---------------------------------------------------------------------------
//  resolveCatalogIds(f, catalog) -> { ids, unresolved, blocked }
//    ids       — only the ones that resolved, ready to merge onto the fitting
//    unresolved— names that are set and could not be resolved (reportable)
//    blocked   — true when the fitting TYPE itself could not be resolved, which
//                is the one field nothing downstream can proceed without
// ---------------------------------------------------------------------------
function resolveCatalogIds(f, catalog, learned) {
  const cat = catalog || {};
  const ids = {}, unresolved = [], how = {};
  // One step: resolve a name, record HOW it was found, and report it when it could not be.
  const take = (field, list, name, kind, label) => {
    const r = resolveName(list, name, kind, learned);
    if (r.id && r.id !== NO_MATCH) { ids[field] = r.id; how[field] = r.how; return r.id; }
    if (r.id === NO_MATCH) {
      unresolved.push({ what: label, value: txt(name), suggestions: r.suggestions });
    }
    return '';
  };

  const typeId = txt(f.fitting_type_id) || take('fitting_type_id', cat.types, f.fitting_type, 'type', 'fitting type');
  if (txt(f.fitting_type_id)) ids.fitting_type_id = txt(f.fitting_type_id);

  const makeId = txt(f.fitting_make_id) || take('fitting_make_id', cat.makes, f.fitting_make, 'make', 'make');
  if (txt(f.fitting_make_id)) ids.fitting_make_id = txt(f.fitting_make_id);

  // Scoped to the type. No children for this type → left blank on purpose.
  if (txt(f.end_type_id)) ids.end_type_id = txt(f.end_type_id);
  else if (txt(f.end_type) && typeId) {
    const kids = childrenOf(cat.ends, 'typeId', typeId);
    if (kids.length) take('end_type_id', kids, f.end_type, 'end', 'end type');
  }

  if (txt(f.connection_type_id)) ids.connection_type_id = txt(f.connection_type_id);
  else if (txt(f.connection_type) && typeId) {
    const kids = childrenOf(cat.connections, 'typeId', typeId);
    if (kids.length) take('connection_type_id', kids, f.connection_type, 'connection', 'connection');
  }

  // Specifications hang off the MAKE, not the type.
  if (txt(f.specification_id)) ids.specification_id = txt(f.specification_id);
  else if (txt(f.specification) && makeId) {
    const kids = childrenOf(cat.specs, 'makeId', makeId);
    if (kids.length) take('specification_id', kids, f.specification, 'specification', 'specification');
  }

  return { ids: ids, unresolved: unresolved, how: how, blocked: !txt(ids.fitting_type_id) };
}

// ---------------------------------------------------------------------------
//  matchDetailRow(f, items) -> an index item, or null
//
//  The review page's autoResolveFittings, server-side, so a commit resolves the
//  same way whether or not anyone opened the page. One candidate is adopted;
//  ambiguity is refused. A confident wrong row carries a real weight for the
//  wrong part and survives every check downstream — far worse than a blank.
// ---------------------------------------------------------------------------
function matchDetailRow(f, items) {
  if (!Array.isArray(items) || !items.length) return null;
  const want = sizeKey(f.size);
  if (!want) return null;

  // A name set but unresolved must narrow to nothing, so it is carried as NO_MATCH.
  const constrain = (idVal, nameVal) => (txt(idVal) ? txt(idVal) : (txt(nameVal) ? NO_MATCH : ''));
  const t = constrain(f.fitting_type_id, f.fitting_type);
  const m = constrain(f.fitting_make_id, f.fitting_make);
  const e = constrain(f.end_type_id, f.end_type);
  const c = constrain(f.connection_type_id, f.connection_type);
  if ([t, m, e, c].indexOf(NO_MATCH) > -1) return null;

  const ok = (a, b) => !a || String(a) === String(b);
  const opts = items.filter((x) => ok(t, x.typeId) && ok(m, x.makeId) && ok(e, x.endId) && ok(c, x.connId));
  if (!opts.length) return null;

  // A reducing pick reads '1/2" x 1/8"', but older rows keep only the RUN in `size` and the
  // pair in `rdims`. The pair is the more specific match, so it is tried first.
  let hits = opts.filter((o) => o.rdims && sizeKey(o.rdims) === want);
  if (!hits.length) hits = opts.filter((o) => sizeKey(o.size) === want);
  // Still nothing: compare the sizes as NUMBERS. '1-1/2"', '1 1/2 in' and '1.5' are one size
  // written three ways, and no amount of string cleaning makes the third equal the first.
  // This is arithmetic, not fuzziness — it cannot match one size to a different one.
  if (!hits.length) {
    const n = npsNum(f.size);
    if (n) hits = opts.filter((o) => npsNum(o.size) === n);
  }
  const sch = sizeKey(f.schedule_or_class || f.schedule);
  if (hits.length > 1 && sch) {
    const narrowed = hits.filter((o) => sizeKey(o.sched).indexOf(sch) > -1);
    if (narrowed.length) hits = narrowed;
  }
  return hits.length === 1 ? hits[0] : null;
}

module.exports = { resolveCatalogIds, matchDetailRow, resolveName, NO_MATCH, idByName, sizeKey, npsNum, score };
