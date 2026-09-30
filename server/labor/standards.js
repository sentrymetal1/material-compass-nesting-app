// =============================================================================
//  labor/standards.js — the fab labour standards library, and the one lookup.
// -----------------------------------------------------------------------------
//  WHY THIS LIVES ON RAILWAY AND NOT IN A ZOHO FORM (decided 2026-09-30).
//  The standards are the same for every tenant — reference data, like the
//  fittings catalog. In Zoho every take-off would spend API calls just reading
//  them; here the read is free. Only the RESULT (hours per component) is ever
//  written to Zoho, into Project_Labor_Details_Form.
//
//  SOURCE: fab_labor_standards.csv, a copy of Fab_Labor_Standards_SEED_v2.csv
//  from MaterialCompass_Imports (the 2026-09-26 audit). Every row carries a
//  Source_Ref back to a page of "Structural Fabrication Model for Labor Hours".
//
//  THE TWO RULES THIS FILE ENFORCES
//   1. Only Value_Kind = 'Hours' rows are hours. The other 15 rows are
//      multipliers, sq ft per ton, and bundled 1997 dollars. Read as hours they
//      either vanish (multipliers written as 0) or inflate a job by thousands
//      of hours (250 sq ft/ton in an Hr/Ton column). They are loaded and kept
//      visible, but resolve() never returns one.
//   2. No match is NOT zero. resolve() returns { missing: reason } and the
//      caller must surface it. A missing standard that quietly returns 0 is a
//      confident, wrong, low bid — the same failure as a blank Weight_Per_Ft.
//
//  SHOP OVERRIDES. A tenant's own anchors (the shop labour form, step 2) are
//  passed in as extra rows and are tried FIRST. The library is the default,
//  never the authority over a shop's own number.
// =============================================================================
const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, 'fab_labor_standards.csv');

// The 8 hour fields on Project_Labor_Details_Form (and the WO labour forms). 8, not 7 — Assy is
// the one that gets missed.
const BUCKETS = ['Cutting_Hrs', 'CNC_Hrs', 'Assy_Hrs', 'Fab_Hrs', 'Weld_Hrs', 'Labor_Hrs', 'Inspection_Hrs', 'Misc_Hrs'];

// Where each library category lands. Grinding goes with welding and layout with fabricate, per the
// labour-type review of 2026-08-03 ("do NOT add Layout (-> Fabricate) ... Grinding (-> Weld)").
// Blast/Paint and Detailing have no labour field of their own yet, so they fall to Misc until the
// Finish / Detailing types are added. Galvanize is OUTSOURCED work and never becomes shop hours.
const CATEGORY_BUCKET = {
  'Cutting': 'Cutting_Hrs',
  'Coping/Blocking': 'Cutting_Hrs',
  'Drilling/Punching': 'Fab_Hrs',
  'Layout': 'Fab_Hrs',
  'Forming': 'Fab_Hrs',
  'Fitup': 'Assy_Hrs',
  'Assembly': 'Assy_Hrs',
  'Welding': 'Weld_Hrs',
  'Grinding/Finishing': 'Weld_Hrs',
  'Handling': 'Labor_Hrs',
  'Loading': 'Labor_Hrs',
  'Blast/Paint': 'Misc_Hrs',
  'Detailing': 'Misc_Hrs',
  'Galvanize': null,
};

// When two rows are equally specific, the shop's own layers win over the 1962 industry standard,
// and a measured actual wins over everything.
const SOURCE_RANK = {
  'Shop Actual': 0,
  'Shop Anchor': 1,
  'Sentry 1997 Rate Sheet': 2,
  'Sentry Handwritten': 3,
  '1962 Std 0.1.3': 4,
  '1962 Std 0.1.6': 4,
  'Industry Published': 5,
};

// ── CSV ──────────────────────────────────────────────────────────────────────
// Quoted fields contain commas ("Range 4.25-4.75 hr/cwt. Sentry 1997 alt: ..."), so this is a real
// parser, not a split(',').
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Throws rather than loading a library it cannot trust. A duplicate code or an 'Hours' row with
// no number is a data error that would otherwise surface as a wrong estimate months later.
function normalise(raw) {
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const code = String(r.Standard_Code || '').trim();
    if (!code) continue;
    if (seen.has(code)) throw new Error('labor standards: duplicate Standard_Code ' + code);
    seen.add(code);
    const kind = String(r.Value_Kind || '').trim();
    const hours = num(r.Hours_Per_Unit);
    if (kind === 'Hours' && !(hours > 0)) throw new Error('labor standards: ' + code + ' is Value_Kind Hours with no hours');
    if (kind !== 'Hours' && hours != null && hours !== 0) {
      throw new Error('labor standards: ' + code + ' is Value_Kind ' + kind + ' but carries ' + hours + ' in Hours_Per_Unit');
    }
    out.push({
      code,
      category: String(r.Operation_Category || '').trim(),
      operation: String(r.Operation || '').trim(),
      process: String(r.Process || '').trim() || 'N/A',
      form: String(r.Applies_To_Form_Type || '').trim() || 'Any',
      material: String(r.Material_Type || '').trim() || 'Any',
      sizeBasis: String(r.Size_Basis || '').trim() || 'N/A',
      sizeMin: num(r.Size_Min),
      sizeMax: num(r.Size_Max),
      complexity: String(r.Complexity || '').trim() || 'N/A',
      weldmentClass: String(r.Weldment_Class || '').trim() || 'N/A',
      unitBasis: String(r.Unit_Basis || '').trim(),
      hours: kind === 'Hours' ? hours : null,
      kind,
      value: num(r.Value),
      source: String(r.Source || '').trim(),
      sourceRef: String(r.Source_Ref || '').trim(),
      notes: String(r.Notes || '').trim(),
    });
  }
  return out;
}

