// =============================================================================
//  takeoff/engine.js — the proven Claude take-off call (CommonJS, for the server)
// -----------------------------------------------------------------------------
//  Mirrors the spike's railway/takeoff-engine.js exactly (validated 52/52 on
//  Alden), in CommonJS so it drops into the existing nesting server.
//  runTakeoff({ docs, modelKey, includeSynopsis }) -> { rows, notes, synopsis,
//    cost_usd, usage, modelKey, modelId }.  docs = array of base64 PDF strings.
// =============================================================================

const _Anthropic = require("@anthropic-ai/sdk");
const Anthropic = _Anthropic.default || _Anthropic; // 0.40.x CJS interop
const fs = require("fs");
const path = require("path");

// The whole take-off package comes back in ONE tool call, so this ceiling has to cover every
// BOM row AND the synopsis the review page is built from. Requests this size are streamed; a
// non-streamed call this large risks an HTTP timeout before the response completes.
// The answer ceiling for a take-off read. 32000 cut off a 54-sheet handrail run mid-answer on
// 2026-10-06 and nothing could be read back (0 rows, $1.25 spent). All three models accept more when
// streamed (Sonnet 4.6 / Opus 4.8 up to 128K, Haiku 4.5 64K); you pay only for what is written.
const TAKEOFF_MAX_OUT = 64000;
// An edit lists only its changes. 8000 covers a reconcile against an attached list that touches
// dozens of rows; a one-decision fix uses a few hundred.
const EDIT_MAX_OUT = 8000;

