require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'client', 'build')));

const ZOHO = {
  clientId: process.env.ZOHO_CLIENT_ID,
  clientSecret: process.env.ZOHO_CLIENT_SECRET,
  refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  accountOwner: process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal',
  appLinkName: process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21',
};
const NESTING_API_URL = process.env.NESTING_API_URL || 'https://metal-nesting-api-production.up.railway.app/nest';

console.log('Zoho Config:', { clientId: ZOHO.clientId ? ZOHO.clientId.substring(0,10)+'...' : 'MISSING', clientSecret: ZOHO.clientSecret ? ZOHO.clientSecret.substring(0,6)+'...' : 'MISSING', refreshToken: ZOHO.refreshToken ? ZOHO.refreshToken.substring(0,10)+'...'+ZOHO.refreshToken.slice(-6) : 'MISSING', accountOwner: ZOHO.accountOwner, appLinkName: ZOHO.appLinkName });

let cachedToken = null, tokenExpiry = 0, lastTokenError = null;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  try {
    const resp = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, { params: { refresh_token: ZOHO.refreshToken, client_id: ZOHO.clientId, client_secret: ZOHO.clientSecret, grant_type: 'refresh_token' } });
    if (resp.data.error) { lastTokenError = resp.data.error; cachedToken = null; tokenExpiry = 0; throw new Error('Zoho token error: ' + resp.data.error); }
    if (!resp.data.access_token) { lastTokenError = 'No access_token'; cachedToken = null; tokenExpiry = 0; throw new Error('No access_token'); }
    cachedToken = resp.data.access_token; tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000; lastTokenError = null;
    console.log('Token obtained, expires in', resp.data.expires_in, 's'); return cachedToken;
  } catch (err) { lastTokenError = err.response?.data || err.message; cachedToken = null; tokenExpiry = 0; throw err; }
}

function zohoHeaders(token) { return { Authorization: 'Zoho-oauthtoken ' + token, Accept: 'application/json' }; }
function creatorApiBase() { return 'https://www.zohoapis.com/creator/v2.1/data/' + ZOHO.accountOwner + '/' + ZOHO.appLinkName; }
function safeNum(val, dec) { dec = dec || 4; const n = parseFloat(val); if (!Number.isFinite(n)) return 0; return Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec); }

// Health & Debug
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/debug', async (req, res) => {
  const info = { config: { accountOwner: ZOHO.accountOwner, appLinkName: ZOHO.appLinkName }, tokenCache: { hasToken: !!cachedToken }, lastTokenError, apiBase: creatorApiBase() };
  try { await getAccessToken(); info.tokenTest = { success: true }; } catch(e) { info.tokenTest = { success: false, error: e.message }; }
  res.json(info);
});

// Project
app.get('/api/project/:id', async (req, res) => {
  try { const token = await getAccessToken(); const resp = await axios.get(creatorApiBase()+'/report/All_Projects?criteria=(ID=='+req.params.id+')', { headers: zohoHeaders(token) });
    if (!resp.data.data?.length) return res.status(404).json({ error: 'Project not found' }); res.json(resp.data.data[0]);
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.response?.data || err.message }); }
});

// BOM
app.get('/api/project/:id/bom', async (req, res) => {
  try { const token = await getAccessToken();
    const resp = await axios.get(creatorApiBase()+'/report/Project_Bill_Of_Material_Detail_Form_Report?criteria=(Project_LU=='+req.params.id+')&limit=200', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => ({ id: row.ID, bom_item: row.BOM_Item, nest_type: row.Nest_Type, form_type_id: row.Form_Type?.ID, form_type_name: row.Form_Type?.zc_display_value || row.Form_Type?.display_value, material_type_id: row.Material_Type?.ID, material_type_name: row.Material_Type?.zc_display_value || row.Material_Type?.display_value, specification_id: row.Specification?.ID, spec_name: row.Specification?.zc_display_value || row.Specification?.display_value, material_type_origin: row.Specification?.Material_Type_Origin || '', material_id: row.Material?.ID, material_name: row.Material?.zc_display_value || row.Material?.display_value, material_dim1: row.Material?.Dim1, quantity: row.Quantity, length_nest: row.Length_Nest, width_nest: row.Width_Nest, density: row.Density, weight_per_ft: row.Weight_Per_Ft })));
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.response?.data || err.message }); }
});

