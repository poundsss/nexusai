// Targeted Grow Chat Ads exposure certification — closes the certified gap: the EXISTING,
// certified `googleAds` surface exposed to the GrowthAgent through the EXISTING tool_configs
// contract (function_<name> grant, executed through the existing function runtime). Scratch
// fixtures only; NO endpoint, entity, contract, provider adapter or credential is modified.
//   1. exposure: the REAL GrowthAgent document (bundled from shared/growthAgentExposure.json,
//      exported VERBATIM from base44/agents/GrowthAgent.jsonc — the live doc; re-sync that
//      copy whenever the agent document changes) declares the googleAds function tool with a
//      bounded description and its existing grants untouched;
//   2. channel routing: account_get resolves per channel through the certified provider
//      registry; an unsupported channel refuses with UNKNOWN_CHANNEL;
//   3. fail-closed: every supported channel reports provider_configured:false and the connect
//      path returns the provider's VERBATIM PROVIDER_NOT_CONFIGURED / CHANNEL_NOT_CONNECTABLE;
//   4. invocation: existing read (account_get, launch_readiness, campaign_list) and mutating
//      (launch, campaign_pause_all) operations return the surface's real responses;
//   5. authorization: the project-scoped gate refuses a non-member (403);
//   6. no unintended persistence: zero Ads rows and no BackgroundJob created by any call,
//      and the scratch project's version_count is untouched (launch fails closed pre-create).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import growthAgentDoc from "../../shared/growthAgentExposure.json" with { type: "json" };

const ADS_CHANNELS = ["google", "zernio:openai", "zernio:meta", "zernio:linkedin", "zernio:tiktok"];
const EXPECTED_ENTITY_GRANTS = ["Activity", "AeoProbe", "AeoResult", "Customer", "ListenObservation", "ListenTerm"];
// This cert's grant filter EXCLUDES the googleAds tool itself (it is asserted separately above).
// Resynced to the live GrowthAgent document: coldCalling, managedAds and myBusiness were added
// by their own later certs (coldCallingCert, managedAdsOptimizationCert) and are part of the
// certified surface set, not unplanned drift.
const EXPECTED_FN_GRANTS = ["aeo", "coldCalling", "emailDomain", "leadGen", "listen", "managedAds", "myBusiness", "outreach", "projectDomains", "seoScan", "support", "virality"];
const AD_DATA_ENTITIES = ["AdsAccount", "AdsCampaign", "AdsBrief", "AdsAssetSession", "BackgroundJob"];

