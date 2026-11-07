import React, { useEffect, useRef, useState, useCallback } from 'react';

// Unified quote view: ONE card per quote (keyed by Quote_LU), holding both the
// structural/pipe lines (RFQs_Sent → priced by weight) AND the fitting lines
// (RFQs_Sent_Fittings → priced per-each). One "Submit quote" runs both write paths:
// structural → /quote-submit (creates the SV form), fittings → /sent-fitting-rfqs/submit
// (PATCHes the bridge rows). Merged client-side so neither proven backend path changes.
const QUOTE_OPTIONS = ['Quote As Is', 'No Quote', 'Alter Material or Form Detail', 'Alter Quantity', 'Alter Length'];
const FITTING_OPTIONS = ['Quote As Is', 'No Quote'];
// The "Alter …" quote options already flow to Zoho as SVD_Item_Verification_Status; each
// one now reveals the editor for WHAT it changes. One kind per line — that's the shape of
// Item_Verification_Status (a single choice), not a UI limitation we invented.
const ALTER_KIND = {
  'Alter Length': 'length',
  'Alter Quantity': 'quantity',
  'Alter Material or Form Detail': 'spec',
};
// Lead time must be a valid Zoho choice ("N Days") — free text silently blanks the field.
// The server sends the authoritative list via lookups.lead_time_choices; this is the fallback.
const LEAD_TIME_FALLBACK_LIST = ['1 Day'].concat(Array.from({ length: 13 }, (_, i) => (i + 2) + ' Days'));
// Quote valid (business days) — mirrors Zoho Quote_Is_Valid_For; server sends lookups.quote_valid_choices.
const QUOTE_VALID_FALLBACK = [1, 2, 3, 4, 5, 15, 30, 45];
// Per-line Item Requirements (SVD multi-select). Server sends lookups.item_requirements_choices.
const ITEM_REQ_FALLBACK = ['Cut To Size', 'Laser Cut', 'Plasma Cut', 'Random Drop', 'See Attached File', 'See Notes', 'Stock Size', 'Sufficient To Cut', 'Water Jet Cut'];

