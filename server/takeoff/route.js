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

const { runTakeoff, reviseTakeoff, chatTakeoff, readSheetIndex, askDocuments, LOW_CONF , MODELS } = require("./engine");
const { buildImportCsv, buildVerifyList } = require("./csv-feed");
const { checkEntitlement, consumeTakeoff } = require("./entitlement");
const { snapRows, snapFittings } = require("./snap");
const { extractPartsList, applyPartsList } = require("./partsList");
const { extractText, inspect } = require("../pdfkind");
const docprep = require("./docprep");

// ---- RUNNING A PACKAGE TOO BIG FOR ONE REQUEST ---------------------------------
// Each batch gets its own drawings plus every text document (they're small once read as text, and
// each batch needs the spec and the parts list to read its drawings properly). The parts list is
// the one thing that could be counted twice — every batch would raise its list-only items — so
// only the FIRST batch may raise rows that come from the list alone.
function batchNote(plan, b) {
  const n = plan.batches.length;
  const here = plan.batches[b].parts.map(docprep.partLabel);
  const elsewhere = [];
  plan.batches.forEach(function (x, k) { if (k !== b) x.parts.forEach(function (p) { elsewhere.push(docprep.partLabel(p)); }); });
  return "THIS PACKAGE IS TOO LARGE FOR ONE READ, so it is being taken off in " + n + " parts. This is part " + (b + 1) + " of " + n + ".\n" +
    "Drawings attached to THIS part: " + here.join(", ") + ".\n" +
    "Drawings taken off in the OTHER parts (not attached here — do not take off anything from them): " + elsewhere.join(", ") + ".\n" +
    "Take off ONLY the members shown on the drawings attached to this part. Text documents (specs, parts lists) are attached to every part for reference." +
    (b === 0
      ? " If a parts list has items that appear on NO drawing in the whole package (this part or the others listed above), raise them here as list_only."
      : " Do NOT raise rows that come only from a parts list (list_only) — part 1 handles those. Use the list here to check and correct the members you find on these drawings.") +
    " Your synopsis should cover THIS part only; the parts are combined afterwards.";
}

function uniq(arr) {
  const seen = {};
  return arr.filter(function (v) {
    const k = typeof v === "string" ? "s:" + v.trim().toLowerCase() : "o:" + JSON.stringify(v);
    if (seen[k]) return false; seen[k] = 1; return true;
  });
}

// Lists are joined, counts and weights added, confidence averaged, text kept from the first part
// that had any. Exported for the tests.
function mergeSynopsis(list) {
  list = list.filter(function (s) { return s && typeof s === "object"; });
  if (!list.length) return null;
  const out = JSON.parse(JSON.stringify(list[0]));
  const seen = { confidence: 1 };
  list.slice(1).forEach(function (s) {
    Object.keys(s).forEach(function (k) {
      const a = out[k], b = s[k];
      if (Array.isArray(b)) { out[k] = uniq((Array.isArray(a) ? a : []).concat(b)); return; }
      if (b && typeof b === "object") {
        if (!a || typeof a !== "object" || Array.isArray(a)) { out[k] = JSON.parse(JSON.stringify(b)); return; }
        Object.keys(b).forEach(function (k2) {
          const x = a[k2], y = b[k2];
          if (Array.isArray(y)) a[k2] = uniq((Array.isArray(x) ? x : []).concat(y));
          else if (typeof y === "number" && typeof x === "number") {
            if (k === "confidence") { seen[k2] = (seen[k2] || 1) + 1; a[k2] = x + (y - x) / seen[k2]; }
            else a[k2] = x + y;
          }
          else if (typeof y === "boolean") a[k2] = !!x || y;
          else if (y != null && (x == null || x === "")) a[k2] = y;
        });
        return;
      }
      if (typeof b === "number" && typeof a === "number" && k === "confidence") {
        seen.__top = (seen.__top || 1) + 1; out[k] = a + (b - a) / seen.__top; return;
      }
      if (a == null || a === "") out[k] = b;
    });
  });
  return out;
}

