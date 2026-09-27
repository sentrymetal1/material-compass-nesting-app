// Before deleting a duplicate catalog row, find out what points at it. Deleting a row that a
// project fitting references does not error - the link simply goes dead and the weight stops
// resolving, silently. node scripts/check_fitting_refs.js <catalogRowId> [...]
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

async function find(t, criteria) {
  const url = base + '/report/Project_BOM_Fittings_Quote_Form_Report?criteria=' + encodeURIComponent(criteria) + '&limit=200';
  try {
    const r = await axios.get(url, { headers: { Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json' } });
    // A zero-match criteria answers 400/9280 rather than an empty list, and a spent quota
    // answers HTTP 200 with code 4000. Both have to be read, not assumed.
    if (r.data && r.data.code && r.data.code !== 3000) return { err: r.data.code + ' ' + r.data.message };
    return { rows: r.data.data || [] };
  } catch (e) {
    const d = e.response && e.response.data;
    if (d && d.code === 9280) return { rows: [] };          // zero match, not a failure
    return { err: (e.response && e.response.status) + ' ' + JSON.stringify(d).slice(0, 160) };
  }
}

(async () => {
  const ids = process.argv.slice(2);
  if (!ids.length) { console.error('usage: node scripts/check_fitting_refs.js <catalogRowId> [...]'); process.exit(1); }
  const t = await token();
  for (const id of ids) {
    console.log('\n=== catalog row ' + id);
    for (const field of ['Fitting_ID', 'Fittings_Socket_Weld', 'Fittings_Butt_Weld']) {
      // Fitting_ID is a NUMBER field, the other two are lookups - so the criteria differ.
      const crit = field === 'Fitting_ID' ? '(Fitting_ID == ' + id + ')' : '(' + field + ' == ' + id + ')';
      const out = await find(t, crit);
      if (out.err) { console.log('   ' + field.padEnd(22) + 'query failed: ' + out.err); continue; }
      console.log('   ' + field.padEnd(22) + out.rows.length + ' row(s)');
      out.rows.slice(0, 8).forEach((r) => console.log('        ID ' + r.ID + '  ' +
        (r.Fitting_Description_Text || '(no text)') + '  qty ' + (r.Quantity || '?') +
        '  project ' + ((r.MCP_Customer_Project_Form && r.MCP_Customer_Project_Form.zc_display_value) || '?')));
    }
  }
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
