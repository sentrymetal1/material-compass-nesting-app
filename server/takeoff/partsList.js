// =============================================================================
//  takeoff/partsList.js — the parts list as a DETERMINISTIC source of raw steel.
// -----------------------------------------------------------------------------
//  Two AI take-offs of the same 149-page Ingersoll Rand parts list (2026-09-28) came back
//  materially different: one had all 21 pipe lines and the angles at the wrong thickness, the
//  other had the angles right and NO pipe at all. The list itself is text, laid out as
//  LVL / ITEM / COMPONENT / QTY / UNIT / DESCRIPTION with attribute lines (PIPE SIZE=4,
//  SCHEDULE=STANDARD, POUNDS PER FOOT=10.788) under each item. Raw stock is billed in IN or
//  FT. That is readable exactly, every time — so for steel that is ON the list, the list is
//  used and the model is not asked.
//
//  Only switches on for a document that parses as this layout. Anything else returns null
//  and the take-off runs exactly as before; drawings-only jobs are untouched.
//
//  Plates are NOT raw stock on these lists (they are drawn, EA parts), so they still come
//  from the model's read of the drawings.
// =============================================================================

const { signature, sameSig } = require("./snap");

// "1.000 EA" arrives as one cell from pdf-parse and two from a positioned-text dump — and a
// long quantity prints with no space at all ("19.500IN", "1009.00IN"). All three are qty + unit.
function tokens(line) {
  const out = [];
  String(line).split(/\s*[\t|]\s*/).forEach(function (c) {
    const s = c.trim(); if (!s) return;
    const m = s.match(/^(\d+\.\d+|\d+)\s*(EA|IN|FT|LB|M|MM)$/);
    if (m) { out.push(m[1], m[2]); } else out.push(s);
  });
  return out;
}

// LVL [SORT] ITEM COMPONENT QTY UNIT [REV] DESCRIPTION… — a line with no component number is a
// text note ("3 | 0010 | 1.000 | EA | MAT'L:STEEL CONFORMING TO"), not an item.
function asItem(line) {
  const t = tokens(line);
  if (t.length < 6 || !/^\d$/.test(t[0])) return null;
  let i = 1;
  if (/^\d{1,3}$/.test(t[i]) && /^\d{4}$/.test(t[i + 1])) i++;       // SORT
  if (!/^\d{4}$/.test(t[i])) return null;
  const item = t[i++];
  if (!/^[A-Z]{3}\d/.test(t[i] || "")) return null;                     // COMPONENT number
  const part = t[i++];
  if (!/^\d+(\.\d+)?$/.test(t[i] || "") || !/^[A-Z]{2,3}$/.test(t[i + 1] || "")) return null;
  const qty = Number(t[i]), unit = t[i + 1]; i += 2;
  if (/^\d\d$/.test(t[i] || "")) i++;                                   // REV
  return { lvl: Number(t[0]), item: item, part: part, qty: qty, unit: unit, desc: t.slice(i).join(" ") };
}

const PAGE = /^-{2,3}\s*(?:p(\d+)|(\d+)\s+of\s+\d+)\s*-{2,3}$/;

// Every item on the list, with its attributes and the quantity multiplier of its parents.
function parseItems(text) {
  const L = String(text || "").split(/\r?\n/);
  const items = []; const stack = {}; let page = 1;
  for (let n = 0; n < L.length; n++) {
    const pm = L[n].trim().match(PAGE); if (pm) { page = Number(pm[1] || pm[2]) + (pm[2] ? 1 : 0); continue; }
    const it = asItem(L[n]); if (!it) continue;
    const attrs = [];
    for (let k = n + 1; k < L.length && !asItem(L[k]) && !PAGE.test(L[k].trim()); k++) attrs.push(tokens(L[k]).join(" "));
    const parent = stack[it.lvl - 1] || null;
    // Each raw item prints twice — once with its description, once as a "." or "CUT 2 PIECES…"
    // continuation. Same level, item, part and parent is the same item.
    const prev = items.find(function (x) { return x.lvl === it.lvl && x.item === it.item && x.part === it.part && x.parent === parent; });
    if (prev) {
      prev.attrs = prev.attrs.concat(attrs);
      if (/^CUT\b/i.test(it.desc)) prev.cut = it.desc;
      if (prev.desc === "." || /^CUT\b/i.test(prev.desc)) { if (/^CUT\b/i.test(prev.desc)) prev.cut = prev.desc; prev.desc = it.desc; }
      continue;
    }
    it.attrs = attrs; it.page = page; it.parent = parent;
    if (/^CUT\b/i.test(it.desc)) it.cut = it.desc;
    it.mult = parent ? parent.mult * (parent.unit === "EA" ? parent.qty : 1) : 1;
    items.push(it);
    stack[it.lvl] = it;
    Object.keys(stack).forEach(function (k) { if (Number(k) > it.lvl) delete stack[k]; });
  }
  return items;
}

