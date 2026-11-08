// =============================================================================
//  mailer.js — Material Compass sends its own email (Resend's HTTP API).
// -----------------------------------------------------------------------------
//  Railway blocks outbound SMTP on this plan, so mail goes over HTTPS to Resend.
//  The sending domain (materialcompass.us) is verified in Resend with DKIM/SPF records
//  at SiteGround. Env:
//    RESEND_API_KEY   required; without it send() refuses (nothing is faked)
//    MAIL_FROM        default "Material Compass <no_reply@materialcompass.us>"
//    MAIL_TEST_TO     optional: when set, EVERY message goes to this address instead
//                     (subject marked), for testing before real suppliers get mail.
// =============================================================================

const axios = require('axios');

const FROM = () => process.env.MAIL_FROM || 'Material Compass <no_reply@materialcompass.us>';
const configured = () => !!process.env.RESEND_API_KEY;

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// { to, subject, html, text?, replyTo?, attachments?: [{ filename, content: Buffer }] }
// -> { ok, id } | { ok:false, error }
async function send(msg) {
  if (!configured()) return { ok: false, error: 'not_configured' };
  const testTo = process.env.MAIL_TEST_TO;
  const to = testTo ? [testTo] : (Array.isArray(msg.to) ? msg.to : [msg.to]).filter(Boolean);
  if (!to.length) return { ok: false, error: 'no_recipient' };
  const body = {
    from: FROM(),
    to,
    subject: (testTo ? '[TEST to ' + [].concat(msg.to).join(', ') + '] ' : '') + msg.subject,
    html: msg.html,
  };
  if (msg.text) body.text = msg.text;
  if (msg.replyTo) body.reply_to = msg.replyTo;
  if (msg.attachments && msg.attachments.length) {
    body.attachments = msg.attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') }));
  }
  try {
    const r = await axios.post('https://api.resend.com/emails', body, {
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      maxBodyLength: Infinity, timeout: 60000,
    });
    return { ok: true, id: r.data && r.data.id };
  } catch (e) {
    const d = e.response && e.response.data;
    console.error('[mailer] send failed', e.response && e.response.status, d ? JSON.stringify(d).slice(0, 300) : e.message);
    return { ok: false, error: (d && (d.message || d.name)) || e.message };
  }
}

// ---------- RFQ email -------------------------------------------------------------------
const BLUE = '#5286B4';
const LOGO = process.env.MC_LOGO_URL || 'https://material-compass-nesting-app-production.up.railway.app/brand/mc-compass.png';

// Brand standard header: 46px circle mark + "MATERIAL COMPASS" in Georgia, spaced, brand blue.
const HEADER_MARK = '<img src="' + esc(LOGO) + '" alt="" width="46" height="46" style="vertical-align:middle">' +
  ' <span style="font-family:Georgia,serif;font-size:18px;letter-spacing:4px;color:' + BLUE + ';vertical-align:middle">MATERIAL COMPASS</span>';

function fmtWt(n) { return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' lbs'; }

