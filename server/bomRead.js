// =============================================================================
//  bomRead.js — read a BOM someone already wrote, in whatever form it came:
//  PDF, Excel, CSV, a photo of a handwritten list, or pasted text.
// -----------------------------------------------------------------------------
//  This is NOT a take-off. A take-off works quantities out from drawings; a BOM
//  already states them. So the model only COPIES: marks, quantities, sizes and
//  lengths exactly as written, renamed to the shop's catalog words where the
//  item is plainly the same thing. It never computes or fills a number the
//  document doesn't give — a gap stays blank with an issue, and the staging
//  review (fuzzy match, error log, Include In Import) is where a person settles
//  it. The rows leave here as the same import CSV the AI take-off commits, so
//  everything after the read is the existing BOM CSV import, unchanged.
// =============================================================================

const _Anthropic = require('@anthropic-ai/sdk');
const Anthropic = _Anthropic.default || _Anthropic;

const MODEL = process.env.BOM_READ_MODEL || 'claude-sonnet-5-5';
const RATE_IN = Number(process.env.BOM_READ_RATE_IN) || 3;
const RATE_OUT = Number(process.env.BOM_READ_RATE_OUT) || 15;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 400000;

const TOOL = {
  name: 'submit_bom_rows',
  description: 'Every material row on the BOM, copied as written and named in the shop catalog\'s words.',
  input_schema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tag: { type: 'string', description: 'Piece mark / item / tag as written. Empty if none.' },
            component: { type: 'string', description: 'Assembly or component the row belongs to, if the BOM groups rows (e.g. "Platform A", "Stair 2"). Empty if none.' },
            drawing: { type: 'string', description: 'Drawing / sheet number written for the row, if any.' },
            form_type: { type: 'string', description: 'Form type from the catalog list (e.g. Wide Flange Beam, Angle, Plate, Pipe). Empty if unsure.' },
            material_type: { type: 'string', description: 'Material from the catalog list (e.g. Carbon Steel, Stainless Steel, Aluminum). Empty if not stated and not obvious.' },
            specification: { type: 'string', description: 'Grade/spec as a catalog specification (e.g. A36, A992, A500 Gr B). Empty if not stated.' },
            size: { type: 'string', description: 'Size written the catalog\'s way for that form (e.g. "W 8 x 31", "L4 x 4 x 3/8", "3/8\\"" for plate thickness). If the size is not in the catalog list, copy it as written.' },
            qty: { type: ['number', 'null'], description: 'Quantity exactly as written for this row. Null if not written. Never multiply or add.' },
            length_ft: { type: ['number', 'null'], description: 'Whole feet of the length as written (20\'-6" -> 20). Null if no length.' },
            length_in: { type: ['number', 'null'], description: 'Remaining inches of the length, may be fractional (20\'-6 1/2" -> 6.5; 246" -> ft 20, in 6). Null if no length.' },
            width_ft: { type: ['number', 'null'], description: 'Plate/sheet width, whole feet. Null if none.' },
            width_in: { type: ['number', 'null'], description: 'Plate/sheet width, remaining inches. Null if none.' },
            galvanized: { type: 'boolean', description: 'True only if the row (or the whole BOM) says galvanized / HDG.' },
            painted: { type: 'boolean', description: 'True only if the row (or the whole BOM) says painted / primed / coated.' },
            confidence: { type: 'number', description: '0-100: how sure you are this row is read and named correctly.' },
            source_text: { type: 'string', description: 'The row as it appears on the document, copied (short).' },
            issue: { type: 'string', description: 'Anything a person must check: unreadable digit, no quantity, size not in catalog, quantity looks per-assembly. Empty if none.' },
          },
          required: ['qty', 'source_text', 'confidence'],
        },
      },
      notes: { type: 'string', description: 'One or two lines about the document as a whole (e.g. "quantities are per assembly, 4 assemblies noted in title block"). Empty if nothing.' },
    },
    required: ['rows'],
  },
};

