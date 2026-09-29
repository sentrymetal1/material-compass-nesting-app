/* mc-token.js — carries the tenant token from the link that opened this page onto every call it
   makes to the Material Compass server. Load it FIRST, before any script that calls fetch.

   Zoho mints the token for the logged-in shop and puts it on the launch link as ?t=. It is kept
   for the tab (sessionStorage), so a page opened from this one — index -> review, the BOM editor
   iframe — still has it. Calls to our own server get an X-MC-Token header; plain links to our API
   (file downloads) get ?t= added when clicked, because a link cannot send a header. */
(function () {
  var KEY = "mc_t", t = "";
  try { t = new URLSearchParams(location.search).get("t") || ""; } catch (e) {}
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else t = sessionStorage.getItem(KEY) || "";
  } catch (e) {}
  window.MC_TOKEN = t;
  if (!t) return;

  var ours = function (url) {
    var s = String(url || "");
    return s.charAt(0) === "/" || s.indexOf(location.origin) === 0 || /material-compass-nesting-app[^/]*\.up\.railway\.app/.test(s);
  };

  var f = window.fetch;
  if (f) {
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : (input && input.url);
        if (ours(url)) {
          init = init || {};
          var h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
          if (!h.has("X-MC-Token")) h.set("X-MC-Token", t);
          init.headers = h;
        }
      } catch (e) {}
      return f.call(this, input, init);
    };
  }

  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!/\/api\//.test(href) || !ours(href) || /[?&]t=/.test(href)) return;
    a.setAttribute("href", href + (href.indexOf("?") > -1 ? "&" : "?") + "t=" + encodeURIComponent(t));
  }, true);
})();
