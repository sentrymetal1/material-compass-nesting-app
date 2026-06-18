// One-off: print field names from supplier reports so resolveSupplier() is built
// on real link names. node scripts/probe_supplier.js
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
async function peek(t, report) {
  try {
    const r = await axios.get(base + '/report/' + report + '?limit=1', { headers: { Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json' } });
    if (r.data && r.data.code && r.data.code !== 3000 && !Array.isArray(r.data.data)) { console.log('\n' + report + ' -> code ' + r.data.code + ' ' + r.data.message); return; }
    const row = (r.data.data || [])[0];
    console.log('\n=== ' + report + ' (' + (r.data.data || []).length + ' shown) ===');
    if (row) console.log(Object.keys(row).join(', '));
    else console.log('(no rows)');
  } catch (e) { console.log('\n' + report + ' -> HTTP ' + (e.response && e.response.status) + ' ' + JSON.stringify(e.response && e.response.data)); }
}
(async () => {
  const t = await token();
  for (const rep of ['All_Supplier_Representatives', 'Supplier_Representatives_Report', 'Supplier_Entry_Report', 'All_Supplier_Locations']) {
    await peek(t, rep);
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
