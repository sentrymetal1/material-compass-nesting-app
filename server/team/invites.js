// =============================================================================
//  team/invites.js — a shop invites its team (plan: docs/TEAM_INVITES_PLAN.md).
// -----------------------------------------------------------------------------
//  Early access (Mark, 2026-11-18): $1 is per COMPANY; team seats are free, capped at 4 people per
//  shop including the admin. Nobody becomes an active representative without going through an
//  invite: the invite creates the Company_Representatives row with ACTIVE = NO and
//  Invite_Status = Invited. Only Accept on the join page sets ACTIVE = YES / Joined, and the Zoho
//  workflow on Company_Representatives then adds the email to the shop's Account_User_Email and
//  grants the portal login (profile "MFG - Representative").
//
//    Company_Representatives (report All_Company_Representatives)
//      Manufacture (shop), Name {first_name,last_name}, Email, Position, ACTIVE (YES/NO),
//      Employee_Status (Keep / Pause / Delete Employee on Platform), Invite_Status
//      (Invited / Joined / Cancel; blank = a rep from before invites = Joined), Invite_Sent.
//
//  The join link is signed with MC_TOKEN_SECRET: <rep id>.<expiry ms>.<sig>, 14 days. It names one
//  rep record; the email on that record is who joins.
//
//  SUPPLIERS use the same link and join page (2026-11-28). Their rep id carries an "s" in front
//  (s<id>.<exp>.<sig>) and names a Supplier_Representatives row (report API_Supplier_Representatives).
//  Invites are sent from the supplier's Profile tab (server/supplier.js). Accept sets Invite_Status =
//  Joined, Active = YES and ticks Grant_Portal_Login; the Zoho workflow Grant Supplier Login adds the
//  email to the supplier's Account_User_Email and gives the portal login (profile "Suppliers").
// =============================================================================
const axios = require('axios');
const crypto = require('crypto');
const mailer = require('../mailer');

const REP_REPORT = 'All_Company_Representatives';
const REP_FORM = 'Company_Representatives';
const MFG_REPORT = 'Customer_Entry_Report';
const SUP_REP_REPORT = 'API_Supplier_Representatives';
const CAP = 4;                                   // admin + 3, early access
const INVITE_DAYS = 14;
const POSITIONS = ['Administrator', 'Estimator', 'Project Manager', 'Purchasing', 'Production Manager', 'Accounting'];

