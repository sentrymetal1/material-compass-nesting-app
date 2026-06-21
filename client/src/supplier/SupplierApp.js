import React, { useEffect, useState, useCallback } from 'react';
import './supplier.css';
import QuotesView from './QuotesView';
import ProfileView from './ProfileView';
import StockView from './StockView';

// Off-Zoho supplier platform — v1. Embedded in the Zoho portal, which passes the
// logged-in email as ?email=. All data comes from Railway (/api/supplier/*), which
// reads/writes Zoho behind the scenes. When auth later moves to Supabase, only the
// identity source changes; this UI does not.
const BUILD_TAG = 'supplier-v1-2026-06-19i';

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
  let title, detail;
  if (m.material) {
    // RFQs_Sent returns lookups as IDs, so prefer the readable description line.
    const x = m.material;
    const names = [x.form, x.material, x.spec].filter(s => s && !/^\d{10,}$/.test(String(s)));
    title = m.description || names.join(' · ') || 'Material';
    detail = m.description ? '' : (x.spec || '');
  } else {
    const f = m.fitting || {};
    title = [f.type, f.make].filter(Boolean).join(' — ') || 'Fitting';
    detail = [f.end, f.connection, f.specification].filter(Boolean).join(' · ');
  }
  const p = m.project;
  const projectLabel = p
    ? [p.quote_number, p.client].filter(Boolean).join(' · ')
    : (m.project_name || '');
  return (
    <div className="match-card">
      <div className="match-main">
        <div className="match-desc">{title}</div>
        <div className="match-spec">{detail}</div>
        <div className="match-meta">
          {m.qty != null && <span className="chip">Qty {m.qty}</span>}
          {projectLabel && <span className="chip">{projectLabel}</span>}
          {p && p.status && <span className="chip chip-status">{p.status}</span>}
          {p && p.due_date && <span className="chip">Due {p.due_date}</span>}
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
  const [view, setView] = useState('dashboard');
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
  useEffect(() => { document.title = 'Material Compass · Supplier'; }, []);

  const d = state.data;
  const fittings = (d && d.matches && d.matches.fittings) || [];
  const structural = (d && d.matches && d.matches.structural) || [];

  return (
    <div className="sup-app">
      <header className="sup-header">
        <div className="sup-brand">
          <span className="sup-logo">◆</span>
          <span className="sup-title">Material Compass <em>· Supplier</em></span>
        </div>
        <nav className="sup-nav">
          <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button>
          <button className={view === 'quotes' ? 'active' : ''} onClick={() => setView('quotes')}>Quotes</button>
          <button className={view === 'stock' ? 'active' : ''} onClick={() => setView('stock')}>Stock</button>
          <button className={view === 'profile' ? 'active' : ''} onClick={() => setView('profile')}>Profile</button>
        </nav>
        <div className="sup-who">
          {d && d.supplier ? d.supplier.company_name : (email || '—')}
        </div>
      </header>

      <main className={'sup-main' + (view === 'quotes' || view === 'profile' || view === 'stock' ? ' sup-main-wide' : '')}>
        {view === 'stock' ? (
          email ? <StockView email={email} />
            : <div className="sup-msg sup-msg-warn">No login detected. This page expects <code>?email=</code> from the portal.</div>
        ) : view === 'profile' ? (
          email ? <ProfileView email={email} />
            : <div className="sup-msg sup-msg-warn">No login detected. This page expects <code>?email=</code> from the portal.</div>
        ) : view === 'quotes' ? (
          email ? <QuotesView email={email} />
            : <div className="sup-msg sup-msg-warn">No login detected. This page expects <code>?email=</code> from the portal.</div>
        ) : (<>
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
                <div className="count-card">
                  <div className="count-num">{d.counts.structural_matches != null ? d.counts.structural_matches : 0}</div>
                  <div className="count-lbl">Structural RFQ matches</div>
                </div>
                <div className="count-card">
                  <div className="count-num">{d.counts.structural_stock != null ? d.counts.structural_stock : 0}</div>
                  <div className="count-lbl">Structural items you stock</div>
                </div>
              </div>
            </div>

            <section className="sup-section">
              <h2>RFQ matches <span className="muted">— quote requests for fittings you stock</span></h2>
              {fittings.length === 0 ? (
                <div className="sup-empty">
                  No open RFQs right now. New requests appear here automatically as
                  manufacturers quote fittings that match your stock list.
                  {d.counts.fitting_matches_closed_hidden > 0 && (
                    <div className="sup-subnote">
                      ({d.counts.fitting_matches_closed_hidden} match{d.counts.fitting_matches_closed_hidden > 1 ? 'es' : ''} hidden — those projects are already awarded or closed.)
                    </div>
                  )}
                </div>
              ) : (
                <div className="match-list">
                  {fittings.map(m => <MatchCard key={m.rfq_row_id} m={m} />)}
                </div>
              )}
            </section>

            <section className="sup-section">
              <h2>Structural matches <span className="muted">— sourcing requests for material you stock</span></h2>
              {structural.length === 0 ? (
                <div className="sup-empty">
                  No open structural requests right now. They appear here automatically as
                  manufacturers source material that matches your structural stock list.
                  {d.counts.structural_matches_closed_hidden > 0 && (
                    <div className="sup-subnote">
                      ({d.counts.structural_matches_closed_hidden} match{d.counts.structural_matches_closed_hidden > 1 ? 'es' : ''} hidden — those projects are already awarded or closed.)
                    </div>
                  )}
                </div>
              ) : (
                <div className="match-list">
                  {structural.map(m => <MatchCard key={m.rfq_row_id} m={m} />)}
                </div>
              )}
            </section>
          </>
        )}
        </>)}
      </main>

      <footer className="sup-footer">{BUILD_TAG}</footer>
    </div>
  );
}
