// =============================================================================
//  triageScope.js — "What this quote includes": the scope pills on Quote Triage.
// -----------------------------------------------------------------------------
//  Mark (2026-11-10): give the estimator pills for what a quote includes so it is harder to forget
//  something, let the AI pre-set them from the note / email / drawings, and let the user confirm.
//  EVERYTHING HERE IS OPTIONAL — a user may skip all of it. An unanswered pill is "not decided",
//  which is NOT the same as "no": it stays visible as a reminder and never blocks anything.
//
//  Stored shape (kept on the volume in quote-notes.json beside the "What to quote" note, keyed
//  'o:<opportunity>' / 'p:<project>' — no Zoho field, no Zoho call):
//    { items:  { material: { v: 'yes'|'no'|'', src: 'ai'|'user', why: '"Include material"' }, … },
//      finish: { type: 'none'|'blast_paint'|'galvanize'|'powder_coat'|'primer'|'', by: 'in_house'|'outside'|'',
//                src, why } }
// =============================================================================

const SCOPE_ITEMS = [
  { key: 'material',      label: 'Material',      printed: 'material' },
  { key: 'fittings',      label: 'Fittings',      printed: 'fittings' },
  { key: 'fabrication',   label: 'Fabrication',   printed: 'shop fabrication' },
  { key: 'welding',       label: 'Welding',       printed: 'welding' },
  { key: 'delivery',      label: 'Delivery',      printed: 'delivery' },
  { key: 'installation',  label: 'Installation',  printed: 'field installation' },
  { key: 'shop_drawings', label: 'Shop drawings', printed: 'shop drawings' },
  { key: 'field_measure', label: 'Field measure', printed: 'field measuring' },
];

const FINISH_TYPES = [
  { key: 'none',        label: 'No finish' },
  { key: 'blast_paint', label: 'Blast & paint' },
  { key: 'galvanize',   label: 'Galvanize' },
  { key: 'powder_coat', label: 'Powder coat' },
  { key: 'primer',      label: 'Primer only' },
];
const FINISH_BY = [
  { key: 'in_house', label: 'In house' },
  { key: 'outside',  label: 'Outside' },
];

const ITEM_KEYS = SCOPE_ITEMS.map(i => i.key);
const FINISH_KEYS = FINISH_TYPES.map(f => f.key);
const BY_KEYS = FINISH_BY.map(b => b.key);

// The extraction rule added to the triage prompt. Explicit words only — a pill the text does not
// speak to stays not_mentioned, because a guessed "included" is worse than an honest blank.
const SCOPE_PROMPT_RULE =
  "- scope = what the requester wants INCLUDED in the price, read ONLY from explicit words. " +
  "'include material' / 'furnish' -> material included; 'material by others' / 'customer furnished' -> material excluded. " +
  "'elbows', 'fittings', 'flanges' to be included -> fittings included. 'fabricate' -> fabrication included. " +
  "'weld', 'welded', 'fabrication and welding' -> welding included; 'bolted only', 'no welding' -> welding excluded. " +
  "'install', 'erect', 'furnish and install' -> installation included; 'furnish only', 'install by others' -> installation excluded. " +
  "'delivered', 'deliver to site' -> delivery included; 'F.O.B. shop', 'will pick up' -> delivery excluded. " +
  "'shop drawings', 'submittals' required -> shop_drawings included. 'field verify', 'field measure' by us -> field_measure included. " +
  "finish: 'galvanized' / 'HDG' -> galvanize, and finish_by outside (hot-dip is done by a galvanizer) unless the text says in house; " +
  "'painted', 'shop prime and paint' -> blast_paint; 'primed' -> primer; 'powder coated' -> powder_coat; 'no finish', 'mill finish', 'bare' -> none. " +
  "For every value you set, put the exact short words it came from in evidence under the same key. " +
  "Anything the material does not state is not_mentioned — never guess from what is usual.\n";

const TRI = ['included', 'excluded', 'not_mentioned'];
const SCOPE_SCHEMA = {
  type: 'object',
  description: 'what the quote should include, from explicit words only; not_mentioned when the material is silent',
  properties: Object.assign(
    {},
    ...ITEM_KEYS.map(k => ({ [k]: { type: 'string', enum: TRI } })),
    {
      finish:    { type: 'string', enum: FINISH_KEYS.concat(['not_mentioned']) },
      finish_by: { type: 'string', enum: BY_KEYS.concat(['not_mentioned']) },
      evidence:  {
        type: 'object',
        description: 'for each key set above (including finish), the exact short words it was read from',
        additionalProperties: { type: 'string' },
      },
    }
  ),
};

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function emptyScope() {
  const items = {};
  ITEM_KEYS.forEach(k => { items[k] = { v: '', src: '', why: '' }; });
  return { items, finish: { type: '', by: '', src: '', why: '' } };
}

