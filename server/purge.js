// ============================================================================
//  PROJECT PURGE — the delete cascade, as a service.
// ----------------------------------------------------------------------------
//  A port of purge_project.js (the CLI Mark runs by hand) so a Delete button on
//  the projects page can reach it. The cascade, its ordering and its safety
//  rules are carried over UNCHANGED, because they were learned the hard way:
//
//    * THREE LEVELS DEEP. Purchase orders hang off the WORK ORDER, not the
//      project, so discovery runs project -> work orders -> purchase orders.
//      Reversing that silently yields zero purchase orders and leaves them
//      orphaned, which is worse than not purging at all.
//    * EVERY REDUNDANT PARENT LINK IS UNIONED. Only ~9% of BOM rows carry the
//      bidirectional lookup; keying on one link misses rows.
//    * DELETE DEEPEST FIRST, so nothing is orphaned partway through.
//    * DELETE BY RECORD ID, never by criteria — a criteria delete 401s and can
//      remove the wrong rows.
//    * QUOTA (code 4000) IS FATAL. On a read it would otherwise look like "no
//      matching rows", which under-counts children and would let a parent be
//      deleted while its children survive. It can arrive as HTTP 200.
//
//  Two things this adds over the CLI, both because a button is not a person at
//  a terminal who just typed --delete:
//
//    1. It REFUSES a project that has any quote. Those carry unmapped children
//       (Supplier_Verify_Detail, Communication_Log, BOM_Import_Staging) that the
//       cascade does not reach, so purging one would leave debris. Those stay a
//       deliberate command-line job.
//    2. It requires the caller to echo back the project's own quote number. A
//       confirm dialog is answered reflexively; a number has to be read first.
// ============================================================================
const axios = require('axios');

// The cascade, in DELETE order (deepest first). `level` says which id set feeds
// this report's lookup fields.
const CASCADE = [
  // ── nesting ───────────────────────────────────────────────────────────
  { report: 'All_Nesting_Cut_Details',                         level: 'stockResult',   fields: ['Nesting_Stock_Result_Lookup'] },
  { report: 'Nesting_Stock_Results',                           level: 'nestRun',       fields: ['Nesting_Run_Header'] },
  { report: 'All_Nesting_Run_Parts',                           level: 'nestRun',       fields: ['Nesting_Run'] },
  { report: 'Nesting_Run_Header_Report',                       level: 'project',       fields: ['Project_Lookup'] },

  // ── purchase orders (deepest first; they hang off the WORK ORDER) ─────
  { report: 'All_Purchase_Order_Details',                      level: 'purchaseOrder', fields: ['Purchase_Order_Form'] },
  { report: 'Purchase_Order_Fittings_Quote_Form_Report',       level: 'workOrder',     fields: ['Job_Form'] },
  { report: 'Purchase_Order_Report',                           level: 'workOrder',     fields: ['Job_ID'] },

  // ── work orders ───────────────────────────────────────────────────────
  { report: 'Work_Order_Material_Allocated_Detail_Form_Report', level: 'workOrder',    fields: ['Job_Form'] },
  { report: 'Work_Order_Fittings_Quote_Form_Report',           level: 'workOrder',     fields: ['Job_Form'] },
  { report: 'Work_Order_Material_Total_Summaries_Report',      level: 'workOrder',     fields: ['Job_Form'] },
  { report: 'All_Jobs',                                        level: 'project',       fields: ['Project_Information', 'Project_ID_Number'] },

  // ── sourcing / quote side ─────────────────────────────────────────────
  { report: 'Customer_New_RFQ_Acceptance_Detail_Report',       level: 'project',       fields: ['Project_LU'] },
  { report: 'Project_Allocate_Quote_Form_Report',              level: 'project',       fields: ['MCP_Customer_Project_Form'] },
  { report: 'All_RFQs_Sent_Report',                            level: 'quote',         fields: ['Quote_LU'] },
  { report: 'RFQs_Sent_Fittings_Report',                       level: 'quote',         fields: ['Quote_LU'] },
  { report: 'All_Supplier_Verify_Form_Report',                 level: 'quote',         fields: ['SV_Quote_Form'] },
  { report: 'Jeffs_Calcs_Report',                              level: 'quote',         fields: ['Quote_Form'] },
  { report: 'Fittings_Quote_Subform_Report',                   level: 'quote',         fields: ['Quote_ID'] },
  { report: 'MFG_Pending_Purchase_Order_Report',               level: 'project',       fields: ['Client_Project', 'Project_LU'] },
  { report: 'All_Quotes',                                      level: 'project',       fields: ['Project_Number'] },

  // ── the project's own children ────────────────────────────────────────
  { report: 'Project_Material_Allocated_Detail_Form_Report',   level: 'project',       fields: ['MCP_Customer_Project_Form', 'Project_Bi_Directional_Lookup', 'Project_LU'] },
  { report: 'Project_Bill_Of_Material_Detail_Form_Report',     level: 'project',       fields: ['MCP_Customer_Project_Form', 'Bi_Directional_Project_ID'] },
  // The project's FITTINGS. Missing from this cascade until 2026-09-25, which was harmless only
  // because no take-off fitting had ever successfully reached a project — the API insert was
  // being refused and counted as written. Now that they land, purging without this leaves rows
  // pointing at a project that no longer exists.
  { report: 'Project_BOM_Fittings_Quote_Form_Report',          level: 'project',       fields: ['MCP_Customer_Project_Form', 'Project_Bi_Directional_Lookup', 'Project_LU'] },
  { report: 'All_Project_Drawing_Details',                     level: 'project',       fields: ['MCP_Customer_Project_Form', 'Project_ID_Relationship', 'Project_ID_Number'] },
  { report: 'All_Project_Components',                          level: 'project',       fields: ['MCP_Customer_Project_Form', 'Project_Bi_Directional_Lookup', 'Project_LU'] },
  { report: 'Import_BOM_Form_Report',                          level: 'project',       fields: ['Project_ID'] },
  { report: 'AI_Takeoff_Saved_Report',                         level: 'project',       fields: ['Project_ID_Look_Up', 'Project_ID'] },
  { report: 'All_Projects',                                    level: 'self',          fields: ['ID'] },
];

