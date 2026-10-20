// The Zernio Ads RUNTIME adapter — the explicitly implemented Zernio operations.
// First implemented operation: syncCampaigns — a READ-ONLY GET /v1/ads/campaigns fetch.
// Second and third implemented operations: pauseCampaign and resumeCampaign — both PUT
// /v1/ads/campaigns/{campaignId}/status with { status: "paused" | "active", platform }
// (docs.zernio.com/ad-campaigns/update-ad-campaign-status, fetched 2026-10-06). They write the
// campaign's OWN on/off switch and NOTHING else: no budget change, nothing created, no spend
// opens (pause STOPS delivery; resume only lets delivery continue where each child's own
// switch is on). The response's platformCampaignStatus passes through verbatim as
// serving_status; the documented skip/updated provenance rides along. zernio:meta REFUSES
// before any call with PROVIDER_INVALID_INPUT: the endpoint's required `platform` is one of
// facebook/instagram and the stored campaign does not declare its half — never guessed. Every
// OTHER operation of the 11-op adapter contract (googleAdsProvider.ts PROVIDER_OPERATIONS)
// stays FAIL-CLOSED: it refuses with PROVIDER_UNIMPLEMENTED (409, non-retryable) and makes NO
// Zernio call. This adapter never creates or launches anything and never opens spend; the only
// write paths are the documented campaign status switch, the documented daily-budget edit on
// the OpenAI channel and the permanent documented campaign delete.
//
// Fourth implemented operation: updateCampaign — PUT /v1/ads/campaigns/{campaignId}
// (docs.zernio.com/ad-campaigns/update-ad-campaign, fetched 2026-10-06). The endpoint requires
// `platform` and serves a NARROW per-platform field matrix: budget edits are "OpenAI: daily or
// lifetime; others 501" and renames are Meta-only (501 everywhere else). The adapter contract's
// patch carries only campaign_name and daily_budget_micros, so the ONLY mappable field is the
// daily budget on zernio:openai (whole currency units; a non-whole-unit micros value refuses
// rather than rounding) — every other patch refuses BEFORE any call instead of sending a
// request the documentation says cannot succeed.
//
// Fifth implemented operation: deleteCampaign — DELETE /v1/ads/campaigns/{campaignId}
// (docs.zernio.com/ad-campaigns/delete-ad-campaign, fetched 2026-10-06). PERMANENT — the
// campaign and its ad sets/ads are deleted on the platform with no restore; the surface marks
// the row REMOVED only after the provider confirmed the delete. The body requires `platform`
// (the existing channel -> platform mapping; zernio:meta refuses pre-call since its half is
// never declared) and optionally `accountId` (read by Zernio only to resolve an EMPTY
// campaign with zero ads — ignored otherwise), so the adapter sends it whenever the account's
// provider_account_ref exists. The response's deleted/adCount pass through as write
// provenance.
//
// Sixth implemented operation: bulkBudgets — Zernio publishes NO bulk-budget endpoint (the
// only documented bulk path is POST /v1/ads/campaigns/bulk-status, which writes STATUS and
// never budgets), so bulkBudgets is a BOUNDED, NON-ATOMIC composition over the documented
// single-campaign budget write (PUT /v1/ads/campaigns/{campaignId} — the SAME endpoint and
// body updateCampaign uses), in the SAME non-atomic shape the Google contract documents:
// { succeeded: [id], failed: [{ campaign_id, reason }] } — the response lists the ones that
// worked and the rest, and one bad entry never fails the batch. Entries carry the contract's
// campaign_id + daily_budget_micros; the provider call also reads the entry's
// provider_campaign_id (the platform id the documented path addresses). Whole-op refusals
// BEFORE any call: no key, empty entries, more than the contract's 50-entry bound,
// zernio:meta (half never declared) and the documented-501 budget platforms (tiktok/linkedin).
// Per-entry refusals (a missing provider id, a non-whole-unit budget) land in `failed` with
// a reason and ZERO calls for that entry; a Zernio 401 on one entry fails the batch and the
// remaining entries are aborted without further calls.
//
// Seventh implemented operation: acceptAsset — the ONLY documented Zernio asset-accept path is
// attachCampaignAssets (POST /v1/ads/campaigns/{campaignId}/assets), which the documentation
// restricts to x-platforms: google ("Creates and attaches sitelinks, callouts and structured
// snippets"; the documented error table answers 501: Only supported on Google Ads). The
// registered Zernio channels are meta, tiktok, linkedin and openai, and the google channel
// stays on its own DIRECT adapter — so no registered Zernio channel documents an asset accept
// at all. acceptAsset therefore maps the contract's fields (sessionAssetId, assetFieldType,
// content), validates them, and refuses BEFORE any call with the documented-501 refusal
// (PROVIDER_INVALID_INPUT) — never a request the documentation says cannot succeed, and no
// mutation of campaign status, budget or anything else. The operation is live (mapped and
// validated, no longer PROVIDER_UNIMPLEMENTED) exactly like updateCampaign's documented-501
// budget platforms.
//
// Eighth implemented operation: mapConversion — the provider-side conversion mapping (the
// surface's conversion_mapping_update with map_to_provider: true). The ONLY documented
// conversion-action creation path, POST /v1/ads/conversions/actions, is Google-only (501 on
// every other platform; its required accountId "must be a googleads account"). The broader
// create-conversion-destination path (POST /v1/accounts/{accountId}/conversion-destinations)
// serves LinkedIn (conversion rule) and Google only — Meta and OpenAI Ads are documented 405
// (their pixels are created via the tracking-tags flow, POST /v1/accounts/{accountId}/tracking-tags)
// — and the LinkedIn path requires a body adAccountId the mapConversion contract does not carry
// ({ mapping } only). TikTok conversions are not documented on Zernio at all. The registered
// Zernio channels are meta, tiktok, linkedin and openai, and the google channel stays on its
// own DIRECT adapter — so mapConversion maps the contract's fields (app_event_name,
// conversion_action_name), validates them, and refuses BEFORE any call with each channel's
// documented refusal (PROVIDER_INVALID_INPUT) — never a request the documentation says cannot
// succeed. No fetch is ever made: no Zernio conversion endpoint is reachable from any
// registered channel.
//
// Ninth implemented operation: uploadConversions — the conversion-event upload (the surface's
// conversion_upload). The ONLY documented conversion-event path, POST /v1/ads/conversions
// (docs.zernio.com/conversions/send-conversions, fetched 2026-10-06), requires the Zernio
// accountId (the SocialAccount id) AND a channel-scoped destinationId per batch — and the
// destinationId semantics differ per platform (Meta pixel/dataset id, Google conversion-action
// resource name, LinkedIn conversion rule id/URN, OpenAI pixel wire id, TikTok Offline Event
// Set id). The adapter contract's args ({ mappings, events }) carry NEITHER: the surface does
// not pass the account, and mapConversion refuses on EVERY registered Zernio channel, so no
// mapping can ever carry a Zernio destination ref — the only mapped rows a project can have
// are Google's, and sending a Google conversion-action resource name to Meta's, OpenAI's or
// TikTok's conversion endpoints would be wrong, not merely unsupported. uploadConversions
// therefore maps and validates the contract's fields and refuses BEFORE any call with
// PROVIDER_INVALID_INPUT — no Zernio conversion endpoint is ever called, nothing is uploaded,
// and no conversion event leaves the app.
//
// Tenth implemented operation: disconnectAccount — DELETE /v1/accounts/{accountId}
// (docs.zernio.com/accounts/delete-account, fetched 2026-10-06). The documented
// intentional-disconnect path: it disconnects and removes the connected account from the Zernio
// profile. The path parameter is the account's provider_account_ref (the same Zernio
// SocialAccount id the other operations already address). The documented 200 response is
// { message: "Account disconnected successfully" } and carries NO budget/spend information, so
// the contract's budget_end_confirmed is honestly FALSE — never inferred. A documented 404
// (the account is already disconnected and sitting in its 1h grace window) surfaces as
// PROVIDER_ERROR with the documented reason; the surface has already short-circuited its own
// already-disconnected state before the adapter runs. No campaign is mutated here — the
// surface stamps the row disconnected after the provider confirmed the delete, per its
// existing certified behavior.
//
// Confirmed contract (docs.zernio.com, fetched 2026-10-06):
//   • auth: `Authorization: Bearer <ZERNIO_API_KEY>` (quickstep + list-ad-campaigns bearerAuth);
//   • endpoint: GET https://zernio.com/api/v1/ads/campaigns — campaigns are aggregations over
//     ad documents; campaign status is derived from child ad statuses; metrics are summed;
//   • filters used: platform (one value — tiktok/linkedin/openai map 1:1; zernio:meta sends NO
//     platform filter because the endpoint's "facebook"/"instagram" values are the two halves
//     of Meta and a filter would silently drop Instagram rows), accountId (the Zernio account
//     id — the project's AdsAccount.provider_account_ref) and limit (100, the documented max).
// No ZERNIO_API_KEY is provisioned for this app: syncCampaigns therefore ALSO fails closed
// with PROVIDER_NOT_CONFIGURED until the key exists. The key is read from process.env only,
// never returned, logged or included in any error detail.
//
// `deps.fetcher` is injectable so the certification can drive the mapping deterministically
// with ZERO network activity (the same injection pattern as the provider seam opts.provider).
// Production never passes one — the platform fetch runs.
//
// `deps.apiKey` is the credential's certification seam: when set, every implemented operation
// uses it INSTEAD of process.env.ZERNIO_API_KEY, so certifications exercise the configured
// paths with ZERO process.env mutation (concurrent certification runs share one runtime and
// used to poison each other's key dance). Production never passes one — the key is read from
// process.env only, never returned, logged or included in any error detail.

