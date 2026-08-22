// Backfill Unit_Weight / Total_Weight onto RFQs_Sent_Fittings bridge rows that a
// supplier priced BEFORE those fields existed.
//
// The submit endpoint writes both fields from the demand line (see the weight copy
// in server/supplier.js), so every row priced from that deploy onward is already
// correct. Rows priced earlier carry a price and no weight, which makes the
// close-out report's Total Weight footer read low without looking broken — the
// exact failure mode this script exists to clear.
//
//   node scripts/backfill_fitting_weights.js                  # dry run, writes nothing
//   node scripts/backfill_fitting_weights.js --apply          # perform the PATCHes
//   node scripts/backfill_fitting_weights.js --quote MMQ-10000  # limit to one quote
//
// Needs ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN in the environment.
// Railway's Console tab already has them; locally you need a .env.
//
// API cost: 1 token + 1 page of demand lines + 1 page of bridge rows for the dry
// run (~3 calls), plus one PATCH per row on --apply. Zoho's daily budget is tight
// (see the API-call-budget note), so the dry run is the default and the filtered
// read is deliberate.
// dotenv is optional: on Railway the vars are already in the environment, and a
// missing dev dependency there must not be what stops a backfill.
try { require('dotenv').config(); } catch (e) { /* env already populated */ }
const axios = require('axios');

const APPLY = process.argv.includes('--apply');
const qIdx = process.argv.indexOf('--quote');
const ONLY_QUOTE = qIdx > -1 ? String(process.argv[qIdx + 1] || '').trim() : '';

const OWNER = process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal';
const APP = process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21';
const BASE = 'https://www.zohoapis.com/creator/v2.1/data/' + OWNER + '/' + APP;
const FIT_RFQ_REPORT = process.env.FITTING_RFQ_REPORT || 'RFQs_Sent_Fittings_Report';
const DEMAND_REPORT = 'Fittings_Quote_Subform_Report';

let TOKEN = null;
async function token() {
  if (TOKEN) return TOKEN;
  const r = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
  if (!r.data.access_token) throw new Error('No access_token: ' + JSON.stringify(r.data));
  TOKEN = r.data.access_token;
  return TOKEN;
}

