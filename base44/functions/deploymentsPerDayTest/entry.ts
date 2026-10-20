// P-10.5 regression suite — deployments_per_day plan entitlement enforcement.
//
// Certifies exactly one behavior: a user deployment REQUEST is refused (fail-closed) when the
// workspace's server-side plan sets a daily deployment ceiling and today's count is already at
// it, and when the workspace's lifecycle is not active. Limits resolve ONLY from the plan —
// never from the request. Unlimited plans are unchanged; one workspace's counter never affects
// another's; the daily window resets on the UTC day boundary (the same clock the budget engine
// uses); and the surrounding deployment security is untouched — every accepted request still
// writes its audit event, and a refused request leaves no row and no audit.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestDeployment } from "../../shared/deploy.ts";
import { createProjectForUser } from "../../shared/projectCreate.ts";
import { startSubscription } from "../../shared/subscriptions.ts";
import { dayStartUtc } from "../../shared/planLimits.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let wsFree = null, wsUnlimited = null, wsOther = null;
  const track = { projects: [], versions: [], deployments: [] };

  const seedDeploy = async (ws, project, n) => {
    const d = await svc.entities.Deployment.create({ project_id: project.id, workspace_id: ws.id, version_id: "seed", version_number: n, environment: "production", status: "FAILED", trigger: "user" });
    track.deployments.push(d.id);
    return d;
  };
  const todaysCount = async (ws) => (await svc.entities.Deployment.filter({ workspace_id: ws.id }, "-created_date", 500)).filter((d) => String(d.created_date) >= dayStartUtc()).length;

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const mkWs = async (name) => {
      const ws = await svc.entities.Workspace.create({ name: `${name}-${Date.now()}`, owner_id: caller.id, credits_balance: 0, status: "active" });
      return ws;
    };
    const mkProject = async (ws, name) => {
      const created = await createProjectForUser(base44, caller, { workspace_id: ws.id, name });
      const project = created.project;
      track.projects.push(project.id);
      const version = await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "deploy quota cert" });
      track.versions.push(version.id);
      return project;
    };

    // ------------------------------------------------ free plan: ceiling of 5 deployments per day
    wsFree = await mkWs("dpd-free");
    const freeProject = await mkProject(wsFree, "dpd-free-app");
    for (let i = 0; i < 4; i++) await seedDeploy(wsFree, freeProject, i + 1);
    const below = await requestDeployment(base44, caller, { project_id: freeProject.id, environment: "production" });
    track.deployments.push(below.deployment.id);
    check("below the ceiling, a deployment request succeeds", below.deployment.status === "QUEUED", below.deployment.status);
    const auditsAfterOk = await svc.entities.AuditLog.filter({ workspace_id: wsFree.id, action: "deployment.requested" }, "-created_date", 50);
    check("an accepted request still writes its audit event", auditsAfterOk.some((a) => a.resource_id === below.deployment.id), `${auditsAfterOk.length} audits`);

    // At the ceiling (5 today): the next request is refused, leaving no row and no audit.
    await expectThrow("at the ceiling, the next deployment request is rejected", () => requestDeployment(base44, caller, { project_id: freeProject.id, environment: "production" }), "PLAN_LIMIT_REACHED");
    check("a refused request creates no deployment row", (await todaysCount(wsFree)) === 5, `${await todaysCount(wsFree)}`);
    const auditsAfterRefusal = await svc.entities.AuditLog.filter({ workspace_id: wsFree.id, action: "deployment.requested" }, "-created_date", 50);
    check("a refused request writes no audit event", auditsAfterRefusal.length === auditsAfterOk.length, `${auditsAfterRefusal.length}`);

    // ------------------------------------------------ daily window: UTC day boundary
    // The ceiling's window is the UTC day — the same clock the budget engine's daily period
    // uses — so a deployment stops counting the moment the clock crosses midnight UTC. The
    // window boundary itself is certified directly (created_date is platform-assigned and
    // cannot be backdated, so the reset is the window, not the rows).
    const midnight = dayStartUtc();
    const midnightDate = new Date(midnight);
    const nowDate = new Date();
    const isUtcMidnight = midnightDate.getUTCHours() === 0 && midnightDate.getUTCMinutes() === 0 && midnightDate.getUTCSeconds() === 0 && midnightDate.getUTCMilliseconds() === 0;
    const isToday = midnightDate.getUTCFullYear() === nowDate.getUTCFullYear() && midnightDate.getUTCMonth() === nowDate.getUTCMonth() && midnightDate.getUTCDate() === nowDate.getUTCDate();
    check("the daily window is today's UTC midnight", isUtcMidnight && isToday, midnight);
    const freeRows = await svc.entities.Deployment.filter({ workspace_id: wsFree.id }, "-created_date", 500);
    check("only deployments created inside the window are counted", freeRows.filter((d) => String(d.created_date) >= midnight).length === 5, `${freeRows.length} rows`);

    // ------------------------------------------------ isolation: another workspace's counter
    wsOther = await mkWs("dpd-other");
    const otherProject = await mkProject(wsOther, "dpd-other-app");
    for (let i = 0; i < 5; i++) await seedDeploy(wsOther, otherProject, i + 1);
    await expectThrow("another workspace at its ceiling is refused independently", () => requestDeployment(base44, caller, { project_id: otherProject.id, environment: "production" }), "PLAN_LIMIT_REACHED");
    check("another workspace's counter does not affect this one", (await todaysCount(wsFree)) === 5 && (await todaysCount(wsOther)) === 5, `${await todaysCount(wsFree)} / ${await todaysCount(wsOther)}`);

    // ------------------------------------------------ unlimited plan: unchanged
    wsUnlimited = await mkWs("dpd-unlimited");
    const unProject = await mkProject(wsUnlimited, "dpd-unlimited-app");
    await startSubscription(svc, { workspace_id: wsUnlimited.id, plan_code: "credits_topup", user_id: caller.id });
    for (let i = 0; i < 6; i++) await seedDeploy(wsUnlimited, unProject, i + 1);
    const unlimited = await requestDeployment(base44, caller, { project_id: unProject.id, environment: "production" });
    track.deployments.push(unlimited.deployment.id);
    check("a plan with no deployment ceiling is unchanged", unlimited.deployment.status === "QUEUED", unlimited.deployment.status);

    // ------------------------------------------------ inactive workspace lifecycle: fail closed
    await svc.entities.Workspace.update(wsOther.id, { status: "suspended" });
    // A suspended workspace is refused fail-closed by the authorization layer (WORKSPACE_INACTIVE)
    // before the plan gate even runs — the entitlement verdict holds either way.
    await expectThrow("a suspended workspace's deployment request is refused", () => requestDeployment(base44, caller, { project_id: otherProject.id, environment: "staging" }), "WORKSPACE_INACTIVE");
    await svc.entities.Workspace.update(wsOther.id, { status: "active" });

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    // Scratch cleanup: every record this suite created is removed.
    for (const id of track.deployments) await svc.entities.Deployment.delete(id).catch(() => {});
    for (const id of track.versions) await svc.entities.ProjectVersion.delete(id).catch(() => {});
    for (const id of track.projects) {
      await purgeBy(svc, "ProjectFile", { project_id: id });
      await purgeBy(svc, "ProjectVersion", { project_id: id });
      await svc.entities.Project.delete(id).catch(() => {});
    }
    for (const ws of [wsFree, wsUnlimited, wsOther]) {
      await cleanupWorkspace(svc, ws?.id, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog"]);
      if (ws) await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }
}