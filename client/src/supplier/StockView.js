import React, { useEffect, useState, useCallback, useMemo } from 'react';

// Supplier Stock tab.
//  Structural: searchable, grouped (by Form Type) toggle list -> Stocked_Material_List.
//  Fittings: add a Type/Make/End group, then check the Connections × Specs you stock.
//    Existing groups show as an accordion you can expand and edit in place. Each save
//    syncs that group (adds new combos, removes deselected) -> Supplier_Fitting_Stock.
export default function StockView({ email }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [tab, setTab] = useState('structural');
  const [q, setQ] = useState('');
  const [stockedOnly, setStockedOnly] = useState(false);
  const [openGroups, setOpenGroups] = useState({});
  const [saving, setSaving] = useState({});
  // fittings
  const [catalog, setCatalog] = useState(null);
  const [addPick, setAddPick] = useState({ type_id: '', make_id: '', end_id: '' });
  const [openFit, setOpenFit] = useState(null); // expanded existing group key
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

  useEffect(() => {
    if (tab !== 'fittings' || catalog) return;
    (async () => {
      try { const r = await fetch('/api/supplier/me/fitting-catalog?email=' + encodeURIComponent(email)); const j = await r.json(); if (j.ok) setCatalog(j.catalog); } catch (e) {}
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
      const r = await fetch('/api/supplier/me/stock/structural/' + it.id + '?email=' + encodeURIComponent(email), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stocked: next }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
    } catch (e) {
      setState(s => ({ ...s, data: { ...s.data, structural: s.data.structural.map(x => x.id === it.id ? { ...x, stocked: it.stocked } : x) } }));
      window.alert('Could not save: ' + (e.message || e));
    } finally { setSaving(s => { const n = { ...s }; delete n[it.id]; return n; }); }
  };

  // existing fitting groups, keyed type|make|end, collecting the stocked conn/spec ids
  const fitStocked = fittings.filter(f => f.stocked);
  const fitGroups = useMemo(() => {
    const g = {};
    for (const f of fitStocked) {
      const key = f.type_id + '|' + f.make_id + '|' + f.end_id;
      if (!g[key]) g[key] = { key, type_id: f.type_id, make_id: f.make_id, end_id: f.end_id, type: f.type, make: f.make, end: f.end, conns: new Set(), specs: new Set(), count: 0 };
      g[key].conns.add(f.connection_id); g[key].specs.add(f.spec_id); g[key].count++;
    }
    return Object.values(g).sort((a, b) => (a.type + a.make + a.end).localeCompare(b.type + b.make + b.end));
  }, [fitStocked]);

  const saveGroup = async (type_id, make_id, end_id, connection_ids, spec_ids, isNew) => {
    setFitBusy(true); setFitMsg('');
    try {
      const r = await fetch('/api/supplier/me/stock/fittings/group?email=' + encodeURIComponent(email), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type_id, make_id, end_id, connection_ids, spec_ids }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
      setFitMsg('Saved — ' + j.added + ' added, ' + j.removed + ' removed.');
      if (isNew) setAddPick({ type_id: '', make_id: '', end_id: '' });
      setOpenFit(null);
      await load();
    } catch (e) { window.alert('Could not save: ' + (e.message || e)); }
    finally { setFitBusy(false); }
  };

  const addEnds = useMemo(() => catalog ? catalog.ends.filter(e => e.type_id === addPick.type_id) : [], [catalog, addPick.type_id]);

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
          <h3 className="stock-sub">Add a fitting group</h3>
          {!catalog ? <div className="sup-msg">Loading catalog…</div> : (
            <div className="fit-add">
              <div className="fit-cascade">
                <label>Fitting type
                  <select value={addPick.type_id} onChange={e => setAddPick({ type_id: e.target.value, make_id: addPick.make_id, end_id: '' })}>
                    <option value="">— select —</option>{catalog.types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
                <label>Make / material
                  <select value={addPick.make_id} onChange={e => setAddPick({ ...addPick, make_id: e.target.value })}>
                    <option value="">— select —</option>{catalog.makes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <label>End type
                  <select value={addPick.end_id} disabled={!addPick.type_id} onChange={e => setAddPick({ ...addPick, end_id: e.target.value })}>
                    <option value="">{addPick.type_id ? '— select —' : 'pick a type first'}</option>{addEnds.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </label>
              </div>
              {addPick.type_id && addPick.make_id && addPick.end_id && (
                <FittingGroupEditor catalog={catalog} type_id={addPick.type_id} make_id={addPick.make_id} end_id={addPick.end_id}
                  busy={fitBusy} onSave={(c, s) => saveGroup(addPick.type_id, addPick.make_id, addPick.end_id, c, s, true)} />
              )}
              {fitMsg && <div className="q-result q-result-ok" style={{ marginTop: 8 }}>{fitMsg}</div>}
            </div>
          )}

          <h3 className="stock-sub">Fittings you stock <span className="muted">— {fitStocked.length} across {fitGroups.length} group{fitGroups.length === 1 ? '' : 's'}</span></h3>
          {fitGroups.length === 0 ? <div className="sup-empty">No stocked fittings yet — add a group above.</div> : fitGroups.map(g => {
            const open = openFit === g.key;
            return (
              <div key={g.key} className="stock-group">
                <button className="stock-group-head" onClick={() => setOpenFit(open ? null : g.key)}>
                  <span className="stock-caret">{open ? '▾' : '▸'}</span>
                  <strong>{g.type}</strong><span className="muted">{g.make} · {g.end}</span>
                  <span className="muted" style={{ marginLeft: 'auto' }}>{g.count} item{g.count === 1 ? '' : 's'}</span>
                </button>
                {open && catalog && (
                  <div style={{ padding: '12px 16px' }}>
                    <FittingGroupEditor catalog={catalog} type_id={g.type_id} make_id={g.make_id} end_id={g.end_id}
                      initConns={[...g.conns]} initSpecs={[...g.specs]} busy={fitBusy}
                      onSave={(c, s) => saveGroup(g.type_id, g.make_id, g.end_id, c, s, false)} />
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function FittingGroupEditor({ catalog, type_id, make_id, end_id, initConns, initSpecs, onSave, busy }) {
  const [conns, setConns] = useState(initConns || []);
  const [specs, setSpecs] = useState(initSpecs || []);
  const connOpts = catalog.connections.filter(c => c.type_id === type_id);
  const specOpts = catalog.specs.filter(s => s.make_id === make_id);
  const tog = (arr, set, id) => set(arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]);
  const count = conns.length * specs.length;
  return (
    <div>
      <div className="fit-check-lbl">Connections <span className="muted">(check all you stock)</span></div>
      <div className="fit-checks">
        {connOpts.length === 0 ? <span className="muted">none for this type</span> : connOpts.map(o => (
          <label key={o.id} className={'fit-check' + (conns.includes(o.id) ? ' on' : '')}><input type="checkbox" checked={conns.includes(o.id)} onChange={() => tog(conns, setConns, o.id)} />{o.name}</label>
        ))}
      </div>
      <div className="fit-check-lbl" style={{ marginTop: 12 }}>Specifications <span className="muted">(check all you stock)</span></div>
      <div className="fit-checks">
        {specOpts.length === 0 ? <span className="muted">none for this make</span> : specOpts.map(o => (
          <label key={o.id} className={'fit-check' + (specs.includes(o.id) ? ' on' : '')}><input type="checkbox" checked={specs.includes(o.id)} onChange={() => tog(specs, setSpecs, o.id)} />{o.name}</label>
        ))}
      </div>
      <div className="q-actions">
        <button className="btn-quote" disabled={busy} onClick={() => onSave(conns, specs)}>{busy ? 'Saving…' : 'Save (' + count + ' item' + (count === 1 ? '' : 's') + ')'}</button>
        {count === 0 && <span className="muted">unchecking everything will clear this group</span>}
      </div>
    </div>
  );
}
