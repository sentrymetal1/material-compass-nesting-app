// STRIPE WEBHOOK: a paid registration becomes a portal login with no one approving it.
//
//   SUBSCRIBE (Registration Form) → record saved → Stripe Payment Link opened with
//   client_reference_id = that Registration record's ID → customer pays →
//   Stripe POSTs checkout.session.completed here → we set the record's Profile_Status = "Subscribed" →
//   Zoho workflow on the Registration Form (Edited › Successful form submission) sees Subscribed and calls
//   thisapp.portal.assignUserInProfile(Admin_Email, "Customer - Admin POC" | "Suppliers - Admin POC") →
//   Zoho emails the admin "Set Your Password". The portal is Public, so they go straight in.
//
// Stripe: Developers › Webhooks › endpoint <railway>/api/stripe/webhook, event checkout.session.completed.
// Railway variable STRIPE_WEBHOOK_SECRET = that endpoint's signing secret (whsec_…). Without it every
// call is refused (503), so an unsigned request can never mark a registration paid.
//
// The body must reach us untouched for the signature check: index.js mounts express.raw for this path
// BEFORE the global express.json.
const crypto = require('crypto');
const axios = require('axios');

const REG_REPORT = 'All_Registrations';
const PAID_STATUS = 'Subscribed';
const TOLERANCE_S = 300;

// Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=…]. HMAC-SHA256 of "<t>.<raw body>" with the secret.
function verifySignature(raw, header, secret, nowS) {
  if (!header || !secret) return false;
  let t = '';
  const sigs = [];
  String(header).split(',').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i < 0) return;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  });
  if (!/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs((nowS || Math.floor(Date.now() / 1000)) - Number(t)) > TOLERANCE_S) return false;
  const want = crypto.createHmac('sha256', secret).update(t + '.').update(raw).digest('hex');
  return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

function registerStripeWebhook(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders } = deps;
  const hdr = async () => ({ headers: zohoHeaders(await getAccessToken()) });

  app.post('/api/stripe/webhook', async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!secret) { console.error('[stripe] STRIPE_WEBHOOK_SECRET is not set; refusing webhook'); return res.status(503).json({ ok: false, error: 'Not configured.' }); }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifySignature(raw, req.get('Stripe-Signature'), secret)) {
      console.warn('[stripe] bad signature from ' + (req.get('x-forwarded-for') || req.ip));
      return res.status(400).json({ ok: false, error: 'Bad signature.' });
    }
    let ev;
    try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ ok: false, error: 'Bad body.' }); }
    if (!ev || ev.type !== 'checkout.session.completed') return res.json({ ok: true, ignored: ev && ev.type });

    const s = (ev.data && ev.data.object) || {};
    const reg = String(s.client_reference_id || '');
    if (s.payment_status && s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') {
      console.warn('[stripe] session ' + s.id + ' completed but payment_status=' + s.payment_status + '; registration ' + reg + ' left as is');
      return res.json({ ok: true, ignored: 'unpaid' });
    }
    if (!/^\d{12,25}$/.test(reg)) {
      // A payment with no registration attached (e.g. the link opened directly). Nothing to grant;
      // say so loudly so it can be matched by hand from the Stripe payment's email.
      console.error('[stripe] paid session ' + s.id + ' has no registration id (client_reference_id=' + JSON.stringify(s.client_reference_id) + ', email=' + ((s.customer_details && s.customer_details.email) || '') + ')');
      return res.json({ ok: true, ignored: 'no registration id' });
    }
    try {
      const r = await axios.patch(creatorApiBase() + '/report/' + REG_REPORT + '/' + reg, { data: { Profile_Status: PAID_STATUS } }, await hdr());
      if (!r.data || r.data.code !== 3000) throw new Error(JSON.stringify(r.data).slice(0, 400));
      console.log('[stripe] registration ' + reg + ' marked ' + PAID_STATUS + ' (session ' + s.id + ')');
      return res.json({ ok: true });
    } catch (e) {
      // 500 makes Stripe retry (it does for up to 3 days), so a Zoho hiccup is not a lost signup.
      const d = e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
      console.error('[stripe] could not mark registration ' + reg + ' paid: ' + d);
      return res.status(500).json({ ok: false, error: 'Could not record the payment yet.' });
    }
  });
}

module.exports = { registerStripeWebhook, verifySignature, REG_REPORT, PAID_STATUS };
