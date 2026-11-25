// Azar 1405 incentive rules. All monetary values are in million toman,
// based on non-electric category sales INCLUDING tax, after returns.
export const SELLER_FLOOR_M = 400;
export const SELLER_RATE = 0.03;
export const SELLER_CAP_M = 20;
export const SUPERVISOR_SHARE = 0.30;
export const SUPERVISOR_INCREMENT_CAP = 0.03;

// The threshold is the seller's verified Aban baseline, but never below 400.
export function sellerTarget(abanSalesM) {
  return Math.max(SELLER_FLOOR_M, Number(abanSalesM || 0));
}

export function sellerBonus(abanSalesM, azarSalesM) {
  const sold = Number(azarSalesM || 0);
  if (!Number.isFinite(sold)) return 0;
  const incremental = Math.max(0, sold - sellerTarget(abanSalesM));
  return Math.min(SELLER_CAP_M, SELLER_RATE * incremental);
}

// Supervisors qualify only when TOTAL branch sales grow strictly above Aban.
// Their reward is also limited to 3% of the branch's net incremental sales.
export function supervisorBonus(abanStoreM, azarStoreM, sellerBonusesM) {
  const growth = Number(azarStoreM || 0) - Number(abanStoreM || 0);
  if (!(growth > 0)) return 0;
  const sellersTotal = sellerBonusesM.reduce((sum, value) =>
    sum + Math.max(0, Number(value) || 0), 0);
  return Math.max(0, Math.min(SUPERVISOR_SHARE * sellersTotal,
    SUPERVISOR_INCREMENT_CAP * growth));
}