const SYSTEM =
  'You transcribe a steel fabricator\'s bill of materials (BOM) into rows. The BOM may be a typed list, a ' +
  'spreadsheet, a drawing\'s material table or a handwritten sheet. COPY, do not estimate: every quantity, ' +
  'size and length must be what the document says. Never multiply, total, convert units of quantity, or fill ' +
  'in a number that is not written — use null and say so in issue. One output row per material row on the ' +
  'document; skip headings, totals, notes and hardware that is not material (bolts, anchors, welding wire) ' +
  'unless it is listed as a material row, in which case keep it and say "not structural material" in issue. ' +
  'Name each row in the shop catalog\'s words (form type, material type, specification, size) when it is ' +
  'plainly the same item ("W8X31" = "W 8 x 31", "L 4x4x3/8" = angle "L4 x 4 x 3/8", "PL 1/2 x 12 x 24" = ' +
  'plate 1/2" thick, width 12 in, length 24 in). When a size is not in the catalog, copy it as written and ' +
  'put "size not in catalog" in issue. If quantities look per assembly with a separate assembly count, copy ' +
  'them as written and explain in notes and issue — never multiply.';

// ---- files -> content blocks --------------------------------------------------------------------
function isExcel(name, mt) {
  return /\.xlsx$/i.test(name || '') || /spreadsheetml/.test(mt || '');
}
function isText(name, mt) {
  return /\.(csv|txt|tsv)$/i.test(name || '') || /^text\//.test(mt || '');
}

// An Excel workbook as plain text, every sheet, one line per row, cells separated by " | ".
async function excelText(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = [];
  wb.eachSheet(function (ws) {
    out.push('=== Sheet: ' + ws.name + ' ===');
    ws.eachRow({ includeEmpty: false }, function (row) {
      const cells = [];
      row.eachCell({ includeEmpty: true }, function (c) {
        let v = c.value;
        if (v && typeof v === 'object') v = v.result != null ? v.result : (v.text != null ? v.text : (v.richText ? v.richText.map(function (r) { return r.text; }).join('') : ''));
        cells.push(v == null ? '' : String(v).trim());
      });
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.some(function (c) { return c !== ''; })) out.push(cells.join(' | '));
    });
  });
  return out.join('\n');
}

async function toBlocks(files, pasted) {
  const blocks = [];
  for (const f of files || []) {
    const name = String(f.name || 'file');
    const mt = String(f.media_type || '').toLowerCase();
    const b64 = String(f.b64 || '');
    if (!b64) continue;
    if (b64.length * 0.75 > MAX_FILE_BYTES) throw Object.assign(new Error(name + ' is too large (30 MB max).'), { status: 413 });
    const buf = Buffer.from(b64, 'base64');
    if (isExcel(name, mt)) {
      let txt;
      try { txt = await excelText(buf); } catch (e) { throw Object.assign(new Error(name + ' could not be opened as an Excel workbook (.xlsx). Save it as .xlsx or .csv and try again.'), { status: 400 }); }
      blocks.push({ type: 'text', text: 'FILE ' + name + ' (spreadsheet, as text):\n' + txt.slice(0, MAX_TEXT_CHARS) });
    } else if (isText(name, mt)) {
      blocks.push({ type: 'text', text: 'FILE ' + name + ':\n' + buf.toString('utf8').slice(0, MAX_TEXT_CHARS) });
    } else if (/^image\/(png|jpe?g|gif|webp)$/.test(mt)) {
      blocks.push({ type: 'text', text: 'FILE ' + name + ' (image):' });
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mt === 'image/jpg' ? 'image/jpeg' : mt, data: b64 } });
    } else if (mt === 'application/pdf' || /\.pdf$/i.test(name)) {
      blocks.push({ type: 'text', text: 'FILE ' + name + ' (PDF):' });
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
    } else if (/\.xls$/i.test(name)) {
      throw Object.assign(new Error(name + ' is an old Excel format (.xls). Open it and Save As .xlsx or .csv, then try again.'), { status: 400 });
    } else {
      throw Object.assign(new Error(name + ': this kind of file can\'t be read. Use PDF, Excel (.xlsx), CSV, a photo, or paste the text.'), { status: 400 });
    }
  }
  const p = String(pasted || '').trim();
  if (p) blocks.push({ type: 'text', text: 'PASTED TEXT:\n' + p.slice(0, MAX_TEXT_CHARS) });
  return blocks;
}

// ---- the import CSV (same template the AI take-off commits) --------------------------------------
// Same as the take-off's: the staging validator splits on commas and knows no quoting, so a comma
// inside a value becomes a space.
const cell = function (v) {
  return v == null ? '' : String(v).replace(/[,\r\n]+/g, ' ').trim();
};
const n = function (v) { return v == null || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v); };

