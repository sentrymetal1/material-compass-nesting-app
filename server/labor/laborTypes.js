// =============================================================================
//  labor/laborTypes.js — the two levels of shop labour, one list for everything.
// -----------------------------------------------------------------------------
//  BROAD (the 8 buckets the project and work-order labour subforms carry, with
//  hours, rate and amount) and DETAIL underneath (MIG, TIG, plasma, band saw…).
//  Agreed with Mark 2026-10-14: the subforms stay broad; detail is available
//  underneath — the take-off's estimate lines, and actual hours entered one row
//  per employee x day x component x labour type, which fills the matching broad
//  column. Estimate and actual use THESE codes, so "TIG quoted 40 h, worked 52 h"
//  lines up exactly. Same split Sentry's Access database used for 23 years
//  (33 job classes rolling into a few groups).
//
//  `zoho` is the text to use for the Labor_Type choice on the actual-hours form,
//  so a row typed in Zoho maps back to the same code.
// =============================================================================
const BUCKET_LABEL = {
  Cutting_Hrs: 'Cutting', CNC_Hrs: 'CNC', Assy_Hrs: 'Fit & assemble', Fab_Hrs: 'Fabrication',
  Weld_Hrs: 'Welding', Labor_Hrs: 'Handling / labor', Inspection_Hrs: 'Inspection', Misc_Hrs: 'Misc.',
};

const TYPES = [
  { code: 'CUT_BANDSAW',  bucket: 'Cutting_Hrs', label: 'Band saw' },
  { code: 'CUT_COLDSAW',  bucket: 'Cutting_Hrs', label: 'Cold saw' },
  { code: 'CUT_SHEAR',    bucket: 'Cutting_Hrs', label: 'Shear' },
  { code: 'CUT_PLASMA',   bucket: 'Cutting_Hrs', label: 'Plasma' },
  { code: 'CUT_OXY',      bucket: 'Cutting_Hrs', label: 'Oxy-fuel' },
  { code: 'CUT_LASER',    bucket: 'Cutting_Hrs', label: 'Laser' },
  { code: 'CUT_WATERJET', bucket: 'Cutting_Hrs', label: 'Waterjet' },
  { code: 'CUT_HANDLE',   bucket: 'Cutting_Hrs', label: 'Load / mark / unload' },
  { code: 'CNC_PROGRAM',  bucket: 'CNC_Hrs',     label: 'CNC programming' },
  { code: 'CNC_MACHINE',  bucket: 'CNC_Hrs',     label: 'CNC machining' },
  { code: 'FIT_LAYOUT',   bucket: 'Assy_Hrs',    label: 'Layout' },
  { code: 'FIT_TACK',     bucket: 'Assy_Hrs',    label: 'Fit & tack' },
  { code: 'FAB_GRIND',    bucket: 'Fab_Hrs',     label: 'Grinding' },
  { code: 'FAB_DRILL',    bucket: 'Fab_Hrs',     label: 'Drilling / punching' },
  { code: 'FAB_FORM',     bucket: 'Fab_Hrs',     label: 'Forming (brake, roll)' },
  { code: 'FAB_MACHINE',  bucket: 'Fab_Hrs',     label: 'Machining' },
  { code: 'WELD_MIG',     bucket: 'Weld_Hrs',    label: 'MIG' },
  { code: 'WELD_TIG',     bucket: 'Weld_Hrs',    label: 'TIG' },
  { code: 'WELD_STICK',   bucket: 'Weld_Hrs',    label: 'Stick' },
  { code: 'WELD_FCAW',    bucket: 'Weld_Hrs',    label: 'Flux-core' },
  { code: 'WELD_SAW',     bucket: 'Weld_Hrs',    label: 'Sub-arc' },
  { code: 'HANDLE',       bucket: 'Labor_Hrs',   label: 'Material handling' },
  { code: 'CLEANUP',      bucket: 'Labor_Hrs',   label: 'Clean up' },
  { code: 'LOADOUT',      bucket: 'Labor_Hrs',   label: 'Loading out' },
  { code: 'INSPECT',      bucket: 'Inspection_Hrs', label: 'Inspection' },
  { code: 'NDE',          bucket: 'Inspection_Hrs', label: 'Testing / NDE' },
  { code: 'MISC',         bucket: 'Misc_Hrs',    label: 'Other' },
];
for (const t of TYPES) t.zoho = BUCKET_LABEL[t.bucket] + ' - ' + t.label;   // "Welding - TIG"
const BY_CODE = Object.fromEntries(TYPES.map((t) => [t.code, t]));
// A line nobody has typed yet lands on the first type of its bucket that is not a specific machine.
const BUCKET_DEFAULT = { Cutting_Hrs: 'CUT_BANDSAW', CNC_Hrs: 'CNC_MACHINE', Assy_Hrs: 'FIT_TACK', Fab_Hrs: 'FAB_GRIND',
  Weld_Hrs: 'WELD_MIG', Labor_Hrs: 'HANDLE', Inspection_Hrs: 'INSPECT', Misc_Hrs: 'MISC' };

