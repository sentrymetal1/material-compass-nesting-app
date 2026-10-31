// =============================================================================
//  mfgRfq.js — the manufacturer sends a material quote (RFQ) to suppliers, off Zoho.
// -----------------------------------------------------------------------------
//  The screen replaces the Zoho Quote Form's UI only. The send itself is ONE addRecord
//  to Quote_Form with its two line subforms nested, so Zoho's own submit workflows run
//  exactly as they do for a human submit: "Assign Quote Number" (MMQ- number, one quote
//  per project), QuoteVerifyInfoBeforeSend, and "Execute Matching and Send Emails"
//  (supplier stock matching, RFQs_Sent / RFQs_Sent_Fittings rows, the emails). The same
//  pattern as the supplier's /quote-submit into Supplier_Verify_Form.
//
//  The lines are built here the way the Quote Form's "Add Material From Project" button
//  (workflow "Populate JeffCalcs Subform") builds them — a field-for-field copy of that
//  Deluge, so the matching engine sees the rows it always has. User-input workflows
//  never fire on an API add, which is why that copy has to happen here.
// =============================================================================

const PURCHASE_REPORT = 'Project_Material_Allocated_Detail_Form_Report';
const FITTING_REPORT = 'Project_Allocate_Quote_Form_Report';

// Quote_Form.Quote_Requirements — same choice list the supplier side confirms against.
const QUOTE_REQUIREMENTS = [
  'AIS - Made & Melted in USA', 'API Q1', 'API Q2', 'ASME', 'DFARS 252.225-7009',
  'ISO 14000', 'ISO 14001', 'ISO 17025', 'ISO 22000', 'ISO 45001', 'ISO 50001',
  'ISO 9000', 'ISO 9001', 'MIL-STD-129', 'MTRs Required',
];

// Columns the copy needs that the API only returns when the report shows them. A missing
// Material_Source would let On Hand material be RFQ'd, so the send refuses without it.
const REQUIRED_PURCHASE_COLUMNS = ['Material_Source'];