// v2.1 paginates on the record_cursor RESPONSE header — `from` is ignored and
// silently re-returns page one. An empty criteria result comes back as HTTP 400
// code 9280 rather than [], which is not an error here.
async function fetchAll(reportPath) {
  const t = await token();
  const out = [];
  let cursor = null;
  while (true) {
    const sep = reportPath.includes('?') ? '&' : '?';
    const headers = { Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json' };
    if (cursor) headers.record_cursor = cursor;
    let resp;
    try {
      resp = await axios.get(BASE + reportPath + sep + 'limit=200', { headers });
    } catch (e) {
      if (e.response && e.response.status === 400 && e.response.data && e.response.data.code === 9280) break;
      throw e;
    }
    // Quota exhaustion arrives as HTTP 200 + code 4000 + no data array. Treating
    // that as "no rows" would report a clean run that touched nothing.
    const code = resp.data && resp.data.code;
    if (code && code !== 3000 && code !== 3100 && !Array.isArray(resp.data && resp.data.data)) {
      throw new Error('Zoho code ' + code + ' on ' + reportPath + ': ' + (resp.data.message || ''));
    }
    out.push(...((resp.data && resp.data.data) || []));
    cursor = resp.headers['record_cursor'] || null;
    if (!cursor) break;
  }
  return out;
}

async function patch(id, data) {
  const t = await token();
  try {
    const r = await axios.patch(BASE + '/report/' + FIT_RFQ_REPORT + '/' + id, { data }, {
      headers: { Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    const code = r.data && r.data.code;
    return { ok: code === 3000 || code == null, code, message: r.data && r.data.message };
  } catch (e) {
    return { ok: false, code: e.response && e.response.data && e.response.data.code, message: (e.response && JSON.stringify(e.response.data)) || e.message };
  }
}

const num = v => (v == null || v === '' ? 0 : Number(v) || 0);
const round2 = n => Math.round(n * 100) / 100;
const lkid = v => (v && typeof v === 'object' ? String(v.ID || '') : String(v || ''));

(async () => {
  console.log(APPLY ? '=== APPLY — records will be written ===' : '=== DRY RUN — nothing will be written (pass --apply to write) ===');

  const demand = {};
  for (const d of await fetchAll('/report/' + DEMAND_REPORT)) demand[String(d.ID)] = num(d.Weight);
  console.log('Demand lines read: ' + Object.keys(demand).length);

  let rows = await fetchAll('/report/' + FIT_RFQ_REPORT);
  console.log('Bridge rows read:  ' + rows.length);
  if (ONLY_QUOTE) {
    rows = rows.filter(r => String(r.Quote_Reference_Number || r.Quote_Number || '') === ONLY_QUOTE);
    console.log('Filtered to ' + ONLY_QUOTE + ': ' + rows.length + ' rows');
  }

  // Only rows a supplier actually answered — an unanswered row has no weight to
  // record yet, and submit will write it correctly when the answer arrives.
  // Rows that already carry a Unit_Weight are left alone: re-writing them would
  // spend calls to no effect and would overwrite a supplier's own submitted value
  // if one ever diverges from the demand line.
  const targets = [];
  const skipped = { unanswered: 0, alreadyWeighed: 0, noDemandWeight: 0 };
  for (const r of rows) {
    const status = String(r.Item_Verification_Status || '').trim();
    if (!status) { skipped.unanswered++; continue; }
    if (num(r.Unit_Weight) > 0) { skipped.alreadyWeighed++; continue; }
    const unitWt = demand[lkid(r.Fittings_Quote_Subform)] || 0;
    if (!unitWt) { skipped.noDemandWeight++; continue; }
    const qty = num(r.Quantity);
    const noQuote = status === 'No Quote';
    targets.push({
      id: String(r.ID),
      quote: r.Quote_Reference_Number || r.Quote_Number || '',
      line: r.Line_Item_Fitting || '',
      status, qty, unitWt,
      // Same rules as the submit path: total is unit x the BRIDGE qty (the quantity
      // actually sent to this supplier), and zeroed on No Quote so the footer means
      // weight actually quoted. Unit_Weight is a property of the item, written either way.
      totalWt: noQuote ? 0 : round2(unitWt * qty),
    });
  }

  console.log('\nSkipped — not yet answered: ' + skipped.unanswered +
    ' | already weighed: ' + skipped.alreadyWeighed +
    ' | demand line has no Weight: ' + skipped.noDemandWeight);
  console.log('To backfill: ' + targets.length + '\n');
  if (skipped.noDemandWeight) {
    console.log('NOTE: ' + skipped.noDemandWeight + ' answered row(s) point at a demand line with a blank Weight.');
    console.log('      Those cannot be backfilled from here — the weight does not exist upstream.\n');
  }
  if (!targets.length) { console.log('Nothing to do.'); return; }

  console.log('quote        line  status         qty   unit wt   total wt   record id');
  for (const t of targets) {
    console.log(
      String(t.quote).padEnd(13) + String(t.line).padEnd(6) + String(t.status).padEnd(15) +
      String(t.qty).padStart(4) + String(t.unitWt).padStart(10) + String(t.totalWt).padStart(11) + '   ' + t.id
    );
  }

  if (!APPLY) { console.log('\nDry run complete. Re-run with --apply to write these ' + targets.length + ' rows.'); return; }

  console.log('\nWriting...');
  let ok = 0;
  const failed = [];
  for (const t of targets) {
    const r = await patch(t.id, { Unit_Weight: t.unitWt, Total_Weight: t.totalWt });
    if (r.ok) { ok++; console.log('  ok   ' + t.id + '  ' + t.quote + ' line ' + t.line); }
    else { failed.push({ t, r }); console.log('  FAIL ' + t.id + '  code ' + r.code + '  ' + r.message); }
  }
  console.log('\nWritten: ' + ok + ' / ' + targets.length + (failed.length ? '  FAILED: ' + failed.length : ''));
  // Per-row failures are printed, not swallowed — a partial run that reports success
  // is how "N confirmed" ends up meaning fewer than N.
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error('\nFATAL:', e.message); process.exitCode = 1; });