// What the AI returned -> stored shape. Anything unrecognised becomes "not decided".
function fromAi(raw) {
  const s = emptyScope();
  if (!raw || typeof raw !== 'object') return s;
  const ev = (raw.evidence && typeof raw.evidence === 'object') ? raw.evidence : {};
  ITEM_KEYS.forEach(k => {
    const v = raw[k] === 'included' ? 'yes' : raw[k] === 'excluded' ? 'no' : '';
    if (v) s.items[k] = { v, src: 'ai', why: clip(ev[k], 120) };
  });
  if (FINISH_KEYS.indexOf(raw.finish) >= 0) {
    s.finish.type = raw.finish; s.finish.src = 'ai'; s.finish.why = clip(ev.finish || ev.finish_by, 120);
  }
  if (BY_KEYS.indexOf(raw.finish_by) >= 0) { s.finish.by = raw.finish_by; s.finish.src = s.finish.src || 'ai'; }
  return s;
}

// Whatever the page posted -> stored shape. Never trusts the client for anything but the values.
function sanitize(input) {
  const s = emptyScope();
  if (!input || typeof input !== 'object') return s;
  const items = input.items && typeof input.items === 'object' ? input.items : {};
  ITEM_KEYS.forEach(k => {
    const it = items[k] || {};
    const v = it.v === 'yes' || it.v === 'no' ? it.v : '';
    if (v) s.items[k] = { v, src: it.src === 'ai' ? 'ai' : 'user', why: clip(it.why, 120) };
  });
  const f = input.finish && typeof input.finish === 'object' ? input.finish : {};
  if (FINISH_KEYS.indexOf(f.type) >= 0) s.finish.type = f.type;
  if (BY_KEYS.indexOf(f.by) >= 0) s.finish.by = f.by;
  if (s.finish.type || s.finish.by) { s.finish.src = f.src === 'ai' ? 'ai' : 'user'; s.finish.why = clip(f.why, 120); }
  return s;
}

// The user's answers win; the AI only fills what the user left undecided.
function merge(user, ai) {
  const u = sanitize(user), a = sanitize(ai), out = emptyScope();
  ITEM_KEYS.forEach(k => { out.items[k] = u.items[k].v ? u.items[k] : a.items[k]; });
  out.finish = {
    type: u.finish.type || a.finish.type,
    by: u.finish.by || a.finish.by,
    src: (u.finish.type || u.finish.by) ? 'user' : a.finish.src,
    why: (u.finish.type || u.finish.by) ? u.finish.why : a.finish.why,
  };
  return out;
}

function isBlank(scope) {
  const s = sanitize(scope);
  return ITEM_KEYS.every(k => !s.items[k].v) && !s.finish.type && !s.finish.by;
}

// The scope in words, for the AI take-off's "What to quote" brief and, later, the customer quote's
// Includes / Excludes lines. '' when nothing was decided.
function toText(scope) {
  if (!scope || isBlank(scope)) return '';
  const s = sanitize(scope);
  const inc = [], exc = [], open = [];
  SCOPE_ITEMS.forEach(it => {
    const v = s.items[it.key].v;
    (v === 'yes' ? inc : v === 'no' ? exc : open).push(it.printed);
  });
  const ft = FINISH_TYPES.find(f => f.key === s.finish.type);
  if (ft && ft.key === 'none') exc.push('finish (bare steel)');
  else if (ft) inc.push(ft.label.toLowerCase() + (s.finish.by === 'outside' ? ' (by an outside vendor)' : s.finish.by === 'in_house' ? ' (in house)' : ''));
  else open.push('finish');
  const parts = [];
  if (inc.length) parts.push('Includes: ' + inc.join(', ') + '.');
  if (exc.length) parts.push('Excludes: ' + exc.join(', ') + '.');
  if (open.length) parts.push('Not decided yet: ' + open.join(', ') + '.');
  return 'SCOPE (from triage): ' + parts.join(' ');
}

// An opportunity's Extracted_JSON -> the AI's scope. Email rows carry the extraction at the top
// level; manual rows nest it under .extraction. null when the row predates scope.
function fromExtractedJson(json) {
  try {
    const j = typeof json === 'string' ? JSON.parse(json || '{}') : (json || {});
    const raw = j.scope || (j.extraction && j.extraction.scope);
    if (!raw) return null;
    const s = fromAi(raw);
    return isBlank(s) ? null : s;
  } catch (e) { return null; }
}

module.exports = {
  SCOPE_ITEMS, FINISH_TYPES, FINISH_BY, SCOPE_SCHEMA, SCOPE_PROMPT_RULE,
  emptyScope, fromAi, sanitize, merge, isBlank, toText, fromExtractedJson,
};