const lkid = v => (v && typeof v === 'object' ? String(v.ID || '') : (v != null ? String(v) : ''));
const disp = v => (v && typeof v === 'object' ? String(v.zc_display_value != null ? v.zc_display_value : (v.Description || '')) : (v != null ? String(v) : ''));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const truthy = v => v === true || v === 'true';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = n => String(n).padStart(2, '0');
function toZohoDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[3] + ',' + m[1] : '';
}
function zohoToday() { const d = new Date(); return MONTHS[d.getMonth()] + ' ' + p2(d.getDate()) + ',' + d.getFullYear(); }
function zohoNow() { const d = new Date(); return zohoToday() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
// Drop blanks: an empty string sent to a lookup, number or choice field can be rejected.
function clean(o) {
  const out = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

// One structural line, as "Populate JeffCalcs Subform" card 1 builds it.
function jeffCalcsRow(s, n, ctx) {
  const lengthFt = num(s.Feet_Length), lengthInchResult = num(s.Length_INCH_Result);
  return clean({
    Project_ID: ctx.projectId,
    Project_ID_Number: ctx.projectId,
    Form_Types: lkid(s.Form_Type),
    Material_Types: lkid(s.Material_Type),
    Material_Form_Detail: lkid(s.Specification),
    Form_Type_ID: lkid(s.Form_Type),
    Dim1_Result: s.Dim1_Result,
    Length_INCH: lkid(s.Length_INCH),
    Width_FT: lkid(s.Width_FT),
    Width_INCH: lkid(s.Width_INCH),
    Material: lkid(s.Material),
    Material_ID: lkid(s.Material),
    Project_Material_Allocated_Detail_Form: String(s.ID),
    Weight_Per_FT: s.Weight_Per_FT,
    Width_Full_Text: disp(s.Width_FT) + '-' + disp(s.Width_INCH),
    Dim2_Result: s.Dim2_Result,
    Dim3_Result: s.Dim3_Result,
    Form_Types_Counter: s.Form_Types_Counter,
    Form_Types_String: s.Form_Types_String || disp(s.Form_Type),
    Material_Types_String: s.Material_Types_String || disp(s.Material_Type),
    Total_Plate_Width: s.Total_Plate_Width,
    Full_Item_Description_String: s.Item_Description,   // card 1 sets it twice; the last write wins
    Length_FT: s.Feet_Length,
    Form_Type_Multi_Select: s.Form_Type_Multi_Select,
    Material_Type_Multi_Select: s.Material_Type_Multi_Select,
    Specification_Multi_Select: s.Specification_Multi_Select,
    Material_Multi_Select: s.Material_Multi_Select,
    Length_INCH_Result: s.Length_INCH_Result,
    Quantity: s.QTY,
    Area: s.Area,
    Unit_Weight: s.Unit_Weight,
    CalcWeight: s.CalcWeight,
    Customer_LU: ctx.mfg,
    Quote_Line_Item: n,
    Account_Type: ctx.accountType,
    Full_Description_and_Dimension: s.Item_QTY_and_Description,
    Full_Item_Description_and_Dimension: s.Item_QTY_and_Description,
    Total_Length: Math.round((lengthFt + lengthInchResult / 12) * 10000) / 10000,
    Populate: ['YES'],
    // Field defaults a form submit fills and an API insert does not (every live line carries them).
    Item_Requirements: ['Stock Size'],
    Part_Number: 'N/A',
    New_Material_Needed: false,
    Revise_by_Manufacture: false,
    Item_Timestamp: ctx.now,
  });
}

// One fitting line, as card 3 builds it. Fitting_Description is a dropdown the Deluge fills
// with ui.add — REST can't write an unlisted dropdown value — so only its _Text twin goes.
function fittingRow(f, n, ctx) {
  const d = k => disp(f[k]);
  return clean({
    MCP_Customer_Project_Form: ctx.projectId,
    Fitting: f.Fitting,
    Fitting_Type: lkid(f.Fitting_Type),
    Fitting_Type_Multi_Select: f.Fitting_Type_Multi_Select,
    Fitting_Make_Multi_Select: f.Fitting_Make_Multi_Select,
    Fitting_Specification_Multi_Select: f.Fitting_Specification_Multi_Select,
    End_Type_Multi_Select: f.End_Type_Multi_Select,
    Connection_Type_Multi_Select: f.Connection_Type_Multi_Select,
    Project_Allocate_Quote_Form: String(f.ID),
    Fitting_Type_Original: lkid(f.Fitting_Type_Original) || undefined,
    Fitting_Make_Original: lkid(f.Fitting_Make_Original) || undefined,
    Fitting_Specification_Original: lkid(f.Fitting_Specification_Original) || undefined,
    Fitting_End_Type_Original: lkid(f.Fitting_End_Type_Original) || undefined,
    Fitting_Connection_Type_Original: lkid(f.Fitting_Connection_Type_Original) || undefined,
    Fitting_Description_Text: f.Fitting_Description_Text,
    Fitting_ID: lkid(f.Fitting_ID),
    Fittings_Butt_Weld: lkid(f.Fittings_Butt_Weld),
    Fittings_Socket_Weld: lkid(f.Fittings_Socket_Weld),
    Fitting_Make: lkid(f.Fitting_Make),
    Fitting_Specification: lkid(f.Fitting_Specification),
    End_Type: lkid(f.End_Type),
    Connection_Type: lkid(f.Connection_Type),
    Fitting_Description_with_Item_and_Quantity: 'Item No. ' + (f.Line_Item_Fitting || '') + ' | QTY ' + (f.Quantity || '')
      + ' | ' + d('Fitting_Type') + ' | ' + d('Fitting_Make') + ' | ' + d('End_Type') + ' | ' + d('Connection_Type')
      + ' | ' + d('Fitting_Specification') + ' - ' + (f.Fitting_Description_Text || disp(f.Fitting_Description)),
    Quantity: f.Quantity,
    Total_Weight: f.Total_Weight,
    Weight: f.Weight,
    Line_Item_Fitting: n,
  });
}

function registerMfgRfqRoutes(app, deps) {
  const { fetchAllZohoPages, cachedLookup, cacheBust, sendZohoAwareError, getAccessToken, creatorApiBase, zohoHeaders, axios } = deps;
  const enc = s => encodeURIComponent(s);
  const fail = (res, err) => {
    if (sendZohoAwareError) return sendZohoAwareError(res, err);
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  };

  // The shop this request is for. A valid token for another shop is refused even in warn mode.
  function mfgOf(req, res) {
    const q = req.query || {}, b = req.body || {};
    const mfg = String(q.manufacturer_id || b.manufacturer_id || '').trim();
    if (!/^\d+$/.test(mfg) || (req.tenant && req.tenant.kind === 'm' && String(req.tenant.id) !== mfg)) {
      res.status(400).json({ ok: false, error: 'Please reopen this page from Material Compass.' });
      return null;
    }
    return mfg;
  }

  const quotesOf = mfg => cachedLookup('rfq-quotes:' + mfg, 60 * 1000, () =>
    fetchAllZohoPages('/report/All_Quotes?criteria=' + enc('(Customer_Entry_Form==' + mfg + ')')));
  const projectsOf = mfg => cachedLookup('rfq-projects:' + mfg, 60 * 1000, () =>
    fetchAllZohoPages('/report/All_Projects?criteria=' + enc('(MANUFACTURE==' + mfg + ')')));

  // A project's quote, if it has one. The Quote Form allows ONE quote per project, ever;
  // changes go through Revise. (Same rule "Assign Quote Number" enforces at submit.)
  const quoteByProject = quotes => {
    const m = new Map();
    // Newest record wins, so a revised quote reports its current revision, not the original.
    for (const q of quotes) {
      const pid = lkid(q.Project_Number);
      if (pid && (!m.has(pid) || Number(q.ID) > Number(m.get(pid).ID))) m.set(pid, q);
    }
    return m;
  };

  // GET /api/mfg/rfq/projects — the shop's projects, with any quote already on them.
  app.get('/api/mfg/rfq/projects', async (req, res) => {
    const mfg = mfgOf(req, res); if (!mfg) return;
    try {
      const [projects, quotes] = await Promise.all([projectsOf(mfg), quotesOf(mfg)]);
      const byProject = quoteByProject(quotes);
      const out = projects.map(p => {
        const q = byProject.get(String(p.ID));
        return {
          id: String(p.ID),
          number: p.Project_Quote_Number || '',
          description: p.Project_Description || '',
          client: disp(p.MFG_Client_Form),
          status: p.Project_Quote_Status || '',
          quote_number: q ? (q.Reference_Number || '') : '',
          quote_status: q ? (q.Status || '') : '',
        };
      }).sort((a, b) => Number(b.id) - Number(a.id));
      res.json({ ok: true, projects: out });
    } catch (err) { fail(res, err); }
  });

  // Everything the screen and the send need for one project.
  async function loadProject(mfg, projectId) {
    const [projects, quotes, purchase, fittings, matches, reps, shop] = await Promise.all([
      projectsOf(mfg),
      quotesOf(mfg),
      fetchAllZohoPages('/report/' + PURCHASE_REPORT + '?criteria=' + enc('(MCP_Customer_Project_Form==' + projectId + ')')),
      fetchAllZohoPages('/report/' + FITTING_REPORT + '?criteria=' + enc('(MCP_Customer_Project_Form==' + projectId + ')')).catch(() => []),
      cachedLookup('rfq-matches:' + mfg, 5 * 60 * 1000, () =>
        fetchAllZohoPages('/report/All_Supplier_Manufacture_Matches?criteria=' + enc('(MANUFACTURE==' + mfg + ')'))),
      cachedLookup('mfg-reps:' + mfg, 10 * 60 * 1000, () =>
        fetchAllZohoPages('/report/All_Company_Representatives?criteria=' + enc('(Manufacture==' + mfg + ')'))),
      cachedLookup('rfq-shop:' + mfg, 10 * 60 * 1000, () =>
        fetchAllZohoPages('/report/Customer_Entry_Report?criteria=' + enc('(ID==' + mfg + ')'))),
    ]);
    const project = projects.find(p => String(p.ID) === String(projectId));
    if (!project) return null;
    const existing = quoteByProject(quotes).get(String(projectId)) || null;
    const missingColumns = purchase.length
      ? REQUIRED_PURCHASE_COLUMNS.filter(c => !purchase.some(r => Object.prototype.hasOwnProperty.call(r, c)))
      : [];
    const sorted = purchase.slice().sort((a, b) => num(a.Line_Item) - num(b.Line_Item));
    // Same selection as card 1: not already on a quote, and not On Hand (blank counts as purchase).
    const lines = sorted.map(s => ({
      raw: s,
      id: String(s.ID),
      line: s.Line_Item || '',
      description: s.Item_Description || s.Description || '',
      qty: num(s.QTY),
      weight: num(s.CalcWeight),
      on_hand: s.Material_Source === 'On Hand',
      already_quoted: truthy(s.Material_Used_For_Original_Material_Quote),
    }));
    return {
      project, existing, missingColumns, lines,
      fittings: fittings.slice().sort((a, b) => num(a.Line_Item_Fitting) - num(b.Line_Item_Fitting)),
      matches, reps,
      accountType: (shop[0] && shop[0].Type_Of_Material_Needs) || '',
    };
  }

  // GET /api/mfg/rfq/project?project_id= — lines, fittings, suppliers and contacts.
  app.get('/api/mfg/rfq/project', async (req, res) => {
    const mfg = mfgOf(req, res); if (!mfg) return;
    const projectId = String(req.query.project_id || '').trim();
    if (!/^\d+$/.test(projectId)) return res.status(400).json({ ok: false, error: 'Choose a project.' });
    try {
      const p = await loadProject(mfg, projectId);
      if (!p) return res.status(404).json({ ok: false, error: 'Project not found for this shop.' });
      const pr = p.project;
      res.json({
        ok: true,
        project: {
          id: String(pr.ID), number: pr.Project_Quote_Number || '', description: pr.Project_Description || '',
          client: disp(pr.MFG_Client_Form), client_id: lkid(pr.MFG_Client_Form),
          status: pr.Project_Quote_Status || '', rep_id: lkid(pr.Manufacture_Representative),
        },
        existing_quote: p.existing ? { id: String(p.existing.ID), number: p.existing.Reference_Number || '', status: p.existing.Status || '' } : null,
        missing_columns: p.missingColumns,
        lines: p.lines.map(({ raw, ...l }) => l),
        fittings: p.fittings.map(f => ({
          id: String(f.ID), line: f.Line_Item_Fitting || '', qty: num(f.Quantity), weight: num(f.Total_Weight),
          description: [disp(f.Fitting_Type), disp(f.Fitting_Make), disp(f.End_Type), disp(f.Connection_Type), disp(f.Fitting_Specification)]
            .filter(Boolean).join(' · ') + (f.Fitting_Description_Text ? '  ·  ' + f.Fitting_Description_Text : ''),
        })),
        suppliers: p.matches
          .filter(m => lkid(m.SUPPLIER) && !truthy(m.Hide_Supplier_From_Matching))
          .map(m => ({
            match_id: String(m.ID),
            supplier_id: lkid(m.SUPPLIER),
            name: (m.SUPPLIER && (m.SUPPLIER.Company_Name || m.SUPPLIER.zc_display_value)) || 'Supplier',
            accepts: /^YES/i.test(m.Supplier_Accept_Quotes_From_Manufacture || ''),
            declined: /^NO/i.test(m.Supplier_Accept_Quotes_From_Manufacture || '') || /^NO/i.test(m.Manufacture_Accept_Quotes_From_Supplier || ''),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        contacts: p.reps.map(r => ({ id: String(r.ID), name: disp(r.Name).trim() || r.Email || '' })),
        requirements: QUOTE_REQUIREMENTS,
        account_type: p.accountType,
      });
    } catch (err) { fail(res, err); }
  });

  // POST /api/mfg/rfq/send — create the Quote_Form; Zoho's submit workflows do the rest.
  app.post('/api/mfg/rfq/send', async (req, res) => {
    const mfg = mfgOf(req, res); if (!mfg) return;
    const b = req.body || {};
    const projectId = String(b.project_id || '').trim();
    const matchIds = Array.isArray(b.supplier_match_ids) ? b.supplier_match_ids.map(String).filter(x => /^\d+$/.test(x)) : [];
    if (!/^\d+$/.test(projectId)) return res.status(400).json({ ok: false, error: 'Choose a project.' });
    if (!matchIds.length) return res.status(400).json({ ok: false, error: 'Choose at least one supplier.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date || ''))) return res.status(400).json({ ok: false, error: 'Choose the date responses are due.' });
    try {
      const p = await loadProject(mfg, projectId);
      if (!p) return res.status(404).json({ ok: false, error: 'Project not found for this shop.' });
      if (p.existing) {
        return res.status(409).json({ ok: false, error: 'This project already has quote ' + (p.existing.Reference_Number || '') + '. Use Revise on that quote instead.' });
      }
      if (p.missingColumns.length) {
        return res.status(409).json({ ok: false, error: 'The project material report is missing column(s): ' + p.missingColumns.join(', ') + '. Without them On Hand material could be sent out, so nothing was sent.' });
      }
      // Only the shop's own matches can be sent to.
      const mine = new Set(p.matches.map(m => String(m.ID)));
      const bad = matchIds.filter(id => !mine.has(id));
      if (bad.length) return res.status(400).json({ ok: false, error: 'One or more suppliers are not matched to your shop.' });

      const ctx = { mfg, projectId, accountType: p.accountType, now: zohoNow() };
      const quotable = p.lines.filter(l => !l.on_hand && !l.already_quoted);
      const jc = quotable.map((l, i) => jeffCalcsRow(l.raw, i + 1, ctx));
      const fit = p.fittings.map((f, i) => fittingRow(f, i + 1, ctx));
      if (!jc.length && !fit.length) return res.status(400).json({ ok: false, error: 'This project has no material or fittings to quote.' });
      const structWt = Math.round(quotable.reduce((s, l) => s + l.weight, 0) * 100) / 100;
      const fitWt = Math.round(p.fittings.reduce((s, f) => s + num(f.Total_Weight), 0) * 100) / 100;

      const pr = p.project;
      const contact = String(b.contact_id || '').trim() || lkid(pr.Manufacture_Representative);
      const reqs = Array.isArray(b.requirements) ? b.requirements.filter(r => QUOTE_REQUIREMENTS.includes(r)) : [];
      const data = clean({
        Customer_Entry_Form: mfg,
        MFG_Customer: lkid(pr.MFG_Client_Form),
        Project_Number: projectId,
        Contact_Name: /^\d+$/.test(contact) ? contact : '',
        Quote_Description: String(b.description || pr.Project_Description || '').trim(),
        Date_field: zohoToday(),
        Requested_Responses_Due: toZohoDate(b.due_date),
        TimeStamp: zohoNow(),
        // "Assign Quote Number" (Created validation) issues the real MMQ- number for this
        // choice; Reference_Number is mandatory, so it needs a placeholder to get that far.
        Auto_Number_or_Enter_Quote_Number: 'Use Auto Number System for Quote Number',
        Reference_Number: 'MMQ-PENDING',
        Revise: false,
        Structural_Match_Choices: matchIds,
        Quote_Requirements: reqs,
        Manufacture_Account_Type: p.accountType,
        Total_Structural_Weight: structWt,
        Total_Fittings_Weight: fitWt,
        Total_Weight: Math.round((structWt + fitWt) * 100) / 100,
        Quote_Total_Weight: Math.round((structWt + fitWt) * 100) / 100,
        JeffCals_SubForm: jc,
        Fitting_Subform: fit,
      });

      const token = await getAccessToken();
      let r;
      try {
        r = await axios.post(creatorApiBase() + '/form/Quote_Form', { data }, { headers: { ...zohoHeaders(token), 'Content-Type': 'application/json' } });
      } catch (e) {
        const d = e.response && e.response.data;
        return res.status(502).json({ ok: false, error: 'Zoho refused the quote. Nothing was sent.', reasons: reasonsOf(d), detail: d || e.message });
      }
      const code = r.data && r.data.code;
      if (code !== 3000) {
        return res.status(502).json({ ok: false, error: 'Zoho refused the quote. Nothing was sent.', reasons: reasonsOf(r.data), detail: r.data });
      }
      const quoteId = String((r.data.data && r.data.data.ID) || '');
      bust('rfq-quotes:' + mfg); bust('rfq-projects:' + mfg); bust('mfg-sent-rfqs:' + mfg);
      // Read back the number Zoho issued (best-effort: the quote exists either way).
      let number = '';
      try {
        const back = await fetchAllZohoPages('/report/All_Quotes?criteria=' + enc('(ID==' + quoteId + ')'));
        number = (back[0] && back[0].Reference_Number) || '';
      } catch (e) { /* the send already happened */ }
      res.json({ ok: true, quote_id: quoteId, quote_number: number, lines: jc.length, fittings: fit.length, suppliers: matchIds.length });
    } catch (err) { fail(res, err); }
  });

  function bust(k) { if (typeof cacheBust === 'function') cacheBust(k); }

  // Zoho's rejection, in words: per-field messages or workflow alerts.
  function reasonsOf(d) {
    const e = d && d.error;
    if (Array.isArray(e)) return e.map(x => [].concat(x.alert_message || []).join(' ') || x.message || '').filter(Boolean);
    if (e && typeof e === 'object') return Object.keys(e).map(k => k + ': ' + e[k]);
    return d && d.message ? [d.message] : [];
  }
}

module.exports = { registerMfgRfqRoutes, jeffCalcsRow, fittingRow };
