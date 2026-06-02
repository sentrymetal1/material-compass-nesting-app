// =============================================================================
//  takeoff/entitlement.js (CommonJS) — credit gating for AI take-offs.
//  Dormant unless the route is given getManufacturer/updateManufacturer/createLog
//  deps. checkEntitlement() before the Claude call; consumeTakeoff() after success.
//  WIRE: confirm Takeoff_Credits / Takeoff_Free_Remaining on Customer_Entry_Form.
// =============================================================================

const F = {
  credits: "Takeoff_Credits",          // WIRE: confirm (Number, 0 decimals)
  freeLeft: "Takeoff_Free_Remaining",   // WIRE: confirm (or remove if no free trial)
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function checkEntitlement(deps, manufacturerId) {
  const rec = await deps.getManufacturer(manufacturerId);
  if (!rec) return { allowed: false, reason: "manufacturer_not_found", credits: 0, free: 0 };
  const credits = num(rec[F.credits]);
  const free = num(rec[F.freeLeft]);
  const allowed = credits > 0 || free > 0;
  return {
    allowed: allowed,
    credits: credits,
    free: free,
    source: free > 0 ? "free" : credits > 0 ? "credit" : null,
    reason: allowed ? null : "no_credits",
  };
}

async function consumeTakeoff(deps, manufacturerId, logFields) {
  logFields = logFields || {};
  const rec = await deps.getManufacturer(manufacturerId);
  if (!rec) throw new Error("manufacturer_not_found_on_consume");
  const credits = num(rec[F.credits]);
  const free = num(rec[F.freeLeft]);

  let patch = null, drawn;
  if (free > 0) { patch = {}; patch[F.freeLeft] = free - 1; drawn = "free"; }
  else if (credits > 0) { patch = {}; patch[F.credits] = credits - 1; drawn = "credit"; }
  else { drawn = "uncharged"; }

  if (patch) await deps.updateManufacturer(manufacturerId, patch);
  if (typeof deps.createLog === "function") {
    await deps.createLog(Object.assign({}, logFields, { Drawn_From: drawn }));
  }
  return {
    drawn: drawn,
    credits_left: drawn === "credit" ? credits - 1 : credits,
    free_left: drawn === "free" ? free - 1 : free,
  };
}

module.exports = { checkEntitlement, consumeTakeoff };
