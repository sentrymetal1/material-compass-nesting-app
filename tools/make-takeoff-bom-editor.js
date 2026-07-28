// =============================================================================
//  make-takeoff-bom-editor.js — generate the take-off copy of the BOM Editor.
// -----------------------------------------------------------------------------
//  The review page needs the SAME grid the estimator already uses on the project:
//  the catalog cascade, live weights, bulk apply, add/delete. Forking 2,500 lines
//  would guarantee drift, so nothing is rewritten. Instead this takes the editor
//  source verbatim, drops the Zoho widget SDK, and injects a SHIM that answers
//  the handful of ZOHO.CREATOR calls out of memory:
//
//    getAllRecords  → the take-off rows the parent page posted in
//    updateRecord   → mutate that in-memory row, tell the parent
//    addRecord      → append a row, hand back a synthetic ID
//    deleteRecord   → drop it
//    getRecordById  → the project header the parent supplied
//
//  So the editor believes it is talking to Zoho, and not one line of its logic
//  changes — while nothing is written to the project until the estimator
//  approves the take-off. Lookups already come from Railway, so those are
//  untouched.
//
//  Run after ANY change to the editor:  node tools/make-takeoff-bom-editor.js
//  Source:  ../Projects/bom-editor/index.html   (override with $BOM_EDITOR_SRC)
//  Output:  server/takeoff/public/bom-editor.html   (committed — Railway has no
//           access to the editor repo at build time)
// =============================================================================

const fs = require("fs");
const path = require("path");

const SRC = process.env.BOM_EDITOR_SRC ||
  path.join(__dirname, "..", "..", "Projects", "bom-editor", "index.html");
const OUT = path.join(__dirname, "..", "server", "takeoff", "public", "bom-editor.html");

const SHIM = `
<script>
/* ---------------------------------------------------------------------------
   TAKE-OFF MODE (?mode=takeoff) — injected by tools/make-takeoff-bom-editor.js.
   Stands in for the Zoho widget SDK so this editor can work a take-off that has
   not been committed yet. Every "save" lands in memory and is posted to the
   parent page; nothing reaches Zoho until the estimator approves. Without the
   flag the file behaves exactly as the widget always did.
--------------------------------------------------------------------------- */
(function () {
  var qs = new URLSearchParams(location.search);
  if (qs.get("mode") !== "takeoff") return;

  var rows = [], project = null, seq = 0, resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });

  function post(type, extra) {
    var msg = { type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    try { parent.postMessage(msg, "*"); } catch (e) {}
  }
  function changed() { post("takeoff:changed", { records: rows }); }
  function byId(id) {
    for (var i = 0; i < rows.length; i++) if (String(rows[i].ID) === String(id)) return rows[i];
    return null;
  }
  // deleteRecord is given criteria ("ID == 123"), never a bare id — same as the real SDK.
  function idFromCriteria(c) {
    var m = String(c || "").match(/ID\\s*==\\s*([A-Za-z0-9_]+)/);
    return m ? m[1] : "";
  }

  window.addEventListener("message", function (ev) {
    var m = ev.data || {};
    if (m.type !== "takeoff:rows") return;
    rows = Array.isArray(m.records) ? m.records : [];
    project = m.project || null;
    resolveReady(true);
  });
  post("takeoff:ready");                      // the parent waits for this before sending rows

  var OK = { code: 3000, result: "success" };
  window.ZOHO = {
    CREATOR: {
      init: function () { return ready; },    // boots only once the rows are in
      UTIL: {
        getQueryParams: function () { var o = {}; qs.forEach(function (v, k) { o[k] = v; }); return o; },
        // The editor's Back button navigates the host page; here it's the parent's call.
        navigateParentURL: function (url) { post("takeoff:navigate", { url: url }); },
      },
      API: {
        getAllRecords: function () { return Promise.resolve({ code: 3000, data: rows.slice() }); },
        getRecordById: function () { return Promise.resolve({ code: 3000, data: project || {} }); },
        updateRecord: function (a) {
          var r = byId(a && a.id), d = (a && a.data && a.data.data) || {};
          if (!r) return Promise.reject(new Error("no such row: " + (a && a.id)));
          for (var k in d) r[k] = d[k];
          changed();
          return Promise.resolve(OK);
        },
        addRecord: function (a) {
          var d = (a && a.data && a.data.data) || {};
          var rec = { ID: "T-new-" + (++seq) };
          for (var k in d) rec[k] = d[k];
          rows.push(rec);
          changed();
          return Promise.resolve({ code: 3000, data: rec });
        },
        deleteRecord: function (a) {
          var id = idFromCriteria(a && a.criteria);
          var i = rows.findIndex(function (r) { return String(r.ID) === String(id); });
          if (i >= 0) rows.splice(i, 1);
          changed();
          return Promise.resolve(OK);
        },
        uploadFile: function () { return Promise.resolve(OK); },
        // Force the Railway lookup path — the custom-API shortcut only exists inside Zoho.
        invokeCustomApi: function () { return Promise.reject(new Error("custom API unavailable in take-off mode")); },
      },
    },
  };
})();
</script>
`;

function main() {
  if (!fs.existsSync(SRC)) {
    console.error("BOM Editor source not found: " + SRC +
      "\nSet BOM_EDITOR_SRC to its path and re-run.");
    process.exit(1);
  }
  const src = fs.readFileSync(SRC, "utf8");

  // 1. Drop the Zoho widget SDK — in take-off mode it would fight the shim, and
  //    outside Zoho it never resolves anyway.
  const sdk = /<script[^>]*widgetsdk[^>]*><\/script>/i;
  if (!sdk.test(src)) {
    console.error("Could not find the widget SDK <script> tag — the editor's markup changed. " +
      "Check the tag and update this build step rather than shipping an unshimmed copy.");
    process.exit(1);
  }
  let out = src.replace(sdk, "<!-- widget SDK removed: take-off mode supplies its own ZOHO shim -->");

  // 2. Inject the shim as the FIRST script in <head>, so window.ZOHO exists before
  //    the editor's own script runs ZOHO.CREATOR.init().
  const head = out.indexOf("</head>");
  if (head < 0) { console.error("No </head> in the editor source."); process.exit(1); }
  out = out.slice(0, head) + SHIM + out.slice(head);

  // 3. A banner so a copy found in the wild is never mistaken for the source.
  out = out.replace(/<html/i, "<!-- GENERATED FILE — do not edit. Source: bom-editor/index.html, " +
    "built by tools/make-takeoff-bom-editor.js. Edit the editor and re-run the build. -->\n<html");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  const ver = (src.match(/v\d+\.\d+\.\d+/) || ["(unknown)"])[0];
  console.log("wrote " + OUT + "  (" + out.length + " bytes, editor " + ver + ")");
}

main();
