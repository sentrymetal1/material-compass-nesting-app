import React, { useEffect, useState, useCallback } from 'react';

// Fitting RFQ pricing view — the supplier-side of the fitting quote loop.
// Reads the RFQs the MFG sent this supplier (RFQs_Sent_Fittings bridge) and lets them
// price each line PER-EACH (total = unit × qty). Submit PATCHes the price + status
// straight onto each bridge row (the "bridge = response" model — no Supplier_Alter_Form).
const QUOTE_OPTIONS = ['Quote As Is', 'No Quote'];

function money(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function num(n, dp) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp == null ? 2 : dp });
}

function FittingLineRow({ line, draft, onChange }) {
  const qty = Number(line.qty) || 0;
  const noQuote = draft.quote_option === 'No Quote';
  const unit = !noQuote ? (parseFloat(draft.unit_price) || 0) : 0;
  const total = unit * qty;
  return (
    <tr className={noQuote ? 'q-line q-noquote' : 'q-line'}>
      <td className="q-ln-cell"><span className="q-ln">{line.line}</span></td>
      <td className="q-desc">{line.description}</td>
      <td className="q-num">{num(qty, 0)}</td>
      <td className="q-opt">
        <select value={draft.quote_option || 'Quote As Is'} onChange={e => onChange({ quote_option: e.target.value })}>
          {QUOTE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </td>
      <td className="q-price">
        <span className="q-dollar">$</span>
        <input type="number" step="0.001" min="0" inputMode="decimal"
          value={draft.unit_price} disabled={noQuote} placeholder="0.000"
          onChange={e => onChange({ unit_price: e.target.value })} />
        <span className="q-perlb">/ea</span>
      </td>
      <td className="q-num q-calc">{noQuote || unit <= 0 ? '—' : money(total)}</td>
      <td><input className="q-mini" value={draft.lead_time} disabled={noQuote} placeholder="—" onChange={e => onChange({ lead_time: e.target.value })} /></td>
      <td><input className="q-mini" value={draft.comments} disabled={noQuote} placeholder="—" onChange={e => onChange({ comments: e.target.value })} /></td>
    </tr>
  );
}

function QuoteCard({ quote, email, onSaved }) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState(() => {
    const d = {};
    quote.lines.forEach(l => {
      d[l.rfq_row_id] = {
        quote_option: l.quote_option || 'Quote As Is',
        unit_price: l.unit_price != null ? String(l.unit_price) : '',
        lead_time: l.lead_time || '',
        comments: l.comments || '',
      };
    });
    return d;
  });
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null);

  const setDraft = (id, patch) => setDrafts(d => ({ ...d, [id]: { ...d[id], ...patch } }));

  const grandTotal = quote.lines.reduce((sum, l) => {
    const dr = drafts[l.rfq_row_id] || {};
    if (dr.quote_option === 'No Quote') return sum;
    return sum + (parseFloat(dr.unit_price) || 0) * (Number(l.qty) || 0);
  }, 0);

  const pricedCount = quote.lines.filter(l => {
    const dr = drafts[l.rfq_row_id] || {};
    return dr.quote_option === 'No Quote' || (parseFloat(dr.unit_price) || 0) > 0;
  }).length;

  async function submit() {
    setSubmitting(true); setMsg(null);
    try {
      const lines = quote.lines.map(l => {
        const dr = drafts[l.rfq_row_id] || {};
        return {
          rfq_row_id: l.rfq_row_id,
          quote_option: dr.quote_option || 'Quote As Is',
          unit_price: dr.quote_option === 'No Quote' ? 0 : (parseFloat(dr.unit_price) || 0),
          lead_time: dr.lead_time || '',
          comments: dr.comments || '',
        };
      });
      const r = await fetch('/api/supplier/me/fitting-rfqs/submit?email=' + encodeURIComponent(email), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        const detail = (j.results && j.results.find(x => !x.ok)) || {};
        setMsg({ type: 'error', text: 'Saved ' + (j.saved || 0) + ', failed ' + (j.failed || lines.length) + (detail.message ? ' — ' + String(detail.message).slice(0, 120) : (j.error ? ' — ' + j.error : '')) });
      } else {
        setMsg({ type: 'ok', text: 'Submitted ' + j.saved + ' line' + (j.saved === 1 ? '' : 's') + '.' });
        if (onSaved) onSaved();
      }
    } catch (e) {
      setMsg({ type: 'error', text: String(e.message || e) });
    } finally { setSubmitting(false); }
  }

  return (
    <div className="q-card">
      <div className="q-head" onClick={() => setOpen(o => !o)}>
        <span className="q-caret">{open ? '▾' : '▸'}</span>
        <strong>{quote.quote_number || 'Quote'}</strong>
        {quote.manufacturer && <span className="muted">{quote.manufacturer}</span>}
        {quote.quote_description && <span className="muted q-desc-inline">{quote.quote_description}</span>}
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {quote.lines.length} fitting{quote.lines.length === 1 ? '' : 's'} · {pricedCount}/{quote.lines.length} priced
        </span>
      </div>
      {open && (
        <div className="q-body">
          <table className="q-table">
            <thead>
              <tr>
                <th>#</th><th>Fitting</th><th>Qty</th><th>Option</th><th>Unit Price</th><th>Line Total</th><th>Lead Time</th><th>Comments</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map(l => (
                <FittingLineRow key={l.rfq_row_id} line={l} draft={drafts[l.rfq_row_id]} onChange={p => setDraft(l.rfq_row_id, p)} />
              ))}
            </tbody>
          </table>
          <div className="q-foot">
            <div className="q-total">Quote total: <strong>{money(grandTotal)}</strong></div>
            {msg && <span className={'q-msg ' + (msg.type === 'ok' ? 'q-msg-ok' : 'q-msg-err')}>{msg.text}</span>}
            <button className="btn-quote" disabled={submitting} onClick={submit}>
              {submitting ? 'Submitting…' : 'Submit quote'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FittingRfqsView({ email }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  const load = useCallback(async () => {
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const r = await fetch('/api/supplier/me/fitting-rfqs?email=' + encodeURIComponent(email));
      const j = await r.json();
      if (!r.ok || !j.ok) { setState({ status: 'error', data: null, error: j.error || ('HTTP ' + r.status) }); return; }
      setState({ status: 'ready', data: j, error: null });
    } catch (e) {
      setState({ status: 'error', data: null, error: String(e.message || e) });
    }
  }, [email]);

  useEffect(() => { load(); }, [load]);

  const d = state.data;
  return (
    <div className="q-view">
      <div className="q-view-head">
        <h1>Fitting RFQs</h1>
        <div className="muted">Price the fitting requests manufacturers sent you. Total = unit price × quantity.</div>
      </div>
      {state.status === 'loading' && <div className="sup-msg">Loading your fitting RFQs…</div>}
      {state.status === 'error' && (
        <div className="sup-msg sup-msg-error">Couldn’t load: {state.error}<button className="btn-link" onClick={load}>Retry</button></div>
      )}
      {state.status === 'ready' && (
        d.quotes.length === 0 ? (
          <div className="sup-empty">
            No open fitting RFQs right now. Requests appear here when a manufacturer sends you
            a fitting quote (picks you under “Fittings (Registered) Choices”).
          </div>
        ) : (
          <div className="q-list">
            {d.quotes.map(q => <QuoteCard key={q.quote_id} quote={q} email={email} onSaved={load} />)}
          </div>
        )
      )}
    </div>
  );
}
