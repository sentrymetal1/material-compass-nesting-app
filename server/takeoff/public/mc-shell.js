/* mc-shell.js — keeps a Material Compass page inside the platform instead of in a new tab.

   1. FRAMED: when the page runs inside the portal (a Zoho page's iframe, or another of our pages),
      <html> gets class mc-embed: the "Material Compass" brand is hidden (the portal already shows it),
      the page uses the full width and tighter padding. The page title and its buttons stay.
      Opt out with <script src="/takeoff/mc-shell.js" data-embed="off"> (pages with their own layout).
   2. BACK LINK: a page opened with ?from=setup shows "← Back to shop setup" in its header. Links to our
      other pages clicked on it carry from= along, so Setup → Team → Import clients still leads back.
   3. PANEL: mcOpenPanel(url, {title}) opens one of our pages over this one (iframe + Close), instead
      of a new tab. Links marked <a data-mc-panel="Title" href="..."> do the same. Closing it fires
      window event "mc-panel-closed" (detail = {url}) so the page can re-read what may have changed.

   Load after mc-token.js (it reads window.MC_TOKEN). Safe to load twice. */
(function () {
  if (window.mcOpenPanel) return;
  var me = document.currentScript;
  var embedOn = !(me && me.getAttribute("data-embed") === "off");
  var framed = false;
  try { framed = window.top !== window; } catch (e) { framed = true; }
  var Q = new URLSearchParams(location.search);
  var MFG = Q.get("manufacturer_id") || "";
  var TOK = window.MC_TOKEN || Q.get("t") || "";

  // Pages a user can be sent back to. key = the from= value.
  var FROM = {
    setup: { page: "setup.html", label: "shop setup" },
    clients: { page: "clients.html", label: "clients" },
  };
  var from = Q.get("from") || "";
  if (!FROM[from]) from = "";
  var here = (location.pathname.split("/").pop() || "").toLowerCase();
  if (from && FROM[from].page === here) from = "";   // already back where we came from

  var CSS =
    "html.mc-embed .appbar .brand{display:none!important}" +
    "html.mc-embed body{padding:12px 16px!important}" +
    "html.mc-embed .wrap,html.mc-embed .appbar{max-width:none!important}" +
    "html.mc-embed .appbar .page{border-left:0!important;padding-left:0!important}" +
    "html.mc-embed .appbar.mcs-hide{display:none!important}" +
    ".mcs-back{display:flex;align-items:center;gap:10px;margin:0 0 12px}" +
    "a.mcs-bl{font:600 13px/1.4 'Segoe UI',system-ui,sans-serif;color:#2f6db3;text-decoration:none;background:#fff;border:1px solid #cdd3da;border-radius:8px;padding:5px 12px;white-space:nowrap}" +
    "a.mcs-bl:hover{background:#f3f7fc}" +
    ".mcs-pw{position:fixed;inset:0;z-index:2147482000;background:rgba(29,36,48,.42);display:flex;padding:22px}" +
    ".mcs-pc{flex:1;display:flex;flex-direction:column;background:#eef1f5;border-radius:12px;overflow:hidden;box-shadow:0 18px 50px rgba(20,30,40,.3)}" +
    ".mcs-ph{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fff;border-bottom:1px solid #e3e7ec;font:600 14px 'Segoe UI',system-ui,sans-serif;color:#1d2430}" +
    ".mcs-ph span{flex:1}" +
    ".mcs-ph button{font:600 13px 'Segoe UI',system-ui,sans-serif;background:#2f6db3;color:#fff;border:0;border-radius:8px;padding:6px 16px;cursor:pointer}" +
    ".mcs-pc iframe{flex:1;border:0;width:100%;background:#eef1f5}";

  var st = document.createElement("style");
  st.textContent = CSS;
  (document.head || document.documentElement).appendChild(st);
  if (framed && embedOn) document.documentElement.classList.add("mc-embed");

  function ourPage(href) {
    try {
      var u = new URL(href, location.href);
      return u.origin === location.origin && /^\/takeoff\/[\w-]+\.html$/.test(u.pathname) ? u : null;
    } catch (e) { return null; }
  }
  function pageUrl(page) {
    return "/takeoff/" + page + "?manufacturer_id=" + encodeURIComponent(MFG) + (TOK ? "&t=" + encodeURIComponent(TOK) : "");
  }

  // ---- Header + back link ---------------------------------------------------------------------
  // Framed, a header holding only the brand and the page name repeats what the portal and the
  // page's own heading already say: hide it. A header with anything else (buttons, save state)
  // stays. The back link goes at the front of the header when there is one, else in its own row.
  function fixHeader() {
    var bar = document.querySelector(".appbar");
    var back = null;
    if (from && MFG) {
      back = document.createElement("a");
      back.className = "mcs-bl";
      back.href = pageUrl(FROM[from].page);
      back.textContent = "← Back to " + FROM[from].label;
    }
    if (bar) {
      if (back) bar.insertBefore(back, bar.firstChild);
      else if (framed && embedOn) {
        var bare = Array.prototype.every.call(bar.children, function (c) {
          return c.classList.contains("brand") || c.classList.contains("page") || c.classList.contains("sp");
        });
        if (bare) bar.classList.add("mcs-hide");
      }
    } else if (back) {
      var row = document.createElement("div");
      row.className = "mcs-back";
      row.appendChild(back);
      var host = document.querySelector(".wrap") || document.body;
      host.insertBefore(row, host.firstChild);
    }
  }

  // ---- Panel ----------------------------------------------------------------------------------
  var openPanel = null;
  function closePanel() {
    if (!openPanel) return;
    var p = openPanel; openPanel = null;
    p.el.remove();
    document.removeEventListener("keydown", onKey, true);
    try { window.dispatchEvent(new CustomEvent("mc-panel-closed", { detail: { url: p.url } })); } catch (e) {}
  }
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); closePanel(); } }
  window.mcOpenPanel = function (url, opts) {
    opts = opts || {};
    closePanel();
    var u = ourPage(url);
    if (u && TOK && !u.searchParams.get("t")) u.searchParams.set("t", TOK);
    var src = u ? u.pathname + u.search : url;
    var w = document.createElement("div");
    w.className = "mcs-pw";
    w.innerHTML = '<div class="mcs-pc"><div class="mcs-ph"><span></span><button type="button">Close</button></div><iframe></iframe></div>';
    w.querySelector(".mcs-ph span").textContent = opts.title || "";
    w.querySelector("button").addEventListener("click", closePanel);
    w.addEventListener("click", function (e) { if (e.target === w) closePanel(); });
    w.querySelector("iframe").src = src;
    document.body.appendChild(w);
    document.addEventListener("keydown", onKey, true);
    openPanel = { el: w, url: src };
  };
  window.mcClosePanel = closePanel;

  // ---- Links ----------------------------------------------------------------------------------
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest("a[href]");
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    if (a.hasAttribute("data-mc-panel")) {
      ev.preventDefault();
      window.mcOpenPanel(a.getAttribute("href"), { title: a.getAttribute("data-mc-panel") });
      return;
    }
    // Carry from= onto links to our other pages, so the back bar survives a step's own links.
    if (!from || a.target === "_top" || a.target === "_blank") return;
    var u = ourPage(a.getAttribute("href"));
    if (!u || u.searchParams.get("from")) return;
    u.searchParams.set("from", from);
    a.setAttribute("href", u.pathname + u.search + u.hash);
  }, true);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fixHeader);
  else fixHeader();
})();
