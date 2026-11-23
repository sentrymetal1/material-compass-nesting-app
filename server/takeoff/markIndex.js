// markIndex.js — where every word sits on each drawing, read off the sheet by OCR.
//
// The drawing workspace (drawings.html) draws a box around a part mark when its line is clicked.
// Most drawings carry no text a PDF reader can find: AutoCAD plots letters as strokes, and scans
// are pictures. So each sheet is drawn to an image and read with OCR (tesseract), once, in the
// background, and the words and their places are kept beside the PDFs. No AI and no AI cost.
// Tested on MCP-10109 drawing 10058: 42 part marks found with their places, ~9 s a sheet.
//
//   GET  /api/takeoff/marks/:project_id[?since=ISO]  → { ok, status, pages }
//   POST /api/takeoff/marks/:project_id/build        → { ok, status }
//        body { targets:[{file_id,page}], first?: "file_id:page" }
//
// pages: { "<file_id>:<page>": { at, words:[[text, x, y, w, h, conf]] } } with x/y/w/h as
// fractions of the page (top-left origin, as pdf.js shows it), or { at, err } when a page
// could not be read. A replaced drawing arrives as a new file id, so it is read again.
// One sheet at a time across all projects: OCR is CPU-heavy and the server is shared.

const path = require("path");
const filestore = require("../filestore");

const okPid = function (pid) { return /^\d+$/.test(String(pid || "")); };
const idxName = function (pid) { return "marks-" + pid + ".json"; };
const MAX_SIDE = 7200;       // px; scale 3 on a 1:1 sheet — read better than scale 4 in testing
const MIN_CONF = 40;

const queue = [];            // [{ pid, key, file_id, page }]
const status = {};           // pid → { total, done, failed }
let running = false, worker = null, idleTimer = null, pdfjs = null;
// Where the PDFs come from. The project file store, unless a test hands in its own.
let io = {
  read: async function (pid, fileId) { const f = filestore.readFile("project", pid, fileId); return f && f.buf ? f.buf : null; },
  ids: function (pid) { return filestore.listFiles("project", pid).map(function (f) { return String(f.id); }); },
};

function readIdx(pid) { return filestore.readJson(idxName(pid), null) || { v: 1, pages: {} }; }
function statusOf(pid) {
  const s = status[pid] || { total: 0, done: 0, failed: 0 };
  return { running: queue.some(function (q) { return q.pid === pid; }) || (running && s.active === true),
           total: s.total, done: s.done, failed: s.failed, queued: queue.filter(function (q) { return q.pid === pid; }).length };
}

async function getWorker() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (worker) return worker;
  const Tesseract = require("tesseract.js");
  const cachePath = path.join(filestore.storeRoot(), "tessdata");
  worker = await Tesseract.createWorker("eng", 1, { cachePath: cachePath });
  await worker.setParameters({ tessedit_pageseg_mode: "11" });   // sparse text: labels scattered over a drawing
  return worker;
}
function releaseWorkerSoon() {
  idleTimer = setTimeout(function () { const w = worker; worker = null; if (w) w.terminate().catch(function () {}); }, 60000);
}

