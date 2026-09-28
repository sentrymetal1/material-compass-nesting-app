// Bring already-committed fittings up to the same shape a hand-entered one has.
//
// Found by diffing MCP-10009's one hand-keyed fitting against the 60 the take-off wrote. Five
// fields were set on the hand row and blank on the API rows, and nothing the other way:
//
//   Drawing / Drawing_LU                  the sheet it was read from - the take-off HAS this
//                                         (`source_sheet`) and creates the drawing records, it
//                                         just never joined them
//   Total_Amount_Of_Est_Material          0.00 on a form entry, null from the API - and a null
//   Total_Est_Line_Amount_Quote_Material  in Deluge arithmetic is not 0, it is nothing, so
//                                         anything summing the column worked from nothing
//   Fitting_Description                   NOT fixable: the dropdown's options only exist inside
//                                         a form session, so REST is refused with code 3001
//                                         whatever value it sends. Display
//                                         Fitting_Description_Text instead.
//
// The forward fix is in fittingsCommit; this is for projects committed before it.
//
//   node scripts/backfill_fitting_parity.js MCP-10009          (dry run)
//   node scripts/backfill_fitting_parity.js MCP-10009 --apply
require('dotenv').config();
const axios = require('axios');

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

// Exact first, then either string containing the other, so a partial reference still lands on
// the right sheet: "AAA3793678" finds "AAA3793678-GAMMADG".
function findDrawing(list, sheet) {
  const s = txt(sheet).toLowerCase();
  if (!s || !list.length) return null;
  return list.find((d) => d.name.toLowerCase() === s)
      || list.find((d) => d.name.toLowerCase().indexOf(s) > -1 || s.indexOf(d.name.toLowerCase()) > -1)
      || null;
}

(async () => {
  const name = process.argv[2] || 'MCP-10009';
  const APPLY = process.argv.indexOf('--apply') > -1;
  const t = await token();

  const proj = await get(t, '/report/All_Projects?criteria=' + encodeURIComponent('(Project_Quote_Number=="' + name + '")') + '&limit=2');
  if (!proj.length) throw new Error('no project named ' + name);
  const pid = proj[0].ID;

  const dwgs = (await get(t, '/report/All_Project_Drawing_Details?criteria=' + encodeURIComponent('(MCP_Customer_Project_Form==' + pid + ')') + '&limit=200'))
    .map((r) => ({ id: String(r.ID), name: txt(r.Drawing_Number) })).filter((d) => d.name);
  console.log('drawings on the project: ' + dwgs.length);
  dwgs.forEach((d) => console.log('   ' + d.name));

  const rows = await get(t, '/report/' + PROJ + '?criteria=' + encodeURIComponent('(MCP_Customer_Project_Form==' + pid + ')') + '&limit=200');
  console.log('\nfitting rows: ' + rows.length + '\n');

  const plan = []; const unmatched = {};
  rows.forEach((r) => {
    const data = {};
    if (!disp(r.Drawing_LU)) {
      // The committed rows do not carry source_sheet, so the sheet name has to come from the
      // row's own Drawing text if the commit managed to write one - otherwise it cannot be
      // recovered here and the row is left alone rather than guessed at.
      // Drawing is a LOOKUP, not text - txt() on it yields "[object Object]", which is how
      // 7,930 catalog rows once ended up with that literal string as their schedule.
      const sheet = disp(r.Drawing);
      const d = findDrawing(dwgs, sheet);
      if (d) { data.Drawing_LU = d.id; data.Drawing = d.name; }
      else if (sheet) unmatched[sheet] = (unmatched[sheet] || 0) + 1;
    }
    if (txt(r.Total_Amount_Of_Est_Material) === '') data.Total_Amount_Of_Est_Material = 0;
    if (txt(r.Total_Est_Line_Amount_Quote_Material) === '') data.Total_Est_Line_Amount_Quote_Material = 0;
    if (Object.keys(data).length) plan.push({ id: r.ID, line: r.Line_Item_Fitting, data: data });
  });

  const withDwg = plan.filter((p) => p.data.Drawing_LU).length;
  console.log((APPLY ? 'APPLYING to ' : 'DRY RUN — would touch ') + plan.length + ' row(s)');
  console.log('   drawing linked on   ' + withDwg);
  console.log('   money zeroed on     ' + plan.filter((p) => 'Total_Amount_Of_Est_Material' in p.data).length);
  if (Object.keys(unmatched).length) {
    console.log('\n   sheet names with no matching drawing record:');
    Object.keys(unmatched).forEach((k) => console.log('      ' + JSON.stringify(k) + '  x' + unmatched[k]));
  }
  if (!plan.length) { console.log('\nnothing to do.'); return; }
  if (!APPLY) { console.log('\nre-run with --apply to write.'); return; }

  let ok = 0; const fails = [];
  for (const p of plan) { try { await patch(t, p.id, p.data); ok++; } catch (e) { fails.push('line ' + p.line + ': ' + e.message); } }
  console.log('\nupdated: ' + ok + ' of ' + plan.length);
  if (fails.length) { console.log('failures (' + fails.length + '):'); fails.slice(0, 8).forEach((f) => console.log('   ' + f)); }
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
