// NexusAI Google Ads foundation — the project-scoped service surface over the documented
// Base44 Google Ads contract (behavior target: docs.base44.com Google Ads campaigns guide +
// the Apps API google-ads section). STANDALONE: no Base44 APIs, no Base44 PAT, no app_id.
//
// What this foundation owns (per the completed audit):
//   • the project-level ONE-account model (an app has at most one ads account; reads return
//     null with a 200 when there is none — the documented normal state);
//   • campaign, brief, asset-session, change-log and conversion-mapping persistence with the
//     documented lifecycle/state fields;
//   • the service boundary for accounts, campaigns, briefs, assets and conversions;
//   • every LIVE provider operation behind the dedicated adapter (googleAdsProvider.ts), which
//     fails closed with PROVIDER_NOT_CONFIGURED until the external Google Ads infrastructure
//     (developer token / MCC / OAuth credentials) is provisioned. No simulated live results.
//
// What is deliberately NOT here (audit NON-PARITY, never claimed as Base44 behavior):
//   billing charges or the 15% service fee (Base44 bills clicks itself), Google OAuth scopes,
//   provisioning handshake internals, the 20/10-per-minute generation pools (they are a
//   documented property of Base44's generation infrastructure, not of this data model), and
//   any field Base44's docs do not name. Generation produces PREVIEWS only — the documented
//   accept step is the sole route onto a live campaign and requires the provider.

import { audit } from "./authz.ts";
import { notConfigured, providerConfigured } from "./googleAdsProvider.ts";
import { normalizeAdsChannel, resolveAdsProvider, isChannelConfigured } from "./adsProviderRegistry.ts";
import { runWeeklyAdsReport, listAdsReports, scheduleWeeklyAdsReport } from "./adsReporting.ts";
import { createGateway, pickModel } from "./modelGateway.ts";
import { budgetBoundaries } from "./googleAdsBudgetBoundaries.ts";
import { connectZernioOpenAIAds, listZernioAdAccounts } from "./zernioAdsProvider.ts";
import { startZernioMetaConnect } from "./zernioMetaConnect.ts";
import { syncAndImportCampaigns } from "./adsCampaignImport.ts";
import { loadPlanContext } from "./briefPlanContext.ts";

// The production PREVIEW generators. Copy runs through the EXISTING model gateway (structured
// output); pictures run through the existing Core image generation. Neither is a Google Ads
// provider call — both only produce previews the accept step (provider-gated) can later use.
export function createDefaultGenerators(base44) {
  const gateway = createGateway(base44);
  return {
    async brief({ project, campaign_type, goal, audience, plan_context }) {
      const model = pickModel("standard");
      const background = plan_context ? `\n\nBackground from the project's marketing plan (context only; do not copy verbatim, do not invent claims): ${JSON.stringify(plan_context)}` : "";
      const res = await gateway.generate(model, {
        system: "You write Google Ads campaign copy. Reply ONLY with JSON matching the schema.",
        messages: [{ role: "user", content: `App: ${project.name}. Campaign type: ${campaign_type}. Goal: ${goal || "promote the app"}. Audience: ${audience || "general"}. Write up to 10 headlines (max 30 chars each), up to 5 descriptions (max 90 chars each) and 5 keyword themes. Write in the app's language.${background}` }],
        jsonSchema: { type: "object", properties: { headlines: { type: "array", items: { type: "string" } }, descriptions: { type: "array", items: { type: "string" } }, keywords: { type: "array", items: { type: "string" } }, language: { type: "string" } }, required: ["headlines", "descriptions"] },
        maxAttempts: 2,
      });
      return res.output || {};
    },
    async text({ project, campaign_type, asset_field_types, final_url }) {
      const model = pickModel("standard");
      const res = await gateway.generate(model, {
        system: "You write Google Ads asset copy. Reply ONLY with JSON matching the schema.",
        messages: [{ role: "user", content: `App: ${project.name}. Campaign type: ${campaign_type}. Landing page: ${final_url || "the app's main page"}. For each asset_field_type (${asset_field_types.join(", ")}) write lines in the app's language: HEADLINE max 30 chars, DESCRIPTION max 90 chars, LONG_HEADLINE max 90 chars. Return 3 lines per type.` }],
        jsonSchema: { type: "object", properties: { lines: { type: "array", items: { type: "object", properties: { asset_field_type: { type: "string" }, content: { type: "string" } }, required: ["asset_field_type", "content"] } }, language: { type: "string" } }, required: ["lines"] },
        maxAttempts: 2,
      });
      return { lines: (res.output?.lines || []).filter((l) => asset_field_types.includes(l.asset_field_type)), language: res.output?.language || null };
    },
    async images({ project, campaign_type, asset_field_types, final_url, freeform_prompt }) {
      const base = freeform_prompt || `Promotional visual for the app "${project.name}" based on ${final_url}`;
      const shapeText = { LANDSCAPE_IMAGE: "landscape 1.91:1 wide", SQUARE_IMAGE: "square 1:1", PORTRAIT_IMAGE: "portrait 4:5", TALL_PORTRAIT_IMAGE: "tall portrait 9:16" };
      const done = [];
      for (const slot of asset_field_types) {
        const img = await base44.asServiceRole.integrations.Core.GenerateImage({ prompt: `${base}. Composition: ${shapeText[slot]}. Clean, modern, no text overlay.` });
        if (img?.url) done.push({ asset_field_type: slot, url: img.url });
      }
      // Previews that did not finish in time are reported, never faked.
      return { images: done, background_image_count: Math.max(0, asset_field_types.length - done.length), language: null };
    },
  };
}

const nowIso = () => new Date().toISOString();

