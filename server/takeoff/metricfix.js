// =============================================================================
//  takeoff/metricfix.js — catch metric-drawing mistakes the model makes, using only
//  the drawing's own numbers (the row's note quotes them).
// -----------------------------------------------------------------------------
//  The Amrize handrail set (2026-10-07) is dimensioned in millimetres. The take-off
//  converted lengths by dividing by 30.48 instead of 304.8 (6414 mm became 210.4 ft,
//  not 21.04), and wrote the flat bar "FB6.35x101.6" (1/4" x 4") as "4 x 4", a 4"
//  square bar sixteen times heavier. 48,949 lb of handrail.
//
//  Two repairs, both provable from the note, and one flag:
//   1. LENGTH exactly 10x a millimetre value quoted in the note -> that value / 304.8.
//   2. FLAT BAR given in mm ("FB6.35x101.6", "FB 6x100") -> its inch size (1/4 x 4).
//   3. Anything still implausible (a length several times every mm value quoted, or a
//      "flat" bar that is square) is FLAGGED, never changed.
//  Same code runs on the server after a take-off and in the review page on open
//  (copied there), so packages saved before this get repaired too.
// =============================================================================

function frac16(x) {
  const n = Math.round(x * 16);
  const whole = Math.floor(n / 16);
  let rem = n % 16, den = 16;
  while (rem && rem % 2 === 0) { rem /= 2; den /= 2; }
  if (!rem) return String(whole);
  return (whole ? whole + "-" : "") + rem + "/" + den;
}

function mmValues(note) {
  const out = [];
  const s = String(note || "");
  // "76x152mm" / "204mm x 254mm": both sides of a pair are millimetres.
  const pair = /(\d{2,5}(?:\.\d+)?)\s*(?:mm)?\s*[x×]\s*(\d{2,5}(?:\.\d+)?)\s*mm\b/gi;
  let m;
  while ((m = pair.exec(s))) { [m[1], m[2]].forEach(function (x) { const v = Number(x); if (v >= 50) out.push(v); }); }
  const re = /(\d{2,5}(?:\.\d+)?)\s*mm\b/gi;
  while ((m = re.exec(s))) { const v = Number(m[1]); if (v >= 50 && out.indexOf(v) < 0) out.push(v); }
  return out;
}

// Returns { fixed:[{what, field, was, now, why}], flagged:[{what, why}] } and edits rows in place.
function fixMetric(rows) {
  const fixed = [], flagged = [];
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    if (!r || r.deleted) return;
    const note = String(r.note || "");
    const what = [r.source_sheet, r.member_mark, r.form_type, r.size].filter(Boolean).join(" ");

    // 2. Flat bar written in millimetres.
    if (/bar\s*-\s*flat/i.test(String(r.form_type || ""))) {
      const fb = note.match(/\bFB\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
      if (fb && Number(fb[1]) >= 3 && Number(fb[2]) >= 12) {
        const size = frac16(Number(fb[1]) / 25.4) + " x " + frac16(Number(fb[2]) / 25.4);
        if (String(r.size || "").replace(/\s+/g, "") !== size.replace(/\s+/g, "")) {
          fixed.push({ what: what, field: "size", was: r.size || "", now: size, why: "FB" + fb[1] + "x" + fb[2] + " mm = " + size + " in" });
          r.size = size;
        }
      } else {
        const sq = String(r.size || "").match(/^\s*([\d\/.-]+)\s*x\s*([\d\/.-]+)\s*$/i);
        if (sq && sq[1] === sq[2]) flagged.push({ what: what, why: "a flat bar can't be " + r.size + " (that's a square bar) — check the size" });
      }
    }

    // 1. Length ten times a quoted millimetre value.
    const L = Number(r.length_ft) || 0;
    const mm = mmValues(note);
    if (L > 0 && mm.length) {
      const right = mm.some(function (v) { const c = v / 304.8; return Math.abs(L - c) / c < 0.03; });
      if (!right) {
        const hit = mm.find(function (v) { const c = v / 304.8; return Math.abs(L - 10 * c) / (10 * c) < 0.03; });
        if (hit) {
          const now = Math.round(hit / 304.8 * 1000) / 1000;
          fixed.push({ what: what, field: "length_ft", was: L, now: now, why: hit + " mm = " + now.toFixed(2) + " ft (was 10x)" });
          r.length_ft = now;
        } else {
          const maxMm = Math.max.apply(null, mm), maxFt = maxMm / 304.8;
          // A straight member's cut length is the largest mm its note quotes (the others are widths,
          // offsets). When the stored length is more than double every dimension on the drawing,
          // the drawing's number wins. Plates and sheets mix lengths and widths, so they're only flagged.
          const linear = !(Number(r.width_ft) > 0) && !/plate|sheet/i.test(String(r.form_type || ""));
          if (L > 2 * maxFt && linear) {
            const now = Math.round(maxFt * 1000) / 1000;
            fixed.push({ what: what, field: "length_ft", was: L, now: now, why: "the drawing gives " + maxMm + " mm = " + now.toFixed(2) + " ft (was " + L.toFixed(1) + " ft)" });
            r.length_ft = now;
          } else if (L > 2 * maxFt && Number(r.width_ft) > 0 && mm.length >= 2) {
            // A plate: its two largest mm values are its length and width.
            const s = mm.slice().sort(function (a, b) { return b - a; });
            const nl = Math.round(s[0] / 304.8 * 1000) / 1000, nw = Math.round(s[1] / 304.8 * 1000) / 1000;
            fixed.push({ what: what, field: "length_ft", was: L, now: nl, why: "plate " + s[0] + " x " + s[1] + " mm on the drawing (was " + L.toFixed(1) + " ft long)" });
            if (Math.abs((Number(r.width_ft) || 0) - nw) / nw > 0.03) fixed.push({ what: what, field: "width_ft", was: Number(r.width_ft), now: nw, why: "plate " + s[0] + " x " + s[1] + " mm on the drawing" });
            r.length_ft = nl; r.width_ft = nw;
          } else if (L > 2 * maxFt && L > 3) {
            flagged.push({ what: what, why: "length " + L.toFixed(1) + " ft is far longer than any dimension the note quotes (max " + maxMm + " mm = " + maxFt.toFixed(1) + " ft)" });
          }
        }
      }
    }
  });
  return { fixed: fixed, flagged: flagged };
}

