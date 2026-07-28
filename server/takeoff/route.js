// =============================================================================
//  takeoff/route.js (CommonJS) — POST /api/takeoff handler (stateless).
// -----------------------------------------------------------------------------
//  PDFs in → { rows, synopsis, import_csv, verify_csv, counts, cost } out.
//  Holds the Anthropic key (server env), runs the proven engine, builds the
//  CSVs. Does NOT touch Zoho — the widget does the Zoho write under the tenant's
//  own session. Mount in server/index.js:
//
//    const { takeoffHandler } = require("./takeoff/route");
//    app.use("/api/takeoff", express.json({ limit: "60mb" }));  // BEFORE the global 10mb json
//    app.post("/api/takeoff", (req, res) => takeoffHandler(req, res, {}));
//
//  Request : { project_id, manufacturer_id, pdfs:["<b64>",...] | pdf_base64, model?, tier?, include_synopsis? }
//  Response: { ok, count, gap_count, low_confidence, rows, notes, synopsis,
//              cost_usd, import_csv, verify_csv, credits_left, free_left }
// =============================================================================

const { runTakeoff, reviseTakeoff, chatTakeoff, readSheetIndex, askDocuments, LOW_CONF } = require("./engine");
const { buildImportCsv, buildVerifyList } = require("./csv-feed");
const { checkEntitlement, consumeTakeoff } = require("./entitlement");
const { snapRows } = require("./snap");

// Errors from the upstream model API are shown to the user verbatim, and they name the vendor and
// its model ids ("anthropic", "claude-sonnet-…"). The product is Material Compass AI, so rewrite
// them on the way out. The raw text still goes to the server log, where it's needed for debugging.
function outward(err) {
  return String((err && err.message) || err)
    .replace(/\bclaude[-\w.:\[\]]*/gi, "Material Compass AI")
    .replace(/\banthropic\b/gi, "Material Compass AI")
    .replace(/\bx-api-key\b/gi, "API key");
}

