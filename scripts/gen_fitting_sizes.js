const fs=require('fs');
// Usage: node scripts/gen_fitting_sizes.js <file holding the Deluge getFittingSizes source>
const srcPath=process.argv[2];
if(!srcPath){ console.error('usage: node scripts/gen_fitting_sizes.js <deluge-source.txt>'); process.exit(1); }
const src=fs.readFileSync(srcPath,'utf8');
const lists={};
for(const name of ['flStraight','bwStraight','bwCombos','fgStraight','fgCombos']){
  const i0=src.indexOf(name+' = {'); const i1=src.indexOf('};',i0); const m=i0<0?null:[0,src.slice(i0+name.length+4,i1)];
  if(!m) throw new Error('missing '+name);
  lists[name]=JSON.parse('['+m[1]+']');
}
const out=`// GENERATED from the Deluge custom function getFittingSizes() (Zoho → Workflows → Functions),
// source as pasted 2026-09-26. The five size lists are COPIED verbatim, not retyped, so every label
// is spelled exactly as the project form's own fitting dropdown spells it — which is also how
// getFittingWeight() looks weights up (by literal string: "1/2\\" | 3000#" weighs 0, "| 3000 PSI" weighs).
// If the Deluge function changes, regenerate this file; do not hand-edit the lists.
//
// Loaded by the review page (<script src>) and requirable from Node.
(function (root) {
  const L = ${JSON.stringify(lists)};

  function isReducing(ftype, connType, endType) {
    return ftype === 'Reducer' || ftype === 'Bushing' || connType.indexOf('Reduc') > -1 ||
      endType.indexOf('Reduc') > -1 || endType.indexOf('Swage') > -1;
  }

  // Same five arguments, same order, same branches as the Deluge. 'fitting' is the style:
  // "Butt Weld" or anything else (forged).
  function getFittingSizes(ftype, fitting, connType, endType, makeName) {
    ftype = String(ftype || ''); fitting = String(fitting || '');
    connType = String(connType || ''); endType = String(endType || ''); makeName = String(makeName || '');
    if (ftype === 'Flange') {
      let scheds = null;
      if (endType.indexOf('Weld Neck') > -1) {
        scheds = makeName.indexOf('Stainless') > -1 ? ['SCH 10S', 'SCH 40S', 'SCH 80S'] : ['SCH 10', 'SCH 40', 'SCH 80', 'SCH 160', 'XXS'];
      } else if (endType.indexOf('Socket') > -1) {
        scheds = makeName.indexOf('Stainless') > -1 ? ['SCH 40S', 'SCH 80S'] : ['SCH 40', 'SCH 80'];
      }
      if (!scheds) return L.flStraight.slice();
      const out = [];
      L.flStraight.forEach(function (fs) { scheds.forEach(function (sc) { out.push(fs + ' | ' + sc); }); });
      return out;
    }
    if (makeName.indexOf('Iron') > -1) {
      const cls = makeName.indexOf('Malleable') > -1 ? ['Class 150', 'Class 300']
        : makeName.indexOf('Cast') > -1 ? ['Class 125', 'Class 250']
        : ['Class 125', 'Class 150', 'Class 250', 'Class 300'];
      const nps = ['1/8"', '1/4"', '3/8"', '1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"', '2-1/2"', '3"', '3-1/2"', '4"', '5"', '6"'];
      const out = [];
      if (isReducing(ftype, connType, endType)) {
        cls.forEach(function (c) { nps.forEach(function (big, bi) { nps.forEach(function (small, si) {
          if (si < bi) out.push(big + ' x ' + small + ' | ' + c); }); }); });
      } else {
        cls.forEach(function (c) { nps.forEach(function (n) { out.push(n + ' | ' + c); }); });
      }
      return out;
    }
    const bw = fitting === 'Butt Weld';
    return (isReducing(ftype, connType, endType) ? (bw ? L.bwCombos : L.fgCombos) : (bw ? L.bwStraight : L.fgStraight)).slice();
  }

  const api = { getFittingSizes: getFittingSizes, isReducing: isReducing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MCFittingSizes = api;
})(this);
`;
fs.writeFileSync(require('path').join(__dirname,'..','server','takeoff','public','fittingSizes.js'),out);
console.log('wrote fittingSizes.js', Object.fromEntries(Object.entries(lists).map(([k,v])=>[k,v.length])));
