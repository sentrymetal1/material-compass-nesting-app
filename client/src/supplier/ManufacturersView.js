import React, { useState, useEffect, useRef } from 'react';
import fmtPhone from './fmtPhone';

// Manufacturers matched to this supplier (junction Quote_Sent_To_Manufacture_Supplier_Status).
// SupplierApp owns the data (it also drives the nav badge and the dashboard alert); this view
// renders it, reports Accept / Decline back through onDecide, and edits the supplier's side of the
// rep assignments through api() + onChanged (reload).

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

// Your reps carry one location_id; a manufacturer's reps carry location_ids (they can cover
// several). No location set = offered at every location.
const repsAt = (team, loc) => team.reps.filter(r => r.location_ids
  ? (!r.location_ids.length || r.location_ids.includes(loc))
  : (!r.location_id || r.location_id === loc));

// One side of a pairing: a location, then which of that side's reps at it. Reps are stored per
// location, so switching location drops any picked rep who doesn't work there.
function SidePicker({ who, team, loc, ids, setLoc, setIds, emptyNote }) {
  const reps = loc ? repsAt(team, loc) : [];
  const toggle = id => setIds(ids.includes(id) ? ids.filter(x => x !== id) : ids.concat(id));
  return (
    <div className="mfg-edit-side">
      <label className="mfg-edit-label">{who} location
        <select value={loc} onChange={e => { const v = e.target.value; setLoc(v); setIds(ids.filter(id => repsAt(team, v).some(r => r.id === id))); }}>
          <option value="">Pick a location…</option>
          {team.locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.city ? ' — ' + l.city : ''}</option>)}
        </select>
      </label>
      <div className="mfg-edit-label">{who} reps</div>
      {loc && !reps.length && <div className="muted">{emptyNote}</div>}
      <div className="mfg-edit-reps">
        {reps.map(r => (
          <label key={r.id} className="mfg-edit-rep">
            <input type="checkbox" checked={ids.includes(r.id)} onChange={() => toggle(r.id)} />
            {r.name}{r.position ? <span className="muted"> · {r.position}</span> : null}
          </label>
        ))}
      </div>
    </div>
  );
}