// processModel process key -> detail type.
const FROM_PROCESS = {
  MIG: 'WELD_MIG', TIG: 'WELD_TIG', STICK: 'WELD_STICK', FCAW: 'WELD_FCAW', SAW: 'WELD_SAW',
  PLASMA: 'CUT_PLASMA', PLASMA_H: 'CUT_PLASMA', OXY: 'CUT_OXY', OXY_H: 'CUT_OXY', LASER: 'CUT_LASER', WATERJET: 'CUT_WATERJET',
  BANDSAW: 'CUT_BANDSAW', COLDSAW: 'CUT_COLDSAW', SHEAR: 'CUT_SHEAR', IRONWORKER: 'CUT_SHEAR',
  BRAKE: 'FAB_FORM', ROLL: 'FAB_FORM', PUNCH: 'FAB_DRILL', DRILL: 'FAB_DRILL', MILL: 'FAB_MACHINE', LATHE: 'FAB_MACHINE',
  CNC_MILL: 'CNC_MACHINE', CNC_LATHE: 'CNC_MACHINE',
};

// The detail type for one estimate line: its process when it has one, then what the line says,
// then its bucket's default. Always a type whose bucket is the line's own bucket.
function typeForLine(l) {
  const bucket = l && l.bucket;
  const fits = (code) => code && BY_CODE[code] && BY_CODE[code].bucket === bucket ? code : null;
  if (l && fits(l.labor_type)) return l.labor_type;
  const what = String((l && l.what) || '').toLowerCase();
  // Handling around a cut is its own work even though the cutter's process is on the line.
  if (bucket === 'Cutting_Hrs' && /^load, mark/.test(what)) return 'CUT_HANDLE';
  return fits(FROM_PROCESS[l && l.process]) ||
    (bucket === 'Weld_Hrs' && /\btig\b/.test(what) ? 'WELD_TIG' : null) ||
    (bucket === 'Weld_Hrs' && /\bstick\b|\bsmaw\b/.test(what) ? 'WELD_STICK' : null) ||
    (bucket === 'Assy_Hrs' && /layout/.test(what) ? 'FIT_LAYOUT' : null) ||
    BUCKET_DEFAULT[bucket] || 'MISC';
}

// Zoho Labor_Type text ("Welding - TIG", or older wording like "Welding - Tig") -> code.
function codeFromZoho(text) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const exact = TYPES.find((t) => t.zoho.toLowerCase() === s);
  if (exact) return exact.code;
  const tail = s.split(/\s*-\s*/).pop();
  const byLabel = TYPES.find((t) => t.label.toLowerCase() === tail || t.label.toLowerCase().split(/[ /(]/)[0] === tail);
  return byLabel ? byLabel.code : null;
}

module.exports = { TYPES, BY_CODE, BUCKET_LABEL, BUCKET_DEFAULT, FROM_PROCESS, typeForLine, codeFromZoho };
