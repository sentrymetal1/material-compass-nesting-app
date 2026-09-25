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
//  ── TWO CALLERS, ONE CREATOR ────────────────────────────────────────────────
//  `makeDetailRowCreator` owns the row creation; the POST route is one caller
//  and `fittingsCommit` is the other. That split exists because a take-off
//  fitting with no detail row lands on the project with a blank `Fitting_ID`,
//  and `Fitting_ID` is the join key across BOM → Quote → Purchase: without it
//  the fitting prices at $0 on the component. Commit therefore creates the row
//  it needs rather than writing a fitting that cannot carry a price.
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
const iron = require('./ironFittingWeights');
const { indexHay } = require('./fittingIndex');
// The same size and schedule normalisation the matcher uses, so a sibling is found by what a
// size IS rather than by how the table happens to spell it.
const { npsNum, sameSched } = require('./fittingResolve');

const BW_FORM = 'Tee_Reducing_NPS_Dimensions';
const SW_FORM = 'Fittings_Socket_Weld_and_Threaded_Details';
const BW_REPORT = 'Tee_Reducing_NPS_Dimensions_Report';
const SW_REPORT = 'Fittings_Socket_Weld_and_Threaded_Details_Report';

const txt = (v) => String(v == null ? '' : v).trim();
// "1-1/2\"", "1 1/2 in", "1.5" all have to read as the same size.
const sizeKey = (s) => txt(s).toLowerCase().replace(/inch(es)?|["”']/g, '').replace(/[^a-z0-9/.]+/g, '');

// Butt weld lives in one table, everything else in the other. The end type decides, because
// that is what the two tables are actually divided by.
const tableFor = (endName) => (/butt\s*weld/i.test(txt(endName)) ? 'bw' : 'sw');

function badInput(msg) { const e = new Error(msg); e.status = 400; return e; }

// =============================================================================
//  The creator. Everything below the route used to live inside it.
// =============================================================================
function makeDetailRowCreator(deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, cacheBust, buildFittingIndex,
          appendFittingIndex, filestore } = deps;

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

  // A lookup id harvested from a sibling row, remembered for the life of the process. These are
  // ids of catalog rows Mark maintains by hand — they do not move — and a take-off commits ten
  // fittings of the same size at a time, which would otherwise be ten identical paid reads
  // against a 1,000/day ceiling.
  const siblingCache = new Map();
  async function siblingIds(base, token, tbl, rowId) {
    const key = tbl + '|' + rowId;
    if (siblingCache.has(key)) return siblingCache.get(key);
    const r = await axios.get(base + '/report/' + (tbl === 'bw' ? BW_REPORT : SW_REPORT) + '/' + rowId,
      { headers: zohoHeaders(token) });
    const row = (r.data && r.data.data) || {};
    siblingCache.set(key, row);
    return row;
  }
  function idOf(row, field) {
    return String((row && row[field] && (row[field].ID || row[field].id)) || (row && row[field + '.ID']) || '');
  }

  // ---------------------------------------------------------------------------
  //  createDetailRow(input, opts)
  //    input : { fitting: {...editor row...}, size, schedule, description,
  //              project_id, manufacturer_id }
  //    opts  : { index }  — an already-built index, so a commit loop pays for it once
  //
  //  Returns { id, table, label, weight, weight_source, weight_confidence,
  //            weight_note, unresolved, size, schedule }.
  //  Throws on refusal; a validation refusal carries err.status = 400.
  // ---------------------------------------------------------------------------
  async function createDetailRow(input, opts) {
    const b = input || {};
    const o = opts || {};
    const f = b.fitting || {};
    const size = txt(b.size), sched = txt(b.schedule);
    if (!txt(f.fitting_type_id)) throw badInput('This row has no catalog fitting type yet — set that first.');
    if (!size) throw badInput('A size is required.');

    const token = await getAccessToken();
    const base = creatorApiBase();
    const idx = o.index || await buildFittingIndex();
    const items = (idx && idx.items) || [];
    const tbl = tableFor(f.end_type);

    // ── DO NOT CREATE WHAT IS ALREADY THERE ─────────────────────────────────────────────
    // A take-off routinely carries the same 2" olet on four components, and the editor hands
    // each of them over unmatched. Creating one row per occurrence would spend four writes to
    // produce four catalog records for one fitting — against 195k of a 250k record ceiling, and
    // leaving a picker with four identical entries. So an exact structural match is REUSED.
    //
    // Exact means: same fitting type, and same make/end/connection wherever this row names one,
    // and the same size and schedule-or-class. Anything looser would join a fitting to a record
    // that is not it, which is the silent-orphan failure this module exists to avoid.
    const same = (a, bv) => sizeKey(a) === sizeKey(bv);
    const sameId = (want, has) => !txt(want) || txt(want) === txt(has);
    const existing = items.find((x) =>
      x.tbl === tbl &&
      txt(x.typeId) === txt(f.fitting_type_id) &&
      sameId(f.fitting_make_id, x.makeId) &&
      sameId(f.end_type_id, x.endId) &&
      sameId(f.connection_type_id, x.connId) &&
      same(x.size, size) && same(x.sched, sched));
    if (existing) {
      return {
        id: String(existing.id), table: existing.tbl,
        label: txt(existing.label) || [size, sched].filter(Boolean).join(' | '),
        weight: existing.weight == null ? null : Number(existing.weight),
        weight_source: existing.weight == null ? null : 'catalog-row',
        weight_confidence: existing.weight == null ? null : 'catalog',
        weight_note: null, unresolved: [], size: size, schedule: sched,
        reused: true,
      };
    }

    // Structural lookups come straight from the editor — already resolved against the catalog.
    //
    // Fitting_Style is set because EVERY existing row has one — checked against the live tables
    // 2026-09-23: 10,957 rows, "Butt Weld" on every butt-weld row and "Forged" on every
    // socket/threaded row, including last session's 524 iron ones. It is not decoration: the
    // project subform shows or hides the two Fittings_* cascade lookups by this field, so a row
    // without it is a row that joins correctly and still does not appear.
    const data = {
      Fitting_Type: txt(f.fitting_type_id),
      Fitting_Style: tbl === 'bw' ? 'Butt Weld' : 'Forged',
    };
    if (txt(f.fitting_make_id))    data.Fitting_Make = txt(f.fitting_make_id);
    if (txt(f.end_type_id))        data.End_Type = txt(f.end_type_id);
    if (txt(f.connection_type_id)) data.Connection_Type = txt(f.connection_type_id);
    // The small end of a reducing fitting, in the field the picker reads it from — without it
    // three different reducing couplings are indistinguishable in the list.
    if (txt(f.reducer_dims) && tbl === 'sw') data.Reducer_Dims_Text = txt(f.reducer_dims);

    // ── SIBLINGS COME FROM THIS TABLE ONLY ──────────────────────────────────────────────
    // The two detail tables have DIFFERENT dimension fields — NPS_Dimension on butt weld,
    // NPS_Dimensions on socket/threaded — and different id spaces behind them. An earlier
    // version fell back to a sibling in either table and then read it out of this table's
    // report, which Zoho answers with "The specified record ID is incorrect or non-existent".
    // A cross-table id would be worse if it HAD worked: a real id pointing at the wrong thing.
    //
    // Sizes are compared numerically as well as textually, because the two tables write a size
    // differently: '1-1/4"' on socket/threaded against '1-1/4" (1.660 OD)' on butt weld. That
    // difference alone is why no same-table sibling was being found here.
    const sameTable = items.filter((x) => x.tbl === tbl);
    const wantSize = sizeKey(size), wantNps = npsNum(size);
    const sizeSib = sameTable.find((x) => sizeKey(x.size) === wantSize) ||
                    (wantNps ? sameTable.find((x) => npsNum(x.size) === wantNps) : null);
    // ...and a sibling with this schedule or class gives us that one. Same normalisation the
    // matcher uses, so 'SCH 80 (.191")' finds the row filed as '80 (.191)'.
    const schedSib = sched ? (sameTable.find((x) => sameSched(x.sched, sched)) || null) : null;

    // Raw rows carry the lookup ids; the index does not, so fetch just the two siblings.
    const unresolved = [];
    if (sizeSib) {
      const row = await siblingIds(base, token, tbl, sizeSib.id);
      const dimId = idOf(row, tbl === 'bw' ? 'NPS_Dimension' : 'NPS_Dimensions');
      if (dimId) data[tbl === 'bw' ? 'NPS_Dimension' : 'NPS_Dimensions'] = dimId;
      else unresolved.push('size');
    } else unresolved.push('size');

    if (sched) {
      if (schedSib) {
        const row = await siblingIds(base, token, tbl, schedSib.id);
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
    const label = txt(b.description) || [size, sched].filter(Boolean).join(' | ');
    if (tbl === 'bw') data.NPS_Dim_And_SCH_Text = label;
    else { data.NPS_Inch_Text = size; data.NPS_Dim_and_Class = label; }

    // Weight, computed rather than left blank where the geometry allows it. Mark: weights can
    // be backfilled, so a null here is acceptable — a zero never is.
    const wt = estimateWeight(f, size, sched);
    if (wt != null) data.Weight = Number(wt.lb.toFixed(4));

    const ins = await axios.post(base + '/form/' + (tbl === 'bw' ? BW_FORM : SW_FORM), { data }, { headers: zohoHeaders(token) });
    const newId = String(ins.data?.data?.ID || '');
    if (!newId) throw new Error('Zoho accepted the call but returned no id.');

    // Usable NOW. Without this the row exists but the picker cannot see it for up to 12 hours,
    // which from the estimator's seat is indistinguishable from the add having failed.
    //
    // BOTH copies, and the append is the one that matters: cacheBust only drops the in-memory
    // index, so the next build reloads the 24h copy on the volume — which does not have this row
    // in it. Appending first means the rebuilt index carries the new row without spending the
    // ~53 reads a forced rebuild would cost.
    const weightLb = wt == null ? null : Number(wt.lb.toFixed(4));
    const item = {
      id: newId, tbl: tbl,
      type: txt(f.fitting_type), typeId: txt(f.fitting_type_id),
      make: txt(f.fitting_make), makeId: txt(f.fitting_make_id),
      end: txt(f.end_type),      endId: txt(f.end_type_id),
      conn: txt(f.connection_type), connId: txt(f.connection_type_id),
      size: size, sched: sched, rdims: '',
      label: label, weight: weightLb,
      hay: indexHay([txt(f.fitting_type), txt(f.fitting_make), txt(f.end_type),
                     txt(f.connection_type), size, sched, '', label].join(' ')),
    };
    // Into the caller's copy too, so the reuse check above sees this row for the rest of a
    // commit. Without it, four identical olets on four components still make four records.
    if (Array.isArray(items)) items.push(item);
    if (typeof appendFittingIndex === 'function') {
      try { appendFittingIndex(item); }
      catch (e) { console.error('[fitting-add] index append failed (row still created):', e.message); }
    }
    if (typeof cacheBust === 'function') cacheBust('takeoff:fitting-index');

    remember({
      id: newId, table: tbl, at: new Date().toISOString(),
      manufacturer_id: txt(b.manufacturer_id), project_id: txt(b.project_id),
      type: txt(f.fitting_type), make: txt(f.fitting_make), end: txt(f.end_type),
      connection: txt(f.connection_type), size: size, schedule: sched,
      description: txt(b.description), weight: weightLb,
      // Where the weight came from, so the review queue can tell a published figure from an
      // estimate without re-deriving it.
      weight_source: wt == null ? null : wt.source,
      weight_confidence: wt == null ? null : wt.confidence,
      weight_note: wt == null ? null : wt.note,
      unresolved: unresolved, source_sheet: txt(f.source_sheet), confirmed: false,
      // Which door it came in by. A row created at commit was never seen by anyone, so the
      // review queue should weigh it differently from one an estimator typed deliberately.
      via: txt(b.via) || 'add',
    });

    console.log('[fitting-add] ' + txt(f.fitting_type) + ' ' + size + (sched ? ' ' + sched : '') +
      ' -> ' + (tbl === 'bw' ? 'butt weld' : 'socket/threaded') + ' table, id ' + newId +
      (txt(b.via) ? ' (via ' + txt(b.via) + ')' : '') +
      (unresolved.length ? ' (unresolved: ' + unresolved.join(', ') + ')' : '') +
      (wt == null ? ' (no weight)' : ' (weight ' + wt.lb.toFixed(3) + ' lb, ' + wt.confidence + ')'));

    return {
      id: newId, table: tbl, label: label,
      weight: weightLb,
      weight_source: wt == null ? null : wt.source,
      weight_confidence: wt == null ? null : wt.confidence,
      weight_note: wt == null ? null : wt.note,
      unresolved: unresolved, size: size, schedule: sched,
    };
  }

  // Two routes, and the order matters.
  //
  // A threaded IRON fitting is a casting, not a length of pipe, so no geometry gets near it —
  // at 1/2" the elbow formula cannot reach the catalogued weight even with a solid body. Those
  // come from a published table instead, so that route is tried first and for any end type.
  //
  // Everything else is pipe-derived where the geometry is knowable. A socket-weld or threaded
  // FORGED body is not derivable from a size alone, so it returns null and stays blank rather
  // than inventing one.
  //
  // Returns null, or { lb, source, confidence, note } — never a bare zero.
  function estimateWeight(f, size, sched) {
    try {
      const fromTable = iron.ironFittingLb({
        material: txt(f.fitting_make),
        type: txt(f.fitting_type),
        size: txt(size),
      });
      if (fromTable) return fromTable;

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
      const lb = weights.FITTING_LENGTH_IN[key](nps) * perIn;
      if (!(lb > 0)) return null;
      return {
        lb: lb,
        source: 'pipe-section-geometry',
        confidence: 'estimated',
        note: 'derived from the pipe section and a B16.9 centre-to-end length; not a published weight',
      };
    } catch (e) { return null; }
  }

  return { createDetailRow: createDetailRow, readLedger: readLedger, estimateWeight: estimateWeight };
}

// =============================================================================
//  The routes.
// =============================================================================
//  `deps` may be the raw dependency bag, or an already-built creator (what
//  index.js passes, so the commit path and this route share one ledger and one
//  sibling cache).
function registerFittingAdd(app, deps) {
  const creator = deps && typeof deps.createDetailRow === 'function' ? deps : makeDetailRowCreator(deps);
  const { createDetailRow, readLedger } = creator;

  // POST /api/takeoff/fitting-add
  //   { fitting: {...editor row...}, size, schedule, description, project_id, manufacturer_id }
  app.post('/api/takeoff/fitting-add', async (req, res) => {
    const b = req.body || {};
    try {
      const out = await createDetailRow({
        fitting: b.fitting || {}, size: b.size, schedule: b.schedule, description: b.description,
        project_id: b.project_id, manufacturer_id: b.manufacturer_id, via: 'add',
      });
      res.json({ ok: true, id: out.id, table: out.table,
        weight: out.weight, weight_source: out.weight_source, weight_confidence: out.weight_confidence,
        unresolved: out.unresolved, size: out.size, schedule: out.schedule });
    } catch (err) {
      if (err && err.status === 400) return res.status(400).json({ ok: false, error: err.message });
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
      grouped[k] = grouped[k] || { what: k, uses: 0, first: r.at, last: r.at, ids: [], unresolved: r.unresolved, confirmed: r.confirmed, via: r.via || 'add' };
      grouped[k].uses++; grouped[k].last = r.at; grouped[k].ids.push(r.id);
    });
    res.json({ ok: true, total: rows.length,
      items: Object.values(grouped).sort((a, b) => b.uses - a.uses) });
  });
}

module.exports = { registerFittingAdd, makeDetailRowCreator };