export const CAMPAIGN_TYPES = ["PERFORMANCE_MAX", "DEMAND_GEN", "SEARCH", "DISPLAY"];
export const LAUNCH_TYPES = ["SMART", "PERFORMANCE_MAX"];
// DOCUMENTED (Base44): which slots each channel type fills.
const TEXT_SLOTS = { SEARCH: ["HEADLINE", "DESCRIPTION"], DISPLAY: ["HEADLINE", "DESCRIPTION", "LONG_HEADLINE"], PERFORMANCE_MAX: ["HEADLINE", "DESCRIPTION", "LONG_HEADLINE"], DEMAND_GEN: ["HEADLINE", "DESCRIPTION", "LONG_HEADLINE"] };
const IMAGE_SLOTS = { SEARCH: ["LANDSCAPE_IMAGE", "SQUARE_IMAGE"], DISPLAY: ["LANDSCAPE_IMAGE", "SQUARE_IMAGE"], PERFORMANCE_MAX: ["LANDSCAPE_IMAGE", "SQUARE_IMAGE", "PORTRAIT_IMAGE", "TALL_PORTRAIT_IMAGE"], DEMAND_GEN: ["LANDSCAPE_IMAGE", "SQUARE_IMAGE", "PORTRAIT_IMAGE", "TALL_PORTRAIT_IMAGE"] };

const err = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

// Fail closed BEFORE resolving or mutating anything: a live operation without the external
// Google Ads infrastructure is refused with the provider gate, never a resource-level error.
// `providerLive` is true when the external gate is open OR an adapter was injected (the
// certification) — a caller that supplies an adapter takes responsibility for its wiring;
// production never passes one, so unconfigured production always refuses.
const requireProvider = (operation, providerLive) => {
  if (!providerLive) throw notConfigured(operation);
};

// --- helpers -------------------------------------------------------------------------

const newestRow = async (svc, Entity, query) =>
  (await svc.entities[Entity].filter(query, "-created_date", 1))[0] || null;

// Provider/channel-scoped account resolution: ONE account per (project, channel) — a legacy
// row without a channel field is Google. One bounded query, never N+1.
async function newestAccount(svc, projectId, channel = "google") {
  const rows = await svc.entities.AdsAccount.filter({ project_id: projectId }, "-created_date", 20);
  return rows.find((r) => (r.channel || "google") === channel) || null;
}

// The ONE-ACCOUNT invariant, per provider channel: the OLDEST row of the channel is the
// deterministic winner, so concurrent launches can never mutually delete (the old keepId-based
// dedup could wipe both rows under a race). Re-checked after each delete pass; bounded so a
// pathological store cannot loop. The storage layer does not honor `$ne` in deleteMany filters,
// so losers are resolved and deleted explicitly — the same pattern the SecurityScan dedup uses.
async function enforceSingleAccount(svc, projectId, channel = "google") {
  try {
    for (let i = 0; i < 3; i += 1) {
      const rows = (await svc.entities.AdsAccount.filter({ project_id: projectId }, "created_date", 100))
        .filter((r) => (r.channel || "google") === channel);
      if (rows.length <= 1) return rows[0] || null;
      for (const r of rows.slice(1)) await svc.entities.AdsAccount.delete(r.id);
    }
  } catch { /* a failed dedup must not fail the launch */ }
  return null;
}

// Concurrency-safe account resolution: reuse the channel's account when one exists, otherwise
// create and dedup to the deterministic winner. The returned row is ALWAYS re-resolved from the
// store, so a losing concurrent create attaches to the winner instead of a deleted row.
async function ensureAccount(svc, project, channel, accFields) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await newestAccount(svc, project.id, channel);
    if (existing) return svc.entities.AdsAccount.update(existing.id, accFields);
    await svc.entities.AdsAccount.create({ project_id: project.id, workspace_id: project.workspace_id, channel, ...accFields });
    await enforceSingleAccount(svc, project.id, channel);
    const resolved = await newestAccount(svc, project.id, channel);
    if (resolved) return resolved;
  }
  throw err("could not resolve the ads account under concurrency", "ACCOUNT_RACE", 409);
}

async function changeLog(svc, { project, actor, scope, resource_id, action, detail }) {
  await svc.entities.AdsChangeLog.create({
    project_id: project.id, workspace_id: project.workspace_id,
    scope, resource_id: resource_id || null, actor, action, detail: detail || {},
  });
}

// The campaign projection: the documented list row is built for a table. Metrics are only what
// a provider sync delivered (metrics_pending true otherwise, zeros per the documented shape).
function projectCampaign(row) {
  const m = row.metrics || {};
  const pending = row.metrics_pending !== false;
  return {
    id: row.id, campaign_name: row.campaign_name, campaign_type: row.campaign_type,
    status: row.status, daily_budget_micros: Number(row.daily_budget_micros || 0),
    start_date: row.start_date || "", landing_page: row.landing_page || "",
    site_links: row.site_links || [], targeting: row.targeting || {},
    provider_campaign_id: row.provider_campaign_id || null,
    review_status: row.review_status || "", serving_status: row.serving_status || "",
    metrics_pending: pending, last_synced_at: row.last_synced_at || null,
    impressions: pending ? 0 : Number(m.impressions || 0),
    clicks: pending ? 0 : Number(m.clicks || 0),
    cost_micros: pending ? 0 : Number(m.cost_micros || 0),
    spend: pending ? 0 : Number(m.spend || 0),
    conversions: pending ? 0 : Number(m.conversions || 0),
    ctr: pending ? 0 : Number(m.ctr || 0),
  };
}

const projectBrief = (row) => ({
  id: row.id, campaign_type: row.campaign_type, headlines: row.headlines || [], descriptions: row.descriptions || [],
  keywords: row.keywords || [], budget_micros: row.budget_micros ?? null, business_name: row.business_name || "",
  business_phone: row.business_phone || "", landing_page: row.landing_page || "", language: row.language || null,
  status: row.status, generation_warning: row.generation_warning || null, generated_at: row.generated_at || null,
});

const projectSession = (row) => ({
  id: row.id, kind: row.kind, campaign_type: row.campaign_type, status: row.status,
  text: row.text || [], images: row.images || [], background_image_count: Number(row.background_image_count || 0),
  language: row.language || null, accepted_session_asset_ids: row.accepted_session_asset_ids || [],
  error: row.error || null, completed_at: row.completed_at || null,
});

const projectMapping = (row) => ({
  id: row.id, app_event_name: row.app_event_name, conversion_action_name: row.conversion_action_name || "",
  provider_conversion_ref: row.provider_conversion_ref || null, status: row.status, updated_at: row.updated_at || null,
});

