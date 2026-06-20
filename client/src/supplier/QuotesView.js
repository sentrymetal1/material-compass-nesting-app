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

const round = (n, dp) => { const f = Math.pow(10, dp); return Math.round(n * f) / f; };

// One priceable line. Supplier can edit EITHER the Line Total OR Price/lb — each
// recalculates the other via the line weight. Unit price stays derived (total ÷ qty).
function LineRow({ line, draft, onChange }) {
  const qty = Number(line.qty) || 0;
  const totalWeight = qty * (Number(line.unit_weight) || 0);
  const noQuote = draft.quote_option === 'No Quote';
  const lineTotal = !noQuote ? (parseFloat(draft.total_price) || 0) : 0;
  const unitPrice = qty > 0 ? lineTotal / qty : 0;

  const onTotal = v => {
    const t = parseFloat(v);
    const ppl = totalWeight > 0 && t > 0 ? round(t / totalWeight, 5) : '';
    onChange({ total_price: v, price_per_lb: ppl === '' ? '' : String(ppl) });
  };
  const onPpl = v => {
    const p = parseFloat(v);
    const tot = p > 0 ? round(p * totalWeight, 2) : '';
    onChange({ price_per_lb: v, total_price: tot === '' ? '' : String(tot) });
  };

  return (
    <tr className={noQuote ? 'q-line q-noquote' : 'q-line'}>
      <td className="q-ln-cell"><span className="q-ln">{line.line}</span></td>
      <td className="q-desc">
        {line.description}
        {line.item_requirements && line.item_requirements.length > 0 && (
          <div className="q-reqs">{line.item_requirements.map((r, i) => <span key={i} className="q-req">{r}</span>)}</div>
        )}
      </td>
      <td className="q-num">{num(qty, 0)}</td>
      <td className="q-num">{num(totalWeight, 1)} lb</td>
      <td className="q-opt">
        <select value={draft.quote_option || 'Quote As Is'} onChange={e => onChange({ quote_option: e.target.value })}>
          {QUOTE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </td>
      <td className="q-price">
        <span className="q-dollar">$</span>
        <input type="number" step="0.01" min="0" inputMode="decimal"
          value={draft.total_price} disabled={noQuote} placeholder="0.00"
          onChange={e => onTotal(e.target.value)} />
      </td>
      <td className="q-price">
        <span className="q-dollar">$</span>
        <input type="number" step="0.00001" min="0" inputMode="decimal"
          value={draft.price_per_lb} disabled={noQuote} placeholder="0.00000"
          onChange={e => onPpl(e.target.value)} />
        <span className="q-perlb">/lb</span>
      </td>
      <td className="q-num q-calc">{noQuote || lineTotal <= 0 ? '—' : money(unitPrice) + '/ea'}</td>
      <td><input className="q-mini" value={draft.lead_time} disabled={noQuote} placeholder="—" onChange={e => onChange({ lead_time: e.target.value })} /></td>
      <td><input className="q-mini" value={draft.comments} disabled={noQuote} placeholder="—" onChange={e => onChange({ comments: e.target.value })} /></td>
    </tr>
  );
}

function QuoteCard({ quote, lookups, email }) {
  const [open, setOpen] = useState(false);
  const [submitState, setSubmitState] = useState(null); // {status:'saving'|'done'|'error', result, error}
  // drafts keyed by rfqs_sent_id: { total_price, price_per_lb, quote_option, lead_time, comments }
  const [drafts, setDrafts] = useState(() => {
    const d = {};
    quote.lines.forEach(l => { d[l.rfqs_sent_id] = { total_price: l.total_price || '', price_per_lb: l.price_per_lb || '', quote_option: l.quote_option || 'Quote As Is', lead_time: '', comments: '' }; });
    return d;
  });
  const setLine = (id, patch) => setDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  // Batch-fill: apply a quote option / lead time / comment to every line at once.
  const [batch, setBatch] = useState({ quote_option: '', lead_time: '', comments: '' });
  const setB = patch => setBatch(p => ({ ...p, ...patch }));
  const applyBatch = () => setDrafts(prev => {
    const next = { ...prev };
    quote.lines.forEach(l => {
      const d = { ...next[l.rfqs_sent_id] };
      if (batch.quote_option) d.quote_option = batch.quote_option;
      if (batch.lead_time !== '') d.lead_time = batch.lead_time;
      if (batch.comments !== '') d.comments = batch.comments;
      next[l.rfqs_sent_id] = d;
    });
    return next;
  });

  // Quote-level header / summary fields (the "more than the quote itself" info).
  const [hdr, setHdr] = useState({
    supplier_quote_number: '', meets_requirements: '', shipping: '', misc: '',
    valid_days: '', valid_until: '', lead_time: '', notes: '', ready: false,
    location: '', rep: '', requirements: [], attachment_name: '',
  });
  const setH = patch => setHdr(p => ({ ...p, ...patch }));
  // Auto-fill Valid Until from valid-days (today + N days), but keep it editable.
  const onValidDays = v => {
    const n = parseInt(v, 10);
    let until = hdr.valid_until;
    if (n > 0) { const dt = new Date(); dt.setDate(dt.getDate() + n); until = dt.toISOString().slice(0, 10); }
    setH({ valid_days: v, valid_until: until });
  };
  const toggleReq = r => setH({ requirements: hdr.requirements.includes(r) ? hdr.requirements.filter(x => x !== r) : [...hdr.requirements, r] });
  const locations = (lookups && lookups.locations) || [];
  const reps = (lookups && lookups.reps) || [];
  const reqChoices = (lookups && lookups.quote_requirements) || [];

  const grand = quote.lines.reduce((sum, l) => {
    const dr = drafts[l.rfqs_sent_id] || {};
    if (dr.quote_option === 'No Quote') return sum;
    return sum + (parseFloat(dr.total_price) || 0);
  }, 0);
  const priced = quote.lines.filter(l => parseFloat((drafts[l.rfqs_sent_id] || {}).total_price) > 0).length;
  const totalWeight = quote.lines.reduce((s, l) => {
    const dr = drafts[l.rfqs_sent_id] || {};
    if (dr.quote_option === 'No Quote') return s;
    return s + (Number(l.qty) || 0) * (Number(l.unit_weight) || 0);
  }, 0);
  const totalAmount = grand + (parseFloat(hdr.shipping) || 0) + (parseFloat(hdr.misc) || 0);

  const onSubmit = async () => {
    setSubmitState({ status: 'saving' });
    try {
      const lines = quote.lines.map(l => {
        const d = drafts[l.rfqs_sent_id] || {};
        const qty = Number(l.qty) || 0;
        const total = parseFloat(d.total_price) || 0;
        return {
          rfqs_sent_id: l.rfqs_sent_id, sv_detail_id: l.sv_detail_id, line: l.line,
          quote_option: d.quote_option || 'Quote As Is',
          total_price: total, price_per_lb: parseFloat(d.price_per_lb) || 0,
          unit_price: qty > 0 ? total / qty : 0, lead_time: d.lead_time, comments: d.comments,
        };
      });
      const sv_form_id = (quote.lines.find(l => l.sv_form_id) || {}).sv_form_id || '';
      const r = await fetch('/api/supplier/me/quote-submit?email=' + encodeURIComponent(email), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quote_id: quote.quote_id, sv_form_id, header: hdr, lines }),
      });
      const j = await r.json();
      setSubmitState({ status: 'done', result: j });
    } catch (e) {
      setSubmitState({ status: 'error', error: String(e.message || e) });
    }
  };

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
          <div className="q-batch">
            <span className="q-batch-lbl">⚡ Fill all lines:</span>
            <select value={batch.quote_option} onChange={e => setB({ quote_option: e.target.value })}>
              <option value="">Quote option…</option>
              {QUOTE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
            <input className="q-mini" value={batch.lead_time} onChange={e => setB({ lead_time: e.target.value })} placeholder="Lead time…" />
            <input className="q-mini" value={batch.comments} onChange={e => setB({ comments: e.target.value })} placeholder="Comments…" />
            <button className="q-batch-btn" onClick={applyBatch}>Apply to all</button>
          </div>
          <table className="q-table">
            <thead>
              <tr><th>#</th><th>Item</th><th>Qty</th><th>Weight</th><th>Quote option</th><th>Line total</th><th>Price / lb</th><th>Unit price</th><th>Lead time</th><th>Comments</th></tr>
            </thead>
            <tbody>
              {quote.lines.map(l => (
                <LineRow key={l.rfqs_sent_id} line={l} draft={drafts[l.rfqs_sent_id]} onChange={p => setLine(l.rfqs_sent_id, p)} />
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan="5" className="q-foot-lbl">Grand total ({priced}/{quote.lines.length} priced)</td><td className="q-num q-total">{money(grand)}</td><td colSpan="4"></td></tr>
            </tfoot>
          </table>

          <div className="q-summary">
            <h4>Quote summary</h4>
            <div className="q-grid">
              <label>Supplier location
                <select value={hdr.location} onChange={e => setH({ location: e.target.value })}>
                  <option value="">— select —</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
              <label>Supplier representative
                <select value={hdr.rep} onChange={e => setH({ rep: e.target.value })}>
                  <option value="">— select —</option>
                  {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <label>Your quote #
                <input value={hdr.supplier_quote_number} onChange={e => setH({ supplier_quote_number: e.target.value })} placeholder="Internal quote number" />
              </label>
              <label>Meets MFG requirements
                <select value={hdr.meets_requirements} onChange={e => setH({ meets_requirements: e.target.value })}>
                  <option value="">— select —</option>
                  <option value="YES - Meets All MFG Requirements">Yes</option>
                  <option value="NO - Does Not Meet All MFG Requirements">No</option>
                </select>
              </label>
              <label>Quote valid (business days)
                <input type="number" min="0" value={hdr.valid_days} onChange={e => onValidDays(e.target.value)} placeholder="e.g. 30" />
              </label>
              <label>Valid until
                <input type="date" value={hdr.valid_until} onChange={e => setH({ valid_until: e.target.value })} />
              </label>
              <label>Lead time for ship complete
                <input value={hdr.lead_time} onChange={e => setH({ lead_time: e.target.value })} placeholder="e.g. 2 weeks" />
              </label>
              <label>Shipping amount
                <input type="number" step="0.01" min="0" value={hdr.shipping} onChange={e => setH({ shipping: e.target.value })} placeholder="0.00" />
              </label>
              <label>Miscellaneous amount
                <input type="number" step="0.01" min="0" value={hdr.misc} onChange={e => setH({ misc: e.target.value })} placeholder="0.00" />
              </label>
              <label className="q-grid-wide">Quote requirements
                <div className="q-checks">
                  {reqChoices.map(r => (
                    <label key={r} className="q-check"><input type="checkbox" checked={hdr.requirements.includes(r)} onChange={() => toggleReq(r)} />{r}</label>
                  ))}
                </div>
              </label>
              <label>Internal quote (attachment)
                <input type="file" onChange={e => setH({ attachment_name: e.target.files && e.target.files[0] ? e.target.files[0].name : '' })} />
              </label>
              <label className="q-grid-wide">Notes to buyer
                <textarea rows="2" value={hdr.notes} onChange={e => setH({ notes: e.target.value })} placeholder="Optional notes for the manufacturer" />
              </label>
            </div>

            <div className="q-totals">
              <div><span className="q-tot-lbl">Material</span> {money(grand)}</div>
              <div><span className="q-tot-lbl">+ Shipping</span> {money(parseFloat(hdr.shipping) || 0)}</div>
              <div><span className="q-tot-lbl">+ Misc</span> {money(parseFloat(hdr.misc) || 0)}</div>
              <div className="q-tot-grand"><span className="q-tot-lbl">Total amount</span> {money(totalAmount)}</div>
              <div><span className="q-tot-lbl">Total weight</span> {num(totalWeight, 1)} lb</div>
            </div>
          </div>

          <div className="q-actions">
            <label className="q-ready">
              <input type="checkbox" checked={hdr.ready} onChange={e => setH({ ready: e.target.checked })} />
              Ready for submission
            </label>
            <button className="btn-quote" disabled={submitState && submitState.status === 'saving'} onClick={onSubmit}>
              {submitState && submitState.status === 'saving' ? 'Saving…' : 'Submit quote'}
            </button>
            {submitState && submitState.status === 'done' && (
              <span className={'q-result ' + (submitState.result.ok ? 'q-result-ok' : 'q-result-warn')}>
                {submitState.result.ok
                  ? `Quote submitted (${submitState.result.lines} line${submitState.result.lines === 1 ? '' : 's'}).`
                  : (submitState.result.message || submitState.result.error || 'Submit did not complete.')}
              </span>
            )}
            {submitState && submitState.status === 'error' && <span className="q-result q-result-warn">Error: {submitState.error}</span>}
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
          : shown.map(q => <QuoteCard key={q.quote_id} quote={q} lookups={d.lookups || {}} email={email} />)}
      </section>
    </>
  );
}