// Stock
app.get('/api/stock', async (req, res) => {
  try { const token = await getAccessToken();
    const resp = await axios.get(creatorApiBase()+'/report/Nesting_Stock_Library_Report?criteria=(Is_Active=="Yes")&limit=200', { headers: zohoHeaders(token) });
    res.json((resp.data.data || []).map(row => ({ id: row.ID, form_type: row.Form_Type?.ID || row.Form_Type, form_type_name: row.Form_Type?.zc_display_value || row.Form_Type, material_type: row.Material_Type?.ID || row.Material_Type, material_type_name: row.Material_Type?.zc_display_value || row.Material_Type, stock_length: row.Stock_Length, stock_width: row.Stock_Width, density: row.Density_LBS_per_Culin, is_standard: row.Is_Standard })));
  } catch (err) { res.status(500).json({ error: 'Failed', details: err.response?.data || err.message }); }
});

// Nest
app.post('/api/nest', async (req, res) => {
  try { console.log('NEST REQUEST:', JSON.stringify(req.body));
    const resp = await axios.post(NESTING_API_URL, req.body, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
    console.log('NEST RESPONSE:', JSON.stringify(resp.data)); res.json(resp.data);
  } catch (err) { res.status(500).json({ error: 'Nesting failed', details: err.response?.data || err.message }); }
});

// Save Nesting Results
app.post('/api/project/:id/save-results', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { results_1d, results_2d, summary, kerf_1d, kerf_2d, run_by } = req.body;

    let bomItems = [];
    try {
      const bomResp = await axios.get(creatorApiBase()+'/report/Project_Bill_Of_Material_Detail_Form_Report?criteria=(Project_LU=='+projectId+')&limit=200', { headers: zohoHeaders(token) });
      bomItems = (bomResp.data.data || []).map(row => ({ id: row.ID, form_type_id: row.Form_Type?.ID, dim1: parseFloat(row.Material?.Dim1) || parseFloat(row.Dim1) || 0, weight_per_ft: parseFloat(row.Weight_Per_Ft) || parseFloat(row.Material?.Weight_Lb_Ft) || 0, density: parseFloat(row.Density) || 0 }));
    } catch (e) { console.error('BOM fetch failed for weights'); }

    function getBomData(result) {
      const id = result.cuts?.[0]?.bom_line_id;
      if (!id) return { weight_per_ft: 0, thickness: 0 };
      const b = bomItems.find(x => x.id === id);
      return b ? { weight_per_ft: b.weight_per_ft, thickness: b.dim1, density: b.density } : { weight_per_ft: 0, thickness: 0 };
    }
    function calcStockWt(r, wpf) {
      if (!wpf || !r.stock_length_in) return 0;
      return r.stock_width_in ? Math.round((r.stock_length_in * r.stock_width_in / 144) * wpf * 100) / 100 : Math.round(wpf * (r.stock_length_in / 12) * 100) / 100;
    }

    let existingRuns = [];
    try {
      const rr = await axios.get(creatorApiBase()+'/report/Nesting_Run_Header_Report?criteria=(Project_Lookup=='+projectId+')', { headers: zohoHeaders(token) });
      existingRuns = rr.data.data || [];
    } catch (e) { if (e.response?.data?.code === 9280) existingRuns = []; else throw e; }

    const approvedRuns = existingRuns.filter(r => r.Run_Status === 'Approved');
    for (const pr of approvedRuns) { try { await axios.patch(creatorApiBase()+'/report/Nesting_Run_Header_Report/'+pr.ID, { data: { Run_Status: 'Superseded' } }, { headers: zohoHeaders(token) }); } catch(e) {} }

    let mfg = '';
    try { const pr = await axios.get(creatorApiBase()+'/report/All_Projects/'+projectId, { headers: zohoHeaders(token) }); const m = pr.data.data?.MANUFACTURE; mfg = m?.ID || m?.zc_display_value || m || ''; } catch(e) {}

    const now = new Date();
    const rd = (now.getMonth()+1).toString().padStart(2,'0')+'/'+now.getDate().toString().padStart(2,'0')+'/'+now.getFullYear()+' '+now.toTimeString().slice(0,8);
    const hd = { Project_Lookup: projectId, Run_Number: existingRuns.length + 1, Run_Date: rd, Run_Status: 'Approved', Added_User: 'web_app' };
    if (run_by) hd.Run_By = run_by; else if (mfg) hd.Run_By = mfg;
    if (kerf_1d !== undefined) hd.Kerf_1D = kerf_1d;
    if (kerf_2d !== undefined) hd.Kerf_2D = kerf_2d;

    const hr = await axios.post(creatorApiBase()+'/form/Nesting_Run_Header', { data: hd }, { headers: zohoHeaders(token) });
    const nestRunID = hr.data.data.ID;

    let s1d = 0;
    for (const result of results_1d || []) {
      if (result.error || !result.cuts?.length) continue;
      try {
        const bd = getBomData(result);
        const cuts = result.cuts.map((c, i) => ({ BOM_Line_Lookup: c.bom_line_id, Part_Mark: c.part_mark, Cut_Length: c.cut_length, Cut_Weight: c.cut_length ? Math.round(bd.weight_per_ft * (c.cut_length / 12) * 10000) / 10000 : 0, Quantity_On_This_Stock: c.quantity_on_this_stock, Cut_Sequence: i + 1 }));
        await axios.post(creatorApiBase()+'/form/Nesting_Stock_Result', { data: { Nesting_Run_Header: nestRunID, Nesting_Type: '1D - Linear', Form_Type: result.form_type, Material_Type: result.material_origin, Specification: result.cuts[0].spec_name, Material: result.cuts[0].material_type, Stock_Size_Label: result.stock_label || '', Stock_Length: result.stock_length_in, Stock_Thickness: bd.thickness || 0, Remnant_Length: Math.round((result.remnant_length_in || 0) * 100) / 100, Waste_Percentage: result.waste_percentage, Stock_Weight_LBS: calcStockWt(result, bd.weight_per_ft), Stock_Sequence: s1d + 1, Nesting_Cut_Detail: cuts } }, { headers: zohoHeaders(token) });
        s1d++;
      } catch (e) { console.error('1D save error:', e.response?.data || e.message); }
    }

    let s2d = 0;
    for (const result of results_2d || []) {
      if (result.error || !result.cuts?.length) continue;
      try {
        const bd = getBomData(result);
        const degreeSign = String.fromCharCode(176);
        const cuts = result.cuts.map((c, i) => ({ BOM_Line_Lookup: c.bom_line_id, Part_Mark: c.part_mark, Cut_Length: c.cut_length, Cut_Width: c.cut_width, Cut_Weight: (c.cut_length && c.cut_width) ? Math.round((c.cut_length * c.cut_width / 144) * bd.weight_per_ft * 10000) / 10000 : 0, Quantity_On_This_Stock: c.quantity_on_this_stock, X_Position: c.x_position || 0, Y_Position: c.y_position || 0, Rotation: c.rotation === 90 ? '90'+degreeSign : '0'+degreeSign, Cut_Sequence: i + 1 }));
        await axios.post(creatorApiBase()+'/form/Nesting_Stock_Result', { data: { Nesting_Run_Header: nestRunID, Nesting_Type: '2D - Panel', Form_Type: result.form_type, Material_Type: result.material_origin, Specification: result.cuts[0].spec_name, Material: result.cuts[0].material_type, Stock_Size_Label: result.stock_label || '', Stock_Length: result.stock_length_in, Stock_Width: result.stock_width_in, Stock_Thickness: bd.thickness || 0, Remnant_Area: result.remnant_area_in2 || 0, Waste_Percentage: result.waste_percentage, Stock_Weight_LBS: calcStockWt(result, bd.weight_per_ft), Stock_Sequence: s2d + 1, Nesting_Cut_Detail: cuts } }, { headers: zohoHeaders(token) });
        s2d++;
      } catch (e) { console.error('2D save error:', e.response?.data || e.message); }
    }

    try {
      await axios.patch(creatorApiBase()+'/report/Nesting_Run_Header_Report/'+nestRunID, { data: { Total_Stock_Pieces: s1d + s2d, Total_Waste_Inches: Math.round((summary?.total_remnant_length_in || 0) * 10000) / 10000, Notes: 'Saved '+s1d+' 1D + '+s2d+' 2D | Waste: '+(summary?.avg_waste_pct_1d || 0)+'%' } }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
    } catch (e) { console.error('Header patch failed'); }

    res.json({ success: true, nest_run_id: nestRunID, run_number: existingRuns.length + 1, run_status: 'Approved', saved_1d: s1d, saved_2d: s2d, superseded_runs: approvedRuns.length });
  } catch (err) { console.error('Save error:', err.response?.data || err.message); res.status(500).json({ error: 'Failed to save results', details: err.response?.data || err.message }); }
});