function kv(attrs) {
  const o = {};
  attrs.forEach(function (a) {
    const m = String(a).match(/^([A-Z][A-Z0-9 _./#()-]*?)\s*=\s*(.+)$/);
    if (m && !(m[1].trim() in o)) o[m[1].trim()] = m[2].trim();
  });
  return o;
}

const trimNum = (s) => String(s).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

// Pick the catalog's own spelling from a few ways of writing the same size. The catalog writes
// 1/8" SCH 40 but 1/2" SCH 40 (STD), so the right form depends on the size.
function catalogSize(cands, form, mat, groups) {
  const list = groups && (groups[form + "|" + mat] || groups[form + "|any material"]);
  if (!list) return cands[0];
  for (const c of cands) {
    const exact = list.find(function (s) { return s.toUpperCase().replace(/\s+/g, " ") === c.toUpperCase(); });
    if (exact) return exact;
    const sig = signature(c);
    const hits = list.filter(function (s) { return sameSig(signature(s), sig); });
    if (hits.length === 1) return hits[0];
  }
  return cands[0];
}

// One raw item -> one take-off row, or null when it is not steel this take-off handles
// (Unistrut, stainless tubing, conduit, a fabricated gasket).
function toRow(it, attrs, desc, groups) {
  const k = attrs;
  let form, mat = "Carbon Steel", spec = "", cands;
  if (/ANGLE/i.test(desc)) {
    const big = k["LARGE LEG DIMENSION"] || k["LEG DIMENSION"], small = k["SMALL LEG DIMENSION"] || k["LEG DIMENSION"];
    if (!big || !k.THICKNESS) return null;
    form = "Angle"; cands = ["L" + big + " x " + small + " x " + k.THICKNESS];
    spec = String(k.SPECIFICATION || "A36").replace(/^ASTM-?/i, "");
  } else if (/CHANNEL/i.test(desc)) {
    if (!k.SIZE || !k["WEIGHT PER FOOT"]) return null;
    form = "Channel"; cands = [k.SIZE + " x " + trimNum(k["WEIGHT PER FOOT"])]; spec = "A36";
  } else if (/FLAT-STOCK/i.test(desc)) {
    if (!k.THICKNESS || !k.WIDTH) return null;
    form = "Bar - Flat"; cands = [k.THICKNESS + " x " + trimNum(k.WIDTH)];
    if (/^3\d\d/.test(k.TYPE || "") || /STAINLESS/i.test(desc)) { mat = "Stainless Steel"; spec = k.TYPE || "304"; } else spec = "A36";
  } else if (/^PIPE\.RAW/i.test(desc)) {
    const size = k["PIPE SIZE"] || (desc.match(/\(([\d\/-]+)"/) || [])[1];
    if (!size) return null;
    let sch = String(k.SCHEDULE || (desc.match(/sch\.?\s*(\w+)/i) || [])[1] || "").toUpperCase();
    if (sch === "STANDARD") sch = "STD";
    form = "Pipe";
    cands = (sch === "STD" || sch === "40")
      ? [size + '" SCH 40 (STD)', size + '" SCH 40']
      : (sch === "80" || sch === "XS") ? [size + '" SCH 80 (XS)', size + '" SCH 80']
      : sch ? [size + '" SCH ' + sch] : [size + '" SCH 40 (STD)', size + '" SCH 40'];
    const astm = String(k["ASTM NUMBER"] || "A53").replace(/\s*GR\.?\s*\w+$/i, "");
    const grade = (String(k["ASTM NUMBER"] || "").match(/GR\.?\s*(\w+)$/i) || [])[1] || (/^[A-Z]$/.test(k.GRADE || "") ? k.GRADE : "B");
    spec = astm + " Gr " + grade;
  } else return null;

  // Raw stock is billed as a length. A "CUT n PIECES x LONG" note is used only when it adds up to
  // that length — on this list the channel says 4 pieces of 4" against 114" of stock, and the
  // billed length is the one that gets ordered.
  const totalIn = it.unit === "FT" ? it.qty * 12 : it.qty;
  let pieces = 1, eachIn = totalIn;
  const cm = String(it.cut || "").match(/CUT\s+(\d+)\s+PIECES?\s+([\d.]+)"?/i);
  if (cm) {
    const n = Number(cm[1]), each = Number(cm[2]);
    if (n > 0 && Math.abs(n * each - totalIn) <= Math.max(0.5, totalIn * 0.03)) { pieces = n; eachIn = each; }
  }
  const lbft = parseFloat(k["POUNDS PER FOOT"]) || parseFloat(k["WEIGHT PER FOOT"]) || null;
  return {
    form_type: form, material_type: mat, specification: spec,
    size: catalogSize(cands, form, mat, groups),
    length_ft: Math.round(eachIn / 12 * 1000) / 1000,
    quantity: pieces * it.mult,
    disposition: "fabricate", cross_check: "list", galvanized: false, confidence: 1,
    note: "Parts list item " + it.item + " · " + it.part + " · p." + it.page + " · " + trimNum(it.qty) + " " + it.unit +
          (it.mult > 1 ? " × " + it.mult + " (parent qty)" : "") + (it.cut ? " · " + it.cut : ""),
    list_item: it.item, list_part: it.part, list_page: it.page,
    list_lb_per_ft: lbft,
  };
}

// text -> { rows, skipped, items } for a parts list this recognises, else null.
function extractPartsList(text, groups) {
  const items = parseItems(text);
  const raw = items.filter(function (x) { return x.unit === "IN" || x.unit === "FT"; });
  // Recognition: a real item list with raw stock on it. A drawing's title block never gets here.
  if (items.length < 10 || !raw.length) return null;
  // The continuation line carries some parts' attributes; pool them by part number.
  const byPart = {}, descOf = {};
  raw.forEach(function (x) {
    byPart[x.part] = Object.assign(kv(x.attrs), byPart[x.part] || {});
    if (x.desc !== "." && !/^CUT\b/i.test(x.desc)) descOf[x.part] = x.desc;
  });
  const rows = [], skipped = [];
  raw.forEach(function (x) {
    const desc = descOf[x.part] || x.desc;
    const r = toRow(x, Object.assign({}, byPart[x.part], kv(x.attrs)), desc, groups);
    if (r) rows.push(r); else skipped.push({ item: x.item, part: x.part, page: x.page, qty: x.qty + " " + x.unit, desc: desc });
  });
  return rows.length ? { rows: rows, skipped: skipped, items: items.length } : null;
}

// Put the list's rows in, take the model's rows for the same steel out, and say what changed.
// Only forms the list actually carries are touched, and only for the component the list belongs
// to — a plate, or another component's angles, are left to the model.
function applyPartsList(rows, list, opts) {
  opts = opts || {};
  const doc = opts.document || "", comp = opts.component || "";
  list.rows.forEach(function (r) { r.source_sheet = doc; if (comp) r.component = comp; });
  const forms = {}; list.rows.forEach(function (r) { forms[r.form_type] = 1; });
  const sameComp = function (r) { return !comp || !String(r.component || "").trim() || String(r.component).trim() === comp; };
  const replaced = [], kept = [];
  rows.forEach(function (r) {
    if (forms[r.form_type] && sameComp(r)) {
      replaced.push({ form_type: r.form_type, size: r.size, quantity: r.quantity, length_ft: r.length_ft,
                      source_sheet: r.source_sheet, confidence: r.confidence, note: r.note || "" });
    } else kept.push(r);
  });
  const ft = function (r) { return (Number(r.quantity) || 0) * (Number(r.length_ft) || 0); };
  const sum = function (a) { return Math.round(a.reduce(function (s, r) { return s + ft(r); }, 0) * 10) / 10; };
  const report = {
    document: doc, component: comp, list_items: list.items,
    rows_from_list: list.rows.length, forms: Object.keys(forms),
    list_feet: sum(list.rows), ai_feet_replaced: sum(replaced),
    replaced: replaced, not_steel: list.skipped,
  };
  return { rows: kept.concat(list.rows), report: report };
}

module.exports = { extractPartsList, applyPartsList, parseItems };