const MODELS = {
  haiku:  { id: "claude-haiku-4-5-20251001", in: 1,  out: 5,  cacheWrite: 1.25,  cacheRead: 0.10 },
  sonnet: { id: "claude-sonnet-4-6",          in: 3,  out: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  // Opus 4.8 is $5/$25 per MTok. This row carried $15/$75 - the old Opus 3 / 4.1 pricing -
  // so every Deep run has been REPORTED at three times what it actually cost. Cache rates follow
  // the base: write is 1.25x input, read is 0.1x.
  opus:   { id: "claude-opus-4-8",            in: 5,  out: 25, cacheWrite: 6.25,  cacheRead: 0.50 },
};

const LOW_CONF = 0.6;
const docprep = require("./docprep");

let KNOWLEDGE;
try {
  KNOWLEDGE = fs.readFileSync(path.join(__dirname, "knowledge.md"), "utf8");
} catch (e) {
  KNOWLEDGE = [
    "MATERIAL CATALOG (fallback — knowledge.md not found):",
    "FORM TYPES (sub-typed; output the exact sub-type): Beam - I/W/S/HP/WT, Channel, Channel - MC,",
    "Tube - Square/Round/Rectangle, Bar - Flat/Round/Square/Hex, Angle, Tee, Pipe, Plate, Tread Plate, Sheet.",
    "MATERIAL TYPES: Carbon Steel, Carbon Steel - Galvanized, Aluminum, Stainless Steel.",
    "Galvanizing on fabricated shapes = the galvanized flag (material stays Carbon Steel), NOT a material type.",
  ].join("\n");
}

const ROW_ITEM = {
  type: "object",
  properties: {
    form_type:     { type: "string", description: "Form Type = the EXACT sub-typed name from §1 (never a generic parent). One of: 'Beam - I','Beam - W','Beam - S','Beam - HP','Beam - WT','Channel','Channel - MC','Tube - Square','Tube - Round','Tube - Rectangle','Bar - Flat','Bar - Round','Bar - Square','Bar - Hex','Angle','Tee','Pipe','Plate','Tread Plate','Sheet'. HSS→Tube-*; C-channel→Channel; MC-channel→Channel - MC." },
    material_type: { type: "string", description: "Mat Type = exact string: 'Aluminum','Carbon Steel','Carbon Steel - Galvanized', or 'Stainless Steel'. For galvanized fabricated shapes keep 'Carbon Steel' and set galvanized:true." },
    specification: { type: "string", description: "Spec valid for that Form+Material per §1: e.g. '6061-T6'/'6063-T6'/'6061-B308' (aluminum), 'A36'/'A992'/'A572 Gr 50'/'A500 Gr B' (carbon), 'A36 Galvanized' (galv), '304'/'316'/'A240 304/316' (stainless)." },
    size:          { type: "string", description: "Material = exact catalog size format from §1 — SPACES around x, correct prefix: 'L4 x 4 x 1/4', 'C10 x 15.3', 'C 12 x 8.274' (alum), 'MC8 x 8.5', 'W12 x 26', '6\" SCH 80 (XS)' (pipe, no 'PIPE'), '1/2\"' (plate, no 'PL'), '4 x 1/4' (square tube, no 'HSS')." },
    length_ft:     { type: "number", description: "Length per piece in feet (estimate if scaled)." },
    quantity:      { type: "number", description: "Number of pieces of this exact size/length in ONE unit of the component. If the job builds several of a component, do NOT multiply — read one unit; the multiplication to the job total is done downstream." },
    source_sheet:  { type: "string", description: "Sheet number the member was read from, e.g. 'S-201'." },
    member_mark:   { type: "string", description: "Member mark/tag if shown, e.g. 'B-12'. Empty if none." },
    component:     { type: "string", description: "The project COMPONENT/ASSEMBLY this member belongs to. If a PROJECT COMPONENTS list is provided in context, use the EXACT matching name from it; otherwise infer a short assembly name (e.g. 'Loading Dock Frame', 'Stair S1'). Empty only if none applies." },
    confidence:    { type: "number", description: "0.0–1.0 — your confidence in this row. Be honest; flag guesses low." },
    note:          { type: "string", description: "OPTIONAL one short phrase only (≤100 chars), e.g. 'GAP — verify with spec/PM'. Do NOT write paragraphs here — all detailed analysis goes in `synopsis` or the top-level `notes`, never per-row." },
    galvanized:    { type: "boolean", description: "true if hot-dip galvanized per spec/drawings. Galvanizing is a FINISH: keep material_type as the base steel ('Carbon Steel') so the size resolves — do NOT use a 'Carbon Steel - Galvanized' material type for fabricated shapes." },
    width_ft:      { type: "number", description: "REQUIRED for Plate / Sheet / Tread Plate (area-measured): the plate WIDTH in feet (a 12\"-wide plate = 1.0). Put thickness in `size` ('1/2\"') and the width here. Linear members omit this." },
    disposition:   { type: "string", description: "How this member is procured: 'fabricate' (cut/weld in the shop from stock — the default), 'buyout' (bought complete: grating, handrail systems, hatches, ladders), or 'by-others' (someone else's scope). Say which — do not leave it out." },
    cross_check:   { type: "string", description: "Where this row's evidence came from, once you have reconciled the lists against the drawings. EXACTLY one of: 'both' (it is on a parts list/BOM table AND shown on a drawing — the two agree), 'list_only' (listed but you could not find it drawn), 'drawing_only' (drawn or scheduled but absent from the parts list), 'corrected' (the list and the drawing disagreed and you took one over the other — say which in `note`), or 'no_list' (this package has no parts list covering it, so there was nothing to check against). Never guess: 'both' means you actually saw it in both places." },
  },
  // component and source_sheet are REQUIRED: a row that can't be tied to a component and a drawing
  // can't be checked, can't be grouped, and lands in staging without a link. They may be empty
  // strings when genuinely unknown, but the model has to make that call explicitly.
  required: ["form_type", "material_type", "specification", "size", "length_ft", "quantity",
             "confidence", "component", "source_sheet", "disposition", "cross_check"],
};

// PIPE FITTINGS are a different animal from structural steel and live in a different place on the
// project (the fittings quote subform, rolled up separately as Unit_Fittings_*). They are bought
// complete, identified by a type × make × end × connection × spec vocabulary rather than a size
// string, and they must NEVER land in the structural BOM — which is exactly what happened when the
// schema gave the model nowhere else to put an elbow.
const FITTING_ITEM = {
  type: "object",
  properties: {
    /* The catalog block below is the list — these examples are NOT.
       Naming types here invites the model to copy the example instead of the catalog,
       and a name the catalog does not use matches nothing on the review page: the
       fitting arrives with no id and therefore no price.

       Note how the catalog splits a branch outlet: the TYPE is the family ("Olet") and
       the product is the END TYPE ("Threadolet", "Weldolet", "Sockolet", "Elbolet").
       A drawing says THREADOLET, so the pair has to be assembled, and the model has to
       be told that in so many words or it writes the drawing's word into `fitting_type`
       and loses the link. */
    fitting_type:    { type: "string", description: "WHAT it is — copied character for character from the FITTING TYPES list in the shop's catalog block below, and ONLY from that list. Some types are families whose specific product is an END TYPE beneath them: a THREADOLET or WELDOLET on a drawing is fitting_type 'Olet' with that word as the end_type. Never put a product name here that the FITTING TYPES list does not contain. If nothing in the list fits, take the closest, set confidence ≤ 0.3, and name what the drawing actually called for in `note`." },
    fitting_make:    { type: "string", description: "The material family, verbatim from FITTING MAKES (e.g. 'Carbon Steel', 'Stainless Steel', 'Wrought - Carbon Steel', 'Iron - Malleable')." },
    end_type:        { type: "string", description: "How it joins, verbatim from the END TYPES listed under THAT fitting type in the catalog block — only the ones listed under it, never an end type borrowed from another type. This is also where the specific product goes when the type is a family: a threadolet is Olet + 'Threadolet', a weldolet is Olet + 'Weldolet'." },
    connection_type: { type: "string", description: "The geometry/face, verbatim from CONNECTION TYPES (e.g. '90° (Long Radius)', '45° (Long Radius)', 'Concentric', 'Eccentric', 'Raised Face', 'Flat Face', 'Equal', 'Reducing', 'Standard')." },
    /* Make and specification are ONE choice, not two.
       The catalog lists specifications underneath the make that owns them, and the
       commonest wrong answer is a real spec filed under the wrong make — "Carbon Steel"
       with "WPB | ASTM A234", which this catalog keeps under "Wrought - Carbon Steel".
       The pair then matches no catalog row, so the line carries no weight and no price. */
    specification:   { type: "string", description: "Grade/spec copied verbatim from the SPECIFICATIONS listed UNDER the make you chose — the two are one choice. If the grade the drawing calls for is listed under a different make, change fitting_make to that make rather than pairing a spec with a make the catalog does not file it under." },
    size:            { type: "string", description: "Nominal size as written on the drawing — '6\"', '2-1/2\"'; for reducers and reducing tees give both, largest first: '6\" x 4\"'." },
    schedule_or_class: { type: "string", description: "Wall or pressure rating as written: 'SCH 40', 'SCH 80', 'STD', 'XS', 'Class 150', 'Class 300', '3000#', '6000#'. Empty only if the documents genuinely never state it." },
    quantity:        { type: "number", description: "Pieces in ONE unit of the component — same rule as the BOM: never multiply by how many of the component the job builds." },
    component:       { type: "string", description: "The component/assembly this fitting belongs to, spelled EXACTLY as in the project's confirmed scope." },
    source_sheet:    { type: "string", description: "The drawing or document number it was read from — a P&ID, an iso, a piping plan, or a parts list." },
    confidence:      { type: "number", description: "0.0–1.0. Be honest: a fitting inferred from a line callout rather than a schedule is a guess." },
    note:            { type: "string", description: "OPTIONAL one short phrase (≤100 chars), e.g. 'schedule not stated — assumed to match line'." },
    cross_check:     { type: "string", description: "Same rule as BOM rows: 'both', 'list_only', 'drawing_only', 'corrected' or 'no_list'." },
  },
  required: ["fitting_type", "size", "quantity", "component", "source_sheet", "confidence"],
};

const SYNOPSIS_SCHEMA = {
  type: "object",
  description: "Structured project review for the estimator's approval page — the full bid-package analysis.",
  properties: {
    project: {
      type: "object", description: "Top-level project identification.",
      properties: {
        name:        { type: "string", description: "Project name as shown on the title block." },
        type:        { type: "string", description: "Project type, e.g. 'K-12 / institutional', 'WWTP', 'commercial'." },
        sheets_read: { type: "array", items: { type: "string" }, description: "Sheet + spec section numbers you read, e.g. ['S-101','A-220','Spec 05 12 00']." },
        summary:     { type: "string", description: "1–2 sentence plain-English summary of the steel scope." },
      },
    },
    scope_of_work: {
      type: "object", description: "Four work streams, each a short bullet list (phrases, not paragraphs).",
      properties: {
        fabricate: { type: "array", items: { type: "string" }, description: "What WE fabricate." },
        buyout:    { type: "array", items: { type: "string" }, description: "Buyout/outsource items (grating, railings, hatches) — quote-only, NOT BOM rows." },
        by_others: { type: "array", items: { type: "string" }, description: "Out of our scope (concrete, precast, etc.)." },
        send_out:  { type: "array", items: { type: "string" }, description: "Fabricated by us but sent out for finishing (galvanizing, etc.)." },
      },
    },
    decisions: {
      type: "array",
      description: "JUDGMENT CALLS the estimator must confirm — surface them as explicit choices, do not silently decide. Only true scope/finish ambiguities; not data-entry.",
      items: {
        type: "object",
        properties: {
          id:                { type: "string", description: "Short stable id, e.g. 'd1'." },
          item:              { type: "string", description: "The question, e.g. '4 davit cranes on S-301 — in fab scope?'." },
          where:             { type: "string", description: "Sheet/spec reference." },
          why_flagged:       { type: "string", description: "One sentence: why this needs a human call." },
          ai_recommendation: { type: "string", description: "The option you recommend (one of the answers), or '' if genuinely undecided." },
          options:           { type: "array", items: { type: "string" }, description: "The 2 (rarely 3) answer choices, e.g. ['Include','Skip']." },
        },
        required: ["id", "item", "options"],
      },
    },
    reconciliation: {
      type: "object",
      description: "THE CROSS-CHECK: every parts list / BOM table in the package worked against what the drawings actually show. Fill this in whenever the package contains a bill of material, a parts list, a cut list, or a material table on a drawing. If there is no such list anywhere, set performed=false and leave the arrays empty.",
      properties: {
        performed: { type: "boolean", description: "true if you actually reconciled a list against the drawings." },
        sources:   { type: "array", items: { type: "string" }, description: "What you reconciled — document numbers and/or sheets whose title-block material tables you used, e.g. ['AAP3805291-00504 BOM','S-201 material table']." },
        agreed:    { type: "number", description: "How many line items matched the drawings on size, quantity and length." },
        only_in_list: {
          type: "array", description: "On a parts list but you could NOT find it drawn or detailed. These are still real material — keep them in the BOM — but the estimator must know they were unverified.",
          items: { type: "object", properties: {
            item: { type: "string" }, where: { type: "string", description: "Which list and line." },
            quantity: { type: "string" }, action: { type: "string", description: "What you did — kept it, or why not." },
          }, required: ["item"] },
        },
        only_on_drawings: {
          type: "array", description: "Drawn, dimensioned or scheduled but MISSING from the parts list. This is the highest-value finding in the whole take-off — an omission from the shop's own list.",
          items: { type: "object", properties: {
            item: { type: "string" }, where: { type: "string", description: "Sheet and detail." },
            why_it_matters: { type: "string" },
          }, required: ["item"] },
        },
        lists_compared: {
          type: "array",
          description: "WHEN THE PACKAGE HAS MORE THAN ONE PARTS LIST, compare them to EACH OTHER and report it here — one entry per pair. Two near-identical lists are the dangerous case: they are usually a revision or a parent/child pair, and the few lines where they differ are exactly what an estimator needs to see. Empty when there is only one list.",
          items: {
            type: "object",
            properties: {
              list_a: { type: "string", description: "The document you treated as authoritative." },
              list_b: { type: "string", description: "The other one." },
              relationship: { type: "string", description: "'nested' (b's items are already inside a), 'revision' (same scope, different issue/date), 'separate' (genuinely different scopes), or 'unclear'." },
              items_in_common: { type: "number", description: "Lines that appear on both AND match on EVERY field you could compare: size/section, dimensions (length, width, thickness), quantity, grade/spec, and weight where both give one. A line that appears on both but differs on ANY of those is NOT counted here — it belongs in `differences`. If a field is stated on one list and absent from the other, that is not agreement either: put it in `differences` with the missing side written '(not stated)'." },
              compared_on: { type: "array", items: { type: "string" }, description: "Which fields you were actually able to compare across the two lists, e.g. ['item number','description','size','quantity','length','weight']. Say what you could NOT compare, so the agreed count is read for what it is." },
              only_in_a: { type: "array", items: { type: "object", properties: { item: { type: "string" }, note: { type: "string" } }, required: ["item"] }, description: "On list A, absent from list B." },
              only_in_b: { type: "array", items: { type: "object", properties: { item: { type: "string" }, note: { type: "string" } }, required: ["item"] }, description: "On list B, absent from list A — if you counted from A, THESE ARE THE LINES AT RISK OF BEING MISSED. Say for each whether you included it." },
              differences: {
                type: "array",
                description: "On both lists, but they do not match on something: quantity, size/section, length, width, thickness, grade/spec, or weight — INCLUDING the case where one list states a value and the other leaves it blank. Quantity and dimensions are the ones that change the steel bought, so check them on every shared line; do not report only the obvious size differences.",
                items: { type: "object", properties: {
                  item: { type: "string" },
                  field: { type: "string", description: "What disagrees: 'quantity', 'length', 'size', 'width', 'thickness', 'grade', 'weight'." },
                  a_says: { type: "string" }, b_says: { type: "string" },
                  used: { type: "string", description: "Which value went into the BOM." },
                }, required: ["item"] },
              },
              counted_from: { type: "string", description: "Which list the material was actually taken off, and why that one." },
            },
            required: ["list_a", "list_b", "relationship"],
          },
        },
        mismatches: {
          type: "array", description: "Present in BOTH but they disagree — quantity, length, size, grade or finish.",
          items: { type: "object", properties: {
            item: { type: "string" },
            list_says: { type: "string" }, drawings_say: { type: "string" },
            used: { type: "string", description: "Which value you put in the BOM row." },
            why: { type: "string", description: "One line on why you took that one." },
          }, required: ["item"] },
        },
      },
    },
    gaps: {
      type: "array", description: "Members identified but not countable/sizable from this set (the verify list).",
      items: {
        type: "object",
        properties: {
          item:             { type: "string" },
          where:            { type: "string" },
          why:              { type: "string" },
          suggested_action: { type: "string" },
        },
        required: ["item"],
      },
    },
    conflicts: {
      type: "array", description: "Drawing-vs-spec (or sheet-vs-sheet) disagreements.",
      items: {
        type: "object",
        properties: {
          topic:          { type: "string" },
          drawing_says:   { type: "string" },
          spec_says:      { type: "string" },
          recommendation: { type: "string" },
          // Where the conflict actually lives on the job. A detail on S401 means nothing to the
          // estimator until it's tied to the plan runs where that section is cut.
          member:         { type: "string", description: "The member(s) the conflict affects, as a fabricator names them, e.g. 'L4x4x3/8 continuous ledger angle', 'bent plate 3/8 pour stop', 'shelf angle'." },
          plan_locations: { type: "array", description: "Where this detail/section is used on the PLAN sheets: each place the section or detail callout is cut on a plan. Empty if the plans attached here don't show it.",
                            items: { type: "object", properties: {
                              sheet:    { type: "string", description: "Plan sheet number, verbatim, e.g. 'S201'." },
                              location: { type: "string", description: "Grid lines and/or area as printed, e.g. 'Grid C–D along line 3', 'Area F north edge', 'Roof edge, grids 1–7'." },
                              length_ft:{ type: "number", description: "Estimated run length at THIS location in feet, if it can be read or scaled from dimensions; omit if not." },
                            }, required: ["sheet", "location"] } },
          est_length_ft:  { type: "number", description: "Estimated TOTAL length in feet of the affected member across all plan locations — for continuous members (edge/ledger/shelf angles, bent-plate pour stops, embeds) sum the runs from the plan dimensions. Omit if it can't be estimated." },
          length_basis:   { type: "string", description: "How the length was estimated, e.g. 'sum of grid dimensions along roof edge on S203–S208', 'scaled, ±10%'. Required when est_length_ft is given." },
        },
        required: ["topic"],
      },
    },
    // What the fabricator's scope takes off each sheet, and what it leaves for others. Steel quotes
    // carry inclusions/exclusions by sheet; the estimator should never have to reconstruct it.
    drawing_scope: {
      type: "array", description: "ONE entry per drawing sheet attached: what on that sheet is in the fabricator's scope and what is not.",
      items: {
        type: "object",
        properties: {
          sheet:    { type: "string", description: "Drawing number, verbatim." },
          title:    { type: "string", description: "Sheet title." },
          included: { type: "array", items: { type: "string" }, description: "Fabricator-scope items taken off this sheet, short and specific (e.g. 'W12 roof beams, grids A–F', 'L4x4 ledger angles', 'base plates & anchor rods')." },
          excluded: { type: "array", description: "Items shown on this sheet that are NOT in the fabricator's scope.",
                      items: { type: "object", properties: {
                        item: { type: "string", description: "e.g. 'metal roof deck', 'cast-in-place concrete', 'rebar', 'open-web joists'." },
                        by:   { type: "string", description: "'by others', 'other trade', 'buyout' (we supply but buy it in), or 'not shown — verify'." },
                      }, required: ["item"] } },
          notes:    { type: "string", description: "One line, only if something about this sheet's scope needs saying (e.g. 'demolition only — no new steel')." },
        },
        required: ["sheet"],
      },
    },
    compliance: {
      type: "array", description: "Domestic-content (BABA/AIS), finish schedule, code/spec callouts the estimator should know.",
      items: {
        type: "object",
        properties: { topic: { type: "string" }, note: { type: "string" } },
        required: ["topic", "note"],
      },
    },
    totals: {
      type: "object", description: "Quick roll-up.",
      properties: {
        fab_rows:      { type: "number", description: "Count of quantified fabricate rows." },
        est_weight_lb: { type: "number", description: "Rough total fabricated weight in lb, if estimable." },
        gap_count:     { type: "number" },
        low_conf_count:{ type: "number" },
      },
    },
    confidence: {
      type: "object", description: "0.0–1.0 self-assessment overall and by section.",
      properties: {
        overall: { type: "number" }, scope: { type: "number" }, bom: { type: "number" }, gaps: { type: "number" },
      },
    },
  },
};

// -----------------------------------------------------------------------------
//  EDITS, NOT REWRITES. Revise and chat used to have the model return the COMPLETE package to
//  change one thing. On a 149-page parts-list job that was a 4-minute answer that could be cut off
//  at the output ceiling, and every row it copied was a row it could quietly change (confidence
//  dropped from all 37, once). The model now returns only its changes, addressed by the row's
//  index `i` in the package it was shown, and applyChanges() makes them. Rows it does not name
//  are the same objects afterwards — catalog picks, parts-list rows, hand edits and all.
// -----------------------------------------------------------------------------
const CHANGE_ITEM = function (item) {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["update", "delete", "add"], description: "update = change some fields of an existing entry; delete = remove it; add = a new entry." },
      i:      { type: "number", description: "update/delete: the entry's `i` from the CURRENT package. Omit for add." },
      set:    Object.assign({}, item, { required: [], description: "update: ONLY the fields that change. add: the complete new entry." }),
    },
    required: ["action"],
  };
};
const EDIT_TOOL = {
  name: "submit_changes",
  description: "Apply the estimator's change to the take-off by listing ONLY what changes. Everything not listed stays exactly as it is.",
  input_schema: {
    type: "object",
    properties: {
      row_changes:     { type: "array", items: CHANGE_ITEM(ROW_ITEM), description: "Changes to BOM rows, addressed by `i`." },
      fitting_changes: { type: "array", items: CHANGE_ITEM(FITTING_ITEM), description: "Changes to pipe fittings, addressed by `i`." },
      // Conflicts, gaps, decisions and compliance notes are edited ITEM BY ITEM, by `i`, exactly like
      // rows. They used to be returned as a whole replacement array, and resolving ONE conflict came
      // back as an empty list often enough that the estimator lost the rest (2026-10-03, Dunkirk).
      conflict_changes:   { type: "array", items: CHANGE_ITEM(SYNOPSIS_SCHEMA.properties.conflicts.items),  description: "Changes to synopsis.conflicts by `i`. Resolving or dismissing a conflict = `delete` THAT one's `i`. Never touch the others." },
      gap_changes:        { type: "array", items: CHANGE_ITEM(SYNOPSIS_SCHEMA.properties.gaps.items),       description: "Changes to synopsis.gaps by `i`. Closing a gap = `delete` its `i`." },
      decision_changes:   { type: "array", items: CHANGE_ITEM(SYNOPSIS_SCHEMA.properties.decisions.items),  description: "Changes to synopsis.decisions by `i`." },
      compliance_changes: { type: "array", items: CHANGE_ITEM(SYNOPSIS_SCHEMA.properties.compliance.items), description: "Changes to synopsis.compliance by `i`." },
      synopsis:        { type: "object", description: "ONLY the scope_of_work or project section, if you changed it, given IN FULL (the whole `scope_of_work` object with all four streams). Omit to leave it unchanged. Conflicts, gaps, decisions and compliance are NOT edited here — use their *_changes lists.",
                         properties: { scope_of_work: SYNOPSIS_SCHEMA.properties.scope_of_work, project: SYNOPSIS_SCHEMA.properties.project } },
      notes:           { type: "string", description: "ONE short past-tense sentence saying exactly what changed. Shown to the estimator." },
    },
    required: ["notes"],
  },
};

