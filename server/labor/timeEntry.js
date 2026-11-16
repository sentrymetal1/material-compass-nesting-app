// =============================================================================
//  labor/timeEntry.js — actual hours per work order, entered as a weekly time sheet.
// -----------------------------------------------------------------------------
//  Plan: docs/LABOR_TRACKING_PLAN.md (Mark, 2026-11-16: anyone with platform access enters
//  time, in the office for now; tablet later; hours may go to the WHOLE JOB).
//
//  One Zoho row per employee x day x component x labour type x entry type, in
//  Work_Order_Actual_Labor_Details_Form (report API_Actual_Labor). The hours go in the
//  type's broad bucket (Weld_Hrs, …), priced at the WORK ORDER's rate for that bucket, and
//  _Amt / Total_Hours / Total_Amount are written because an API insert runs no Deluge.
//  Links set on every row: Job_Form, Work_Order_Bi_Directional_Lookup (without it the row
//  does not show on the WO), Work_Order_ID, and the component pair.
//
//  WHOLE JOB: hours split over the WO's components by quoted labour $ (else weight, else
//  evenly), each piece tagged Section_Detail = "Whole job", so the sheet can show them as
//  one line again.
//
//  The work order's Actual Labor Totals record (report API_Actual_Labor_Totals) is rebuilt
//  from ALL its actual rows after every save, the same fix the project's labour bar needed.
//
//  Rows with no Work_Date (the old hand-typed lump sums) never appear on a week and are
//  never touched.
// =============================================================================
const axios = require('axios');
const { TYPES, BY_CODE, BUCKET_DEFAULT, codeFromZoho } = require('./laborTypes');

const ROW_REPORT = 'API_Actual_Labor';
const ROW_FORM = 'Work_Order_Actual_Labor_Details_Form';
const TOT_REPORT = 'API_Actual_Labor_Totals';
const TOT_FORM = 'Work_Order_Actual_Labor_Totals';
const WO_REPORT = 'API_Work_Orders';
const COMP_REPORT = 'Work_Order_Components_Form_Report';
const EMP_REPORT = 'API_Employees';
const EMP_FORM = 'Employee';
const WHOLE = 'Whole job';
const ENTRY_TYPES = ['Project Quote', 'Change', 'Adder'];

// Row bucket -> [WO rate field, Totals prefix]
const BUCKETS = {
  Cutting_Hrs: ['Cutting_Rate', 'Cut'], CNC_Hrs: ['CNC_Rate', 'CNC'], Assy_Hrs: ['Assembly_Rate', 'Assy'],
  Fab_Hrs: ['Fabrication_Rate', 'Fab'], Weld_Hrs: ['Welding_Rate', 'Weld'], Labor_Hrs: ['Labor_Rate', 'Labor'],
  Inspection_Hrs: ['Inspection_Rate', 'Inspection'], Misc_Hrs: ['Misc_Rate', 'Misc'],
};
const stem = (b) => b.replace(/_Hrs$/, '');

