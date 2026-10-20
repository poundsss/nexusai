// Live sweep confirmation for the bounded-batch scheduler: creates a REAL scratch deployed
// app with one due trigger, lets the PLATFORM worker (the "Scheduled Triggers" workflow)
// execute it, then verifies the actual ScheduledRun/FunctionInvocation rows and cleans up.
// Ops:
//   setup   — scratch billing fixtures + deployed app + one due trigger (echoSched)
//   verify  — reads the run rows produced by the live sweep (requires ids from setup)
//   cleanup — purges everything the setup created (requires the ids from setup)
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createDeployedApp, MINIMAL_MAIN, MINIMAL_STYLES } from "../../shared/deployFixtures.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";

const FN_ECHO = `export const config = { method: 'ANY' };
export default async function (ctx) {
  return { status: 200, body: ctx.request.body || null };
}`;
const APP = `import { html } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">Live</h1></div>\`; }
`;

// Fixture identity checks: only rows minted by this function's own setup may be read or deleted.
const isFixtureWorkspace = (ws) => !!ws && String(ws.name || "").startsWith("billing-test p9lv") && String(ws.owner_id || "").startsWith("billing_owner_p9lv");
const isFixturePlan = (plan) => !!plan && String(plan.code || "").startsWith("test_p9lv");
async function fixtureProject(db, projectId) {
  const project = await db.entities.Project.get(projectId).catch(() => null);
  if (!project || !String(project.slug || "").startsWith("p9lv-")) return null;
  const ws = await db.entities.Workspace.get(project.workspace_id).catch(() => null);
  return isFixtureWorkspace(ws) ? project : null;
}
const forbidden = () => Response.json({ ok: false, error: "Forbidden" }, { status: 403 });

export default async function (req) {
  const client = createClientFromRequest(req);
  const caller = await client.auth.me().catch(() => null);
  if (!caller) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (caller.role !== "admin") return forbidden();
  const db = client.asServiceRole;
  const body = await req.json().catch(() => ({}));
  const op = String(body.op || "setup");
  const args = body || {};

  if (op === "setup") {
    const stamp = Date.now();
    const created = { workspaces: [], plans: [] };
    const plan = await makeBillingPlan(db, created, `p9lv${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9lv${stamp}`, { plan });
    const app = await createDeployedApp(db, {
      workspace_id: A.ws.id, name: `p9lv ${stamp}`, slug: `p9lv-${stamp}`, deployed_by: A.user.id,
      entities: [], files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", APP], ["styles.css", MINIMAL_STYLES]],
      extra_files: [["base44/functions/echoSched/entry.ts", FN_ECHO]],
    });
    if (app.run.status !== "LIVE") {
      await db.entities.Project.delete(app.project.id).catch(() => {});
      for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
      for (const wid of created.workspaces) await cleanupWorkspace(db, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "WorkspaceMember", "Project", "UsageEvent", "AIOperation"]).catch(() => {});
      return Response.json({ ok: false, error: `deployment not LIVE: ${app.run.status}` }, { status: 500 });
    }
    // One due trigger: due NOW, so the very next platform sweep tick executes it.
    const trigger = await db.entities.ScheduledTrigger.create({
      project_id: app.project.id, name: `livecheck${stamp}`, function_name: "echoSched",
      interval_seconds: 60, enabled: true, payload: { echo: "live-check" },
      next_run_at: new Date(Date.now() - 1000).toISOString(),
    });
    return Response.json({
      ok: true, project_id: app.project.id, trigger_id: trigger.id,
      workspace_id: A.ws.id, plan_id: plan.id,
      next_run_at: trigger.next_run_at, deployed_at: new Date().toISOString(),
    });
  }

  if (op === "verify") {
    const triggerId = String(args.trigger_id || "");
    const projectId = String(args.project_id || "");
    if (!triggerId || !projectId) return Response.json({ ok: false, error: "trigger_id and project_id required" }, { status: 400 });
    if (!(await fixtureProject(db, projectId))) return forbidden();
    const trigger = await db.entities.ScheduledTrigger.get(triggerId).catch(() => null);
    if (!trigger || trigger.project_id !== projectId) return forbidden();
    const runs = await db.entities.ScheduledRun.filter({ trigger_id: triggerId }, "created_date", 20);
    const invocations = await db.entities.FunctionInvocation.filter({ project_id: projectId, trigger: "scheduled" }, "created_date", 20);
    return Response.json({
      ok: true,
      trigger: trigger && { enabled: trigger.enabled, last_status: trigger.last_status, run_count: Number(trigger.run_count) || 0, next_run_at: trigger.next_run_at, last_error: trigger.last_error || null },
      runs: runs.map((r) => ({ status: r.status, scheduled_at: r.scheduled_at, completed_at: r.completed_at, duration_ms: r.duration_ms, error: r.error || null })),
      invocations: invocations.map((i) => ({ function_name: i.function_name, ok: i.ok, status: i.status, duration_ms: i.duration_ms, started: i.created_date })),
    });
  }

  // cleanup
  const projectId = String(args.project_id || "");
  const workspaceId = String(args.workspace_id || "");
  const planId = String(args.plan_id || "");
  // Validate EVERY supplied id before any deletion; one foreign id refuses the whole cleanup.
  if (projectId) {
    const project = await fixtureProject(db, projectId);
    if (!project || (workspaceId && project.workspace_id !== workspaceId)) return forbidden();
  }
  if (workspaceId && !isFixtureWorkspace(await db.entities.Workspace.get(workspaceId).catch(() => null))) return forbidden();
  if (planId && !isFixturePlan(await db.entities.BillingPlan.get(planId).catch(() => null))) return forbidden();
  if (projectId) {
    for (const entity of ["ScheduledTrigger", "ScheduledRun", "AuditLog", "Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Build", "FunctionInvocation", "AppRecord", "AppEntity", "AppSession", "WorkflowDefinition", "WorkflowRun", "WorkflowStepRun"]) {
      await purgeBy(db, entity, { project_id: projectId });
    }
    await db.entities.Project.delete(projectId).catch(() => {});
  }
  if (workspaceId) {
    await cleanupWorkspace(db, workspaceId, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "WorkspaceMember", "Project", "UsageEvent", "AIOperation"]);
  }
  if (planId) await db.entities.BillingPlan.delete(planId).catch(() => {});
  await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p9lv" } }).catch(() => {});
  return Response.json({ ok: true, cleaned: true });
}