async function readPage(pid, fileId, pageNo) {
  if (!pdfjs) pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = require("@napi-rs/canvas");
  const buf = await io.read(pid, fileId);
  if (!buf) throw new Error("file not found");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MAX_SIDE / Math.max(v1.width, v1.height));
    const vp = page.getViewport({ scale: scale });
    const canvas = createCanvas(Math.floor(vp.width), Math.floor(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: canvas }).promise;
    const png = canvas.toBuffer("image/png");
    const w = await getWorker();
    const r = await w.recognize(png, {}, { blocks: true });
    const W = canvas.width, H = canvas.height, out = [];
    (r.data.blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) { (l.words || []).forEach(function (x) {
      const t = String(x.text || "").trim();
      if (t.length < 2 || x.confidence < MIN_CONF) return;
      const bb = x.bbox, r4 = function (n) { return Math.round(n * 10000) / 10000; };
      out.push([t, r4(bb.x0 / W), r4(bb.y0 / H), r4((bb.x1 - bb.x0) / W), r4((bb.y1 - bb.y0) / H), Math.round(x.confidence)]);
    }); }); }); });
    return out;
  } finally { try { await doc.destroy(); } catch (e) {} }
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const s = status[job.pid] = status[job.pid] || { total: 0, done: 0, failed: 0 };
      s.active = true;
      const idx = readIdx(job.pid);
      if (idx.pages[job.key] && !idx.pages[job.key].err) { s.done++; continue; }
      let entry;
      const t0 = Date.now();
      // Logged at the START too: if the server dies mid-read, the log shows which sheet it was on
      // (11-23: MCP-10116 restarted with no [marks] line, so nobody could tell).
      console.log("[marks] " + job.pid + " " + job.key + ": reading, memory " + Math.round(process.memoryUsage().rss / 1048576) + " MB");
      // Stamped when the read FINISHES: the page asks for "newer than my last look", and a sheet
      // stamped at its start would be older than a look taken while it was being read.
      try { const words = await readPage(job.pid, job.file_id, job.page); entry = { at: new Date().toISOString(), words: words }; }
      catch (e) { entry = { at: new Date().toISOString(), err: String((e && e.message) || e).slice(0, 200) }; s.failed++; console.error("[marks] " + job.key + " failed:", entry.err); }
      const fresh = readIdx(job.pid);          // re-read: another request may have added pages meanwhile
      fresh.pages[job.key] = entry;
      filestore.writeJson(idxName(job.pid), fresh);
      s.done++;
      console.log("[marks] " + job.pid + " " + job.key + ": " + (entry.words ? entry.words.length + " words" : "failed") + " in " + Math.round((Date.now() - t0) / 1000) + "s, memory " + Math.round(process.memoryUsage().rss / 1048576) + " MB");
      if (!queue.some(function (q) { return q.pid === job.pid; })) s.active = false;
    }
  } finally { running = false; releaseWorkerSoon(); }
}

function registerMarkIndex(app, opts) {
  if (opts && opts.io) io = Object.assign({}, io, opts.io);
  app.get("/api/takeoff/marks/:project_id", function (req, res) {
    const pid = String(req.params.project_id || "");
    if (!okPid(pid)) return res.status(400).json({ ok: false, error: "project_id required" });
    const idx = readIdx(pid), since = String(req.query.since || "");
    let pages = idx.pages;
    if (since) { pages = {}; Object.keys(idx.pages).forEach(function (k) { if (idx.pages[k].at > since) pages[k] = idx.pages[k]; }); }
    return res.json({ ok: true, status: statusOf(pid), pages: pages, now: new Date().toISOString() });
  });

  app.post("/api/takeoff/marks/:project_id/build", function (req, res) {
    const pid = String(req.params.project_id || "");
    if (!okPid(pid)) return res.status(400).json({ ok: false, error: "project_id required" });
    const body = req.body || {};
    const known = {}; io.ids(pid).forEach(function (id) { known[id] = true; });
    const idx = readIdx(pid);
    const s = status[pid] = status[pid] || { total: 0, done: 0, failed: 0 };
    let added = 0;
    (Array.isArray(body.targets) ? body.targets : []).slice(0, 2000).forEach(function (t) {
      const fid = String((t && t.file_id) || ""), pg = Math.max(1, parseInt(t && t.page, 10) || 1);
      if (!known[fid]) return;
      const key = fid + ":" + pg;
      if (idx.pages[key] && !idx.pages[key].err) return;                       // already read
      if (queue.some(function (q) { return q.pid === pid && q.key === key; })) return;
      queue.push({ pid: pid, key: key, file_id: fid, page: pg }); added++;
    });
    if (added) s.total += added;
    // The sheet on screen goes to the front, so it is read next.
    const first = String(body.first || "");
    const at = queue.findIndex(function (q) { return q.pid === pid && q.key === first; });
    if (at > 0) queue.unshift(queue.splice(at, 1)[0]);
    pump().catch(function (e) { console.error("[marks] pump error", e); });
    return res.json({ ok: true, added: added, status: statusOf(pid) });
  });
}

module.exports = { registerMarkIndex, readPage };
