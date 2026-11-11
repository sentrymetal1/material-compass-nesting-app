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
  { key: 'grating',       label: 'Grating',       printed: 'grating' },
  { key: 'fasteners',     label: 'Fasteners',     printed: 'fasteners' },
  { key: 'anchor_bolts',  label: 'Anchor bolts',  printed: 'anchor bolts' },
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

// ---- "How it gets made" — the drill-down shown on the AI Take-off page (Mark 2026-11-10) ----
// Each option is one of:
//   where — In house / Outside / Not needed   (values 'in' | 'out' | 'no')
//   yes   — Yes / No                          (values 'yes' | 'no')
// plus a few single picks (welding process, weld code, blast grade). Blank = not decided.
// Job-wide for now; a per-component override belongs on the labor step later.
const OPS_GROUPS = [
  { key: 'cutting', label: 'Cutting', options: [
    { key: 'cut_saw', label: 'Saw', kind: 'where' },
    { key: 'cut_cnc_plasma', label: 'CNC plasma', kind: 'where' },
    { key: 'cut_torch', label: 'Torch (oxy-fuel)', kind: 'where' },
    { key: 'cut_laser', label: 'Laser', kind: 'where' },
    { key: 'cut_waterjet', label: 'Waterjet', kind: 'where' },
    { key: 'cut_shear', label: 'Shear', kind: 'where' },
    { key: 'cut_buy_to_size', label: 'Buy cut to size', kind: 'yes' },
  ] },
  { key: 'holes', label: 'Holes', options: [
    { key: 'hole_drill', label: 'Drill', kind: 'where' },
    { key: 'hole_punch', label: 'Punch', kind: 'where' },
    { key: 'hole_cnc_drill', label: 'CNC drill line', kind: 'where' },
    { key: 'hole_tap', label: 'Tap', kind: 'where' },
    { key: 'hole_vent_drain', label: 'Vent & drain holes (galvanizing)', kind: 'yes' },
  ] },
  { key: 'ends', label: 'Pipe & tube ends', options: [
    { key: 'end_notch', label: 'Notch', kind: 'where' },
    { key: 'end_cope', label: 'Cope', kind: 'where' },
    { key: 'end_miter', label: 'Miter', kind: 'where' },
    { key: 'end_bevel', label: 'Bevel for weld', kind: 'where' },
  ] },
  { key: 'forming', label: 'Forming', options: [
    { key: 'form_brake', label: 'Brake / bend', kind: 'where' },
    { key: 'form_roll', label: 'Roll', kind: 'where' },
    { key: 'form_pipe_bend', label: 'Pipe bending (goosenecks, returns)', kind: 'where' },
  ] },
  { key: 'welding', label: 'Welding', picks: ['weld_process', 'weld_code'], options: [
    { key: 'weld_fillet', label: 'Fillet welds', kind: 'yes' },
    { key: 'weld_cjp', label: 'Full penetration (CJP)', kind: 'yes' },
    { key: 'weld_stitch', label: 'Stitch / seal welds', kind: 'yes' },
    { key: 'weld_grind_smooth', label: 'Grind welds smooth (handrail)', kind: 'yes' },
  ] },
  { key: 'prep', label: 'Surface prep', picks: ['blast'], options: [
    { key: 'prep_grind_deburr', label: 'Grind & deburr', kind: 'where' },
  ] },
  { key: 'inspection', label: 'Inspection', options: [
    { key: 'insp_visual', label: 'Visual', kind: 'yes' },
    { key: 'insp_cwi', label: 'CWI inspection', kind: 'where' },
    { key: 'insp_ndt', label: 'NDT (UT / MT)', kind: 'where' },
    { key: 'insp_mill_certs', label: 'Mill certs required', kind: 'yes' },
  ] },
  { key: 'assembly', label: 'Assembly & shipping', options: [
    { key: 'asm_shop_assemble', label: 'Shop assemble', kind: 'yes' },
    { key: 'asm_trial_fit', label: 'Trial fit', kind: 'yes' },
    { key: 'asm_match_mark', label: 'Match-mark', kind: 'yes' },
    { key: 'asm_ship_loose', label: 'Ship loose', kind: 'yes' },
  ] },
];
const OPS_PICKS = {
  weld_process: { label: 'Welding process', options: [
    { key: 'mig', label: 'MIG (GMAW)' }, { key: 'fcaw', label: 'Flux-core (FCAW)' },
    { key: 'smaw', label: 'Stick (SMAW)' }, { key: 'gtaw', label: 'TIG (GTAW)' } ] },
  weld_code: { label: 'Weld code', options: [
    { key: 'd1_1', label: 'AWS D1.1 structural' }, { key: 'd1_6', label: 'AWS D1.6 stainless' }, { key: 'none', label: 'No code' } ] },
  blast: { label: 'Blast', options: [
    { key: 'none', label: 'No blast' }, { key: 'sp6', label: 'SP6 commercial' }, { key: 'sp10', label: 'SP10 near-white' } ] },
};
const OPS_OPTIONS = [].concat(...OPS_GROUPS.map(g => g.options));
const OPS_KIND = Object.fromEntries(OPS_OPTIONS.map(o => [o.key, o.kind]));
const VALID_OP = { where: ['in', 'out', 'no'], yes: ['yes', 'no'] };

// What a pick starts at when nobody has chosen. Mark (2026-11-10): welding defaults to MIG — that is
// how Sentry welds — "but in the future we may want other users to pick what is default". So this is
// the platform fallback only; shopDefaults() is the seam where a per-shop setting will plug in.
const DEFAULT_PICKS = { weld_process: 'mig' };
function shopDefaults(/* manufactureId */) {
  // TODO per-shop: read the shop's own defaults (e.g. a Viking that sticks-welds) and spread over these.
  return { ...DEFAULT_PICKS };
}