// q: { quote_number, revision, quote_date, due_date, manufacturer, mfg_contact:{name,email,phone},
//      requirements:[], notes, lines:[{line, description, qty, unit_weight, total_weight, note}] }
// opts: { supplierName, link, firstTime, revised }
function rfqEmail(q, opts) {
  const o = opts || {};
  const fits = q.fittings || [];
  const totalWt = q.lines.concat(fits).reduce((s, l) => s + (Number(l.total_weight) || 0), 0);
  const fitRows = fits.map((l, i) => '<tr style="background:' + (i % 2 ? '#f7f9fc' : '#fff') + '">' +
    '<td style="padding:8px 10px;color:#7a8a99;font-size:12px">' + esc(l.line || i + 1) + '</td>' +
    '<td style="padding:8px 10px;font-size:13px">' + esc(l.description) + '</td>' +
    '<td style="padding:8px 10px;text-align:center;font-size:13px">' + esc(l.qty == null ? '' : l.qty) + '</td>' +
    '<td style="padding:8px 10px;text-align:right;font-size:13px;white-space:nowrap">' + (Number(l.total_weight) ? fmtWt(l.total_weight) : '') + '</td></tr>').join('');
  const revisedBanner = o.revised && !o.firstTime
    ? '<tr><td style="padding:14px 28px"><div style="border-left:4px solid #e8590c;background:#fff4e6;padding:10px 14px;font-size:13px;color:#7a3e00"><b>REVISION ' + esc(q.revision || '') + ':</b> this request replaces the earlier one for this material. Please quote from this revision.</div></td></tr>'
    : '';
  const rows = q.lines.map((l, i) => '<tr style="background:' + (i % 2 ? '#f7f9fc' : '#fff') + '">' +
    '<td style="padding:8px 10px;color:#7a8a99;font-size:12px">' + esc(l.line || i + 1) + '</td>' +
    '<td style="padding:8px 10px;font-size:13px">' + esc(l.description) + (l.note ? '<div style="color:#7a8a99;font-size:12px">' + esc(l.note) + '</div>' : '') + '</td>' +
    '<td style="padding:8px 10px;text-align:center;font-size:13px">' + esc(l.qty == null ? '' : l.qty) + '</td>' +
    '<td style="padding:8px 10px;text-align:right;font-size:13px;white-space:nowrap">' + fmtWt(l.total_weight) + '</td></tr>').join('');
  const reqs = (q.requirements || []).filter(Boolean);
  const c = q.mfg_contact || {};
  const button = o.link
    ? '<a href="' + esc(o.link) + '" style="display:inline-block;background:' + BLUE + ';color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:6px;font-size:15px">Price this quote online</a>' +
      '<div style="font-size:12px;color:#7a8a99;margin-top:8px">No account needed. Upload your own quote PDF and the lines fill in for you. The link works for 60 days and lets you revise your quote.</div>'
    : '';
  const html =
'<!DOCTYPE html><html><body style="margin:0;background:#eef2f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2d3d">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0"><tr><td align="center">' +
'<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #d9e2ec">' +
'<tr><td style="padding:18px 28px">' + '' + HEADER_MARK + '' + '</td></tr>' +
'<tr><td style="background:' + BLUE + ';color:#fff;padding:18px 28px"><div style="font-size:22px;font-weight:700">REQUEST FOR QUOTE</div>' +
'<div style="font-size:13px;opacity:.9">' + esc(q.manufacturer) + ' is asking ' + esc(o.supplierName || 'you') + ' for a price on the material below.</div></td></tr>' +
revisedBanner +
'<tr><td style="padding:14px 28px;background:#f4f7fb"><table width="100%"><tr>' +
'<td style="font-size:11px;color:#7a8a99">QUOTE NUMBER<div style="font-size:15px;color:#1f2d3d;font-weight:700">' + esc(q.quote_number) + (q.revision && o.revised && !o.firstTime ? ' Rev #' + esc(q.revision) : '') + '</div></td>' +
'<td style="font-size:11px;color:#7a8a99">SENT<div style="font-size:15px;color:#1f2d3d;font-weight:700">' + esc(q.sent_date || '') + '</div></td>' +
'<td style="font-size:11px;color:#7a8a99">RESPONSE DUE<div style="font-size:15px;color:#c92a2a;font-weight:700">' + esc(q.due_date || '') + '</div></td>' +
'</tr></table></td></tr>' +
'<tr><td style="padding:16px 28px"><div style="font-size:11px;color:#7a8a99">REQUESTED BY</div>' +
'<div style="font-weight:700">' + esc(q.manufacturer) + '</div>' +
(c.name ? '<div>' + esc(c.name) + '</div>' : '') +
(c.email ? '<div><a href="mailto:' + esc(c.email) + '" style="color:' + BLUE + '">' + esc(c.email) + '</a></div>' : '') +
(c.phone ? '<div>' + esc(c.phone) + '</div>' : '') + '</td></tr>' +
(reqs.length || q.notes ? '<tr><td style="padding:0 28px 12px"><div style="font-size:11px;color:#7a8a99">REQUIREMENTS &amp; NOTES</div>' +
  reqs.map(r => '<div style="border-left:3px solid ' + BLUE + ';background:#f4f7fb;padding:6px 10px;margin-top:6px;font-size:13px">' + esc(r) + '</div>').join('') +
  (q.notes ? '<div style="margin-top:6px;font-size:13px">' + esc(q.notes) + '</div>' : '') + '</td></tr>' : '') +
(button ? '<tr><td style="padding:8px 28px 18px" align="center">' + button + '</td></tr>' : '') +
'<tr><td style="padding:0 28px"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d9e2ec;border-collapse:collapse">' +
(q.lines.length ? '<tr style="background:#eef2f7;font-size:11px;color:#55677a"><td style="padding:8px 10px">#</td><td style="padding:8px 10px">ITEM</td><td style="padding:8px 10px;text-align:center">QTY</td><td style="padding:8px 10px;text-align:right">WEIGHT</td></tr>' + rows : '') +
(fits.length ? '<tr style="background:#eef2f7;font-size:11px;color:#55677a"><td style="padding:8px 10px">#</td><td style="padding:8px 10px">FITTING</td><td style="padding:8px 10px;text-align:center">QTY</td><td style="padding:8px 10px;text-align:right">WEIGHT</td></tr>' + fitRows : '') +
'<tr style="background:#eef4fb"><td colspan="3" style="padding:10px;text-align:right;font-size:12px;color:#55677a">Total quote weight</td><td style="padding:10px;text-align:right;font-weight:700">' + fmtWt(totalWt) + '</td></tr>' +
'</table></td></tr>' +
'<tr><td style="padding:18px 28px"><div style="background:#fff8e6;border-top:2px solid #f0ad4e;padding:12px 16px;font-size:13px">' +
'<b>How to respond</b><br>' + (o.link ? 'Use <b>Price this quote online</b> above, or reply' : 'Reply') +
' to this email by <b>' + esc(q.due_date || 'the due date') + '</b> with your price and lead time for each line. Mark any line you cannot supply as <i>No Quote</i>.</div></td></tr>' +
'<tr><td style="padding:12px 28px;background:#f4f6f8;font-size:11px;color:#7a8a99">Sent through Material Compass on behalf of ' + esc(String(q.manufacturer || '').replace(/\.$/, '')) +
'. Want every request in one place, with your stock matched automatically? <a href="https://materialcompass.us" style="color:' + BLUE + '">Join Material Compass free</a>.</td></tr>' +
'</table></td></tr></table></body></html>';
  const subject = (o.revised && !o.firstTime ? 'REVISED RFQ ~ Rev #' + (q.revision || '') + ' ~ ' : 'RFQ ~ ') + 'Quote #' + q.quote_number + ' from ' + q.manufacturer;
  return { subject, html };
}

