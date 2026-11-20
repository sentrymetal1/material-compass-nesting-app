// =============================================================================
//  teach/teachRoutes.js — "Teach the take-off" page's server side (page: takeoff/public/teach.html).
// -----------------------------------------------------------------------------
//    GET    /api/teach/jobs                      the shop's past jobs (+ labels, progress)
//    POST   /api/teach/jobs                      add a past job
//    GET    /api/teach/jobs/:id                  one job + its proposals and cross-checks
//    POST   /api/teach/jobs/:id                  edit name / number / outcome / project type / labor category
//    DELETE /api/teach/jobs/:id                  remove a job and its files (confirmed lessons stay)
//    POST   /api/teach/jobs/:id/file             add ONE file; the AI reads it now
//    POST   /api/teach/jobs/:id/file/:fid/kind   "this is really a job cost report" -> read again
//    POST   /api/teach/jobs/:id/file/:fid/read   read a saved file again
//    DELETE /api/teach/jobs/:id/file/:fid
//    POST   /api/teach/jobs/:id/confirm          save the confirmed proposals
//
//  Storage, per shop: the jobs in teach-<shop>.json and the files under <store>/teach/<shop>/<job>/.
//  Files are KEPT (Mark, 2026-11-19) so they can be read again as the take-off improves; they are not
//  reachable through the general /api/files routes. Confirmed lessons go to:
//    reference job      -> labor/shop.js reference_jobs (id "tj<job>", replaced on re-confirm)
//    scope / outside cost / material price -> Takeoff_Correction rows, Source = "history",
//                          Project_Type = the job's project type.
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { readJson, writeJson, storeRoot } = require('../filestore');
const shop = require('../labor/shop');
const T = require('./teachCore');

const MAX_FILE = 30 * 1024 * 1024;
const s = (v) => (v == null ? '' : String(v)).trim();

