// =============================================================================
//  fittingsCommit.js — put the take-off's fittings onto the project.
// -----------------------------------------------------------------------------
//  This is the hole the whole fittings chain was waiting on. The take-off found
//  58 fittings on the Gamma Lube job, showed them, let them be corrected — and
//  then dropped them on approve, because nothing wrote them anywhere.
//
//  Everything downstream already works or has mapped gaps:
//    rollupFittingsToPurchase runs on project save and is correctly keyed, so
//    Purchase Material fills itself once these rows exist. The Work Order side
//    carries fittings properly (confirmed on WO# 10000). The quote leg has two
//    known gaps (MFG review form, material sourcing) that are separate work.
//  None of it can be tested until a fitting reaches a project.
//
//  TARGET: form `Project_BOM_Fittings_Quote_Form` (confirmed from the form
//  builder URL, 2026-09-21). Display names differ from link names on that form
//  — "QTY" is Quantity, "Line Item" is Line_Item_Fitting, "NEW PROJECT
//  SUBMITTAL" is MCP_Customer_Project_Form — so every name here comes from the
//  report's columns, not from the form builder's labels.
// =============================================================================
const axios = require('axios');

// Only ever written when the editor resolved a real catalog record. A name without its id is
// worthless downstream: it resolves to nothing and prices at zero, silently
// ([[feedback_fitting_id_catalog_coverage]]).
const LOOKUPS = [
  ['fitting_type_id',   'Fitting_Type'],
  ['fitting_make_id',   'Fitting_Make'],
  ['end_type_id',       'End_Type'],
  ['connection_type_id','Connection_Type'],
  ['specification_id',  'Fitting_Specification'],
];

