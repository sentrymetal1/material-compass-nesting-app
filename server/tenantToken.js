// =============================================================================
//  tenantToken.js — who is calling, proven rather than asserted.
// -----------------------------------------------------------------------------
//  Every route trusted a manufacturer / project / supplier id straight from the URL or body
//  (inventory: Projects/TENANT_ISOLATION_INVENTORY.md). The fix is a token MINTED IN ZOHO,
//  server-side, for the shop Zoho knows is logged in, and checked here with the same secret:
//
//    token   = <kind><id> "." <expiryMs> "." <signature>
//    kind    = "m" (manufacturer, id = Customer_Entry record id) | "s" (supplier, id = login email)
//    payload = <kind><id> "." <expiryMs>          — exactly the first two parts, as sent
//    signature = HMAC-SHA256(payload) with MC_TOKEN_SECRET
//
//  Zoho's Deluge builds it with zoho.encryption.hmacsha256. Its output encoding and argument
//  order are confirmed against a known test vector before anything is enforced; until then
//  verify() accepts the plausible variants and REPORTS which one matched, so the first real
//  token settles it.
//
//  MODE (MC_TOKEN_MODE): "warn" (default) — record what every request would have got, serve it
//  anyway. "enforce" — refuse a tenant route without a valid token, or with one for another shop.
//  Enforce is switched on only once the report shows every page sending good tokens.
// =============================================================================

const crypto = require("crypto");

const MODE = () => (process.env.MC_TOKEN_MODE || "warn").toLowerCase();
const SECRET = () => process.env.MC_TOKEN_SECRET || "";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const norm = (s) => String(s || "").trim().replace(/ /g, "+").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The signature forms a Deluge HMAC could plausibly take. Which one Zoho produces is recorded on
// the first match (lastVariant) and then pinned via MC_TOKEN_VARIANT.
function candidates(payload, secret) {
  const k1 = crypto.createHmac("sha256", secret).update(payload).digest();   // key = secret (correct order)
  const k2 = crypto.createHmac("sha256", payload).update(secret).digest();   // key = payload (swapped args)
  return {
    "key-secret/base64": b64url(k1), "key-secret/hex": k1.toString("hex"),
    "key-payload/base64": b64url(k2), "key-payload/hex": k2.toString("hex"),
  };
}
let lastVariant = null;

// token -> { kind, id, exp, variant } or { error }
function verify(token) {
  const secret = SECRET();
  if (!secret || secret.length < 32) return { error: "not_configured" };
  const t = decodeURIComponent(String(token || "").trim());
  // Split from the RIGHT: a supplier token's id is an email, and emails contain dots.
  const i2 = t.lastIndexOf("."), i1 = i2 > 0 ? t.lastIndexOf(".", i2 - 1) : -1;
  if (i1 <= 0) return { error: t ? "malformed" : "missing" };
  const who = t.slice(0, i1), expS = t.slice(i1 + 1, i2), sig = t.slice(i2 + 1);
  const kind = who.charAt(0), id = who.slice(1);
  if ((kind !== "m" && kind !== "s") || !id || !/^\d{10,16}$/.test(expS)) return { error: "malformed" };
  const payload = who + "." + expS;
  const got = norm(sig), gotHex = String(sig).trim().toLowerCase();
  const pinned = process.env.MC_TOKEN_VARIANT || "";
  const cands = candidates(payload, secret);
  let variant = null;
  Object.keys(cands).some((v) => {
    if (pinned && v !== pinned) return false;
    const ok = v.endsWith("/hex") ? safeEq(gotHex, cands[v]) : safeEq(got, cands[v]);
    if (ok) variant = v;
    return ok;
  });
  if (!variant) return { error: "bad_signature" };
  lastVariant = variant;
  const exp = Number(expS);
  if (Date.now() > exp) return { error: "expired", kind, id };
  return { kind, id: kind === "s" ? id.toLowerCase() : id, exp, variant };
}

// Mint on this side too — for tests, and for Railway pages that open other Railway pages.
function mint(kind, id, ttlMs) {
  const payload = kind + id + "." + (Date.now() + (ttlMs || 12 * 3600 * 1000));
  return payload + "." + b64url(crypto.createHmac("sha256", SECRET()).update(payload).digest());
}

// Which tenant does THIS request claim to be? Every spelling the pages use.
function claimed(req) {
  const q = req.query || {}, b = (req.body && typeof req.body === "object") ? req.body : {};
  const m = q.manufacturer_id || b.manufacturer_id || q.manufacture || b.manufacture ||
            q.Manufacture_ID || b.Manufacture_ID || q.mfg_id || b.mfg_id ||
            (req.params && req.params.manufacturer_id) || "";
  const s = q.email || req.get("X-Supplier-Email") || "";
  return { mfg: String(m || "").trim(), email: String(s || "").trim().toLowerCase() };
}

// Tenant routes: everything that reads or writes one shop's data (Tier 1 in the inventory).
// Shared catalogs and static assets are not here.
const TENANT_ROUTES = [
  /^\/api\/triage\//, /^\/triage\/opportunity\//, /^\/api\/files\//, /^\/connect\/outlook\/start$/,
  /^\/api\/takeoff$/, /^\/api\/takeoff\/(revise|chat|index|ask|commit|commit-fittings|save|saved\/|attach-drawings|learn|project-scope|bom-preview|account\/|project-types|fitting-resolve|fitting-add)/,
  /^\/api\/project\//, /^\/api\/standalone\//, /^\/api\/bom-lookups\/(components|drawings)$/,
  /^\/api\/match-suggestions$/, /^\/api\/fittings\/resolve-row$/, /^\/api\/supplier\/me/,
];

// What the report shows: per route, how requests would have fared under enforce.
const stats = {};
function tally(route, outcome) {
  const r = stats[route] = stats[route] || {};
  r[outcome] = (r[outcome] || 0) + 1;
}

function middleware(req, res, next) {
  const p = req.path;
  if (!TENANT_ROUTES.some((re) => re.test(p))) return next();
  const token = req.get("X-MC-Token") || (req.query && req.query.t) || "";
  const v = verify(token);
  const c = claimed(req);
  let outcome;
  if (v.error) outcome = v.error;
  else if (v.kind === "m" && c.mfg && c.mfg !== v.id) outcome = "wrong_tenant";
  else if (v.kind === "s" && c.email && c.email !== v.id) outcome = "wrong_tenant";
  else outcome = "ok";
  // Group ids out of the route so the report reads per endpoint, not per record.
  const route = req.method + " " + p.replace(/\/\d{6,25}(?=\/|$)/g, "/:id");
  tally(route, outcome);
  req.tenant = v.error ? null : v;
  if (outcome === "ok" || MODE() !== "enforce") {
    if (outcome !== "ok" && outcome !== "missing") {
      console.warn("[tenant] " + outcome + " " + route + (c.mfg ? " claims mfg " + c.mfg : "") + (v.id ? " token " + v.kind + v.id : ""));
    }
    return next();
  }
  return res.status(401).json({ ok: false, error: "Please reopen this page from Material Compass.", reason: outcome });
}

function report() {
  return { mode: MODE(), secret_configured: SECRET().length >= 32, variant_seen: lastVariant,
           pinned_variant: process.env.MC_TOKEN_VARIANT || null, routes: stats };
}

module.exports = { verify, mint, middleware, report, candidates, TENANT_ROUTES };
