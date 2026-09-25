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

const { resolveCatalogIds, matchDetailRow, detailCandidates } = require('./fittingResolve');

// NO CAP by default. An earlier draft capped catalog adds per commit to protect the record and
// API ceilings; Mark's call is that a fitting which cannot price is the expensive thing and he
// will buy records and calls as needed. Set FITTING_DETAIL_CREATE_CAP to put a ceiling back.
const MAX_CREATES_PER_COMMIT = Number(process.env.FITTING_DETAIL_CREATE_CAP || 0) || Infinity;

function registerFittingsCommit(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages,
          createDetailRow, buildFittingIndex, loadFittingCatalog, loadFittingLearning } = deps;

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

      const written = [], skipped = [], failed = [], provisional = [], unresolvedId = [], matched = [], nameGaps = [];

      // Built once, and only if something actually needs it. The index is ~53 paid reads when it
      // is cold, so a commit where every fitting already matched must not pay for it at all.
      let index = null, created = 0;
      async function detailIndex() {
        if (index === null) index = await buildFittingIndex();
        return index;
      }
      // The five cascade tables, likewise once. This is how a NAME becomes an id.
      let catalog = null;
      async function fittingCatalog() {
        if (catalog === null) catalog = typeof loadFittingCatalog === 'function' ? await loadFittingCatalog() : {};
        return catalog;
      }
      // And what this shop has corrected before. Same Takeoff_Correction table structural uses.
      const learned = typeof loadFittingLearning === 'function'
        ? await loadFittingLearning(txt((req.body || {}).manufacturer_id)) : {};

      for (const raw of list) {
        // ── NAMES → IDS ───────────────────────────────────────────────────────────────────
        // A take-off fitting arrives with names and no ids: the review page only stores an id
        // when a human picks from a dropdown (review.html:684). This used to mean that a
        // take-off nobody hand-edited row by row had every fitting REFUSED here — not
        // mispriced, absent from the project. So the names are resolved against the same five
        // cascade tables the page's pickers use, with the type-scoping the ids demand.
        const f = Object.assign({}, raw);
        let nameProblems = [];
        try {
          const r = resolveCatalogIds(f, await fittingCatalog(), learned);
          Object.assign(f, r.ids);
          nameProblems = r.unresolved;
        } catch (e) {
          console.error('[fittings] catalog resolve failed (falling back to whatever ids the row carried):', e.message);
        }

        // A fitting with no resolved type is not a fitting, it is a note. Writing it would create
        // a row that prices at zero and looks legitimate — refuse it and say which one. After the
        // resolve above this only fires on a type the Fitting_Type table does not contain, which
        // is a catalog gap a human has to close.
        if (!txt(f.fitting_type_id)) {
          skipped.push({ what: txt(f.fitting_type) || '(no type)', size: txt(f.size),
            why: txt(f.fitting_type) ? '"' + txt(f.fitting_type) + '" is not a fitting type in your catalog'
                                     : 'the take-off gave no fitting type' });
          continue;
        }

        // ── AN EXISTING ROW BEFORE A NEW ONE ──────────────────────────────────────────────
        // The page's auto-match only runs when the page is open, so a commit has to do it too
        // or it creates duplicates of rows the catalog already has.
        // Set when real rows fit this fitting but are not the same fitting as each other — a
        // reducing tee whose outlet the take-off did not give. Creating in that case would add a
        // near-duplicate to a catalog that already carries too many, so it is left for a human.
        let tooManyRows = 0;
        if (!txt(f.detail_id)) {
          try {
            const items = ((await detailIndex()) || {}).items || [];
            const hit = matchDetailRow(f, items);
            if (hit) {
              f.detail_id = String(hit.id); f.detail_table = hit.tbl;
              f.detail_label = txt(hit.label);
              if (num(f.weight) == null && hit.weight != null) f.weight = hit.weight;
              matched.push({ what: f.detail_label, id: f.detail_id });
            } else {
              const cands = detailCandidates(f, items);
              if (cands.length > 1) tooManyRows = cands.length;
            }
          } catch (e) {
            console.error('[fittings] detail match failed (will try to create instead):', e.message);
          }
        }

        // ── THE FITTING_ID GAP ────────────────────────────────────────────────────────────
        // Most non-blind flanges, every olet and every stub end have no row in either detail
        // table, so the editor resolves the type and make and still hands over a blank
        // detail_id. That blank becomes a blank `Fitting_ID`, and `Fitting_ID` is the join key
        // across BOM → Quote → Purchase: the fitting then prices at $0 on the component, which
        // reads as a free fitting rather than as a missing one
        // ([[feedback_fitting_id_catalog_coverage]]).
        //
        // So the row the catalog is missing gets created, exactly as the add-flow creates it —
        // same sibling-borrowed lookup ids, same ledger, same weight rules. A fitting that
        // cannot be priced is the failure; a provisional catalog row is not.
        let detailId = txt(f.detail_id), detailTable = txt(f.detail_table), detailLabel = txt(f.detail_label);
        let weight = num(f.weight);
        const schedule = txt(f.schedule_or_class) || txt(f.schedule);

        if (!detailId && tooManyRows) {
          unresolvedId.push({ what: [txt(f.fitting_type), txt(f.size), schedule].filter(Boolean).join(' · '),
            why: tooManyRows + ' catalog rows fit this and they are different fittings — pick one ' +
                 '(a reducing fitting needs its outlet size)' });
        } else if (!detailId && typeof createDetailRow === 'function' && txt(f.size)) {
          if (created >= MAX_CREATES_PER_COMMIT) {
            unresolvedId.push({ what: [txt(f.fitting_type), txt(f.size), schedule].filter(Boolean).join(' · '),
              why: 'FITTING_DETAIL_CREATE_CAP (' + MAX_CREATES_PER_COMMIT + ') reached for this commit' });
          } else {
            try {
              const made = await createDetailRow({
                fitting: f, size: txt(f.size), schedule: schedule,
                description: detailLabel, project_id: projectId, via: 'commit',
              }, { index: await detailIndex() });
              detailId = made.id; detailTable = made.table; detailLabel = made.label;
              // Only ever fills a blank. A weight the take-off already established outranks one
              // estimated here.
              if (weight == null && made.weight != null) weight = made.weight;
              // A reused row is an existing catalog record the editor simply did not match —
              // it cost no write, it is not provisional, and nobody needs to review it.
              if (!made.reused) {
                created++;
                provisional.push({ what: detailLabel, id: made.id,
                  unresolved: made.unresolved, weight: made.weight });
              }
            } catch (e) {
              // The fitting still goes on the project. Losing it over a failed catalog add would
              // trade a $0 line for a missing line, which is strictly worse.
              const why = e.response?.data?.message || e.message;
              unresolvedId.push({ what: [txt(f.fitting_type), txt(f.size), schedule].filter(Boolean).join(' · '),
                why: String(why).slice(0, 160) });
              console.error('[fittings] catalog add failed (fitting still written):', why);
            }
          }
        } else if (!detailId) {
          unresolvedId.push({ what: [txt(f.fitting_type), txt(f.size), schedule].filter(Boolean).join(' · '),
            why: txt(f.size) ? 'no catalog row and none could be created' : 'no size to create one from' });
        }

        // A name the catalog does not have. The fitting still links — the type resolved, or we
        // would not be here — but the row it joins to is less specific than the drawing was, and
        // that is a catalog gap worth naming while somebody is looking at it.
        if (nameProblems.length) {
          nameGaps.push({ what: detailLabel || [txt(f.fitting_type), txt(f.size)].filter(Boolean).join(' · '),
            which: nameProblems });
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
          // ── NOT Fitting_Description ────────────────────────────────────────────────────
          // That field is a DROPDOWN whose options are generated at runtime by
          // getFittingSizes() inside the form session. The REST API has no session, so Zoho
          // refuses every value with code 3001, "Invalid column value for Fitting_Description"
          // — as an HTTP 200, which is why this went unnoticed: the insert "succeeded", the
          // row was counted as written, and nothing was created. Not one take-off fitting had
          // ever reached a project.
          //
          // Fitting_Description_Text is a plain text field and takes it. It is also what the
          // Created workflow reads first when it computes the weight, and it is one of Mark's
          // two arbiters, so nothing downstream is worse off.
          Fitting_Description_Text: detailLabel ||
            [txt(f.fitting_type), txt(f.size), schedule,
             txt(f.end_type), txt(f.fitting_make)].filter(Boolean).join(' · '),
        };
        LOOKUPS.forEach(([src, field]) => { if (txt(f[src])) data[field] = txt(f[src]); });

        const comp = comps[txt(f.component).toLowerCase().replace(/\s+/g, ' ')];
        if (comp) data.Component = comp;

        // The Butt Weld / Forged router. On a UI entry another workflow sets this; on an API
        // insert nothing has, and the project subform shows or hides the two Fittings_*
        // cascade lookups by it — so a row without it joins correctly and still does not show.
        if (detailTable === 'bw') data.Fitting = 'Butt Weld';
        else if (detailTable === 'sw') data.Fitting = 'Forged';

        // Weight only when it is real. A blank weight is honest; a zero is an answer, and it
        // would understate the job every time it was summed.
        // THREE decimals: a fourth is refused with code 3001, "has exceeded its maximum
        // digits", and that refusal arrives as an HTTP 200 that creates nothing.
        const round3 = (n) => Number(Number(n).toFixed(3));
        if (weight != null) data.Weight = round3(weight);
        if (weight != null && data.Quantity) data.Total_Weight = round3(weight * data.Quantity);
        // The detail-table row this fitting resolved to, which is where weight comes from later.
        if (detailId && detailTable === 'bw') data.Fittings_Butt_Weld = detailId;
        if (detailId && detailTable === 'sw') data.Fittings_Socket_Weld = detailId;

        // THE TWO ARBITERS. Mark's design: `Fitting_ID` and `Fitting_Description_Text` are what
        // say which catalog record a row actually is — the two Fittings_* lookups above are
        // cascade helpers and are hidden or shown by Fitting_Style. Until this existed, every
        // take-off fitting arrived with both blank, which is the same state as a row whose
        // match was dropped ([[feedback_fitting_id_catalog_coverage]]).
        if (detailId) data.Fitting_ID = detailId;
        if (detailLabel) data.Fitting_Description_Text = detailLabel;

        try {
          const newId = await post(base, token, data);
          written.push({ line: line, what: data.Fitting_Description_Text, id: newId });
          line++;
        } catch (e) {
          const msg = e.response?.data?.message || e.message;
          failed.push({ what: data.Fitting_Description, why: String(msg).slice(0, 160) });
        }
      }

      console.log('[fittings] project ' + projectId + ': wrote ' + written.length + ' of ' + list.length +
        (matched.length ? ', matched ' + matched.length + ' to existing catalog rows' : '') +
        (provisional.length ? ', created ' + provisional.length + ' catalog row' + (provisional.length === 1 ? '' : 's') : '') +
        (unresolvedId.length ? ', ' + unresolvedId.length + ' without a Fitting_ID' : '') +
        (skipped.length ? ', skipped ' + skipped.length : '') + (failed.length ? ', failed ' + failed.length : ''));
      res.json({ ok: true, written: written.length, lines: written, skipped: skipped, failed: failed,
        // Rows the catalog did not have and now does — provisional, and in the add-flow's
        // review queue. And the ones still carrying no join key, which are the ones that will
        // price at $0 if nobody touches them.
        provisional: provisional, no_fitting_id: unresolvedId,
        // Resolved server-side rather than by a human in the editor: matched to a row that
        // already existed, and names the catalog could not place.
        matched: matched, name_gaps: nameGaps,
        total: list.length });
    } catch (err) {
      console.error('[fittings] commit failed:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });

  // One insert, with a single retry that drops the one field name I could not verify. Losing a
  // fitting over a guessed link name would be a poor trade for the guess.
  //
  // ── CHECK THE CODE. ALWAYS. ──────────────────────────────────────────────────────────────
  // Zoho refuses a record with HTTP 200 and a code in the body. This function used to return
  // the axios response and the caller counted it as written, so on 2026-09-24 a 58-fitting
  // take-off logged "wrote 58 of 58" and created NOTHING — every row refused with 3001,
  // "Invalid column value for Fitting_Description". A silent success is worse than a failure:
  // the failure would have been fixed months ago.
  // Returns the new record id, or throws with Zoho's own words.
  async function post(base, token, data) {
    const send = async (payload) => {
      const r = await axios.post(base + '/form/Project_BOM_Fittings_Quote_Form',
        { data: payload }, { headers: zohoHeaders(token) });
      const body = r.data || {};
      if (body.code !== 3000) {
        const why = [].concat(body.error || [], body.message || []).filter(Boolean).join('; ') ||
          JSON.stringify(body).slice(0, 200);
        const err = new Error('Zoho refused the row (code ' + body.code + '): ' + why);
        err.zohoCode = body.code;
        throw err;
      }
      const rec = Array.isArray(body.data) ? (body.data[0] || {}) : (body.data || {});
      return String(rec.ID || rec.id || '');
    };
    try {
      return await send(data);
    } catch (e) {
      const msg = String(e.zohoCode ? e.message : (e.response?.data?.message || e.message || ''));
      if (/Project_LU/i.test(msg) && data.Project_LU) {
        const retry = Object.assign({}, data); delete retry.Project_LU;
        console.log('[fittings] Project_LU rejected — writing without it');
        return await send(retry);
      }
      throw e;
    }
  }
}

module.exports = { registerFittingsCommit };