// ─── Purchase List (fully populated with lookup resolution) ────
let lookupCache = { lengthInch: null, plateWidthFt: null, materialTypes: null, cacheTime: 0 };

async function fetchLookupTables(token) {
  const CACHE_TTL = 5 * 60 * 1000;
  if (lookupCache.lengthInch && (Date.now() - lookupCache.cacheTime) < CACHE_TTL) return lookupCache;
  console.log('Fetching lookup tables for purchase list...');
  let lengthInch = [], plateWidthFt = [], materialTypes = [];

  try {
    const r = await axios.get(creatorApiBase()+'/report/All_Length_Inch_Lookups?limit=200', { headers: zohoHeaders(token) });
    lengthInch = (r.data.data || []).map(row => ({ id: row.ID, description: row.Description || '', result: parseFloat(row.Result) || 0 }));
    console.log('Length INCH Lookups:', lengthInch.length);
  } catch (e) { console.error('Failed Length INCH fetch:', e.response?.data || e.message); }

  try {
    const r = await axios.get(creatorApiBase()+'/report/All_Plate_Standard_Sizes?limit=200', { headers: zohoHeaders(token) });
    plateWidthFt = (r.data.data || []).map(row => ({
      id: row.ID,
      description: row.Description || '',
      widthFt: parseFloat(row.Width_Ft) || parseFloat(row.Width_ft) || parseFloat(row['Width (ft)']) || 0
    }));
    console.log('Plate Standard Sizes:', plateWidthFt.length);
    // If widthFt is all 0, try parsing from Description (e.g. "8'" -> 8)
    if (plateWidthFt.length > 0 && plateWidthFt.every(r => r.widthFt === 0)) {
      console.log('widthFt all zero, parsing from Description...');
      plateWidthFt.forEach(r => {
        const m = (r.description || '').match(/^(\d+)/);
        if (m) r.widthFt = parseInt(m[1]);
      });
    }
  } catch (e) { console.error('Failed Plate Sizes fetch:', e.response?.data || e.message); }

  try {
    const r = await axios.get(creatorApiBase()+'/report/All_Material_Types?limit=200', { headers: zohoHeaders(token) });
    materialTypes = (r.data.data || []).map(row => ({
      id: row.ID,
      name: row.Material_Type || row.zc_display_value || row.display_value || ''
    }));
    console.log('Material Types:', materialTypes.length);
  } catch (e) { console.error('Failed Material Types fetch:', e.response?.data || e.message); }

  lookupCache = { lengthInch, plateWidthFt, materialTypes, cacheTime: Date.now() };
  return lookupCache;
}

