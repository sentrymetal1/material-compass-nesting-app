// =============================================================================
//  takeoff/docprep.js — get ANY size of package in front of the model.
// -----------------------------------------------------------------------------
//  One request to the model carries at most ~32 MB and ~100 PDF pages. A real
//  bid package blows through that without trying: Dunkirk CSD Phase 1.3 arrived
//  as 37 structural sheets, the same sheets again in Addendum 6, and Divisions
//  05 and 09 of the spec — 60.5 MB. The take-off refused it ("trim before
//  running") and the preview read silently didn't run at all.
//
//  Two things fix that, in this order:
//
//   1. READ DOCUMENTS AS TEXT. A spec or a parts list only has to be read, not
//      looked at. pdfkind (the same check the quote intake uses) tells the two
//      apart by sheet size; a document goes as extracted text — a few hundred KB
//      instead of 18 MB, and no page limit. Only DRAWINGS travel as PDFs.
//
//   2. BATCH THE DRAWINGS. Whatever is still too big for one request is packed
//      into as many requests as it takes, file order kept, and a single PDF that
//      is too big on its own is split by pages. The caller runs each batch and
//      puts the results back together.
//
//  A text document still has to fit the model's context, so a long spec is cut
//  to the sections a steel estimator reads (Division 05, painting and coatings,
//  fireproofing) — and the model and the user are both told what was left out.
// =============================================================================

const pdfkind = require("../pdfkind");

// Per request. The API's ceiling is 32 MB of request body; the system prompt, catalogs and the
// text documents ride in the same body, so the drawings get a little under it.
const MAX_BATCH_B64 = 26 * 1024 * 1024;
// The API reads at most 100 PDF pages in one request.
const MAX_BATCH_PAGES = 90;
// Context budget, in tokens. A drawing page costs ~2,000; text ~1 token per 4 chars. Kept well
// under 200k so the catalog, the knowledge base and the answer itself still fit.
const CONTEXT_BUDGET = 150000;
const TOKENS_PER_PAGE = 2000;
// All text documents together, per request, ~37k tokens. Low enough that a whole finishes book
// (Division 09 on Dunkirk: tiling, carpet, ceilings — 204k chars) is cut to its painting sections
// rather than riding along in every part; high enough that Division 05 itself always goes whole.
const TEXT_BUDGET_CHARS = 150000;

function uniqNums(a) {
  const seen = {};
  return a.filter(function (n) { const k = n.replace(/\s/g, ""); if (seen[k]) return false; seen[k] = 1; return true; });
}

function b64Bytes(b64) { return Math.floor(String(b64 || "").length * 3 / 4); }

// Spec sections a steel take-off actually reads. Everything else in a spec book — doors, ceilings,
// flooring, plumbing — is dropped first when the book is too long to send whole.
function sectionMatters(num, head) {
  const n = String(num || "").replace(/\s+/g, "");
  if (/^05/.test(n)) return true;                       // metals
  if (/^0990|^0991|^0996|^0997/.test(n)) return true;   // painting, high-performance coatings
  if (/^0781/.test(n)) return true;                     // applied fireproofing (goes on steel)
  if (/^0130|^0133|^0140|^0145/.test(n)) return true;   // submittals, quality, testing/inspection
  return /galvaniz|structural steel|steel joist|steel deck|metal fabrication|shop prim/i.test(String(head || ""));
}

// "SECTION 05 12 00 - STRUCTURAL STEEL FRAMING" → sections with their number. Returns null when
// the text has no section structure (a parts list, a letter), which is left whole.
function splitSections(text) {
  // Uppercase and followed by a dash: that is a section's own header. "Section 051213 'Architecturally
  // Exposed…'" in a Related Sections list is a cross-reference and must not start a section.
  const re = /(^|\n)[ \t]*SECTION\s+(\d{2}\s?\d{2}\s?\d{2}(?:\.\d+)?)\s*[-–—][^\n]*/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ at: m.index + m[1].length, num: m[2], head: m[0].trim().slice(0, 160) });
  // A section header repeats on every page ("SECTION 05 12 00 ... PAGE 3 OF 9"); keep only where
  // the number CHANGES, so a section is one block rather than one per page.
  const starts = marks.filter(function (x, i) { return i === 0 || marks[i - 1].num.replace(/\s/g, "") !== x.num.replace(/\s/g, ""); });
  if (starts.length < 2) return null;
  const out = [];
  if (starts[0].at > 0) out.push({ num: "", head: "(front matter)", text: text.slice(0, starts[0].at) });
  starts.forEach(function (s, i) {
    out.push({ num: s.num, head: s.head, text: text.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : text.length) });
  });
  return out;
}

