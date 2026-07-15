// ── Supplier line alteration: description rebuild + weight recompute ──────────
// When a supplier revises a quoted line (Length / QTY / Specification), Zoho's
// derived fields do NOT recompute on the API write path — same reason quote-submit
// sets its header rollups explicitly. So we compute here and write the results.
//
// Scope: Length, Quantity, Specification. Form type, material type and the material
// token (e.g. "W10 x 26", `1/2"`) never change under an alteration, so the material
// token is carried through from the source description rather than resolved out of
// the 19 per-form-type size catalogs.
//
// Field facts verified against live data (All_RFQs_Sent_Report):
//   - Form_Type / Material_Type / Material_Form_Detail come back as RAW IDs, so
//     names require the catalog maps below.
//   - Material_Form_Detail.Type_Detail IS the Specification token ("A36", "A992").
//   - Weight_Per_FT is a number on the RFQ row — no catalog join needed for weight.
//   - Total_Plate_Width is 0.0000 on every row: dead field, never read it. Width
//     comes from Width_FT / Width_INCH.
//   - Material_Form_Detail_Report is 480 rows: it MUST be paged, or specs silently
//     fail to resolve past the first 200.

const CATALOG_TTL = 60 * 60 * 1000;   // catalogs are near-static; API budget is tight

// A line whose weight inputs are blank but whose stored Unit_Weight is valid must
// never be "recomputed" to 0 — some live rows carry Length_FT/Weight_Per_FT of 0
// alongside a correct Unit_Weight. Recalc refuses those instead of destroying data.
class LineCalcError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

// id -> name maps for the three lookups that matter to a description.
async function fetchCatalogs(deps) {
  const { fetchAllZohoPages, cachedLookup } = deps;
  return cachedLookup('line-calc:catalogs', CATALOG_TTL, async () => {
    const [formTypes, matTypes, specs, lengthInch] = await Promise.all([
      fetchAllZohoPages('/report/All_Form_Types'),
      fetchAllZohoPages('/report/Material_Types_Report'),
      fetchAllZohoPages('/report/Material_Form_Detail_Report'),
      fetchAllZohoPages('/report/All_Length_Inch_Lookups'),
    ]);
    const formTypeById = {};
    for (const r of formTypes) {
      formTypeById[String(r.ID)] = {
        name: r.Form_Type || '',
        // "Panel" (Sheet/Plate) computes weight over an area; "Linear" over length.
        isPanel: String(r.Measurement || '') === 'Panel',
      };
    }
    const matTypeById = {};
    for (const r of matTypes) matTypeById[String(r.ID)] = r.Material_Type || '';

    const specById = {};
    for (const r of specs) {
      specById[String(r.ID)] = {
        typeDetail: r.Type_Detail || '',
        formTypeId: String((r.Form_Type && r.Form_Type.ID) || ''),
        matTypeId: String((r.Material_Type && r.Material_Type.ID) || ''),
      };
    }
    const lengthInchById = {}, lengthInchByResult = [];
    for (const r of lengthInch) {
      const rec = { id: String(r.ID), description: r.Description || '', result: parseFloat(r.Result) || 0 };
      lengthInchById[rec.id] = rec;
      lengthInchByResult.push(rec);
    }
    return { formTypeById, matTypeById, specById, lengthInchById, lengthInchByResult };
  });
}

const lkid = v => String((v && typeof v === 'object' ? v.ID : v) || '');
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const round = (n, dp) => { const f = Math.pow(10, dp); return Math.round((Number(n) || 0) * f) / f; };

// Map a decimal inch value back onto the Length_INCH lookup record (the fractional
// catalog: 3-9/16" -> 3.5625). Tolerance mirrors findLengthInchId in index.js.
function findLengthInchId(catalogs, inchVal) {
  const target = num(inchVal);
  let best = null, bestDiff = Infinity;
  for (const rec of catalogs.lengthInchByResult) {
    const d = Math.abs(rec.result - target);
    if (d < bestDiff) { bestDiff = d; best = rec; }
  }
  return (best && bestDiff <= 0.05) ? best : null;
}

// Dimension token, matching the live format exactly:
//   ft=20, in=0 -> `240" (20')`      ft=2, in=4 -> `28" (2'4")`
function formatDim(ft, inch) {
  const f = Math.floor(num(ft)), i = num(inch);
  const totalIn = f * 12 + i;
  const totalStr = (Math.round(totalIn * 100) / 100) + '"';
  const inner = i > 0 ? f + "'" + (Math.round(i * 100) / 100) + '"' : f + "'";
  return totalStr + ' (' + inner + ')';
}

