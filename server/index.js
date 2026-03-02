require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve React frontend in production
app.use(express.static(path.join(__dirname, '..', 'client', 'build')));

// ─── Zoho Config ───────────────────────────────────────────────
const ZOHO = {
  clientId: process.env.ZOHO_CLIENT_ID,
  clientSecret: process.env.ZOHO_CLIENT_SECRET,
  refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  accountOwner: process.env.ZOHO_ACCOUNT_OWNER || 'mark_sentrymetal',
  appLinkName: process.env.ZOHO_APP_LINK_NAME || 'type-formsheet-2-18-21',
};
const NESTING_API_URL = process.env.NESTING_API_URL || 'https://metal-nesting-api-production.up.railway.app/nest';

// Log config on startup (mask secrets)
console.log('Zoho Config:', {
  clientId: ZOHO.clientId ? ZOHO.clientId.substring(0, 10) + '...' : 'MISSING',
  clientSecret: ZOHO.clientSecret ? ZOHO.clientSecret.substring(0, 6) + '...' : 'MISSING',
  refreshToken: ZOHO.refreshToken ? ZOHO.refreshToken.substring(0, 10) + '...' + ZOHO.refreshToken.slice(-6) : 'MISSING',
  accountOwner: ZOHO.accountOwner,
  appLinkName: ZOHO.appLinkName,
});

// ─── Token Cache ───────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;
let lastTokenError = null;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  console.log('Requesting new access token from Zoho...');
  console.log('Using refresh token:', ZOHO.refreshToken ? ZOHO.refreshToken.substring(0, 10) + '...' + ZOHO.refreshToken.slice(-6) : 'MISSING');

  try {
    const resp = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
      params: {
        refresh_token: ZOHO.refreshToken,
        client_id: ZOHO.clientId,
        client_secret: ZOHO.clientSecret,
        grant_type: 'refresh_token',
      },
    });

    console.log('Token response keys:', Object.keys(resp.data));

    // Check if Zoho returned an error
    if (resp.data.error) {
      console.error('Zoho token error:', resp.data.error);
      lastTokenError = resp.data.error;
      // Do NOT cache a bad token
      cachedToken = null;
      tokenExpiry = 0;
      throw new Error(`Zoho token error: ${resp.data.error}`);
    }

    if (!resp.data.access_token) {
      console.error('No access_token in response:', JSON.stringify(resp.data));
      lastTokenError = 'No access_token in response';
      cachedToken = null;
      tokenExpiry = 0;
      throw new Error('No access_token in Zoho response');
    }

    cachedToken = resp.data.access_token;
    tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
    lastTokenError = null;
    console.log('Access token obtained successfully, expires in', resp.data.expires_in, 'seconds');
    return cachedToken;
  } catch (err) {
    console.error('Token request failed:', err.response?.data || err.message);
    lastTokenError = err.response?.data || err.message;
    cachedToken = null;
    tokenExpiry = 0;
    throw err;
  }
}

function zohoHeaders(token) {
  return { 
    Authorization: `Zoho-oauthtoken ${token}`,
    Accept: 'application/json'
  };
}

function creatorApiBase() {
  return `https://www.zohoapis.com/creator/v2.1/data/${ZOHO.accountOwner}/${ZOHO.appLinkName}`;
}

// ─── API Routes ────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint — shows token status without exposing secrets
app.get('/api/debug', async (req, res) => {
  const info = {
    config: {
      clientId: ZOHO.clientId ? ZOHO.clientId.substring(0, 10) + '...' : 'MISSING',
      clientSecret: ZOHO.clientSecret ? '***set***' : 'MISSING',
      refreshToken: ZOHO.refreshToken ? ZOHO.refreshToken.substring(0, 10) + '...' + ZOHO.refreshToken.slice(-6) : 'MISSING',
      accountOwner: ZOHO.accountOwner,
      appLinkName: ZOHO.appLinkName,
    },
    tokenCache: {
      hasToken: !!cachedToken,
      tokenExpiry: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
      isExpired: Date.now() >= tokenExpiry,
    },
    lastTokenError: lastTokenError,
    apiBase: creatorApiBase(),
  };

  // Try to get a fresh token
  try {
    const token = await getAccessToken();
    info.tokenTest = { success: true, tokenPrefix: token ? token.substring(0, 10) + '...' : 'null' };
  } catch (err) {
    info.tokenTest = { success: false, error: err.message };
  }

  res.json(info);
});

