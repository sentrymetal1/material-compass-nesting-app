import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './App.css';

const API = '';
// Why the last saved-run fetch came back empty, so the UI can say which.
let lastSavedRunMessage = '';

function getProjectIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('project_id') || params.get('id') || '';
}

function getManufactureIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('Manufacture_ID') || params.get('manufacture_id') || params.get('mfg_id') || '';
}

function getUserFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('User') || params.get('user') || '';
}

// Where to send the window back to after a successful save (the project page).
// The launcher passes this URL-encoded; URLSearchParams.get decodes it once.
function getReturnUrlFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('return_url') || params.get('returnUrl') || '';
}

// Display the local part of an email (before @) for the recall panel
function emailLocalPart(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

// Compute the next tag in a sequence: "P-1" -> "P-2", "B3" -> "B4", "1" -> "2",
// "ABC" (no trailing digits) -> "ABC-1", "" -> "". Used by Add Part to auto-populate.
function nextTag(prevTag) {
  const s = String(prevTag || '').trim();
  if (!s) return '';
  const m = s.match(/^(.*?)(\d+)$/);
  if (m) return m[1] + (parseInt(m[2]) + 1);
  return s + '-1';
}

// Lookup record IDs that represent "0" — used as defaults for dimension fields so saved Run_Part
// records never have null values for INCH(L), FT(W), INCH(W).
const ZERO_INCH_ID = '4111484000000521139';     // Length_INCH_Lookup record where Description="0"
const ZERO_FT_WIDTH_ID = '4111484000003558015'; // Plate_Standard_Sizes record where width = 0'

// Parse "1/4", "3/8", "1-1/4", "2", "W10 x 12" etc. into an array of numeric tokens
// for size-aware sort. "1-1/4" -> [1.25], "W10 x 12" -> [10, 12], "L4 x 4 x 3/8" -> [4, 4, 0.375].
function materialSortKey(name) {
  if (!name) return [Infinity];
  const tokens = String(name).match(/(\d+(?:-\d+\/\d+)?|\d+\/\d+|\d+(?:\.\d+)?)/g) || [];
  return tokens.map(t => {
    const mixed = t.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
    const frac = t.match(/^(\d+)\/(\d+)$/);
    if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
    return parseFloat(t) || 0;
  });
}

function compareByMaterialName(a, b) {
  const ka = materialSortKey(a.name);
  const kb = materialSortKey(b.name);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const ai = ka[i] === undefined ? -Infinity : ka[i];
    const bi = kb[i] === undefined ? -Infinity : kb[i];
    if (ai !== bi) return ai - bi;
  }
  return (a.name || '').localeCompare(b.name || '');
}

// Convert FT/INCH lookup IDs to total inches using the lookup tables
function dimsToInches(lengthFt, lengthInchId, widthFtId, widthInchId, lengthInchTable, plateWidthTable) {
  const ft = parseFloat(lengthFt) || 0;
  let inchVal = 0;
  if (lengthInchId && lengthInchTable) {
    const rec = lengthInchTable.find(r => String(r.id) === String(lengthInchId));
    if (rec) inchVal = parseFloat(rec.result) || 0;
  }
  const lengthIn = ft * 12 + inchVal;
  let widthIn = 0;
  if (widthFtId && plateWidthTable) {
    const wRec = plateWidthTable.find(r => String(r.id) === String(widthFtId));
    if (wRec) widthIn += (parseFloat(wRec.width_ft) || 0) * 12;
  }
  if (widthInchId && lengthInchTable) {
    const wiRec = lengthInchTable.find(r => String(r.id) === String(widthInchId));
    if (wiRec) widthIn += parseFloat(wiRec.result) || 0;
  }
  return { length_in: lengthIn, width_in: widthIn };
}

function inToFt(val) {
  const n = parseFloat(val);
  if (!n || n === 0) return '—';
  const ft = Math.floor(n / 12);
  const rem = +(n % 12).toFixed(2);
  if (ft === 0) return `${n}"`;
  if (rem === 0) return `${n}" (${ft}')`;
  return `${n}" (${ft}'${rem}")`;
}

function fmtLbs(val) {
  const n = parseFloat(val);
  if (!n || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' lbs';
}

/** Calculate unit weight for a stock piece
 * 1D: weight_per_ft × (length_in / 12)
 * 2D: weight_per_ft × (length_in × width_in / 144)
 */
function calcUnitWeight(weightPerFt, lengthIn, widthIn) {
  const wpf = parseFloat(weightPerFt) || 0;
  const l = parseFloat(lengthIn) || 0;
  const w = parseFloat(widthIn) || 0;
  if (wpf === 0 || l === 0) return 0;
  if (w > 0) {
    return wpf * (l * w / 144);
  }
  return wpf * (l / 12);
}

// ─── Cut to size ────────────────────────────────────────────────────────────
// Every stock piece in the plan is a purchase decision. Nesting six 87"
// channels out of a 20' bar is a real answer; burning a 24' pipe for one 6"
// nipple is not — nobody buys that. Any stock piece using less than
// `utilThresholdPct` of its stock gets re-quoted as "buy a piece cut to this
// size" instead.
//
// No re-packing is needed. The API already reports remnant per stock piece, and
// utilization is exactly (stock - remnant) / stock — which is 100 minus the
// reported waste_percentage. So this is a pure transform over the returned
// plan, and the packing algorithm is left alone.
const CTS_DEFAULTS = {
  enabled: true,
  utilThresholdPct: 35,   // convert a piece using less than this % of its stock
  trimLinearIn: 0,        // optional extra length on a linear buy (0 = exact)
  trimPanelIn: 0,         // optional extra per side on a plate buy (0 = exact)
  roundToIn: 0.125,       // buy dims round up to this increment — 1/8"
  skipAtPctOfStock: 90,   // buy size this close to full stock — just take the stock
};
// Cut to size means the size. No supplier minimums and no default allowance: a
// 9" x 2" part buys 9" x 2", not a wider strip or a padded one. The trim fields
// stay available at 0 for the jobs that genuinely need an allowance, and the
// trailing kerf comes off a converted piece too — you don't cut a piece that
// already arrives at its finished length.

function roundUpTo(val, inc) {
  const v = parseFloat(val) || 0;
  const i = parseFloat(inc) || 0;
  if (i <= 0) return Math.round(v * 10000) / 10000;
  return Math.round(Math.ceil(v / i) * i * 10000) / 10000;
}

const r4 = v => Math.round((parseFloat(v) || 0) * 10000) / 10000;
const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;

/** Stable per-stock-piece id for manual overrides. stock_sequence is assigned
 *  sequentially across all pieces within results_1d / results_2d. */
function ctsPieceKey(result) {
  const dim = result.stock_width_in && parseFloat(result.stock_width_in) > 0 ? '2d' : '1d';
  return `${dim}-${result.stock_sequence}`;
}

/** Buy dims for a linear piece: what got used, plus a square-up allowance.
 *  `force` is set when the user asked for this explicitly, which bypasses the
 *  not-worth-it guard — otherwise the button would appear to do nothing. */
function ctsLinearBuy(r, o, force) {
  const stockL = parseFloat(r.stock_length_in) || 0;
  if (stockL <= 0) return null;
  // remnant_length_in is stock minus every cut *and* its kerf, so this is the
  // real consumed length — same definition the API used for waste_percentage.
  const used = stockL - (parseFloat(r.remnant_length_in) || 0);
  if (used <= 0) return null;
  // One kerf comes back off: the API charges a kerf per cut including the last,
  // but the far end of a cut-to-size piece is the supplier's cut, not yours. A
  // lone 6" part then buys 6" exactly instead of 6.125" rounded up to 7".
  const net = Math.max(used - (parseFloat(o.kerf1D) || 0), 0);
  if (net <= 0) return null;
  const buyL = roundUpTo(net + o.trimLinearIn, o.roundToIn);
  if (!force && buyL >= stockL * (o.skipAtPctOfStock / 100)) return null;
  const remnant = Math.max(buyL - used, 0);
  return {
    stock_length_in: buyL,
    remnant_length_in: r4(remnant),
    waste_percentage: r2((remnant / buyL) * 100),
    cts_used_in: r4(used),
  };
}

/** Buy dims for a panel: bounding box of the nest plus edge trim all around.
 *  Requires per-placement records — `cuts` is consolidated by (mark, L, W) and
 *  keeps only one position, so its bounding box would be wrong. Saved runs
 *  reconstructed without placements are left as full-sheet buys. */
function ctsPanelBuy(r, o, force) {
  const stockL = parseFloat(r.stock_length_in) || 0;
  const stockW = parseFloat(r.stock_width_in) || 0;
  const places = r.placements;
  if (stockL <= 0 || stockW <= 0 || !places || places.length === 0) return null;
  let maxX = 0, maxY = 0, usedArea = 0;
  for (const c of places) {
    const l = parseFloat(c.cut_length) || 0;
    const w = parseFloat(c.cut_width) || 0;
    maxX = Math.max(maxX, (parseFloat(c.x_position) || 0) + l);
    maxY = Math.max(maxY, (parseFloat(c.y_position) || 0) + w);
    usedArea += l * w;
  }
  if (maxX <= 0 || maxY <= 0) return null;
  const buyL = Math.min(roundUpTo(maxX + 2 * o.trimPanelIn, o.roundToIn), stockL);
  const buyW = Math.min(roundUpTo(maxY + 2 * o.trimPanelIn, o.roundToIn), stockW);
  const buyArea = buyL * buyW;
  if (!force && buyArea >= stockL * stockW * (o.skipAtPctOfStock / 100)) return null;
  // Centre the nest in the smaller plate so trim shows on all four edges, but
  // never shift a part past the buy edge when rounding clamped the buy dims.
  const shiftX = Math.max(Math.min(o.trimPanelIn, (buyL - maxX) / 2), 0);
  const shiftY = Math.max(Math.min(o.trimPanelIn, (buyW - maxY) / 2), 0);
  const shift = c => ({
    ...c,
    x_position: r4((parseFloat(c.x_position) || 0) + shiftX),
    y_position: r4((parseFloat(c.y_position) || 0) + shiftY),
  });
  const remnantArea = Math.max(buyArea - usedArea, 0);
  return {
    stock_length_in: buyL,
    stock_width_in: buyW,
    remnant_length_in: r4(Math.max(buyL - maxX - shiftX, 0)),
    remnant_width_in: r4(Math.max(buyW - maxY - shiftY, 0)),
    remnant_area_in2: r4(remnantArea),
    waste_percentage: r2((remnantArea / buyArea) * 100),
    cts_used_in2: r4(usedArea),
    placements: places.map(shift),
    cuts: (r.cuts || []).map(shift),
    svg_layout: null, // server SVG was drawn against the full sheet
  };
}

/** Finished size to buy for ONE part of a BOM row marked cut-to-size.
 *  One piece per part: the part's own dimensions plus trim, rounded up, floored
 *  at the supplier minimum. Nothing is nested, so there is no bounding box. */
function ctsItemBuyDims(row, o) {
  const partL = parseFloat(row.length_nest) || 0;
  if (partL <= 0) return null;
  const is2D = row.nest_type === 'Panel';
  const partW = is2D ? (parseFloat(row.width_nest) || 0) : 0;
  if (is2D && partW <= 0) return null;
  if (is2D) {
    return {
      is2D: true,
      buy_length_in: roundUpTo(partL + 2 * o.trimPanelIn, o.roundToIn),
      buy_width_in: roundUpTo(partW + 2 * o.trimPanelIn, o.roundToIn),
    };
  }
  // No kerf here at all — this part never entered a nest, so nothing is cut
  // out of anything. The buy is the finished length.
  return {
    is2D: false,
    buy_length_in: roundUpTo(partL + o.trimLinearIn, o.roundToIn),
    buy_width_in: 0,
  };
}

// Each stock field gets its own label sitting directly above its own box. A
// single floating "qty" label between two inputs read as belonging to the box
// on its left, so lengths were being typed into the quantity field.
const FIELD = { display: 'flex', flexDirection: 'column', gap: 2 };
const FIELD_LBL = {
  fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--gray-600)', fontWeight: 600,
};

// ─── Nest groups ────────────────────────────────────────────────────────────
// One card per material, which is what makes typed stock entry workable: the
// card header already says form, material and size, so a stock row only needs
// a length and a quantity. Every comparable tool scopes a run this way.
//
// Spec is deliberately NOT part of the key. The nester matches stock on
// form_type + material_origin plus an optional material_name filter, and never
// on specification — so A36 and A572 channel of the same size draw from the
// same stock and must share a card. nest_type is in the key so a form that
// somehow carries both linear and panel rows can't collapse into one card.
function nestGroupKey(row) {
  return `${row.nest_type}|${row.form_type_id}|${row.material_type_id}|${row.material_name || ''}`;
}

function buildNestGroups(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = nestGroupKey(row);
    if (!map.has(key)) {
      map.set(key, {
        key,
        nest_type: row.nest_type,
        is2D: row.nest_type === 'Panel',
        form_type_id: row.form_type_id,
        form_type_name: row.form_type_name || String(row.form_type_id || ''),
        material_type_id: row.material_type_id,
        material_type_name: row.material_type_name || String(row.material_type_id || ''),
        material_name: row.material_name || '',
        specs: [],
        rows: [],
        pieces: 0,
        totalLength: 0,
        totalArea: 0,
      });
    }
    const g = map.get(key);
    if (row.spec_name && !g.specs.includes(row.spec_name)) g.specs.push(row.spec_name);
    const qty = parseInt(row.quantity, 10) || 0;
    const l = parseFloat(row.length_nest) || 0;
    const w = parseFloat(row.width_nest) || 0;
    g.rows.push(row);
    g.pieces += qty;
    if (g.is2D) g.totalArea += qty * l * w; else g.totalLength += qty * l;
  }
  return [...map.values()].sort((a, b) =>
    a.form_type_name.localeCompare(b.form_type_name) ||
    a.material_type_name.localeCompare(b.material_type_name) ||
    a.material_name.localeCompare(b.material_name));
}

/** Extended totals for a group — what you actually have to cut.
 *
 *  Linear groups total in inches. Panel groups can't total a width, so they
 *  total in AREA; weight is carried for both so a plate group and a channel
 *  group can be compared on the one axis you buy on. Weight is inlined rather
 *  than calling calcUnitWeight so this stays dependency-free and testable.
 */
function groupTotals(group) {
  let lengthIn = 0, areaIn2 = 0, lbs = 0, unweighed = 0;
  for (const r of group.rows) {
    const qty = parseInt(r.quantity, 10) || 0;
    const L = parseFloat(r.length_nest) || 0;
    const W = parseFloat(r.width_nest) || 0;
    const wpf = parseFloat(r.weight_per_ft) || 0;
    if (group.is2D) areaIn2 += qty * L * W; else lengthIn += qty * L;
    if (wpf > 0 && L > 0) lbs += qty * (W > 0 ? wpf * (L * W / 144) : wpf * (L / 12));
    else if (L > 0) unweighed += qty;   // Weight_Per_Ft blank on the BOM row
  }
  return { lengthIn, areaIn2, lbs, unweighed };
}

/** Extended size of one BOM row, in the unit its group totals in. */
function rowExtended(row, is2D) {
  const qty = parseInt(row.quantity, 10) || 0;
  const L = parseFloat(row.length_nest) || 0;
  const W = parseFloat(row.width_nest) || 0;
  return is2D ? qty * L * W : qty * L;
}

/** Square feet, for panel totals. */
function fmtArea(in2) {
  const n = parseFloat(in2) || 0;
  if (n <= 0) return '—';
  return (n / 144).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' ft²';
}

/** Parts in this group that fit NO entered stock size.
 *
 *  The nester reports these as "too long for any stock" only after a run, which
 *  is a confusing place to learn it — by then the numbers on the card have
 *  already gone nonsensical ("needs 104 sticks"). Catching it up front turns a
 *  post-run error into an obvious red line on the card that blocks the run.
 *
 *  Panels are checked both ways round, since a part may fit rotated. Rows
 *  bought cut to size are skipped — they never enter the nest.
 */
function groupOversizeParts(group, entries, ctsIds) {
  const stocks = (entries || [])
    .map(s => ({ L: parseFloat(s.len) || 0, W: parseFloat(s.wid) || 0 }))
    .filter(s => s.L > 0 && (!group.is2D || s.W > 0));
  if (stocks.length === 0) return [];
  return group.rows.filter(r => {
    if (ctsIds && ctsIds.has(r.id)) return false;
    const L = parseFloat(r.length_nest) || 0;
    const W = parseFloat(r.width_nest) || 0;
    if (L <= 0) return false;
    if (!group.is2D) return !stocks.some(s => s.L >= L);
    return !stocks.some(s => (s.L >= L && s.W >= W) || (s.L >= W && s.W >= L));
  });
}

/** How much of the smallest entered stock this group's parts would fill.
 *  Null when nothing is entered yet — the caller says "no stock" instead. */
function groupFillPct(group, entries) {
  const caps = (entries || [])
    .map(s => group.is2D
      ? (parseFloat(s.len) || 0) * (parseFloat(s.wid) || 0)
      : (parseFloat(s.len) || 0))
    .filter(c => c > 0);
  if (caps.length === 0) return null;
  const need = group.is2D ? group.totalArea : group.totalLength;
  const smallest = Math.min(...caps);
  return smallest > 0 ? (need / smallest) * 100 : null;
}

/** Rebuild the per-group stock map from flat library-shaped rows, so reopening a
 *  saved run restores the sizes it was nested with. nest_type is inferred from
 *  the width, which is the same test the payload builder uses. */
function groupStockFromRows(rows) {
  const out = {};
  for (const s of rows || []) {
    const len = parseFloat(s.stock_length) || 0;
    if (len <= 0) continue;
    const wid = parseFloat(s.stock_width) || 0;
    const key = `${wid > 0 ? 'Panel' : 'Linear'}|${s.form_type}|${s.material_type}|${s.material_name || ''}`;
    if (!out[key]) out[key] = [];
    out[key].push({
      len: String(len),
      wid: wid > 0 ? String(wid) : '',
      qty: String(s.quantity ?? '').trim(),
      ref: s.reference || '',
      standard: String(s.is_standard) === 'Yes',
    });
  }
  return out;
}

/** Library sizes offered as chips for a group — the stock rows that actually
 *  match its form + material.
 *
 *  Deduped by size, because the library carries one row per material size and
 *  they collapse to the same chip — EXCEPT rows carrying a reference (heat #,
 *  bin). Those are specific physical pieces, not a size you can order any
 *  number of, so two of them never merge. Quantity and reference ride along on
 *  the chip so clicking it doesn't quietly discard what's on hand. */
function groupChips(group, stockLibrary) {
  const seen = new Set();
  const out = [];
  for (const s of stockLibrary || []) {
    if (String(s.form_type) !== String(group.form_type_id)) continue;
    if (String(s.material_type) !== String(group.material_type_id)) continue;
    const len = parseFloat(s.stock_length) || 0;
    const wid = parseFloat(s.stock_width) || 0;
    if (len <= 0) continue;
    if (group.is2D !== (wid > 0)) continue;   // panels need width, linear must not have one
    const ref = s.reference || '';
    const label = (group.is2D ? `${len}x${wid}` : String(len)) + (ref ? `#${ref}` : '');
    if (seen.has(label)) continue;
    seen.add(label);
    // Only a referenced row's quantity is a real cap — that's a specific piece
    // on the floor. A plain catalog size carrying "1" is not a statement that
    // you may buy only one, and importing it would cap the nest at one stick.
    const qty = ref ? String(s.quantity ?? '').trim() : '';
    out.push({
      label, len, wid, reference: ref,
      quantity: qty,
      standard: String(s.is_standard) === 'Yes',
    });
  }
  return out.sort((a, b) => (a.len - b.len) || (a.wid - b.wid));
}

/** Is this stock piece something already on the floor, rather than a buy?
 *  The source is encoded in the stock_id the payload builder assigns, so the
 *  results come back self-describing with no side map to keep in sync. */
function isOnHandStockId(stockId) {
  return String(stockId || '').startsWith('oh');
}

/** Turn the per-group stock entries into the API's stock_1d / stock_2d arrays.
 *  Each entry is tagged with the group's material_name so the nester confines
 *  it to that material; a blank quantity stays null, which the API reads as an
 *  uncapped supply.
 *
 *  On-hand rows are always capped: an uncapped "on hand" is a contradiction, so
 *  a blank quantity on one falls back to 1 rather than becoming infinite shop
 *  stock. */