const ITEM_KEYS = SCOPE_ITEMS.map(i => i.key);
const FINISH_KEYS = FINISH_TYPES.map(f => f.key);
const BY_KEYS = FINISH_BY.map(b => b.key);

// The extraction rule added to the triage prompt. Explicit words only — a pill the text does not
// speak to stays not_mentioned, because a guessed "included" is worse than an honest blank.
const SCOPE_PROMPT_RULE =
  "- scope = what the requester wants INCLUDED in the price, read ONLY from explicit words. " +
  "'include material' / 'furnish' -> material included; 'material by others' / 'customer furnished' -> material excluded. " +
  "'elbows', 'fittings', 'flanges' to be included -> fittings included. 'fabricate' -> fabrication included. " +
  "'grating', 'bar grating', 'grating treads' to be furnished -> grating included; 'grating by others' -> grating excluded. " +
  "'bolts', 'hardware', 'fasteners', 'connection bolts' to be furnished -> fasteners included; 'bolts by others/erector' -> fasteners excluded. " +
  "'anchor bolts', 'anchor rods' to be furnished -> anchor_bolts included; 'anchor rods by others', 'exclude anchor rods', 'by concrete contractor' -> anchor_bolts excluded. " +
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
  return { items, finish: { type: '', by: '', src: '', why: '' }, ops: {}, picks: {} };
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
  const ops = input.ops && typeof input.ops === 'object' ? input.ops : {};
  Object.keys(ops).forEach(k => {
    const kind = OPS_KIND[k];
    if (kind && VALID_OP[kind].indexOf(ops[k]) >= 0) s.ops[k] = ops[k];
  });
  const picks = input.picks && typeof input.picks === 'object' ? input.picks : {};
  Object.keys(OPS_PICKS).forEach(k => {
    if (OPS_PICKS[k].options.some(o => o.key === picks[k])) s.picks[k] = picks[k];
  });
  return s;
}

// The user's answers win; the AI only fills what the user left undecided.
// (The AI does not set the "how it gets made" options at triage — those are the user's.)
function merge(user, ai) {
  const u = sanitize(user), a = sanitize(ai), out = emptyScope();
  ITEM_KEYS.forEach(k => { out.items[k] = u.items[k].v ? u.items[k] : a.items[k]; });
  out.finish = {
    type: u.finish.type || a.finish.type,
    by: u.finish.by || a.finish.by,
    src: (u.finish.type || u.finish.by) ? 'user' : a.finish.src,
    why: (u.finish.type || u.finish.by) ? u.finish.why : a.finish.why,
  };
  out.ops = { ...a.ops, ...u.ops };
  out.picks = { ...a.picks, ...u.picks };
  return out;
}

function isBlank(scope) {
  const s = sanitize(scope);
  return ITEM_KEYS.every(k => !s.items[k].v) && !s.finish.type && !s.finish.by
    && !Object.keys(s.ops).length && !Object.keys(s.picks).length;
}

// The "how it gets made" choices in words. Defaults (e.g. MIG) are said, and said to be defaults.
function methodsText(scope, defaults) {
  const s = sanitize(scope);
  const d = defaults || {};
  const lines = [];
  const word = { in: 'in house', out: 'outside', yes: '', no: '' };
  OPS_GROUPS.forEach(g => {
    const done = [], notNeeded = [];
    (g.picks || []).forEach(pk => {
      const val = s.picks[pk] || d[pk];
      const opt = val && OPS_PICKS[pk].options.find(o => o.key === val);
      if (opt) done.push(opt.label + (s.picks[pk] ? '' : ' (shop default)'));
    });
    g.options.forEach(o => {
      const v = s.ops[o.key];
      if (!v) return;
      if (v === 'no') notNeeded.push(o.label.toLowerCase());
      else done.push(o.label.toLowerCase() + (word[v] ? ' (' + word[v] + ')' : ''));
    });
    if (!done.length && !notNeeded.length) return;
    lines.push(g.label + ': ' + [done.join(', '), notNeeded.length ? 'not needed: ' + notNeeded.join(', ') : '']
      .filter(Boolean).join('; ') + '.');
  });
  return lines.length ? 'HOW IT GETS MADE: ' + lines.join(' ') : '';
}

// The scope in words, for the AI take-off's "What to quote" brief and, later, the customer quote's
// Includes / Excludes lines. '' when nothing was decided.
function toText(scope, defaults) {
  const s = sanitize(scope);
  const methods = methodsText(s, defaults);
  const itemsSet = ITEM_KEYS.some(k => s.items[k].v) || s.finish.type || s.finish.by;
  if (!itemsSet) return methods;
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
  return 'SCOPE: ' + parts.join(' ') + (methods ? '\n' + methods : '');
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

// Everything a page needs to draw the pills and the drill-down — one source for both pages.
function definitions(manufactureId) {
  return { items: SCOPE_ITEMS, finish_types: FINISH_TYPES, finish_by: FINISH_BY,
           ops_groups: OPS_GROUPS, ops_picks: OPS_PICKS, defaults: shopDefaults(manufactureId) };
}

module.exports = {
  SCOPE_ITEMS, FINISH_TYPES, FINISH_BY, SCOPE_SCHEMA, SCOPE_PROMPT_RULE, OPS_GROUPS, OPS_PICKS, DEFAULT_PICKS,
  emptyScope, fromAi, sanitize, merge, isBlank, toText, methodsText, fromExtractedJson, shopDefaults, definitions,
};
