// Grow project-context certification — runtime verification of the composer → agent → tool
// project binding. Scratch fixtures only; NO certified contract, entity or provider adapter is
// modified. Closes the gap end to end:
//   1. runtime propagation: the EXACT structured context payload Growth Chat send() ships
//      (custom_context project_context with data.project_id) round-trips through the same
//      conversation runtime the GrowthAgent consumes — verbatim type, message and project_id;
//   2. project switching: a later selection rebinds the context on the newest user message
//      while the older message keeps its own binding (selection survives the conversation);
//   3. no-project case: a message WITHOUT project_context persists clean — general chat stays
//      available;
//   4. doc binding: the GrowthAgent document still declares every surface the context names
//      (googleAds, managedAds, leadGen, listen, aeo, virality, seoScan, support, outreach,
//      emailDomain, projectDomains, coldCalling, myBusiness) as function tools;
//   5. invalid + unauthorized project rejection and cross-project isolation on the live surfaces;
//   6. launch authorization unchanged: Google Ads launch refuses closed without credentials,
//      Managed Ads accept refuses without a synced recommendation (no approval, no execution);
//   7. no unintended persistence.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import growthAgentDoc from "../../shared/growthAgentExposure.json" with { type: "json" };

// The EXACT context payload the composer ships (src/pages/GrowthAgent.jsx send()). If the
// frontend copy changes, this constant must be re-synced — it is the contract under test.
const CONTEXT_TYPE = "project_context";
const CONTEXT_MESSAGE = "The member selected this project in the Grow composer. It is the ONLY project this request may act on: pass data.project_id verbatim as project_id on every project-scoped surface call (googleAds, managedAds, leadGen, listen, aeo, virality, seoScan, support, outreach, emailDomain, projectDomains, coldCalling, myBusiness). Never infer a project from the message text, never substitute another project's id, and refuse a project-scoped action that lacks this selection.";
const CONTEXT_SURFACES = ["googleAds", "managedAds", "leadGen", "listen", "aeo", "virality", "seoScan", "support", "outreach", "emailDomain", "projectDomains", "coldCalling", "myBusiness"];
const AD_DATA_ENTITIES = ["AdsAccount", "AdsCampaign", "AdsBrief", "AdsAssetSession", "BackgroundJob"];

