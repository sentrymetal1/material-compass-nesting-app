import React, { useEffect, useState, useCallback } from 'react';
import './supplier.css';
import { useConfirm } from './ConfirmDialog';

// Manufacturer: send a project's material out to suppliers for quotes. Replaces the Zoho
// Quote Form's screens; the send creates the same Quote_Form record, so Zoho numbers it,
// matches each line to supplier stock, creates the supplier RFQ lines and sends the emails.
// Opened with /mfg-rfq?manufacturer_id=<Customer_Entry ID>&t=<token>[&project_id=…]
const BUILD_TAG = 'mfg-rfq-2026-11-07b-add-to-quote';
const BASE = '/api/mfg/rfq/';

const MATERIAL_CHOICES = ['Structural And Pipe', 'Fittings And Pipe', 'Structural Pipe And Fittings'];
const POSITION_CHOICES = ['Inside Sales', 'Outside Sales', 'Production Manager'];
const BLANK_SUP = { company: '', company_email: '', phone: '', address1: '', address2: '', city: '', state: '', zip: '',
  material: '', first_name: '', last_name: '', contact_email: '', position: '', location_id: '', rep_id: '' };

// A supplier the shop works with but hasn't got in its list. Saved through Zoho's
// "Add Outside Supplier" form, which reuses the supplier if it's already in the system.
function AddSupplier({ auth, contacts, locations, defaultRep, onAdded }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK_SUP);
  const [st, setSt] = useState({ status: 'idle', error: '' });
  const set = patch => setF(p => ({ ...p, ...patch }));
  const field = (k, label, props) => (
    <label className="q-sum-field">{label}
      <input type="text" value={f[k]} onChange={e => set({ [k]: e.target.value })} {...props} />
    </label>
  );
  const save = async () => {
    setSt({ status: 'saving', error: '' });
    try {
      const r = await fetch(BASE + 'add-supplier?' + auth, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...f, rep_id: f.rep_id || defaultRep, location_id: f.location_id || (locations[0] && locations[0].id) || '' }),
      });
      const j = await r.json();
      if (!j.ok) { setSt({ status: 'error', error: (j.error || 'Could not add the supplier.') + (j.reasons && j.reasons.length ? ' ' + j.reasons.join(' ') : '') }); return; }
      onAdded(j);
      setF(BLANK_SUP); setOpen(false); setSt({ status: 'idle', error: '' });
    } catch (e) { setSt({ status: 'error', error: String(e.message || e) }); }
  };
  if (!open) return <button type="button" className="btn-link mq-add-sup" onClick={() => setOpen(true)}>+ Add a supplier that isn’t listed</button>;
  return (
    <div className="mq-add-panel">
      <div className="mq-add-head">Add a supplier <span className="muted">— if they’re already in Material Compass they’re reused, not duplicated. They get your quotes by email with every line, and reply by email.</span></div>
      <div className="q-grid q-grid-4">
        {field('company', 'Company name *')}
        {field('phone', 'Company phone *', { inputMode: 'tel', placeholder: '716-555-0100' })}
        {field('company_email', 'Company email', { inputMode: 'email', placeholder: 'blank = use the contact email' })}
        <label className="q-sum-field">Material they supply
          <select value={f.material} onChange={e => set({ material: e.target.value })}>
            <option value="">—</option>{MATERIAL_CHOICES.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        {field('address1', 'Street address *')}
        {field('city', 'City *')}
        {field('state', 'State *', { placeholder: 'NY' })}
        {field('zip', 'ZIP *', { inputMode: 'numeric' })}
        {field('first_name', 'Contact first name *')}
        {field('last_name', 'Contact last name *')}
        {field('contact_email', 'Contact email *', { inputMode: 'email' })}
        <label className="q-sum-field">Contact position
          <select value={f.position} onChange={e => set({ position: e.target.value })}>
            <option value="">—</option>{POSITION_CHOICES.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        {locations.length > 1 && (
          <label className="q-sum-field">Your location
            <select value={f.location_id || locations[0].id} onChange={e => set({ location_id: e.target.value })}>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        <label className="q-sum-field">Your rep for them
          <select value={f.rep_id || defaultRep} onChange={e => set({ rep_id: e.target.value })}>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      <div className="q-actions">
        <button type="button" className="btn-link" onClick={() => { setOpen(false); setSt({ status: 'idle', error: '' }); }}>Cancel</button>
        <button type="button" className="btn-quote" disabled={st.status === 'saving'} onClick={save}>{st.status === 'saving' ? 'Adding…' : 'Add supplier'}</button>
        {st.status === 'error' && <span className="q-result q-result-warn">{st.error}</span>}
      </div>
    </div>
  );
}

function params() {
  const p = new URLSearchParams(window.location.search);
  return { mfg: p.get('manufacturer_id') || p.get('Manufacture_ID') || '', token: p.get('t') || '', projectId: p.get('project_id') || '',
    // ?add_to=<quote id>: add suppliers to that quote instead of sending/revising it.
    addTo: p.get('add_to') || '' };
}
function num(n, dp) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp == null ? 0 : dp }); }
// Three business days out, as a sensible default for "responses due".
function defaultDue() {
  const d = new Date(); let added = 0;
  while (added < 3) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) added++; }
  return d.toISOString().slice(0, 10);
}

