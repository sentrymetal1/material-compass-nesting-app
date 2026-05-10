import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

const API = '';

function getProjectIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('project_id') || params.get('id') || '';
}

function getManufactureIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('Manufacture_ID') || params.get('manufacture_id') || params.get('mfg_id') || '';
}

function getUserFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('User') || params.get('user') || '';
}

// Display the local part of an email (before @) for the recall panel
function emailLocalPart(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

// Compute the next tag in a sequence: "P-1" -> "P-2", "B3" -> "B4", "1" -> "2",
// "ABC" (no trailing digits) -> "ABC-1", "" -> "". Used by Add Part to auto-populate.
function nextTag(prevTag) {
  const s = String(prevTag || '').trim();
  if (!s) return '';
  const m = s.match(/^(.*?)(\d+)$/);
  if (m) return m[1] + (parseInt(m[2]) + 1);
  return s + '-1';
}

// Lookup record IDs that represent "0" — used as defaults for dimension fields so saved Run_Part
// records never have null values for INCH(L), FT(W), INCH(W).
const ZERO_INCH_ID = '4111484000000521139';     // Length_INCH_Lookup record where Description="0"
const ZERO_FT_WIDTH_ID = '4111484000003558015'; // Plate_Standard_Sizes record where width = 0'

// Parse "1/4", "3/8", "1-1/4", "2", "W10 x 12" etc. into an array of numeric tokens
// for size-aware sort. "1-1/4" -> [1.25], "W10 x 12" -> [10, 12], "L4 x 4 x 3/8" -> [4, 4, 0.375].
function materialSortKey(name) {
  if (!name) return [Infinity];
  const tokens = String(name).match(/(\d+(?:-\d+\/\d+)?|\d+\/\d+|\d+(?:\.\d+)?)/g) || [];
  return tokens.map(t => {
    const mixed = t.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
    const frac = t.match(/^(\d+)\/(\d+)$/);
    if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
    return parseFloat(t) || 0;
  });
}

function compareByMaterialName(a, b) {
  const ka = materialSortKey(a.name);
  const kb = materialSortKey(b.name);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const ai = ka[i] === undefined ? -Infinity : ka[i];
    const bi = kb[i] === undefined ? -Infinity : kb[i];
    if (ai !== bi) return ai - bi;
  }
  return (a.name || '').localeCompare(b.name || '');
}

// Convert FT/INCH lookup IDs to total inches using the lookup tables
function dimsToInches(lengthFt, lengthInchId, widthFtId, widthInchId, lengthInchTable, plateWidthTable) {
  const ft = parseFloat(lengthFt) || 0;
  let inchVal = 0;
  if (lengthInchId && lengthInchTable) {
    const rec = lengthInchTable.find(r => String(r.id) === String(lengthInchId));
    if (rec) inchVal = parseFloat(rec.result) || 0;
  }
  const lengthIn = ft * 12 + inchVal;
  let widthIn = 0;
  if (widthFtId && plateWidthTable) {
    const wRec = plateWidthTable.find(r => String(r.id) === String(widthFtId));
    if (wRec) widthIn += (parseFloat(wRec.width_ft) || 0) * 12;
  }
  if (widthInchId && lengthInchTable) {
    const wiRec = lengthInchTable.find(r => String(r.id) === String(widthInchId));
    if (wiRec) widthIn += parseFloat(wiRec.result) || 0;
  }
  return { length_in: lengthIn, width_in: widthIn };
}

function inToFt(val) {
  const n = parseFloat(val);
  if (!n || n === 0) return '—';
  const ft = Math.floor(n / 12);
  const rem = +(n % 12).toFixed(2);
  if (ft === 0) return `${n}"`;
  if (rem === 0) return `${n}" (${ft}')`;
  return `${n}" (${ft}'${rem}")`;
}

function fmtLbs(val) {
  const n = parseFloat(val);
  if (!n || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' lbs';
}

/** Calculate unit weight for a stock piece
 * 1D: weight_per_ft × (length_in / 12)
 * 2D: weight_per_ft × (length_in × width_in / 144)
 */
function calcUnitWeight(weightPerFt, lengthIn, widthIn) {
  const wpf = parseFloat(weightPerFt) || 0;
  const l = parseFloat(lengthIn) || 0;
  const w = parseFloat(widthIn) || 0;
  if (wpf === 0 || l === 0) return 0;
  if (w > 0) {
    return wpf * (l * w / 144);
  }
  return wpf * (l / 12);
}

function groupResults(results, nameLookup) {
  if (!results || results.length === 0) return [];
  const materialGroups = {};
  for (const r of results) {
    if (r.error) continue;
    // Include material_name in the key so different materials on the same
    // form/origin/length get their own group (algorithm now locks each
    // bin/sheet to one material, so this matches reality).
    const matKey = r.material_name || '';
    const key = `${r.form_type}|${r.material_origin}|${matKey}|${r.stock_length_in}|${r.stock_width_in || 0}`;
    if (!materialGroups[key]) {
      materialGroups[key] = {
        form_type: r.form_type,
        material_origin: r.material_origin,
        stock_length_in: r.stock_length_in,
        stock_width_in: r.stock_width_in,
        form_type_name: (nameLookup && nameLookup[r.form_type]) || r.form_type,
        material_type_name: (nameLookup && nameLookup[r.material_origin]) || r.material_origin,
        spec_name: (nameLookup && r.cuts?.[0] && nameLookup[r.cuts[0].spec_name]) || '',
        material_name: r.material_name || (nameLookup && r.cuts?.[0] && nameLookup[r.cuts[0].material_type]) || '',
        patterns: [],
      };
    }
    const cutSig = (r.cuts || [])
      .map(c => `${c.part_mark}:${c.cut_length}:${c.cut_width || 0}:${c.quantity_on_this_stock}`)
      .join('|');
    const existing = materialGroups[key].patterns.find(p => p.signature === cutSig);
    if (existing) {
      existing.count++;
      existing.stockPieces.push(r);
    } else {
      materialGroups[key].patterns.push({
        signature: cutSig,
        count: 1,
        representative: r,
        stockPieces: [r],
      });
    }
  }
  return Object.values(materialGroups);
}

function resolveErrorNames(errorMsg, nameLookup) {
  if (!nameLookup) return errorMsg;
  let resolved = errorMsg;
  for (const [id, name] of Object.entries(nameLookup)) {
    if (id && name && resolved.includes(id)) {
      resolved = resolved.split(id).join(name);
    }
  }
  return resolved;
}

function analyzeError(errorMsg, nameLookup, parts1D, parts2D, stock2D, stock1D) {
  const resolved = resolveErrorNames(errorMsg, nameLookup);
  const tooLargeMatch = resolved.match(/Part\s+(\S+)\s+\(([^)]+)\)\s+too large for any stock in\s+(.+)/i);
  if (!tooLargeMatch) {
    return { message: resolved, details: null };
  }
  const partMark = tooLargeMatch[1];
  const partDims = tooLargeMatch[2];
  const stockCategory = tooLargeMatch[3].replace(/\.$/, '');
  const dimMatch = partDims.match(/([\d.]+)[x×]([\d.]+)/);
  const lenMatch = partDims.match(/([\d.]+)"/);
  const allParts = [...(parts1D || []), ...(parts2D || [])];
  const part = allParts.find(p => String(p.part_mark || p.bom_item) === String(partMark));

  if (dimMatch) {
    const partLength = parseFloat(dimMatch[1]);
    const partWidth = parseFloat(dimMatch[2]);
    const allStock = [...(stock2D || [])];
    const matchingStock = allStock.filter(s => {
      const label = s.stock_label || '';
      return label.toLowerCase().includes(stockCategory.toLowerCase()) ||
        (s.form_type_name && s.material_type_name &&
          stockCategory.toLowerCase().includes(s.form_type_name.toLowerCase()) &&
          stockCategory.toLowerCase().includes(s.material_type_name.toLowerCase()));
    });
    const maxStockLength = matchingStock.length > 0 ? Math.max(...matchingStock.map(s => parseFloat(s.length_in || s.stock_length) || 0)) : 0;
    const maxStockWidth = matchingStock.length > 0 ? Math.max(...matchingStock.map(s => parseFloat(s.width_in || s.stock_width) || 0)) : 0;
    const lengthExceeds = partLength > maxStockLength && partLength > maxStockWidth;
    const widthExceeds = partWidth > maxStockLength && partWidth > maxStockWidth;
    let dimensionNote = '';
    if (widthExceeds && !lengthExceeds) {
      dimensionNote = `Requires ${partWidth}" in one dimension, but max available stock width is ${maxStockWidth}" and max length is ${maxStockLength}".`;
    } else if (lengthExceeds && !widthExceeds) {
      dimensionNote = `Requires ${partLength}" in one dimension, but max available stock length is ${maxStockLength}" and max width is ${maxStockWidth}".`;
    } else if (lengthExceeds && widthExceeds) {
      dimensionNote = `Both dimensions (${partLength}" × ${partWidth}") exceed all available stock (max: ${maxStockLength}" × ${maxStockWidth}").`;
    } else {
      dimensionNote = `Part dimensions are ${partLength}" × ${partWidth}". Max available stock is ${maxStockLength}" × ${maxStockWidth}".`;
    }
    const availableSizes = matchingStock.map(s => {
      const sL = parseFloat(s.length_in || s.stock_length) || 0;
      const sW = parseFloat(s.width_in || s.stock_width) || 0;
      return `${sL}" × ${sW}"`;
    });
    const minLength = Math.max(partLength, partWidth);
    const minWidth = Math.min(partLength, partWidth);
    return {
      message: `Part ${partMark} (${partLength}" × ${partWidth}") — no stock available in ${stockCategory}`,
      details: {
        type: '2d',
        dimensionNote,
        availableSizes: [...new Set(availableSizes)],
        suggestions: [
          `Add stock at least ${Math.ceil(minWidth)}" × ${Math.ceil(minLength)}" (or larger) to the Stock Library for ${stockCategory}.`,
          `Review Part ${partMark} in the BOM — if length and width can be swapped or dimensions reduced, adjust accordingly.`,
          part?.grain_direction && part.grain_direction !== 'none'
            ? `Grain direction is set to "${part.grain_direction}" which prevents rotation. Setting to "None" may allow more stock options.`
            : null,
        ].filter(Boolean),
      },
    };
  } else if (lenMatch) {
    const partLength = parseFloat(lenMatch[1]);
    const allStock = [...(stock1D || [])];
    const matchingStock = allStock.filter(s => {
      const label = s.stock_label || '';
      return label.toLowerCase().includes(stockCategory.toLowerCase());
    });
    const maxStockLength = matchingStock.length > 0 ? Math.max(...matchingStock.map(s => parseFloat(s.length_in || s.stock_length) || 0)) : 0;
    return {
      message: `Part ${partMark} (${partLength}") — no stock available in ${stockCategory}`,
      details: {
        type: '1d',
        dimensionNote: `Requires ${partLength}" length, but max available stock length is ${maxStockLength}".`,
        availableSizes: matchingStock.map(s => `${parseFloat(s.length_in || s.stock_length)}"`),
        suggestions: [
          `Add stock at least ${Math.ceil(partLength)}" long to the Stock Library for ${stockCategory}.`,
          `Review Part ${partMark} in the BOM — if the length can be reduced, adjust accordingly.`,
        ],
      },
    };
  }
  return { message: resolved, details: null };
}

function PanelVisualization({ result, kerf2D }) {
  const stockL = result.stock_length_in || 0;
  const stockW = result.stock_width_in || 0;
  // Use per-placement records when available (one rect per physical part).
  // Falls back to `cuts` for older API responses where placements wasn't sent.
  const cuts = result.placements || result.cuts || [];
  if (!stockL || !stockW || cuts.length === 0) return null;
  const marginLeft = 30;
  const marginTop = 5;
  const marginBottom = 20;
  const marginRight = 5;
  const maxDrawWidth = 600;
  const maxDrawHeight = 300;
  const scaleX = maxDrawWidth / stockL;
  const scaleY = maxDrawHeight / stockW;
  const scale = Math.min(scaleX, scaleY);
  const drawW = stockL * scale;
  const drawH = stockW * scale;
  const svgWidth = drawW + marginLeft + marginRight;
  const svgHeight = drawH + marginTop + marginBottom;
  const colors = [
    '#4A90D9', '#5BA55B', '#D4A843', '#C75B5B', '#7B68AE',
    '#3AAFA9', '#E07B53', '#8D6E63', '#5C6BC0', '#26A69A',
  ];
  const partMarks = [...new Set(cuts.map(c => c.part_mark))];
  const colorMap = {};
  partMarks.forEach((mark, i) => { colorMap[mark] = colors[i % colors.length]; });

  return (
    <div className="panel-viz-wrap">
      <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="panel-viz-svg">
        <g transform={`translate(${marginLeft}, ${marginTop})`}>
          <rect x={0} y={0} width={drawW} height={drawH} fill="#f5f5f5" stroke="#999" strokeWidth={1} />
          {Array.from({ length: Math.floor(stockL / 12) }, (_, i) => (
            <line key={`vg-${i}`} x1={(i + 1) * 12 * scale} y1={0} x2={(i + 1) * 12 * scale} y2={drawH} stroke="#e0e0e0" strokeWidth={0.5} />
          ))}
          {Array.from({ length: Math.floor(stockW / 12) }, (_, i) => (
            <line key={`hg-${i}`} x1={0} y1={(i + 1) * 12 * scale} x2={drawW} y2={(i + 1) * 12 * scale} stroke="#e0e0e0" strokeWidth={0.5} />
          ))}
          {cuts.map((cut, i) => {
            const x = (parseFloat(cut.x_position) || 0) * scale;
            const y = (parseFloat(cut.y_position) || 0) * scale;
            const rotation = parseInt(cut.rotation) || 0;
            const cutW = rotation === 90 ? (cut.cut_width * scale) : (cut.cut_length * scale);
            const cutH = rotation === 90 ? (cut.cut_length * scale) : (cut.cut_width * scale);
            const color = colorMap[cut.part_mark] || '#4A90D9';
            const clampedW = Math.min(cutW, drawW - x);
            const clampedH = Math.min(cutH, drawH - y);
            return (
              <g key={i}>
                <rect x={x} y={y} width={clampedW} height={clampedH} fill={color} fillOpacity={0.75} stroke="white" strokeWidth={1} />
                {clampedW > 28 && clampedH > 14 && (
                  <text x={x + clampedW / 2} y={y + clampedH / 2 - (clampedH > 28 ? 5 : 0)} textAnchor="middle" dominantBaseline="central" fill="white" fontSize={Math.min(12, Math.min(clampedW * 0.3, clampedH * 0.4))} fontWeight="bold" fontFamily="'IBM Plex Mono', monospace">
                    {cut.part_mark}
                  </text>
                )}
                {clampedW > 50 && clampedH > 28 && (
                  <text x={x + clampedW / 2} y={y + clampedH / 2 + 8} textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.85)" fontSize={Math.min(9, Math.min(clampedW * 0.2, clampedH * 0.25))} fontFamily="'IBM Plex Mono', monospace">
                    {cut.cut_length}"×{cut.cut_width}"
                  </text>
                )}
                {rotation === 90 && clampedW > 40 && clampedH > 36 && (
                  <text x={x + clampedW / 2} y={y + clampedH / 2 + 18} textAnchor="middle" dominantBaseline="central" fill="rgba(255,255,255,0.6)" fontSize={8} fontFamily="'IBM Plex Mono', monospace">
                    (R90°)
                  </text>
                )}
              </g>
            );
          })}
          <text x={drawW / 2} y={drawH + 15} textAnchor="middle" fontSize={10} fill="#666" fontFamily="'IBM Plex Mono', monospace">
            {stockL}" ({(stockL / 12).toFixed(0)}')
          </text>
          <text x={-drawH / 2} y={-14} textAnchor="middle" fontSize={10} fill="#666" fontFamily="'IBM Plex Mono', monospace" transform="rotate(-90)">
            {stockW}" ({(stockW / 12).toFixed(0)}')
          </text>
        </g>
      </svg>
    </div>
  );
}