// ---- THE SAME PART RAISED FROM TWO PAGES OF ONE DRAWING ----------------------------------------
// Drawing 8065 came as "1 OF 2" and "2 OF 2"; the take-off raised p242, p243, p248, p259, p285 and the
// base plates from both pages, so the drawing weighed ~2x what its title block says. Within one
// drawing, rows with the same mark and the same form + size are one part. The row kept is the one
// quoting the parts table ("REQ'D"), else the larger quantity. "pl196" and "p196" are the same plate.
function markKey(r) {
  let m = String(r.member_mark || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/plate/i.test(String(r.form_type || ""))) m = m.replace(/^pl/, "p");
  return m;
}
function dedupeSheets(rows) {
  const removed = [];
  const groups = {};
  (Array.isArray(rows) ? rows : []).forEach(function (r, i) {
    if (!r || r.deleted || !r.source_sheet || !markKey(r)) return;
    const k = String(r.source_sheet).toUpperCase().replace(/[^A-Z0-9]/g, "") + "|" + markKey(r) + "|" +
              String(r.form_type || "").toLowerCase() + "|" + String(r.size || "").toLowerCase().replace(/\s+/g, "");
    (groups[k] = groups[k] || []).push(i);
  });
  const drop = {};
  Object.keys(groups).forEach(function (k) {
    const ids = groups[k];
    if (ids.length < 2) return;
    const score = function (i) { const r = rows[i]; return (/req.?d/i.test(String(r.note || "")) ? 1000 : 0) + (Number(r.quantity) || 0); };
    const keep = ids.slice().sort(function (a, b) { return score(b) - score(a); })[0];
    ids.forEach(function (i) {
      if (i === keep) return;
      drop[i] = 1;
      const r = rows[i];
      removed.push({ what: [r.source_sheet, r.member_mark, r.form_type, r.size].filter(Boolean).join(" "),
                     qty: Number(r.quantity) || 0, kept: rows[keep].member_mark + " (qty " + rows[keep].quantity + ")",
                     why: "same part raised from two pages of drawing " + r.source_sheet });
    });
  });
  if (removed.length) {
    const kept = rows.filter(function (_, i) { return !drop[i]; });
    rows.splice(0, rows.length, ...kept);
  }
  return removed;
}

module.exports = { fixMetric, dedupeSheets, frac16, mmValues };