export default function MfgRfqApp() {
  const [{ mfg, token, projectId: p0, addTo }] = useState(params);
  const auth = 'manufacturer_id=' + encodeURIComponent(mfg) + (token ? '&t=' + encodeURIComponent(token) : '');
  const [projects, setProjects] = useState({ status: 'loading', list: [], error: '' });
  const [projectId, setProjectId] = useState(p0);
  const [proj, setProj] = useState({ status: 'idle' });
  const [picked, setPicked] = useState([]);
  const [form, setForm] = useState({ contact_id: '', description: '', due_date: defaultDue(), requirements: [] });
  const [send, setSend] = useState(null);
  const [addMsg, setAddMsg] = useState('');
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
    setProj({ status: 'loading' }); setPicked([]); setSend(null); setAddMsg('');
    const add = addTo && projectId === p0 ? '&add_to=' + encodeURIComponent(addTo) : '';
    fetch(BASE + 'project?' + auth + '&project_id=' + encodeURIComponent(projectId) + add).then(r => r.json()).then(j => {
      if (!live) return;
      if (!j.ok) { setProj({ status: 'error', error: j.error || 'Could not load the project' }); return; }
      setProj({ status: 'ready', ...j });
      const eq = j.existing_quote;
      setForm(f => ({ ...f, contact_id: j.project.rep_id || (j.contacts[0] && j.contacts[0].id) || '', description: (eq && eq.description) || j.project.description || '' }));
    }).catch(e => { if (live) setProj({ status: 'error', error: String(e.message || e) }); });
    return () => { live = false; };
  }, [projectId, auth, addTo, p0]);

  // A project with a quote can only be revised. A revision re-sends every purchase line and
  // every fitting, and replaces what the suppliers were sent before.
  // Add mode (opened from "Add Other Suppliers") sends the SAME quote to more suppliers.
  const eq = proj.status === 'ready' ? proj.existing_quote : null;
  const am = proj.status === 'ready' ? proj.add_mode : null;
  const sentTo = new Set((am && am.sent_supplier_ids) || []);
  const revising = !am && !!(eq && eq.can_revise);
  const quotable = proj.status === 'ready' ? proj.lines.filter(l => !l.on_hand && (revising || !l.already_quoted)) : [];
  const blocked = proj.status === 'ready' && (am ? !am.allowed : ((eq && !eq.can_revise) || (proj.missing_columns && proj.missing_columns.length)));
  const nothing = !am && proj.status === 'ready' && !quotable.length && !proj.fittings.length;
  const busy = !!(send && (send.status === 'sending' || send.status === 'done'));
  const canSend = proj.status === 'ready' && !blocked && !nothing && picked.length > 0 && !!form.due_date && !busy;
  const togglePick = id => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  const toggleReq = r => setF({ requirements: form.requirements.includes(r) ? form.requirements.filter(x => x !== r) : [...form.requirements, r] });

  const onAdd = async () => {
    const chosen = proj.suppliers.filter(s => picked.includes(s.match_id));
    const declined = chosen.filter(s => s.declined).map(s => s.name);
    const ok = await confirm({
      title: 'Send ' + eq.number + ' to ' + chosen.length + ' more supplier' + (chosen.length === 1 ? '' : 's') + '?',
      message: chosen.map(s => s.name).join(', ') + ' will be emailed ' + eq.number + ' now, with the lines they stock (email-only suppliers get every line). '
        + 'Suppliers who already have it are not sent anything.'
        + (declined.length ? ' Note: ' + declined.join(', ') + (declined.length === 1 ? ' is' : ' are') + ' set to not accept quotes from you.' : ''),
      confirmLabel: 'Send',
    });
    if (!ok) return;
    setSend({ status: 'sending' });
    try {
      const r = await fetch(BASE + 'add-suppliers?' + auth, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, quote_id: am.quote_id, supplier_match_ids: picked, due_date: form.due_date }),
      });
      const j = await r.json();
      if (!j.ok) { setSend({ status: 'error', error: j.error || 'Send failed', reasons: j.reasons || [] }); return; }
      setSend({ status: 'done', added: j });
    } catch (e) { setSend({ status: 'error', error: String(e.message || e), reasons: [] }); }
  };

  const onSend = async () => {
    if (am) return onAdd();
    const names = proj.suppliers.filter(s => picked.includes(s.match_id)).map(s => s.name);
    const declined = proj.suppliers.filter(s => picked.includes(s.match_id) && s.declined).map(s => s.name);
    const note = declined.length ? ' Note: ' + declined.join(', ') + (declined.length === 1 ? ' is' : ' are') + ' set to not accept quotes from you.' : '';
    const what = quotable.length + ' material line' + (quotable.length === 1 ? '' : 's')
      + (proj.fittings.length ? ' and ' + proj.fittings.length + ' fitting' + (proj.fittings.length === 1 ? '' : 's') : '');
    const ok = await confirm(revising ? {
      title: 'Send Rev # ' + eq.revision + ' of ' + eq.number + '?',
      message: 'Everything sent for ' + eq.number + ' before is voided, including any supplier quotes already received. '
        + names.join(', ') + ' will be emailed now with the lines they stock, out of ' + what + '.' + note,
      confirmLabel: 'Send revision',
    } : {
      title: 'Send to ' + names.length + ' supplier' + (names.length === 1 ? '' : 's') + '?',
      message: names.join(', ') + ' will be emailed now with the lines they stock: ' + what + '.' + note,
      confirmLabel: 'Send',
    });
    if (!ok) return;
    setSend({ status: 'sending' });
    try {
      const r = await fetch(BASE + 'send?' + auth, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, supplier_match_ids: picked, ...form, ...(revising ? { revise_quote_id: eq.id } : {}) }),
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
                  {am && am.allowed && (
                    <div className="sup-msg">Adding suppliers to quote <strong>{eq.number}</strong>. Pick who else should get it. Suppliers marked <strong>Already sent</strong> have it; nothing they were sent changes.</div>
                  )}
                  {am && !am.allowed && (
                    <div className="sup-msg sup-msg-warn">Quote <strong>{eq.number}</strong> is {eq.status}, so suppliers can’t be added any more.</div>
                  )}
                  {proj.add_to_stale && (
                    <div className="sup-msg sup-msg-warn">That quote has been revised since. Showing the project’s current quote; use Revise or reopen Add Other Suppliers from the newest quote.</div>
                  )}
                  {!am && eq && revising && (
                    <div className="sup-msg sup-msg-warn">This project already has quote <strong>{eq.number}</strong> ({eq.status}). Sending now makes <strong>Rev # {eq.revision}</strong>: every purchase line and fitting below goes out again, and what suppliers were sent before is voided.</div>
                  )}
                  {!am && eq && !revising && (
                    <div className="sup-msg sup-msg-warn">Quote <strong>{eq.number}</strong> is {eq.status}, so it can’t be revised.</div>
                  )}
                  {proj.missing_columns && proj.missing_columns.length > 0 && (
                    <div className="sup-msg sup-msg-error">Can’t send yet: the project material report doesn’t show {proj.missing_columns.join(', ')}, so On Hand material can’t be told apart. Add that column to Project_Material_Allocated_Detail_Form_Report.</div>
                  )}

                  {!am && <section className="sup-section">
                    <h2>Material <span className="muted">— {quotable.length} line{quotable.length === 1 ? '' : 's'} to quote · {num(quotable.reduce((s, l) => s + l.weight, 0), 0)} lb</span></h2>
                    {proj.lines.length === 0 ? <div className="sup-empty">No purchase material on this project.</div> : (
                      <table className="q-table">
                        <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Weight</th><th></th></tr></thead>
                        <tbody>
                          {proj.lines.map(l => {
                            const skip = l.on_hand || (!revising && l.already_quoted);
                            return (
                              <tr key={l.id} className={skip ? 'q-line q-noquote' : 'q-line'}>
                                <td className="q-ln-cell"><span className="q-ln">{l.line}</span></td>
                                <td className="q-desc">{l.description}</td>
                                <td className="q-num">{num(l.qty)}</td>
                                <td className="q-num">{num(l.weight, 1)} lb</td>
                                <td>{l.on_hand ? <span className="mq-sup-st mq-st-wait">On Hand — not sent</span>
                                  : skip ? <span className="mq-sup-st mq-st-wait">Already quoted</span>
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
                  </section>}

                  <section className="sup-section mq-pick">
                    <h2>Suppliers</h2>
                    {addMsg && <div className="sup-msg">{addMsg}</div>}
                    {proj.suppliers.length === 0 ? <div className="sup-empty">You have no matched suppliers yet. Add one below, or match suppliers in the Match Hub.</div> : (
                      <div className="mq-suppliers">
                        {proj.suppliers.map(s => {
                          const already = sentTo.has(s.supplier_id);
                          return (
                            <button key={s.match_id} type="button" disabled={already}
                              className={'mq-sup' + (picked.includes(s.match_id) ? ' mq-sup-on' : '') + (already ? ' mq-sup-sent' : '')}
                              title={already ? 'Already has this quote' : s.declined ? 'Set to not accept quotes from you; you can still send to them' : ''}
                              onClick={() => togglePick(s.match_id)}>
                              <span className="mq-sup-name">{picked.includes(s.match_id) ? '✓ ' : ''}{s.name}</span>
                              {already ? <span className="mq-sup-st mq-st-done">Already sent</span>
                                : s.declined ? <span className="mq-sup-st mq-st-no">Not accepting</span>
                                : s.email_only ? <span className="mq-sup-st mq-st-wait">Email only</span>
                                : s.accepts ? <span className="mq-sup-st mq-st-done">On the platform</span>
                                : <span className="mq-sup-st mq-st-wait">By email</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <AddSupplier auth={auth} contacts={proj.contacts || []} locations={proj.locations || []} defaultRep={form.contact_id}
                      onAdded={j => {
                        setProj(p => ({ ...p, suppliers: j.suppliers || p.suppliers }));
                        setPicked(p => [...new Set([...p, ...(j.added_match_ids || [])])]);
                        setAddMsg(j.message || '');
                      }} />
                  </section>

                  {!am && <section className="sup-section mq-pick">
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
                  </section>}

                  {am && am.allowed && (
                    <label className="q-sum-field mq-add-due">Responses due from these suppliers<span className="req-star">*</span>
                      <input type="date" value={form.due_date} onChange={e => setF({ due_date: e.target.value })} />
                    </label>
                  )}
                  <div className="q-actions">
                    <button className="btn-quote" disabled={!canSend} onClick={onSend}>
                      {send && send.status === 'sending' ? 'Sending…'
                        : am ? 'Send ' + eq.number + ' to ' + (picked.length || '') + ' more supplier' + (picked.length === 1 ? '' : 's')
                        : revising ? 'Send Rev # ' + eq.revision + ' to suppliers' : 'Send to suppliers'}
                    </button>
                    {send && send.status === 'done' && send.added && (
                      <span className="q-result q-result-ok">Sent {send.added.quote_number} to {send.added.names.join(', ')}.</span>
                    )}
                    {!blocked && !nothing && picked.length === 0 && <span className="q-missing">Choose at least one supplier.</span>}
                    {am && !blocked && picked.length > 0 && !form.due_date && <span className="q-missing">Choose the date their responses are due.</span>}
                    {nothing && !blocked && <span className="q-missing">Nothing on this project to quote.</span>}
                    {send && send.status === 'done' && !send.added && (
                      <span className="q-result q-result-ok">Sent{send.revision ? ' Rev # ' + send.revision : ''}{send.quote_number ? ' as ' + send.quote_number : ''} —{send.lines} line{send.lines === 1 ? '' : 's'}{send.fittings ? ', ' + send.fittings + ' fitting' + (send.fittings === 1 ? '' : 's') : ''} to {send.suppliers} supplier{send.suppliers === 1 ? '' : 's'}.</span>
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