function matDesc(group) {
  const parts = [group.form_type_name, group.material_type_name];
  if (group.spec_name) parts.push(group.spec_name);
  if (group.material_name) parts.push(group.material_name);
  return parts.join(' | ');
}

function ManualPartsEntry({ parts, onChange, lookupTables, onLookupTablesLoaded }) {
  const [formTypes, setFormTypes] = useState(lookupTables?.formTypes || []);
  const [matTypes, setMatTypes] = useState(lookupTables?.matTypes || []);
  const [lengthInch, setLengthInch] = useState(lookupTables?.lengthInch || []);
  const [plateWidths, setPlateWidths] = useState(lookupTables?.plateWidths || []);
  // Cascade cache keyed by "formTypeId|materialTypeId" — survives row reorders and component remounts
  const [cascadeCache, setCascadeCache] = useState({});

  useEffect(() => {
    async function loadBase() {
      try {
        const [ftRes, mtRes, liRes, pwRes] = await Promise.all([
          fetch(`${API}/api/lookups/form-types`),
          fetch(`${API}/api/lookups/material-types`),
          fetch(`${API}/api/lookups/length-inch`),
          fetch(`${API}/api/lookups/plate-widths`),
        ]);
        const ft = (ftRes.ok ? await ftRes.json() : []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const mt = (mtRes.ok ? await mtRes.json() : []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const li = liRes.ok ? await liRes.json() : []; // already sorted by decimal result on server
        const pw = pwRes.ok ? await pwRes.json() : []; // already sorted by width_ft on server
        setFormTypes(ft);
        setMatTypes(mt);
        setLengthInch(li);
        setPlateWidths(pw);
        if (onLookupTablesLoaded) onLookupTablesLoaded({ formTypes: ft, matTypes: mt, lengthInch: li, plateWidths: pw });
      } catch (e) { console.error('Failed to load lookup tables:', e); }
    }
    if (formTypes.length === 0) loadBase();
  }, []); // eslint-disable-line

  async function ensureCascade(formTypeId, materialTypeId) {
    if (!formTypeId || !materialTypeId) return;
    const key = `${formTypeId}|${materialTypeId}`;
    if (cascadeCache[key]) return;
    try {
      const [specRes, matRes] = await Promise.all([
        fetch(`${API}/api/lookups/specifications?form_type_id=${formTypeId}&material_type_id=${materialTypeId}`),
        fetch(`${API}/api/lookups/materials?form_type_id=${formTypeId}&material_type_id=${materialTypeId}`),
      ]);
      const specs = (specRes.ok ? await specRes.json() : []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const mats = (matRes.ok ? await matRes.json() : []).sort(compareByMaterialName);
      setCascadeCache(p => ({ ...p, [key]: { specs, mats } }));
    } catch (e) { console.error('Cascade load failed:', e); }
  }

  // Auto-prefetch cascade for any rows that already have form+mat picked (handles component remount)
  useEffect(() => {
    const seen = new Set();
    parts.forEach(p => {
      if (p.form_type_id && p.material_type_id) {
        const key = `${p.form_type_id}|${p.material_type_id}`;
        if (!seen.has(key)) { seen.add(key); ensureCascade(p.form_type_id, p.material_type_id); }
      }
    });
  }, [parts]); // eslint-disable-line

  function updateRow(idx, patch) {
    const next = parts.map((p, i) => i === idx ? { ...p, ...patch } : p);
    onChange(next);
  }
  function addRow() {
    const newId = `part_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    // Copy form/mat/spec/material from the last row to speed up similar-part entry; user can change.
    const last = parts[parts.length - 1];
    const seed = last ? {
      form_type_id: last.form_type_id, form_type_name: last.form_type_name,
      material_type_id: last.material_type_id, material_type_name: last.material_type_name,
      specification_id: last.specification_id, spec_name: last.spec_name,
      material_id: last.material_id, material_name: last.material_name,
      weight_per_ft: last.weight_per_ft, dim1: last.dim1, density: last.density,
      width_ft_id: last.width_ft_id || ZERO_FT_WIDTH_ID, // panels often share width
      nest_type: last.nest_type
    } : {
      form_type_id: '', form_type_name: '',
      material_type_id: '', material_type_name: '',
      specification_id: '', spec_name: '',
      material_id: '', material_name: '',
      weight_per_ft: 0, dim1: 0, density: 0,
      width_ft_id: ZERO_FT_WIDTH_ID,
      nest_type: 'Linear'
    };
    let newTag;
    if (last && last.tag && last.tag.trim()) {
      newTag = nextTag(last.tag);
    } else if (!last) {
      // First part — pre-populate so the auto-increment pattern works from row 2 onward.
      newTag = 'P-1';
    } else {
      // Previous row exists but tag is empty — default to position-based sequence
      newTag = `P-${parts.length + 1}`;
    }
    onChange([...parts, {
      client_part_id: newId, tag: newTag, component: '', drawing: '',
      ...seed,
      quantity: 1, length_ft: 0, length_inch_id: ZERO_INCH_ID, width_inch_id: ZERO_INCH_ID,
      galv: false, plate_sa: false
    }]);
  }
  function removeRow(idx) {
    onChange(parts.filter((_, i) => i !== idx));
  }

  function isRowValid(p) {
    let lenIn = (parseInt(p.length_ft) || 0) * 12;
    if (p.length_inch_id) {
      const rec = lengthInch.find(r => String(r.id) === String(p.length_inch_id));
      if (rec) lenIn += parseFloat(rec.result) || 0;
    }
    return !!(p.form_type_id && p.material_type_id && p.specification_id && p.material_id
      && parseInt(p.quantity) > 0
      && lenIn > 0);
  }

  return (
    <div className="manual-parts-entry" style={{ background: 'white', border: '1px solid #e2e6eb', borderRadius: 6, padding: '14px 16px' }}>
      <div style={{ background: '#f5f6f8', margin: '-14px -16px 14px -16px', padding: '10px 16px', fontSize: 12, fontWeight: 600, color: '#444', borderBottom: '1px solid #e2e6eb', borderRadius: '6px 6px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>PARTS TO NEST</span>
        <button onClick={addRow} className="btn btn-primary btn-small">+ Add Part</button>
      </div>
      {parts.length === 0 ? (
        <p className="hint">No parts yet — click "Add Part" to start, or upload a CSV.</p>
      ) : (
        <div className="table-wrap">
          <table className="table" style={{ width: 'auto', minWidth: '100%' }}>
            <thead>
              <tr>
                <th></th>
                <th>Tag</th>
                <th>Form</th>
                <th>Mat Type</th>
                <th>Spec</th>
                <th>Material</th>
                <th>Qty</th>
                <th>FT(L)</th>
                <th>INCH(L)</th>
                <th>FT(W)</th>
                <th>INCH(W)</th>
                <th>Nest Type</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p, idx) => {
                const cacheKey = `${p.form_type_id}|${p.material_type_id}`;
                const cached = cascadeCache[cacheKey] || { specs: [], mats: [] };
                const specs = cached.specs;
                const mats = cached.mats;
                const valid = isRowValid(p);
                return (
                  <tr key={p.client_part_id} style={!valid && (p.form_type_id || p.material_type_id) ? { background: '#fff8e1' } : {}}>
                    <td style={{ width: 30 }}><button onClick={() => removeRow(idx)} className="btn btn-small btn-danger" title="Remove row" style={{ padding: '2px 6px' }}>×</button></td>
                    <td><input type="text" value={p.tag} onChange={e => updateRow(idx, { tag: e.target.value })} placeholder="P-1" style={{ width: 60 }} /></td>
                    <td>
                      <select value={p.form_type_id} onChange={e => {
                        const ft = formTypes.find(f => String(f.id) === String(e.target.value));
                        const measurement = ft?.measurement || '';
                        const newNestType = measurement === 'Panel' ? 'Panel' : (measurement === 'Linear' ? 'Linear' : p.nest_type);
                        updateRow(idx, {
                          form_type_id: e.target.value,
                          form_type_name: ft?.name || '',
                          specification_id: '', spec_name: '',
                          material_id: '', material_name: '', weight_per_ft: 0, dim1: 0, density: 0,
                          nest_type: newNestType,
                          // Reset width fields to zero IDs if switching to Linear
                          ...(newNestType === 'Linear' ? { width_ft_id: ZERO_FT_WIDTH_ID, width_inch_id: ZERO_INCH_ID } : {})
                        });
                        ensureCascade(e.target.value, p.material_type_id);
                      }}>
                        <option value="">—</option>
                        {formTypes.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.material_type_id} onChange={e => {
                        const mt = matTypes.find(m => String(m.id) === String(e.target.value));
                        updateRow(idx, {
                          material_type_id: e.target.value,
                          material_type_name: mt?.name || '',
                          specification_id: '', spec_name: '',
                          material_id: '', material_name: '', weight_per_ft: 0, dim1: 0, density: 0
                        });
                        ensureCascade(p.form_type_id, e.target.value);
                      }}>
                        <option value="">—</option>
                        {matTypes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.specification_id} onChange={e => {
                        const s = specs.find(x => String(x.id) === String(e.target.value));
                        updateRow(idx, { specification_id: e.target.value, spec_name: s?.name || '' });
                      }} disabled={specs.length === 0} style={{ minWidth: 130 }}>
                        <option value="">—</option>
                        {specs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.material_id} onChange={e => {
                        const m = mats.find(x => String(x.id) === String(e.target.value));
                        updateRow(idx, {
                          material_id: e.target.value,
                          material_name: m?.name || '',
                          weight_per_ft: m?.weight_per_ft || 0,
                          dim1: m?.dim1 || 0,
                          density: m?.density || 0
                        });
                      }} disabled={mats.length === 0} style={{ minWidth: 180 }}>
                        <option value="">—</option>
                        {mats.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td><input type="number" min="1" value={p.quantity} onChange={e => updateRow(idx, { quantity: parseInt(e.target.value) || 0 })} style={{ width: 50 }} /></td>
                    <td><input type="number" min="0" step="1" value={p.length_ft} onChange={e => updateRow(idx, { length_ft: parseInt(e.target.value) || 0 })} style={{ width: 50 }} /></td>
                    <td>
                      <select value={p.length_inch_id || ZERO_INCH_ID} onChange={e => updateRow(idx, { length_inch_id: e.target.value })}>
                        {lengthInch.map(li => <option key={li.id} value={li.id}>{li.description}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.width_ft_id || ZERO_FT_WIDTH_ID} onChange={e => updateRow(idx, { width_ft_id: e.target.value })} disabled={p.nest_type !== 'Panel'}>
                        {plateWidths.map(pw => <option key={pw.id} value={pw.id}>{pw.description || pw.width_ft + "'"}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={p.width_inch_id || ZERO_INCH_ID} onChange={e => updateRow(idx, { width_inch_id: e.target.value })} disabled={p.nest_type !== 'Panel'}>
                        {lengthInch.map(li => <option key={li.id} value={li.id}>{li.description}</option>)}
                      </select>
                    </td>
                    <td>
                      {p.nest_type === 'Linear' ? (
                        <span style={{
                          background: '#e8f5e9', color: '#2e7d32',
                          padding: '4px 12px', borderRadius: 12,
                          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                          display: 'inline-block'
                        }}>LINEAR</span>
                      ) : p.nest_type === 'Panel' ? (
                        <span style={{
                          background: '#ffebee', color: '#c62828',
                          padding: '4px 12px', borderRadius: 12,
                          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                          display: 'inline-block'
                        }}>PANEL</span>
                      ) : (
                        <span style={{ color: '#bbb' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [projectId, setProjectId] = useState(getProjectIdFromURL());
  const [manufactureId] = useState(getManufactureIdFromURL());
  const [userEmail] = useState(getUserFromURL());
  const isStandalone = !projectId && !!manufactureId;
  const [nestSource, setNestSource] = useState(isStandalone ? 'Manual' : 'Project');
  const [standaloneParts, setStandaloneParts] = useState([]);
  const [standaloneLookups, setStandaloneLookups] = useState({ formTypes: [], matTypes: [], lengthInch: [], plateWidths: [] });
  const [standaloneRuns, setStandaloneRuns] = useState([]);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [loadingRunId, setLoadingRunId] = useState(null);
  const [archivingRunId, setArchivingRunId] = useState(null);
  const [runsFilter, setRunsFilter] = useState('Active');
  const [runsSource, setRunsSource] = useState('All');
  const [runTitle, setRunTitle] = useState('');
  const [step, setStep] = useState(isStandalone ? 1 : (projectId ? 1 : 0));
  const [project, setProject] = useState(null);
  const [bom, setBom] = useState([]);
  const [stock, setStock] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [kerf1D, setKerf1D] = useState(0.125);
  const [kerf2D, setKerf2D] = useState(0.125);
  const [grainDirections, setGrainDirections] = useState({});
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [enabledStock, setEnabledStock] = useState(new Set());
  const [stockFilter, setStockFilter] = useState('all');
  const [newStock, setNewStock] = useState({ form_type: '', material_type: '', material_name: '', stock_length: '', stock_width: '', quantity: '1', reference: '' });
  const [nextCustomId, setNextCustomId] = useState(900000);
  const [lastNestPayload, setLastNestPayload] = useState(null);
  const [selectedPatterns, setSelectedPatterns] = useState(new Set());
  const [showPurchasePreview, setShowPurchasePreview] = useState(false);
  const [savingPurchase, setSavingPurchase] = useState(false);
  const [purchaseStatus, setPurchaseStatus] = useState('');
  const [savedPurchaseLines, setSavedPurchaseLines] = useState([]);
  const [loadingSavedPurchase, setLoadingSavedPurchase] = useState(false);
  const [showSavedPurchase, setShowSavedPurchase] = useState(false);
  const [savedRunInfo, setSavedRunInfo] = useState(null);

  const loadProject = useCallback(async (id) => {
    setLoading(true);
    setError('');
    try {
      const [projRes, bomRes, stockRes] = await Promise.all([
        fetch(`${API}/api/project/${id}`),
        fetch(`${API}/api/project/${id}/bom`),
        fetch(`${API}/api/stock`),
      ]);
      if (!projRes.ok) throw new Error('Project not found');
      const projData = await projRes.json();
      const bomData = await bomRes.json();
      const stockData = await stockRes.json();
      const taggedStock = stockData.map(s => ({ ...s, source: 'library' }));
      setProject(projData);
      setBom(bomData);
      setStock(taggedStock);
      const autoSelect = new Set();
      bomData.forEach(item => {
        if (item.nest_type && item.nest_type !== '') autoSelect.add(item.id);
      });
      setSelected(autoSelect);
      setEnabledStock(new Set(taggedStock.map(s => s.id)));
      setStep(1);
      // Auto-load saved nesting results
      try {
        const nestRes = await fetch(`${API}/api/project/${id}/nesting-results`);
        if (nestRes.ok) {
          const nestData = await nestRes.json();
          if (nestData.found && (nestData.results_1d?.length > 0 || nestData.results_2d?.length > 0)) {
            if (nestData._nameLookup && bomData.length > 0) {
              bomData.forEach(b => {
                if (b.form_type_id && b.form_type_name) nestData._nameLookup[b.form_type_id] = b.form_type_name;
                if (b.material_type_id && b.material_type_name) nestData._nameLookup[b.material_type_id] = b.material_type_name;
                if (b.specification_id && b.spec_name) nestData._nameLookup[b.specification_id] = b.spec_name;
                if (b.material_id && b.material_name) nestData._nameLookup[b.material_id] = b.material_name;
              });
            }
            setSavedRunInfo(nestData.run_header);
            setResults(nestData);
            autoSelectAllPatterns(nestData);
            if (nestData.run_header?.kerf_1d) setKerf1D(nestData.run_header.kerf_1d);
            if (nestData.run_header?.kerf_2d) setKerf2D(nestData.run_header.kerf_2d);
          }
        }
      } catch (e) { console.error('Auto-load nesting results:', e); }
      // Auto-load saved purchase list
      try {
        const plRes = await fetch(`${API}/api/project/${id}/purchase-list`);
        if (plRes.ok) {
          const plData = await plRes.json();
          if (plData.purchase_lines && plData.purchase_lines.length > 0) {
            setSavedPurchaseLines(plData.purchase_lines);
            setShowSavedPurchase(true);
          }
        }
      } catch (e) { console.error('Auto-load purchase list:', e); }
    } catch (err) {
      setError(err.message || 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectId) loadProject(projectId);
  }, [projectId, loadProject]);

  // Standalone mode: convert standaloneParts into bom-shape rows so downstream code (selectedBom, bomKeys, runNesting) works unchanged
  useEffect(() => {
    if (!isStandalone) return;
    const lengthInchTbl = standaloneLookups.lengthInch;
    const plateWidthTbl = standaloneLookups.plateWidths;
    const bomRows = standaloneParts.map(p => {
      const dims = dimsToInches(p.length_ft, p.length_inch_id, p.width_ft_id, p.width_inch_id, lengthInchTbl, plateWidthTbl);
      return {
        id: p.client_part_id,
        bom_item: p.tag || `Part ${p.client_part_id.slice(-4)}`,
        nest_type: p.nest_type,
        form_type_id: p.form_type_id,
        form_type_name: p.form_type_name,
        material_type_id: p.material_type_id,
        material_type_name: p.material_type_name,
        specification_id: p.specification_id,
        spec_name: p.spec_name,
        material_id: p.material_id,
        material_name: p.material_name,
        material_dim1: parseFloat(p.dim1) || 0,
        quantity: parseInt(p.quantity) || 0,
        length_nest: dims.length_in,
        width_nest: dims.width_in,
        density: parseFloat(p.density) || 0,
        weight_per_ft: parseFloat(p.weight_per_ft) || 0,
        // pass-through standalone-only fields needed at save time
        _standalone: true,
        _client_part_id: p.client_part_id,
        _tag: p.tag, _component: p.component, _drawing: p.drawing,
        _length_ft: p.length_ft,
        _length_inch_id: p.length_inch_id, _width_ft_id: p.width_ft_id, _width_inch_id: p.width_inch_id,
        _galv: p.galv, _plate_sa: p.plate_sa
      };
    }).filter(r => r.form_type_id && r.material_type_id && r.quantity > 0 && r.length_nest > 0);
    setBom(bomRows);
    setSelected(new Set(bomRows.map(r => r.id)));
  }, [standaloneParts, standaloneLookups, isStandalone]);

  // Standalone mode: fetch list of prior runs for this manufacturer (filterable by status + source)
  const refreshStandaloneRuns = useCallback(() => {
    if (!isStandalone || !manufactureId) return Promise.resolve();
    return fetch(`${API}/api/standalone/nesting-runs?manufacturer_id=${manufactureId}&status=${runsFilter}&source=${runsSource}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.runs) setStandaloneRuns(data.runs); else setStandaloneRuns([]); })
      .catch(e => console.error('Standalone runs list:', e));
  }, [isStandalone, manufactureId, runsFilter, runsSource]);

  useEffect(() => {
    if (isStandalone && manufactureId) refreshStandaloneRuns();
  }, [isStandalone, manufactureId, runsFilter, runsSource, refreshStandaloneRuns]);

  async function archiveStandaloneRun(runId, newStatus) {
    setArchivingRunId(runId);
    try {
      const resp = await fetch(`${API}/api/standalone/runs/${runId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (!resp.ok) throw new Error('Status update failed');
      await refreshStandaloneRuns();
    } catch (e) {
      console.error('Archive run:', e);
      setError(e.message || 'Failed to update run');
    } finally {
      setArchivingRunId(null);
    }
  }

  async function loadStandaloneRun(runId) {
    if (!runId) return;
    setLoadingRunId(runId);
    try {
      const resp = await fetch(`${API}/api/standalone/nesting-results?manufacturer_id=${manufactureId}&run_id=${runId}`);
      if (!resp.ok) throw new Error('Failed to load run');
      const data = await resp.json();
      if (!data.found) { setError('Run not found'); return; }
      setSavedRunInfo(data.run_header);
      setResults(data);
      autoSelectAllPatterns(data);
      if (data.run_header?.kerf_1d) setKerf1D(data.run_header.kerf_1d);
      if (data.run_header?.kerf_2d) setKerf2D(data.run_header.kerf_2d);
      setStep(3);
    } catch (e) {
      setError(e.message || 'Failed to load run');
    } finally {
      setLoadingRunId(null);
    }
  }

  async function fetchSavedNestingResults() {
    try {
      const url = isStandalone
        ? `${API}/api/standalone/nesting-results?manufacturer_id=${manufactureId}`
        : `${API}/api/project/${projectId}/nesting-results`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.found) return;
      if (data._nameLookup && bom.length > 0) {
        bom.forEach(b => {
          if (b.form_type_id && b.form_type_name) data._nameLookup[b.form_type_id] = b.form_type_name;
          if (b.material_type_id && b.material_type_name) data._nameLookup[b.material_type_id] = b.material_type_name;
          if (b.specification_id && b.spec_name) data._nameLookup[b.specification_id] = b.spec_name;
          if (b.material_id && b.material_name) data._nameLookup[b.material_id] = b.material_name;
        });
      }
      setSavedRunInfo(data.run_header);
      setResults(data);
      autoSelectAllPatterns(data);
      if (data.run_header?.kerf_1d) setKerf1D(data.run_header.kerf_1d);
      if (data.run_header?.kerf_2d) setKerf2D(data.run_header.kerf_2d);
    } catch (err) {
      console.error('Error fetching saved nesting results:', err);
    }
  }

  async function fetchSavedPurchaseList() {
    setLoadingSavedPurchase(true);
    try {
      const resp = await fetch(`${API}/api/project/${projectId}/purchase-list`);
      if (!resp.ok) throw new Error('Failed to fetch purchase list');
      const data = await resp.json();
      setSavedPurchaseLines(data.purchase_lines || []);
      setShowSavedPurchase(true);
    } catch (err) {
      console.error('Error fetching saved purchase list:', err);
      setSavedPurchaseLines([]);
      setShowSavedPurchase(true);
    } finally {
      setLoadingSavedPurchase(false);
    }
  }

  function toggleSelect(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function selectAll() { setSelected(new Set(bom.filter(b => b.nest_type).map(b => b.id))); }
  function selectNone() { setSelected(new Set()); }
  function toggleStock(id) {
    setEnabledStock(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function enableAllStock() { setEnabledStock(new Set(stock.map(s => s.id))); }
  function disableAllStock() { setEnabledStock(new Set()); }

  function togglePattern(key) {
    setSelectedPatterns(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  function selectAllPatterns() {
    if (!results) return;
    const allKeys = new Set();
    groupResults(results.results_1d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`1d-${gi}-${pi}`));
    });
    groupResults(results.results_2d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`2d-${gi}-${pi}`));
    });
    setSelectedPatterns(allKeys);
  }

  function clearAllPatterns() { setSelectedPatterns(new Set()); }

  function autoSelectAllPatterns(data) {
    const allKeys = new Set();
    groupResults(data.results_1d, data._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`1d-${gi}-${pi}`));
    });
    groupResults(data.results_2d, data._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`2d-${gi}-${pi}`));
    });
    setSelectedPatterns(allKeys);
  }

  function getSelectedResults() {
    if (!results) return { selected_1d: [], selected_2d: [] };
    const selected_1d = [];
    const selected_2d = [];
    groupResults(results.results_1d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((pattern, pi) => {
        if (selectedPatterns.has(`1d-${gi}-${pi}`)) selected_1d.push(...pattern.stockPieces);
      });
    });
    groupResults(results.results_2d, results._nameLookup).forEach((group, gi) => {
      group.patterns.forEach((pattern, pi) => {
        if (selectedPatterns.has(`2d-${gi}-${pi}`)) selected_2d.push(...pattern.stockPieces);
      });
    });
    return { selected_1d, selected_2d };
  }

  function getWeightMap() {
    const map = {};
    bom.forEach(b => { map[String(b.id)] = parseFloat(b.weight_per_ft) || 0; });
    return map;
  }

  function getStockWeightPerFt(result, weightMap) {
    const firstCut = result.cuts?.[0];
    if (!firstCut) return 0;
    return weightMap[String(firstCut.bom_line_id)] || 0;
  }

  function buildPurchaseLines() {
    if (!results) return [];
    const { selected_1d, selected_2d } = getSelectedResults();
    const weightMap = getWeightMap();
    const agg = {};
    for (const r of [...selected_1d, ...selected_2d]) {
      if (r.error) continue;
      const firstCut = r.cuts?.[0];
      if (!firstCut) continue;
      const is2D = r.stock_width_in && r.stock_width_in > 0;
      const key = `${r.form_type}|${r.material_origin}|${firstCut.spec_name}|${firstCut.material_type}|${r.stock_length_in}|${r.stock_width_in || 0}`;
      if (!agg[key]) {
        const wpf = weightMap[String(firstCut.bom_line_id)] || 0;
        const unitWt = calcUnitWeight(wpf, r.stock_length_in, is2D ? r.stock_width_in : 0);
        const bomItem = bom.find(b =>
          String(b.form_type_id) === String(r.form_type) &&
          String(b.material_type_id) === String(r.material_origin)
        );
        const ftn = results._nameLookup?.[r.form_type] || r.form_type;
        const mtn = results._nameLookup?.[r.material_origin] || r.material_origin;
        const specName = results._nameLookup?.[firstCut.spec_name] || '';
        const matName = results._nameLookup?.[firstCut.material_type] || '';
        const sizeDesc = is2D
          ? `${inToFt(r.stock_length_in)} × ${inToFt(r.stock_width_in)}`
          : inToFt(r.stock_length_in);
        agg[key] = {
          form_type_id: r.form_type,
          material_type_id: r.material_origin,
          specification_id: firstCut.spec_name,
          material_id: firstCut.material_type,
          description: `${ftn} | ${mtn} | ${specName} | ${matName} | ${sizeDesc}`,
          form_type_name: ftn,
          material_type_name: mtn,
          spec_name: bomItem?.spec_name || '',
          material_name: bomItem?.material_name || '',
          material_size: matName,
          stock_length_in: r.stock_length_in,
          stock_width_in: r.stock_width_in || 0,
          quantity: 0,
          feet_length: r.stock_length_in / 12,
          weight_per_ft: wpf,
          unit_weight: unitWt,
          total_weight: 0,
          total_length: is2D ? 0 : (r.stock_length_in / 12),
          total_plate_width: is2D ? r.stock_width_in : 0,
          is2D,
        };
      }
      agg[key].quantity += 1;
    }
    const lines = Object.values(agg);
    lines.forEach(line => { line.total_weight = line.unit_weight * line.quantity; });
    return lines;
  }

  // ─── FIX: savePurchaseList with auto-refresh after save ───
  async function savePurchaseList() {
    const lines = buildPurchaseLines();
    if (lines.length === 0) {
      setPurchaseStatus('Error: No purchase lines to save');
      return;
    }
    setSavingPurchase(true);
    setPurchaseStatus('');
    try {
      const resp = await fetch(`${API}/api/project/${projectId}/generate-purchase-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchase_lines: lines }),
      });
      if (!resp.ok) throw new Error('Save failed');
      const data = await resp.json();
      setPurchaseStatus(`Purchase list saved! ${data.items_saved} line items written to project. Refreshing...`);
      // Wait 2s for Zoho to finish writing before re-fetching
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const refreshResp = await fetch(`${API}/api/project/${projectId}/purchase-list`);
        if (refreshResp.ok) {
          const refreshData = await refreshResp.json();
          const newLines = refreshData.purchase_lines || [];
          setSavedPurchaseLines(newLines);
          setShowSavedPurchase(true);
          setPurchaseStatus(`Purchase list saved! ${newLines.length} line items confirmed in project.`);
        }
      } catch (e) {
        console.error('Purchase list refresh failed:', e);
        setPurchaseStatus(`Purchase list saved! ${data.items_saved} line items written. Click "View Saved" to refresh.`);
      }
    } catch (err) {
      setPurchaseStatus(`Error: ${err.message}`);
    } finally {
      setSavingPurchase(false);
    }
  }

  // ─── Weight Summary Calculations ───
  function calcWeightSummary() {
    if (!results) return { totalAllocated: 0, totalWaste: 0, totalStock: 0 };
    const { selected_1d, selected_2d } = getSelectedResults();
    const weightMap = getWeightMap();
    let totalStock = 0;
    let totalAllocated = 0;
    for (const r of [...selected_1d, ...selected_2d]) {
      if (r.error || !r.cuts?.length) continue;
      const wpf = getStockWeightPerFt(r, weightMap);
      const is2D = r.stock_width_in && r.stock_width_in > 0;
      const stockWt = calcUnitWeight(wpf, r.stock_length_in, is2D ? r.stock_width_in : 0);
      totalStock += stockWt;
      for (const cut of r.cuts) {
        const cutWt = is2D
          ? wpf * ((cut.cut_length * cut.cut_width) / 144)
          : wpf * (cut.cut_length / 12);
        totalAllocated += cutWt * (cut.quantity_on_this_stock || 1);
      }
    }
    return { totalStock, totalAllocated, totalWaste: totalStock - totalAllocated };
  }

  function addCustomStock() {
    if (!newStock.form_type || !newStock.material_type || !newStock.stock_length) return;
    const id = nextCustomId;
    const matchingBom = selectedBom.find(
      b => b.form_type_name === newStock.form_type && b.material_type_name === newStock.material_type
    );
    const entry = {
      id,
      form_type: matchingBom?.form_type_id || newStock.form_type,
      form_type_name: newStock.form_type,
      material_type: matchingBom?.material_type_id || newStock.material_type,
      material_type_name: newStock.material_type,
      material_name: newStock.material_name || '',
      stock_length: parseFloat(newStock.stock_length),
      stock_width: newStock.stock_width ? parseFloat(newStock.stock_width) : null,
      density: 0,
      is_standard: 'No',
      source: 'custom',
      quantity: newStock.quantity || '',
      reference: newStock.reference || '',
    };
    setStock(prev => [...prev, entry]);
    setEnabledStock(prev => { const n = new Set(prev); n.add(id); return n; });
    setNextCustomId(prev => prev + 1);
    setNewStock(prev => ({ ...prev, material_name: '', stock_length: '', stock_width: '', quantity: '1', reference: '' }));
  }

  function removeCustomStock(id) {
    setStock(prev => prev.filter(s => s.id !== id));
    setEnabledStock(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  function setStockQuantity(id, value) {
    setStock(prev => prev.map(s => s.id === id ? { ...s, quantity: value } : s));
  }

  const selectedBom = bom.filter(b => selected.has(b.id) && b.nest_type);
  const formTypes = [...new Set(selectedBom.map(b => b.form_type_name).filter(Boolean))];
  const matTypes = [...new Set(selectedBom.map(b => b.material_type_name).filter(Boolean))];
  const bomKeys = new Set(selectedBom.map(b => `${b.form_type_id}|${b.material_type_id}`));
  const matchedStock = stock.filter(s => bomKeys.has(`${s.form_type}|${s.material_type}`));
  const activeStockCount = matchedStock.filter(s => enabledStock.has(s.id)).length;

  function getFilteredStock() {
    let list = matchedStock;
    if (stockFilter === 'library') list = list.filter(s => s.source === 'library');
    if (stockFilter === 'custom') list = list.filter(s => s.source === 'custom');
    return [...list].sort((a, b) => {
      const ftA = (a.form_type_name || a.form_type || '').toString().toLowerCase();
      const ftB = (b.form_type_name || b.form_type || '').toString().toLowerCase();
      if (ftA !== ftB) return ftA.localeCompare(ftB);
      const mtA = (a.material_type_name || a.material_type || '').toString().toLowerCase();
      const mtB = (b.material_type_name || b.material_type || '').toString().toLowerCase();
      if (mtA !== mtB) return mtA.localeCompare(mtB);
      const lenA = parseFloat(a.stock_length) || 0;
      const lenB = parseFloat(b.stock_length) || 0;
      if (lenA !== lenB) return lenA - lenB;
      const wA = parseFloat(a.stock_width) || 0;
      const wB = parseFloat(b.stock_width) || 0;
      return wA - wB;
    });
  }

  async function runNesting() {
    setLoading(true);
    setError('');
    setResults(null);
    setSelectedPatterns(new Set());
    setShowPurchasePreview(false);
    setSavedRunInfo(null);
    setPurchaseStatus('');
    try {
      const parts1D = [];
      const parts2D = [];
      const neededKeys1D = new Set();
      const neededKeys2D = new Set();
      for (const row of selectedBom) {
        if (!row.nest_type || !row.quantity || !row.length_nest) continue;
        if (row.nest_type === 'Linear') {
          parts1D.push({
            bom_line_id: String(row.id),
            part_mark: String(row.bom_item),
            form_type: String(row.form_type_id),
            material_type: String(row.material_id),
            material_origin: String(row.material_type_id),
            material_name: row.material_name || '',
            spec_name: String(row.specification_id),
            density: parseFloat(row.density) || 0,
            length_in: parseFloat(row.length_nest),
            quantity: parseInt(row.quantity),
            form_type_name: row.form_type_name || '',
            mat_type_name: row.material_type_name || '',
            spec_name_display: row.spec_name || '',
            material_name_display: row.material_name || '',
          });
          neededKeys1D.add(`${row.form_type_id}|${row.material_type_id}`);
        }
        if (row.nest_type === 'Panel') {
          parts2D.push({
            bom_line_id: String(row.id),
            part_mark: String(row.bom_item),
            form_type: String(row.form_type_id),
            material_type: String(row.material_id),
            material_origin: String(row.material_type_id),
            material_name: row.material_name || '',
            spec_name: String(row.specification_id),
            density: parseFloat(row.density) || 0,
            length_in: parseFloat(row.length_nest),
            width_in: parseFloat(row.width_nest) || 0,
            thickness_in: parseFloat(row.material_dim1) || 0,
            quantity: parseInt(row.quantity),
            grain_direction: grainDirections[row.id] || 'none',
            form_type_name: row.form_type_name || '',
            mat_type_name: row.material_type_name || '',
            spec_name_display: row.spec_name || '',
            material_name_display: row.material_name || '',
          });
          neededKeys2D.add(`${row.form_type_id}|${row.material_type_id}`);
        }
      }
      const enabledStockItems = stock.filter(s => enabledStock.has(s.id));
      const stock1D = enabledStockItems
        .filter(s => (!s.stock_width || parseFloat(s.stock_width) === 0) && neededKeys1D.has(`${s.form_type}|${s.material_type}`))
        .map(s => ({
          stock_id: String(s.id),
          stock_label: `${s.form_type_name || s.form_type} | ${s.material_type_name || s.material_type}`,
          form_type: String(s.form_type),
          material_origin: String(s.material_type),
          material_name: s.material_name || '',
          quantity: s.quantity ? parseInt(s.quantity, 10) : null,
          reference: s.reference || '',
          density: parseFloat(s.density) || 0,
          length_in: parseFloat(s.stock_length),
          is_standard: String(s.is_standard),
        }));
      const stock2D = enabledStockItems
        .filter(s => s.stock_width && parseFloat(s.stock_width) > 0 && neededKeys2D.has(`${s.form_type}|${s.material_type}`))
        .map(s => ({
          stock_id: String(s.id),
          stock_label: `${s.form_type_name || s.form_type} | ${s.material_type_name || s.material_type}`,
          form_type: String(s.form_type),
          material_origin: String(s.material_type),
          material_name: s.material_name || '',
          quantity: s.quantity ? parseInt(s.quantity, 10) : null,
          reference: s.reference || '',
          density: parseFloat(s.density) || 0,
          length_in: parseFloat(s.stock_length),
          width_in: parseFloat(s.stock_width),
          is_standard: String(s.is_standard),
        }));
      const payload = {
        project_id: String(projectId || manufactureId || 'standalone'),
        run_number: 1,
        kerf_1d: kerf1D,
        kerf_2d: kerf2D,
        parts_1d: parts1D,
        parts_2d: parts2D,
        stock_1d: stock1D,
        stock_2d: stock2D,
      };
      setLastNestPayload(payload);
      const resp = await fetch(`${API}/api/nest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        let detail = '';
        try {
          const errBody = await resp.json();
          const d = errBody.details ?? errBody.error ?? errBody;
          detail = typeof d === 'string' ? d : JSON.stringify(d);
        } catch (_) { detail = await resp.text().catch(() => ''); }
        console.error('Nesting API failure:', detail);
        throw new Error(`Nesting API error (${resp.status}): ${detail || 'no detail'}`);
      }
      const data = await resp.json();
      const nameLookup = {};
      [...parts1D, ...parts2D].forEach(p => {
        nameLookup[p.form_type] = p.form_type_name;
        nameLookup[p.material_origin] = p.mat_type_name;
        nameLookup[p.spec_name] = p.spec_name_display;
        nameLookup[p.material_type] = p.material_name_display;
      });
      data._nameLookup = nameLookup;
      setResults(data);
      autoSelectAllPatterns(data);
      setStep(3);
    } catch (err) {
      setError(err.message || 'Nesting failed');
    } finally {
      setLoading(false);
    }
  }

  async function saveToZoho() {
    if (!results) return;
    const { selected_1d, selected_2d } = getSelectedResults();
    if (selected_1d.length === 0 && selected_2d.length === 0) {
      setSaveStatus('Error: No patterns selected for import');
      return;
    }
    setSaving(true);
    setSaveStatus('');
    try {
      let resp;
      if (isStandalone) {
        // Build parts payload from standaloneParts (the user-entered list)
        const partsPayload = standaloneParts
          .filter(p => p.form_type_id && p.material_type_id && p.quantity > 0)
          .map(p => ({
            client_part_id: p.client_part_id,
            tag: p.tag, component: p.component, drawing: p.drawing,
            form_type_id: p.form_type_id, material_type_id: p.material_type_id,
            specification_id: p.specification_id, material_id: p.material_id,
            quantity: parseInt(p.quantity) || 0,
            length_ft: parseInt(p.length_ft) || 0,
            length_inch_id: p.length_inch_id || '',
            width_ft_id: p.width_ft_id || '',
            width_inch_id: p.width_inch_id || '',
            galv: !!p.galv, plate_sa: !!p.plate_sa,
            nest_type: p.nest_type || 'Linear',
            weight_per_ft: parseFloat(p.weight_per_ft) || 0,
            dim1: parseFloat(p.dim1) || 0,
            density: parseFloat(p.density) || 0,
          }));
        resp = await fetch(`${API}/api/standalone/save-results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manufacturer_id: manufactureId,
            nest_source: nestSource === 'CSV' ? 'CSV' : 'Manual',
            parts: partsPayload,
            results_1d: selected_1d,
            results_2d: selected_2d,
            summary: results.summary,
            kerf_1d: kerf1D,
            kerf_2d: kerf2D,
            run_title: runTitle.trim(),
            created_by: userEmail,
          }),
        });
      } else {
        resp = await fetch(`${API}/api/project/${projectId}/save-results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            results_1d: selected_1d,
            results_2d: selected_2d,
            summary: results.summary,
            kerf_1d: kerf1D,
            kerf_2d: kerf2D,
            created_by: userEmail,
          }),
        });
      }
      if (!resp.ok) throw new Error('Save failed');
      const data = await resp.json();
      setSaveStatus(`Saved! Run #${data.run_number} — ${data.saved_1d || 0} 1D + ${data.saved_2d || 0} 2D results (Status: ${data.run_status})`);
      setRunTitle('');
      if (isStandalone) await refreshStandaloneRuns();
    } catch (err) {
      setSaveStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  const selectedPatternCount = selectedPatterns.size;
  const weightSummary = (step === 3 && results) ? calcWeightSummary() : null;
  const stockShortages = (() => {
    if (step !== 3 || !results) return [];
    const usage = {};
    [...(results.results_1d || []), ...(results.results_2d || [])].forEach(r => {
      if (r.error) return;
      const id = String(r.stock_id);
      usage[id] = (usage[id] || 0) + 1;
    });
    return stock.reduce((acc, s) => {
      const qty = parseInt(s.quantity, 10);
      if (!Number.isFinite(qty) || qty < 0) return acc;
      const used = usage[String(s.id)] || 0;
      if (used > qty) {
        acc.push({
          id: s.id,
          form_type_name: s.form_type_name || s.form_type,
          material_type_name: s.material_type_name || s.material_type,
          stock_length: s.stock_length,
          stock_width: s.stock_width,
          used,
          qty,
          short: used - qty,
        });
      }
      return acc;
    }, []);
  })();
  const purchaseLines = (step === 3 && results && showPurchasePreview) ? buildPurchaseLines() : [];
  const weightMap = (step === 3 && results) ? getWeightMap() : {};

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo-group">
            <img src="/Material Compass Circle Logo.png" alt="Material Compass" className="logo-icon" style={{ width: 40, height: 40, borderRadius: '50%' }} />
            <div>
              <h1 className="logo-title">Material Compass</h1>
              <p className="logo-sub">Nesting</p>
            </div>
          </div>
          {project && (
            <div className="project-badge">
              {project.Project_Quote_Number || project.Project_Description || `Project #${projectId}`}
            </div>
          )}
          {isStandalone && (
            <div className="project-badge">
              Standalone Nesting — Mfg ID {manufactureId.slice(-6)}
            </div>
          )}
        </div>
      </header>

      <main className="main" style={isStandalone && step === 1 ? { maxWidth: 1500 } : {}}>
        <div className="steps">
          {['Select Items', 'Configure', 'Results'].map((label, i) => (
            <div key={i} className={`step-dot ${step >= i + 1 ? 'active' : ''} ${step === i + 1 ? 'current' : ''}`}>
              <span className="step-num">{i + 1}</span>
              <span className="step-label">{label}</span>
            </div>
          ))}
        </div>

        {error && <div className="error-box">{error}</div>}
        {loading && <div className="loading-box">Loading...</div>}

        {/* Step 0: Enter Project ID (project mode only) */}
        {step === 0 && !loading && !isStandalone && (
          <div className="card">
            <h2>Enter Project ID</h2>
            <p className="hint">Or pass ?project_id=123 in the URL</p>
            <div className="input-row">
              <input
                type="text"
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                placeholder="Project ID"
                className="input"
              />
              <button onClick={() => loadProject(projectId)} className="btn btn-primary" disabled={!projectId}>
                Load Project
              </button>
            </div>
          </div>
        )}

        {/* Step 1 — Standalone: source toggle + manual entry */}
        {step === 1 && isStandalone && (
          <div className="card">
            <div className="card-header">
              <h2>Quick Nest — Standalone</h2>
              <div className="btn-group">
                <button onClick={() => setNestSource('Manual')} className={`btn btn-small ${nestSource === 'Manual' ? 'btn-primary' : ''}`}>Manual entry</button>
                <button onClick={() => setNestSource('CSV')} className={`btn btn-small ${nestSource === 'CSV' ? 'btn-primary' : ''}`} disabled>CSV upload (coming soon)</button>
              </div>
            </div>
            <p className="hint">
              Saved nests are visible to everyone at your company.
            </p>

            {/* Recall panel: previously saved standalone nests */}
            <div style={{ background: 'white', border: '1px solid #e2e6eb', borderRadius: 6, marginBottom: 18, overflow: 'hidden' }}>
              <div style={{ background: '#f5f6f8', padding: '10px 16px', fontSize: 12, fontWeight: 600, color: '#444', borderBottom: '1px solid #e2e6eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span>SAVED NESTS (YOUR COMPANY)</span>
                <span style={{ fontWeight: 400, color: '#888', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, fontWeight: 600 }}>SOURCE:</span>
                  <select
                    value={runsSource}
                    onChange={e => { setRunsSource(e.target.value); setShowAllRuns(false); }}
                    style={{ fontSize: 11, padding: '2px 6px' }}
                  >
                    <option value="All">All</option>
                    <option value="Manual">Manual</option>
                    <option value="CSV">CSV</option>
                    <option value="Project">Project</option>
                  </select>
                  <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 6 }}>STATUS:</span>
                  <select
                    value={runsFilter}
                    onChange={e => { setRunsFilter(e.target.value); setShowAllRuns(false); }}
                    style={{ fontSize: 11, padding: '2px 6px' }}
                  >
                    <option value="Active">Active</option>
                    <option value="Archived">Archived</option>
                    <option value="All">All</option>
                  </select>
                  {standaloneRuns.length > 0 && (
                    <span>
                      {showAllRuns ? `${standaloneRuns.length} of ${standaloneRuns.length}` : `${Math.min(5, standaloneRuns.length)} of ${standaloneRuns.length}`}
                    </span>
                  )}
                  {standaloneRuns.length > 5 && (
                    <button
                      onClick={() => setShowAllRuns(v => !v)}
                      className="btn btn-small"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                    >
                      {showAllRuns ? 'Show less' : 'Show all'}
                    </button>
                  )}
                </span>
              </div>
              {standaloneRuns.length === 0 ? (
                <div style={{ padding: '20px 16px', fontSize: 12, color: '#888', textAlign: 'center' }}>
                  No {runsFilter === 'All' ? '' : runsFilter.toLowerCase()} nests saved yet.
                </div>
              ) : (
                <div>
                  {(showAllRuns ? standaloneRuns : standaloneRuns.slice(0, 5)).map(run => {
                    const sourceTagStyle = run.nest_source === 'CSV'
                      ? { background: '#f3e5f5', color: '#7b1fa2' }
                      : run.nest_source === 'Project'
                        ? { background: '#e8f5e9', color: '#2e7d32' }
                        : { background: '#e3f2fd', color: '#1976d2' };
                    const isArchived = run.run_status === 'Archived';
                    const isProject = run.nest_source === 'Project';
                    // Title fallback: explicit title > project name > "Untitled"
                    const titleNode = run.run_title
                      ? <span>{run.run_title}</span>
                      : run.project_name
                        ? <span>Project: <strong>{run.project_name}</strong></span>
                        : <span style={{ color: '#999', fontWeight: 400, fontStyle: 'italic' }}>Untitled</span>;
                    return (
                      <div key={run.id} style={{
                        padding: '10px 16px', borderBottom: '1px solid #f0f2f5',
                        display: 'grid', gridTemplateColumns: '70px 70px 1fr 140px 70px 90px',
                        gap: 12, alignItems: 'center', fontSize: 12,
                        opacity: isArchived ? 0.65 : 1
                      }}>
                        <span style={{ fontWeight: 600, color: '#5F94CE' }}>Run #{run.run_number}</span>
                        <span style={{ ...sourceTagStyle, padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, textAlign: 'center' }}>
                          {(run.nest_source || '?').toUpperCase()}
                        </span>
                        <span style={{ color: '#222', overflow: 'hidden' }}>
                          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                            {titleNode}
                          </div>
                          <div style={{ fontSize: 11, color: '#666', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                            {run.total_stock_pieces} stock pcs
                            {run.created_by ? ` • saved by ${emailLocalPart(run.created_by)}` : ''}
                            {isArchived ? ' • archived' : ''}
                          </div>
                        </span>
                        <span style={{ color: '#888', fontSize: 11 }}>{run.run_date}</span>
                        <button
                          onClick={() => loadStandaloneRun(run.id)}
                          className="btn btn-small"
                          disabled={loadingRunId === run.id}
                          style={{ fontSize: 11, padding: '4px 10px' }}
                        >
                          {loadingRunId === run.id ? '…' : 'Load'}
                        </button>
                        {isProject ? (
                          <span style={{ fontSize: 10, color: '#888', textAlign: 'center' }} title="Manage project runs from the project page">—</span>
                        ) : (
                          <button
                            onClick={() => archiveStandaloneRun(run.id, isArchived ? 'Approved' : 'Archived')}
                            className="btn btn-small"
                            disabled={archivingRunId === run.id}
                            style={{ fontSize: 11, padding: '4px 8px' }}
                            title={isArchived ? 'Restore to Active' : 'Archive (hide from default view)'}
                          >
                            {archivingRunId === run.id ? '…' : (isArchived ? 'Restore' : 'Archive')}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Section divider — visually separate "review past nests" from "start a new nest" */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 32, marginBottom: 14 }}>
              <div style={{ flex: 1, height: 1, background: '#d4dde6' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#5F94CE', letterSpacing: 1, textTransform: 'uppercase' }}>
                Start a new nest
              </span>
              <div style={{ flex: 1, height: 1, background: '#d4dde6' }} />
            </div>

            {/* Run title — labels the new nest the user is about to enter (required) */}
            <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#5F94CE', textTransform: 'uppercase', letterSpacing: 0.5, minWidth: 100 }}>
                Run Title <span style={{ color: '#d32f2f' }}>*</span>
              </label>
              <input
                type="text"
                value={runTitle}
                onChange={e => setRunTitle(e.target.value)}
                placeholder="Required — e.g. 'Smith Job', 'Shop scrap nest', 'Quote #1234'"
                className="input"
                style={{ flex: 1, maxWidth: 500, borderColor: runTitle.trim() ? '' : '#f5b7b1' }}
              />
            </div>

            <ManualPartsEntry
              parts={standaloneParts}
              onChange={setStandaloneParts}
              lookupTables={standaloneLookups}
              onLookupTablesLoaded={setStandaloneLookups}
            />
            <div className="card-footer">
              <span className="count">
                {standaloneParts.length} part{standaloneParts.length !== 1 ? 's' : ''} entered
                {(() => {
                  const liTbl = standaloneLookups.lengthInch || [];
                  const isPartValid = (p) => {
                    let lenIn = (parseInt(p.length_ft) || 0) * 12;
                    if (p.length_inch_id) {
                      const rec = liTbl.find(r => String(r.id) === String(p.length_inch_id));
                      if (rec) lenIn += parseFloat(rec.result) || 0;
                    }
                    return !!(p.form_type_id && p.material_type_id && p.specification_id && p.material_id
                      && parseInt(p.quantity) > 0 && lenIn > 0);
                  };
                  const incomplete = standaloneParts.filter(p => !isPartValid(p)).length;
                  if (!runTitle.trim()) return <span style={{ color: '#d32f2f', marginLeft: 8 }}>— Run Title required</span>;
                  if (incomplete > 0) return <span style={{ color: '#d32f2f', marginLeft: 8 }}>— {incomplete} incomplete</span>;
                  return null;
                })()}
              </span>
              <button
                onClick={() => setStep(2)}
                className="btn btn-primary"
                disabled={(() => {
                  if (!runTitle.trim()) return true;
                  if (standaloneParts.length === 0) return true;
                  const liTbl = standaloneLookups.lengthInch || [];
                  return standaloneParts.some(p => {
                    let lenIn = (parseInt(p.length_ft) || 0) * 12;
                    if (p.length_inch_id) {
                      const rec = liTbl.find(r => String(r.id) === String(p.length_inch_id));
                      if (rec) lenIn += parseFloat(rec.result) || 0;
                    }
                    return !(p.form_type_id && p.material_type_id && p.specification_id && p.material_id
                      && parseInt(p.quantity) > 0 && lenIn > 0);
                  });
                })()}
              >
                Next → Configure
              </button>
            </div>
          </div>
        )}

        {/* Step 1 — Project mode: BOM */}
        {step === 1 && !isStandalone && (
          <div className="card">
            <div className="card-header">
              <h2>Bill of Materials</h2>
              <div className="btn-group">
                <button onClick={selectAll} className="btn btn-small">Select All</button>
                <button onClick={selectNone} className="btn btn-small">Clear</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th></th><th>Mark</th><th>Type</th><th>Form</th><th>Material</th>
                    <th>Spec</th><th>Size</th><th>Qty</th><th>Length</th><th>Width</th><th>Wt/Ft</th>
                  </tr>
                </thead>
                <tbody>
                  {bom.map(item => (
                    <tr key={item.id} className={selected.has(item.id) ? 'row-selected' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(item.id)}
                          onChange={() => toggleSelect(item.id)}
                          disabled={!item.nest_type}
                        />
                      </td>
                      <td className="mono">{item.bom_item}</td>
                      <td>
                        <span className={`badge ${item.nest_type === 'Linear' ? 'badge-1d' : item.nest_type === 'Panel' ? 'badge-2d' : ''}`}>
                          {item.nest_type || '—'}
                        </span>
                      </td>
                      <td>{item.form_type_name}</td>
                      <td>{item.material_name}</td>
                      <td>{item.spec_name}</td>
                      <td>{item.material_type_name}</td>
                      <td className="num">{item.quantity}</td>
                      <td className="num">{item.length_nest ? inToFt(item.length_nest) : '—'}</td>
                      <td className="num">{item.width_nest && parseFloat(item.width_nest) > 0 ? inToFt(item.width_nest) : '—'}</td>
                      <td className="num">{item.weight_per_ft ? `${parseFloat(item.weight_per_ft).toFixed(2)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Saved Nesting Run Banner */}
            {savedRunInfo && results && (
              <div className="save-status save-success" style={{ margin: '12px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  Previous nesting run found — Run #{savedRunInfo.run_number} ({savedRunInfo.run_date}) — {results.summary?.total_stock_pieces || 0} stock pieces — Status: {savedRunInfo.run_status}
                </span>
                <button onClick={() => setStep(3)} className="btn btn-primary btn-small" style={{ marginLeft: 12 }}>
                  View Saved Results →
                </button>
              </div>
            )}
            <div className="card-footer">
              <span className="count">{selected.size} items selected</span>
              <div className="btn-group">
                <button onClick={fetchSavedPurchaseList} className="btn btn-secondary" disabled={loadingSavedPurchase}>
                  {loadingSavedPurchase ? 'Loading...' : 'View Saved Purchase List'}
                </button>
                <button onClick={() => setStep(2)} className="btn btn-primary" disabled={selected.size === 0}>
                  Next → Configure
                </button>
              </div>
            </div>

            {/* Saved Purchase List Display */}
            {showSavedPurchase && (
              <div className="result-section" style={{ marginTop: 16 }}>
                <div className="card-header">
                  <h3>Saved Purchase List ({savedPurchaseLines.length} items)</h3>
                  <button onClick={() => setShowSavedPurchase(false)} className="btn btn-small">Close</button>
                </div>
                {savedPurchaseLines.length === 0 ? (
                  <p className="hint">No purchase list saved for this project yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>#</th><th>Description</th><th>Form Type</th><th>Material</th>
                          <th>Spec</th><th>Qty</th><th>Feet</th><th>Wt/Ft</th>
                          <th>Unit Wt</th><th>Total Wt</th><th>Price/LB</th><th>Unit Price</th><th>Unit Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {savedPurchaseLines.map((line, i) => (
                          <tr key={i}>
                            <td className="num">{line.line_item}</td>
                            <td>{line.item_description || line.description}</td>
                            <td>{line.form_type_name}</td>
                            <td>{line.material_name}</td>
                            <td>{line.spec_name}</td>
                            <td className="num">{line.quantity}</td>
                            <td className="num">{line.feet_length}</td>
                            <td className="num">{line.weight_per_ft > 0 ? line.weight_per_ft.toFixed(2) : '—'}</td>
                            <td className="num">{line.unit_weight > 0 ? fmtLbs(line.unit_weight) : '—'}</td>
                            <td className="num">{line.total_weight > 0 ? fmtLbs(line.total_weight) : '—'}</td>
                            <td className="num">{line.price_per_lb > 0 ? `$${line.price_per_lb.toFixed(2)}` : '—'}</td>
                            <td className="num">{line.unit_price > 0 ? `$${line.unit_price.toFixed(2)}` : '—'}</td>
                            <td className="num">{line.unit_total > 0 ? `$${line.unit_total.toFixed(2)}` : '—'}</td>
                          </tr>
                        ))}
                        <tr className="purchase-total-row">
                          <td></td>
                          <td><strong>Total</strong></td>
                          <td></td><td></td><td></td>
                          <td className="num"><strong>{savedPurchaseLines.reduce((s, l) => s + l.quantity, 0)}</strong></td>
                          <td></td><td></td><td></td>
                          <td className="num"><strong>{fmtLbs(savedPurchaseLines.reduce((s, l) => s + l.total_weight, 0))}</strong></td>
                          <td></td><td></td>
                          <td className="num"><strong>${savedPurchaseLines.reduce((s, l) => s + l.unit_total, 0).toFixed(2)}</strong></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Configure */}
        {step === 2 && (
          <div className="card">
            <h2>Nesting Configuration</h2>
            <div className="config-grid">
              <div className="config-section">
                <h3>Kerf Settings</h3>
                <div className="field">
                  <label>1D Kerf (inches)</label>
                  <input type="number" step="0.0625" value={kerf1D} onChange={e => setKerf1D(parseFloat(e.target.value) || 0)} className="input" />
                </div>
                <div className="field">
                  <label>2D Kerf (inches)</label>
                  <input type="number" step="0.0625" value={kerf2D} onChange={e => setKerf2D(parseFloat(e.target.value) || 0)} className="input" />
                </div>
              </div>
              <div className="config-section">
                <h3>Grain Direction (2D Panels)</h3>
                {bom.filter(b => selected.has(b.id) && b.nest_type === 'Panel').map(item => (
                  <div key={item.id} className="field">
                    <label>
                      Mark {item.bom_item} — {item.form_type_name} | {item.material_type_name} | {item.material_name} | {parseFloat(item.length_nest)}" × {parseFloat(item.width_nest)}"
                    </label>
                    <select
                      value={grainDirections[item.id] || 'none'}
                      onChange={e => setGrainDirections(prev => ({ ...prev, [item.id]: e.target.value }))}
                      className="input"
                    >
                      <option value="none">None (allow rotation)</option>
                      <option value="length">Length</option>
                      <option value="width">Width</option>
                    </select>
                  </div>
                ))}
                {bom.filter(b => selected.has(b.id) && b.nest_type === 'Panel').length === 0 && (
                  <p className="hint">No 2D panels selected</p>
                )}
              </div>

              <div className="config-section config-full">
                <div className="stock-header">
                  <h3>Stock Sizes</h3>
                  <div className="stock-controls">
                    <div className="btn-group">
                      <button onClick={enableAllStock} className="btn btn-small">Use All</button>
                      <button onClick={disableAllStock} className="btn btn-small">Use None</button>
                    </div>
                    <div className="filter-tabs">
                      {[
                        ['all', 'All', matchedStock.length],
                        ['library', 'Library', matchedStock.filter(s => s.source === 'library').length],
                        ['custom', 'Custom', matchedStock.filter(s => s.source === 'custom').length],
                      ].map(([k, l, n]) => (
                        <button key={k} className={`filter-btn ${stockFilter === k ? 'active' : ''}`} onClick={() => setStockFilter(k)}>
                          {l} ({n})
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="hint">
                  <strong>{activeStockCount}</strong> of {matchedStock.length} stock sizes enabled for nesting. Unchecked sizes will be excluded.
                </p>
                <table className="stock-table">
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>Use</th><th>Source</th><th>Form Type</th>
                      <th>Material</th><th>Description</th><th>Length</th><th>Width</th><th>Standard</th>
                      <th style={{ width: 90 }}>Qty</th><th>Reference</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {getFilteredStock().map(s => (
                      <tr key={s.id} className={`${s.source === 'custom' ? 'stock-row-custom' : ''} ${!enabledStock.has(s.id) ? 'stock-disabled' : ''}`}>
                        <td><input type="checkbox" checked={enabledStock.has(s.id)} onChange={() => toggleStock(s.id)} /></td>
                        <td>
                          <span className={`badge ${s.source === 'library' ? 'badge-lib' : 'badge-custom'}`}>
                            {s.source === 'library' ? 'Library' : 'Custom'}
                          </span>
                        </td>
                        <td>{s.form_type_name || s.form_type}</td>
                        <td>{s.material_type_name || s.material_type}</td>
                        <td>{s.material_name || <span style={{ color: '#bbb' }}>—</span>}</td>
                        <td className="num">{inToFt(s.stock_length)}</td>
                        <td className="num">{s.stock_width && parseFloat(s.stock_width) > 0 ? inToFt(s.stock_width) : '—'}</td>
                        <td>{s.is_standard}</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={s.quantity ?? ''}
                            onChange={e => setStockQuantity(s.id, e.target.value)}
                            placeholder="—"
                            style={{ width: 70, padding: '2px 4px', fontFamily: "'IBM Plex Mono', monospace" }}
                          />
                        </td>
                        <td>{s.reference || <span style={{ color: '#bbb' }}>—</span>}</td>
                        <td>
                          {s.source === 'custom' && (
                            <button onClick={() => removeCustomStock(s.id)} className="btn btn-small btn-danger">Remove</button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {getFilteredStock().length === 0 && (
                      <tr><td colSpan={11} style={{ textAlign: 'center', color: '#999', padding: 16 }}>No stock items</td></tr>
                    )}
                  </tbody>
                </table>
                {(() => {
                  // Detect if the picked Form Type is panel or linear by matching against selectedBom rows
                  const matchingPart = selectedBom.find(b => b.form_type_name === newStock.form_type);
                  const isPanel = matchingPart?.nest_type === 'Panel';
                  const isLinear = matchingPart?.nest_type === 'Linear';
                  const qtyOk = parseInt(newStock.quantity) >= 1;
                  const widthOk = !isPanel || (newStock.stock_width && parseFloat(newStock.stock_width) > 0);
                  const canAdd = !!(newStock.form_type && newStock.material_type && newStock.stock_length && qtyOk && widthOk);
                  return (
                <div className="add-stock-row">
                  <div className="mini-field">
                    <label>Form Type <span style={{ color: '#d32f2f' }}>*</span></label>
                    <select value={newStock.form_type} onChange={e => setNewStock(p => ({ ...p, form_type: e.target.value }))}>
                      <option value="">Select...</option>
                      {formTypes.map(ft => <option key={ft} value={ft}>{ft}</option>)}
                    </select>
                  </div>
                  <div className="mini-field">
                    <label>Material <span style={{ color: '#d32f2f' }}>*</span></label>
                    <select value={newStock.material_type} onChange={e => setNewStock(p => ({ ...p, material_type: e.target.value, material_name: '' }))}>
                      <option value="">Select...</option>
                      {matTypes.map(mt => <option key={mt} value={mt}>{mt}</option>)}
                    </select>
                  </div>
                  <div className="mini-field">
                    <label>Description (opt.)</label>
                    {(() => {
                      const matchingMats = [...new Set(
                        selectedBom
                          .filter(b => (!newStock.form_type || b.form_type_name === newStock.form_type)
                            && (!newStock.material_type || b.material_type_name === newStock.material_type))
                          .map(b => b.material_name)
                          .filter(Boolean)
                      )];
                      return (
                        <select value={newStock.material_name} onChange={e => setNewStock(p => ({ ...p, material_name: e.target.value }))}>
                          <option value="">Any</option>
                          {matchingMats.map(mn => <option key={mn} value={mn}>{mn}</option>)}
                        </select>
                      );
                    })()}
                  </div>
                  <div className="mini-field">
                    <label>Length (in) <span style={{ color: '#d32f2f' }}>*</span></label>
                    <input type="number" step="0.25" value={newStock.stock_length} onChange={e => setNewStock(p => ({ ...p, stock_length: e.target.value }))} placeholder="240" />
                  </div>
                  <div className="mini-field">
                    <label>
                      Width (in)
                      {isPanel && <span style={{ color: '#d32f2f' }}> *</span>}
                      {isLinear && <span style={{ color: '#999', fontSize: 10 }}> (linear — N/A)</span>}
                    </label>
                    <input
                      type="number"
                      step="0.25"
                      value={isLinear ? '' : newStock.stock_width}
                      onChange={e => setNewStock(p => ({ ...p, stock_width: e.target.value }))}
                      placeholder={isPanel ? 'Required' : (isLinear ? '—' : 'Pick form type first')}
                      disabled={isLinear}
                      style={isLinear ? { background: '#f5f6f8', cursor: 'not-allowed' } : {}}
                    />
                  </div>
                  <div className="mini-field">
                    <label>Qty <span style={{ color: '#d32f2f' }}>*</span></label>
                    <input type="number" min="1" step="1" value={newStock.quantity} onChange={e => setNewStock(p => ({ ...p, quantity: e.target.value }))} placeholder="1" />
                  </div>
                  <div className="mini-field">
                    <label>Reference (opt.)</label>
                    <input type="text" value={newStock.reference} onChange={e => setNewStock(p => ({ ...p, reference: e.target.value }))} placeholder="Heat # / bin / job" />
                  </div>
                  <button onClick={addCustomStock} className="btn btn-add" disabled={!canAdd}>
                    + Add Stock
                  </button>
                </div>
                  );
                })()}
              </div>
            </div>
            <div className="card-footer">
              <button onClick={() => setStep(1)} className="btn">← Back</button>
              <div className="btn-group" style={{ alignItems: 'center' }}>
                <span className="count">{activeStockCount} stock sizes active</span>
                <button onClick={runNesting} className="btn btn-primary" disabled={loading || activeStockCount === 0}>
                  {loading ? 'Running...' : 'Run Nesting'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Results */}
        {step === 3 && results && (
          <div className="card">
            <div className="card-header">
              <h2>Nesting Results</h2>
              <div className="btn-group">
                <button onClick={selectAllPatterns} className="btn btn-small">Select All Patterns</button>
                <button onClick={clearAllPatterns} className="btn btn-small">Clear Selection</button>
                <button onClick={() => window.print()} className="btn btn-small btn-print">Print</button>
              </div>
            </div>
            {savedRunInfo && (
              <div className="save-status save-success" style={{ marginBottom: 12 }}>
                Viewing saved nesting run #{savedRunInfo.run_number}
                {savedRunInfo.run_title ? ` — "${savedRunInfo.run_title}"` : ''}
                {' — '}{savedRunInfo.run_date}
                {savedRunInfo.created_by ? ` — saved by ${emailLocalPart(savedRunInfo.created_by)}` : ''}
                {' — Status: '}{savedRunInfo.run_status}
              </div>
            )}
            {results.summary && (
              <div className="summary-bar">
                <div className="summary-item">
                  <span className="summary-val">{results.summary.total_stock_pieces}</span>
                  <span className="summary-label">Stock Pieces</span>
                </div>
                <div className="summary-item">
                  <span className="summary-val">{results.summary.avg_waste_pct_1d?.toFixed(1)}%</span>
                  <span className="summary-label">Avg Waste (1D)</span>
                </div>
                {weightSummary && (
                  <>
                    <div className="summary-item">
                      <span className="summary-val">{weightSummary.totalStock.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span className="summary-label">Total Stock (lbs)</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-val">{weightSummary.totalAllocated.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span className="summary-label">Allocated (lbs)</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-val">{weightSummary.totalWaste.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                      <span className="summary-label">Waste (lbs)</span>
                    </div>
                  </>
                )}
                {results.summary.errors?.length > 0 && (
                  <div className="summary-item summary-error">
                    <span className="summary-val">{results.summary.errors.length}</span>
                    <span className="summary-label">Errors</span>
                  </div>
                )}
                <div className="summary-item">
                  <span className="summary-val" style={{ color: selectedPatternCount > 0 ? 'var(--green)' : 'var(--gray-400)' }}>
                    {selectedPatternCount}
                  </span>
                  <span className="summary-label">Patterns Selected</span>
                </div>
              </div>
            )}

            {stockShortages.length > 0 && (
              <div className="stock-shortage-banner" style={{
                background: '#fdecea', border: '1px solid #d32f2f', borderRadius: 4,
                padding: '10px 14px', marginBottom: 12, color: '#b71c1c',
                fontFamily: "'IBM Plex Mono', monospace", fontSize: 13
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: 6 }}>
                  ⚠ Insufficient on-hand stock for {stockShortages.length} size{stockShortages.length > 1 ? 's' : ''}:
                </div>
                {stockShortages.map(s => (
                  <div key={s.id} style={{ marginLeft: 18 }}>
                    {s.form_type_name} | {s.material_type_name} | {inToFt(s.stock_length)}
                    {s.stock_width && parseFloat(s.stock_width) > 0 ? ` × ${inToFt(s.stock_width)}` : ''}
                    {' — need '}<strong>{s.used}</strong>, have <strong>{s.qty}</strong>, short <strong>{s.short}</strong>
                  </div>
                ))}
              </div>
            )}

            {/* 1D Results */}
            {results.results_1d?.length > 0 && (
              <div className="result-section">
                <h3>1D — Linear Results</h3>
                {groupResults(results.results_1d, results._nameLookup).map((group, gi) => {
                  const groupWeightPerFt = (() => {
                    const firstResult = group.patterns[0]?.representative;
                    if (!firstResult?.cuts?.[0]) return 0;
                    return weightMap[String(firstResult.cuts[0].bom_line_id)] || 0;
                  })();
                  const groupTotalPieces = group.patterns.reduce((sum, p) => sum + p.count, 0);
                  const groupUnitWeight = calcUnitWeight(groupWeightPerFt, group.stock_length_in, 0);
                  const groupTotalWeight = groupUnitWeight * groupTotalPieces;
                  return (
                    <div key={gi} className="material-group">
                      <div className="material-group-header">
                        <h4>
                          {matDesc(group)} | {inToFt(group.stock_length_in)} — {groupTotalPieces} stock pieces
                          {groupWeightPerFt > 0 && (
                            <span className="group-weight"> — {fmtLbs(groupUnitWeight)}/pc — {fmtLbs(groupTotalWeight)} total</span>
                          )}
                        </h4>
                      </div>
                      {group.patterns.map((pattern, pi) => {
                        const r = pattern.representative;
                        const patternKey = `1d-${gi}-${pi}`;
                        const isPatternSelected = selectedPatterns.has(patternKey);
                        const patternWpf = getStockWeightPerFt(r, weightMap);
                        const patternStockWeight = calcUnitWeight(patternWpf, r.stock_length_in, 0);
                        const patternCutWeight = r.cuts?.reduce((sum, c) => sum + (patternWpf * (c.cut_length / 12) * (c.quantity_on_this_stock || 1)), 0) || 0;
                        const patternWasteWeight = patternStockWeight - patternCutWeight;
                        return (
                          <div key={pi} className={`stock-result ${isPatternSelected ? 'pattern-selected' : 'pattern-deselected'}`}>
                            <div className="stock-result-header">
                              <div className="pattern-select-row">
                                <input
                                  type="checkbox"
                                  checked={isPatternSelected}
                                  onChange={() => togglePattern(patternKey)}
                                  className="pattern-checkbox"
                                />
                                <span className="stock-label">
                                  Cut Pattern {pi + 1} — {matDesc(group)} | {inToFt(r.stock_length_in)}
                                  {(() => {
                                    const src = stock.find(x => String(x.id) === String(r.stock_id));
                                    return src?.reference ? <span className="stock-ref-badge" style={{ marginLeft: 8, padding: '1px 6px', background: '#e8f0fb', color: '#2c5aa0', borderRadius: 3, fontSize: 11 }}>Ref: {src.reference}</span> : null;
                                  })()}
                                  {pattern.count > 1 && <span className="pattern-count-badge">×{pattern.count} identical</span>}
                                  {(() => {
                                    const totalUsed = r.cuts?.reduce((sum, c) => sum + c.cut_length + kerf1D, 0) || 0;
                                    const shorterStocks = matchedStock
                                      .filter(s => s.form_type === r.form_type && s.material_type === r.material_origin && parseFloat(s.stock_length) < r.stock_length_in)
                                      .map(s => parseFloat(s.stock_length))
                                      .sort((a, b) => b - a);
                                    const nextShorter = shorterStocks[0];
                                    const warnings = [];
                                    if (nextShorter && totalUsed > nextShorter && totalUsed <= nextShorter + 1) {
                                      warnings.push(`Within 1" of ${inToFt(nextShorter)} stock — confirm kerf, shorter stock may work`);
                                    }
                                    if (r.remnant_length_in >= 0 && r.remnant_length_in <= 1 && r.cuts?.length > 0) {
                                      warnings.push('Tight fit on current stock — verify kerf allowance');
                                    }
                                    return warnings.map((w, wi) => <span key={wi} style={{ color: '#d32f2f', fontSize: '11px', marginLeft: '8px', display: 'inline-block' }}>⚠ {w}</span>);
                                  })()}
                                </span>
                              </div>
                              <div className="result-badges">
                                <span className="waste-badge">{r.waste_percentage?.toFixed(1)}% waste</span>
                                {patternWpf > 0 && (
                                  <span className="weight-badge">
                                    {fmtLbs(patternStockWeight)} stock — {fmtLbs(patternWasteWeight)} waste
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="bar-visual">
                              {r.cuts?.flatMap((cut, j) =>
                                Array.from({ length: cut.quantity_on_this_stock || 1 }, (_, k) => (
                                  <div
                                    key={`${j}-${k}`}
                                    className="bar-cut"
                                    style={{ width: `${(cut.cut_length / r.stock_length_in) * 100}%` }}
                                    title={`${cut.part_mark}: ${cut.cut_length}" — ${fmtLbs(patternWpf * (cut.cut_length / 12))}`}
                                  >
                                    <span>{cut.part_mark} ({cut.cut_length}")</span>
                                  </div>
                                ))
                              )}
                              {r.remnant_length_in > 0 && (
                                <div className="bar-remnant" style={{ width: `${(r.remnant_length_in / r.stock_length_in) * 100}%` }}>
                                  <span>{r.remnant_length_in.toFixed(1)}"</span>
                                </div>
                              )}
                            </div>
                            <table className="cut-table">
                              <thead>
                                <tr><th>Mark</th><th>Length</th><th>Qty on Stock</th><th>Total Qty</th><th>Cut Weight</th></tr>
                              </thead>
                              <tbody>
                                {r.cuts?.map((cut, j) => {
                                  const bomItem = bom.find(b => String(b.id) === String(cut.bom_line_id));
                                  const cutWt = patternWpf * (cut.cut_length / 12);
                                  return (
                                    <tr key={j}>
                                      <td className="mono">{cut.part_mark}</td>
                                      <td className="num">{cut.cut_length}"</td>
                                      <td className="num">{cut.quantity_on_this_stock}</td>
                                      <td className="num">{bomItem?.quantity || '—'}</td>
                                      <td className="num">{patternWpf > 0 ? fmtLbs(cutWt) : '—'}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 2D Results */}
            {results.results_2d?.length > 0 && (
              <div className="result-section">
                <h3>2D — Panel Results</h3>
                {groupResults(results.results_2d, results._nameLookup).map((group, gi) => {
                  const groupWeightPerFt = (() => {
                    const firstResult = group.patterns[0]?.representative;
                    if (!firstResult?.cuts?.[0]) return 0;
                    return weightMap[String(firstResult.cuts[0].bom_line_id)] || 0;
                  })();
                  const groupTotalPieces = group.patterns.reduce((sum, p) => sum + p.count, 0);
                  const groupUnitWeight = calcUnitWeight(groupWeightPerFt, group.stock_length_in, group.stock_width_in);
                  const groupTotalWeight = groupUnitWeight * groupTotalPieces;
                  return (
                    <div key={gi} className="material-group">
                      <div className="material-group-header">
                        <h4>
                          {matDesc(group)} | {inToFt(group.stock_length_in)} × {inToFt(group.stock_width_in)} — {groupTotalPieces} stock pieces
                          {groupWeightPerFt > 0 && (
                            <span className="group-weight"> — {fmtLbs(groupUnitWeight)}/pc — {fmtLbs(groupTotalWeight)} total</span>
                          )}
                        </h4>
                      </div>
                      {group.patterns.map((pattern, pi) => {
                        const r = pattern.representative;
                        const patternKey = `2d-${gi}-${pi}`;
                        const isPatternSelected = selectedPatterns.has(patternKey);
                        const patternWpf = getStockWeightPerFt(r, weightMap);
                        const patternStockWeight = calcUnitWeight(patternWpf, r.stock_length_in, r.stock_width_in);
                        const patternCutWeight = r.cuts?.reduce((sum, c) => sum + (patternWpf * (c.cut_length * c.cut_width / 144) * (c.quantity_on_this_stock || 1)), 0) || 0;
                        const patternWasteWeight = patternStockWeight - patternCutWeight;
                        return (
                          <div key={pi} className={`stock-result ${isPatternSelected ? 'pattern-selected' : 'pattern-deselected'}`}>
                            <div className="stock-result-header">
                              <div className="pattern-select-row">
                                <input
                                  type="checkbox"
                                  checked={isPatternSelected}
                                  onChange={() => togglePattern(patternKey)}
                                  className="pattern-checkbox"
                                />
                                <span className="stock-label">
                                  Cut Pattern {pi + 1} — {matDesc(group)} | {inToFt(r.stock_length_in)} × {inToFt(r.stock_width_in)}
                                  {(() => {
                                    const src = stock.find(x => String(x.id) === String(r.stock_id));
                                    return src?.reference ? <span className="stock-ref-badge" style={{ marginLeft: 8, padding: '1px 6px', background: '#e8f0fb', color: '#2c5aa0', borderRadius: 3, fontSize: 11 }}>Ref: {src.reference}</span> : null;
                                  })()}
                                  {pattern.count > 1 && <span className="pattern-count-badge">×{pattern.count} identical</span>}
                                  {(() => {
                                    const warnings = [];
                                    const maxCutX = Math.max(...(r.cuts?.map(c => c.x_position + c.cut_length + kerf2D) || [0]));
                                    const maxCutY = Math.max(...(r.cuts?.map(c => c.y_position + c.cut_width + kerf2D) || [0]));
                                    const smallerPanels = matchedStock
                                      .filter(s => s.form_type === r.form_type && s.material_type === r.material_origin && parseFloat(s.stock_width) > 0 && (parseFloat(s.stock_length) * parseFloat(s.stock_width)) < (r.stock_length_in * r.stock_width_in))
                                      .map(s => ({ l: parseFloat(s.stock_length), w: parseFloat(s.stock_width) }))
                                      .sort((a, b) => (b.l * b.w) - (a.l * a.w));
                                    const nextSmaller = smallerPanels[0];
                                    if (nextSmaller) {
                                      const fitsNormal = maxCutX <= nextSmaller.l + 1 && maxCutY <= nextSmaller.w + 1;
                                      const fitsRotated = maxCutX <= nextSmaller.w + 1 && maxCutY <= nextSmaller.l + 1;
                                      if (fitsNormal || fitsRotated) {
                                        warnings.push(`Within 1" of ${inToFt(nextSmaller.l)} × ${inToFt(nextSmaller.w)} stock — confirm kerf, smaller panel may work`);
                                      }
                                    }
                                    if (r.waste_percentage >= 0 && r.waste_percentage <= 3 && r.cuts?.length > 0) {
                                      warnings.push('Tight fit on current panel — verify kerf allowance');
                                    }
                                    return warnings.map((w, wi) => <span key={wi} style={{ color: '#d32f2f', fontSize: '11px', marginLeft: '8px', display: 'inline-block' }}>⚠ {w}</span>);
                                  })()}
                                </span>
                              </div>
                              <div className="result-badges">
                                <span className="waste-badge">{r.waste_percentage?.toFixed(1)}% waste</span>
                                {patternWpf > 0 && (
                                  <span className="weight-badge">
                                    {fmtLbs(patternStockWeight)} stock — {fmtLbs(patternWasteWeight)} waste
                                  </span>
                                )}
                              </div>
                            </div>
                            <PanelVisualization result={r} kerf2D={kerf2D} />
                            <table className="cut-table">
                              <thead>
                                <tr><th>Mark</th><th>Length</th><th>Width</th><th>Qty on Stock</th><th>Total Qty</th><th>Cut Weight</th></tr>
                              </thead>
                              <tbody>
                                {r.cuts?.map((cut, j) => {
                                  const bomItem = bom.find(b => String(b.id) === String(cut.bom_line_id));
                                  const cutWt = patternWpf * (cut.cut_length * cut.cut_width / 144);
                                  return (
                                    <tr key={j}>
                                      <td className="mono">{cut.part_mark}</td>
                                      <td className="num">{cut.cut_length}"</td>
                                      <td className="num">{cut.cut_width}"</td>
                                      <td className="num">{cut.quantity_on_this_stock}</td>
                                      <td className="num">{bomItem?.quantity || '—'}</td>
                                      <td className="num">{patternWpf > 0 ? fmtLbs(cutWt) : '—'}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Enhanced Errors */}
            {results.summary?.errors?.length > 0 && (
              <div className="result-section">
                <h3>Errors</h3>
                {results.summary.errors.map((e, i) => {
                  const analysis = analyzeError(
                    e,
                    results._nameLookup,
                    lastNestPayload?.parts_1d,
                    lastNestPayload?.parts_2d,
                    lastNestPayload?.stock_2d,
                    lastNestPayload?.stock_1d
                  );
                  return (
                    <div key={i} className="error-box error-enhanced">
                      <div className="error-title">{analysis.message}</div>
                      {analysis.details && (
                        <div className="error-details">
                          <p className="error-dimension">{analysis.details.dimensionNote}</p>
                          {analysis.details.availableSizes.length > 0 && (
                            <p className="error-stock-info">
                              Available stock sizes: {analysis.details.availableSizes.join(', ')}
                            </p>
                          )}
                          <div className="error-suggestions">
                            <strong>To resolve:</strong>
                            <ol>
                              {analysis.details.suggestions.map((s, si) => (
                                <li key={si}>{s}</li>
                              ))}
                            </ol>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Purchase List Preview */}
            {showPurchasePreview && purchaseLines.length > 0 && (
              <div className="result-section">
                <h3>Purchase List Preview</h3>
                <p className="hint">Review the aggregated purchase lines below before saving to the project.</p>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Description</th><th>Qty</th><th>Length (ft)</th><th>Wt/Ft</th><th>Unit Weight</th><th>Total Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseLines.map((line, i) => (
                      <tr key={i}>
                        <td>{line.description}</td>
                        <td className="num">{line.quantity}</td>
                        <td className="num">{line.feet_length.toFixed(1)}</td>
                        <td className="num">{line.weight_per_ft > 0 ? `${line.weight_per_ft.toFixed(2)}` : '—'}</td>
                        <td className="num">{line.unit_weight > 0 ? fmtLbs(line.unit_weight) : '—'}</td>
                        <td className="num">{line.total_weight > 0 ? fmtLbs(line.total_weight) : '—'}</td>
                      </tr>
                    ))}
                    <tr className="purchase-total-row">
                      <td><strong>Total</strong></td>
                      <td className="num"><strong>{purchaseLines.reduce((s, l) => s + l.quantity, 0)}</strong></td>
                      <td></td><td></td><td></td>
                      <td className="num"><strong>{fmtLbs(purchaseLines.reduce((s, l) => s + l.total_weight, 0))}</strong></td>
                    </tr>
                  </tbody>
                </table>
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button onClick={savePurchaseList} className="btn btn-primary" disabled={savingPurchase}>
                    {savingPurchase ? 'Saving...' : 'Save Purchase List to Project'}
                  </button>
                  <button onClick={() => setShowPurchasePreview(false)} className="btn">Cancel</button>
                </div>
                {purchaseStatus && (
                  <div className={`save-status ${purchaseStatus.startsWith('Error') ? 'save-error' : 'save-success'}`} style={{ marginTop: 8 }}>
                    {purchaseStatus}
                  </div>
                )}
              </div>
            )}

            {/* Saved Purchase List in Results view */}
            {showSavedPurchase && savedPurchaseLines.length > 0 && (
              <div className="result-section">
                <div className="card-header">
                  <h3>Saved Purchase List ({savedPurchaseLines.length} items)</h3>
                  <button onClick={() => setShowSavedPurchase(false)} className="btn btn-small">Close</button>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th><th>Description</th><th>Qty</th><th>Feet</th>
                        <th>Unit Wt</th><th>Total Wt</th><th>Price/LB</th><th>Unit Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {savedPurchaseLines.map((line, i) => (
                        <tr key={i}>
                          <td className="num">{line.line_item}</td>
                          <td>{line.item_description || line.description}</td>
                          <td className="num">{line.quantity}</td>
                          <td className="num">{line.feet_length}</td>
                          <td className="num">{line.unit_weight > 0 ? fmtLbs(line.unit_weight) : '—'}</td>
                          <td className="num">{line.total_weight > 0 ? fmtLbs(line.total_weight) : '—'}</td>
                          <td className="num">{line.price_per_lb > 0 ? `$${line.price_per_lb.toFixed(2)}` : '—'}</td>
                          <td className="num">{line.unit_total > 0 ? `$${line.unit_total.toFixed(2)}` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="card-footer">
              <button onClick={() => setStep(2)} className="btn">← Reconfigure</button>
              <div className="btn-group" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                {isStandalone && runTitle && (
                  <span style={{ fontSize: 12, color: '#666' }}>
                    Title: <strong>{runTitle}</strong>
                  </span>
                )}
                <span className="count">{selectedPatternCount} pattern{selectedPatternCount !== 1 ? 's' : ''} selected</span>
                <button onClick={saveToZoho} className="btn btn-primary" disabled={saving || selectedPatternCount === 0}>
                  {saving ? 'Saving...' : `${isStandalone ? 'Save' : 'Import'} ${selectedPatternCount} Pattern${selectedPatternCount !== 1 ? 's' : ''}${isStandalone ? '' : ' to Project'}`}
                </button>
                {!isStandalone && (
                  <>
                    <button
                      onClick={() => { setShowPurchasePreview(true); setPurchaseStatus(''); }}
                      className="btn btn-secondary"
                      disabled={selectedPatternCount === 0}
                    >
                      Generate Purchase List
                    </button>
                    <button onClick={fetchSavedPurchaseList} className="btn btn-small" disabled={loadingSavedPurchase}>
                      {loadingSavedPurchase ? 'Loading...' : 'View Saved'}
                    </button>
                  </>
                )}
              </div>
            </div>
            {saveStatus && (
              <div className={`save-status ${saveStatus.startsWith('Error') ? 'save-error' : 'save-success'}`}>
                {saveStatus}
              </div>
            )}
          </div>
        )}
      </main>
      <footer className="footer"><span>Material Compass Nesting v1.0</span></footer>
    </div>
  );
}
