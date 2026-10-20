// NexusAI-native Google Ads budget-boundaries registry — the bounded static data behind the
// `budget_boundaries` read on the certified googleAds surface. NOT a provider operation: it is
// planning data (the documented budget range Google accepts per campaign type and currency),
// so the certified provider contract (googleAdsProvider.ts) and its fail-closed gate stay
// untouched and no live Google Ads call is ever made.
//
// DOCUMENTED (Base44, GET /google-ads/campaigns/budget-boundaries): the response carries
// min/max/recommended daily budget in micros, exactly three raw presets (low→high; unlike the
// recommendation the highest preset may sit above max) and the USD conversion rate. Documented
// fallbacks: an unrecognized currency falls back to USD and an unknown campaign type falls
// back to SMART. Only USD is CONFIRMED — non-USD values are never invented: every other (or
// unrecognized) currency code falls back to USD, and because the amounts are then in USD the
// response reports currency_code "USD" rather than mislabeling borrowed values.

export const BUDGET_BOUNDARIES_USD = {
  min_daily_budget_micros: 10_000_000,
  max_daily_budget_micros: 1_000_000_000,
  recommended_daily_budget_micros: 30_000_000,
  preset_daily_budget_micros: [15_000_000, 30_000_000, 60_000_000],
  usd_to_currency_rate: 1,
};

export const BUDGET_BOUNDARY_TYPES = ["SMART", "PERFORMANCE_MAX"];

export function budgetBoundaries(input = {}) {
  const rawType = String(input.campaign_type || "").toUpperCase();
  const campaign_type = BUDGET_BOUNDARY_TYPES.includes(rawType) ? rawType : "SMART";
  return { currency_code: "USD", campaign_type, ...BUDGET_BOUNDARIES_USD };
}