function buildStockPayload(groups, groupStock) {
  const stock_1d = [];
  const stock_2d = [];
  groups.forEach((g, gi) => {
    (groupStock[g.key] || []).forEach((s, si) => {
      const len = parseFloat(s.len) || 0;
      if (len <= 0) return;
      const wid = parseFloat(s.wid) || 0;
      if (g.is2D && wid <= 0) return;
      const qtyRaw = String(s.qty ?? '').trim();
      let qty = qtyRaw === '' ? null : (parseInt(qtyRaw, 10) || null);
      if (s.onHand && (qty === null || qty <= 0)) qty = 1;
      const entry = {
        stock_id: `${s.onHand ? 'oh' : 'or'}${gi}s${si}`,
        stock_label: `${g.form_type_name} | ${g.material_type_name}`,
        form_type: String(g.form_type_id),
        material_origin: String(g.material_type_id),
        material_name: g.material_name || '',
        quantity: qty,
        reference: s.ref || '',
        density: 0,
        length_in: len,
        is_standard: s.standard ? 'Yes' : 'No',
      };
      if (g.is2D) stock_2d.push({ ...entry, width_in: wid });
      else stock_1d.push(entry);
    });
  });
  return { stock_1d, stock_2d };
}

/**
 * Which BOM rows are worth suggesting for cut-to-size, before any nesting has run.
 *
 * Judged per nest group, not per row. A single 32" pipe is the only 1-1/4" pipe
 * on the job, so it can never fill a 24' stick — but Items 100/110/120 are all
 * MC6 x 18 and nest into one bar beautifully. Looking at rows in isolation would
 * wrongly flag the channels, so the test is whether the *whole group* can fill
 * `utilThresholdPct` of the shortest stock available to it.
 */
function suggestCtsItems(rows, stockList, enabledIds, o) {
  const groups = {};
  for (const row of rows) {
    const key = `${row.form_type_id}|${row.material_type_id}|${row.material_name || ''}`;
    if (!groups[key]) groups[key] = { rows: [], total: 0, is2D: row.nest_type === 'Panel' };
    const qty = parseInt(row.quantity, 10) || 0;
    const l = parseFloat(row.length_nest) || 0;
    const w = parseFloat(row.width_nest) || 0;
    groups[key].rows.push(row);
    groups[key].total += row.nest_type === 'Panel' ? qty * l * w : qty * l;
  }
  const suggested = new Set();
  for (const g of Object.values(groups)) {
    const first = g.rows[0];
    const candidates = stockList.filter(s =>
      enabledIds.has(s.id) &&
      String(s.form_type) === String(first.form_type_id) &&
      String(s.material_type) === String(first.material_type_id) &&
      (g.is2D ? parseFloat(s.stock_width) > 0 : !(parseFloat(s.stock_width) > 0))
    );
    if (candidates.length === 0) continue; // no stock to compare against
    const capacities = candidates.map(s => g.is2D
      ? (parseFloat(s.stock_length) || 0) * (parseFloat(s.stock_width) || 0)
      : (parseFloat(s.stock_length) || 0)).filter(c => c > 0);
    if (capacities.length === 0) continue;
    const smallest = Math.min(...capacities);
    if (g.total < smallest * (o.utilThresholdPct / 100)) {
      g.rows.forEach(r => suggested.add(r.id));
    }
  }
  return suggested;
}

/**
 * Re-quote low-utilization stock pieces as cut-to-size buys.
 * Pure — never mutates `data`, so it can be re-derived whenever settings change.
 * @param overrides map of ctsPieceKey -> true (force cut to size) / false (force nest)
 */
function applyCutToSize(data, opts, overrides) {
  if (!data) return data;
  const o = { ...CTS_DEFAULTS, ...(opts || {}) };
  const ov = overrides || {};
  const convert = (r, is2D) => {
    if (!r || r.error) return r;
    const forced = ov[ctsPieceKey(r)];
    if (forced === false) return r;
    if (!o.enabled && forced !== true) return r;
    const utilPct = 100 - (parseFloat(r.waste_percentage) || 0);
    if (forced !== true && utilPct >= o.utilThresholdPct) return r;
    const buy = is2D ? ctsPanelBuy(r, o, forced === true) : ctsLinearBuy(r, o, forced === true);
    if (!buy) return r;
    return {
      ...r,
      ...buy,
      cut_to_size: true,
      cts_forced: forced === true,
      original_stock_length_in: r.stock_length_in,
      original_stock_width_in: r.stock_width_in ?? null,
      original_waste_percentage: r.waste_percentage,
    };
  };
  const results_1d = (data.results_1d || []).map(r => convert(r, false));
  const results_2d = (data.results_2d || []).map(r => convert(r, true));
  const ok1 = results_1d.filter(r => !r.error);
  const ok2 = results_2d.filter(r => !r.error);
  // The API's summary describes the pre-conversion plan, so it has to be
  // rebuilt here. Weighted by stock consumed rather than averaged across
  // pieces — an unweighted mean lets a 6" offcut outvote a 40' bar.
  const sum = (arr, f) => arr.reduce((t, x) => t + (parseFloat(f(x)) || 0), 0);
  const stockLen1d = sum(ok1, r => r.stock_length_in);
  const remnLen1d = sum(ok1, r => r.remnant_length_in);
  const stockArea2d = sum(ok2, r => (parseFloat(r.stock_length_in) || 0) * (parseFloat(r.stock_width_in) || 0));
  const remnArea2d = sum(ok2, r => r.remnant_area_in2);
  return {
    ...data,
    results_1d,
    results_2d,
    _ctsCount: [...ok1, ...ok2].filter(r => r.cut_to_size).length,
    summary: {
      ...(data.summary || {}),
      total_stock_pieces: ok1.length + ok2.length,
      total_1d_stock_pieces: ok1.length,
      total_2d_stock_pieces: ok2.length,
      total_remnant_length_in: r4(remnLen1d),
      total_remnant_area_in2: r4(remnArea2d),
      avg_waste_pct_1d: stockLen1d > 0 ? r2((remnLen1d / stockLen1d) * 100) : 0,
      avg_waste_pct_2d: stockArea2d > 0 ? r2((remnArea2d / stockArea2d) * 100) : 0,
    },
  };
}

function groupResults(results, nameLookup) {
  if (!results || results.length === 0) return [];
  const materialGroups = {};
  for (const r of results) {
    if (r.error) continue;
    // Include material_name in the key so different materials on the same
    // form/origin/length get their own group (algorithm now locks each
    // bin/sheet to one material, so this matches reality).
    const matKey = r.material_name || '';
    // cut_to_size in the key so a cut-to-size buy never merges into a group of
    // full-stock pieces that happen to share its length.
    const key = `${r.form_type}|${r.material_origin}|${matKey}|${r.stock_length_in}|${r.stock_width_in || 0}|${r.cut_to_size ? 'cts' : 'nest'}`;
    if (!materialGroups[key]) {
      materialGroups[key] = {
        form_type: r.form_type,
        material_origin: r.material_origin,
        stock_length_in: r.stock_length_in,
        stock_width_in: r.stock_width_in,
        cut_to_size: !!r.cut_to_size,
        form_type_name: (nameLookup && nameLookup[r.form_type]) || r.form_type,
        material_type_name: (nameLookup && nameLookup[r.material_origin]) || r.material_origin,
        spec_name: (nameLookup && r.cuts?.[0] && nameLookup[r.cuts[0].spec_name]) || '',
        material_name: r.material_name || (nameLookup && r.cuts?.[0] && nameLookup[r.cuts[0].material_type]) || '',
        patterns: [],
      };
    }
    const cutSig = (r.cuts || [])
      .map(c => `${c.part_mark}:${c.cut_length}:${c.cut_width || 0}:${c.quantity_on_this_stock}`)
      .join('|');
    const existing = materialGroups[key].patterns.find(p => p.signature === cutSig);
    if (existing) {
      existing.count++;
      existing.stockPieces.push(r);
    } else {
      materialGroups[key].patterns.push({
        signature: cutSig,
        count: 1,
        representative: r,
        stockPieces: [r],
      });
    }
  }
  return Object.values(materialGroups);
}

function resolveErrorNames(errorMsg, nameLookup) {
  if (!nameLookup) return errorMsg;
  let resolved = errorMsg;
  for (const [id, name] of Object.entries(nameLookup)) {
    if (id && name && resolved.includes(id)) {
      resolved = resolved.split(id).join(name);
    }
  }
  return resolved;
}

function analyzeError(errorMsg, nameLookup, parts1D, parts2D, stock2D, stock1D) {
  const resolved = resolveErrorNames(errorMsg, nameLookup);
  const tooLargeMatch = resolved.match(/Part\s+(\S+)\s+\(([^)]+)\)\s+too large for any stock in\s+(.+)/i);
  if (!tooLargeMatch) {
    return { message: resolved, details: null };
  }
  const partMark = tooLargeMatch[1];
  const partDims = tooLargeMatch[2];
  const stockCategory = tooLargeMatch[3].replace(/\.$/, '');
  const dimMatch = partDims.match(/([\d.]+)[x×]([\d.]+)/);
  const lenMatch = partDims.match(/([\d.]+)"/);
  const allParts = [...(parts1D || []), ...(parts2D || [])];
  const part = allParts.find(p => String(p.part_mark || p.bom_item) === String(partMark));

  if (dimMatch) {
    const partLength = parseFloat(dimMatch[1]);
    const partWidth = parseFloat(dimMatch[2]);
    const allStock = [...(stock2D || [])];
    const matchingStock = allStock.filter(s => {
      const label = s.stock_label || '';
      return label.toLowerCase().includes(stockCategory.toLowerCase()) ||
        (s.form_type_name && s.material_type_name &&
          stockCategory.toLowerCase().includes(s.form_type_name.toLowerCase()) &&
          stockCategory.toLowerCase().includes(s.material_type_name.toLowerCase()));
    });
    const maxStockLength = matchingStock.length > 0 ? Math.max(...matchingStock.map(s => parseFloat(s.length_in || s.stock_length) || 0)) : 0;
    const maxStockWidth = matchingStock.length > 0 ? Math.max(...matchingStock.map(s => parseFloat(s.width_in || s.stock_width) || 0)) : 0;
    const lengthExceeds = partLength > maxStockLength && partLength > maxStockWidth;
    const widthExceeds = partWidth > maxStockLength && partWidth > maxStockWidth;
    let dimensionNote = '';
    if (widthExceeds && !lengthExceeds) {
      dimensionNote = `Requires ${partWidth}" in one dimension, but max available stock width is ${maxStockWidth}" and max length is ${maxStockLength}".`;
    } else if (lengthExceeds && !widthExceeds) {
      dimensionNote = `Requires ${partLength}" in one dimension, but max available stock length is ${maxStockLength}" and max width is ${maxStockWidth}".`;
    } else if (lengthExceeds && widthExceeds) {
      dimensionNote = `Both dimensions (${partLength}" × ${partWidth}") exceed all available stock (max: ${maxStockLength}" × ${maxStockWidth}").`;
    } else {
      dimensionNote = `Part dimensions are ${partLength}" × ${partWidth}". Max available stock is ${maxStockLength}" × ${maxStockWidth}".`;
    }
    const availableSizes = matchingStock.map(s => {
      const sL = parseFloat(s.length_in || s.stock_length) || 0;
      const sW = parseFloat(s.width_in || s.stock_width) || 0;
      return `${sL}" × ${sW}"`;
    });
    const minLength = Math.max(partLength, partWidth);
    const minWidth = Math.min(partLength, partWidth);
    return {
      message: `Part ${partMark} (${partLength}" × ${partWidth}") — no stock available in ${stockCategory}`,
      details: {
        type: '2d',
        dimensionNote,
        availableSizes: [...new Set(availableSizes)],
        suggestions: [
          `Add stock at least ${Math.ceil(minWidth)}" × ${Math.ceil(minLength)}" (or larger) to the Stock Library for ${stockCategory}.`,
          `Review Part ${partMark} in the BOM — if length and width can be swapped or dimensions reduced, adjust accordingly.`,
          part?.grain_direction && part.grain_direction !== 'none'
            ? `Grain direction is set to "${part.grain_direction}" which prevents rotation. Setting to "None" may allow more stock options.`
            : null,
        ].filter(Boolean),
      },
    };
  } else if (lenMatch) {
    const partLength = parseFloat(lenMatch[1]);
    const allStock = [...(stock1D || [])];
    const matchingStock = allStock.filter(s => {
      const label = s.stock_label || '';
      return label.toLowerCase().includes(stockCategory.toLowerCase());
    });
    const maxStockLength = matchingStock.length > 0 ? Math.max(...matchingStock.map(s => parseFloat(s.length_in || s.stock_length) || 0)) : 0;
    return {
      message: `Part ${partMark} (${partLength}") — no stock available in ${stockCategory}`,
      details: {
        type: '1d',
        dimensionNote: `Requires ${partLength}" length, but max available stock length is ${maxStockLength}".`,
        availableSizes: matchingStock.map(s => `${parseFloat(s.length_in || s.stock_length)}"`),
        suggestions: [
          `Add stock at least ${Math.ceil(partLength)}" long to the Stock Library for ${stockCategory}.`,
          `Review Part ${partMark} in the BOM — if the length can be reduced, adjust accordingly.`,
        ],
      },
    };
  }
  return { message: resolved, details: null };
}

function PanelVisualization({ result, kerf2D }) {
  const stockL = result.stock_length_in || 0;
  const stockW = result.stock_width_in || 0;
  // Use per-placement records when available (one rect per physical part).
  // Falls back to `cuts` for older API responses where placements wasn't sent.
  const cuts = result.placements || result.cuts || [];
  if (!stockL || !stockW || cuts.length === 0) return null;
  const marginLeft = 30;
  const marginTop = 5;
  const marginBottom = 20;
  const marginRight = 5;
  const maxDrawWidth = 600;
  const maxDrawHeight = 300;
  const scaleX = maxDrawWidth / stockL;
  const scaleY = maxDrawHeight / stockW;
  const scale = Math.min(scaleX, scaleY);
  const drawW = stockL * scale;
  const drawH = stockW * scale;
  const svgWidth = drawW + marginLeft + marginRight;
  const svgHeight = drawH + marginTop + marginBottom;
  const colors = [
    '#4A90D9', '#5BA55B', '#D4A843', '#C75B5B', '#7B68AE',
    '#3AAFA9', '#E07B53', '#8D6E63', '#5C6BC0', '#26A69A',
  ];
  const partMarks = [...new Set(cuts.map(c => c.part_mark))];
  const colorMap = {};
  partMarks.forEach((mark, i) => { colorMap[mark] = colors[i % colors.length]; });

  return (
    <div className="panel-viz-wrap">
      <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="panel-viz-svg">
        <g transform={`translate(${marginLeft}, ${marginTop})`}>
          <rect x={0} y={0} width={drawW} height={drawH} fill="#f5f5f5" stroke="#999" strokeWidth={1} />
          {Array.from({ length: Math.floor(stockL / 12) }, (_, i) => (
            <line key={`vg-${i}`} x1={(i + 1) * 12 * scale} y1={0} x2={(i + 1) * 12 * scale} y2={drawH} stroke="#e0e0e0" strokeWidth={0.5} />
          ))}
          {Array.from({ length: Math.floor(stockW / 12) }, (_, i) => (
            <line key={`hg-${i}`} x1={0} y1={(i + 1) * 12 * scale} x2={drawW} y2={(i + 1) * 12 * scale} stroke="#e0e0e0" strokeWidth={0.5} />
          ))}
          {cuts.map((cut, i) => {
            const x = (parseFloat(cut.x_position) || 0) * scale;
            const y = (parseFloat(cut.y_position) || 0) * scale;
            const rotation = parseInt(cut.rotation) || 0;
            const cutW = rotation === 90 ? (cut.cut_width * scale) : (cut.cut_length * scale);
            const cutH = rotation === 90 ? (cut.cut_length * scale) : (cut.cut_width * scale);
            const color = colorMap[cut.part_mark] || '#4A90D9';
            const clampedW = Math.min(cutW, drawW - x);
            const clampedH = Math.min(cutH, drawH - y);
            return (
              <g key={i}>
                <rect x={x} y={y} width={clampedW} height={clampedH} fill={color} fillOpacity={0.75} stroke="white" strokeWidth={1} />
                {clampedW > 28 && clampedH > 14 && (
                  <text x={x + clampedW / 2} y={y + clampedH / 2 - (clampedH > 28 ? 5 : 0)} textAnchor="middle" dominantBaseline="central" fill="white" fontSize={Math.min(12, Math.min(clampedW * 0.3, clampedH * 0.4))} fontWeight="bold" fontFamily="'IBM Plex Mono', monospace">
                    {cut.part_mark}
                  </text>
                )}
                {clampedW > 50 && clampedH > 28 && (
                  <text x={x + clampedW / 2} y={y + clampedH / 2 + 8} textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.85)" fontSize={Math.min(9, Math.min(clampedW * 0.2, clampedH * 0.25))} fontFamily="'IBM Plex Mono', monospace">
                    {cut.cut_length}"×{cut.cut_width}"
                  </text>
                )}
                {rotation === 90 && clampedW > 40 && clampedH > 36 && (
                  <text x={x + clampedW / 2} y={y + clampedH / 2 + 18} textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.6)" fontSize={8} fontFamily="'IBM Plex Mono', monospace">
                    (R90°)
                  </text>
                )}
              </g>
            );
          })}
          <text x={drawW / 2} y={drawH + 15} textAnchor="middle" fontSize={10} fill="#666" fontFamily="'IBM Plex Mono', monospace">
            {stockL}" ({(stockL / 12).toFixed(0)}')
          </text>
          <text x={-drawH / 2} y={-14} textAnchor="middle" fontSize={10} fill="#666" fontFamily="'IBM Plex Mono', monospace" transform="rotate(-90)">
            {stockW}" ({(stockW / 12).toFixed(0)}')
          </text>
        </g>
      </svg>
    </div>
  );
}

function matDesc(group) {
  const parts = [group.form_type_name, group.material_type_name];
  if (group.spec_name) parts.push(group.spec_name);
  if (group.material_name) parts.push(group.material_name);
  return parts.join(' | ');
}

