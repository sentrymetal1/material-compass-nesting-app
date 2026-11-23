/* takeoff-store.js — the take-off's working copy and its save to the project, for pages other than
   the review page (today: drawings.html). It uses the SAME browser keys and the SAME project save as
   review.html (lsKey "mc_takeoff_<project>", saved-signature "mc_takeoff_saved_sig_<project>",
   POST /api/takeoff/save), so the two pages share one take-off:
     - every change is written to this browser's copy at once, then to the project 15 s later
       (or straight away when the tab is hidden / closed), skipped when nothing changed;
     - after each change the other page is told {type:"changed", from:<page>} on the channel
       "mc-drawings-<project>" and re-reads the browser copy.
   Edits always start from the newest browser copy, so a change made on the other page a moment
   ago is never overwritten.
   PACKAGE FIELDS: keep PKG_FIELDS in step with doZohoSave() in review.html. */
(function () {
  "use strict";
  const MC_HOST = "https://material-compass-nesting-app-production.up.railway.app";
  const API = /(^|\.)up\.railway\.app$|^localhost$/.test(location.hostname) ? "" : MC_HOST;
  const DELAY = 15000;
  const PKG_FIELDS = { rows: null, fittings: null, synopsis: null, notes: null, cost_usd: null, drawing_files: [], labor: null, quote_notes: [],
    superseded: [], addendum_notices: [], addenda: null, out_of_scope: [], check: null, checked_v1: false,
    fittings_written: [], welds: [], features: [], labor_extras: null, weld_rules: [], drawing_counts: {}, labels_at: null,
    labor_methods: null, cost_summary: null, material_confirm: null, scales: null };
  const arr = (a) => (Array.isArray(a) ? a : []);

  function pkgOf(R) {
    const p = {};
    for (const k in PKG_FIELDS) {
      const d = PKG_FIELDS[k];
      p[k] = R[k] == null ? (Array.isArray(d) ? [] : d && typeof d === "object" ? {} : d) : R[k];
    }
    p.checked_v1 = !!R.checked_v1;
    return p;
  }
  function sig(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ":" + h; }

  function create(projectId, opts) {
    opts = opts || {};
    const from = opts.from || "page";
    const lsKey = "mc_takeoff_" + projectId, sigKey = "mc_takeoff_saved_sig_" + projectId;
    let timer = null, status = "idle", listeners = [];
    let ch = null;
    try { if ("BroadcastChannel" in window && projectId) ch = new BroadcastChannel("mc-drawings-" + projectId); } catch (e) {}

    const setStatus = (s, detail) => { status = s; listeners.forEach((f) => { try { f(s, detail); } catch (e) {} }); };
    function read() {
      try { const s = localStorage.getItem(lsKey); if (s) { const R = JSON.parse(s); if (R && arr(R.rows).length) return R; } } catch (e) {}
      return null;
    }
    async function load() {
      const R = read();
      if (R) return R;
      const r = await fetch(API + "/api/takeoff/saved/" + encodeURIComponent(projectId));
      const d = await r.json();
      if (d && d.ok === false) throw new Error(d.error || "The saved take-off could not be read.");
      if (!(d && d.ok && d.found && d.package)) return null;
      const P = d.package; P.__project = String(projectId);
      try { localStorage.setItem(lsKey, JSON.stringify(P)); } catch (e) {}
      return P;
    }
    function keep(R) {
      R.__project = String(projectId);
      R.__w = { by: from, at: Date.now() };   // the review page re-reads the copy when it sees a newer write from here
      try { localStorage.setItem(lsKey, JSON.stringify(R)); }
      catch (e) { setStatus("full", "This browser couldn't keep a copy. Wait for “Saved” before closing."); }
    }
    async function saveNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      const R = read(); if (!R) return;
      const body = JSON.stringify({ project_id: projectId, package: pkgOf(R) });
      const sg = sig(body);
      let last = null; try { last = localStorage.getItem(sigKey); } catch (e) {}
      if (last === sg) { setStatus("saved"); return; }
      setStatus("saving");
      try {
        const r = await fetch(API + "/api/takeoff/save", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60000 });
        const d = await r.json();
        if (d.ok) { try { localStorage.setItem(sigKey, sg); localStorage.setItem(sigKey + "_at", new Date().toISOString()); } catch (e) {} setStatus("saved"); }
        else setStatus("failed", d.error || "");
      } catch (e) { setStatus("failed", String(e.message || e)); }
    }
    // Apply fn to the newest copy, keep it, tell the other page, save to the project shortly.
    function change(fn) {
      const R = read(); if (!R) throw new Error("No take-off is open for this project.");
      const out = fn(R);
      if (out === false) return R;
      keep(R);
      if (ch) { try { ch.postMessage({ type: "changed", from }); } catch (e) {} }
      if (timer) clearTimeout(timer);
      timer = setTimeout(saveNow, DELAY);
      setStatus("pending");
      return R;
    }
    const flush = () => { if (timer) saveNow(); };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
    window.addEventListener("pagehide", flush);
    return { load, read, change, saveNow, flush, channel: ch, onStatus: (f) => listeners.push(f), get status() { return status; },
      savedAt: () => { try { return localStorage.getItem(sigKey + "_at"); } catch (e) { return null; } } };
  }

  /* ---- the line fixes, the same as review.html makes them (its drawings-edit handler,
     wcFixLength, wcKeepLength, editQty). Each takes the take-off R and returns an error text or "". */
  const fp = (r) => [r.member_mark, r.source_sheet, r.size, r.quantity, r.length_ft].map((x) => String(x == null ? "" : x)).join("|");
  const sk = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const sameSheet = (a, b) => { a = sk(a); b = sk(b); return !!a && !!b && (a === b || a.endsWith(b) || b.endsWith(a)); };
  function noteMm(r) {
    const note = String((r && r.note) || ""), L = Number(r && r.length_ft) || 0; if (!(L > 0) || r.mm_ok) return null;
    if (/plate|sheet/i.test(String(r.form_type || ""))) return null;
    const mm = []; note.replace(/(\d{2,5}(?:\.\d+)?)\s*mm\b/gi, (_, n) => { if (Number(n) >= 150) mm.push(Number(n)); return _; });
    if (!mm.length) return null; const inL = L * 12;
    if (mm.some((n) => Math.abs(n / 25.4 - inL) <= Math.max(0.25, inL * 0.02))) return null;
    return { mm: mm[0], note_in: mm[0] / 25.4, row_in: inL };
  }
  const isDouble = (r) => r && !r.deleted && Number(r.quantity) > 0 && !r.dbl_ok && Math.round(Number(r.units) || 1) > 1 &&
    /\(\s*\d+\s*assy|\d+\s*assy\b|assemblies\)|x\s*\d+\s*assy/i.test(String(r.note || ""));
  const units = (r) => Math.max(1, Math.round(Number(r.units) || 1));
  function applyEdit(R, m) {
    const rows = arr(R.rows), i = Number(m.i), r = rows[i];
    if (m.op !== "add" && m.op !== "new" && (!r || fp(r) !== m.fp)) return "That line changed a moment ago. It has been refreshed; try again.";
    if (m.op === "qty") {
      const v = Number(m.value); if (!(v >= 0)) return "Not a quantity.";
      if (r.qty_was == null) r.qty_was = r.quantity;
      r.quantity = Math.max(0, v); r.qty_per_unit = r.quantity; r.quantity_total = r.quantity * units(r);
    } else if (m.op === "length") {
      const v = Number(m.value); if (!(v > 0)) return "Not a length.";
      if (r.length_was_ft == null) r.length_was_ft = r.length_ft;
      r.length_ft = Math.round(v * 10000) / 10000; r.length_fixed = m.how || "set in the Drawings view";
    } else if (m.op === "useMm") {
      const x = noteMm(r); if (!x) return "That line is no longer flagged.";
      r.length_was_ft = r.length_ft; r.length_ft = Math.round(x.mm / 304.8 * 10000) / 10000; r.length_fixed = "note " + x.mm + " mm";
    } else if (m.op === "keepMm") r.mm_ok = true;
    else if (m.op === "dblFix") {
      if (!isDouble(r)) return "That line is no longer flagged.";
      const u = units(r); r.qty_was = r.quantity; r.quantity = Math.max(1, Math.round(Number(r.quantity) / u));
      r.qty_per_unit = r.quantity; r.quantity_total = r.quantity * u; r.dbl_ok = true;
    } else if (m.op === "dblKeep") r.dbl_ok = true;
    else if (m.op === "add") {
      const t = rows[Number(m.from)]; if (!t || fp(t) !== m.fp) return "That line changed a moment ago. It has been refreshed; try again.";
      const q = Math.round(Number(m.value) || 0); if (!(q > 0)) return "Type the quantity first.";
      const same = rows.filter((x) => x && !x.deleted && sameSheet(x.source_sheet, m.sheet)), base = same[0] || {};
      const nr = { form_type: t.form_type, material_type: t.material_type, specification: t.specification, size: t.size, length_ft: t.length_ft,
        width_ft: t.width_ft, member_mark: t.member_mark, galvanized: t.galvanized, disposition: t.disposition || "fabricate",
        component: base.component || t.component, units: base.units || 1, sheet_qty: base.sheet_qty, source_sheet: String(m.sheet),
        quantity: q, confidence: null, added_from: "drawings view",
        note: "Added in the Drawings view: " + (t.member_mark || "part") + " is printed on " + m.sheet + " with no take-off line; size and length copied from " + (t.source_sheet || "another drawing") + "." };
      nr.qty_per_unit = nr.quantity; nr.quantity_total = nr.quantity * units(nr);
      const at = same.length ? rows.lastIndexOf(same[same.length - 1]) + 1 : rows.length;
      rows.splice(at, 0, nr);
    } else if (m.op === "new") {
      // A line the take-off missed, typed in by hand on its drawing (Mark 11-23: "how does someone
      // manually add a line item"). Component and units come from the drawing's other lines.
      const x = m.row || {}, q = Math.round(Number(x.quantity) || 0), L = Number(x.length_ft) || 0;
      if (!String(x.size || "").trim()) return "Type the size.";
      if (!(q > 0)) return "Type the quantity.";
      if (!(L > 0)) return "Type the length.";
      const same = rows.filter((y) => y && !y.deleted && sameSheet(y.source_sheet, m.sheet)), base = same[0] || {};
      const nr = { form_type: String(x.form_type || "").trim(), material_type: String(x.material_type || "").trim() || base.material_type,
        specification: base.specification, size: String(x.size).trim(), length_ft: Math.round(L * 10000) / 10000,
        width_ft: Number(x.width_ft) > 0 ? Math.round(Number(x.width_ft) * 10000) / 10000 : undefined,
        member_mark: String(x.member_mark || "").trim(), galvanized: base.galvanized, disposition: "fabricate",
        component: base.component, units: base.units || 1, sheet_qty: base.sheet_qty, source_sheet: String(m.sheet),
        quantity: q, confidence: null, added_from: "drawings view (by hand)",
        note: "Added by hand in the Drawings view: the take-off had no line for it." };
      nr.qty_per_unit = nr.quantity; nr.quantity_total = nr.quantity * units(nr);
      const at = same.length ? rows.lastIndexOf(same[same.length - 1]) + 1 : rows.length;
      rows.splice(at, 0, nr);
    } else return "Unknown change.";
    return "";
  }

  window.TakeoffStore = { create, applyEdit, fp, noteMm, isDouble, sameSheet, PKG_FIELDS: Object.keys(PKG_FIELDS) };
})();