function buildImportCsv(rows) {
  const out = [
    'MATERIAL COMPASS - BOM Import Template (AI BOM Import)', 'Generated by AI BOM Import - review in BOM Staging',
    'Tag,Component,Drawing Number,Form Type,Mat Type,Specification,Material,QTY,FT(L),INCH(L),FT(W),INCH(W),Galv,Surface Area,Confidence',
    'blue = lookup ; green = direct entry ; * = required', '', '',
  ];
  rows.forEach(function (r, i) {
    out.push([
      cell(r.tag || ('IMP-' + String(i + 1).padStart(3, '0'))), cell(r.component), cell(r.drawing),
      cell(r.form_type), cell(r.material_type), cell(r.specification), cell(r.size),
      cell(n(r.qty)), cell(n(r.length_ft)), cell(n(r.length_in)), cell(n(r.width_ft)), cell(n(r.width_in)),
      r.galvanized ? 'Yes' : '', r.painted ? 'Yes' : '', cell(n(Math.round(Number(r.confidence) || 0))),
    ].join(','));
  });
  return out.join('\n');
}

// ---- the read ------------------------------------------------------------------------------------
async function readBom({ files, text, catalogText, client }) {
  const blocks = await toBlocks(files, text);
  if (!blocks.length) throw Object.assign(new Error('Add a file or paste the BOM text first.'), { status: 400 });
  const ai = client || new Anthropic();
  const content = [];
  if (catalogText) content.push({ type: 'text', text: 'SHOP CATALOG (form | materials, valid specifications, sizes):\n' + catalogText, cache_control: { type: 'ephemeral' } });
  content.push.apply(content, blocks);
  content.push({ type: 'text', text: 'Copy every material row of the BOM above. Answer only by calling ' + TOOL.name + '.' });

  let usage = { input_tokens: 0, output_tokens: 0 }, out = null;
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const resp = await ai.messages.create({
      model: MODEL, max_tokens: 32000, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content }],
    });
    const u = resp.usage || {};
    usage.input_tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) * 0.1;
    usage.output_tokens += u.output_tokens || 0;
    const tu = (resp.content || []).find(function (b) { return b.type === 'tool_use'; });
    if (tu) out = tu.input;
    if (resp.stop_reason === 'max_tokens' && !out) throw Object.assign(new Error('That BOM is too long to read in one go. Split it into parts (for example by page or sheet) and import each with "Add to the BOM".'), { status: 413 });
  }
  const cost = (usage.input_tokens * RATE_IN + usage.output_tokens * RATE_OUT) / 1e6;
  try { require('./costLedger').record('ai bom import', cost, {}); } catch (e) { /* bookkeeping never blocks */ }
  if (!out || !Array.isArray(out.rows)) throw Object.assign(new Error('The BOM could not be read. Try a clearer file, or paste the text.'), { status: 422 });

  const rows = out.rows.map(function (r) {
    const issues = [];
    if (r.issue) issues.push(String(r.issue).trim());
    if (r.qty == null || !(Number(r.qty) > 0)) issues.push('No quantity read');
    if (!r.size) issues.push('No size read');
    return {
      tag: String(r.tag || '').trim(), component: String(r.component || '').trim(), drawing: String(r.drawing || '').trim(),
      form_type: String(r.form_type || '').trim(), material_type: String(r.material_type || '').trim(),
      specification: String(r.specification || '').trim(), size: String(r.size || '').trim(),
      qty: r.qty == null ? null : Number(r.qty),
      length_ft: r.length_ft == null ? null : Number(r.length_ft), length_in: r.length_in == null ? null : Number(r.length_in),
      width_ft: r.width_ft == null ? null : Number(r.width_ft), width_in: r.width_in == null ? null : Number(r.width_in),
      galvanized: !!r.galvanized, painted: !!r.painted,
      confidence: Math.max(0, Math.min(100, Math.round(Number(r.confidence) || 0))),
      source_text: String(r.source_text || '').trim(), issue: issues.filter(Boolean).join('; '),
    };
  });
  return { rows, notes: String(out.notes || '').trim(), cost_usd: Math.round(cost * 100) / 100 };
}

module.exports = { readBom, buildImportCsv, excelText };
