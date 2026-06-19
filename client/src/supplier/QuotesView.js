import React, { useEffect, useState, useCallback } from 'react';

// Price-entry view: lists the supplier's sent RFQs and lets them price each line.
// STEP 1 = read + interactive pricing + live totals (no write yet; Submit is staged).
const QUOTE_OPTIONS = ['Quote As Is', 'No Quote', 'Alter Material or Form Detail', 'Alter Quantity', 'Alter Length'];

function money(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function num(n, dp) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp == null ? 2 : dp });
}

// One priceable line. Supplier enters $/lb; line total = $/lb × (qty × unit weight).
function LineRow({ line, draft, onChange }) {
  const totalWeight = (Number(line.qty) || 0) * (Number(line.unit_weight) || 0);
  const ppl = parseFloat(draft.price_per_lb);
  const noQuote = draft.quote_option === 'No Quote';
  const lineTotal = !noQuote && ppl > 0 ? ppl * totalWeight : 0;
  return (
    <tr className={noQuote ? 'q-line q-noquote' : 'q-line'}>
      <td className="q-ln">{line.line}</td>
      <td className="q-desc">
        {line.description}
        {line.item_requirements && line.item_requirements.length > 0 && (
          <div className="q-reqs">{line.item_requirements.map((r, i) => <span key={i} className="q-req">{r}</span>)}</div>
        )}
      </td>
      <td className="q-num">{num(line.qty, 0)}</td>
      <td className="q-num">{num(totalWeight, 1)} lb</td>
      <td className="q-opt">
        <select value={draft.quote_option || 'Quote As Is'} onChange={e => onChange({ quote_option: e.target.value })}>
          {QUOTE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </td>
      <td className="q-price">
        <span className="q-dollar">$</span>
        <input
          type="number" step="0.00001" min="0" inputMode="decimal"
          value={draft.price_per_lb} disabled={noQuote}
          placeholder="0.00000"
          onChange={e => onChange({ price_per_lb: e.target.value })}
        />
        <span className="q-perlb">/lb</span>
      </td>
      <td className="q-num q-total">{noQuote ? '—' : money(lineTotal)}</td>
    </tr>
  );
}

function QuoteCard({ quote }) {
  const [open, setOpen] = useState(false);
  // drafts keyed by rfqs_sent_id: { price_per_lb, quote_option }
  const [drafts, setDrafts] = useState(() => {
    const d = {};
    quote.lines.forEach(l => { d[l.rfqs_sent_id] = { price_per_lb: l.price_per_lb || '', quote_option: l.quote_option || 'Quote As Is' }; });
    return d;
  });
  const setLine = (id, patch) => setDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const grand = quote.lines.reduce((sum, l) => {
    const dr = drafts[l.rfqs_sent_id] || {};
    if (dr.quote_option === 'No Quote') return sum;
    const ppl = parseFloat(dr.price_per_lb) || 0;
    return sum + ppl * (Number(l.qty) || 0) * (Number(l.unit_weight) || 0);
  }, 0);
  const priced = quote.lines.filter(l => parseFloat((drafts[l.rfqs_sent_id] || {}).price_per_lb) > 0).length;

  return (
    <div className="q-card">
      <div className="q-head" onClick={() => setOpen(o => !o)}>
        <div className="q-head-main">
          <span className="q-caret">{open ? '▾' : '▸'}</span>
          <strong>Quote {quote.quote_number}</strong>
          <span className="q-head-desc">{quote.quote_description}</span>
        </div>
        <div className="q-head-meta">
          {quote.manufacturer && <span className="chip">{quote.manufacturer}</span>}
          <span className="chip">{quote.lines.length} lines</span>
          {grand > 0 && <span className="chip chip-status">{money(grand)}</span>}
        </div>
      </div>
      {open && (
        <div className="q-body">
          <table className="q-table">
            <thead>
              <tr><th>#</th><th>Item</th><th>Qty</th><th>Weight</th><th>Quote option</th><th>Price / lb</th><th>Line total</th></tr>
            </thead>
            <tbody>
              {quote.lines.map(l => (
                <LineRow key={l.rfqs_sent_id} line={l} draft={drafts[l.rfqs_sent_id]} onChange={p => setLine(l.rfqs_sent_id, p)} />
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan="6" className="q-foot-lbl">Grand total ({priced}/{quote.lines.length} priced)</td><td className="q-num q-total">{money(grand)}</td></tr>
            </tfoot>
          </table>
          <div className="q-actions">
            <button className="btn-quote" disabled title="Submitting is wired in the next step">Submit quote</button>
            <span className="q-hint">Pricing saves to Zoho once the submit step is wired.</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function QuotesView({ email }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const load = useCallback(async () => {
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const r = await fetch('/api/supplier/me/rfqs?email=' + encodeURIComponent(email));
      const j = await r.json();
      if (!r.ok || !j.ok) { setState({ status: 'error', data: null, error: j.error || ('HTTP ' + r.status) }); return; }
      setState({ status: 'ready', data: j, error: null });
    } catch (e) { setState({ status: 'error', data: null, error: String(e.message || e) }); }
  }, [email]);
  useEffect(() => { load(); }, [load]);

  if (state.status === 'loading') return <div className="sup-msg">Loading your RFQs…</div>;
  if (state.status === 'error') return <div className="sup-msg sup-msg-error">Couldn’t load RFQs: {state.error} <button className="btn-link" onClick={load}>Retry</button></div>;

  const d = state.data;
  const openQuotes = d.quotes.filter(q => /^Open|Quote Revised|Submitted/i.test(q.status));
  const shown = openQuotes.length ? openQuotes : d.quotes;

  return (
    <>
      <div className="q-tiles">
        {[['open', 'New / Open'], ['submitted', 'Submitted'], ['awarded', 'Awarded'], ['closed', 'Closed']].map(([k, lbl]) => (
          <div key={k} className={'q-tile q-tile-' + k}><div className="count-num">{d.tiles[k]}</div><div className="count-lbl">{lbl}</div></div>
        ))}
      </div>
      <section className="sup-section">
        <h2>Requests for quote <span className="muted">— price the lines you can fill</span></h2>
        {shown.length === 0
          ? <div className="sup-empty">No RFQs to quote right now.</div>
          : shown.map(q => <QuoteCard key={q.quote_id} quote={q} />)}
      </section>
    </>
  );
}
