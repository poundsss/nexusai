// Targeted Grow Chat EMAIL-DOMAIN exposure certification — closes the "Set up email" gap the
// exact way the audit classified it: the EXISTING certified `emailDomain` surface exposed to
// the GrowthAgent through the EXISTING tool_configs contract (function_<name> grant, executed
// through the existing function runtime). Scratch fixtures only; NO new endpoint is created
// (the surface already exists as the certified project-authorized `emailDomain` function) and
// NO Runable mailbox semantics are invented — this manages the app's own SENDING domain, not
// an inbox. ZERO provider side effects: with the management PAT unconfigured the surface
// refuses fail-closed BEFORE any action validation or network call.
//   1. exposure: the REAL GrowthAgent document (bundled VERBATIM from
//      shared/growthAgentExposure.json) declares the emailDomain function tool with a bounded
//      description and its existing grants untouched;
//   2. invocation: the existing list action returns the surface's real fail-closed response
//      (EMAIL_DOMAIN_SECRET_NOT_CONFIGURED) — no management PAT is configured in this app;
//   3. ordering: a mutating action hits the SAME fail-closed gate first (the surface refuses
//      on the missing PAT before validating the action or calling any network);
//   4. authorization: the project-scoped gate refuses a non-member (403);
//   5. no unintended persistence: zero EmailDomain rows and zero AuditLog rows result from
//      any call (the surface refused before its audit point), and the project is untouched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import growthAgentDoc from "../../shared/growthAgentExposure.json" with { type: "json" };

const EXPECTED_ENTITY_GRANTS = ["Activity", "AeoProbe", "AeoResult", "Customer", "ListenObservation", "ListenTerm"];
const EXPECTED_FN_GRANTS = ["aeo", "emailDomain", "googleAds", "leadGen", "listen", "outreach", "projectDomains", "seoScan", "support", "virality"];

async function callEmailDomain(project_id, body) {
  try {
    const res = await base44Ref.functions.invoke("emailDomain", { project_id, ...body });
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
    const ghost = { id: `grow-edomain-ghost-${stamp}`, email: `grow-edomain-ghost-${stamp}@example.invalid` };

    // ---- 1. EXPOSURE: the real document, parsed exactly as the runtime's contract ----
    const toolConfigs = Array.isArray(growthAgentDoc.tool_configs) ? growthAgentDoc.tool_configs : [];
    const domainTool = toolConfigs.find((tc) => tc && tc.function_name === "emailDomain");
    h.check("exposure: the GrowthAgent declares the emailDomain function tool with a bounded description",
      !!domainTool && typeof domainTool.description === "string" && domainTool.description.length > 0 && domainTool.description.length <= 2000,
      JSON.stringify({ found: !!domainTool, desc_len: domainTool?.description?.length || 0 }));
    const entityGrants = toolConfigs.filter((tc) => tc && tc.entity_name).map((tc) => tc.entity_name).sort();
    const fnGrants = toolConfigs.filter((tc) => tc && tc.function_name).map((tc) => tc.function_name).sort();
    h.check("exposure: the agent's existing Grow grants are untouched (outreach + emailDomain added, nothing removed)",
      JSON.stringify(entityGrants) === JSON.stringify(EXPECTED_ENTITY_GRANTS)
        && JSON.stringify(fnGrants) === JSON.stringify(EXPECTED_FN_GRANTS),
      JSON.stringify({ entityGrants, fnGrants }));

    // ---- scratch fixtures ----
    const ws = await svc.entities.Workspace.create({ name: `grow-edomain-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    workspaceIds.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `grow-edomain-${stamp}`, status: "ready", version_count: 2 });
    projectIds.push(proj.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `grow-edomain-f-${stamp}`, owner_id: ghost.id, credits_balance: 0, status: "active" });
    workspaceIds.push(foreignWs.id);
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: `grow-edomain-f-${stamp}`, status: "ready", version_count: 0 });
    projectIds.push(foreignProj.id);

    // ---- 2. EXISTING SURFACE INVOCATION: the surface's real fail-closed response ----
    const list = await callEmailDomain(proj.id, { action: "list" });
    h.check("invocation: the existing emailDomain list returns the surface's verbatim fail-closed EMAIL_DOMAIN_SECRET_NOT_CONFIGURED (503) with no management PAT",
      list.status === 503 && list.code === "EMAIL_DOMAIN_SECRET_NOT_CONFIGURED", JSON.stringify(list));

    // ---- 3. FAIL-CLOSED ORDERING: a mutating action hits the SAME PAT gate first ----
    const disable = await callEmailDomain(proj.id, { action: "disable", domain: "example.invalid" });
    h.check("fail-closed: the disable mutation returns the SAME verbatim EMAIL_DOMAIN_SECRET_NOT_CONFIGURED before any action validation or network call",
      disable.status === 503 && disable.code === "EMAIL_DOMAIN_SECRET_NOT_CONFIGURED", JSON.stringify(disable));

    const unknown = await callEmailDomain(proj.id, { action: "nope" });
    h.check("fail-closed ordering: even an unknown action refuses with the PAT gate first (the surface validates the token BEFORE the action)",
      unknown.status === 503 && unknown.code === "EMAIL_DOMAIN_SECRET_NOT_CONFIGURED", JSON.stringify(unknown));

    // ---- 4. AUTHORIZATION: the project-scoped gate refuses a non-member ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot reach the project's email-domain surface (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));

    // ---- 5. NO UNINTENDED PERSISTENCE / NO PROVIDER SIDE EFFECTS ----
    const domains = (await svc.entities.EmailDomain.filter({ project_id: proj.id }, "-created_date", 10)) || [];
    const audits = (await svc.entities.AuditLog.filter({ project_id: proj.id }, "-created_date", 10)) || [];
    const projectAfter = await svc.entities.Project.get(proj.id);
    h.check("no unintended persistence: zero EmailDomain rows, zero AuditLog rows (the surface refused before its audit point), and the project untouched",
      domains.length === 0 && audits.length === 0 && projectAfter.version_count === 2,
      JSON.stringify({ domains: domains.length, audits: audits.length, version_count: projectAfter.version_count }));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projectIds) {
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await purgeBy(svc, "EmailDomain", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaceIds) {
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  return harnessResponse(h);
}