// Their side on the left, yours on the right. Used for an existing pairing (a) or a new one.
function PairingRow({ a, mine, theirs, saving, canRemove, onSave, onRemove, onCancel }) {
  const [tLoc, setTLoc] = useState(a ? a.their_location_id : '');
  const [tIds, setTIds] = useState(a ? a.their_rep_ids : []);
  const [loc, setLoc] = useState(a ? a.your_location_id : '');
  const [ids, setIds] = useState(a ? a.your_rep_ids : []);
  const same = (x, y) => x.slice().sort().join() === y.slice().sort().join();
  const dirty = !a || tLoc !== a.their_location_id || loc !== a.your_location_id || !same(tIds, a.their_rep_ids) || !same(ids, a.your_rep_ids);
  const ready = tLoc && tIds.length && loc && ids.length;
  const key = a ? a.id : 'new';
  return (
    <div className={'mfg-edit-row' + (a ? '' : ' mfg-edit-new')}>
      <div className="mfg-edit-pair">
        <SidePicker who="Their" team={theirs} loc={tLoc} ids={tIds} setLoc={setTLoc} setIds={setTIds}
          emptyNote="They have no reps at this location yet." />
        <div className="mfg-edit-arrow">↔</div>
        <SidePicker who="Your" team={mine} loc={loc} ids={ids} setLoc={setLoc} setIds={setIds}
          emptyNote="No reps at this location yet. Add them on the Profile tab." />
      </div>
      <div className="mfg-actions mfg-actions-compact">
        <button type="button" className="btn-quote" disabled={!!saving || !dirty || !ready}
          onClick={() => onSave(a, { their_location_id: tLoc, their_rep_ids: tIds, location_id: loc, rep_ids: ids })}>
          {saving === key ? 'Saving…' : 'Save'}
        </button>
        {canRemove && <button type="button" className="btn-secondary" disabled={!!saving} onClick={() => onRemove(a)}>Remove</button>}
        {onCancel && <button type="button" className="btn-secondary" disabled={!!saving} onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

// Inline editor under a card: one row per pairing, plus "add another pairing". With no pairings
// yet it opens straight on a new one — the supplier can set contacts before the MFG accepts.
function ContactsEditor({ m, team, api, onChanged, onClose, confirm }) {
  const [saving, setSaving] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(!m.assignments.length);
  const [theirs, setTheirs] = useState({ status: 'loading', locations: [], reps: [] });
  // api is re-created on every parent render; read it through a ref so this loads once per card.
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    let live = true;
    apiRef.current('GET', '/api/supplier/me/manufacturers/' + m.id + '/team')
      .then(j => live && setTheirs({ status: 'ready', locations: j.locations || [], reps: j.reps || [] }))
      .catch(e => live && setTheirs({ status: 'error', locations: [], reps: [], error: String(e.message || e) }));
    return () => { live = false; };
  }, [m.id]);
  const run = async (key, fn) => {
    setSaving(key); setErr(null);
    try { await fn(); setAdding(false); await onChanged(); } catch (e) { setErr(String(e.message || e)); }
    setSaving(null);
  };
  const save = (a, body) => a
    ? run(a.id, () => api('PATCH', '/api/supplier/me/rep-matches/' + a.id, body))
    : run('new', () => api('POST', '/api/supplier/me/rep-matches/pair', { match_id: m.id, ...body }));
  const remove = async a => {
    const ok = await confirm({
      title: 'Remove this pairing?',
      message: 'Your ' + (a.your_location || 'location') + ' team will no longer be a contact for ' + m.company_name + '. You can add it back any time.',
      confirmLabel: 'Remove', danger: true,
    });
    if (ok) run(a.id, () => api('DELETE', '/api/supplier/me/rep-matches/' + a.id));
  };

  let body;
  if (team.status === 'loading' || theirs.status === 'loading') body = <div className="muted">Loading both teams…</div>;
  else if (team.status === 'error') body = <div className="sup-msg sup-msg-error">Couldn’t load your locations and reps: {team.error}</div>;
  else if (theirs.status === 'error') body = <div className="sup-msg sup-msg-error">Couldn’t load {m.company_name}’s locations and reps: {theirs.error}</div>;
  else body = <>
    {m.assignments.map(a => (
      <PairingRow key={a.id + '|' + a.their_location_id + '|' + a.your_location_id + '|' + a.your_rep_ids.join() + '|' + a.their_rep_ids.join()}
        a={a} mine={team} theirs={theirs} saving={saving} canRemove={m.assignments.length > 1} onSave={save} onRemove={remove} />
    ))}
    {adding
      ? <PairingRow mine={team} theirs={theirs} saving={saving} onSave={save} onCancel={m.assignments.length ? () => setAdding(false) : null} />
      : <button type="button" className="btn-link" onClick={() => setAdding(true)}>+ Add another pairing</button>}
  </>;
  return (
    <div className="mfg-edit">
      <div className="mfg-edit-head">
        <strong>Your contacts with {m.company_name}</strong>
        <button type="button" className="btn-link" onClick={onClose}>Done</button>
      </div>
      <div className="sup-subnote">Pair their people with yours, location by location. You can do this before they accept you; they can change their side later.</div>
      {err && <div className="sup-msg sup-msg-error">{err}</div>}
      {body}
    </div>
  );
}

function MfgCard({ m, busy, onDecide, team, editing, onEdit, api, onChanged, confirm }) {
  const canEdit = m.status !== 'declined';
  const hasPairs = !!(m.assignments && m.assignments.length);
  return (
    <div className="mfg-card-wrap">
    <div className="mfg-card">
      <div className="mfg-main">
        <div className="mfg-name">{m.company_name}</div>
        <div className="mfg-contact">
          {m.city && <span>{m.city}</span>}
          {m.phone && <a href={'tel:' + m.phone}>{fmtPhone(m.phone)}</a>}
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
                  {[c.their_location && ('their ' + c.their_location), c.your_location && ('your ' + c.your_location)].filter(Boolean).join(' → ')}
                </span>
              </div>
            ))}
          </div>
        )}
        {canEdit && !hasPairs && (
          <div className="muted mfg-no-contacts">No contacts paired yet. Pick who works with whom — you don’t have to wait for them to accept.</div>
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
        {canEdit && !editing && (
          <button type="button" className="btn-secondary" onClick={() => onEdit(m.id)}>{hasPairs ? 'Edit contacts' : 'Set up contacts'}</button>
        )}
        {(m.status === 'active' || m.status === 'waiting') && (
          <button type="button" className="btn-link mfg-stop" disabled={!!busy} onClick={() => onDecide(m, false)}>
            {busy === m.id ? 'Saving…' : 'Stop receiving quotes'}
          </button>
        )}
      </div>
    </div>
    {editing && <ContactsEditor m={m} team={team} api={api} onChanged={onChanged} onClose={() => onEdit(null)} confirm={confirm} />}
    </div>
  );
}

export default function ManufacturersView({ state, busy, error, onDecide, onRetry, api, onChanged, confirm }) {
  const [showDeclined, setShowDeclined] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // Your locations + reps, loaded the first time an editor opens (the Profile endpoint has both).
  const [team, setTeam] = useState({ status: 'idle', locations: [], reps: [] });
  const openEditor = async id => {
    setEditingId(id);
    if (!id || team.status === 'ready' || team.status === 'loading') return;
    setTeam(t => ({ ...t, status: 'loading' }));
    try {
      const j = await api('GET', '/api/supplier/me/profile');
      setTeam({ status: 'ready', locations: j.locations || [], reps: j.reps || [] });
    } catch (e) {
      setTeam({ status: 'error', locations: [], reps: [], error: String(e.message || e) });
    }
  };
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
                {rows.map(m => (
                  <MfgCard key={m.id} m={m} busy={busy} onDecide={onDecide} team={team}
                    editing={editingId === m.id} onEdit={openEditor} api={api} onChanged={onChanged} confirm={confirm} />
                ))}
              </div>
            </>}
          </section>
        );
      })}
    </div>
  );
}