// --- launch -------------------------------------------------------------------------

/**
 * DOCUMENTED (Base44): read launch readiness BEFORE launch — it tells you whether a launch
 * will succeed. Here it is computed from project state plus the provider configuration gate;
 * nothing is invented on Google's behalf.
 */
async function launchReadiness(svc, project, account, providerLive = providerConfigured(), inputLandingPage = "") {
  const blockers = [];
  if (!providerLive) blockers.push("PROVIDER_NOT_CONFIGURED");
  // DOCUMENTED (Base44, ads connection UX): only a PUBLISHED, publicly visible app can be
  // advertised — "A private or workspace-only app cannot be advertised."
  if (project.status === "archived" || project.unpublished || !project.production_deployment_id) {
    blockers.push("APP_NOT_PUBLISHED");
  } else if ((project.visibility || "public") !== "public") {
    blockers.push("APP_NOT_PUBLIC");
  }
  if (account && account.status !== "active") blockers.push("ACCOUNT_NOT_ACTIVE");
  if (account && !account.payment_on_file) blockers.push("PAYMENT_ON_FILE_MISSING");
  const landing = account?.landing_page || inputLandingPage || project.default_landing_page || project.home_page || "";
  if (!landing) blockers.push("LANDING_PAGE_MISSING");
  // DOCUMENTED (Base44): 2 active campaigns at a time — "To start a third, pause one of the
  // campaigns you are already running." One bounded query, never N+1.
  const activeCount = (await svc.entities.AdsCampaign.filter({ project_id: project.id, status: "ENABLED" }, "created_date", 100)).length;
  if (activeCount >= 2) blockers.push("ACTIVE_CAMPAIGN_LIMIT");
  return {
    ready: blockers.length === 0,
    blockers,
    currency_code: account?.currency_code || null,
    payment_on_file: !!(account?.payment_on_file),
    business_name: account?.business_name || project.business_name || "",
    business_phone: account?.business_phone || "",
    landing_page: landing,
  };
}

// --- asset generation (PREVIEWS ONLY — never a provider call) -----------------------

// Deterministic session_asset_id: session, slot, index — stable across polls.
const slotAssetId = (sessionId, slot, i) => `${sessionId}:${slot}:${i}`;

async function runAssetGeneration(svc, project, user, input, generators) {
  const kind = String(input.kind || "generate_all");
  if (!["generate_all", "generate_text", "generate_images"].includes(kind)) {
    throw err(`Unknown generation kind "${kind}"`, "UNKNOWN_KIND");
  }
  const campaignType = CAMPAIGN_TYPES.includes(input.campaign_type) ? input.campaign_type : "PERFORMANCE_MAX";
  // DOCUMENTED (Base44): only one generation runs per app and kind at a time; a concurrent call
  // returns THAT run's session. The generating session is the in-flight marker.
  const inFlight = await newestRow(svc, "AdsAssetSession", { project_id: project.id, kind });
  if (inFlight && inFlight.status === "generating") {
    return { in_flight: true, session: projectSession(inFlight) };
  }
  const textSlots = kind === "generate_images" ? [] : TEXT_SLOTS[campaignType];
  const imageSlots = kind === "generate_text" ? [] : IMAGE_SLOTS[campaignType];
  if (kind === "generate_images" && !input.final_url && !input.freeform_prompt) {
    throw err("send exactly one of final_url or freeform_prompt", "FINAL_URL_OR_PROMPT_REQUIRED");
  }
  const session = await svc.entities.AdsAssetSession.create({
    project_id: project.id, workspace_id: project.workspace_id, kind, campaign_type: campaignType,
    status: "generating", final_url: input.final_url || "", freeform_prompt: input.freeform_prompt || "",
    text: [], images: [], background_image_count: 0, accepted_session_asset_ids: [],
  });
  try {
    const gen = generators || {};
    const text = textSlots.length && gen.text
      ? await gen.text({ project, campaign_type: campaignType, asset_field_types: textSlots, final_url: input.final_url || "" })
      : { lines: [], language: null };
    const images = imageSlots.length && gen.images
      ? await gen.images({ project, campaign_type: campaignType, asset_field_types: imageSlots, final_url: input.final_url || "", freeform_prompt: input.freeform_prompt || "" })
      : { images: [], background_image_count: 0, language: null };
    const lines = (text.lines || []).slice(0, 60).map((l, i) => ({
      session_asset_id: slotAssetId(session.id, l.asset_field_type, i),
      asset_field_type: l.asset_field_type, content: String(l.content || "").slice(0, 200),
    }));
    const imgs = (images.images || []).slice(0, 20).map((im, i) => ({
      session_asset_id: slotAssetId(session.id, im.asset_field_type, 100 + i),
      asset_field_type: im.asset_field_type, url: String(im.url || ""),
    }));
    const updated = await svc.entities.AdsAssetSession.update(session.id, {
      status: "completed", text: lines, images: imgs,
      background_image_count: Number(images.background_image_count || 0),
      language: text.language || images.language || null, completed_at: nowIso(),
    });
    await changeLog(svc, { project, actor: "system", scope: "asset", resource_id: session.id, action: "asset.generated", detail: { kind, campaign_type: campaignType, text: lines.length, images: imgs.length } });
    return { in_flight: false, session: projectSession(updated) };
  } catch (e) {
    const safe = String(e?.message || e).slice(0, 300);
    const updated = await svc.entities.AdsAssetSession.update(session.id, {
      status: "failed", error: safe, completed_at: nowIso(),
    }).catch(() => null);
    if (updated) return { in_flight: false, session: projectSession(updated) };
    throw e;
  }
}

// --- the surface ---------------------------------------------------------------------

/**
 * The one routing point every Google Ads action funnels through.
 *
 * `opts.provider`  — the live adapter (default: fail-closed). The certification injects a
 *                    deterministic stub; production never passes one.
 * `opts.generators`— the copy/image generators for PREVIEW generation. Default: the existing
 *                    model gateway (copy) and Core image generation (pictures). The
 *                    certification injects deterministic generators.
 */
