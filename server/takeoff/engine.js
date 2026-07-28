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

const MODELS = {
  haiku:  { id: "claude-haiku-4-5-20251001", in: 1,  out: 5,  cacheWrite: 1.25,  cacheRead: 0.10 },
  sonnet: { id: "claude-sonnet-4-6",          in: 3,  out: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  opus:   { id: "claude-opus-4-8",            in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.50 },
};

const LOW_CONF = 0.6;

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
    fitting_type:    { type: "string", description: "WHAT it is — copied verbatim from the FITTING TYPES list in the catalog block (Elbow, Tee, Flange, Reducer, Cap, Coupling, Cross, Nipple, Union, Olet, Stub End, Bushing)." },
    fitting_make:    { type: "string", description: "The material family, verbatim from FITTING MAKES (e.g. 'Carbon Steel', 'Stainless Steel', 'Wrought - Carbon Steel', 'Iron - Malleable')." },
    end_type:        { type: "string", description: "How it joins, verbatim from the END TYPES listed for that fitting type (e.g. 'Butt Weld', 'Socket Weld', 'Threaded - NPT', 'Weld Neck', 'Slip On', 'Blind', 'Weldolet')." },
    connection_type: { type: "string", description: "The geometry/face, verbatim from CONNECTION TYPES (e.g. '90° (Long Radius)', '45° (Long Radius)', 'Concentric', 'Eccentric', 'Raised Face', 'Flat Face', 'Equal', 'Reducing', 'Standard')." },
    specification:   { type: "string", description: "Grade/spec verbatim from the SPECIFICATIONS listed for that make (e.g. 'WPB | ASTM A234', 'A105 | ASTM A105', 'F304L | ASTM A182')." },
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
        },
        required: ["topic"],
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