function findLengthInchId(table, inchVal) {
  if (!table || !table.length) return null;
  const target = parseFloat(inchVal) || 0;
  let best = null, bestDiff = Infinity;
  for (const rec of table) {
    const d = Math.abs(rec.result - target);
    if (d < bestDiff) { bestDiff = d; best = rec; }
  }
  return (best && bestDiff <= 0.05) ? best.id : null;
}

function findWidthFtId(table, ftVal) {
  if (!table || !table.length) return null;
  const target = Math.floor(parseFloat(ftVal) || 0);
  // Try by widthFt number first
  const byNum = table.find(r => r.widthFt === target);
  if (byNum) return byNum.id;
  // Try by description string
  const byDesc = table.find(r => r.description === target + "'" || r.description === String(target));
  return byDesc ? byDesc.id : null;
}

function findMaterialTypeId(table, name) {
  if (!table || !table.length || !name) return null;
  const exact = table.find(r => r.name === name);
  if (exact) return exact.id;
  const lower = name.toLowerCase();
  const fuzzy = table.find(r => r.name.toLowerCase() === lower);
  return fuzzy ? fuzzy.id : null;
}

app.post('/api/project/:id/generate-purchase-list', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { purchase_lines } = req.body;
    if (!purchase_lines || purchase_lines.length === 0) return res.status(400).json({ error: 'No purchase lines' });

    console.log('Purchase list: ' + purchase_lines.length + ' lines for project ' + projectId);

    // Fetch lookup tables for Length_INCH, Width_FT, Width_INCH, Material_Type
    const lookups = await fetchLookupTables(token);

    // Log first few lookup entries for debugging
    if (lookups.lengthInch.length > 0) console.log('Sample Length INCH:', JSON.stringify(lookups.lengthInch.slice(0, 3)));
    if (lookups.plateWidthFt.length > 0) console.log('Sample Plate Sizes:', JSON.stringify(lookups.plateWidthFt.slice(0, 3)));
    if (lookups.materialTypes.length > 0) console.log('Sample Mat Types:', JSON.stringify(lookups.materialTypes.slice(0, 3)));

    const subformRows = purchase_lines.map(function(line, idx) {
      var stockLenIn = parseFloat(line.stock_length_in) || 0;
      var stockWidIn = parseFloat(line.stock_width_in) || 0;
      var is2D = stockWidIn > 0;

      // Calculate feet/inches split
      var lenFt = Math.floor(stockLenIn / 12);
      var lenInchRem = safeNum(stockLenIn % 12, 4);
      var widFt = is2D ? Math.floor(stockWidIn / 12) : 0;
      var widInchRem = is2D ? safeNum(stockWidIn % 12, 4) : 0;

      // Resolve lookup record IDs
      var lengthInchId = findLengthInchId(lookups.lengthInch, lenInchRem);
      var widthFtId = is2D ? findWidthFtId(lookups.plateWidthFt, widFt) : findWidthFtId(lookups.plateWidthFt, 0);
      var widthInchId = findLengthInchId(lookups.lengthInch, widInchRem);
      var matTypeId = findMaterialTypeId(lookups.materialTypes, line.material_type_name);

      // Calculate weights
      var unitWt = safeNum(line.unit_weight, 4);
      var qty = safeNum(line.quantity, 0);
      var totalWt = safeNum(unitWt * qty, 2);

      // Area in sq ft: for 2D = (length x width) / 144
      var area = is2D ? safeNum((stockLenIn * stockWidIn) / 144, 2) : 0;

      // Total Length (1D only) = feet_length * qty
      var totalLength = is2D ? 0 : safeNum((stockLenIn / 12) * qty, 4);

      // Total Plate Width (2D only) = stock_width_in (single piece width)
      var totalPlateWidth = is2D ? safeNum(stockWidIn, 4) : 0;

      // Build description
      var descParts = [line.form_type_name, line.material_type_name, line.spec_name, line.material_name].filter(Boolean);
      var lenStr = lenFt + "'-" + (lenInchRem > 0 ? Math.round(lenInchRem) + '"' : '0"');
      var sizeStr = is2D
        ? lenStr + ' x ' + widFt + "'-" + (widInchRem > 0 ? Math.round(widInchRem) + '"' : '0"')
        : lenStr;
      var fullDesc = descParts.join(' | ') + ' | ' + sizeStr;

      console.log('Row ' + (idx+1) + ': MatType=' + (matTypeId ? 'OK('+matTypeId+')' : 'MISS('+line.material_type_name+')') + ' LenInch=' + (lengthInchId ? 'OK' : 'MISS') + '(' + lenInchRem + ') WidFt=' + (widthFtId ? 'OK' : 'MISS') + '(' + widFt + ') WidInch=' + (widthInchId ? 'OK' : 'MISS') + '(' + widInchRem + ') TotWt=' + totalWt);

      // Build row - ONLY include lookup fields when we have a valid record ID
      var row = {
        Line_Item: idx + 1,
        Form_Type: line.form_type_id,
        Specification: line.specification_id,
        Material: line.material_id,
        MCP_Customer_Project_Form: projectId,
        Project_Bi_Directional_Lookup: projectId,
        Project_LU: projectId,
        Item_Description: fullDesc,
        Item_QTY_and_Description: line.description || fullDesc,
        Description: fullDesc,
        QTY: qty,
        Feet_Length: safeNum(lenFt, 0),
        Weight_Per_FT: safeNum(line.weight_per_ft, 4),
        Unit_Weight: unitWt,
        CalcWeight: totalWt,
        Area: area,
        Total_Length: totalLength,
        Total_Plate_Width: totalPlateWidth,
        Material_Size: safeNum(line.material_size, 4),
        Price_Per_LB: 0,
        Unit_Price: 0,
        Unit_Total: 0,
      };
      if (matTypeId) row.Material_Type = matTypeId;
      else if (line.material_type_id) row.Material_Type = line.material_type_id;
      if (lengthInchId) row.Length_INCH = lengthInchId;
      if (widthFtId) row.Width_FT = widthFtId;
      if (widthInchId) row.Width_INCH = widthInchId;
      return row;
    });

    console.log('PATCH URL:', creatorApiBase()+'/report/All_Projects/'+projectId);
    console.log('Subform rows:', subformRows.length);
    // Log first row for debugging
    if (subformRows.length > 0) console.log('First row:', JSON.stringify(subformRows[0]));

    var patchResp = await axios.patch(
      creatorApiBase()+'/report/All_Projects/'+projectId,
      { data: { Material_Allocated: subformRows } },
      { headers: zohoHeaders(token) }
    );
    console.log('Purchase PATCH response:', JSON.stringify(patchResp.data));
    res.json({ success: true, items_saved: subformRows.length });
  } catch (err) {
    console.error('Purchase list error:', JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: 'Failed to save purchase list', details: err.response?.data || err.message });
  }
});

