import React, { useEffect, useState } from 'react';

// First-run checklist on the supplier dashboard. Every step is read from the supplier's own
// data, so it ticks itself off as they work — nobody marks anything done by hand. It goes
// away once all steps are done; until then it can be hidden for this browser.
const HIDE_KEY = email => 'mc-setup-hidden:' + String(email || '').toLowerCase();

function stepsFor({ profile, counts, manufacturers }) {
  const p = (profile && profile.profile) || {};
  const a = p.address || {};
  const hasAddress = !!(a.address_line_1 || a.district_city || a.postal_code);
  const locations = (profile && profile.locations) || [];
  const reps = (profile && profile.reps) || [];
  const stocked = (Number(counts && counts.structural_stock) || 0) + (Number(counts && counts.fitting_stock) || 0);
  const mfgList = (manufacturers && manufacturers.manufacturers) || [];
  const active = mfgList.filter(m => m.status === 'active').length;
  const pending = mfgList.filter(m => m.status === 'pending').length;
  return [
    {
      key: 'company', view: 'profile', cta: 'Open Profile',
      title: 'Complete your company details',
      why: 'Phone, address and the materials you service. Manufacturers see these when they look at your company.',
      done: !!(p.phone && hasAddress && p.material_serviced),
    },
    {
      key: 'locations', view: 'profile', cta: 'Add a location',
      title: 'Add your locations',
      why: 'Each branch or warehouse you ship from. Manufacturers are matched to suppliers within their area, by location.',
      done: locations.length > 0,
      detail: locations.length ? locations.length + ' added' : '',
    },
    {
      key: 'reps', view: 'profile', cta: 'Add a representative',
      title: 'Add your sales representatives',
      why: 'The people who receive quote requests by email. Assign each one to the location they work from.',
      done: reps.some(r => r.email),
      detail: reps.length ? reps.length + ' added' : '',
    },
    {
      key: 'stock', view: 'stock', cta: 'Mark your stock',
      title: 'Mark the material you stock',
      why: 'The most important step. Quote requests are only sent for material you have marked as stocked. Until you do, you won’t appear in manufacturer searches.',
      done: stocked > 0,
      detail: stocked ? stocked + ' item' + (stocked === 1 ? '' : 's') + ' stocked' : '',
    },
    {
      key: 'mfgs', view: 'manufacturers', cta: pending ? 'Review requests' : 'Open Manufacturers',
      title: 'Accept a manufacturer',
      why: pending
        ? pending + ' manufacturer' + (pending === 1 ? ' wants' : 's want') + ' to send you quote requests. Accept to start receiving them.'
        : 'Once your stock is marked, manufacturers near you can request to work with you. Requests appear on the Manufacturers tab. Accept them to start receiving quotes.',
      done: active > 0,
      detail: active ? active + ' active' : '',
    },
  ];
}

export default function SetupGuide({ email, counts, manufacturers, onGo }) {
  const [profile, setProfile] = useState(null);
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(HIDE_KEY(email)) === '1'; } catch (e) { return false; }
  });

  useEffect(() => {
    if (!email) return undefined;
    let live = true;
    fetch('/api/supplier/me/profile?email=' + encodeURIComponent(email))
      .then(r => r.json()).then(j => { if (live && j && j.ok) setProfile(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [email]);

  // Until the profile arrives the first three steps would read as not done; wait for it.
  if (!profile) return null;
  const steps = stepsFor({ profile, counts, manufacturers });
  const doneCount = steps.filter(s => s.done).length;
  if (doneCount === steps.length) return null;

  const setHide = v => {
    setHidden(v);
    try { if (v) localStorage.setItem(HIDE_KEY(email), '1'); else localStorage.removeItem(HIDE_KEY(email)); } catch (e) { /* private window */ }
  };
  if (hidden) {
    return (
      <div className="setup-mini">
        Setup: {doneCount} of {steps.length} done
        <button className="btn-link" onClick={() => setHide(false)}>Show steps</button>
      </div>
    );
  }
  const next = steps.find(s => !s.done);
  return (
    <section className="setup">
      <div className="setup-head">
        <div>
          <h2>Get set up to receive quote requests</h2>
          <div className="setup-sub">{doneCount} of {steps.length} done. Each step ticks itself off as you complete it.</div>
        </div>
        <button className="btn-link" onClick={() => setHide(true)}>Hide for now</button>
      </div>
      <div className="setup-bar"><div className="setup-bar-fill" style={{ width: (doneCount / steps.length * 100) + '%' }} /></div>
      <ol className="setup-steps">
        {steps.map((s, i) => (
          <li key={s.key} className={'setup-step' + (s.done ? ' setup-done' : '') + (s === next ? ' setup-next' : '')}>
            <span className="setup-num">{s.done ? '✓' : i + 1}</span>
            <div className="setup-body">
              <div className="setup-title">{s.title}{s.detail && <span className="setup-detail">{s.detail}</span>}</div>
              {!s.done && <div className="setup-why">{s.why}</div>}
            </div>
            {!s.done && (
              <button className={s === next ? 'btn-quote' : 'btn-link'} onClick={() => onGo(s.view)}>{s.cta}</button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
