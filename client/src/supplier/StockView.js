import React, { useEffect, useState, useCallback, useMemo } from 'react';

// Supplier Stock tab. v1: Structural stock as a searchable, grouped (by Form Type)
// toggle list — flip an item "stocked" and it's saved to Stocked_Material_List and
// feeds matching. Fittings stock is shown read-only (add-from-catalog cascade next).
export default function StockView({ email }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [tab, setTab] = useState('structural');
  const [q, setQ] = useState('');
  const [stockedOnly, setStockedOnly] = useState(false);
  const [openGroups, setOpenGroups] = useState({});
  const [saving, setSaving] = useState({}); // id -> true while a toggle is in flight

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

  const structural = (state.data && state.data.structural) || [];
  const fittings = (state.data && state.data.fittings) || [];

  // filter + group structural by form type
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const g = {};
    for (const it of structural) {
      if (stockedOnly && !it.stocked) continue;
      if (needle) {
        const hay = (it.form_type + ' ' + it.material_type + ' ' + it.spec).toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      (g[it.form_type || '—'] = g[it.form_type || '—'] || []).push(it);
    }
    return g;
  }, [structural, q, stockedOnly]);
  const groupNames = Object.keys(groups).sort();
  const stockedCount = structural.filter(s => s.stocked).length;

  const toggle = async (it) => {
    const next = !it.stocked;
    setSaving(s => ({ ...s, [it.id]: true }));
    // optimistic
    setState(s => ({ ...s, data: { ...s.data, structural: s.data.structural.map(x => x.id === it.id ? { ...x, stocked: next } : x) } }));
    try {
      const r = await fetch('/api/supplier/me/stock/structural/' + it.id + '?email=' + encodeURIComponent(email), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stocked: next }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
    } catch (e) {
      // revert on failure
      setState(s => ({ ...s, data: { ...s.data, structural: s.data.structural.map(x => x.id === it.id ? { ...x, stocked: it.stocked } : x) } }));
      window.alert('Could not save: ' + (e.message || e));
    } finally { setSaving(s => { const n = { ...s }; delete n[it.id]; return n; }); }
  };

  if (state.status === 'loading') return <div className="sup-msg">Loading your stock…</div>;
  if (state.status === 'error') return <div className="sup-msg sup-msg-error">Couldn’t load stock: {state.error} <button className="btn-link" onClick={load}>Retry</button></div>;

  return (
    <div className="stock">
      <div className="stock-tabs">
        <button className={tab === 'structural' ? 'active' : ''} onClick={() => setTab('structural')}>Structural <span className="muted">({stockedCount} stocked)</span></button>
        <button className={tab === 'fittings' ? 'active' : ''} onClick={() => setTab('fittings')}>Fittings <span className="muted">({fittings.filter(f => f.stocked).length} stocked)</span></button>
      </div>

      {tab === 'structural' ? (
        <section className="sup-section">
          <div className="stock-controls">
            <input className="stock-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search form, material, spec…" />
            <label className="stock-only"><input type="checkbox" checked={stockedOnly} onChange={e => setStockedOnly(e.target.checked)} /> Stocked only</label>
          </div>
          {groupNames.length === 0 ? <div className="sup-empty">No matching items.</div> : groupNames.map(name => {
            const rows = groups[name];
            const open = openGroups[name];
            const onCount = rows.filter(r => r.stocked).length;
            return (
              <div key={name} className="stock-group">
                <button className="stock-group-head" onClick={() => setOpenGroups(o => ({ ...o, [name]: !o[name] }))}>
                  <span className="stock-caret">{open ? '▾' : '▸'}</span>
                  <strong>{name}</strong>
                  <span className="muted">{onCount}/{rows.length} stocked</span>
                </button>
                {open && (
                  <div className="stock-rows">
                    {rows.map(it => (
                      <label key={it.id} className={'stock-row' + (it.stocked ? ' stock-on' : '')}>
                        <input type="checkbox" checked={it.stocked} disabled={!!saving[it.id]} onChange={() => toggle(it)} />
                        <span className="stock-mat">{it.material_type}</span>
                        <span className="stock-spec">{it.spec}</span>
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
          <h2>Fittings you stock <span className="muted">— {fittings.filter(f => f.stocked).length}</span></h2>
          <div className="sup-subnote" style={{ marginBottom: 12 }}>Editing fittings (add from catalog) is coming next — this is what currently feeds your dashboard matches.</div>
          {fittings.filter(f => f.stocked).length === 0 ? <div className="sup-empty">No stocked fittings yet.</div> : (
            <div className="prof-list">
              {fittings.filter(f => f.stocked).map(f => (
                <div key={f.id} className="prof-row">
                  <div className="prof-row-main">
                    <strong>{[f.type, f.make].filter(Boolean).join(' — ')}</strong>
                    <span className="muted">{[f.end, f.connection, f.spec].filter(Boolean).join(' · ')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
