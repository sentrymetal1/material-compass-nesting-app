// =============================================================================
//  suppliers/claim.js — a shop's material suppliers, and inviting its own suppliers to claim
//  their Material Compass account (setup checklist step 4).
// -----------------------------------------------------------------------------
//    GET  /api/mfg/suppliers                   the shop's suppliers (+ contacts of its own suppliers)
//    POST /api/mfg/suppliers/invite            { supplier_id, rep_id } email that contact an invite
//    GET  /api/suppliers/claim?c=              the invitee's view (signed link, no login)
//    POST /api/suppliers/claim { c }           accept: the contact gets a login on that supplier
//
//  A shop's "own" supplier (added with Add Outside Supplier) is a Supplier_Entry_Form record with
//  Register = "No": it gets EVERY line of an RFQ by email. CLAIMING gives one of its contacts a login:
//    - their email is added to Supplier_Entry_Form.Account_User_Email (how the supplier portal finds
//      the supplier for a login),
//    - their Supplier_Representatives record gets Admin_Email (how Zoho pages find it) and
//      Grant_Portal_Login = true, which the Zoho workflow "Grant Supplier Login" turns into a portal
//      invite (profile "Suppliers - Admin POC") and resets.
//  Register stays "No". Setting it to "Yes" switches the supplier to stock-list matching (only lines
//  it stocks, and matches with every shop); a just-claimed supplier has no stock list, so the shop
//  that invited it would stop reaching it. Moving to stock matching is a later, separate step.
//
//  The claim link is signed with MC_TOKEN_SECRET: <rep id>.<supplier id>.<expiry ms>.<sig>, 30 days.
//
//  REP vs ADMIN (Mark, 2026-11-21). A shop invites the salesperson it buys from, who is rarely the person
//  who should control the supplier's account. So a claim from a shop's invite gives a REP login (portal
//  profile "Suppliers"). The company ADMIN ("Suppliers - Admin POC": people, profile, stock list) is
//  claimed separately, through a link sent ONLY to the supplier's main company email
//  (Supplier_Entry_Form.Email), whose page stops anyone not authorized. The admin login is that company
//  mailbox, not a person, so it survives staff turnover. When the main email IS the rep's own email (a
//  one-person supplier, or a record created without a company email), the rep becomes admin directly.
//  A new admin link can always be requested to the main email (recovery); claiming it replaces the admin.
//    GET  /api/suppliers/admin-claim?c=     POST /api/suppliers/admin-claim { c, name, title, confirm }
//    POST /api/suppliers/admin-link { supplier_id }   (re)send the admin link to the main email only
// =============================================================================
const axios = require('axios');
const crypto = require('crypto');
const mailer = require('../mailer');
const { readJson, writeJson } = require('../filestore');

const MATCH_REPORT = 'All_Supplier_Manufacture_Matches';
const SUP_REPORT = 'Supplier_Entry_Report';
const REP_REPORT = 'API_Supplier_Reps';   // unfiltered (All_Supplier_Representatives hides the reps Add Outside Supplier creates)
const CLAIM_DAYS = 30;
const INVITES = 'supplier-invites.json';
const ADMINS = 'supplier-admins.json';
const ADMIN_DAYS = 30;
const PUBLIC_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mail|gmx|comcast|verizon|att|sbcglobal|bellsouth|charter|cox|earthlink|protonmail|proton|zoho)\.[a-z.]+$/i;

const s = (v) => (v == null ? '' : String(v)).trim();
const lc = (v) => s(v).toLowerCase();
const idOf = (v) => (v && typeof v === 'object' ? s(v.ID) : s(v));
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v));
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const emails = (v) => String(v || '').split(/[,;\s]+/).map(lc).filter(Boolean);

