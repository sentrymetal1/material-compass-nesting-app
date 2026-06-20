import React, { useEffect, useState, useCallback } from 'react';

// Supplier Profile tab — company details (editable), locations, representatives.
// v1: edit the core company scalars; locations/reps are read-only lists (CRUD next).
function fmtAddr(a) {
  if (!a || typeof a !== 'object') return '';
  const parts = [a.address_line_1 || a.address_line1, a.district_city, a.state_province, a.postal_code, a.country];
  return parts.filter(Boolean).join(', ');
}

const EDITABLE = ['company_name', 'contact_first', 'contact_last', 'email', 'phone', 'fax', 'website'];

export default function ProfileView({ email }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [form, setForm] = useState(null);
  const [save, setSave] = useState(null); // {status:'saving'|'done'|'error', error}

  const load = useCallback(async () => {
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const r = await fetch('/api/supplier/me/profile?email=' + encodeURIComponent(email));
      const j = await r.json();
      if (!r.ok || !j.ok) { setState({ status: 'error', data: null, error: j.error || ('HTTP ' + r.status) }); return; }
      setState({ status: 'ready', data: j, error: null });
      setForm(EDITABLE.reduce((o, k) => { o[k] = j.profile[k] || ''; return o; }, {}));
    } catch (e) { setState({ status: 'error', data: null, error: String(e.message || e) }); }
  }, [email]);
  useEffect(() => { load(); }, [load]);

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const onSave = async () => {
    setSave({ status: 'saving' });
    try {
      const r = await fetch('/api/supplier/me/profile?email=' + encodeURIComponent(email), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setSave({ status: 'error', error: j.message || j.error || ('HTTP ' + r.status) }); return; }
      setSave({ status: 'done' });
      // reflect locally so the change shows without waiting on the cached directory
      setState(s => ({ ...s, data: { ...s.data, profile: { ...s.data.profile, ...form } } }));
    } catch (e) { setSave({ status: 'error', error: String(e.message || e) }); }
  };

  if (state.status === 'loading') return <div className="sup-msg">Loading your profile…</div>;
  if (state.status === 'error') return <div className="sup-msg sup-msg-error">Couldn’t load profile: {state.error} <button className="btn-link" onClick={load}>Retry</button></div>;

  const p = state.data.profile;
  const locations = state.data.locations || [];
  const reps = state.data.reps || [];

  return (
    <div className="prof">
      <section className="sup-section">
        <h2>Company profile</h2>
        <div className="prof-card">
          <div className="q-grid">
            <label>Company name<input value={form.company_name} onChange={e => setF('company_name', e.target.value)} /></label>
            <label>Contact first name<input value={form.contact_first} onChange={e => setF('contact_first', e.target.value)} /></label>
            <label>Contact last name<input value={form.contact_last} onChange={e => setF('contact_last', e.target.value)} /></label>
            <label>Email<input type="email" value={form.email} onChange={e => setF('email', e.target.value)} /></label>
            <label>Phone<input value={form.phone} onChange={e => setF('phone', e.target.value)} /></label>
            <label>Fax<input value={form.fax} onChange={e => setF('fax', e.target.value)} /></label>
            <label className="q-grid-wide">Website<input value={form.website} onChange={e => setF('website', e.target.value)} placeholder="https://" /></label>
          </div>

          <div className="prof-readonly">
            <div><span className="prof-lbl">Account type</span> {p.account_type || '—'}</div>
            <div><span className="prof-lbl">Material serviced</span> {p.material_serviced || '—'}</div>
            <div><span className="prof-lbl">Address</span> {fmtAddr(p.address) || '—'}</div>
            <div><span className="prof-lbl">Certifications</span> {p.certifications.length ? p.certifications.map((c, i) => <span key={i} className="chip">{c}</span>) : '—'}</div>
            <div><span className="prof-lbl">Login email(s)</span> <span className="prof-mono">{p.login_emails || '—'}</span></div>
          </div>

          <div className="q-actions">
            <button className="btn-quote" disabled={save && save.status === 'saving'} onClick={onSave}>
              {save && save.status === 'saving' ? 'Saving…' : 'Save changes'}
            </button>
            {save && save.status === 'done' && <span className="q-result q-result-ok">Saved.</span>}
            {save && save.status === 'error' && <span className="q-result q-result-warn">Error: {save.error}</span>}
          </div>
        </div>
      </section>

      <section className="sup-section">
        <h2>Locations &amp; representatives <span className="muted">— {locations.length} location{locations.length === 1 ? '' : 's'}, {reps.length} rep{reps.length === 1 ? '' : 's'}</span></h2>
        {locations.length === 0 && reps.length === 0 ? <div className="sup-empty">No locations or representatives on file.</div> : (
          <div className="prof-locgroups">
            {locations.map(l => {
              const here = reps.filter(r => r.location_id === l.id);
              return (
                <div key={l.id} className="prof-locgroup">
                  <div className="prof-loc-head">
                    <div className="prof-row-main"><strong>{l.name || '—'}</strong><span className="muted">{fmtAddr(l.address)}</span></div>
                    <div className="muted">{l.phone}</div>
                  </div>
                  {here.length === 0 ? <div className="prof-norep">No representatives at this location.</div>
                    : here.map(r => <RepRow key={r.id} r={r} />)}
                </div>
              );
            })}
            {(() => {
              const matched = new Set(locations.map(l => l.id));
              const orphan = reps.filter(r => !r.location_id || !matched.has(r.location_id));
              if (!orphan.length) return null;
              return (
                <div className="prof-locgroup">
                  <div className="prof-loc-head"><div className="prof-row-main"><strong>Unassigned</strong><span className="muted">no location set</span></div></div>
                  {orphan.map(r => <RepRow key={r.id} r={r} />)}
                </div>
              );
            })()}
          </div>
        )}
      </section>
    </div>
  );
}

function RepRow({ r }) {
  const contact = [r.email, (r.phone || '') + (r.ext ? ' x' + r.ext : '')].filter(s => s && s.trim()).join('  ·  ');
  return (
    <div className="prof-rep">
      <div className="prof-row-main">
        <strong>{r.name || '—'}</strong>
        {r.position && <span className="chip">{r.position}</span>}
      </div>
      <div className="muted">{contact}</div>
    </div>
  );
}
