/* =============================================================================
 * scope-pills.js — "What this quote includes" + "How it gets made" on the AI Take-off page.
 * -----------------------------------------------------------------------------
 * Mark (2026-11-10): show the triage pills again here, plus a drill-down of how the job gets made
 * (cutting, holes, pipe ends, forming, welding, prep, inspection, assembly). Everything optional.
 * Option lists come from GET /api/triage/scope-def (server/triageScope.js) so this page and the
 * triage page can never disagree. Changes save to the project (POST /api/triage/scope, key p:<id>)
 * and the server hands back the words the AI reads ("SCOPE: … / HOW IT GETS MADE: …").
 *
 * Usage: McScope.mount(el, { base, project_id, manufacture, scope, scope_text, onText(text) })
 * ============================================================================= */
(function () {
  var CSS =
    ".mcs-head{font-size:13px;font-weight:700;color:#2b3340;margin:2px 0 6px}" +
    ".mcs-head span{font-weight:400;color:#8893a0}" +
    ".mcs-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 12px}" +
    ".mcs-p,.mcs-o{font:inherit;font-size:12px;font-weight:600;padding:4px 10px;border-radius:14px;cursor:pointer;border:1px solid;line-height:1.4;background:#fff}" +
    ".mcs-p.yes,.mcs-o.yes,.mcs-o.in{background:#e9f6ec;border-color:#a9d8b5;color:#1a6b34}" +
    ".mcs-o.out{background:#fff1e8;border-color:#f2b48f;color:#8a3b0a}" +
    ".mcs-p.no,.mcs-o.no{background:#f2f4f6;border-color:#d5dbe1;color:#5b6573}" +
    ".mcs-p.open{background:#fff7e6;border:1px dashed #e0b25c;color:#7a5000}" +
    ".mcs-o.open{border-color:#d5dbe1;color:#3d4955}" +
    ".mcs-p:hover,.mcs-o:hover{filter:brightness(.97)}" +
    ".mcs-p .ai{font-size:9.5px;font-weight:700;letter-spacing:.04em;background:#5F94CE;color:#fff;border-radius:6px;padding:0 4px;margin-left:5px;vertical-align:1px}" +
    ".mcs select{font:inherit;font-size:12px;border:1px solid #cdd3da;border-radius:14px;padding:3px 8px;background:#fff;color:#23303b}" +
    ".mcs select.open{background:#fff7e6;border:1px dashed #e0b25c;color:#7a5000}" +
    ".mcs-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;margin:0 0 12px}" +
    "@media (max-width:900px){.mcs-groups{grid-template-columns:1fr}}" +
    ".mcs-g{border:1px solid #e3e8ee;border-radius:8px;background:#fff}" +
    ".mcs-g summary{cursor:pointer;padding:7px 10px;font-size:12.5px;font-weight:700;color:#2b3340;list-style:revert}" +
    ".mcs-g summary .sum{font-weight:400;color:#5b6573;margin-left:6px}" +
    ".mcs-g .mcs-row{padding:2px 10px 8px;margin:0}" +
    ".mcs-saved{font-size:11.5px;color:#8893a0;min-height:14px}";

  var WHERE_NEXT = { "": "in", "in": "out", "out": "no", "no": "" };
  var YES_NEXT = { "": "yes", "yes": "no", "no": "" };
  var TRI_NEXT = { "": "yes", "yes": "no", "no": "" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function mount(root, opts) {
    if (!root) return;
    opts = opts || {};
    if (!document.getElementById("mcs-style")) {
      var st = document.createElement("style"); st.id = "mcs-style"; st.textContent = CSS;
      document.head.appendChild(st);
    }
    root.classList.add("mcs");
    var base = opts.base || "";
    var defs = null;
    var scope = normalize(opts.scope);
    var openGroups = {};
    var saveTimer = null;

    function normalize(s) {
      s = s && typeof s === "object" ? s : {};
      return {
        items: s.items && typeof s.items === "object" ? s.items : {},
        finish: s.finish && typeof s.finish === "object" ? s.finish : {},
        ops: s.ops && typeof s.ops === "object" ? s.ops : {},
        picks: s.picks && typeof s.picks === "object" ? s.picks : {},
      };
    }

    function itemPill(it) {
      var cur = scope.items[it.key] || {};
      var v = cur.v || "";
      var cls = v === "yes" ? "yes" : v === "no" ? "no" : "open";
      var mark = v === "yes" ? "✓" : v === "no" ? "✕" : "?";
      var state = v === "yes" ? "included" : v === "no" ? "not included" : "not decided";
      var tip = it.label + ": " + state + (cur.src === "ai" && cur.why ? " (the AI read this from: " + cur.why + ")" : "") + ". Click to change.";
      return '<button type="button" class="mcs-p ' + cls + '" data-k="' + it.key + '" title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
        mark + " " + esc(it.label) + (cur.src === "ai" ? '<span class="ai">AI</span>' : "") + "</button>";
    }

    function finishSelects() {
      var f = scope.finish || {};
      var h = '<select data-f="type" aria-label="Finish" class="' + (f.type ? "" : "open") + '"><option value="">Finish: not decided</option>' +
        defs.finish_types.map(function (o) { return '<option value="' + o.key + '"' + (f.type === o.key ? " selected" : "") + ">Finish: " + esc(o.label) + "</option>"; }).join("") + "</select>";
      if (f.type && f.type !== "none") {
        h += '<select data-f="by" aria-label="Who does the finish" class="' + (f.by ? "" : "open") + '"><option value="">Finish by: not decided</option>' +
          defs.finish_by.map(function (o) { return '<option value="' + o.key + '"' + (f.by === o.key ? " selected" : "") + ">Finish by: " + esc(o.label) + "</option>"; }).join("") + "</select>";
      }
      return h;
    }

    function optPill(o) {
      var v = scope.ops[o.key] || "";
      var label = o.label, tail = "";
      if (o.kind === "where") tail = v === "in" ? " · in house" : v === "out" ? " · outside" : v === "no" ? " · not needed" : "";
      else tail = v === "no" ? " · no" : "";
      var mark = v === "yes" || v === "in" ? "✓ " : v === "out" ? "↗ " : v === "no" ? "✕ " : "";
      var cls = v || "open";
      var next = o.kind === "where" ? "In house → Outside → Not needed → not decided" : "Yes → No → not decided";
      return '<button type="button" class="mcs-o ' + cls + '" data-o="' + o.key + '" data-kind="' + o.kind + '" title="' + esc(o.label + ". Click to change: " + next) + '">' +
        mark + esc(label) + esc(tail) + "</button>";
    }

    function pickSelect(pk) {
      var p = defs.ops_picks[pk];
      var val = scope.picks[pk] || "";
      var dflt = defs.defaults && defs.defaults[pk];
      var dOpt = dflt && p.options.filter(function (o) { return o.key === dflt; })[0];
      var first = dOpt ? p.label + ": " + dOpt.label + " (shop default)" : p.label + ": not decided";
      return '<select data-pick="' + pk + '" aria-label="' + esc(p.label) + '" class="' + (val || dOpt ? "" : "open") + '">' +
        '<option value="">' + esc(first) + "</option>" +
        p.options.map(function (o) { return '<option value="' + o.key + '"' + (val === o.key ? " selected" : "") + ">" + esc(p.label + ": " + o.label) + "</option>"; }).join("") +
        "</select>";
    }

    function groupSummary(g) {
      var bits = [];
      (g.picks || []).forEach(function (pk) {
        var val = scope.picks[pk] || (defs.defaults || {})[pk];
        var o = val && defs.ops_picks[pk].options.filter(function (x) { return x.key === val; })[0];
        if (o) bits.push(o.label.replace(/ \(.*\)$/, ""));
      });
      g.options.forEach(function (o) {
        var v = scope.ops[o.key];
        if (v && v !== "no") bits.push(o.label.replace(/ \(.*\)$/, "").toLowerCase() + (v === "out" ? " (outside)" : ""));
      });
      return bits.length ? bits.join(", ") : "not set";
    }

    function render() {
      if (!defs) { root.innerHTML = '<div class="mcs-saved">Loading the scope options…</div>'; return; }
      var groups = defs.ops_groups.map(function (g) {
        var isOpen = openGroups[g.key] ? " open" : "";
        return '<details class="mcs-g" data-g="' + g.key + '"' + isOpen + "><summary>" + esc(g.label) +
          '<span class="sum">' + esc(groupSummary(g)) + "</span></summary>" +
          '<div class="mcs-row">' + (g.picks || []).map(pickSelect).join("") + g.options.map(optPill).join("") + "</div></details>";
      }).join("");
      root.innerHTML =
        '<div class="mcs-head">What this quote includes <span>· carried from triage · click a pill to change it</span></div>' +
        '<div class="mcs-row">' + defs.items.map(itemPill).join("") + finishSelects() + "</div>" +
        '<div class="mcs-head">How it gets made <span>· optional · open a group to choose · the AI reads these with your notes</span></div>' +
        '<div class="mcs-groups">' + groups + "</div>" +
        '<div class="mcs-saved" id="mcsSaved"></div>';
    }

    function changed() {
      render();
      var s = root.querySelector("#mcsSaved"); if (s) s.textContent = "Saving…";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 350);
    }

    function save() {
      if (!opts.project_id) { var s0 = root.querySelector("#mcsSaved"); if (s0) s0.textContent = ""; return; }
      fetch(base + "/api/triage/scope", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: opts.project_id, manufacture: opts.manufacture || "", scope: scope }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        var s = root.querySelector("#mcsSaved");
        if (j && j.ok) {
          if (s) s.textContent = "Saved for this project. The AI reads it on the next run.";
          if (opts.onText) opts.onText(j.scope_text || "");
        } else if (s) s.textContent = "Could not save that change. Try again.";
      }).catch(function () {
        var s = root.querySelector("#mcsSaved"); if (s) s.textContent = "Could not save that change. Try again.";
      });
    }

    root.addEventListener("toggle", function (e) {
      var d = e.target; if (!d || !d.getAttribute) return;
      var g = d.getAttribute("data-g"); if (g) openGroups[g] = d.open;
    }, true);

    root.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!b || !root.contains(b)) return;
      var k = b.getAttribute("data-k");
      if (k) {
        var cur = scope.items[k] || {};
        var nv = TRI_NEXT[cur.v || ""];
        scope.items[k] = { v: nv, src: nv ? "user" : "", why: "" };
        return changed();
      }
      var o = b.getAttribute("data-o");
      if (o) {
        var kind = b.getAttribute("data-kind");
        var nx = (kind === "where" ? WHERE_NEXT : YES_NEXT)[scope.ops[o] || ""];
        if (nx) scope.ops[o] = nx; else delete scope.ops[o];
        return changed();
      }
    });

    root.addEventListener("change", function (e) {
      var sel = e.target; if (!sel || sel.tagName !== "SELECT") return;
      var f = sel.getAttribute("data-f"), pk = sel.getAttribute("data-pick");
      if (f) {
        scope.finish[f] = sel.value;
        if (f === "type" && (!sel.value || sel.value === "none")) scope.finish.by = "";
        scope.finish.src = (scope.finish.type || scope.finish.by) ? "user" : ""; scope.finish.why = "";
      } else if (pk) {
        if (sel.value) scope.picks[pk] = sel.value; else delete scope.picks[pk];
      }
      changed();
    });

    render();
    if (opts.onText) opts.onText(opts.scope_text || "");
    fetch(base + "/api/triage/scope-def?manufacture=" + encodeURIComponent(opts.manufacture || ""))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error("no definitions");
        defs = d;
        // Open any group that already has a choice in it, so it is visible at a glance.
        defs.ops_groups.forEach(function (g) {
          if (g.options.some(function (o) { return scope.ops[o.key]; }) || (g.picks || []).some(function (pk) { return scope.picks[pk]; })) openGroups[g.key] = true;
        });
        render();
      })
      .catch(function () { root.innerHTML = '<div class="mcs-saved">The scope options could not be loaded. Your notes below still go with the run.</div>'; });
  }

  window.McScope = { mount: mount };
})();
