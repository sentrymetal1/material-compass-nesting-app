import React, { useEffect, useState, useCallback } from 'react';
import './supplier.css';
import { useConfirm } from './ConfirmDialog';

// Manufacturer: send a project's material out to suppliers for quotes. Replaces the Zoho
// Quote Form's screens; the send creates the same Quote_Form record, so Zoho numbers it,
// matches each line to supplier stock, creates the supplier RFQ lines and sends the emails.
// Opened with /mfg-rfq?manufacturer_id=<Customer_Entry ID>&t=<token>[&project_id=…]
const BUILD_TAG = 'mfg-rfq-2026-10-31a';
const BASE = '/api/mfg/rfq/';

function params() {
  const p = new URLSearchParams(window.location.search);
  return { mfg: p.get('manufacturer_id') || p.get('Manufacture_ID') || '', token: p.get('t') || '', projectId: p.get('project_id') || '' };
}
function num(n, dp) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp == null ? 0 : dp }); }
// Three business days out, as a sensible default for "responses due".
function defaultDue() {
  const d = new Date(); let added = 0;
  while (added < 3) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) added++; }
  return d.toISOString().slice(0, 10);
}

export default function MfgRfqApp() {
  const [{ mfg, token, projectId: p0 }] = useState(params);
  const auth = 'manufacturer_id=' + encodeURIComponent(mfg) + (token ? '&t=' + encodeURIComponent(token) : '');
  const [projects, setProjects] = useState({ status: 'loading', list: [], error: '' });
  const [projectId, setProjectId] = useState(p0);
  const [proj, setProj] = useState({ status: 'idle' });
  const [picked, setPicked] = useState([]);
  const [form, setForm] = useState({ contact_id: '', description: '', due_date: defaultDue(), requirements: [] });
  const [send, setSend] = useState(null);
  const [dialog, confirm] = useConfirm();
  const setF = patch => setForm(f => ({ ...f, ...patch }));

  const loadProjects = useCallback(async () => {
    try {
      const j = await fetch(BASE + 'projects?' + auth).then(r => r.json());
      if (!j.ok) throw new Error(j.error || 'Could not load your projects');
      setProjects({ status: 'ready', list: j.projects || [], error: '' });
    } catch (e) { setProjects({ status: 'error', list: [], error: String(e.message || e) }); }
  }, [auth]);
  useEffect(() => { if (mfg) loadProjects(); }, [mfg, loadProjects]);

  useEffect(() => {
    if (!projectId) { setProj({ status: 'idle' }); return undefined; }
    let live = true;
    setProj({ status: 'loading' }); setPicked([]); setSend(null);
    fetch(BASE + 'project?' + auth + '&project_id=' + encodeURIComponent(projectId)).then(r => r.json()).then(j => {
      if (!live) return;
      if (!j.ok) { setProj({ status: 'error', error: j.error || 'Could not load the project' }); return; }
      setProj({ status: 'ready', ...j });
      setForm(f => ({ ...f, contact_id: j.project.rep_id || (j.contacts[0] && j.contacts[0].id) || '', description: j.project.description || '' }));
    }).catch(e => { if (live) setProj({ status: 'error', error: String(e.message || e) }); });
    return () => { live = false; };
  }, [projectId, auth]);

  const quotable = proj.status === 'ready' ? proj.lines.filter(l => !l.on_hand && !l.already_quoted) : [];
  const blocked = proj.status === 'ready' && (proj.existing_quote || (proj.missing_columns && proj.missing_columns.length));
  const nothing = proj.status === 'ready' && !quotable.length && !proj.fittings.length;
  const canSend = proj.status === 'ready' && !blocked && !nothing && picked.length > 0 && form.due_date && !(send && (send.status === 'sending' || send.status === 'done'));
  const togglePick = id => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  const toggleReq = r => setF({ requirements: form.requirements.includes(r) ? form.requirements.filter(x => x !== r) : [...form.requirements, r] });

  const onSend = async () => {
    const names = proj.suppliers.filter(s => picked.includes(s.match_id)).map(s => s.name);
    const ok = await confirm({
      title: 'Send to ' + names.length + ' supplier' + (names.length === 1 ? '' : 's') + '?',
      message: names.join(', ') + ' will be emailed now with the lines they stock: '
        + quotable.length + ' material line' + (quotable.length === 1 ? '' : 's')
        + (proj.fittings.length ? ' and ' + proj.fittings.length + ' fitting' + (proj.fittings.length === 1 ? '' : 's') : '') + '.',
      confirmLabel: 'Send',
    });
    if (!ok) return;
    setSend({ status: 'sending' });
    try {
      const r = await fetch(BASE + 'send?' + auth, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, supplier_match_ids: picked, ...form }),
      });
      const j = await r.json();
      if (!j.ok) { setSend({ status: 'error', error: j.error || 'Send failed', reasons: j.reasons || [] }); return; }
      setSend({ status: 'done', ...j });
      loadProjects();
    } catch (e) { setSend({ status: 'error', error: String(e.message || e), reasons: [] }); }
  };

  return (
    <div className="sup-app">
      <header className="sup-header">
        <div className="sup-brand">
          <span className="sup-logo">◆</span>
          <span className="sup-title">Material Compass <em>· Send material to suppliers</em></span>
        </div>
      </header>
      <main className="sup-main sup-main-wide">
        {!mfg ? <div className="sup-msg sup-msg-warn">Please open this page from Material Compass.</div>
          : projects.status === 'loading' ? <div className="sup-msg">Loading your projects…</div>
          : projects.status === 'error' ? <div className="sup-msg sup-msg-error">Couldn’t load your projects: {projects.error} <button className="btn-link" onClick={loadProjects}>Retry</button></div>
          : (
            <>
              <section className="sup-section mq-pick">
                <p className="mq-lead">Pick a project. Its purchase material is listed below; choose the suppliers and send. Each supplier only receives the lines they stock.</p>
                <label className="mq-field">Project
                  <select value={projectId} onChange={e => setProjectId(e.target.value)}>
                    <option value="">— choose a project —</option>
                    {projects.list.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.number}{p.description ? ' — ' + p.description : ''}{p.client ? ' (' + p.client + ')' : ''}{p.quote_number ? '  · quoted ' + p.quote_number : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </section>

              {proj.status === 'loading' && <div className="sup-msg">Loading the project…</div>}
              {proj.status === 'error' && <div className="sup-msg sup-msg-error">{proj.error}</div>}

              {proj.status === 'ready' && (
                <>
                  {proj.existing_quote && (
                    <div className="sup-msg sup-msg-warn">This project already has quote <strong>{proj.existing_quote.number}</strong> ({proj.existing_quote.status}). A project gets one quote; to change it, use Revise on that quote.</div>
                  )}
                  {proj.missing_columns && proj.missing_columns.length > 0 && (
                    <div className="sup-msg sup-msg-error">Can’t send yet: the project material report doesn’t show {proj.missing_columns.join(', ')}, so On Hand material can’t be told apart. Add that column to Project_Material_Allocated_Detail_Form_Report.</div>
                  )}

                  <section className="sup-section">
                    <h2>Material <span className="muted">— {quotable.length} line{quotable.length === 1 ? '' : 's'} to quote · {num(quotable.reduce((s, l) => s + l.weight, 0), 0)} lb</span></h2>
                    {proj.lines.length === 0 ? <div className="sup-empty">No purchase material on this project.</div> : (
                      <table className="q-table">
                        <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Weight</th><th></th></tr></thead>
                        <tbody>
                          {proj.lines.map(l => {
                            const skip = l.on_hand || l.already_quoted;
                            return (
                              <tr key={l.id} className={skip ? 'q-line q-noquote' : 'q-line'}>
                                <td className="q-ln-cell"><span className="q-ln">{l.line}</span></td>
                                <td className="q-desc">{l.description}</td>
                                <td className="q-num">{num(l.qty)}</td>
                                <td className="q-num">{num(l.weight, 1)} lb</td>
                                <td>{l.on_hand ? <span className="mq-sup-st mq-st-wait">On Hand — not sent</span>
                                  : l.already_quoted ? <span className="mq-sup-st mq-st-wait">Already quoted</span>
                                  : <span className="mq-sup-st mq-st-done">Quote</span>}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {proj.fittings.length > 0 && (
                      <>
                        <div className="q-section-label">Fittings <span className="muted">— {proj.fittings.length}</span></div>
                        <table className="q-table">
                          <thead><tr><th>#</th><th>Fitting</th><th>Qty</th><th>Weight</th></tr></thead>
                          <tbody>
                            {proj.fittings.map(f => (
                              <tr key={f.id} className="q-line">
                                <td className="q-ln-cell"><span className="q-ln">{f.line}</span></td>
                                <td className="q-desc">{f.description}</td>
                                <td className="q-num">{num(f.qty)}</td>
                                <td className="q-num">{f.weight ? num(f.weight, 1) + ' lb' : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </section>

                  <section className="sup-section mq-pick">
                    <h2>Suppliers</h2>
                    {proj.suppliers.length === 0 ? <div className="sup-empty">You have no matched suppliers yet. Match suppliers in the Match Hub first.</div> : (
                      <div className="mq-suppliers">
                        {proj.suppliers.map(s => (
                          <button key={s.match_id} type="button" disabled={s.declined}
                            className={'mq-sup' + (picked.includes(s.match_id) ? ' mq-sup-on' : '')}
                            title={s.declined ? 'This match is set to not accept quotes' : ''}
                            onClick={() => togglePick(s.match_id)}>
                            <span className="mq-sup-name">{picked.includes(s.match_id) ? '✓ ' : ''}{s.name}</span>
                            {s.declined ? <span className="mq-sup-st mq-st-wait">Not accepting</span>
                              : s.accepts ? <span className="mq-sup-st mq-st-done">On the platform</span>
                              : <span className="mq-sup-st mq-st-wait">By email</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="sup-section mq-pick">
                    <h2>Quote details</h2>
                    <div className="q-grid q-grid-8">
                      <label className="q-sum-field">Contact
                        <select value={form.contact_id} onChange={e => setF({ contact_id: e.target.value })}>
                          {proj.contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </label>
                      <label className="q-sum-field">Responses due<span className="req-star">*</span>
                        <input type="date" value={form.due_date} onChange={e => setF({ due_date: e.target.value })} />
                      </label>
                    </div>
                    <label className="q-notes">Description
                      <input value={form.description} onChange={e => setF({ description: e.target.value })} />
                    </label>
                    <div className="q-ireq-lbl">Requirements <span className="muted">(suppliers confirm they meet these)</span></div>
                    <div className="q-req-pills">
                      {proj.requirements.map(r => (
                        <button key={r} type="button" className={'q-req-pill' + (form.requirements.includes(r) ? ' mq-req-on' : ' mq-req-off')} onClick={() => toggleReq(r)}>{r}</button>
                      ))}
                    </div>
                  </section>

                  <div className="q-actions">
                    <button className="btn-quote" disabled={!canSend} onClick={onSend}>
                      {send && send.status === 'sending' ? 'Sending…' : 'Send to suppliers'}
                    </button>
                    {!blocked && !nothing && picked.length === 0 && <span className="q-missing">Choose at least one supplier.</span>}
                    {nothing && !blocked && <span className="q-missing">Nothing on this project to quote.</span>}
                    {send && send.status === 'done' && (
                      <span className="q-result q-result-ok">Sent{send.quote_number ? ' as ' + send.quote_number : ''} — {send.lines} line{send.lines === 1 ? '' : 's'}{send.fittings ? ', ' + send.fittings + ' fitting' + (send.fittings === 1 ? '' : 's') : ''} to {send.suppliers} supplier{send.suppliers === 1 ? '' : 's'}.</span>
                    )}
                    {send && send.status === 'error' && (
                      <span className="q-result q-result-warn">{send.error}{send.reasons && send.reasons.length ? ' ' + send.reasons.join(' ') : ''}</span>
                    )}
                  </div>
                </>
              )}
            </>
          )}
      </main>
      {dialog}
      <footer className="sup-footer">{BUILD_TAG}</footer>
    </div>
  );
}
