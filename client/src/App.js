import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

const API = '';

function getProjectIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('project_id') || params.get('id') || '';
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
    // 2D plate: weight per sq ft × area in sq ft
    return wpf * (l * w / 144);
  }
  // 1D linear: weight per ft × length in ft
  return wpf * (l / 12);
}

function groupResults(results, nameLookup) {
  if (!results || results.length === 0) return [];
  const materialGroups = {};
  for (const r of results) {
    if (r.error) continue; // skip error results from grouped display
    const key = `${r.form_type}|${r.material_origin}|${r.stock_length_in}|${r.stock_width_in || 0}`;
    if (!materialGroups[key]) {
      materialGroups[key] = {
        form_type: r.form_type,
        material_origin: r.material_origin,
        stock_length_in: r.stock_length_in,
        stock_width_in: r.stock_width_in,
        form_type_name: (nameLookup && nameLookup[r.form_type]) || r.form_type,
        material_type_name: (nameLookup && nameLookup[r.material_origin]) || r.material_origin,
        spec_name: (nameLookup && r.cuts?.[0] && nameLookup[r.cuts[0].spec_name]) || '',
        material_name: (nameLookup && r.cuts?.[0] && nameLookup[r.cuts[0].material_type]) || '',
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

/** Replace Zoho IDs in error messages with display names */
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

/** Enhanced error analysis — parses "too large" errors and adds stock dimension context */
function analyzeError(errorMsg, nameLookup, parts1D, parts2D, stock2D, stock1D) {
  const resolved = resolveErrorNames(errorMsg, nameLookup);

  // Try to parse "Part X (WxH") too large for any stock in TYPE | MATERIAL"
  const tooLargeMatch = resolved.match(/Part\s+(\S+)\s+\(([^)]+)\)\s+too large for any stock in\s+(.+)/i);
  if (!tooLargeMatch) {
    return { message: resolved, details: null };
  }

  const partMark = tooLargeMatch[1];
  const partDims = tooLargeMatch[2];
  const stockCategory = tooLargeMatch[3].replace(/\.$/, '');

  // Parse part dimensions
  const dimMatch = partDims.match(/([\d.]+)[x×]([\d.]+)/);
  const lenMatch = partDims.match(/([\d.]+)"/);

  // Find the actual part from the request data
  const allParts = [...(parts1D || []), ...(parts2D || [])];
  const part = allParts.find(p => String(p.part_mark || p.bom_item) === String(partMark));

  if (dimMatch) {
    // 2D part
    const partLength = parseFloat(dimMatch[1]);
    const partWidth = parseFloat(dimMatch[2]);

    // Find matching stock for this category
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
    // 1D part
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

/** 2D Panel Visualization Component — replaces broken SVG from nesting API */
function PanelVisualization({ result, kerf2D }) {
  const stockL = result.stock_length_in || 0;
  const stockW = result.stock_width_in || 0;
  const cuts = result.cuts || [];

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
  partMarks.forEach((mark, i) => {
    colorMap[mark] = colors[i % colors.length];
  });

  return (
    <div className="panel-viz-wrap">
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="panel-viz-svg"
      >
        <g transform={`translate(${marginLeft}, ${marginTop})`}>
          {/* Stock outline */}
          <rect
            x={0} y={0}
            width={drawW} height={drawH}
            fill="#f5f5f5" stroke="#999" strokeWidth={1}
          />
          {/* Grid lines every 12 inches */}
          {Array.from({ length: Math.floor(stockL / 12) }, (_, i) => (
            <line
              key={`vg-${i}`}
              x1={(i + 1) * 12 * scale} y1={0}
              x2={(i + 1) * 12 * scale} y2={drawH}
              stroke="#e0e0e0" strokeWidth={0.5}
            />
          ))}
          {Array.from({ length: Math.floor(stockW / 12) }, (_, i) => (
            <line
              key={`hg-${i}`}
              x1={0} y1={(i + 1) * 12 * scale}
              x2={drawW} y2={(i + 1) * 12 * scale}
              stroke="#e0e0e0" strokeWidth={0.5}
            />
          ))}
          {/* Cut pieces */}
          {cuts.map((cut, i) => {
            const x = (parseFloat(cut.x_position) || 0) * scale;
            const y = (parseFloat(cut.y_position) || 0) * scale;
            // FIX: coerce rotation to number — API may return string "90"
            const rotation = parseInt(cut.rotation) || 0;
            const cutW = rotation === 90 ? (cut.cut_width * scale) : (cut.cut_length * scale);
            const cutH = rotation === 90 ? (cut.cut_length * scale) : (cut.cut_width * scale);
            const color = colorMap[cut.part_mark] || '#4A90D9';
            // Clamp to stock boundaries
            const clampedW = Math.min(cutW, drawW - x);
            const clampedH = Math.min(cutH, drawH - y);

            return (
              <g key={i}>
                <rect
                  x={x} y={y}
                  width={clampedW} height={clampedH}
                  fill={color} fillOpacity={0.75}
                  stroke="white" strokeWidth={1}
                />
                {clampedW > 28 && clampedH > 14 && (
                  <text
                    x={x + clampedW / 2}
                    y={y + clampedH / 2 - (clampedH > 28 ? 5 : 0)}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="white"
                    fontSize={Math.min(12, Math.min(clampedW * 0.3, clampedH * 0.4))}
                    fontWeight="bold"
                    fontFamily="'IBM Plex Mono', monospace"
                  >
                    {cut.part_mark}
                  </text>
                )}
                {clampedW > 50 && clampedH > 28 && (
                  <text
                    x={x + clampedW / 2}
                    y={y + clampedH / 2 + 8}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="rgba(255,255,255,0.85)"
                    fontSize={Math.min(9, Math.min(clampedW * 0.2, clampedH * 0.25))}
                    fontFamily="'IBM Plex Mono', monospace"
                  >
                    {cut.cut_length}"×{cut.cut_width}"
                  </text>
                )}
                {rotation === 90 && clampedW > 40 && clampedH > 36 && (
                  <text
                    x={x + clampedW / 2}
                    y={y + clampedH / 2 + 18}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="rgba(255,255,255,0.6)"
                    fontSize={8}
                    fontFamily="'IBM Plex Mono', monospace"
                  >
                    (R90°)
                  </text>
                )}
              </g>
            );
          })}
          {/* Dimension labels */}
          <text x={drawW / 2} y={drawH + 15} textAnchor="middle" fontSize={10} fill="#666"
            fontFamily="'IBM Plex Mono', monospace">
            {stockL}" ({(stockL / 12).toFixed(0)}')
          </text>
          <text
            x={-drawH / 2} y={-14}
            textAnchor="middle" fontSize={10} fill="#666"
            fontFamily="'IBM Plex Mono', monospace"
            transform="rotate(-90)"
          >
            {stockW}" ({(stockW / 12).toFixed(0)}')
          </text>
        </g>
      </svg>
    </div>
  );
}

/** Build full material description: Form Type | Material Type | Spec | Material */
function matDesc(group) {
  const parts = [group.form_type_name, group.material_type_name];
  if (group.spec_name) parts.push(group.spec_name);
  if (group.material_name) parts.push(group.material_name);
  return parts.join(' | ');
}

export default function App() {
  const [projectId, setProjectId] = useState(getProjectIdFromURL());
  const [step, setStep] = useState(projectId ? 1 : 0);
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
  const [newStock, setNewStock] = useState({ form_type: '', material_type: '', stock_length: '', stock_width: '' });
  const [nextCustomId, setNextCustomId] = useState(900000);

  // Store the last nest request payload for error analysis
  const [lastNestPayload, setLastNestPayload] = useState(null);

  // Pattern-level selection for import approval
  const [selectedPatterns, setSelectedPatterns] = useState(new Set());

  // Purchase list state
  const [showPurchasePreview, setShowPurchasePreview] = useState(false);
  const [savingPurchase, setSavingPurchase] = useState(false);
  const [purchaseStatus, setPurchaseStatus] = useState('');

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
    } catch (err) {
      setError(err.message || 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projectId) loadProject(projectId);
  }, [projectId, loadProject]);

  function toggleSelect(id) {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function selectAll() {
    setSelected(new Set(bom.filter(b => b.nest_type).map(b => b.id)));
  }
  function selectNone() {
    setSelected(new Set());
  }
  function toggleStock(id) {
    setEnabledStock(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function enableAllStock() {
    setEnabledStock(new Set(stock.map(s => s.id)));
  }
  function disableAllStock() {
    setEnabledStock(new Set());
  }

  // ─── Pattern Selection Helpers ───
  function togglePattern(key) {
    setSelectedPatterns(prev => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  function selectAllPatterns() {
    if (!results) return;
    const allKeys = new Set();
    const groups1d = groupResults(results.results_1d, results._nameLookup);
    groups1d.forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`1d-${gi}-${pi}`));
    });
    const groups2d = groupResults(results.results_2d, results._nameLookup);
    groups2d.forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`2d-${gi}-${pi}`));
    });
    setSelectedPatterns(allKeys);
  }

  function clearAllPatterns() {
    setSelectedPatterns(new Set());
  }

  function autoSelectAllPatterns(data) {
    const allKeys = new Set();
    const groups1d = groupResults(data.results_1d, data._nameLookup);
    groups1d.forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`1d-${gi}-${pi}`));
    });
    const groups2d = groupResults(data.results_2d, data._nameLookup);
    groups2d.forEach((group, gi) => {
      group.patterns.forEach((_, pi) => allKeys.add(`2d-${gi}-${pi}`));
    });
    setSelectedPatterns(allKeys);
  }

  function getSelectedResults() {
    if (!results) return { selected_1d: [], selected_2d: [] };
    const selected_1d = [];
    const selected_2d = [];
    const groups1d = groupResults(results.results_1d, results._nameLookup);
    groups1d.forEach((group, gi) => {
      group.patterns.forEach((pattern, pi) => {
        if (selectedPatterns.has(`1d-${gi}-${pi}`)) {
          selected_1d.push(...pattern.stockPieces);
        }
      });
    });
    const groups2d = groupResults(results.results_2d, results._nameLookup);
    groups2d.forEach((group, gi) => {
      group.patterns.forEach((pattern, pi) => {
        if (selectedPatterns.has(`2d-${gi}-${pi}`)) {
          selected_2d.push(...pattern.stockPieces);
        }
      });
    });
    return { selected_1d, selected_2d };
  }

  // ─── Weight Lookup Helper ───
  function getWeightMap() {
    const map = {};
    bom.forEach(b => {
      map[String(b.id)] = parseFloat(b.weight_per_ft) || 0;
    });
    return map;
  }

  function getStockWeightPerFt(result, weightMap) {
    const firstCut = result.cuts?.[0];
    if (!firstCut) return 0;
    return weightMap[String(firstCut.bom_line_id)] || 0;
  }

  // ─── Purchase List Aggregation ───
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
        // Look up display names
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

    // Calculate total weights
    const lines = Object.values(agg);
    lines.forEach(line => {
      line.total_weight = line.unit_weight * line.quantity;
    });
    return lines;
  }

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
      setPurchaseStatus(`Purchase list saved! ${data.items_saved} line items written to project.`);
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

    return {
      totalStock: totalStock,
      totalAllocated: totalAllocated,
      totalWaste: totalStock - totalAllocated,
    };
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
      stock_length: parseFloat(newStock.stock_length),
      stock_width: newStock.stock_width ? parseFloat(newStock.stock_width) : null,
      density: 0,
      is_standard: 'No',
      source: 'custom',
    };
    setStock(prev => [...prev, entry]);
    setEnabledStock(prev => {
      const n = new Set(prev);
      n.add(id);
      return n;
    });
    setNextCustomId(prev => prev + 1);
    setNewStock(prev => ({ ...prev, stock_length: '', stock_width: '' }));
  }

  function removeCustomStock(id) {
    setStock(prev => prev.filter(s => s.id !== id));
    setEnabledStock(prev => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
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
          density: parseFloat(s.density) || 0,
          length_in: parseFloat(s.stock_length),
          width_in: parseFloat(s.stock_width),
          is_standard: String(s.is_standard),
        }));
      const payload = {
        project_id: String(projectId),
        run_number: 1,
        kerf_1d: kerf1D,
        kerf_2d: kerf2D,
        parts_1d: parts1D,
        parts_2d: parts2D,
        stock_1d: stock1D,
        stock_2d: stock2D,
      };

      // Store payload for error analysis
      setLastNestPayload(payload);

      const resp = await fetch(`${API}/api/nest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error('Nesting API error');
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
      const resp = await fetch(`${API}/api/project/${projectId}/save-results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          results_1d: selected_1d,
          results_2d: selected_2d,
          summary: results.summary,
          kerf_1d: kerf1D,
          kerf_2d: kerf2D,
        }),
      });
      if (!resp.ok) throw new Error('Save failed');
      const data = await resp.json();
      setSaveStatus(`Saved! Run #${data.run_number} — ${data.saved_1d} 1D + ${data.saved_2d} 2D results (Status: ${data.run_status})`);
    } catch (err) {
      setSaveStatus(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  // Computed values for results view
  const selectedPatternCount = selectedPatterns.size;
  const weightSummary = (step === 3 && results) ? calcWeightSummary() : null;
  const purchaseLines = (step === 3 && results && showPurchasePreview) ? buildPurchaseLines() : [];
  const weightMap = (step === 3 && results) ? getWeightMap() : {};

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo-group">
            <div className="logo-icon">◈</div>
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
        </div>
      </header>

      <main className="main">
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

        {/* Step 0: Enter Project ID */}
        {step === 0 && !loading && (
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

        {/* Step 1: BOM */}
        {step === 1 && (
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
            <div className="card-footer">
              <span className="count">{selected.size} items selected</span>
              <button onClick={() => setStep(2)} className="btn btn-primary" disabled={selected.size === 0}>
                Next → Configure
              </button>
            </div>
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
                      <th>Material</th><th>Length</th><th>Width</th><th>Standard</th><th></th>
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
                        <td className="num">{inToFt(s.stock_length)}</td>
                        <td className="num">{s.stock_width && parseFloat(s.stock_width) > 0 ? inToFt(s.stock_width) : '—'}</td>
                        <td>{s.is_standard}</td>
                        <td>
                          {s.source === 'custom' && (
                            <button onClick={() => removeCustomStock(s.id)} className="btn btn-small btn-danger">Remove</button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {getFilteredStock().length === 0 && (
                      <tr><td colSpan={8} style={{ textAlign: 'center', color: '#999', padding: 16 }}>No stock items</td></tr>
                    )}
                  </tbody>
                </table>
                <div className="add-stock-row">
                  <div className="mini-field">
                    <label>Form Type</label>
                    <select value={newStock.form_type} onChange={e => setNewStock(p => ({ ...p, form_type: e.target.value }))}>
                      <option value="">Select...</option>
                      {formTypes.map(ft => <option key={ft} value={ft}>{ft}</option>)}
                    </select>
                  </div>
                  <div className="mini-field">
                    <label>Material</label>
                    <select value={newStock.material_type} onChange={e => setNewStock(p => ({ ...p, material_type: e.target.value }))}>
                      <option value="">Select...</option>
                      {matTypes.map(mt => <option key={mt} value={mt}>{mt}</option>)}
                    </select>
                  </div>
                  <div className="mini-field">
                    <label>Length (in)</label>
                    <input type="number" step="0.25" value={newStock.stock_length} onChange={e => setNewStock(p => ({ ...p, stock_length: e.target.value }))} placeholder="240" />
                  </div>
                  <div className="mini-field">
                    <label>Width (in, 2D only)</label>
                    <input type="number" step="0.25" value={newStock.stock_width} onChange={e => setNewStock(p => ({ ...p, stock_width: e.target.value }))} placeholder="Optional" />
                  </div>
                  <button onClick={addCustomStock} className="btn btn-add" disabled={!newStock.form_type || !newStock.material_type || !newStock.stock_length}>
                    + Add Stock
                  </button>
                </div>
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
                                  return warnings.map((w, wi) => <span key={wi} style={{color:'#d32f2f', fontSize:'11px', marginLeft:'8px', display:'inline-block'}}>⚠ {w}</span>);
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
                            {r.cuts?.map((cut, j) => (
                              <div
                                key={j}
                                className="bar-cut"
                                style={{ width: `${(cut.cut_length / r.stock_length_in) * 100}%` }}
                                title={`${cut.part_mark}: ${cut.cut_length}" — ${fmtLbs(patternWpf * (cut.cut_length / 12))}`}
                              >
                                <span>{cut.part_mark} ({cut.cut_length}")</span>
                              </div>
                            ))}
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
                                  return warnings.map((w, wi) => <span key={wi} style={{color:'#d32f2f', fontSize:'11px', marginLeft:'8px', display:'inline-block'}}>⚠ {w}</span>);
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
                          {/* Frontend-rendered 2D panel visualization */}
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
                      <td></td>
                      <td></td>
                      <td></td>
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

            <div className="card-footer">
              <button onClick={() => setStep(2)} className="btn">← Reconfigure</button>
              <div className="btn-group" style={{ alignItems: 'center' }}>
                <span className="count">{selectedPatternCount} pattern{selectedPatternCount !== 1 ? 's' : ''} selected</span>
                <button onClick={saveToZoho} className="btn btn-primary" disabled={saving || selectedPatternCount === 0}>
                  {saving ? 'Saving...' : `Import ${selectedPatternCount} Pattern${selectedPatternCount !== 1 ? 's' : ''} to Project`}
                </button>
                <button
                  onClick={() => { setShowPurchasePreview(true); setPurchaseStatus(''); }}
                  className="btn btn-secondary"
                  disabled={selectedPatternCount === 0}
                >
                  Generate Purchase List
                </button>
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
