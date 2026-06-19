// Map the live quote-pipeline structure (supplier side) so the off-Zoho Submit
// Quote flow is built on real field names. node scripts/probe_quotes.js
require('dotenv').config();
const axios = require('axios');
const OWNER = process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal';
const APP = process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21';
const base = 'https://www.zohoapis.com/creator/v2.1/data/' + OWNER + '/' + APP;

async function token() {
  const r = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, { params: {
    refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' } });
  return r.data.access_token;
}
async function peek(t, report, n) {
  try {
    const r = await axios.get(base + '/report/' + report + '?limit=' + (n || 1), { headers: { Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json' } });
    if (r.data && r.data.code && r.data.code !== 3000 && !Array.isArray(r.data.data)) { console.log('\n### ' + report + ' -> code ' + r.data.code + ' ' + r.data.message); return; }
    const rows = r.data.data || [];
    console.log('\n### ' + report + ' (' + rows.length + ' shown)');
    if (!rows[0]) { console.log('  (no rows)'); return; }
    console.log('  fields: ' + Object.keys(rows[0]).join(', '));
    // print a compact sample of values to spot line-item subforms + price fields
    const r0 = rows[0];
    Object.keys(r0).forEach(k => {
      const v = r0[k];
      if (Array.isArray(v)) console.log('   [SUBFORM] ' + k + ' (' + v.length + ' rows) sample keys: ' + (v[0] ? Object.keys(v[0]).join(', ') : '(empty)'));
      else if (/price|amount|unit|status|weight|quantity|qty/i.test(k)) console.log('   ' + k + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : v));
    });
  } catch (e) { console.log('\n### ' + report + ' -> HTTP ' + (e.response && e.response.status) + ' ' + JSON.stringify(e.response && e.response.data)); }
}
(async () => {
  const t = await token();
  for (const rep of [
    'All_Quotes',
    'All_Supplier_Manufacture_Material_Quotes',
    'Supplier_Manufacture_Material_Quotes_Submitted',
    'All_Supplier_Verify',
    'Supplier_Verify_Report',
  ]) await peek(t, rep, 2);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
