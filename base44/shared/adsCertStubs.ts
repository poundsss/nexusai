// Shared certification stubs for the Ads foundation suites (googleAdsCert + adsProviderSeamCert).
// A deterministic in-memory provider: the SAME signatures as the adapter contract
// (googleAdsProvider.ts PROVIDER_OPERATIONS), no external call ever made. The `state` records
// every op a suite drove; the surface above the adapter cannot tell this stub from a real one.
import { googleAdsSurface } from "./googleAds.ts";

export function makeAdsStubProvider() {
  const state = { launched: [], paused: [], resumed: [], deleted: [], accepted: [], mapped: [], uploaded: 0 };
  return {
    state,
    disconnectAccount: async () => ({ budget_end_confirmed: true }),
    launch: async ({ payload }) => {
      state.launched.push(payload);
      return {
        account: { provider_account_ref: "prov-acc-1", currency_code: "USD", billing_cadence: "every_3_days" },
        campaigns: [{ campaign_name: payload.campaign_name, campaign_type: payload.campaign_type, status: "ENABLED", daily_budget_micros: payload.daily_budget_micros, provider_campaign_id: "prov-camp-1" }],
      };
    },
    syncCampaigns: async ({ campaigns }) => ({
      campaigns: campaigns.filter((c) => c.provider_campaign_id).map((c) => ({ provider_campaign_id: c.provider_campaign_id, status: c.status, metrics: { impressions: 100, clicks: 5, cost_micros: 1000000, spend: 1, conversions: 1, ctr: 0.05 } })),
    }),
    updateCampaign: async ({ campaign, patch }) => ({ campaign: patch }),
    pauseCampaign: async ({ campaign }) => ({ campaign: { status: "PAUSED", serving_status: "SUSPENDED" } }),
    resumeCampaign: async ({ campaign }) => ({ campaign: { status: "ENABLED", serving_status: "SERVING" } }),
    deleteCampaign: async ({ campaign }) => ({ campaign: { status: "REMOVED" } }),
    bulkBudgets: async ({ entries }) => ({
      succeeded: entries.filter((e) => e.daily_budget_micros > 0).map((e) => e.campaign_id),
      failed: entries.filter((e) => !(e.daily_budget_micros > 0)).map((e) => ({ campaign_id: e.campaign_id, reason: "budget too low" })),
    }),
    acceptAsset: async ({ sessionAssetId }) => { state.accepted.push(sessionAssetId); return { provider_asset_ref: `prov-asset-${state.accepted.length}` }; },
    mapConversion: async () => { state.mapped.push(1); return { provider_conversion_ref: "prov-conv-1" }; },
    uploadConversions: async () => { state.uploaded += 1; return { uploaded: 1, failed: [] }; },
  };
}

/** The certified surface entry point both suites drive (project + user + input + opts). */
export function makeAdsSurface(svc) {
  return (project, user, input, opts) => googleAdsSurface(svc, project, { id: project.workspace_id }, user, input, opts);
}