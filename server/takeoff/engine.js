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
    quantity:      { type: "number", description: "Number of pieces of this exact size/length." },
    source_sheet:  { type: "string", description: "Sheet number the member was read from, e.g. 'S-201'." },
    member_mark:   { type: "string", description: "Member mark/tag if shown, e.g. 'B-12'. Empty if none." },
    component:     { type: "string", description: "The project COMPONENT/ASSEMBLY this member belongs to. If a PROJECT COMPONENTS list is provided in context, use the EXACT matching name from it; otherwise infer a short assembly name (e.g. 'Loading Dock Frame', 'Stair S1'). Empty only if none applies." },
    confidence:    { type: "number", description: "0.0–1.0 — your confidence in this row. Be honest; flag guesses low." },
    note:          { type: "string", description: "OPTIONAL one short phrase only (≤100 chars), e.g. 'GAP — verify with spec/PM'. Do NOT write paragraphs here — all detailed analysis goes in `synopsis` or the top-level `notes`, never per-row." },
    galvanized:    { type: "boolean", description: "true if hot-dip galvanized per spec/drawings. Galvanizing is a FINISH: keep material_type as the base steel ('Carbon Steel') so the size resolves — do NOT use a 'Carbon Steel - Galvanized' material type for fabricated shapes." },
    width_ft:      { type: "number", description: "REQUIRED for Plate / Sheet / Tread Plate (area-measured): the plate WIDTH in feet (a 12\"-wide plate = 1.0). Put thickness in `size` ('1/2\"') and the width here. Linear members omit this." },
  },
  required: ["form_type", "material_type", "specification", "size", "length_ft", "quantity", "confidence"],
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
    rows: { type: "array", description: "One row per distinct member size/length/spec combination.", items: ROW_ITEM },
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

function systemBlocks(includeSynopsis, shopLearning, universalKnowledge, projectContext) {
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
    "size+length+spec members into one row with a quantity. Always cite the source sheet.\n\n";

  const outputBOM =
    "OUTPUT DISCIPLINE (critical): Return `rows` as a real JSON ARRAY of row objects — NEVER a " +
    "single string, never quoted. Each row carries ONLY the schema fields; keep the per-row `note` " +
    "to one short phrase.";

  const outputSynopsis = includeSynopsis
    ? " Put ALL detailed analysis in the structured `synopsis` object (NOT in prose, NOT per-row): " +
      "classify scope into fabricate/buyout/by_others/send_out; surface genuine judgment calls as " +
      "`decisions` (each a clear question + 2 answer options + your recommendation) — these are scope/" +
      "finish ambiguities a human must confirm, not data entry; list `gaps`, drawing-vs-spec " +
      "`conflicts`, `compliance` items, `totals`, and per-section `confidence`. Be specific and cite sheets."
    : " Put any brief ambiguities in the top-level `notes` field.";

  const blocks = [
    { type: "text", text: base + outputBOM + outputSynopsis + " Then call submit_takeoff. Do not reply in prose." },
    { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
  ];
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
    system: systemBlocks(includeSynopsis, opts.shopLearning, opts.universalKnowledge, opts.projectContext),
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
  const synopsis = includeSynopsis ? unwrap(result.synopsis, null) : null;

  return {
    rows: result.rows,
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
          },
          required: ["page", "number"],
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
  "(5) Give a per-page confidence. Return via submit_sheet_index.";

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
                   page_list: [e.page], confidence: (e.confidence == null ? null : e.confidence) };
      order.push(k);
    } else {
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
  const ask = "Index the attached drawing package PAGE BY PAGE.\n" + manifest +
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
    });
  });

  const grouped = groupPagesIntoSheets(entries);

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
    sheets: grouped.sheets,
    pages: entries,
    audit: audit,
    cost_usd: Number(costOf(resp.usage, model).toFixed(4)),
    usage: resp.usage,
    modelKey: MODELS[modelKey] ? modelKey : "sonnet",
    modelId: model.id,
  };
}

module.exports = { runTakeoff, reviseTakeoff, chatTakeoff, readSheetIndex, pdfPageCount, groupPagesIntoSheets, MODELS, LOW_CONF, buildTakeoffTool, TAKEOFF_TOOL, costOf };
