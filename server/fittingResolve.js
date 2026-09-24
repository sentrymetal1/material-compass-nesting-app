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

function aliasFor(kind, name) {
  const map = (ALIAS_SEED && ALIAS_SEED[kind]) || {};
  const hit = map[norm(name)];
  return hit ? txt(hit) : '';
}

// Exact, then alias, then normalised-and-unambiguous.
function idByName(list, name, kind) {
  const v = txt(name);
  if (!v || !Array.isArray(list) || !list.length) return '';
  const exact = list.find((o) => txt(o.name) === v);
  if (exact) return String(exact.id);

  const al = kind ? aliasFor(kind, v) : '';
  if (al) {
    const viaAlias = list.find((o) => txt(o.name) === al) ||
                     list.filter((o) => norm(o.name) === norm(al));
    if (viaAlias && !Array.isArray(viaAlias)) return String(viaAlias.id);
    if (Array.isArray(viaAlias) && viaAlias.length === 1) return String(viaAlias[0].id);
  }

  const loose = list.filter((o) => norm(o.name) === norm(v));
  if (loose.length === 1) return String(loose[0].id);
  return NO_MATCH;          // set, and either unknown or ambiguous
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
function resolveCatalogIds(f, catalog) {
  const cat = catalog || {};
  const ids = {}, unresolved = [];
  const take = (field, value, label) => {
    if (value && value !== NO_MATCH) { ids[field] = value; return value; }
    if (value === NO_MATCH) unresolved.push(label);
    return '';
  };

  const typeId = txt(f.fitting_type_id) ||
    take('fitting_type_id', idByName(cat.types, f.fitting_type, 'type'), 'fitting type "' + txt(f.fitting_type) + '"');
  if (txt(f.fitting_type_id)) ids.fitting_type_id = txt(f.fitting_type_id);

  const makeId = txt(f.fitting_make_id) ||
    take('fitting_make_id', idByName(cat.makes, f.fitting_make, 'make'), 'make "' + txt(f.fitting_make) + '"');
  if (txt(f.fitting_make_id)) ids.fitting_make_id = txt(f.fitting_make_id);

  // Scoped to the type. No children for this type → left blank on purpose.
  if (txt(f.end_type_id)) ids.end_type_id = txt(f.end_type_id);
  else if (txt(f.end_type) && typeId) {
    const kids = childrenOf(cat.ends, 'typeId', typeId);
    if (kids.length) take('end_type_id', idByName(kids, f.end_type, 'end'), 'end type "' + txt(f.end_type) + '"');
  }

  if (txt(f.connection_type_id)) ids.connection_type_id = txt(f.connection_type_id);
  else if (txt(f.connection_type) && typeId) {
    const kids = childrenOf(cat.connections, 'typeId', typeId);
    if (kids.length) take('connection_type_id', idByName(kids, f.connection_type, 'connection'), 'connection "' + txt(f.connection_type) + '"');
  }

  // Specifications hang off the MAKE, not the type.
  if (txt(f.specification_id)) ids.specification_id = txt(f.specification_id);
  else if (txt(f.specification) && makeId) {
    const kids = childrenOf(cat.specs, 'makeId', makeId);
    if (kids.length) take('specification_id', idByName(kids, f.specification), 'specification "' + txt(f.specification) + '"');
  }

  return { ids: ids, unresolved: unresolved, blocked: !txt(ids.fitting_type_id) };
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
  const sch = sizeKey(f.schedule_or_class || f.schedule);
  if (hits.length > 1 && sch) {
    const narrowed = hits.filter((o) => sizeKey(o.sched).indexOf(sch) > -1);
    if (narrowed.length) hits = narrowed;
  }
  return hits.length === 1 ? hits[0] : null;
}

module.exports = { resolveCatalogIds, matchDetailRow, NO_MATCH, idByName, sizeKey };
