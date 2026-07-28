// =============================================================================
//  takeoff/snap.js — snap a row's Material to the shop's catalog spelling.
// -----------------------------------------------------------------------------
//  Even told the sizes are a closed list, the model composes them: it returns
//  "1.5 x 1/8" where the catalog says "1-1/2 x 1/8", or "L4x4x1/4" for
//  "L4 x 4 x 1/4". Same steel, different string — and the import matches on the
//  string, so it lands unresolved (blank/red Material).
//
//  This is the deterministic pass that fixes it: compare what the size MEANS,
//  not how it's written. Every number is reduced to a value (1-1/2, 1.5 and
//  1.500 are all 1.5) and the letters are kept as a set, so a row snaps to the
//  catalog entry with the same numbers and the same letters. Only an UNAMBIGUOUS
//  single match snaps — anything else is left exactly as the model wrote it and
//  reported as unmatched, so the review page can ask a human instead of the tool
//  quietly picking the wrong steel.
// =============================================================================

// "1-1/2" → 1.5, "1/8" → 0.125, "0.250" → 0.25, "15.3" → 15.3
function toNum(tok) {
  const t = String(tok).trim();
  let m = t.match(/^(\d+)-(\d+)\/(\d+)$/);            // mixed: 1-1/2
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\/(\d+)$/);                       // fraction: 1/8
  if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^\d*\.?\d+$/);                          // decimal / integer
  if (m) return Number(t);
  return null;
}

// A size reduced to what it means: the numbers it contains (in order) plus the
// letters it carries (as a set, so "SCH 80 (XS)" and "SCH 80 XS" agree).
function signature(size) {
  const s = String(size == null ? "" : size).trim();
  if (!s) return null;
  const nums = [];
  // Pull mixed numbers/fractions/decimals out first so "1-1/2" isn't read as 1 and 2.
  const numRe = /\d+-\d+\/\d+|\d+\/\d+|\d*\.?\d+/g;
  let m;
  while ((m = numRe.exec(s))) {
    const v = toNum(m[0]);
    if (v != null) nums.push(Math.round(v * 10000) / 10000);
  }
  const letters = (s.toUpperCase().match(/[A-Z]+/g) || []).filter(function (w) { return w !== "GA"; });
  const gauge = /\bGA\b/i.test(s);
  if (!nums.length && !letters.length) return null;
  return { n: nums.join(","), a: letters.slice().sort().join(""), g: gauge };
}
function sameSig(x, y) { return !!x && !!y && x.n === y.n && x.a === y.a && x.g === y.g; }

// SQUARE TUBE IS WRITTEN TWICE OVER. Steel drawings use the HSS convention and spell both
// faces — "6 x 6 x 3/16" — while this catalog, like most stock lists, drops the repeat because
// the faces are equal by definition: "6 x 3/16". Same steel, and a signature comparison can
// never see it, because one has three numbers and the other has two. Real cost: four square-tube
// rows out of 58 on a live take-off resolved to nothing, and a job full of tube would lose the lot.
// So for square tube ONLY, and ONLY when the first two numbers are identical, offer the collapsed
// form as a second candidate. Rectangular tube is left alone — there the two faces differ and
// dropping one would be losing a dimension.
function squareTubeCollapse(size, formType) {
  if (!/tube/i.test(String(formType || "")) || !/square/i.test(String(formType || ""))) return null;
  const s = String(size == null ? "" : size).trim();
  const parts = s.split(/\s*[xX×]\s*/).map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.length !== 3) return null;
  const a = toNum(parts[0]), b = toNum(parts[1]);
  if (a == null || b == null || a !== b) return null;
  return parts[0] + " x " + parts[2];
}

// rows: the take-off's rows (mutated in place). groups: { "Form|Material": [size,...] }.
// Returns what changed and what couldn't be resolved — both worth surfacing.
function snapRows(rows, groups) {
  const out = { snapped: [], unmatched: [], checked: 0 };
  if (!Array.isArray(rows) || !groups) return out;

  const sigCache = {};
  const sigsFor = function (key) {
    if (!sigCache[key]) {
      sigCache[key] = (groups[key] || []).map(function (s) { return { size: s, sig: signature(s) }; });
    }
    return sigCache[key];
  };

  rows.forEach(function (r) {
    const size = String((r && r.size) == null ? "" : r.size).trim();
    const form = String((r && r.form_type) || "").trim();
    const mat = String((r && r.material_type) || "").trim();
    const list = groups[form + "|" + mat] ? form + "|" + mat
      : (groups[form + "|any material"] ? form + "|any material" : null);
    if (!list) return;                                  // no catalog for this form/material — review's problem
    out.checked++;

    const entries = sigsFor(list);
    const exact = entries.some(function (e) { return e.size.toUpperCase().replace(/\s+/g, " ") === size.toUpperCase().replace(/\s+/g, " "); });
    if (exact) {
      // Normalize spacing/case to the catalog's exact string so the import matches byte for byte.
      const hit = entries.find(function (e) { return e.size.toUpperCase().replace(/\s+/g, " ") === size.toUpperCase().replace(/\s+/g, " "); });
      if (hit && hit.size !== r.size) { out.snapped.push({ from: r.size, to: hit.size, form: form }); r.size = hit.size; }
      return;
    }
    if (!size) { out.unmatched.push({ size: "", form: form, material: mat }); return; }

    const sig = signature(size);
    let matches = entries.filter(function (e) { return sameSig(e.sig, sig); });
    if (!matches.length) {
      const collapsed = squareTubeCollapse(size, form);
      if (collapsed) {
        const csig = signature(collapsed);
        matches = entries.filter(function (e) { return sameSig(e.sig, csig); });
      }
    }
    if (matches.length === 1) {
      out.snapped.push({ from: r.size, to: matches[0].size, form: form });
      r.size = matches[0].size;
      return;
    }
    // Ambiguous or genuinely absent — leave the model's text alone and flag it. Guessing between
    // two real catalog sizes would put the wrong steel on a quote.
    out.unmatched.push({ size: size, form: form, material: mat, candidates: matches.length });
  });
  return out;
}

module.exports = { snapRows, signature, toNum, sameSig, squareTubeCollapse };
