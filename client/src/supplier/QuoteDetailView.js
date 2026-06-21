import React, { useEffect, useState, useCallback } from 'react';

// Quote coverage detail — the FULL quote, every line tagged for this supplier:
//  • Match / Exact match  — sent to you AND you stock it
//  • No stock match       — sent to you, not in your stock list (you could be stocking it)
//  • MFG: not a match      — the manufacturer didn't send you this line (shown inactive)
//  • Pending / Quoted      — your response state on the lines you were sent
// Pricing + submit happens in the Quotes tab; this view is the coverage picture.
function badge(l) {
  if (!l.sent_to_me) return { cls: 'cov-na', label: 'MFG: not a match' };
  if (l.stock_match === 'exact') return { cls: 'cov-exact', label: 'Exact match' };
  if (l.stock_match === 'strong') return { cls: 'cov-match', label: 'Match' };
  return { cls: 'cov-nostock', label: 'No stock match' };
}

export default function QuoteDetailView({ email, quoteId, onBack, onGoToQuotes }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const load = useCallback(async () => {
    setState({ status: 'loading', data: null, error: null });
    try {
      const r = await fetch('/api/supplier/me/quote-detail?quote_id=' + encodeURIComponent(quoteId) + '&email=' + encodeURIComponent(email));
      const j = await r.json();
      if (!r.ok || !j.ok) { setState({ status: 'error', data: null, error: j.error || ('HTTP ' + r.status) }); return; }
      setState({ status: 'ready', data: j, error: null });
    } catch (e) { setState({ status: 'error', data: null, error: String(e.message || e) }); }
  }, [email, quoteId]);
  useEffect(() => { load(); }, [load]);

  if (state.status === 'loading') return <div className="sup-msg">Loading quote…</div>;
  if (state.status === 'error') return <div className="sup-msg sup-msg-error">Couldn’t load quote: {state.error} <button className="btn-link" onClick={load}>Retry</button></div>;

  const { quote, counts, lines } = state.data;
  return (
    <div className="qd">
      <div className="qd-top">
        <button className="btn-link" onClick={onBack}>← Back</button>
        <button className="btn-quote" onClick={onGoToQuotes}>Price &amp; submit in Quotes</button>
      </div>

      <div className="qd-head">
        <h1>{quote.quote_number || 'Quote'}</h1>
        <div className="muted">{[quote.client, quote.project].filter(Boolean).join(' · ')}</div>
        <div className="qd-counts">
          <span><strong>{counts.total}</strong> lines</span>
          <span><strong>{counts.sent_to_me}</strong> sent to you</span>
          <span><strong>{counts.matched}</strong> match your stock</span>
          <span><strong>{counts.quoted}</strong> quoted</span>
        </div>
      </div>

      <div className="qd-lines">
        {lines.map((l, i) => {
          const b = badge(l);
          return (
            <div key={i} className={'qd-line' + (l.sent_to_me ? '' : ' qd-inactive')}>
              <div className="qd-line-main">
                <span className="qd-ln">{l.line_item || '—'}</span>
                <span className="qd-desc">{l.description || '—'}</span>
              </div>
              <div className="qd-line-meta">
                {l.qty != null && <span className="chip">Qty {l.qty}</span>}
                {l.sent_to_me && <span className={'chip ' + (l.responded ? 'cov-quoted' : 'cov-pending')}>{l.responded ? 'Quoted' : 'Pending'}</span>}
                <span className={'cov-badge ' + b.cls}>{b.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