const NOTE_LISTS = ["conflicts", "gaps", "decisions", "compliance"];
const FIT_IDENTITY = ["fitting_type", "fitting_make", "end_type", "connection_type", "specification", "size", "schedule_or_class"];
const FIT_PICK = ["detail_id", "detail_table", "detail_label", "std_label", "size_other", "weight", "auto_matched",
                  "fitting_type_id", "fitting_make_id", "end_type_id", "connection_type_id", "specification_id"];

// The package as the model sees it for an edit: every entry carries its index.
function indexedPackage(current) {
  const tag = function (a) { return (Array.isArray(a) ? a : []).map(function (x, i) { return Object.assign({ i: i }, x); }); };
  let syn = current.synopsis || null;
  if (syn) {
    syn = Object.assign({}, syn);
    NOTE_LISTS.forEach(function (k) { if (Array.isArray(syn[k])) syn[k] = tag(syn[k]); });
  }
  return { rows: tag(current.rows), fittings: tag(current.fittings), synopsis: syn };
}

// Apply the model's changes to the current package. Indexes refer to the package as SHOWN, so all
// updates and deletes resolve against it before anything is appended. A change naming an index that
// does not exist is skipped and reported — never guessed at.
function applyChanges(current, input) {
  input = input || {};
  const skipped = [];
  const one = function (list, changes, kind) {
    const out = (Array.isArray(list) ? list : []).slice();
    const gone = {};
    const adds = [];
    (Array.isArray(unwrap(changes, [])) ? unwrap(changes, []) : []).forEach(function (c) {
      if (!c || !c.action) return;
      const set = (c.set && typeof c.set === "object") ? c.set : {};
      if (c.action === "add") { if (Object.keys(set).length) adds.push(set); return; }
      const i = Number(c.i);
      if (!Number.isInteger(i) || i < 0 || i >= out.length) { skipped.push(kind + " " + c.action + " i=" + c.i); return; }
      if (c.action === "delete") { gone[i] = true; return; }
      const patch = Object.assign({}, set); delete patch.i;
      // A fitting's catalog pick belongs to what the fitting IS. Change its type, make, ends, spec,
      // size or class and the old pick describes a different part — a class fix would otherwise keep
      // the Class 2500 row it was correcting, weight and all. Drop it so the page re-matches.
      if (kind === "fitting" && FIT_IDENTITY.some(function (k) {
            return k in patch && String(patch[k] == null ? "" : patch[k]) !== String(out[i][k] == null ? "" : out[i][k]); })) {
        out[i] = Object.assign({}, out[i]);                  // copy first: never touch the input
        FIT_PICK.forEach(function (k) { delete out[i][k]; });
      }
      out[i] = Object.assign({}, out[i], patch);
      // A quantity edit moves the job total with it. A stale quantity_total is what made the BOM
      // import order a different number from the one on screen.
      if ("quantity" in patch) {
        const u = Math.max(1, Math.round(Number(out[i].units) || 1));
        out[i].qty_per_unit = Number(out[i].quantity) || 0;
        out[i].quantity_total = out[i].qty_per_unit * u;
      }
    });
    return out.filter(function (_, i) { return !gone[i]; }).concat(adds);
  };
  const rows = one(current.rows, input.row_changes, "row");
  const fittings = one(current.fittings, input.fitting_changes, "fitting");
  const syn = Object.assign({}, current.synopsis || {});
  // Item-by-item, like rows: a conflict the model doesn't name is never touched.
  NOTE_LISTS.forEach(function (k) {
    const c = input[k.replace(/s$/, "") + "_changes"];
    if (c !== undefined && Array.isArray(syn[k] || [])) syn[k] = one(syn[k], c, k.replace(/s$/, ""));
  });
  const ch = unwrap(input.synopsis, null);
  // A whole-list replacement of a note list is refused even if sent — that is the path that lost
  // every other conflict when one was resolved.
  if (ch && typeof ch === "object") Object.keys(ch).forEach(function (k) {
    if (ch[k] === undefined) return;
    if (NOTE_LISTS.indexOf(k) > -1) { skipped.push("whole-list replace of " + k + " (ignored)"); return; }
    syn[k] = ch[k];
  });
  // Totals are counted, not asked for — the model is no longer shown the whole BOM to add up.
  const qty = function (r) { return Number(r.quantity) || 0; };
  syn.totals = Object.assign({}, syn.totals || {}, {
    fab_rows: rows.filter(function (r) { return qty(r) > 0 && String(r.disposition || "fabricate") === "fabricate"; }).length,
    gap_count: rows.filter(function (r) { return qty(r) <= 0; }).length,
    low_conf_count: rows.filter(function (r) { return typeof r.confidence === "number" && r.confidence <= LOW_CONF; }).length,
  });
  return { rows: rows, fittings: fittings, synopsis: syn, skipped: skipped };
}

function buildTakeoffTool(includeSynopsis) {
  if (includeSynopsis === undefined) includeSynopsis = true;
  const properties = {
    rows: { type: "array", description: "One row per distinct member size/length/spec combination. STRUCTURAL AND MISC-METAL MEMBERS ONLY — pipe fittings go in `fittings`, never here.", items: ROW_ITEM },
    fittings: { type: "array", description: "Pipe fittings — elbows, tees, flanges, reducers, caps, couplings, unions, nipples and branch outlets, each named as the catalog names it. One entry per distinct type+size+schedule+spec. Empty array if the package has none.", items: FITTING_ITEM },
    notes: { type: "string", description: "Anything ambiguous/illegible/assumed not captured elsewhere — for the human reviewer." },
  };
  if (includeSynopsis) properties.synopsis = SYNOPSIS_SCHEMA;
  return {
    name: "submit_takeoff",
    description: "Submit the structural steel material take-off extracted from the drawings.",
    input_schema: { type: "object", properties, required: ["rows"] },
  };
}

const TAKEOFF_TOOL = buildTakeoffTool(true);

