// =============================================================================
//  quoteAutofill.js — read a supplier's quote (PDF or photo) and pre-fill the
//  quote card for one RFQ. Used by both the supplier's own screen and the
//  manufacturer entering a quote a supplier sent them off-platform.
// -----------------------------------------------------------------------------
//  Claude only READS: which of OUR lines each priced row on the PDF is, the
//  number as printed and what it is per (lb, cwt, ft, each, line total). Every
//  money figure written into the card is computed HERE from that and from our
//  own qty/weight, so a model never decides a total. Anything it can't place,
//  or that doesn't reconcile, comes back flagged and is left for a person to
//  fill. Nothing is submitted: the card is pre-filled and the user reviews it.
// =============================================================================

const _Anthropic = require('@anthropic-ai/sdk');
const Anthropic = _Anthropic.default || _Anthropic;   // 0.40.x CJS interop

const MODEL = process.env.QUOTE_AUTOFILL_MODEL || 'claude-sonnet-5-5';
// $ per million tokens, for the cost ledger only. Override with the model.
const RATE_IN = Number(process.env.QUOTE_AUTOFILL_RATE_IN) || 3;
const RATE_OUT = Number(process.env.QUOTE_AUTOFILL_RATE_OUT) || 15;
const MAX_BYTES = 25 * 1024 * 1024;
// A printed extended total and price x our qty/weight disagreeing by more than this
// usually means the supplier quoted a different quantity or length.
const RECONCILE_TOL = 0.03;

const round = (n, dp) => { const f = Math.pow(10, dp); return Math.round((Number(n) || 0) * f) / f; };
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TOOL = {
  name: 'submit_quote_extraction',
  description: 'Report what the supplier quote says, mapped onto the RFQ lines you were given.',
  input_schema: {
    type: 'object',
    properties: {
      header: {
        type: 'object',
        properties: {
          supplier_quote_number: { type: 'string', description: "The supplier's own quote/reference number. Empty if not printed." },
          quote_date: { type: 'string', description: 'YYYY-MM-DD, empty if not printed.' },
          valid_days: { type: ['number', 'null'], description: 'Days the quote is valid, only if stated as a number of days.' },
          valid_until: { type: 'string', description: 'YYYY-MM-DD expiry date if printed (or computable from a stated date + days). Empty otherwise.' },
          lead_time_days: { type: ['number', 'null'], description: 'Quote-level lead time in days if stated. "Stock"/"in stock"/"ex-stock" = 1. Weeks x 5 (business days). Null if not stated.' },
          shipping: { type: ['number', 'null'], description: 'Freight/delivery/shipping charge as printed. 0 only if the quote says free/included/no charge. Null if not mentioned.' },
          misc: { type: ['number', 'null'], description: 'Sum of other non-material charges (cutting, handling, fuel surcharge, cert fees...). Null if none printed. Never tax.' },
          misc_label: { type: 'string', description: 'What the misc charges are, as printed.' },
          material_subtotal: { type: ['number', 'null'], description: 'Material subtotal as printed, if any.' },
          grand_total: { type: ['number', 'null'], description: 'Quote total as printed (before tax if tax is shown separately).' },
          notes: { type: 'string', description: 'Short terms worth keeping: payment terms, FOB, mill certs, price-hold wording. One or two lines.' },
        },
        required: ['supplier_quote_number'],
      },
      lines: {
        type: 'array',
        description: 'Exactly one entry per RFQ line you were given, in any order.',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The ref of the RFQ line (e.g. S3, F1).' },
            status: { type: 'string', enum: ['priced', 'no_quote', 'not_found'], description: 'priced = a price for this item is on the quote. no_quote = the supplier explicitly declined it / cannot supply. not_found = not on the quote.' },
            pdf_text: { type: 'string', description: 'The matching row on the quote, copied as printed (short).' },
            price: { type: ['number', 'null'], description: 'The unit price exactly as printed, in price_basis units.' },
            price_basis: { type: 'string', enum: ['per_lb', 'per_cwt', 'per_ft', 'each', 'line_total', 'unknown'], description: 'What the printed price is per. per_cwt = per 100 lb. A price per piece/bar/length/plate = each. Use line_total if only an extended amount is printed.' },
            line_total: { type: ['number', 'null'], description: 'Extended amount for the row as printed. Null if not printed. Never compute it.' },
            pdf_qty: { type: ['number', 'null'], description: 'Quantity on the quote row, as printed.' },
            pdf_length: { type: 'string', description: 'Length on the quote row as printed (e.g. "20\'", "240 in"), if any.' },
            lead_time_days: { type: ['number', 'null'], description: 'Line lead time in days, if this row states one. Stock = 1. Weeks x 5.' },
            note: { type: 'string', description: 'Anything the supplier changed or qualified on this row: substitute grade/size, different length, cut charge included, partial qty. Empty if nothing.' },
            match: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure you are the quote row is this RFQ line.' },
          },
          required: ['ref', 'status', 'match'],
        },
      },
      unmatched_pdf_lines: {
        type: 'array',
        description: 'Priced rows on the quote that are not any of the RFQ lines (and are not freight/charges already in the header).',
        items: { type: 'object', properties: { pdf_text: { type: 'string' }, amount: { type: ['number', 'null'] } }, required: ['pdf_text'] },
      },
    },
    required: ['header', 'lines', 'unmatched_pdf_lines'],
  },
};

