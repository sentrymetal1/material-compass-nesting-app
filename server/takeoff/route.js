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

const { runTakeoff, reviseTakeoff, LOW_CONF } = require("./engine");
const { buildImportCsv, buildVerifyList } = require("./csv-feed");
const { checkEntitlement, consumeTakeoff } = require("./entitlement");

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
    const out = await runTakeoff({ docs: docs, modelKey: modelKey, includeSynopsis: includeSynopsis });
    const rows = out.rows;

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
      credits_left: balance ? balance.credits_left : null,
      free_left: balance ? balance.free_left : null,
    });
  } catch (err) {
    console.error("takeoff error", err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
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
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}

module.exports = { takeoffHandler, reviseHandler };
