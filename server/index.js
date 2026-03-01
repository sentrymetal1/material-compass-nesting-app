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

// ─── Token Cache ───────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const resp = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: ZOHO.refreshToken,
      client_id: ZOHO.clientId,
      client_secret: ZOHO.clientSecret,
      grant_type: 'refresh_token',
    },
  });

  cachedToken = resp.data.access_token;
  tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000; // refresh 1 min early
  return cachedToken;
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

// GET /api/project/:id — fetch project info
app.get('/api/project/:id', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;

    const resp = await axios.get(
      `${creatorApiBase()}/report/All_Projects?criteria=(ID==${projectId})`,
      { headers: zohoHeaders(token) }
    );

    if (!resp.data.data || resp.data.data.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
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
// Frontend sends only enabled stock (user can toggle library stock on/off and add custom sizes)
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
// STATUS-BASED FLOW: Previous "Approved" runs → "Superseded", new run → "Approved"
app.post('/api/project/:id/save-results', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { results_1d, results_2d, summary, kerf_1d, kerf_2d, run_by } = req.body;

    // 1. Fetch existing runs for this project
    const runsResp = await axios.get(
      `${creatorApiBase()}/report/Nesting_Run_Header_Report?criteria=(Project_Lookup==${projectId})`,
      { headers: zohoHeaders(token) }
    );
    const existingRuns = runsResp.data.data || [];
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
        // Continue — don't block the new run if superseding fails
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
      manufactureName = projData?.MANUFACTURE?.zc_display_value || projData?.MANUFACTURE?.display_value || projData?.MANUFACTURE || '';
      console.log('Project MANUFACTURE:', manufactureName);
    } catch (projErr) {
      console.error('Failed to fetch project for MANUFACTURE:', projErr.response?.data || projErr.message);
    }

    // 3. Create Nesting_Run_Header with "Approved" status
    const now = new Date();
    const runDate = `${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getDate().toString().padStart(2,'0')}/${now.getFullYear()} ${now.toTimeString().slice(0,8)}`;
    const headerData = {
      Project_Lookup: projectId,
      Run_Number: runNum,
      Run_Status: 'Approved',
      Run_Date: runDate,
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

    // 4. Save 1D results (only selected patterns sent from frontend)
    let savedCount1D = 0;
    for (const result of results_1d || []) {
      if (result.error) continue;
      if (!result.cuts || result.cuts.length === 0) continue;

      const firstCut = result.cuts[0];
      try {
        const srData = {
          Nesting_Run_Header: nestRunID,
          Nesting_Type: '1D - Linear',
          Form_Type: result.form_type,
          Material_Type: result.material_origin,
          Specification: firstCut.spec_name,
          Material: firstCut.material_type,
          Stock_Size_Label: firstCut.stock_label || '',
          Stock_Length: result.stock_length_in,
          Remnant_Length: Math.round((result.remnant_length_in || 0) * 100) / 100,
          Waste_Percentage: result.waste_percentage,
          Stock_Weight_LBS: result.stock_weight_lbs || 0,
          Stock_Sequence: result.stock_sequence || savedCount1D + 1,
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
        const srID = srResp.data.data.ID;
        let cutSeq = 1;
        for (const cut of result.cuts) {
          await axios.post(
            `${creatorApiBase()}/form/Nesting_Cut_Detail`,
            {
              data: {
                Nesting_Stock_Result: srID,
                BOM_Line_Lookup: cut.bom_line_id,
                Part_Mark: cut.part_mark,
                Cut_Length: cut.cut_length,
                Quantity_On_This_Stock: cut.quantity_on_this_stock,
                Cut_Sequence: cutSeq,
              },
            },
            { headers: zohoHeaders(token) }
          );
          cutSeq++;
        }
        savedCount1D++;
      } catch (srErr) {
        console.error(`Error saving 1D stock result ${savedCount1D + 1}:`, srErr.response?.data || srErr.message);
      }
    }

    // 5. Save 2D results (only selected patterns sent from frontend)
    let savedCount2D = 0;
    for (const result of results_2d || []) {
      if (result.error) continue;
      if (!result.cuts || result.cuts.length === 0) continue;

      const firstCut = result.cuts[0];
      try {
        const srResp = await axios.post(
          `${creatorApiBase()}/form/Nesting_Stock_Result`,
          {
            data: {
              Nesting_Run_Header: nestRunID,
              Nesting_Type: '2D - Panel',
              Form_Type: result.form_type,
              Material_Type: result.material_origin,
              Specification: firstCut.spec_name,
              Material: firstCut.material_type,
              Stock_Size_Label: firstCut.stock_label || '',
              Stock_Length: result.stock_length_in,
              Stock_Width: result.stock_width_in,
              Remnant_Area: result.remnant_area_in2 || 0,
              Waste_Percentage: result.waste_percentage,
              Stock_Weight_LBS: result.stock_weight_lbs || 0,
              Stock_Sequence: result.stock_sequence || savedCount2D + 1,
            },
          },
          { headers: zohoHeaders(token) }
        );

        const srID = srResp.data.data.ID;
        let cutSeq = 1;
        for (const cut of result.cuts) {
          await axios.post(
            `${creatorApiBase()}/form/Nesting_Cut_Detail`,
            {
              data: {
                Nesting_Stock_Result: srID,
                BOM_Line_Lookup: cut.bom_line_id,
                Part_Mark: cut.part_mark,
                Cut_Length: cut.cut_length,
                Cut_Width: cut.cut_width,
                Quantity_On_This_Stock: cut.quantity_on_this_stock,
                X_Position: cut.x_position || 0,
                Y_Position: cut.y_position || 0,
                Rotation: cut.rotation === 90 ? '90°' : '0°',
                Cut_Sequence: cutSeq,
              },
            },
            { headers: zohoHeaders(token) }
          );
          cutSeq++;
        }
        savedCount2D++;
      } catch (srErr) {
        console.error(`Error saving 2D stock result ${savedCount2D + 1}:`, srErr.response?.data || srErr.message);
      }
    }

    // 6. Update run header with summary (total pieces, waste, notes)
    const supersededCount = approvedRuns.length;
    const totalWaste = summary?.total_remnant_length_in || 0;
    const wastePct = summary?.avg_waste_pct_1d || 0;
    const notesStr = `Saved ${savedCount1D} 1D + ${savedCount2D} 2D results | Waste: ${wastePct}%${supersededCount > 0 ? ` | Superseded ${supersededCount} previous run(s)` : ''}`;

    try {
      const patchData = {
        Total_Stock_Pieces: (savedCount1D + savedCount2D) || 0,
        Total_Waste_Inches: totalWaste,
        Notes: notesStr,
      };
      console.log('Header PATCH payload:', JSON.stringify(patchData));
      
      const patchResp = await axios.patch(
        `${creatorApiBase()}/report/Nesting_Run_Header_Report/${nestRunID}`,
        {
          data: patchData,
        },
        { headers: zohoHeaders(token) }
      );
      console.log('Header PATCH response:', JSON.stringify(patchResp.data));
    } catch (patchErr) {
      console.error('ERROR updating run header summary:', patchErr.response?.data || patchErr.message);
      // Don't fail the whole save — the results are already saved
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

// POST /api/project/:id/generate-purchase-list — aggregate nesting results into Material_Allocated subform
app.post('/api/project/:id/generate-purchase-list', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { purchase_lines } = req.body; // pre-aggregated from frontend

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

    // Update the project record's Material_Allocated subform
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

// POST /api/project/:id/save-purchase-material — write to Purchase Material subform
app.post('/api/project/:id/save-purchase-material', async (req, res) => {
  try {
    const token = await getAccessToken();
    const projectId = req.params.id;
    const { items } = req.body; // array of purchase material line items

    const subformRows = items.map((item, idx) => ({
      Line_Item_Fitting: idx + 1,
      Form_Type: item.form_type_id,
      Material_Types: item.material_type_id,
      Specification: item.specification_id,
      Material: item.material_id,
      Item_Description: item.description || '',
      QTY: item.quantity,
      Feet_Length: item.feet_length || 0,
      Length_INCH: item.length_inch || '',
      Width_FT: item.width_ft || '',
      Width_INCH: item.width_inch || '',
      Weight_Per_FT: item.weight_per_ft || 0,
      Unit_Weight: item.unit_weight || 0,
      CutWeight: item.total_weight || 0,
    }));

    // Update the project record's Material_Allocated subform
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
    console.error('Error saving purchase material:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to save purchase material', details: err.response?.data || err.message });
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