function systemBlocks(includeSynopsis, shopLearning, universalKnowledge, projectContext, liveCatalog, fittingsCatalog) {
  const base =
    "You are an expert structural steel & miscellaneous-metals estimator performing a material " +
    "take-off from engineered drawings. Extract EVERY member you can identify and classify each " +
    "strictly against the provided catalog — never invent a spec or form type.\n\n" +
    "BE EXHAUSTIVE. Estimators routinely MISS these on a first pass — actively hunt for each: " +
    "loose/masonry lintels; partition ledger & masonry embed angles; grating support/embed angles; " +
    "overhead & coiling DOOR FRAMES (channel jambs, plate headers, sill angles); BOLLARDS (pipe); " +
    "embed beams; column base & cap plates; clip/gusset plates. Read SCHEDULES and DETAIL callouts, " +
    "not just plan views — many members only appear there.\n\n" +
    "FLAG GAPS — DON'T DROP THEM. If a member is referenced but you can't size or count it, STILL " +
    "output a row with your best-guess quantity (or 0), confidence 0, and a note 'GAP — verify with " +
    "spec/PM'. A flagged gap is far more useful than a silent omission.\n\n" +
    "CAPTURE FINISH (galvanized / prime / mill) and flag spec-driven finishes. Note if domestic-content " +
    "(BABA/AIS) appears to apply. When a value isn't legible, lower confidence. Group identical " +
    "size+length+spec members into one row with a quantity. Always cite the source sheet.\n\n" +
    "READ THE LISTS AS DATA, NOT AS DECORATION. Two kinds of list appear in these packages and BOTH are " +
    "primary sources: (a) a standalone bill of material / parts list / cut list document, and (b) the " +
    "MATERIAL TABLE printed on a drawing itself — usually beside or above the title block, with item " +
    "numbers, marks, sizes, lengths and quantities, keyed to balloons on the view. Read every one of them " +
    "line by line. They are usually more precise than scaling a view.\n\n" +
    "THEN RECONCILE THE LISTS AGAINST THE DRAWINGS — this is a required step, not an optional one. Work " +
    "each list against what the sheets actually show, and account for every line three ways:\n" +
    "  • in BOTH and agreeing → one row, cross_check 'both', higher confidence.\n" +
    "  • on the LIST but you cannot find it drawn → keep the row (the list is real material), cross_check " +
    "'list_only', and record it in synopsis.reconciliation.only_in_list.\n" +
    "  • DRAWN or scheduled but MISSING from the list → add the row, cross_check 'drawing_only', and record " +
    "it in synopsis.reconciliation.only_on_drawings. This is the most valuable thing you can find — an " +
    "omission from the shop's own list becomes missing steel on the floor.\n" +
    "  • they DISAGREE on quantity, length, size, grade or finish → ONE row using the value you judge " +
    "correct (default to the list for count and length, the drawing for how the member is used), " +
    "cross_check 'corrected', and record both values in synopsis.reconciliation.mismatches.\n" +
    "NEVER DOUBLE-COUNT: a member that is both listed and drawn is ONE row, never two. If the package has " +
    "no list of any kind, set reconciliation.performed=false and use cross_check 'no_list' — do not " +
    "pretend a check happened.\n\n" +
    "TWO PARTS LISTS? COMPARE THEM TO EACH OTHER. When a package carries more than one bill of material, " +
    "do NOT assume one supersedes the other and quietly take off from the bigger one. Work them against " +
    "each other line by line and fill in synopsis.reconciliation.lists_compared: what is on both, what is " +
    "on ONLY ONE, and every line where the quantity, size or grade disagrees. Say which you counted from " +
    "and why. Near-identical lists are the dangerous case, not the easy one — they are usually a revision " +
    "or a parent/child pair, and the handful of lines that differ is the whole point. Anything present on " +
    "the list you did NOT count from must be explicitly included or explicitly explained; it must never " +
    "just fall out.\n" +
    "COMPARE THE NUMBERS, NOT JUST THE NAMES. Two lists 'having the same item' proves nothing — check " +
    "QUANTITY and every DIMENSION (length, width, thickness) line by line, plus grade and stated weight. " +
    "A line only counts as agreeing when all of those match; if one list states a value and the other " +
    "leaves it blank, that is a difference, not a match. A quantity that differs by one, or a length that " +
    "differs by an inch, is exactly the kind of thing a human skims past and a machine should not.\n\n";

  const outputBOM =
    "OUTPUT DISCIPLINE (critical): Return `rows` as a real JSON ARRAY of row objects — NEVER a " +
    "single string, never quoted. Each row carries ONLY the schema fields; keep the per-row `note` " +
    "to one short phrase.";

  const outputSynopsis = includeSynopsis
    ? " Put ALL detailed analysis in the structured `synopsis` object (NOT in prose, NOT per-row): " +
      "fill in `reconciliation` (what you checked the drawings against, what agreed, what was listed but " +
      "not drawn, what was drawn but not listed, and every disagreement with both values) — an estimator " +
      "reads that section before anything else; " +
      "classify scope into fabricate/buyout/by_others/send_out; surface genuine judgment calls as " +
      "`decisions` (each a clear question + 2 answer options + your recommendation) — these are scope/" +
      "finish ambiguities a human must confirm, not data entry; list `gaps`, drawing-vs-spec " +
      "`conflicts`, `compliance` items, `totals`, and per-section `confidence`. Be specific and cite sheets. " +
      "For EVERY conflict, trace the detail or section it concerns back to the PLAN sheets: list each place " +
      "that section/detail callout is cut (`plan_locations`: plan sheet + grid lines/area as printed), name the " +
      "affected `member`, and estimate its length — especially CONTINUOUS members (edge, ledger and shelf angles, " +
      "bent-plate pour stops, continuous embeds): sum the runs from the plan's grid dimensions into " +
      "`est_length_ft`, give a per-location `length_ft` where readable, and say how in `length_basis`. Never " +
      "invent a location or a length — if the plans attached here don't show where the section is cut, leave " +
      "`plan_locations` empty and say so in `length_basis`. " +
      "Fill `drawing_scope` with ONE entry for EVERY drawing sheet attached (including sheets with no fabricator " +
      "steel — say so): what on that sheet is in the fabricator's scope (`included`) and what is shown but NOT " +
      "(`excluded`, each with who: by others / other trade / buyout / not shown — verify)."
    : " Put any brief ambiguities in the top-level `notes` field.";

  // knowledge.md teaches the SHAPE of a size ("L{a} x {b} x {t}"), which let the model compose sizes
  // that look right but don't exist in this shop's lookup — those land as blank/unresolved material.
  // The live catalog closes that: it's the actual list of sizes, so `size` becomes a copy, not a guess.
  const sizeRule = liveCatalog
    ? "\n\nMATERIAL SIZES ARE A CLOSED LIST. Your `size` MUST be copied VERBATIM from the catalog block " +
      "below (the shop's own lookup) — matching character for character including spaces, quotes and " +
      "fractions — the catalog writes dimensions as FRACTIONS, not decimals (`1-1/2 x 1/8`, never " +
      "`1.5 x 1/8`). Never compose, reformat or round a size, and never leave `size` empty. If a member's " +
      "size genuinely isn't in the list, pick the nearest listed size, set confidence ≤ 0.3, and say which " +
      "size the drawing actually called for in the row's `note` — an explicit near-miss can be corrected, " +
      "a blank cannot.\n"
    : "";

  // Fittings are quoted and bought, not cut and welded, and the shop tracks them in their own
  // vocabulary. Without this the model either ignores an elbow or forces it into a structural
  // form type, which is worse — it lands in the BOM as steel to fabricate.
  const fittingsRule = fittingsCatalog
    ? "\n\nPIPE FITTINGS GO IN `fittings`, NEVER IN `rows`. An elbow, tee, flange, reducer, cap, coupling, " +
      "cross, nipple, union, branch outlet, stub end or bushing is a BOUGHT item identified by type × make × end " +
      "type × connection × specification — not by a size string — so it belongs in the `fittings` array, " +
      "with every value copied VERBATIM from the fittings catalog block below. The PIPE ITSELF is " +
      "structural: a run of 6\" SCH 40 pipe is a `rows` entry with form type Pipe; the elbows and flanges " +
      "on that run are `fittings`. Read piping plans, isometrics, P&IDs and any valve/fitting schedule. " +
      "Give each fitting a size and a schedule or class — if the documents state neither, say so in the " +
      "`note` rather than inventing one, and lower confidence. Count fittings per ONE unit of the " +
      "component, exactly like BOM rows.\n"
    : "";

  const blocks = [
    { type: "text", text: base + outputBOM + outputSynopsis + sizeRule + fittingsRule + " Then call submit_takeoff. Do not reply in prose." },
    { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
  ];
  // The shop's fitting vocabulary — small and stable ⇒ prompt-cached beside the size catalog.
  if (fittingsCatalog && String(fittingsCatalog).trim()) blocks.push({ type: "text", text: String(fittingsCatalog), cache_control: { type: "ephemeral" } });
  // The shop's live Form Type × Material Type × size catalog — big and stable ⇒ prompt-cached.
  if (liveCatalog && String(liveCatalog).trim()) blocks.push({ type: "text", text: String(liveCatalog), cache_control: { type: "ephemeral" } });
  // Universal learned knowledge (Tier 1) — same for all shops → cached.
  if (universalKnowledge && String(universalKnowledge).trim()) blocks.push({ type: "text", text: String(universalKnowledge), cache_control: { type: "ephemeral" } });
  // This project's pre-defined components + drawings — per-project, NOT cached.
  if (projectContext && String(projectContext).trim()) blocks.push({ type: "text", text: String(projectContext) });
  // Per-shop learning (Tier 3) — injected, NOT cached (varies per manufacturer).
  if (shopLearning && String(shopLearning).trim()) blocks.push({ type: "text", text: String(shopLearning) });
  return blocks;
}

// A take-off read in several parts re-sends the same ~127k-token catalog and knowledge base with each
// part, and a part runs 5-9 minutes, longer than the default 5-minute cache. So every part paid to
// write it again (2026-10-07: three writes, zero reads). Split runs mark it for an hour instead, so
// parts 2+ read it at a tenth of the price. All markers get the same TTL (longer TTLs must come first).
function withCacheTtl(blocks, ttl) {
  if (ttl !== "1h") return blocks;
  return blocks.map(function (b) { return b.cache_control ? Object.assign({}, b, { cache_control: { type: "ephemeral", ttl: "1h" } }) : b; });
}

function costOf(usage, model) {
  return (
    usage.input_tokens * model.in +
    // A 1-hour cache write costs 2x input, not 1.25x; usage breaks writes down by TTL.
    (((usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens) || 0) * model.in * 2) +
    (((usage.cache_creation_input_tokens || 0) - ((usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens) || 0)) * model.cacheWrite) +
    (usage.cache_read_input_tokens || 0) * model.cacheRead +
    usage.output_tokens * model.out
  ) / 1_000_000;
}

function unwrap(v, fallback) {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { return fallback; } }
  return v == null ? fallback : v;
}

// One attached file, as a content block.
//
// A plain STRING is a base64 PDF - the original shape, and still what the uploader sends for a
// PDF. An OBJECT carries its own media type, which is how a photographed or scanned drawing gets
// in: the model reads an image directly, so there is no conversion step to lose detail in.
//
// The REVISE path has always accepted images this way. Only the RUN was PDF-only, and the
// uploader silently DROPPED everything else - `accept="application/pdf"` plus a filter on
// f.type - so selecting a JPG of a drawing did nothing at all, with no message to say why.
function docBlock(d) {
  if (typeof d === "string") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: d } };
  }
  const mt = String((d && d.media_type) || "");
  if (mt.indexOf("image/") === 0) {
    return { type: "image", source: { type: "base64", media_type: mt, data: d.data } };
  }
  return { type: "document", source: { type: "base64", media_type: mt || "application/pdf", data: (d && d.data) || d } };
}

async function runTakeoff(opts) {
  opts = opts || {};
  const docs = opts.docs;
  const modelKey = opts.modelKey || "sonnet";
  const includeSynopsis = opts.includeSynopsis !== undefined ? opts.includeSynopsis : true;
  // `blocks` = content already prepared by docprep (drawings as PDFs, documents as text, one batch
  // of a larger package). Without it, docs[] are sent as they are — the original path.
  const blocks = Array.isArray(opts.blocks) && opts.blocks.length ? opts.blocks : null;
  if (!blocks && (!Array.isArray(docs) || !docs.length)) throw new Error("runTakeoff: docs[] (base64 PDFs) required");
  const model = MODELS[modelKey] || MODELS.sonnet;
  const anthropic = opts.client || new Anthropic(); // ANTHROPIC_API_KEY from env

  // ONE tool call carries the whole package - every row, the fittings, and the synopsis.
  // 16000 was not enough for a large job: the rows came back, the synopsis was cut off the
  // end, and the review page was skipped with no error anywhere. Streamed because a ceiling
  // this high risks an HTTP timeout on a non-streamed call.
  const resp = await anthropic.messages.stream({
    model: model.id,
    max_tokens: (model.maxOut || TAKEOFF_MAX_OUT),
    system: withCacheTtl(systemBlocks(includeSynopsis, opts.shopLearning, opts.universalKnowledge, opts.projectContext, opts.liveCatalog, opts.fittingsCatalog), opts.cacheTtl),
    tools: [buildTakeoffTool(includeSynopsis)],
    tool_choice: { type: "tool", name: "submit_takeoff" },
    messages: [{
      role: "user",
      content: [].concat(
        blocks || docs.map(docBlock),
        [{ type: "text", text: "Perform the full material take-off across ALL the attached documents (drawings + any specs). Cross-reference structural, architectural, and spec sheets." +
          (opts.batchNote ? "\n\n" + opts.batchNote : "") }]
      ),
    }],
  }).finalMessage();

  const toolUse = resp.content.find(function (b) { return b.type === "tool_use"; });
  const result = toolUse ? toolUse.input : { rows: [], notes: "(no tool_use returned)" };

  result.rows = unwrap(result.rows, []);
  if (!Array.isArray(result.rows)) result.rows = [];
  // The string-instead-of-array quirk applies to every array the model returns, not just rows.
  result.fittings = unwrap(result.fittings, []);
  if (!Array.isArray(result.fittings)) result.fittings = [];
  const synopsis = includeSynopsis ? unwrap(result.synopsis, null) : null;

  // A cut-off response is not an empty one. The rows are kept - they are paid for and
  // usable - but the caller is TOLD, because a missing synopsis silently sends the
  // estimator down a different path and looks like the take-off simply chose to.
  const truncated = resp.stop_reason === "max_tokens";
  let notes = result.notes || "";
  if (truncated) {
    notes = (notes ? notes + "\n\n" : "") +
      "The read was cut off at " + TAKEOFF_MAX_OUT + " output tokens" +
      (includeSynopsis && !synopsis ? ", so the scope synopsis is missing" : "") +
      ". The rows below are what came back before the cut.";
  }

  return {
    rows: result.rows,
    fittings: result.fittings,
    notes: notes,
    truncated: truncated,
    synopsis: synopsis,
    cost_usd: Number(costOf(resp.usage, model).toFixed(4)),
    usage: resp.usage,
    modelKey: MODELS[modelKey] ? modelKey : "sonnet",
    modelId: model.id,
  };
}