const SYSTEM =
  'You read steel/metals supplier quotes for a fabricator. You are given the RFQ lines that were sent ' +
  'to this supplier (each with a ref) and the supplier\'s quote document. Map each RFQ line to the quote row ' +
  'that prices it, and copy numbers EXACTLY as printed. Never calculate, estimate or fill in a number that is ' +
  'not on the document: use null. Suppliers describe items their own way (e.g. "W8X31 A992 40\'" for ' +
  '"W 8 x 31 Wide Flange A992 40 ft", "HR PL 1/2 x 48 x 96" for a 1/2" plate, "PIPE 4 SCH40 A53B" for 4" sch 40 ' +
  'pipe); match on shape, size, grade and length. If two RFQ lines could match one quote row, choose the ' +
  'closest and set match to medium or low. Do not assign one quote row to two RFQ lines. Return one entry ' +
  'for every RFQ line.';

// Our lines as the model sees them. The ref is the only key it returns; ids stay server-side.
function lineList(structural, fittings) {
  const rows = [];
  structural.forEach((l, i) => {
    const a = l.alteration || {};
    const len = (a.length_ft || a.length_inch) ? ' | length ' + (a.length_ft || 0) + "' " + (a.length_inch || 0) + '"' : '';
    const wt = (Number(l.qty) || 0) * (Number(l.unit_weight) || 0);
    rows.push('S' + (i + 1) + ' | line ' + (l.line || i + 1) + ' | qty ' + (l.qty == null ? '?' : l.qty) + ' | ' +
      l.description + len + (wt > 0 ? ' | total weight ' + round(wt, 1) + ' lb' : ''));
  });
  fittings.forEach((l, i) => {
    rows.push('F' + (i + 1) + ' | fitting line ' + (l.line || i + 1) + ' | qty ' + (l.qty == null ? '?' : l.qty) + ' | ' + l.description);
  });
  return rows.join('\n');
}

function docBlock(b64, mediaType) {
  const mt = String(mediaType || '').toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp)$/.test(mt)) {
    return { type: 'image', source: { type: 'base64', media_type: mt === 'image/jpg' ? 'image/jpeg' : mt, data: b64 } };
  }
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
}

async function extract(client, args, attempt) {
  const { b64, mediaType, name, quote, structural, fittings } = args;
  // Newer models refuse a forced tool_choice, so the tool is offered and the prompt
  // requires it; a reply without the call gets one retry.
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM + ' Answer only by calling ' + TOOL.name + '.',
    tools: [TOOL],
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: [
        docBlock(b64, mediaType),
        { type: 'text', text:
          'Supplier quote file: ' + (name || 'quote') + '\n' +
          'Our RFQ ' + (quote.quote_number || '') + (quote.quote_description ? ' — ' + quote.quote_description : '') + '\n\n' +
          'RFQ LINES (ref | our line | qty | item):\n' + lineList(structural, fittings) },
      ],
    }],
  });
  const tu = resp.content.find(b => b.type === 'tool_use');
  const usage = resp.usage || {};
  if (!tu && !attempt) {
    const again = await extract(client, args, 1);
    return { out: again.out, usage: { input_tokens: (usage.input_tokens || 0) + (again.usage.input_tokens || 0), output_tokens: (usage.output_tokens || 0) + (again.usage.output_tokens || 0) } };
  }
  return { out: tu ? tu.input : null, usage };
}

function leadChoice(days, choices) {
  const d = num(days);
  if (d == null || d <= 0) return { value: '' };
  const n = Math.ceil(d);
  const v = n <= 1 ? '1 Day' : n + ' Days';
  if (choices.includes(v)) return { value: v };
  return { value: '', flag: 'Lead time on the quote is ' + d + ' days, longer than the longest choice (' + choices[choices.length - 1] + '). Pick one by hand.' };
}