import { PROVIDER_OPERATIONS } from "./googleAdsProvider.ts";

export const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";

/** channel -> the single Zernio `platform` query value; meta stays unfiltered (see header). */
const CHANNEL_PLATFORM = {
  "zernio:tiktok": "tiktok",
  "zernio:linkedin": "linkedin",
  "zernio:openai": "openai",
};

/** Documented derived campaign status -> the NexusAI serving state, ONLY where unambiguous.
 *  Everything else passes through verbatim (completed/cancelled/error/rejected) — never guessed. */
const STATUS_MAP = {
  active: "ENABLED",
  paused: "PAUSED",
  pending_review: "PENDING",
};

const zernioNotConfigured = (op, channel) => Object.assign(
  new Error(`Zernio Ads provider is not configured — "${op}" on channel "${channel}" requires ZERNIO_API_KEY. No Zernio API call was made.`),
  { code: "PROVIDER_NOT_CONFIGURED", status: 409, retryable: false },
);

const zernioUnimplemented = (op, channel) => Object.assign(
  new Error(`Zernio Ads "${op}" on channel "${channel}" is not implemented yet — the adapter implements syncCampaigns, pauseCampaign, resumeCampaign, updateCampaign, deleteCampaign, bulkBudgets, acceptAsset, mapConversion, uploadConversions and disconnectAccount only. No Zernio API call was made.`),
  { code: "PROVIDER_UNIMPLEMENTED", status: 409, retryable: false },
);