// GET /api/project/:id — fetch project info
app.get('/api/project/:id', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;

    console.log('Fetching project:', projectId);
    console.log('URL:', `${creatorApiBase()}/report/All_Projects?criteria=(ID==${projectId})`);

    const resp = await axios.get(
      `${creatorApiBase()}/report/All_Projects?criteria=(ID==${projectId})`,
      { headers: zohoHeaders(token) }
    );

    console.log('Project response status:', resp.status);
    console.log('Project response data keys:', resp.data ? Object.keys(resp.data) : 'null');
    console.log('Project full response:', JSON.stringify(resp.data).substring(0, 500));
    console.log('Project records found:', resp.data?.data?.length || 0);

    if (!resp.data.data || resp.data.data.length === 0) {
      return res.status(404).json({ 
        error: 'Project not found', 
        zoho_response: resp.data,
        url_used: `${creatorApiBase()}/report/All_Projects?criteria=(ID==${projectId})`
      });
    }

    res.json(resp.data.data[0]);
  } catch (err) {
    console.error('Error fetching project:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch project', details: err.response?.data || err.message });
  }
});

// GET /api/project/:id/bom — fetch BOM items for a project
app.get('/api/project/:id/bom', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;

    const resp = await axios.get(
      `${creatorApiBase()}/report/Project_Bill_Of_Material_Detail_Form_Report?criteria=(Project_LU==${projectId})&limit=200`,
      { headers: zohoHeaders(token) }
    );

    const bomItems = (resp.data.data || []).map(row => ({
      id: row.ID,
      bom_item: row.BOM_Item,
      nest_type: row.Nest_Type,
      form_type_id: row.Form_Type?.ID,
      form_type_name: row.Form_Type?.zc_display_value || row.Form_Type?.display_value,
      material_type_id: row.Material_Type?.ID,
      material_type_name: row.Material_Type?.zc_display_value || row.Material_Type?.display_value,
      specification_id: row.Specification?.ID,
      spec_name: row.Specification?.zc_display_value || row.Specification?.display_value,
      material_type_origin: row.Specification?.Material_Type_Origin || '',
      material_id: row.Material?.ID,
      material_name: row.Material?.zc_display_value || row.Material?.display_value,
      material_dim1: row.Material?.Dim1,
      quantity: row.Quantity,
      length_nest: row.Length_Nest,
      width_nest: row.Width_Nest,
      density: row.Density,
      weight_per_ft: row.Weight_Per_Ft,
    }));

    res.json(bomItems);
  } catch (err) {
    console.error('Error fetching BOM:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch BOM', details: err.response?.data || err.message });
  }
});

// GET /api/stock — fetch active stock library
app.get('/api/stock', async (req, res) => {
  try {
    const token = await getAccessToken();

    const resp = await axios.get(
      `${creatorApiBase()}/report/Nesting_Stock_Library_Report?criteria=(Is_Active=="Yes")&limit=200`,
      { headers: zohoHeaders(token) }
    );

    const stock = (resp.data.data || []).map(row => ({
      id: row.ID,
      form_type: row.Form_Type?.ID || row.Form_Type,
      form_type_name: row.Form_Type?.zc_display_value || row.Form_Type,
      material_type: row.Material_Type?.ID || row.Material_Type,
      material_type_name: row.Material_Type?.zc_display_value || row.Material_Type,
      stock_length: row.Stock_Length,
      stock_width: row.Stock_Width,
      density: row.Density_LBS_per_Culin,
      is_standard: row.Is_Standard,
    }));

    res.json(stock);
  } catch (err) {
    console.error('Error fetching stock:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch stock', details: err.response?.data || err.message });
  }
});

// POST /api/nest — run nesting (proxies to existing Railway nesting API)
app.post('/api/nest', async (req, res) => {
  try {
    const resp = await axios.post(NESTING_API_URL, req.body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000,
    });

    res.json(resp.data);
  } catch (err) {
    console.error('Error running nesting:', err.response?.data || err.message);
    res.status(500).json({ error: 'Nesting failed', details: err.response?.data || err.message });
  }
});

