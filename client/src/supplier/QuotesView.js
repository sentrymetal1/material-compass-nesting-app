import React, { useEffect, useState, useCallback } from 'react';

// Unified quote view: ONE card per quote (keyed by Quote_LU), holding both the
// structural/pipe lines (RFQs_Sent → priced by weight) AND the fitting lines
// (RFQs_Sent_Fittings → priced per-each). One "Submit quote" runs both write paths:
// structural → /quote-submit (creates the SV form), fittings → /sent-fitting-rfqs/submit
// (PATCHes the bridge rows). Merged client-side so neither proven backend path changes.
const QUOTE_OPTIONS = ['Quote As Is', 'No Quote', 'Alter Material or Form Detail', 'Alter Quantity', 'Alter Length'];
const FITTING_OPTIONS = ['Quote As Is', 'No Quote'];
// Lead time must be a valid Zoho choice ("N Days") — free text silently blanks the field.
// The server sends the authoritative list via lookups.lead_time_choices; this is the fallback.
const LEAD_TIME_FALLBACK_LIST = ['1 Day'].concat(Array.from({ length: 13 }, (_, i) => (i + 2) + ' Days'));
// Quote valid (business days) — mirrors Zoho Quote_Is_Valid_For; server sends lookups.quote_valid_choices.
const QUOTE_VALID_FALLBACK = [1, 2, 3, 4, 5, 15, 30, 45];