// Live descriptions are `Form | MatType | Spec | Material | dims`.
const DESC_SEP = ' | ';
const DESC_SPEC_IX = 2, DESC_DIMS_IX = 4, DESC_PARTS = 5;

function splitDescription(desc) {
  const parts = String(desc || '').split(DESC_SEP);
  return parts.length === DESC_PARTS ? parts : null;
}

// PATCH, don't rebuild. Only the tokens that actually changed are replaced; every
// other token is carried through verbatim.
//
// This is load-bearing: some live rows store a correct description alongside blank
// Length_FT/Width_FT, so a from-scratch rebuild renders `0" (0') × 0" (0')` and
// destroys a good description — the same failure the weight guard prevents. A line
// whose geometry did not change never has its dimension token recomputed.
function patchDescription(stored, { specName, dims }) {
  const parts = splitDescription(stored);
  if (!parts) return null;                       // unexpected shape — caller decides
  if (specName != null) parts[DESC_SPEC_IX] = specName;
  if (dims != null) parts[DESC_DIMS_IX] = dims;
  return parts.join(DESC_SEP);
}

// Fallback for descriptions not in the canonical 5-part shape.
function buildDescription(parts) {
  const { formTypeName, matTypeName, specName, materialToken, isPanel, lenFt, lenIn, widFt, widIn } = parts;
  const dims = isPanel
    ? formatDim(lenFt, lenIn) + ' × ' + formatDim(widFt, widIn)
    : formatDim(lenFt, lenIn);
  return [formTypeName, matTypeName, specName, materialToken, dims]
    .filter(t => t != null && t !== '')
    .join(DESC_SEP);
}

// Weight, verified against live rows:
//   Linear: Weight_Per_FT * length_ft            (26 * 20ft = 520)
//   Panel : Weight_Per_FT * length_ft * width_ft (20.42 * 2.333ft * 5ft = 238.23)
//   CalcWeight = Unit_Weight * Quantity          (held on every row sampled)
function computeUnitWeight({ weightPerFt, isPanel, lenFt, lenIn, widFt, widIn }) {
  const lengthFt = num(lenFt) + num(lenIn) / 12;
  if (!isPanel) return num(weightPerFt) * lengthFt;
  const widthFt = num(widFt) + num(widIn) / 12;
  return num(weightPerFt) * lengthFt * widthFt;
}

/**
 * Recompute one altered line.
 *
 * @param row         the authoritative All_RFQs_Sent_Report record
 * @param alteration  { length_ft, length_inch, quantity, spec_id } — any subset;
 *                    omitted/null keys mean "unchanged"
 * @param catalogs    from fetchCatalogs()
 * @returns { description, unit_weight, calc_weight, quantity, length_ft, length_inch,
 *            length_inch_id, spec_id, changed, warnings }
 * @throws  LineCalcError when the row cannot be safely recomputed
 */