function ManualPartsEntry({ parts, onChange, lookupTables, onLookupTablesLoaded }) {
  const [formTypes, setFormTypes] = useState(lookupTables?.formTypes || []);
  const [matTypes, setMatTypes] = useState(lookupTables?.matTypes || []);
  const [lengthInch, setLengthInch] = useState(lookupTables?.lengthInch || []);
  const [plateWidths, setPlateWidths] = useState(lookupTables?.plateWidths || []);
  // Cascade cache keyed by "formTypeId|materialTypeId" — survives row reorders and component remounts
  const [cascadeCache, setCascadeCache] = useState({});

  useEffect(() => {
    async function loadBase() {
      try {
        const [ftRes, mtRes, liRes, pwRes] = await Promise.all([
          fetch(`${API}/api/lookups/form-types`),
          fetch(`${API}/api/lookups/material-types`),
          fetch(`${API}/api/lookups/length-inch`),
          fetch(`${API}/api/lookups/plate-widths`),
        ]);
        const ft = (ftRes.ok ? await ftRes.json() : []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const mt = (mtRes.ok ? await mtRes.json() : []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const li = liRes.ok ? await liRes.json() : []; // already sorted by decimal result on server
        const pw = pwRes.ok ? await pwRes.json() : []; // already sorted by width_ft on server
        setFormTypes(ft);
        setMatTypes(mt);
        setLengthInch(li);
        setPlateWidths(pw);
        if (onLookupTablesLoaded) onLookupTablesLoaded({ formTypes: ft, matTypes: mt, lengthInch: li, plateWidths: pw });
      } catch (e) { console.error('Failed to load lookup tables:', e); }
    }
    if (formTypes.length === 0) loadBase();
  }, []); // eslint-disable-line

  async function ensureCascade(formTypeId, materialTypeId) {
    if (!formTypeId || !materialTypeId) return;
    const key = `${formTypeId}|${materialTypeId}`;
    if (cascadeCache[key]) return;
    try {
      const [specRes, matRes] = await Promise.all([
        fetch(`${API}/api/lookups/specifications?form_type_id=${formTypeId}&material_type_id=${materialTypeId}`),
        fetch(`${API}/api/lookups/materials?form_type_id=${formTypeId}&material_type_id=${materialTypeId}`),
      ]);
      const specs = (specRes.ok ? await specRes.json() : []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const mats = (matRes.ok ? await matRes.json() : []).sort(compareByMaterialName);
      setCascadeCache(p => ({ ...p, [key]: { specs, mats } }));
    } catch (e) { console.error('Cascade load failed:', e); }
  }

  // Auto-prefetch cascade for any rows that already have form+mat picked (handles component remount)
  useEffect(() => {
    const seen = new Set();
    parts.forEach(p => {
      if (p.form_type_id && p.material_type_id) {
        const key = `${p.form_type_id}|${p.material_type_id}`;
        if (!seen.has(key)) { seen.add(key); ensureCascade(p.form_type_id, p.material_type_id); }
      }
    });
  }, [parts]); // eslint-disable-line

  function updateRow(idx, patch) {
    const next = parts.map((p, i) => i === idx ? { ...p, ...patch } : p);
    onChange(next);
  }
  function addRow() {
    const newId = `part_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    // Copy form/mat/spec/material from the last row to speed up similar-part entry; user can change.
    const last = parts[parts.length - 1];
    const seed = last ? {
      form_type_id: last.form_type_id, form_type_name: last.form_type_name,
      material_type_id: last.material_type_id, material_type_name: last.material_type_name,
      specification_id: last.specification_id, spec_name: last.spec_name,
      material_id: last.material_id, material_name: last.material_name,
      weight_per_ft: last.weight_per_ft, dim1: last.dim1, density: last.density,
      width_ft_id: last.width_ft_id || ZERO_FT_WIDTH_ID, // panels often share width
      nest_type: last.nest_type
    } : {
      form_type_id: '', form_type_name: '',
      material_type_id: '', material_type_name: '',
      specification_id: '', spec_name: '',
      material_id: '', material_name: '',
      weight_per_ft: 0, dim1: 0, density: 0,
      width_ft_id: ZERO_FT_WIDTH_ID,
      nest_type: 'Linear'
    };
    let newTag;
    if (last && last.tag && last.tag.trim()) {
      newTag = nextTag(last.tag);
    } else if (!last) {
      // First part — pre-populate so the auto-increment pattern works from row 2 onward.
      newTag = 'P-1';
    } else {
      // Previous row exists but tag is empty — default to position-based sequence
      newTag = `P-${parts.length + 1}`;
    }
    onChange([...parts, {
      client_part_id: newId, tag: newTag, component: '', drawing: '',
      ...seed,
      quantity: 1, length_ft: 0, length_inch_id: ZERO_INCH_ID, width_inch_id: ZERO_INCH_ID,
      galv: false, plate_sa: false
    }]);
  }
  function removeRow(idx) {
    onChange(parts.filter((_, i) => i !== idx));
  }

  function isRowValid(p) {
    let lenIn = (parseInt(p.length_ft) || 0) * 12;
    if (p.length_inch_id) {
      const rec = lengthInch.find(r => String(r.id) === String(p.length_inch_id));
      if (rec) lenIn += parseFloat(rec.result) || 0;
    }
    return !!(p.form_type_id && p.material_type_id && p.specification_id && p.material_id
      && parseInt(p.quantity) > 0
      && lenIn > 0);
  }

  return (
    <div className="manual-parts-entry" style={{ background: 'white', border: '1px solid #e2e6eb', borderRadius: 6, padding: '14px 16px' }}>
      <div style={{ background: '#f5f6f8', margin: '-14px -16px 14px -16px', padding: '10px 16px', fontSize: 12, fontWeight: 600, color: '#444', borderBottom: '1px solid #e2e6eb', borderRadius: '6px 6px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>PARTS TO NEST</span>
        <button onClick={addRow} className="btn btn-primary btn-small">+ Add Part</button>
      </div>
      {parts.length === 0 ? (
        <p className="hint">No parts yet — click "Add Part" to start, or upload a CSV.</p>
      ) : (
        <div className="table-wrap">
          <table className="table" style={{ width: 'auto', minWidth: '100%' }}>
            <thead>
              <tr>
                <th></th>
                <th>Tag</th>
                <th>Form</th>
                <th>Mat Type</th>
                <th>Spec</th>
                <th>Material</th>
                <th>Qty</th>
                <th>FT(L)</th>
                <th>INCH(L)</th>
                <th>FT(W)</th>
                <th>INCH(W)</th>
                <th>Nest Type</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p, idx) => {
                const cacheKey = `${p.form_type_id}|${p.material_type_id}`;
                const cached = cascadeCache[cacheKey] || { specs: [], mats: [] };
                const specs = cached.specs;
                const mats = cached.mats;
                const valid = isRowValid(p);
                return (
                  <tr key={p.client_part_id} style={!valid && (p.form_type_id || p.material_type_id) ? { background: '#fff8e1' } : {}}>
                    <td style={{ width: 30 }}><button onClick={() => removeRow(idx)} className="btn btn-small btn-danger" title="Remove row" style={{ padding: '2px 6px' }}>×</button></td>
                    <td><input type="text" value={p.tag} onChange={e => updateRow(idx, { tag: e.target.value })} placeholder="P-1" style={{ width: 60 }} /></td>
                    <td>
                      <select value={p.form_type_id} onChange={e => {
                        const ft = formTypes.find(f => String(f.id) === String(e.target.value));
                        const measurement = ft?.measurement || '';
                        const newNestType = measurement === 'Panel' ? 'Panel' : (measurement === 'Linear' ? 'Linear' : p.nest_type);
                        updateRow(idx, {
                          form_type_id: e.target.value,
                          form_type_name: ft?.name || '',
                          specification_id: '', spec_name: '',
                          material_id: '', material_name: '', weight_per_ft: 0, dim1: 0, density: 0,
                          nest_type: newNestType,
                          // Reset width fields to zero IDs if switching to Linear
                          ...(newNestType === 'Linear' ? { width_ft_id: ZERO_FT_WIDTH_ID, width_inch_id: ZERO_INCH_ID } : {})
                        });
                        ensureCascade(e.target.value, p.material_type_id);
                      }}>
                        <option value="">—</option>
                        {formTypes.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.material_type_id} onChange={e => {
                        const mt = matTypes.find(m => String(m.id) === String(e.target.value));
                        updateRow(idx, {
                          material_type_id: e.target.value,
                          material_type_name: mt?.name || '',
                          specification_id: '', spec_name: '',
                          material_id: '', material_name: '', weight_per_ft: 0, dim1: 0, density: 0
                        });
                        ensureCascade(p.form_type_id, e.target.value);
                      }}>
                        <option value="">—</option>
                        {matTypes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.specification_id} onChange={e => {
                        const s = specs.find(x => String(x.id) === String(e.target.value));
                        updateRow(idx, { specification_id: e.target.value, spec_name: s?.name || '' });
                      }} disabled={specs.length === 0} style={{ minWidth: 130 }}>
                        <option value="">—</option>
                        {specs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.material_id} onChange={e => {
                        const m = mats.find(x => String(x.id) === String(e.target.value));
                        updateRow(idx, {
                          material_id: e.target.value,
                          material_name: m?.name || '',
                          weight_per_ft: m?.weight_per_ft || 0,
                          dim1: m?.dim1 || 0,
                          density: m?.density || 0
                        });
                      }} disabled={mats.length === 0} style={{ minWidth: 180 }}>
                        <option value="">—</option>
                        {mats.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td><input type="number" min="1" value={p.quantity} onChange={e => updateRow(idx, { quantity: parseInt(e.target.value) || 0 })} style={{ width: 50 }} /></td>
                    <td><input type="number" min="0" step="1" value={p.length_ft} onChange={e => updateRow(idx, { length_ft: parseInt(e.target.value) || 0 })} style={{ width: 50 }} /></td>
                    <td>
                      <select value={p.length_inch_id || ZERO_INCH_ID} onChange={e => updateRow(idx, { length_inch_id: e.target.value })}>
                        {lengthInch.map(li => <option key={li.id} value={li.id}>{li.description}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.width_ft_id || ZERO_FT_WIDTH_ID} onChange={e => updateRow(idx, { width_ft_id: e.target.value })} disabled={p.nest_type !== 'Panel'}>
                        {plateWidths.map(pw => <option key={pw.id} value={pw.id}>{pw.description || pw.width_ft + "'"}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.width_inch_id || ZERO_INCH_ID} onChange={e => updateRow(idx, { width_inch_id: e.target.value })} disabled={p.nest_type !== 'Panel'}>
                        {lengthInch.map(li => <option key={li.id} value={li.id}>{li.description}</option>)}
                      </select>
                    </td>
                    <td>
                      {p.nest_type === 'Linear' ? (
                        <span style={{
                          background: '#e8f5e9', color: '#2e7d32',
                          padding: '4px 12px', borderRadius: 12,
                          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                          display: 'inline-block'
                        }}>LINEAR</span>
                      ) : p.nest_type === 'Panel' ? (
                        <span style={{
                          background: '#ffebee', color: '#c62828',
                          padding: '4px 12px', borderRadius: 12,
                          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                          display: 'inline-block'
                        }}>PANEL</span>
                      ) : (
                        <span style={{ color: '#bbb' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [projectId, setProjectId] = useState(getProjectIdFromURL());
  const returnUrl = getReturnUrlFromURL();
  const [canReturnToProject, setCanReturnToProject] = useState(false);
  const [manufactureId] = useState(getManufactureIdFromURL());
  const [userEmail] = useState(getUserFromURL());
  const isStandalone = !projectId && !!manufactureId;
  const [nestSource, setNestSource] = useState(isStandalone ? 'Manual' : 'Project');
  const [standaloneParts, setStandaloneParts] = useState([]);
  const [standaloneLookups, setStandaloneLookups] = useState({ formTypes: [], matTypes: [], lengthInch: [], plateWidths: [] });
  const [standaloneRuns, setStandaloneRuns] = useState([]);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [loadingRunId, setLoadingRunId] = useState(null);
  const [archivingRunId, setArchivingRunId] = useState(null);
  const [runsFilter, setRunsFilter] = useState('Active');
  const [runsSource, setRunsSource] = useState('All');
  const [runsSearch, setRunsSearch] = useState('');
  const [runTitle, setRunTitle] = useState('');
  const [runNotes, setRunNotes] = useState('');
  const [loadedFromRunNumber, setLoadedFromRunNumber] = useState(null);
  const [loadedRunIsProject, setLoadedRunIsProject] = useState(false);
  const [archiveUndo, setArchiveUndo] = useState(null); // { runId, previousStatus }
  const [savedNestsExpanded, setSavedNestsExpanded] = useState(() => {
    try { return localStorage.getItem('savedNestsExpanded') === 'true'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('savedNestsExpanded', savedNestsExpanded ? 'true' : 'false'); } catch {}
  }, [savedNestsExpanded]);
  const [step, setStep] = useState(isStandalone ? 1 : (projectId ? 1 : 0));
  const [project, setProject] = useState(null);
  const [bom, setBom] = useState([]);
  const [stock, setStock] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [kerf1D, setKerf1D] = useState(0.125);
  const [kerf2D, setKerf2D] = useState(0.125);
  const [grainDirections, setGrainDirections] = useState({});
  // rawResults is the untouched API response. `results` below is the derived
  // view with cut-to-size applied, so changing a cut-to-size setting re-quotes
  // the plan instantly without another nesting run.
  const [rawResults, setRawResults] = useState(null);
  const [cts, setCts] = useState(CTS_DEFAULTS);
  const [ctsOverrides, setCtsOverrides] = useState({});
  // BOM rows the user marked cut-to-size on the Configure step. These are pulled
  // out of the nest entirely and bought as finished pieces, one per part.
  const [ctsItems, setCtsItems] = useState(new Set());
  // Stock sizes typed per nest group: { [groupKey]: [{len, wid, qty, ref, standard}] }.
  // Starts empty on purpose — the library is offered as chips to click, not as
  // rows to audit.
  const [groupStock, setGroupStock] = useState({});
  const [openGroups, setOpenGroups] = useState(new Set());
  // Kerf rides along with the cut-to-size settings: a converted piece gives back
  // its trailing kerf, since its far end is the supplier's cut and not yours.
  const ctsOpts = useMemo(() => ({ ...cts, kerf1D, kerf2D }), [cts, kerf1D, kerf2D]);
  const results = useMemo(() => applyCutToSize(rawResults, ctsOpts, ctsOverrides), [rawResults, ctsOpts, ctsOverrides]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [lastNestPayload, setLastNestPayload] = useState(null);
  const [selectedPatterns, setSelectedPatterns] = useState(new Set());
  const [showPurchasePreview, setShowPurchasePreview] = useState(false);
  const [savingPurchase, setSavingPurchase] = useState(false);
  const [purchaseStatus, setPurchaseStatus] = useState('');
  const [savedPurchaseLines, setSavedPurchaseLines] = useState([]);
  const [loadingSavedPurchase, setLoadingSavedPurchase] = useState(false);
  const [loadingSavedResults, setLoadingSavedResults] = useState(false);
  const [showSavedPurchase, setShowSavedPurchase] = useState(false);
  const [savedRunInfo, setSavedRunInfo] = useState(null);

  const loadProject = useCallback(async (id) => {
    setLoading(true);
    setError('');
    try {
      const [projRes, bomRes, stockRes] = await Promise.all([
        fetch(`${API}/api/project/${id}`),
        fetch(`${API}/api/project/${id}/bom`),
        fetch(`${API}/api/stock`),
      ]);
      if (!projRes.ok) {
        // Surface the server's specific message (e.g. quota exhausted) rather
        // than a blanket "Project not found".
        let msg = 'Project not found';
        try { const ej = await projRes.json(); if (ej?.error) msg = ej.error; } catch (e) {}
        throw new Error(msg);
      }
      const projData = await projRes.json();
      const bomData = await bomRes.json();
      const stockData = await stockRes.json();
      const taggedStock = stockData.map(s => ({ ...s, source: 'library' }));
      setProject(projData);
      setBom(bomData);
      setStock(taggedStock);
      const autoSelect = new Set();
      bomData.forEach(item => {
        if (item.nest_type && item.nest_type !== '') autoSelect.add(item.id);
      });
      setSelected(autoSelect);
      setStep(1);
      // Auto-load saved nesting results
      try {
        const nestRes = await fetch(`${API}/api/project/${id}/nesting-results`);
        if (nestRes.ok) {
          const nestData = await nestRes.json();
          if (nestData.found && (nestData.results_1d?.length > 0 || nestData.results_2d?.length > 0)) {
            if (nestData._nameLookup && bomData.length > 0) {
              bomData.forEach(b => {
                if (b.form_type_id && b.form_type_name) nestData._nameLookup[b.form_type_id] = b.form_type_name;
                if (b.material_type_id && b.material_type_name) nestData._nameLookup[b.material_type_id] = b.material_type_name;
                if (b.specification_id && b.spec_name) nestData._nameLookup[b.specification_id] = b.spec_name;
                if (b.material_id && b.material_name) nestData._nameLookup[b.material_id] = b.material_name;
              });
            }
            setSavedRunInfo(nestData.run_header);
            setRawResults(nestData);
            autoSelectAllPatterns(nestData);
            if (nestData.run_header?.kerf_1d) setKerf1D(nestData.run_header.kerf_1d);
            if (nestData.run_header?.kerf_2d) setKerf2D(nestData.run_header.kerf_2d);
          }
        }
      } catch (e) { console.error('Auto-load nesting results:', e); }
      // Auto-load saved purchase list
      try {
        const plRes = await fetch(`${API}/api/project/${id}/purchase-list`);
        if (plRes.ok) {
          const plData = await plRes.json();
          if (plData.purchase_lines && plData.purchase_lines.length > 0) {
            setSavedPurchaseLines(plData.purchase_lines);
            setShowSavedPurchase(true);
          }
        }
      } catch (e) { console.error('Auto-load purchase list:', e); }
    } catch (err) {
      setError(err.message || 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectId) loadProject(projectId);
  }, [projectId, loadProject]);

  // Standalone mode: convert standaloneParts into bom-shape rows so downstream code (selectedBom, bomKeys, runNesting) works unchanged
  useEffect(() => {
    if (!isStandalone) return;
    const lengthInchTbl = standaloneLookups.lengthInch;
    const plateWidthTbl = standaloneLookups.plateWidths;
    const bomRows = standaloneParts.map(p => {
      const dims = dimsToInches(p.length_ft, p.length_inch_id, p.width_ft_id, p.width_inch_id, lengthInchTbl, plateWidthTbl);
      return {
        id: p.client_part_id,
        bom_item: p.tag || `Part ${p.client_part_id.slice(-4)}`,
        nest_type: p.nest_type,
        form_type_id: p.form_type_id,
        form_type_name: p.form_type_name,
        material_type_id: p.material_type_id,
        material_type_name: p.material_type_name,
        specification_id: p.specification_id,
        spec_name: p.spec_name,
        material_id: p.material_id,
        material_name: p.material_name,
        material_dim1: parseFloat(p.dim1) || 0,
        quantity: parseInt(p.quantity) || 0,
        length_nest: dims.length_in,
        width_nest: dims.width_in,
        density: parseFloat(p.density) || 0,
        weight_per_ft: parseFloat(p.weight_per_ft) || 0,
        // pass-through standalone-only fields needed at save time
        _standalone: true,
        _client_part_id: p.client_part_id,
        _tag: p.tag, _component: p.component, _drawing: p.drawing,
        _length_ft: p.length_ft,
        _length_inch_id: p.length_inch_id, _width_ft_id: p.width_ft_id, _width_inch_id: p.width_inch_id,
        _galv: p.galv, _plate_sa: p.plate_sa
      };
    }).filter(r => r.form_type_id && r.material_type_id && r.quantity > 0 && r.length_nest > 0);
    setBom(bomRows);
    setSelected(new Set(bomRows.map(r => r.id)));
  }, [standaloneParts, standaloneLookups, isStandalone]);

  // Standalone mode: fetch list of prior runs for this manufacturer (server filters status only;
  // source is filtered client-side because Zoho's null handling makes the "Project" criteria
  // exclude legacy runs with empty Nest_Source).
  const refreshStandaloneRuns = useCallback(() => {
    if (!isStandalone || !manufactureId) return Promise.resolve();
    return fetch(`${API}/api/standalone/nesting-runs?manufacturer_id=${manufactureId}&status=${runsFilter}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.runs) setStandaloneRuns(data.runs); else setStandaloneRuns([]); })
      .catch(e => console.error('Standalone runs list:', e));
  }, [isStandalone, manufactureId, runsFilter]);

  useEffect(() => {
    if (isStandalone && manufactureId) refreshStandaloneRuns();
  }, [isStandalone, manufactureId, runsFilter, refreshStandaloneRuns]);

  // Apply source filter + search client-side over the fetched runs list
  const filteredStandaloneRuns = standaloneRuns.filter(r => {
    // Source filter
    if (runsSource === 'Manual' && r.nest_source !== 'Manual') return false;
    if (runsSource === 'CSV' && r.nest_source !== 'CSV') return false;
    if (runsSource === 'Project' && !r.project_id) return false;
    // Search filter — case-insensitive match against title, project name, notes, or creator
    if (runsSearch.trim()) {
      const q = runsSearch.trim().toLowerCase();
      const hay = `${r.run_title || ''} ${r.project_name || ''} ${r.notes || ''} ${r.run_notes || ''} ${r.created_by || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Duplicate: like Load, but clears title + savedRunInfo so the user is clearly
  // starting a fresh run (no "Editing copy of #N" banner, no auto-loaded title).
  async function duplicateStandaloneRun(runId) {
    await loadStandaloneRun(runId);
    setRunTitle('');
    setRunNotes('');
    setLoadedFromRunNumber(null);
    setSavedRunInfo(null);
    setRawResults(null);
    setStep(1);
  }

  async function archiveStandaloneRun(runId, newStatus) {
    setArchivingRunId(runId);
    const previousStatus = newStatus === 'Archived' ? 'Approved' : 'Archived';
    const runBeingChanged = standaloneRuns.find(r => r.id === runId);
    try {
      const resp = await fetch(`${API}/api/standalone/runs/${runId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (!resp.ok) throw new Error('Status update failed');
      await refreshStandaloneRuns();
      // Show undo toast for Archive only (Restore doesn't need an undo)
      if (newStatus === 'Archived' && runBeingChanged) {
        setArchiveUndo({ runId, previousStatus, runNumber: runBeingChanged.run_number, expiresAt: Date.now() + 5000 });
      }
    } catch (e) {
      console.error('Archive run:', e);
      setError(e.message || 'Failed to update run');
    } finally {
      setArchivingRunId(null);
    }
  }

  // Auto-dismiss undo toast after 5s
  useEffect(() => {
    if (!archiveUndo) return;
    const timer = setTimeout(() => setArchiveUndo(null), 5000);
    return () => clearTimeout(timer);
  }, [archiveUndo]);

  async function undoArchive() {
    if (!archiveUndo) return;
    const { runId, previousStatus } = archiveUndo;
    setArchiveUndo(null);
    setArchivingRunId(runId);
    try {
      const resp = await fetch(`${API}/api/standalone/runs/${runId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: previousStatus })
      });
      if (!resp.ok) throw new Error('Undo failed');
      await refreshStandaloneRuns();
    } catch (e) {
      setError(e.message || 'Failed to undo archive');
    } finally {
      setArchivingRunId(null);
    }
  }

  async function loadStandaloneRun(runId) {
    if (!runId) return;
    setLoadingRunId(runId);
    try {
      const resp = await fetch(`${API}/api/standalone/nesting-results?manufacturer_id=${manufactureId}&run_id=${runId}`);
      if (!resp.ok) throw new Error('Failed to load run');
      const data = await resp.json();
      if (!data.found) { setError('Run not found'); return; }
      setSavedRunInfo(data.run_header);
      setRawResults(data);
      autoSelectAllPatterns(data);
      if (data.run_header?.kerf_1d) setKerf1D(data.run_header.kerf_1d);
      if (data.run_header?.kerf_2d) setKerf2D(data.run_header.kerf_2d);
      if (data.run_header?.run_title) setRunTitle(data.run_header.run_title);
      if (data.run_header?.run_notes) setRunNotes(data.run_header.run_notes); else setRunNotes('');

      const isProjectRun = !!data.run_header?.project_id;
      setLoadedRunIsProject(isProjectRun);
      setLoadedFromRunNumber(data.run_header?.run_number || null);

      // For project runs: clear stale standalone state so user doesn't see parts/stock from a previous load
      if (isProjectRun) {
        setStandaloneParts([]);
        setStock([]);
        setGroupStock({});
        setOpenGroups(new Set());
      }

      // For standalone runs only: pre-fill parts grid + stock entries so user can revise
      if (!isProjectRun && Array.isArray(data.input_parts) && data.input_parts.length > 0) {
        const reconstructedParts = data.input_parts.map((p, idx) => ({
          client_part_id: `loaded_${p.id || idx}`,
          tag: p.tag || '',
          component: p.component || '',
          drawing: p.drawing || '',
          form_type_id: p.form_type_id || '',
          form_type_name: p.form_type_name || '',
          material_type_id: p.material_type_id || '',
          material_type_name: p.material_type_name || '',
          specification_id: p.specification_id || '',
          spec_name: p.spec_name || '',
          material_id: p.material_id || '',
          material_name: p.material_name || '',
          quantity: parseInt(p.quantity) || 1,
          length_ft: parseInt(p.length_ft) || 0,
          length_inch_id: p.length_inch_id || ZERO_INCH_ID,
          width_ft_id: p.width_ft_id || ZERO_FT_WIDTH_ID,
          width_inch_id: p.width_inch_id || ZERO_INCH_ID,
          galv: !!p.galv,
          plate_sa: !!p.plate_sa,
          nest_type: p.nest_type || 'Linear',
          weight_per_ft: 0,
          dim1: 0,
          density: 0,
        }));
        setStandaloneParts(reconstructedParts);

        // Aggregate stock pieces used in the original nest into custom stock entries
        const stockMap = {};
        [...(data.results_1d || []), ...(data.results_2d || [])].forEach(r => {
          if (r.error) return;
          const len = r.stock_length_in;
          const wid = r.stock_width_in || 0;
          const key = `${r.form_type}|${r.material_origin}|${len}|${wid}`;
          if (!stockMap[key]) {
            const matchingPart = reconstructedParts.find(p => String(p.form_type_id) === String(r.form_type) && String(p.material_type_id) === String(r.material_origin));
            stockMap[key] = {
              form_type_id: r.form_type,
              form_type_name: matchingPart?.form_type_name || data._nameLookup?.[r.form_type] || '',
              material_type_id: r.material_origin,
              material_type_name: matchingPart?.material_type_name || data._nameLookup?.[r.material_origin] || '',
              stock_length: len,
              stock_width: wid > 0 ? wid : null,
              count: 0,
            };
          }
          stockMap[key].count++;
        });
        const reconstructedStock = Object.values(stockMap).map((s, idx) => ({
          id: 900000 + idx,
          form_type: s.form_type_id,
          form_type_name: s.form_type_name,
          material_type: s.material_type_id,
          material_type_name: s.material_type_name,
          material_name: '',
          stock_length: s.stock_length,
          stock_width: s.stock_width,
          density: 0,
          is_standard: 'No',
          source: 'custom',
          quantity: s.count,
          reference: '',
        }));
        setStock(reconstructedStock);
        setGroupStock(groupStockFromRows(reconstructedStock));
      }

      setStep(3);
    } catch (e) {
      setError(e.message || 'Failed to load run');
    } finally {
      setLoadingRunId(null);
    }
  }

  /** Jump to the Results step so a plan can be reviewed or printed. Results
   *  already in memory are shown straight away; otherwise the project's saved
   *  run is fetched first, so this works on a fresh page load too. */
  async function viewNestingResults() {
    if (results) { setError(''); setStep(3); return; }
    setLoadingSavedResults(true);
    try {
      // Only navigate if a run was actually loaded — stepping to Results with
      // nothing to render leaves a blank page with no way back.
      const found = await fetchSavedNestingResults();
      if (found) { setError(''); setStep(3); }
      else setError(lastSavedRunMessage || 'No saved nesting run for this project yet.');
    } finally {
      setLoadingSavedResults(false);
    }
  }

  async function fetchSavedNestingResults() {
    try {
      const url = isStandalone
        ? `${API}/api/standalone/nesting-results?manufacturer_id=${manufactureId}`
        : `${API}/api/project/${projectId}/nesting-results`;
      const resp = await fetch(url);
      // Carry the server's reason back — "quota exhausted" and "never saved" are
      // very different news, and guessing between them wastes the user's time.
      let body = null;
      try { body = await resp.json(); } catch (_) { body = null; }
      if (!resp.ok || !body || !body.found) {
        lastSavedRunMessage = (body && body.message) || 'Saved runs could not be read right now.';
        return false;
      }
      const data = body;
      if (data._nameLookup && bom.length > 0) {
        bom.forEach(b => {
          if (b.form_type_id && b.form_type_name) data._nameLookup[b.form_type_id] = b.form_type_name;
          if (b.material_type_id && b.material_type_name) data._nameLookup[b.material_type_id] = b.material_type_name;
          if (b.specification_id && b.spec_name) data._nameLookup[b.specification_id] = b.spec_name;
          if (b.material_id && b.material_name) data._nameLookup[b.material_id] = b.material_name;
        });
      }
      setSavedRunInfo(data.run_header);
      setRawResults(data);
      autoSelectAllPatterns(data);
      if (data.run_header?.kerf_1d) setKerf1D(data.run_header.kerf_1d);
      if (data.run_header?.kerf_2d) setKerf2D(data.run_header.kerf_2d);
      return true;
    } catch (err) {
      console.error('Error fetching saved nesting results:', err);
      return false;
    }
  }

  async function fetchSavedPurchaseList() {
    setLoadingSavedPurchase(true);
    try {
      const resp = await fetch(`${API}/api/project/${projectId}/purchase-list`);
      if (!resp.ok) throw new Error('Failed to fetch purchase list');
      const data = await resp.json();
      setSavedPurchaseLines(data.purchase_lines || []);
      setShowSavedPurchase(true);
    } catch (err) {
      console.error('Error fetching saved purchase list:', err);
      setSavedPurchaseLines([]);
      setShowSavedPurchase(true);
    } finally {
      setLoadingSavedPurchase(false);
    }
  }

  function toggleSelect(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function selectAll() { setSelected(new Set(bom.filter(b => b.nest_type).map(b => b.id))); }
  function selectNone() { setSelected(new Set()); }
  function togglePattern(key) {
    setSelectedPatterns(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  function selectAllPatterns() {
    if (!results) return;
    const allKeys = new Set();
    groupResults(results.results_1d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`1d-${gi}-${pi}`));
    });
    groupResults(results.results_2d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`2d-${gi}-${pi}`));
    });
    setSelectedPatterns(allKeys);
  }

  function clearAllPatterns() { setSelectedPatterns(new Set()); }

  function autoSelectAllPatterns(data) {
    // Group the cut-to-size view, not the raw response — pattern keys are
    // positional, and converting a piece changes which group it lands in.
    const view = applyCutToSize(data, ctsOpts, ctsOverrides);
    const allKeys = new Set();
    groupResults(view.results_1d, view._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`1d-${gi}-${pi}`));
    });
    groupResults(view.results_2d, view._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`2d-${gi}-${pi}`));
    });
    setSelectedPatterns(allKeys);
  }

  // Pattern selection keys are positional (`1d-<group>-<pattern>`), so any
  // change to the cut-to-size rules reshuffles them. Re-select everything.
  useEffect(() => {
    if (!results) return;
    const allKeys = new Set();
    groupResults(results.results_1d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`1d-${gi}-${pi}`));
    });
    groupResults(results.results_2d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`2d-${gi}-${pi}`));
    });
    setSelectedPatterns(allKeys);
  }, [results]);

  function getSelectedResults() {
    if (!results) return { selected_1d: [], selected_2d: [] };
    const selected_1d = [];
    const selected_2d = [];
    groupResults(results.results_1d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((pattern, pi) => {
        if (selectedPatterns.has(`1d-${gi}-${pi}`)) selected_1d.push(...pattern.stockPieces);
      });
    });
    groupResults(results.results_2d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((pattern, pi) => {
        if (selectedPatterns.has(`2d-${gi}-${pi}`)) selected_2d.push(...pattern.stockPieces);
      });
    });
    return { selected_1d, selected_2d };
  }

  function getWeightMap() {
    const map = {};
    bom.forEach(b => { map[String(b.id)] = parseFloat(b.weight_per_ft) || 0; });
    return map;
  }

  function getStockWeightPerFt(result, weightMap) {
    const firstCut = result.cuts?.[0];
    if (!firstCut) return 0;
    return weightMap[String(firstCut.bom_line_id)] || 0;
  }

  function toggleGroupOpen(key) {
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function addGroupStock(key, entry) {
    setGroupStock(prev => ({ ...prev, [key]: [...(prev[key] || []), entry] }));
    setOpenGroups(prev => new Set(prev).add(key));
  }

  function updateGroupStock(key, idx, field, value) {
    setGroupStock(prev => {
      const rows = [...(prev[key] || [])];
      if (!rows[idx]) return prev;
      rows[idx] = { ...rows[idx], [field]: value };
      return { ...prev, [key]: rows };
    });
  }

  function removeGroupStock(key, idx) {
    setGroupStock(prev => {
      const rows = [...(prev[key] || [])];
      rows.splice(idx, 1);
      return { ...prev, [key]: rows };
    });
  }

  /** Card-level mode. Cut-to-size stays per BOM row underneath, so a group can
   *  be switched wholesale here and still be corrected row by row inside. */
  function setGroupMode(group, mode) {
    setCtsItems(prev => {
      const next = new Set(prev);
      group.rows.forEach(r => { if (mode === 'cts') next.add(r.id); else next.delete(r.id); });
      return next;
    });
    setOpenGroups(prev => new Set(prev).add(group.key));
  }

  /** Force every stock piece behind a pattern to cut-to-size (true), full stock
   *  (false), or back to the automatic threshold decision (null). */
  function setCtsForPattern(pattern, value) {
    setCtsOverrides(prev => {
      const next = { ...prev };
      (pattern.stockPieces || []).forEach(p => {
        const k = ctsPieceKey(p);
        if (value === null) delete next[k]; else next[k] = value;
      });
      return next;
    });
  }

  /** Cut-to-size badge + override buttons for one pattern. */
  function renderCtsControls(pattern, r) {
    const isCts = !!r.cut_to_size;
    const overridden = Object.prototype.hasOwnProperty.call(ctsOverrides, ctsPieceKey(r));
    const is2D = parseFloat(r.original_stock_width_in) > 0 || parseFloat(r.stock_width_in) > 0;
    const wasDesc = isCts
      ? (is2D
        ? `${inToFt(r.original_stock_length_in)} × ${inToFt(r.original_stock_width_in)}`
        : inToFt(r.original_stock_length_in))
      : '';
    return (
      <>
        {isCts && (
          <span
            className="cts-badge"
            title={`Was ${wasDesc} stock at ${(parseFloat(r.original_waste_percentage) || 0).toFixed(1)}% waste`}
            style={{
              padding: '2px 8px', background: '#e6f4ea', color: '#1b5e20',
              border: '1px solid #1b5e20', borderRadius: 3, fontSize: 11,
              fontWeight: 'bold', letterSpacing: '0.04em',
            }}
          >
            CUT TO SIZE{r.cts_forced ? ' (forced)' : ''} — was {wasDesc}
          </span>
        )}
        <button
          className="btn btn-small"
          style={{ fontSize: 11, padding: '2px 8px' }}
          title={isCts ? 'Buy full stock and nest out of it instead' : 'Buy a piece cut to this size instead'}
          onClick={() => setCtsForPattern(pattern, !isCts)}
        >
          {isCts ? 'Use full stock' : 'Cut to size'}
        </button>
        {overridden && (
          <button
            className="btn btn-small"
            style={{ fontSize: 11, padding: '2px 8px' }}
            title="Go back to the automatic utilization threshold"
            onClick={() => setCtsForPattern(pattern, null)}
          >
            Auto
          </button>
        )}
      </>
    );
  }

  /** Purchase lines for BOM rows marked cut-to-size on the Configure step.
   *  One buy piece per part, so a qty-4 row becomes 4 pieces at the finished
   *  size. These never touched the nester, so they have no cut pattern. */
  function buildDirectCutLines() {
    const agg = {};
    for (const row of ctsBom) {
      const dims = ctsItemBuyDims(row, ctsOpts);
      const qty = parseInt(row.quantity, 10) || 0;
      if (!dims || qty <= 0) continue;
      const ftn = row.form_type_name || row.form_type_id;
      const mtn = row.material_type_name || row.material_type_id;
      const specName = row.spec_name || '';
      const matName = row.material_name || '';
      const key = `${ftn}|${mtn}|${specName}|${matName}|${dims.buy_length_in}|${dims.buy_width_in}|cts-item`;
      if (!agg[key]) {
        const wpf = parseFloat(row.weight_per_ft) || 0;
        const sizeDesc = dims.is2D
          ? `${inToFt(dims.buy_length_in)} × ${inToFt(dims.buy_width_in)}`
          : inToFt(dims.buy_length_in);
        agg[key] = {
          form_type_id: row.form_type_id,
          material_type_id: row.material_type_id,
          specification_id: row.specification_id,
          material_id: row.material_id,
          description: `${ftn} | ${mtn} | ${specName} | ${matName} | ${sizeDesc} | CUT TO SIZE`,
          form_type_name: ftn,
          material_type_name: mtn,
          spec_name: specName,
          material_name: matName,
          material_size: matName,
          stock_length_in: dims.buy_length_in,
          stock_width_in: dims.buy_width_in,
          quantity: 0,
          feet_length: dims.buy_length_in / 12,
          weight_per_ft: wpf,
          unit_weight: calcUnitWeight(wpf, dims.buy_length_in, dims.is2D ? dims.buy_width_in : 0),
          total_weight: 0,
          total_length: dims.is2D ? 0 : (dims.buy_length_in / 12),
          total_plate_width: dims.is2D ? dims.buy_width_in : 0,
          is2D: dims.is2D,
          cut_to_size: true,
          cts_item: true,
          on_hand: false,
          stock_reference: '',
          marks: [],
        };
      }
      agg[key].quantity += qty;
      agg[key].marks.push(row.bom_item);
    }
    const lines = Object.values(agg);
    lines.forEach(l => { l.total_weight = l.unit_weight * l.quantity; });
    return lines;
  }

  function buildPurchaseLines() {
    if (!results) return [];
    const { selected_1d, selected_2d } = getSelectedResults();
    const weightMap = getWeightMap();
    const agg = {};
    // Reference (heat #, bin) for each stock piece, from the payload that was
    // actually nested. Typed by hand and otherwise lost at save — it's the only
    // thing tying a consumed piece back to a physical one.
    const refById = {};
    [...(lastNestPayload?.stock_1d || []), ...(lastNestPayload?.stock_2d || [])]
      .forEach(s => { if (s.reference) refById[String(s.stock_id)] = s.reference; });

    for (const r of [...selected_1d, ...selected_2d]) {
      if (r.error) continue;
      // On-hand material is allocated rather than bought, but it still belongs on
      // the project — tagged, so the purchase view can exclude it while the
      // allotted totals stay complete.
      const onHand = isOnHandStockId(r.stock_id);
      const firstCut = r.cuts?.[0];
      if (!firstCut) continue;
      const is2D = r.stock_width_in && r.stock_width_in > 0;
      const ftn = results._nameLookup?.[r.form_type] || r.form_type;
      const mtn = results._nameLookup?.[r.material_origin] || r.material_origin;
      const specName = results._nameLookup?.[firstCut.spec_name] || '';
      const matName = results._nameLookup?.[firstCut.material_type] || '';
      // Key by display values so same-looking material/length collapses to one
      // purchase line even when underlying IDs differ across BOM rows.
      const key = `${ftn}|${mtn}|${specName}|${matName}|${r.stock_length_in}|${r.stock_width_in || 0}|${r.cut_to_size ? 'cts' : 'nest'}|${onHand ? 'oh' : 'buy'}`;
      if (!agg[key]) {
        const wpf = weightMap[String(firstCut.bom_line_id)] || 0;
        const unitWt = calcUnitWeight(wpf, r.stock_length_in, is2D ? r.stock_width_in : 0);
        const sizeDesc = is2D
          ? `${inToFt(r.stock_length_in)} × ${inToFt(r.stock_width_in)}`
          : inToFt(r.stock_length_in);
        agg[key] = {
          form_type_id: r.form_type,
          material_type_id: r.material_origin,
          specification_id: firstCut.spec_name,
          material_id: firstCut.material_type,
          description: `${ftn} | ${mtn} | ${specName} | ${matName} | ${sizeDesc}${r.cut_to_size ? ' | CUT TO SIZE' : ''}${onHand ? ' | ON HAND' : ''}`,
          cut_to_size: !!r.cut_to_size,
          on_hand: onHand,
          stock_reference: '',
          form_type_name: ftn,
          material_type_name: mtn,
          spec_name: specName,
          material_name: matName,
          material_size: matName,
          stock_length_in: r.stock_length_in,
          stock_width_in: r.stock_width_in || 0,
          quantity: 0,
          feet_length: r.stock_length_in / 12,
          weight_per_ft: wpf,
          unit_weight: unitWt,
          total_weight: 0,
          total_length: is2D ? 0 : (r.stock_length_in / 12),
          total_plate_width: is2D ? r.stock_width_in : 0,
          is2D,
        };
      }
      agg[key].quantity += 1;
      const ref = refById[String(r.stock_id)];
      if (ref && !agg[key].stock_reference.split(', ').filter(Boolean).includes(ref)) {
        agg[key].stock_reference = agg[key].stock_reference ? agg[key].stock_reference + ', ' + ref : ref;
      }
    }
    const lines = Object.values(agg);
    lines.forEach(line => { line.total_weight = line.unit_weight * line.quantity; });
    // Items marked cut-to-size on Configure never entered the nest, so they have
    // no pattern to derive from — append their buy lines here.
    return [...lines, ...buildDirectCutLines()];
  }

  // ─── FIX: savePurchaseList with auto-refresh after save ───
  async function savePurchaseList() {
    const lines = buildPurchaseLines();
    if (lines.length === 0) {
      setPurchaseStatus('Error: No purchase lines to save');
      return;
    }
    setSavingPurchase(true);
    setPurchaseStatus('');
    try {
      const resp = await fetch(`${API}/api/project/${projectId}/generate-purchase-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchase_lines: lines }),
      });
      if (!resp.ok) throw new Error('Save failed');
      const data = await resp.json();
      const failures = data.failures || [];
      const attempted = data.items_attempted != null ? data.items_attempted : lines.length;
      // Build a failure summary so dropped rows never disappear silently.
      let failMsg = '';
      if (failures.length > 0) {
        console.error('Purchase list rows rejected by Zoho:', failures);
        const codes = [...new Set(failures.map(f => f.code).filter(c => c != null))];
        const names = failures.map(f => `#${f.line} ${f.description || ''}`).join('; ');
        // Surface the raw field-level error from the first rejected row so the
        // offending field is visible on-screen (no need to open dev tools), with
        // the data platform's name scrubbed — tenants shouldn't see the vendor.
        const firstMsg = (failures.find(f => f.message)?.message || '').replace(/\bZoho\b/gi, 'the data service');
        failMsg = ` — WARNING: ${failures.length} of ${attempted} row(s) were REJECTED and not saved${codes.length ? ` (error code ${codes.join(', ')})` : ''}: ${names}.${firstMsg ? ` [Reason: ${firstMsg}]` : ''}`;
      }
      const prefix = failures.length > 0 ? 'Error' : '';
      // Full success → offer to return to the project page (a fresh reload there
      // makes the just-inserted rows survive the next "Update To Save Totals").
      if (failures.length === 0) setCanReturnToProject(true);
      setPurchaseStatus(`${prefix}${prefix ? ': ' : ''}Saved ${data.items_saved}/${attempted} line items to project.${failMsg} Refreshing...`);
      // Wait 2s for Zoho to finish writing before re-fetching
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const refreshResp = await fetch(`${API}/api/project/${projectId}/purchase-list`);
        if (refreshResp.ok) {
          const refreshData = await refreshResp.json();
          const newLines = refreshData.purchase_lines || [];
          setSavedPurchaseLines(newLines);
          setShowSavedPurchase(true);
          setPurchaseStatus(`${prefix}${prefix ? ': ' : ''}${newLines.length}/${attempted} line items confirmed in project.${failMsg}`);
        }
      } catch (e) {
        console.error('Purchase list refresh failed:', e);
        setPurchaseStatus(`${prefix}${prefix ? ': ' : ''}Saved ${data.items_saved}/${attempted} line items.${failMsg} Click "View Saved" to refresh.`);
      }
    } catch (err) {
      setPurchaseStatus(`Error: ${err.message}`);
    } finally {
      setSavingPurchase(false);
    }
  }

  // ─── Weight Summary Calculations ───
  function calcWeightSummary() {
    if (!results) return { totalAllocated: 0, totalWaste: 0, totalStock: 0 };
    const { selected_1d, selected_2d } = getSelectedResults();
    const weightMap = getWeightMap();
    let totalStock = 0;
    let totalAllocated = 0;
    let fromStock = 0;   // drawn from the shop — weight you already own
    for (const r of [...selected_1d, ...selected_2d]) {
      if (r.error || !r.cuts?.length) continue;
      const wpf = getStockWeightPerFt(r, weightMap);
      const is2D = r.stock_width_in && r.stock_width_in > 0;
      const stockWt = calcUnitWeight(wpf, r.stock_length_in, is2D ? r.stock_width_in : 0);
      totalStock += stockWt;
      if (isOnHandStockId(r.stock_id)) fromStock += stockWt;
      for (const cut of r.cuts) {
        const cutWt = is2D
          ? wpf * ((cut.cut_length * cut.cut_width) / 144)
          : wpf * (cut.cut_length / 12);
        totalAllocated += cutWt * (cut.quantity_on_this_stock || 1);
      }
    }
    // Items marked cut-to-size on Configure never entered the nest, so they have
    // no result rows — without this they vanish from the header entirely and the
    // totals read far below the BOM.
    for (const row of ctsBom) {
      const dims = ctsItemBuyDims(row, ctsOpts);
      const qty = parseInt(row.quantity, 10) || 0;
      const wpf = parseFloat(row.weight_per_ft) || 0;
      if (!dims || qty <= 0 || wpf <= 0) continue;
      const is2D = dims.is2D;
      totalStock += calcUnitWeight(wpf, dims.buy_length_in, is2D ? dims.buy_width_in : 0) * qty;
      totalAllocated += calcUnitWeight(
        wpf, parseFloat(row.length_nest) || 0, is2D ? (parseFloat(row.width_nest) || 0) : 0) * qty;
    }

    // The BOM is the anchor: every selected part's finished weight, whether it
    // was nested, bought cut to size, or drawn from the shop. Allocated should
    // land on it. Anything left over is a row the plan hasn't accounted for.
    let bomWeight = 0, unpriced = 0;
    for (const row of selectedBom) {
      const qty = parseInt(row.quantity, 10) || 0;
      const wpf = parseFloat(row.weight_per_ft) || 0;
      const L = parseFloat(row.length_nest) || 0;
      const W = row.nest_type === 'Panel' ? (parseFloat(row.width_nest) || 0) : 0;
      if (wpf > 0 && L > 0) bomWeight += calcUnitWeight(wpf, L, W) * qty;
      else if (L > 0) unpriced += qty;
    }
    return {
      totalStock, totalAllocated, totalWaste: totalStock - totalAllocated,
      fromStock, toOrder: totalStock - fromStock,
      bomWeight, unpriced, shortfall: bomWeight - totalAllocated,
    };
  }

  const selectedBom = bom.filter(b => selected.has(b.id) && b.nest_type);
  // Rows marked cut-to-size never reach the nester; everything else does.
  const ctsBom = selectedBom.filter(b => ctsItems.has(b.id));
  const nestBom = selectedBom.filter(b => !ctsItems.has(b.id));
  const formTypes = [...new Set(selectedBom.map(b => b.form_type_name).filter(Boolean))];
  const matTypes = [...new Set(selectedBom.map(b => b.material_type_name).filter(Boolean))];
  // Every group in the job, including the ones bought cut to size — the card is
  // where you switch a group between the two, so it has to be listed either way.
  const nestGroups = buildNestGroups(selectedBom);
  // A group blocks the run if it still needs stock, or if something in it fits
  // none of the sizes entered — the nester would only report that afterwards.
  const groupsNeedingStock = nestGroups.filter(g =>
    g.rows.some(r => !ctsItems.has(r.id)) && (groupStock[g.key] || []).every(s => !(parseFloat(s.len) > 0)));
  const groupsOversize = nestGroups.filter(g =>
    groupOversizeParts(g, groupStock[g.key], ctsItems).length > 0);
  const groupsBlocked = [...new Set([...groupsNeedingStock, ...groupsOversize])];

  // Keyed off nestBom, not selectedBom: a form/material that is entirely
  // cut-to-size needs no stock, so its rows drop out of the Stock Sizes table.
  const bomKeys = new Set(nestBom.map(b => `${b.form_type_id}|${b.material_type_id}`));
  const matchedStock = stock.filter(s => bomKeys.has(`${s.form_type}|${s.material_type}`));

  async function runNesting() {
    setLoading(true);
    setError('');
    setRawResults(null);
    setSelectedPatterns(new Set());
    setShowPurchasePreview(false);
    setSavedRunInfo(null);
    setPurchaseStatus('');
    try {
      const parts1D = [];
      const parts2D = [];
      for (const row of nestBom) {
        if (!row.nest_type || !row.quantity || !row.length_nest) continue;
        if (row.nest_type === 'Linear') {
          parts1D.push({
            bom_line_id: String(row.id),
            part_mark: String(row.bom_item),
            form_type: String(row.form_type_id),
            material_type: String(row.material_id),
            material_origin: String(row.material_type_id),
            material_name: row.material_name || '',
            spec_name: String(row.specification_id),
            density: parseFloat(row.density) || 0,
            length_in: parseFloat(row.length_nest),
            quantity: parseInt(row.quantity),
            form_type_name: row.form_type_name || '',
            mat_type_name: row.material_type_name || '',
            spec_name_display: row.spec_name || '',
            material_name_display: row.material_name || '',
          });
        }
        if (row.nest_type === 'Panel') {
          parts2D.push({
            bom_line_id: String(row.id),
            part_mark: String(row.bom_item),
            form_type: String(row.form_type_id),
            material_type: String(row.material_id),
            material_origin: String(row.material_type_id),
            material_name: row.material_name || '',
            spec_name: String(row.specification_id),
            density: parseFloat(row.density) || 0,
            length_in: parseFloat(row.length_nest),
            width_in: parseFloat(row.width_nest) || 0,
            thickness_in: parseFloat(row.material_dim1) || 0,
            quantity: parseInt(row.quantity),
            grain_direction: grainDirections[row.id] || 'none',
            form_type_name: row.form_type_name || '',
            mat_type_name: row.material_type_name || '',
            spec_name_display: row.spec_name || '',
            material_name_display: row.material_name || '',
          });
        }
      }
      // Stock now comes from what was typed on each nest group card, tagged with
      // that group's material_name so the nester confines it to that material.
      // Groups that are entirely cut-to-size contribute nothing.
      const nestingGroups = nestGroups.filter(g => g.rows.some(r => !ctsItems.has(r.id)));
      const { stock_1d: stock1D, stock_2d: stock2D } = buildStockPayload(nestingGroups, groupStock);
      const payload = {
        project_id: String(projectId || manufactureId || 'standalone'),
        run_number: 1,
        kerf_1d: kerf1D,
        kerf_2d: kerf2D,
        parts_1d: parts1D,
        parts_2d: parts2D,
        stock_1d: stock1D,
        stock_2d: stock2D,
      };
      setLastNestPayload(payload);
      // Everything selected is cut-to-size, so there is nothing to nest. The API
      // rejects an empty parts payload, so synthesize an empty plan instead of
      // calling it — the direct buy lines carry the whole job.
      if (parts1D.length === 0 && parts2D.length === 0) {
        setRawResults({
          project_id: payload.project_id, run_number: 1, results_1d: [], results_2d: [],
          summary: { total_stock_pieces: 0, avg_waste_pct_1d: 0, avg_waste_pct_2d: 0, errors: [] },
          _nameLookup: {},
        });
        setSelectedPatterns(new Set());
        setStep(3);
        return;
      }
      const resp = await fetch(`${API}/api/nest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        let detail = '';
        try {
          const errBody = await resp.json();
          const d = errBody.details ?? errBody.error ?? errBody;
          detail = typeof d === 'string' ? d : JSON.stringify(d);
        } catch (_) { detail = await resp.text().catch(() => ''); }
        console.error('Nesting API failure:', detail);
        throw new Error(`Nesting API error (${resp.status}): ${detail || 'no detail'}`);
      }
      const data = await resp.json();
      const nameLookup = {};
      [...parts1D, ...parts2D].forEach(p => {
        nameLookup[p.form_type] = p.form_type_name;
        nameLookup[p.material_origin] = p.mat_type_name;
        nameLookup[p.spec_name] = p.spec_name_display;
        nameLookup[p.material_type] = p.material_name_display;
      });
      data._nameLookup = nameLookup;
      setRawResults(data);
      autoSelectAllPatterns(data);
      setStep(3);
    } catch (err) {
      setError(err.message || 'Nesting failed');
    } finally {
      setLoading(false);
    }
  }

  async function saveToZoho() {
    if (!results) return;
    const { selected_1d, selected_2d } = getSelectedResults();
    if (selected_1d.length === 0 && selected_2d.length === 0) {
      setSaveStatus('Error: No patterns selected for import');
      return;
    }
    setSaving(true);
    setSaveStatus('');
    try {
      let resp;
      if (isStandalone) {
        // Build parts payload from standaloneParts (the user-entered list)
        const partsPayload = standaloneParts
          .filter(p => p.form_type_id && p.material_type_id && p.quantity > 0)
          .map(p => ({
            client_part_id: p.client_part_id,
            tag: p.tag, component: p.component, drawing: p.drawing,
            form_type_id: p.form_type_id, material_type_id: p.material_type_id,
            specification_id: p.specification_id, material_id: p.material_id,
            quantity: parseInt(p.quantity) || 0,
            length_ft: parseInt(p.length_ft) || 0,
            length_inch_id: p.length_inch_id || '',
            width_ft_id: p.width_ft_id || '',
            width_inch_id: p.width_inch_id || '',
            galv: !!p.galv, plate_sa: !!p.plate_sa,
            nest_type: p.nest_type || 'Linear',
            weight_per_ft: parseFloat(p.weight_per_ft) || 0,
            dim1: parseFloat(p.dim1) || 0,
            density: parseFloat(p.density) || 0,
          }));
        resp = await fetch(`${API}/api/standalone/save-results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manufacturer_id: manufactureId,
            nest_source: nestSource === 'CSV' ? 'CSV' : 'Manual',
            parts: partsPayload,
            results_1d: selected_1d,
            results_2d: selected_2d,
            summary: results.summary,
            kerf_1d: kerf1D,
            kerf_2d: kerf2D,
            run_title: runTitle.trim(),
            run_notes: runNotes.trim(),
            created_by: userEmail,
          }),
        });
      } else {
        resp = await fetch(`${API}/api/project/${projectId}/save-results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            results_1d: selected_1d,
            results_2d: selected_2d,
            summary: results.summary,
            kerf_1d: kerf1D,
            kerf_2d: kerf2D,
            created_by: userEmail,
            run_notes: runNotes.trim(),
          }),
        });
      }
      if (!resp.ok) throw new Error('Save failed');
      const data = await resp.json();
      setSaveStatus(`Saved! Run #${data.run_number} — ${data.saved_1d || 0} 1D + ${data.saved_2d || 0} 2D results (Status: ${data.run_status})`);
      setRunTitle('');
      setRunNotes('');
      setLoadedFromRunNumber(null);
      setLoadedRunIsProject(false);
      setSavedRunInfo(null);
      if (isStandalone) await refreshStandaloneRuns();
    } catch (err) {
      setSaveStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  const selectedPatternCount = selectedPatterns.size;
  const weightSummary = (step === 3 && results) ? calcWeightSummary() : null;
  const stockShortages = (() => {
    if (step !== 3 || !results) return [];
    const usage = {};
    [...(results.results_1d || []), ...(results.results_2d || [])].forEach(r => {
      if (r.error) return;
      // A cut-to-size buy is a new purchase, not a draw against on-hand stock —
      // it must not count a 24' pipe as consumed for a 6" nipple.
      if (r.cut_to_size) return;
      const id = String(r.stock_id);
      usage[id] = (usage[id] || 0) + 1;
    });
    return stock.reduce((acc, s) => {
      const qty = parseInt(s.quantity, 10);
      if (!Number.isFinite(qty) || qty < 0) return acc;
      const used = usage[String(s.id)] || 0;
      if (used > qty) {
        acc.push({
          id: s.id,
          form_type_name: s.form_type_name || s.form_type,
          material_type_name: s.material_type_name || s.material_type,
          stock_length: s.stock_length,
          stock_width: s.stock_width,
          used,
          qty,
          short: used - qty,
        });
      }
      return acc;
    }, []);
  })();
  const purchaseLines = (step === 3 && results && showPurchasePreview) ? buildPurchaseLines() : [];
  const weightMap = (step === 3 && results) ? getWeightMap() : {};

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo-group">
            <img src="/Material Compass Circle Logo.png" alt="Material Compass" className="logo-icon" style={{ width: 40, height: 40, borderRadius: '50%' }} />
            <div>
              <h1 className="logo-title">Material Compass</h1>
              <p className="logo-sub">Nesting</p>
            </div>
          </div>
          {project && (
            <div className="project-badge">
              {project.Project_Quote_Number || project.Project_Description || `Project #${projectId}`}
            </div>
          )}
          {isStandalone && (
            <div className="project-badge">
              Standalone Nesting — Mfg ID {manufactureId.slice(-6)}
            </div>
          )}
          {/* Always reachable, not only after a save. Leaving mid-nest was a
              dead end otherwise — the only way out was the browser button. */}
          {!isStandalone && (returnUrl || window.history.length > 1) && (
            <button
              onClick={() => {
                if (returnUrl) window.location.href = returnUrl;
                else window.history.back();
              }}
              className="btn btn-small"
              title={returnUrl ? 'Return to the project page' : 'Go back to where you came from'}
              style={{
                background: 'transparent',
                color: '#cfd8e3',
                border: '1px solid #3a4757',
                whiteSpace: 'nowrap',
              }}
            >
              ← Back to Project
            </button>
          )}
        </div>
      </header>

      <main className="main" style={isStandalone && step === 1 ? { maxWidth: 1500 } : {}}>
        <div className="steps">
          {['Select Items', 'Configure', 'Results'].map((label, i) => (
            <div key={i} className={`step-dot ${step >= i + 1 ? 'active' : ''} ${step === i + 1 ? 'current' : ''}`}>
              <span className="step-num">{i + 1}</span>
              <span className="step-label">{label}</span>
            </div>
          ))}
        </div>

        {error && <div className="error-box">{error}</div>}
        {loading && <div className="loading-box">Loading...</div>}

        {/* Step 0: Enter Project ID (project mode only) */}
        {step === 0 && !loading && !isStandalone && (
          <div className="card">
            <h2>Enter Project ID</h2>
            <p className="hint">Or pass ?project_id=123 in the URL</p>
            <div className="input-row">
              <input
                type="text"
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                placeholder="Project ID"
                className="input"
              />
              <button onClick={() => loadProject(projectId)} className="btn btn-primary" disabled={!projectId}>
                Load Project
              </button>
            </div>
          </div>
        )}

        {/* Step 1 — Standalone: source toggle + manual entry */}
        {step === 1 && isStandalone && (
          <div className="card">
            <div className="card-header">
              <h2>Quick Nest — Standalone</h2>
              <div className="btn-group">
                <button onClick={() => setNestSource('Manual')} className={`btn btn-small ${nestSource === 'Manual' ? 'btn-primary' : ''}`}>Manual entry</button>
                <button onClick={() => setNestSource('CSV')} className={`btn btn-small ${nestSource === 'CSV' ? 'btn-primary' : ''}`} disabled>CSV upload (coming soon)</button>
              </div>
            </div>
            <p className="hint">
              Saved nests are visible to everyone at your company.
            </p>

            {/* Archive undo toast — appears for 5s after archiving */}
            {archiveUndo && (
              <div style={{
                background: '#323232', color: 'white', padding: '10px 16px',
                borderRadius: 6, marginBottom: 12,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 13, boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
              }}>
                <span>Run #{archiveUndo.runNumber} archived.</span>
                <button
                  onClick={undoArchive}
                  style={{ background: 'transparent', color: '#ffeb3b', border: 'none', fontWeight: 700, textTransform: 'uppercase', fontSize: 12, cursor: 'pointer', padding: '4px 12px' }}
                >
                  Undo
                </button>
              </div>
            )}

            {/* Recall panel: previously saved standalone nests */}
            <div style={{ background: 'white', border: '1px solid #e2e6eb', borderRadius: 6, marginBottom: 18, overflow: 'hidden' }}>
              <div style={{ background: '#f5f6f8', padding: '10px 16px', fontSize: 12, fontWeight: 600, color: '#444', borderBottom: savedNestsExpanded ? '1px solid #e2e6eb' : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span
                  onClick={() => setSavedNestsExpanded(v => !v)}
                  style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 6 }}
                  title={savedNestsExpanded ? 'Collapse' : 'Expand'}
                >
                  <span style={{ fontSize: 10, transition: 'transform 0.15s', display: 'inline-block', transform: savedNestsExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                  SAVED NESTS ({standaloneRuns.length})
                </span>
                <span style={{ fontWeight: 400, color: '#888', display: savedNestsExpanded ? 'flex' : 'none', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={runsSearch}
                    onChange={e => { setRunsSearch(e.target.value); setShowAllRuns(false); }}
                    placeholder="Search title / project / notes..."
                    style={{ fontSize: 11, padding: '3px 8px', width: 220, border: '1px solid #ccc', borderRadius: 3 }}
                  />
                  <span style={{ fontSize: 10, fontWeight: 600 }}>SOURCE:</span>
                  <select
                    value={runsSource}
                    onChange={e => { setRunsSource(e.target.value); setShowAllRuns(false); }}
                    style={{ fontSize: 11, padding: '2px 6px' }}
                  >
                    <option value="All">All</option>
                    <option value="Manual">Manual</option>
                    <option value="CSV">CSV</option>
                    <option value="Project">Project</option>
                  </select>
                  <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 6 }}>STATUS:</span>
                  <select
                    value={runsFilter}
                    onChange={e => { setRunsFilter(e.target.value); setShowAllRuns(false); }}
                    style={{ fontSize: 11, padding: '2px 6px' }}
                  >
                    <option value="Active">Active</option>
                    <option value="Archived">Archived</option>
                    <option value="All">All</option>
                  </select>
                  {filteredStandaloneRuns.length > 0 && (
                    <span>
                      {showAllRuns ? `${filteredStandaloneRuns.length} of ${filteredStandaloneRuns.length}` : `${Math.min(5, filteredStandaloneRuns.length)} of ${filteredStandaloneRuns.length}`}
                    </span>
                  )}
                  {filteredStandaloneRuns.length > 5 && (
                    <button
                      onClick={() => setShowAllRuns(v => !v)}
                      className="btn btn-small"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                    >
                      {showAllRuns ? 'Show less' : 'Show all'}
                    </button>
                  )}
                </span>
              </div>
              {!savedNestsExpanded ? null : filteredStandaloneRuns.length === 0 ? (
                <div style={{ padding: '20px 16px', fontSize: 12, color: '#888', textAlign: 'center' }}>
                  No {runsFilter === 'All' ? '' : runsFilter.toLowerCase()} {runsSource === 'All' ? '' : runsSource.toLowerCase()} nests {runsSource !== 'All' ? 'in this category ' : ''}saved yet.
                </div>
              ) : (
                <div>
                  {(showAllRuns ? filteredStandaloneRuns : filteredStandaloneRuns.slice(0, 5)).map(run => {
                    const sourceTagStyle = run.nest_source === 'CSV'
                      ? { background: '#f3e5f5', color: '#7b1fa2' }
                      : run.nest_source === 'Project'
                        ? { background: '#e8f5e9', color: '#2e7d32' }
                        : { background: '#e3f2fd', color: '#1976d2' };
                    const isArchived = run.run_status === 'Archived';
                    const isProject = run.nest_source === 'Project';
                    // Title fallback: explicit title > project name > "Untitled"
                    const titleNode = run.run_title
                      ? <span>{run.run_title}</span>
                      : run.project_name
                        ? <span>Project: <strong>{run.project_name}</strong></span>
                        : <span style={{ color: '#999', fontWeight: 400, fontStyle: 'italic' }}>Untitled</span>;
                    return (
                      <div key={run.id} style={{
                        padding: '10px 16px', borderBottom: '1px solid #f0f2f5',
                        display: 'grid', gridTemplateColumns: '70px 70px 1fr 130px 60px 80px 80px',
                        gap: 10, alignItems: 'center', fontSize: 12,
                        opacity: isArchived ? 0.65 : 1
                      }}>
                        <span style={{ fontWeight: 600, color: '#5F94CE' }}>Run #{run.run_number}</span>
                        <span style={{ ...sourceTagStyle, padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, textAlign: 'center' }}>
                          {(run.nest_source || '?').toUpperCase()}
                        </span>
                        <span style={{ color: '#222', overflow: 'hidden' }}>
                          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                            {titleNode}
                          </div>
                          <div style={{ fontSize: 11, color: '#666', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                            {run.total_stock_pieces} stock pcs
                            {run.created_by ? ` • saved by ${emailLocalPart(run.created_by)}` : ''}
                            {isArchived ? ' • archived' : ''}
                          </div>
                        </span>
                        <span style={{ color: '#888', fontSize: 11 }}>{run.run_date}</span>
                        <button
                          onClick={() => loadStandaloneRun(run.id)}
                          className="btn btn-small"
                          disabled={loadingRunId === run.id}
                          style={{ fontSize: 11, padding: '4px 8px' }}
                          title="Load this run (view + revise standalone)"
                        >
                          {loadingRunId === run.id ? '…' : 'Load'}
                        </button>
                        {isProject ? (
                          <span style={{ fontSize: 10, color: '#888', textAlign: 'center' }} title="Project runs can't be duplicated from the standalone tool">—</span>
                        ) : (
                          <button
                            onClick={() => duplicateStandaloneRun(run.id)}
                            className="btn btn-small"
                            disabled={loadingRunId === run.id}
                            style={{ fontSize: 11, padding: '4px 8px' }}
                            title="Duplicate as a fresh new run (parts copied, title cleared)"
                          >
                            Duplicate
                          </button>
                        )}
                        {isProject ? (
                          <span style={{ fontSize: 10, color: '#888', textAlign: 'center' }} title="Manage project runs from the project page">—</span>
                        ) : (
                          <button
                            onClick={() => archiveStandaloneRun(run.id, isArchived ? 'Approved' : 'Archived')}
                            className="btn btn-small"
                            disabled={archivingRunId === run.id}
                            style={{ fontSize: 11, padding: '4px 8px' }}
                            title={isArchived ? 'Restore to Active' : 'Archive (hide from default view)'}
                          >
                            {archivingRunId === run.id ? '…' : (isArchived ? 'Restore' : 'Archive')}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Section divider — visually separate "review past nests" from "start a new nest" */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 32, marginBottom: 14 }}>
              <div style={{ flex: 1, height: 1, background: '#d4dde6' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#5F94CE', letterSpacing: 1, textTransform: 'uppercase' }}>
                {loadedFromRunNumber ? `Edit copy of Run #${loadedFromRunNumber}` : 'Start a new nest'}
              </span>
              <div style={{ flex: 1, height: 1, background: '#d4dde6' }} />
            </div>

            {/* Banner shown when user has loaded a previous standalone run for revision */}
            {loadedFromRunNumber && !loadedRunIsProject && (
              <div style={{ background: '#e3f2fd', border: '1px solid #90caf9', borderRadius: 6, padding: '8px 14px', marginBottom: 14, fontSize: 12, color: '#0d47a1', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Editing a copy of Run #{loadedFromRunNumber}. Saving will create a new run; the original remains unchanged.</span>
                <button
                  onClick={() => {
                    setLoadedFromRunNumber(null);
                    setLoadedRunIsProject(false);
                    setSavedRunInfo(null);
                    setStandaloneParts([]);
                    setStock([]);
                    setGroupStock({});
                    setOpenGroups(new Set());
                    setRawResults(null);
                    setRunTitle('');
                    setRunNotes('');
                  }}
                  className="btn btn-small"
                  style={{ fontSize: 11 }}
                >
                  Clear & start fresh
                </button>
              </div>
            )}

            {/* Run title — labels the new nest the user is about to enter (required) */}
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#5F94CE', textTransform: 'uppercase', letterSpacing: 0.5, minWidth: 100 }}>
                Run Title <span style={{ color: '#d32f2f' }}>*</span>
              </label>
              <input
                type="text"
                value={runTitle}
                onChange={e => setRunTitle(e.target.value)}
                placeholder="Required — e.g. 'Smith Job', 'Shop scrap nest', 'Quote #1234'"
                className="input"
                style={{ flex: 1, maxWidth: 500, borderColor: runTitle.trim() ? '' : '#f5b7b1' }}
              />
            </div>

            {/* Run notes — optional free-text for longer context */}
            <div style={{ marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#5F94CE', textTransform: 'uppercase', letterSpacing: 0.5, minWidth: 100, paddingTop: 6 }}>
                Notes
              </label>
              <textarea
                value={runNotes}
                onChange={e => setRunNotes(e.target.value)}
                placeholder="Optional — context, customer requests, follow-up items..."
                className="input"
                rows={2}
                style={{ flex: 1, maxWidth: 700, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>

            <ManualPartsEntry
              parts={standaloneParts}
              onChange={setStandaloneParts}
              lookupTables={standaloneLookups}
              onLookupTablesLoaded={setStandaloneLookups}
            />
            <div className="card-footer">
              <span className="count">
                {standaloneParts.length} part{standaloneParts.length !== 1 ? 's' : ''} entered
                {(() => {
                  const liTbl = standaloneLookups.lengthInch || [];
                  const isPartValid = (p) => {
                    let lenIn = (parseInt(p.length_ft) || 0) * 12;
                    if (p.length_inch_id) {
                      const rec = liTbl.find(r => String(r.id) === String(p.length_inch_id));
                      if (rec) lenIn += parseFloat(rec.result) || 0;
                    }
                    return !!(p.form_type_id && p.material_type_id && p.specification_id && p.material_id
                      && parseInt(p.quantity) > 0 && lenIn > 0);
                  };
                  const incomplete = standaloneParts.filter(p => !isPartValid(p)).length;
                  if (!runTitle.trim()) return <span style={{ color: '#d32f2f', marginLeft: 8 }}>— Run Title required</span>;
                  if (incomplete > 0) return <span style={{ color: '#d32f2f', marginLeft: 8 }}>— {incomplete} incomplete</span>;
                  return null;
                })()}
              </span>
              <button
                onClick={() => setStep(2)}
                className="btn btn-primary"
                disabled={(() => {
                  if (!runTitle.trim()) return true;
                  if (standaloneParts.length === 0) return true;
                  const liTbl = standaloneLookups.lengthInch || [];
                  return standaloneParts.some(p => {
                    let lenIn = (parseInt(p.length_ft) || 0) * 12;
                    if (p.length_inch_id) {
                      const rec = liTbl.find(r => String(r.id) === String(p.length_inch_id));
                      if (rec) lenIn += parseFloat(rec.result) || 0;
                    }
                    return !(p.form_type_id && p.material_type_id && p.specification_id && p.material_id
                      && parseInt(p.quantity) > 0 && lenIn > 0);
                  });
                })()}
              >
                Next → Configure
              </button>
            </div>
          </div>
        )}

        {/* Step 1 — Project mode: BOM */}
        {step === 1 && !isStandalone && (
          <div className="card">
            <div className="card-header">
              <h2>Bill of Materials</h2>
              <div className="btn-group">
                <button onClick={selectAll} className="btn btn-small">Select All</button>
                <button onClick={selectNone} className="btn btn-small">Clear</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th></th><th>Mark</th><th>Type</th><th>Form</th><th>Material</th>
                    <th>Spec</th><th>Size</th><th>Qty</th><th>Length</th><th>Width</th><th>Wt/Ft</th>
                  </tr>
                </thead>
                <tbody>
                  {bom.map(item => (
                    <tr key={item.id} className={selected.has(item.id) ? 'row-selected' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(item.id)}
                          onChange={() => toggleSelect(item.id)}
                          disabled={!item.nest_type}
                        />
                      </td>
                      <td className="mono">{item.bom_item}</td>
                      <td>
                        <span className={`badge ${item.nest_type === 'Linear' ? 'badge-1d' : item.nest_type === 'Panel' ? 'badge-2d' : ''}`}>
                          {item.nest_type || '—'}
                        </span>
                      </td>
                      <td>{item.form_type_name}</td>
                      <td>{item.material_name}</td>
                      <td>{item.spec_name}</td>
                      <td>{item.material_type_name}</td>
                      <td className="num">{item.quantity}</td>
                      <td className="num">{item.length_nest ? inToFt(item.length_nest) : '—'}</td>
                      <td className="num">{item.width_nest && parseFloat(item.width_nest) > 0 ? inToFt(item.width_nest) : '—'}</td>
                      <td className="num">{item.weight_per_ft ? `${parseFloat(item.weight_per_ft).toFixed(2)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Saved Nesting Run Banner */}
            {savedRunInfo && results && (
              <div className="save-status save-success" style={{ margin: '12px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  Previous nesting run found — Run #{savedRunInfo.run_number} ({savedRunInfo.run_date}) — {results.summary?.total_stock_pieces || 0} stock pieces — Status: {savedRunInfo.run_status}
                {savedRunInfo.superseded_only && (
                  <strong style={{ color: '#b06a1f', display: 'block', marginTop: 4 }}>
                    No approved run on file — this is the newest saved run. A save that was
                    interrupted can leave a project in this state; re-import the patterns to
                    approve it again.
                  </strong>
                )}
                </span>
                <button onClick={() => setStep(3)} className="btn btn-primary btn-small" style={{ marginLeft: 12 }}>
                  View Saved Results →
                </button>
              </div>
            )}
            <div className="card-footer">
              <span className="count">{selected.size} items selected</span>
              <div className="btn-group">
                <button onClick={viewNestingResults} className="btn btn-secondary" disabled={loadingSavedResults}>
                  {loadingSavedResults ? 'Loading...' : 'View Nesting Results'}
                </button>
                <button onClick={fetchSavedPurchaseList} className="btn btn-secondary" disabled={loadingSavedPurchase}>
                  {loadingSavedPurchase ? 'Loading...' : 'View Saved Purchase List'}
                </button>
                <button onClick={() => setStep(2)} className="btn btn-primary" disabled={selected.size === 0}>
                  Next → Configure
                </button>
              </div>
            </div>

            {/* Saved Purchase List Display */}
            {showSavedPurchase && (
              <div className="result-section" style={{ marginTop: 16 }}>
                <div className="card-header">
                  <h3>Saved Purchase List ({savedPurchaseLines.length} items)</h3>
                  <div className="btn-group">
                    <button onClick={viewNestingResults} className="btn btn-small btn-primary" disabled={loadingSavedResults}>
                      {loadingSavedResults ? 'Loading...' : 'View Nesting Results →'}
                    </button>
                    <button onClick={() => setShowSavedPurchase(false)} className="btn btn-small">Close</button>
                  </div>
                </div>
                {savedPurchaseLines.length === 0 ? (
                  <p className="hint">No purchase list saved for this project yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>#</th><th>Description</th><th>Form Type</th><th>Material</th>
                          <th>Spec</th><th>Qty</th><th>Feet</th><th>Wt/Ft</th>
                          <th className="num">Unit Wt</th><th className="num">Total Wt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {savedPurchaseLines.map((line, i) => (
                          <tr key={i}>
                            <td className="num">{line.line_item}</td>
                            <td>{line.item_description || line.description}</td>
                            <td>{line.form_type_name}</td>
                            <td>{line.material_name}</td>
                            <td>{line.spec_name}</td>
                            <td className="num">{line.quantity}</td>
                            <td className="num">{line.feet_length}</td>
                            <td className="num">{line.weight_per_ft > 0 ? line.weight_per_ft.toFixed(2) : '—'}</td>
                            <td className="num">{line.unit_weight > 0 ? fmtLbs(line.unit_weight) : '—'}</td>
                            <td className="num">{line.total_weight > 0 ? fmtLbs(line.total_weight) : '—'}</td>
                          </tr>
                        ))}
                        <tr className="purchase-total-row">
                          <td></td>
                          <td><strong>Total</strong></td>
                          <td></td><td></td><td></td>
                          <td className="num"><strong>{savedPurchaseLines.reduce((s, l) => s + l.quantity, 0)}</strong></td>
                          <td></td><td></td><td></td>
                          <td className="num"><strong>{fmtLbs(savedPurchaseLines.reduce((s, l) => s + l.total_weight, 0))}</strong></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Configure */}
        {step === 2 && (
          <div className="card">
            <h2>Nesting Configuration</h2>
            <div className="config-grid">
              <div className="config-section">
                <h3>Kerf Settings</h3>
                <div className="field">
                  <label>1D Kerf (inches)</label>
                  <input type="number" step="0.0625" value={kerf1D} onChange={e => setKerf1D(parseFloat(e.target.value) || 0)} className="input" />
                </div>
                <div className="field">
                  <label>2D Kerf (inches)</label>
                  <input type="number" step="0.0625" value={kerf2D} onChange={e => setKerf2D(parseFloat(e.target.value) || 0)} className="input" />
                </div>

                <h3 style={{ marginTop: 22 }}>Cut To Size</h3>
                <p className="hint" style={{ marginTop: -6 }}>
                  Any stock piece that ends up barely used gets re-quoted as a piece
                  cut to size instead of a full length or full sheet. Applies after
                  nesting — change it any time without re-running.
                </p>
                <div className="field">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={cts.enabled}
                      onChange={e => setCts(p => ({ ...p, enabled: e.target.checked }))}
                    />
                    Re-quote low-utilization pieces as cut to size
                  </label>
                </div>
                <div className="field">
                  <label>Convert below this utilization (%)</label>
                  <input
                    type="number" min="0" max="100" step="5" className="input"
                    value={cts.utilThresholdPct}
                    disabled={!cts.enabled}
                    onChange={e => setCts(p => ({ ...p, utilThresholdPct: Math.min(Math.max(parseFloat(e.target.value) || 0, 0), 100) }))}
                  />
                  <p className="hint">
                    Picks <em>which</em> pieces convert, not how small they are — a converted
                    piece is always the smallest it can be. Lower = fewer conversions and more
                    full stock. Higher = more pieces bought cut, more cut charges.
                  </p>
                </div>
                <div className="field">
                  <label>Linear square-up allowance (in)</label>
                  <input
                    type="number" min="0" step="0.5" className="input"
                    value={cts.trimLinearIn}
                    onChange={e => setCts(p => ({ ...p, trimLinearIn: Math.max(parseFloat(e.target.value) || 0, 0) }))}
                  />
                  <p className="hint">
                    Leave at 0 and a cut-to-size piece is the finished length, nothing added.
                    Raise it only if you intend to face off the supplier's cut end. Separate from
                    kerf — a piece that arrives at length needs no cut from you.
                  </p>
                </div>
                <div className="field">
                  <label>Plate edge trim, per side (in)</label>
                  <input
                    type="number" min="0" step="0.5" className="input"
                    value={cts.trimPanelIn}
                    onChange={e => setCts(p => ({ ...p, trimPanelIn: Math.max(parseFloat(e.target.value) || 0, 0) }))}
                  />
                  <p className="hint">
                    Leave at 0 and a 9" × 2" part buys 9" × 2" — no minimum width, no padding.
                    Raise it only if you want mill edge to face off, which adds to all four edges.
                  </p>
                </div>
                <div className="field">
                  <label>Round buy sizes up to (in)</label>
                  <input
                    type="number" min="0" step="0.125" className="input"
                    value={cts.roundToIn}
                    onChange={e => setCts(p => ({ ...p, roundToIn: Math.max(parseFloat(e.target.value) || 0, 0) }))}
                  />
                  <p className="hint">Keeps buy sizes orderable — 1/8" lands on a real increment, where 9.0313" does not.</p>
                </div>
              </div>
              <div className="config-section config-full">
                <div className="stock-header">
                  <h3>Nest Groups</h3>
                  <div className="stock-controls">
                    <div className="btn-group">
                      <button className="btn btn-small" onClick={() => setOpenGroups(new Set(nestGroups.map(g => g.key)))}>Expand All</button>
                      <button className="btn btn-small" onClick={() => setOpenGroups(new Set())}>Collapse All</button>
                      <button
                        className="btn btn-small"
                        title="Check the groups whose parts can't fill the smallest library size for their material"
                        onClick={() => setCtsItems(suggestCtsItems(selectedBom, stock, new Set(stock.map(s => s.id)), cts))}
                      >
                        Suggest Cut To Size
                      </button>
                    </div>
                  </div>
                </div>
                <p className="hint">
                  One card per material. Enter the stock sizes you actually have — a
                  blank quantity means as many as needed. Click a size below the rows to
                  add it. Switch a group to Cut To Size and it leaves the nest entirely.
                </p>

                {nestGroups.length === 0 && <p className="hint">No items selected</p>}

                {nestGroups.map(group => {
                  const open = openGroups.has(group.key);
                  const entries = groupStock[group.key] || [];
                  const groupCts = group.rows.filter(r => ctsItems.has(r.id));
                  const allCts = groupCts.length === group.rows.length;
                  const someCts = groupCts.length > 0 && !allCts;
                  const chips = groupChips(group, stock);
                  const stdChips = chips.filter(c => c.standard);
                  const ownChips = chips.filter(c => !c.standard);
                  const fill = groupFillPct(group, entries);
                  const totals = groupTotals(group);
                  const specLabel = group.specs.length > 1 ? `${group.specs.length} specs` : (group.specs[0] || '');

                  const oversize = groupOversizeParts(group, entries, ctsItems);
                  let hint, hintWarn = false, hintBad = false;
                  if (allCts) {
                    hint = 'Bought cut to size — no stock needed.';
                  } else if (oversize.length > 0) {
                    // Say this instead of a fill percentage: "needs 104 sticks" is
                    // arithmetic on a stock size that can't hold the part at all.
                    const biggest = oversize.reduce((a, b) =>
                      (parseFloat(b.length_nest) || 0) > (parseFloat(a.length_nest) || 0) ? b : a);
                    hint = `Won't fit: ${oversize.map(r => r.bom_item).join(', ')} — `
                      + `${group.is2D
                          ? `${parseFloat(biggest.length_nest)}" × ${parseFloat(biggest.width_nest)}"`
                          : `${parseFloat(biggest.length_nest)}"`}`
                      + ' is bigger than every stock size entered. Add a bigger size, or switch these to Cut To Size.';
                    hintBad = true;
                  } else if (fill === null) {
                    hint = "No stock entered — this group can't be nested yet.";
                    hintWarn = true;
                  } else if (fill < cts.utilThresholdPct) {
                    hint = `Parts fill only ${Math.round(fill)}% of the smallest ${group.is2D ? 'sheet' : 'stick'} — consider Cut To Size.`;
                    hintWarn = true;
                  } else if (fill <= 100) {
                    hint = `Parts fill ${Math.round(fill)}% of one ${group.is2D ? 'sheet' : 'stick'}.`;
                  } else {
                    hint = `Parts need about ${Math.ceil(fill / 100)} ${group.is2D ? 'sheets' : 'sticks'} (${Math.round(fill)}% of one).`;
                  }

                  // A chip carrying a reference is a specific piece in the shop, so it
                  // lands as On Hand with its count. A catalog size lands as To Order.
                  const addChip = c => addGroupStock(group.key, {
                    len: String(c.len), wid: c.wid ? String(c.wid) : '',
                    qty: c.quantity || '', ref: c.reference || '', standard: c.standard,
                    onHand: !!c.reference,
                  });

                  return (
                    <div
                      key={group.key}
                      style={{
                        border: `1px solid ${allCts ? '#1b5e20' : 'var(--gray-300)'}`,
                        borderRadius: 4, marginBottom: 8, overflow: 'hidden',
                      }}
                    >
                      <button
                        onClick={() => toggleGroupOpen(group.key)}
                        aria-expanded={open}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                          padding: '9px 12px', background: 'none', border: 0, cursor: 'pointer',
                          font: 'inherit', fontSize: 12, textAlign: 'left', color: 'inherit',
                        }}
                      >
                        <span style={{ color: 'var(--gray-400)', fontSize: 10, width: 10 }}>{open ? '▼' : '▶'}</span>
                        <span className={`badge ${group.is2D ? 'badge-2d' : 'badge-1d'}`}>{group.is2D ? '2D' : '1D'}</span>
                        <strong>{group.form_type_name}{group.material_name ? ` · ${group.material_name}` : ''}</strong>
                        <span style={{ color: 'var(--gray-600)', flex: 1, minWidth: 0, fontSize: 11 }}>
                          {group.material_type_name}{specLabel ? ` · ${specLabel}` : ''}
                        </span>
                        {allCts && <span className="badge" style={{ background: '#e6f4ea', color: '#1b5e20' }}>Cut To Size</span>}
                        {someCts && <span className="badge" style={{ background: '#e6f4ea', color: '#1b5e20' }}>{groupCts.length} cut</span>}
                        {!allCts && entries.length === 0 && (
                          <span className="badge" style={{ background: '#fdecea', color: '#b71c1c' }}>No stock</span>
                        )}
                        {!allCts && entries.length > 0 && oversize.length > 0 && (
                          <span className="badge" style={{ background: '#fdecea', color: '#b71c1c' }}>Won't fit</span>
                        )}
                        <span style={{ fontSize: 11, color: 'var(--gray-600)', whiteSpace: 'nowrap' }}>
                          {group.pieces} pcs
                          {' · '}
                          {group.is2D ? fmtArea(totals.areaIn2) : inToFt(totals.lengthIn)}
                          {totals.lbs > 0 && ` · ${fmtLbs(totals.lbs)}`}
                        </span>
                      </button>

                      {open && (
                        <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--gray-200)' }}>
                          <div className="filter-tabs" style={{ margin: '10px 0 12px' }}>
                            <button
                              className={`filter-btn ${!allCts ? 'active' : ''}`}
                              onClick={() => setGroupMode(group, 'nest')}
                            >
                              Nest From Stock
                            </button>
                            <button
                              className={`filter-btn ${allCts ? 'active' : ''}`}
                              onClick={() => setGroupMode(group, 'cts')}
                            >
                              Cut To Size
                            </button>
                          </div>

                          <table className="table" style={{ marginBottom: 4 }}>
                            <thead>
                              <tr>
                                <th style={{ width: 34 }}>Cut</th>
                                {/* Mark absorbs the slack so the numeric columns hug
                                    their values instead of drifting apart. */}
                                <th style={{ width: '100%' }}>Mark</th>
                                <th className="num">Qty</th>
                                <th className="num">{group.is2D ? 'Size' : 'Length'}</th>
                                <th className="num">{group.is2D ? 'Total Area' : 'Total Length'}</th>
                                <th className="num">Buys</th>
                                {group.is2D && <th>Grain</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {group.rows.map(row => {
                                const on = ctsItems.has(row.id);
                                const dims = ctsItemBuyDims(row, ctsOpts);
                                const L = parseFloat(row.length_nest) || 0;
                                const W = parseFloat(row.width_nest) || 0;
                                const grain = grainDirections[row.id] || 'none';
                                return (
                                  <tr key={row.id} style={on ? { background: '#f1f8f2' } : undefined}>
                                    <td>
                                      <input
                                        type="checkbox"
                                        checked={on}
                                        disabled={!dims}
                                        title={dims ? 'Buy this part cut to size instead of nesting it' : 'Needs a part length (and width for panels)'}
                                        onChange={() => setCtsItems(prev => {
                                          const next = new Set(prev);
                                          if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                                          return next;
                                        })}
                                      />
                                    </td>
                                    <td className="mono">{row.bom_item}</td>
                                    <td className="num">{parseInt(row.quantity, 10) || 0}</td>
                                    <td className="num">{group.is2D ? `${L}" × ${W}"` : `${L}"`}</td>
                                    <td className="num">
                                      {group.is2D ? fmtArea(rowExtended(row, true)) : `${rowExtended(row, false)}"`}
                                    </td>
                                    <td className="num" style={{ color: on ? '#1b5e20' : 'var(--gray-400)' }}>
                                      {on && dims
                                        ? (dims.is2D ? `${dims.buy_length_in}" × ${dims.buy_width_in}"` : `${dims.buy_length_in}"`)
                                        : '—'}
                                    </td>
                                    {group.is2D && (
                                      <td>
                                        {on ? <span style={{ color: 'var(--gray-400)' }}>—</span> : (
                                          <div className="filter-tabs">
                                            {[['none', 'None'], ['length', 'L'], ['width', 'W']].map(([val, lab]) => (
                                              <button
                                                key={val}
                                                className={`filter-btn ${grain === val ? 'active' : ''}`}
                                                style={{ padding: '2px 7px', fontSize: 10 }}
                                                title={val === 'none' ? 'Allow the part to rotate 90°' : `Lock grain to ${val}`}
                                                onClick={() => setGrainDirections(prev => ({ ...prev, [row.id]: val }))}
                                              >
                                                {lab}
                                              </button>
                                            ))}
                                          </div>
                                        )}
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                              <tr style={{ borderTop: '2px solid var(--gray-300)', fontWeight: 700 }}>
                                <td />
                                <td>Total</td>
                                <td className="num">{group.pieces}</td>
                                <td />
                                <td className="num">
                                  {group.is2D ? fmtArea(totals.areaIn2) : `${Math.round(totals.lengthIn * 100) / 100}"`}
                                </td>
                                <td className="num" colSpan={group.is2D ? 2 : 1}>
                                  {totals.lbs > 0 ? fmtLbs(totals.lbs) : '—'}
                                </td>
                              </tr>
                              {!group.is2D && totals.lengthIn > 0 && (
                                <tr>
                                  <td /><td colSpan={5} className="hint" style={{ paddingTop: 2 }}>
                                    {inToFt(totals.lengthIn)} of {group.material_name || group.form_type_name} to cut
                                    {totals.unweighed > 0 && ` — ${totals.unweighed} pc(s) have no Weight_Per_Ft, so the weight is understated`}
                                  </td>
                                </tr>
                              )}
                              {group.is2D && totals.unweighed > 0 && (
                                <tr>
                                  <td /><td colSpan={6} className="hint" style={{ paddingTop: 2 }}>
                                    {totals.unweighed} pc(s) have no Weight_Per_Ft, so the weight is understated
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>

                          {!allCts && (
                            <>
                              <p className="hint" style={{ margin: '12px 0 5px', fontSize: 11 }}>Stock sizes to nest from</p>
                              {entries.map((s, i) => (
                                <div
                                  key={i}
                                  style={{
                                    display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, flexWrap: 'wrap',
                                    background: s.onHand ? '#f1f8f2' : undefined,
                                    borderLeft: s.onHand ? '3px solid #1b5e20' : '3px solid transparent',
                                    paddingLeft: 5,
                                  }}
                                >
                                  <div className="filter-tabs">
                                    <button
                                      className={`filter-btn ${!s.onHand ? 'active' : ''}`}
                                      style={{ padding: '3px 8px', fontSize: 10 }}
                                      title="Buy this size — it goes on the purchase list"
                                      onClick={() => updateGroupStock(group.key, i, 'onHand', false)}
                                    >
                                      To Order
                                    </button>
                                    <button
                                      className={`filter-btn ${s.onHand ? 'active' : ''}`}
                                      style={{ padding: '3px 8px', fontSize: 10 }}
                                      title="Already in the shop — allocated, never purchased"
                                      onClick={() => updateGroupStock(group.key, i, 'onHand', true)}
                                    >
                                      On Hand
                                    </button>
                                  </div>
                                  <label style={FIELD}>
                                    <span style={FIELD_LBL}>Length (in)</span>
                                  <input
                                    className="input" style={{ width: 90 }}
                                    value={s.len} placeholder="0"
                                    aria-label="Stock length in inches"
                                    onChange={e => updateGroupStock(group.key, i, 'len', e.target.value)}
                                  />
                                    </label>
                                  {group.is2D && (
                                    <label style={FIELD}>
                                      <span style={FIELD_LBL}>Width (in)</span>
                                      <input
                                        className="input" style={{ width: 90 }}
                                        value={s.wid || ''} placeholder="0"
                                        aria-label="Stock width in inches"
                                        onChange={e => updateGroupStock(group.key, i, 'wid', e.target.value)}
                                      />
                                    </label>
                                  )}
                                  <label style={FIELD}>
                                    <span style={FIELD_LBL}>How many</span>
                                  <input
                                    className="input" style={{ width: 80 }}
                                    value={s.qty || ''} placeholder={s.onHand ? '1' : 'all'}
                                    aria-label={s.onHand ? 'How many you have' : 'How many to buy, blank for as many as needed'}
                                    onChange={e => updateGroupStock(group.key, i, 'qty', e.target.value)}
                                  />
                                  </label>
                                  {!String(s.qty || '').trim() && (
                                    <span style={{ fontSize: 11, color: s.onHand ? '#b06a1f' : 'var(--gray-400)', fontStyle: 'italic', alignSelf: 'flex-end', paddingBottom: 6 }}>
                                      {s.onHand ? 'assumes 1' : 'as many as needed'}
                                    </span>
                                  )}
                                  <label style={FIELD}>
                                    <span style={FIELD_LBL}>Heat # / bin</span>
                                  <input
                                    className="input" style={{ width: 130 }}
                                    value={s.ref || ''} placeholder="optional"
                                    aria-label="Reference"
                                    onChange={e => updateGroupStock(group.key, i, 'ref', e.target.value)}
                                  />
                                  </label>
                                  <button
                                    className="btn btn-small"
                                    style={{ alignSelf: 'flex-end', marginBottom: 1 }}
                                    aria-label="Remove this stock size"
                                    onClick={() => removeGroupStock(group.key, i)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                              <button
                                className="btn btn-small"
                                onClick={() => addGroupStock(group.key, { len: '', wid: '', qty: '', ref: '', standard: false })}
                              >
                                + Add Size
                              </button>

                              {stdChips.length > 0 && (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                                  <span style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--gray-400)' }}>Standard</span>
                                  {stdChips.map(c => (
                                    <button
                                      key={c.label} className="btn btn-small"
                                      style={{ borderRadius: 999, fontSize: 11, padding: '2px 10px' }}
                                      onClick={() => addChip(c)}
                                    >
                                      {c.wid ? `${c.len}" × ${c.wid}"` : `${c.len}"`}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {ownChips.length > 0 && (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                                  <span style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--gray-400)' }}>Your sizes</span>
                                  {ownChips.map(c => (
                                    <button
                                      key={c.label} className="btn btn-small"
                                      style={{ borderRadius: 999, fontSize: 11, padding: '2px 10px' }}
                                      onClick={() => addChip(c)}
                                    >
                                      {c.wid ? `${c.len}" × ${c.wid}"` : `${c.len}"`}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {chips.length === 0 && (
                                <p className="hint" style={{ marginTop: 8, fontSize: 11 }}>
                                  No library sizes for this material — type the size you buy.
                                </p>
                              )}
                            </>
                          )}

                          <p
                            className="hint"
                            style={{ marginTop: 12, paddingTop: 8, borderTop: '1px dashed var(--gray-200)', color: hintBad ? '#b71c1c' : (hintWarn ? '#b06a1f' : undefined), fontWeight: hintBad ? 600 : undefined }}
                          >
                            {hint}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="card-footer">
              <button onClick={() => setStep(1)} className="btn">← Back</button>
              <div className="btn-group" style={{ alignItems: 'center' }}>
                <span className="count">
                  {nestGroups.length - groupsBlocked.length} of {nestGroups.length} groups ready
                  {groupsNeedingStock.length > 0 && ` — ${groupsNeedingStock.length} need stock`}
                  {groupsOversize.length > 0 && ` — ${groupsOversize.length} have parts too big for the stock entered`}
                </span>
                <button
                  onClick={runNesting}
                  className="btn btn-primary"
                  title={groupsBlocked.length > 0
                    ? `Fix first: ${groupsBlocked.map(g => g.form_type_name + (g.material_name ? ' ' + g.material_name : '')).join(', ')}`
                    : ''}
                  disabled={loading || groupsBlocked.length > 0 || nestGroups.length === 0}
                >
                  {loading ? 'Running...' : 'Run Nesting'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Results */}
        {/* Never leave Results blank. Any route that lands here without a plan
            gets an explanation and a way out, rather than an empty page. */}
        {step === 3 && !results && (
          <div className="card">
            <h2>Nesting Results</h2>
            <p className="hint">
              Nothing to show — no nesting run is loaded. Pick your items and run a nest,
              and the cut patterns will appear here.
            </p>
            <div className="card-footer">
              <button onClick={() => setStep(1)} className="btn">← {isStandalone ? 'Edit Parts' : 'Select Items'}</button>
              <button onClick={() => setStep(2)} className="btn btn-primary" disabled={selected.size === 0}>
                Configure →
              </button>
            </div>
          </div>
        )}

        {step === 3 && results && (
          <div className="card">
            <div className="card-header">
              <h2>Nesting Results</h2>
              <div className="btn-group">
                <button onClick={selectAllPatterns} className="btn btn-small">Select All Patterns</button>
                <button onClick={clearAllPatterns} className="btn btn-small">Clear Selection</button>
                <button onClick={() => window.print()} className="btn btn-small btn-print">Print</button>
              </div>
            </div>
            {savedRunInfo && (
              <div className="save-status save-success" style={{ marginBottom: 12 }}>
                Viewing saved nesting run #{savedRunInfo.run_number}
                {savedRunInfo.run_title ? ` — "${savedRunInfo.run_title}"` : ''}
                {' — '}{savedRunInfo.run_date}
                {savedRunInfo.created_by ? ` — saved by ${emailLocalPart(savedRunInfo.created_by)}` : ''}
                {' — Status: '}{savedRunInfo.run_status}
              </div>
            )}
            {results.summary && (
              <div className="summary-bar">
                <div className="summary-item">
                  <span className="summary-val">{results.summary.total_stock_pieces}</span>
                  <span className="summary-label">Stock Pieces</span>
                </div>
                <div className="summary-item">
                  <span className="summary-val">{results.summary.avg_waste_pct_1d?.toFixed(1)}%</span>
                  <span className="summary-label">Length Waste (1D)</span>
                </div>
                {(() => {
                  // Converted stock pieces plus the pieces bought direct for items
                  // marked cut-to-size on Configure — both are cut-to-size buys.
                  const directPieces = buildDirectCutLines().reduce((s, l) => s + l.quantity, 0);
                  const total = (results._ctsCount || 0) + directPieces;
                  if (total === 0) return null;
                  return (
                    <div className="summary-item">
                      <span className="summary-val" style={{ color: 'var(--green)' }}>{total}</span>
                      <span className="summary-label">Cut To Size</span>
                    </div>
                  );
                })()}
                {weightSummary && (
                  <>
                    <div className="summary-item">
                      <span className="summary-val">{weightSummary.totalStock.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span className="summary-label">Total Weight (lbs)</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-val">{weightSummary.toOrder.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span className="summary-label">To Order (lbs)</span>
                    </div>
                    {weightSummary.fromStock > 0 && (
                      <div className="summary-item">
                        <span className="summary-val" style={{ color: 'var(--green)' }}>
                          {weightSummary.fromStock.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </span>
                        <span className="summary-label">From Stock (lbs)</span>
                      </div>
                    )}
                    <div className="summary-item">
                      <span className="summary-val">{weightSummary.totalAllocated.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span className="summary-label">Allocated (lbs)</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-val">{weightSummary.totalWaste.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span className="summary-label">Waste (lbs)</span>
                    </div>
                  </>
                )}
                {results.summary.errors?.length > 0 && (
                  <div className="summary-item summary-error">
                    <span className="summary-val">{results.summary.errors.length}</span>
                    <span className="summary-label">Errors</span>
                  </div>
                )}
                <div className="summary-item">
                  <span className="summary-val" style={{ color: selectedPatternCount > 0 ? 'var(--green)' : 'var(--gray-400)' }}>
                    {selectedPatternCount}
                  </span>
                  <span className="summary-label">Patterns Selected</span>
                </div>
              </div>
            )}

            {/* Reconcile the plan against the BOM. Allocated should land on the
                BOM's own weight; a gap means parts the plan never covered. */}
            {weightSummary && weightSummary.bomWeight > 0 && (() => {
              const gap = weightSummary.shortfall;
              const off = Math.abs(gap) > Math.max(weightSummary.bomWeight * 0.005, 1);
              return (
                <div style={{
                  padding: '9px 14px', marginBottom: 12, borderRadius: 4, fontSize: 13,
                  background: off ? '#fdf3e3' : '#f2f8f3',
                  border: `1px solid ${off ? '#b06a1f' : '#1b5e20'}`,
                  color: off ? '#7a4a12' : '#1b5e20',
                }}>
                  <strong>{fmtLbs(weightSummary.totalAllocated)}</strong> allocated against{' '}
                  <strong>{fmtLbs(weightSummary.bomWeight)}</strong> of selected BOM
                  {off ? (
                    <>
                      {' — '}<strong>{fmtLbs(Math.abs(gap))} {gap > 0 ? 'not covered' : 'over'}</strong>.
                      {gap > 0 && ' Check for groups you did not run, patterns left unselected, or rows the nester errored on.'}
                    </>
                  ) : ' — the plan covers the BOM.'}
                  {weightSummary.unpriced > 0 && (
                    <> {weightSummary.unpriced} part(s) have no Weight_Per_Ft, so both figures understate.</>
                  )}
                </div>
              );
            })()}

            {stockShortages.length > 0 && (
              <div className="stock-shortage-banner" style={{
                background: '#fdecea', border: '1px solid #d32f2f', borderRadius: 4,
                padding: '10px 14px', marginBottom: 12, color: '#b71c1c',
                fontFamily: "'IBM Plex Mono', monospace", fontSize: 13
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: 6 }}>
                  ⚠ Insufficient on-hand stock for {stockShortages.length} size{stockShortages.length > 1 ? 's' : ''}:
                </div>
                {stockShortages.map(s => (
                  <div key={s.id} style={{ marginLeft: 18 }}>
                    {s.form_type_name} | {s.material_type_name} | {inToFt(s.stock_length)}
                    {s.stock_width && parseFloat(s.stock_width) > 0 ? ` × ${inToFt(s.stock_width)}` : ''}
                    {' — need '}<strong>{s.used}</strong>, have <strong>{s.qty}</strong>, short <strong>{s.short}</strong>
                  </div>
                ))}
              </div>
            )}

            {/* Pieces taken from shop stock — allocated, never purchased */}
            {(() => {
              const { selected_1d, selected_2d } = getSelectedResults();
              const onHand = [...selected_1d, ...selected_2d].filter(r => !r.error && isOnHandStockId(r.stock_id));
              if (onHand.length === 0) return null;
              const wm = getWeightMap();
              const agg = {};
              for (const r of onHand) {
                const is2D = r.stock_width_in > 0;
                const ftn = results._nameLookup?.[r.form_type] || r.form_type;
                const mtn = results._nameLookup?.[r.material_origin] || r.material_origin;
                const k = `${ftn}|${mtn}|${r.material_name}|${r.stock_length_in}|${r.stock_width_in || 0}`;
                if (!agg[k]) {
                  const wpf = getStockWeightPerFt(r, wm);
                  agg[k] = {
                    desc: `${ftn} | ${mtn}${r.material_name ? ` | ${r.material_name}` : ''}`,
                    size: is2D ? `${inToFt(r.stock_length_in)} × ${inToFt(r.stock_width_in)}` : inToFt(r.stock_length_in),
                    qty: 0,
                    unit: calcUnitWeight(wpf, r.stock_length_in, is2D ? r.stock_width_in : 0),
                    refs: new Set(),
                  };
                }
                agg[k].qty += 1;
                const src = lastNestPayload && [...(lastNestPayload.stock_1d || []), ...(lastNestPayload.stock_2d || [])]
                  .find(x => String(x.stock_id) === String(r.stock_id));
                if (src?.reference) agg[k].refs.add(src.reference);
              }
              const lines = Object.values(agg);
              return (
                <div className="result-section">
                  <h3>From Your Stock — Not Purchased</h3>
                  <p className="hint">
                    These pieces came off material you marked On Hand, so they are allocated
                    from the shop and deliberately left off the purchase list.
                  </p>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: '100%' }}>Description</th><th>Size</th>
                        <th className="num">Pieces</th><th className="num">Unit Wt</th>
                        <th className="num">Total Wt</th><th>Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={i}>
                          <td>{l.desc}</td>
                          <td className="mono">{l.size}</td>
                          <td className="num">{l.qty}</td>
                          <td className="num">{l.unit > 0 ? fmtLbs(l.unit) : '—'}</td>
                          <td className="num">{l.unit > 0 ? fmtLbs(l.unit * l.qty) : '—'}</td>
                          <td className="mono">{[...l.refs].join(', ') || '—'}</td>
                        </tr>
                      ))}
                      <tr className="purchase-total-row">
                        <td><strong>Total from your stock</strong></td>
                        <td />
                        <td className="num"><strong>{lines.reduce((t, l) => t + l.qty, 0)}</strong></td>
                        <td />
                        <td className="num"><strong>{fmtLbs(lines.reduce((t, l) => t + l.unit * l.qty, 0))}</strong></td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })()}

            {/* Items pulled out of the nest on Configure — bought, not nested */}
            {ctsBom.length > 0 && (
              <div className="result-section">
                <h3>Cut To Size — Bought Direct</h3>
                <p className="hint">
                  These {ctsBom.length} item{ctsBom.length > 1 ? 's were' : ' was'} marked cut to size on
                  Configure, so {ctsBom.length > 1 ? 'they' : 'it'} never entered the nest — one buy piece
                  per part, no cut pattern. Included in the purchase list.
                </p>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Marks</th><th>Description</th><th className="num">Pieces</th>
                      <th className="num">Buy Each</th><th className="num">Unit Wt</th><th className="num">Total Wt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buildDirectCutLines().map((line, i) => (
                      <tr key={i}>
                        <td className="mono">{line.marks.join(', ')}</td>
                        <td>{line.form_type_name} | {line.material_type_name} | {line.spec_name} | {line.material_name}</td>
                        <td className="num">{line.quantity}</td>
                        <td className="num">
                          {line.is2D
                            ? `${line.stock_length_in}" × ${line.stock_width_in}"`
                            : `${line.stock_length_in}"`}
                        </td>
                        <td className="num">{line.unit_weight > 0 ? fmtLbs(line.unit_weight) : '—'}</td>
                        <td className="num">{line.total_weight > 0 ? fmtLbs(line.total_weight) : '—'}</td>
                      </tr>
                    ))}
                    {(() => {
                      const dl = buildDirectCutLines();
                      return (
                        <tr className="purchase-total-row">
                          <td /><td><strong>Total bought cut to size</strong></td>
                          <td className="num"><strong>{dl.reduce((t, l) => t + l.quantity, 0)}</strong></td>
                          <td /><td />
                          <td className="num"><strong>{fmtLbs(dl.reduce((t, l) => t + l.total_weight, 0))}</strong></td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            )}

            {/* 1D Results */}
            {results.results_1d?.length > 0 && (
              <div className="result-section">
                <h3>1D — Linear Results</h3>
                {groupResults(results.results_1d, results._nameLookup).map((group, gi) => {
                  const groupWeightPerFt = (() => {
                    const firstResult = group.patterns[0]?.representative;
                    if (!firstResult?.cuts?.[0]) return 0;
                    return weightMap[String(firstResult.cuts[0].bom_line_id)] || 0;
                  })();
                  const groupTotalPieces = group.patterns.reduce((sum, p) => sum + p.count, 0);
                  const groupUnitWeight = calcUnitWeight(groupWeightPerFt, group.stock_length_in, 0);
                  const groupTotalWeight = groupUnitWeight * groupTotalPieces;
                  return (
                    <div key={gi} className="material-group">
                      <div className="material-group-header">
                        <h4>
                          {matDesc(group)} | {inToFt(group.stock_length_in)} — {groupTotalPieces} {group.cut_to_size ? 'pieces cut to size' : 'stock pieces'}
                          {groupWeightPerFt > 0 && (
                            <span className="group-weight"> — {fmtLbs(groupUnitWeight)}/pc — {fmtLbs(groupTotalWeight)} total</span>
                          )}
                        </h4>
                      </div>
                      {group.patterns.map((pattern, pi) => {
                        const r = pattern.representative;
                        const patternKey = `1d-${gi}-${pi}`;
                        const isPatternSelected = selectedPatterns.has(patternKey);
                        const patternWpf = getStockWeightPerFt(r, weightMap);
                        const patternStockWeight = calcUnitWeight(patternWpf, r.stock_length_in, 0);
                        const patternCutWeight = r.cuts?.reduce((sum, c) => sum + (patternWpf * (c.cut_length / 12) * (c.quantity_on_this_stock || 1)), 0) || 0;
                        const patternWasteWeight = patternStockWeight - patternCutWeight;
                        return (
                          <div key={pi} className={`stock-result ${isPatternSelected ? 'pattern-selected' : 'pattern-deselected'}`}>
                            <div className="stock-result-header">
                              <div className="pattern-select-row">
                                <input
                                  type="checkbox"
                                  checked={isPatternSelected}
                                  onChange={() => togglePattern(patternKey)}
                                  className="pattern-checkbox"
                                />
                                <span className="stock-label">
                                  Cut Pattern {pi + 1} — {matDesc(group)} | {inToFt(r.stock_length_in)}
                                  {(() => {
                                    // A cut-to-size buy is new material, so it inherits none of
                                    // the on-hand piece's reference (heat #, bin, tag).
                                    const src = r.cut_to_size ? null : stock.find(x => String(x.id) === String(r.stock_id));
                                    return src?.reference ? <span className="stock-ref-badge" style={{ marginLeft: 8, padding: '1px 6px', background: '#e8f0fb', color: '#2c5aa0', borderRadius: 3, fontSize: 11 }}>Ref: {src.reference}</span> : null;
                                  })()}
                                  {pattern.count > 1 && <span className="pattern-count-badge">×{pattern.count} identical</span>}
                                  {(() => {
                                    // "a shorter stock size would fit" is meaningless once the
                                    // piece is already being bought cut to size.
                                    if (r.cut_to_size) return null;
                                    const totalUsed = r.cuts?.reduce((sum, c) => sum + c.cut_length + kerf1D, 0) || 0;
                                    const shorterStocks = matchedStock
                                      .filter(s => s.form_type === r.form_type && s.material_type === r.material_origin && parseFloat(s.stock_length) < r.stock_length_in)
                                      .map(s => parseFloat(s.stock_length))
                                      .sort((a, b) => b - a);
                                    const nextShorter = shorterStocks[0];
                                    const warnings = [];
                                    if (nextShorter && totalUsed > nextShorter && totalUsed <= nextShorter + 1) {
                                      warnings.push(`Within 1" of ${inToFt(nextShorter)} stock — confirm kerf, shorter stock may work`);
                                    }
                                    if (r.remnant_length_in >= 0 && r.remnant_length_in <= 1 && r.cuts?.length > 0) {
                                      warnings.push('Tight fit on current stock — verify kerf allowance');
                                    }
                                    return warnings.map((w, wi) => <span key={wi} style={{ color: '#d32f2f', fontSize: '11px', marginLeft: '8px', display: 'inline-block' }}>⚠ {w}</span>);
                                  })()}
                                </span>
                              </div>
                              <div className="result-badges">
                                {renderCtsControls(pattern, r)}
                                <span className="waste-badge">{r.waste_percentage?.toFixed(1)}% waste</span>
                                {patternWpf > 0 && (
                                  <span className="weight-badge">
                                    {fmtLbs(patternStockWeight)} stock — {fmtLbs(patternWasteWeight)} waste
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="bar-visual">
                              {r.cuts?.flatMap((cut, j) =>
                                Array.from({ length: cut.quantity_on_this_stock || 1 }, (_, k) => (
                                  <div
                                    key={`${j}-${k}`}
                                    className="bar-cut"
                                    style={{ width: `${(cut.cut_length / r.stock_length_in) * 100}%` }}
                                    title={`${cut.part_mark}: ${cut.cut_length}" — ${fmtLbs(patternWpf * (cut.cut_length / 12))}`}
                                  >
                                    <span>{cut.part_mark} ({cut.cut_length}")</span>
                                  </div>
                                ))
                              )}
                              {r.remnant_length_in > 0 && (
                                <div className="bar-remnant" style={{ width: `${(r.remnant_length_in / r.stock_length_in) * 100}%` }}>
                                  <span>{r.remnant_length_in.toFixed(1)}"</span>
                                </div>
                              )}
                            </div>
                            <table className="cut-table">
                              <thead>
                                <tr><th>Mark</th><th>Length</th><th>Qty on Stock</th><th>Total Qty</th><th>Cut Weight</th></tr>
                              </thead>
                              <tbody>
                                {r.cuts?.map((cut, j) => {
                                  const bomItem = bom.find(b => String(b.id) === String(cut.bom_line_id));
                                  const cutWt = patternWpf * (cut.cut_length / 12);
                                  return (
                                    <tr key={j}>
                                      <td className="mono">{cut.part_mark}</td>
                                      <td className="num">{cut.cut_length}"</td>
                                      <td className="num">{cut.quantity_on_this_stock}</td>
                                      <td className="num">{bomItem?.quantity || '—'}</td>
                                      <td className="num">{patternWpf > 0 ? fmtLbs(cutWt) : '—'}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 2D Results */}
            {results.results_2d?.length > 0 && (
              <div className="result-section">
                <h3>2D — Panel Results</h3>
                {groupResults(results.results_2d, results._nameLookup).map((group, gi) => {
                  const groupWeightPerFt = (() => {
                    const firstResult = group.patterns[0]?.representative;
                    if (!firstResult?.cuts?.[0]) return 0;
                    return weightMap[String(firstResult.cuts[0].bom_line_id)] || 0;
                  })();
                  const groupTotalPieces = group.patterns.reduce((sum, p) => sum + p.count, 0);
                  const groupUnitWeight = calcUnitWeight(groupWeightPerFt, group.stock_length_in, group.stock_width_in);
                  const groupTotalWeight = groupUnitWeight * groupTotalPieces;
                  return (
                    <div key={gi} className="material-group">
                      <div className="material-group-header">
                        <h4>
                          {matDesc(group)} | {inToFt(group.stock_length_in)} × {inToFt(group.stock_width_in)} — {groupTotalPieces} {group.cut_to_size ? 'plates cut to size' : 'stock pieces'}
                          {groupWeightPerFt > 0 && (
                            <span className="group-weight"> — {fmtLbs(groupUnitWeight)}/pc — {fmtLbs(groupTotalWeight)} total</span>
                          )}
                        </h4>
                      </div>
                      {group.patterns.map((pattern, pi) => {
                        const r = pattern.representative;
                        const patternKey = `2d-${gi}-${pi}`;
                        const isPatternSelected = selectedPatterns.has(patternKey);
                        const patternWpf = getStockWeightPerFt(r, weightMap);
                        const patternStockWeight = calcUnitWeight(patternWpf, r.stock_length_in, r.stock_width_in);
                        const patternCutWeight = r.cuts?.reduce((sum, c) => sum + (patternWpf * (c.cut_length * c.cut_width / 144) * (c.quantity_on_this_stock || 1)), 0) || 0;
                        const patternWasteWeight = patternStockWeight - patternCutWeight;
                        return (
                          <div key={pi} className={`stock-result ${isPatternSelected ? 'pattern-selected' : 'pattern-deselected'}`}>
                            <div className="stock-result-header">
                              <div className="pattern-select-row">
                                <input
                                  type="checkbox"
                                  checked={isPatternSelected}
                                  onChange={() => togglePattern(patternKey)}
                                  className="pattern-checkbox"
                                />
                                <span className="stock-label">
                                  Cut Pattern {pi + 1} — {matDesc(group)} | {inToFt(r.stock_length_in)} × {inToFt(r.stock_width_in)}
                                  {(() => {
                                    // A cut-to-size buy is new material, so it inherits none of
                                    // the on-hand piece's reference (heat #, bin, tag).
                                    const src = r.cut_to_size ? null : stock.find(x => String(x.id) === String(r.stock_id));
                                    return src?.reference ? <span className="stock-ref-badge" style={{ marginLeft: 8, padding: '1px 6px', background: '#e8f0fb', color: '#2c5aa0', borderRadius: 3, fontSize: 11 }}>Ref: {src.reference}</span> : null;
                                  })()}
                                  {pattern.count > 1 && <span className="pattern-count-badge">×{pattern.count} identical</span>}
                                  {(() => {
                                    if (r.cut_to_size) return null;
                                    const warnings = [];
                                    const maxCutX = Math.max(...(r.cuts?.map(c => c.x_position + c.cut_length + kerf2D) || [0]));
                                    const maxCutY = Math.max(...(r.cuts?.map(c => c.y_position + c.cut_width + kerf2D) || [0]));
                                    const smallerPanels = matchedStock
                                      .filter(s => s.form_type === r.form_type && s.material_type === r.material_origin && parseFloat(s.stock_width) > 0 && (parseFloat(s.stock_length) * parseFloat(s.stock_width)) < (r.stock_length_in * r.stock_width_in))
                                      .map(s => ({ l: parseFloat(s.stock_length), w: parseFloat(s.stock_width) }))
                                      .sort((a, b) => (b.l * b.w) - (a.l * a.w));
                                    const nextSmaller = smallerPanels[0];
                                    if (nextSmaller) {
                                      const fitsNormal = maxCutX <= nextSmaller.l + 1 && maxCutY <= nextSmaller.w + 1;
                                      const fitsRotated = maxCutX <= nextSmaller.w + 1 && maxCutY <= nextSmaller.l + 1;
                                      if (fitsNormal || fitsRotated) {
                                        warnings.push(`Within 1" of ${inToFt(nextSmaller.l)} × ${inToFt(nextSmaller.w)} stock — confirm kerf, smaller panel may work`);
                                      }
                                    }
                                    if (r.waste_percentage >= 0 && r.waste_percentage <= 3 && r.cuts?.length > 0) {
                                      warnings.push('Tight fit on current panel — verify kerf allowance');
                                    }
                                    return warnings.map((w, wi) => <span key={wi} style={{ color: '#d32f2f', fontSize: '11px', marginLeft: '8px', display: 'inline-block' }}>⚠ {w}</span>);
                                  })()}
                                </span>
                              </div>
                              <div className="result-badges">
                                {renderCtsControls(pattern, r)}
                                <span className="waste-badge">{r.waste_percentage?.toFixed(1)}% waste</span>
                                {patternWpf > 0 && (
                                  <span className="weight-badge">
                                    {fmtLbs(patternStockWeight)} stock — {fmtLbs(patternWasteWeight)} waste
                                  </span>
                                )}
                              </div>
                            </div>
                            <PanelVisualization result={r} kerf2D={kerf2D} />
                            <table className="cut-table">
                              <thead>
                                <tr><th>Mark</th><th>Length</th><th>Width</th><th>Qty on Stock</th><th>Total Qty</th><th>Cut Weight</th></tr>
                              </thead>
                              <tbody>
                                {r.cuts?.map((cut, j) => {
                                  const bomItem = bom.find(b => String(b.id) === String(cut.bom_line_id));
                                  const cutWt = patternWpf * (cut.cut_length * cut.cut_width / 144);
                                  return (
                                    <tr key={j}>
                                      <td className="mono">{cut.part_mark}</td>
                                      <td className="num">{cut.cut_length}"</td>
                                      <td className="num">{cut.cut_width}"</td>
                                      <td className="num">{cut.quantity_on_this_stock}</td>
                                      <td className="num">{bomItem?.quantity || '—'}</td>
                                      <td className="num">{patternWpf > 0 ? fmtLbs(cutWt) : '—'}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Enhanced Errors */}
            {results.summary?.errors?.length > 0 && (
              <div className="result-section">
                <h3>Errors</h3>
                {results.summary.errors.map((e, i) => {
                  const analysis = analyzeError(
                    e,
                    results._nameLookup,
                    lastNestPayload?.parts_1d,
                    lastNestPayload?.parts_2d,
                    lastNestPayload?.stock_2d,
                    lastNestPayload?.stock_1d
                  );
                  return (
                    <div key={i} className="error-box error-enhanced">
                      <div className="error-title">{analysis.message}</div>
                      {analysis.details && (
                        <div className="error-details">
                          <p className="error-dimension">{analysis.details.dimensionNote}</p>
                          {analysis.details.availableSizes.length > 0 && (
                            <p className="error-stock-info">
                              Available stock sizes: {analysis.details.availableSizes.join(', ')}
                            </p>
                          )}
                          <div className="error-suggestions">
                            <strong>To resolve:</strong>
                            <ol>
                              {analysis.details.suggestions.map((s, si) => (
                                <li key={si}>{s}</li>
                              ))}
                            </ol>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Purchase List Preview */}
            {showPurchasePreview && purchaseLines.length > 0 && (
              <div className="result-section">
                <h3>Purchase List Preview</h3>
                <p className="hint">
                  Review the aggregated lines below before saving to the project.
                  {purchaseLines.some(l => l.on_hand) && (
                    <> Rows marked <strong>ON HAND</strong> are drawn from shop stock — they are
                    saved to the project and priced like any material, but no purchase order is
                    raised for them.</>
                  )}
                </p>
                {purchaseLines.some(l => l.on_hand) && (() => {
                  const buy = purchaseLines.filter(l => !l.on_hand);
                  const own = purchaseLines.filter(l => l.on_hand);
                  const wt = ls => ls.reduce((t, l) => t + l.total_weight, 0);
                  return (
                    <p className="hint">
                      To order: <strong>{buy.reduce((t, l) => t + l.quantity, 0)} pcs / {fmtLbs(wt(buy))}</strong>
                      {'  ·  '}
                      From shop stock: <strong>{own.reduce((t, l) => t + l.quantity, 0)} pcs / {fmtLbs(wt(own))}</strong>
                    </p>
                  );
                })()}
                <table className="table">
                  <thead>
                    <tr>
                      <th>Description</th><th>Qty</th><th>Length (ft)</th><th>Wt/Ft</th><th>Unit Weight</th><th>Total Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseLines.map((line, i) => (
                      <tr key={i}>
                        <td>
                          {line.description}
                          {line.cut_to_size && (
                            <span style={{
                              marginLeft: 8, padding: '1px 6px', background: '#e6f4ea',
                              color: '#1b5e20', borderRadius: 3, fontSize: 11, fontWeight: 'bold',
                            }}>CUT TO SIZE</span>
                          )}
                          {line.on_hand && (
                            <span style={{
                              marginLeft: 8, padding: '1px 6px', background: '#fdf3e3',
                              color: '#7a4a12', borderRadius: 3, fontSize: 11, fontWeight: 'bold',
                            }}>ON HAND{line.stock_reference ? ` · ${line.stock_reference}` : ''}</span>
                          )}
                        </td>
                        <td className="num">{line.quantity}</td>
                        <td className="num">{line.feet_length.toFixed(1)}</td>
                        <td className="num">{line.weight_per_ft > 0 ? `${line.weight_per_ft.toFixed(2)}` : '—'}</td>
                        <td className="num">{line.unit_weight > 0 ? fmtLbs(line.unit_weight) : '—'}</td>
                        <td className="num">{line.total_weight > 0 ? fmtLbs(line.total_weight) : '—'}</td>
                      </tr>
                    ))}
                    <tr className="purchase-total-row">
                      <td><strong>Total</strong></td>
                      <td className="num"><strong>{purchaseLines.reduce((s, l) => s + l.quantity, 0)}</strong></td>
                      <td></td><td></td><td></td>
                      <td className="num"><strong>{fmtLbs(purchaseLines.reduce((s, l) => s + l.total_weight, 0))}</strong></td>
                    </tr>
                  </tbody>
                </table>
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button onClick={savePurchaseList} className="btn btn-primary" disabled={savingPurchase}>
                    {savingPurchase ? 'Saving...' : 'Save Purchase List to Project'}
                  </button>
                  <button onClick={() => setShowPurchasePreview(false)} className="btn">Cancel</button>
                </div>
                {purchaseStatus && (
                  <div className={`save-status ${purchaseStatus.startsWith('Error') ? 'save-error' : 'save-success'}`} style={{ marginTop: 8 }}>
                    {purchaseStatus}
                  </div>
                )}
                {canReturnToProject && returnUrl && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => { window.location.href = returnUrl; }} className="btn btn-primary">
                      Done — Return to Project
                    </button>
                    <span className="hint">Reloads the project fresh so the saved rows survive your next Update.</span>
                  </div>
                )}
              </div>
            )}

            {/* Saved Purchase List in Results view */}
            {showSavedPurchase && savedPurchaseLines.length > 0 && (
              <div className="result-section">
                <div className="card-header">
                  <h3>Saved Purchase List ({savedPurchaseLines.length} items)</h3>
                  <button onClick={() => setShowSavedPurchase(false)} className="btn btn-small">Close</button>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th><th>Description</th><th>Qty</th><th>Feet</th>
                        <th className="num">Unit Wt</th><th className="num">Total Wt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {savedPurchaseLines.map((line, i) => (
                        <tr key={i}>
                          <td className="num">{line.line_item}</td>
                          <td>{line.item_description || line.description}</td>
                          <td className="num">{line.quantity}</td>
                          <td className="num">{line.feet_length}</td>
                          <td className="num">{line.unit_weight > 0 ? fmtLbs(line.unit_weight) : '—'}</td>
                          <td className="num">{line.total_weight > 0 ? fmtLbs(line.total_weight) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="card-footer">
              <div className="btn-group">
                <button onClick={() => setStep(1)} className="btn">← {isStandalone ? 'Edit Parts' : 'Select Items'}</button>
                <button onClick={() => setStep(2)} className="btn">← Reconfigure</button>
              </div>
              <div className="btn-group" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                {isStandalone && runTitle && (
                  <span style={{ fontSize: 12, color: '#666' }}>
                    Title: <strong>{runTitle}</strong>
                  </span>
                )}
                <span className="count">{selectedPatternCount} pattern{selectedPatternCount !== 1 ? 's' : ''} selected</span>
                <button
                  onClick={saveToZoho}
                  className="btn btn-primary"
                  disabled={saving || selectedPatternCount === 0 || (isStandalone && loadedRunIsProject)}
                  title={isStandalone && loadedRunIsProject ? 'View-only — go to the project page to modify a project run' : ''}
                >
                  {saving ? 'Saving...' : (isStandalone && loadedRunIsProject) ? 'View only (project run)' : `${isStandalone ? 'Save' : 'Import'} ${selectedPatternCount} Pattern${selectedPatternCount !== 1 ? 's' : ''}${isStandalone ? '' : ' to Project'}`}
                </button>
                {!isStandalone && (
                  <>
                    <button
                      onClick={() => { setShowPurchasePreview(true); setPurchaseStatus(''); }}
                      className="btn btn-secondary"
                      disabled={selectedPatternCount === 0}
                    >
                      Generate Purchase List
                    </button>
                    <button onClick={fetchSavedPurchaseList} className="btn btn-small" disabled={loadingSavedPurchase}>
                      {loadingSavedPurchase ? 'Loading...' : 'View Saved'}
                    </button>
                  </>
                )}
              </div>
            </div>
            {saveStatus && (
              <div className={`save-status ${saveStatus.startsWith('Error') ? 'save-error' : 'save-success'}`}>
                {saveStatus}
              </div>
            )}
          </div>
        )}
      </main>
      <footer className="footer"><span>Material Compass Nesting v2.12 — Back to Project always available</span></footer>
    </div>
  );
}