function loadFromText(text) {
  const rows = parseCsv(text).filter((r) => r.length > 1);
  const head = rows[0].map((h) => h.trim());
  return normalise(rows.slice(1).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]]))));
}

let LIBRARY = null;
function library() {
  if (!LIBRARY) LIBRARY = loadFromText(fs.readFileSync(CSV_PATH, 'utf8'));
  return LIBRARY;
}

// ── VOCABULARY: take-off names → library names ───────────────────────────────
// The take-off emits sub-typed catalog names ('Beam - W', 'Channel - MC'); the library was written
// against the parent families. Anything not listed maps to itself and will simply find no rows,
// which comes back as missing — correct, since e.g. tube has no standard in the seed.
const FORM_MAP = {
  'Beam - W': 'Beam', 'Beam - I': 'Beam', 'Beam - S': 'Beam', 'Beam - HP': 'Beam',
  'Beam - WT': 'Tee', 'Tee': 'Tee',
  'Channel': 'Channel', 'Channel - MC': 'Channel',
  'Angle': 'Angle',
  'Plate': 'Plate', 'Tread Plate': 'Plate', 'Sheet': 'Plate',
  'Pipe': 'Pipe',
  'Tube - Square': 'Tube', 'Tube - Round': 'Tube', 'Tube - Rectangle': 'Tube',
  'Bar - Flat': 'Bar', 'Bar - Round': 'Bar', 'Bar - Square': 'Bar', 'Bar - Hex': 'Bar',
};
function libraryForm(formType) {
  const f = String(formType || '').trim();
  return FORM_MAP[f] || f;
}

// Stainless needs the grade to pick a row, and the take-off carries it in the specification.
function libraryMaterial(materialType, specification) {
  const m = String(materialType || '').trim().toLowerCase();
  const spec = String(specification || '');
  if (m.indexOf('stainless') > -1) return /316/.test(spec) ? '316/316L SS' : '304/304L SS';
  if (m.indexOf('aluminum') > -1 || m.indexOf('aluminium') > -1) return 'Aluminum';
  if (m.indexOf('carbon') > -1) return 'Carbon Steel';   // galvanized is a finish, not a material
  return String(materialType || '').trim();
}

// ── THE LOOKUP ───────────────────────────────────────────────────────────────
//   q = { category, operation (exact string or RegExp), process, form, material,
//         size: { 'Member Depth (in)': 12, 'Plate Thickness (in)': 0.5, ... },
//         weldmentClass }
//   opts = { overrides: [shop rows, same shape as library rows] }
// Returns { row, bucket, alternatives } or { missing: reason }.
function resolve(q, opts) {
  const pool = [].concat((opts && opts.overrides) || [], library());
  const opMatch = (row) => q.operation instanceof RegExp ? q.operation.test(row.operation)
    : !q.operation || row.operation === q.operation;
  const anyOr = (rowVal, want) => rowVal === 'Any' || rowVal === 'N/A' || !want || rowVal === want;

  const candidates = [];
  for (const row of pool) {
    if (row.kind !== 'Hours' || !(row.hours > 0)) continue;
    if (q.category && row.category !== q.category) continue;
    if (!opMatch(row)) continue;
    if (!anyOr(row.process, q.process)) continue;
    if (!anyOr(row.form, q.form)) continue;
    if (!anyOr(row.material, q.material)) continue;
    if (q.weldmentClass && !anyOr(row.weldmentClass, q.weldmentClass)) continue;
    // A banded row needs the size it is banded on. Inclusive of min, exclusive of max.
    if (row.sizeBasis !== 'N/A' && (row.sizeMin != null || row.sizeMax != null)) {
      const s = q.size && q.size[row.sizeBasis];
      if (!(s > 0)) continue;
      if (row.sizeMin != null && s < row.sizeMin) continue;
      if (row.sizeMax != null && s >= row.sizeMax) continue;
    }
    // Specificity: an exact form or material beats 'Any'; a shop row beats the library.
    let score = 0;
    if (q.form && row.form === q.form) score += 4;
    if (q.material && row.material === q.material) score += 2;
    if (q.process && row.process === q.process) score += 1;
    candidates.push({ row, score, rank: SOURCE_RANK[row.source] != null ? SOURCE_RANK[row.source] : 9 });
  }

  if (!candidates.length) {
    const what = [q.category, q.operation instanceof RegExp ? q.operation.source : q.operation, q.form, q.material]
      .filter(Boolean).join(' / ');
    return { missing: 'no labour standard for ' + what + (q.size ? ' at ' + JSON.stringify(q.size) : '') };
  }
  candidates.sort((a, b) => (b.score - a.score) || (a.rank - b.rank) || (b.row.hours - a.row.hours));
  const best = candidates[0].row;
  const bucket = Object.prototype.hasOwnProperty.call(CATEGORY_BUCKET, best.category) ? CATEGORY_BUCKET[best.category] : 'Misc_Hrs';
  if (bucket == null) return { missing: best.code + ' is outsourced work (' + best.category + '), not shop hours' };
  return { row: best, bucket, alternatives: candidates.length - 1 };
}

// The non-hours rows, for the screens that need to show them as what they are.
function nonHoursRows() {
  return library().filter((r) => r.kind !== 'Hours');
}

module.exports = {
  resolve, library, loadFromText, nonHoursRows, libraryForm, libraryMaterial,
  BUCKETS, CATEGORY_BUCKET, SOURCE_RANK, FORM_MAP,
};