// -----------------------------------------------------------------------------
//  reviseTakeoff — the 3c "tell the AI to revise" loop. Takes the CURRENT package
//  (rows + synopsis) + an estimator instruction, returns the COMPLETE revised
//  package. Edit-only by default (no PDFs); pass docs[] to let it re-read drawings.
// -----------------------------------------------------------------------------
const REVISE_SYSTEM =
  "You are REVISING an existing structural steel material take-off based on an estimator's instruction. " +
  "You are given the current package (BOM rows + fittings + synopsis) and ONE instruction. Every row and " +
  "fitting carries its index `i`. Apply the instruction PRECISELY by calling submit_changes with ONLY what " +
  "changes — never the whole package.\n" +
  "RULES: (1) Change ONLY what the instruction implies. Anything you do not list stays exactly as it is, so " +
  "never list an entry to 'keep' it. (2) row_changes / fitting_changes: `update` with the entry's `i` and ONLY " +
  "the fields that change in `set`; `delete` with its `i`; `add` with the complete new entry in `set`. The `i` " +
  "is always the index in the package you were shown. (3) To resolve a conflict or decision: change the " +
  "affected rows AND `delete` THAT conflict (conflict_changes) or decision (decision_changes) by its `i`. " +
  "Conflicts, gaps, decisions and compliance notes each carry an `i` too and are edited ONE BY ONE exactly like " +
  "rows — only the ones you name change; every other one stays. Never resend a whole list. " +
  "(3b) REMOVE/DISMISS gaps or conflicts: `delete` each one by its `i`. (3c) SCOPE OF WORK: " +
  "return the FULL scope_of_work object with all four streams, the change applied — never only describe it in notes. " +
  "(4) Obey every catalog rule from the knowledge base (exact sub-typed form types, size formats, valid specs). " +
  "Totals are recounted for you; do not send them. " +
  "(5) In `notes`, write ONE short past-tense sentence stating EXACTLY what you changed " +
  "(e.g. 'Set galvanized = Yes on 12 exterior lintels and shelf angles, and removed the lintel-finish conflict.'). " +
  "It is shown to the estimator as confirmation of the edit. " +
  "(6) REFERENCE ATTACHMENTS: if the user attached a document (a BOM sheet, cut list, spec, vendor quote, " +
  "marked-up drawing), reconcile the take-off against it per the instruction — add what is missing, delete " +
  "extras, update quantities/sizes/specs — as individual changes, obeying every catalog rule. " +
  "(7) Rows whose note starts 'Parts list item' were read directly off the parts list; change them only when " +
  "the instruction is explicitly about them. Then call submit_changes. No prose.";

async function reviseTakeoff(opts) {
  opts = opts || {};
  const current = opts.current || {};
  const instruction = opts.instruction;
  const modelKey = opts.modelKey || "sonnet";
  const docs = opts.docs;
  const attachments = opts.attachments;  // mixed: [{kind:'pdf'|'image'|'text', media_type?, data?, text?, name?}]
  if (!instruction) throw new Error("reviseTakeoff: instruction required");
  const model = MODELS[modelKey] || MODELS.sonnet;
  const anthropic = opts.client || new Anthropic();

  const userContent = [];
  // Legacy path: docs[] = base64 PDFs (re-read drawings).
  if (Array.isArray(docs) && docs.length) {
    docs.forEach(function (d) { userContent.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d } }); });
  }
  // New path: mixed reference attachments (PDF / image / text BOM sheet, etc).
  let attachLabels = [];
  if (Array.isArray(attachments) && attachments.length) {
    attachments.forEach(function (a) {
      if (!a) return;
      const nm = a.name ? String(a.name) : "attachment";
      if (a.kind === "image" && a.data) {
        userContent.push({ type: "image", source: { type: "base64", media_type: a.media_type || "image/png", data: a.data } });
        attachLabels.push(nm + " (image)");
      } else if (a.kind === "text" && a.text) {
        userContent.push({ type: "text", text: "ATTACHED REFERENCE DOCUMENT — " + nm + " (text/CSV):\n" + String(a.text).slice(0, 200000) });
        attachLabels.push(nm + " (text)");
      } else if (a.data) {  // default to PDF document
        userContent.push({ type: "document", source: { type: "base64", media_type: a.media_type || "application/pdf", data: a.data } });
        attachLabels.push(nm + " (pdf)");
      }
    });
  }
  if (attachLabels.length) {
    userContent.push({ type: "text", text: "The estimator attached " + attachLabels.length + " reference document(s): " + attachLabels.join(", ") + ". Apply them per the instruction below (reconcile / merge — do not blindly replace)." });
  }
  // FITTINGS GO IN TOO. They were left out, so the estimator could ask for anything about the
  // structural rows and nothing at all about the pipe fittings — the one table that generates
  // the most questions was the one table the AI could not see. It answered as though the
  // fittings did not exist, which reads as a refusal rather than a blind spot.
  userContent.push({ type: "text", text:
    "CURRENT TAKE-OFF PACKAGE (JSON — every row and fitting carries its index `i`):\n" +
    JSON.stringify(indexedPackage(current)) +
    "\n\nESTIMATOR INSTRUCTION:\n" + instruction +
    "\n\nApply the instruction by calling submit_changes with ONLY the changes." });

  // Only the changes come back, so the answer is small whatever the size of the job.
  const resp = await anthropic.messages.stream({
    model: model.id,
    max_tokens: EDIT_MAX_OUT,
    system: [
      { type: "text", text: REVISE_SYSTEM },
      { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
    ],
    tools: [EDIT_TOOL],
    tool_choice: { type: "tool", name: "submit_changes" },
    messages: [{ role: "user", content: userContent }],
  }).finalMessage();

  // A cut-off change list is incomplete — applying half an instruction is worse than none.
  if (resp.stop_reason === "max_tokens") {
    throw new Error("The revision was cut off at " + EDIT_MAX_OUT + " output tokens before the AI " +
      "finished listing its changes, so nothing was changed. Ask for a narrower edit.");
  }

  const toolUse = resp.content.find(function (b) { return b.type === "tool_use"; });
  if (!toolUse) throw new Error("The AI returned no changes, so nothing was changed.");
  const applied = applyChanges(current, toolUse.input);

  return {
    rows: applied.rows,
    fittings: applied.fittings,
    notes: (toolUse.input.notes || "") + (applied.skipped.length ? " (skipped, index not found: " + applied.skipped.join(", ") + ")" : ""),
    synopsis: applied.synopsis,
    cost_usd: Number(costOf(resp.usage, model).toFixed(4)),
    usage: resp.usage,
    modelId: model.id,
  };
}

// -----------------------------------------------------------------------------
//  chatTakeoff — CONVERSATIONAL "Tell the AI". Multi-turn: takes the running
//  message thread + the CURRENT package, and EITHER answers/chats in text OR
//  edits the take-off (calls submit_takeoff). Tool is OPTIONAL (auto), so the
//  model can reply to a question without forcing a (possibly destructive) edit.
//  opts: { messages:[{role:'user'|'assistant', text}], current:{rows,synopsis},
//          modelKey, attachments }. Returns { edited, reply, rows?, synopsis?, notes?, cost_usd }.
// -----------------------------------------------------------------------------
const CHAT_SYSTEM =
  "You are the conversational assistant for an estimator reviewing a structural-steel material take-off. " +
  "You are given the CURRENT package (BOM rows + synopsis) and the running conversation. Decide each turn:\n" +
  "• If the user ASKS A QUESTION or just chats (e.g. 'what spec did you use for the angles?', 'how many tons?', " +
  "'why is this galvanized?'), reply in PLAIN TEXT — concise, specific, grounded in the current package. Do NOT call the tool.\n" +
  "• If the user REQUESTS A CHANGE (edit/add/remove rows, resolve a conflict, remove gaps/conflicts, reconcile against an " +
  "attached doc, change spec/finish/markup), call submit_changes with ONLY what changes. Every row and fitting carries its " +
  "index `i`: `update` with that `i` and only the changed fields in `set`; `delete` with its `i`; `add` with the complete new " +
  "entry. Anything not listed stays exactly as it is — never list an entry to keep it. Obey every catalog rule (exact " +
  "sub-typed form types, size formats, valid specs). Conflicts, gaps, decisions and compliance notes carry an `i` and are " +
  "edited ONE BY ONE like rows (conflict_changes / gap_changes / decision_changes / compliance_changes): resolving ONE " +
  "conflict = fix the rows + `delete` that conflict's `i` — every other conflict stays untouched; never resend a whole list. " +
  "A scope edit → the FULL scope_of_work object with all four streams — never only described in `notes`. If the user pasted a screenshot/image, match " +
  "the quoted text to the exact item and change THAT one. Totals are recounted for you. In `notes`, write ONE short " +
  "past-tense sentence stating exactly what you changed (shown to the estimator as confirmation).\n" +
  "Use the prior conversation for context (the user may say 'now also…' or refer to earlier turns). Keep text replies brief.";

async function chatTakeoff(opts) {
  opts = opts || {};
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const current = opts.current || {};
  const modelKey = opts.modelKey || "sonnet";
  const attachments = opts.attachments;
  const model = MODELS[modelKey] || MODELS.sonnet;
  const anthropic = opts.client || new Anthropic();

  // Map the thread to Anthropic turns (text only — current package is injected fresh on the last turn).
  const msgs = messages.map(function (m) {
    return { role: m.role === "assistant" ? "assistant" : "user", content: [{ type: "text", text: String(m.text || "") }] };
  });
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: [{ type: "text", text: "(continue)" }] });

  // Augment the LAST user turn with attachments + the current package context (prepended before the user's text).
  const extra = [];
  if (Array.isArray(attachments) && attachments.length) {
    attachments.forEach(function (a) {
      if (!a) return;
      if (a.kind === "image" && a.data) extra.push({ type: "image", source: { type: "base64", media_type: a.media_type || "image/png", data: a.data } });
      else if (a.kind === "text" && a.text) extra.push({ type: "text", text: "ATTACHED REFERENCE — " + (a.name || "doc") + ":\n" + String(a.text).slice(0, 200000) });
      else if (a.data) extra.push({ type: "document", source: { type: "base64", media_type: a.media_type || "application/pdf", data: a.data } });
    });
  }
  // Fittings are in here for the same reason they are in reviseTakeoff: without them "Ask AI"
  // cannot see the pipe fittings at all, and answers questions about them as though the table
  // were empty.
  extra.push({ type: "text", text: "CURRENT TAKE-OFF PACKAGE (JSON — every row and fitting carries its index `i`):\n" + JSON.stringify(indexedPackage(current)) + "\n\n(The message that follows is the user's latest turn.)" });
  const last = msgs[msgs.length - 1];
  last.content = extra.concat(last.content);

  const resp = await anthropic.messages.create({
    model: model.id,
    max_tokens: EDIT_MAX_OUT,
    system: [
      { type: "text", text: CHAT_SYSTEM },
      { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
    ],
    tools: [EDIT_TOOL],
    tool_choice: { type: "auto" },
    messages: msgs,
  });

  const cost = Number(costOf(resp.usage, model).toFixed(4));
  const toolUse = resp.content.find(function (b) { return b.type === "tool_use"; });
  const textOut = resp.content.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n").trim();

  if (toolUse && resp.stop_reason === "max_tokens") {   // an incomplete change list — never apply it
    return { edited: false, cost_usd: cost, usage: resp.usage, modelId: model.id,
      reply: "⚠ That edit was cut off before the AI finished listing its changes, so nothing was changed. " +
             "Ask for a narrower edit." };
  }
  if (toolUse) {
    const applied = applyChanges(current, toolUse.input);
    const said = String(toolUse.input.notes || "").trim();
    return { edited: true, rows: applied.rows, fittings: applied.fittings, synopsis: applied.synopsis,
      notes: said,
      reply: (said || textOut || "Updated the take-off.") +
             (applied.skipped.length ? " (skipped, index not found: " + applied.skipped.join(", ") + ")" : ""),
      cost_usd: cost, usage: resp.usage, modelId: model.id };
  }
  return { edited: false, reply: textOut || "(no reply)", cost_usd: cost, usage: resp.usage, modelId: model.id };
}

