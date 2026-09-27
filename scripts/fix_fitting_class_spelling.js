// Rewrite a fitting's class into the spelling getFittingWeight actually recognises.
//
// THE TARGET SPELLINGS ARE NOT GUESSED. They are read off the function itself:
//
//   fgDim.put("1/2\" | 3000 PSI", ".840|.147|0.5|1.00|1.00");   <- forged, keyed by literal string
//   dimStr = fgDim.get(mainDisp);  if(dimStr != null) { dimFound = true; }
//
//   if(sizeDisplay.contains("Class ")) { clsTok = sizeDisplay.getSuffix("Class "); }
//   flMap.put("4\" | Class 150", "16.755");                     <- flange, needs the word Class
//
// So a forged rating must read "<n> PSI" and a flange class "Class <n>". '3000#' and '150 LB'
// are correct English, are what the drawing says, and return 0.
//
// WHY BOTH RECORDS. The catalog row carries one copy of that text and the project line carries
// its own (Fitting_Description_Text) - and it is the project line's copy the Created-or-Edited
// workflow reads. Fixing only the catalog would leave every existing quote still unweighed.
// Updating the project line also RE-FIRES that workflow, so the weight recomputes by itself.
//
// AN EARLIER VERSION OF THIS SCRIPT took the spelling from a sibling row whose rating
// sameSched() considered identical. Its dry run proposed turning '4" | SCH STD (.237")' into
// '4" | SCH STD (.375)' - a different wall thickness, because schedKey() deliberately discards
// the parenthetical. Right rule for matching, catastrophic for rewriting. Hence the explicit,
// auditable transform below, and butt-weld schedule strings are never touched.
//
//   node scripts/fix_fitting_class_spelling.js MCP-10009          (dry run)
//   node scripts/fix_fitting_class_spelling.js MCP-10009 --apply
require('dotenv').config();
const axios = require('axios');

const OWNER = process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal';
const APP = process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21';
const base = 'https://www.zohoapis.com/creator/v2.1/data/' + OWNER + '/' + APP;
const BW_REPORT = 'Tee_Reducing_NPS_Dimensions_Report';
const SW_REPORT = 'Fittings_Socket_Weld_and_Threaded_Details_Report';
const PROJ_REPORT = 'Project_BOM_Fittings_Quote_Form_Report';

const txt = (v) => String(v == null ? '' : v).trim();
const lk = (v) => (v && typeof v === 'object') ? txt(v.ID) : txt(v);

// ── THE ONLY TRANSFORM ──────────────────────────────────────────────────────────────────────
// Forged ratings: '3000#', '3000 LB', '3000' -> '3000 PSI'. Flange classes: '150 LB', '150'
// -> 'Class 150'. Which of the two applies is decided by the VALUE, because the forged ratings
// in fgDim are 2000/3000/6000/9000 and the flange classes in flMap are 150/300/600/900/1500/
// 2500 - two disjoint sets, so there is nothing to disambiguate.
const FORGED = { 2000: 1, 3000: 1, 6000: 1, 9000: 1 };
const FLANGE = { 150: 1, 300: 1, 600: 1, 900: 1, 1500: 1, 2500: 1 };

function canonicalClass(cls) {
  const s = txt(cls);
  if (!s) return null;
  if (/^\d+\s*PSI$/i.test(s)) return null;                 // already right
  if (/^Class\s+\d+$/i.test(s)) return null;               // already right
  if (/SCH|\(/i.test(s)) return null;                      // a butt-weld schedule - never touched
  const m = s.match(/^(\d+)\s*(#|LB|LBS)?$/i);             // '3000#', '150 LB', '150'
  if (!m) return null;
  const n = Number(m[1]);
  if (FORGED[n]) return n + ' PSI';
  if (FLANGE[n]) return 'Class ' + n;
  return null;                                             // unknown rating - left alone
}

// '1-1/2" | 3000#' -> '1-1/2" | 3000 PSI'. Everything before the LAST pipe is untouched, so a
// reducing pair and a wall thickness both survive.
function fixText(s) {
  const t = txt(s);
  const i = t.lastIndexOf('|');
  if (i < 0) return null;
  const head = t.slice(0, i + 1), cls = t.slice(i + 1).trim();
  const better = canonicalClass(cls);
  return better ? head + ' ' + better : null;
}

async function token() {
  const r = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, { params: {
    refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' } });
  return r.data.access_token;
}
const H = (t) => ({ Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json' });

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
// Zoho answers a refusal with HTTP 200 and a code in the body; the code is read, never assumed.
async function patch(t, report, id, data) {
  const r = await axios.patch(base + '/report/' + report + '/' + id, { data },
    { headers: Object.assign({ 'Content-Type': 'application/json' }, H(t)) });
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
  const rows = await get(t, '/report/' + PROJ_REPORT + '?criteria=' + encodeURIComponent('(MCP_Customer_Project_Form==' + proj[0].ID + ')') + '&limit=200');
  console.log('project ' + name + ': ' + rows.length + ' fitting rows\n');

  const plan = [];
  rows.forEach((r) => {
    const was = txt(r.Fitting_Description_Text);
    const now = fixText(was);
    if (!now) return;
    const bw = lk(r.Fittings_Butt_Weld), sw = lk(r.Fittings_Socket_Weld);
    plan.push({ rowId: r.ID, was: was, now: now,
      catId: sw || bw || '', catReport: sw ? SW_REPORT : (bw ? BW_REPORT : ''),
      catField: sw ? 'NPS_Dim_and_Class' : 'NPS_Dim_And_SCH_Text' });
  });

  if (!plan.length) { console.log('nothing to correct.'); return; }
  console.log((APPLY ? 'APPLYING to ' : 'DRY RUN — would change ') + plan.length + ' row(s):\n');
  plan.forEach((p) => console.log('  ' + p.was.padEnd(30) + ' -> ' + p.now.padEnd(30) + (p.catId ? '' : '   (no catalog row linked)')));
  if (!APPLY) { console.log('\nre-run with --apply to write.'); return; }

  let okRow = 0, okCat = 0; const fails = [];
  for (const p of plan) {
    try { await patch(t, PROJ_REPORT, p.rowId, { Fitting_Description_Text: p.now }); okRow++; }
    catch (e) { fails.push('project row ' + p.rowId + ': ' + e.message); }
    if (p.catId) {
      try { await patch(t, p.catReport, p.catId, { [p.catField]: p.now }); okCat++; }
      catch (e) { fails.push('catalog row ' + p.catId + ': ' + e.message); }
    }
  }
  console.log('\nproject lines updated: ' + okRow + ' of ' + plan.length);
  console.log('catalog rows updated : ' + okCat);
  if (fails.length) { console.log('\nfailures (' + fails.length + '):'); fails.forEach((f) => console.log('   ' + f)); }
  console.log('\nThen rebuild the index ONCE so the new spellings are visible to matching:');
  console.log('  /api/takeoff/fitting-index-check?rebuild=1');
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