// ---------- Manufacturer notices ------------------------------------------------------
const PORTAL = process.env.MC_PORTAL_URL || 'https://customer.materialcompassportal.com';

// Shared frame: logo, colored title band, quote facts, body, footer.
function frame(title, subtitle, band, facts, body) {
  return '<!DOCTYPE html><html><body style="margin:0;background:#eef2f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2d3d">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0"><tr><td align="center">' +
'<table width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #d9e2ec">' +
'<tr><td style="padding:18px 28px">' + HEADER_MARK + '</td></tr>' +
'<tr><td style="background:' + band + ';color:#fff;padding:18px 28px"><div style="font-size:22px;font-weight:700">' + title + '</div>' +
'<div style="font-size:13px;opacity:.92">' + subtitle + '</div></td></tr>' +
'<tr><td style="padding:14px 28px;background:#f4f7fb"><table width="100%"><tr>' +
facts.map(([k, v, red]) => '<td style="font-size:11px;color:#7a8a99">' + esc(k) + '<div style="font-size:15px;color:' + (red ? '#c92a2a' : '#1f2d3d') + ';font-weight:700">' + esc(v || '') + '</div></td>').join('') +
'</tr></table></td></tr>' + body +
'<tr><td style="padding:18px 28px" align="center"><a href="' + esc(PORTAL) + '" style="display:inline-block;background:' + BLUE + ';color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:6px;font-size:15px">Open Material Compass</a></td></tr>' +
'<tr><td style="padding:12px 28px;background:#f4f6f8;font-size:11px;color:#7a8a99">Sent automatically by Material Compass.</td></tr>' +
'</table></td></tr></table></body></html>';
}
const th = s => '<td style="padding:8px 10px;font-size:11px;color:#55677a">' + s + '</td>';
const td = (s, align) => '<td style="padding:8px 10px;font-size:13px' + (align ? ';text-align:' + align : '') + '">' + s + '</td>';

