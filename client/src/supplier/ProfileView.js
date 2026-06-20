import React, { useEffect, useState, useCallback } from 'react';

// Supplier Profile tab — editable company details, plus full CRUD for locations
// and representatives (reps nested under their location).
function fmtAddr(a) {
  if (!a || typeof a !== 'object') return '';
  const parts = [a.address_line_1 || a.address_line1, a.district_city, a.state_province, a.postal_code, a.country];
  return parts.filter(Boolean).join(', ');
}
function contactStr(r) {
  return [r.email, (r.phone || '') + (r.ext ? ' x' + r.ext : '')].filter(s => s && s.trim()).join('  ·  ');
}

const EDITABLE = ['company_name', 'contact_first', 'contact_last', 'email', 'phone', 'fax', 'website'];

export default function ProfileView({ email }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [form, setForm] = useState(null);
  const [save, setSave] = useState(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null); // {kind:'loc'|'rep', id}
  const [add, setAdd] = useState(null);   // {kind:'loc'} | {kind:'rep', location_id}

  const load = useCallback(async () => {
    setState(s => ({ ...s, status: s.data ? 'ready' : 'loading' }));
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
  const onSaveCompany = async () => {
    setSave({ status: 'saving' });
    try {
      const r = await fetch('/api/supplier/me/profile?email=' + encodeURIComponent(email), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setSave({ status: 'error', error: j.message || j.error || ('HTTP ' + r.status) }); return; }
      setSave({ status: 'done' });
      setState(s => ({ ...s, data: { ...s.data, profile: { ...s.data.profile, ...form } } }));
    } catch (e) { setSave({ status: 'error', error: String(e.message || e) }); }
  };

  // CRUD helper for locations/reps — mutate then refresh.
  const mut = async (method, pathSuffix, body) => {
    setBusy(true);
    try {
      const r = await fetch('/api/supplier/me' + pathSuffix + '?email=' + encodeURIComponent(email), {
        method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { window.alert('Error: ' + (j.message || j.error || ('HTTP ' + r.status))); return; }
      setEdit(null); setAdd(null);
      await load();
    } catch (e) { window.alert('Error: ' + (e.message || e)); }
    finally { setBusy(false); }
  };
  const removeIt = (kind, id) => {
    if (window.confirm('Delete this ' + (kind === 'loc' ? 'location' : 'representative') + '?')) {
      mut('DELETE', '/' + (kind === 'loc' ? 'locations' : 'reps') + '/' + id);
    }
  };

  if (state.status === 'loading') return <div className="sup-msg">Loading your profile…</div>;
  if (state.status === 'error') return <div className="sup-msg sup-msg-error">Couldn’t load profile: {state.error} <button className="btn-link" onClick={load}>Retry</button></div>;

  const p = state.data.profile;
  const locations = state.data.locations || [];
  const reps = state.data.reps || [];
  const matched = new Set(locations.map(l => l.id));
  const orphans = reps.filter(r => !r.location_id || !matched.has(r.location_id));

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
            <button className="btn-quote" disabled={save && save.status === 'saving'} onClick={onSaveCompany}>
              {save && save.status === 'saving' ? 'Saving…' : 'Save changes'}
            </button>
            {save && save.status === 'done' && <span className="q-result q-result-ok">Saved.</span>}
            {save && save.status === 'error' && <span className="q-result q-result-warn">Error: {save.error}</span>}
          </div>
        </div>
      </section>

      <section className="sup-section">
        <div className="prof-sec-head">
          <h2>Locations &amp; representatives <span className="muted">— {locations.length} location{locations.length === 1 ? '' : 's'}, {reps.length} rep{reps.length === 1 ? '' : 's'}</span></h2>
          <button className="btn-link" onClick={() => { setAdd({ kind: 'loc' }); setEdit(null); }}>+ Add location</button>
        </div>

        {add && add.kind === 'loc' && (
          <LocForm busy={busy} onCancel={() => setAdd(null)} onSave={f => mut('POST', '/locations', f)} />
        )}

        <div className="prof-locgroups">
          {locations.map(l => {
            const here = reps.filter(r => r.location_id === l.id);
            const editingLoc = edit && edit.kind === 'loc' && edit.id === l.id;
            return (
              <div key={l.id} className="prof-locgroup">
                <div className="prof-loc-head">
                  <div className="prof-row-main"><strong>{l.name || '—'}</strong><span className="muted">{fmtAddr(l.address)}</span></div>
                  <div className="prof-actions">
                    {l.phone && <span className="muted">{l.phone}</span>}
                    <button className="btn-link" onClick={() => { setEdit({ kind: 'loc', id: l.id }); setAdd(null); }}>Edit</button>
                    <button className="btn-link btn-danger" onClick={() => removeIt('loc', l.id)}>Delete</button>
                  </div>
                </div>
                {editingLoc && <LocForm initial={l} busy={busy} onCancel={() => setEdit(null)} onSave={f => mut('PATCH', '/locations/' + l.id, f)} />}

                {here.map(r => (edit && edit.kind === 'rep' && edit.id === r.id)
                  ? <div key={r.id} className="prof-rep"><RepForm initial={r} locations={locations} busy={busy} onCancel={() => setEdit(null)} onSave={f => mut('PATCH', '/reps/' + r.id, f)} /></div>
                  : (
                    <div key={r.id} className="prof-rep">
                      <div className="prof-row-main"><strong>{r.name || '—'}</strong>{r.position && <span className="chip">{r.position}</span>}</div>
                      <div className="prof-actions">
                        {contactStr(r) && <span className="muted">{contactStr(r)}</span>}
                        <button className="btn-link" onClick={() => { setEdit({ kind: 'rep', id: r.id }); setAdd(null); }}>Edit</button>
                        <button className="btn-link btn-danger" onClick={() => removeIt('rep', r.id)}>Delete</button>
                      </div>
                    </div>
                  ))}

                {add && add.kind === 'rep' && add.location_id === l.id
                  ? <div className="prof-rep"><RepForm locations={locations} defaultLoc={l.id} busy={busy} onCancel={() => setAdd(null)} onSave={f => mut('POST', '/reps', f)} /></div>
                  : <button className="btn-link prof-addrep" onClick={() => { setAdd({ kind: 'rep', location_id: l.id }); setEdit(null); }}>+ Add rep here</button>}
              </div>
            );
          })}

          {orphans.length > 0 && (
            <div className="prof-locgroup">
              <div className="prof-loc-head"><div className="prof-row-main"><strong>Unassigned</strong><span className="muted">no location set</span></div></div>
              {orphans.map(r => (edit && edit.kind === 'rep' && edit.id === r.id)
                ? <div key={r.id} className="prof-rep"><RepForm initial={r} locations={locations} busy={busy} onCancel={() => setEdit(null)} onSave={f => mut('PATCH', '/reps/' + r.id, f)} /></div>
                : (
                  <div key={r.id} className="prof-rep">
                    <div className="prof-row-main"><strong>{r.name || '—'}</strong>{r.position && <span className="chip">{r.position}</span>}</div>
                    <div className="prof-actions">
                      {contactStr(r) && <span className="muted">{contactStr(r)}</span>}
                      <button className="btn-link" onClick={() => { setEdit({ kind: 'rep', id: r.id }); setAdd(null); }}>Edit</button>
                      <button className="btn-link btn-danger" onClick={() => removeIt('rep', r.id)}>Delete</button>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function LocForm({ initial, onSave, onCancel, busy }) {
  const a = (initial && initial.address) || {};
  const [f, setF] = useState({
    name: (initial && initial.name) || '', phone: (initial && initial.phone) || '',
    street: a.address_line_1 || a.address_line1 || '', city: a.district_city || '',
    state: a.state_province || '', zip: a.postal_code || '', country: a.country || 'United States',
  });
  const s = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <div className="prof-form">
      <div className="q-grid">
        <label>Location name<input value={f.name} onChange={e => s('name', e.target.value)} /></label>
        <label>Phone<input value={f.phone} onChange={e => s('phone', e.target.value)} /></label>
        <label className="q-grid-wide">Street<input value={f.street} onChange={e => s('street', e.target.value)} /></label>
        <label>City<input value={f.city} onChange={e => s('city', e.target.value)} /></label>
        <label>State<input value={f.state} onChange={e => s('state', e.target.value)} /></label>
        <label>ZIP<input value={f.zip} onChange={e => s('zip', e.target.value)} /></label>
        <label>Country<input value={f.country} onChange={e => s('country', e.target.value)} /></label>
      </div>
      <div className="q-actions">
        <button className="btn-quote" disabled={busy} onClick={() => onSave(f)}>Save</button>
        <button className="btn-link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function RepForm({ initial, locations, defaultLoc, onSave, onCancel, busy }) {
  const [f, setF] = useState({
    first: (initial && initial.first) || '', last: (initial && initial.last) || '',
    position: (initial && initial.position) || '', email: (initial && initial.email) || '',
    phone: (initial && initial.phone) || '', ext: (initial && initial.ext) || '',
    location_id: (initial && initial.location_id) || defaultLoc || '',
  });
  const s = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <div className="prof-form">
      <div className="q-grid">
        <label>First name<input value={f.first} onChange={e => s('first', e.target.value)} /></label>
        <label>Last name<input value={f.last} onChange={e => s('last', e.target.value)} /></label>
        <label>Position<input value={f.position} onChange={e => s('position', e.target.value)} /></label>
        <label>Email<input type="email" value={f.email} onChange={e => s('email', e.target.value)} /></label>
        <label>Phone<input value={f.phone} onChange={e => s('phone', e.target.value)} /></label>
        <label>Ext<input value={f.ext} onChange={e => s('ext', e.target.value)} /></label>
        <label>Location
          <select value={f.location_id} onChange={e => s('location_id', e.target.value)}>
            <option value="">— none —</option>
            {(locations || []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      </div>
      <div className="q-actions">
        <button className="btn-quote" disabled={busy} onClick={() => onSave(f)}>Save</button>
        <button className="btn-link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