// One input as the caller sent it → { name, kind: drawing|text|image, ... }.
// Accepts: a base64 string (PDF); { data, media_type, name?, read_as? }; or an already-read
// document { kind:"text", text, name, pages }.
async function prepareOne(raw, name) {
  if (raw && typeof raw === "object" && raw.kind === "text" && typeof raw.text === "string") {
    return { name: raw.name || name || "document", kind: "text", text: raw.text, chars: raw.text.length,
             pages: Number(raw.pages) || 0, why: raw.why || "read as text" };
  }
  const data = typeof raw === "string" ? raw : (raw && raw.data) || "";
  const mt = String((raw && typeof raw === "object" && raw.media_type) || "application/pdf");
  const nm = (raw && typeof raw === "object" && raw.name) || name || "document";
  if (mt.indexOf("image/") === 0) {
    return { name: nm, kind: "image", b64: data, media_type: mt, pages: 1, bytes: b64Bytes(data) };
  }
  const forced = String((raw && typeof raw === "object" && raw.read_as) || "").toLowerCase();
  let kind = forced === "text" ? "text" : forced === "drawing" ? "drawing" : "";
  let why = forced ? "set by the estimator" : "";
  let pages = 0;
  if (!kind) {
    try { const r = await pdfkind.inspect(nm, data); kind = r.kind; why = r.why; pages = r.pages; }
    catch (e) { kind = "drawing"; why = "could not check it — read as a drawing"; }
  }
  if (kind === "text") {
    try {
      const t = await pdfkind.extractText(data);
      if (t.text && t.text.length >= 40) {
        return { name: nm, kind: "text", text: t.text, chars: t.text.length, pages: t.pages || pages,
                 why: why, b64: data };   // b64 kept: the parts-list reader and page counts still use it
      }
      why = "marked a document but has no text in it (a scan?) — read as a drawing";
    } catch (e) { why = "marked a document but the text would not come out — read as a drawing"; }
  }
  return { name: nm, kind: "drawing", b64: data, media_type: "application/pdf", pages: pages, bytes: b64Bytes(data), why: why };
}

async function prepareDocs(raws, names) {
  const list = Array.isArray(raws) ? raws : [];
  const nm = Array.isArray(names) ? names : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const it = await prepareOne(list[i], nm[i]);
    it.index = i;
    if (it.kind === "drawing" && !it.pages) it.pages = await countPages(it.b64);
    out.push(it);
  }
  return out;
}

