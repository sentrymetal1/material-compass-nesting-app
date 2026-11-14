/* outside-types.js — THE ONE LIST OF OUTSIDE-COST TYPES (Mark 2026-11-14).

   Mirrors the Zoho table "Project Items and Subcontracting Types" (37 rows): each Item Type has a
   Code, a bucket (= its Category of Item = one Outsource Totals column), a default unit, and whether
   the vendor can bring the steel. The project page's Load button finds the Item Type BY CODE, so the
   codes here must match the Zoho table exactly. Universal on purpose — steel, aluminum, stainless,
   pipe, machining shops — not fab-centric.

   Shared by the review page and the server (projectOutside.js): one copy, so the two agree.
*/
(function (root) {
  // [code, Item Type (Zoho name), bucket (Category of Item), default unit, can supply material]
  var TYPES = [
    ["plasma_cut", "Plasma Cutting", "Cutting", "lot", 1],
    ["laser_cut", "Laser Cutting", "Cutting", "lot", 1],
    ["oxy_cut", "Oxy-Fuel Cutting", "Cutting", "lot", 1],
    ["waterjet_cut", "Waterjet Cutting", "Cutting", "lot", 1],
    ["saw_cut", "Saw Cutting", "Cutting", "ea", 1],
    ["shear", "Shearing", "Cutting", "lot", 1],
    ["punch", "Punching", "Cutting", "ea", 0],
    ["cope", "Coping", "Cutting", "ea", 0],
    ["beam_line", "Beam Drill / Saw Line", "Cutting", "lot", 1],
    ["roll", "Rolling", "Forming & Rolling", "lot", 1],
    ["brake_form", "Press Brake Forming", "Forming & Rolling", "lot", 1],
    ["pipe_bend", "Pipe & Tube Bending", "Forming & Rolling", "ea", 1],
    ["machining", "Machining", "Machining", "lot", 1],
    ["drill_tap", "Drilling & Tapping", "Machining", "ea", 0],
    ["pipe_end_prep", "Pipe Threading / Grooving / Beveling", "Machining", "ea", 0],
    ["outside_weld", "Outside Welding", "Outside Welding & Fab", "lot", 0],
    ["outside_fab", "Outside Fabrication", "Outside Welding & Fab", "lot", 1],
    ["heat_treat", "Heat Treating / Stress Relief", "Heat Treat", "lb", 0],
    ["galvanize", "Galvanizing", "Galvanize", "lb", 0],
    ["blast_paint", "Blasting & Painting", "Paint & Coatings", "sq ft", 0],
    ["powder_coat", "Powder Coating", "Paint & Coatings", "sq ft", 0],
    ["anodize", "Anodizing", "Paint & Coatings", "lot", 0],
    ["plating", "Plating", "Paint & Coatings", "lot", 0],
    ["passivate", "Passivation", "Paint & Coatings", "lot", 0],
    ["fasteners", "Fasteners", "Fasteners & Hardware", "ea", 1],
    ["fittings", "Fittings", "Fittings & Valves", "ea", 1],
    ["valves", "Valves", "Fittings & Valves", "ea", 1],
    ["grating", "Grating", "Grating", "sq ft", 1],
    ["decking", "Decking", "Decking", "sq ft", 1],
    ["detailing", "Detailing", "Engineering & Detailing", "drawing", 0],
    ["engineering", "Engineering / PE Stamp", "Engineering & Detailing", "lot", 0],
    ["inspection", "Inspection / NDE", "Inspection & Testing", "lot", 0],
    ["hydro_test", "Hydro / Pressure Testing", "Inspection & Testing", "lot", 0],
    ["installation", "Installation", "Installation & Rigging", "lot", 0],
    ["rigging", "Rigging / Crane", "Installation & Rigging", "lot", 0],
    ["trucking", "Trucking", "Freight", "load", 0],
    ["other", "Miscellaneous", "Miscellaneous", "lot", 1]
  ];
  var BY = {};
  TYPES.forEach(function (t) { BY[t[0]] = { code: t[0], name: t[1], bucket: t[2], unit: t[3], supplies: !!t[4] }; });

  // Buckets in the order the Outsource Totals show them.
  var BUCKETS = ["Paint & Coatings", "Galvanize", "Machining", "Decking", "Engineering & Detailing", "Fasteners & Hardware",
    "Fittings & Valves", "Grating", "Cutting", "Forming & Rolling", "Outside Welding & Fab", "Heat Treat",
    "Inspection & Testing", "Installation & Rigging", "Freight", "Miscellaneous"];

  // Labor-tab ops sent outside → their Item Type.
  var OP_CODE = { plate_cut: "plasma_cut", member_cut: "saw_cut", feat_cope: "cope", feat_notch: "cope", feat_hole: "drill_tap",
    feat_bend: "pipe_bend", feat_brake: "brake_form", feat_roll: "roll", member_weld: "outside_weld", plate_weld: "outside_weld",
    weld_typical: "outside_weld", weld_drawing: "outside_weld", fitting_welds: "outside_weld", member_fit: "outside_fab",
    plate_fit: "outside_fab", detail: "detailing", nde: "inspection", test: "hydro_test", loadout: "trucking", crane: "rigging",
    cnc_prog: "machining" };

  // A free-typed line's likely type, from its words — only a starting point; the user picks.
  var WORDS = [
    [/plasma/i, "plasma_cut"], [/laser/i, "laser_cut"], [/water ?jet/i, "waterjet_cut"], [/oxy|torch|burn/i, "oxy_cut"],
    [/beam ?line|drill ?line/i, "beam_line"], [/\bcope|coping/i, "cope"], [/\bsaw/i, "saw_cut"], [/shear/i, "shear"], [/punch/i, "punch"],
    [/brake/i, "brake_form"], [/\broll/i, "roll"], [/bend/i, "pipe_bend"], [/thread|groov|bevel/i, "pipe_end_prep"],
    [/drill|tap/i, "drill_tap"], [/machin|cnc|mill|turn/i, "machining"], [/heat ?treat|stress ?relie|normaliz/i, "heat_treat"],
    [/galv/i, "galvanize"], [/powder/i, "powder_coat"], [/anodiz/i, "anodize"], [/plat(ing|ed)\b/i, "plating"], [/passivat/i, "passivate"],
    [/blast|paint|prime|coat/i, "blast_paint"], [/valve/i, "valves"], [/fitting|flange|elbow/i, "fittings"],
    [/bolt|anchor|fastener|nut|washer/i, "fasteners"], [/grating|tread/i, "grating"], [/deck/i, "decking"],
    [/detail|shop draw/i, "detailing"], [/engineer|\bpe\b|stamp|calc/i, "engineering"], [/hydro|pressure test|leak test/i, "hydro_test"],
    [/inspect|nde|\bndt|\bcwi|x-?ray|\but\b|\bmt\b/i, "inspection"], [/install|erect/i, "installation"], [/crane|rigg/i, "rigging"],
    [/truck|freight|deliver|ship/i, "trucking"], [/weld/i, "outside_weld"], [/fab/i, "outside_fab"]
  ];
  function guess(label) { var s = String(label || ""); for (var i = 0; i < WORDS.length; i++) if (WORDS[i][0].test(s)) return WORDS[i][1]; return "other"; }

  // The code of one Summary line (key = a standard line, "w:<comp>|<op>" from the Labor tab, or "x…" typed).
  function codeOf(key, line) {
    var l = line || {};
    if (l.code && BY[l.code]) return l.code;
    if (BY[key]) return key;
    var m = /^w:.*\|(.+)$/.exec(String(key || ""));
    if (m && OP_CODE[m[1]]) return OP_CODE[m[1]];
    return guess(l.label);
  }

  var api = { TYPES: TYPES, BY: BY, BUCKETS: BUCKETS, OP_CODE: OP_CODE, guess: guess, codeOf: codeOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.OutsideTypes = api;
})(typeof window !== "undefined" ? window : this);