// GET /api/project/:id/purchase-list — retrieve saved purchase list from Zoho
// Queries the Material_Allocated subform report directly (subform data not included in project GET)
app.get('/api/project/:id/purchase-list', async (req, res) => {
  try {
    var token = await getAccessToken();
    var projectId = req.params.id;

    console.log('Fetching purchase list for project:', projectId);

    // Try the subform report — filter by Project_LU
    var reportName = 'Project_Material_Allocated_Detail_Form_Report';
    var url = creatorApiBase() + '/report/' + reportName + '?criteria=(Project_LU==' + projectId + ')&limit=200';
    console.log('Purchase list GET URL:', url);

    var resp = await axios.get(url, { headers: zohoHeaders(token) });
    var rawRows = resp.data.data || [];
    console.log('Purchase list rows found:', rawRows.length);

    // Log first row keys for debugging
    if (rawRows.length > 0) console.log('First row keys:', Object.keys(rawRows[0]).join(', '));

    var lines = rawRows.map(function(row, idx) {
      var formType = row.Form_Type || {};
      var materialType = row.Material_Type || {};
      var specification = row.Specification || {};
      var material = row.Material || {};
      var lengthInch = row.Length_INCH || {};
      var widthFt = row.Width_FT || {};
      var widthInch = row.Width_INCH || {};

      return {
        line_item: row.Line_Item || idx + 1,
        form_type_id: formType.ID || formType,
        form_type_name: formType.zc_display_value || formType.display_value || '',
        material_type_id: materialType.ID || materialType,
        material_type_name: materialType.zc_display_value || materialType.display_value || '',
        specification_id: specification.ID || specification,
        spec_name: specification.zc_display_value || specification.display_value || '',
        material_id: material.ID || material,
        material_name: material.zc_display_value || material.display_value || '',
        item_description: row.Item_Description || '',
        item_qty_and_description: row.Item_QTY_and_Description || '',
        description: row.Description || '',
        quantity: parseFloat(row.QTY) || 0,
        feet_length: parseFloat(row.Feet_Length) || 0,
        length_inch_id: lengthInch.ID || lengthInch || '',
        length_inch_display: lengthInch.zc_display_value || lengthInch.display_value || '',
        width_ft_id: widthFt.ID || widthFt || '',
        width_ft_display: widthFt.zc_display_value || widthFt.display_value || '',
        width_inch_id: widthInch.ID || widthInch || '',
        width_inch_display: widthInch.zc_display_value || widthInch.display_value || '',
        weight_per_ft: parseFloat(row.Weight_Per_FT) || 0,
        unit_weight: parseFloat(row.Unit_Weight) || 0,
        total_weight: parseFloat(row.CalcWeight) || parseFloat(row.Total_Weight) || 0,
        price_per_lb: parseFloat(row.Price_Per_LB) || 0,
        unit_price: parseFloat(row.Unit_Price) || 0,
        unit_total: parseFloat(row.Unit_Total) || 0,
        area: parseFloat(row.Area) || 0,
        total_length: parseFloat(row.Total_Length) || 0,
        total_plate_width: parseFloat(row.Total_Plate_Width) || 0,
        material_size: parseFloat(row.Material_Size) || 0,
        row_id: row.ID || null,
      };
    });

    res.json({
      project_id: projectId,
      line_count: lines.length,
      purchase_lines: lines.sort(function(a, b) { return (a.line_item || 0) - (b.line_item || 0); }),
    });
  } catch (err) {
    console.error('Error fetching purchase list:', err.response?.data || err.message);
    // If report not found or no data, return empty
    if (err.response?.data?.code === 9280 || err.response?.status === 404) {
      return res.json({ project_id: req.params.id, line_count: 0, purchase_lines: [] });
    }
    res.status(500).json({ error: 'Failed to fetch purchase list', details: err.response?.data || err.message });
  }
});

