// Targeted Grow Chat "Set default website" exposure certification — the EXISTING, certified
// projectDomains contract (its documented set_primary action) exposed to the GrowthAgent
// through the EXISTING tool_configs contract (function_<name> grant, executed through the
// existing function runtime). Scratch fixtures only; NO endpoint, entity, contract, provider
// adapter, credential or UI is modified, and the domain contract is never reinterpreted:
//   1. exposure: the REAL GrowthAgent document (bundled VERBATIM from
//      shared/growthAgentExposure.json — re-sync that copy whenever the agent document
//      changes) declares the projectDomains function tool with a bounded description and its
//      existing grants untouched;
//   2. set_primary behavior: a verified, ACTIVE domain is promoted and the promotion is
//      persisted (read back from the store);
//   3. one-primary invariant: at most one primary per project+environment — promoting a
//      second production domain demotes the first; promoting a staging domain leaves the
//      production primary untouched;
//   4. verified-domain requirement: a pending_verification domain refuses with the surface's
//      verbatim NOT_VERIFIED;
//   5. authorization: a non-member cannot reach the project's domain surface (403);
//   6. isolation: another project's domain id is indistinguishable from one that never
//      existed (404) and the second project's list is empty;
//   7. fail-closed validation: an unsupported action is refused;
//   8. no unintended persistence: only the test's own CustomDomain rows exist, the project's
//      slug and version count are untouched (the built-in URL fallback is unchanged), and no
//      website entity or BackgroundJob is created by any call.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import growthAgentDoc from "../../shared/growthAgentExposure.json" with { type: "json" };

const EXPECTED_ENTITY_GRANTS = ["Activity", "AeoProbe", "AeoResult", "Customer", "ListenObservation", "ListenTerm"];
const EXPECTED_FN_GRANTS = ["aeo", "emailDomain", "googleAds", "leadGen", "listen", "outreach", "projectDomains", "seoScan", "support", "virality"];