async function takeoffHandler(req, res, deps) {
  deps = deps || {};
  const getManufacturer = deps.getManufacturer;
  const updateManufacturer = deps.updateManufacturer;
  const createLog = deps.createLog;
  const buyCreditsUrl = deps.buyCreditsUrl;
  try {
    const body = req.body || {};
    const project_id = body.project_id;
    const manufacturer_id = body.manufacturer_id;
    const modelKey = body.model || "sonnet";
    if (!project_id)      return res.status(400).json({ ok: false, error: "project_id required" });
    if (!manufacturer_id) return res.status(400).json({ ok: false, error: "manufacturer_id required" });

    const docs = (Array.isArray(body.pdfs) && body.pdfs.length) ? body.pdfs : (body.pdf_base64 ? [body.pdf_base64] : []);
    if (!docs.length) return res.status(400).json({ ok: false, error: "pdfs[] or pdf_base64 required" });

    // Premium (default) returns the synopsis; Basic = BOM only (cheaper).
    const includeSynopsis = body.include_synopsis != null ? !!body.include_synopsis : body.tier !== "basic";

    // 0. Credit gate (skipped entirely if entitlement deps aren't wired).
    const gated = typeof getManufacturer === "function";
    if (gated) {
      const ent = await checkEntitlement({ getManufacturer: getManufacturer }, manufacturer_id);
      if (!ent.allowed) {
        return res.status(402).json({
          ok: false, error: "out_of_credits", reason: ent.reason,
          credits: ent.credits, free: ent.free, buy_url: buyCreditsUrl || null,
          message: "You're out of AI take-offs. Buy more credits to continue.",
        });
      }
    }

    // 1. Proven engine.
    const out = await runTakeoff({ docs: docs, modelKey: modelKey, includeSynopsis: includeSynopsis, shopLearning: deps.shopLearning, universalKnowledge: deps.universalKnowledge, projectContext: deps.projectContext, liveCatalog: deps.liveCatalog });
    const rows = out.rows;

    // 1a. Fill in from the confirmed scope what the model left blank. The intake established which
    // component each drawing belongs to, so a row that cites a sheet never needs to go without a
    // component — and a blank component is a row that can't be grouped, checked, or linked on
    // import. Deterministic: it only ever copies the mapping the estimator already approved.
    const fill = { component: 0, sheet_unknown: [] };
    const drawToComp = {};
    (Array.isArray(body.scope_tree) ? body.scope_tree : []).forEach(function (n) {
      const comp = String((n && n.component) || "").trim();
      (Array.isArray(n && n.drawings) ? n.drawings : []).forEach(function (d) {
        const k = String(d == null ? "" : d).toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (k && comp) drawToComp[k] = comp;
      });
    });
    rows.forEach(function (r) {
      if (String(r.component || "").trim()) return;
      const k = String(r.source_sheet || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (k && drawToComp[k]) { r.component = drawToComp[k]; fill.component++; }
      else if (k && fill.sheet_unknown.indexOf(r.source_sheet) < 0) fill.sheet_unknown.push(r.source_sheet);
    });
    if (fill.component) console.log("[takeoff] filled component on " + fill.component + " rows from the confirmed scope");

    // 1b. Snap materials to the catalog's exact spelling BEFORE the CSV is built — the import
    // matches on the string, so "1.5 x 1/8" and "1-1/2 x 1/8" are not the same row to it.
    const snap = deps.catalogGroups ? snapRows(rows, deps.catalogGroups) : { snapped: [], unmatched: [] };
    if (snap.snapped.length) console.log("[takeoff] snapped " + snap.snapped.length + " materials to catalog spelling");

    // 2. Build CSVs + counts.
    const import_csv = buildImportCsv(rows);
    const verify_csv = buildVerifyList(rows);
    const gap_count = rows.filter(function (r) { return (Number(r.quantity) || 0) <= 0; }).length;
    const count = rows.length - gap_count;
    const low_confidence = rows.filter(function (r) { return Number(r.confidence) <= LOW_CONF; }).length;

    // 3. Consume one credit (best-effort, post-success).
    let balance = null;
    if (gated && rows.length > 0) {
      try {
        balance = await consumeTakeoff(
          { getManufacturer: getManufacturer, updateManufacturer: updateManufacturer, createLog: createLog },
          manufacturer_id,
          { Manufacturer: manufacturer_id, Project: project_id, Model: out.modelId, Cost_USD: out.cost_usd, Row_Count: rows.length }
        );
      } catch (e) { console.error("consume/log failed (rows still returned)", e); }
    }

    return res.json({
      ok: true,
      count: count,
      gap_count: gap_count,
      low_confidence: low_confidence,
      rows: rows,
      notes: out.notes,
      synopsis: out.synopsis,
      cost_usd: out.cost_usd,
      import_csv: import_csv,
      verify_csv: verify_csv,
      material_snapped: snap.snapped.length,
      material_unmatched: snap.unmatched.length,
      // What the model left blank, so the review page can show it rather than the user finding out
      // in staging. blank_* counts are AFTER the scope backfill above.
      field_gaps: (function () {
        const empty = function (v) { return v === undefined || v === null || String(v).trim() === ""; };
        return {
          component: rows.filter(function (r) { return empty(r.component); }).length,
          source_sheet: rows.filter(function (r) { return empty(r.source_sheet); }).length,
          member_mark: rows.filter(function (r) { return empty(r.member_mark); }).length,
          size: rows.filter(function (r) { return empty(r.size); }).length,
          length_ft: rows.filter(function (r) { return !(Number(r.length_ft) > 0); }).length,
          width_needed: rows.filter(function (r) {
            return /plate|sheet/i.test(String(r.form_type || "")) && !(Number(r.width_ft) > 0);
          }).length,
          component_filled_from_scope: fill.component,
          unknown_sheets: fill.sheet_unknown.slice(0, 10),
        };
      })(),
      disposition: (function () {
        const c = { fabricate: 0, buyout: 0, "by-others": 0, unset: 0 };
        rows.forEach(function (r) {
          const d = String(r.disposition || "").toLowerCase().trim();
          if (c[d] === undefined) c.unset++; else c[d]++;
        });
        return c;
      })(),
      credits_left: balance ? balance.credits_left : null,
      free_left: balance ? balance.free_left : null,
    });
  } catch (err) {
    console.error("takeoff error", err);
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}

// POST /api/takeoff/revise — the 3c revise loop. Body: { instruction, current:{rows,synopsis},
// project_id?, manufacturer_id?, model?, pdfs? }. Returns the revised package (same shape).
async function reviseHandler(req, res, deps) {
  deps = deps || {};
  try {
    const body = req.body || {};
    const instruction = body.instruction;
    const current = body.current;
    const modelKey = body.model || "sonnet";
    if (!instruction || !String(instruction).trim()) return res.status(400).json({ ok: false, error: "instruction required" });
    if (!current || !Array.isArray(current.rows)) return res.status(400).json({ ok: false, error: "current package (rows[]) required" });

    const out = await reviseTakeoff({
      current: current,
      instruction: instruction,
      modelKey: modelKey,
      docs: (Array.isArray(body.pdfs) && body.pdfs.length) ? body.pdfs : undefined,
      attachments: (Array.isArray(body.attachments) && body.attachments.length) ? body.attachments : undefined,
    });
    const rows = out.rows;
    const gap_count = rows.filter(function (r) { return (Number(r.quantity) || 0) <= 0; }).length;
    const count = rows.length - gap_count;
    const low_confidence = rows.filter(function (r) { return Number(r.confidence) <= LOW_CONF; }).length;

    return res.json({
      ok: true,
      count: count,
      gap_count: gap_count,
      low_confidence: low_confidence,
      rows: rows,
      notes: out.notes,
      synopsis: out.synopsis,
      cost_usd: out.cost_usd,
      import_csv: buildImportCsv(rows),
      verify_csv: buildVerifyList(rows),
    });
  } catch (err) {
    console.error("revise error", err);
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}

// POST /api/takeoff/chat — conversational "Tell the AI". Body: { messages:[{role,text}],
// current:{rows,synopsis}, model?, attachments? }. Returns either a text reply or an edited package.
async function chatHandler(req, res, deps) {
  deps = deps || {};
  try {
    const body = req.body || {};
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ ok: false, error: "messages[] required" });
    const current = body.current || {};

    const out = await chatTakeoff({
      messages: messages,
      current: current,
      modelKey: body.model || "sonnet",
      attachments: (Array.isArray(body.attachments) && body.attachments.length) ? body.attachments : undefined,
    });

    if (out.edited) {
      const rows = out.rows;
      return res.json({
        ok: true, edited: true, reply: out.reply, notes: out.notes,
        rows: rows, synopsis: out.synopsis, cost_usd: out.cost_usd,
        import_csv: buildImportCsv(rows), verify_csv: buildVerifyList(rows),
        count: rows.filter(function (r) { return (Number(r.quantity) || 0) > 0; }).length,
      });
    }
    return res.json({ ok: true, edited: false, reply: out.reply, cost_usd: out.cost_usd });
  } catch (err) {
    console.error("chat error", err);
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}

// POST /api/takeoff/index — the intake sheet-index pass. Body: { pdfs[] | pdf_base64, names?, model? }.
// Returns { sheets:[{doc,number,title,pages:[start,end],page_list,confidence}], pages:[per-page reads],
// audit:{page_count,sheets,pages_blank,pages_missing,ok,...}, cost_usd, model }. The model reads one row
// PER PAGE; sheets are grouped in code and reconciled against the page count parsed from the PDF itself,
// so the drawing count is checkable rather than asserted. No take-off, no components.
// Not metered (like revise/chat) — it's a cheap setup step, not a billable take-off.
async function indexHandler(req, res) {
  try {
    const body = req.body || {};
    const docs = (Array.isArray(body.pdfs) && body.pdfs.length) ? body.pdfs : (body.pdf_base64 ? [body.pdf_base64] : []);
    if (!docs.length) return res.status(400).json({ ok: false, error: "pdfs[] or pdf_base64 required" });
    const out = await readSheetIndex({
      docs: docs,
      names: Array.isArray(body.names) ? body.names : [],
      knownComponents: Array.isArray(body.components) ? body.components : [],
      modelKey: body.model || "sonnet",
    });
    return res.json({ ok: true, sheets: out.sheets, documents: out.documents, pages: out.pages,
                      audit: out.audit, cost_usd: out.cost_usd, model: out.modelId });
  } catch (err) {
    console.error("takeoff index error", err);
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}

// POST /api/takeoff/ask — questions about the UPLOADED DOCUMENTS at intake, before the run.
// Body: { pdfs[] | pdf_base64, names?, messages:[{role,text}], context?, model? } → { ok, reply, cost_usd }.
// Answers only: it never edits the scope or the project. Not metered — like index/chat/revise.
async function askHandler(req, res) {
  try {
    const body = req.body || {};
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ ok: false, error: "messages[] required" });
    const docs = (Array.isArray(body.pdfs) && body.pdfs.length) ? body.pdfs : (body.pdf_base64 ? [body.pdf_base64] : []);
    const out = await askDocuments({
      docs: docs,
      names: Array.isArray(body.names) ? body.names : [],
      messages: messages,
      context: body.context ? String(body.context) : "",
      modelKey: body.model || "sonnet",
    });
    return res.json({ ok: true, reply: out.reply, cost_usd: out.cost_usd, model: out.modelId });
  } catch (err) {
    console.error("takeoff ask error", err);
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}

module.exports = { takeoffHandler, reviseHandler, chatHandler, indexHandler, askHandler };
