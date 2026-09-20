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

// Chars per page above which a document reads as prose or a table rather than a
// drawing. A drawing sheet carries a title block and some notes, rarely more
// than a few hundred characters; a BOM page runs to well over a thousand.
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
async function inspect(name, b64) {
  const fname = String(name || '');
  let pages = 0, chars = 0;
  try {
    const r = await readPdf(b64);
    pages = r.pages; chars = r.text.trim().length;
  } catch (e) {
    return { pages: 0, chars: 0, perPage: 0, kind: 'drawing', why: 'could not read it — treating as a drawing' };
  }
  const perPage = pages ? Math.round(chars / pages) : 0;

  // Density decides it. A scanned drawing yields almost no text and correctly
  // reads as a drawing; a scanned BOM does too, and that is honest — there is no
  // text in it to extract, so the image path is the only one that can work.
  if (perPage >= DENSE_CHARS_PER_PAGE) {
    return { pages, chars, perPage, kind: 'text', why: perPage + ' characters a page — reads as a document' };
  }
  // Sparse. The filename is the tiebreaker, and only when it is unambiguous.
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