// -----------------------------------------------------------------------------
//  readSheetIndex — the intake "sheet-index" pass. Reads ONLY the sheet NUMBERS
//  (+ page ranges) from a drawing PDF; does NOT take off materials or propose any
//  components. The widget reconciles these sheets against the user's typed list.
//  Input dominates cost (same PDF as a take-off), but output is tiny and there's
//  no synopsis reasoning, so it's much cheaper than a full run.
// -----------------------------------------------------------------------------
//  The model is asked for ONE ROW PER PAGE — never for a list of "sheets". Sheets are then
//  derived in code by grouping consecutive pages that carry the same title-block number, and
//  the whole thing is reconciled against the REAL page count parsed from the PDF file itself.
//  That's what makes the drawing count checkable: pages are ground truth, drawings are derived.
const SHEET_INDEX_TOOL = {
  name: "submit_sheet_index",
  description: "Report the title-block drawing number found on EVERY page of the uploaded PDF(s), one entry per page. Do NOT take off materials.",
  input_schema: {
    type: "object",
    properties: {
      pages: {
        type: "array",
        description: "EXACTLY one entry per page of the package, in page order — including pages with no drawing number.",
        items: {
          type: "object",
          properties: {
            doc:        { type: "integer", description: "1-based index of the attached document this page is in (1 = first PDF attached). Use 1 if only one document." },
            page:       { type: "integer", description: "1-based page number WITHIN that document." },
            number:     { type: "string",  description: "The EXACT drawing number from this page's title block, verbatim (e.g. 'RIS-48300-S1-A-1', 'S-201'). Empty string if the page has no legible drawing number (cover, index, notes, blank). Never normalize, expand, or invent." },
            title:      { type: "string",  description: "Short sheet title from the title block if legible, else empty." },
            continued:  { type: "boolean", description: "True if this page is a continuation of the SAME drawing number as the previous page." },
            confidence: { type: "number",  description: "0-1 confidence the number was read correctly (0 when there is no number)." },
            suggested_component: { type: "string", description: "The component / assembly this sheet details, as a SHORT name (2-4 words) taken from the title block, e.g. 'Catwalk Floor', 'Platform Railing', 'Stair Stringers'. Drop the project/product prefix. Sheets detailing the SAME assembly MUST get the IDENTICAL string so they group. Empty for a cover, index or notes page." },
          },
          required: ["page", "number"],
        },
      },
      documents: {
        type: "array",
        description: "One entry per ATTACHED DOCUMENT, in attachment order — including documents that are not drawings at all (a bill of material, parts list, cut list, spec section, vendor cut sheet). Every attached document gets an entry, no exceptions.",
        items: {
          type: "object",
          properties: {
            doc:   { type: "integer", description: "1-based index of the attached document." },
            kind:  { type: "string",  description: "What this document IS: 'drawings' (sheets with title blocks), 'bom' (bill of material / parts list / cut list / material summary), 'spec' (specification section, written requirements), or 'other'." },
            label: { type: "string",  description: "The document's own identifying number or title, read from inside it (e.g. 'AAP3805291-00504', 'Bill of Material Rev C', 'Section 05 12 00'). Empty if it carries none." },
            summary: { type: "string", description: "ONE short line: what this document contains and what an estimator would use it for (e.g. 'Parts list for the platform assembly — 84 line items with marks, sizes and cut lengths.')." },
            suggested_component: { type: "string", description: "If the whole document relates to ONE assembly, the same short component name used for the sheets; else empty." },
          },
          required: ["doc", "kind"],
        },
      },
    },
    required: ["pages"],
  },
};

const SHEET_SYSTEM =
  "You are INDEXING a structural steel drawing package — not taking it off. Go through the attached PDF(s) PAGE BY PAGE " +
  "and report the drawing number in each page's title block. Do NOT list members, quantities, sizes, or materials. " +
  "Do NOT infer or propose components.\n" +
  "RULES: (1) Return EXACTLY ONE ENTRY PER PAGE, in page order, for EVERY page — no page skipped, no page reported twice. " +
  "The number of entries you return MUST equal the number of pages stated in the request. " +
  "(2) Use the EXACT number printed in the title block, verbatim — never normalize, expand, or invent one. " +
  "(3) If a page has no legible drawing number (cover sheet, drawing index, notes page, blank), return that page with " +
  "number as an empty string and confidence 0 — never fabricate a number and never omit the page. " +
  "(4) If a page continues the SAME drawing as the previous page, repeat that same number and set continued=true. " +
  "Do NOT group pages yourself — one row per page; the grouping is done downstream. " +
  "(5) Give a per-page confidence.\n" +
  "(6) ALSO propose the component / assembly each sheet details, in `suggested_component`, read from the " +
  "title block — this is a SUGGESTION the estimator will accept, rename or ignore, so make it the name a " +
  "fabricator would use: short (2-4 words), no project or product prefix, no sheet numbers. Sheets that " +
  "detail the SAME assembly must carry the IDENTICAL string so they group under one component; a sheet " +
  "family sharing a number stem (…-10A-2A, …-10A-2B, …-10A-3) is usually one assembly. Leave it empty for " +
  "cover, index and notes pages. Do NOT invent an assembly the title block doesn't support.\n" +
  "(7) ALSO return `documents` — ONE entry for EVERY attached document, in order, including documents that " +
  "are NOT drawings (a bill of material / parts list / cut list, a spec section, a vendor cut sheet). Say " +
  "what each one IS (`kind`), the number or title printed inside it (`label`), and one line on what it " +
  "contains (`summary`). Never skip a document because it has no title blocks — a BOM or parts list is one " +
  "of the most valuable documents in the package and it must be reported, not ignored.\n" +
  "Return via submit_sheet_index.";