// q: { quote_number, revision, quote_date, due_date }
// suppliers: [{ name, lines, weight, email_only }]; opts: { added } (Add Other Suppliers)
function mfgSentEmail(q, suppliers, opts) {
  const o = opts || {};
  const n = suppliers.length;
  const ref = q.quote_number + (q.revision ? ' Rev #' + q.revision : '');
  // Fittings column only when we know the split (null = Zoho's lumped count).
  const showFit = suppliers.some(s => s.fittings != null);
  const rows = suppliers.map((s, i) => '<tr style="background:' + (i % 2 ? '#f7f9fc' : '#fff') + '">' +
    td(esc(s.name) + (s.email_only ? ' <span style="color:#7a8a99;font-size:11px">(email only)</span>' : '')) +
    td(esc(s.lines), 'center') + (showFit ? td(esc(s.fittings == null ? '' : s.fittings), 'center') : '') +
    td(fmtWt(s.weight), 'right') + '</tr>').join('');
  const body = '<tr><td style="padding:16px 28px"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d9e2ec;border-collapse:collapse">' +
    '<tr style="background:#eef2f7">' + th('SUPPLIER') + th(showFit ? 'STRUCTURAL / PIPE' : 'LINES') + (showFit ? th('FITTINGS') : '') + th('TOTAL WEIGHT') + '</tr>' + rows + '</table>' +
    '<div style="font-size:13px;color:#55677a;margin-top:10px">Each supplier got only the lines they stock (email-only suppliers get every line), with a link to price it online. Their prices show up in Material Compass as they respond.</div></td></tr>';
  const html = frame(o.added ? 'SUPPLIERS ADDED' : 'RFQ SENT',
    o.added ? esc(ref) + ' was sent to ' + n + ' more supplier' + (n === 1 ? '' : 's') + '.'
            : 'Your request was sent to ' + n + ' matched supplier' + (n === 1 ? '' : 's') + '.',
    BLUE, [['QUOTE NUMBER', ref], ['QUOTE DATE', q.quote_date], ['RESPONSES DUE', q.due_date, true]], body);
  const subject = (o.added ? 'Sent to ' + n + ' more supplier' + (n === 1 ? '' : 's') + ' ~ Quote #' + q.quote_number
    : (q.revision ? 'REVISED RFQ Sent ~ Rev #' + q.revision + ' ~ ' : 'RFQ Sent ~ ') + 'Quote #' + q.quote_number + ' ~ ' + n + ' supplier' + (n === 1 ? '' : 's') + ' notified');
  return { subject, html };
}

// lines: [{ line, form, material, spec, weight }]
function noMatchEmail(q, lines) {
  const ref = q.quote_number + (q.revision ? ' Rev #' + q.revision : '');
  const rows = lines.map((l, i) => '<tr style="background:' + (i % 2 ? '#fff5f5' : '#fff') + '">' +
    td(esc(l.line), 'center') + td(esc(l.form)) + td(esc(l.material)) + td(esc(l.spec)) + td(fmtWt(l.weight), 'right') + '</tr>').join('');
  const body = '<tr><td style="padding:16px 28px"><div style="font-size:13px;margin-bottom:10px">No matched supplier stocks ' + (lines.length === 1 ? 'this line' : 'these ' + lines.length + ' lines') +
    ', so nobody was asked to price ' + (lines.length === 1 ? 'it' : 'them') + '. Check the material is entered correctly, or add a supplier who carries it (Add Other Suppliers on the quote).</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f1c0c0;border-collapse:collapse">' +
    '<tr style="background:#fdecec">' + th('LINE') + th('FORM') + th('MATERIAL') + th('SPEC') + th('WEIGHT') + '</tr>' + rows + '</table></td></tr>';
  const html = frame('ACTION REQUIRED: UNMATCHED ITEMS', esc(lines.length) + ' line' + (lines.length === 1 ? '' : 's') + ' on quote ' + esc(ref) + ' could not be matched to any supplier.',
    '#c62828', [['QUOTE NUMBER', ref], ['QUOTE DATE', q.quote_date], ['RESPONSES DUE', q.due_date, true]], body);
  return { subject: 'Action Required ~ Quote #' + q.quote_number + (q.revision ? ' Rev #' + q.revision : '') + ' Has Unmatched Items', html };
}

