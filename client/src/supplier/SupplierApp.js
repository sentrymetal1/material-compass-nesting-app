import React, { useEffect, useState, useCallback } from 'react';
import './supplier.css';

// Off-Zoho supplier platform — v1. Embedded in the Zoho portal, which passes the
// logged-in email as ?email=. All data comes from Railway (/api/supplier/*), which
// reads/writes Zoho behind the scenes. When auth later moves to Supabase, only the
// identity source changes; this UI does not.
const BUILD_TAG = 'supplier-v1-2026-06-17';

function getEmail() {
  const p = new URLSearchParams(window.location.search);
  return p.get('email') || p.get('User') || p.get('user') || '';
}

const TIER = {
  exact:    { label: 'Exact match',    cls: 'tier-exact' },
  strong:   { label: 'Strong match',   cls: 'tier-strong' },
  spec:     { label: 'Type + end',     cls: 'tier-spec' },
  category: { label: 'Category match', cls: 'tier-category' },
};

function MatchCard({ m }) {
  const t = TIER[m.match_level] || { label: m.match_level, cls: 'tier-category' };
  const f = m.fitting || {};
  const spec = [f.type, f.make, f.end, f.connection, f.specification].filter(Boolean).join(' · ');
  return (
    <div className="match-card">
      <div className="match-main">
        <div className="match-desc">{m.description || spec || 'Fitting'}</div>
        <div className="match-spec">{spec}</div>
        <div className="match-meta">
          {m.qty != null && <span className="chip">Qty {m.qty}</span>}
          {m.project_name && <span className="chip">Project {m.project_name}</span>}
          {m.quote_id_number && <span className="chip">Quote #{m.quote_id_number}</span>}
        </div>
      </div>
      <div className="match-side">
        <span className={'tier ' + t.cls}>{t.label}</span>
        <button className="btn-quote" type="button" disabled title="Quoting flow — coming in the next phase">
          Quote
        </button>
      </div>
    </div>
  );
}

export default function SupplierApp() {
  const [email] = useState(getEmail);
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  const load = useCallback(async () => {
    if (!email) { setState({ status: 'no-email', data: null, error: null }); return; }
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const r = await fetch('/api/supplier/me/dashboard?email=' + encodeURIComponent(email));
      const j = await r.json();
      if (!r.ok || !j.ok) { setState({ status: 'error', data: null, error: j.error || ('HTTP ' + r.status) }); return; }
      setState({ status: 'ready', data: j, error: null });
    } catch (e) {
      setState({ status: 'error', data: null, error: String(e.message || e) });
    }
  }, [email]);

  useEffect(() => { load(); }, [load]);

  const d = state.data;
  const fittings = (d && d.matches && d.matches.fittings) || [];

  return (
    <div className="sup-app">
      <header className="sup-header">
        <div className="sup-brand">
          <span className="sup-logo">◆</span>
          <span className="sup-title">Material Compass <em>· Supplier</em></span>
        </div>
        <nav className="sup-nav">
          <a className="active" href="#dashboard">Dashboard</a>
          <span className="soon" title="Coming next">Quotes</span>
          <span className="soon" title="Coming next">Stock</span>
          <span className="soon" title="Coming next">Profile</span>
        </nav>
        <div className="sup-who">
          {d && d.supplier ? d.supplier.company_name : (email || '—')}
        </div>
      </header>

      <main className="sup-main">
        {state.status === 'loading' && <div className="sup-msg">Loading your dashboard…</div>}

        {state.status === 'no-email' && (
          <div className="sup-msg sup-msg-warn">
            No login detected. This page expects <code>?email=</code> from the portal.
          </div>
        )}

        {state.status === 'error' && (
          <div className="sup-msg sup-msg-error">
            Couldn’t load your dashboard: {state.error}
            <button className="btn-link" onClick={load}>Retry</button>
          </div>
        )}

        {state.status === 'ready' && (
          <>
            <div className="sup-greeting">
              <h1>Welcome, {d.supplier.company_name}</h1>
              <div className="sup-counts">
                <div className="count-card">
                  <div className="count-num">{d.counts.fitting_matches}</div>
                  <div className="count-lbl">Fitting RFQ matches</div>
                </div>
                <div className="count-card">
                  <div className="count-num">{d.counts.fitting_stock}</div>
                  <div className="count-lbl">Fittings you stock</div>
                </div>
              </div>
            </div>

            <section className="sup-section">
              <h2>RFQ matches <span className="muted">— quote requests for fittings you stock</span></h2>
              {fittings.length === 0 ? (
                <div className="sup-empty">
                  No matching RFQs right now. New requests appear here automatically as
                  manufacturers send fitting quotes that match your stock list.
                </div>
              ) : (
                <div className="match-list">
                  {fittings.map(m => <MatchCard key={m.rfq_row_id} m={m} />)}
                </div>
              )}
            </section>

            <section className="sup-section sup-section-soon">
              <h2>Structural, pipe &amp; plate matches <span className="muted">— coming next</span></h2>
              <div className="sup-empty">These will join this dashboard in the next phase.</div>
            </section>
          </>
        )}
      </main>

      <footer className="sup-footer">{BUILD_TAG}</footer>
    </div>
  );
}
