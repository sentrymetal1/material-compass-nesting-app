// =============================================================================
//  pdfkind.js — is this PDF something to LOOK AT, or something to READ?
// -----------------------------------------------------------------------------
//  The distinction decides the cost, and it is the whole reason a customer's
//  bill of material used to break the intake.
//
//    A DRAWING has to be seen. It goes as page images, ~2,000 tokens a page, so
//    a set of them has to live inside a page budget.
//
//    A TEXT document — a BOM, a spec, a scope letter — only has to be read.
//    Pulled out as text it costs about a fifth as much, and the WHOLE document
//    fits instead of the first N pages of it. Measured on a dense 12-page BOM:
//    4,452 tokens as text against 24,000 as images.
//
//  So the same 149-page BOM is either impossible or comfortable depending only
//  on which path it takes. Sending everything down the image path is what made
//  a BOM fail while drawings went through.
//
//  The kind is GUESSED here and shown to the user, never decided silently — the
//  guess is right most of the time and wrong occasionally, and the person
//  looking at the file always knows better than the heuristic.
// =============================================================================

// PAGE SIZE IS THE RELIABLE SIGNAL, not text density.
//
// The first version used density alone and got it wrong on real files: Mark's drawing sheets
// carried 1,745 to 4,530 characters each and were classified as documents. A CAD export is
// vector, so its title block, notes, dimensions and revision table are all real extractable
// text — a drawing can easily out-text a page of a BOM.
//
// Sheet size separates them cleanly instead. Documents are printed on letter or legal, whose
// SHORT side is 612pt (8.5"). Drawings are large format — 11x17 has a short side of 792pt, and
// it only grows from there. So: short side comfortably over 8.5 inches means a drawing,
// whatever the text says.
const LARGE_FORMAT_MIN_SIDE = 700;   // pt. Letter/legal sit at 612; 11x17 at 792.

// Only consulted when the sheet is letter-sized, where size cannot decide.
const DENSE_CHARS_PER_PAGE = 700;

const NAME_SAYS_TEXT = /\b(bom|bill[\s_-]*of[\s_-]*material|material[\s_-]*list|parts?[\s_-]*list|schedule|spec(ification)?s?|scope|letter|proposal|quote|rfq|addend|instruction)\b/i;
const NAME_SAYS_DRAWING = /\b(dwg|drawing|sht|sheet|plan|elev(ation)?|section|detail|iso|p&id|pid|layout)\b/i;

async function readPdf(b64) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: Buffer.from(b64, 'base64') });
  try {
    const r = await parser.getText();
    return { pages: Number(r.total || r.numpages || 0) || 0, text: String(r.text || '') };
  } finally {
    try { await parser.destroy(); } catch (e) {}
  }
}

// { pages, chars, perPage, kind: 'drawing'|'text', why }
// Never throws: an unreadable or image-only PDF is a drawing, which is the safe
// answer because that path already has a page budget protecting it.
// The short side of the widest page, in points. pdf-lib reads this without parsing any text,
// so it works even on a scan.
async function shortestSide(b64) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const d = await PDFDocument.load(Buffer.from(b64, 'base64'), { ignoreEncryption: true });
    let biggest = 0, shortOfBiggest = 0;
    d.getPages().forEach((p) => {
      const { width, height } = p.getSize();
      const area = width * height;
      if (area > biggest) { biggest = area; shortOfBiggest = Math.min(width, height); }
    });
    return Math.round(shortOfBiggest);
  } catch (e) { return 0; }
}

function inches(pt) { return (pt / 72).toFixed(1).replace(/\.0$/, ''); }

async function inspect(name, b64) {
  const fname = String(name || '');

  // Size first, because it is the signal that does not lie. It also survives a scan, where
  // there is no text to measure at all.
  const side = await shortestSide(b64);
  if (side >= LARGE_FORMAT_MIN_SIDE) {
    let pages = 0, chars = 0;
    try { const r = await readPdf(b64); pages = r.pages; chars = r.text.trim().length; } catch (e) {}
    return { pages, chars, perPage: pages ? Math.round(chars / pages) : 0, kind: 'drawing',
      why: inches(side) + ' inch sheet — large format, so a drawing' };
  }

  let pages = 0, chars = 0;
  try {
    const r = await readPdf(b64);
    pages = r.pages; chars = r.text.trim().length;
  } catch (e) {
    return { pages: 0, chars: 0, perPage: 0, kind: 'drawing', why: 'could not read it — treating as a drawing' };
  }
  const perPage = pages ? Math.round(chars / pages) : 0;

  // Letter-sized. Now density decides: a parts list or a spec is dense, a small-format sketch
  // is not. A scan of either yields nothing, and correctly falls to the image path, which is
  // the only one that can work on it.
  if (perPage >= DENSE_CHARS_PER_PAGE) {
    return { pages, chars, perPage, kind: 'text', why: perPage + ' characters a page on a letter sheet — reads as a document' };
  }
  if (NAME_SAYS_TEXT.test(fname) && !NAME_SAYS_DRAWING.test(fname)) {
    return { pages, chars, perPage, kind: 'text', why: 'named like a document, though it holds little text' };
  }
  return { pages, chars, perPage, kind: 'drawing', why: perPage ? (perPage + ' characters a page — reads as a drawing') : 'no text in it — a scan or a drawing' };
}

// The document as text. Truncates only at a size no realistic document reaches,
// so in practice the caller gets all of it.
async function extractText(b64, maxChars) {
  const cap = maxChars || 400000;
  const r = await readPdf(b64);
  const t = r.text.trim();
  return { pages: r.pages, text: t.length > cap ? t.slice(0, cap) : t, truncated: t.length > cap };
}

module.exports = { inspect, extractText, DENSE_CHARS_PER_PAGE };