async function runBatches(prepared, plan, engineOpts) {
  const texts = prepared.filter(function (it) { return it.kind === "text"; }).map(docprep.textBlock);
  const batches = plan.batches.length ? plan.batches : [{ parts: [] }];
  const outs = [];
  let failed = null;
  for (let b = 0; b < batches.length; b++) {
    const blocks = batches[b].parts.map(docprep.partBlock).concat(texts);
    const opts = Object.assign({}, engineOpts, { blocks: blocks, batchNote: batches.length > 1 ? batchNote(plan, b) : "" });
    console.log("[takeoff] part " + (b + 1) + "/" + batches.length + ": " + batches[b].parts.length + " drawing file(s), " +
      (batches[b].pages || 0) + " pages, " + texts.length + " text document(s)");
    try {
      const o = await runTakeoff(opts);
      console.log("[ai-cost] takeoff part " + (b + 1) + "/" + batches.length + " $" + o.cost_usd +
        " (in " + ((o.usage && o.usage.input_tokens) || 0) + ", cache-write " + ((o.usage && o.usage.cache_creation_input_tokens) || 0) +
        ", cache-read " + ((o.usage && o.usage.cache_read_input_tokens) || 0) + ", out " + ((o.usage && o.usage.output_tokens) || 0) + ")");
      outs.push(o);
    } catch (e) {
      // A part that fails after earlier parts finished must not throw them away — they're paid
      // for. On 2026-10-03 part 2 hit an empty credit balance and the finished part 1 was lost,
      // so the estimator paid for it twice. Keep what came back and say what's missing.
      if (!outs.length) throw e;
      failed = { part: b + 1, error: e, missing: [] };
      for (let k = b; k < batches.length; k++) batches[k].parts.forEach(function (p) { failed.missing.push(docprep.partLabel(p)); });
      console.error("[takeoff] part " + (b + 1) + " failed — keeping the " + outs.length + " finished part(s):", e.message || e);
      break;
    }
  }
  if (outs.length === 1 && !failed) return outs[0];
  const sum = function (f) { return outs.reduce(function (s, o) { return s + (Number(f(o)) || 0); }, 0); };
  return {
    rows: [].concat.apply([], outs.map(function (o) { return o.rows || []; })),
    fittings: [].concat.apply([], outs.map(function (o) { return o.fittings || []; })),
    notes: (failed
      ? "⚠ INCOMPLETE: part " + failed.part + " of " + batches.length + " failed (" + outward(failed.error) + "), so these drawings were NOT taken off: " +
        failed.missing.join(", ") + ". Add them from this page with ➕ Add drawings.\n\n" : "") +
      outs.map(function (o, i) { return o.notes ? "Part " + (i + 1) + " of " + batches.length + ": " + o.notes : ""; })
      .filter(Boolean).join("\n\n"),
    incomplete: failed ? { part: failed.part, of: batches.length, missing: failed.missing } : null,
    truncated: outs.some(function (o) { return o.truncated; }),
    synopsis: mergeSynopsis(outs.map(function (o) { return o.synopsis; })),
    cost_usd: Number(sum(function (o) { return o.cost_usd; }).toFixed(4)),
    usage: { input_tokens: sum(function (o) { return o.usage && o.usage.input_tokens; }),
             output_tokens: sum(function (o) { return o.usage && o.usage.output_tokens; }) },
    modelKey: outs[0].modelKey,
    modelId: outs[0].modelId,
    parts: outs.length,
  };
}

// Errors from the upstream model API are shown to the user verbatim, and they name the vendor and
// its model ids ("anthropic", "claude-sonnet-…"). The product is Material Compass AI, so rewrite
// them on the way out. The raw text still goes to the server log, where it's needed for debugging.
function outward(err) {
  return String((err && err.message) || err)
    .replace(/\bclaude[-\w.:\[\]]*/gi, "Material Compass AI")
    .replace(/\banthropic\b/gi, "Material Compass AI")
    .replace(/\bx-api-key\b/gi, "API key");
}

// res.json() goes through res.send(), which sets Content-Length and an ETag. After the
// keep-alive heartbeat has written its first space those headers are already out, and Express
// throws rather than sending - losing a run that had completed. Write the body directly in
// that case; the JSON is identical either way.
function sendJson(res, payload) {
  if (res.headersSent) return res.end(JSON.stringify(payload));
  return res.json(payload);
}