// GROUND TRUTH — the page count comes from the PDF file itself, never from the model.
// pdf-lib parses the real page tree (works with compressed object streams, unlike a byte
// scan). Returns null if the file can't be parsed, so callers can degrade instead of lying.
async function pdfPageCount(b64) {
  try {
    const { PDFDocument } = require("pdf-lib");
    const doc = await PDFDocument.load(Buffer.from(String(b64), "base64"),
      { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const n = doc.getPageCount();
    return (typeof n === "number" && n > 0) ? n : null;
  } catch (err) {
    console.error("pdfPageCount failed:", (err && err.message) || err);
    return null;
  }
}

// Derive SHEETS from the per-page reads: consecutive pages carrying the same title-block
// number are one drawing. A number that reappears after a gap is still ONE drawing (its
// page list keeps both runs) but is reported in `split` so it can be shown as unusual.
// What an attached file can be. A package is rarely all drawings — the BOM/parts list and the spec
// arrive in the same upload and have to be carried through the same way.
const DOC_KINDS = ["drawings", "bom", "spec", "other"];
function fileStem(nm) { return String(nm == null ? "" : nm).replace(/\.[A-Za-z0-9]+$/, "").trim(); }
function normNum(n) { return String(n == null ? "" : n).toUpperCase().replace(/[^A-Z0-9]/g, ""); }
// The most-repeated non-empty title across a set of pages — a BOM's pages usually all carry the
// same header, so this names the entry from the document itself rather than from the file name.
function commonTitle(entries, doc, pages) {
  const want = {}; pages.forEach(function (p) { want[p] = 1; });
  const tally = {};
  entries.forEach(function (e) {
    if (e.doc !== doc || !want[e.page]) return;
    const t = String(e.title || "").trim();
    if (t) tally[t] = (tally[t] || 0) + 1;
  });
  let best = "", n = 0;
  Object.keys(tally).forEach(function (t) { if (tally[t] > n) { n = tally[t]; best = t; } });
  return best;
}

function groupPagesIntoSheets(entries) {
  const key = function (n) { return String(n).toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  const sorted = entries.slice().sort(function (a, b) { return (a.doc - b.doc) || (a.page - b.page); });
  const byKey = {}, order = [], split = [];
  let last = null;
  sorted.forEach(function (e) {
    if (!e.number) { last = null; return; }                 // unreadable page breaks the run
    const k = e.doc + "|" + key(e.number);
    const s = byKey[k];
    if (!s) {
      byKey[k] = { doc: e.doc, number: e.number, title: e.title || "", pages: [e.page, e.page],
                   page_list: [e.page], confidence: (e.confidence == null ? null : e.confidence),
                   suggested_component: e.suggested_component || "" };
      order.push(k);
    } else {
      if (!s.suggested_component && e.suggested_component) s.suggested_component = e.suggested_component;
      if (last !== k && split.indexOf(s.number) < 0) split.push(s.number);   // non-adjacent repeat
      s.pages = [Math.min(s.pages[0], e.page), Math.max(s.pages[1], e.page)];
      s.page_list.push(e.page);
      if (e.title && e.title.length > (s.title || "").length) s.title = e.title;   // keep the fullest title
      if (e.confidence != null) s.confidence = (s.confidence == null) ? e.confidence : Math.max(s.confidence, e.confidence);
    }
    last = k;
  });
  return { sheets: order.map(function (k) { return byKey[k]; }), split: split };
}

async function readSheetIndex(opts) {
  opts = opts || {};
  const modelKey = opts.modelKey || "sonnet"; // accuracy of sheet detection matters; output is tiny so tier ≠ cost driver
  if (!Array.isArray(opts.docs) || !opts.docs.length) throw new Error("readSheetIndex: docs[] (base64 PDFs) required");
  const model = MODELS[modelKey] || MODELS.sonnet;
  const anthropic = opts.client || new Anthropic();
  const names = Array.isArray(opts.names) ? opts.names : [];

  // Documents are read as text and never looked at page by page; drawings go in as many requests
  // as the package needs. See docprep.js — this is what lets a 60 MB package be previewed at all.
  const docs = opts.prepared || await docprep.prepareDocs(opts.docs, names);
  docprep.fitText(docs);
  const textDocs = docs.filter(function (it) { return it.kind === "text"; });

  // Count the pages BEFORE asking the model anything — this is the number everything is checked against.
  const docPages = docs.map(function (it) { return it.pages > 0 ? it.pages : (it.kind === "text" ? 1 : null); });
  const knownPages = docPages.every(function (n) { return n != null; });
  const totalPages = knownPages ? docPages.reduce(function (a, b) { return a + b; }, 0) : null;
  const plan = await docprep.planBatches(docs);
  if (!plan.batches.length) plan.batches.push({ parts: [], b64: 0, pages: 0 });   // text only: one call to classify

  // The project's existing components. Without these the model invents a near-duplicate ("Platform
  // Parts" beside an existing "Platform Assembly") and the estimator ends up with two components
  // for one assembly. Reusing what's there is almost always right.
  const known = (Array.isArray(opts.knownComponents) ? opts.knownComponents : [])
    .map(function (c) { return String(c || "").trim(); }).filter(Boolean);
  const knownBlock = known.length
    ? "\n\nTHIS PROJECT ALREADY HAS THESE COMPONENTS:\n" + known.map(function (c) { return "- " + c; }).join("\n") +
      "\nIf a sheet belongs to one of them, put that name in `suggested_component` EXACTLY as written above. " +
      "Only invent a new name when a sheet genuinely fits none of them — do not coin a variant of an " +
      "existing name (no 'Platform Parts' next to an existing 'Platform Assembly')."
    : "";

  // One request per batch. Each request numbers its own attachments 1..k; every page is mapped
  // straight back to its FILE and its page WITHIN that file, so a PDF split across two requests
  // still comes out as one document with continuous page numbers.
  const seen = {}, entries = [], docMeta = {};
  let dupPages = 0, costUsd = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  // A batch whose pages don't all come back is asked again ONCE, with just the files it missed.
  const queue = plan.batches.slice();
  for (let b = 0; b < queue.length; b++) {
    const parts = queue[b].parts;
    const withText = b === 0 ? textDocs : [];      // documents are classified once, in the first request
    const pagesHere = parts.reduce(function (s, p) { return s + p.pages; }, 0);
    const manifest = parts.map(function (p, j) {
      return "Document " + (j + 1) + " (" + docprep.partLabel(p) + "): " + p.pages + " page" + (p.pages === 1 ? "" : "s");
    }).concat(withText.map(function (it, k) {
      return "Document " + (parts.length + k + 1) + ' ("' + it.name + '"): a TEXT document' +
        (it.pages ? " of " + it.pages + " pages" : "") + ", given below as an excerpt. Return NO page entries " +
        "for it — give it ONE `documents` entry only.";
    })).join("\n");
    const ask = "Index the attached drawing package PAGE BY PAGE.\n" + manifest + knownBlock +
      (parts.length
        ? "\n\nReturn EXACTLY " + pagesHere + " page entries — one per page of the PDF documents, in order, including any page with no drawing number." +
          "\nEach PDF is a SEPARATE attached document: set `doc` to its number in the list above and `page` to the page " +
          "WITHIN that document — a one-page PDF is always page 1. Never number pages across documents."
        : "\n\nThere are no drawings in this request — return an empty `pages` list and one `documents` entry per document.") +
      (queue.length > 1 ? "\n(This is part " + (b + 1) + " of a larger package read in parts. Number documents exactly as listed above.)" : "") +
      "\nDo not take off materials.";

    // ── THE CEILING HAS TO SCALE WITH THE PACKAGE ──────────────────────────────────────────
    // This asks for one row per page, so a fixed 8000 was only ever right for the package size
    // it was written against. On 2026-09-26 a 153-page set (a 149-page BOM plus three drawings)
    // ran past it: the tool input was cut off mid-JSON, the parser turned that into [], and all
    // 153 pages came back reported as "never came back from the read" with no error anywhere.
    // A truncated index is not a partial index — it is nothing at all.
    const maxTokens = Math.min(48000, Math.max(8000, pagesHere * 130 + withText.length * 300 + 1500));
    const params = {
      model: model.id,
      max_tokens: maxTokens,
      system: SHEET_SYSTEM,
      tools: [SHEET_INDEX_TOOL],
      tool_choice: { type: "tool", name: "submit_sheet_index" },
      messages: [{
        role: "user",
        content: [].concat(
          parts.map(docprep.partBlock),
          withText.map(function (it, k) {
            return { type: "text", text: "Document " + (parts.length + k + 1) + ' — "' + it.name +
              '" (excerpt of a text document):\n' + it.text.slice(0, 6000) };
          }),
          [{ type: "text", text: ask }]
        ),
      }],
    };
    // Above ~16k a non-streamed call risks an HTTP timeout before the response completes, so
    // large packages stream and take the final message.
    const resp = maxTokens > 16000
      ? await anthropic.messages.stream(params).finalMessage()
      : await anthropic.messages.create(params);
    costUsd += costOf(resp.usage, model);
    usage.input_tokens += (resp.usage && resp.usage.input_tokens) || 0;
    usage.output_tokens += (resp.usage && resp.usage.output_tokens) || 0;

    // Say it out loud rather than returning an empty index. Silence here cost an afternoon.
    if (resp.stop_reason === "max_tokens") {
      throw new Error("The page index was cut off at " + maxTokens + " output tokens while indexing " +
        pagesHere + " pages, so none of it could be read. Split the package into fewer pages per " +
        "read, or raise the ceiling in readSheetIndex.");
    }
    const toolUse = resp.content.find(function (x) { return x.type === "tool_use"; });
    // The model answered, but not with the tool. Another silent-empty path.
    if (!toolUse) {
      throw new Error("The read came back without a page index (stop_reason: " +
        (resp.stop_reason || "unknown") + "). Nothing was indexed.");
    }
    let raw = unwrap(toolUse.input.pages, []);
    if (!Array.isArray(raw)) raw = [];

    // Every page of this request in attachment order, so a page can be found by its running
    // number. On Dunkirk (2026-10-03) the model numbered sixteen one-page PDFs as "doc 1, pages
    // 1-16" — fifteen real drawings were thrown away as pages that don't exist. A page that
    // doesn't fit its document is read as a running page number across the request instead.
    const flat = [];
    parts.forEach(function (part, j) { for (let q = 1; q <= part.pages; q++) flat.push({ j: j, page: q }); });
    const runningOk = raw.length === flat.length;

    // Normalize, and keep only ONE entry per (doc,page) — the page is the primary key, so a
    // page the model reported twice can no longer become a second drawing.
    raw.forEach(function (p, n) {
      let local = parseInt(p && p.doc, 10) || 1;
      let page = parseInt(p && p.page, 10);
      if (local > parts.length) return;                                 // a text document
      if (local < 1 || !page || page < 1 || page > parts[local - 1].pages) {
        const at = (local === 1 && page >= 1 && page <= flat.length) ? flat[page - 1]
                 : runningOk ? flat[n] : null;
        if (!at) return;                                                // page that doesn't exist
        local = at.j + 1; page = at.page;
      }
      const part = parts[local - 1];
      const doc = part.item.index + 1, gpage = part.pageOffset + page;
      const k = doc + ":" + gpage;
      if (seen[k]) { dupPages++; return; }
      seen[k] = 1;
      entries.push({
        doc: doc, page: gpage,
        number: String((p && p.number) == null ? "" : p.number).trim(),
        title: String((p && p.title) == null ? "" : p.title).trim(),
        confidence: (p && typeof p.confidence === "number") ? p.confidence : null,
        suggested_component: String((p && p.suggested_component) == null ? "" : p.suggested_component).trim(),
      });
    });

    const modelDocs = unwrap(toolUse.input.documents, []);
    (Array.isArray(modelDocs) ? modelDocs : []).forEach(function (d) {
      const local = parseInt(d && d.doc, 10);
      if (!local || local < 1 || local > parts.length + withText.length) return;
      const i = local <= parts.length ? parts[local - 1].item.index + 1 : withText[local - parts.length - 1].index + 1;
      if (docMeta[i] && docMeta[i].kind) return;      // a split file: the first part's answer stands
      const k = String((d && d.kind) || "").toLowerCase().trim();
      docMeta[i] = {
        kind: DOC_KINDS.indexOf(k) > -1 ? k : "",
        label: String((d && d.label) == null ? "" : d.label).trim(),
        summary: String((d && d.summary) == null ? "" : d.summary).trim(),
        suggested_component: String((d && d.suggested_component) == null ? "" : d.suggested_component).trim(),
      };
    });

    // Anything this request didn't return gets one more try on its own, before it is reported missing.
    if (!queue[b].retry) {
      const missed = parts.filter(function (part) {
        for (let q = 1; q <= part.pages; q++) if (!seen[(part.item.index + 1) + ":" + (part.pageOffset + q)]) return true;
        return false;
      });
      if (missed.length) {
        console.log("[takeoff index] " + missed.length + " file(s) came back incomplete — reading them again");
        queue.push({ parts: missed, retry: true, pages: missed.reduce(function (s, p) { return s + p.pages; }, 0) });
      }
    }
  }

  // A text document has no title blocks to read: every page of it belongs to the document. Filled
  // in here so it is accounted for exactly like a BOM the model read page by page.
  textDocs.forEach(function (it) {
    const doc = it.index + 1;
    for (let p = 1; p <= docPages[doc - 1]; p++) {
      const k = doc + ":" + p;
      if (seen[k]) continue;
      seen[k] = 1;
      entries.push({ doc: doc, page: p, number: "", title: "", confidence: null, suggested_component: "" });
    }
    if (!docMeta[doc] || !docMeta[doc].kind) {
      docMeta[doc] = Object.assign({ label: "", summary: "", suggested_component: "" }, docMeta[doc] || {},
        { kind: /\b(bom|bill of material|parts? list|material list|cut list)\b/i.test(it.name) ? "bom"
              : /spec|division|section/i.test(it.name) ? "spec" : "other" });
    }
  });

  const grouped = groupPagesIntoSheets(entries);
  grouped.sheets.forEach(function (s) { s.kind = "drawing"; });

  // ---- ONE ENTRY PER ATTACHED FILE, DRAWING OR NOT ------------------------
  // A bill of material, a parts list or a spec section carries no title-block number on any page, so
  // the grouping above returns NOTHING for it and the whole file used to disappear from the
  // estimator's list — 62 of 68 pages counted as "no drawing number" and never seen again. Every page
  // that isn't on a drawing is now gathered into ONE entry per file, tagged kind:"document", so each
  // uploaded file is represented, can be put on a component, and travels into the take-off by name.

  const usedNums = {};
  grouped.sheets.forEach(function (s) { usedNums[normNum(s.number)] = 1; });
  const documents = [], docSheets = [];
  for (let i = 1; i <= docs.length; i++) {
    const meta = docMeta[i] || { kind: "", label: "", summary: "", suggested_component: "" };
    const onSheet = {};
    grouped.sheets.forEach(function (s) {
      if (s.doc === i) (s.page_list || []).forEach(function (p) { onSheet[p] = 1; });
    });
    // Pages the model READ but that carry no drawing number. Pages it never returned stay in
    // pages_missing — those are a read failure to fix, not a document to file.
    const loose = entries.filter(function (e) { return e.doc === i && !e.number && !onSheet[e.page]; })
      .map(function (e) { return e.page; })
      .sort(function (a, b) { return a - b; });
    const namedPages = Object.keys(onSheet).length;
    const kind = meta.kind || (namedPages ? "drawings" : "other");
    const rec = { doc: i, name: names[i - 1] || null, pages: docPages[i - 1],
                  pages_on_drawings: namedPages, pages_loose: loose.length,
                  kind: kind, label: meta.label, summary: meta.summary, entry_number: null,
                  // How the file was READ: as text (a document) or looked at as drawings.
                  read_as: docs[i - 1].kind, read_why: docs[i - 1].why || "", trimmed: docs[i - 1].trimmed || null };
    if (loose.length) {
      // Named from the FILE first: that's the name the estimator uploaded and recognises. The
      // number the model read from inside it is the fallback, and a clash with a real drawing
      // number is disambiguated rather than allowed to collide.
      let num = fileStem(names[i - 1]) || meta.label || ("Document " + i);
      if (usedNums[normNum(num)]) num = num + (kind === "bom" ? " (BOM)" : " (doc)");
      usedNums[normNum(num)] = 1;
      docSheets.push({
        doc: i, number: num,
        title: commonTitle(entries, i, loose) || meta.summary ||
               (kind === "bom" ? "Bill of material / parts list" : kind === "spec" ? "Specification" : "Reference document"),
        pages: [loose[0], loose[loose.length - 1]], page_list: loose, confidence: null,
        suggested_component: meta.suggested_component || "",
        kind: "document", doc_kind: kind, file: names[i - 1] || null, summary: meta.summary,
      });
      rec.entry_number = num;
    }
    documents.push(rec);
  }
  // Keep file order: each file's drawings, then that file's document entry.
  const allSheets = [];
  for (let i = 1; i <= docs.length; i++) {
    grouped.sheets.forEach(function (s) { if (s.doc === i) allSheets.push(s); });
    docSheets.forEach(function (s) { if (s.doc === i) allSheets.push(s); });
  }

  // Reconcile against the real page count: every page either belongs to a drawing, has no
  // drawing number (cover/index/notes), or was never reported. All three are reported.
  const blank = [], missing = [];
  entries.forEach(function (e) { if (!e.number) blank.push({ doc: e.doc, page: e.page }); });
  docPages.forEach(function (n, i) {
    if (n == null) return;
    for (let p = 1; p <= n; p++) if (!seen[(i + 1) + ":" + p]) missing.push({ doc: i + 1, page: p });
  });
  const named = entries.filter(function (e) { return !!e.number; }).length;

  const audit = {
    page_count: totalPages,                       // null ⇒ a PDF wouldn't parse; nothing is claimed
    docs: docPages.map(function (n, i) {
      return { doc: i + 1, name: names[i] || null, pages: n,
               pages_named: entries.filter(function (e) { return e.doc === i + 1 && e.number; }).length };
    }),
    documents: documents,                         // one row per attached file, drawings or not
    doc_entries: docSheets.length,                // how many of those became a non-drawing entry
    sheets: grouped.sheets.length,
    pages_named: named,
    pages_blank: blank,                           // real pages with no title-block number
    pages_missing: missing,                       // pages the model never reported back
    pages_reported_twice: dupPages,               // collapsed on the page key
    split_numbers: grouped.split,                 // same number in non-adjacent page runs
    // "ok" = every page of every PDF was accounted for exactly once. Only then is the
    // drawing count trustworthy without a human eyeballing it.
    ok: (totalPages != null && missing.length === 0 && dupPages === 0),
  };

  return {
    sheets: allSheets,
    documents: documents,
    pages: entries,
    audit: audit,
    batches: queue.length,
    cost_usd: Number(costUsd.toFixed(4)),
    usage: usage,
    modelKey: MODELS[modelKey] ? modelKey : "sonnet",
    modelId: model.id,
  };
}

// -----------------------------------------------------------------------------
//  compareAddenda — WHAT EACH ADDENDUM CHANGED, and what that does to the quote.
//  The take-off reads only the newest issue of each sheet (the intake sets the older one
//  aside so its steel isn't counted twice). This puts each original next to its reissue and
//  reports the differences that matter to a steel fabricator. opts.pairs = [{ sheet, issue,
//  old:{name,b64}, new:{name,b64} }], opts.notices = [{ name, text }] (addendum letters read as
//  text), opts.bom = compact rows for context. Pairs are sent in as many requests as needed.
// -----------------------------------------------------------------------------
const ADDENDA_TOOL = {
  name: "submit_addenda",
  description: "Report what each addendum changed on the structural/misc-metals scope and how it affects the fabricator's quote.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array", description: "ONE entry per sheet pair compared.",
        items: { type: "object", properties: {
          sheet:   { type: "string", description: "Sheet number as given in the pair list." },
          issue:   { type: "string", description: "The addendum, as given (e.g. 'Addendum 6')." },
          impact:  { type: "string", enum: ["none", "minor", "major"], description: "Effect on the fabricator's steel scope: none = no steel change (e.g. a note or concrete change only)." },
          summary: { type: "string", description: "One sentence: what changed on this sheet for the fabricator." },
          changes: { type: "array", items: { type: "object", properties: {
            change:   { type: "string", enum: ["added", "removed", "revised"] },
            what:     { type: "string", description: "The member/detail/note that changed, specific (size, mark, detail number)." },
            location: { type: "string", description: "Grid/area/detail where, as printed." },
            quantity: { type: "string", description: "How much, if it can be read: pieces, LF, or 'n/a'." },
            quote_effect: { type: "string", description: "Effect on the quote: 'adds ~X lb', 'deletes N beams', 'changes finish to galvanized', 'no cost effect'…" },
          }, required: ["change", "what"] } },
        }, required: ["sheet", "impact", "summary"] },
      },
      notices: {
        type: "array", description: "ONE entry per addendum letter/narrative given as text: the items in it that touch the fabricator's scope.",
        items: { type: "object", properties: {
          name:  { type: "string" },
          items: { type: "array", items: { type: "string" }, description: "Steel/misc-metals-relevant items only, each one line." },
        }, required: ["name"] },
      },
      overall: { type: "string", description: "Two or three sentences: the net effect of the addenda on the fabricator's quote." },
    },
    required: ["sheets"],
  },
};
const ADDENDA_SYSTEM =
  "You are a structural steel / miscellaneous metals estimator comparing ORIGINAL drawing sheets with their " +
  "ADDENDUM reissues. For each pair, find what changed that matters to the FABRICATOR: members added, removed or " +
  "resized; connection, base plate or anchor changes; new or deleted details; finish (galvanized/primed) changes; " +
  "lengths, elevations or grid changes that move tonnage. Ignore changes that don't touch steel scope except to say " +
  "impact 'none'. Use revision clouds and delta tags when present, but compare the whole sheet — not every change is " +
  "clouded. Be specific (sizes, marks, grids). Never invent a change; if the sheets look identical, say so. " +
  "Return via submit_addenda.";

