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
// v2 (2026-11-24): single digits are kept. Parts-list ITEM numbers 1-9 and balloons are one
// character, and v1 dropped every one-character word, so mark "1" could only ever land on a
// 1" or (1 inside other text. Sheets read under v1 are treated as unread and read again.
const IDX_V = 2;
const MIN_CONF_ONE = 60;   // a lone digit needs a surer read: hatching and leader lines can look like a 1
const isFresh = function (e) { return !!(e && !e.err && e.v >= IDX_V); };

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

const r4 = function (n) { return Math.round(n * 10000) / 10000; };

// The parts list's ITEM NO. column, read a second time on its own. Inside the table grid the
// whole-sheet read misses most item numbers (MCP-10116 DW-001: of items 1-25 it found 12, 14, 16,
// 18, 20-25 only), and those numbers are what a take-off line's mark is. So: find each "ITEM"
// header, cut out the column under it down to where the list ends, and read just that strip as
// digits. Numbers already found are not added twice. Words are [text, x, y, w, h, conf] fractions.
async function readItemColumns(worker, canvas, out, createCanvas) {
  const W = canvas.width, H = canvas.height;
  const heads = out.filter(function (w) { return /^item$/i.test(String(w[0]).replace(/[^a-z]/gi, "")); });
  for (const hd of heads.slice(0, 4)) {
    const hw = hd[3], hh = hd[4];
    const x0 = hd[1] - hw * 0.15, x1 = hd[1] + hw * 1.9;          // ITEM … NO. — not the borders
    const inCol = function (w) { const cx = w[1] + w[3] / 2; return cx > x0 && cx < x1 && w[2] > hd[2] + hh; };
    // Where the list ends: follow the numbers already found below the header while the rows keep
    // coming; a big gap (the NOTES' "10." further down the sheet) is past the end.
    const ys = out.filter(function (w) { return inCol(w) && /^\d+$/.test(w[0]); }).map(function (w) { return w[2]; }).sort(function (a, b) { return a - b; });
    let end = hd[2] + hh, pitch = hh * 2.6;
    for (const y of ys) { if (y - end > Math.max(pitch * 6, hh * 12) && end > hd[2] + hh) break; end = y; }
    if (end <= hd[2] + hh) end = Math.min(1, hd[2] + 0.35);                // nothing found: a generous strip
    const y0 = hd[2] + hh * 1.3, y1 = Math.min(1, end + hh * 3);
    const sx = Math.max(0, Math.floor(x0 * W)), sy = Math.max(0, Math.floor(y0 * H));
    const cw = Math.min(W - sx, Math.ceil((x1 - x0) * W)), ch = Math.min(H - sy, Math.ceil((y1 - y0) * H));
    if (cw < 10 || ch < 10) continue;
    // Two reads of the strip (as drawn, and enlarged 2x with a margin): each misses a different
    // few digits boxed in by the grid (tested 11-24), so their union is kept.
    const dup = function (t, x, y) { return out.some(function (o) { return o[0] === t && Math.abs(o[1] - x) < hw && Math.abs(o[2] - y) < hh; }); };
    for (const Z of [1, 2]) {
      const P = 40;
      const c2 = createCanvas(cw * Z + 2 * P, ch * Z + 2 * P), x2 = c2.getContext("2d");
      x2.fillStyle = "#fff"; x2.fillRect(0, 0, c2.width, c2.height);
      x2.drawImage(canvas, sx, sy, cw, ch, P, P, cw * Z, ch * Z);
      await worker.setParameters({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: "0123456789" });
      let r;
      try { r = await worker.recognize(c2.toBuffer("image/png"), {}, { blocks: true }); }
      finally { await worker.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "" }); }
      (r.data.blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) { (l.words || []).forEach(function (x) {
        const t = String(x.text || "").trim();
        if (!/^\d{1,3}$/.test(t) || x.confidence < 70) return;
        const bx = (x.bbox.x0 - P) / Z, by = (x.bbox.y0 - P) / Z, bw = (x.bbox.x1 - x.bbox.x0) / Z, bh = (x.bbox.y1 - x.bbox.y0) / Z;
        const nh = bh / H;
        if (nh < hh * 0.6 || nh > hh * 1.7) return;                         // a grid line, not a number
        const nw = [t, r4((sx + bx) / W), r4((sy + by) / H), r4(bw / W), r4(nh), Math.round(x.confidence)];
        if (!dup(t, nw[1], nw[2])) out.push(nw);
      }); }); }); });
    }
    fillItemRows(out, inCol, hw, hh);
  }
}

