// Builder UI parity certification suite — read-only over the engines, strict over the contracts
// the Builder surfaces depend on: the project load contract, workspace isolation and the
// permission boundaries (the SAME server-side guards the panes route through), version
// navigation and restore, preview source readability, and the workflow management API the
// Logic pane uses. The deployment pipeline itself is certified by deploymentEnvironmentsTest.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createProjectForUser } from "../../shared/projectCreate.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { builderProjectRead } from "../../shared/builderProjectRead.ts";
import { restoreProjectVersion } from "../../shared/versionRestore.ts";
import { createWorkflow, updateWorkflow, validateWorkflowDefinition, listWorkflows, triggerWorkflow } from "../../shared/workflowApi.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy, captureCall } from "../../shared/testHarness.ts";
import { ensureProjectSlug } from "../../shared/deploy.ts";

const CLEANUP = ["ProjectFile", "ProjectVersion", "WorkflowDefinition", "WorkflowRun", "Build", "CommitJournal", "Conversation", "Message", "AuditLog", "AppRole", "AppTeam", "Project"];
const ENDPOINT = "https://enormous-quick-start-flow.base44.app/functions";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let ws = null, project = null;
  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: "builder-ui-ghost-000000", email: "ghost@example.invalid" };

    // A scratch workspace + project — created through the REAL server-authoritative path, with
    // its scaffold files and initial version, exactly what the Builder loads on open.
    ws = await svc.entities.Workspace.create({ name: `builder-ui-${Date.now()}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    const created = await createProjectForUser(base44, caller, { workspace_id: ws.id, name: "builder ui cert" });
    project = created.project;
    const version1 = created.version;

    // ---------------- the Builder's load contract ----------------
    // The Builder's project row itself is served by the same authorized read (direct
    // Project/Workspace/Deployment/AppRecord SDK access is locked server-side).
    const read = await builderProjectRead(base44, caller, project.id);
    const [entityRows, versionRows] = await Promise.all([
      base44.entities.AppEntity.filter({ project_id: project.id }, "name", 200),
      base44.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 100),
    ]);
    const p = read.project;
    const fileRows = read.files;
    check("the Builder's data contract loads for an authorized member",
      p?.id === project.id && fileRows.length > 0 && Array.isArray(entityRows) && versionRows[0]?.number === 1,
      `${fileRows.length} files`);
    const src = fileRows.find((f) => typeof f.content === "string" && f.content.length > 0);
    check("the preview's sources are readable project files", !!src, src?.path || "none");
    check("the initial version carries its file snapshot",
      Array.isArray(version1?.snapshot?.files) && version1.snapshot.files.length > 0, `${version1?.snapshot?.files?.length || 0} files`);

    // ---------------- workspace isolation and permissions (the same guards the surfaces use) ----------------
    await expectThrow("a non-member cannot load another account's project", () => loadAuthorizedProject(base44, ghost, project.id, "project.read"), "NOT_A_MEMBER");
    await expectThrow("a non-member cannot create a project in the workspace", () => createProjectForUser(base44, ghost, { workspace_id: ws.id, name: "nope" }), "NOT_A_MEMBER");
    await expectThrow("a non-member cannot restore a version", () => loadAuthorizedProject(base44, ghost, project.id, "version.restore"), "NOT_A_MEMBER");
    await expectThrow("a non-member cannot deploy", () => loadAuthorizedProject(base44, ghost, project.id, "deploy.manage"), "NOT_A_MEMBER");
    await expectThrow("a non-member cannot manage workflows", () => listWorkflows(base44, ghost, { project_id: project.id }), "NOT_A_MEMBER");
    const auditRead = await captureCall(() => base44.entities.AuditLog.filter({ workspace_id: ws.id }, "-created_date", 10));
    check("audit history is never exposed to the client",
      auditRead.threw || auditRead.value.length === 0, auditRead.threw ? `refused (${auditRead.status})` : `${auditRead.value.length}`);

    // ---------------- the AI / agent / deploy endpoints require authentication ----------------
    for (const [name, fn] of [["AI run", "aiRun"], ["agent run", "agentRun"], ["deployment", "deployProject"], ["workflow management", "workflows"]]) {
      const probe = await fetch(`${ENDPOINT}/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      check(`the ${name} endpoint refuses unauthenticated calls`, probe.status === 401, `${probe.status}`);
    }

    // ---------------- version navigation: timeline, restore, optimistic concurrency ----------------
    const wsRow = await svc.entities.Workspace.get(ws.id);
    const restored = await restoreProjectVersion(base44, { project, workspace: wsRow, user: caller, versionId: version1.id });
    check("restoring a version creates a new version linked to its source",
      restored.version > version1.number && restored.restored_from_version === version1.number, `v${restored.version}`);
    const after = await base44.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 100);
    check("version history stays ordered after a restore",
      after[0]?.number === restored.version && after[0]?.restored_from_version_id === version1.id, `v${after[0]?.number}`);
    await expectThrow("a restore from a stale view is refused (optimistic concurrency)",
      () => restoreProjectVersion(base44, { project, workspace: wsRow, user: caller, versionId: version1.id, baseVersionNumber: 99 }), "VERSION_CONFLICT");

    // ---------------- the Logic pane's workflow management contract ----------------
    const wf = await createWorkflow(base44, caller, { project_id: project.id, name: "Builder UI cert", description: "cert", trigger: { type: "manual" }, steps: [] });
    const listed = await listWorkflows(base44, caller, { project_id: project.id });
    check("workflow management routes through the authorized API",
      listed.project_id === project.id && listed.workflows.some((d) => d.workflow_definition_id === wf.workflow_definition_id), `${listed.count} workflow(s)`);
    await expectThrow("triggering requires a finalized workflow (a draft never executes)",
      () => triggerWorkflow(base44, caller, { project_id: project.id, name: "Builder UI cert" }), "WORKFLOW_NOT_FOUND");

    // ---------------- Logic pane: trigger management + validation gate (scratch draft only) ----------------
    const upd = await updateWorkflow(base44, caller, { workflow_definition_id: wf.workflow_definition_id, trigger: { type: "event", event: "order.created" } });
    check("trigger management routes through the authorized update API",
      upd.trigger_type === "event" && upd.trigger_event === "order.created", `${upd.trigger_type}/${upd.trigger_event || ""}`);
    const report = await validateWorkflowDefinition(base44, caller, { workflow_definition_id: wf.workflow_definition_id });
    check("validation reports before any finalize mutates state",
      typeof report.ok === "boolean" && Array.isArray(report.errors), `ok=${report.ok}`);

    // ---------------- Agents pane: run history contract ----------------
    const agentRuns = await base44.entities.AgentRun.filter({ project_id: project.id }, "-created_date", 10);
    check("the Agents pane's history contract is project-scoped",
      Array.isArray(agentRuns) && agentRuns.every((r) => r.project_id === project.id), `${agentRuns.length} run(s)`);

    // ---------------- Settings/Deploy: domain management contract ----------------
    const dom = await captureCall(() => base44.functions.invoke("projectDomains", { project_id: project.id, action: "list" }));
    check("the domain management contract serves this project's domains only",
      !dom.threw && Array.isArray(dom.value?.data?.domains) && (dom.value.data.project_id === undefined || dom.value.data.project_id === project.id),
      dom.threw ? `refused (${dom.status})` : `${dom.value?.data?.domains?.length || 0} domain(s)`);

    // ---------------- Publish panel contracts (Phase 3: web + mobile tabs) ----------------
    // The slug is assigned SERVER-side by the deploy path (ensureProjectSlug), so the
    // web tab's public address exists exactly once the project is deployed.
    const slug = await ensureProjectSlug(svc, p);
    check("the publish panel's web tab derives its public address from the deploy-assigned slug",
      typeof slug === "string" && slug.length > 0 && p.slug === slug, slug || "none");
    for (const [name, fn] of [["mobile build", "mobileBuild"], ["mobile store", "mobileStore"], ["version diff", "versionDiff"]]) {
      const probe = await fetch(`${ENDPOINT}/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      check(`the ${name} endpoint refuses unauthenticated calls`, probe.status === 401, `${probe.status}`);
    }
    const rels = await captureCall(() => base44.functions.invoke("mobileBuild", { action: "list_releases", project_id: project.id }));
    check("the publish panel's mobile tab reads releases project-scoped",
      !rels.threw && Array.isArray(rels.value?.data?.releases) && rels.value.data.releases.every((r) => r.project_id === project.id),
      rels.threw ? `refused (${rels.status})` : `${rels.value?.data?.releases?.length || 0} release(s)`);
    const subs = await captureCall(() => base44.functions.invoke("mobileStore", { action: "list_submissions", project_id: project.id }));
    check("the publish panel's mobile tab reads submissions project-scoped",
      !subs.threw && Array.isArray(subs.value?.data?.submissions) && subs.value.data.submissions.every((s) => s.project_id === project.id),
      subs.threw ? `refused (${subs.status})` : `${subs.value?.data?.submissions?.length || 0} submission(s)`);

    // ---------------- the Settings pane's security surface ----------------
    await svc.entities.AppRole.create({
      project_id: project.id, workspace_id: ws.id, key: "manager", name: "Manager",
      permissions: ["orders.*", "reports.read"], system: false, created_at: new Date().toISOString(),
    });
    const roleRead = await captureCall(() => base44.entities.AppRole.filter({ project_id: project.id }, "key", 50));
    check("application roles stay project-scoped on every read path",
      roleRead.threw || (roleRead.value.every((r) => r.project_id === project.id) && roleRead.value.length >= 1),
      roleRead.threw ? `refused (${roleRead.status}) — the pane degrades safely` : `${roleRead.value.length} role(s)`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    if (project?.id) {
      await purgeBy(svc, "ProjectIndexEntry", { project_id: project.id });
      await purgeBy(svc, "CommitJournal", { project_id: project.id });
      await purgeBy(svc, "Build", { project_id: project.id });
      // App data (seeded records + entity definitions) is keyed by project, not workspace.
      await purgeBy(svc, "AppRecord", { project_id: project.id });
      await purgeBy(svc, "AppEntity", { project_id: project.id });
      // Files and versions are project-keyed (no workspace_id), so the workspace pass misses them.
      await purgeBy(svc, "ProjectFile", { project_id: project.id });
      await purgeBy(svc, "ProjectVersion", { project_id: project.id });
      await svc.entities.Project.delete(project.id).catch(() => {});
    }
    await cleanupWorkspace(svc, ws?.id, CLEANUP);
  }
}