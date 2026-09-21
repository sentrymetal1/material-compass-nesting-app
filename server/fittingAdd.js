// =============================================================================
//  fittingAdd.js — add a fitting the catalog does not have, without stopping.
// -----------------------------------------------------------------------------
//  Mark's rule for the whole platform: nothing may stop a user finishing a
//  quote. Four fitting types — Bushing, Union, Olet, Stub End — have NO rows in
//  either detail table, so on a real job this path is not an edge case. His
//  Gamma Lube job alone has four bushings and five unions.
//
//  So the estimator supplies only what they can read off the drawing: a size and
//  a schedule or class. Everything else is already known (type, make, end,
//  connection and spec are resolved in the editor) or derived here. Then the
//  cache is busted so the new row is usable immediately rather than in twelve
//  hours, and they carry on.
//
//  ── THE LOOKUP TRICK, AND WHY IT MATTERS ────────────────────────────────────
//  A detail row's NPS dimension, schedule and class are LOOKUPS, so writing
//  loose text would create a row that displays correctly and joins to nothing.
//  Three reports match "class" — Class_Report, Class_Type_Report and
//  Forged_Class_Dimensions_Report — and which one backs the detail table is not
//  established. Guessing would produce exactly that silent orphan.
//
//  So it does not guess: it finds a SIBLING row that already carries the value
//  and reuses that row's lookup id. Every existing row carries its own ids, so
//  the result is guaranteed consistent with the data already there. The lookup
//  reports are only consulted for a value that appears in neither table.
// =============================================================================
const axios = require('axios');
const weights = require('./weights');

const BW_FORM = 'Tee_Reducing_NPS_Dimensions';
const SW_FORM = 'Fittings_Socket_Weld_and_Threaded_Details';

