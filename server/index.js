// Match Suggestions
const geoCache = {};

async function getLatLng(postalCode, country) {
  if (!postalCode) return null;
  const key = postalCode.trim();
  if (geoCache[key]) return geoCache[key];
  try {
    const cc = (country && country.toLowerCase().includes('canada')) ? 'ca' : 'us';
    const resp = await axios.get(`https://api.zippopotam.us/${cc}/${key}`, { timeout: 5000 });
    if (resp.data.places && resp.data.places.length > 0) {
      const result = {
        lat: parseFloat(resp.data.places[0].latitude),
        lng: parseFloat(resp.data.places[0].longitude)
      };
      geoCache[key] = result;
      return result;
    }
    return null;
  } catch (e) {
    console.log('Geocode failed for zip:', key, e.message);
    return null;
  }
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreMatch({ supplierStock, mfgShape, mfgMaterial, mfgSpec, supplierCaps, distanceMi, radius, quoteCount }) {
  let stockScore = 0;
  if (mfgShape || mfgMaterial || mfgSpec) {
    const fullKey = `${mfgShape}|${mfgMaterial}|${mfgSpec}`.toLowerCase();
    const catKey  = `${mfgShape}|${mfgMaterial}`.toLowerCase();
    const hasExact = supplierStock.some(s => `${s.Form_Type}|${s.Material_Type}|${s.Type_Detail}`.toLowerCase() === fullKey);
    const hasCat   = supplierStock.some(s => `${s.Form_Type}|${s.Material_Type}`.toLowerCase() === catKey);
    stockScore = hasExact ? 1.0 : hasCat ? 0.5 : 0;
  }
  const supCapSet = new Set(supplierCaps.map(c => c.Supplier_Process?.Capabilities?.toLowerCase()).filter(Boolean));
  const capScore = supCapSet.size > 0 ? Math.min(supCapSet.size / 10, 1) : 0;
  const distanceScore = Math.max(0, 1 - (distanceMi / radius));
  const historyScore = quoteCount > 0 ? Math.min(Math.log10(quoteCount + 1) / Math.log10(11), 1) : 0;
  const total = (stockScore * 0.50) + (capScore * 0.20) + (distanceScore * 0.15) + (historyScore * 0.15);
  return {
    total: Math.round(total * 100),
    breakdown: {
      stockMatch:   Math.round(stockScore    * 100),
      capabilities: Math.round(capScore      * 100),
      distance:     Math.round(distanceScore * 100),
      history:      Math.round(historyScore  * 100)
    }
  };
}

app.get('/api/match-suggestions', async (req, res) => {
  const { mfg_id, radius = 150, shape = '', material = '', spec = '' } = req.query;
  if (!mfg_id) return res.status(400).json({ error: 'mfg_id required' });
  try {
    const token = await getAccessToken();
    const base  = creatorApiBase();
    const hdrs  = zohoHeaders(token);

    // 1. MFG record
  const mfgResp = await axios.get(
  `${base}/report/Customer_Entry_Report?criteria=(ID==${mfg_id})`,
  { headers: hdrs }
);
    const mfg = mfgResp.data.data?.[0];
    if (!mfg) return res.status(404).json({ error: 'MFG not found' });

    // 2. Geocode MFG by zip
    const mfgZip = mfg.Address?.postal_code;
    const mfgCountry = mfg.Address?.country;
    const mfgGeo = await getLatLng(mfgZip, mfgCountry);
    if (!mfgGeo) return res.status(400).json({ error: 'Could not geocode MFG zip: ' + mfgZip });

    // 3. Quote history
    const rfqResp = await axios.get(
      `${base}/report/All_RFQs_Sent_Report?criteria=(Quote_LU.Customer_Entry_LU==${mfg_id})&limit=200`,
      { headers: hdrs }
    ).catch(() => ({ data: { data: [] } }));
    const quoteHistory = {};
    for (const rfq of (rfqResp.data.data || [])) {
      const sid = rfq.Supplier_LU?.ID;
      if (sid) quoteHistory[sid] = (quoteHistory[sid] || 0) + 1;
    }

    // 4. All registered suppliers
    const supResp = await axios.get(
      `${base}/report/All_Suppliers_Entry_Report?criteria=(Register=="Yes")&limit=200`,
      { headers: hdrs }
    );
    const suppliers = supResp.data.data || [];

    // 5. Score each supplier in radius
    const results = await Promise.all(suppliers.map(async (sup) => {
      const supZip     = sup.Address?.postal_code;
      const supCountry = sup.Address?.country;
      const supGeo     = await getLatLng(supZip, supCountry);
      if (!supGeo) return null;

      const distanceMi = haversine(mfgGeo.lat, mfgGeo.lng, supGeo.lat, supGeo.lng);
      if (distanceMi > parseFloat(radius)) return null;

      const [stockResp, capResp] = await Promise.all([
        axios.get(
          `${base}/report/Stocked_Material_List?criteria=(Supplier_ID==${sup.ID})&&(Material_Stocked==true)&limit=500`,
          { headers: hdrs }
        ).catch(() => ({ data: { data: [] } })),
        axios.get(
          `${base}/report/Capabilities_Processes_Per_Supplier_Report?criteria=(Supplier_Entry_Form==${sup.ID})&limit=200`,
          { headers: hdrs }
        ).catch(() => ({ data: { data: [] } }))
      ]);

      const supplierStock = stockResp.data.data || [];
      const supplierCaps  = capResp.data.data  || [];

      const score = scoreMatch({
        supplierStock,
        mfgShape:    shape,
        mfgMaterial: material,
        mfgSpec:     spec,
        supplierCaps,
        distanceMi,
        radius:      parseFloat(radius),
        quoteCount:  quoteHistory[sup.ID] || 0
      });

      return {
        id:          sup.ID,
        name:        sup.Company_Name,
        address:     sup.Address,
        distanceMi:  Math.round(distanceMi),
        score:       score.total,
        breakdown:   score.breakdown,
        mainContact: sup.Main_Contact_Name,
        phone:       sup.Phone,
        email:       sup.Email,
        stockCount:  supplierStock.length,
        capCount:    supplierCaps.length
      };
    }));

    const filtered = results.filter(Boolean).sort((a, b) => b.score - a.score);

    res.json({
      mfg_id,
      radius,
      searchCriteria: { shape, material, spec },
      count: filtered.length,
      results: filtered
    });

  } catch (err) {
    console.error('Match suggestions error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});