// A lead-time <select> reused by the line rows, batch-fill, and header.
function LeadTimeSelect({ value, disabled, choices, className, blankLabel, onChange }) {
  return (
    <select className={className} value={value || ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">{blankLabel || '—'}</option>
      {(choices && choices.length ? choices : LEAD_TIME_FALLBACK_LIST).map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function money(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function num(n, dp) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp == null ? 2 : dp });
}
const round = (n, dp) => { const f = Math.pow(10, dp); return Math.round(n * f) / f; };
// Format a currency input to 2 decimals on blur ("" stays "" so 'required' still catches blanks).
const fmtMoney2 = v => { const n = parseFloat(v); return isNaN(n) ? '' : n.toFixed(2); };

// Merge the two pipelines into one quote list keyed by quote_id (= Quote_LU).
function mergeQuotes(structuralQuotes, fittingQuotes) {
  const m = new Map();
  const ensure = q => {
    if (!m.has(q.quote_id)) {
      m.set(q.quote_id, {
        quote_id: q.quote_id,
        quote_number: q.quote_number || '',
        quote_description: q.quote_description || '',
        manufacturer: q.manufacturer || '',
        status: q.status || '',
        structural_lines: [],
        fitting_lines: [],
      });
    }
    return m.get(q.quote_id);
  };
  for (const q of structuralQuotes || []) {
    const e = ensure(q);
    e.structural_lines = q.lines || [];
    e.quote_number = e.quote_number || q.quote_number || '';
    e.quote_description = e.quote_description || q.quote_description || '';
    e.manufacturer = e.manufacturer || q.manufacturer || '';
    e.status = e.status || q.status || '';
  }
  for (const q of fittingQuotes || []) {
    const e = ensure(q);
    e.fitting_lines = q.lines || [];
    if (!e.quote_number) e.quote_number = q.quote_number || '';
    if (!e.quote_description) e.quote_description = q.quote_description || '';
    if (!e.manufacturer) e.manufacturer = q.manufacturer || '';
    if (!e.status) e.status = q.status || '';
  }
  return [...m.values()];
}

// One structural line — supplier edits EITHER Line Total OR Price/lb (each recalcs the
// other via line weight); unit price stays derived (total ÷ qty).
function LineRow({ line, draft, onChange, leadChoices }) {
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
      <td><LeadTimeSelect className="q-mini" value={draft.lead_time} disabled={noQuote} choices={leadChoices} onChange={v => onChange({ lead_time: v })} /></td>
      <td><input className="q-mini" value={draft.comments} disabled={noQuote} placeholder="—" onChange={e => onChange({ comments: e.target.value })} /></td>
    </tr>
  );
}

// One fitting line — priced PER-EACH (total = unit × qty).
function FittingLineRow({ line, draft, onChange, leadChoices }) {
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
          {FITTING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
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
      <td><LeadTimeSelect className="q-mini" value={draft.lead_time} disabled={noQuote} choices={leadChoices} onChange={v => onChange({ lead_time: v })} /></td>
      <td><input className="q-mini" value={draft.comments} disabled={noQuote} placeholder="—" onChange={e => onChange({ comments: e.target.value })} /></td>
    </tr>
  );
}

function QuoteCard({ quote, lookups, email, revise }) {
  const hasStruct = quote.structural_lines.length > 0;
  const hasFit = quote.fitting_lines.length > 0;
  const [open, setOpen] = useState(false);
  const [submitState, setSubmitState] = useState(null); // {status, structResult, fitResult, error}

  // structural drafts keyed by rfqs_sent_id
  const [drafts, setDrafts] = useState(() => {
    const d = {};
    quote.structural_lines.forEach(l => { d[l.rfqs_sent_id] = { total_price: l.total_price || '', price_per_lb: l.price_per_lb || '', quote_option: l.quote_option || 'Quote As Is', lead_time: '', comments: '' }; });
    return d;
  });
  const setLine = (id, patch) => setDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  // fitting drafts keyed by rfq_row_id
  const [fitDrafts, setFitDrafts] = useState(() => {
    const d = {};
    quote.fitting_lines.forEach(l => { d[l.rfq_row_id] = { unit_price: l.unit_price != null ? String(l.unit_price) : '', quote_option: l.quote_option || 'Quote As Is', lead_time: l.lead_time || '', comments: l.comments || '' }; });
    return d;
  });
  const setFit = (id, patch) => setFitDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  // Batch-fill (structural lines).
  const [batch, setBatch] = useState({ quote_option: '', lead_time: '', comments: '' });
  const setB = patch => setBatch(p => ({ ...p, ...patch }));
  const applyBatch = () => setDrafts(prev => {
    const next = { ...prev };
    quote.structural_lines.forEach(l => {
      const d = { ...next[l.rfqs_sent_id] };
      if (batch.quote_option) d.quote_option = batch.quote_option;
      if (batch.lead_time !== '') d.lead_time = batch.lead_time;
      if (batch.comments !== '') d.comments = batch.comments;
      next[l.rfqs_sent_id] = d;
    });
    return next;
  });

  // Quote-level header / summary (drives the structural SV-form submit).
  const [hdr, setHdr] = useState({
    supplier_quote_number: '', meets_requirements: '', shipping: '', misc: '',
    valid_days: '', valid_until: '', lead_time: '', notes: '', ready: false,
    location: '', rep: '',
    // Prepopulate the supplier's requirements from the MFG's quote requirements (they're
    // confirming the manufacturer's requirements). Backend supplies quote.mfg_requirements.
    requirements: Array.isArray(quote.mfg_requirements) ? quote.mfg_requirements : [],
    attachment_name: '',
  });
  const setH = patch => setHdr(p => ({ ...p, ...patch }));
  const onValidDays = v => {
    const n = parseInt(v, 10);
    let until = hdr.valid_until;
    if (n > 0) {
      const dt = new Date(); dt.setDate(dt.getDate() + n);
      while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() + 1); // Valid Until allows Mon-Fri only
      until = dt.toISOString().slice(0, 10);
    }
    setH({ valid_days: v, valid_until: until });
  };
  const locations = (lookups && lookups.locations) || [];
  const reps = (lookups && lookups.reps) || [];
  // Only show the requirements the MFG actually requested for THIS quote (not the full
  // 15-option catalog). The supplier confirms which of those they meet.
  const mfgReqs = Array.isArray(quote.mfg_requirements) ? quote.mfg_requirements : [];
  const leadChoices = (lookups && lookups.lead_time_choices) || LEAD_TIME_FALLBACK_LIST;
  const quoteValidChoices = (lookups && lookups.quote_valid_choices) || QUOTE_VALID_FALLBACK;

  const structGrand = quote.structural_lines.reduce((sum, l) => {
    const dr = drafts[l.rfqs_sent_id] || {};
    if (dr.quote_option === 'No Quote') return sum;
    return sum + (parseFloat(dr.total_price) || 0);
  }, 0);
  const fitGrand = quote.fitting_lines.reduce((sum, l) => {
    const dr = fitDrafts[l.rfq_row_id] || {};
    if (dr.quote_option === 'No Quote') return sum;
    return sum + (parseFloat(dr.unit_price) || 0) * (Number(l.qty) || 0);
  }, 0);
  const grand = structGrand + fitGrand;
  const structPriced = quote.structural_lines.filter(l => parseFloat((drafts[l.rfqs_sent_id] || {}).total_price) > 0).length;
  const fitPriced = quote.fitting_lines.filter(l => {
    const dr = fitDrafts[l.rfq_row_id] || {};
    return dr.quote_option === 'No Quote' || (parseFloat(dr.unit_price) || 0) > 0;
  }).length;
  const totalWeight = quote.structural_lines.reduce((s, l) => {
    const dr = drafts[l.rfqs_sent_id] || {};
    if (dr.quote_option === 'No Quote') return s;
    return s + (Number(l.qty) || 0) * (Number(l.unit_weight) || 0);
  }, 0);
  const totalAmount = grand + (parseFloat(hdr.shipping) || 0) + (parseFloat(hdr.misc) || 0);

  // Quote-summary fields the supplier MUST complete before submitting (structural quotes).
  // Attachment + Notes stay optional. Shipping/Misc are required but "0" is a valid entry.
  const REQUIRED_FIELDS = [
    ['location', 'Supplier location'],
    ['rep', 'Supplier representative'],
    ['supplier_quote_number', 'Your quote #'],
    ['meets_requirements', 'Meets MFG requirements'],
    ['valid_days', 'Quote valid (business days)'],
    ['valid_until', 'Valid until'],
    ['lead_time', 'Lead time for ship complete'],
    ['shipping', 'Shipping amount'],
    ['misc', 'Miscellaneous amount'],
  ];
  const missingFields = hasStruct
    ? REQUIRED_FIELDS.filter(([k]) => String(hdr[k] == null ? '' : hdr[k]).trim() === '').map(([, lbl]) => lbl)
    : [];

  const onSubmit = async () => {
    if (missingFields.length) {
      setSubmitState({ status: 'error', error: 'Please complete all required fields: ' + missingFields.join(', ') + '.' });
      return;
    }
    setSubmitState({ status: 'saving' });
    try {
      let structResult = null, fitResult = null;

      if (hasStruct) {
        const lines = quote.structural_lines.map(l => {
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
        const sv_form_id = (quote.structural_lines.find(l => l.sv_form_id) || {}).sv_form_id || '';
        const r = await fetch('/api/supplier/me/quote-submit?email=' + encodeURIComponent(email), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quote_id: quote.quote_id, sv_form_id, header: hdr, lines }),
        });
        structResult = await r.json();
      }

      if (hasFit) {
        const lines = quote.fitting_lines.map(l => {
          const d = fitDrafts[l.rfq_row_id] || {};
          return {
            rfq_row_id: l.rfq_row_id,
            quote_option: d.quote_option || 'Quote As Is',
            unit_price: d.quote_option === 'No Quote' ? 0 : (parseFloat(d.unit_price) || 0),
            lead_time: d.lead_time || '', comments: d.comments || '',
          };
        });
        const r = await fetch('/api/supplier/me/sent-fitting-rfqs/submit?email=' + encodeURIComponent(email), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }),
        });
        fitResult = await r.json();
      }

      setSubmitState({ status: 'done', structResult, fitResult });
    } catch (e) {
      setSubmitState({ status: 'error', error: String(e.message || e) });
    }
  };

  // Combined submit result message.
  let resultNode = null;
  if (submitState && submitState.status === 'done') {
    const sr = submitState.structResult, fr = submitState.fitResult;
    const sOk = !sr || sr.ok, fOk = !fr || fr.ok;
    const ok = sOk && fOk;
    const parts = [];
    if (sr) parts.push(sr.ok ? `${sr.lines != null ? sr.lines : quote.structural_lines.length} structural` : ('structural failed' + (sr.message || sr.error ? ': ' + (sr.message || sr.error) : '')));
    if (fr) parts.push(fr.ok ? `${fr.saved != null ? fr.saved : quote.fitting_lines.length} fitting` : `fitting failed (${fr.saved || 0}/${(fr.saved || 0) + (fr.failed || 0)})`);
    resultNode = <span className={'q-result ' + (ok ? 'q-result-ok' : 'q-result-warn')}>{(ok ? 'Quote submitted — ' : 'Partial submit — ') + parts.join(', ') + ' line' + (parts.length ? 's' : '') + '.'}</span>;
  } else if (submitState && submitState.status === 'error') {
    resultNode = <span className="q-result q-result-warn">Error: {submitState.error}</span>;
  }

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
          {hasStruct && <span className="chip">{quote.structural_lines.length} structural</span>}
          {hasFit && <span className="chip">{quote.fitting_lines.length} fitting</span>}
          {grand > 0 && <span className="chip chip-status">{money(grand)}</span>}
        </div>
      </div>
      {open && (
        <div className="q-body">
          {hasStruct && (
            <>
              {hasFit && <div className="q-section-label">Structural / Pipe</div>}
              <div className="q-batch">
                <span className="q-batch-lbl">⚡ Fill all lines:</span>
                <select value={batch.quote_option} onChange={e => setB({ quote_option: e.target.value })}>
                  <option value="">Quote option…</option>
                  {QUOTE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                <LeadTimeSelect className="q-mini" value={batch.lead_time} choices={leadChoices} blankLabel="Lead time…" onChange={v => setB({ lead_time: v })} />
                <input className="q-mini" value={batch.comments} onChange={e => setB({ comments: e.target.value })} placeholder="Comments…" />
                <button className="q-batch-btn" onClick={applyBatch}>Apply to all</button>
              </div>
              <table className="q-table">
                <thead>
                  <tr><th>#</th><th>Item</th><th>Qty</th><th>Weight</th><th>Quote option</th><th>Line total</th><th>Price / lb</th><th>Unit price</th><th>Lead time</th><th>Comments</th></tr>
                </thead>
                <tbody>
                  {quote.structural_lines.map(l => (
                    <LineRow key={l.rfqs_sent_id} line={l} draft={drafts[l.rfqs_sent_id]} onChange={p => setLine(l.rfqs_sent_id, p)} leadChoices={leadChoices} />
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan="5" className="q-foot-lbl">Structural total ({structPriced}/{quote.structural_lines.length} priced)</td><td className="q-num q-total">{money(structGrand)}</td><td colSpan="4"></td></tr>
                </tfoot>
              </table>
            </>
          )}

          {hasFit && (
            <>
              <div className="q-section-label">Fittings <span className="muted">— priced per-each (total = unit × qty)</span></div>
              <table className="q-table">
                <thead>
                  <tr><th>#</th><th>Fitting</th><th>Qty</th><th>Option</th><th>Unit Price</th><th>Line Total</th><th>Lead Time</th><th>Comments</th></tr>
                </thead>
                <tbody>
                  {quote.fitting_lines.map(l => (
                    <FittingLineRow key={l.rfq_row_id} line={l} draft={fitDrafts[l.rfq_row_id]} onChange={p => setFit(l.rfq_row_id, p)} leadChoices={leadChoices} />
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan="4" className="q-foot-lbl">Fittings total ({fitPriced}/{quote.fitting_lines.length} priced)</td><td className="q-num q-total">{money(fitGrand)}</td><td colSpan="3"></td></tr>
                </tfoot>
              </table>
            </>
          )}

          {hasStruct && (
            <div className="q-summary">
              <h4>Quote summary</h4>

              <div className="q-req-panel">
                <div className="q-req-panel-head">MFG Requirements <span className="q-req-note">— set by the manufacturer</span></div>
                <div className="q-req-panel-body">
                  <div className="q-req-panel-reqs">
                    {mfgReqs.length > 0 ? (
                      <div className="q-req-pills">
                        {mfgReqs.map(r => <span key={r} className="q-req-pill">{r}</span>)}
                      </div>
                    ) : (
                      <div className="q-reqs-none">No specific requirements requested by the manufacturer.</div>
                    )}
                  </div>
                  <div className="q-req-panel-meets">
                    <span className="q-meets-lbl">Does your quote meet these?<span className="req-star">*</span></span>
                    <div className="q-seg">
                      <button type="button"
                        className={'q-seg-btn' + (hdr.meets_requirements === 'YES - Meets All MFG Requirements' ? ' q-seg-on q-seg-yes' : '')}
                        onClick={() => setH({ meets_requirements: 'YES - Meets All MFG Requirements' })}>Yes — meets all</button>
                      <button type="button"
                        className={'q-seg-btn' + (hdr.meets_requirements === 'NO - Does Not Meet All MFG Requirements' ? ' q-seg-on q-seg-no' : '')}
                        onClick={() => setH({ meets_requirements: 'NO - Does Not Meet All MFG Requirements' })}>No — does not meet all</button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="q-grid">
                <label>Supplier location<span className="req-star">*</span>
                  <select value={hdr.location} onChange={e => setH({ location: e.target.value })}>
                    <option value="">— select —</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
                <label>Supplier representative<span className="req-star">*</span>
                  <select value={hdr.rep} onChange={e => setH({ rep: e.target.value })}>
                    <option value="">— select —</option>
                    {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
                <label>Your quote #<span className="req-star">*</span>
                  <input value={hdr.supplier_quote_number} onChange={e => setH({ supplier_quote_number: e.target.value })} placeholder="Internal quote number" />
                </label>
                <label>Quote valid (business days)<span className="req-star">*</span>
                  <select value={hdr.valid_days} onChange={e => onValidDays(e.target.value)}>
                    <option value="">— select —</option>
                    {quoteValidChoices.map(n => <option key={n} value={n}>{n} {n === 1 ? 'day' : 'days'}</option>)}
                  </select>
                </label>
                <label>Valid until<span className="req-star">*</span>
                  <input type="date" value={hdr.valid_until} onChange={e => setH({ valid_until: e.target.value })} />
                </label>
                <label>Lead time for ship complete<span className="req-star">*</span>
                  <LeadTimeSelect value={hdr.lead_time} choices={leadChoices} blankLabel="— select —" onChange={v => setH({ lead_time: v })} />
                </label>
                <label>Shipping amount<span className="req-star">*</span>
                  <div className="q-money-in">
                    <span className="q-dollar">$</span>
                    <input type="text" inputMode="decimal" value={hdr.shipping} placeholder="0.00"
                      onChange={e => setH({ shipping: e.target.value })}
                      onBlur={e => setH({ shipping: fmtMoney2(e.target.value) })} />
                  </div>
                </label>
                <label>Miscellaneous amount<span className="req-star">*</span>
                  <div className="q-money-in">
                    <span className="q-dollar">$</span>
                    <input type="text" inputMode="decimal" value={hdr.misc} placeholder="0.00"
                      onChange={e => setH({ misc: e.target.value })}
                      onBlur={e => setH({ misc: fmtMoney2(e.target.value) })} />
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
          )}

          {!hasStruct && hasFit && (
            <div className="q-totals">
              <div className="q-tot-grand"><span className="q-tot-lbl">Fittings total</span> {money(fitGrand)}</div>
            </div>
          )}

          {revise && (
            <div className="q-revise-note">Re-pricing creates a new revision — your current quote will be marked <strong>Revised</strong> and replaced by this one.</div>
          )}
          <div className="q-actions">
            {hasStruct && (
              <label className="q-ready">
                <input type="checkbox" checked={hdr.ready} onChange={e => setH({ ready: e.target.checked })} />
                Ready for submission
              </label>
            )}
            <button className="btn-quote" disabled={submitState && submitState.status === 'saving'} onClick={onSubmit}>
              {submitState && submitState.status === 'saving' ? 'Submitting…' : (revise ? 'Submit revision' : 'Submit quote')}
            </button>
            {resultNode}
            {hasStruct && missingFields.length > 0 && !resultNode && (
              <span className="q-missing">Required: {missingFields.join(', ')}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function QuotesView({ email }) {
  const [state, setState] = useState({ status: 'loading', quotes: [], lookups: {}, error: null });
  const [tab, setTab] = useState('open');

  const load = useCallback(async () => {
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const [rfqsR, fitR] = await Promise.all([
        fetch('/api/supplier/me/rfqs?email=' + encodeURIComponent(email)).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) })),
        fetch('/api/supplier/me/sent-fitting-rfqs?email=' + encodeURIComponent(email)).then(r => r.json()).catch(() => ({ ok: false })),
      ]);
      // Structural is primary; fittings degrades gracefully (a fittings outage shouldn't blank the page).
      if (!rfqsR || !rfqsR.ok) {
        if (!fitR || !fitR.ok) { setState({ status: 'error', quotes: [], lookups: {}, error: (rfqsR && rfqsR.error) || 'Could not load quotes' }); return; }
      }
      const structuralQuotes = (rfqsR && rfqsR.ok) ? (rfqsR.quotes || []) : [];
      const fittingQuotes = (fitR && fitR.ok) ? (fitR.quotes || []) : [];
      const quotes = mergeQuotes(structuralQuotes, fittingQuotes);
      const lookups = (rfqsR && rfqsR.lookups) || {};
      setState({ status: 'ready', quotes, lookups, error: null });
    } catch (e) {
      setState({ status: 'error', quotes: [], lookups: {}, error: String(e.message || e) });
    }
  }, [email]);
  useEffect(() => { load(); }, [load]);

  if (state.status === 'loading') return <div className="sup-msg">Loading your RFQs…</div>;
  if (state.status === 'error') return <div className="sup-msg sup-msg-error">Couldn’t load RFQs: {state.error} <button className="btn-link" onClick={load}>Retry</button></div>;

  // "Responded" = any structural OR fitting line carries a response (Item_Verification_Status).
  const responded = q =>
    q.structural_lines.some(l => l.quote_option && String(l.quote_option).trim() !== '') ||
    q.fitting_lines.some(l => l.quote_option && String(l.quote_option).trim() !== '');
  // Bucket every quote; unknown/in-process statuses fall back to open/submitted so a
  // fittings-only quote (status "In Process") still shows up.
  const bucketOf = q => {
    const s = q.status || '';
    if (/Sourcing|Purchase Order|Award/i.test(s)) return 'awarded';
    if (/^Closed|Cancel/i.test(s)) return 'closed';
    return responded(q) ? 'submitted' : 'open';
  };
  const buckets = { open: [], submitted: [], awarded: [], closed: [] };
  state.quotes.forEach(q => { const b = bucketOf(q); if (b) buckets[b].push(q); });

  const TABS = [['open', 'New / Open'], ['submitted', 'Submitted'], ['awarded', 'Awarded'], ['closed', 'Closed']];
  const SUBHEAD = {
    open: 'price the lines you can fill',
    submitted: 'awaiting the manufacturer; expand to revise',
    awarded: 'sourcing in progress',
    closed: 'completed or cancelled',
  };
  const list = buckets[tab] || [];
  const readOnly = tab === 'awarded' || tab === 'closed';

  return (
    <>
      <div className="q-tiles">
        {TABS.map(([k, lbl]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={'q-tile q-tile-' + k + (tab === k ? ' q-tile-active' : '')}>
            <div className="count-num">{buckets[k].length}</div><div className="count-lbl">{lbl}</div>
          </button>
        ))}
      </div>
      <section className="sup-section">
        <h2>{TABS.find(t => t[0] === tab)[1]} <span className="muted">— {SUBHEAD[tab]}</span></h2>
        {list.length === 0
          ? <div className="sup-empty">Nothing here right now.</div>
          : list.map(q => readOnly
            ? (
              <div key={q.quote_id} className="q-card q-card-ro">
                <div className="q-head">
                  <div className="q-head-main"><strong>Quote {q.quote_number}</strong><span className="q-head-desc">{q.quote_description}</span></div>
                  <div className="q-head-meta">
                    {q.manufacturer && <span className="chip">{q.manufacturer}</span>}
                    {q.structural_lines.length > 0 && <span className="chip">{q.structural_lines.length} structural</span>}
                    {q.fitting_lines.length > 0 && <span className="chip">{q.fitting_lines.length} fitting</span>}
                  </div>
                </div>
              </div>
            )
            : <QuoteCard key={q.quote_id} quote={q} lookups={state.lookups || {}} email={email} revise={tab === 'submitted'} />)}
      </section>
    </>
  );
}
