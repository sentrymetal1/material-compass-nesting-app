// Fill in butt-weld weights the Deluge workflow did not produce, using the same geometry it
// uses. See server/buttWeldWeight.js for why this is needed and why it is not a rival engine.
//
// Safe to run repeatedly: it only ever touches a row whose Weight is blank or zero, which is
// exactly the condition the workflow's own line-14 guard uses, so the two never fight over a
// value a person set.
//
//   node scripts/backfill_buttweld_weights.js MCP-10009          (dry run)
//   node scripts/backfill_buttweld_weights.js MCP-10009 --apply
require('dotenv').config();
const axios = require('axios');
const { buttWeldFittingLb } = require('../server/buttWeldWeight');

const OWNER = process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal';
const APP = process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21';
const base = 'https://www.zohoapis.com/creator/v2.1/data/' + OWNER + '/' + APP;
const PROJ = 'Project_BOM_Fittings_Quote_Form_Report';

const txt = (v) => String(v == null ? '' : v).trim();
const disp = (v) => (v && typeof v === 'object') ? (v.zc_display_value || '') : txt(v);

async function token() {
  const r = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, { params: {
    refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' } });
  return r.data.access_token;
}
const H = (t) => ({ Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json', 'Content-Type': 'application/json' });

async function get(t, path) {
  try {
    const r = await axios.get(base + path, { headers: H(t) });
    if (r.data && r.data.code && r.data.code !== 3000 && !Array.isArray(r.data.data)) throw new Error(r.data.code + ' ' + r.data.message);
    return r.data.data || [];
  } catch (e) {
    const d = e.response && e.response.data;
    if (d && d.code === 9280) return [];
    throw new Error((e.response && e.response.status) + ' ' + JSON.stringify(d || e.message).slice(0, 200));
  }
}
async function patch(t, id, data) {
  const r = await axios.patch(base + '/report/' + PROJ + '/' + id, { data }, { headers: H(t) });
  const b = r.data || {};
  const code = b.code != null ? b.code : (Array.isArray(b.result) && b.result[0] && b.result[0].code);
  if (code !== 3000) throw new Error('code ' + code + ' ' + (b.message || JSON.stringify(b).slice(0, 140)));
}

(async () => {
  const name = process.argv[2] || 'MCP-10009';
  const APPLY = process.argv.indexOf('--apply') > -1;
  const t = await token();

  // Density from the Fitting Make record - the same field getFittingWeight reads.
  const makes = await get(t, '/report/Fitting_Make_Report?limit=200');
  const dens = {};
  makes.forEach((m) => { const n = txt(m.Fitting_Make); if (n && Number(m.Density) > 0) dens[n] = Number(m.Density); });

  const proj = await get(t, '/report/All_Projects?criteria=' + encodeURIComponent('(Project_Quote_Number=="' + name + '")') + '&limit=2');
  if (!proj.length) throw new Error('no project named ' + name);
  const rows = await get(t, '/report/' + PROJ + '?criteria=' + encodeURIComponent('(MCP_Customer_Project_Form==' + proj[0].ID + ')') + '&limit=200');
  console.log('project ' + name + ': ' + rows.length + ' fitting rows\n');

  const plan = [];
  rows.forEach((r) => {
    if (Number(r.Weight) > 0) return;                       // never overwrite a real figure
    if (disp(r.Fitting) !== 'Butt Weld') return;            // forged and flange already price
    const make = disp(r.Fitting_Make);
    const got = buttWeldFittingLb({
      fitting_type: disp(r.Fitting_Type),
      connection_type: disp(r.Connection_Type),
      size_display: txt(r.Fitting_Description_Text),
      density: dens[make] || 0.2833,
    });
    if (!got) return;                                       // blank stays blank, never a zero
    const qty = Number(r.Quantity) || 0;
    plan.push({ id: r.ID, what: disp(r.Fitting_Type).padEnd(9) + txt(r.Fitting_Description_Text),
      lb: got.lb, qty: qty,
      // Weight takes THREE decimals, Total_Weight only TWO - a third is refused with
      // code 3001, "Total_Weight has exceeded its maximum digits", inside an HTTP 200.
      data: { Weight: got.lb, Total_Weight: Number((got.lb * qty).toFixed(2)) } });
  });

  if (!plan.length) { console.log('nothing to fill.'); return; }
  console.log((APPLY ? 'APPLYING to ' : 'DRY RUN — would fill ') + plan.length + ' row(s):\n');
  plan.forEach((p) => console.log('  ' + p.what.padEnd(46) + String(p.lb).padStart(9) + ' lb  x' +
    String(p.qty).padStart(3) + '  = ' + (p.lb * p.qty).toFixed(2).padStart(9)));
  if (!APPLY) { console.log('\nre-run with --apply to write.'); return; }

  let ok = 0; const fails = [];
  for (const p of plan) { try { await patch(t, p.id, p.data); ok++; } catch (e) { fails.push(p.id + ': ' + e.message); } }
  console.log('\nfilled: ' + ok + ' of ' + plan.length);
  if (fails.length) { console.log('failures:'); fails.forEach((f) => console.log('   ' + f)); }

  const after = await get(t, '/report/' + PROJ + '?criteria=' + encodeURIComponent('(MCP_Customer_Project_Form==' + proj[0].ID + ')') + '&limit=200');
  const w = after.filter((r) => Number(r.Weight) > 0).length;
  const tot = after.reduce((a, r) => a + (Number(r.Total_Weight) || 0), 0);
  console.log('\nPROJECT NOW:  weight > 0  ' + w + ' / ' + after.length + '    fittings total ' + tot.toFixed(2) + ' lb');
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