const enc = encodeURIComponent;
const s = (v) => (v == null ? '' : String(v)).trim();
const idOf = (v) => (v && typeof v === 'object' ? s(v.ID) : s(v));
const disp = (v) => (v && typeof v === 'object' ? s(v.zc_display_value) : s(v));
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ISO yyyy-mm-dd <-> Zoho display "Nov 16,2026" (the format the API reads and writes).
function zDate(iso) { const [y, m, d] = iso.split('-').map(Number); return MON[m - 1] + ' ' + String(d).padStart(2, '0') + ',' + y; }
function isoFromZ(z) {
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(s(z));
  if (!m) return '';
  const mo = MON.indexOf(m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()) + 1;
  return mo ? m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0') : '';
}
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Any date -> the Monday of its week.
function monday(iso) {
  const d = new Date((/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date().toISOString().slice(0, 10)) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const isOpen = (w) => !/clos|complet|cancel|invoic|void/i.test(s(w.Work_Order_Status) + ' ' + s(w.Job_Status));

function shopOf(req) {
  if (req.tenant && req.tenant.kind === 'm') return s(req.tenant.id);
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  return s((req.query && req.query.manufacturer_id) || b.manufacturer_id);
}

// What one Zoho row means on the sheet.
function rowCode(r) {
  const c = codeFromZoho(r.Labor_Type);
  if (c) return c;
  let best = 'Misc_Hrs', hi = 0;
  for (const b of Object.keys(BUCKETS)) if (num(r[b]) > hi) { hi = num(r[b]); best = b; }
  return BUCKET_DEFAULT[best] || 'MISC';
}
function rowHours(r) {
  const t = num(r.Total_Hours);
  return t || Object.keys(BUCKETS).reduce((a, b) => a + num(r[b]), 0);
}
const lineKey = (emp, wo, comp, code, entry) => [emp, wo, comp || 'WHOLE', code, entry].join('|');

// Split hours over components by weight; the last piece takes the rounding.
function spread(hours, comps) {
  if (!comps.length) return [{ comp: null, hours: r2(hours) }];
  let w = comps.map((c) => c.quoted_amt);
  if (!w.some((x) => x > 0)) w = comps.map((c) => c.weight);
  if (!w.some((x) => x > 0)) w = comps.map(() => 1);
  const tot = w.reduce((a, x) => a + x, 0);
  const out = []; let used = 0;
  comps.forEach((c, i) => {
    const h = i === comps.length - 1 ? r2(hours - used) : r2(hours * w[i] / tot);
    used = r2(used + h);
    if (h > 0) out.push({ comp: c, hours: h });
  });
  return out;
}

function registerTimeEntry(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders, fetchAllZohoPages } = deps;
  const H = async () => ({ headers: { ...zohoHeaders(await getAccessToken()), 'Content-Type': 'application/json' } });
  const check = (r, what) => {
    const b = r && r.data ? r.data : {};
    if (b.code !== 3000) throw new Error(what + ' was refused (code ' + b.code + '): ' + (b.message || JSON.stringify(b).slice(0, 200)));
    return b;
  };
  // An empty report answers 9220 / 9280 instead of []; that is not an error here.
  const rows = async (path) => {
    try { return await fetchAllZohoPages(path); }
    catch (e) { const c = e.response && e.response.data && e.response.data.code; if (c === 9220 || c === 9280) return []; throw e; }
  };

  async function employees(shop) {
    return (await rows('/report/' + EMP_REPORT + '?criteria=' + enc('(Customer_Entry_Form == ' + shop + ')'))).map((e) => {
      const n = e.Employee_Name || {};
      return { id: s(e.ID), first: s(n.first_name), last: s(n.last_name),
        name: (s(n.first_name) + ' ' + s(n.last_name)).trim() || s(n.zc_display_value), number: s(e.Employee_Number),
        rate: num(e.Hourly_Rate) || null, email: s(e.Email), active: !/inactive|terminat|left/i.test(s(e.Status)) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function workOrders(shop) {
    const [wos, comps] = await Promise.all([
      // Older WOs have the Manufacture lookup but no Manufacture_ID number, so match either.
      rows('/report/' + WO_REPORT + '?criteria=' + enc('(Manufacture == ' + shop + ' || Manufacture_ID == ' + shop + ')')),
      rows('/report/' + COMP_REPORT + '?criteria=' + enc('(Customer_Entry_Form == ' + shop + ')')),
    ]);
    const byWo = {};
    comps.forEach((c) => {
      const wo = idOf(c.Job_Form) || s(c.Work_Order_LU);
      if (!wo) return;
      (byWo[wo] = byWo[wo] || []).push({ id: s(c.ID), name: s(c.Project_Component) || idOf(c.Project_Components_Form),
        pcf: idOf(c.Project_Components_Form), quoted_amt: num(c.Total_Labor_Amt),
        weight: num(c.Unit_Weight_Of_Component) * (num(c.Quantity) || 1) });
    });
    return wos.map((w) => {
      const rates = {};
      for (const b of Object.keys(BUCKETS)) rates[b] = num(w[BUCKETS[b][0]]);
      const number = s(w.Job_Number) && s(w.Job_Number) !== 'TBD' ? s(w.Job_Number) : s(w.Job_Auto_Number) || 'WO (number pending)';
      const what = s(w.Work_Order_Description).replace(/^WO#\s*\d+\s*\|\s*/, '') ||
        disp(w.Project_Information);
      return { id: s(w.ID), number, label: number + (what ? ' · ' + what : '') + (disp(w.Client) ? ' · ' + disp(w.Client) : ''),
        open: isOpen(w), rates, components: (byWo[s(w.ID)] || []).sort((a, b) => a.name.localeCompare(b.name)) };
    }).sort((a, b) => b.number.localeCompare(a.number, undefined, { numeric: true }));
  }

  // This shop's rows dated in the week.
  async function weekRows(start, woIds) {
    const end = addDays(start, 6);
    const crit = '(Work_Date >= "' + zDate(start) + '" && Work_Date <= "' + zDate(end) + '")';
    return (await rows('/report/' + ROW_REPORT + '?criteria=' + enc(crit))).filter((r) => woIds.has(idOf(r.Job_Form)));
  }

  // Zoho rows -> sheet lines { key, employee, wo, component ('' = whole job), code, entry, hours[7], ids[7][] }
  function toLines(zrows, start) {
    const lines = {};
    for (const r of zrows) {
      const day = Math.round((new Date(isoFromZ(r.Work_Date) + 'T12:00:00Z') - new Date(start + 'T12:00:00Z')) / 864e5);
      if (!(day >= 0 && day <= 6)) continue;
      const whole = /^whole job/i.test(s(r.Section_Detail));
      const emp = idOf(r.Employee), wo = idOf(r.Job_Form), comp = whole ? '' : idOf(r.Work_Order_Components_Form);
      const code = rowCode(r), entry = s(r.Type_Of_Entry) || 'Project Quote';
      const k = lineKey(emp, wo, comp, code, entry);
      const L = lines[k] = lines[k] || { key: k, employee: emp, wo, component: comp, code, entry,
        hours: [0, 0, 0, 0, 0, 0, 0], ids: [[], [], [], [], [], [], []], note: '' };
      L.hours[day] = r2(L.hours[day] + rowHours(r));
      L.ids[day].push(s(r.ID));
      if (s(r.Comments) && !L.note) L.note = s(r.Comments);
    }
    return Object.values(lines);
  }

  async function rebuildTotals(woId, wo, shop, base, h) {
    const all = await rows('/report/' + ROW_REPORT + '?criteria=' + enc('(Job_Form == ' + woId + ')'));
    const data = { Job_Form: woId, Work_Order_ID: woId, Manufacture: shop };
    let th = 0, ta = 0;
    for (const b of Object.keys(BUCKETS)) {
      const hrs = r2(all.reduce((a, r) => a + num(r[b]), 0));
      const amt = r2(all.reduce((a, r) => a + num(r[stem(b) + '_Amt']), 0));
      data[BUCKETS[b][1] + '_Total_Hrs'] = hrs; data[BUCKETS[b][1] + '_Total_Amt'] = amt;
      th += hrs; ta += amt;
    }
    data.Total_Hrs = r2(th); data.Total_Amt = r2(ta);
    const have = await rows('/report/' + TOT_REPORT + '?criteria=' + enc('(Job_Form == ' + woId + ')'));
    if (have.length) check(await axios.patch(base + '/report/' + TOT_REPORT + '/' + s(have[0].ID), { data }, h), 'The labor totals for ' + wo.number);
    else check(await axios.post(base + '/form/' + TOT_FORM, { data }, h), 'The labor totals for ' + wo.number);
    return { hours: data.Total_Hrs, amount: data.Total_Amt };
  }

  const bad = (res, msg) => res.status(400).json({ ok: false, error: msg });

  // ---- load one week -------------------------------------------------------------------------
  app.get('/api/labor-time/week', async (req, res) => {
    try {
      const shop = shopOf(req);
      if (!/^\d+$/.test(shop)) return bad(res, 'Please reopen this page from Material Compass.');
      const start = monday(s(req.query.start));
      const [emps, wos] = await Promise.all([employees(shop), workOrders(shop)]);
      const lines = toLines(await weekRows(start, new Set(wos.map((w) => w.id))), start);
      res.json({ ok: true, start, days: [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i)),
        employees: emps, work_orders: wos, lines, entry_types: ENTRY_TYPES,
        types: TYPES.map((t) => ({ code: t.code, label: t.label, zoho: t.zoho, bucket: t.bucket })) });
    } catch (e) {
      console.error('[labor-time] week', e.response ? JSON.stringify(e.response.data) : e.message);
      res.status(502).json({ ok: false, error: 'The time sheet could not be loaded. Please try again.' });
    }
  });

  // ---- save one week ---------------------------------------------------------------------------
  // body: { start, lines: [{ employee, wo, component ('' = whole job), code, entry, hours[7], note }] }
  // The sheet sent is the WHOLE week for this shop: lines left out are deleted.
  app.post('/api/labor-time/save', async (req, res) => {
    const done = { added: 0, removed: 0, kept: 0 }, problems = [];
    try {
      const shop = shopOf(req);
      if (!/^\d+$/.test(shop)) return bad(res, 'Please reopen this page from Material Compass.');
      const b = req.body || {};
      const start = monday(s(b.start));
      if (start !== s(b.start)) return bad(res, 'The week must start on a Monday. Reload the page.');
      const [emps, wos] = await Promise.all([employees(shop), workOrders(shop)]);
      const empSet = new Set(emps.map((e) => e.id)), woById = {};
      wos.forEach((w) => { woById[w.id] = w; });

      // What the sheet wants: key|day -> { line, hours }
      const want = {};
      for (const L of (Array.isArray(b.lines) ? b.lines : [])) {
        const emp = s(L.employee), wo = s(L.wo), comp = s(L.component), code = s(L.code), entry = s(L.entry) || 'Project Quote';
        const hrs = (Array.isArray(L.hours) ? L.hours : []).slice(0, 7).map((x) => r2(Math.max(0, num(x))));
        if (!hrs.some((x) => x > 0)) continue;
        if (!empSet.has(emp)) return bad(res, 'An employee on the sheet is not on your list. Reload the page.');
        const W = woById[wo];
        if (!W) return bad(res, 'A work order on the sheet is not one of yours. Reload the page.');
        if (comp && !W.components.some((c) => c.id === comp)) return bad(res, 'A component on the sheet is not on ' + W.number + '.');
        if (!BY_CODE[code]) return bad(res, 'Unknown labor type. Reload the page.');
        if (ENTRY_TYPES.indexOf(entry) < 0) return bad(res, 'Unknown entry type.');
        if (hrs.some((x) => x > 24)) return bad(res, 'More than 24 hours in one day for one line.');
        const k = lineKey(emp, wo, comp, code, entry);
        hrs.forEach((x, d) => {
          if (!(x > 0)) return;
          const kk = k + '|' + d;
          if (want[kk]) want[kk].hours = r2(want[kk].hours + x);
          else want[kk] = { emp, wo, comp, code, entry, day: d, hours: x, note: s(L.note).slice(0, 250) };
        });
      }

      // What Zoho has for this week, grouped the same way.
      const have = {};
      for (const L of toLines(await weekRows(start, new Set(wos.map((w) => w.id))), start)) {
        L.hours.forEach((x, d) => { if (L.ids[d].length) have[L.key + '|' + d] = { hours: x, ids: L.ids[d], wo: L.wo }; });
      }

      const base = creatorApiBase(), h = await H();
      const touched = new Set(), toDelete = [], toAdd = [];
      for (const kk of Object.keys(have)) {
        if (want[kk] && Math.abs(want[kk].hours - have[kk].hours) < 0.005) { done.kept++; delete want[kk]; continue; }
        toDelete.push(...have[kk].ids); touched.add(have[kk].wo);
      }
      for (const kk of Object.keys(want)) {
        const w = want[kk], W = woById[w.wo], t = BY_CODE[w.code], bucket = t.bucket;
        const rate = W.rates[bucket] || 0, date = zDate(addDays(start, w.day));
        const pieces = w.comp ? [{ comp: W.components.find((c) => c.id === w.comp), hours: w.hours }] : spread(w.hours, W.components);
        for (const p of pieces) {
          const data = {
            Job_Form: W.id, Work_Order_Bi_Directional_Lookup: W.id, Work_Order_ID: W.id,
            Employee: w.emp, Work_Date: date, Start_Date: date, End_Date: date,
            Labor_Type: t.zoho, Type_Of_Entry: w.entry, Section_Detail: w.comp ? '' : WHOLE, Comments: w.note,
            Total_Hours: p.hours, Total_Amount: r2(p.hours * rate),
          };
          for (const bk of Object.keys(BUCKETS)) {
            const st = stem(bk);
            data[bk] = bk === bucket ? p.hours : 0;
            data[st + '_Rate'] = W.rates[bk] || 0;
            data[st + '_Amt'] = bk === bucket ? r2(p.hours * rate) : 0;
          }
          if (p.comp) {
            data.Work_Order_Components_Form = p.comp.id; data.Work_Order_Component_ID = p.comp.id;
            if (p.comp.pcf) data.Project_Components_Form = p.comp.pcf;
          }
          toAdd.push(data);
        }
        touched.add(W.id);
      }

      // Add first, then delete: a failure part-way leaves extra rows (visible), never lost hours.
      for (let i = 0; i < toAdd.length; i += 200) {
        const r = await axios.post(base + '/form/' + ROW_FORM, { data: toAdd.slice(i, i + 200) }, h);
        const results = Array.isArray(r.data && r.data.result) ? r.data.result : [r.data];
        results.forEach((x) => { if (x && x.code === 3000) done.added++; else problems.push('A row was refused: ' + JSON.stringify(x && (x.error || x.message) || x).slice(0, 160)); });
      }
      if (problems.length) {
        return res.status(502).json({ ok: false, error: 'Some hours did not save, so nothing was removed. ' + problems[0], done });
      }
      for (const id of toDelete) {
        try { check(await axios.delete(base + '/report/' + ROW_REPORT + '/' + id, h), 'Removing an old entry'); done.removed++; }
        catch (e) { problems.push(e.message); }
      }
      const totals = {};
      for (const woId of touched) {
        try { totals[woById[woId].number] = await rebuildTotals(woId, woById[woId], shop, base, h); }
        catch (e) { problems.push('Totals for ' + woById[woId].number + ': ' + e.message); }
      }
      res.json({ ok: true, done, totals, problems });
    } catch (e) {
      console.error('[labor-time] save', e.response ? JSON.stringify(e.response.data) : e.message);
      res.status(502).json({ ok: false, error: 'The save did not go through: ' + (e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message), done });
    }
  });

  // ---- employees ---------------------------------------------------------------------------------
  // body: { employee: { id?, first, last, number, rate, email, active } }
  app.post('/api/labor-time/employee', async (req, res) => {
    try {
      const shop = shopOf(req);
      if (!/^\d+$/.test(shop)) return bad(res, 'Please reopen this page from Material Compass.');
      const e = (req.body || {}).employee || {};
      const first = s(e.first), last = s(e.last);
      if (!first && !last) return bad(res, 'Enter the employee\'s name.');
      const list = await employees(shop), id = s(e.id);
      if (id && !list.some((x) => x.id === id)) return res.status(404).json({ ok: false, error: 'That employee is not on your list.' });
      const nm = (first + ' ' + last).toLowerCase().replace(/\s+/g, ' ');
      const dup = list.find((x) => x.id !== id && x.name.toLowerCase().replace(/\s+/g, ' ') === nm);
      if (dup) return res.status(409).json({ ok: false, error: dup.name + ' is already on your list.' + (dup.active ? '' : ' They are inactive; turn them back on instead.') });
      const data = { Customer_Entry_Form: shop, Employee_Name: { first_name: first, last_name: last },
        Employee_Number: s(e.number), Email: s(e.email), Status: e.active === false ? 'Inactive' : 'Active' };
      if (num(e.rate) > 0) data.Hourly_Rate = r2(num(e.rate));
      const base = creatorApiBase(), h = await H();
      let newId = id;
      if (id) check(await axios.patch(base + '/report/' + EMP_REPORT + '/' + id, { data }, h), 'The employee update');
      else newId = s(check(await axios.post(base + '/form/' + EMP_FORM, { data }, h), 'The new employee').data.ID);
      res.json({ ok: true, id: newId, employees: await employees(shop) });
    } catch (e) {
      console.error('[labor-time] employee', e.response ? JSON.stringify(e.response.data) : e.message);
      res.status(502).json({ ok: false, error: 'The employee was not saved: ' + (e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message) });
    }
  });
}

module.exports = { registerTimeEntry, spread, monday, zDate, isoFromZ, rowCode };