// Editable multi-select for a line's item requirements: selected values as removable
// chips + an "add" dropdown. Pre-filled with the MFG's requirement for that line.
function ItemReqEditor({ value, options, onChange }) {
  const selected = Array.isArray(value) ? value : [];
  const avail = (options || []).filter(o => !selected.includes(o));
  return (
    <div className="q-ireq">
      {selected.map(r => (
        <span key={r} className="q-ireq-chip">{r}
          <button type="button" title="Remove" onClick={() => onChange(selected.filter(x => x !== r))}>×</button>
        </span>
      ))}
      {avail.length > 0 && (
        <select className="q-ireq-add" value="" onChange={e => { if (e.target.value) onChange([...selected, e.target.value]); }}>
          <option value="">+ requirement…</option>
          {avail.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
    </div>
  );
}

// Build the alteration request for a line from its draft, or null when nothing to send.
// Only the field matching the chosen "Alter …" option is sent — the server treats an
// omitted key as "unchanged".
function alterationBody(draft, kind) {
  if (kind === 'length') {
    const ft = parseFloat(draft.alt_length_ft), inch = parseFloat(draft.alt_length_inch);
    if (!Number.isFinite(ft) && !Number.isFinite(inch)) return null;
    return { length_ft: Number.isFinite(ft) ? ft : 0, length_inch: Number.isFinite(inch) ? inch : 0 };
  }
  if (kind === 'quantity') {
    const q = parseFloat(draft.alt_quantity);
    return Number.isFinite(q) ? { quantity: q } : null;
  }
  if (kind === 'spec') return draft.alt_spec_id ? { spec_id: draft.alt_spec_id } : null;
  return null;
}

// The inline editor shown when a line's quote option is "Alter …". Every value the
// supplier types is priced by the SERVER (/line-preview) — the client never computes a
// weight or a description, so what's previewed here is exactly what submit will write.
function AlterEditor({ line, draft, kind, specOptions, ep, onChange }) {
  const meta = line.alteration || {};
  const seq = React.useRef(0);
  const body = alterationBody(draft, kind);
  const bodyKey = JSON.stringify(body);   // stable dep: refetch only when values change

  useEffect(() => {
    if (!body) { onChange({ preview: null, preview_error: '', previewing: false }); return undefined; }
    // Already priced for exactly these values (a reopened saved quote): don't ask again.
    if (draft.preview && draft.preview_key === bodyKey) return undefined;
    const mine = ++seq.current;
    onChange({ previewing: true });
    const t = setTimeout(async () => {
      try {
        const r = await fetch(ep('line-preview'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rfqs_sent_id: line.rfqs_sent_id, ...body }),
        });
        const j = await r.json();
        // A slower earlier request must never clobber a newer one.
        if (mine !== seq.current) return;
        if (r.ok && j.ok) onChange({ preview: j.preview, preview_key: bodyKey, preview_error: '', previewing: false });
        else onChange({ preview: null, preview_error: j.error || 'Could not price this change.', previewing: false });
      } catch (e) {
        if (mine === seq.current) onChange({ preview: null, preview_error: String(e.message || e), previewing: false });
      }
    }, 350);
    return () => clearTimeout(t);
    // Keyed on bodyKey (the serialized values), NOT `body`/`onChange` — those are new
    // objects every render and would re-fire the fetch forever.
  }, [bodyKey, line.rfqs_sent_id]);   // eslint-disable-line

  // Length on a line with no per-foot weight can't be repriced — say why rather than
  // silently disable. (Some rows carry a good Unit_Weight with blank inputs.)
  if (kind === 'length' && !meta.can_alter_length) {
    return (
      <div className="q-alter q-alter-blocked">
        This line has no per-foot weight on file, so a new length can’t be priced automatically.
        Please use Comments to propose a length, or choose a different quote option.
      </div>
    );
  }

  return (
    <div className="q-alter">
      {kind === 'length' && (
        <label className="q-alter-f">New length
          <input type="number" min="0" step="1" className="q-alter-n" placeholder={String(meta.length_ft ?? 0)}
            value={draft.alt_length_ft ?? ''} onChange={e => onChange({ alt_length_ft: e.target.value })} />
          <span className="q-alter-u">ft</span>
          <input type="number" min="0" max="11.99" step="0.0625" className="q-alter-n" placeholder={String(meta.length_inch ?? 0)}
            value={draft.alt_length_inch ?? ''} onChange={e => onChange({ alt_length_inch: e.target.value })} />
          <span className="q-alter-u">in</span>
        </label>
      )}
      {/* Quantity is typed straight into the Qty column. */}
      {kind === 'spec' && (
        <label className="q-alter-f">New specification
          <select value={draft.alt_spec_id || ''} onChange={e => onChange({ alt_spec_id: e.target.value })}>
            <option value="">— keep {specOptions.find(o => o.id === meta.spec_id)?.label || 'current'} —</option>
            {specOptions.filter(o => o.id !== meta.spec_id).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
      )}
      {draft.previewing && <span className="q-alter-msg muted">pricing…</span>}
      {!draft.previewing && draft.preview_error && <span className="q-alter-msg q-alter-err">{draft.preview_error}</span>}
      {!draft.previewing && !draft.preview_error && draft.preview && (
        <span className="q-alter-msg q-alter-ok">→ {draft.preview.description} · {num(draft.preview.unit_weight, 2)} lb/ea</span>
      )}
      {!body && !draft.previewing && <span className="q-alter-msg muted">{kind === 'quantity' ? 'Type the new quantity in the Qty column.' : 'Enter a value to reprice this line.'}</span>}
    </div>
  );
}

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
// The line as currently quoted: the MFG's line, with the server's priced preview folded
// over it when the supplier has altered it. EVERY qty/weight/description read goes through
// this — reading l.qty directly on an altered line is how the row and the quote totals
// drift apart. Only a preview that actually changed something counts as altered.
function effLine(line, draft) {
  const p = draft && draft.preview;
  if (!p) return line;
  const changed = p.changed && (p.changed.length || p.changed.quantity || p.changed.spec);
  if (!changed) return line;
  return { ...line, qty: p.quantity, unit_weight: p.unit_weight, description: p.description, altered: true };
}
// A line's draft rebuilt from the quote as last saved (server's copy — see
// saveQuoteSnapshot). The saved preview comes along keyed to its alteration, so the
// editor shows it without asking the server to price the line again.
function savedDraft(s) {
  const d = {
    total_price: s.quote_option === 'No Quote' ? '' : (s.total_price ? Number(s.total_price).toFixed(2) : ''),
    price_per_lb: s.price_per_lb || '',
    quote_option: s.quote_option || 'Quote As Is',
    lead_time: s.lead_time || '', comments: s.comments || '',
    item_requirements: Array.isArray(s.item_requirements) ? s.item_requirements : [],
  };
  const a = s.alteration;
  if (a) {
    if (a.quantity != null) d.alt_quantity = String(a.quantity);
    if (a.length_ft != null) d.alt_length_ft = String(a.length_ft);
    if (a.length_inch != null) d.alt_length_inch = String(a.length_inch);
    if (a.spec_id) d.alt_spec_id = String(a.spec_id);
    const body = alterationBody(d, ALTER_KIND[d.quote_option] || null);
    if (s.preview && body) { d.preview = s.preview; d.preview_key = JSON.stringify(body); }
  }
  return d;
}
function savedHeader(saved) {
  const h = saved && saved.header;
  if (!h) return {};
  const keep = ['supplier_quote_number', 'meets_requirements', 'shipping', 'misc', 'valid_days', 'valid_until',
    'lead_time', 'notes', 'ready', 'location', 'rep', 'requirements'];
  const out = {};
  keep.forEach(k => { if (h[k] !== undefined && h[k] !== null) out[k] = h[k]; });
  // An auto-numbered save shows blank, so it isn't mistaken for the supplier's own number.
  if (/^AUTO-/.test(String(out.supplier_quote_number || ''))) out.supplier_quote_number = '';
  return out;
}
// Format a currency input to 2 decimals on blur ("" stays "" so 'required' still catches blanks).
const fmtMoney2 = v => { const n = parseFloat(v); return isNaN(n) ? '' : n.toFixed(2); };

// Merge the two pipelines into one quote list keyed by quote_id (= Quote_LU).
export function mergeQuotes(structuralQuotes, fittingQuotes) {
  const m = new Map();
  const ensure = q => {
    if (!m.has(q.quote_id)) {
      m.set(q.quote_id, {
        quote_id: q.quote_id,
        quote_number: q.quote_number || '',
        quote_description: q.quote_description || '',
        manufacturer: q.manufacturer || '',
        status: q.status || '',
        // quote-level fields from the structural pipeline — preserve them through the merge
        mfg_requirements: Array.isArray(q.mfg_requirements) ? q.mfg_requirements : [],
        files: Array.isArray(q.files) ? q.files : [],
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
    if (Array.isArray(q.mfg_requirements) && q.mfg_requirements.length) e.mfg_requirements = q.mfg_requirements;
    if (Array.isArray(q.files) && q.files.length) e.files = q.files;
    if (q.saved) e.saved = q.saved;   // the quote as last saved (server's disk copy)
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

// What auto-fill did to one line: the quote row it was read from, and anything that needs a
// person to look (not on the quote, a total that doesn't reconcile, an unsure match).
function AutofillMark({ mark }) {
  // A supplier reading their own quote gets the changes listed once above the lines, not a
  // note under every row (mark.quiet). The row colour still shows which lines changed.
  if (!mark || mark.quiet) return null;
  return (
    <div className="q-af-mark">
      {mark.found && mark.pdf_text && <div className="q-af-src" title="Read from the supplier's quote">📄 {mark.pdf_text}</div>}
      {(mark.flags || []).map((f, i) => <div key={i} className="q-af-flag">⚠ {f}</div>)}
    </div>
  );
}
// The row number. After auto-fill it is the SUPPLIER's quote line, so the card reads beside
// their PDF; a line they didn't quote gets none. Our RFQ line stays underneath: it is the
// key RFQs_Sent, allocation and the PO join on, and it never changes. The supplier's number
// is display only, since it differs per supplier and can change in a revised quote.
function LineNoCell({ line, mark }) {
  if (!mark) return <td className="q-ln-cell"><span className="q-ln">{line.line}</span></td>;
  const sup = mark.found && mark.pdf_line != null ? mark.pdf_line : null;
  return (
    <td className="q-ln-cell">
      {sup != null ? <span className="q-ln q-ln-sup" title="Supplier's quote line">{sup}</span> : <span className="q-ln q-ln-none" title="Not priced on its own line of the supplier's quote">–</span>}
      <div className="q-ln-rfq" title="Your RFQ line — used for allocation">RFQ {line.line}</div>
    </td>
  );
}
const afRowClass = mark => (!mark ? '' : !mark.found ? ' q-af-skip' : (mark.flags && mark.flags.length ? ' q-af-warn' : ' q-af-ok'));

// A money/rate box that reads "4,946.06" at rest and edits as the plain number. The draft
// always holds the bare number (commas stripped), so every calculation is unchanged.
function NumInput({ value, onChange, minDp, maxDp, disabled, placeholder }) {
  const [focus, setFocus] = useState(false);
  const n = parseFloat(value);
  const shown = focus || value == null || value === '' || isNaN(n)
    ? (value ?? '')
    : n.toLocaleString('en-US', { minimumFractionDigits: minDp, maximumFractionDigits: maxDp });
  return (
    <input type="text" inputMode="decimal" value={shown} disabled={disabled} placeholder={placeholder}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      onChange={e => onChange(e.target.value.replace(/[,$\s]/g, ''))} />
  );
}

// Read a chosen file as bare base64 (no data: prefix).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
}

// The server rebuilds an altered description with an "Item No N |" prefix the list strips; compare
// (and show) without it, or a qty-only change looks like a different item.
const descKey = d => String(d || '').replace(/^\s*(Item No \d+\s*)?\|?\s*/i, '').trim();

// One structural line — supplier edits EITHER Line Total OR Price/lb (each recalcs the
// other via line weight); unit price stays derived (total ÷ qty).
function LineRow({ line, draft, onChange, leadChoices, itemReqChoices, specOptions, ep, mark }) {
  const kind = ALTER_KIND[draft.quote_option] || null;
  // An altered line prices against its NEW qty/weight — effLine folds the server's
  // preview over the original so the row, the pricing math and the quote totals can
  // never disagree about what's being quoted.
  const eff = effLine(line, draft);
  const qty = Number(eff.qty) || 0;
  const totalWeight = qty * (Number(eff.unit_weight) || 0);
  const noQuote = draft.quote_option === 'No Quote';
  const lineTotal = !noQuote ? (parseFloat(draft.total_price) || 0) : 0;
  const unitPrice = qty > 0 ? lineTotal / qty : 0;

  // A typed total or $/lb is the new price; forget any basis auto-fill brought in.
  const onTotal = v => {
    const t = parseFloat(v);
    const ppl = totalWeight > 0 && t > 0 ? round(t / totalWeight, 5) : '';
    onChange({ total_price: v, price_per_lb: ppl === '' ? '' : String(ppl), basis: null });
  };
  const onPpl = v => {
    const p = parseFloat(v);
    const tot = p > 0 ? round(p * totalWeight, 2) : '';
    onChange({ price_per_lb: v, total_price: tot === '' ? '' : String(tot), basis: null });
  };

  // Editable qty = an "Alter Quantity" on this line; the server reprices the weight (via
  // AlterEditor's preview) and the effect below reprices the total from the line's basis.
  // A length/spec alteration owns the line (one alteration kind per line), so qty locks.
  const qtyLocked = kind === 'length' || kind === 'spec' || noQuote;
  const onQty = v => {
    const patch = {};
    if (!draft.basis) {
      // Typed prices: hold the price per piece steady across the qty change.
      const t = parseFloat(draft.total_price);
      if (t > 0 && qty > 0) patch.basis = { price: t / qty, basis: 'each' };
    }
    const n = parseFloat(v);
    if (Number.isFinite(n) && n === Number(line.qty)) onChange({ ...patch, quote_option: 'Quote As Is', alt_quantity: '', preview: null, preview_error: '' });
    else onChange({ ...patch, quote_option: 'Alter Quantity', alt_quantity: v });
  };
  // Reprice when qty OR weight moves (a spec swap changes weight with the qty unchanged).
  const lastQty = useRef(qty + '|' + totalWeight);
  useEffect(() => {
    if (lastQty.current === qty + '|' + totalWeight) return;
    lastQty.current = qty + '|' + totalWeight;
    const b = draft.basis;
    if (!b || noQuote || !(qty > 0)) return;
    const a = line.alteration || {};
    const lenFt = (Number(a.length_ft) || 0) + (Number(a.length_inch) || 0) / 12;
    let t = null;
    if (b.basis === 'each') t = b.price * qty;
    else if (b.basis === 'per_lb' && totalWeight > 0) t = b.price * totalWeight;
    else if (b.basis === 'per_cwt' && totalWeight > 0) t = b.price * totalWeight / 100;
    else if (b.basis === 'per_ft' && lenFt > 0) t = b.price * lenFt * qty;
    if (!(t > 0)) return;
    const tot = round(t, 2);
    onChange({ total_price: tot.toFixed(2), price_per_lb: totalWeight > 0 ? String(round(tot / totalWeight, 5)) : '' });
  }, [qty, totalWeight]);   // eslint-disable-line

  return (
    <tr className={(noQuote ? 'q-line q-noquote' : 'q-line') + afRowClass(mark)}>
      <LineNoCell line={line} mark={mark} />
      <td className="q-desc">
        {/* When altered, show what the MFG asked for struck through above the new line, so
            the supplier can see exactly what they're changing before they send it. */}
        {eff.altered && descKey(eff.description) !== descKey(line.description)
          ? <><span className="q-desc-was">{line.description}</span><div className="q-desc-now">{descKey(eff.description)}</div></>
          : line.description}
        {line.mfg_note && <div className="q-mfgnote"><span className="q-mfgnote-lbl">MFG note:</span> {line.mfg_note}</div>}
        <AutofillMark mark={mark} />
        {kind && <AlterEditor line={line} draft={draft} kind={kind} specOptions={specOptions} ep={ep} onChange={onChange} />}
        <div className="q-ireq-lbl">Item requirements <span className="muted">(MFG — editable)</span></div>
        <ItemReqEditor value={draft.item_requirements} options={itemReqChoices} onChange={reqs => onChange({ item_requirements: reqs })} />
      </td>
      <td className={eff.altered ? 'q-num q-altered' : 'q-num'}>
        {qtyLocked
          ? num(qty, 0)
          : <input type="number" min="1" step="1" className="q-qty-in" title="Change to quote a different quantity"
              value={kind === 'quantity' ? (draft.alt_quantity ?? '') : String(line.qty ?? '')}
              placeholder={String(line.qty ?? '')} onChange={e => onQty(e.target.value)} />}
        {kind === 'quantity' && eff.altered && Number(eff.qty) !== Number(line.qty) && <div className="q-qty-was">was {num(line.qty, 0)}</div>}
      </td>
      <td className={eff.altered ? 'q-num q-altered' : 'q-num'}>{num(totalWeight, 1)} lb</td>
      <td className="q-opt">
        <select value={draft.quote_option || 'Quote As Is'} onChange={e => onChange({ quote_option: e.target.value })}>
          {QUOTE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </td>
      <td className="q-price">
        <span className="q-dollar">$</span>
        <NumInput value={draft.total_price} minDp={2} maxDp={2} disabled={noQuote} placeholder="0.00" onChange={onTotal} />
      </td>
      <td className="q-price">
        <span className="q-dollar">$</span>
        <NumInput value={draft.price_per_lb} minDp={2} maxDp={5} disabled={noQuote} placeholder="0.00000" onChange={onPpl} />
        <span className="q-perlb">/lb</span>
      </td>
      <td className="q-num q-calc">{noQuote || lineTotal <= 0 ? '—' : money(unitPrice) + '/ea'}</td>
      <td><LeadTimeSelect className="q-mini" value={draft.lead_time} disabled={noQuote} choices={leadChoices} onChange={v => onChange({ lead_time: v })} /></td>
      <td><input className="q-mini" value={draft.comments} disabled={noQuote} placeholder="—" onChange={e => onChange({ comments: e.target.value })} /></td>
    </tr>
  );
}

// One fitting line — priced PER-EACH (total = unit × qty).
function FittingLineRow({ line, draft, onChange, leadChoices, mark }) {
  const qty = Number(line.qty) || 0;
  const noQuote = draft.quote_option === 'No Quote';
  const unit = !noQuote ? (parseFloat(draft.unit_price) || 0) : 0;
  const total = unit * qty;
  return (
    <tr className={(noQuote ? 'q-line q-noquote' : 'q-line') + afRowClass(mark)}>
      <LineNoCell line={line} mark={mark} />
      <td className="q-desc">{line.description}<AutofillMark mark={mark} /></td>
      <td className="q-num">{num(qty, 0)}</td>
      <td className="q-opt">
        <select value={draft.quote_option || 'Quote As Is'} onChange={e => onChange({ quote_option: e.target.value })}>
          {FITTING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </td>
      <td className="q-price">
        <span className="q-dollar">$</span>
        <NumInput value={draft.unit_price} minDp={2} maxDp={3} disabled={noQuote} placeholder="0.000"
          onChange={v => onChange({ unit_price: v })} />
        <span className="q-perlb">/ea</span>
      </td>
      <td className="q-num q-calc">{noQuote || unit <= 0 ? '—' : money(total)}</td>
      <td><LeadTimeSelect className="q-mini" value={draft.lead_time} disabled={noQuote} choices={leadChoices} onChange={v => onChange({ lead_time: v })} /></td>
      <td><input className="q-mini" value={draft.comments} disabled={noQuote} placeholder="—" onChange={e => onChange({ comments: e.target.value })} /></td>
    </tr>
  );
}

// NOTE: `revise` here = re-pricing a SUBMITTED quote as a new revision (quote-level).
// That's unrelated to per-line alteration (`alterationCatalog` / the "Alter …" options).
// `ep(name)` builds the URL for one endpoint: the supplier's own (/api/supplier/me/…) or
// the manufacturer's on-behalf twin (/api/mfg/supplier-quotes/…). `mfg` switches the
// wording to a manufacturer entering a quote a supplier sent them.
export function QuoteCard({ quote, lookups, ep, revise, alterationCatalog, mfg, defaultOpen, onSubmitted }) {
  const hasStruct = quote.structural_lines.length > 0;
  const hasFit = quote.fitting_lines.length > 0;
  const [open, setOpen] = useState(!!defaultOpen);
  const [submitState, setSubmitState] = useState(null); // {status, structResult, fitResult, error}
  // Set by a failed submit so the missing controls light up. A sentence next to the
  // button ("Please complete all required fields: Meets MFG requirements") left the
  // supplier hunting the form for which control it meant.
  const [showErrors, setShowErrors] = useState(false);
  const cardRef = useRef(null);
  // Selectable specs for a line, from the shared catalog (hoisted out of the per-line
  // payload — see alterationMeta on the server).
  // Plus any spec auto-fill just added to the catalog for this form/material.
  const specOptionsFor = l => {
    const key = (l.alteration || {}).spec_key;
    const base = ((alterationCatalog || {}).specs || {})[key] || [];
    const added = ((afRes && afRes.new_specs) || []).filter(s => s.spec_key === key && !base.some(o => o.id === s.id));
    return added.length ? base.concat(added.map(s => ({ id: s.id, label: s.label }))) : base;
  };

  // structural drafts keyed by rfqs_sent_id
  const [drafts, setDrafts] = useState(() => {
    const d = {};
    const savedLines = (quote.saved && quote.saved.lines) || {};
    quote.structural_lines.forEach(l => {
      const s = savedLines[l.rfqs_sent_id];
      if (s) { d[l.rfqs_sent_id] = savedDraft(s); return; }
      d[l.rfqs_sent_id] = { total_price: l.total_price || '', price_per_lb: l.price_per_lb || '', quote_option: l.quote_option || 'Quote As Is', lead_time: '', comments: '', item_requirements: Array.isArray(l.item_requirements) ? l.item_requirements : [] };
    });
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
    // Who gets the 'quote received' email (Supplier_Verify_Form Email_Manufacturer / Email_Supplier).
    // A manufacturer keying in a quote a supplier sent them needs neither; a supplier's own
    // submit tells the manufacturer and keeps a copy.
    email_mfg: !mfg, email_supplier: !mfg,
    // Prepopulate the supplier's requirements from the MFG's quote requirements (they're
    // confirming the manufacturer's requirements). Backend supplies quote.mfg_requirements.
    requirements: Array.isArray(quote.mfg_requirements) ? quote.mfg_requirements : [],
    attachment_name: '',
    // A saved quote reopens with its summary as saved (location, rep, quote #, terms…).
    // The email choices stay this screen's defaults.
    ...savedHeader(quote.saved),
  });
  const setH = patch => setHdr(p => ({ ...p, ...patch }));
  // The supplier's quote file itself, uploaded onto the saved record after submit. The PDF
  // used for auto-fill becomes this file unless the user picks another.
  const [attachFile, setAttachFile] = useState(null);
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
  // Auto-fill from the supplier's quote PDF/photo. The server reads it against THIS quote's
  // lines and returns values; they land in the same drafts a person types into, and nothing
  // is sent until the user presses Submit.
  const [af, setAf] = useState({ status: 'idle', file: null, result: null, error: '' });
  const runAutofill = async () => {
    const file = af.file;
    if (!file) return;
    setAf(s => ({ ...s, status: 'reading', error: '' }));
    try {
      const b64 = await fileToBase64(file);
      const r = await fetch(ep('autofill'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quote_id: quote.quote_id, file_b64: b64, media_type: file.type || 'application/pdf', file_name: file.name }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: 'The server did not answer (' + r.status + ').' }));
      if (!r.ok || !j.ok) throw new Error(j.error || 'The quote could not be read.');
      setDrafts(prev => {
        const next = { ...prev };
        Object.entries(j.structural || {}).forEach(([id, v]) => {
          if (!next[id]) return;
          const d = { ...next[id], quote_option: v.quote_option || next[id].quote_option, basis: v.basis || null, alt_quantity: '', preview: null, preview_error: '' };
          // The supplier quoted a different piece count: the card carries THEIR qty.
          if (v.alt_quantity) d.alt_quantity = String(v.alt_quantity);
          // ...or a different catalog spec: recorded as Alter Material on this line.
          d.alt_spec_id = v.alt_spec_id || '';
          if (v.quote_option === 'No Quote') { d.total_price = ''; d.price_per_lb = ''; }
          else if (v.total_price) { d.total_price = v.total_price; d.price_per_lb = v.price_per_lb || ''; }
          if (v.lead_time) d.lead_time = v.lead_time;
          if (v.comments) d.comments = v.comments;
          next[id] = d;
        });
        return next;
      });
      setFitDrafts(prev => {
        const next = { ...prev };
        Object.entries(j.fittings || {}).forEach(([id, v]) => {
          if (!next[id]) return;
          const d = { ...next[id], quote_option: v.quote_option || next[id].quote_option };
          if (v.quote_option === 'No Quote') d.unit_price = '';
          else if (v.unit_price) d.unit_price = v.unit_price;
          if (v.lead_time) d.lead_time = v.lead_time;
          if (v.comments) d.comments = v.comments;
          next[id] = d;
        });
        return next;
      });
      const h = j.header || {};
      setHdr(p => ({
        ...p, ...h,
        // Valid-until follows valid-days unless the quote printed its own date.
        valid_until: h.valid_until || (h.valid_days ? (() => {
          const dt = new Date(); dt.setDate(dt.getDate() + parseInt(h.valid_days, 10));
          while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() + 1);
          return dt.toISOString().slice(0, 10);
        })() : p.valid_until),
        attachment_name: file.name,
      }));
      setAttachFile(file);
      setAf(s => ({ ...s, status: 'done', result: j }));
      setSubmitState(null);
    } catch (e) {
      setAf(s => ({ ...s, status: 'error', error: String(e.message || e) }));
    }
  };
  const afRes = af.status === 'done' ? af.result : null;
  const markOf = (kind, id) => {
    const m = afRes && afRes[kind] ? afRes[kind][id] : null;
    return m && !mfg ? { ...m, quiet: true } : m;
  };
  // The supplier's own upload: they already reviewed their quote, so they get a short list of
  // where it differs from what the manufacturer asked for, and nothing else.
  const supplierChanges = () => {
    if (!afRes) return [];
    const out = [], noQuote = [], noPrice = [];
    const subs = new Map((afRes.substitutions || []).map(s => [String(s.line), s]));
    quote.structural_lines.forEach(l => {
      const m = (afRes.structural || {})[l.rfqs_sent_id];
      if (!m) return;
      if (m.combined) { out.push('Line ' + l.line + ': combined with line ' + m.combined_with_line); return; }
      if (!m.found || m.quote_option === 'No Quote') { noQuote.push(l.line); return; }
      if (m.alt_quantity) out.push('Line ' + l.line + ': qty ' + m.alt_quantity + ' (requested ' + l.qty + ')');
      const s = subs.get(String(l.line));
      if (s) out.push('Line ' + l.line + ': ' + s.to + ' instead of ' + s.from);
      if (!m.total_price) noPrice.push(l.line);
    });
    quote.fitting_lines.forEach(l => {
      const m = (afRes.fittings || {})[l.rfq_row_id];
      if (!m) return;
      if (!m.found || m.quote_option === 'No Quote') { noQuote.push('F' + l.line); return; }
      if (!m.unit_price) noPrice.push('F' + l.line);
    });
    if (noQuote.length) out.push('Not quoted (No Quote): line' + (noQuote.length === 1 ? ' ' : 's ') + noQuote.join(', '));
    if (noPrice.length) out.push('No price read, enter it: line' + (noPrice.length === 1 ? ' ' : 's ') + noPrice.join(', '));
    (afRes.unmatched_pdf_lines || []).forEach(u => out.push('Not requested: ' + u.pdf_text + (u.amount != null ? ' (' + money(u.amount) + ')' : '')));
    return out;
  };
  // After auto-fill, show lines in the SUPPLIER's order so the card reads beside their PDF:
  // quoted rows by their quote line, a line they combined right after its partner, then
  // everything they didn't quote. Returns [line, isFirstNotQuoted].
  const orderLines = (lines, kind, idKey) => {
    if (!afRes || !afRes[kind]) return lines.map(l => [l, false]);
    const rank = (l, i) => {
      const m = afRes[kind][l[idKey]] || {};
      if (m.found && m.pdf_line != null) return m.pdf_line;
      if (m.combined && m.pdf_line != null) return m.pdf_line + 0.5;
      if (m.found || m.combined) return 5000 + i;
      return 10000 + i;
    };
    const sorted = lines.map((l, i) => [rank(l, i), i, l]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const firstOff = sorted.findIndex(x => x[0] >= 10000);
    return sorted.map((x, k) => [x[2], k === firstOff && k > 0]);
  };

  const locations = (lookups && lookups.locations) || [];
  const reps = (lookups && lookups.reps) || [];
  // Only show the requirements the MFG actually requested for THIS quote (not the full
  // 15-option catalog). The supplier confirms which of those they meet.
  const mfgReqs = Array.isArray(quote.mfg_requirements) ? quote.mfg_requirements : [];
  const leadChoices = (lookups && lookups.lead_time_choices) || LEAD_TIME_FALLBACK_LIST;
  const quoteValidChoices = (lookups && lookups.quote_valid_choices) || QUOTE_VALID_FALLBACK;
  const itemReqChoices = (lookups && lookups.item_requirements_choices) || ITEM_REQ_FALLBACK;

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
    const e = effLine(l, dr);   // altered lines contribute their NEW weight, not the MFG's
    return s + (Number(e.qty) || 0) * (Number(e.unit_weight) || 0);
  }, 0);
  const totalAmount = grand + (parseFloat(hdr.shipping) || 0) + (parseFloat(hdr.misc) || 0);

  // Quote-summary fields the supplier MUST complete before submitting (structural quotes).
  // Attachment + Notes stay optional. Shipping/Misc are required but "0" is a valid entry.
  const REQUIRED_FIELDS = [
    ['location', 'Supplier location'],
    ['rep', 'Supplier representative'],
    ['supplier_quote_number', mfg ? "Supplier's quote #" : 'Your quote #'],
    ['meets_requirements', 'Meets MFG requirements'],
    ['valid_days', 'Quote valid (business days)'],
    ['valid_until', 'Valid until'],
    ['lead_time', 'Lead time for ship complete'],
    ['shipping', 'Shipping amount'],
    ['misc', 'Miscellaneous amount'],
  ];
  // Fittings-only quotes are exempt on purpose: the whole quote-summary block below is
  // rendered under `hasStruct`, and the fittings endpoint takes lines only -- no header.
  // Requiring these there would block a submit on controls that do not exist.
  // A manufacturer entering a quote can't be blocked on a supplier who never set up
  // locations or reps — there is nothing to pick. A supplier on their own screen still must.
  const notApplicable = k => mfg && ((k === 'location' && !locations.length) || (k === 'rep' && !reps.length));
  const missingKeys = new Set(hasStruct
    ? REQUIRED_FIELDS.filter(([k]) => !notApplicable(k) && String(hdr[k] == null ? '' : hdr[k]).trim() === '').map(([k]) => k)
    : []);
  const missingFields = REQUIRED_FIELDS.filter(([k]) => missingKeys.has(k)).map(([, lbl]) => lbl);
  // Class hook for a required control that is still empty AFTER a failed submit.
  const inv = k => (showErrors && missingKeys.has(k) ? ' q-invalid' : '');

  // A line marked "Alter …" that carries no actual change (or a change the server refused)
  // must not go out: it would quote the MFG's original spec under an "altered" label.
  const alterationProblems = quote.structural_lines.reduce((acc, l) => {
    const d = drafts[l.rfqs_sent_id] || {};
    const kind = ALTER_KIND[d.quote_option];
    if (!kind) return acc;
    if (!alterationBody(d, kind)) acc.push('Line ' + l.line + ': choose a new value for “' + d.quote_option + '”.');
    else if (d.previewing) acc.push('Line ' + l.line + ': still pricing — one moment.');
    else if (d.preview_error) acc.push('Line ' + l.line + ': ' + d.preview_error);
    return acc;
  }, []);

  const onSubmit = async () => {
    if (missingFields.length) {
      setShowErrors(true);
      setSubmitState({ status: 'error', error: 'Please complete all required fields: ' + missingFields.join(', ') + '.' });
      // Put the supplier ON the first missing control rather than leaving them to find
      // it -- the summary sits well below the fold on a quote with this many lines.
      setTimeout(() => {
        const root = cardRef.current;
        if (!root) return;
        const first = root.querySelector('.q-invalid');
        if (!first) return;
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const control = first.querySelector('select, input, textarea, button');
        if (control) control.focus({ preventScroll: true });
      }, 0);
      return;
    }
    if (alterationProblems.length) {
      setSubmitState({ status: 'error', error: 'Please resolve the altered lines: ' + alterationProblems.join(' ') });
      return;
    }
    setSubmitState({ status: 'saving' });
    try {
      let structResult = null, fitResult = null;

      if (hasStruct) {
        const lines = quote.structural_lines.map(l => {
          const d = drafts[l.rfqs_sent_id] || {};
          const qty = Number(effLine(l, d).qty) || 0;   // altered lines divide by the NEW qty
          const total = parseFloat(d.total_price) || 0;
          // Send the REQUEST, not our preview: the server recomputes from its own copy of
          // the row and is the authority on the resulting description/weight.
          const alteration = alterationBody(d, ALTER_KIND[d.quote_option] || null);
          return {
            rfqs_sent_id: l.rfqs_sent_id, sv_detail_id: l.sv_detail_id, line: l.line,
            quote_option: d.quote_option || 'Quote As Is',
            total_price: total, price_per_lb: parseFloat(d.price_per_lb) || 0,
            unit_price: qty > 0 ? total / qty : 0, lead_time: d.lead_time, comments: d.comments,
            item_requirements: Array.isArray(d.item_requirements) ? d.item_requirements : [],
            ...(alteration ? { alteration } : {}),
          };
        });
        const sv_form_id = (quote.structural_lines.find(l => l.sv_form_id) || {}).sv_form_id || '';
        const r = await fetch(ep('quote-submit'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          // fittings_total rides along on the structural submit: the fittings write is a
          // separate endpoint that never sees the SV header, so this is the only point at
          // which the header money can be made whole. Matches the "Fittings total" shown
          // above -- No Quote lines already excluded.
          body: JSON.stringify({ quote_id: quote.quote_id, sv_form_id, header: { ...hdr, fittings_total: fitGrand }, lines }),
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
        // Link each fitting row back to the SV record the structural submit just
        // created. Fittings use a "bridge = response" model and otherwise have no
        // path to that record, which is why the MFG side can't reach anything held
        // on it -- the supplier's own quote number, and the review form's fittings
        // subform. structResult is the response from the POST directly above.
        // Blank on a fittings-only quote: no structural lines, so no SV record exists.
        const sv_form_id = (structResult && structResult.sv_form_id) || '';
        const r = await fetch(ep('sent-fitting-rfqs/submit'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines, sv_form_id }),
        });
        fitResult = await r.json();
      }

      // Attach the quote file to the record just saved. Its own call: a refused file must not
      // undo saved prices, it is reported beside them.
      let attachResult = null;
      if (attachFile && structResult && structResult.ok && structResult.sv_form_id) {
        try {
          const b64 = await fileToBase64(attachFile);
          const ar = await fetch(ep('quote-attachment'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sv_form_id: structResult.sv_form_id, file_b64: b64, file_name: attachFile.name, media_type: attachFile.type || 'application/pdf' }),
          });
          attachResult = await ar.json().catch(() => ({ ok: false, error: 'no answer (' + ar.status + ')' }));
        } catch (e) { attachResult = { ok: false, error: String(e.message || e) }; }
      }
      setSubmitState({ status: 'done', structResult, fitResult, attachResult });
      if (onSubmitted && (!structResult || structResult.ok) && (!fitResult || fitResult.ok)) onSubmitted();
    } catch (e) {
      setSubmitState({ status: 'error', error: String(e.message || e) });
    }
  };

  // Combined submit result message.
  let resultNode = null;
  if (submitState && submitState.status === 'done') {
    const sr = submitState.structResult, fr = submitState.fitResult, atr = submitState.attachResult;
    const sOk = !sr || sr.ok, fOk = !fr || fr.ok;
    const ok = sOk && fOk;
    const parts = [];
    if (sr) parts.push(sr.ok
      ? `${sr.lines != null ? sr.lines : quote.structural_lines.length} structural${sr.altered ? ` (${sr.altered} altered)` : ''}`
      : ('structural failed' + (sr.message || sr.error ? ': ' + (sr.message || sr.error) : '')
        // The server refuses the WHOLE submit if an altered line can't be recomputed —
        // name the lines rather than leaving the supplier guessing.
        + (Array.isArray(sr.line_errors) && sr.line_errors.length
          ? ' — ' + sr.line_errors.map(e => 'line ' + e.line + ': ' + e.error).join('; ')
          : '')));
    if (fr) parts.push(fr.ok ? `${fr.saved != null ? fr.saved : quote.fitting_lines.length} fitting` : `fitting failed (${fr.saved || 0}/${(fr.saved || 0) + (fr.failed || 0)})`);
    resultNode = <span className={'q-result ' + (ok ? 'q-result-ok' : 'q-result-warn')}>{(ok ? (mfg ? 'Supplier quote saved — ' : 'Quote submitted — ') : 'Partial submit — ') + parts.join(', ') + ' line' + (parts.length ? 's' : '') + '.'}{atr && (atr.ok ? ' Quote PDF attached.' : <strong> The quote PDF was NOT attached: {atr.error}</strong>)}</span>;
  } else if (submitState && submitState.status === 'error') {
    resultNode = <span className="q-result q-result-warn">Error: {submitState.error}</span>;
  }

  return (
    <div className="q-card" ref={cardRef}>
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
          {quote.files && quote.files.length > 0 && (
            <div className="q-files">
              <span className="q-files-lbl">📎 {mfg ? 'Your reference files:' : 'Manufacturer reference files:'}</span>
              {quote.files.map((f, i) => (
                <a key={i} className="q-file" target="_blank" rel="noreferrer"
                  href={ep('quote-file') + '&record=' + encodeURIComponent(quote.quote_id) + '&filepath=' + encodeURIComponent(f.filepath)}>{f.name}</a>
              ))}
              {!mfg && <span className="q-files-note">review all files before quoting</span>}
            </div>
          )}
          <div className="q-af">
            <div className="q-af-row">
              <span className="q-af-lbl">✨ {mfg ? "Have the supplier's quote as a PDF?" : 'Upload your quote'}</span>
              <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp"
                onChange={e => { const f = e.target.files && e.target.files[0]; setAf({ status: 'idle', file: f || null, result: null, error: '' }); }} />
              <button type="button" className="q-batch-btn" disabled={!af.file || af.status === 'reading'} onClick={runAutofill}>
                {af.status === 'reading' ? 'Reading…' : mfg ? 'Auto-fill lines' : 'Fill from my quote'}
              </button>
            </div>
            {mfg && af.status === 'idle' && !af.file && <div className="q-af-hint">Upload it and every line it prices is filled in for you to check. Nothing is saved until you submit.</div>}
            {af.status === 'reading' && <div className="q-af-hint">Reading {af.file && af.file.name}{mfg ? ' against your ' + (quote.structural_lines.length + quote.fitting_lines.length) + ' lines' : ''} — this takes up to a minute.</div>}
            {af.status === 'error' && <div className="q-af-err">{af.error}</div>}
            {afRes && !mfg && (() => {
              const changes = supplierChanges();
              const pdfTotal = afRes.pdf_grand_total;
              const off = pdfTotal != null && Math.abs(pdfTotal - totalAmount) > 1;
              return (
                <div className="q-af-sum">
                  {changes.length === 0
                    ? <div className="q-af-ok-txt">✓ Your quote matches the request.</div>
                    : (
                      <>
                        <div><strong>Changes from the request:</strong></div>
                        {changes.map((c, i) => <div key={i} className="q-af-flag">⚠ {c}</div>)}
                      </>
                    )}
                  {off && <div className="q-af-warn-txt">Your quote total {money(pdfTotal)} · total here {money(totalAmount)}</div>}
                </div>
              );
            })()}
            {afRes && mfg && (() => {
              const all = [...Object.values(afRes.structural || {}), ...Object.values(afRes.fittings || {})];
              const filled = all.filter(m => m.found).length;
              const look = all.filter(m => m.found && m.flags && m.flags.length).length;
              const combined = all.filter(m => m.combined).length;
              const missing = all.length - filled - combined;
              const pdfTotal = afRes.pdf_grand_total;
              const off = pdfTotal != null && Math.abs(pdfTotal - totalAmount) > 1;
              return (
                <div className="q-af-sum">
                  <div><strong>Filled {filled} of {all.length} lines</strong> from {afRes.file_name}.{' '}
                    {look > 0 && <span className="q-af-warn-txt">{look} filled line{look === 1 ? '' : 's'} need{look === 1 ? 's' : ''} a check. </span>}
                    {missing > 0 && <span className="q-af-muted-txt">{missing} line{missing === 1 ? ' isn’t' : 's aren’t'} on the quote, so {missing === 1 ? 'it’s' : 'they’re'} set to No Quote (greyed out). </span>}
                    {combined > 0 && <span className="q-af-muted-txt">{combined} line{combined === 1 ? ' was' : 's were'} combined by the supplier into another line. </span>}
                    {!look && !missing && !combined && 'Check the prices before you save.'}</div>
                  {pdfTotal != null && (
                    <div className={off ? 'q-af-warn-txt' : 'q-af-ok-txt'}>
                      Total on the quote {money(pdfTotal)} · total here {money(totalAmount)}{off ? ' — they don’t match yet. Check the highlighted lines, shipping and misc.' : ' ✓'}
                    </div>
                  )}
                  {(afRes.substitutions || []).length > 0 && (
                    <div className="q-af-subs">
                      <strong>⚠ Spec substitution{afRes.substitutions.length === 1 ? '' : 's'} — the supplier quoted a different material than you asked for:</strong>
                      {afRes.substitutions.map((s, i) => (
                        <div key={i}>Line {s.line}: {s.from} → <strong>{s.to}</strong>{s.added ? ' — new spec, added to the catalog' : ''}{s.recorded ? ' (set to Alter Material)' : ' (noted in Comments)'}</div>
                      ))}
                      <div className="q-af-subs-note">Confirm each is acceptable before you save. Your request is unchanged; only the supplier's offer records the substitute.</div>
                    </div>
                  )}
                  {(afRes.header_flags || []).map((f, i) => <div key={i} className="q-af-flag">⚠ {f}</div>)}
                  {(afRes.unmatched_pdf_lines || []).length > 0 && (
                    <div className="q-af-flag">⚠ On the quote but not on your RFQ: {afRes.unmatched_pdf_lines.map(u => u.pdf_text + (u.amount != null ? ' (' + money(u.amount) + ')' : '')).join('; ')}</div>
                  )}
                </div>
              );
            })()}
          </div>
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
                  {orderLines(quote.structural_lines, 'structural', 'rfqs_sent_id').map(([l, divider]) => (
                    <React.Fragment key={l.rfqs_sent_id}>
                    {divider && <tr className="q-af-divider"><td colSpan="10">Not on {mfg ? "the supplier's" : 'your'} quote — set to No Quote</td></tr>}
                    <LineRow line={l} draft={drafts[l.rfqs_sent_id]} onChange={p => setLine(l.rfqs_sent_id, p)} leadChoices={leadChoices} itemReqChoices={itemReqChoices} ep={ep} specOptions={specOptionsFor(l)} mark={markOf('structural', l.rfqs_sent_id)} />
                    </React.Fragment>
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
                  {orderLines(quote.fitting_lines, 'fittings', 'rfq_row_id').map(([l, divider]) => (
                    <React.Fragment key={l.rfq_row_id}>
                    {divider && <tr className="q-af-divider"><td colSpan="8">Not on {mfg ? "the supplier's" : 'your'} quote — set to No Quote</td></tr>}
                    <FittingLineRow line={l} draft={fitDrafts[l.rfq_row_id]} onChange={p => setFit(l.rfq_row_id, p)} leadChoices={leadChoices} mark={markOf('fittings', l.rfq_row_id)} />
                    </React.Fragment>
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

              <div className="q-req-row">
                <div className="q-req-panel">
                  <div className="q-req-panel-top">
                    <span className="q-req-panel-head">MFG REQUIREMENTS <span className="q-req-note">— {mfg ? 'set on your quote' : 'set by the manufacturer'}</span></span>
                    <div className={'q-req-panel-meets' + inv('meets_requirements')} data-field="meets_requirements">
                      <span className="q-meets-lbl">{mfg ? "Does the supplier's quote meet these?" : 'Does your quote meet these?'}<span className="req-star">*</span></span>
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
                  <div className="q-req-panel-reqs">
                    {mfgReqs.length > 0 ? (
                      <div className="q-req-pills">
                        {mfgReqs.map(r => <span key={r} className="q-req-pill">{r}</span>)}
                      </div>
                    ) : (
                      <div className="q-reqs-none">No specific requirements requested by the manufacturer.</div>
                    )}
                  </div>
                </div>
                <label className="q-attach">
                  <span className="q-attach-lbl">{mfg ? "Supplier's quote (PDF)" : 'Internal quote (attachment)'}</span>
                  <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={e => { const f0 = e.target.files && e.target.files[0]; setAttachFile(f0 || null); setH({ attachment_name: f0 ? f0.name : '' }); }} />
                  {attachFile && <span className="q-attach-now">📎 {attachFile.name}{afRes && afRes.file_name === attachFile.name ? ' (from auto-fill)' : ''} — attached when you save</span>}
                </label>
              </div>

              <div className="q-grid q-grid-8">
                <label className={'q-sum-field' + inv('location')} data-field="location">Supplier location{!notApplicable('location') && <span className="req-star">*</span>}
                  <select value={hdr.location} onChange={e => setH({ location: e.target.value })}>
                    <option value="">{notApplicable('location') ? '— none on file —' : '— select —'}</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
                <label className={'q-sum-field' + inv('rep')} data-field="rep">Supplier representative{!notApplicable('rep') && <span className="req-star">*</span>}
                  <select value={hdr.rep} onChange={e => setH({ rep: e.target.value })}>
                    <option value="">{notApplicable('rep') ? '— none on file —' : '— select —'}</option>
                    {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
                <label className={'q-sum-field' + inv('supplier_quote_number')} data-field="supplier_quote_number">{mfg ? "Supplier's quote #" : 'Your quote #'}<span className="req-star">*</span>
                  <input value={hdr.supplier_quote_number} onChange={e => setH({ supplier_quote_number: e.target.value })} placeholder={mfg ? 'From their quote' : 'Internal quote number'} />
                </label>
                <label className={'q-sum-field' + inv('valid_days')} data-field="valid_days">Quote valid (business days)<span className="req-star">*</span>
                  <select value={hdr.valid_days} onChange={e => onValidDays(e.target.value)}>
                    <option value="">— select —</option>
                    {quoteValidChoices.map(n => <option key={n} value={n}>{n} {n === 1 ? 'day' : 'days'}</option>)}
                  </select>
                </label>
                <label className={'q-sum-field' + inv('valid_until')} data-field="valid_until">Valid until<span className="req-star">*</span>
                  <input type="date" value={hdr.valid_until} onChange={e => setH({ valid_until: e.target.value })} />
                </label>
                <label className={'q-sum-field' + inv('lead_time')} data-field="lead_time">Lead time for ship complete<span className="req-star">*</span>
                  <LeadTimeSelect value={hdr.lead_time} choices={leadChoices} blankLabel="— select —" onChange={v => setH({ lead_time: v })} />
                </label>
                <label className={'q-sum-field' + inv('shipping')} data-field="shipping">Shipping amount<span className="req-star">*</span>
                  <div className="q-money-in">
                    <span className="q-dollar">$</span>
                    <input type="text" inputMode="decimal" value={hdr.shipping} placeholder="0.00"
                      onChange={e => setH({ shipping: e.target.value })}
                      onBlur={e => setH({ shipping: fmtMoney2(e.target.value) })} />
                  </div>
                </label>
                <label className={'q-sum-field' + inv('misc')} data-field="misc">Miscellaneous amount<span className="req-star">*</span>
                  <div className="q-money-in">
                    <span className="q-dollar">$</span>
                    <input type="text" inputMode="decimal" value={hdr.misc} placeholder="0.00"
                      onChange={e => setH({ misc: e.target.value })}
                      onBlur={e => setH({ misc: fmtMoney2(e.target.value) })} />
                  </div>
                </label>
              </div>

              <label className="q-notes">{mfg ? 'Supplier notes' : 'Notes to buyer'}
                <textarea rows="2" value={hdr.notes} onChange={e => setH({ notes: e.target.value })} placeholder={mfg ? 'Optional: terms or notes from their quote' : 'Optional notes for the manufacturer'} />
              </label>

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
            <div className="q-revise-note">{mfg
              ? <>This supplier already has a quote on file. Saving creates a new revision: the current one is marked <strong>Revised</strong> and replaced by this one.</>
              : <>Re-pricing creates a new revision — your current quote will be marked <strong>Revised</strong> and replaced by this one.</>}</div>
          )}
          {hasStruct && (
            <div className="q-email">
              <span className="q-email-lbl">Email on save:</span>
              {[['email_mfg', mfg ? 'Email me (manufacturer)' : 'Email the manufacturer'], ['email_supplier', mfg ? 'Email the supplier a copy' : 'Email me a copy']].map(([k, lbl]) => (
                <span key={k} className="q-email-opt">{lbl}
                  <span className="q-seg q-seg-sm">
                    <button type="button" className={'q-seg-btn' + (hdr[k] ? ' q-seg-on q-seg-yes' : '')} onClick={() => setH({ [k]: true })}>Yes</button>
                    <button type="button" className={'q-seg-btn' + (!hdr[k] ? ' q-seg-on q-seg-no' : '')} onClick={() => setH({ [k]: false })}>No</button>
                  </span>
                </span>
              ))}
            </div>
          )}
          <div className="q-actions">
            {hasStruct && (
              <label className="q-ready">
                <input type="checkbox" checked={hdr.ready} onChange={e => setH({ ready: e.target.checked })} />
                Ready for submission
              </label>
            )}
            <button className="btn-quote" disabled={submitState && submitState.status === 'saving'} onClick={onSubmit}>
              {submitState && submitState.status === 'saving' ? 'Submitting…'
                : mfg ? (revise ? "Save supplier's revision" : "Save supplier's quote")
                : (revise ? 'Submit revision' : 'Submit quote')}
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
  const ep = useCallback(name => '/api/supplier/me/' + name + '?email=' + encodeURIComponent(email), [email]);

  const load = useCallback(async () => {
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const [rfqsR, fitR] = await Promise.all([
        fetch(ep('rfqs')).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) })),
        fetch(ep('sent-fitting-rfqs')).then(r => r.json()).catch(() => ({ ok: false })),
      ]);
      // Structural is primary; fittings degrades gracefully (a fittings outage shouldn't blank the page).
      if (!rfqsR || !rfqsR.ok) {
        if (!fitR || !fitR.ok) { setState({ status: 'error', quotes: [], lookups: {}, error: (rfqsR && rfqsR.error) || 'Could not load quotes' }); return; }
      }
      const structuralQuotes = (rfqsR && rfqsR.ok) ? (rfqsR.quotes || []) : [];
      const fittingQuotes = (fitR && fitR.ok) ? (fitR.quotes || []) : [];
      const quotes = mergeQuotes(structuralQuotes, fittingQuotes);
      const lookups = (rfqsR && rfqsR.lookups) || {};
      // Shared spec lists for the "Alter …" editors (hoisted off the per-line payload).
      const alteration_catalog = (rfqsR && rfqsR.alteration_catalog) || { specs: {} };
      setState({ status: 'ready', quotes, lookups, alteration_catalog, error: null });
    } catch (e) {
      setState({ status: 'error', quotes: [], lookups: {}, error: String(e.message || e) });
    }
  }, [ep]);
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
            : <QuoteCard key={q.quote_id} quote={q} lookups={state.lookups || {}} ep={ep} revise={tab === 'submitted'} alterationCatalog={state.alteration_catalog} />)}
      </section>
    </>
  );
}