// Parts-list rows are evenly spaced. With the item numbers that WERE read as anchors, fit
// row = a + b × item (median slopes, so one misread can't skew it), and put any item number
// that wasn't read where its row is. Only when the anchors agree with the fit; placed numbers
// carry confidence 0 so they can be told apart from read ones.
function fillItemRows(out, inCol, hw, hh) {
  const pts = out.filter(function (w) { return inCol(w) && /^\d{1,3}$/.test(w[0]); })
    .map(function (w) { return { n: +w[0], y: w[2] + w[4] / 2, w: w }; });
  const byN = {}; pts.forEach(function (p) { (byN[p.n] = byN[p.n] || []).push(p); });
  const one = Object.keys(byN).filter(function (n) { return byN[n].length === 1; }).map(function (n) { return byN[n][0]; });
  if (one.length < 4) return;
  const med = function (a) { const s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; };
  const slopes = [];
  for (let i = 0; i < one.length; i++) for (let j = i + 1; j < one.length; j++) if (one[i].n !== one[j].n) slopes.push((one[j].y - one[i].y) / (one[j].n - one[i].n));
  const b = med(slopes); if (!(b > hh * 1.2)) return;                         // rows go down the sheet
  const a = med(one.map(function (p) { return p.y - b * p.n; }));
  const good = one.filter(function (p) { return Math.abs(p.y - (a + b * p.n)) < b * 0.3; });
  if (good.length < 4 || good.length < one.length * 0.75) return;            // not an even list: leave it
  const nMax = Math.max.apply(null, good.map(function (p) { return p.n; }));
  const xs = med(good.map(function (p) { return p.w[1] + p.w[3] / 2; })), h = med(good.map(function (p) { return p.w[4]; }));
  const cw1 = med(good.map(function (p) { return p.w[3] / p.w[0].length; }));
  for (let n = 1; n <= nMax; n++) {
    const yc = a + b * n;
    if (pts.some(function (p) { return p.n === n && Math.abs(p.y - yc) < b * 0.5; })) continue;
    const t = String(n), ww = cw1 * t.length;
    out.push([t, r4(xs - ww / 2), r4(yc - h / 2), r4(ww), r4(h), 0]);
  }
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
      if (x.confidence < MIN_CONF) return;
      if (t.length < 2 && !(/^\d$/.test(t) && x.confidence >= MIN_CONF_ONE)) return;
      const bb = x.bbox;
      out.push([t, r4(bb.x0 / W), r4(bb.y0 / H), r4((bb.x1 - bb.x0) / W), r4((bb.y1 - bb.y0) / H), Math.round(x.confidence)]);
    }); }); }); });
    try { await readItemColumns(w, canvas, out, createCanvas); }
    catch (e) { console.error("[marks] item column pass failed:", String((e && e.message) || e).slice(0, 200)); }
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
      if (isFresh(idx.pages[job.key])) { s.done++; continue; }
      let entry;
      const t0 = Date.now();
      // Logged at the START too: if the server dies mid-read, the log shows which sheet it was on
      // (11-23: MCP-10116 restarted with no [marks] line, so nobody could tell).
      console.log("[marks] " + job.pid + " " + job.key + ": reading, memory " + Math.round(process.memoryUsage().rss / 1048576) + " MB");
      // Stamped when the read FINISHES: the page asks for "newer than my last look", and a sheet
      // stamped at its start would be older than a look taken while it was being read.
      try { const words = await readPage(job.pid, job.file_id, job.page); entry = { at: new Date().toISOString(), v: IDX_V, words: words }; }
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
    // A sheet read under an older version is left out, so the page asks for it to be read again.
    const pages = {};
    Object.keys(idx.pages).forEach(function (k) { const e = idx.pages[k];
      if ((isFresh(e) || (e && e.err)) && (!since || e.at > since)) pages[k] = e; });
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
      if (isFresh(idx.pages[key])) return;                                     // already read
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
