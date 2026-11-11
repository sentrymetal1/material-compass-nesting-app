/* rail-pricing.js — HANDRAIL PRICED BY THE FOOT, from the shop's own Handrail standard (Labor setup).

   Why (Mark, 2026-11-11, MCP-10013): "handrail should be priced per foot how it is in the setup."
   The take-off was pricing pipe handrail member by member as a welded frame (every pipe cut, fit and
   welded all round, every plate fillet-welded round its edge): ~811 h, where the shop's own Handrail
   standard (hr per ft of rail, cut + fit + weld in one number) comes to a fraction of it.

   Per drawing of a handrail component:
     feet  = the top-rail pieces' lengths × their quantities (labelled by Label pieces) — or the feet
             typed on the Labor tab. A drawing with no top rail labelled is LISTED, never guessed.
     type  = 2-line, or 2-line + kickplate when the drawing has a flat-bar toe plate — or as picked.
   The rate covers the rail itself: posts, rails, stubs, pickets, its elbows and their welds, and the
   toe plate when the type includes one. Everything else on the drawing (base plates, connection
   plates, brackets, their welds) is still priced piece by piece ON TOP, and shows as its own lines.

   Shared by the review page and the server (labor/takeoffLabor.js): one copy, so the two agree.

   takeoff.labor_methods = { [component, lower-case]: { mode: 'per_ft' | 'member',
                                                         sheets: { [sheetKey]: { feet, std } } } }
*/
(function (root) {
  // The Labor setup's Handrail standards priced by the foot (labor/components.js STANDARD keys).
  var STDS = [
    ["handrail_pipe_2", "2-line"], ["handrail_pipe_2_kick", "2-line + kickplate"],
    ["handrail_pipe_3", "3-line"], ["handrail_pipe_3_kick", "3-line + kickplate"]
  ];
  var STD_SET = {}; STDS.forEach(function (s) { STD_SET[s[0]] = s[1]; });
  var RAIL_ROLES = { post: 1, top_rail: 1, mid_rail: 1, bottom_rail: 1, rail: 1, picket: 1, stub: 1 };

  var compKey = function (c) { return String(c == null ? "" : c).trim().toLowerCase(); };
  var sheetKey = function (s) { return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  var formFam = function (ft) { return String(ft || "").trim().split(/[\s-]+/)[0].toLowerCase(); };
  var live = function (r) { return r && !r.deleted && (Number(r.quantity) || 0) > 0 && r.fitting_type == null; };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
  var hasKick = function (std) { return /_kick$/.test(String(std || "")); };
  // A toe plate is flat bar or plate. The labeller sometimes calls a pipe a toe plate; a pipe is rail.
  var isToePlate = function (r) { return r.role === "toe_plate" && formFam(r.form_type) !== "pipe"; };

  // A component named handrail / guardrail is priced by the foot unless the estimator says otherwise.
  function methodOf(takeoff, component) {
    var m = ((takeoff && takeoff.labor_methods) || {})[compKey(component)];
    if (m && (m.mode === "per_ft" || m.mode === "member")) return m;
    return /\b(hand|guard)\s*-?\s*rail/i.test(String(component || "")) ? { mode: "per_ft", auto: true } : { mode: "member", auto: true };
  }

  // Is this piece part of the rail the per-foot rate covers?
  function covers(row, sheet) {
    if (formFam(row.form_type) === "pipe") return true;          // every pipe on a pipe rail is rail
    if (RAIL_ROLES[row.role]) return true;
    return isToePlate(row) && hasKick(sheet && sheet.std);
  }

  // Per drawing of a component: counted feet, the type, and what was typed over them.
  function sheetsOf(takeoff, component, method) {
    var k = compKey(component), by = {}, order = [];
    var over = (method && method.sheets) || {};
    ((takeoff && takeoff.rows) || []).forEach(function (r) {
      if (!live(r) || compKey(r.component) !== k) return;
      var s = String(r.source_sheet == null ? "" : r.source_sheet).trim(); if (!s) return;
      if (!by[s]) { by[s] = { sheet: s, top_ft: 0, top_pieces: 0, kick: false, rows: [] }; order.push(s); }
      var b = by[s]; b.rows.push(r);
      if (r.role === "top_rail" && formFam(r.form_type) === "pipe") { b.top_ft += num(r.length_ft) * num(r.quantity); b.top_pieces += num(r.quantity); }
      if (isToePlate(r)) b.kick = true;
    });
    return order.map(function (s) {
      var b = by[s], o = over[sheetKey(s)] || {};
      var typed = o.feet != null && o.feet !== "" && isFinite(Number(o.feet)) && Number(o.feet) >= 0;
      var stdAuto = b.kick ? "handrail_pipe_2_kick" : "handrail_pipe_2";
      var std = STD_SET[o.std] ? o.std : stdAuto;
      var x = { sheet: s, top_ft: Math.round(b.top_ft * 100) / 100, top_pieces: b.top_pieces, kick: b.kick,
        feet: typed ? Number(o.feet) : Math.round(b.top_ft * 100) / 100, feet_from: typed ? "typed" : (b.top_ft > 0 ? "top rail" : "none"),
        std: std, std_auto: stdAuto, std_from: STD_SET[o.std] ? "picked" : "auto" };
      x.covered = b.rows.filter(function (r) { return covers(r, x); }).length;
      x.on_top = b.rows.length - x.covered;
      return x;
    });
  }

  // Does a typical weld only join rail pieces (so the per-foot rate already includes it)?
  function weldCovered(joins, sheet) {
    var j = joins || [];
    if (!j.length) return false;
    return j.every(function (x) { return x === "pipe" || x === "elbow" || RAIL_ROLES[x] || (x === "toe_plate" && hasKick(sheet && sheet.std)); });
  }

  var api = { STDS: STDS, STD_SET: STD_SET, RAIL_ROLES: RAIL_ROLES, methodOf: methodOf, covers: covers, sheetsOf: sheetsOf,
    weldCovered: weldCovered, hasKick: hasKick, compKey: compKey, sheetKey: sheetKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RailPricing = api;
})(typeof window !== "undefined" ? window : this);
