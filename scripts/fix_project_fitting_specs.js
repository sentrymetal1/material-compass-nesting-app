// Correct the make/specification pairings and the forged coupling class on a project's fittings.
//
// Three groups, all from MCP-10009 and all the same underlying mistake: the take-off wrote a
// specification that is real, and paired it with a make the catalog does not file it under, so
// NEITHER resolved and the line reached the supplier with no specification at all.
//
//   butt weld   make -> Wrought - Carbon Steel, spec -> WPB | ASTM A234
//               (the catalog files A234 under Wrought; this is exactly the case the review
//               page's "specification trumps" rule now handles, added after this project
//               committed)
//   nipples     spec -> Gr B | ASTM A106. A nipple is cut pipe, so A106 is the pipe spec; A234
//               is a BUTT-WELD FITTING spec and was never right for one.
//   couplings   STD -> 3000 PSI, and repointed at the EXISTING 3000 PSI catalog row rather
//               than relabelling the STD row the commit created. Relabelling would have made a
//               second 1-1/2" | 3000 PSI row beside the one that has always been there.
//
// Every patch re-fires Created-or-Edited, so weights recompute without anyone reopening a record.
//
//   node scripts/fix_project_fitting_specs.js MCP-10009          (dry run)
//   node scripts/fix_project_fitting_specs.js MCP-10009 --apply
require('dotenv').config();
const axios = require('axios');

const OWNER = process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal';
const APP = process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21';
const base = 'https://www.zohoapis.com/creator/v2.1/data/' + OWNER + '/' + APP;
const PROJ = 'Project_BOM_Fittings_Quote_Form_Report';

// Read off the live catalog, not recalled. WPB | ASTM A234 reports makeId 4111484000000655111,
// which IS Wrought - Carbon Steel - so the pairing below is the catalog's own, not a preference.
const MAKE_WROUGHT_CS = '4111484000000655111';
const SPEC_WPB_A234   = '4111484000000657119';
const SPEC_GRB_A106   = '4111484000006234006';
// Existing Coupling / Carbon Steel / Threaded - NPT / Full rows at 3000 PSI.
const COUPLING_3000 = { '1-1/2"': '4111484000000750607', '4"': '4111484000000750623' };

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
// Zoho answers a refusal with HTTP 200 and a code in the body, so the code is read, never assumed.
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

  const proj = await get(t, '/report/All_Projects?criteria=' + encodeURIComponent('(Project_Quote_Number=="' + name + '")') + '&limit=2');
  if (!proj.length) throw new Error('no project named ' + name);
  const rows = await get(t, '/report/' + PROJ + '?criteria=' + encodeURIComponent('(MCP_Customer_Project_Form==' + proj[0].ID + ')') + '&limit=200');
  console.log('project ' + name + ': ' + rows.length + ' fitting rows\n');

  const plan = [];
  rows.forEach((r) => {
    const style = disp(r.Fitting), type = disp(r.Fitting_Type);
    const spec = disp(r.Fitting_Specification), text = txt(r.Fitting_Description_Text);
    const size = text.split('|')[0].trim();

    if (style === 'Forged' && type === 'Coupling' && /\|\s*STD$/i.test(text) && COUPLING_3000[size]) {
      plan.push({ id: r.ID, what: text + '  ->  ' + size + ' | 3000 PSI   (repointed at the existing catalog row)',
        data: { Fitting_Description_Text: size + ' | 3000 PSI',
                Fitting_ID: COUPLING_3000[size], Fittings_Socket_Weld: COUPLING_3000[size] } });
      return;
    }
    if (!spec && style === 'Butt Weld') {
      plan.push({ id: r.ID, what: text + '  ->  make Wrought - Carbon Steel, spec WPB | ASTM A234',
        data: { Fitting_Make: MAKE_WROUGHT_CS, Fitting_Specification: SPEC_WPB_A234 } });
      return;
    }
    if (!spec && type === 'Nipple') {
      plan.push({ id: r.ID, what: text + '  ->  spec Gr B | ASTM A106',
        data: { Fitting_Specification: SPEC_GRB_A106 } });
      return;
    }
  });

  if (!plan.length) { console.log('nothing to change.'); return; }
  console.log((APPLY ? 'APPLYING to ' : 'DRY RUN — would change ') + plan.length + ' row(s):\n');
  plan.forEach((p) => console.log('  ' + p.what));
  if (!APPLY) { console.log('\nre-run with --apply to write.'); return; }

  let ok = 0; const fails = [];
  for (const p of plan) {
    try { await patch(t, p.id, p.data); ok++; } catch (e) { fails.push(p.id + ': ' + e.message); }
  }
  console.log('\nupdated: ' + ok + ' of ' + plan.length);
  if (fails.length) { console.log('failures:'); fails.forEach((f) => console.log('   ' + f)); }

  const after = await get(t, '/report/' + PROJ + '?criteria=' + encodeURIComponent('(MCP_Customer_Project_Form==' + proj[0].ID + ')') + '&limit=200');
  const w = after.filter((r) => Number(r.Weight) > 0).length;
  const s = after.filter((r) => disp(r.Fitting_Specification)).length;
  const tot = after.reduce((a, r) => a + (Number(r.Total_Weight) || 0), 0);
  console.log('\nPROJECT NOW:  weight > 0  ' + w + ' / ' + after.length +
    '    specification set  ' + s + ' / ' + after.length + '    fittings total ' + tot.toFixed(2) + ' lb');
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
