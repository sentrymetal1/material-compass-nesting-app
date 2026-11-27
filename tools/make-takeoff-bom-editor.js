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

  // A lookup picked in a cell is saved as its bare record ID. Real records read back as
  // {ID, display_value}; here the row IS the read-back, so it is given its name from the editor's own
  // lookup cache. Without this the take-off stored "4111484000005482938" as the size (2026-11-24).
  var LK = { Form_Type: "Form_Types_Report", Material_Type: "Material_Types_Report", Specification: "Material_Form_Detail_Report",
    Material: "Beam_Channel_Tee_Lookup_Report", Component: "Project_Components", Length_INCH: "All_Length_Inch_Lookups",
    Width_FT: "All_Plate_Standard_Sizes", Width_INCH: "All_Length_Inch_Lookups" };
  function withLabel(k, v) {
    if (!LK[k] || v == null || v === "" || typeof v === "object") return v;
    var lbl = "";
    try { var c = (typeof lookupCache !== "undefined") && lookupCache[LK[k]]; lbl = c && c.byId && c.byId[String(v)]; } catch (e) {}
    return lbl ? { ID: String(v), display_value: String(lbl) } : v;
  }

  // The INCH and plate FT (W) pick-lists are read through getAllRecords too. Answering them with the
  // take-off rows gave the PM a list of "1".."5" (the item numbers) with no fractions, and every length
  // lost its inches (2026-11-24). They come from the server's catalog lists, shaped like the records.
  var BOM_REPORT = "Project_Bill_Of_Material_Detail_Form_Report", listCache = {};
  var LISTS = {
    All_Length_Inch_Lookups: { url: "/api/lookups/length-inch",
      map: function (x) { return { ID: String(x.id), Description: String(x.description || ""), Result: Number(x.result) || 0 }; } },
    All_Plate_Standard_Sizes: { url: "/api/lookups/plate-widths",
      map: function (x) { return { ID: String(x.id), Description: String(x.description || ""), Width: Number(x.width_ft) || 0 }; } },
  };
  function listRecords(name, page) {
    var L = LISTS[name];
    if (!L || (page && page > 1)) return Promise.resolve({ code: 3000, data: [] });
    listCache[name] = listCache[name] || fetch(L.url).then(function (r) {
      if (!r.ok) throw new Error("list " + name + " " + r.status);
      return r.json();
    }).then(function (a) { return (Array.isArray(a) ? a : []).map(L.map); })
      .catch(function (e) { delete listCache[name]; throw e; });
    return listCache[name].then(function (data) { return { code: 3000, data: data }; });
  }

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
        // Paged like Zoho: the editor loops while a page comes back full, so handing every
        // row back for every page would never end.
        getAllRecords: function (a) {
          if (a && a.reportName && a.reportName !== BOM_REPORT) return listRecords(a.reportName, a.page);
          var size = (a && a.pageSize) || 200, page = (a && a.page) || 1;
          return Promise.resolve({ code: 3000, data: rows.slice((page - 1) * size, page * size) });
        },
        getRecordById: function () { return Promise.resolve({ code: 3000, data: project || {} }); },
        updateRecord: function (a) {
          var r = byId(a && a.id), d = (a && a.data && a.data.data) || {};
          if (!r) return Promise.reject(new Error("no such row: " + (a && a.id)));
          for (var k in d) r[k] = withLabel(k, d[k]);
          changed();
          return Promise.resolve(OK);
        },
        addRecord: function (a) {
          var d = (a && a.data && a.data.data) || {};
          var rec = { ID: "T-new-" + (++seq) };
          for (var k in d) rec[k] = withLabel(k, d[k]);
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

  // 2b. The tenant token script, FIRST in <head>, so every call the editor makes carries it.
  out = out.replace(/<head>/i, '<head>\n  <script src="/takeoff/mc-token.js"></script>');

  // 3. A banner so a copy found in the wild is never mistaken for the source.
  out = out.replace(/<html/i, "<!-- GENERATED FILE — do not edit. Source: bom-editor/index.html, " +
    "built by tools/make-takeoff-bom-editor.js. Edit the editor and re-run the build. -->\n<html");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  const ver = (src.match(/v\d+\.\d+\.\d+/) || ["(unknown)"])[0];
  console.log("wrote " + OUT + "  (" + out.length + " bytes, editor " + ver + ")");
}

main();