/** A refusal issued BEFORE any call (missing provider id, unresolved meta platform). */
const zernioBadInput = (op, channel, why) => Object.assign(
  new Error(`Zernio Ads "${op}" on channel "${channel}" refused before any call: ${why}. No Zernio API call was made.`),
  { code: "PROVIDER_INVALID_INPUT", status: 409, retryable: false },
);

/** One documented Zernio campaign -> the syncCampaigns return row the surface consumes
 *  (provider_campaign_id, status, review_status, serving_status, metrics). */
export function mapZernioCampaign(c = {}) {
  const m = c.metrics || {};
  const spend = Number(m.spend || 0);
  return {
    provider_campaign_id: c.platformCampaignId != null && String(c.platformCampaignId).trim()
      ? String(c.platformCampaignId) : null,
    campaign_name: String(c.campaignName || "").slice(0, 200),
    currency: c.currency != null ? String(c.currency) : null,
    status: STATUS_MAP[String(c.status || "")] || String(c.status || ""),
    review_status: c.reviewStatus != null ? String(c.reviewStatus) : "",
    serving_status: Array.isArray(c.servingStatuses) && c.servingStatuses.length
      ? c.servingStatuses.join(",")
      : (c.servingStatus != null ? String(c.servingStatus) : ""),
    metrics: {
      impressions: Number(m.impressions || 0),
      clicks: Number(m.clicks || 0),
      spend,
      conversions: Number(m.conversions || 0),
      ctr: Number(m.ctr || 0),
      // Zernio reports spend in the campaign's own currency units; micros follow the documented
      // 1,000,000 micros = one unit convention.
      cost_micros: Math.round(spend * 1e6),
    },
  };
}

// Paginated sync. The documented response carries `pagination { page, limit, total, pages }`;
// every page is read up to SYNC_MAX_PAGES. `complete` is false when the cap stopped the walk
// (or a page came back short of the reported total) — never silently reported as complete.
// `window` (optional { fromDate, toDate }, YYYY-MM-DD) scopes the summed metrics to a period
// (documented fromDate/toDate). Without it Zernio's documented default is the trailing 90 days.
export const SYNC_MAX_PAGES = 10;
async function syncCampaigns({ channel, account, fetcher, apiKey, window = null }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("syncCampaigns", channel);
  const all = [];
  let page = 1, pages = 1, total = null;
  do {
    const out = await syncCampaignsPage({ channel, account, fetcher, key, window, page });
    all.push(...out.campaigns);
    pages = out.pages; total = out.total;
    page += 1;
  } while (page <= pages && page <= SYNC_MAX_PAGES);
  const complete = page > pages && (total == null || all.length >= total);
  return {
    campaigns: all.map(mapZernioCampaign).filter((c) => c.provider_campaign_id),
    complete,
    provider_total: total,
    metrics_window: window
      ? { from: window.fromDate, to: window.toDate, basis: "period" }
      : { from: null, to: null, basis: "trailing_90_days" },
  };
}