// Turn the model's reading of one structural row into card values, all money computed here.
function shapeStructural(line, x) {
  const flags = [];
  const qty = Number(line.qty) || 0;
  const weight = qty * (Number(line.unit_weight) || 0);
  const a = line.alteration || {};
  const lengthFt = (Number(a.length_ft) || 0) + (Number(a.length_inch) || 0) / 12;
  const price = num(x.price), printed = num(x.line_total);
  let computed = null;
  switch (x.price_basis) {
    case 'per_lb': if (price != null && weight > 0) computed = price * weight; break;
    case 'per_cwt': if (price != null && weight > 0) computed = price * weight / 100; break;
    case 'per_ft': if (price != null && lengthFt > 0 && qty > 0) computed = price * lengthFt * qty; break;
    case 'each': if (price != null && qty > 0) computed = price * qty; break;
    case 'line_total': if (printed == null && price != null) computed = price; break;
    default: break;
  }
  if (computed == null && price != null && /per_lb|per_cwt/.test(x.price_basis) && !(weight > 0)) {
    flags.push('Priced by weight but this line has no weight on file — enter the line total by hand.');
  }
  let total = printed != null ? printed : computed;
  if (printed != null && computed != null && printed > 0) {
    const diff = Math.abs(printed - computed) / printed;
    if (diff > RECONCILE_TOL) {
      flags.push('Quote shows ' + money(printed) + ' for this row, but its price × our ' +
        (x.price_basis === 'each' ? 'qty' : x.price_basis === 'per_ft' ? 'length × qty' : 'weight') + ' = ' + money(computed) +
        '. The supplier may have quoted a different quantity or length — check it.');
    }
  }
  const pq = num(x.pdf_qty);
  if (pq != null && qty > 0 && Math.abs(pq - qty) > 1e-6 && !/lb|cwt/i.test(String(x.pdf_text || ''))) {
    // A per-lb row often prints pounds as the qty; only flag counts that look like pieces.
    if (x.price_basis === 'each' || x.price_basis === 'per_ft' || x.price_basis === 'line_total') {
      flags.push('Quote qty ' + pq + ' vs our qty ' + qty + '.');
    }
  }
  if (total != null && !(total > 0)) total = null;
  if (total == null) flags.push('No price could be read for this line — enter it by hand.');
  return {
    total_price: total != null ? round(total, 2).toFixed(2) : '',
    price_per_lb: total != null && weight > 0 ? String(round(total / weight, 5)) : '',
    flags,
  };
}

function shapeFitting(line, x) {
  const flags = [];
  const qty = Number(line.qty) || 0;
  const price = num(x.price), printed = num(x.line_total);
  let unit = null;
  if (x.price_basis === 'each' && price != null) unit = price;
  else if (printed != null && qty > 0) unit = printed / qty;
  else if (x.price_basis === 'line_total' && price != null && qty > 0) unit = price / qty;
  if (unit != null && printed != null && x.price_basis === 'each' && printed > 0 && Math.abs(printed - unit * qty) / printed > RECONCILE_TOL) {
    flags.push('Quote shows ' + money(printed) + ' for this row, but ' + money(unit) + ' × our qty ' + qty + ' = ' + money(unit * qty) + '. Check the quantity.');
  }
  if (unit != null && !(unit > 0)) unit = null;
  if (unit == null) flags.push('No price could be read for this fitting — enter it by hand.');
  return { unit_price: unit != null ? String(round(unit, 3)) : '', flags };
}