async function compareAddenda(opts) {
  opts = opts || {};
  const pairs = Array.isArray(opts.pairs) ? opts.pairs : [];
  const notices = Array.isArray(opts.notices) ? opts.notices : [];
  if (!pairs.length && !notices.length) throw new Error("compareAddenda: pairs[] or notices[] required");
  const model = MODELS[opts.modelKey] || MODELS.sonnet;
  const anthropic = opts.client || new Anthropic();
  // Each pair is two PDFs; keep a request under ~24 MB of base64.
  const groups = [];
  let cur = null;
  pairs.forEach(function (p) {
    const len = String(p.old.b64 || "").length + String(p.new.b64 || "").length;
    if (!cur || (cur.pairs.length && cur.len + len > 24 * 1024 * 1024)) { cur = { pairs: [], len: 0 }; groups.push(cur); }
    cur.pairs.push(p); cur.len += len;
  });
  if (!groups.length) groups.push({ pairs: [], len: 0 });

  const out = { sheets: [], notices: [], overall: [], cost_usd: 0 };
  for (let g = 0; g < groups.length; g++) {
    const content = [];
    const lines = [];
    groups[g].pairs.forEach(function (p, k) {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.old.b64 } });
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.new.b64 } });
      lines.push("Pair " + (k + 1) + " — sheet " + p.sheet + " (" + (p.issue || "addendum") + "): document " + (2 * k + 1) +
        ' is the ORIGINAL ("' + p.old.name + '"), document ' + (2 * k + 2) + ' is the REISSUE ("' + p.new.name + '").');
    });
    const withNotices = g === 0 ? notices : [];
    withNotices.forEach(function (n) {
      content.push({ type: "text", text: 'ADDENDUM NOTICE (text) — "' + n.name + '":\n' + String(n.text || "").slice(0, 60000) });
    });
    content.push({ type: "text", text:
      (lines.length ? "SHEET PAIRS:\n" + lines.join("\n") + "\n\n" : "") +
      (withNotices.length ? "Also report the steel-relevant items in each addendum notice above.\n\n" : "") +
      (opts.bom ? "THE CURRENT TAKE-OFF (read from the reissued sheets), for context on what each change affects:\n" + opts.bom + "\n\n" : "") +
      "Compare each pair and report via submit_addenda." });
    const resp = await anthropic.messages.create({
      model: model.id, max_tokens: 8000, system: ADDENDA_SYSTEM,
      tools: [ADDENDA_TOOL], tool_choice: { type: "tool", name: "submit_addenda" },
      messages: [{ role: "user", content: content }],
    });
    out.cost_usd += costOf(resp.usage, model);
    const tu = resp.content.find(function (b) { return b.type === "tool_use"; });
    const r = tu ? tu.input : {};
    const sh = unwrap(r.sheets, []); if (Array.isArray(sh)) out.sheets = out.sheets.concat(sh);
    const nt = unwrap(r.notices, []);
    if (withNotices.length && Array.isArray(nt)) out.notices = out.notices.concat(nt);   // only the request that carried them
    if (r.overall) out.overall.push(String(r.overall));
  }
  return { sheets: out.sheets, notices: out.notices, overall: out.overall.join(" "),
           cost_usd: Number(out.cost_usd.toFixed(4)), modelId: model.id, requests: groups.length };
}

// -----------------------------------------------------------------------------
//  askDocuments — QUESTIONS AT INTAKE. The review page has a conversation about the
//  finished package; this is the same thing one step earlier, about the DOCUMENTS
//  themselves, before a take-off is spent: "what's in file 2?", "does the BOM cover
//  the handrail?", "which sheets have no material on them?". Answers only — it never
//  edits the scope, so it can't quietly change what the run is about to read.
//  The uploaded PDFs are the cached prefix, so a follow-up question costs a fraction
//  of the first one.
// -----------------------------------------------------------------------------
const ASK_SYSTEM =
  "You are Material Compass AI, helping a steel estimator SET UP a material take-off. The estimator has " +
  "uploaded the documents attached below and is deciding how they break into components and drawings " +
  "before spending a take-off run.\n" +
  "Answer their questions about THESE documents: what a file is, what a sheet shows, which sheets carry " +
  "material and which are layouts/notes, what a bill of material lists, whether something appears anywhere " +
  "in the set, how the sheets group into assemblies.\n" +
  "RULES: (1) Ground every answer in the attached documents and cite where — file name, drawing number, " +
  "page. (2) If the documents don't say, say so plainly; never guess a number, a size or a quantity into " +
  "existence. (3) Be brief — a few sentences or a short list, no headings, no preamble. (4) You are NOT " +
  "doing the take-off: don't list out a full BOM even if asked — say which drawings it would come from and " +
  "that the run will produce it. (5) If the estimator's confirmed scope is included below, use it to answer " +
  "coverage questions (what's placed, what isn't) and point at what to fix on this screen. (6) Plain text only.";

async function askDocuments(opts) {
  opts = opts || {};
  const docs = Array.isArray(opts.docs) ? opts.docs : [];
  const names = Array.isArray(opts.names) ? opts.names : [];
  const thread = Array.isArray(opts.messages) ? opts.messages : [];
  if (!thread.length) throw new Error("askDocuments: messages[] required");
  const model = MODELS[opts.modelKey] || MODELS.sonnet;
  const anthropic = opts.client || new Anthropic();

  // Documents go as text, drawings as PDFs. A question is ONE request, so when the drawings are
  // more than one request can hold, the first batch goes and the model is told which files it
  // can't see — an honest "not in front of me" beats a request that fails outright.
  const items = docs.length ? await docprep.prepareDocs(docs, names) : [];
  docprep.fitText(items);
  const plan = items.length ? await docprep.planBatches(items) : { batches: [] };
  const sent = plan.batches.length ? plan.batches[0].parts : [];
  const unseen = items.filter(function (it) {
    return it.kind !== "text" && !sent.some(function (p) { return p.item === it; });
  });

  // The documents are the stable prefix of every turn — cache-marked so question 2 onward is cheap.
  const head = [].concat(sent.map(docprep.partBlock), items.filter(function (it) { return it.kind === "text"; }).map(docprep.textBlock));
  if (head.length) head[head.length - 1].cache_control = { type: "ephemeral" };
  head.push({ type: "text", text:
    (items.length ? "THE ATTACHED DOCUMENTS, in order:\n" + items.map(function (it, i) {
      return (i + 1) + ". " + it.name + (it.kind === "text" ? " (read as text)" : "");
    }).join("\n") + "\n\n" : "") +
    (unseen.length ? "NOT ATTACHED to this question (too large to send together): " +
      unseen.map(function (it) { return it.name; }).join(", ") + ". If the answer needs them, say so.\n\n" : "") +
    (opts.context ? String(opts.context) + "\n\n" : "") +
    "(The estimator's question follows.)" });

  const msgs = [];
  thread.forEach(function (m, i) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const text = String(m.text == null ? "" : m.text);
    if (i === 0) msgs.push({ role: "user", content: head.concat([{ type: "text", text: text }]) });
    else msgs.push({ role: role, content: [{ type: "text", text: text }] });
  });
  if (msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: [{ type: "text", text: "(continue)" }] });

  const resp = await anthropic.messages.create({
    model: model.id,
    max_tokens: 1500,
    system: [{ type: "text", text: ASK_SYSTEM }],
    messages: msgs,
  });
  const reply = resp.content.filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; }).join("\n").trim();
  return { reply: reply || "(no reply)", cost_usd: Number(costOf(resp.usage, model).toFixed(4)),
           usage: resp.usage, modelId: model.id };
}

module.exports = { compareAddenda, applyChanges, indexedPackage, EDIT_TOOL, runTakeoff, reviseTakeoff, chatTakeoff, readSheetIndex, askDocuments, pdfPageCount, groupPagesIntoSheets, MODELS, LOW_CONF, buildTakeoffTool, TAKEOFF_TOOL, costOf };