async function syncCampaignsPage({ channel, account, fetcher, key, window, page }) {
  const params = new URLSearchParams();
  params.set("limit", "100");
  const platform = CHANNEL_PLATFORM[channel];
  if (platform) params.set("platform", platform);
  if (account?.provider_account_ref) params.set("accountId", String(account.provider_account_ref));
  if (window?.fromDate) params.set("fromDate", window.fromDate);
  if (window?.toDate) params.set("toDate", window.toDate);
  if (page > 1) params.set("page", String(page));
  let res;
  try {
    res = await fetcher(`${ZERNIO_API_BASE_URL}/ads/campaigns?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Zernio /ads/campaigns request failed: ${String(e?.message || e).slice(0, 200)}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error(`Zernio rejected the API key (HTTP ${res.status})`),
      { code: "PROVIDER_AUTH_FAILED", status: 502, retryable: false },
    );
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(`Zernio /ads/campaigns returned HTTP ${res.status}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  const body = await res.json().catch(() => ({}));
  const p = body?.pagination || null;
  return {
    campaigns: (Array.isArray(body?.campaigns) ? body.campaigns : []).slice(0, 100),
    pages: Number(p?.pages) > 0 ? Number(p.pages) : 1,
    total: p && Number.isFinite(Number(p.total)) ? Number(p.total) : null,
  };
}

/** Zernio SocialAccount.platform per ads channel (documented enum on GET /v1/accounts). */
export const ZERNIO_ACCOUNT_PLATFORM = {
  "zernio:meta": "metaads",
  "zernio:tiktok": "tiktokads",
  "zernio:linkedin": "linkedinads",
  "zernio:openai": "openaiads",
};

/**
 * READ-ONLY: the ad accounts already connected in Zernio for one channel
 * (GET /v1/accounts?category=ads&platform=…, documented page/limit pagination).
 * Never creates or changes anything on Zernio. `complete` is false when the page cap stopped
 * the walk.
 */
export async function listZernioAdAccounts({ channel, fetcher = fetch.bind(globalThis), apiKey } = {}) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("listAdAccounts", channel);
  const platform = ZERNIO_ACCOUNT_PLATFORM[channel];
  if (!platform) throw zernioBadInput("listAdAccounts", channel, "the channel has no Zernio ad-account platform");
  const accounts = [];
  let page = 1, pages = 1;
  do {
    const params = new URLSearchParams({ category: "ads", platform, page: String(page), limit: "100" });
    let res;
    try {
      res = await fetcher(`${ZERNIO_API_BASE_URL}/accounts?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw Object.assign(new Error(`Zernio /accounts request failed: ${String(e?.message || e).slice(0, 200)}`), { code: "PROVIDER_ERROR", status: 502, retryable: false });
    }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Zernio rejected the API key (HTTP ${res.status})`), { code: "PROVIDER_AUTH_FAILED", status: 502, retryable: false });
    if (!res.ok) throw Object.assign(new Error(`Zernio /accounts returned HTTP ${res.status}`), { code: "PROVIDER_ERROR", status: 502, retryable: false });
    const body = await res.json().catch(() => ({}));
    for (const a of Array.isArray(body?.accounts) ? body.accounts : []) {
      if (!a?._id || a.platform !== platform) continue;
      accounts.push({
        provider_account_ref: String(a._id),
        name: String(a.displayName || a.username || a._id).slice(0, 200),
        is_active: a.isActive !== false && !a.needsReconnection,
      });
    }
    pages = Number(body?.pagination?.pages) > 0 ? Number(body.pagination.pages) : 1;
    page += 1;
  } while (page <= pages && page <= SYNC_MAX_PAGES);
  return { accounts, complete: page > pages };
}

/** One documented PUT .../status response (pause AND resume) -> the return the surface consumes
 *  ({ campaign: { status, serving_status } } merged over the stored row). platformCampaignStatus
 *  is the platform's own raw vocabulary (TikTok DISABLE/ENABLE, OpenAI status) — verbatim, never
 *  mapped. A skipped write (the live read already showed the requested state) maps identically. */
export function mapZernioStatusResponse(body = {}) {
  return {
    campaign: {
      status: body?.status === "active" ? "ENABLED" : "PAUSED",
      serving_status: body?.platformCampaignStatus != null ? String(body.platformCampaignStatus) : "",
      provider_write: {
        updated: Number(body?.updated ?? 0),
        skipped: Number(body?.skipped ?? 0),
        skipped_reasons: Array.isArray(body?.skippedReasons) ? body.skippedReasons.slice(0, 5).map(String) : [],
      },
    },
  };
}

async function setCampaignStatus({ op, wanted, channel, campaign, fetcher, apiKey }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured(op, channel);
  // The endpoint REQUIRES a single platform value; meta spans two halves and the stored row
  // carries no half — refusing beats guessing a wrong half.
  const platform = CHANNEL_PLATFORM[channel];
  if (!platform) throw zernioBadInput(op, channel,
    `channel "${channel}" spans the facebook and instagram halves and the stored campaign does not declare its half`);
  const id = campaign?.provider_campaign_id != null ? String(campaign.provider_campaign_id).trim() : "";
  if (!id) throw zernioBadInput(op, channel,
    "the campaign has no provider_campaign_id — it was never created on the provider");
  let res;
  try {
    res = await fetcher(`${ZERNIO_API_BASE_URL}/ads/campaigns/${encodeURIComponent(id)}/status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ status: wanted, platform }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Zernio campaign status request failed: ${String(e?.message || e).slice(0, 200)}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error(`Zernio rejected the API key (HTTP ${res.status})`),
      { code: "PROVIDER_AUTH_FAILED", status: 502, retryable: false },
    );
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(`Zernio PUT /ads/campaigns/${id}/status returned HTTP ${res.status}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  const body = await res.json().catch(() => ({}));
  return mapZernioStatusResponse(body);
}

// The SAME documented switch endpoint on both sides of the switch — the only difference is the
// requested state in the body; the response mapping, errors and refusals are identical.
const pauseCampaign = ({ channel, campaign, fetcher, apiKey }) =>
  setCampaignStatus({ op: "pauseCampaign", wanted: "paused", channel, campaign, fetcher, apiKey });

const resumeCampaign = ({ channel, campaign, fetcher, apiKey }) =>
  setCampaignStatus({ op: "resumeCampaign", wanted: "active", channel, campaign, fetcher, apiKey });

/** One documented PUT .../campaigns/{id} response -> the updateCampaign return the surface
 *  consumes ({ campaign: ... } merged over the stored row). The budget object and budgetLevel
 *  pass through VERBATIM (never mapped); `updated` is the documented write provenance. No
 *  status is carried — the update endpoint does not change the campaign's serving switch. */
export function mapZernioUpdateResponse(body = {}) {
  return {
    campaign: {
      provider_write: {
        updated: Number(body?.updated ?? 0),
        budget: body?.budget ?? null,
        budget_level: body?.budgetLevel != null ? String(body.budgetLevel) : "",
      },
    },
  };
}

// Campaign edits. The documented update endpoint serves a NARROW field set per platform
// (docs.zernio.com/ad-campaigns/update-ad-campaign, fetched 2026-10-06): budget edits are
// "OpenAI: daily or lifetime; others 501" and renames are Meta-only (501 elsewhere). The
// contract's patch carries only campaign_name and daily_budget_micros, so the ONLY mappable
// field is the daily budget on zernio:openai — every other patch refuses BEFORE any call
// rather than sending a request that cannot succeed.
const BUDGET_CHANNELS = { openai: "daily" };

async function updateCampaign({ channel, campaign, patch, fetcher, apiKey }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("updateCampaign", channel);
  const platform = CHANNEL_PLATFORM[channel];
  if (!platform) throw zernioBadInput("updateCampaign", channel,
    `channel "${channel}" spans the facebook and instagram halves and the stored campaign does not declare its half`);
  const id = campaign?.provider_campaign_id != null ? String(campaign.provider_campaign_id).trim() : "";
  if (!id) throw zernioBadInput("updateCampaign", channel,
    "the campaign has no provider_campaign_id — it was never created on the provider");
  const hasName = patch?.campaign_name !== undefined;
  const hasBudget = patch?.daily_budget_micros !== undefined;
  if (!hasName && !hasBudget) throw zernioBadInput("updateCampaign", channel,
    "the patch is empty — Zernio requires at least one supported field");
  if (hasName) throw zernioBadInput("updateCampaign", channel,
    "campaign renames are Meta-only on Zernio (501 on every other platform) and the stored Meta campaign does not declare its platform half");
  if (!BUDGET_CHANNELS[platform]) throw zernioBadInput("updateCampaign", channel,
    `budget updates are documented 501 on Zernio's "${platform}" platform (daily/lifetime budget edits are served for OpenAI Ads only)`);
  const amount = Number(patch.daily_budget_micros) / 1e6;
  if (!Number.isInteger(amount)) throw zernioBadInput("updateCampaign", channel,
    "the daily budget is not a whole number of currency units (Zernio carries whole-unit budgets) — refusing instead of rounding");
  return mapZernioUpdateResponse(await putZernioBudget({ platform, id, amount, fetcher, apiKey }));
}

/** The documented single-campaign budget write — PUT /v1/ads/campaigns/{campaignId} with
 *  { platform, budget: { amount, type } } — SHARED verbatim by updateCampaign (the single
 *  edit) and bulkBudgets (the composed one): the same endpoint, body, auth and error
 *  mapping for both. */
async function putZernioBudget({ platform, id, amount, fetcher, apiKey }) {
  let res;
  try {
    res = await fetcher(`${ZERNIO_API_BASE_URL}/ads/campaigns/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey || process.env.ZERNIO_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ platform, budget: { amount, type: BUDGET_CHANNELS[platform] } }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Zernio campaign update request failed: ${String(e?.message || e).slice(0, 200)}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error(`Zernio rejected the API key (HTTP ${res.status})`),
      { code: "PROVIDER_AUTH_FAILED", status: 502, retryable: false },
    );
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(`Zernio PUT /ads/campaigns/${id} returned HTTP ${res.status}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  return res.json().catch(() => ({}));
}

// BULK budgets. Zernio publishes NO bulk-budget endpoint — the only documented bulk path is
// POST /v1/ads/campaigns/bulk-status, which writes STATUS and never budgets — so bulkBudgets
// is a BOUNDED, NON-ATOMIC composition over the documented single-campaign budget write
// (putZernioBudget above; OpenAI daily budgets only), in the SAME non-atomic shape the
// Google contract documents: { succeeded: [id], failed: [{ campaign_id, reason }] } — the
// response lists the ones that worked and the rest; one bad entry never fails the batch.
// Entries carry the contract's campaign_id + daily_budget_micros; the provider call also
// reads the entry's provider_campaign_id — the platform id the documented path addresses.
// Whole-op refusals BEFORE any call (no key, empty entries, more than the 50-entry bound,
// meta's undeclared half, the documented-501 budget platforms) throw; per-entry refusals
// (a missing provider id, a non-whole-unit budget) land in `failed` with a reason and ZERO
// calls for that entry — never a request the documentation says cannot succeed. A Zernio
// 401 on one entry fails the batch and the remaining entries are aborted without further
// calls.
const BULK_BUDGETS_BOUND = 50;

async function bulkBudgets({ channel, entries, fetcher, apiKey }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("bulkBudgets", channel);
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw zernioBadInput("bulkBudgets", channel,
    "entries is required — at least one campaign budget");
  if (list.length > BULK_BUDGETS_BOUND) throw zernioBadInput("bulkBudgets", channel,
    `entries exceeds the contract's bound (${list.length} > ${BULK_BUDGETS_BOUND})`);
  const platform = CHANNEL_PLATFORM[channel];
  if (!platform) throw zernioBadInput("bulkBudgets", channel,
    `channel "${channel}" spans the facebook and instagram halves and the stored campaigns do not declare their half`);
  if (!BUDGET_CHANNELS[platform]) throw zernioBadInput("bulkBudgets", channel,
    `budget updates are documented 501 on Zernio's "${platform}" platform (daily/lifetime budget edits are served for OpenAI Ads only)`);
  const succeeded = [];
  const failed = [];
  let aborted = null;
  for (const entry of list) {
    const cid = entry?.campaign_id != null ? String(entry.campaign_id) : "";
    if (aborted) {
      failed.push({ campaign_id: cid, reason: aborted });
      continue;
    }
    const id = entry?.provider_campaign_id != null ? String(entry.provider_campaign_id).trim() : "";
    if (!id) {
      failed.push({ campaign_id: cid, reason: "the campaign has no provider_campaign_id — it was never created on the provider" });
      continue;
    }
    const amount = Number(entry?.daily_budget_micros) / 1e6;
    if (!(amount > 0) || !Number.isInteger(amount)) {
      failed.push({ campaign_id: cid, reason: "the daily budget is not a positive whole number of currency units (Zernio carries whole-unit budgets) — refusing instead of rounding" });
      continue;
    }
    try {
      await putZernioBudget({ platform, id, amount, fetcher, apiKey });
      succeeded.push(cid);
    } catch (e) {
      if (e?.code === "PROVIDER_AUTH_FAILED") aborted = "aborted: Zernio rejected the API key";
      failed.push({ campaign_id: cid, reason: String(e?.message || e).slice(0, 200) });
    }
  }
  return { succeeded, failed };
}

// ASSET accept. The ONLY documented Zernio asset-attach path is attachCampaignAssets —
// POST /v1/ads/campaigns/{campaignId}/assets — which the documentation restricts to
// x-platforms: google (the documented error table answers 501: "Only supported on Google
// Ads"). The registered Zernio channels are meta, tiktok, linkedin and openai, and the google
// channel stays on its own DIRECT adapter — so no registered Zernio channel documents an asset
// accept at all. acceptAsset maps the contract's fields, validates them, and refuses BEFORE
// any call with the documented-501 refusal (PROVIDER_INVALID_INPUT) — never a request the
// documentation says cannot succeed; campaign status and budget are never touched.
async function acceptAsset({ channel, sessionAssetId, assetFieldType, content, apiKey }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("acceptAsset", channel);
  if (!String(sessionAssetId || "").trim() || !String(assetFieldType || "").trim() || !String(content || "").trim()) {
    throw zernioBadInput("acceptAsset", channel,
      "sessionAssetId, assetFieldType and content are required (the contract's acceptAsset fields)");
  }
  throw zernioBadInput("acceptAsset", channel,
    `campaign asset attach is documented ONLY for Google Ads on Zernio (attachCampaignAssets, x-platforms: google; 501 on every other platform) and channel "${channel}" is not Google`);
}

// CONVERSION mapping. The documented conversion-mapping endpoints leave no registered Zernio
// channel a live path (see the header): the conversion-action creation is Google-only (501
// elsewhere), Meta/OpenAI destinations are documented 405 (the tracking-tags flow instead),
// the LinkedIn destination path needs a body adAccountId the contract's { mapping } args do
// not carry, and TikTok conversions are undocumented. mapConversion therefore maps and
// validates the contract's fields, then refuses BEFORE any call with the channel's documented
// refusal — no Zernio conversion endpoint is ever called.
async function mapConversion({ channel, mapping, apiKey }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("mapConversion", channel);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw zernioBadInput("mapConversion", channel,
      "mapping is required (the contract's mapConversion input)");
  }
  if (!String(mapping.app_event_name || "").trim()) {
    throw zernioBadInput("mapConversion", channel,
      "the mapping carries no app_event_name — the app event the provider conversion action maps");
  }
  if (!String(mapping.conversion_action_name || "").trim()) {
    throw zernioBadInput("mapConversion", channel,
      "the mapping carries no conversion_action_name — the human name of the provider conversion action");
  }
  if (channel === "zernio:linkedin") {
    throw zernioBadInput("mapConversion", channel,
      "the documented LinkedIn path (POST /v1/accounts/{accountId}/conversion-destinations) requires a body adAccountId the mapConversion contract does not carry ({ mapping } only) — refusing before any call instead of guessing");
  }
  if (channel === "zernio:meta" || channel === "zernio:openai") {
    const platform = channel.slice("zernio:".length);
    throw zernioBadInput("mapConversion", channel,
      `conversion destination creation is documented 405 on Zernio for "${platform}" (pixels are created via the tracking-tags flow, POST /v1/accounts/{accountId}/tracking-tags)`);
  }
  throw zernioBadInput("mapConversion", channel,
    'conversion mapping is not documented for Zernio\'s "tiktok" platform (the conversions endpoints cover googleads and linkedinads destinations, plus the Meta/OpenAI tracking-tags flow)');
}

// CONVERSION-EVENT upload. The documented conversion-event path (POST /v1/ads/conversions)
// requires the Zernio accountId and a channel-scoped destinationId the contract's
// { mappings, events } args do not carry — and no registered Zernio channel can ever hold a
// destination ref (mapConversion refuses on every one of them). mapConversion therefore maps
// and validates the contract's fields, then refuses BEFORE any call — no Zernio conversion
// endpoint is ever called and nothing is uploaded (see the header).
async function uploadConversions({ channel, mappings, events, apiKey }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("uploadConversions", channel);
  if (!Array.isArray(mappings) || !mappings.length) {
    throw zernioBadInput("uploadConversions", channel,
      "mappings is required — at least one mapped conversion action (the contract's uploadConversions args)");
  }
  if (!Array.isArray(events) || !events.length) {
    throw zernioBadInput("uploadConversions", channel,
      "events is required — at least one conversion event to send (the contract's uploadConversions args)");
  }
  throw zernioBadInput("uploadConversions", channel,
    'the documented conversion-event path (POST /v1/ads/conversions) requires the Zernio accountId and a channel-scoped destinationId the contract\'s args ({ mappings, events }) do not carry — mapConversion refuses on every registered Zernio channel, so no mapping can ever carry a Zernio destination; refusing before any call instead of sending another platform\'s destination ref');
}

// ACCOUNT disconnect. The documented intentional-disconnect path —
// DELETE /v1/accounts/{accountId} — removes the connected account from the Zernio profile. The
// response's documented message passes through verbatim; the contract's budget_end_confirmed
// is honestly false (the documented response carries no budget/spend information).
export function mapZernioDisconnectResponse(body = {}) {
  return { message: body?.message != null ? String(body.message) : "" };
}

async function disconnectAccount({ channel, account, fetcher, apiKey }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("disconnectAccount", channel);
  const id = account?.provider_account_ref != null ? String(account.provider_account_ref).trim() : "";
  if (!id) throw zernioBadInput("disconnectAccount", channel,
    "the account has no provider_account_ref — it was never created on the provider");
  let res;
  try {
    res = await fetcher(`${ZERNIO_API_BASE_URL}/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Zernio account disconnect request failed: ${String(e?.message || e).slice(0, 200)}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error(`Zernio rejected the API key (HTTP ${res.status})`),
      { code: "PROVIDER_AUTH_FAILED", status: 502, retryable: false },
    );
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(`Zernio DELETE /accounts/${id} returned HTTP ${res.status}` +
        (res.status === 404 ? " (the documented response for an account already disconnected — its grace window is still running)" : "")),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  const body = await res.json().catch(() => ({}));
  return { ...mapZernioDisconnectResponse(body), budget_end_confirmed: false };
}

/** One documented DELETE .../campaigns/{id} response -> the deleteCampaign return the surface
 *  consumes ({ campaign: ... }). The surface discards it (it stamps REMOVED itself after the
 *  provider confirmed the delete); `deleted` and `adCount` pass through verbatim. */
export function mapZernioDeleteResponse(body = {}) {
  return {
    campaign: {
      provider_write: {
        deleted: Boolean(body?.deleted),
        ad_count: Number(body?.adCount ?? 0),
      },
    },
  };
}

// Permanent campaign delete. The documented delete endpoint requires `platform` in the body
// and optionally reads `accountId` to resolve an EMPTY campaign (zero ads) — it is ignored
// otherwise, so sending it whenever the account reference exists can only help that case.
async function deleteCampaign({ channel, campaign, account, fetcher, apiKey }) {
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("deleteCampaign", channel);
  const platform = CHANNEL_PLATFORM[channel];
  if (!platform) throw zernioBadInput("deleteCampaign", channel,
    `channel "${channel}" spans the facebook and instagram halves and the stored campaign does not declare its half`);
  const id = campaign?.provider_campaign_id != null ? String(campaign.provider_campaign_id).trim() : "";
  if (!id) throw zernioBadInput("deleteCampaign", channel,
    "the campaign has no provider_campaign_id — it was never created on the provider");
  const reqBody = { platform };
  const accountId = account?.provider_account_ref != null ? String(account.provider_account_ref).trim() : "";
  if (accountId) reqBody.accountId = accountId;
  let res;
  try {
    res = await fetcher(`${ZERNIO_API_BASE_URL}/ads/campaigns/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Zernio campaign delete request failed: ${String(e?.message || e).slice(0, 200)}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error(`Zernio rejected the API key (HTTP ${res.status})`),
      { code: "PROVIDER_AUTH_FAILED", status: 502, retryable: false },
    );
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(`Zernio DELETE /ads/campaigns/${id} returned HTTP ${res.status}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  const body = await res.json().catch(() => ({}));
  return mapZernioDeleteResponse(body);
}

// OPENAI ADS connection. The DOCUMENTED Zernio credentials-connect path —
// POST /v1/connect/openai-ads/credentials (docs.zernio.com/platforms/openai-ads#connect +
// openapi.yaml /v1/connect/openai-ads/credentials, fetched 2026-10-06): Zernio validates the
// member's ChatGPT Ads Manager key against OpenAI BEFORE storing anything, and reposting a
// rotated key for the same ad account updates the connection in place (documented
// idempotency). This is NOT a campaign adapter operation — the certified 11-op contract above
// is untouched. The member's key travels to Zernio ONCE in the documented request body and is
// NEVER stored, logged or echoed by this app; only the returned account identity is mapped.
// Documented errors: 401 with code invalid_credentials = the member's key cannot read an
// OpenAI ad account (distinct from a rejected ZERNIO_API_KEY); 402 PAYMENT_REQUIRED with
// reason + dashboard_url (Zernio's billing gate, closed before the key is even checked);
// 403 = the Ads add-on is required.
export async function connectZernioOpenAIAds({ userApiKey, profileId, fetcher: injectedFetcher, apiKey } = {}) {
  const fetcher = injectedFetcher || fetch.bind(globalThis);
  const key = apiKey || process.env.ZERNIO_API_KEY;
  if (!key) throw zernioNotConfigured("account_connect", "zernio:openai");
  if (!String(userApiKey || "").trim() || !String(profileId || "").trim()) {
    throw zernioBadInput("account_connect", "zernio:openai",
      "the member's OpenAI Ads key and the Zernio profileId are required");
  }
  let res;
  try {
    res = await fetcher(`${ZERNIO_API_BASE_URL}/connect/openai-ads/credentials`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apiKey: userApiKey, profileId }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw Object.assign(
      new Error(`Zernio OpenAI Ads connect request failed: ${String(e?.message || e).slice(0, 200)}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  if (res.status === 402) {
    const pay = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error(`Zernio closed the OpenAI Ads connection behind its billing gate (reason: ${pay?.reason || "unknown"}); the member resolves it on their Zernio dashboard. No connection was made.`),
      { code: "PROVIDER_PAYMENT_REQUIRED", status: 402, reason: pay?.reason || null, dashboard_url: pay?.dashboard_url || null, retryable: false },
    );
  }
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && body?.code === "invalid_credentials") {
      throw Object.assign(
        new Error("the member's OpenAI Ads key could not read an OpenAI ad account (documented invalid_credentials) — no connection was made"),
        { code: "PROVIDER_INVALID_CREDENTIALS", status: 401, retryable: false },
      );
    }
    throw Object.assign(
      new Error(`Zernio rejected the connect request (HTTP ${res.status})`),
      { code: "PROVIDER_AUTH_FAILED", status: 502, retryable: false },
    );
  }
  if (!res.ok) {
    throw Object.assign(
      new Error(`Zernio POST /connect/openai-ads/credentials returned HTTP ${res.status}`),
      { code: "PROVIDER_ERROR", status: 502, retryable: false },
    );
  }
  const body = await res.json().catch(() => ({}));
  const accountId = body?.accountId != null ? String(body.accountId).trim() : "";
  if (!accountId) {
    throw zernioBadInput("account_connect", "zernio:openai",
      "the documented response carries no accountId — refusing rather than persisting an unusable connection");
  }
  return {
    provider_account_ref: accountId,
    ad_account_name: body?.adAccountName != null ? String(body.adAccountName) : "",
  };
}

/**
 * The Zernio runtime adapter: the SAME 11-op contract as the Google adapter. syncCampaigns,
 * pauseCampaign, resumeCampaign, updateCampaign and deleteCampaign are implemented (live only
 * once ZERNIO_API_KEY exists); every other operation fails closed. `deps.fetcher` is the
 * certification's deterministic network seam.
 */
export function createZernioAdsProvider(channel, deps = {}) {
  const fetcher = deps.fetcher || fetch.bind(globalThis);
  const provider = {};
  const IMPLEMENTED_OPS = { pauseCampaign, resumeCampaign, updateCampaign, deleteCampaign, bulkBudgets, acceptAsset, mapConversion, uploadConversions, disconnectAccount };
  for (const op of PROVIDER_OPERATIONS) {
    const implemented = op === "syncCampaigns" ? syncCampaigns : IMPLEMENTED_OPS[op] || null;
    if (implemented) {
      provider[op] = async (args = {}) => implemented({ channel, window: args.window || null, campaign: args.campaign, account: args.account, patch: args.patch, entries: args.entries, mapping: args.mapping, mappings: args.mappings, events: args.events, sessionAssetId: args.sessionAssetId, assetFieldType: args.assetFieldType, content: args.content, fetcher, apiKey: deps.apiKey });
    } else {
      provider[op] = async () => { throw zernioUnimplemented(op, channel); };
    }
  }
  return provider;
}