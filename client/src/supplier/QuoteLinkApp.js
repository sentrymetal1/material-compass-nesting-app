import React, { useEffect, useState, useCallback } from 'react';
import './supplier.css';
import { QuoteCard, mergeQuotes } from './QuotesView';

// Supplier WITHOUT a Material Compass login, on the "Price this quote online" link from the
// RFQ email: /quote-online?t=<q token>. The token opens one quote for one supplier; it is the
// same quote card registered suppliers use, and the same record lands for the manufacturer.
const BUILD_TAG = 'quote-online-2026-11-07';
const BASE = '/api/q/';

const responded = q =>
  q.structural_lines.some(l => l.quote_option && String(l.quote_option).trim() !== '') ||
  q.fitting_lines.some(l => l.quote_option && String(l.quote_option).trim() !== '');

export default function QuoteLinkApp() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('t') || '');
  const [card, setCard] = useState({ status: 'loading' });
  const [reloadN] = useState(0);
  const [savedNow, setSavedNow] = useState(false);
  const ep = useCallback(name => BASE + name + '?t=' + encodeURIComponent(token), [token]);

  useEffect(() => {
    if (!token) { setCard({ status: 'error', error: 'This link is not complete. Please use the link in your RFQ email.' }); return; }
    let live = true;
    setCard({ status: 'loading' });
    (async () => {
      try {
        const [rfqsR, fitR] = await Promise.all([
          fetch(ep('rfqs')).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) })),
          fetch(ep('sent-fitting-rfqs')).then(r => r.json()).catch(() => ({ ok: false })),
        ]);
        if (!live) return;
        if ((!rfqsR || !rfqsR.ok) && (!fitR || !fitR.ok)) throw new Error((rfqsR && rfqsR.error) || 'This quote request could not be loaded.');
        const quotes = mergeQuotes((rfqsR && rfqsR.ok && rfqsR.quotes) || [], (fitR && fitR.ok && fitR.quotes) || []);
        const quote = quotes[0];
        const supplier = (rfqsR && rfqsR.supplier) || (fitR && fitR.supplier) || null;
        setCard(quote
          ? { status: 'ready', quote, supplier, lookups: rfqsR.lookups || {}, alteration_catalog: rfqsR.alteration_catalog || { specs: {} } }
          : { status: 'error', error: 'This quote request is no longer open.' });
      } catch (e) {
        if (live) setCard({ status: 'error', error: String(e.message || e) });
      }
    })();
    return () => { live = false; };
  }, [token, ep, reloadN]);

  const q = card.quote;
  const closed = q && /^Closed|Cancel|Sourcing|Purchase Order|Award/i.test(q.status || '');

  return (
    <div className="sup-app">
      <header className="sup-header">
        <div className="sup-brand">
          <span className="sup-logo">◆</span>
          <span className="sup-title">Material Compass <em>· Price a quote request</em></span>
        </div>
        {card.supplier && <span className="muted">{card.supplier.company_name}</span>}
      </header>
      <main className="sup-main sup-main-wide">
        {card.status === 'loading' && <div className="sup-msg">Loading the quote request…</div>}
        {card.status === 'error' && <div className="sup-msg sup-msg-warn">{card.error}</div>}
        {card.status === 'ready' && (
          <>
            <p className="mq-lead">
              {q.manufacturer ? q.manufacturer + ' asked' : 'You were asked'} for your price on quote <strong>{q.quote_number}</strong>.
              Price the lines you can supply, mark the rest No Quote, and submit. No account is needed.
              Have your quote as a PDF? Upload it and the lines are filled in for you to check.
            </p>
            {closed ? (
              <div className="sup-msg sup-msg-warn">This quote request is closed{q.status ? ' (' + q.status + ')' : ''}. Prices can no longer be submitted.</div>
            ) : (
              <>
                {q.saved && <div className="sup-msg">Showing your quote as submitted {new Date(q.saved.saved_at).toLocaleString()}. Submitting again sends a revision.</div>}
                <QuoteCard key={q.quote_id + '|' + reloadN}
                  quote={q} lookups={card.lookups} alterationCatalog={card.alteration_catalog}
                  ep={ep} defaultOpen revise={responded(q) || !!q.saved}
                  onSubmitted={() => setSavedNow(true)} />
                {savedNow && (
                  <div className="sup-msg mq-done">
                    Thank you. Your quote is with {q.manufacturer || 'the manufacturer'}. You can close this page, or use this same link to revise it.
                  </div>
                )}
              </>
            )}
            <div className="sup-msg ql-join">
              Want every request in one place, with your stock matched automatically?{' '}
              <a href="https://materialcompass.us" target="_blank" rel="noreferrer">Join Material Compass free</a>.
            </div>
          </>
        )}
      </main>
      <footer className="sup-footer">{BUILD_TAG}</footer>
    </div>
  );
}
