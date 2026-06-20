import React, { useEffect, useState, useCallback, useMemo } from 'react';

// Supplier Stock tab.
//  Structural: searchable, grouped (by Form Type) toggle list -> Stocked_Material_List.
//  Fittings: cascade add-picker (Type->End->Connection, Make->Spec) + stocked list
//    grouped by type with remove -> Supplier_Fitting_Stock. Feeds dashboard matches.
export default function StockView({ email }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [tab, setTab] = useState('structural');
  const [q, setQ] = useState('');
  const [stockedOnly, setStockedOnly] = useState(false);
  const [openGroups, setOpenGroups] = useState({});
  const [saving, setSaving] = useState({});
  // fittings
  const [catalog, setCatalog] = useState(null);
  const [pick, setPick] = useState({ type_id: '', make_id: '', end_id: '', connection_ids: [], spec_ids: [] });
  const [fitMsg, setFitMsg] = useState('');
  const [fitBusy, setFitBusy] = useState(false);

  const load = useCallback(async () => {
    setState(s => ({ ...s, status: s.data ? 'ready' : 'loading' }));
    try {
      const r = await fetch('/api/supplier/me/stock?email=' + encodeURIComponent(email));
      const j = await r.json();
      if (!r.ok || !j.ok) { setState({ status: 'error', data: null, error: j.error || ('HTTP ' + r.status) }); return; }
      setState({ status: 'ready', data: j, error: null });
    } catch (e) { setState({ status: 'error', data: null, error: String(e.message || e) }); }
  }, [email]);
  useEffect(() => { load(); }, [load]);

  // lazy-load the fitting catalog the first time the Fittings tab is opened
  useEffect(() => {
    if (tab !== 'fittings' || catalog) return;
    (async () => {
      try {
        const r = await fetch('/api/supplier/me/fitting-catalog?email=' + encodeURIComponent(email));
        const j = await r.json();
        if (j.ok) setCatalog(j.catalog);
      } catch (e) { /* picker just stays empty */ }
    })();
  }, [tab, catalog, email]);

  const structural = (state.data && state.data.structural) || [];
  const fittings = (state.data && state.data.fittings) || [];

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const g = {};
    for (const it of structural) {
      if (stockedOnly && !it.stocked) continue;
      if (needle && !(it.form_type + ' ' + it.material_type + ' ' + it.spec).toLowerCase().includes(needle)) continue;
      (g[it.form_type || '—'] = g[it.form_type || '—'] || []).push(it);
    }
    return g;
  }, [structural, q, stockedOnly]);
  const groupNames = Object.keys(groups).sort();
  const stockedCount = structural.filter(s => s.stocked).length;

  const toggle = async (it) => {
    const next = !it.stocked;
    setSaving(s => ({ ...s, [it.id]: true }));
    setState(s => ({ ...s, data: { ...s.data, structural: s.data.structural.map(x => x.id === it.id ? { ...x, stocked: next } : x) } }));
    try {
      const r = await fetch('/api/supplier/me/stock/structural/' + it.id + '?email=' + encodeURIComponent(email), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stocked: next }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
    } catch (e) {
      setState(s => ({ ...s, data: { ...s.data, structural: s.data.structural.map(x => x.id === it.id ? { ...x, stocked: it.stocked } : x) } }));
      window.alert('Could not save: ' + (e.message || e));
    } finally { setSaving(s => { const n = { ...s }; delete n[it.id]; return n; }); }
  };

  // fittings cascade options
  const ends = useMemo(() => catalog ? catalog.ends.filter(e => e.type_id === pick.type_id) : [], [catalog, pick.type_id]);
  const conns = useMemo(() => catalog ? catalog.connections.filter(c => c.type_id === pick.type_id) : [], [catalog, pick.type_id]);
  const specs = useMemo(() => catalog ? catalog.specs.filter(s => s.make_id === pick.make_id) : [], [catalog, pick.make_id]);
  const setP = patch => setPick(p => ({ ...p, ...patch }));
  const toggleIn = (key, id) => setPick(p => ({ ...p, [key]: p[key].includes(id) ? p[key].filter(x => x !== id) : [...p[key], id] }));
  const comboCount = pick.connection_ids.length * pick.spec_ids.length;
  const canAdd = pick.type_id && pick.make_id && pick.end_id && comboCount > 0;

  const addFitting = async () => {
    setFitBusy(true); setFitMsg('');
    try {
      const r = await fetch('/api/supplier/me/stock/fittings/bulk?email=' + encodeURIComponent(email), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type_id: pick.type_id, make_id: pick.make_id, end_id: pick.end_id, connection_ids: pick.connection_ids, spec_ids: pick.spec_ids }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
      setFitMsg('Added ' + j.added + (j.duplicates ? ' (' + j.duplicates + ' already stocked)' : '') + '.');
      setPick(p => ({ ...p, connection_ids: [], spec_ids: [] }));
      await load();
    } catch (e) { window.alert('Could not add: ' + (e.message || e)); }
    finally { setFitBusy(false); }
  };
  const removeFitting = async (id) => {
    setFitBusy(true);
    try {
      const r = await fetch('/api/supplier/me/stock/fittings/' + id + '?email=' + encodeURIComponent(email), { method: 'DELETE' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
      await load();
    } catch (e) { window.alert('Could not remove: ' + (e.message || e)); }
    finally { setFitBusy(false); }
  };

  const fitStocked = fittings.filter(f => f.stocked);
  const fitGroups = useMemo(() => {
    const g = {};
    for (const f of fitStocked) (g[f.type || '—'] = g[f.type || '—'] || []).push(f);
    return g;
  }, [fitStocked]);

  if (state.status === 'loading') return <div className="sup-msg">Loading your stock…</div>;
  if (state.status === 'error') return <div className="sup-msg sup-msg-error">Couldn’t load stock: {state.error} <button className="btn-link" onClick={load}>Retry</button></div>;

  return (
    <div className="stock">
      <div className="stock-tabs">
        <button className={tab === 'structural' ? 'active' : ''} onClick={() => setTab('structural')}>Structural <span className="muted">({stockedCount} stocked)</span></button>
        <button className={tab === 'fittings' ? 'active' : ''} onClick={() => setTab('fittings')}>Fittings <span className="muted">({fitStocked.length} stocked)</span></button>
      </div>

      {tab === 'structural' ? (
        <section className="sup-section">
          <div className="stock-controls">
            <input className="stock-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search form, material, spec…" />
            <label className="stock-only"><input type="checkbox" checked={stockedOnly} onChange={e => setStockedOnly(e.target.checked)} /> Stocked only</label>
          </div>
          {groupNames.length === 0 ? <div className="sup-empty">No matching items.</div> : groupNames.map(name => {
            const rows = groups[name]; const open = openGroups[name]; const onCount = rows.filter(r => r.stocked).length;
            return (
              <div key={name} className="stock-group">
                <button className="stock-group-head" onClick={() => setOpenGroups(o => ({ ...o, [name]: !o[name] }))}>
                  <span className="stock-caret">{open ? '▾' : '▸'}</span><strong>{name}</strong><span className="muted">{onCount}/{rows.length} stocked</span>
                </button>
                {open && (
                  <div className="stock-rows">
                    {rows.map(it => (
                      <label key={it.id} className={'stock-row' + (it.stocked ? ' stock-on' : '')}>
                        <input type="checkbox" checked={it.stocked} disabled={!!saving[it.id]} onChange={() => toggle(it)} />
                        <span className="stock-mat">{it.material_type}</span><span className="stock-spec">{it.spec}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ) : (
        <section className="sup-section">
          <h3 className="stock-sub">Add a fitting you stock</h3>
          {!catalog ? <div className="sup-msg">Loading catalog…</div> : (
            <div className="fit-add">
              <div className="fit-cascade">
                <label>Fitting type
                  <select value={pick.type_id} onChange={e => setP({ type_id: e.target.value, end_id: '', connection_ids: [] })}>
                    <option value="">— select —</option>
                    {catalog.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
                <label>Make / material
                  <select value={pick.make_id} onChange={e => setP({ make_id: e.target.value, spec_ids: [] })}>
                    <option value="">— select —</option>
                    {catalog.makes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <label>End type
                  <select value={pick.end_id} disabled={!pick.type_id} onChange={e => setP({ end_id: e.target.value })}>
                    <option value="">{pick.type_id ? '— select —' : 'pick a type first'}</option>
                    {ends.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </label>
              </div>

              {pick.type_id && (
                <div className="fit-checkblock">
                  <div className="fit-check-lbl">Connections <span className="muted">(check all you stock)</span></div>
                  <div className="fit-checks">
                    {conns.length === 0 ? <span className="muted">none for this type</span> : conns.map(o => (
                      <label key={o.id} className={'fit-check' + (pick.connection_ids.includes(o.id) ? ' on' : '')}>
                        <input type="checkbox" checked={pick.connection_ids.includes(o.id)} onChange={() => toggleIn('connection_ids', o.id)} />{o.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {pick.make_id && (
                <div className="fit-checkblock">
                  <div className="fit-check-lbl">Specifications <span className="muted">(check all you stock)</span></div>
                  <div className="fit-checks">
                    {specs.length === 0 ? <span className="muted">none for this make</span> : specs.map(o => (
                      <label key={o.id} className={'fit-check' + (pick.spec_ids.includes(o.id) ? ' on' : '')}>
                        <input type="checkbox" checked={pick.spec_ids.includes(o.id)} onChange={() => toggleIn('spec_ids', o.id)} />{o.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="q-actions">
                <button className="btn-quote" disabled={!canAdd || fitBusy} onClick={addFitting}>
                  {fitBusy ? 'Adding…' : (comboCount > 0 ? 'Add ' + comboCount + ' to stock' : 'Add to stock')}
                </button>
                {fitMsg && <span className="q-result q-result-ok">{fitMsg}</span>}
              </div>
            </div>
          )}

          <h3 className="stock-sub">Fittings you stock <span className="muted">— {fitStocked.length}</span></h3>
          {fitStocked.length === 0 ? <div className="sup-empty">No stocked fittings yet — add one above.</div> : (
            Object.keys(fitGroups).sort().map(type => (
              <div key={type} className="stock-group">
                <div className="stock-group-head" style={{ cursor: 'default' }}><strong>{type}</strong><span className="muted">{fitGroups[type].length}</span></div>
                <div className="prof-list" style={{ padding: 8 }}>
                  {fitGroups[type].map(f => (
                    <div key={f.id} className="prof-row">
                      <div className="prof-row-main">
                        <strong>{f.make}</strong>
                        <span className="muted">{[f.end, f.connection, f.spec].filter(Boolean).join(' · ')}</span>
                      </div>
                      <button className="btn-link btn-danger" disabled={fitBusy} onClick={() => removeFitting(f.id)}>Remove</button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}