// ---------- signed claim link (pure, tested) ----------------------------------------------------
const secret = () => process.env.MC_TOKEN_SECRET || '';
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (rep, sup, exp) => b64u(crypto.createHmac('sha256', secret()).update('sc' + rep + '.' + sup + '.' + exp).digest());
function makeClaimToken(repId, supId, now) {
  const exp = (now || Date.now()) + CLAIM_DAYS * 86400000;
  return repId + '.' + supId + '.' + exp + '.' + sign(repId, supId, exp);
}
function readClaimToken(tok, now) {
  if (secret().length < 32) return { error: 'not_configured' };
  const m = /^(\d{6,25})\.(\d{6,25})\.(\d{10,16})\.([A-Za-z0-9_-]+)$/.exec(s(tok));
  if (!m) return { error: 'malformed' };
  const a = Buffer.from(sign(m[1], m[2], m[3])), b = Buffer.from(m[4]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'bad_signature' };
  if ((now || Date.now()) > Number(m[3])) return { error: 'expired' };
  return { repId: m[1], supId: m[2] };
}
// Admin link: <supplier id>.<base64url(main email)>.<expiry ms>.<sig>. Only ever sent to that email.
const signA = (sup, em, exp) => b64u(crypto.createHmac('sha256', secret()).update('sa' + sup + '.' + em + '.' + exp).digest());
function makeAdminToken(supId, email, now) {
  const exp = (now || Date.now()) + ADMIN_DAYS * 86400000;
  const em = b64u(Buffer.from(lc(email)));
  return supId + '.' + em + '.' + exp + '.' + signA(supId, em, exp);
}
function readAdminToken(tok, now) {
  if (secret().length < 32) return { error: 'not_configured' };
  const m = /^(\d{6,25})\.([A-Za-z0-9_-]+)\.(\d{10,16})\.([A-Za-z0-9_-]+)$/.exec(s(tok));
  if (!m) return { error: 'malformed' };
  const a = Buffer.from(signA(m[1], m[2], m[3])), b = Buffer.from(m[4]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'bad_signature' };
  if ((now || Date.now()) > Number(m[3])) return { error: 'expired' };
  return { supId: m[1], email: Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') };
}
const looksPersonal = (email) => PUBLIC_MAIL.test(lc(email));

// "a@x.com, b@x.com" + "c@x.com" -> "a@x.com,b@x.com,c@x.com" (once, case-insensitive)
function addEmail(list, email) {
  const have = emails(list);
  if (have.includes(lc(email))) return { value: String(list || ''), added: false };
  return { value: have.concat([lc(email)]).join(','), added: true };
}

function inviteEmail(shopName, sup, rep, link) {
  const esc = mailer.esc, BLUE = '#5286B4';
  const logo = process.env.MC_LOGO_URL || 'https://material-compass-nesting-app-production.up.railway.app/brand/mc-compass.png';
  const html = '<!DOCTYPE html><html><body style="margin:0;background:#eef2f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2d3d">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0"><tr><td align="center">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #d9e2ec">' +
    '<tr><td style="padding:18px 28px"><img src="' + esc(logo) + '" alt="" width="46" height="46" style="vertical-align:middle"> ' +
    '<span style="font-family:Georgia,serif;font-size:18px;letter-spacing:4px;color:' + BLUE + ';vertical-align:middle">MATERIAL COMPASS</span></td></tr>' +
    '<tr><td style="background:' + BLUE + ';color:#fff;padding:18px 28px"><div style="font-size:21px;font-weight:700">' + esc(shopName) + ' invited ' + esc(sup.name) + ' to Material Compass</div>' +
    '<div style="font-size:13px;opacity:.92">Free for suppliers during early access</div></td></tr>' +
    '<tr><td style="padding:20px 28px;font-size:14.5px;line-height:1.6">Hi ' + esc(rep.first || 'there') + ',<br><br>' +
    esc(shopName) + ' sends you material quote requests through Material Compass. Today they reach you by email. ' +
    'With your own login you can also:<ul style="margin:8px 0 0 18px;padding:0">' +
    '<li>see every request from ' + esc(shopName) + ' in one place and price it online,</li>' +
    '<li>keep your company details and contacts current,</li>' +
    '<li>later, list what you stock so matching requests find you.</li></ul>' +
    '<div style="margin-top:10px">You will still get every request by email, as now.</div></td></tr>' +
    '<tr><td style="padding:4px 28px 18px" align="center"><a href="' + esc(link) + '" style="display:inline-block;background:' + BLUE + ';color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:6px;font-size:15px">Claim ' + esc(sup.name) + '</a></td></tr>' +
    '<tr><td style="padding:0 28px 14px;font-size:12px;color:#7a8a99">Button not working? Copy this link into your browser:<br><span style="color:#1f2d3d;word-break:break-all">' + esc(link) + '</span></td></tr>' +
    '<tr><td style="padding:0 28px 18px;font-size:12px;color:#7a8a99">This invite is for ' + esc(rep.email) + ' and expires in ' + CLAIM_DAYS + ' days. If you were not expecting it, you can ignore this email.</td></tr>' +
    '<tr><td style="padding:12px 28px;background:#f4f6f8;font-size:11px;color:#7a8a99">Sent by Material Compass on behalf of ' + esc(shopName) + '.</td></tr>' +
    '</table></td></tr></table></body></html>';
  const text = 'Hi ' + (rep.first || 'there') + ',\n\n' + shopName + ' sends you material quote requests through Material Compass and has invited ' + sup.name +
    ' to claim its free supplier login, to see and price requests online.\n\nClaim it here: ' + link + '\n\nYou will still get every request by email. This invite expires in ' + CLAIM_DAYS + ' days.';
  return { subject: shopName + ' invited you to Material Compass', html, text };
}

// To the supplier's MAIN company email: a rep claimed a login; the company has no administrator yet.
function companyNotice(sup, rep, shopName, link) {
  const esc = mailer.esc, BLUE = '#5286B4', RED = '#b42318';
  const logo = process.env.MC_LOGO_URL || 'https://material-compass-nesting-app-production.up.railway.app/brand/mc-compass.png';
  const who = rep ? esc(rep.name || rep.email) + ' (' + esc(rep.email) + ')' : '';
  const html = '<!DOCTYPE html><html><body style="margin:0;background:#eef2f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2d3d">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0"><tr><td align="center">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #d9e2ec">' +
    '<tr><td style="padding:18px 28px"><img src="' + esc(logo) + '" alt="" width="46" height="46" style="vertical-align:middle"> ' +
    '<span style="font-family:Georgia,serif;font-size:18px;letter-spacing:4px;color:' + BLUE + ';vertical-align:middle">MATERIAL COMPASS</span></td></tr>' +
    '<tr><td style="background:' + BLUE + ';color:#fff;padding:18px 28px"><div style="font-size:20px;font-weight:700">' + esc(sup.name) + ' on Material Compass</div>' +
    '<div style="font-size:13px;opacity:.92">Your company account has no administrator yet</div></td></tr>' +
    '<tr><td style="padding:18px 28px 6px"><div style="border:2px solid ' + RED + ';background:#fff4f2;border-radius:8px;padding:12px 14px;font-size:14px;color:' + RED + ';line-height:1.5">' +
    '<b>Only for the person who manages ' + esc(sup.name) + '\'s account</b> (owner, manager or office lead).<br>If that is not you, forward this email to them. Do not continue.</div></td></tr>' +
    '<tr><td style="padding:12px 28px;font-size:14.5px;line-height:1.6">' +
    (rep ? who + ' claimed a Material Compass login for ' + esc(sup.name) + (shopName ? ', invited by your customer ' + esc(shopName) : '') + '. They can see and price quote requests. ' : '') +
    'Nobody manages your company\'s account yet. The administrator controls who at ' + esc(sup.name) + ' can use Material Compass, your company profile and your stock list.' +
    '<div style="margin-top:8px">The administrator login will be <b>this mailbox</b>, so it stays with your company when people change jobs.</div></td></tr>' +
    '<tr><td style="padding:6px 28px 18px" align="center"><a href="' + esc(link) + '" style="display:inline-block;background:' + BLUE + ';color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:6px;font-size:15px">Become your company\'s administrator</a></td></tr>' +
    '<tr><td style="padding:0 28px 18px;font-size:12px;color:#7a8a99">Not right, or someone at your company should not have access? Reply to this email and we will help. This link expires in ' + ADMIN_DAYS + ' days.</td></tr>' +
    '<tr><td style="padding:12px 28px;background:#f4f6f8;font-size:11px;color:#7a8a99">Sent by Material Compass.</td></tr>' +
    '</table></td></tr></table></body></html>';
  const text = 'ONLY FOR THE PERSON WHO MANAGES ' + sup.name.toUpperCase() + "'S ACCOUNT. If that is not you, forward this email to them. Do not continue.\n\n" +
    (rep ? (rep.name || rep.email) + ' (' + rep.email + ') claimed a Material Compass login for ' + sup.name + (shopName ? ', invited by ' + shopName : '') + '.\n' : '') +
    'Nobody manages your company account yet. The administrator login will be this mailbox.\n\nBecome the administrator: ' + link;
  return { subject: sup.name + ': your Material Compass account needs an administrator', html, text };
}

// ---------- routes -----------------------------------------------------------------------------
function registerSupplierClaim(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages } = deps;
  const enc = encodeURIComponent;
  const hdr = async () => ({ headers: zohoHeaders(await getAccessToken()), validateStatus: () => true });
  const publicBase = (req) => process.env.PUBLIC_BASE_URL || ('https://' + req.get('host'));
  function shopOf(req) {
    if (req.tenant && req.tenant.kind === 'm') return s(req.tenant.id);
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    return s((req.query && req.query.manufacturer_id) || b.manufacturer_id);
  }
  const rows = (p) => fetchAllZohoPages(p).catch((e) => {
    const d = e.response && e.response.data;
    if (d && /9220|9280/.test(JSON.stringify(d))) return [];
    throw e;
  });
  const fail = (res, e) => {
    console.error('[suppliers]', e && e.response ? JSON.stringify(e.response.data).slice(0, 400) : (e && e.stack) || e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  };
  const loadInvites = () => readJson(INVITES, {}) || {};
  async function shopInfo(mfg) {
    const r = await axios.get(creatorApiBase() + '/report/Customer_Entry_Report/' + mfg, await hdr());
    const d = (r.data && r.data.data) || {};
    return { name: s(d.Company_Name) || 'Your customer', email: EMAIL_RE.test(lc(d.Email)) ? lc(d.Email) : '' };
  }
  const supById = async (id) => {
    const r = await axios.get(creatorApiBase() + '/report/' + SUP_REPORT + '/' + id, await hdr());
    return (r.data && r.data.data && r.data.data.ID) ? r.data.data : null;
  };
  const repById = async (id) => {
    const r = await axios.get(creatorApiBase() + '/report/' + REP_REPORT + '/' + id, await hdr());
    return (r.data && r.data.data && r.data.data.ID) ? r.data.data : null;
  };
  const repOut = (r) => ({ id: s(r.ID), name: s(r.Name && r.Name.zc_display_value) || (s(r.Name && r.Name.first_name) + ' ' + s(r.Name && r.Name.last_name)).trim(),
    first: s(r.Name && r.Name.first_name), email: lc(r.Email), position: s(r.Position) });

  // The shop's suppliers: matched (on the platform) and its own (email only), with the contacts of its own.
  app.get('/api/mfg/suppliers', async (req, res) => {
    const mfg = shopOf(req);
    if (!/^\d{6,25}$/.test(mfg)) return res.status(400).json({ ok: false, error: 'Open this page from Material Compass.' });
    try {
      const [matches, dir] = await Promise.all([
        rows('/report/' + MATCH_REPORT + '?criteria=' + enc('(MANUFACTURE == ' + mfg + ')')),
        rows('/report/' + SUP_REPORT),
      ]);
      const byId = new Map(dir.map((d) => [s(d.ID), d]));
      const mine = matches.filter((m) => idOf(m.SUPPLIER) && !truthy(m.Hide_Supplier_From_Matching));
      const ownIds = mine.map((m) => idOf(m.SUPPLIER)).filter((id) => /^no$/i.test(s((byId.get(id) || {}).Register)));
      const reps = ownIds.length ? await rows('/report/' + REP_REPORT) : [];
      const inv = loadInvites();
      const list = mine.map((m) => {
        const id = idOf(m.SUPPLIER), d = byId.get(id) || {};
        const own = /^no$/i.test(s(d.Register));
        const logins = emails(d.Account_User_Email);
        const contacts = own ? reps.filter((r) => idOf(r.Supplier_Entry_Form) === id).map(repOut).map((c) => Object.assign(c, {
          has_login: logins.includes(c.email) && !!(inv[id] && inv[id][c.id] && inv[id][c.id].claimed),
          invited: (inv[id] && inv[id][c.id] && inv[id][c.id].sent) || '',
        })) : [];
        return { id, name: s(d.Company_Name) || s(m.SUPPLIER && m.SUPPLIER.zc_display_value) || 'Supplier', own,
          city: s(d.Address && d.Address.district_city), state: s(d.Address && d.Address.state_province),
          material: s(d.Type_Of_Material_Serviced), email: s(d.Email), contacts };
      }).sort((a, b) => (a.own === b.own ? a.name.localeCompare(b.name) : (a.own ? -1 : 1)));
      res.json({ ok: true, suppliers: list });
    } catch (e) { fail(res, e); }
  });

  // Invite one contact of one of the shop's OWN suppliers to claim it.
  app.post('/api/mfg/suppliers/invite', async (req, res) => {
    const mfg = shopOf(req), b = req.body || {};
    const supId = s(b.supplier_id), repId = s(b.rep_id);
    if (!/^\d{6,25}$/.test(mfg) || !/^\d{6,25}$/.test(supId) || !/^\d{6,25}$/.test(repId)) return res.status(400).json({ ok: false, error: 'Open this page from Material Compass.' });
    try {
      const matches = await rows('/report/' + MATCH_REPORT + '?criteria=' + enc('(MANUFACTURE == ' + mfg + ')'));
      if (!matches.some((m) => idOf(m.SUPPLIER) === supId)) return res.status(404).json({ ok: false, error: 'That supplier is not one of yours. Reload the page.' });
      const [sup, rep] = await Promise.all([supById(supId), repById(repId)]);
      if (!sup || !rep || idOf(rep.Supplier_Entry_Form) !== supId) return res.status(404).json({ ok: false, error: 'That contact is not with this supplier. Reload the page.' });
      if (!/^no$/i.test(s(sup.Register))) return res.status(400).json({ ok: false, error: s(sup.Company_Name) + ' is already on Material Compass.' });
      const r = repOut(rep);
      if (!EMAIL_RE.test(r.email)) return res.status(400).json({ ok: false, error: 'This contact has no valid email.' });
      const shop = await shopInfo(mfg);
      const link = publicBase(req) + '/takeoff/supplier-claim.html?c=' + enc(makeClaimToken(repId, supId));
      const m = inviteEmail(shop.name, { name: s(sup.Company_Name) }, r, link);
      const msg = { to: r.email, subject: m.subject, html: m.html, text: m.text };
      if (shop.email) msg.replyTo = shop.email;
      const sent = await mailer.send(msg);
      if (!sent.ok) return res.status(502).json({ ok: false, error: 'The email did not send. Please try again in a few minutes.' });
      const inv = loadInvites();
      inv[supId] = inv[supId] || {};
      inv[supId][repId] = Object.assign(inv[supId][repId] || {}, { sent: new Date().toISOString(), by: mfg, email: r.email });
      writeJson(INVITES, inv);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---- the invitee (signed link) ----
  const MSG = {
    expired: 'This invite has expired. Ask your customer to send a new one.',
    gone: 'This invite is no longer valid. Ask your customer to send a new one.',
    malformed: 'This link is not complete. Open it again from the invite email.',
    bad_signature: 'This link is not complete. Open it again from the invite email.',
    not_configured: 'Invites are not available right now. Please try again later.',
  };
  async function claimOf(c) {
    const t = readClaimToken(c);
    if (t.error) return { error: MSG[t.error] || MSG.gone };
    const [sup, rep] = await Promise.all([supById(t.supId), repById(t.repId)]);
    if (!sup || !rep || idOf(rep.Supplier_Entry_Form) !== t.supId) return { error: MSG.gone };
    return { sup, rep: repOut(rep), supId: t.supId, repId: t.repId };
  }
  app.get('/api/suppliers/claim', async (req, res) => {
    try {
      const c = await claimOf(req.query.c);
      if (c.error) return res.json({ ok: false, error: c.error });
      const inv = (loadInvites()[c.supId] || {})[c.repId] || {};
      const a = c.sup.Address || {};
      res.json({ ok: true, supplier: { name: s(c.sup.Company_Name), address: s(a.zc_display_value), phone: s(c.sup.Phone_Number) },
        contact: { first: c.rep.first, name: c.rep.name, email: c.rep.email }, claimed: !!inv.claimed,
        invited_by: inv.by ? (await shopInfo(inv.by)).name : '' });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/suppliers/claim', async (req, res) => {
    try {
      const c = await claimOf((req.body || {}).c);
      if (c.error) return res.json({ ok: false, error: c.error });
      const inv = loadInvites();
      const mine = (inv[c.supId] = inv[c.supId] || {})[c.repId] = (inv[c.supId][c.repId] || {});
      if (!mine.claimed) {
        // 1) the login email on the supplier record (supplier portal)
        const add = addEmail(c.sup.Account_User_Email, c.rep.email);
        if (add.added) {
          const r1 = await axios.patch(creatorApiBase() + '/report/' + SUP_REPORT + '/' + c.supId, { data: { Account_User_Email: add.value } }, await hdr());
          if (!r1.data || r1.data.code !== 3000) throw new Error('supplier patch ' + JSON.stringify(r1.data).slice(0, 200));
        }
        // 2) the rep: Admin_Email (Zoho pages) + Grant_Portal_Login (the Zoho workflow invites them to the
        //    portal as a REP). If the company's main email IS this rep's email, they are the company: admin.
        const admins = readJson(ADMINS, {}) || {};
        const main = lc(c.sup.Email);
        const selfAdmin = !admins[c.supId] && main && main === c.rep.email;
        const r2 = await axios.patch(creatorApiBase() + '/report/' + REP_REPORT + '/' + c.repId,
          { data: Object.assign({ Admin_Email: c.rep.email, Grant_Portal_Login: 'true' }, selfAdmin ? { Grant_Portal_Admin: 'true' } : {}) }, await hdr());
        if (!r2.data || r2.data.code !== 3000) throw new Error('rep patch ' + JSON.stringify(r2.data).slice(0, 200));
        mine.claimed = new Date().toISOString();
        writeJson(INVITES, inv);
        if (selfAdmin) {
          admins[c.supId] = { email: main, name: c.rep.name, title: '', rep_id: c.repId, at: mine.claimed, how: 'main email is the rep' };
          writeJson(ADMINS, admins);
        } else if (!admins[c.supId] && EMAIL_RE.test(main)) {
          // 3) tell the company (main email only) that a rep is in and nobody manages the account yet
          const shopName = mine.by ? (await shopInfo(mine.by)).name : '';
          const link = publicBase(req) + '/takeoff/supplier-admin.html?c=' + enc(makeAdminToken(c.supId, main));
          const n = companyNotice({ name: s(c.sup.Company_Name) }, c.rep, shopName, link);
          mailer.send({ to: main, subject: n.subject, html: n.html, text: n.text, replyTo: process.env.MC_SUPPORT_EMAIL || 'admin@materialcompass.us' }).catch(() => {});
          admins._notice = admins._notice || {}; admins._notice[c.supId] = mine.claimed; writeJson(ADMINS, admins);
        }
        const to = process.env.MC_APPROVALS_TO || 'admin@materialcompass.us';
        const esc = mailer.esc;
        mailer.send({ to, subject: 'Approve supplier portal login: ' + c.rep.name + ' (' + s(c.sup.Company_Name) + ')',
          html: '<p><b>' + esc(c.rep.name) + '</b> (' + esc(c.rep.email) + ') claimed supplier <b>' + esc(s(c.sup.Company_Name)) + '</b>.</p>' +
            '<p>Approve their portal sign-up request: Zoho Creator › Settings › Users &amp; Control › Portal Users › pending requests › Approve.</p>' +
            '<p>Their email is on the supplier\'s login list and their rep has Admin_Email set. Register stays "No" (all RFQ lines by email).</p>',
          text: c.rep.name + ' (' + c.rep.email + ') claimed supplier ' + s(c.sup.Company_Name) + '. Approve their portal sign-up request in Zoho Creator.' }).catch(() => {});
      }
      const ad = (readJson(ADMINS, {}) || {})[c.supId];
      res.json({ ok: true, email: c.rep.email, supplier: s(c.sup.Company_Name), is_admin: !!(ad && ad.email === c.rep.email) });
    } catch (e) { fail(res, e); }
  });

  // ---- company administrator (link sent only to the supplier's main email) ----
  async function adminOf(c) {
    const t = readAdminToken(c);
    if (t.error) return { error: MSG[t.error] || MSG.gone };
    const sup = await supById(t.supId);
    if (!sup) return { error: MSG.gone };
    // The link names the main email it was sent to; if the company has changed its main email since, it is void.
    if (lc(sup.Email) !== lc(t.email)) return { error: 'This link was sent to an email that is no longer your company\'s main email. Request a new one below.' , supId: t.supId };
    return { sup, supId: t.supId, email: lc(t.email) };
  }
  app.get('/api/suppliers/admin-claim', async (req, res) => {
    try {
      const a = await adminOf(req.query.c);
      if (a.error) return res.json({ ok: false, error: a.error, supplier_id: a.supId || '' });
      const cur = (readJson(ADMINS, {}) || {})[a.supId] || null;
      const addr = a.sup.Address || {};
      res.json({ ok: true, supplier: { id: a.supId, name: s(a.sup.Company_Name), address: s(addr.zc_display_value) }, email: a.email,
        personal: looksPersonal(a.email), current_admin: cur ? { name: cur.name, title: cur.title, email: cur.email, at: cur.at, same: cur.email === a.email } : null });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/suppliers/admin-claim', async (req, res) => {
    try {
      const b = req.body || {};
      const a = await adminOf(b.c);
      if (a.error) return res.json({ ok: false, error: a.error });
      const name = s(b.name).slice(0, 80), title = s(b.title).slice(0, 80);
      if (!b.confirm) return res.json({ ok: false, error: 'Tick the box to confirm you are authorized to manage your company\'s account.' });
      if (!name) return res.json({ ok: false, error: 'Enter your name.' });
      if (!title) return res.json({ ok: false, error: 'Enter your title.' });
      // The admin's rep record: the one with the main email, else a new one at the supplier's first location.
      const reps = await rows('/report/' + REP_REPORT + '?criteria=' + enc('(Supplier_Entry_Form == ' + a.supId + ')'));
      let rep = reps.find((r) => lc(r.Email) === a.email);
      const parts = name.split(/\s+/);
      if (rep) {
        const r = await axios.patch(creatorApiBase() + '/report/' + REP_REPORT + '/' + rep.ID, { data: { Admin_Email: a.email, Grant_Portal_Admin: 'true' } }, await hdr());
        if (!r.data || r.data.code !== 3000) throw new Error('admin rep patch ' + JSON.stringify(r.data).slice(0, 200));
      } else {
        const loc = reps.map((r) => (Array.isArray(r.Supplier_Locations) ? r.Supplier_Locations : (r.Supplier_Locations ? [r.Supplier_Locations] : [])).map(idOf)).flat().find(Boolean);
        if (!loc) return res.json({ ok: false, error: 'Your company record is missing a location. Reply to the email and we will finish this for you.' });
        const r = await axios.post(creatorApiBase() + '/form/Supplier_Representatives', { data: { Supplier_Entry_Form: a.supId, Supplier_Locations: [loc],
          Name: { first_name: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0], last_name: parts.length > 1 ? parts[parts.length - 1] : '' },
          Email: a.email, Admin_Email: a.email, Grant_Portal_Admin: 'true' } }, await hdr());
        if (!r.data || r.data.code !== 3000) throw new Error('admin rep insert ' + JSON.stringify(r.data).slice(0, 300));
        rep = { ID: r.data.data.ID };
      }
      const add = addEmail(a.sup.Account_User_Email, a.email);
      if (add.added) {
        const r1 = await axios.patch(creatorApiBase() + '/report/' + SUP_REPORT + '/' + a.supId, { data: { Account_User_Email: add.value } }, await hdr());
        if (!r1.data || r1.data.code !== 3000) throw new Error('supplier patch ' + JSON.stringify(r1.data).slice(0, 200));
      }
      const admins = readJson(ADMINS, {}) || {};
      const prev = admins[a.supId];
      admins[a.supId] = { email: a.email, name, title, rep_id: s(rep.ID), at: new Date().toISOString(), how: 'main email link', replaced: prev ? prev.email : undefined };
      writeJson(ADMINS, admins);
      const to = process.env.MC_APPROVALS_TO || 'admin@materialcompass.us';
      const esc = mailer.esc;
      mailer.send({ to, subject: 'Approve supplier ADMIN login: ' + name + ' (' + s(a.sup.Company_Name) + ')',
        html: '<p><b>' + esc(name) + '</b>, ' + esc(title) + ', is now the administrator of supplier <b>' + esc(s(a.sup.Company_Name)) + '</b>, with the company mailbox ' + esc(a.email) + '.</p>' +
          (prev ? '<p>This replaces the previous administrator ' + esc(prev.email) + '.</p>' : '') +
          '<p>Approve their portal sign-up request (profile Suppliers - Admin POC): Zoho Creator › Settings › Users &amp; Control › Portal Users.</p>',
        text: name + ' (' + title + ') is now administrator of supplier ' + s(a.sup.Company_Name) + ' (' + a.email + '). Approve their portal sign-up request.' }).catch(() => {});
      res.json({ ok: true, email: a.email, supplier: s(a.sup.Company_Name) });
    } catch (e) { fail(res, e); }
  });

  // (Re)send the admin link. It only ever goes to the supplier's MAIN email, so anyone may ask; once an hour.
  app.post('/api/suppliers/admin-link', async (req, res) => {
    try {
      const supId = s((req.body || {}).supplier_id);
      if (!/^\d{6,25}$/.test(supId)) return res.json({ ok: false, error: 'Open this page from the email you received.' });
      const sup = await supById(supId);
      const main = sup && lc(sup.Email);
      if (!sup || !EMAIL_RE.test(main)) return res.json({ ok: false, error: 'We could not find a company email to send it to. Reply to the email you received and we will help.' });
      const admins = readJson(ADMINS, {}) || {};
      admins._sent = admins._sent || {};
      if (admins._sent[supId] && Date.now() - Date.parse(admins._sent[supId]) < 3600 * 1000) return res.json({ ok: true, masked: main.replace(/^(.).*(@.*)$/, '$1•••$2') });
      const link = publicBase(req) + '/takeoff/supplier-admin.html?c=' + enc(makeAdminToken(supId, main));
      const n = companyNotice({ name: s(sup.Company_Name) }, null, '', link);
      const r = await mailer.send({ to: main, subject: n.subject, html: n.html, text: n.text, replyTo: process.env.MC_SUPPORT_EMAIL || 'admin@materialcompass.us' });
      if (!r.ok) return res.json({ ok: false, error: 'The email did not send. Please try again later.' });
      admins._sent[supId] = new Date().toISOString(); writeJson(ADMINS, admins);
      res.json({ ok: true, masked: main.replace(/^(.).*(@.*)$/, '$1•••$2') });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { registerSupplierClaim, makeClaimToken, readClaimToken, makeAdminToken, readAdminToken, looksPersonal, addEmail, inviteEmail, companyNotice };