// Forms the API cannot see, reported honestly rather than hidden.
const UNREACHABLE = [
  'Purchase_Order_NEW_Details and Purchase_Order_Totals — no report exists on them. They are true ' +
  'subform rows, so Zoho removes them with their parent purchase order.',
  'Supplier_Verify_Detail, Communication_Log and BOM_Import_Staging are unmapped. They only matter ' +
  'for a project that has quotes, which this refuses to purge.',
];

class QuotaError extends Error {}
function assertNotQuota(payload) {
  if (payload && payload.code === 4000) {
    throw new QuotaError('Zoho daily API limit reached — the run stopped and nothing further was attempted.');
  }
}

function registerPurgeRoutes(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders } = deps;

  // Every row matching (field == id), tolerating zero-match and missing-field
  // errors but never a quota error.
  async function matches(token, report, field, ids) {
    const base = creatorApiBase();
    const out = new Map();
    for (const id of ids) {
      let cur = null;
      do {
        const h = { ...zohoHeaders(token) };
        if (cur) h.record_cursor = cur;
        let r;
        try {
          r = await axios.get(base + '/report/' + report + '?criteria=(' + field + '==' + id + ')&limit=200', { headers: h });
        } catch (e) {
          const code = e.response && e.response.data && e.response.data.code;
          assertNotQuota(e.response && e.response.data);   // fatal — never silently "empty"
          if (code === 9280 || code === 3100) break;       // genuinely zero matches
          if (code === 2894) throw new Error('no such report: ' + report);
          break;                                           // field not on this report — skip quietly
        }
        assertNotQuota(r.data);                            // 4000 can arrive as HTTP 200
        ((r.data && r.data.data) || []).forEach(x => out.set(String(x.ID), x));
        cur = r.headers['record_cursor'] || null;
      } while (cur);
    }
    return out;
  }

  // Discovery + counting. Shared by the preview and the purge, so the button can
  // never delete against a plan different from the one it showed.
  async function discover(token, projectId) {
    const ids = [String(projectId)];
    const idsBy = { project: ids, self: ids, quote: [], nestRun: [], stockResult: [], workOrder: [], purchaseOrder: [] };

    const quotes = await matches(token, 'All_Quotes', 'Project_Number', ids);
    idsBy.quote = [...quotes.keys()];

    const runs = await matches(token, 'Nesting_Run_Header_Report', 'Project_Lookup', ids);
    idsBy.nestRun = [...runs.keys()];
    const stock = idsBy.nestRun.length ? await matches(token, 'Nesting_Stock_Results', 'Nesting_Run_Header', idsBy.nestRun) : new Map();
    idsBy.stockResult = [...stock.keys()];

    const wos = new Map();
    for (const f of ['Project_Information', 'Project_ID_Number']) {
      (await matches(token, 'All_Jobs', f, ids)).forEach((v, k) => wos.set(k, v));
    }
    idsBy.workOrder = [...wos.keys()];

    const pos = idsBy.workOrder.length ? await matches(token, 'Purchase_Order_Report', 'Job_ID', idsBy.workOrder) : new Map();
    idsBy.purchaseOrder = [...pos.keys()];

    const plan = [];
    for (const step of CASCADE) {
      const found = new Map();
      const src = idsBy[step.level];
      if (src && src.length) {
        for (const f of step.fields) {
          (await matches(token, step.report, f, src)).forEach((v, k) => found.set(k, v));
        }
      }
      plan.push({ report: step.report, ids: [...found.keys()] });
    }
    const total = plan.reduce((s, p) => s + p.ids.length, 0);
    return { idsBy, plan, total };
  }

  async function projectHeader(token, projectId) {
    const base = creatorApiBase();
    try {
      const r = await axios.get(base + '/report/All_Projects?criteria=(ID==' + projectId + ')', { headers: zohoHeaders(token) });
      assertNotQuota(r.data);
      const row = (r.data && r.data.data && r.data.data[0]) || null;
      if (!row) return null;
      return {
        id: String(row.ID),
        number: String(row.Project_Quote_Number || '').trim(),
        description: String(row.Project_Description || '').trim(),
        manufacturer: (row.MANUFACTURE && row.MANUFACTURE.zc_display_value) || '',
        status: String(row.Project_Quote_Status || '').trim(),
      };
    } catch (e) {
      if (e instanceof QuotaError) throw e;
      return null;
    }
  }

  // What WOULD be deleted. Writes nothing. This is the CLI's dry run.
  app.get('/api/project/:id/purge-preview', async (req, res) => {
    const projectId = String(req.params.id || '');
    if (!/^[0-9]{6,25}$/.test(projectId)) return res.status(400).json({ ok: false, error: 'bad project id' });
    try {
      const token = await getAccessToken();
      const header = await projectHeader(token, projectId);
      if (!header) return res.status(404).json({ ok: false, error: 'No such project.' });
      const { idsBy, plan, total } = await discover(token, projectId);
      const blocked = idsBy.quote.length
        ? 'This project has ' + idsBy.quote.length + ' quote' + (idsBy.quote.length === 1 ? '' : 's') +
          '. Quotes carry child records this cascade does not reach, so purging here would leave debris behind. ' +
          'Purge it from the command line instead.'
        : null;
      res.json({
        ok: true, project: header, total, blocked,
        resolved: {
          quotes: idsBy.quote.length, work_orders: idsBy.workOrder.length,
          purchase_orders: idsBy.purchaseOrder.length, nesting_runs: idsBy.nestRun.length,
          stock_results: idsBy.stockResult.length,
        },
        forms: plan.filter(p => p.ids.length).map(p => ({ report: p.report, records: p.ids.length })),
        unreachable: UNREACHABLE,
      });
    } catch (err) {
      if (err instanceof QuotaError) return res.status(429).json({ ok: false, error: err.message });
      console.error('[purge] preview error:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });

  // The destructive half. Re-discovers rather than trusting anything the caller
  // sends, so a stale preview cannot widen what gets deleted.
  app.post('/api/project/:id/purge', async (req, res) => {
    const projectId = String(req.params.id || '');
    if (!/^[0-9]{6,25}$/.test(projectId)) return res.status(400).json({ ok: false, error: 'bad project id' });
    try {
      const token = await getAccessToken();
      const header = await projectHeader(token, projectId);
      if (!header) return res.status(404).json({ ok: false, error: 'No such project.' });

      const confirm = String((req.body && req.body.confirm) || '').trim();
      if (!confirm || confirm.toUpperCase() !== header.number.toUpperCase()) {
        return res.status(400).json({ ok: false, error: 'Type the project number exactly to confirm: ' + header.number });
      }

      const { idsBy, plan, total } = await discover(token, projectId);
      if (idsBy.quote.length) {
        return res.status(409).json({ ok: false, error: 'This project has a quote. Purge it from the command line, where the unmapped quote children can be checked first.' });
      }

      const base = creatorApiBase();
      let deleted = 0, quota = false;
      const failed = [], per = [];
      try {
        for (const p of plan) {
          if (!p.ids.length) continue;
          let n = 0;
          for (const id of p.ids) {
            // No ?criteria= on a DELETE — it 401s and can remove the wrong rows.
            const d = await axios.delete(base + '/report/' + p.report + '/' + id, { headers: zohoHeaders(token), validateStatus: () => true });
            assertNotQuota(d.data);                        // stop the instant quota runs out, mid-cascade
            if (d.status === 200 && d.data && d.data.code === 3000) { n++; deleted++; }
            else failed.push(p.report + '/' + id + ': ' + JSON.stringify(d.data).slice(0, 90));
          }
          per.push({ report: p.report, deleted: n });
        }
      } catch (e) {
        if (!(e instanceof QuotaError)) throw e;
        quota = true;   // partial purge: children gone, parents may remain
      }
      console.log('[purge] project ' + projectId + ' (' + header.number + '): ' + deleted + '/' + total + ' deleted' +
        (failed.length ? ', ' + failed.length + ' failed' : '') + (quota ? ' — QUOTA STOP' : ''));
      res.json({
        ok: true, project: header, total, deleted, per,
        failed: failed.slice(0, 20), failed_count: failed.length,
        quota,
        note: quota
          ? 'The daily API limit stopped this partway. Children may be gone while parents remain. Run it again tomorrow and it will re-discover and finish.'
          : null,
      });
    } catch (err) {
      if (err instanceof QuotaError) return res.status(429).json({ ok: false, error: err.message });
      console.error('[purge] error:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });

  // The confirm screen the Delete button opens.
  app.get('/purge', (req, res) => res.send(renderPurgePage()));
}

function renderPurgePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Delete Project · Material Compass</title>
<style>
:root{--ink:#1d2430;--mut:#667;--line:#e3e7ec;--red:#b3261e;--bg:#f6f7f9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.bar{background:#fff;border-bottom:1px solid var(--line);padding:12px 20px;font-weight:700}
.bar span{color:var(--mut);font-weight:400;margin-left:8px}
.wrap{max-width:760px;margin:20px auto;padding:0 16px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:14px}
h1{font-size:18px;margin:0 0 4px}
.sub{color:var(--mut);margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
td.n,th.n{text-align:right;white-space:nowrap}
.tot td{font-weight:700;border-top:2px solid var(--line);border-bottom:none}
.warn{background:#fff7ed;border:1px solid #f2d5ae;border-radius:8px;padding:12px;margin-bottom:14px}
.stop{background:#fdecea;border:1px solid #f3c2bd;border-radius:8px;padding:12px;color:var(--red)}
.note{color:var(--mut);font-size:12px;margin-top:10px}
input{font:inherit;padding:8px 10px;border:1px solid #cdd3da;border-radius:7px;width:220px}
button{font:inherit;font-weight:600;padding:9px 16px;border-radius:7px;border:0;cursor:pointer}
.del{background:var(--red);color:#fff}
.del[disabled]{background:#d8b6b2;cursor:not-allowed}
.spin{display:inline-block;width:12px;height:12px;border:2px solid #ccc;border-top-color:#666;border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes s{to{transform:rotate(360deg)}}
@media (max-width:480px){input{width:100%}}
</style></head><body>
<div class="bar">Material Compass <span>Delete Project</span></div>
<div class="wrap" id="app"><div class="card"><span class="spin"></span>Reading the project…</div></div>
<script>
var P = new URLSearchParams(location.search).get('project_id') || '';
var app = document.getElementById('app');
var esc = function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;');};

function show(html){ app.innerHTML = html; }

function load(){
  if(!P){ show('<div class="card stop">No project was passed to this page.</div>'); return; }
  fetch('/api/project/'+encodeURIComponent(P)+'/purge-preview').then(function(r){return r.json();}).then(function(d){
    if(!d.ok){ show('<div class="card stop">'+esc(d.error)+'</div>'); return; }
    var p = d.project;
    var rows = (d.forms||[]).map(function(f){
      return '<tr><td>'+esc(f.report)+'</td><td class="n">'+f.records+'</td></tr>';
    }).join('') || '<tr><td colspan="2">Nothing but the project record itself.</td></tr>';

    var head = '<div class="card"><h1>'+esc(p.description||'(no description)')+'</h1>'+
      '<div class="sub">'+esc(p.number)+' · '+esc(p.manufacturer)+(p.status?' · '+esc(p.status):'')+'</div>';

    if(d.blocked){
      show(head+'<div class="stop">'+esc(d.blocked)+'</div></div>');
      return;
    }

    show(head+
      '<div class="warn"><b>This deletes '+d.total+' record'+(d.total===1?'':'s')+' and cannot be undone.</b>'+
      '<div class="note">Work orders '+d.resolved.work_orders+' · purchase orders '+d.resolved.purchase_orders+
      ' · nesting runs '+d.resolved.nesting_runs+'</div></div>'+
      '<table><thead><tr><th>Form</th><th class="n">Records</th></tr></thead><tbody>'+rows+
      '<tr class="tot"><td>Total</td><td class="n">'+d.total+'</td></tr></tbody></table>'+
      '<div class="note">'+(d.unreachable||[]).map(esc).join('<br>')+'</div></div>'+
      '<div class="card"><b>Type '+esc(p.number)+' to confirm.</b>'+
      '<div class="note">Read it off the row above rather than copying it, so this is a decision and not a reflex.</div>'+
      '<div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">'+
      '<input id="cf" placeholder="project number" autocomplete="off"/>'+
      '<button class="del" id="go" disabled>Delete permanently</button></div>'+
      '<div id="msg" class="note"></div></div>');

    var cf = document.getElementById('cf'), go = document.getElementById('go');
    cf.addEventListener('input', function(){
      go.disabled = cf.value.trim().toUpperCase() !== String(p.number).toUpperCase();
    });
    go.addEventListener('click', function(){
      go.disabled = true;
      document.getElementById('msg').innerHTML = '<span class="spin"></span>Deleting, deepest records first…';
      fetch('/api/project/'+encodeURIComponent(P)+'/purge', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({confirm: cf.value.trim()})
      }).then(function(r){return r.json();}).then(function(d){
        if(!d.ok){ document.getElementById('msg').innerHTML = '<span style="color:#b3261e">'+esc(d.error)+'</span>'; go.disabled=false; return; }
        show('<div class="card"><h1>Deleted</h1><div class="sub">'+esc(d.project.number)+' · '+
          d.deleted+' of '+d.total+' records removed'+(d.failed_count?', '+d.failed_count+' refused':'')+'.</div>'+
          (d.quota?'<div class="stop">'+esc(d.note)+'</div>':'')+
          (d.failed_count?'<div class="note">'+d.failed.map(esc).join('<br>')+'</div>':'')+
          '<div class="note">You can close this window. Refresh the projects list to see it gone.</div></div>');
      }).catch(function(e){
        document.getElementById('msg').innerHTML = '<span style="color:#b3261e">'+esc(e)+'</span>'; go.disabled=false;
      });
    });
  }).catch(function(e){ show('<div class="card stop">Could not read the project: '+esc(e)+'</div>'); });
}
load();
</script></body></html>`;
}

module.exports = { registerPurgeRoutes, CASCADE };
