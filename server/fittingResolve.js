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
//
// THE SIZE IS THE LEADING TOKEN AND NOTHING ELSE. The catalog writes a butt-weld size as
// '2-1/2" (2.875 OD)', so an anchored-to-end pattern never fires and parseFloat is left to read
// '2-1/2 (2.875 OD)' as 2 — which silently makes a 2-1/2" fitting equal to a 2" one. Wrong size,
// wrong weight, and nothing on screen to say so. So: match the leading size, allow anything
// after it, and check the fraction forms BEFORE the plain number.
function npsNum(s) {
  const v = txt(s).replace(/["”]/g, ' ').replace(/inch(es)?\b|\bin\b/gi, ' ').trim();
  const mixed = v.match(/^(\d+)\s*[-\s]\s*(\d+)\s*\/\s*(\d+)/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = v.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const dec = v.match(/^(\d+(?:\.\d+)?)/);
  return dec ? Number(dec[1]) : 0;
}

// A schedule or class, reduced to the part that identifies it.
//
// The two sides never write these the same way. A take-off says 'SCH 40', 'Schedule 40',
// 'Class 150'; the catalog says '40 (0.154")', 'STD (0.133")', '3000 PSI'. The wall thickness
// in parentheses is a DESCRIPTION of the schedule, not part of its name, and two different
// schedules can carry the same wall — so it is dropped rather than compared.
function schedKey(s) {
  return txt(s)
    .replace(/\([^)]*\)/g, ' ')                       // the wall thickness, which is not the name
    .replace(/\b(sch|schedule|class|cl)\b\.?/gi, ' ') // the word, which only one side writes
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim().toLowerCase();
}

// Same schedule? Equal after normalising, or one is a whole token of the other — '3000' matches
// '3000 psi', but '40' never matches '140'.
function sameSched(a, b) {
  const A = schedKey(a), B = schedKey(b);
  if (!A || !B) return false;
  if (A === B) return true;
  const ta = A.split(' ').filter(Boolean), tb = B.split(' ').filter(Boolean);
  return ta.every((w) => tb.indexOf(w) > -1) || tb.every((w) => ta.indexOf(w) > -1);
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
// The rows still standing after every filter. matchDetailRow adopts one of these or refuses;
// a caller that is about to CREATE a row wants to know the difference between "nothing like
// this exists" (create it) and "several rows fit and they are not the same fitting" (do not —
// ask). Creating in the second case adds a near-duplicate to a catalog that already has too many.
function detailCandidates(f, items) {
  return narrow(f, items).hits;
}

function matchDetailRow(f, items) {
  return narrow(f, items).hit;
}

function narrow(f, items) {
  const none = { hit: null, hits: [] };
  if (!Array.isArray(items) || !items.length) return none;
  const want = sizeKey(f.size);
  if (!want) return none;

  // A name set but unresolved must narrow to nothing, so it is carried as NO_MATCH.
  const constrain = (idVal, nameVal) => (txt(idVal) ? txt(idVal) : (txt(nameVal) ? NO_MATCH : ''));
  const t = constrain(f.fitting_type_id, f.fitting_type);
  const m = constrain(f.fitting_make_id, f.fitting_make);
  const e = constrain(f.end_type_id, f.end_type);
  const c = constrain(f.connection_type_id, f.connection_type);
  if ([t, m, e, c].indexOf(NO_MATCH) > -1) return none;

  const ok = (a, b) => !a || String(a) === String(b);
  const opts = items.filter((x) => ok(t, x.typeId) && ok(m, x.makeId) && ok(e, x.endId) && ok(c, x.connId));
  if (!opts.length) return none;

  // A reducing pick reads '1/2" x 1/8"', but older rows keep only the RUN in `size` and the
  // pair in `rdims`. The pair is the more specific match, so it is tried first.
  let hits = opts.filter((o) => o.rdims && sizeKey(o.rdims) === want);

  // ── A PAIR ASKED FOR IS A PAIR REQUIRED ─────────────────────────────────────────────────
  // '3" x 1-1/2"' names both ends of a reducing fitting. Falling through to the run size
  // alone returns every 3" bushing in the catalog — 3" x 3/4", x 1", x 1-1/4", x 2",
  // x 2-1/2" — and reports them as five rows that 'fit'. Not one of them fits: they are five
  // different parts, and putting them in front of an estimator invites a wrong pick that the
  // quote then carries. (3" x 1-1/2" is simply not in the malleable bushing range; the
  // catalog skips from x 1-1/4" to x 2".)
  //
  // The pair is written in `rdims` on 1,292 rows, in `size` on 98 more and in `label` on a
  // handful, so all three are read. When none of them carries it the honest answer is that it
  // is not in the catalog — and that is the answer that lets the commit create it, rather than
  // an ambiguity that stops everything.
  const wantsPair = /[0-9]x/.test(want);   // sizeKey turns '3" x 1-1/2"' into '3x1-1/2'
  if (!hits.length && wantsPair) {
    const seen = {};
    hits = opts
      .filter((o) => sizeKey(o.size) === want ||
                     sizeKey(String(o.label || '').split('|')[0]) === want)
      .filter((o) => (seen[o.id] ? false : (seen[o.id] = 1)));
    if (!hits.length) return none;
  } else if (!hits.length) {
    // BOTH size tests, and their UNION — not one then the other. The two tables write a size
    // differently ('1-1/4"' vs '1-1/4" (1.660 OD)'), so taking the string matches and stopping
    // there silently drops every row from the other table. That is how a Swage nipple asked for
    // in SCH STD came back as the 3000 LB row: the only string match was the wrong one, the
    // schedule filter then matched nothing, and the fallback handed that row back anyway.
    const n = npsNum(f.size);
    const byString = opts.filter((o) => sizeKey(o.size) === want);
    const byNumber = n ? opts.filter((o) => npsNum(o.size) === n) : [];
    const seen = {};
    hits = byString.concat(byNumber).filter((o) => (seen[o.id] ? false : (seen[o.id] = 1)));
  }
  if (!hits.length) return none;

  // The schedule or class decides between same-size rows. This is where most of the matching
  // actually happens: a 2" carbon steel butt-weld elbow has 73 rows behind it and they differ
  // only here.
  const sch = f.schedule_or_class || f.schedule;
  if (txt(sch)) {
    const narrowed = hits.filter((o) => sameSched(o.sched, sch));
    // The size exists but not in this schedule. That is a MISS, not a reason to fall back to a
    // row in some other schedule — the fitting needs a row of its own.
    if (!narrowed.length) return none;
    hits = narrowed;
  }
  if (hits.length === 1) return { hit: hits[0], hits: hits };

  // ── DUPLICATES ARE NOT AMBIGUITY ────────────────────────────────────────────────────────
  // The catalog carries the same fitting more than once — a 10" 80S stainless cap is in there
  // twice, identical and both 9.5 lb, and a 24" 150 LB blind flange ten times. Refusing those
  // means the commit creates an ELEVENTH. When the rows are interchangeable — same size, same
  // schedule, same reducing dimensions, same weight — any of them is the right answer, so take
  // the lowest id and take it consistently, so the same fitting lands on the same row every time.
  //
  // Rows that genuinely DIFFER are still refused. A reducing tee whose outlet size is unknown
  // is a real question, and answering it by picking one is how a quote gets the wrong part.
  const first = hits[0];
  const same = hits.every((o) =>
    npsNum(o.size) === npsNum(first.size) &&
    schedKey(o.sched) === schedKey(first.sched) &&
    sizeKey(o.rdims || '') === sizeKey(first.rdims || '') &&
    ((o.weight == null && first.weight == null) || Number(o.weight) === Number(first.weight)));
  if (!same) return { hit: null, hits: hits };
  return { hit: hits.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))[0], hits: hits };
}

module.exports = { resolveCatalogIds, matchDetailRow, detailCandidates, resolveName, NO_MATCH,
  idByName, sizeKey, npsNum, schedKey, sameSched, score };
