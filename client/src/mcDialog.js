// Material Compass's own alert, for the React pages.
//
// window.alert() prints "<host> says" above the message and nothing can reword
// it, so every error put the hosting address in front of a supplier instead of
// the product's name. The styled dialog lives in one place, served by the same
// app at /takeoff/mc-dialog.js and loaded from public/index.html, so the take-off
// pages and these ones can never drift apart. If that script ever fails to load,
// fall back to the browser's box rather than swallowing the error.
export function mcAlert(message, title) {
  if (typeof window !== 'undefined' && typeof window.mcAlert === 'function') {
    return window.mcAlert(message, { title: title || 'Supplier Portal' });
  }
  window.alert(message);
  return Promise.resolve();
}
