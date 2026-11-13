// =============================================================================
//  projectOutside.js — the take-off's outside costs, shaped for the project page.
// -----------------------------------------------------------------------------
//  Mark 2026-11-12: outside costs found on the AI take-off must reach the project's
//  Item Sourcing Take-Off (subform Outsource_Details), supplier blank, so the quote
//  carries them from day one and the user confirms suppliers later.
//
//  The project page's Deluge reads GET /api/takeoff/project-outside/<project_id>.
//  Each take-off save writes a small copy to the Railway volume, so opening a project
//  costs no data-service call.
//
//  Category strings MUST match the project's Outsource totals workflow exactly
//  (Projects memory: feedback_outsource_category_taxonomies) — same table as review.html PROJ_CAT.
// =============================================================================

const COST_CATS = [
  ['galvanize', 'Galvanizing', 'lb'], ['blast_paint', 'Blast / paint', 'lb'], ['fasteners', 'Fasteners & anchors', 'ea'],
  ['trucking', 'Trucking / delivery', 'load'], ['detailing', 'Detailing (shop drawings)', 'drawing'], ['inspection', 'Inspection / testing', 'lot'],
  ['installation', 'Installation / rigging', 'lot'], ['grating', 'Grating', 'sq ft'], ['decking', 'Decking', 'sq ft'],
  ['machining', 'Machining', 'lot'], ['fittings', 'Fittings (bought in)', 'ea'], ['other', 'Other / buyout', 'lot'],
];
const PROJ_CAT = {
  galvanize: 'Galvanize', blast_paint: 'Blast / Paint', fasteners: 'Fasteners', trucking: 'Trucking', detailing: 'Detailing',
  inspection: 'Inspection', installation: 'Installation / Rigging', grating: 'Grating', decking: 'Decking', machining: 'Machining',
  fittings: 'Fittings', other: 'Miscellaneous',
};

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

// Included outside lines. Prefers the page's own snapshot (cost_summary.project_out, written on
// every save, which carries weight-based quantities exactly as shown); falls back to the stored lines.
function outsideLines(pkg) {
  const S = (pkg && pkg.cost_summary) || {};
  let list = Array.isArray(S.project_out) ? S.project_out : null;
  if (!list) {
    const lines = S.lines || {};
    const keys = COST_CATS.map((c) => c[0]).concat(Object.keys(lines).filter((k) => lines[k] && lines[k].extra));
    list = [];
    keys.forEach((k) => {
      const l = lines[k];
      if (!l || l.status !== 'include') return;
      const c = COST_CATS.find((x) => x[0] === k);
      list.push({ key: k, category: PROJ_CAT[k] || 'Miscellaneous', description: (c ? c[1] : (l.label || 'Other')) + (l.note ? ' — ' + l.note : ''),
        qty: num(l.qty), unit: l.unit || (c ? c[2] : 'lot'), unit_amt: num(l.unit_amt), total: num(l.total) });
    });
  }
  return list.map((x) => ({
    key: String(x.key || ''), category: String(x.category || 'Miscellaneous'), description: String(x.description || '').slice(0, 250),
    qty: r2(num(x.qty)), unit: String(x.unit || ''), unit_amt: r4(num(x.unit_amt)), total: r2(num(x.total)),
  }));
}

const fileFor = (projectId) => 'takeoff-out-' + projectId + '.json';

function remember(filestore, projectId, pkg) {
  if (!/^\d+$/.test(String(projectId))) return;
  try { filestore.writeJson(fileFor(projectId), { project_id: String(projectId), saved_at: new Date().toISOString(), lines: outsideLines(pkg) }); }
  catch (e) { console.error('[takeoff out] could not write copy for ' + projectId + ':', e.message); }
}

function reply(projectId, savedAt, lines) {
  const total = lines.reduce((a, x) => a + (x.total || 0), 0);
  return { ok: true, found: true, project_id: String(projectId), saved_at: savedAt || null, count: lines.length,
    total: r2(total), no_amount: lines.filter((x) => x.total == null).length, lines };
}

module.exports = { outsideLines, remember, reply, fileFor, PROJ_CAT };