async function callFn(fn, project_id, body) {
  try {
    const res = await base44Ref.functions.invoke(fn, { project_id, ...body });
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
  const conversationIds = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: `ctx-ghost-${stamp}`, email: `ctx-ghost-${stamp}@example.invalid` };

    // ---- scratch fixtures: a member workspace with TWO projects (multi-project + switch cases),
    // and a foreign workspace/project the member must never reach ----
    const ws = await svc.entities.Workspace.create({ name: `grow-ctx-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    workspaceIds.push(ws.id);
    const projA = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-ctx-a-${stamp}`, status: "ready", version_count: 3 });
    projectIds.push(projA.id);
    const projB = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-ctx-b-${stamp}`, status: "ready", version_count: 0 });
    projectIds.push(projB.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `grow-ctx-f-${stamp}`, owner_id: ghost.id, credits_balance: 0, status: "active" });
    workspaceIds.push(foreignWs.id);
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: `grow-ctx-f-${stamp}`, status: "ready", version_count: 1 });
    projectIds.push(foreignProj.id);

    // ---- 1. RUNTIME PROPAGATION: the composer's structured context reaches the conversation ----
    const conv = await base44.agents.createConversation({ agent_name: "GrowthAgent", metadata: { name: `cert ${stamp}` } });
    conversationIds.push(conv.id);
    const ship = (projectId, extra = {}) => base44.agents.addMessage(conv, {
      role: "user",
      content: `Run the ads readiness check for project ${stamp}`,
      ...(projectId ? { custom_context: [{ type: CONTEXT_TYPE, message: CONTEXT_MESSAGE, data: { project_id: projectId } }] } : extra),
    });
    await ship(projA.id);
    const after = await base44.agents.getConversation(conv.id);
    const ctxMsg = (after?.messages || []).filter((m) => m.role === "user" && m.custom_context?.length).pop();
    const ctx = ctxMsg?.custom_context?.[0];
    h.check("runtime propagation: the composer's project_context reaches the conversation verbatim (type, message, project_id)",
      !!ctx && ctx.type === CONTEXT_TYPE && ctx.message === CONTEXT_MESSAGE && ctx.data?.project_id === projA.id,
      JSON.stringify({ type: ctx?.type, project_id: ctx?.data?.project_id, message_matches: ctx?.message === CONTEXT_MESSAGE }));

    // ---- 2. PROJECT SWITCHING: the newest message carries the NEW selection ----
    await ship(projB.id);
    const afterSwitch = await base44.agents.getConversation(conv.id);
    const userCtxMsgs = (afterSwitch?.messages || []).filter((m) => m.role === "user" && m.custom_context?.length);
    const switched = userCtxMsgs[userCtxMsgs.length - 1]?.custom_context?.[0];
    const first = userCtxMsgs[0]?.custom_context?.[0];
    h.check("project switching: the newest user message binds the NEW project and the earlier binding is preserved",
      switched?.data?.project_id === projB.id && first?.data?.project_id === projA.id,
      JSON.stringify({ first: first?.data?.project_id, latest: switched?.data?.project_id }));

    // ---- 3. NO-PROJECT CASE: a context-free message persists clean ----
    await base44.agents.addMessage(conv, { role: "user", content: `General question ${stamp}` });
    const afterPlain = await base44.agents.getConversation(conv.id);
    const plainMsg = (afterPlain?.messages || []).filter((m) => m.role === "user" && m.content === `General question ${stamp}`).pop();
    h.check("no-project case: a message without a selection persists with no project_context (general chat available)",
      !!plainMsg && (!Array.isArray(plainMsg.custom_context) || plainMsg.custom_context.length === 0), JSON.stringify({ found: !!plainMsg, ctx: plainMsg?.custom_context ?? null }));

    // ---- 4. DOC BINDING: every surface the context names is a declared function tool ----
    const toolConfigs = Array.isArray(growthAgentDoc.tool_configs) ? growthAgentDoc.tool_configs : [];
    const declared = toolConfigs.filter((tc) => tc && tc.function_name).map((tc) => tc.function_name);
    const adsDesc = toolConfigs.find((tc) => tc?.function_name === "googleAds")?.description || "";
    h.check("doc binding: the GrowthAgent declares EVERY surface the project_context names",
      CONTEXT_SURFACES.every((s) => declared.includes(s)),
      JSON.stringify({ declared, missing: CONTEXT_SURFACES.filter((s) => !declared.includes(s)) }));
    h.check("doc binding: the googleAds tool keeps its bounded description",
      adsDesc.length > 0 && adsDesc.length <= 2000, String(adsDesc.length));

    // ---- 5. INVALID PROJECT: a context carrying a nonexistent id never resolves ----
    // A transient 500 (worker transport artifact) is retried once before the refusal is judged.
    let invalid = await callFn("googleAds", `missing-${stamp}`, { action: "account_get", channel: "google" });
    if (invalid.status >= 500) invalid = await callFn("googleAds", `missing-${stamp}`, { action: "account_get", channel: "google" });
    h.check("invalid project: a nonexistent project_id is refused by the surface (never resolves to a default)",
      invalid.status !== 200 && [403, 404].includes(invalid.status), JSON.stringify(invalid));

    // ---- 5a. NAME-AS-ID REGRESSION: the composer's text carries the canonical id tag, the
    // display name never resolves, and the canonical id resolves on zernio:meta (read only) ----
    const tagged = `Run Meta Ads for project "${projA.name}". (googleAds surface, channel zernio:meta)\n\n[project_id: ${projA.id}]`;
    await base44.agents.addMessage(conv, { role: "user", content: tagged, custom_context: [{ type: CONTEXT_TYPE, message: CONTEXT_MESSAGE, data: { project_id: projA.id } }] });
    const afterTag = await base44.agents.getConversation(conv.id);
    const tagMsg = (afterTag?.messages || []).filter((m) => m.role === "user" && String(m.content || "").includes("[project_id:")).pop();
    h.check("name-as-id: the shipped text carries the canonical project_id tag matching the context id",
      !!tagMsg && tagMsg.content.endsWith(`[project_id: ${projA.id}]`) && tagMsg.custom_context?.[0]?.data?.project_id === projA.id, String(tagMsg?.content || "").slice(-60));
    let byName = await callFn("googleAds", projA.name, { action: "account_get", channel: "zernio:meta" });
    if (byName.status >= 500) byName = await callFn("googleAds", projA.name, { action: "account_get", channel: "zernio:meta" });
    h.check("name-as-id: the project's display name is refused as project_id (never resolved by name)",
      byName.status !== 200, JSON.stringify(byName).slice(0, 200));
    const byId = await callFn("googleAds", projA.id, { action: "account_get", channel: "zernio:meta" });
    h.check("name-as-id: the canonical id resolves through loadAuthorizedProject on zernio:meta",
      byId.status === 200 && "account" in (byId.data || {}), JSON.stringify(byId).slice(0, 200));

    // ---- 5b. UNAUTHORIZED PROJECT: the context cannot authorize a foreign project ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, projA.id, "project.read"));
    h.check("unauthorized project: a non-member is refused at the project gate (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
    const strangerAds = await callFn("googleAds", foreignProj.id, { action: "launch_readiness", channel: "google" });
    h.check("unauthorized project: the live googleAds surface refuses the foreign project_id (403)",
      strangerAds.status === 403, JSON.stringify(strangerAds));

    // ---- 6. LAUNCH AUTHORIZATION (Google Ads + Managed Ads), unchanged ----
    const readiness = await callFn("googleAds", projA.id, { action: "launch_readiness", channel: "google" });
    h.check("launch authorization: launch_readiness reports ready:false with the provider blocker",
      readiness.status === 200 && readiness.data?.ready === false && (readiness.data?.blockers || []).includes("PROVIDER_NOT_CONFIGURED"),
      JSON.stringify(readiness.data || {}).slice(0, 300));
    const launch = await callFn("googleAds", projA.id, { action: "launch", channel: "google", campaign_name: "cert", daily_budget_micros: 10000000, landing_page: "https://example.invalid" });
    h.check("launch authorization: the launch operation refuses closed before anything is created",
      launch.status === 409 && launch.code === "PROVIDER_NOT_CONFIGURED", JSON.stringify(launch));
    const accept = await callFn("managedAds", projA.id, { action: "recommendation_accept", channel: "google", report_id: "none", campaign_id: "none" });
    h.check("launch authorization: managedAds recommendation_accept refuses without a synced recommendation (no report, no approval, no execution)",
      accept.status === 404 && accept.code === "REPORT_NOT_FOUND", JSON.stringify(accept));

    // ---- 7. CROSS-PROJECT ISOLATION: the second project's surface sees NOTHING of the first ----
    const other = await callFn("googleAds", projB.id, { action: "campaign_list", channel: "google" });
    h.check("cross-project isolation: the second project's ads surface is empty after the first project's calls",
      other.status === 200 && Array.isArray(other.data?.campaigns) && other.data.campaigns.length === 0, JSON.stringify(other.data || {}));

    // ---- 8. NO UNINTENDED PERSISTENCE ----
    const counts = {};
    for (const name of AD_DATA_ENTITIES) counts[name] = (await svc.entities[name].filter({ project_id: projA.id }, "-created_date", 100)).length;
    const projectAfter = await svc.entities.Project.get(projA.id);
    h.check("no unintended persistence: zero Ads rows, zero jobs, and the project's version untouched",
      AD_DATA_ENTITIES.every((n) => counts[n] === 0) && projectAfter.version_count === 3, JSON.stringify({ counts, version_count: projectAfter.version_count }));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const cid of conversationIds) await svc.entities.Conversation.delete(cid).catch(() => {});
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
    for (const wid of workspaceIds) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}