async function countPages(b64) {
  try {
    const { PDFDocument } = require("pdf-lib");
    const d = await PDFDocument.load(Buffer.from(String(b64), "base64"),
      { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    return d.getPageCount() || 0;
  } catch (e) { return 0; }
}

// Shrink the text documents to fit one request. A spec book is cut to the sections that matter
// to steel; anything still over is trimmed proportionally. Every cut is recorded on the item
// (`trimmed`) so the model can be told, and the page can say so.
function fitText(items, budget) {
  budget = budget || TEXT_BUDGET_CHARS;
  const texts = items.filter(function (it) { return it.kind === "text"; });
  // The whole text stays available to deterministic readers (the parts-list parser); only what
  // goes to the model is cut.
  texts.forEach(function (it) { if (it.fullText == null) it.fullText = it.text; });
  const total = function () { return texts.reduce(function (s, it) { return s + it.text.length; }, 0); };
  if (total() <= budget) return;
  texts.forEach(function (it) {
    const secs = splitSections(it.text);
    if (!secs) return;
    const keep = secs.filter(function (s) { return !s.num || sectionMatters(s.num, s.head); });
    const dropped = secs.filter(function (s) { return keep.indexOf(s) < 0; });
    if (!dropped.length) return;
    const before = it.text.length;
    it.text = keep.map(function (s) { return s.text; }).join("\n");
    it.trimmed = {
      kind: "sections", before: before, after: it.text.length,
      kept: uniqNums(keep.filter(function (s) { return s.num; }).map(function (s) { return s.num; })),
      dropped: uniqNums(dropped.map(function (s) { return s.num; })),
    };
  });
  if (total() <= budget) return;
  const scale = budget / total();
  texts.forEach(function (it) {
    const cap = Math.max(4000, Math.floor(it.text.length * scale));
    if (it.text.length <= cap) return;
    const before = (it.trimmed && it.trimmed.before) || it.text.length;
    it.text = it.text.slice(0, cap);
    it.trimmed = Object.assign({}, it.trimmed || {}, { kind: (it.trimmed ? "sections+cut" : "cut"), before: before, after: cap });
  });
}

// Split one PDF into page ranges, each a standalone PDF that fits a batch.
async function splitPdf(b64, maxPages, maxBytes) {
  const { PDFDocument } = require("pdf-lib");
  const src = await PDFDocument.load(Buffer.from(String(b64), "base64"),
    { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const n = src.getPageCount();
  const perPageBytes = b64Bytes(b64) / Math.max(1, n);
  const step = Math.max(1, Math.min(maxPages, Math.floor(maxBytes / Math.max(1, perPageBytes * 4 / 3))));
  const parts = [];
  for (let start = 0; start < n; start += step) {
    const end = Math.min(n, start + step);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: end - start }, function (_, k) { return start + k; }));
    pages.forEach(function (p) { out.addPage(p); });
    const bytes = await out.save();
    parts.push({ b64: Buffer.from(bytes).toString("base64"), pageOffset: start, pages: end - start });
  }
  return parts;
}

// Pack the drawings (and images) into batches. Each part is { item, b64, media_type, pages,
// pageOffset }. File order is kept, so neighbouring sheets of one area tend to share a batch.
async function planBatches(items, opts) {
  opts = opts || {};
  const textChars = items.filter(function (it) { return it.kind === "text"; })
    .reduce(function (s, it) { return s + it.text.length; }, 0);
  const textB64 = Math.ceil(textChars * 1.1);
  const maxB64 = Math.max(4 * 1024 * 1024, (opts.maxB64 || MAX_BATCH_B64) - textB64);
  const tokenRoom = CONTEXT_BUDGET - Math.ceil(textChars / 4) - 30000;
  const maxPages = Math.max(8, Math.min(opts.maxPages || MAX_BATCH_PAGES, Math.floor(tokenRoom / TOKENS_PER_PAGE)));

  const parts = [];
  for (const it of items) {
    if (it.kind === "text") continue;
    const len = String(it.b64 || "").length;
    if (it.kind === "drawing" && (len > maxB64 || (it.pages || 0) > maxPages)) {
      try {
        const pieces = await splitPdf(it.b64, maxPages, maxB64);
        pieces.forEach(function (p) {
          parts.push({ item: it, b64: p.b64, media_type: "application/pdf", pages: p.pages, pageOffset: p.pageOffset });
        });
        continue;
      } catch (e) { /* unsplittable — send whole and let the API say so */ }
    }
    parts.push({ item: it, b64: it.b64, media_type: it.media_type || "application/pdf", pages: it.pages || 1, pageOffset: 0 });
  }

  const batches = [];
  let cur = null;
  parts.forEach(function (p) {
    const len = p.b64.length;
    if (!cur || (cur.parts.length && (cur.b64 + len > maxB64 || cur.pages + p.pages > maxPages))) {
      cur = { parts: [], b64: 0, pages: 0 };
      batches.push(cur);
    }
    cur.parts.push(p); cur.b64 += len; cur.pages += p.pages;
  });
  return { batches: batches, maxB64: maxB64, maxPages: maxPages };
}

// Content blocks for the model.
function partBlock(p) {
  if (String(p.media_type).indexOf("image/") === 0) {
    return { type: "image", source: { type: "base64", media_type: p.media_type, data: p.b64 } };
  }
  return { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.b64 } };
}
function partLabel(p) {
  const it = p.item;
  const whole = !p.pageOffset && p.pages === it.pages;
  return '"' + it.name + '"' + (whole ? "" : " (pages " + (p.pageOffset + 1) + "-" + (p.pageOffset + p.pages) + " of " + it.pages + ")");
}
function textBlock(it) {
  let head = 'ATTACHED DOCUMENT — "' + it.name + '" (' + (it.pages ? it.pages + " pages, " : "") +
    "read as text; it is a document, not a drawing)";
  if (it.trimmed) {
    head += "\nNOTE: this document was too long to send whole. " +
      (it.trimmed.kept && it.trimmed.kept.length
        ? "Only the sections relevant to steel were kept (" + it.trimmed.kept.join(", ") + ")" +
          (it.trimmed.dropped && it.trimmed.dropped.length ? "; left out: " + it.trimmed.dropped.length + " other sections" : "") + ". "
        : "") +
      (/cut/.test(it.trimmed.kind) ? "The text was also cut short at the end. " : "") +
      "If something you need is not here, say so rather than assume.";
  }
  return { type: "text", text: head + "\n\n" + it.text };
}

// What the page shows: each file, how it will be read, and what was trimmed.
function summary(items, plan) {
  return {
    files: items.map(function (it) {
      return { name: it.name, kind: it.kind, pages: it.pages || 0, why: it.why || "",
               chars: it.kind === "text" ? it.text.length : undefined, trimmed: it.trimmed || null };
    }),
    batches: plan ? plan.batches.length : 1,
  };
}

module.exports = {
  prepareDocs, prepareOne, fitText, planBatches, splitPdf, partBlock, partLabel, textBlock, summary,
  splitSections, sectionMatters, b64Bytes,
  MAX_BATCH_B64, MAX_BATCH_PAGES, TEXT_BUDGET_CHARS,
};