// POST /api/project/:id/save-results — save nesting results back to Zoho
app.post('/api/project/:id/save-results', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { results_1d, results_2d, summary, kerf_1d, kerf_2d, run_by } = req.body;

    // 1. Fetch existing runs for this project (handle no-records gracefully)
    let existingRuns = [];
    try {
      const runsResp = await axios.get(
        `${creatorApiBase()}/report/Nesting_Run_Header_Report?criteria=(Project_Lookup==${projectId})`,
        { headers: zohoHeaders(token) }
      );
      existingRuns = runsResp.data.data || [];
    } catch (runsErr) {
      // Zoho returns code 9280 when no records match the criteria — treat as empty
      const zCode = runsErr.response?.data?.code;
      if (zCode === 9280) {
        console.log('No existing nesting runs for this project (first run)');
        existingRuns = [];
      } else {
        throw runsErr;
      }
    }
    const runNum = existingRuns.length + 1;

    // 2. Supersede previous "Approved" runs
    const approvedRuns = existingRuns.filter(
      r => r.Run_Status === 'Approved'
    );
    for (const prevRun of approvedRuns) {
      try {
        await axios.patch(
          `${creatorApiBase()}/report/Nesting_Run_Header_Report/${prevRun.ID}`,
          {
            data: {
              Run_Status: 'Superseded',
            },
          },
          { headers: zohoHeaders(token) }
        );
        console.log(`Superseded run #${prevRun.Run_Number} (ID: ${prevRun.ID})`);
      } catch (supersErr) {
        console.error(`Failed to supersede run ${prevRun.ID}:`, supersErr.response?.data || supersErr.message);
      }
    }

    // 2b. Fetch project record to get MANUFACTURE for Run_By
    let manufactureName = '';
    try {
      const projResp = await axios.get(
        `${creatorApiBase()}/report/All_Projects/${projectId}`,
        { headers: zohoHeaders(token) }
      );
      const projData = projResp.data.data;
      const mfgRaw = projData?.MANUFACTURE;
      manufactureName = mfgRaw?.ID || mfgRaw?.zc_display_value || mfgRaw?.display_value || mfgRaw || '';
      console.log('Project MANUFACTURE raw:', JSON.stringify(mfgRaw), '→ using:', manufactureName);
    } catch (projErr) {
      console.error('Failed to fetch project for MANUFACTURE:', projErr.response?.data || projErr.message);
    }

    // 3. Create Nesting_Run_Header with "Approved" status
    // Run_Date is a Single Line text field — store as timestamp string
    const now = new Date();
    const runDateStr = `${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getDate().toString().padStart(2,'0')}/${now.getFullYear()} ${now.toTimeString().slice(0,8)}`;

    const headerData = {
      Project_Lookup: projectId,
      Run_Number: runNum,
      Run_Date: runDateStr,
      Run_Status: 'Approved',
      Added_User: 'web_app',
    };
    if (run_by) {
      headerData.Run_By = run_by;
    } else if (manufactureName) {
      headerData.Run_By = manufactureName;
    }
    if (kerf_1d !== undefined) headerData.Kerf_1D = kerf_1d;
    if (kerf_2d !== undefined) headerData.Kerf_2D = kerf_2d;

    console.log('Header create payload:', JSON.stringify(headerData));

    const headerResp = await axios.post(
      `${creatorApiBase()}/form/Nesting_Run_Header`,
      { data: headerData },
      { headers: zohoHeaders(token) }
    );

    console.log('Header create response:', JSON.stringify(headerResp.data));
    const nestRunID = headerResp.data.data.ID;

    // 4. Save 1D results — cut details embedded as subform rows
    let savedCount1D = 0;
    for (const result of results_1d || []) {
      if (result.error) continue;
      if (!result.cuts || result.cuts.length === 0) continue;

      const firstCut = result.cuts[0];
      try {
        // Build cut detail subform rows
        const cutDetailRows = result.cuts.map((cut, idx) => ({
          BOM_Line_Lookup: cut.bom_line_id,
          Part_Mark: cut.part_mark,
          Cut_Length: cut.cut_length,
          Quantity_On_This_Stock: cut.quantity_on_this_stock,
          Cut_Sequence: idx + 1,
        }));

        const srData = {
          Nesting_Run_Header: nestRunID,
          Nesting_Type: '1D - Linear',
          Form_Type: result.form_type,
          Material_Type: result.material_origin,
          Specification: firstCut.spec_name,
          Material: firstCut.material_type,
          Stock_Size_Label: result.stock_label || firstCut.stock_label || '',
          Stock_Length: result.stock_length_in,
          Stock_Thickness: result.stock_thickness || firstCut.stock_thickness || 0,
          Remnant_Length: Math.round((result.remnant_length_in || 0) * 100) / 100,
          Waste_Percentage: result.waste_percentage,
          Stock_Weight_LBS: result.stock_weight_lbs || 0,
          Stock_Sequence: result.stock_sequence || savedCount1D + 1,
          Nesting_Cut_Detail: cutDetailRows,
        };
        console.log('1D Stock Result payload:', JSON.stringify(srData));
        const srResp = await axios.post(
          `${creatorApiBase()}/form/Nesting_Stock_Result`,
          { data: srData },
          { headers: zohoHeaders(token) }
        );
        console.log('1D Stock Result response:', JSON.stringify(srResp.data));

        if (!srResp.data?.data?.ID) {
          console.error('1D Stock Result - no ID in response:', JSON.stringify(srResp.data));
          continue;
        }
        savedCount1D++;
      } catch (srErr) {
        console.error(`Error saving 1D stock result ${savedCount1D + 1}:`, srErr.response?.data || srErr.message);
      }
    }

    // 5. Save 2D results — cut details embedded as subform rows
    let savedCount2D = 0;
    for (const result of results_2d || []) {
      if (result.error) continue;
      if (!result.cuts || result.cuts.length === 0) continue;

      const firstCut = result.cuts[0];
      try {
        // Build cut detail subform rows
        const cutDetailRows = result.cuts.map((cut, idx) => ({
          BOM_Line_Lookup: cut.bom_line_id,
          Part_Mark: cut.part_mark,
          Cut_Length: cut.cut_length,
          Cut_Width: cut.cut_width,
          Quantity_On_This_Stock: cut.quantity_on_this_stock,
          X_Position: cut.x_position || 0,
          Y_Position: cut.y_position || 0,
          Rotation: cut.rotation === 90 ? '90°' : '0°',
          Cut_Sequence: idx + 1,
        }));

        const srData = {
          Nesting_Run_Header: nestRunID,
          Nesting_Type: '2D - Panel',
          Form_Type: result.form_type,
          Material_Type: result.material_origin,
          Specification: firstCut.spec_name,
          Material: firstCut.material_type,
          Stock_Size_Label: result.stock_label || firstCut.stock_label || '',
          Stock_Length: result.stock_length_in,
          Stock_Width: result.stock_width_in,
          Stock_Thickness: result.stock_thickness || firstCut.stock_thickness || 0,
          Remnant_Area: result.remnant_area_in2 || 0,
          Waste_Percentage: result.waste_percentage,
          Stock_Weight_LBS: result.stock_weight_lbs || 0,
          Stock_Sequence: result.stock_sequence || savedCount2D + 1,
          Nesting_Cut_Detail: cutDetailRows,
        };

        console.log('2D Stock Result payload:', JSON.stringify(srData));
        const srResp = await axios.post(
          `${creatorApiBase()}/form/Nesting_Stock_Result`,
          { data: srData },
          { headers: zohoHeaders(token) }
        );
        console.log('2D Stock Result response:', JSON.stringify(srResp.data));

        if (!srResp.data?.data?.ID) {
          console.error('2D Stock Result - no ID in response:', JSON.stringify(srResp.data));
          continue;
        }
        savedCount2D++;
      } catch (srErr) {
        console.error(`Error saving 2D stock result ${savedCount2D + 1}:`, srErr.response?.data || srErr.message);
      }
    }

    // 6. Update run header with summary (Total_Stock_Pieces, Total_Waste_Inches, Notes)
    const supersededCount = approvedRuns.length;
    const totalWaste = summary?.total_remnant_length_in || 0;
    const wastePct = summary?.avg_waste_pct_1d || 0;
    const notesStr = `Saved ${savedCount1D} 1D + ${savedCount2D} 2D results | Waste: ${wastePct}%${supersededCount > 0 ? ` | Superseded ${supersededCount} previous run(s)` : ''}`;

    try {
      const patchData = {
        Total_Stock_Pieces: (savedCount1D + savedCount2D) || 0,
        Total_Waste_Inches: Math.round(totalWaste * 10000) / 10000,
        Notes: notesStr,
      };
      console.log('Header PATCH payload:', JSON.stringify(patchData));

      // Try report endpoint first
      const reportUrl = `${creatorApiBase()}/report/Nesting_Run_Header_Report/${nestRunID}`;
      console.log('Header PATCH URL (report):', reportUrl);

      let patchSuccess = false;
      try {
        const patchResp = await axios.patch(
          reportUrl,
          { data: patchData },
          { 
            headers: {
              ...zohoHeaders(token),
              'Content-Type': 'application/json',
            }
          }
        );
        console.log('Header PATCH response (report):', JSON.stringify(patchResp.data));
        // Check if Zoho returned an error code
        if (patchResp.data?.code === 3000 || patchResp.data?.data) {
          patchSuccess = true;
        }
      } catch (reportErr) {
        console.error('Report PATCH failed:', JSON.stringify(reportErr.response?.data || reportErr.message));
      }

      // Fallback: try form endpoint if report failed
      if (!patchSuccess) {
        console.log('Trying form endpoint fallback...');
        const formUrl = `${creatorApiBase()}/form/Nesting_Run_Header/${nestRunID}`;
        console.log('Header PATCH URL (form):', formUrl);
        try {
          const formResp = await axios.patch(
            formUrl,
            { data: patchData },
            { 
              headers: {
                ...zohoHeaders(token),
                'Content-Type': 'application/json',
              }
            }
          );
          console.log('Header PATCH response (form):', JSON.stringify(formResp.data));
        } catch (formErr) {
          console.error('Form PATCH also failed:', JSON.stringify(formErr.response?.data || formErr.message));
          console.error('Form PATCH error status:', formErr.response?.status);
        }
      }
    } catch (patchErr) {
      console.error('ERROR updating run header summary:', JSON.stringify(patchErr.response?.data || patchErr.message));
      console.error('ERROR status:', patchErr.response?.status);
    }

    res.json({
      success: true,
      nest_run_id: nestRunID,
      run_number: runNum,
      run_status: 'Approved',
      saved_1d: savedCount1D,
      saved_2d: savedCount2D,
      superseded_runs: supersededCount,
    });
  } catch (err) {
    console.error('Error saving results:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to save results', details: err.response?.data || err.message });
  }
});

