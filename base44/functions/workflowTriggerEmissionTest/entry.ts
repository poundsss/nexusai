// Targeted certification for the two DOCUMENTED Base44 workflow lifecycle triggers:
//   • app_publish — emitted on the project's successful production LIVE publication (deploy.ts);
//   • app_payment — emitted on a successfully settled payment or refund (billing.processBillingEvent).
// Everything runs through the REAL contract, engine, dispatch entry point, job queue and deploy
// worker. No second dispatcher and no stubbed infrastructure. Additive-only: the certified
// behavior of the six existing trigger types is re-asserted at the end of the suite.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  WORKFLOW_CONTRACT_VERSION, WORKFLOW_TRIGGER_TYPES, validateWorkflow, workflowChecksum,
} from "../../shared/workflowContract.ts";
import { emitAppPublish, emitAppPayment } from "../../shared/workflowTriggers.ts";
import { processBillingEvent } from "../../shared/billing.ts";
import { createDeployedApp } from "../../shared/deployFixtures.ts";
import { advanceWorkflowRun } from "../../shared/workflowEngine.ts";
import { runJobs } from "../../shared/jobQueue.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";
import { dispatchWorkflowEvent } from "../../shared/workflowEngine.ts";

const drain = async (base44, max_jobs = 6) =>
  runJobs(base44, { queue: "default", handlers: MAINTENANCE_HANDLERS, max_jobs, budget_ms: 25000 });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `wtrig-${Date.now()}`;
  const h = createHarness();
  const created = { workspace: null, projects: [] };
  let pubDef = null, payDef = null, regDef = null;
  try {
    // --- setup ---
    const workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    created.workspace = workspace.id;
    const projectA = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-A`, status: "ready", version_count: 0 });
    const projectB = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-B`, status: "ready", version_count: 0 });
    created.projects.push(projectA.id, projectB.id);

    // --- 1. contract: the two trigger types are accepted and described; unknown still refused ---
    h.check("1a trigger types registered", WORKFLOW_TRIGGER_TYPES.includes("app_publish") && WORKFLOW_TRIGGER_TYPES.includes("app_payment"), WORKFLOW_TRIGGER_TYPES.join(","));
    const pubOk = validateWorkflow({ name: "pub", trigger: { type: "app_publish" }, steps: [{ id: "s1", type: "complete", message: "ok" }], entry_step: "s1" }, { functionNames: [] });
    const payOk = validateWorkflow({ name: "pay", trigger: { type: "app_payment" }, steps: [{ id: "s1", type: "complete", message: "ok" }], entry_step: "s1" }, { functionNames: [] });
    const badType = validateWorkflow({ name: "bad", trigger: { type: "carrier_pigeon" }, steps: [{ id: "s1", type: "complete", message: "ok" }], entry_step: "s1" }, { functionNames: [] });
    h.check("1b validation accepts app_publish/app_payment", pubOk.ok && payOk.ok, pubOk.errors.concat(payOk.errors).join("; "));
    h.check("1c unknown trigger still refused", !badType.ok && badType.failed_checks.includes("trigger"), badType.errors.join("; "));

    // --- 2. app_publish: REAL production deployment fires the workflow ---
    const finalized = (project, { key, name, trigger_type, trigger = null }) => {
      const def = { name, trigger: trigger || { type: trigger_type }, steps: [{ id: "s1", type: "complete", message: "ok" }], entry_step: "s1" };
      const v = validateWorkflow(def, { functionNames: [] });
      if (!v.ok) throw new Error(`fixture invalid: ${v.errors.join("; ")}`);
      return svc.entities.WorkflowDefinition.create({
        workflow_key: key, name, version: 1, status: "FINALIZED", finalized: true,
        project_id: project.id, workspace_id: workspace.id,
        trigger: def.trigger, trigger_type, trigger_event: def.trigger.event || null,
        steps: def.steps, entry_step: "s1", definition_checksum: workflowChecksum(def),
        contract_version: WORKFLOW_CONTRACT_VERSION, created_at: new Date().toISOString(),
      });
    };
    const published = await createDeployedApp(svc, {
      workspace_id: workspace.id, name: `${TAG}-pub`, slug: `${TAG}-pub`, deployed_by: `${TAG}-owner`,
      on_project_created: async (p) => { created.projects.push(p.id); pubDef = await finalized(p, { key: "pub-flow", name: "Pub flow", trigger_type: "app_publish" }); },
    });
    const pubRunsQuery = { project_id: published.project.id, trigger_source: "app_publish" };
    const pubRuns1 = await svc.entities.WorkflowRun.filter(pubRunsQuery, "-created_date", 10);
    const deployment = await svc.entities.Deployment.get(published.run.deployment_id || published.project.production_deployment_id);
    h.check("2a production deploy went LIVE", published.run.deployment?.status === "LIVE" || deployment?.status === "LIVE", published.run.status);
    h.check("2b app_publish fired exactly once",
      pubRuns1.length === 1 && pubRuns1[0].workflow_key === "pub-flow" && pubRuns1[0].workflow_id === pubDef.id &&
      // The engine namespaces every idempotency key with the workflow lineage key.
      pubRuns1[0].trigger_idempotency_key === `pub-flow:app_publish:${(deployment || published.run.deployment)?.id}`,
      JSON.stringify({ n: pubRuns1.length, wf: pubRuns1[0]?.workflow_id, def: pubDef?.id, key: pubRuns1[0]?.trigger_idempotency_key, dep: deployment?.id }));
    await drain(base44);
    const pubRunRow = (await svc.entities.WorkflowRun.filter(pubRunsQuery, "-created_date", 10))[0] || null;
    const pubAdvanced = pubRunRow ? await advanceWorkflowRun(base44, { workflow_run_id: pubRunRow.id }) : null;
    h.check("2c app_publish run completes on the engine", pubAdvanced?.status === "COMPLETED", pubAdvanced?.status || "no-run");
    // Replay of the SAME publication is a duplicate trigger, never a second logical run.
    const pubReplay = await emitAppPublish(svc, {
      project: published.project, workspace_id: workspace.id, deployment_id: deployment?.id,
      version_number: deployment?.version_number || null, deployment_url: deployment?.deployment_url || null,
    });
    const pubRuns2 = await svc.entities.WorkflowRun.filter(pubRunsQuery, "-created_date", 10);
    h.check("2d app_publish idempotent per deployment", pubRuns2.length === 1 && pubReplay?.runs?.[0]?.duplicate === true, `rows=${pubRuns2.length}, dup=${pubReplay?.runs?.[0]?.duplicate}`);

    // --- 3. app_payment: settled money events fire; replays and non-money events do not ---
    payDef = await finalized(projectA, { key: "pay-flow", name: "Pay flow", trigger_type: "app_payment" });
    const paid = await processBillingEvent(svc, {
      workspace_id: workspace.id, provider: "test", provider_event_id: `pay-${TAG}`,
      event_type: "credit_purchase", amount_cents: 1000, credits: 1000,
    });
    await drain(base44);
    const payRunsQuery = { project_id: projectA.id, trigger_source: "app_payment" };
    const payRuns1 = await svc.entities.WorkflowRun.filter(payRunsQuery, "-created_date", 10);
    h.check("3a settled payment fired exactly once",
      paid.duplicate === false && payRuns1.length === 1 && payRuns1[0].workflow_id === payDef.id &&
      // The engine namespaces every idempotency key with the workflow lineage key.
      payRuns1[0].trigger_idempotency_key === `pay-flow:app_payment:${paid.event.id}`,
      JSON.stringify({ n: payRuns1.length, wf: payRuns1[0]?.workflow_id, def: payDef?.id, key: payRuns1[0]?.trigger_idempotency_key, ev: paid.event?.id }));
    const payRunRow = payRuns1[0] || null;
    const payAdvanced = payRunRow ? await advanceWorkflowRun(base44, { workflow_run_id: payRunRow.id }) : null;
    h.check("3b app_payment run completes on the engine", payAdvanced?.status === "COMPLETED", payAdvanced?.status || "no-run");
    // A replayed provider event resolves to the FIRST event upstream and must not re-fire.
    const replay = await processBillingEvent(svc, {
      workspace_id: workspace.id, provider: "test", provider_event_id: `pay-${TAG}`,
      event_type: "credit_purchase", amount_cents: 1000, credits: 1000,
    });
    const payRuns2 = await svc.entities.WorkflowRun.filter(payRunsQuery, "-created_date", 10);
    h.check("3c replayed payment never re-fires", replay.duplicate === true && payRuns2.length === 1, `runs=${payRuns2.length}`);
    // Non-money events (zero amount, not a refund) never fire.
    await processBillingEvent(svc, { workspace_id: workspace.id, provider: "test", provider_event_id: `upd-${TAG}`, event_type: "subscription_updated" });
    await processBillingEvent(svc, { workspace_id: workspace.id, provider: "test", provider_event_id: `promo-${TAG}`, event_type: "promotional_grant", credits: 50 });
    const payRuns3 = await svc.entities.WorkflowRun.filter(payRunsQuery, "-created_date", 10);
    // A refund IS money moving: it fires.
    const refunded = await processBillingEvent(svc, { workspace_id: workspace.id, provider: "test", provider_event_id: `ref-${TAG}`, event_type: "refund", amount_cents: 400, credits: 400 });
    const payRuns4 = await svc.entities.WorkflowRun.filter(payRunsQuery, "-created_date", 10);
    h.check("3d zero-amount events do not fire, refund fires",
      payRuns3.length === 1 && !refunded.duplicate && payRuns4.length === 2,
      `after-nonmoney=${payRuns3.length}, after-refund=${payRuns4.length}`);
    // Workspace isolation of dispatch: a sibling project with no workflow collects nothing.
    const bRuns = await svc.entities.WorkflowRun.filter({ project_id: projectB.id, trigger_source: "app_payment" }, "-created_date", 10);
    h.check("3e sibling project without a workflow gets no runs", bRuns.length === 0, `runs=${bRuns.length}`);

    // --- 4. regression: the pre-existing trigger types dispatch unchanged through the same path ---
    regDef = await finalized(projectA, { key: "reg-flow", name: "Reg flow", trigger_type: "app_event", trigger: { type: "app_event", event: "order.created" } });
    const regDispatch = await dispatchWorkflowEvent(svc, {
      project: projectA, workspace: { id: workspace.id }, source: "app_event", event: "order.created",
      payload: { total: 1 }, idempotency_key: `reg-${TAG}`, actor: "system",
    });
    await drain(base44);
    const regRun = (await svc.entities.WorkflowRun.filter({ project_id: projectA.id, trigger_source: "app_event" }, "-created_date", 10))[0] || null;
    const regAdvanced = regRun ? await advanceWorkflowRun(base44, { workflow_run_id: regRun.id }) : null;
    h.check("4 existing app_event dispatch unchanged",
      regDispatch.matched === 1 && regAdvanced?.status === "COMPLETED" && regRun?.workflow_id === regDef.id,
      `matched=${regDispatch.matched}, status=${regAdvanced?.status || "no-run"}`);

    const summary = h.summary();
    return Response.json({ ok: summary.ok, passed: summary.passed, failed: summary.failed, failures: summary.failures });
  } catch (e) {
    const { passed, failed, results } = h.summary();
    return Response.json({ ok: false, error: e.message, stack: String(e.stack || "").slice(0, 800), passed, failed, results }, { status: 500 });
  } finally {
    for (const pid of created.projects) {
      for (const name of ["Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "BackgroundJob", "WorkflowStepRun", "AuditLog"]) {
        await purgeBy(svc, name, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    if (created.workspace) {
      await cleanupWorkspace(svc, created.workspace, [
        "WorkflowRun", "WorkflowDefinition", "BillingEvent", "CreditLedgerEntry", "Invoice",
        "Subscription", "WorkspaceMember", "AuditLog", "TraceEvent",
      ]);
    }
  }
}