function registerTeach(app, deps) {
  const { getAccessToken, creatorApiBase, zohoHeaders } = deps;

  function shopOf(req) {
    if (req.tenant && req.tenant.kind === 'm') return s(req.tenant.id);
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    return s((req.query && req.query.manufacturer_id) || b.manufacturer_id);
  }
  const jsonName = (mfg) => 'teach-' + mfg + '.json';
  const load = (mfg) => readJson(jsonName(mfg), { jobs: [] }) || { jobs: [] };
  const store = (mfg, d) => writeJson(jsonName(mfg), d);
  const fileDir = (mfg, jobId) => {
    if (!/^\d{6,25}$/.test(mfg) || !/^[a-z0-9]{6,40}$/.test(jobId)) throw new Error('bad path');
    return path.join(storeRoot(), 'teach', mfg, jobId);
  };
  const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const bad = (res, msg, code) => res.status(code || 400).json({ ok: false, error: msg });
  const fail = (res, e) => {
    console.error('[teach]', e && e.response ? JSON.stringify(e.response.data).slice(0, 400) : (e && e.stack) || e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  };
  function withShop(handler) {
    return async (req, res) => {
      const mfg = shopOf(req);
      if (!/^\d{6,25}$/.test(mfg)) return bad(res, 'Open this page from Material Compass.');
      try { await handler(req, res, mfg); } catch (e) { fail(res, e); }
    };
  }
  const findJob = (d, id) => d.jobs.find((j) => j.id === id);
  const reviewed = (d) => d.jobs.filter((j) => j.reviewed).length;
  // What the page shows of a job (no extracts' bulk unless asked).
  function jobOut(j, full) {
    const o = { id: j.id, name: j.name, number: j.number, outcome: j.outcome, final_price: j.final_price, project_type: j.project_type || null,
      labor_cat: j.labor_cat || '', reviewed: j.reviewed || null, created: j.created,
      files: (j.files || []).map((f) => ({ id: f.id, name: f.name, kind: f.kind, kind_label: T.KINDS[f.kind] || '', status: f.status, error: f.error || '',
        summary: (f.extract && f.extract.summary) || '', size: f.size })),
      suggest: suggestions(j), confirmed: (j.confirmed || []).length };
    if (full) Object.assign(o, T.buildProposals(j));
    return o;
  }
  // The AI's project type / labor category guesses across a job's files (most common first).
  function suggestions(j) {
    const pt = {}, lc = {};
    for (const f of j.files || []) {
      const e = f.extract || {};
      if (s(e.project_type_guess)) pt[s(e.project_type_guess)] = (pt[s(e.project_type_guess)] || 0) + 1;
      if (T.LABOR_CATS.includes(e.labor_category_guess)) lc[e.labor_category_guess] = (lc[e.labor_category_guess] || 0) + 1;
    }
    const top = (m) => Object.keys(m).sort((a, b) => m[b] - m[a])[0] || '';
    return { project_type: top(pt), labor_cat: top(lc), name: (j.files || []).map((f) => s(f.extract && f.extract.job_name)).find(Boolean) || '',
      number: (j.files || []).map((f) => s(f.extract && f.extract.job_number)).find(Boolean) || '' };
  }

  // ---------- reading one file with the AI -------------------------------------------------------
  async function excelText(buf) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const out = [];
    wb.eachSheet((ws) => {
      out.push('=== Sheet: ' + ws.name + ' ===');
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        const cells = [];
        row.eachCell({ includeEmpty: false }, (c) => {
          let v = c.value;
          if (v && typeof v === 'object') v = v.result != null ? v.result : (v.text != null ? v.text : (v.richText ? v.richText.map((r) => r.text).join('') : (v instanceof Date ? v.toISOString().slice(0, 10) : '')));
          if (v != null && String(v).trim() !== '') cells.push(c.address + '=' + String(v).trim());
        });
        if (cells.length) out.push(cells.join(' | '));
      });
    });
    return out.join('\n');
  }
  async function blocksFor(name, mt, buf) {
    const n = name.toLowerCase();
    if (/\.pdf$/.test(n) || mt === 'application/pdf') return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }];
    if (/\.(png|jpe?g|gif|webp)$/.test(n) || /^image\/(png|jpeg|gif|webp)$/.test(mt)) {
      const media = /png$/.test(n) ? 'image/png' : /gif$/.test(n) ? 'image/gif' : /webp$/.test(n) ? 'image/webp' : 'image/jpeg';
      return [{ type: 'image', source: { type: 'base64', media_type: /^image\//.test(mt) ? mt : media, data: buf.toString('base64') } }];
    }
    if (/\.xlsx$/.test(n)) {
      let t;
      try { t = await excelText(buf); } catch (e) { throw Object.assign(new Error(name + ' could not be opened as an Excel workbook. Save it as .xlsx, .csv or PDF and add it again.'), { user: true }); }
      return [{ type: 'text', text: 'SPREADSHEET ' + name + ' (each cell as ADDRESS=value; cite the cell in "where"):\n' + t.slice(0, 180000) }];
    }
    if (/\.(csv|txt|tsv)$/.test(n) || /^text\//.test(mt)) return [{ type: 'text', text: 'FILE ' + name + ' (cite the line in "where"):\n' + buf.toString('utf8').split(/\r?\n/).map((l, i) => (i + 1) + ': ' + l).join('\n').slice(0, 180000) }];
    if (/\.(xls|doc|docx)$/.test(n)) throw Object.assign(new Error(name + ': save this as PDF (or .xlsx for spreadsheets) and add it again.'), { user: true });
    throw Object.assign(new Error(name + ': this kind of file can\'t be read. Use PDF, Excel (.xlsx), CSV or a photo.'), { user: true });
  }
  async function readWithAI(job, f, buf) {
    if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Reading documents is not available right now.'), { user: true });
    const _A = require('@anthropic-ai/sdk'); const Anthropic = _A.default || _A;
    const ai = new Anthropic();
    const blocks = await blocksFor(f.name, f.media_type, buf);
    const hint = f.kind_set_by_user ? '\nThe shop says this document is: ' + (T.KINDS[f.kind] || f.kind) + '.' : '';
    const ask = async () => ai.messages.create({
      model: process.env.TEACH_MODEL || 'claude-sonnet-5-5', max_tokens: 6000,
      system: 'You read documents from a metal fabrication shop\'s PAST jobs, so its estimating software can learn how this shop ' +
        'scopes and prices work. Record only what the document states. Never estimate, infer or calculate a total the document does ' +
        'not show; leave the field out. Give "where" for every value (page, sheet cell or line). Answer only by calling record_document.',
      tools: [T.EXTRACT_TOOL], tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: blocks.concat([{ type: 'text', text: 'Document: ' + f.name + '\nPast job: ' + (job.name || '(not named yet)') + (job.number ? ' #' + job.number : '') + hint }]) }],
    });
    let resp = await ask();
    let tu = resp.content.find((b) => b.type === 'tool_use');
    if (!tu) { resp = await ask(); tu = resp.content.find((b) => b.type === 'tool_use'); }
    if (!tu) throw Object.assign(new Error(f.name + ' could not be read. Try again, or add it as a PDF.'), { user: true });
    const e = tu.input || {};
    if (!T.KIND_KEYS.includes(e.kind)) e.kind = 'other';
    return e;
  }
  async function readFile(mfg, job, f) {
    const buf = fs.readFileSync(path.join(fileDir(mfg, job.id), f.stored));
    try {
      f.extract = await readWithAI(job, f, buf);
      if (!f.kind_set_by_user) f.kind = f.extract.kind;
      f.status = 'read'; f.error = '';
    } catch (e) {
      f.status = 'failed';
      // The AI service itself refusing (no credit, overloaded, rate limit) is not the document's fault:
      // say so, rather than sending the user off to convert a file that is fine.
      const svc = e.status === 401 || e.status === 402 || e.status === 403 || e.status === 429 || e.status >= 500 || /credit balance|billing|overloaded|rate.?limit/i.test(String(e.message || ''));
      f.error = e.user ? e.message : (svc ? 'Document reading is not available right now. Try again later; the file is saved and can be read then.' : 'Could not be read. Try again, or add it as a PDF.');
      if (!e.user) console.error('[teach] read', f.name, e.message);
    }
    f.read_at = new Date().toISOString();
  }

  // ---------- routes -----------------------------------------------------------------------------
  app.get('/api/teach/jobs', withShop(async (req, res, mfg) => {
    const d = load(mfg);
    res.json({ ok: true, jobs: d.jobs.map((j) => jobOut(j, false)).reverse(), reviewed: reviewed(d), target: 3, better: 10,
      kinds: T.KINDS, labor_cats: shop.JOB_TYPES });
  }));

  app.post('/api/teach/jobs', withShop(async (req, res, mfg) => {
    const b = req.body || {};
    const d = load(mfg);
    if (d.jobs.length >= 200) return bad(res, 'You have 200 past jobs here already, which is plenty. Remove some to add more.');
    const j = { id: newId(), name: s(b.name).slice(0, 120), number: s(b.number).slice(0, 40), outcome: ['won', 'lost', ''].includes(b.outcome) ? b.outcome : '',
      final_price: Number(b.final_price) > 0 ? Number(b.final_price) : null, files: [], created: new Date().toISOString() };
    d.jobs.push(j); store(mfg, d);
    res.json({ ok: true, job: jobOut(j, true) });
  }));

  app.get('/api/teach/jobs/:id', withShop(async (req, res, mfg) => {
    const j = findJob(load(mfg), req.params.id);
    if (!j) return bad(res, 'That job is not here any more. Reload the page.', 404);
    res.json({ ok: true, job: jobOut(j, true) });
  }));

  app.post('/api/teach/jobs/:id', withShop(async (req, res, mfg) => {
    const d = load(mfg), j = findJob(d, req.params.id), b = req.body || {};
    if (!j) return bad(res, 'That job is not here any more. Reload the page.', 404);
    if (b.name !== undefined) j.name = s(b.name).slice(0, 120);
    if (b.number !== undefined) j.number = s(b.number).slice(0, 40);
    if (b.outcome !== undefined) j.outcome = ['won', 'lost'].includes(b.outcome) ? b.outcome : '';
    if (b.final_price !== undefined) j.final_price = Number(b.final_price) > 0 ? Number(b.final_price) : null;
    if (b.labor_cat !== undefined) j.labor_cat = T.LABOR_CATS.includes(b.labor_cat) ? b.labor_cat : '';
    if (b.project_type !== undefined) j.project_type = b.project_type && s(b.project_type.name) ? { id: s(b.project_type.id), name: s(b.project_type.name).slice(0, 120) } : null;
    store(mfg, d);
    res.json({ ok: true, job: jobOut(j, true) });
  }));

  app.delete('/api/teach/jobs/:id', withShop(async (req, res, mfg) => {
    const d = load(mfg), j = findJob(d, req.params.id);
    if (!j) return res.json({ ok: true });
    try { fs.rmSync(fileDir(mfg, j.id), { recursive: true, force: true }); } catch (e) {}
    d.jobs = d.jobs.filter((x) => x.id !== j.id); store(mfg, d);
    res.json({ ok: true });
  }));

  app.post('/api/teach/jobs/:id/file', withShop(async (req, res, mfg) => {
    const b = req.body || {};
    let d = load(mfg), j = findJob(d, req.params.id);
    if (!j) return bad(res, 'That job is not here any more. Reload the page.', 404);
    const name = s(b.name).replace(/[\\/]/g, '_').slice(0, 180) || 'document';
    const buf = Buffer.from(String(b.b64 || ''), 'base64');
    if (!buf.length) return bad(res, name + ' is empty.');
    if (buf.length > MAX_FILE) return bad(res, name + ' is over 30 MB. Split it, or add just the pages that matter.');
    if ((j.files || []).some((f) => f.name === name && f.size === buf.length)) return bad(res, name + ' is already on this job.');
    const dir = fileDir(mfg, j.id);
    fs.mkdirSync(dir, { recursive: true });
    const id = newId();
    const stored = id + (path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.bin');
    fs.writeFileSync(path.join(dir, stored), buf);
    const f = { id, name, stored, media_type: s(b.media_type).slice(0, 100), size: buf.length, kind: 'other', status: 'reading', added: new Date().toISOString() };
    j.files = (j.files || []).concat([f]); store(mfg, d);
    await readFile(mfg, j, f);
    // Re-load before writing: another file of the same job may have finished meanwhile.
    d = load(mfg); const j2 = findJob(d, req.params.id);
    if (j2) {
      const i = (j2.files || []).findIndex((x) => x.id === f.id);
      if (i >= 0) j2.files[i] = f; else j2.files.push(f);
      const sg = suggestions(j2);
      if (!j2.name && sg.name) j2.name = sg.name.slice(0, 120);
      if (!j2.number && sg.number) j2.number = sg.number.slice(0, 40);
      if (!j2.labor_cat && sg.labor_cat) j2.labor_cat = sg.labor_cat;
      store(mfg, d);
    }
    res.json({ ok: true, file: { id: f.id, name: f.name, status: f.status, error: f.error || '' }, job: jobOut(j2 || j, true) });
  }));

  app.post('/api/teach/jobs/:id/file/:fid/kind', withShop(async (req, res, mfg) => {
    const d = load(mfg), j = findJob(d, req.params.id);
    const f = j && (j.files || []).find((x) => x.id === req.params.fid);
    if (!f) return bad(res, 'That file is not here any more. Reload the page.', 404);
    const kind = s((req.body || {}).kind);
    if (!T.KIND_KEYS.includes(kind)) return bad(res, 'Pick what the document is.');
    f.kind = kind; f.kind_set_by_user = true;
    await readFile(mfg, j, f);
    store(mfg, d);
    res.json({ ok: true, job: jobOut(j, true) });
  }));

  // Read a saved file again (it failed because the reading service was down, or the take-off improved).
  app.post('/api/teach/jobs/:id/file/:fid/read', withShop(async (req, res, mfg) => {
    const d = load(mfg), j = findJob(d, req.params.id);
    const f = j && (j.files || []).find((x) => x.id === req.params.fid);
    if (!f) return bad(res, 'That file is not here any more. Reload the page.', 404);
    await readFile(mfg, j, f);
    store(mfg, d);
    res.json({ ok: true, job: jobOut(j, true) });
  }));

  app.delete('/api/teach/jobs/:id/file/:fid', withShop(async (req, res, mfg) => {
    const d = load(mfg), j = findJob(d, req.params.id);
    const f = j && (j.files || []).find((x) => x.id === req.params.fid);
    if (!f) return res.json({ ok: true });
    try { fs.unlinkSync(path.join(fileDir(mfg, j.id), f.stored)); } catch (e) {}
    j.files = j.files.filter((x) => x.id !== f.id); store(mfg, d);
    res.json({ ok: true, job: jobOut(j, true) });
  }));

  // Save the confirmed proposals. body: { proposals: [{ type, title, fields, source }] } (only the ticked ones)
  app.post('/api/teach/jobs/:id/confirm', withShop(async (req, res, mfg) => {
    const d = load(mfg), j = findJob(d, req.params.id);
    if (!j) return bad(res, 'That job is not here any more. Reload the page.', 404);
    if (!j.project_type || !s(j.project_type.name)) return bad(res, 'Pick or add this job\'s project type first.');
    const picked = Array.isArray((req.body || {}).proposals) ? req.body.proposals.slice(0, 300) : [];
    const result = { reference_job: false, lessons: 0, skipped: 0, problems: [] };

    // 1) reference job -> the shop's labor setup (replaces this job's earlier one)
    const rjp = picked.find((p) => p.type === 'reference_job');
    if (rjp) {
      const row = T.referenceJob(j, rjp);
      if (!row) result.problems.push('Reference job not saved: it needs both tons and hours.');
      else {
        const prof = shop.load(mfg);
        prof.reference_jobs = (prof.reference_jobs || []).filter((x) => x.id !== 'tj' + j.id).concat([Object.assign(row, { id: 'tj' + j.id })]);
        shop.save(mfg, prof);
        result.reference_job = true;
      }
    }

    // 2) lessons -> Takeoff_Correction (Source = history); a lesson already saved for this job is not added twice
    const done = new Set(j.confirmed || []);
    const now = new Date().toISOString();
    const rows = [];
    for (const p of picked) {
      if (!['scope', 'outside_cost', 'material_price'].includes(p.type)) continue;
      const text = T.lessonText(p);
      if (!text) continue;
      if (done.has(text.toLowerCase())) { result.skipped++; continue; }
      rows.push({ text, data: { Manufacture_ID: mfg, Context: text, AI_Value: s('From past job ' + (j.name || '') + (j.number ? ' #' + j.number : '') + ': ' + s(p.source)).slice(0, 250),
        Human_Value: 'confirmed', Project_Type: s(j.project_type.name).slice(0, 250), Source: 'history', Created: now } });
    }
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const r = await axios.post(creatorApiBase() + '/form/Takeoff_Correction', { data: chunk.map((x) => x.data) },
        { headers: zohoHeaders(await getAccessToken()), validateStatus: () => true });
      const list = Array.isArray(r.data && r.data.result) ? r.data.result : (chunk.length === 1 ? [r.data] : []);
      chunk.forEach((x, n) => {
        const ok = list[n] && list[n].code === 3000;
        if (ok) { result.lessons++; done.add(x.text.toLowerCase()); }
        else result.problems.push('Not saved: ' + x.text.slice(0, 80));
      });
    }
    j.confirmed = Array.from(done);
    if (result.reference_job || result.lessons || result.skipped || (!result.problems.length)) j.reviewed = now;
    store(mfg, d);
    res.json({ ok: true, result, reviewed: reviewed(d) });
  }));
}

// How many past jobs a shop has reviewed (setup checklist).
function reviewedCount(mfg) {
  try { return ((readJson('teach-' + mfg + '.json', { jobs: [] }) || { jobs: [] }).jobs || []).filter((j) => j.reviewed).length; }
  catch (e) { return 0; }
}

module.exports = { registerTeach, reviewedCount };
