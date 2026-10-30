import React, { useState, useCallback, useEffect } from 'react';

// In-app replacement for window.confirm. The browser's own box shows the embedded page's address
// (…railway.app) and can't be styled, so confirmations go through this Material Compass dialog.
//   const [confirmDialog, confirm] = useConfirm();
//   if (!(await confirm({ title, message, confirmLabel, danger: true }))) return;
//   …and render {confirmDialog} once.
export function useConfirm() {
  const [req, setReq] = useState(null);
  const confirm = useCallback(opts => new Promise(resolve => setReq({ ...opts, resolve })), []);
  const close = ok => { if (req) req.resolve(ok); setReq(null); };

  useEffect(() => {
    if (!req) return undefined;
    const onKey = e => { if (e.key === 'Escape') { req.resolve(false); setReq(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);

  const dialog = req ? (
    <div className="mc-dialog-backdrop" onClick={() => close(false)}>
      <div className="mc-dialog" role="dialog" aria-modal="true" aria-labelledby="mc-dialog-title" onClick={e => e.stopPropagation()}>
        <div className="mc-dialog-brand"><span className="sup-logo">◆</span> Material Compass</div>
        <h2 id="mc-dialog-title" className="mc-dialog-title">{req.title}</h2>
        {req.message && <p className="mc-dialog-msg">{req.message}</p>}
        <div className="mc-dialog-actions">
          <button type="button" className="btn-secondary" onClick={() => close(false)}>{req.cancelLabel || 'Cancel'}</button>
          <button type="button" className={req.danger ? 'btn-danger' : 'btn-quote'} autoFocus onClick={() => close(true)}>
            {req.confirmLabel || 'OK'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return [dialog, confirm];
}
