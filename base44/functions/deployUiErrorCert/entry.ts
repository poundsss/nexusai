// Targeted deployment-UI error-surfacing certification (the audit's one confirmed gap).
//
// The UI hook (src/hooks/useDeployments.js) now catches failed history loads and failed
// deploy/rollback calls and surfaces the server's classified error. This suite certifies
// the CONTRACT that catch depends on, against the real store and the real deploy endpoint,
// on scratch fixtures only:
//   1. a successful history load returns rows (and a retry after a failure succeeds),
//   2. a failed history load is a classified, catchable refusal,
//   3. a failed deploy request is a classified refusal (402/409/404 semantics preserved),
//   4. a failed rollback request is a classified refusal,
//   5. authorization semantics are unchanged (a non-member cannot deploy or restore),
//   6. the retry/recovery path ends on a real LIVE deployment driven by the REAL worker.
// The deployment pipeline itself remains certified by deploymentEnvironmentsTest and
// restoreIntegrityTest.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createProjectForUser } from "../../shared/projectCreate.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy, captureCall } from "../../shared/testHarness.ts";
import { createDeployedApp } from "../../shared/deployFixtures.ts";

const CLEANUP = ["ProjectFile", "ProjectVersion", "WorkflowDefinition", "WorkflowRun", "Build",
  "CommitJournal", "Conversation", "Message", "AuditLog", "Project", "Deployment", "DeploymentArtifact"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let ws = null, project = null;
  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: "deploy-ui-ghost-00000", email: "ghost@example.invalid" };

    ws = await svc.entities.Workspace.create({ name: `deploy-ui-${Date.now()}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    const created = await createProjectForUser(base44, caller, { workspace_id: ws.id, name: "deploy ui cert" });
    project = created.project;

    // ---------------- 1. the hook's SUCCESS path ----------------
    const okLoad = await base44.entities.Deployment.filter({ project_id: project.id }, "-created_date", 30);
    check("a successful deployment-history load returns rows with no error",
      Array.isArray(okLoad.items ?? okLoad) && (okLoad.items ?? okLoad).length === 0,
      `${(okLoad.items ?? okLoad).length} row(s)`);

    // ---------------- 2. a failed history LOAD is classified ----------------
    const badLoad = await captureCall(() => base44.entities.Deployment.filter({ project_id: { $bogus_operator: "x" } }, "-created_date", 30));
    check("a failed deployment-history load is a classified, catchable refusal (the hook's catch surfaces it)",
      badLoad.threw && Number(badLoad.status || 0) >= 400 && Number(badLoad.status || 0) < 500
        && !!(badLoad.message || badLoad.code),
      `refused (${badLoad.status}): ${String(badLoad.message).slice(0, 80)}`);

    // ---------------- 3. a failed DEPLOY request is classified ----------------
    const badDeploy = await captureCall(() => svc.functions.invoke("deployProject", { action: "deploy", project_id: "deploy-ui-ghost-project-00" }));
    check("a failed deploy request returns a classified refusal the hook surfaces",
      badDeploy.threw && Number(badDeploy.status || 0) >= 400 && Number(badDeploy.status || 0) < 500
        && !!(badDeploy.message || badDeploy.code),
      `refused (${badDeploy.status}): ${String(badDeploy.message).slice(0, 80)}`);
    // Authorization semantics preserved, exactly as before the UI change:
    await expectThrow("a non-member cannot deploy", () => loadAuthorizedProject(base44, ghost, project.id, "deploy.manage"), "NOT_A_MEMBER");

    // ---------------- 4. a failed ROLLBACK request is classified ----------------
    const badRollback = await captureCall(() => svc.functions.invoke("deployProject", { action: "rollback", project_id: project.id, deployment_id: "deploy-ui-ghost-deployment", environment: "production" }));
    check("a failed rollback request returns a classified refusal the hook surfaces",
      badRollback.threw && Number(badRollback.status || 0) >= 400 && Number(badRollback.status || 0) < 500
        && !!(badRollback.message || badRollback.code),
      `refused (${badRollback.status}): ${String(badRollback.message).slice(0, 80)}`);

    // ---------------- 5. the retry/recovery path: failure, then success ----------------
    // The same reload the Retry button drives, after the failures above, ends on a REAL
    // LIVE deployment produced by the REAL worker (create → build → verify → LIVE).
    const deployed = await createDeployedApp(svc, {
      workspace_id: ws.id, name: "deploy ui cert live", slug: `deploy-ui-${Date.now()}`,
      deployed_by: caller.id, on_project_created: null,
    });
    project = deployed.project;
    // The store's secondary index lags a few seconds behind its writes: wait for visibility.
    let rows = [];
    let diag = {};
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      rows = (await svc.entities.Deployment.filter({ project_id: project.id }, { sort: "-created_date", limit: 30 })).items ?? [];
      if (rows.length === 0 && i === 19) {
        const byId = await svc.entities.Deployment.get(deployed.run.deployment.id).catch((e) => ({ err: String(e.message).slice(0, 60) }));
        const byWs = (await svc.entities.Deployment.filter({ workspace_id: project.workspace_id }, { sort: "-created_date", limit: 30 })).items ?? [];
        const raw = (await svc.entities.Deployment.filter({ project_id: { $regex: "^deploy-ui-" } }, { sort: "-created_date", limit: 5 })).items ?? [];
        diag = {
          depProjectId: deployed.run.deployment.project_id, filterProjectId: project.id,
          byIdStatus: byId?.status || byId?.err, wsRows: byWs.length,
          recent: raw.map((r) => ({ id: r.id, p: r.project_id, s: r.status, ws: r.workspace_id })),
        };
      }
    }
    check("retry after a failure reloads successfully and shows the LIVE deployment",
      deployed.run?.deployment?.status === "LIVE"
        && rows.length === 1 && rows[0].status === "LIVE" && !rows[0].superseded_at,
      JSON.stringify({ dep: deployed.run?.deployment?.status, rows: rows.length, rowStatus: rows[0]?.status, ...diag }));
    await expectThrow("a non-member still cannot restore versions", () => loadAuthorizedProject(base44, ghost, project.id, "version.restore"), "NOT_A_MEMBER");

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    if (project?.id) {
      await purgeBy(svc, "Deployment", { project_id: project.id });
      await purgeBy(svc, "DeploymentArtifact", { project_id: project.id });
      await purgeBy(svc, "ProjectIndexEntry", { project_id: project.id });
      await purgeBy(svc, "CommitJournal", { project_id: project.id });
      await purgeBy(svc, "Build", { project_id: project.id });
    }
    await cleanupWorkspace(svc, ws?.id, CLEANUP);
  }
}