function buildTakeoffTool(includeSynopsis) {
  if (includeSynopsis === undefined) includeSynopsis = true;
  const properties = {
    rows: { type: "array", description: "One row per distinct member size/length/spec combination. STRUCTURAL AND MISC-METAL MEMBERS ONLY — pipe fittings go in `fittings`, never here.", items: ROW_ITEM },
    fittings: { type: "array", description: "Pipe fittings (elbows, tees, flanges, reducers, caps, couplings, olets, unions, nipples). One entry per distinct type+size+schedule+spec. Empty array if the package has none.", items: FITTING_ITEM },
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
    "pretend a check happened.\n\n";

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
      "`conflicts`, `compliance` items, `totals`, and per-section `confidence`. Be specific and cite sheets."
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
      "cross, nipple, union, olet, stub end or bushing is a BOUGHT item identified by type × make × end " +
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

function costOf(usage, model) {
  return (
    usage.input_tokens * model.in +
    (usage.cache_creation_input_tokens || 0) * model.cacheWrite +
    (usage.cache_read_input_tokens || 0) * model.cacheRead +
    usage.output_tokens * model.out
  ) / 1_000_000;
}

function unwrap(v, fallback) {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { return fallback; } }
  return v == null ? fallback : v;
}

async function runTakeoff(opts) {
  opts = opts || {};
  const docs = opts.docs;
  const modelKey = opts.modelKey || "sonnet";
  const includeSynopsis = opts.includeSynopsis !== undefined ? opts.includeSynopsis : true;
  if (!Array.isArray(docs) || !docs.length) throw new Error("runTakeoff: docs[] (base64 PDFs) required");
  const model = MODELS[modelKey] || MODELS.sonnet;
  const anthropic = opts.client || new Anthropic(); // ANTHROPIC_API_KEY from env

  const resp = await anthropic.messages.create({
    model: model.id,
    max_tokens: 16000,
    system: systemBlocks(includeSynopsis, opts.shopLearning, opts.universalKnowledge, opts.projectContext, opts.liveCatalog, opts.fittingsCatalog),
    tools: [buildTakeoffTool(includeSynopsis)],
    tool_choice: { type: "tool", name: "submit_takeoff" },
    messages: [{
      role: "user",
      content: [].concat(
        docs.map(function (d) { return { type: "document", source: { type: "base64", media_type: "application/pdf", data: d } }; }),
        [{ type: "text", text: "Perform the full material take-off across ALL the attached documents (drawings + any specs). Cross-reference structural, architectural, and spec sheets." }]
      ),
    }],
  });

  const toolUse = resp.content.find(function (b) { return b.type === "tool_use"; });
  const result = toolUse ? toolUse.input : { rows: [], notes: "(no tool_use returned)" };

  result.rows = unwrap(result.rows, []);
  if (!Array.isArray(result.rows)) result.rows = [];
  // The string-instead-of-array quirk applies to every array the model returns, not just rows.
  result.fittings = unwrap(result.fittings, []);
  if (!Array.isArray(result.fittings)) result.fittings = [];
  const synopsis = includeSynopsis ? unwrap(result.synopsis, null) : null;

  return {
    rows: result.rows,
    fittings: result.fittings,
    notes: result.notes || "",
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
  "You are given the current package (BOM rows + synopsis) and ONE instruction. Apply it PRECISELY and " +
  "return the COMPLETE revised package (full rows + full synopsis) via submit_takeoff — NOT a diff, not " +
  "only the changed parts.\n" +
  "RULES: (1) Change ONLY what the instruction implies; copy every unaffected row and synopsis field " +
  "through UNCHANGED. (2) To resolve a conflict or decision: edit the affected rows (e.g. set " +
  "galvanized=true on the named members, change a spec, add or remove rows) AND remove the resolved item " +
  "from synopsis.conflicts (or reflect the decision in scope_of_work). " +
  "(2b) REMOVE/DISMISS: if the instruction says to remove, dismiss, delete, or ignore specific gaps or conflicts " +
  "(without changing the BOM), return synopsis.gaps and/or synopsis.conflicts WITH THOSE ITEMS DROPPED — return " +
  "the full remaining array (an EMPTY array [] if all were removed). NEVER omit the field and NEVER echo a removed " +
  "item back. (2c) SCOPE OF WORK: to add/edit/remove a scope write-up you MUST actually modify the array in " +
  "synopsis.scope_of_work (fabricate/buyout/by_others/send_out) and return the FULL scope_of_work object with the change " +
  "applied (empty [] if a stream is now empty) — NEVER just describe it in notes while leaving scope_of_work unchanged. " +
  "(3) Obey every catalog rule from the " +
  "knowledge base (exact sub-typed form types, size formats, valid specs). (4) Recompute synopsis.totals. " +
  "(5) OUTPUT DISCIPLINE: rows as a real JSON array; all analysis in the structured synopsis. " +
  "(6) In the top-level `notes` field, write ONE short past-tense sentence stating EXACTLY what you changed " +
  "(e.g. 'Set galvanized = Yes on 12 exterior lintels and shelf angles, and removed the lintel-finish conflict.'). " +
  "This sentence is shown to the estimator as confirmation of the edit. " +
  "(7) REFERENCE ATTACHMENTS: if the user attached document(s) (a BOM sheet, cut list, spec, vendor quote, " +
  "marked-up drawing), treat them as REFERENCE to apply per the instruction — e.g. reconcile the current " +
  "take-off against the attached BOM (add missing members, remove extras, correct quantities/sizes/specs to " +
  "match), or merge in listed items. Do NOT blindly replace the package; reconcile per the instruction. Still " +
  "obey every catalog rule (exact sub-typed form types, size formats, valid specs) when mapping attached items. " +
  "Then call submit_takeoff. No prose.";

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
  userContent.push({ type: "text", text:
    "CURRENT TAKE-OFF PACKAGE (JSON):\n" +
    JSON.stringify({ rows: current.rows || [], synopsis: current.synopsis || null }) +
    "\n\nESTIMATOR INSTRUCTION:\n" + instruction +
    "\n\nApply the instruction and return the COMPLETE revised package via submit_takeoff." });

  const resp = await anthropic.messages.create({
    model: model.id,
    max_tokens: 16000,
    system: [
      { type: "text", text: REVISE_SYSTEM },
      { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
    ],
    tools: [buildTakeoffTool(true)],
    tool_choice: { type: "tool", name: "submit_takeoff" },
    messages: [{ role: "user", content: userContent }],
  });

  const toolUse = resp.content.find(function (b) { return b.type === "tool_use"; });
  const out = toolUse ? toolUse.input : { rows: [], notes: "(no tool_use returned)" };
  out.rows = unwrap(out.rows, []);
  if (!Array.isArray(out.rows)) out.rows = [];
  const synopsis = unwrap(out.synopsis, null);

  return {
    rows: out.rows,
    notes: out.notes || "",
    synopsis: synopsis,
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
  "attached doc, change spec/finish/markup), call submit_takeoff with the COMPLETE revised package (full rows + full synopsis), " +
  "NOT a diff. Copy every unaffected row/field through UNCHANGED. Obey every catalog rule (exact sub-typed form types, size " +
  "formats, valid specs). If removing/dismissing gaps or conflicts, return synopsis.gaps/synopsis.conflicts with those items " +
  "DROPPED (empty [] if all removed); never echo a removed item back. " +
  "SCOPE OF WORK edits: to add/edit/remove a scope write-up, you MUST actually modify the array in " +
  "synopsis.scope_of_work (fabricate / buyout / by_others / send_out) and return the FULL scope_of_work object with all four " +
  "arrays — the target item added, edited, or removed (an empty [] if that stream is now empty). NEVER just describe the change " +
  "in `notes` while passing scope_of_work back unchanged. If the user pasted a screenshot/image, match the quoted text to the " +
  "exact scope item and remove/edit THAT one. Recompute synopsis.totals. In the tool's top-level `notes`, " +
  "write ONE short past-tense sentence stating exactly what you changed (shown to the estimator as confirmation).\n" +
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
  extra.push({ type: "text", text: "CURRENT TAKE-OFF PACKAGE (JSON):\n" + JSON.stringify({ rows: current.rows || [], synopsis: current.synopsis || null }) + "\n\n(The message that follows is the user's latest turn.)" });
  const last = msgs[msgs.length - 1];
  last.content = extra.concat(last.content);

  const resp = await anthropic.messages.create({
    model: model.id,
    max_tokens: 16000,
    system: [
      { type: "text", text: CHAT_SYSTEM },
      { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
    ],
    tools: [buildTakeoffTool(true)],
    tool_choice: { type: "auto" },
    messages: msgs,
  });

  const cost = Number(costOf(resp.usage, model).toFixed(4));
  const toolUse = resp.content.find(function (b) { return b.type === "tool_use"; });
  const textOut = resp.content.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n").trim();

  if (toolUse) {
    const out = toolUse.input || {};
    out.rows = unwrap(out.rows, []);
    if (!Array.isArray(out.rows)) out.rows = [];
    const synopsis = unwrap(out.synopsis, null);
    return { edited: true, rows: out.rows, synopsis: synopsis, notes: out.notes || "",
      reply: (out.notes && String(out.notes).trim()) || textOut || "Updated the take-off.",
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
  const docs = opts.docs;
  const modelKey = opts.modelKey || "sonnet"; // accuracy of sheet detection matters; output is tiny so tier ≠ cost driver
  if (!Array.isArray(docs) || !docs.length) throw new Error("readSheetIndex: docs[] (base64 PDFs) required");
  const model = MODELS[modelKey] || MODELS.sonnet;
  const anthropic = opts.client || new Anthropic();

  // Count the pages BEFORE asking the model anything — this is the number everything is checked against.
  const docPages = [];
  for (let i = 0; i < docs.length; i++) docPages.push(await pdfPageCount(docs[i]));
  const names = Array.isArray(opts.names) ? opts.names : [];
  const knownPages = docPages.every(function (n) { return n != null; });
  const totalPages = knownPages ? docPages.reduce(function (a, b) { return a + b; }, 0) : null;

  // Tell the model exactly how many pages it must account for, per document.
  const manifest = docPages.map(function (n, i) {
    return "Document " + (i + 1) + (names[i] ? ' ("' + names[i] + '")' : "") +
      ": " + (n == null ? "page count unknown" : n + " page" + (n === 1 ? "" : "s"));
  }).join("\n");
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

  const ask = "Index the attached drawing package PAGE BY PAGE.\n" + manifest + knownBlock +
    (totalPages != null
      ? "\n\nReturn EXACTLY " + totalPages + " entries — one per page, in order, including any page with no drawing number."
      : "\n\nReturn exactly one entry per page, in order, including any page with no drawing number.") +
    "\nDo not take off materials.";

  const resp = await anthropic.messages.create({
    model: model.id,
    max_tokens: 8000,           // one row per page: a 100-page set needs the headroom
    system: SHEET_SYSTEM,
    tools: [SHEET_INDEX_TOOL],
    tool_choice: { type: "tool", name: "submit_sheet_index" },
    messages: [{
      role: "user",
      content: [].concat(
        docs.map(function (d) { return { type: "document", source: { type: "base64", media_type: "application/pdf", data: d } }; }),
        [{ type: "text", text: ask }]
      ),
    }],
  });

  const toolUse = resp.content.find(function (b) { return b.type === "tool_use"; });
  let raw = unwrap(toolUse ? toolUse.input.pages : [], []);
  if (!Array.isArray(raw)) raw = [];

  // Normalize, and keep only ONE entry per (doc,page) — the page is the primary key, so a
  // page the model reported twice can no longer become a second drawing.
  const seen = {}, entries = [];
  let dupPages = 0;
  raw.forEach(function (p) {
    const doc = Math.min(Math.max(1, parseInt(p && p.doc, 10) || 1), docs.length);
    const page = parseInt(p && p.page, 10);
    if (!page || page < 1) return;
    if (docPages[doc - 1] != null && page > docPages[doc - 1]) return;   // page that doesn't exist
    const k = doc + ":" + page;
    if (seen[k]) { dupPages++; return; }
    seen[k] = 1;
    entries.push({
      doc: doc, page: page,
      number: String((p && p.number) == null ? "" : p.number).trim(),
      title: String((p && p.title) == null ? "" : p.title).trim(),
      confidence: (p && typeof p.confidence === "number") ? p.confidence : null,
      suggested_component: String((p && p.suggested_component) == null ? "" : p.suggested_component).trim(),
    });
  });

  const grouped = groupPagesIntoSheets(entries);
  grouped.sheets.forEach(function (s) { s.kind = "drawing"; });

  // ---- ONE ENTRY PER ATTACHED FILE, DRAWING OR NOT ------------------------
  // A bill of material, a parts list or a spec section carries no title-block number on any page, so
  // the grouping above returns NOTHING for it and the whole file used to disappear from the
  // estimator's list — 62 of 68 pages counted as "no drawing number" and never seen again. Every page
  // that isn't on a drawing is now gathered into ONE entry per file, tagged kind:"document", so each
  // uploaded file is represented, can be put on a component, and travels into the take-off by name.
  const modelDocs = unwrap(toolUse ? toolUse.input.documents : [], []);
  const docMeta = {};
  (Array.isArray(modelDocs) ? modelDocs : []).forEach(function (d) {
    const i = parseInt(d && d.doc, 10);
    if (!i || i < 1 || i > docs.length) return;
    const k = String((d && d.kind) || "").toLowerCase().trim();
    docMeta[i] = {
      kind: DOC_KINDS.indexOf(k) > -1 ? k : "",
      label: String((d && d.label) == null ? "" : d.label).trim(),
      summary: String((d && d.summary) == null ? "" : d.summary).trim(),
      suggested_component: String((d && d.suggested_component) == null ? "" : d.suggested_component).trim(),
    };
  });

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
                  kind: kind, label: meta.label, summary: meta.summary, entry_number: null };
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
    cost_usd: Number(costOf(resp.usage, model).toFixed(4)),
    usage: resp.usage,
    modelKey: MODELS[modelKey] ? modelKey : "sonnet",
    modelId: model.id,
  };
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

  // The documents are the stable prefix of every turn — cache-marked so question 2 onward is cheap.
  const head = docs.map(function (d, i) {
    const b = { type: "document", source: { type: "base64", media_type: "application/pdf", data: d } };
    if (i === docs.length - 1) b.cache_control = { type: "ephemeral" };
    return b;
  });
  head.push({ type: "text", text:
    (docs.length ? "THE ATTACHED DOCUMENTS, in order:\n" + docs.map(function (d, i) {
      return (i + 1) + ". " + (names[i] || ("Document " + (i + 1)));
    }).join("\n") + "\n\n" : "") +
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

module.exports = { runTakeoff, reviseTakeoff, chatTakeoff, readSheetIndex, askDocuments, pdfPageCount, groupPagesIntoSheets, MODELS, LOW_CONF, buildTakeoffTool, TAKEOFF_TOOL, costOf };