// quote = one merged quote ({ structural_lines, fitting_lines, ... }) from OUR data.
async function autofillQuote({ b64, mediaType, name, quote, leadChoices, validChoices, client }) {
  if (!b64) throw Object.assign(new Error('No file was sent.'), { status: 400 });
  if (b64.length * 0.75 > MAX_BYTES) throw Object.assign(new Error('That file is too large (25 MB max).'), { status: 413 });
  const structural = quote.structural_lines || [];
  const fittings = quote.fitting_lines || [];
  if (!structural.length && !fittings.length) throw Object.assign(new Error('This quote has no lines to fill.'), { status: 400 });

  const ai = client || new Anthropic(); // ANTHROPIC_API_KEY from env
  const { out, usage } = await extract(ai, { b64, mediaType, name, quote, structural, fittings });
  const cost = ((usage.input_tokens || 0) * RATE_IN + (usage.output_tokens || 0) * RATE_OUT) / 1e6;
  try { require('./costLedger').record('supplier quote autofill', cost, { quote: quote.quote_number || quote.quote_id }); } catch (e) { /* never block on bookkeeping */ }
  if (!out) throw Object.assign(new Error('The quote could not be read. Try a clearer PDF, or enter it by hand.'), { status: 422 });

  const byRef = new Map();
  (Array.isArray(out.lines) ? out.lines : []).forEach(x => { if (x && x.ref && !byRef.has(String(x.ref).toUpperCase())) byRef.set(String(x.ref).toUpperCase(), x); });

  const lead = d => leadChoice(d, leadChoices);
  const lineResult = (x, shaped) => {
    const lt = lead(x.lead_time_days);
    const flags = shaped.flags.slice();
    if (lt.flag) flags.push(lt.flag);
    if (x.match === 'low' || x.match === 'medium') flags.unshift((x.match === 'low' ? 'Unsure' : 'Fairly sure') + ' this is the right row on the quote — check the item.');
    return { lead_time: lt.value, comments: String(x.note || '').trim(), pdf_text: String(x.pdf_text || '').trim(), match: x.match || 'high', flags };
  };

  const struct = {};
  structural.forEach((l, i) => {
    const x = byRef.get('S' + (i + 1));
    if (!x || x.status === 'not_found') { struct[l.rfqs_sent_id] = { found: false, flags: ['Not on the supplier\'s quote — price it by hand or mark it No Quote.'] }; return; }
    if (x.status === 'no_quote') { struct[l.rfqs_sent_id] = { found: true, quote_option: 'No Quote', ...lineResult(x, { flags: [] }) }; return; }
    const shaped = shapeStructural(l, x);
    struct[l.rfqs_sent_id] = { found: true, quote_option: 'Quote As Is', total_price: shaped.total_price, price_per_lb: shaped.price_per_lb, ...lineResult(x, shaped) };
  });
  const fit = {};
  fittings.forEach((l, i) => {
    const x = byRef.get('F' + (i + 1));
    if (!x || x.status === 'not_found') { fit[l.rfq_row_id] = { found: false, flags: ['Not on the supplier\'s quote — price it by hand or mark it No Quote.'] }; return; }
    if (x.status === 'no_quote') { fit[l.rfq_row_id] = { found: true, quote_option: 'No Quote', ...lineResult(x, { flags: [] }) }; return; }
    const shaped = shapeFitting(l, x);
    fit[l.rfq_row_id] = { found: true, quote_option: 'Quote As Is', unit_price: shaped.unit_price, ...lineResult(x, shaped) };
  });

  const h = out.header || {};
  const header = {}, headerFlags = [];
  if (h.supplier_quote_number) header.supplier_quote_number = String(h.supplier_quote_number).trim();
  const vd = num(h.valid_days);
  if (vd != null) {
    if (validChoices.includes(vd)) header.valid_days = String(vd);
    else headerFlags.push('Quote is valid ' + vd + ' days, which isn\'t one of the choices — pick the closest by hand.');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(h.valid_until || ''))) header.valid_until = h.valid_until;
  const hl = lead(h.lead_time_days);
  if (hl.value) header.lead_time = hl.value;
  if (hl.flag) headerFlags.push(hl.flag);
  if (num(h.shipping) != null && num(h.shipping) >= 0) header.shipping = round(num(h.shipping), 2).toFixed(2);
  else headerFlags.push('No shipping charge on the quote — enter 0 if delivery is included.');
  if (num(h.misc) != null && num(h.misc) >= 0) header.misc = round(num(h.misc), 2).toFixed(2);
  const notes = [String(h.notes || '').trim(), h.misc_label && num(h.misc) ? 'Misc = ' + String(h.misc_label).trim() : ''].filter(Boolean).join(' · ');
  if (notes) header.notes = notes;

  return {
    ok: true,
    file_name: name || '',
    header,
    header_flags: headerFlags,
    structural: struct,
    fittings: fit,
    unmatched_pdf_lines: (Array.isArray(out.unmatched_pdf_lines) ? out.unmatched_pdf_lines : [])
      .map(u => ({ pdf_text: String(u.pdf_text || '').trim(), amount: num(u.amount) })).filter(u => u.pdf_text),
    pdf_material_subtotal: num(h.material_subtotal),
    pdf_grand_total: num(h.grand_total),
    cost_usd: round(cost, 4),
  };
}

module.exports = { autofillQuote, _test: { shapeStructural, shapeFitting, leadChoice, lineList } };
