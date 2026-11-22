// sheetMap.js — which file and page each drawing number is on, per project.
//
// The drawing workspace (drawings.html) opens a take-off line's drawing. A line only knows its
// drawing NUMBER ("10058"); the project's PDFs only know their file names and page counts. The
// intake sheet-index pass reads the title-block number off every page, but its answer was never
// kept. This keeps it: the first time a project's drawings are opened, the estimator presses
// "Find drawing pages", the same reader runs once over the stored PDFs, and the result is saved
// beside them. Every later open is free.
//
//   GET  /api/takeoff/sheet-map/:project_id        → { ok, files, map, stale }
//   POST /api/takeoff/sheet-map/:project_id/build  → { ok, map, cost_usd }
//
// `stale` is true when the project's PDFs changed after the map was built (a drawing added or
// replaced), so the page can offer to rebuild instead of opening the wrong page.

const filestore = require("../filestore");

const isPdf = function (f) { return /pdf/i.test(f.media_type || "") || /\.pdf$/i.test(f.name || ""); };
const mapName = function (pid) { return "sheetmap-" + pid + ".json"; };
const okPid = function (pid) { return /^\d+$/.test(String(pid || "")); };

function pdfFiles(pid) {
  return filestore.listFiles("project", pid).filter(isPdf)
    .map(function (f) { return { id: String(f.id), name: f.name, size: f.size }; });
}

function isStale(map, files) {
  if (!map) return false;
  const had = (map.file_ids || []).slice().sort().join(",");
  const now = files.map(function (f) { return f.id; }).sort().join(",");
  return had !== now;
}

function registerSheetMap(app, deps) {
  const ledger = deps.ledger;

  app.get("/api/takeoff/sheet-map/:project_id", function (req, res) {
    const pid = String(req.params.project_id || "");
    if (!okPid(pid)) return res.status(400).json({ ok: false, error: "project_id required" });
    try {
      const files = pdfFiles(pid);
      const map = filestore.readJson(mapName(pid), null);
      return res.json({ ok: true, files: files, map: map, stale: isStale(map, files) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Could not read this project's drawings." });
    }
  });

  app.post("/api/takeoff/sheet-map/:project_id/build", async function (req, res) {
    const pid = String(req.params.project_id || "");
    if (!okPid(pid)) return res.status(400).json({ ok: false, error: "project_id required" });
    try {
      const files = pdfFiles(pid);
      if (!files.length) return res.json({ ok: false, error: "This project has no drawings saved yet. Open the take-off once with its drawings so they're kept." });
      const docs = [], names = [], used = [];
      files.forEach(function (f) {
        const r = filestore.readFile("project", pid, f.id);
        if (r && r.buf) { docs.push(r.buf.toString("base64")); names.push(f.name); used.push(f); }
      });
      const out = await require("./engine").readSheetIndex({ docs: docs, names: names, modelKey: "sonnet" });
      const sheets = (out.sheets || []).map(function (s) {
        const f = used[(s.doc || 1) - 1] || used[0];
        return { number: s.number, title: s.title || "", file_id: f.id, file_name: f.name,
                 page: (s.page_list && s.page_list[0]) || (s.pages && s.pages[0]) || 1, pages: s.pages || null };
      });
      const map = { built_at: new Date().toISOString(), file_ids: used.map(function (f) { return f.id; }),
                    sheets: sheets, cost_usd: out.cost_usd || 0 };
      filestore.writeJson(mapName(pid), map);
      const body = req.body || {};
      if (ledger) ledger.record("preview read", out.cost_usd, { project_id: pid, manufacturer_id: body.manufacturer_id || "",
                                                               detail: "drawing pages for the workspace, " + used.length + " file(s)" });
      return res.json({ ok: true, map: map, cost_usd: out.cost_usd || 0 });
    } catch (e) {
      console.error("sheet-map build error", e && (e.message || e));
      return res.status(500).json({ ok: false, error: "Could not read the drawing numbers. Try again in a minute." });
    }
  });
}

module.exports = { registerSheetMap, isStale };