const txt = (v) => String(v == null ? '' : v).trim();
// "1-1/2\"", "1 1/2 in", "1.5" all have to read as the same size.
const sizeKey = (s) => txt(s).toLowerCase().replace(/inch(es)?|["”']/g, '').replace(/[^a-z0-9/.]+/g, '');

function registerFittingAdd(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, cacheBust, buildFittingIndex, filestore } = deps;

  // Butt weld lives in one table, everything else in the other. The end type decides, because
  // that is what the two tables are actually divided by.
  const tableFor = (endName) => (/butt\s*weld/i.test(txt(endName)) ? 'bw' : 'sw');

  // The audit trail lives on the Railway volume, NOT in Zoho. Mark's decision: a provisional
  // record must be indistinguishable from a confirmed one everywhere it appears — the quote, the
  // RFQ, the PO — so there is no flag field to render. The ledger is how Material Compass finds
  // them later, sorted by how often each has been used, because an item that has appeared on six
  // jobs is a real catalog gap and a one-off is probably a misread drawing.
  function remember(rec) {
    try {
      const prev = readLedger();
      prev.push(rec);
      filestore.writeJson('fitting-additions.json', prev);
    } catch (e) { console.error('[fitting-add] ledger write failed (record still created):', e.message); }
  }
  function readLedger() {
    try { return filestore.readJson('fitting-additions.json', []) || []; } catch (e) { return []; }
  }

  // POST /api/takeoff/fitting-add
  //   { fitting: {...editor row...}, size, schedule, description, project_id, manufacturer_id }
  app.post('/api/takeoff/fitting-add', async (req, res) => {
    const b = req.body || {};
    const f = b.fitting || {};
    const size = txt(b.size), sched = txt(b.schedule);
    if (!txt(f.fitting_type_id)) return res.status(400).json({ ok: false, error: 'This row has no catalog fitting type yet — set that first.' });
    if (!size) return res.status(400).json({ ok: false, error: 'A size is required.' });

    try {
      const token = await getAccessToken();
      const base = creatorApiBase();
      const idx = await buildFittingIndex();
      const items = idx.items || [];
      const tbl = tableFor(f.end_type);

      // Structural lookups come straight from the editor — already resolved against the catalog.
      const data = {
        Fitting_Type: txt(f.fitting_type_id),
      };
      if (txt(f.fitting_make_id))    data.Fitting_Make = txt(f.fitting_make_id);
      if (txt(f.end_type_id))        data.End_Type = txt(f.end_type_id);
      if (txt(f.connection_type_id)) data.Connection_Type = txt(f.connection_type_id);

      // A sibling with this size anywhere in the same table gives us its dimension lookup id.
      const wantSize = sizeKey(size);
      const sizeSib = items.find((x) => x.tbl === tbl && sizeKey(x.size) === wantSize) ||
                      items.find((x) => sizeKey(x.size) === wantSize);
      // ...and a sibling with this schedule or class gives us that one.
      const wantSched = sizeKey(sched);
      const schedSib = sched ? (items.find((x) => x.tbl === tbl && sizeKey(x.sched) === wantSched) ||
                                items.find((x) => sizeKey(x.sched) === wantSched)) : null;

      // Raw rows carry the lookup ids; the index does not, so fetch just the two siblings.
      const unresolved = [];
      if (sizeSib) {
        const row = await one(base, token, tbl === 'bw' ? 'Tee_Reducing_NPS_Dimensions_Report' : 'Fittings_Socket_Weld_and_Threaded_Details_Report', sizeSib.id);
        const dimId = idOf(row, tbl === 'bw' ? 'NPS_Dimension' : 'NPS_Dimensions');
        if (dimId) data[tbl === 'bw' ? 'NPS_Dimension' : 'NPS_Dimensions'] = dimId;
        else unresolved.push('size');
      } else unresolved.push('size');

      if (sched) {
        if (schedSib) {
          const row = await one(base, token, schedSib.tbl === 'bw' ? 'Tee_Reducing_NPS_Dimensions_Report' : 'Fittings_Socket_Weld_and_Threaded_Details_Report', schedSib.id);
          if (tbl === 'bw') {
            const sid = idOf(row, 'NPS_Schedule');
            if (sid) data.NPS_Schedule = sid; else unresolved.push('schedule');
          } else {
            const cid = idOf(row, 'Class'), ctid = idOf(row, 'Class_Type');
            if (cid) data.Class = cid; else unresolved.push('class');
            if (ctid) data.Class_Type = ctid;
          }
        } else unresolved.push(tbl === 'bw' ? 'schedule' : 'class');
      }

      // The text the estimator typed goes on regardless, so the row reads correctly even where a
      // lookup could not be resolved — a half-linked row that SAYS what it is beats a blank.
      if (tbl === 'bw') data.NPS_Dim_And_SCH_Text = txt(b.description) || [size, sched].filter(Boolean).join(' | ');
      else { data.NPS_Inch_Text = size; data.NPS_Dim_and_Class = txt(b.description) || [size, sched].filter(Boolean).join(' | '); }

      // Weight, computed rather than left blank where the geometry allows it. Mark: weights can
      // be backfilled, so a null here is acceptable — a zero never is.
      const wt = estimateWeight(f, size, sched);
      if (wt != null) data.Weight = Number(wt.toFixed(4));

      const ins = await axios.post(base + '/form/' + (tbl === 'bw' ? BW_FORM : SW_FORM), { data }, { headers: zohoHeaders(token) });
      const newId = String(ins.data?.data?.ID || '');
      if (!newId) return res.status(502).json({ ok: false, error: 'Zoho accepted the call but returned no id.' });

      // Usable NOW. Without this the row exists but the picker cannot see it for up to 12 hours,
      // which from the estimator's seat is indistinguishable from the add having failed.
      cacheBust('takeoff:fitting-index');

      remember({
        id: newId, table: tbl, at: new Date().toISOString(),
        manufacturer_id: txt(b.manufacturer_id), project_id: txt(b.project_id),
        type: txt(f.fitting_type), make: txt(f.fitting_make), end: txt(f.end_type),
        connection: txt(f.connection_type), size: size, schedule: sched,
        description: txt(b.description), weight: wt == null ? null : Number(wt.toFixed(4)),
        unresolved: unresolved, source_sheet: txt(f.source_sheet), confirmed: false,
      });

      console.log('[fitting-add] ' + txt(f.fitting_type) + ' ' + size + (sched ? ' ' + sched : '') +
        ' -> ' + (tbl === 'bw' ? 'butt weld' : 'socket/threaded') + ' table, id ' + newId +
        (unresolved.length ? ' (unresolved: ' + unresolved.join(', ') + ')' : '') +
        (wt == null ? ' (no weight)' : ' (weight ' + wt.toFixed(3) + ')'));

      res.json({ ok: true, id: newId, table: tbl, weight: wt == null ? null : Number(wt.toFixed(4)),
        unresolved: unresolved, size: size, schedule: sched });
    } catch (err) {
      console.error('[fitting-add] failed:', err.response?.data || err.message);
      res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
    }
  });

  // What has been added but not yet confirmed — the review queue, busiest first, because an item
  // used on six jobs is a real gap and a one-off is probably a misread drawing.
  app.get('/api/takeoff/fitting-additions', (req, res) => {
    const rows = readLedger();
    const key = (r) => [r.type, r.make, r.end, r.size, r.schedule].join(' | ');
    const grouped = {};
    rows.forEach((r) => {
      const k = key(r);
      grouped[k] = grouped[k] || { what: k, uses: 0, first: r.at, last: r.at, ids: [], unresolved: r.unresolved, confirmed: r.confirmed };
      grouped[k].uses++; grouped[k].last = r.at; grouped[k].ids.push(r.id);
    });
    res.json({ ok: true, total: rows.length,
      items: Object.values(grouped).sort((a, b) => b.uses - a.uses) });
  });

  async function one(base, token, report, id) {
    const r = await axios.get(base + '/report/' + report + '/' + id, { headers: zohoHeaders(token) });
    return (r.data && r.data.data) || {};
  }
  function idOf(row, field) {
    return String((row && row[field] && (row[field].ID || row[field].id)) || (row && row[field + '.ID']) || '');
  }

  // Pipe-derived where the geometry is knowable. A socket-weld or threaded forged body is not
  // derivable from a size alone, so it returns null and stays blank rather than inventing one.
  function estimateWeight(f, size, sched) {
    try {
      if (!/butt\s*weld/i.test(txt(f.end_type))) return null;
      const nps = weights.toNumber(txt(size).replace(/["”]/g, ''));
      const wall = /(\d*\.?\d+)\s*\)?\s*$/.exec(txt(sched).replace(/[^0-9.().]/g, ' '));
      if (!nps || !wall) return null;
      const t = Number(wall[1]);
      if (!(t > 0) || t > 2) return null;
      const od = nps + 2 * t;                       // crude, but only ever an estimate
      const perIn = weights.pipeSectionLbPerIn(od, t, txt(f.fitting_make) || 'Carbon Steel');
      if (perIn == null) return null;
      const key = /elbow/i.test(txt(f.fitting_type)) ? 'elbow_90_lr'
                : /tee|cross/i.test(txt(f.fitting_type)) ? 'tee'
                : /cap/i.test(txt(f.fitting_type)) ? 'cap' : null;
      if (!key) return null;
      return weights.FITTING_LENGTH_IN[key](nps) * perIn;
    } catch (e) { return null; }
  }
}

module.exports = { registerFittingAdd };
