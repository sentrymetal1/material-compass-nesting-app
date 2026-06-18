// Local smoke-test for the fitting matcher — validates Zoho field reads BEFORE deploy.
// Run:  node scripts/smoke_fitting_match.js <supplierRecordId>
// Needs a local .env with ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN
// (copy the values from Railway). Reads one page from each report, prints the
// EXACT field names Zoho returns + a dry-run of the match. No writes.
require('dotenv').config();
const axios = require('axios');

const OWNER = process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal';
const APP = process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21';
const SUPPLY_REPORT = process.env.FITTING_STOCK_REPORT || 'Supplier_Fitting_Stock_All';
const DEMAND_REPORT = 'Fittings_Quote_Subform_Report';
const base = 'https://www.zohoapis.com/creator/v2.1/data/' + OWNER + '/' + APP;

async function token() {
  const r = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
  if (!r.data.access_token) throw new Error('token error: ' + JSON.stringify(r.data));
  return r.data.access_token;
}

function lk(v) {
  if (v == null) return { id: '', name: '' };
  if (typeof v === 'object') return { id: String(v.ID || v.id || ''), name: String(v.display_value || v.zc_display_value || '') };
  return { id: String(v), name: String(v) };
}
function axes(r) {
  return { type: lk(r.Fitting_Type), make: lk(r.Fitting_Make), end: lk(r.End_Type), conn: lk(r.Connection_Type), spec: lk(r.Fitting_Specification) };
}

async function read(t, report, criteria) {
  const url = base + '/report/' + report + (criteria ? '?criteria=' + criteria + '&limit=5' : '?limit=5');
  const r = await axios.get(url, { headers: { Authorization: 'Zoho-oauthtoken ' + t, Accept: 'application/json' } });
  if (r.data && r.data.code && r.data.code !== 3000 && !Array.isArray(r.data.data)) {
    throw new Error('Zoho code ' + r.data.code + ': ' + r.data.message + '  (' + url + ')');
  }
  return r.data.data || [];
}

(async () => {
  const supplierId = process.argv[2];
  const t = await token();
  console.log('Token OK\n');

  // Demand
  const demand = await read(t, DEMAND_REPORT);
  console.log('=== DEMAND  ' + DEMAND_REPORT + '  (' + demand.length + ' rows shown) ===');
  if (demand[0]) {
    console.log('field names:', Object.keys(demand[0]).join(', '));
    const a = axes(demand[0]);
    console.log('axes row0:', JSON.stringify(a));
    console.log('qty:', demand[0].Quantity, '| project:', lk(demand[0].MCP_Customer_Project_Form).name, '| quote:', lk(demand[0].Quote_ID).id);
  }

  // Supply (unfiltered report; filter to stocked rows for the chosen supplier)
  console.log('\n=== SUPPLY  ' + SUPPLY_REPORT + ' ===');
  const stockCrit = supplierId
    ? '(Supplier_ID==' + encodeURIComponent(supplierId) + '%26%26Fitting_Stocked_Checkbox=="Stocked")'
    : '(Fitting_Stocked_Checkbox=="Stocked")';
  const stock = await read(t, SUPPLY_REPORT, stockCrit);
  console.log('(' + stock.length + ' stocked rows shown' + (supplierId ? ' for supplier ' + supplierId : ', ALL suppliers — pass a supplierId to scope') + ')');
  if (stock[0]) {
    console.log('field names:', Object.keys(stock[0]).join(', '));
    console.log('axes row0:', JSON.stringify(axes(stock[0])));
    console.log('supplier ids in sample:', [...new Set(stock.map(s => lk(s.Supplier_ID).id))].join(', '));
  }

  // Dry-run match (exact tier only, on the small samples)
  if (demand[0] && stock[0]) {
    const stockKeys = new Set(stock.map(s => { const a = axes(s); return [a.type.id, a.make.id, a.end.id, a.conn.id, a.spec.id].join('|'); }));
    const hits = demand.filter(d => { const a = axes(d); return stockKeys.has([a.type.id, a.make.id, a.end.id, a.conn.id, a.spec.id].join('|')); });
    console.log('\nExact matches in sample:', hits.length, '(samples are tiny, so 0 is normal — this only proves the field reads line up)');
  }
})().catch(e => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
