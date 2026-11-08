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
'<tr><td style="padding:18px 28px">' + '<img src="' + esc(LOGO) + '" alt="" height="34" style="vertical-align:middle"> <span style="font-weight:700;color:' + BLUE + ';letter-spacing:2px;vertical-align:middle">MATERIAL COMPASS</span>' + '</td></tr>' +
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

module.exports = { send, configured, rfqEmail, esc };