const enc = encodeURIComponent;
const s = (v) => (v == null ? '' : String(v)).trim();
const idOf = (v) => (v && typeof v === 'object' ? s(v.ID) : s(v));
const lc = (v) => s(v).toLowerCase();
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// ---------- pure helpers (tested) ----------------------------------------------------------
function statusOf(r) {
  const st = s(r.Invite_Status);
  if (/^cancel/i.test(st)) return 'Cancelled';   // the Zoho choice is "Cancel"
  if (st) return st;                         // Invited / Joined
  return 'Joined';                           // reps from before invites
}
// A seat is taken by everyone not cancelled and not deleted from the platform.
function takesSeat(r) {
  return statusOf(r) !== 'Cancelled' && !/^delete/i.test(s(r.Employee_Status));
}
function repOut(r) {
  const n = r.Name || {};
  return {
    id: s(r.ID),
    first: s(n.first_name), last: s(n.last_name),
    name: s(n.zc_display_value) || (s(n.first_name) + ' ' + s(n.last_name)).trim(),
    email: s(r.Email), position: s(r.Position),
    active: s(r.ACTIVE).toUpperCase() === 'YES',
    status: statusOf(r), employee_status: s(r.Employee_Status),
    invite_sent: s(r.Invite_Sent),
  };
}
// A supplier rep, in the shape the join routes use. Supplier reps keep Active (not ACTIVE).
function supRepOut(r) {
  const o = repOut(Object.assign({}, r, { ACTIVE: r.Active }));
  o.id = 's' + o.id;
  return o;
}
const secret = () => process.env.MC_TOKEN_SECRET || '';
function sign(repId, exp) {
  const payload = 'i' + repId + '.' + exp;
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJoinToken(repId, now) {
  const exp = (now || Date.now()) + INVITE_DAYS * 86400000;
  return repId + '.' + exp + '.' + sign(repId, exp);
}
// -> { repId, exp } | { error }
function readJoinToken(tok, now) {
  if (secret().length < 32) return { error: 'not_configured' };
  const m = /^(s?\d{6,25})\.(\d{10,16})\.([A-Za-z0-9_-]+)$/.exec(s(tok));
  if (!m) return { error: 'malformed' };
  const want = sign(m[1], m[2]);
  const a = Buffer.from(want), b = Buffer.from(m[3]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'bad_signature' };
  if ((now || Date.now()) > Number(m[2])) return { error: 'expired', repId: m[1] };
  return { repId: m[1], exp: Number(m[2]) };
}
// The location new reps get: the Administrator's, else any rep's. Location is a multi lookup.
function defaultLocation(shopReps) {
  const ids = (r) => (Array.isArray(r.Location) ? r.Location : (r.Location ? [r.Location] : [])).map(idOf).filter(Boolean);
  const admin = shopReps.find((r) => /administrator/i.test(s(r.Position)) && ids(r).length);
  const any = admin || shopReps.find((r) => ids(r).length);
  return any ? ids(any)[0] : '';
}
// Zoho date-time: "Nov 18,2026 10:05:00"
function zDateTime(d) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return M[d.getMonth()] + ' ' + p(d.getDate()) + ',' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
// Now as a wall-clock Date in the Zoho app's time zone (Railway runs in UTC).
function appNow() {
  const tz = process.env.ZOHO_TZ || 'America/New_York';
  try { return new Date(new Date().toLocaleString('en-US', { timeZone: tz })); } catch (e) { return new Date(); }
}
// Invite-time checks against the shop's reps and every other shop's. -> { error } | { reuse: rep|null }
function checkInvite(shopReps, otherReps, b) {
  const email = lc(b.email);
  if (!s(b.first) || !s(b.last)) return { error: 'Enter a first and last name.' };
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.' };
  // The portal refuses logins with a '+' in the address (Zoho: "Email address is invalid"), 2026-11-21.
  if (email.includes('+')) return { error: 'Logins cannot use an email with a "+" in it. Use their regular email address.' };
  if (POSITIONS.indexOf(s(b.position)) < 0) return { error: 'Pick a position from the list.' };
  const mine = shopReps.find((r) => lc(r.Email) === email);
  if (mine && statusOf(mine) === 'Invited') return { error: 'This person already has an invite. Use Resend on their row.' };
  if (mine && statusOf(mine) !== 'Cancelled') return { error: 'This person is already on your team.' };
  if (otherReps.some((r) => lc(r.Email) === email && takesSeat(r))) {
    return { error: 'This email is already used by another company on Material Compass. Use a different email.' };
  }
  if (shopReps.filter(takesSeat).length >= CAP) return { error: 'cap' };
  return { reuse: mine || null };
}

// ---------- email ----------------------------------------------------------------------------
function inviteEmail(shopName, rep, link, kind) {
  const esc = mailer.esc;
  const BLUE = '#5286B4';
  const logo = process.env.MC_LOGO_URL || 'https://material-compass-nesting-app-production.up.railway.app/brand/mc-compass.png';
  const html = '<!DOCTYPE html><html><body style="margin:0;background:#eef2f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2d3d">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0"><tr><td align="center">' +
    '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #d9e2ec">' +
    '<tr><td style="padding:18px 28px"><img src="' + esc(logo) + '" alt="" width="46" height="46" style="vertical-align:middle"> ' +
    '<span style="font-family:Georgia,serif;font-size:18px;letter-spacing:4px;color:' + BLUE + ';vertical-align:middle">MATERIAL COMPASS</span></td></tr>' +
    '<tr><td style="background:' + BLUE + ';color:#fff;padding:18px 28px"><div style="font-size:21px;font-weight:700">You\'re invited to join ' + esc(shopName) + '</div>' +
    '<div style="font-size:13px;opacity:.92">on Material Compass, as ' + esc(rep.position) + '</div></td></tr>' +
    '<tr><td style="padding:20px 28px;font-size:14.5px;line-height:1.6">Hi ' + esc(rep.first) + ',<br><br>' +
    esc(shopName) + (kind === 's' ? ' uses Material Compass to receive and answer quote requests from steel fabricators' : ' uses Material Compass for quoting, sourcing material and running work orders') + ', and has added you to their team. ' +
    'Click below to accept. You will then get a second email to set your password.</td></tr>' +
    '<tr><td style="padding:4px 28px 22px" align="center"><a href="' + esc(link) + '" style="display:inline-block;background:' + BLUE + ';color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:6px;font-size:15px">Join ' + esc(shopName) + '</a></td></tr>' +
    '<tr><td style="padding:0 28px 14px;font-size:12px;color:#7a8a99">Button not working? Copy this link into your browser:<br>' +
    '<span style="color:#1f2d3d;word-break:break-all">' + esc(link) + '</span></td></tr>' +
    '<tr><td style="padding:0 28px 18px;font-size:12px;color:#7a8a99">This invite is for ' + esc(rep.email) + ' and expires in ' + INVITE_DAYS + ' days. ' +
    'If you were not expecting it, you can ignore this email.</td></tr>' +
    '<tr><td style="padding:12px 28px;background:#f4f6f8;font-size:11px;color:#7a8a99">Sent by Material Compass on behalf of ' + esc(shopName) + '.</td></tr>' +
    '</table></td></tr></table></body></html>';
  const text = 'Hi ' + rep.first + ',\n\n' + shopName + ' has invited you to join their team on Material Compass as ' + rep.position +
    '.\n\nAccept here: ' + link + '\n\nYou will then get a second email to set your password. This invite expires in ' + INVITE_DAYS + ' days.';
  return { subject: shopName + ' invited you to Material Compass', html, text };
}

// ---------- routes ---------------------------------------------------------------------------
function registerTeamInvites(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages } = deps;
  const base = () => creatorApiBase();
  const hdr = async () => ({ headers: zohoHeaders(await getAccessToken()) });
  const publicBase = (req) => process.env.PUBLIC_BASE_URL || ('https://' + req.get('host'));

  function shopOf(req) {
    if (req.tenant && req.tenant.kind === 'm') return s(req.tenant.id);
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    return s((req.query && req.query.manufacturer_id) || b.manufacturer_id);
  }
  const allReps = () => fetchAllZohoPages('/report/' + REP_REPORT).catch((e) => {
    if (e.response && e.response.data && /9220|9280/.test(JSON.stringify(e.response.data))) return [];
    throw e;
  });
  const repsOfShop = (all, mfg) => all.filter((r) => idOf(r.Manufacture) === mfg);
  // The shop's name and its main email (replies to an invite go to the shop, not to no_reply).
  async function shopInfo(mfg) {
    try {
      const r = await axios.get(base() + '/report/' + MFG_REPORT + '/' + mfg, await hdr());
      const d = (r.data && r.data.data) || {};
      return { name: s(d.Company_Name) || 'Your company', email: EMAIL_RE.test(lc(d.Email)) ? lc(d.Email) : '' };
    } catch (e) { return { name: 'Your company', email: '' }; }
  }
  const shopName = async (mfg) => (await shopInfo(mfg)).name;
  async function patchRep(id, data) {
    const r = await axios.patch(base() + '/report/' + REP_REPORT + '/' + id, { data }, await hdr());
    if (r.data && r.data.code !== 3000) throw new Error('Zoho ' + JSON.stringify(r.data).slice(0, 300));
  }
  async function sendInvite(req, shop, rep) {
    const link = publicBase(req) + '/takeoff/join.html?i=' + enc(makeJoinToken(rep.id));
    const m = inviteEmail(shop.name, rep, link);
    const msg = { to: rep.email, subject: m.subject, html: m.html, text: m.text };
    if (shop.email) msg.replyTo = shop.email;
    const r = await mailer.send(msg);
    return r.ok ? null : (r.error || 'send failed');
  }
  const fail = (res, e, code) => {
    console.error('[team]', e && e.response ? JSON.stringify(e.response.data).slice(0, 400) : (e && e.message) || e);
    res.status(code || 500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  };

  // The shop's team, seats and positions.
  app.get('/api/team', async (req, res) => {
    const mfg = shopOf(req);
    if (!/^\d{6,25}$/.test(mfg)) return res.status(400).json({ ok: false, error: 'Open this page from Material Compass.' });
    try {
      const [all, name] = await Promise.all([allReps(), shopName(mfg)]);
      const mine = repsOfShop(all, mfg);
      const used = mine.filter(takesSeat).length;
      res.json({ ok: true, shop: { id: mfg, name }, cap: CAP, used, positions: POSITIONS,
        reps: mine.map(repOut).sort((a, b) => (a.status === 'Cancelled') - (b.status === 'Cancelled') || a.name.localeCompare(b.name)) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/team/invite', async (req, res) => {
    const mfg = shopOf(req), b = req.body || {};
    if (!/^\d{6,25}$/.test(mfg)) return res.status(400).json({ ok: false, error: 'Open this page from Material Compass.' });
    try {
      const all = await allReps();
      const mine = repsOfShop(all, mfg);
      const chk = checkInvite(mine, all.filter((r) => idOf(r.Manufacture) !== mfg), b);
      if (chk.error === 'cap') return res.status(409).json({ ok: false, cap: true, error: 'Your early-access plan includes ' + CAP + ' people, and all seats are in use. Contact us to add more seats.' });
      if (chk.error) return res.status(400).json({ ok: false, error: chk.error });
      const data = {
        Manufacture: mfg,
        Name: { first_name: s(b.first), last_name: s(b.last) },
        Email: lc(b.email), Position: s(b.position),
        ACTIVE: 'NO', Employee_Status: 'Keep Employee on Platform',
        Invite_Status: 'Invited', Invite_Sent: zDateTime(appNow()),
      };
      // Like the reps made at registration: Admin_Email = the shop's main email, Location = the
      // admin's location (first rep of the shop that has one).
      const shop = await shopInfo(mfg);
      if (shop.email) { data.Admin_Email = shop.email; data.Admin_Email_Format = shop.email; }   // text field + the email field shown on the form
      const loc = defaultLocation(mine);
      if (loc) data.Location = [loc];
      let id;
      if (chk.reuse) {
        id = s(chk.reuse.ID);
        await patchRep(id, data);
      } else {
        const r = await axios.post(base() + '/form/' + REP_FORM, { data }, await hdr());
        const d = r.data || {};
        id = s(d.data && d.data.ID);
        if (d.code !== 3000 || !id) throw new Error('Zoho insert ' + JSON.stringify(d).slice(0, 300));
      }
      const mailErr = await sendInvite(req, shop, { id, first: s(b.first), email: lc(b.email), position: s(b.position) });
      res.json({ ok: true, id, emailed: !mailErr,
        warning: mailErr ? 'The invite was saved but the email did not send. Use Resend on their row.' : '' });
    } catch (e) { fail(res, e); }
  });

  async function ownInvite(req, res) {
    const mfg = shopOf(req), id = s((req.body || {}).rep_id);
    if (!/^\d{6,25}$/.test(mfg) || !/^\d{6,25}$/.test(id)) { res.status(400).json({ ok: false, error: 'Open this page from Material Compass.' }); return null; }
    const all = await allReps();
    const rep = all.find((r) => s(r.ID) === id);
    if (!rep || idOf(rep.Manufacture) !== mfg) { res.status(404).json({ ok: false, error: 'That person is not on your team. Reload the page.' }); return null; }
    if (statusOf(rep) !== 'Invited') { res.status(400).json({ ok: false, error: 'Only a pending invite can be changed here.' }); return null; }
    return { mfg, rep };
  }

  app.post('/api/team/resend', async (req, res) => {
    try {
      const own = await ownInvite(req, res); if (!own) return;
      await patchRep(s(own.rep.ID), { Invite_Sent: zDateTime(appNow()) });
      const o = repOut(own.rep);
      const mailErr = await sendInvite(req, await shopInfo(own.mfg), o);
      if (mailErr) return res.status(502).json({ ok: false, error: 'The email did not send. Please try again in a few minutes.' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/team/cancel', async (req, res) => {
    try {
      const own = await ownInvite(req, res); if (!own) return;
      await patchRep(s(own.rep.ID), { Invite_Status: 'Cancel', ACTIVE: 'NO' });   // Zoho radio choice text
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---- join (the invitee; no tenant token — the signed invite link is the proof) ----
  async function inviteFrom(tok) {
    const t = readJoinToken(tok);
    if (t.error) return { error: t.error };
    if (t.repId[0] === 's') {
      const r = await axios.get(base() + '/report/' + SUP_REP_REPORT + '/' + t.repId.slice(1), await hdr()).catch(() => null);
      const rep = r && r.data && r.data.data;
      if (!rep || !rep.ID) return { error: 'gone' };
      const sup = rep.Supplier_Entry_Form || {};
      return { kind: 's', rep, o: supRepOut(rep), shopLabel: s(rep.Supplier_Company_Name) || s(sup.zc_display_value) || 'Your company' };
    }
    const r = await axios.get(base() + '/report/' + REP_REPORT + '/' + t.repId, await hdr()).catch(() => null);
    const rep = r && r.data && r.data.data;
    if (!rep || !rep.ID) return { error: 'gone' };
    return { kind: 'm', rep, o: repOut(rep), mfg: idOf(rep.Manufacture) };
  }
  const JOIN_MSG = {
    expired: 'This invite has expired. Ask your company to send a new one.',
    gone: 'This invite is no longer valid. Ask your company to send a new one.',
    malformed: 'This link is not complete. Open it again from the invite email.',
    bad_signature: 'This link is not complete. Open it again from the invite email.',
    not_configured: 'Invites are not available right now. Please try again later.',
  };

  app.get('/api/team/join', async (req, res) => {
    try {
      const inv = await inviteFrom(req.query.i);
      if (inv.error) return res.json({ ok: false, error: JOIN_MSG[inv.error] || JOIN_MSG.gone });
      const o = inv.o;
      if (o.status === 'Cancelled') return res.json({ ok: false, error: JOIN_MSG.gone });
      res.json({ ok: true, shop: inv.kind === 's' ? inv.shopLabel : await shopName(inv.mfg), first: o.first, email: o.email, position: o.position, joined: o.status === 'Joined' });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/team/join', async (req, res) => {
    try {
      const inv = await inviteFrom((req.body || {}).i);
      if (inv.error) return res.json({ ok: false, error: JOIN_MSG[inv.error] || JOIN_MSG.gone });
      const o = inv.o;
      if (o.status === 'Cancelled') return res.json({ ok: false, error: JOIN_MSG.gone });
      if (inv.kind === 's' && o.status !== 'Joined') {
        // Ticking Grant_Portal_Login runs the Zoho workflow Grant Supplier Login (login list + portal
        // login "Suppliers"), which unticks it again.
        const r = await axios.patch(base() + '/report/' + SUP_REP_REPORT + '/' + o.id.slice(1), { data: { Invite_Status: 'Joined', Active: 'YES', Grant_Portal_Login: true } }, await hdr());
        if (r.data && r.data.code !== 3000) throw new Error('Zoho ' + JSON.stringify(r.data).slice(0, 300));
      } else if (o.status !== 'Joined') {
        await patchRep(o.id, { Invite_Status: 'Joined', ACTIVE: 'YES' });
        // Saving Joined runs the Zoho workflow Grant_Login_On_Join: it adds the email to the shop's login
        // list and gives the portal login (portal is Public, so no approval). It emails the admin if Zoho refuses.
      }
      res.json({ ok: true, email: o.email });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { registerTeamInvites, defaultLocation, checkInvite, takesSeat, statusOf, makeJoinToken, readJoinToken, zDateTime, appNow, inviteEmail, CAP, POSITIONS, EMAIL_RE };
