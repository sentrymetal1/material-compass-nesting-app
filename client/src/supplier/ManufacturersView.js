import React, { useState } from 'react';

// Manufacturers matched to this supplier (junction Quote_Sent_To_Manufacture_Supplier_Status).
// SupplierApp owns the data (it also drives the nav badge and the dashboard alert); this view
// only renders it and reports Accept / Decline back through onDecide.

const SECTIONS = [
  { key: 'pending', title: 'Waiting for your answer', note: 'These manufacturers want to send you quote requests. Accept to start receiving their RFQs.' },
  { key: 'active', title: 'Active', note: 'You accept quote requests from these manufacturers, and they have accepted you.' },
  { key: 'waiting', title: 'Waiting on the manufacturer', note: 'You said yes. Their requests start once they accept you too.' },
  { key: 'declined', title: 'Declined', note: 'You chose not to receive quote requests from these manufacturers. You can change your mind.' },
];

export function DecisionButtons({ m, busy, onDecide, compact }) {
  const working = busy === m.id;
  return (
    <div className={'mfg-actions' + (compact ? ' mfg-actions-compact' : '')}>
      <button type="button" className="btn-quote" disabled={!!busy} onClick={() => onDecide(m, true)}>
        {working ? 'Saving…' : 'Accept'}
      </button>
      <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => onDecide(m, false)}>
        Decline
      </button>
    </div>
  );
}

function MfgCard({ m, busy, onDecide }) {
  return (
    <div className="mfg-card">
      <div className="mfg-main">
        <div className="mfg-name">{m.company_name}</div>
        <div className="mfg-contact">
          {m.city && <span>{m.city}</span>}
          {m.phone && <a href={'tel:' + m.phone}>{m.phone}</a>}
          {m.email && <a href={'mailto:' + m.email}>{m.email}</a>}
          {m.website && <a href={/^https?:/i.test(m.website) ? m.website : 'http://' + m.website} target="_blank" rel="noopener noreferrer">{m.website}</a>}
        </div>
        {m.status === 'pending' && m.manufacturer_decision === 'yes' && (
          <div className="mfg-hint">They have already accepted you.</div>
        )}
        {m.contacts && m.contacts.length > 0 && (
          <div className="mfg-reps">
            <div className="mfg-reps-label">Your contacts there</div>
            {m.contacts.map((c, i) => (
              <div key={i} className="mfg-rep">
                <strong>{c.name}</strong>
                {c.email && <a href={'mailto:' + c.email}>{c.email}</a>}
                <span className="muted">
                  {[c.their_location, c.your_location && ('works with your ' + c.your_location)].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mfg-side">
        {m.status === 'pending' && <DecisionButtons m={m} busy={busy} onDecide={onDecide} />}
        {m.status === 'active' && <span className="tier tier-exact">Active</span>}
        {m.status === 'waiting' && <span className="tier tier-category">Waiting on them</span>}
        {m.status === 'declined' && (
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => onDecide(m, true)}>
            {busy === m.id ? 'Saving…' : 'Accept instead'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ManufacturersView({ state, busy, error, onDecide, onRetry }) {
  const [showDeclined, setShowDeclined] = useState(false);
  if (state.status === 'loading' && !state.data) return <div className="sup-msg">Loading manufacturers…</div>;
  if (state.status === 'error') {
    return (
      <div className="sup-msg sup-msg-error">
        Couldn’t load your manufacturers: {state.error}
        <button className="btn-link" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  const list = (state.data && state.data.manufacturers) || [];
  const by = key => list.filter(m => m.status === key);

  return (
    <div className="mfg-view">
      <h1 className="mfg-title">Manufacturers</h1>
      {error && <div className="sup-msg sup-msg-error">{error}</div>}
      {list.length === 0 && (
        <div className="sup-empty">No manufacturers are matched with you yet. New ones appear here as they join Material Compass.</div>
      )}
      {SECTIONS.map(s => {
        const rows = by(s.key);
        if (!rows.length) return null;
        const collapsed = s.key === 'declined' && !showDeclined;
        return (
          <section key={s.key} className="sup-section">
            <h2>
              {s.title} <span className="muted">({rows.length})</span>
              {s.key === 'declined' && (
                <button className="btn-link" onClick={() => setShowDeclined(v => !v)}>{showDeclined ? 'Hide' : 'Show'}</button>
              )}
            </h2>
            {!collapsed && <>
              <div className="sup-subnote mfg-section-note">{s.note}</div>
              <div className="match-list">
                {rows.map(m => <MfgCard key={m.id} m={m} busy={busy} onDecide={onDecide} />)}
              </div>
            </>}
          </section>
        );
      })}
    </div>
  );
}