// A supplier's quote, as saved: to the manufacturer ("received") or the supplier ("copy").
// d: { quote_number, description, manufacturer, supplier:{name,email,phone}, supplier_quote_number,
//      valid_until, lead_time, shipping, misc, notes,
//      lines:[{line, description, qty, status, total}], fittings:[{line, description, qty, status, unit, total}] }
function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function quoteReceivedEmail(d, opts) {
  const copy = !!(opts && opts.copy);
  const statusCell = (s, kind) => {
    const no = /no quote/i.test(s || ''), alt = /alter/i.test(s || '');
    return td('<span style="color:' + (no ? '#c92a2a' : alt ? '#b54708' : '#1a7f37') + ';font-weight:700;font-size:12px">' + esc(no ? 'No Quote' : alt ? 'Altered' + (kind ? ': ' + kind : '') : 'Quoted') + '</span>', 'center');
  };
  const all = d.lines.concat(d.fittings);
  const nNo = all.filter(l => /no quote/i.test(l.status || '')).length;
  const nAlt = all.filter(l => /alter/i.test(l.status || '')).length;
  const breakdown = (all.length - nNo) + ' quoted' + (nAlt ? ' · ' + nAlt + ' altered' : '') + (nNo ? ' · ' + nNo + ' not quoted' : '');
  const mat = d.lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const fit = d.fittings.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const total = mat + fit + (Number(d.shipping) || 0) + (Number(d.misc) || 0);
  const tbl = (head, rows) => '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d9e2ec;border-collapse:collapse;margin-top:10px">' + head + rows + '</table>';
  const sRows = d.lines.map((l, i) => '<tr style="background:' + (i % 2 ? '#f7f9fc' : '#fff') + '">' + td(esc(l.line), 'center') +
    td(esc(l.description) + (l.alt_note ? '<div style="font-size:11px;color:#b54708;margin-top:3px">SUPPLIER ALTERED: ' + esc(l.alt_note) + '</div>' : '')) +
    td(esc(l.qty == null ? '' : l.qty), 'center') + statusCell(l.status, l.alt_kind) + td(/no quote/i.test(l.status || '') ? '—' : money(l.total), 'right') + '</tr>').join('');
  const fRows = d.fittings.map((l, i) => '<tr style="background:' + (i % 2 ? '#f7f9fc' : '#fff') + '">' + td(esc(l.line), 'center') + td(esc(l.description)) +
    td(esc(l.qty == null ? '' : l.qty), 'center') + statusCell(l.status) + td(/no quote/i.test(l.status || '') ? '—' : money(l.unit) + '/ea', 'right') +
    td(/no quote/i.test(l.status || '') ? '—' : money(l.total), 'right') + '</tr>').join('');
  const sup = d.supplier || {};
  const body =
    '<tr><td style="padding:16px 28px"><table width="100%"><tr><td style="vertical-align:top">' +
      '<div style="font-size:11px;color:#7a8a99">QUOTED BY</div><div style="font-size:16px;font-weight:700">' + esc(sup.name) + '</div>' +
      (sup.email ? '<div style="font-size:13px">' + esc(sup.email) + '</div>' : '') + (sup.phone ? '<div style="font-size:13px">' + esc(sup.phone) + '</div>' : '') +
      (d.description ? '<div style="font-size:12px;color:#7a8a99;margin-top:6px">' + esc(d.description) + '</div>' : '') +
    '</td><td style="vertical-align:top;text-align:right"><div style="background:#f4f7fb;border-radius:8px;padding:12px 18px;display:inline-block;text-align:center">' +
      '<div style="font-size:11px;color:#7a8a99">QUOTE TOTAL</div><div style="font-size:24px;font-weight:700">' + money(total) + '</div>' +
      '<div style="font-size:11px;color:#7a8a99">' + esc(breakdown) + '</div></div></td></tr></table></td></tr>' +
    '<tr><td style="padding:0 28px"><table width="100%" style="background:#f4f7fb;border-radius:6px"><tr>' +
      [['STRUCTURAL / PIPE', money(mat)], ['FITTINGS', money(fit)], ['SHIPPING', money(d.shipping)], ['MISC', money(d.misc)], ['LEAD TIME', d.lead_time || '']]
        .filter(([k]) => k !== 'FITTINGS' || d.fittings.length)
        .map(([k, v]) => '<td style="padding:10px 12px;font-size:11px;color:#7a8a99">' + k + '<div style="font-size:14px;color:#1f2d3d;font-weight:700">' + esc(v) + '</div></td>').join('') +
    '</tr></table></td></tr>' +
    (d.lines.length ? '<tr><td style="padding:12px 28px 0">' + tbl('<tr style="background:#eef2f7">' + th('#') + th('STRUCTURAL / PIPE') + th('QTY') + th('STATUS') + th('LINE TOTAL') + '</tr>', sRows) + '</td></tr>' : '') +
    (d.fittings.length ? '<tr><td style="padding:12px 28px 0">' + tbl('<tr style="background:#eef2f7">' + th('#') + th('FITTING') + th('QTY') + th('STATUS') + th('UNIT') + th('LINE TOTAL') + '</tr>', fRows) + '</td></tr>' : '') +
    '<tr><td style="padding:12px 28px"><table width="100%"><tr><td style="text-align:right;font-size:12px;color:#55677a">Quote total (incl. shipping &amp; misc.)</td><td style="text-align:right;font-size:18px;font-weight:700;width:150px">' + money(total) + '</td></tr></table>' +
      (d.notes ? '<div style="margin-top:8px;font-size:13px"><b>Notes:</b> ' + esc(d.notes) + '</div>' : '') +
      '<div style="background:#fff8e6;border-top:2px solid #f0ad4e;padding:12px 16px;font-size:13px;margin-top:12px">' +
      (copy ? '<b>For your records</b><br>If anything above is not what you quoted, submit a revised quote for <b>' + esc(d.quote_number) + '</b>. You will be notified if the manufacturer awards any lines.'
            : '<b>Next steps</b><br>Open <b>' + esc(d.quote_number) + '</b> in Material Compass. Check any altered or not-quoted lines, then compare with your other suppliers before awarding.') +
      '</div></td></tr>';
  const html = frame(copy ? 'QUOTE SUBMITTED' : 'SUPPLIER QUOTE RECEIVED',
    copy ? 'A copy of your quote to ' + esc(d.manufacturer) + ', as recorded in Material Compass.' : esc(sup.name) + ' has responded to your request for quote. Review it before awarding.',
    BLUE, [['RFQ NUMBER', d.quote_number], ['SUPPLIER QUOTE #', d.supplier_quote_number], ['VALID UNTIL', d.valid_until, true]], body);
  const subject = copy ? 'Your quote for ' + d.quote_number + ' - ' + money(total) + ' (copy)'
    : sup.name + ' quoted ' + d.quote_number + ' - ' + money(total);
  return { subject, html, total };
}

// Material Compass is the real sender (Zoho's copies are switched off) vs. test copies only.
const live = () => configured() && process.env.RFQ_EMAIL_LIVE === '1' && !process.env.MAIL_TEST_TO;
const testing = () => configured() && !live() && !!process.env.MAIL_TEST_TO;

module.exports = { send, configured, live, testing, rfqEmail, mfgSentEmail, noMatchEmail, quoteReceivedEmail, esc };
