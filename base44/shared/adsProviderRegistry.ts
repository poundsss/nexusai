// The provider-neutral Ads SEAM — NexusAI-native routing of every live ads operation by
// provider/channel, built ONLY on the CONFIRMED Zernio documentation (docs.zernio.com,
// fetched 2026-10-06) and the EXISTING Google adapter contract (googleAdsProvider.ts).
//
// What this registry is:
//   • the ONE routing point every ads surface resolves its adapter through — channel in,
//     { provider, providerLive } out. Google keeps its own direct adapter and its exact
//     existing behavior; the Zernio channels route through Zernio adapters.
//   • fail-closed by design: the Zernio adapters implement the SAME 11-operation adapter
//     contract as Google. TEN operations are explicitly implemented and live when
//     ZERNIO_API_KEY exists: syncCampaigns (a READ-ONLY GET /v1/ads/campaigns fetch),
//     pauseCampaign and resumeCampaign (PUT /v1/ads/campaigns/{id}/status — writes the
//     campaign's own switch only; no budget change, nothing created, no spend opens),
//     updateCampaign (PUT /v1/ads/campaigns/{id} — the documented per-platform field matrix
//     serves ONLY the daily budget on OpenAI; renames are Meta-only 501 and TikTok/LinkedIn
//     budgets 501, so every other patch refuses pre-call) and deleteCampaign
//     (DELETE /v1/ads/campaigns/{id} — PERMANENT, no restore) and bulkBudgets (NO dedicated
//     Zernio bulk-budget endpoint exists — the only documented bulk path, bulk-status, writes
//     STATUS; bulkBudgets is a bounded, non-atomic composition of the documented OpenAI
//     daily-budget write returning the contract's { succeeded, failed } shape) and acceptAsset
//     (the ONLY documented Zernio asset-accept path, attachCampaignAssets, is x-platforms:
//     google — 501 on every other platform, so every registered Zernio channel refuses
//     pre-call with the documented-501 refusal), and mapConversion (the ONLY documented conversion-action creation path,
//     POST /v1/ads/conversions/actions, is Google-only — 501 on every other platform; the
//     LinkedIn destination path needs an adAccountId the contract does not carry, Meta/OpenAI
//     are documented 405, TikTok conversions are undocumented — every registered Zernio channel
//     refuses pre-call with its documented refusal), and uploadConversions (the
//     ONLY documented conversion-event path, POST /v1/ads/conversions, requires the Zernio
//     accountId and a channel-scoped destinationId the contract's { mappings, events } args do
//     not carry — every registered Zernio channel refuses pre-call, no conversion endpoint is
//     ever called), and disconnectAccount (DELETE /v1/accounts/{accountId} — the documented
//     intentional-disconnect path; the documented response carries no budget/spend
//     information, so the contract's budget_end_confirmed is honestly false), all in
//     zernioAdsProvider.ts.
//     EVERY other operation refuses (PROVIDER_NOT_CONFIGURED while unconfigured,
//     PROVIDER_UNIMPLEMENTED once a key exists) and makes NO Zernio API call.
//
// Confirmed Zernio evidence behind the channel set (audit): Zernio's Ads API covers 7 ad
// networks (Meta, Google, TikTok, LinkedIn, Pinterest, X, OpenAI/ChatGPT). Google stays on
// its own adapter; the NexusAI target channels on Zernio are meta, tiktok, linkedin and
// openai. Pinterest/X are deliberately NOT registered: the audit scoped the target set and
// no capability for them is claimed. Adapters implement ONLY the common contract; all
// provider-specific Zernio shapes (Meta promotedObject/pixels, OpenAI pixels + server-side
// conversions, Google asset groups/keywords/bid strategies) stay OUTSIDE it.
import {
  PROVIDER_OPERATIONS,
  createFailClosedProvider,
  providerConfigured as googleProviderConfigured,
} from "./googleAdsProvider.ts";
import { createZernioAdsProvider } from "./zernioAdsProvider.ts";

/** google is the direct existing adapter; zernio:* are the confirmed Zernio channels. */
export const ADS_CHANNELS = ["google", "zernio:meta", "zernio:tiktok", "zernio:linkedin", "zernio:openai"];

export const ZERNIO_ADS_CHANNELS = ADS_CHANNELS.filter((c) => c.startsWith("zernio:"));

// The only credential the Zernio adapter will require. NOT set for this app — which is
// exactly why every Zernio operation fails closed today.
export const ZERNIO_REQUIRED_SECRETS = ["ZERNIO_API_KEY"];

export function zernioProviderConfigured() {
  return ZERNIO_REQUIRED_SECRETS.every((name) => !!process.env[name]);
}

/** Configuration state per channel (what account_get reports as provider_configured). */
export function isChannelConfigured(channel) {
  return channel === "google" ? googleProviderConfigured() : zernioProviderConfigured();
}

/** Absent → "google" (legacy requests and legacy rows are Google); unknown → null. */
export function normalizeAdsChannel(input) {
  const channel = String(input || "").trim() || "google";
  return ADS_CHANNELS.includes(channel) ? channel : null;
}

function zernioNotConfigured(operation, channel) {
  return Object.assign(
    new Error(`Zernio Ads provider is not configured — "${operation}" on channel "${channel}" requires the external Zernio Ads infrastructure (ZERNIO_API_KEY) and an explicitly implemented runtime integration. No Zernio API call was made.`),
    { code: "PROVIDER_NOT_CONFIGURED", status: 409, retryable: false },
  );
}

/** The Zernio adapters: the SAME 11-op contract as the Google adapter, ALL fail-closed. */
export function createZernioFailClosedProvider(channel) {
  const provider = {};
  for (const op of PROVIDER_OPERATIONS) {
    provider[op] = async () => {
      throw zernioNotConfigured(op, channel);
    };
  }
  return provider;
}

/**
 * THE seam. An injected adapter (the certification's deterministic stub) always wins and is
 * live — the caller takes responsibility for its wiring. Production resolves the channel's
 * adapter, which fails closed while unconfigured. `configured` is the honest configuration
 * state of the channel regardless of injection (what account_get reports).
 */
export function resolveAdsProvider(channel, opts = {}) {
  if (opts.provider) {
    return { provider: opts.provider, providerLive: true, configured: isChannelConfigured(channel) };
  }
  if (channel === "google") {
    const configured = googleProviderConfigured();
    return { provider: createFailClosedProvider(), providerLive: configured, configured };
  }
  const configured = zernioProviderConfigured();
  // Once ZERNIO_API_KEY exists the channel routes to the runtime adapter — syncCampaigns,
  // pauseCampaign, resumeCampaign, updateCampaign, deleteCampaign, bulkBudgets, acceptAsset,
  // mapConversion, uploadConversions and disconnectAccount live, the rest still fail-closed
  // (PROVIDER_UNIMPLEMENTED). Unconfigured stays exactly as
  // the seam certification locked it: the fail-closed factory.
  return {
    provider: configured ? createZernioAdsProvider(channel) : createZernioFailClosedProvider(channel),
    providerLive: configured,
    configured,
  };
}