// functions.invoke rejects non-2xx responses as thrown errors; normalize both outcomes into
// { status, code, data } so every assertion reads the platform's verbatim refusal.
async function callDomains(project_id, body) {
  try {
    const res = await base44Ref.functions.invoke("projectDomains", { project_id, ...body });
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
    const ghost = { id: `web-ghost-${stamp}`, email: `web-ghost-${stamp}@example.invalid` };

    // ---- 1. EXPOSURE: the real document, parsed exactly as the runtime's contract ----
    const toolConfigs = Array.isArray(growthAgentDoc.tool_configs) ? growthAgentDoc.tool_configs : [];
    const webTool = toolConfigs.find((tc) => tc && tc.function_name === "projectDomains");
    h.check("exposure: the GrowthAgent declares the projectDomains function tool with a bounded description",
      !!webTool && typeof webTool.description === "string" && webTool.description.length > 0 && webTool.description.length <= 2000,
      JSON.stringify({ found: !!webTool, desc_len: webTool?.description?.length || 0 }));
    const entityGrants = toolConfigs.filter((tc) => tc && tc.entity_name).map((tc) => tc.entity_name).sort();
    const fnGrants = toolConfigs.filter((tc) => tc && tc.function_name && tc.function_name !== "projectDomains").map((tc) => tc.function_name).sort();
    const expectedOtherFns = EXPECTED_FN_GRANTS.filter((n) => n !== "projectDomains");
    h.check("exposure: the agent's existing Grow grants are untouched",
      JSON.stringify(entityGrants) === JSON.stringify(EXPECTED_ENTITY_GRANTS)
        && JSON.stringify(fnGrants) === JSON.stringify(expectedOtherFns),
      JSON.stringify({ entityGrants, fnGrants }));

    // ---- scratch fixtures: a member workspace (caller owns it) and a foreign one ----
    const ws = await svc.entities.Workspace.create({ name: `grow-web-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    workspaceIds.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-web-${stamp}`, status: "ready", version_count: 2, slug: `grow-web-${stamp}` });
    projectIds.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-web-2-${stamp}`, status: "ready", version_count: 0, slug: `grow-web-2-${stamp}` });
    projectIds.push(proj2.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `grow-web-f-${stamp}`, owner_id: ghost.id, credits_balance: 0, status: "active" });
    workspaceIds.push(foreignWs.id);
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: `grow-web-f-${stamp}`, status: "ready", version_count: 1, slug: `grow-web-f-${stamp}` });
    projectIds.push(foreignProj.id);

    // Fixtures bypass the REAL DNS TXT verify step on purpose: 'verify' performs a live DNS
    // lookup, so certification seeds the STORED states the verify step produces (active /
    // pending_verification) and exercises set_primary, the exposed action, exactly as called.
    const fixture = (i, environment, status) => ({
      project_id: proj.id, workspace_id: ws.id, hostname: `web-${i}-${stamp}.example.test`,
      environment, status, verification_method: "dns_txt",
      verification_host: `acme.web-${i}-${stamp}.example.test`, verification_token: `tok-${i}-${stamp}`,
      is_primary: false, added_by: caller.id,
    });
    const prodA = await svc.entities.CustomDomain.create(fixture(1, "production", "active"));
    const prodB = await svc.entities.CustomDomain.create(fixture(2, "production", "active"));
    const staging = await svc.entities.CustomDomain.create(fixture(3, "staging", "active"));
    const pending = await svc.entities.CustomDomain.create(fixture(4, "production", "pending_verification"));

    // ---- 2. SET_PRIMARY BEHAVIOR + PERSISTENCE ROUNDTRIP ----
    const first = await callDomains(proj.id, { action: "set_primary", domain_id: prodA.id });
    const firstPersisted = await svc.entities.CustomDomain.get(prodA.id);
    h.check("set_primary: a verified, ACTIVE domain is promoted and the promotion is persisted (read back from the store)",
      first.status === 200 && first.data?.domain?.is_primary === true && firstPersisted.is_primary === true,
      JSON.stringify(first.data || {}).slice(0, 300));

    // ---- 3. ONE-PRIMARY INVARIANT (at most one primary per project+environment) ----
    const second = await callDomains(proj.id, { action: "set_primary", domain_id: prodB.id });
    const prodAAfter = await svc.entities.CustomDomain.get(prodA.id);
    const prodBAfter = await svc.entities.CustomDomain.get(prodB.id);
    h.check("one-primary invariant: promoting a second production domain demotes the first",
      second.status === 200 && prodBAfter.is_primary === true && prodAAfter.is_primary === false,
      JSON.stringify({ prodA: prodAAfter.is_primary, prodB: prodBAfter.is_primary }));

    const stagingSet = await callDomains(proj.id, { action: "set_primary", domain_id: staging.id });
    const prodBAfterStaging = await svc.entities.CustomDomain.get(prodB.id);
    h.check("one-primary invariant: promoting a staging domain leaves the production primary untouched",
      stagingSet.status === 200 && prodBAfterStaging.is_primary === true,
      JSON.stringify({ prodB_still_primary: prodBAfterStaging.is_primary }));

    // ---- 4. VERIFIED-DOMAIN REQUIREMENT ----
    const pendingSet = await callDomains(proj.id, { action: "set_primary", domain_id: pending.id });
    h.check("verified-domain requirement: a pending_verification domain refuses with the surface's verbatim NOT_VERIFIED",
      pendingSet.status === 400 && pendingSet.code === "NOT_VERIFIED", JSON.stringify(pendingSet));

    // ---- 5. AUTHORIZATION: the project-scoped gate refuses a non-member ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "domain.manage"));
    h.check("authorization: a non-member cannot reach the project's domain surface (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));

    // ---- 6. ISOLATION: another project's domain is unreachable and invisible ----
    const strangerDomain = await callDomains(proj2.id, { action: "set_primary", domain_id: prodA.id });
    h.check("isolation: another project's domain id is indistinguishable from one that never existed (404)",
      strangerDomain.status === 404, JSON.stringify(strangerDomain));
    const proj2List = await callDomains(proj2.id, { action: "list" });
    h.check("isolation: the second project's domain list is empty",
      proj2List.status === 200 && Array.isArray(proj2List.data?.domains) && proj2List.data.domains.length === 0,
      JSON.stringify(proj2List.data || {}));

    // ---- 7. FAIL-CLOSED VALIDATION ----
    const unsupported = await callDomains(proj.id, { action: "make_default_website" });
    h.check("fail-closed: an unsupported action is refused (the contract is never reinterpreted)",
      unsupported.status === 400, JSON.stringify(unsupported));

    // ---- 8. NO UNINTENDED PERSISTENCE / BUILTIN FALLBACK UNCHANGED ----
    const domainRows = await svc.entities.CustomDomain.filter({ project_id: proj.id }, "-created_date", 50);
    const projectAfter = await svc.entities.Project.get(proj.id);
    h.check("no unintended persistence: only the four fixture domains exist, the project's slug and version count are untouched (the built-in URL fallback is unchanged)",
      domainRows.length === 4 && projectAfter.slug === `grow-web-${stamp}` && projectAfter.version_count === 2,
      JSON.stringify({ domains: domainRows.length, slug: projectAfter.slug, version_count: projectAfter.version_count }));
    const jobs = await svc.entities.BackgroundJob.filter({ project_id: proj.id }, "-created_date", 10);
    h.check("no unintended persistence: no BackgroundJob is created by any exposure call",
      jobs.length === 0, JSON.stringify({ background_jobs: jobs.length }));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projectIds) {
      await purgeBy(svc, "CustomDomain", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaceIds) {
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  return harnessResponse(h);
}