// functions.invoke rejects non-2xx responses as thrown errors; normalize both outcomes into
// { status, code, data } so every assertion reads the platform's verbatim refusal.
async function callAds(project_id, body) {
  try {
    const res = await base44Ref.functions.invoke("googleAds", { project_id, ...body });
    return { status: 200, code: null, data: res.data };
  } catch (e) {
    const resp = e?.response;
    return { status: Number(resp?.status || e?.status || 0), code: resp?.data?.code || e?.code || null, data: resp?.data || null };
  }
}
let base44Ref = null;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  base44Ref = base44;
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const workspaceIds = [];
  const projectIds = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: `ads-ghost-${stamp}`, email: `ads-ghost-${stamp}@example.invalid` };

    // ---- 1. EXPOSURE: the real document, parsed exactly as the runtime's contract ----
    const toolConfigs = Array.isArray(growthAgentDoc.tool_configs) ? growthAgentDoc.tool_configs : [];
    const adsTool = toolConfigs.find((tc) => tc && tc.function_name === "googleAds");
    h.check("exposure: the GrowthAgent declares the googleAds function tool with a bounded description",
      !!adsTool && typeof adsTool.description === "string" && adsTool.description.length > 0 && adsTool.description.length <= 2000,
      JSON.stringify({ found: !!adsTool, desc_len: adsTool?.description?.length || 0 }));
    const entityGrants = toolConfigs.filter((tc) => tc && tc.entity_name).map((tc) => tc.entity_name).sort();
    const fnGrants = toolConfigs.filter((tc) => tc && tc.function_name && tc.function_name !== "googleAds").map((tc) => tc.function_name).sort();
    h.check("exposure: the agent's existing Grow grants are untouched",
      JSON.stringify(entityGrants) === JSON.stringify(EXPECTED_ENTITY_GRANTS)
        && JSON.stringify(fnGrants) === JSON.stringify(EXPECTED_FN_GRANTS),
      JSON.stringify({ entityGrants, fnGrants }));

    // ---- scratch fixtures: a member workspace (caller owns it) and a foreign one ----
    const ws = await svc.entities.Workspace.create({ name: `grow-ads-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    workspaceIds.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-ads-${stamp}`, status: "ready", version_count: 3 });
    projectIds.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-ads-2-${stamp}`, status: "ready", version_count: 0 });
    projectIds.push(proj2.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `grow-ads-f-${stamp}`, owner_id: ghost.id, credits_balance: 0, status: "active" });
    workspaceIds.push(foreignWs.id);
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: `grow-ads-f-${stamp}`, status: "ready", version_count: 1 });
    projectIds.push(foreignProj.id);

    // ---- 2+3. CHANNEL ROUTING + FAIL-CLOSED (the exact call the agent tool makes) ----
    const route = {};
    for (const channel of ADS_CHANNELS) {
      const r = await callAds(proj.id, { action: "account_get", channel });
      route[channel] = { status: r.status, account: r.data?.account ?? null, provider_configured: r.data?.provider_configured ?? null };
    }
    // DOCUMENTED: with no account account_get returns {account: null} with a 200 — the
    // configured state is only exposed ON an account; the unconfigured fail-closed state is
    // asserted below through the connect/launch refusals instead.
    h.check("channel routing: account_get resolves EVERY supported channel (one account per project+channel) with no account",
      ADS_CHANNELS.every((c) => route[c]?.status === 200 && route[c].account === null),
      JSON.stringify(route));

    const unknown = await callAds(proj.id, { action: "account_get", channel: "twitter" });
    h.check("channel routing: an unsupported channel refuses with the surface's verbatim UNKNOWN_CHANNEL",
      unknown.status === 400 && unknown.code === "UNKNOWN_CHANNEL", JSON.stringify(unknown));

    const openaiConnect = await callAds(proj.id, { action: "account_connect", channel: "zernio:openai", openai_api_key: "k", profile_id: "p" });
    h.check("fail-closed: connecting OpenAI Ads without credentials returns the provider's verbatim PROVIDER_NOT_CONFIGURED (no connect call)",
      openaiConnect.status === 409 && openaiConnect.code === "PROVIDER_NOT_CONFIGURED", JSON.stringify(openaiConnect));

    const googleConnect = await callAds(proj.id, { action: "account_connect", channel: "google" });
    h.check("channel routing: the google channel keeps its own adapter contract — no documented connect path (CHANNEL_NOT_CONNECTABLE)",
      googleConnect.status === 409 && googleConnect.code === "CHANNEL_NOT_CONNECTABLE", JSON.stringify(googleConnect));

    // ---- 4. EXISTING ADS OPERATION INVOCATION (reads + fail-closed mutations) ----
    const readiness = await callAds(proj.id, { action: "launch_readiness", channel: "google" });
    h.check("invocation: the existing launch_readiness read returns the surface's real response with the provider blocker",
      readiness.status === 200 && Array.isArray(readiness.data?.blockers) && readiness.data.blockers.includes("PROVIDER_NOT_CONFIGURED") && readiness.data.ready === false,
      JSON.stringify(readiness.data || {}).slice(0, 300));

    const campaigns = await callAds(proj.id, { action: "campaign_list", channel: "zernio:meta" });
    h.check("invocation: the existing channel-scoped campaign_list returns an empty list with provider_sync skipped",
      campaigns.status === 200 && Array.isArray(campaigns.data?.campaigns) && campaigns.data.campaigns.length === 0
        && campaigns.data.provider_sync === "skipped_not_configured" && campaigns.data.provider_configured === false,
      JSON.stringify(campaigns.data || {}));

    const launch = await callAds(proj.id, { action: "launch", channel: "google", campaign_name: "cert", daily_budget_micros: 10000000, landing_page: "https://example.invalid" });
    h.check("fail-closed: the existing launch operation refuses BEFORE anything is created (no campaign, no spend opens)",
      launch.status === 409 && launch.code === "PROVIDER_NOT_CONFIGURED", JSON.stringify(launch));

    const pauseAll = await callAds(proj.id, { action: "campaign_pause_all", channel: "google" });
    h.check("fail-closed: the existing campaign_pause_all operation refuses with the provider's verbatim error",
      pauseAll.status === 409 && pauseAll.code === "PROVIDER_NOT_CONFIGURED", JSON.stringify(pauseAll));

    // ---- 5. AUTHORIZATION: the project-scoped gate refuses a non-member ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot reach the project's ads surface (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));

    // ---- 6. NO UNINTENDED PERSISTENCE / EXTERNAL CAMPAIGN CREATION ----
    const counts = {};
    for (const name of AD_DATA_ENTITIES) {
      counts[name] = (await svc.entities[name].filter({ project_id: proj.id }, "-created_date", 100)).length;
    }
    const projectAfter = await svc.entities.Project.get(proj.id);
    h.check("no unintended persistence: zero Ads account/campaign/brief/session rows, zero jobs, and the project's version untouched",
      AD_DATA_ENTITIES.every((n) => counts[n] === 0) && projectAfter.version_count === 3, JSON.stringify({ counts, version_count: projectAfter.version_count }));

    // ---- ISOLATION: the second project's surface sees NONE of the first project's rows ----
    const other = await callAds(proj2.id, { action: "campaign_list", channel: "google" });
    h.check("project isolation: the second project's ads surface is empty",
      other.status === 200 && other.data?.campaigns?.length === 0, JSON.stringify(other.data || {}));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projectIds) {
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsBrief", { project_id: pid });
      await purgeBy(svc, "AdsAssetSession", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaceIds) {
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  return harnessResponse(h);
}