async function takeoffHandler(req, res, deps) {
  deps = deps || {};
  // Declared out here so the catch below can stop it - the try block owns the interval.
  let stopHeartbeatRef = null;
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

    // The credit gate above still needs to answer 402 with a body, so the response is not
    // opened until it has passed. Past this point the run takes minutes, and Railway's edge drops a connection that has
    // sent nothing for about five of them. The browser then receives "upstream error", which
    // is not JSON and surfaces as a parse failure with the run already paid for.
    //
    // Whitespace is legal before a JSON document, so a space every 15s keeps the socket alive
    // and the body still parses. Headers go out now, so the error path below can no longer set
    // a status code - it writes ok:false instead, which is what the page branches on anyway.
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (res.flushHeaders) res.flushHeaders();
    const heartbeat = setInterval(function () { try { res.write(" "); } catch (e) {} }, 15000);
    const stopHeartbeat = function () { clearInterval(heartbeat); };
    stopHeartbeatRef = stopHeartbeat;
    res.on("close", stopHeartbeat);

    // 1. Proven engine — once for a package that fits one request, once per batch for one that
    // doesn't. Documents are read as text either way (docprep.js).
    const prepared = await docprep.prepareDocs(docs, Array.isArray(body.names) ? body.names : []);
    docprep.fitText(prepared);
    const plan = await docprep.planBatches(prepared);
    const engineOpts = { modelKey: modelKey, includeSynopsis: includeSynopsis, shopLearning: deps.shopLearning, universalKnowledge: deps.universalKnowledge, projectContext: deps.projectContext, liveCatalog: deps.liveCatalog, fittingsCatalog: deps.fittingsCatalog };
    const out = await runBatches(prepared, plan, engineOpts);
    const rows = out.rows;
    // Pipe fittings come back in their own stream: bought complete, quoted separately, and kept OUT
    // of the BOM CSV on purpose — they belong to the project's fittings quote, not the BOM.
    const fittings = Array.isArray(out.fittings) ? out.fittings : [];

    // 1-0. A TEXT PARTS LIST IS READ, NOT INTERPRETED. Two runs over the same 149-page list
    // disagreed on the steel — one dropped all 21 pipe lines, the other read the main angles at
    // the wrong thickness. Where a document parses as an item/qty/unit list with raw stock on it,
    // its steel rows replace the model's for the forms it carries. Everything else (plates, other
    // components, drawings-only jobs) is left exactly as the model returned it.
    let partsList = null;
    try {
      const bomDocs = (Array.isArray(body.attached_documents) ? body.attached_documents : [])
        .filter(function (d) { return d && String(d.kind || "").toLowerCase() === "bom"; });
      const bomDoc = bomDocs.length === 1 ? bomDocs[0] : null;
      // The estimator marked the list reference-only: it is read for context and raises no rows.
      const refOnly = bomDocs.length > 0 && bomDocs.every(function (d) { return d.reference_only; });
      for (let i = 0; i < prepared.length && !partsList && !refOnly; i++) {
        const it = prepared[i];
        if (it.kind === "image") continue;
        const t = it.kind === "text" ? { text: it.fullText || it.text }
          : await extractText(it.b64).catch(function () { return null; });
        const list = t && t.text ? extractPartsList(t.text, deps.catalogGroups) : null;
        if (!list) continue;
        const scope = Array.isArray(body.scope_tree) ? body.scope_tree : [];
        const comp = String((bomDoc && bomDoc.component) || (scope.length === 1 && scope[0] && scope[0].component) || "").trim();
        const applied = applyPartsList(rows, list, { document: String((bomDoc && bomDoc.number) || "Parts list").trim(), component: comp });
        rows.splice(0, rows.length, ...applied.rows);
        partsList = applied.report;
        console.log("[takeoff] parts list " + partsList.document + ": " + partsList.rows_from_list + " steel rows (" +
          partsList.list_feet + " ft) replaced " + partsList.replaced.length + " model rows (" + partsList.ai_feet_replaced + " ft)");
      }
    } catch (e) { console.error("[takeoff] parts list read failed — model rows kept:", e.message || e); }
    if (partsList && out.synopsis && typeof out.synopsis === "object") out.synopsis.parts_list = partsList;

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

    // 1a-ii. MULTIPLY UP BY THE COMPONENT'S UNIT COUNT. The model reads ONE unit — four identical
    // platforms are drawn once — so the job total is arithmetic done here, deterministically, where
    // it can be shown and undone. `quantity` stays PER UNIT (that's what the drawing says and what
    // the estimator checks); `quantity_total` is what gets ordered, and it's what the CSV writes,
    // because the project's own rollups divide BOM sums by Component.Quantity to get per-unit cost.
    const unitsOf = {};
    (Array.isArray(body.scope_tree) ? body.scope_tree : []).forEach(function (n) {
      const nm = String((n && n.component) || "").trim().toLowerCase();
      const u = Math.max(1, Math.round(Number(n && (n.units != null ? n.units : n.quantity)) || 1));
      if (nm) unitsOf[nm] = u;
    });
    let multiplied = 0;
    rows.forEach(function (r) {
      const u = unitsOf[String(r.component || "").trim().toLowerCase()] || 1;
      const per = Number(r.quantity) || 0;
      r.units = u;
      r.qty_per_unit = per;
      r.quantity_total = per * u;
      if (u > 1 && per > 0) multiplied++;
    });
    if (multiplied) console.log("[takeoff] multiplied " + multiplied + " rows up by their component's unit count");
    // Fittings are counted per unit too, so they get the same treatment — four skids means four
    // sets of elbows.
    fittings.forEach(function (f) {
      const u = unitsOf[String(f.component || "").trim().toLowerCase()] || 1;
      const per = Number(f.quantity) || 0;
      f.units = u; f.qty_per_unit = per; f.quantity_total = per * u;
    });

    // 1b. Snap materials to the catalog's exact spelling BEFORE the CSV is built — the import
    // matches on the string, so "1.5 x 1/8" and "1-1/2 x 1/8" are not the same row to it.
    const snap = deps.catalogGroups ? snapRows(rows, deps.catalogGroups) : { snapped: [], unmatched: [] };
    if (snap.snapped.length) console.log("[takeoff] snapped " + snap.snapped.length + " materials to catalog spelling");

    // Same for the fitting names, and for the same reason: the review page resolves a type by
    // exact string, so a family name or a plural costs the fitting its id and its price.
    const fitSnap = snapFittings(fittings, deps.fittingTypes, deps.fittingEnds);
    if (fitSnap.snapped.length) {
      console.log("[takeoff] snapped fitting types: " +
        fitSnap.snapped.map(function (s) { return s.from + " -> " + s.to; }).join(", "));
    }
    if (fitSnap.unmatched.length) {
      console.log("[takeoff] fitting types not in the catalog: " +
        fitSnap.unmatched.map(function (u) { return u.type || "(blank)"; }).join(", "));
    }

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

    stopHeartbeat();
    return sendJson(res, {
      ok: true,
      count: count,
      gap_count: gap_count,
      low_confidence: low_confidence,
      rows: rows,
      fittings: fittings,
      fitting_count: fittings.length,
      notes: out.notes,
      synopsis: out.synopsis,
      // The model hit the output ceiling and the tail was lost. Carried through so the page can
      // say so: a missing synopsis quietly routes the estimator away from the review page, and
      // without this that reads as a deliberate choice rather than a cut-off response.
      truncated: !!out.truncated,
      // A part of a split run failed; the finished parts are here and these drawings are not.
      incomplete: out.incomplete || null,
      // Sheets an addendum replaced (set aside at intake) and addendum notices — the review page's
      // Addenda tab compares them on request.
      superseded: Array.isArray(body.superseded) ? body.superseded : [],
      addendum_notices: Array.isArray(body.addendum_notices) ? body.addendum_notices : [],
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
      // How much of the BOM was actually corroborated against a parts list, rather than read off a
      // drawing alone. The review page leads with this — it's the difference between "the AI says so"
      // and "two independent sources say so".
      cross_check: (function () {
        const c = { both: 0, list_only: 0, drawing_only: 0, corrected: 0, no_list: 0, unset: 0 };
        rows.forEach(function (r) {
          const k = String(r.cross_check || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
          if (c[k] === undefined) c.unset++; else c[k]++;
        });
        return c;
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
      parts_list: partsList,
      // How each file was read (text or drawing, what was trimmed) and how many requests it took.
      reading: docprep.summary(prepared, plan),
    });
  } catch (err) {
    console.error("takeoff error", err);
    // The heartbeat may already have sent headers, so a status code is no longer available.
    // The page checks ok:false, not the status.
    if (typeof stopHeartbeatRef === "function") stopHeartbeatRef();
    if (res.headersSent) return res.end(JSON.stringify({ ok: false, error: outward(err) }));
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
    console.log("[ai-cost] revise $" + out.cost_usd);
    const gap_count = rows.filter(function (r) { return (Number(r.quantity) || 0) <= 0; }).length;
    const count = rows.length - gap_count;
    const low_confidence = rows.filter(function (r) { return Number(r.confidence) <= LOW_CONF; }).length;

    return res.json({
      ok: true,
      count: count,
      gap_count: gap_count,
      low_confidence: low_confidence,
      rows: rows,
      // Only when the model actually returned them. Sending `fittings: undefined` drops the key
      // from the JSON, which is what tells the page to keep the ones it has.
      fittings: out.fittings,
      notes: out.notes,
      synopsis: out.synopsis,
      // The model hit the output ceiling and the tail was lost. Carried through so the page can
      // say so: a missing synopsis quietly routes the estimator away from the review page, and
      // without this that reads as a deliberate choice rather than a cut-off response.
      truncated: !!out.truncated,
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

    console.log("[ai-cost] chat $" + out.cost_usd);
    if (out.edited) {
      const rows = out.rows;
      return res.json({
        ok: true, edited: true, reply: out.reply, notes: out.notes,
        rows: rows, fittings: out.fittings, synopsis: out.synopsis, cost_usd: out.cost_usd,
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
    console.log("[ai-cost] preview read $" + out.cost_usd + " (" + (out.batches || 1) + " request(s))");
    return res.json({ ok: true, sheets: out.sheets, documents: out.documents, pages: out.pages,
                      audit: out.audit, cost_usd: out.cost_usd, model: out.modelId });
  } catch (err) {
    console.error("takeoff index error", err);
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}

// POST /api/takeoff/addenda — compare each sheet an addendum replaced with its original, and read
// any addendum notice. Body: { project_id, pairs:[{sheet, issue, old:{name,file_id}, new:{name,file_id}}],
// notices:[{name,file_id}], bom?: string, model? }. Files come from the project's store — the
// originals were set aside at intake, so the browser no longer holds them. Not metered (like ask).
async function addendaHandler(req, res) {
  try {
    const body = req.body || {};
    const pid = String(body.project_id || "");
    if (!/^\d+$/.test(pid)) return res.status(400).json({ ok: false, error: "project_id required" });
    const fstore = require("../filestore");
    const read = function (f) {
      if (!f || !f.file_id) return null;
      const r = fstore.readFile("project", pid, f.file_id);
      return r && r.buf ? r.buf.toString("base64") : null;
    };
    const pairs = [], missing = [];
    (Array.isArray(body.pairs) ? body.pairs : []).forEach(function (p) {
      const o = read(p && p.old), n = read(p && p.new);
      if (o && n) pairs.push({ sheet: p.sheet, issue: p.issue, old: { name: p.old.name, b64: o }, new: { name: p.new.name, b64: n } });
      else missing.push(p && p.sheet);
    });
    const notices = [];
    for (const f of (Array.isArray(body.notices) ? body.notices : [])) {
      const b = read(f);
      if (!b) { missing.push(f && f.name); continue; }
      const t = await extractText(b).catch(function () { return null; });
      if (t && t.text) notices.push({ name: f.name, text: t.text });
    }
    if (!pairs.length && !notices.length) {
      return res.json({ ok: false, error: "None of the addendum files are in the project's file store" +
        (missing.length ? " (" + missing.filter(Boolean).join(", ") + ")" : "") + " — reopen the take-off screen once so they're saved, then try again." });
    }
    const out = await require("./engine").compareAddenda({ pairs: pairs, notices: notices,
      bom: body.bom ? String(body.bom).slice(0, 20000) : "", modelKey: body.model || "sonnet" });
    console.log("[ai-cost] addenda $" + out.cost_usd + " (" + pairs.length + " pairs, " + notices.length + " notices, " + out.requests + " request(s))");
    return res.json({ ok: true, sheets: out.sheets, notices: out.notices, overall: out.overall,
                      cost_usd: out.cost_usd, missing: missing.filter(Boolean), at: new Date().toISOString() });
  } catch (err) {
    console.error("takeoff addenda error", err);
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}

// POST /api/takeoff/inspect — is this file a DRAWING (looked at) or a DOCUMENT (read as text)?
// Body: { name, data (base64 PDF), want_text? }. Called once per file as it lands on the intake
// screen, with no model call and no size limit, so every file is tagged the moment it's added —
// the same check the quote intake makes. A document comes back with its text, so the page sends
// a few hundred KB of spec instead of 18 MB of PDF from then on.
async function inspectHandler(req, res) {
  try {
    const body = Object.assign({}, req.body || {});
    // A file already in the project's store (everything that came with the RFQ) is read from
    // there, so the browser doesn't upload 18 MB just to be told it's a spec.
    if (!body.data && body.project_id && body.file_id) {
      try {
        const f = require("../filestore").readFile("project", body.project_id, body.file_id);
        if (f && f.buf) body.data = f.buf.toString("base64");
      } catch (e) { /* fall through to the 400 */ }
    }
    if (!body.data) return res.status(400).json({ ok: false, error: "data (or project_id + file_id) required" });
    const r = await inspect(body.name, body.data);
    const out = { ok: true, name: body.name || "file", kind: r.kind, why: r.why, pages: r.pages,
                  chars: r.chars || 0, sheet_inches: r.sheetInches || 0, large_format: !!r.largeFormat };
    if (r.kind === "text" || body.want_text) {
      try {
        const t = await extractText(body.data);
        if (t.text && t.text.length >= 40) { out.text = t.text; out.pages = t.pages || out.pages; }
        else if (r.kind === "text") { out.kind = "drawing"; out.why = "no text in it (a scan?) — read as a drawing"; }
      } catch (e) {
        if (r.kind === "text") { out.kind = "drawing"; out.why = "the text would not come out — read as a drawing"; }
      }
    }
    return res.json(out);
  } catch (err) {
    // Never block a file on a failed check — a drawing is the path that always works.
    return res.json({ ok: true, name: (req.body && req.body.name) || "file", kind: "drawing", pages: 0,
                      why: "could not check it — read as a drawing" });
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
    console.log("[ai-cost] ask $" + out.cost_usd);
    return res.json({ ok: true, reply: out.reply, cost_usd: out.cost_usd, model: out.modelId });
  } catch (err) {
    console.error("takeoff ask error", err);
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}


// GET /api/takeoff/pricing — what a run WOULD cost, per reading depth, before spending anything.
//
// The page quotes from this rather than carrying its own copy of the rates. That matters: the
// MODELS table had Opus at three times its real price and every Deep run was reported at 3x,
// because nothing ever compared the two.
//
// The estimate is deliberately simple and errs high:
//   input  = pages x TOKENS_PER_PAGE + PROMPT_OVERHEAD
//   output = OUTPUT_EST (what a full package with a synopsis typically runs to)
// PDFs reach the model as page IMAGES, which is where the money goes - measured at ~2,000
// tokens a page on a real 149-page bill of material (~298,000 tokens for the one file).
const TOKENS_PER_PAGE = 2000;   // a rendered PDF page, measured not guessed
const PROMPT_OVERHEAD = 25000;  // system + knowledge + catalogs + project context
const OUTPUT_EST      = 12000;  // a full package with a synopsis

function pricingHandler(req, res) {
  try {
    const pages = Math.max(0, parseInt(req.query.pages, 10) || 0);
    const inTok = pages * TOKENS_PER_PAGE + PROMPT_OVERHEAD;
    const tiers = [
      { key: "haiku",  label: "Quick",    blurb: "cheapest, try first" },
      { key: "sonnet", label: "Standard", blurb: "balanced (recommended)" },
      { key: "opus",   label: "Deep",     blurb: "most accurate" },
    ].map(function (t) {
      const m = MODELS[t.key];
      const cost = (inTok * m.in + OUTPUT_EST * m.out) / 1000000;
      return { key: t.key, label: t.label, blurb: t.blurb, model: m.id,
               in_rate: m.in, out_rate: m.out,
               est_cost_usd: Number(cost.toFixed(4)) };
    });
    return res.json({ ok: true, pages: pages, est_input_tokens: inTok, est_output_tokens: OUTPUT_EST,
                      tokens_per_page: TOKENS_PER_PAGE, tiers: tiers });
  } catch (err) {
    return res.status(500).json({ ok: false, error: outward(err) });
  }
}

module.exports = { takeoffHandler, reviseHandler, chatHandler, indexHandler, askHandler, pricingHandler, inspectHandler, addendaHandler, mergeSynopsis, runBatches };
