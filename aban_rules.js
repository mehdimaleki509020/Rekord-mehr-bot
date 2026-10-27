// All monetary amounts are expressed in million toman.
export const SELLER_FLOOR_M = 500;
export const SELLER_GROWTH = 1.2;
export const SELLER_BONUS_RATE = 0.01;
export const SUPERVISOR_BONUS_RATE = 0.30;

export function sellerTarget(mehrSalesM) {
  return Math.max(SELLER_FLOOR_M, Number(mehrSalesM || 0) * SELLER_GROWTH);
}

export function sellerBonus(mehrSalesM, abanSalesM) {
  const sold = Number(abanSalesM || 0);
  return sold + 1e-8 >= sellerTarget(mehrSalesM) ? Math.max(0, sold) * SELLER_BONUS_RATE : 0;
}

export function supervisorBonus(mehrStoreM, abanStoreM, sellerBonusesM) {
  // The no-decline condition applies to TOTAL non-electric sales of the store.
  if (Number(abanStoreM || 0) + 1e-8 < Number(mehrStoreM || 0)) return 0;
  return sellerBonusesM.reduce((sum, reward) => sum + Number(reward || 0), 0) * SUPERVISOR_BONUS_RATE;
}