// POST /api/project/:id/generate-purchase-list
app.post('/api/project/:id/generate-purchase-list', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { purchase_lines } = req.body;

    if (!purchase_lines || purchase_lines.length === 0) {
      return res.status(400).json({ error: 'No purchase lines provided' });
    }

    const subformRows = purchase_lines.map((line, idx) => {
      const row = {
        Form_Type: line.form_type_id,
        Material_Types: line.material_type_id,
        Specification: line.specification_id,
        Material: line.material_id,
        Item_Description: line.description || '',
        QTY: line.quantity,
        Feet_Length: line.feet_length || 0,
        Weight_Per_Ft: line.weight_per_ft || 0,
        Unit_Weight: line.unit_weight || 0,
        CutWeight: line.total_weight || 0,
      };
      return row;
    });

    await axios.patch(
      `${creatorApiBase()}/report/All_Projects/${projectId}`,
      {
        data: {
          Material_Allocated: subformRows,
        },
      },
      { headers: zohoHeaders(token) }
    );

    res.json({ success: true, items_saved: subformRows.length });
  } catch (err) {
    console.error('Error saving purchase list:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to save purchase list', details: err.response?.data || err.message });
  }
});

// Catch-all: serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html'));
});

// ─── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Material Compass Nesting server running on port ${PORT}`);
});