// ─── Load Saved Nesting Results ────
app.get('/api/project/:id/nesting-results', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;

    // Step 1: Find latest Approved run header
    var runResp;
    try {
      runResp = await axios.get(creatorApiBase()+'/report/Nesting_Run_Header_Report?criteria=(Project_Lookup=='+projectId+')&limit=10', { headers: zohoHeaders(token) });
    } catch (e) {
      if (e.response?.data?.code === 9280 || e.response?.status === 404) {
        return res.json({ found: false, message: 'No approved nesting run found' });
      }
      throw e;
    }

    var runs = (runResp.data.data || []).filter(function(r) { return r.Run_Status === 'Approved'; });
    if (runs.length === 0) {
      return res.json({ found: false, message: 'No approved nesting run found' });
    }

    // Get latest run (highest Run_Number)
    runs.sort(function(a, b) { return (parseInt(b.Run_Number) || 0) - (parseInt(a.Run_Number) || 0); });
    var runHeader = runs[0];
    var nestRunID = runHeader.ID;
    console.log('Loading nesting run:', nestRunID, 'Run #'+runHeader.Run_Number);

    // Step 2: Fetch all stock results for this run
    var stockResults = [];
    var startIndex = 0;
    var hasMore = true;
    while (hasMore) {
      try {
        var srUrl = creatorApiBase()+'/report/Nesting_Stock_Results?criteria=(Nesting_Run_Header=='+nestRunID+')&limit=200';
        if (startIndex > 0) srUrl += '&from='+startIndex;
        var srResp = await axios.get(srUrl, { headers: zohoHeaders(token) });
        var batch = srResp.data.data || [];
        stockResults = stockResults.concat(batch);
        hasMore = batch.length === 200;
        startIndex += 200;
      } catch (e) {
        if (e.response?.data?.code === 9280) hasMore = false;
        else throw e;
      }
    }

    if (stockResults.length === 0) {
      return res.json({ found: true, run_header: { id: nestRunID, run_number: runHeader.Run_Number, run_date: runHeader.Run_Date, run_status: runHeader.Run_Status, notes: runHeader.Notes }, results_1d: [], results_2d: [], summary: { total_stock_pieces: 0, avg_waste_pct_1d: 0, errors: [] }, _nameLookup: {} });
    }

    // Step 3: Fetch all cut details for this run's stock results
    // Build list of stock result IDs
    var stockResultIds = stockResults.map(function(sr) { return sr.ID; });

    // Fetch cut details in batches — use Nesting_Stock_Result_Lookup field
    var allCutDetails = [];
    // Fetch all cuts for each stock result
    for (var i = 0; i < stockResultIds.length; i++) {
      try {
        var cdResp = await axios.get(creatorApiBase()+'/report/All_Nesting_Cut_Details?criteria=(Nesting_Stock_Result_Lookup=='+stockResultIds[i]+')&limit=200', { headers: zohoHeaders(token) });
        var cuts = cdResp.data.data || [];
        cuts.forEach(function(c) { c._stock_result_id = stockResultIds[i]; });
        allCutDetails = allCutDetails.concat(cuts);
      } catch (e) {
        if (e.response?.data?.code !== 9280) {
          console.error('Cut detail fetch error for SR', stockResultIds[i], ':', e.response?.data || e.message);
        }
      }
    }

    // Group cut details by stock result ID
    var cutsByStock = {};
    allCutDetails.forEach(function(cd) {
      var srId = cd._stock_result_id;
      if (!cutsByStock[srId]) cutsByStock[srId] = [];
      cutsByStock[srId].push(cd);
    });

    // Step 4: Build the results in the format the frontend expects
    var results_1d = [];
    var results_2d = [];
    var nameLookup = {};
    var totalWaste1d = 0;
    var count1d = 0;

    stockResults.forEach(function(sr) {
      var nestType = sr.Nesting_Type || '';
      var formType = sr.Form_Type || {};
      var materialType = sr.Material_Type || {};
      var specification = sr.Specification || {};
      var material = sr.Material || {};

      var formTypeId = formType.ID || formType || '';
      var materialTypeId = materialType.ID || materialType || '';
      var specId = specification.ID || specification || '';
      var materialId = material.ID || material || '';

      // Build name lookup
      var ftName = formType.zc_display_value || formType.display_value || '';
      var mtName = materialType.zc_display_value || materialType.display_value || '';
      var spName = specification.zc_display_value || specification.display_value || '';
      var matName = material.zc_display_value || material.display_value || '';

      if (formTypeId && ftName) nameLookup[formTypeId] = ftName;
      if (materialTypeId && mtName) nameLookup[materialTypeId] = mtName;
      if (specId && spName) nameLookup[specId] = spName;
      if (materialId && matName) nameLookup[materialId] = matName;

      // Build cuts array from cut details
      var srCuts = cutsByStock[sr.ID] || [];
      // Sort by Cut_Sequence
      srCuts.sort(function(a, b) { return (parseInt(a.Cut_Sequence) || 0) - (parseInt(b.Cut_Sequence) || 0); });

      var cuts = srCuts.map(function(cd) {
        var bomLineLookup = cd.BOM_Line_Lookup || {};
        var rotationStr = cd.Rotation || '0';
        // Parse rotation — may be "90°" or "0°"
        var rotation = parseInt(rotationStr) || 0;

        return {
          bom_line_id: bomLineLookup.ID || bomLineLookup || '',
          part_mark: cd.Part_Mark || '',
          cut_length: parseFloat(cd.Cut_Length) || 0,
          cut_width: parseFloat(cd.Cut_Width) || 0,
          cut_weight: parseFloat(cd.Cut_Weight) || 0,
          quantity_on_this_stock: parseInt(cd.Quantity_On_This_Stock) || 1,
          x_position: parseFloat(cd.X_Position) || 0,
          y_position: parseFloat(cd.Y_Position) || 0,
          rotation: rotation,
          cut_sequence: parseInt(cd.Cut_Sequence) || 0,
          spec_name: specId,
          material_type: materialId,
        };
      });

      var stockLength = parseFloat(sr.Stock_Length) || 0;
      var stockWidth = parseFloat(sr.Stock_Width) || 0;
      var wastePercentage = parseFloat(sr.Waste_Percentage) || 0;
      var remnantLength = parseFloat(sr.Remnant_Length) || 0;
      var remnantArea = parseFloat(sr.Remnant_Area) || 0;

      var resultObj = {
        stock_result_id: sr.ID,
        form_type: formTypeId,
        material_origin: materialTypeId,
        stock_length_in: stockLength,
        stock_label: sr.Stock_Size_Label || (ftName + ' | ' + mtName),
        waste_percentage: wastePercentage,
        stock_weight_lbs: parseFloat(sr.Stock_Weight_LBS) || 0,
        stock_sequence: parseInt(sr.Stock_Sequence) || 0,
        grain_direction: sr.Grain_Direction || '',
        cuts: cuts,
      };

      if (nestType.indexOf('1D') >= 0 || nestType.indexOf('Linear') >= 0) {
        resultObj.remnant_length_in = remnantLength;
        results_1d.push(resultObj);
        totalWaste1d += wastePercentage;
        count1d++;
      } else if (nestType.indexOf('2D') >= 0 || nestType.indexOf('Panel') >= 0) {
        resultObj.stock_width_in = stockWidth;
        resultObj.remnant_area_in2 = remnantArea;
        results_2d.push(resultObj);
      }
    });

    // Sort by stock_sequence
    results_1d.sort(function(a, b) { return a.stock_sequence - b.stock_sequence; });
    results_2d.sort(function(a, b) { return a.stock_sequence - b.stock_sequence; });

    var avgWaste1d = count1d > 0 ? totalWaste1d / count1d : 0;

    res.json({
      found: true,
      run_header: {
        id: nestRunID,
        run_number: parseInt(runHeader.Run_Number) || 1,
        run_date: runHeader.Run_Date || '',
        run_status: runHeader.Run_Status || '',
        run_by: runHeader.Run_By || '',
        kerf_1d: parseFloat(runHeader.Kerf_1D) || 0,
        kerf_2d: parseFloat(runHeader.Kerf_2D) || 0,
        notes: runHeader.Notes || '',
        total_stock_pieces: parseInt(runHeader.Total_Stock_Pieces) || (results_1d.length + results_2d.length),
      },
      results_1d: results_1d,
      results_2d: results_2d,
      summary: {
        total_stock_pieces: results_1d.length + results_2d.length,
        avg_waste_pct_1d: Math.round(avgWaste1d * 10) / 10,
        errors: [],
      },
      _nameLookup: nameLookup,
    });

  } catch (err) {
    console.error('Error fetching nesting results:', err.response?.data || err.message);
    if (err.response?.data?.code === 9280 || err.response?.status === 404) {
      return res.json({ found: false, message: 'No nesting results found' });
    }
    res.status(500).json({ error: 'Failed to fetch nesting results', details: err.response?.data || err.message });
  }
});

// Catch-all: serve React app
app.get('*', function(req, res) { res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html')); });

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Material Compass Nesting server running on port ' + PORT); });
