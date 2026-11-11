/* weld-rules.js — TYPICAL WELDS: set once per component, counted on every drawing from its own pieces.

   Why (Mark, 2026-11-11, MCP-10013 handrail): "each handrail assembly has the same welds (some with more
   or less locations to weld) but it is the same method for all of them." The AI read the typical-weld
   notes on 5 of 43 drawings, five different ways, with no lengths — so welding was either unpriced or
   assumed. A rule says WHAT the weld is (joint, size, length) and WHAT IT IS COUNTED FROM (one per post,
   two per elbow, one per pipe-to-pipe joint…); each drawing's count then comes from its own labelled
   pieces, never from a number the AI asserted for the job.

   Shared by the review page (preview) and the server (labor): one copy, so the two can't disagree.

   rule = { id, component, label, joint, size_in, both_sides, position,
            length_from: 'around' | 'typed' | 'piece_long' | 'piece_short',
            around_member,            // length_from 'around': the member the weld goes round
            length_in,                // length_from 'typed'
            length_role,              // piece_long / piece_short: the role whose edge it runs along
            per,                      // 'elbow' | 'pipe_joint' | 'assembly' | a piece role
            per_each,                 // how many welds per one of `per` (2 per elbow)
            joins: [role|'pipe'|'elbow', …] }   // what it joins: those pieces' assumed welds are replaced
*/
(function (root) {
  var ROLES = [
    ["post", "Post"], ["top_rail", "Top rail"], ["mid_rail", "Mid rail"], ["bottom_rail", "Bottom rail"],
    ["rail", "Rail (other)"], ["picket", "Picket / baluster"], ["stub", "Stub / short piece"], ["toe_plate", "Toe plate / kick plate"],
    ["base_plate", "Base plate"], ["connection_plate", "Connection plate"], ["gusset", "Gusset / stiffener"],
    ["bracket", "Bracket / clip"], ["other", "Other"]
  ];
  var PER = [["elbow", "elbow"], ["pipe_joint", "pipe-to-pipe joint"], ["assembly", "assembly (drawing)"]]
    .concat(ROLES.map(function (r) { return [r[0], r[1].toLowerCase()]; }));
  var ROLE_SET = {}; ROLES.forEach(function (r) { ROLE_SET[r[0]] = 1; });

  var sheetKey = function (s) { return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  var compKey = function (c) { return String(c == null ? "" : c).trim().toLowerCase(); };
  var formFam = function (ft) { return String(ft || "").trim().split(/[\s-]+/)[0].toLowerCase(); };
  var live = function (r) { return r && !r.deleted && (Number(r.quantity) || 0) > 0; };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };

  // The standard pipe-handrail welds, as a starting point the estimator edits. Sizes are the common
  // 3/16" — every number is shown and editable; nothing here is a count.
  function handrailPreset(component) {
    var base = { component: component, joint: "fillet", size_in: 0.1875, position: "flat" };
    var mk = function (o) { return Object.assign({ id: "r" + Math.random().toString(36).slice(2, 9) }, base, o); };
    return [
      mk({ label: "Pipe to elbow", length_from: "around", around_member: 'Pipe 1-1/2" SCH 40 (STD)', both_sides: false, per: "elbow", per_each: 2, joins: ["pipe", "elbow"] }),
      mk({ label: "Pipe to pipe", length_from: "around", around_member: 'Pipe 1-1/2" SCH 40 (STD)', both_sides: false, per: "pipe_joint", per_each: 1, joins: ["pipe"] }),
      mk({ label: "Connection plate to post", length_from: "piece_short", length_role: "connection_plate", both_sides: true, per: "post", per_each: 1, joins: ["connection_plate", "post"] }),
      mk({ label: "Connection plate to base plate", length_from: "piece_long", length_role: "connection_plate", both_sides: true, per: "post", per_each: 1, joins: ["connection_plate", "base_plate"] })
    ];
  }

  // What a rule joins decides which assumed welds it replaces: the pieces it is counted from and
  // runs along, plus pipe when it goes round a pipe or is a pipe joint, plus any it names in joins.
  function joinsOf(r) {
    var j = {};
    if (r.per === "elbow") { j.pipe = 1; j.elbow = 1; }
    else if (r.per === "pipe_joint") j.pipe = 1;
    else if (r.per && r.per !== "assembly") j[r.per] = 1;
    if (r.length_from === "around" && /pipe/i.test(r.around_member || "")) j.pipe = 1;
    if ((r.length_from === "piece_long" || r.length_from === "piece_short") && r.length_role) j[r.length_role] = 1;
    (r.joins || []).forEach(function (x) { j[x] = 1; });
    return Object.keys(j);
  }

  // Per drawing of a component: its live rows, the pieces by role, and the AI's joint counts.
  function sheetsOf(takeoff, component) {
    var k = compKey(component), by = {}, order = [];
    (takeoff.rows || []).forEach(function (r) {
      if (!live(r) || r.fitting_type != null || compKey(r.component) !== k) return;
      var s = String(r.source_sheet == null ? "" : r.source_sheet).trim(); if (!s) return;
      if (!by[s]) { by[s] = { sheet: s, rows: [] }; order.push(s); }
      by[s].rows.push(r);
    });
    return order.map(function (s) { return by[s]; });
  }
  function roleQty(rows, role) {
    return rows.reduce(function (a, r) { return a + (r.role === role ? num(r.quantity) : 0); }, 0);
  }
  function elbowQty(takeoff, component) {
    var k = compKey(component);
    return (takeoff.fittings || []).reduce(function (a, f) {
      return a + (live(f) && compKey(f.component) === k && /elbow/i.test(String(f.fitting_type || "")) ? num(f.quantity) : 0);
    }, 0);
  }
  function countsFor(takeoff, sheet) {
    var dc = takeoff.drawing_counts || {};
    return dc[sheet] || dc[sheetKey(sheet)] || null;
  }

  // One rule -> the welds it makes, plus what could not be counted (never a guessed number).
  //   per drawing for roles / pipe joints / assemblies; once for the component for elbows
  //   (fittings are bought by the job, not drawn per assembly).
  function expandRule(rule, takeoff) {
    var out = { welds: [], missing: [], total: 0 };
    var each = num(rule.per_each) || 1;
    var label = (rule.label || "typical weld") + " (typical)";
    var len = function (rows) {
      if (rule.length_from === "around") return { all_around: true, around_member: rule.around_member || "" };
      if (rule.length_from === "typed") return num(rule.length_in) > 0 ? { length_in: num(rule.length_in) } : null;
      var ps = rows.filter(function (r) { return r.role === rule.length_role; });
      if (!ps.length) return null;
      var p = ps[0], a = num(p.length_ft) * 12, b = num(p.width_ft) * 12;
      if (!(a > 0)) return null;
      var e = rule.length_from === "piece_short" && b > 0 ? Math.min(a, b) : Math.max(a, b || 0);
      return { length_in: Math.round(e * 1000) / 1000, edge_of: (p.member_mark || rule.length_role) };
    };
    var make = function (sheet, count, rows, basis) {
      var L = len(rows || []);
      if (!L) { out.missing.push({ what: label + (sheet ? " (" + sheet + ")" : ""), reason: rule.length_from === "typed" ? "no length typed" : "no " + String(rule.length_role || "").replace(/_/g, " ") + " labelled on this drawing to measure the weld along" }); return; }
      if (!(count > 0)) return;
      var forms = {};
      joinsOf(rule).forEach(function (j) {
        if (j === "pipe") forms.pipe = 1;
        else if (ROLE_SET[j]) (rows || []).forEach(function (r) { if (r.role === j) forms[formFam(r.form_type)] = 1; });
      });
      out.total += count;
      out.welds.push(Object.assign({
        joint: rule.joint || "fillet", size_in: num(rule.size_in), both_sides: !!rule.both_sides, position: rule.position || "flat",
        count: count, component: rule.component, source_sheet: sheet || "", confidence: 1,
        symbol: label + " — " + basis, from_rule: rule.id || true, cover_forms: Object.keys(forms), joins: joinsOf(rule)
      }, L));
    };

    if (rule.per === "elbow") {
      var n = elbowQty(takeoff, rule.component);
      if (!n) { out.missing.push({ what: label, reason: "no elbows in the fittings for " + rule.component }); return out; }
      make("", n * each, [], n + " elbow" + (n === 1 ? "" : "s") + " × " + each);
      return out;
    }
    sheetsOf(takeoff, rule.component).forEach(function (s) {
      var n, basis;
      if (rule.per === "assembly") { n = 1; basis = "1 assembly"; }
      else if (rule.per === "pipe_joint") {
        var c = countsFor(takeoff, s.sheet);
        if (!c || c.pipe_joints == null) { out.missing.push({ what: label + " (" + s.sheet + ")", reason: "pipe joints not counted on this drawing yet — run Label pieces" }); return; }
        n = num(c.pipe_joints); basis = n + " pipe joint" + (n === 1 ? "" : "s");
      } else {
        n = roleQty(s.rows, rule.per);
        basis = n + " " + String(rule.per).replace(/_/g, " ") + (n === 1 ? "" : "s");
        if (!n && !s.rows.some(function (r) { return r.role; })) { out.missing.push({ what: label + " (" + s.sheet + ")", reason: "pieces on this drawing are not labelled yet — run Label pieces" }); return; }
      }
      make(s.sheet, n * each, s.rows, basis + (each !== 1 ? " × " + each : ""));
    });
    return out;
  }

  // Every rule of every component -> { welds, missing, ruleComps, elbowComps }.
  //   ruleComps: components whose AI-read weld schedule the rules replace.
  //   elbowComps: components whose elbow welds a rule prices (the fitting estimate's butt-weld
  //   joints are then dropped — the same welds, never twice).
  function expandAll(takeoff) {
    var res = { welds: [], missing: [], ruleComps: {}, elbowComps: {}, byRule: {} };
    (takeoff.weld_rules || []).forEach(function (rule) {
      if (!rule || rule.deleted || !rule.component) return;
      var x = expandRule(rule, takeoff);
      res.welds = res.welds.concat(x.welds);
      res.missing = res.missing.concat(x.missing.map(function (m) { return Object.assign({ component: rule.component }, m); }));
      res.byRule[rule.id] = { total: x.total, drawings: x.welds.length, missing: x.missing.length };
      res.ruleComps[compKey(rule.component)] = 1;
      if (rule.per === "elbow" && x.welds.length) res.elbowComps[compKey(rule.component)] = 1;
    });
    return res;
  }

  var api = { ROLES: ROLES, PER: PER, handrailPreset: handrailPreset, joinsOf: joinsOf, expandRule: expandRule, expandAll: expandAll, sheetKey: sheetKey, compKey: compKey, formFam: formFam };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WeldRules = api;
})(typeof window !== "undefined" ? window : this);
