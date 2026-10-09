// =============================================================================
//  nestStore.js — a saved nesting run's stock pieces and cuts, kept as ONE file.
// -----------------------------------------------------------------------------
//  A run used to be saved as one Zoho Nesting_Stock_Result record per stock piece,
//  each with its cut rows. The Chiller Yard Trestle job (MCP-10108, 2026-10-09)
//  nested 10,800 stock pieces: every save wrote ~10,800 records plus their cuts,
//  and opening the results read them back one batch at a time. Two saves and an
//  open used the whole 1,000-call daily allowance and added tens of thousands
//  of records against the 250,000-record ceiling.
//
//  Now Zoho keeps only the run header (so it still lists, approves and
//  supersedes runs), and the detail lives here: gzipped JSON on the Railway
//  volume, in the shape GET .../nesting-results returns. Saving or opening a run
//  costs the same few calls whatever its size.
// =============================================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const filestore = require('./filestore');

const dir = function () { return path.join(filestore.storeRoot(), 'nest-runs'); };
const fileOf = function (runId) {
  if (!/^[0-9]{6,25}$/.test(String(runId || ''))) throw new Error('nest run id must be a record id');
  return path.join(dir(), String(runId) + '.json.gz');
};

// Only worth using where the file outlives a restart. Without a volume the old
// per-piece Zoho save is still the only durable copy.
function available() { return filestore.isDurable(); }

function save(runId, payload) {
  const p = fileOf(runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
  fs.renameSync(tmp, p);
  return p;
}

function load(runId) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(fileOf(runId))).toString('utf8')); }
  catch (e) { return null; }
}

function has(runId) {
  try { return fs.existsSync(fileOf(runId)); } catch (e) { return false; }
}

// The nest engine's results → the stored shape (what the loader used to rebuild from
// Nesting_Stock_Result + cut records). dataOf(result) gives the material ids and
// weight_per_ft for a result; calcStockWt(result, wpf) its stock weight.
function build(results1d, results2d, dataOf, calcStockWt) {
  const r4 = function (n) { return Math.round(n * 10000) / 10000; };
  const ok = function (r) { return r && !r.error && r.cuts && r.cuts.length; };
  const cut = function (c, i, d, wide) {
    return { bom_line_id: c.bom_line_id || '', part_mark: c.part_mark, cut_length: c.cut_length || 0, cut_width: wide ? (c.cut_width || 0) : 0,
      cut_weight: wide ? ((c.cut_length && c.cut_width) ? r4((c.cut_length * c.cut_width / 144) * d.weight_per_ft) : 0)
                       : (c.cut_length ? r4(d.weight_per_ft * (c.cut_length / 12)) : 0),
      quantity_on_this_stock: c.quantity_on_this_stock || 1, x_position: wide ? (c.x_position || 0) : 0, y_position: wide ? (c.y_position || 0) : 0,
      rotation: wide && c.rotation === 90 ? 90 : 0, cut_sequence: i + 1,
      spec_name: d.specification_id || c.spec_name || '', material_type: d.material_id || c.material_type || '' };
  };
  const out1d = (results1d || []).filter(ok).map(function (r, n) {
    const d = dataOf(r);
    return { stock_result_id: '', form_type: d.form_type_id || r.form_type || '', material_origin: d.material_type_id || r.material_origin || '',
      stock_length_in: r.stock_length_in, stock_label: r.stock_label || '', waste_percentage: r.waste_percentage,
      stock_weight_lbs: calcStockWt(r, d.weight_per_ft), stock_sequence: n + 1, grain_direction: '',
      remnant_length_in: Math.round((r.remnant_length_in || 0) * 100) / 100,
      cuts: r.cuts.map(function (c, i) { return cut(c, i, d, false); }) };
  });
  const out2d = (results2d || []).filter(ok).map(function (r, n) {
    const d = dataOf(r);
    return { stock_result_id: '', form_type: d.form_type_id || r.form_type || '', material_origin: d.material_type_id || r.material_origin || '',
      stock_length_in: r.stock_length_in, stock_width_in: r.stock_width_in, stock_label: r.stock_label || '', waste_percentage: r.waste_percentage,
      stock_weight_lbs: calcStockWt(r, d.weight_per_ft), stock_sequence: n + 1, grain_direction: r.grain_direction || '',
      remnant_area_in2: r.remnant_area_in2 || 0,
      cuts: r.cuts.map(function (c, i) { return cut(c, i, d, true); }) };
  });
  const w = out1d.reduce(function (s, r) { return s + (Number(r.waste_percentage) || 0); }, 0);
  return { results_1d: out1d, results_2d: out2d,
    summary: { total_stock_pieces: out1d.length + out2d.length, avg_waste_pct_1d: out1d.length ? Math.round(w / out1d.length * 10) / 10 : 0, errors: [] } };
}

module.exports = { available, save, load, has, build };
