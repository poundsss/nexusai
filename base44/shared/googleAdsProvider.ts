// The Google Ads provider ADAPTER — the only place allowed to speak to Google Ads.
//
// The NexusAI Google Ads foundation is standalone: it never calls Base44 APIs, never uses a
// Base44 PAT or app_id, and never invents Google provisioning behavior. Every live operation
// goes through this interface, and the default implementation FAILS CLOSED: until the external
// Google Ads infrastructure exists (a developer token, a manager/customer id and OAuth
// credentials provisioned OUTSIDE this app), every method refuses with PROVIDER_NOT_CONFIGURED
// and NO Google Ads call is attempted — no simulated results, no invented account state.
//
// The interface mirrors ONLY the documented Base44 Google Ads operations (the behavior target):
//   account:      get / disconnect
//   launch:       launch-readiness / launch (launch creates the account if absent, then the
//                 campaign — the single point where money can start)
//   campaigns:    list / get / update sections / pause / resume / pause-all / bulk budgets /
//                 delete (permanent, REMOVED stays listed for reporting)
//   assets:       accept (the only step that puts a preview on a live campaign)
//   conversions:  mapping / upload
// Copy and image GENERATION are deliberately NOT provider calls: they produce previews only
// (documented: "Nothing reaches Google Ads here"), so the surface runs them through the
// existing model gateway / image generation instead.

// The secrets the REAL adapter will require once Google Ads infrastructure is provisioned.
// Declared here so the fail-closed gate and any future wiring share one list; NONE of them are
// set for this app today, which is exactly why everything fails closed.
export const GOOGLE_ADS_REQUIRED_SECRETS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_MANAGER_ID",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
];

export function providerConfigured() {
  return GOOGLE_ADS_REQUIRED_SECRETS.every((name) => !!process.env[name]);
}

export function notConfigured(operation) {
  return Object.assign(
    new Error(`Google Ads provider is not configured — "${operation}" requires the external Google Ads infrastructure (developer token / manager account / OAuth credentials). No Google Ads call was made.`),
    { code: "PROVIDER_NOT_CONFIGURED", status: 409, retryable: false },
  );
}

/**
 * The adapter contract. A real implementation performs the live Google Ads calls; a test
 * implementation is a deterministic stub injected by the certification suite. Both satisfy the
 * same signatures, so the surface above the adapter cannot tell them apart.
 */
export const PROVIDER_OPERATIONS = [
  "disconnectAccount", // ({ account }) -> { budget_end_confirmed }
  "launch", // ({ payload }) -> { account, campaigns } — creates the account if absent, then campaigns
  "syncCampaigns", // ({ account }) -> { campaigns } — provider-side serving state + metrics
  "updateCampaign", // ({ campaign, patch }) -> { campaign }
  "pauseCampaign", // ({ campaign }) -> { campaign }
  "resumeCampaign", // ({ campaign }) -> { campaign }
  "deleteCampaign", // ({ campaign }) -> { campaign } — permanent; REMOVED
  "bulkBudgets", // ({ account, entries }) -> { succeeded: [id], failed: [{ campaign_id, reason }] }
  "acceptAsset", // ({ sessionAssetId, assetFieldType, content }) -> { provider_asset_ref }
  "mapConversion", // ({ mapping }) -> { provider_conversion_ref }
  "uploadConversions", // ({ mappings, events }) -> { uploaded, failed }
];

/** The production adapter: every operation refuses without making any external call. */
export function createFailClosedProvider() {
  const provider = {};
  for (const op of PROVIDER_OPERATIONS) {
    provider[op] = async () => {
      throw notConfigured(op);
    };
  }
  return provider;
}