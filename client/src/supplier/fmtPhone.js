// US numbers show as 716-545-6465 (Zoho keeps +17165456465; the server converts typed
// numbers back on save). Anything that isn't a 10-digit US number is shown as stored.
export default function fmtPhone(v) {
  const s = String(v || '').trim();
  const d = s.replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d.length === 10 ? d : '';
  return ten ? ten.slice(0, 3) + '-' + ten.slice(3, 6) + '-' + ten.slice(6) : s;
}