function computeAlteredLine(row, alteration, catalogs) {
  const alt = alteration || {};
  const warnings = [];

  const formTypeId = lkid(row.Form_Type);
  const ft = catalogs.formTypeById[formTypeId];
  if (!ft) throw new LineCalcError('Unknown Form_Type ' + formTypeId + ' — cannot classify Linear vs Panel', 'UNKNOWN_FORM_TYPE');
  const isPanel = ft.isPanel;

  const matTypeName = catalogs.matTypeById[lkid(row.Material_Type)] || '';

  // Specification: only the spec may change, and only within the same form+material
  // type, or the line would no longer describe the same product.
  const origSpecId = lkid(row.Material_Form_Detail);
  const specId = alt.spec_id ? String(alt.spec_id) : origSpecId;
  const spec = catalogs.specById[specId];
  if (!spec) throw new LineCalcError('Unknown Specification ' + specId, 'UNKNOWN_SPEC');
  if (specId !== origSpecId) {
    if (spec.formTypeId !== formTypeId || spec.matTypeId !== lkid(row.Material_Type)) {
      throw new LineCalcError('Specification ' + spec.typeDetail + ' is not valid for this form/material type', 'SPEC_MISMATCH');
    }
  }

  // Geometry. Width is never altered (not in scope) — carry it from the row.
  const origLenFt = num(row.Length_FT);
  const origLenIn = num(row.Length_INCH_Result);
  const lenFt = alt.length_ft != null ? num(alt.length_ft) : origLenFt;
  const lenIn = alt.length_inch != null ? num(alt.length_inch) : origLenIn;
  const widFt = num(row.Width_FT && row.Width_FT.zc_display_value);
  const widIn = num(row.Width_INCH && row.Width_INCH.Description ? row.Width_INCH.zc_display_value : 0);

  const origQty = num(row.Quantity);
  const qty = alt.quantity != null ? num(alt.quantity) : origQty;

  const lengthChanged = lenFt !== origLenFt || lenIn !== origLenIn;
  const qtyChanged = qty !== origQty;
  const specChanged = specId !== origSpecId;

  if (qty <= 0) throw new LineCalcError('Quantity must be greater than zero', 'BAD_QUANTITY');
  if (lengthChanged && lenFt * 12 + lenIn <= 0) throw new LineCalcError('Length must be greater than zero', 'BAD_LENGTH');

  // ── The blank-input guard ────────────────────────────────────────────────
  // Some live rows carry Length_FT/Weight_Per_FT = 0 with a CORRECT Unit_Weight.
  // Recomputing geometry there yields 0 and destroys good data, so we only
  // recompute the weight when the inputs can actually support it.
  const weightPerFt = num(row.Weight_Per_FT);
  const storedUnitWeight = num(row.Unit_Weight);
  let unitWeight;
  if (lengthChanged) {
    if (weightPerFt <= 0) {
      throw new LineCalcError(
        'Cannot recompute weight: this line has no Weight_Per_FT' +
        (storedUnitWeight > 0 ? ' (stored Unit_Weight ' + storedUnitWeight + ' would be lost)' : ''),
        'NO_WEIGHT_BASIS');
    }
    if (isPanel && num(widFt) + num(widIn) / 12 <= 0) {
      throw new LineCalcError('Cannot recompute panel weight: this line has no width', 'NO_WIDTH_BASIS');
    }
    unitWeight = computeUnitWeight({ weightPerFt, isPanel, lenFt, lenIn, widFt, widIn });
  } else {
    // No geometry change -> unit weight is untouched, even if its inputs are blank.
    unitWeight = storedUnitWeight;
  }

  // Length_INCH is a lookup, so a new inch value must land on a catalog record.
  let lengthInchRec = null;
  if (lengthChanged) {
    lengthInchRec = findLengthInchId(catalogs, lenIn);
    if (!lengthInchRec && lenIn > 0) {
      throw new LineCalcError('Length inch value ' + lenIn + '" has no matching Length_INCH lookup', 'NO_LENGTH_INCH_MATCH');
    }
  }
  const effLenIn = lengthInchRec ? lengthInchRec.result : lenIn;

  // Description: patch only what changed. The dimension token is recomputed ONLY
  // when the geometry actually changed — which the weight guard above has already
  // proven is safe to do (valid Weight_Per_FT, and a width for panels).
  const stored = String(row.Description_And_Dimension_Text || row.Full_Item_Description || '');
  const newDims = lengthChanged
    ? (isPanel ? formatDim(lenFt, effLenIn) + ' × ' + formatDim(widFt, widIn) : formatDim(lenFt, effLenIn))
    : null;
  let description = patchDescription(stored, {
    specName: specChanged ? spec.typeDetail : null,
    dims: newDims,
  });
  if (description == null) {
    // Not the canonical 5-part shape — fall back to a full rebuild, which cannot
    // preserve the material token. Only reachable when something actually changed.
    warnings.push('Source description was not in the expected 5-part format; rebuilt from catalogs (material token may be lost).');
    description = buildDescription({
      formTypeName: ft.name, matTypeName, specName: spec.typeDetail, materialToken: '',
      isPanel, lenFt, lenIn: effLenIn, widFt, widIn,
    });
  }

  return {
    description,
    unit_weight: round(unitWeight, 2),
    calc_weight: round(unitWeight * qty, 2),
    quantity: qty,
    length_ft: lenFt,
    length_inch: effLenIn,
    length_inch_id: lengthInchRec ? lengthInchRec.id : lkid(row.Length_INCH),
    // DECIMAL FEET, not inches: Total_Length on the RFQ row is ft + in/12 (a 20' beam
    // stores 20.0, a 2'4" plate stores 2.3333) — verified 162/162 against live rows.
    // Writing inches here silently disagrees with every unaltered line.
    total_length: round(lenFt + effLenIn / 12, 4),
    spec_id: specId,
    spec_name: spec.typeDetail,
    changed: { length: lengthChanged, quantity: qtyChanged, spec: specChanged },
    warnings,
  };
}

module.exports = {
  fetchCatalogs, computeAlteredLine, buildDescription, patchDescription,
  splitDescription, formatDim, computeUnitWeight, findLengthInchId, LineCalcError,
};
