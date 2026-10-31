import React, { useEffect, useState, useCallback } from 'react';
import './supplier.css';
import { QuoteCard, mergeQuotes } from './QuotesView';

// Manufacturer side: enter a quote a supplier sent you off-platform (email, PDF, phone).
// It is the supplier's own quote card, opened for one supplier, so what lands in Zoho is
// the same Supplier_Verify_Form record a supplier's submit creates — allocation and the
// close-out read it the same way. Opened from Zoho with
//   /mfg-quote-entry?manufacturer_id=<Customer_Entry ID>&t=<token>[&quote_id=…][&supplier_id=…]
const BUILD_TAG = 'mfg-quote-entry-2026-10-31c';
const BASE = '/api/mfg/supplier-quotes/';

function params() {
  const p = new URLSearchParams(window.location.search);
  return {
    mfg: p.get('manufacturer_id') || p.get('Manufacture_ID') || '',
    token: p.get('t') || '',
    quoteId: p.get('quote_id') || '',
    supplierId: p.get('supplier_id') || '',
  };
}

export default function MfgQuoteEntryApp() {
  const [{ mfg, token, quoteId: q0, supplierId: s0 }] = useState(params);
  const [list, setList] = useState({ status: 'loading', quotes: [], error: '' });
  const [quoteId, setQuoteId] = useState(q0);
  const [supplierId, setSupplierId] = useState(s0);
  const [card, setCard] = useState({ status: 'idle' });
  const [reloadN, setReloadN] = useState(0);

  const auth = 'manufacturer_id=' + encodeURIComponent(mfg) + (token ? '&t=' + encodeURIComponent(token) : '');
  const ep = useCallback(name => BASE + name + '?' + auth + '&supplier_id=' + encodeURIComponent(supplierId), [auth, supplierId]);

  const loadList = useCallback(async () => {
    try {
      const j = await fetch(BASE + 'list?' + auth).then(r => r.json());
      if (!j.ok) throw new Error(j.error || 'Could not load your quotes');
      setList({ status: 'ready', quotes: j.quotes || [], error: '' });
    } catch (e) {
      setList({ status: 'error', quotes: [], error: String(e.message || e) });
    }
  }, [auth]);
  useEffect(() => { if (mfg) loadList(); }, [mfg, loadList]);

  // Load the chosen supplier's lines for the chosen quote.
  useEffect(() => {
    if (!quoteId || !supplierId) { setCard({ status: 'idle' }); return; }
    let live = true;
    setCard({ status: 'loading' });
    (async () => {
      try {
        const [rfqsR, fitR] = await Promise.all([
          fetch(ep('rfqs')).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) })),
          fetch(ep('sent-fitting-rfqs')).then(r => r.json()).catch(() => ({ ok: false })),
        ]);
        if (!live) return;
        if ((!rfqsR || !rfqsR.ok) && (!fitR || !fitR.ok)) throw new Error((rfqsR && rfqsR.error) || 'Could not load this quote');
        const quotes = mergeQuotes((rfqsR && rfqsR.ok && rfqsR.quotes) || [], (fitR && fitR.ok && fitR.quotes) || []);
        const quote = quotes.find(x => String(x.quote_id) === String(quoteId));
        setCard(quote
          ? { status: 'ready', quote, lookups: rfqsR.lookups || {}, alteration_catalog: rfqsR.alteration_catalog || { specs: {} } }
          : { status: 'empty' });
      } catch (e) {
        if (live) setCard({ status: 'error', error: String(e.message || e) });
      }
    })();
    return () => { live = false; };
  }, [quoteId, supplierId, ep, reloadN]);

  const quote = list.quotes.find(q => String(q.quote_id) === String(quoteId));
  const supplier = quote && quote.suppliers.find(s => String(s.supplier_id) === String(supplierId));
  // Only one supplier on the quote: nothing to choose, so open their lines straight away.
  useEffect(() => {
    if (quote && !supplierId && quote.suppliers.length === 1) setSupplierId(quote.suppliers[0].supplier_id);
  }, [quote, supplierId]);

  return (
    <div className="sup-app">
      <header className="sup-header">
        <div className="sup-brand">
          <span className="sup-logo">◆</span>
          <span className="sup-title">Material Compass <em>· Enter a supplier's quote</em></span>
        </div>
      </header>
      <main className="sup-main sup-main-wide">
        {!mfg ? (
          <div className="sup-msg sup-msg-warn">Please open this page from Material Compass.</div>
        ) : list.status === 'loading' ? (
          <div className="sup-msg">Loading your quotes…</div>
        ) : list.status === 'error' ? (
          <div className="sup-msg sup-msg-error">Couldn’t load your quotes: {list.error} <button className="btn-link" onClick={loadList}>Retry</button></div>
        ) : (
          <>
            <section className="sup-section mq-pick">
              <p className="mq-lead">When a supplier sends you a quote by email or PDF, enter it here. It's saved exactly as if they had submitted it themselves.</p>
              <label className="mq-field">Your quote
                <select value={quoteId} onChange={e => { setQuoteId(e.target.value); setSupplierId(''); }}>
                  <option value="">— choose a quote —</option>
                  {list.quotes.map(q => (
                    <option key={q.quote_id} value={q.quote_id}>{q.quote_number}{q.quote_description ? ' — ' + q.quote_description : ''}</option>
                  ))}
                  {/* Opened from Zoho on a quote that's no longer open (e.g. closed out): keep it selectable. */}
                  {quoteId && !quote && card.status === 'ready' && (
                    <option value={quoteId}>{card.quote.quote_number}{card.quote.quote_description ? ' — ' + card.quote.quote_description : ''} (closed)</option>
                  )}
                </select>
              </label>
              {quoteId && !quote && card.status === 'ready' && (
                <div className="sup-msg sup-msg-warn">This quote is already closed{card.quote.status ? ' (' + card.quote.status + ')' : ''}. You can still view this supplier's quote, but saving would create a new revision after close-out.</div>
              )}
              {quoteId && !quote && (card.status === 'empty' || card.status === 'error') && (
                <div className="sup-msg sup-msg-warn">That quote isn't open, or no RFQs were sent for it.</div>
              )}
              {quote && (
                <div className="mq-suppliers">
                  <span className="mq-sub">Supplier</span>
                  {quote.suppliers.map(s => (
                    <button key={s.supplier_id} type="button"
                      className={'mq-sup' + (String(s.supplier_id) === String(supplierId) ? ' mq-sup-on' : '')}
                      onClick={() => setSupplierId(s.supplier_id)}>
                      <span className="mq-sup-name">{s.name}</span>
                      <span className={'mq-sup-st ' + (s.answered ? 'mq-st-done' : 'mq-st-wait')}>{s.answered ? 'Quote on file' : 'Waiting'}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {quote && !supplierId && quote.suppliers.length > 1 && (
              <div className="sup-msg">Click the supplier whose quote you’re entering. Their lines will open here, ready to price.</div>
            )}
            {card.status === 'loading' &&<div className="sup-msg">Loading {supplier ? supplier.name + '’s' : 'the'} lines…</div>}
            {card.status === 'error' && <div className="sup-msg sup-msg-error">Couldn’t load the lines: {card.error}</div>}
            {card.status === 'empty' && <div className="sup-msg sup-msg-warn">No open lines for this supplier on this quote.</div>}
            {card.status === 'ready' && (
              <QuoteCard key={quoteId + '|' + supplierId + '|' + reloadN}
                quote={card.quote} lookups={card.lookups} alterationCatalog={card.alteration_catalog}
                ep={ep} mfg defaultOpen revise={!!(supplier && supplier.answered)}
                onSubmitted={() => { loadList(); }} />
            )}
            {card.status === 'ready' && (
              <div className="mq-reload"><button className="btn-link" onClick={() => setReloadN(n => n + 1)}>Reload lines</button></div>
            )}
          </>
        )}
      </main>
      <footer className="sup-footer">{BUILD_TAG}</footer>
    </div>
  );
}
