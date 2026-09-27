// What ACTUALLY landed on a project's fittings, read back by record id.
//
// The take-off's on-screen summary is not evidence: it once reported 58 writes when nothing had
// been created, because the inserts were refused with code 3001 inside an HTTP 200 and nobody
// read the code. So this reads the rows from Zoho and reports what is on them.
//
//   node scripts/verify_project_fittings.js MCP-10009
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
const H = (t) => ({ Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json' });
const disp = (v) => (v && typeof v === 'object') ? (v.zc_display_value || v.ID || '') : (v == null ? '' : String(v));

async function get(t, path) {
  try {
    const r = await axios.get(base + path, { headers: H(t) });
    if (r.data && r.data.code && r.data.code !== 3000 && !Array.isArray(r.data.data)) {
      return { err: r.data.code + ' ' + r.data.message };
    }
    return { rows: r.data.data || [] };
  } catch (e) {
    const d = e.response && e.response.data;
    if (d && d.code === 9280) return { rows: [] };          // zero match is not a failure
    return { err: (e.response && e.response.status) + ' ' + JSON.stringify(d).slice(0, 200) };
  }
}

(async () => {
  const name = process.argv[2] || 'MCP-10009';
  const t = await token();

  // The field is Project_Quote_Number, NOT Project_ID - that name does not exist on the form
  // and the criteria is refused with 3330 rather than simply matching nothing.
  const proj = await get(t, '/report/All_Projects?criteria=' +
    encodeURIComponent('(Project_Quote_Number=="' + name + '")') + '&limit=2');
  if (proj.err) { console.error('project lookup failed: ' + proj.err); process.exit(1); }
  if (!proj.rows.length) { console.error('no project named ' + name); process.exit(1); }
  const pid = proj.rows[0].ID;
  console.log('project ' + name + '  id ' + pid + '  —  ' + disp(proj.rows[0].Project_Description).slice(0, 60));

  const f = await get(t, '/report/Project_BOM_Fittings_Quote_Form_Report?criteria=' +
    encodeURIComponent('(MCP_Customer_Project_Form==' + pid + ')') + '&limit=200');
  if (f.err) { console.error('fittings read failed: ' + f.err); process.exit(1); }
  const rows = f.rows;
  console.log('\nfitting rows on the project: ' + rows.length);

  let withId = 0, withWeight = 0, withComp = 0, withSpec = 0, withStyle = 0;
  rows.forEach((r) => {
    if (Number(r.Fitting_ID) > 0) withId++;
    if (String(r.Weight || '').trim() !== '' && Number(r.Weight) > 0) withWeight++;
    if (disp(r.Component)) withComp++;
    if (disp(r.Fitting_Specification)) withSpec++;
    if (disp(r.Fitting)) withStyle++;
  });
  const pct = (n) => n + ' / ' + rows.length + '  (' + (rows.length ? Math.round(n / rows.length * 100) : 0) + '%)';
  console.log('   Fitting_ID set        ' + pct(withId));
  console.log('   Weight > 0            ' + pct(withWeight));
  console.log('   Component linked      ' + pct(withComp));
  console.log('   Specification set     ' + pct(withSpec));
  console.log('   Fitting style set     ' + pct(withStyle));

  console.log('\nevery row:');
  rows.sort((a, b) => Number(a.Line_Item_Fitting || 0) - Number(b.Line_Item_Fitting || 0)).forEach((r) => {
    const id = Number(r.Fitting_ID) > 0 ? String(r.Fitting_ID) : '— no id —';
    const w = String(r.Weight || '').trim() === '' ? 'blank' : r.Weight;
    console.log('  ' + String(r.Line_Item_Fitting || '?').padStart(3) + '  ' +
      String(r.Fitting_Description_Text || '(no text)').slice(0, 46).padEnd(48) +
      'qty ' + String(r.Quantity || 0).padStart(4) + '   wt ' + String(w).padStart(8) +
      '   ' + id.padEnd(21) + disp(r.Fitting));
  });

  const noId = rows.filter((r) => !(Number(r.Fitting_ID) > 0));
  if (noId.length) {
    console.log('\nrows with NO Fitting_ID (' + noId.length + '):');
    noId.forEach((r) => console.log('   ' + (r.Fitting_Description_Text || '(no text)')));
  }
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