function registerFittingsCommit(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages } = deps;

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const txt = (v) => String(v == null ? '' : v).trim();

  // The project's components, so a fitting's component NAME can become the record it belongs to.
  // Matched case- and space-insensitively, because "Oil Console" and "oil console " are the same
  // component to everyone except a string comparison.
  async function componentsOf(projectId) {
    const rows = await fetchAllZohoPages('/report/All_Project_Components?criteria=' +
      encodeURIComponent('(MCP_Customer_Project_Form==' + projectId + ')'));
    const byName = {};
    (rows || []).forEach((r) => {
      const n = txt(r.Project_Component).toLowerCase().replace(/\s+/g, ' ');
      if (n) byName[n] = String(r.ID);
    });
    return byName;
  }

  // Highest Line_Item_Fitting already on the project. Read from the ROWS, not from a counter —
  // a counter and the records disagree the moment anything is deleted
  // ([[feedback_counter_table_not_sole_truth]]).
  async function nextLineItem(projectId) {
    const rows = await fetchAllZohoPages('/report/Project_BOM_Fittings_Quote_Form_Report?criteria=' +
      encodeURIComponent('(MCP_Customer_Project_Form==' + projectId + ')'));
    let max = 0;
    (rows || []).forEach((r) => { const n = num(r.Line_Item_Fitting); if (n && n > max) max = n; });
    return max + 1;
  }

  // POST /api/takeoff/commit-fittings  { project_id, fittings: [...] }
  app.post('/api/takeoff/commit-fittings', async (req, res) => {
    const projectId = txt((req.body || {}).project_id);
    const list = Array.isArray((req.body || {}).fittings) ? (req.body || {}).fittings : [];
    if (!/^[0-9]{6,25}$/.test(projectId)) return res.status(400).json({ ok: false, error: 'project_id required' });
    if (!list.length) return res.json({ ok: true, written: 0, skipped: [], failed: [] });

    try {
      const token = await getAccessToken();
      const base = creatorApiBase();
      const comps = await componentsOf(projectId);
      let line = await nextLineItem(projectId);

      const written = [], skipped = [], failed = [];

      for (const f of list) {
        // A fitting with no resolved type is not a fitting, it is a note. Writing it would create
        // a row that prices at zero and looks legitimate — refuse it and say which one.
        if (!txt(f.fitting_type_id)) {
          skipped.push({ what: txt(f.fitting_type) || '(no type)', size: txt(f.size),
            why: 'not matched to a catalog fitting type' });
          continue;
        }

        const data = {
          // Both project links. The bidirectional one is what the project page dot-walks per
          // row; without it the record exists and the subform shows nothing
          // ([[feedback_bidirectional_subform_link]]).
          MCP_Customer_Project_Form: projectId,
          Project_Bi_Directional_Lookup: projectId,
          // Display name "Project LU" — not a report column, so this link name is inferred from
          // the components form's convention. If Zoho rejects it the row is retried without it
          // rather than lost.
          Project_LU: projectId,
          Line_Item_Fitting: line,
          // quantity_total, never the per-unit figure: four skids means four sets of elbows.
          Quantity: num(f.quantity_total) != null ? num(f.quantity_total)
                  : (num(f.quantity) || 0) * Math.max(1, num(f.units) || 1),
          // The detail row's OWN text, verbatim, so a take-off fitting is indistinguishable
          // from one keyed on the form: both read "2\" | SCH 160 (.344\")". The joined
          // fallback only appears when no detail row resolved, and is deliberately ugly so
          // it is obvious which rows never matched the catalog.
          Fitting_Description: txt(f.detail_label) ||
            [txt(f.fitting_type), txt(f.size), txt(f.schedule_or_class),
             txt(f.end_type), txt(f.fitting_make)].filter(Boolean).join(' · '),
        };
        LOOKUPS.forEach(([src, field]) => { if (txt(f[src])) data[field] = txt(f[src]); });

        const comp = comps[txt(f.component).toLowerCase().replace(/\s+/g, ' ')];
        if (comp) data.Component = comp;

        // Weight only when it is real. A blank weight is honest; a zero is an answer, and it
        // would understate the job every time it was summed.
        if (num(f.weight) != null) data.Weight = num(f.weight);
        if (num(f.weight) != null && data.Quantity) data.Total_Weight = num(f.weight) * data.Quantity;
        // The detail-table row this fitting resolved to, which is where weight comes from later.
        if (txt(f.detail_id) && txt(f.detail_table) === 'bw') data.Fittings_Butt_Weld = txt(f.detail_id);
        if (txt(f.detail_id) && txt(f.detail_table) === 'sw') data.Fittings_Socket_Weld = txt(f.detail_id);

        // THE TWO ARBITERS. Mark's design: `Fitting_ID` and `Fitting_Description_Text` are what
        // say which catalog record a row actually is — the two Fittings_* lookups above are
        // cascade helpers and are hidden or shown by Fitting_Style. Until this existed, every
        // take-off fitting arrived with both blank, which is the same state as a row whose
        // match was dropped ([[feedback_fitting_id_catalog_coverage]]).
        if (txt(f.detail_id)) data.Fitting_ID = txt(f.detail_id);
        if (txt(f.detail_label)) data.Fitting_Description_Text = txt(f.detail_label);

        try {
          await post(base, token, data);
          written.push({ line: line, what: data.Fitting_Description });
          line++;
        } catch (e) {
          const msg = e.response?.data?.message || e.message;
          failed.push({ what: data.Fitting_Description, why: String(msg).slice(0, 160) });
        }
      }

      console.log('[fittings] project ' + projectId + ': wrote ' + written.length + ' of ' + list.length +
        (skipped.length ? ', skipped ' + skipped.length : '') + (failed.length ? ', failed ' + failed.length : ''));
      res.json({ ok: true, written: written.length, lines: written, skipped: skipped, failed: failed,
        total: list.length });
    } catch (err) {
      console.error('[fittings] commit failed:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });

  // One insert, with a single retry that drops the one field name I could not verify. Losing a
  // fitting over a guessed link name would be a poor trade for the guess.
  async function post(base, token, data) {
    try {
      return await axios.post(base + '/form/Project_BOM_Fittings_Quote_Form', { data }, { headers: zohoHeaders(token) });
    } catch (e) {
      const msg = String(e.response?.data?.message || e.message || '');
      if (/Project_LU/i.test(msg) && data.Project_LU) {
        const retry = Object.assign({}, data); delete retry.Project_LU;
        console.log('[fittings] Project_LU rejected — writing without it');
        return await axios.post(base + '/form/Project_BOM_Fittings_Quote_Form', { data: retry }, { headers: zohoHeaders(token) });
      }
      throw e;
    }
  }
}

module.exports = { registerFittingsCommit };