export async function googleAdsSurface(svc, project, workspace, user, input, opts = {}) {
  // THE provider-neutral seam: every action routes through the ONE adapter resolved for the
  // request's channel. Absent input.channel is Google — legacy behavior, unchanged.
  const channel = normalizeAdsChannel(input?.channel);
  if (!channel) throw err(`Unknown ads channel "${input?.channel}"`, "UNKNOWN_CHANNEL");
  const { provider, providerLive } = resolveAdsProvider(channel, opts);
  const action = String(input.action || "");
  const account = await newestAccount(svc, project.id, channel);

  // ---- accounts ----
  if (action === "account_get") {
    // DOCUMENTED: returns null with a 200 when the app has none — normal, not an error.
    return { account: account ? { id: account.id, channel, status: account.status, currency_code: account.currency_code || null, billing_cadence: account.billing_cadence || "unknown", payment_on_file: !!account.payment_on_file, spend_cap_micros: account.spend_cap_micros ?? null, business_name: account.business_name || "", linked_business_profile: account.linked_business_profile || null, launched_at: account.launched_at || null, disconnected_at: account.disconnected_at || null, provider_configured: isChannelConfigured(channel) } : null };
  }

  if (action === "account_disconnect") {
    requireProvider("account_disconnect", providerLive);
    if (!account) throw err(`The app has no ads account on channel "${channel}"`, "ACCOUNT_NOT_FOUND", 404);
    if (account.status === "disconnected") return { account: { id: account.id, status: account.status }, budget_end_confirmed: true };
    const res = await provider.disconnectAccount({ account });
    const updated = await svc.entities.AdsAccount.update(account.id, { status: "disconnected", disconnected_at: nowIso(), synced_at: nowIso() });
    await changeLog(svc, { project, actor: "member", scope: "account", resource_id: account.id, action: "account.disconnected", detail: { budget_end_confirmed: !!res?.budget_end_confirmed } });
    return { account: { id: updated.id, status: updated.status, disconnected_at: updated.disconnected_at }, budget_end_confirmed: !!res?.budget_end_confirmed };
  }

  // OpenAI Ads connection: the DOCUMENTED Zernio credentials-connect path
  // (connectZernioOpenAIAds in zernioAdsProvider.ts). NOT a campaign adapter operation — the
  // certified adapter contract is untouched. The member's ChatGPT Ads Manager key is sent to
  // Zernio ONCE and is NEVER stored, logged or returned by this app; only the returned account
  // identity is persisted into the existing AdsAccount model (one account per project/channel).
  if (action === "account_connect") {
    if (channel !== "zernio:openai") {
      throw err(`credential connect is documented for OpenAI Ads only — channel "${channel}" has no documented connect path`, "CHANNEL_NOT_CONNECTABLE", 409);
    }
    if (!providerLive) throw err("Connecting OpenAI Ads requires the external Zernio infrastructure (ZERNIO_API_KEY). No connect call was made.", "PROVIDER_NOT_CONFIGURED", 409);
    const userApiKey = String(input.openai_api_key || "").trim();
    const profileId = String(input.profile_id || "").trim();
    if (!userApiKey || !profileId) throw err("openai_api_key and profile_id are required to connect OpenAI Ads", "INVALID_INPUT", 400);
    const res = await connectZernioOpenAIAds({ userApiKey, profileId, fetcher: opts.fetcher, apiKey: opts.apiKey });
    const ref = res.provider_account_ref;
    const wasConnected = account && account.provider_account_ref === ref && account.status === "active" && (account.business_name || "") === res.ad_account_name;
    if (wasConnected) {
      // Documented idempotency: Zernio updated the connection in place; this app's row already
      // reflects it — no write, no second change-log entry.
      return { account: { id: account.id, channel, status: account.status, business_name: account.business_name || "" }, already_connected: true };
    }
    const fields = { status: "active", provider_account_ref: ref, business_name: res.ad_account_name || account?.business_name || "", disconnected_at: null, synced_at: nowIso() };
    const updated = account ? await svc.entities.AdsAccount.update(account.id, fields) : await ensureAccount(svc, project, channel, fields);
    await changeLog(svc, { project, actor: "member", scope: "account", resource_id: updated.id, action: "account.connected", detail: { channel, reconnect: !!account } });
    return { account: { id: updated.id, channel, status: updated.status, business_name: updated.business_name || "" } };
  }

  // Existing Zernio ad accounts (Meta / TikTok / LinkedIn / OpenAI): READ-ONLY listing of the
  // accounts already connected in Zernio, then an explicit link that stores the chosen
  // account's provider reference on THIS project's channel account. Nothing is created or
  // changed at Zernio. An account actively linked to another project is refused, so one ad
  // account's campaigns can never be imported into two projects.
  // Meta Ads not yet connected in Zernio: start Zernio's documented connect flow. Returns only the
  // provider's authUrl; the return target must be this app's own Grow route (absolute, http(s)).
  if (action === "account_connect_url") {
    if (channel !== "zernio:meta") throw err(`a connect link is documented for Meta Ads only — not "${channel}"`, "CHANNEL_NOT_CONNECTABLE", 409);
    requireProvider(action, providerLive);
    let ret;
    try { ret = new URL(String(input.redirect_url || "")); } catch { ret = null; }
    if (!ret || !/^https?:$/.test(ret.protocol) || !ret.pathname.startsWith("/growth-agent")) throw err("redirect_url must be an absolute URL of the Grow page", "INVALID_REDIRECT_URL", 400);
    return await startZernioMetaConnect({ redirectUrl: ret.toString(), fetcher: opts.fetcher, apiKey: opts.apiKey });
  }

  if (action === "account_options" || action === "account_link") {
    if (!channel.startsWith("zernio:")) throw err(`account linking is for Zernio channels only — not "${channel}"`, "CHANNEL_NOT_CONNECTABLE", 409);
    requireProvider(action, providerLive);
    const listed = await listZernioAdAccounts({ channel, fetcher: opts.fetcher, apiKey: opts.apiKey });
    const linkedElsewhere = async (ref) => (await svc.entities.AdsAccount.filter({ channel, provider_account_ref: ref, status: "active" }, "created_date", 20))
      .some((a) => a.project_id !== project.id);
    if (action === "account_options") {
      const accounts = [];
      for (const a of listed.accounts) accounts.push({ ...a, linked_here: account?.provider_account_ref === a.provider_account_ref && account?.status === "active", linked_elsewhere: await linkedElsewhere(a.provider_account_ref) });
      return { accounts, complete: listed.complete };
    }
    const ref = String(input.provider_account_ref || "").trim();
    if (!ref) throw err("provider_account_ref is required", "INVALID_INPUT", 400);
    const match = listed.accounts.find((a) => a.provider_account_ref === ref);
    if (!match) throw err("that account is not a connected Zernio ad account for this channel", "ACCOUNT_NOT_FOUND", 404);
    if (!match.is_active) throw err("the Zernio account needs to be reconnected in Zernio first", "ACCOUNT_NEEDS_RECONNECT", 409);
    if (await linkedElsewhere(ref)) throw err("this ad account is already linked to another project", "ACCOUNT_LINKED_ELSEWHERE", 409);
    if (account && account.provider_account_ref === ref && account.status === "active") {
      return { account: { id: account.id, channel, status: account.status, business_name: account.business_name || "" }, already_connected: true };
    }
    const fields = { status: "active", provider_account_ref: ref, business_name: match.name, disconnected_at: null, synced_at: nowIso() };
    const updated = account ? await svc.entities.AdsAccount.update(account.id, fields) : await ensureAccount(svc, project, channel, fields);
    await changeLog(svc, { project, actor: "member", scope: "account", resource_id: updated.id, action: "account.linked", detail: { channel, relink: !!account } });
    return { account: { id: updated.id, channel, status: updated.status, business_name: updated.business_name || "" } };
  }

  // ---- launch ----
  if (action === "launch_readiness") {
    return await launchReadiness(svc, project, account, providerLive, input.landing_page || "");
  }

  // NexusAI-native planning read (budget_boundaries): the bounded static registry — NOT a
  // provider operation, so it needs no live gate and the certified adapter contract is
  // untouched. Documented fallbacks: unknown currency → USD, unknown type → SMART.
  if (action === "budget_boundaries") {
    return budgetBoundaries(input);
  }

  if (action === "launch") {
    // Fail closed BEFORE anything is created: no readiness pass, no spend-opening call.
    requireProvider("launch", providerLive);
    const readiness = await launchReadiness(svc, project, account, providerLive, input.landing_page || "");
    if (!readiness.ready) {
      throw Object.assign(new Error(`Launch is blocked: ${readiness.blockers.join(", ")}`), { code: "LAUNCH_BLOCKED", status: 409, blockers: readiness.blockers });
    }
    // The provider creates the account (if absent) and the campaign — the single point at
    // which live spend can open. Its result is the ONLY source of account/campaign state.
    const res = await provider.launch({ project, payload: { landing_page: readiness.landing_page, business_name: readiness.business_name, campaign_type: input.campaign_type === "SMART" ? "SMART" : "PERFORMANCE_MAX", campaign_name: String(input.campaign_name || "").slice(0, 200), daily_budget_micros: Number(input.daily_budget_micros || 0) } });
    const accFields = { status: "active", payment_on_file: true, currency_code: res.account?.currency_code || null, provider_account_ref: res.account?.provider_account_ref || null, billing_cadence: res.account?.billing_cadence || "unknown", launched_at: nowIso(), synced_at: nowIso(), landing_page: readiness.landing_page };
    let acc = await ensureAccount(svc, project, channel, accFields);
    const created = [];
    for (const c of (res.campaigns || []).slice(0, 5)) {
      created.push(await svc.entities.AdsCampaign.create({
        project_id: project.id, workspace_id: project.workspace_id, account_id: acc.id, channel,
        campaign_name: String(c.campaign_name || input.campaign_name || "Campaign").slice(0, 200),
        campaign_type: c.campaign_type === "SMART" ? "SMART" : "PERFORMANCE_MAX",
        status: c.status || "PENDING", daily_budget_micros: Number(c.daily_budget_micros || input.daily_budget_micros || 0),
        start_date: c.start_date || nowIso().slice(0, 10), landing_page: readiness.landing_page,
        targeting: input.targeting || {}, provider_campaign_id: c.provider_campaign_id || null,
        review_status: c.review_status || "", serving_status: c.serving_status || "", metrics_pending: true,
      }));
    }
    await changeLog(svc, { project, actor: "member", scope: "account", resource_id: acc.id, action: "account.launched", detail: { campaigns: created.map((c) => c.id) } });
    return { account: { id: acc.id, status: acc.status }, campaigns: created.map(projectCampaign) };
  }

  // ---- campaigns ----
  if (action === "campaign_list" && channel.startsWith("zernio:")) {
    // Zernio: sync + import externally created campaigns (read-only towards the provider).
    let provider_sync = "skipped_not_configured", imported = null;
    if (providerLive && account && account.status === "active") {
      imported = await syncAndImportCampaigns(svc, project, account, channel, provider);
      provider_sync = imported.complete ? "synced" : "partial";
    }
    const fresh = await svc.entities.AdsCampaign.filter({ project_id: project.id, channel }, "-created_date", 200);
    return {
      campaigns: fresh.map(projectCampaign), provider_sync, provider_configured: isChannelConfigured(channel),
      import: imported ? { created: imported.created, updated: imported.updated, complete: imported.complete, provider_total: imported.provider_total } : null,
      metrics_window: imported?.metrics_window || null,
    };
  }
  if (action === "campaign_list") {
    // Channel-scoped: the sync and the projection cover only this channel's campaigns.
    const rows = (await svc.entities.AdsCampaign.filter({ project_id: project.id }, "-created_date", 50))
      .filter((r) => (r.channel || "google") === channel);
    let provider_sync = "skipped_not_configured";
    if (providerLive && account && account.status === "active") {
      const sync = await provider.syncCampaigns({ account, campaigns: rows });
      for (const row of rows) {
        const remote = (sync.campaigns || []).find((c) => c.provider_campaign_id === row.provider_campaign_id);
        if (remote) await svc.entities.AdsCampaign.update(row.id, {
          status: remote.status || row.status, review_status: remote.review_status || row.review_status || "",
          serving_status: remote.serving_status || row.serving_status || "",
          metrics: remote.metrics || row.metrics || {}, metrics_pending: !!(remote.metrics && Object.keys(remote.metrics).length) ? false : row.metrics_pending !== false,
          last_synced_at: nowIso(),
        });
      }
      provider_sync = "synced";
    }
    const fresh = (await svc.entities.AdsCampaign.filter({ project_id: project.id }, "-created_date", 50))
      .filter((r) => (r.channel || "google") === channel);
    return { campaigns: fresh.map(projectCampaign), provider_sync, provider_configured: isChannelConfigured(channel) };
  }

  const campaignAction = async () => {
    const campaignId = String(input.campaign_id || "");
    const row = campaignId ? await svc.entities.AdsCampaign.get(campaignId).catch(() => null) : null;
    if (!row || row.project_id !== project.id) throw err("Campaign not found", "CAMPAIGN_NOT_FOUND", 404);
    if ((row.channel || "google") !== channel) throw err(`the campaign is not on channel "${channel}"`, "CHANNEL_MISMATCH", 400);
    return row;
  };

  if (action === "campaign_get") {
    const row = await campaignAction();
    return { campaign: projectCampaign(row) };
  }

  if (action === "campaign_update") {
    requireProvider("campaign_update", providerLive);
    const row = await campaignAction();
    const patch = {};
    if (input.campaign_name !== undefined) patch.campaign_name = String(input.campaign_name).slice(0, 200);
    if (input.daily_budget_micros !== undefined) {
      const micros = Number(input.daily_budget_micros);
      if (!Number.isInteger(micros) || micros <= 0) throw err("daily_budget_micros must be a positive integer (micros)", "INVALID_BUDGET");
      patch.daily_budget_micros = micros;
    }
    if (input.landing_page !== undefined) throw err("the landing page cannot change after the campaign is created", "LANDING_PAGE_IMMUTABLE");
    const res = await provider.updateCampaign({ campaign: row, patch });
    const merged = { ...row, ...(res.campaign || {}), ...patch };
    const updated = await svc.entities.AdsCampaign.update(row.id, {
      ...patch, review_status: merged.review_status || row.review_status, last_synced_at: nowIso(),
    });
    await changeLog(svc, { project, actor: "member", scope: "campaign", resource_id: row.id, action: "campaign.updated", detail: { changed: Object.keys(patch) } });
    return { campaign: projectCampaign(updated) };
  }

  const lifecycle = (verb, status) => async () => {
    requireProvider(verb, providerLive);
    const row = await campaignAction();
    const res = await provider[verb]({ campaign: row });
    const merged = { ...row, ...(res.campaign || {}) };
    const updated = await svc.entities.AdsCampaign.update(row.id, {
      status: merged.status || status, serving_status: merged.serving_status || row.serving_status || "",
      last_synced_at: nowIso(),
    });
    await changeLog(svc, { project, actor: "member", scope: "campaign", resource_id: row.id, action: `campaign.${status.toLowerCase()}` });
    return { campaign: projectCampaign(updated) };
  };
  if (action === "campaign_pause") return lifecycle("pauseCampaign", "PAUSED")();
  if (action === "campaign_resume") return lifecycle("resumeCampaign", "ENABLED")();

  // DOCUMENTED (Base44): pause-all is the account's spend kill switch — every campaign on the
  // account stops serving in one call; the response reports exactly { status: "paused" | "partial",
  // paused_count, total_count, failed_count }. Composed here from the SAME per-campaign pause
  // path (the provider contract gains no new operation); pausing an already-paused campaign
  // succeeds, so repeated invocations are idempotent. Channel-scoped; REMOVED campaigns are
  // permanent tombstones and are never attempted. One bounded query, no N+1.
  if (action === "campaign_pause_all") {
    requireProvider("campaign_pause_all", providerLive);
    const rows = (await svc.entities.AdsCampaign.filter({ project_id: project.id }, "-created_date", 100))
      .filter((r) => (r.channel || "google") === channel && r.status !== "REMOVED");
    let paused_count = 0;
    let failed_count = 0;
    for (const row of rows) {
      try {
        const res = await provider.pauseCampaign({ campaign: row });
        const merged = { ...row, ...(res.campaign || {}) };
        await svc.entities.AdsCampaign.update(row.id, {
          status: merged.status || "PAUSED",
          serving_status: merged.serving_status || row.serving_status || "",
          last_synced_at: nowIso(),
        });
        paused_count += 1;
      } catch {
        failed_count += 1;
      }
    }
    const status = failed_count === 0 ? "paused" : "partial";
    await changeLog(svc, { project, actor: "member", scope: "campaign", resource_id: account?.id || null, action: "campaign.pause_all", detail: { status, paused_count, total_count: rows.length, failed_count } });
    return { status, paused_count, total_count: rows.length, failed_count };
  }

  if (action === "campaign_delete") {
    const row = await campaignAction();
    await provider.deleteCampaign({ campaign: row });
    const updated = await svc.entities.AdsCampaign.update(row.id, { status: "REMOVED", last_synced_at: nowIso() });
    await changeLog(svc, { project, actor: "member", scope: "campaign", resource_id: row.id, action: "campaign.deleted", detail: { permanent: true } });
    return { campaign: projectCampaign(updated) };
  }

  if (action === "campaign_bulk_budget") {
    requireProvider("campaign_bulk_budget", providerLive);
    const entries = Array.isArray(input.entries) ? input.entries.slice(0, 50) : [];
    if (!entries.length) throw err("entries is required", "INVALID_BUDGET");
    const res = await provider.bulkBudgets({ account, entries });
    const succeeded = [];
    for (const id of res.succeeded || []) {
      const entry = entries.find((e) => String(e.campaign_id) === String(id));
      const row = await svc.entities.AdsCampaign.get(id).catch(() => null);
      if (row && row.project_id === project.id && entry) {
        await svc.entities.AdsCampaign.update(row.id, { daily_budget_micros: Number(entry.daily_budget_micros), last_synced_at: nowIso() });
        succeeded.push(row.id);
      }
    }
    await changeLog(svc, { project, actor: "member", scope: "campaign", resource_id: account?.id || null, action: "campaign.bulk_budget", detail: { succeeded, failed: res.failed || [] } });
    // DOCUMENTED (Base44): not atomic — the response lists the ones that worked and the rest.
    return { succeeded, failed: res.failed || [] };
  }

  if (action === "change_log_list") {
    const rows = await svc.entities.AdsChangeLog.filter({ project_id: project.id }, "-created_date", Number(input.limit || 50));
    return { changes: rows.map((r) => ({ id: r.id, scope: r.scope, resource_id: r.resource_id, actor: r.actor, action: r.action, detail: r.detail || {}, created_date: r.created_date })) };
  }

  // ---- briefs (plans, not campaigns — no provider, no money) ----
  if (action === "brief_create") {
    const brief = await svc.entities.AdsBrief.create({
      project_id: project.id, workspace_id: project.workspace_id,
      campaign_type: CAMPAIGN_TYPES.includes(input.campaign_type) ? input.campaign_type : "PERFORMANCE_MAX",
      headlines: (input.headlines || []).map(String).slice(0, 20), descriptions: (input.descriptions || []).map(String).slice(0, 20),
      keywords: (input.keywords || []).map(String).slice(0, 30), budget_micros: Number(input.budget_micros || 0) || null,
      business_name: String(input.business_name || "").slice(0, 200), business_phone: String(input.business_phone || "").slice(0, 40),
      landing_page: String(input.landing_page || "").slice(0, 500), status: "draft",
    });
    await changeLog(svc, { project, actor: "member", scope: "brief", resource_id: brief.id, action: "brief.created" });
    return { brief: projectBrief(brief) };
  }
  if (action === "brief_list") {
    const rows = await svc.entities.AdsBrief.filter({ project_id: project.id }, "-created_date", 50);
    return { briefs: rows.map(projectBrief) };
  }
  const briefAction = async () => {
    const row = await svc.entities.AdsBrief.get(String(input.brief_id || "")).catch(() => null);
    if (!row || row.project_id !== project.id) throw err("Brief not found", "BRIEF_NOT_FOUND", 404);
    return row;
  };
  if (action === "brief_get") return { brief: projectBrief(await briefAction()) };
  if (action === "brief_update") {
    const row = await briefAction();
    const patch = {};
    if (input.headlines !== undefined) patch.headlines = input.headlines.map(String).slice(0, 20);
    if (input.descriptions !== undefined) patch.descriptions = input.descriptions.map(String).slice(0, 20);
    if (input.keywords !== undefined) patch.keywords = input.keywords.map(String).slice(0, 30);
    if (input.budget_micros !== undefined) patch.budget_micros = Number(input.budget_micros) || null;
    if (input.landing_page !== undefined) patch.landing_page = String(input.landing_page).slice(0, 500);
    patch.status = (patch.headlines || row.headlines || []).length && (patch.descriptions || row.descriptions || []).length ? "ready" : row.status;
    const updated = await svc.entities.AdsBrief.update(row.id, patch);
    await changeLog(svc, { project, actor: "member", scope: "brief", resource_id: row.id, action: "brief.updated", detail: { changed: Object.keys(patch) } });
    return { brief: projectBrief(updated) };
  }
  if (action === "brief_delete") {
    const row = await briefAction();
    await svc.entities.AdsBrief.delete(row.id);
    await changeLog(svc, { project, actor: "member", scope: "brief", resource_id: row.id, action: "brief.deleted" });
    return { deleted: true };
  }
  if (action === "brief_generate") {
    // DOCUMENTED (Base44): a failed generation still returns a saved brief — check that
    // headlines and descriptions came back non-empty before using the result.
    const gen = opts.generators?.brief || null;
    if (!gen) throw err("no copy generator available", "GENERATOR_UNAVAILABLE", 409);
    const plan_context = await loadPlanContext(svc, project.id);
    const res = await gen({ project, campaign_type: CAMPAIGN_TYPES.includes(input.campaign_type) ? input.campaign_type : "PERFORMANCE_MAX", goal: String(input.goal || "").slice(0, 400), audience: String(input.audience || "").slice(0, 400), plan_context });
    const headlines = (res.headlines || []).map(String).filter(Boolean).slice(0, 20);
    const descriptions = (res.descriptions || []).map(String).filter(Boolean).slice(0, 20);
    const warning = headlines.length && descriptions.length ? null : "generation did not produce usable copy — the brief was saved anyway; check headlines and descriptions before use";
    const brief = await svc.entities.AdsBrief.create({
      project_id: project.id, workspace_id: project.workspace_id,
      campaign_type: CAMPAIGN_TYPES.includes(input.campaign_type) ? input.campaign_type : "PERFORMANCE_MAX",
      headlines, descriptions, keywords: (res.keywords || []).map(String).slice(0, 30),
      business_name: String(res.business_name || input.business_name || "").slice(0, 200),
      landing_page: String(res.landing_page || input.landing_page || "").slice(0, 500),
      language: res.language || null,
      status: headlines.length && descriptions.length ? "ready" : "draft",
      generation_warning: warning, generated_at: nowIso(),
    });
    await changeLog(svc, { project, actor: "system", scope: "brief", resource_id: brief.id, action: "brief.generated", detail: { headlines: headlines.length, descriptions: descriptions.length } });
    return { brief: projectBrief(brief), generation_warning: warning };
  }

  // ---- asset sessions ----
  if (action === "asset_generate_all" || action === "asset_generate_text" || action === "asset_generate_images") {
    const kind = action.replace("asset_", "");
    return await runAssetGeneration(svc, project, user, { ...input, kind }, opts.generators);
  }
  if (action === "asset_list") {
    const row = await svc.entities.AdsAssetSession.get(String(input.session_id || "")).catch(() => null);
    if (!row || row.project_id !== project.id) throw err("Asset session not found", "SESSION_NOT_FOUND", 404);
    return { session: projectSession(row) };
  }
  if (action === "asset_accept") {
    // DOCUMENTED (Base44): only Accept puts a generated asset on a live campaign — a provider
    // call, so it fails closed until the Google Ads infrastructure exists.
    requireProvider("asset_accept", providerLive);
    const row = await svc.entities.AdsAssetSession.get(String(input.session_id || "")).catch(() => null);
    if (!row || row.project_id !== project.id) throw err("Asset session not found", "SESSION_NOT_FOUND", 404);
    if (row.status !== "completed") throw err("the session is not completed", "SESSION_NOT_COMPLETED", 409);
    const assetId = String(input.session_asset_id || "");
    const asset = [...(row.text || []), ...(row.images || [])].find((a) => a.session_asset_id === assetId);
    if (!asset) throw err("session_asset_id does not match any preview of this session", "ASSET_NOT_FOUND", 404);
    if ((row.accepted_session_asset_ids || []).includes(assetId)) {
      // DOCUMENTED (Base44): accepting the same image twice creates a duplicate — refuse instead.
      throw err("this asset was already accepted", "ASSET_ALREADY_ACCEPTED", 409);
    }
    const res = await provider.acceptAsset({ sessionAssetId: assetId, assetFieldType: asset.asset_field_type, content: asset.content || asset.url });
    const updated = await svc.entities.AdsAssetSession.update(row.id, { accepted_session_asset_ids: [...(row.accepted_session_asset_ids || []), assetId] });
    await changeLog(svc, { project, actor: "member", scope: "asset", resource_id: row.id, action: "asset.accepted", detail: { session_asset_id: assetId, provider_asset_ref: res?.provider_asset_ref || null } });
    return { session: projectSession(updated) };
  }

  // ---- conversions ----
  if (action === "conversion_mapping_create") {
    const eventName = String(input.app_event_name || "").trim().slice(0, 200);
    if (!eventName) throw err("app_event_name is required", "EVENT_NAME_REQUIRED");
    const existing = await svc.entities.AdsConversionMapping.filter({ project_id: project.id, app_event_name: eventName }, "created_date", 1);
    if (existing.length) throw Object.assign(new Error(`a mapping for "${eventName}" already exists`), { code: "MAPPING_EXISTS", status: 409 });
    const mapping = await svc.entities.AdsConversionMapping.create({
      project_id: project.id, workspace_id: project.workspace_id, app_event_name: eventName,
      conversion_action_name: String(input.conversion_action_name || "").slice(0, 200), status: "unmapped", created_at: nowIso(),
    });
    await changeLog(svc, { project, actor: "member", scope: "conversion", resource_id: mapping.id, action: "conversion.mapping_created" });
    return { mapping: projectMapping(mapping) };
  }
  if (action === "conversion_mapping_update") {
    const row = await svc.entities.AdsConversionMapping.get(String(input.mapping_id || "")).catch(() => null);
    if (!row || row.project_id !== project.id) throw err("Mapping not found", "MAPPING_NOT_FOUND", 404);
    let patch = { updated_at: nowIso() };
    if (input.conversion_action_name !== undefined) patch.conversion_action_name = String(input.conversion_action_name).slice(0, 200);
    if (input.map_to_provider === true) {
      // Confirming a provider-side conversion action is a live call — fail closed.
      requireProvider("conversion_mapping_update", providerLive);
      const res = await provider.mapConversion({ mapping: row });
      patch = { ...patch, provider_conversion_ref: res.provider_conversion_ref, status: "mapped" };
    }
    const updated = await svc.entities.AdsConversionMapping.update(row.id, patch);
    await changeLog(svc, { project, actor: "member", scope: "conversion", resource_id: row.id, action: "conversion.mapping_updated", detail: { changed: Object.keys(patch) } });
    return { mapping: projectMapping(updated) };
  }
  if (action === "conversion_mapping_delete") {
    const row = await svc.entities.AdsConversionMapping.get(String(input.mapping_id || "")).catch(() => null);
    if (!row || row.project_id !== project.id) throw err("Mapping not found", "MAPPING_NOT_FOUND", 404);
    await svc.entities.AdsConversionMapping.delete(row.id);
    await changeLog(svc, { project, actor: "member", scope: "conversion", resource_id: row.id, action: "conversion.mapping_deleted" });
    return { deleted: true };
  }
  if (action === "conversion_mapping_list") {
    const rows = await svc.entities.AdsConversionMapping.filter({ project_id: project.id }, "-created_date", 200);
    return { mappings: rows.map(projectMapping) };
  }
  if (action === "conversion_upload") {
    requireProvider("conversion_upload", providerLive);
    const rows = await svc.entities.AdsConversionMapping.filter({ project_id: project.id, status: "mapped" }, "created_date", 200);
    if (!rows.length) throw err("no mapped conversion actions to upload against", "NO_MAPPINGS", 409);
    const res = await provider.uploadConversions({ mappings: rows, events: Array.isArray(input.events) ? input.events.slice(0, 1000) : [] });
    return { uploaded: res.uploaded || 0, failed: res.failed || [] };
  }

  // ---- weekly performance reports (Runable Grow's documented weekly cadence) --------------
  // The data path is the SAME certified seam as campaign_list (resolveAdsProvider →
  // syncCampaigns) — never a second provider integration and never invented metrics. A report
  // still exists when the provider is unconfigured: a `blocked` row with the machine-checkable
  // refusal, so the weekly cadence is observable either way.
  if (action === "report_run") {
    return await runWeeklyAdsReport(svc, project, workspace, channel, { provider, providerLive });
  }
  if (action === "report_schedule") {
    return await scheduleWeeklyAdsReport(svc, project, workspace, channel);
  }
  if (action === "report_list") {
    return {
      reports: await listAdsReports(svc, project, channel, { limit: input.limit }),
      provider_configured: isChannelConfigured(channel),
    };
  }

  throw err(`Unknown action "${action}"`, "UNKNOWN_ACTION");
}

export { projectCampaign, projectBrief, projectSession, launchReadiness };