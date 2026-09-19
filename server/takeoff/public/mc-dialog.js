// =============================================================================
//  mc-dialog.js — Material Compass's own alert and confirm.
// -----------------------------------------------------------------------------
//  A browser alert() or confirm() prints "<host> says" above the message, and
//  nothing can suppress or reword it. On a page served from a personal GitHub
//  Pages account that line read "sentrymetal1.github.io says" on every error
//  and every delete confirmation. The only way to keep the product's own name in
//  front of the user is to not use the browser's dialogs at all.
//
//    await mcAlert("Saved.", { title: "Take-off" });
//    if (!(await mcConfirm("Delete this?", { danger: true, okText: "Delete" }))) return;
//
//  Both return Promises, so a call site that was `if(!confirm(...)) return;`
//  becomes `if(!(await mcConfirm(...))) return;` inside an async function.
//
//  Calls are QUEUED. A loop that reports three bad files shows three dialogs one
//  after another, never stacked on top of each other with only the last one
//  answerable. Self-contained: injects its own styles and markup on first use.
// =============================================================================
(function () {
  if (window.mcConfirm && window.mcAlert) return;   // loaded twice — keep the first

  var CSS =
    ".mcd-wrap{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;" +
      "padding:20px;background:rgba(29,36,48,.42)}" +
    ".mcd-wrap.show{display:flex}" +
    ".mcd-card{background:#fff;border-radius:14px;max-width:460px;width:100%;box-shadow:0 18px 50px rgba(20,30,40,.28);" +
      "font:14px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1d2430;overflow:hidden}" +
    ".mcd-head{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid #e8ecf1;background:#f7f9fc}" +
    ".mcd-mark{width:22px;height:22px;border-radius:6px;background:#2f6db3;color:#fff;font:700 10px/22px system-ui,sans-serif;" +
      "text-align:center;letter-spacing:.02em;flex:none}" +
    ".mcd-brand{font-size:12px;font-weight:700;color:#1d2430;letter-spacing:.01em}" +
    ".mcd-title{font-size:12px;color:#667;margin-left:auto}" +
    ".mcd-body{padding:18px 20px 6px;white-space:pre-line;word-wrap:break-word;max-height:60vh;overflow:auto}" +
    ".mcd-row{display:flex;gap:8px;justify-content:flex-end;padding:14px 20px 18px;flex-wrap:wrap}" +
    ".mcd-btn{font:600 13px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:9px 18px;border-radius:8px;cursor:pointer;border:1px solid transparent}" +
    ".mcd-ok{background:#2f6db3;color:#fff}" +
    ".mcd-ok:hover{background:#285f9c}" +
    ".mcd-ok.danger{background:#b3261e}" +
    ".mcd-ok.danger:hover{background:#961f18}" +
    ".mcd-cancel{background:#fff;color:#1d2430;border-color:#cfd6de}" +
    ".mcd-cancel:hover{background:#f2f5f8}" +
    ".mcd-btn:focus-visible{outline:2px solid #2f6db3;outline-offset:2px}" +
    "@media (max-width:480px){.mcd-row{justify-content:stretch}.mcd-btn{flex:1}}";

  var el = null, queue = [], busy = false;

  function build() {
    if (el) return;
    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    el = document.createElement("div");
    el.className = "mcd-wrap";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML =
      '<div class="mcd-card">' +
        '<div class="mcd-head"><span class="mcd-mark">MC</span><span class="mcd-brand">Material Compass</span>' +
          '<span class="mcd-title"></span></div>' +
        '<div class="mcd-body"></div>' +
        '<div class="mcd-row"><button type="button" class="mcd-btn mcd-cancel"></button>' +
          '<button type="button" class="mcd-btn mcd-ok"></button></div>' +
      '</div>';
    document.body.appendChild(el);
  }

  function next() {
    if (busy || !queue.length) return;
    busy = true;
    var job = queue.shift();
    build();
    var ok = el.querySelector(".mcd-ok"), cancel = el.querySelector(".mcd-cancel");
    el.querySelector(".mcd-title").textContent = job.opts.title || "";
    el.querySelector(".mcd-body").textContent = String(job.message == null ? "" : job.message);   // text, never HTML
    ok.textContent = job.opts.okText || "OK";
    ok.className = "mcd-btn mcd-ok" + (job.opts.danger ? " danger" : "");
    cancel.textContent = job.opts.cancelText || "Cancel";
    cancel.style.display = job.confirm ? "" : "none";
    var prevFocus = document.activeElement;

    function done(result) {
      el.classList.remove("show");
      ok.onclick = cancel.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      el.onclick = null;
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
      busy = false;
      job.resolve(job.confirm ? result : undefined);
      next();
    }
    // Enter is left to whichever button has focus, so it can never confirm a
    // delete that deliberately opened with focus on Cancel. Escape always backs out.
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
    }
    ok.onclick = function () { done(true); };
    cancel.onclick = function () { done(false); };
    // A click on the dimmed backdrop cancels a confirm; an alert has to be read.
    el.onclick = function (e) { if (e.target === el && job.confirm) done(false); };
    document.addEventListener("keydown", onKey, true);
    el.classList.add("show");
    // A destructive confirm lands focus on Cancel, so a reflexive Enter does not delete.
    setTimeout(function () { (job.confirm && job.opts.danger ? cancel : ok).focus(); }, 0);
  }

  function enqueue(confirm, message, opts) {
    return new Promise(function (resolve) {
      queue.push({ confirm: confirm, message: message, opts: opts || {}, resolve: resolve });
      if (document.body) next();
      else document.addEventListener("DOMContentLoaded", next, { once: true });
    });
  }

  window.mcAlert = function (message, opts) { return enqueue(false, message, opts); };
  window.mcConfirm = function (message, opts) { return enqueue(true, message, opts); };
})();
