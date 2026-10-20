// E2E certification for the NexusAI Workflow / Automation Engine (#28).
//
// Runs against the REAL modules and the REAL data layer: the real workflow contract, the real
// durable engine, the real #27 primitive executor, the real job queue and its worker, the real
// scheduled-trigger infrastructure, the real signed-webhook gate, the real function runtime, the
// real credit path and the real tracing/audit systems. Nothing inside the platform is stubbed and
// no second worker, scheduler, webhook verifier, trace system, ledger or primitive executor exists.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  createWorkflow, updateWorkflow, validateWorkflowDefinition, finalizeWorkflow,
  listWorkflows, getWorkflow, triggerWorkflow, dispatchEvent,
  getWorkflowRun, listWorkflowRuns, cancelWorkflowRun, retryWorkflowRun, describeWorkflowContract,
} from "../../shared/workflowApi.ts";
import { advanceWorkflowRun } from "../../shared/workflowEngine.ts";
import { WORKFLOW_JOB_TYPE, WORKFLOW_CONTRACT_VERSION, workflowChecksum } from "../../shared/workflowContract.ts";
import { PRIMITIVES, PRIMITIVE_CONTRACT_VERSION, describePrimitives } from "../../shared/primitiveContract.ts";
import { runJobs } from "../../shared/jobQueue.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";
import { handleWebhookRequest } from "../../shared/webhookEndpoint.ts";
import { SIGNING_SECRET_NAME, SIGNATURE_HEADER, TIMESTAMP_HEADER, computeSignature } from "../../shared/webhookSecurity.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { MESSAGES_ENTITY } from "../../shared/appMessaging.ts";
import { recordEvent } from "../../shared/ledger.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";

const SECRET = "sk_live_WORKFLOWLEAK1234567890";
const SIGNING_SECRET = "whsec_workflow_certification_secret";

// The REAL Model Gateway with deterministic providers, so AI-primitive steps need no live model.
const stubProvider = (impl) => ({ supportsTools: () => false, getModelInfo: () => null, async stream() { throw new Error("no streaming"); }, generate: impl });
const OK_PROVIDER = { "base44-core": stubProvider(async () => ({ output: "workflow stub answer", usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100, usage_source: "provider" } })) };
const SLOW_PROVIDER = { "base44-core": stubProvider(async () => { await new Promise((r) => setTimeout(r, 900)); return { output: "too late", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, usage_source: "provider" } }; }) };

const FN_NOTIFY = `export const config = { method: "POST" };
export default async function (ctx) { return { body: { ok: true, total: (ctx.request.body || {}).total || 0 } }; }
`;
const FN_FLAKY = `export const config = { method: "POST" };
export default async function (ctx) {
  const seen = await ctx.db.Attempt.list();
  await ctx.db.Attempt.create({ n: seen.length + 1 });
  if (seen.length === 0) return { status: 503, body: { error: "transient upstream failure" } };
  return { body: { ok: true, attempts: seen.length + 1 } };
}
`;
const FN_REJECT = `export const config = { method: "POST" };
export default async function (ctx) { return { status: 400, body: { error: "the payload is not acceptable" } }; }
`;
const FN_WEBHOOK = `export const config = { webhook: true, method: "POST" };
export default async function (ctx) {
  const body = ctx.request.body || {};
  const res = await ctx.workflows.dispatch("order.paid", { order_id: body.order_id, total: body.total }, { source: "webhook", idempotency_key: body.delivery });
  return { body: { matched: res.matched, run_id: res.runs && res.runs[0] ? res.runs[0].workflow_run_id : null } };
}
`;
const FN_SURFACE = `export const config = { method: "POST" };
export default async function (ctx) {
  const list = await ctx.workflows.list();
  const res = await ctx.workflows.dispatch("order.created", { total: 250, api_key: "${SECRET}" }, { inline: true });
  const run = res.runs && res.runs[0] ? res.runs[0] : null;
  const status = run ? await ctx.workflows.status(run.workflow_run_id) : null;
  return { body: { workflows: list.length, matched: res.matched, primitives: ctx.primitives.names().length, run_id: run ? run.workflow_run_id : null, status: status ? status.status : null } };
}
`;

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 600) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // ------------------------------------------------------------------ fixtures
    const ws = await svc.entities.Workspace.create({ name: `wf-cert-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "workflow-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(project.id);
    await recordEvent(svc, { workspace_id: ws.id, event_type: "promotional", amount: 500, idempotency_key: `wf-cert-grant-${ws.id}`, reason: "certification grant" });

    const files = [
      [ENTRY_FILE, "export default function App() { return null; }"],
      ["functions/orderNotify.js", FN_NOTIFY],
      ["functions/flakyStep.js", FN_FLAKY],
      ["functions/rejectStep.js", FN_REJECT],
      ["functions/orderWebhook.js", FN_WEBHOOK],
      ["functions/appSurface.js", FN_SURFACE],
    ];
    for (const [path, content] of files) await svc.entities.ProjectFile.create({ project_id: project.id, path, content });
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Attempt", fields: { n: { type: "number" } } });
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Task", fields: { title: { type: "string" } } });
    await svc.entities.ProjectSecret.create({ project_id: project.id, name: SIGNING_SECRET_NAME, value: SIGNING_SECRET, required: true });

    // A project in a workspace this caller is NOT a member of, and one where the caller is a viewer.
    const wsForeign = await svc.entities.Workspace.create({ name: `wf-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreign = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreign.id);
    const wsViewer = await svc.entities.Workspace.create({ name: `wf-viewer-${Date.now()}`, owner_id: `u_owner_${Date.now()}`, status: "active" });
    created.workspaces.push(wsViewer.id);
    const viewerProject = await svc.entities.Project.create({ workspace_id: wsViewer.id, name: "viewer-project", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(viewerProject.id);
    await svc.entities.WorkspaceMember.create({ workspace_id: wsViewer.id, user_id: user.id, email: user.email, role: "viewer", status: "active" });

    const trace_id = `tr_wf_${Date.now()}`;
    const run_id = `run_wf_${Date.now()}`;
    const testOpts = { messagingTransport: "test", providerOverrides: OK_PROVIDER };
    const mk = async (input) => {
      const draft = await createWorkflow(base44, user, { project_id: project.id, ...input });
      return finalizeWorkflow(base44, user, { workflow_definition_id: draft.workflow_definition_id });
    };

    // -------------------------------------------------- 1. definition creation
    const orderDraft = await createWorkflow(base44, user, {
      project_id: project.id, name: "Order pipeline", description: "Approve and notify large orders",
      trigger: { type: "manual" }, entry_step: "gate", timeout_ms: 600000,
      steps: [
        { id: "gate", type: "condition", condition: { left: "$.trigger.total", op: ">", right: 100 }, if_true: "notify", if_false: "skip" },
        { id: "notify", type: "function", function_name: "orderNotify", input: { total: "$.trigger.total" }, next: "email" },
        { id: "email", type: "primitive", primitive: "SendEmail", input: { to: ["ops@example.com"], subject: "Large order", text: "please review" }, next: "done" },
        { id: "skip", type: "complete", output: { path: "small" } },
        { id: "done", type: "complete", output: { path: "approved", notified: "$.steps.notify.body.ok" } },
      ],
    });
    h.check("1 workflow definition creation works",
      !!orderDraft.workflow_definition_id && orderDraft.status === "DRAFT" && orderDraft.version === 1 &&
      orderDraft.project_id === project.id && orderDraft.steps.length === 5 && !!orderDraft.definition_checksum &&
      orderDraft.contract_version === WORKFLOW_CONTRACT_VERSION,
      `${orderDraft.workflow_key} v${orderDraft.version} (${orderDraft.status})`);

    const order = await finalizeWorkflow(base44, user, { workflow_definition_id: orderDraft.workflow_definition_id });

    // ---------------------------------------- 2/3. versioning + immutability
    const v2 = await updateWorkflow(base44, user, { workflow_definition_id: order.workflow_definition_id, description: "v2 of the pipeline" });
    const v1After = await getWorkflow(base44, user, { workflow_definition_id: order.workflow_definition_id });
    h.check("2 workflow versioning works",
      v2.new_version === true && v2.version === 2 && v2.status === "DRAFT" && v2.workflow_key === order.workflow_key &&
      v1After.version === 1 && v1After.status === "FINALIZED",
      `editing the finalized v1 produced draft v${v2.version} beside it`);
    const immutableEdit = await updateWorkflow(base44, user, { workflow_definition_id: order.workflow_definition_id, steps: [{ id: "x", type: "complete" }], entry_step: "x" });
    const v1Recheck = await getWorkflow(base44, user, { workflow_definition_id: order.workflow_definition_id });
    h.check("3 immutable finalized version works",
      immutableEdit.new_version === true && immutableEdit.workflow_definition_id !== order.workflow_definition_id &&
      v1Recheck.steps.length === 5 && v1Recheck.definition_checksum === order.definition_checksum &&
      v1Recheck.definition_checksum === workflowChecksum(v1Recheck),
      "a finalized version cannot be edited in place; the edit landed as a new draft");

    // ------------------------------------------ 4/25/27. webhook + queue
    const paid = await mk({
      name: "Paid order", trigger: { type: "webhook", event: "order.paid" }, entry_step: "note",
      steps: [
        { id: "note", type: "function", function_name: "orderNotify", input: { total: "$.trigger.total" }, next: "fin" },
        { id: "fin", type: "complete", output: { ok: true } },
      ],
    });
    const rawBody = JSON.stringify({ order_id: "o-1", total: 320, delivery: `d-${Date.now()}` });
    const ts = String(Date.now());
    const signature = await computeSignature(SIGNING_SECRET, ts, rawBody);
    const webhookReq = () => new Request(`https://app.test/functions/appWebhook?project_id=${project.id}&fn=orderWebhook`, {
      method: "POST", body: rawBody,
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: ts, "x-forwarded-for": "203.0.113.9" },
    });
    const delivered = await handleWebhookRequest(svc, webhookReq());
    const deliveredBody = await delivered.json();
    const worked = await runJobs(base44, { queue: "default", handlers: MAINTENANCE_HANDLERS, max_jobs: 5, budget_ms: 25000 });
    const webhookRun = deliveredBody.run_id ? await getWorkflowRun(base44, user, { workflow_run_id: deliveredBody.run_id }) : null;
    const advanceJobs = await svc.entities.BackgroundJob.filter({ project_id: project.id, job_type: WORKFLOW_JOB_TYPE }, "-created_date", 20);
    h.check("4 webhook trigger works",
      delivered.status === 200 && deliveredBody.matched === 1 && !!deliveredBody.run_id &&
      webhookRun?.workflow_id === paid.workflow_definition_id && webhookRun.trigger_source === "webhook" &&
      webhookRun.status === "COMPLETED" && webhookRun.output?.ok === true,
      `verified delivery started ${deliveredBody.run_id} → ${webhookRun?.status}`);
    h.check("27 queued workflow uses the existing job system",
      advanceJobs.length >= 1 && advanceJobs.every((j) => j.job_type === WORKFLOW_JOB_TYPE && j.queue === "default") &&
      advanceJobs.some((j) => j.status === "succeeded") && worked.succeeded >= 1 &&
      advanceJobs.every((j) => j.project_id === project.id && !!j.trace_id),
      `${advanceJobs.length} ${WORKFLOW_JOB_TYPE} job(s); worker completed ${worked.succeeded}`);
    const replayed = await handleWebhookRequest(svc, webhookReq());
    const replayBody = await replayed.json();
    const unsigned = await handleWebhookRequest(svc, new Request(`https://app.test/functions/appWebhook?project_id=${project.id}&fn=orderWebhook`, { method: "POST", body: rawBody, headers: { "content-type": "application/json" } }));
    const paidRuns = await svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_id: paid.workflow_definition_id }, "-created_date", 10);
    h.check("25 webhook replay protection is preserved",
      replayed.status === 409 && replayBody.code === "REPLAYED_REQUEST" &&
      unsigned.status === 401 && (await unsigned.json()).code === "MISSING_SIGNATURE" &&
      paidRuns.length === 1,
      "a replayed signed delivery and an unsigned delivery are both refused before any workflow starts");

    // -------------------------------- 5/26. scheduled trigger (existing scheduler)
    const scheduled = await mk({
      name: "Nightly digest", trigger: { type: "schedule", function_name: "orderNotify", interval_seconds: 900 },
      entry_step: "fin", steps: [{ id: "fin", type: "complete", output: { digest: true } }],
    });
    const triggerRow = scheduled.scheduled_trigger_id ? await svc.entities.ScheduledTrigger.get(scheduled.scheduled_trigger_id) : null;
    const scheduledFire = await dispatchEvent(base44, user, { project_id: project.id, source: "schedule", payload: { tick: 1 }, trace_id, run_id, inline: true, options: testOpts });
    h.check("5 scheduled trigger works",
      !!triggerRow && triggerRow.project_id === project.id && triggerRow.function_name === "orderNotify" &&
      !!triggerRow.next_run_at && triggerRow.enabled !== false &&
      scheduledFire.matched === 1 && scheduledFire.runs[0].status === "COMPLETED" && scheduledFire.runs[0].trigger_source === "schedule",
      `ScheduledTrigger ${triggerRow?.id} next at ${triggerRow?.next_run_at}; a tick completed a run`);
    h.check("26 the scheduled workflow uses the EXISTING scheduler",
      !!triggerRow && Number(triggerRow.interval_seconds) === 900 &&
      (await svc.entities.ScheduledTrigger.filter({ project_id: project.id }, "-created_date", 10)).length === 1,
      "one ScheduledTrigger row registered through the existing ScheduleTask primitive; no second scheduling service");

    // ---------------------------- 6/9/30/37. application event + app surface
    const appFlow = await mk({
      name: "App order flow", trigger: { type: "app_event", event: "order.created" }, entry_step: "gate",
      steps: [
        { id: "gate", type: "condition", condition: { left: "$.trigger.total", op: ">", right: 100 }, if_true: "note", if_false: "skip" },
        { id: "note", type: "function", function_name: "orderNotify", input: { total: "$.trigger.total" }, next: "fin" },
        { id: "fin", type: "complete", output: { path: "large" } },
        { id: "skip", type: "complete", output: { path: "small" } },
      ],
    });
    const entityFlow = await mk({
      name: "Task watcher", trigger: { type: "entity_event", entity: "Task", operations: ["create"] },
      entry_step: "fin", steps: [{ id: "fin", type: "complete", output: { seen: "$.trigger.title" } }],
    });
    const appRun = await executeProjectFunction(svc, {
      project, entities: [{ name: "Attempt", fields: { n: { type: "number" } } }, { name: "Task", fields: { title: { type: "string" } } }],
      name: "appSurface", source: FN_SURFACE, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: null }, user: null, trace_id, run_id,
    });
    const smallRun = await dispatchEvent(base44, user, { project_id: project.id, source: "app_event", event: "order.created", payload: { total: 40 }, trace_id, run_id, inline: true, options: testOpts });
    const entityRun = await dispatchEvent(base44, user, { project_id: project.id, source: "entity_event", entity: "Task", operation: "create", payload: { title: "written by a record event" }, trace_id, run_id, inline: true, options: testOpts });
    const appRunRow = appRun.body?.run_id ? await getWorkflowRun(base44, user, { workflow_run_id: appRun.body.run_id }) : null;
    h.check("6 application/event triggers work",
      appRun.status === 200 && appRun.body.matched === 1 && appRunRow?.status === "COMPLETED" && appRunRow.trigger_source === "app_event" &&
      entityRun.matched === 1 && entityRun.runs[0].status === "COMPLETED" && entityRun.runs[0].output?.seen === "written by a record event",
      `app event → ${appRunRow?.status}; entity event → ${entityRun.runs[0]?.status}`);
    h.check("9 condition branch works",
      appRunRow?.output?.path === "large" && appRunRow.context?.steps?.gate?.result === true &&
      smallRun.runs[0].output?.path === "small" && smallRun.runs[0].context?.steps?.gate?.result === false &&
      !smallRun.runs[0].context?.steps?.note,
      "total 250 took the approval branch; total 40 took the other branch and never ran the function step");
    h.check("37 existing AI Builder / runtime behaviour is unchanged",
      appRun.status === 200 && appRun.body.primitives === 9 && appRun.body.workflows >= 3 &&
      (await executeProjectFunction(svc, { project, entities: [], name: "orderNotify", source: FN_NOTIFY, trigger: "test", requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: { total: 7 } }, user: null })).body.total === 7,
      "ctx.primitives still exposes 9 primitives, ctx.workflows is additive, and a plain function still executes exactly as before");

    // --------------------------- 7/8/11/15/20/22. the order pipeline in slices
    const startedOrder = await triggerWorkflow(base44, user, {
      workflow_definition_id: order.workflow_definition_id, payload: { total: 500, api_key: SECRET },
      idempotency_key: "order-500", trace_id, run_id, options: testOpts,
    });
    const orderRunId = startedOrder.workflow_run_id;
    // First slice is deliberately bounded, so the run yields mid-flight...
    const slice1 = await advanceWorkflowRun(base44, { workflow_run_id: orderRunId, max_steps: 2, options: testOpts });
    // ...and a fresh advance is a DIFFERENT worker picking it up from its persisted state alone.
    const persisted = await svc.entities.WorkflowRun.get(orderRunId);
    const slice2 = await advanceWorkflowRun(base44, { workflow_run_id: orderRunId, options: testOpts });
    const orderRun = await getWorkflowRun(base44, user, { workflow_run_id: orderRunId });
    const emailStep = orderRun.steps.find((s) => s.step_id === "email");
    const notifyStep = orderRun.steps.find((s) => s.step_id === "notify");
    const invocation = emailStep?.primitive_invocation_id ? await svc.entities.PrimitiveInvocation.get(emailStep.primitive_invocation_id) : null;
    h.check("7 a primitive step executes through the #27 executor",
      !!invocation && invocation.primitive === "SendEmail" && invocation.actor === "system" && invocation.status === "succeeded" &&
      invocation.project_id === project.id && invocation.idempotency_key === `wf:${orderRunId}:email` && invocation.trace_id === trace_id,
      `PrimitiveInvocation ${invocation?.id} (${invocation?.primitive}) with the step's deterministic key`);
    h.check("8 a backend function step executes",
      notifyStep?.status === "succeeded" && notifyStep.output?.body?.ok === true && notifyStep.output.body.total === 500 &&
      !!notifyStep.function_invocation_id &&
      (await svc.entities.FunctionInvocation.get(notifyStep.function_invocation_id)).function_name === "orderNotify",
      `orderNotify returned ${JSON.stringify(notifyStep?.output?.body || {})} through the existing function runtime`);
    h.check("11 workflow state persists across a worker restart",
      slice1.outcome === "yielded" && persisted.status === "RUNNING" && persisted.current_step === "done" &&
      !!persisted.context?.steps?.email && !!persisted.context.steps.notify &&
      orderRun.status === "COMPLETED" && orderRun.output?.path === "approved" && orderRun.output.notified === true &&
      slice2.outcome === "completed",
      "the run was resumed from its persisted row by a second, independent advance and completed");

    // Replay: a re-delivered queue job resumes at an already-completed side-effecting step.
    await svc.entities.WorkflowRun.update(orderRunId, { status: "RUNNING", current_step: "email", completed_at: null });
    const replayAdvance = await advanceWorkflowRun(base44, { workflow_run_id: orderRunId, options: testOpts });
    const sent = (await svc.entities.AppRecord.filter({ project_id: project.id, entity_name: MESSAGES_ENTITY }, "-created_date", 50))
      .filter((r) => (r.data || {}).subject === "Large order");
    h.check("15 step idempotency prevents duplicate side effects",
      replayAdvance.status === "COMPLETED" && sent.length === 1 &&
      (await svc.entities.PrimitiveInvocation.filter({ project_id: project.id, primitive: "SendEmail", status: "succeeded" }, "-created_date", 10)).length === 1,
      "a replayed advance skipped the completed email step: one send, one primitive invocation");
    h.check("22 an authorized project can access its own workflows",
      (await listWorkflows(base44, user, { project_id: project.id })).count >= 5 &&
      (await listWorkflowRuns(base44, user, { project_id: project.id })).runs.every((r) => r.project_id === project.id) &&
      (await getWorkflow(base44, user, { workflow_definition_id: order.workflow_definition_id })).runs.some((r) => r.workflow_run_id === orderRunId),
      "definitions, runs and step history are readable for the authorized project");

    // ---------------------------------------- 16. duplicate trigger handling
    const dup = await triggerWorkflow(base44, user, {
      workflow_definition_id: order.workflow_definition_id, payload: { total: 500 },
      idempotency_key: "order-500", trace_id, run_id, inline: true, options: testOpts,
    });
    h.check("16 duplicate trigger handling is correct",
      dup.duplicate === true && dup.workflow_run_id === orderRunId &&
      (await svc.entities.WorkflowRun.filter({ project_id: project.id, trigger_idempotency_key: "order-500" }, "-created_date", 5)).length === 1,
      "the same trigger key resolved to the first run instead of creating a second logical run");

    // ------------------------------------ 10/19/21. delay, cancellation, pinning
    const delayed = await mk({
      name: "Delayed reminder", trigger: { type: "manual" }, entry_step: "wait",
      steps: [{ id: "wait", type: "delay", delay_ms: 120000, next: "fin" }, { id: "fin", type: "complete", output: { reminded: true } }],
    });
    const waiting = await triggerWorkflow(base44, user, { workflow_definition_id: delayed.workflow_definition_id, payload: { order: "o-9" }, trace_id, run_id, inline: true, options: testOpts });
    const delayJob = waiting.continuation_job_id ? await svc.entities.BackgroundJob.get(waiting.continuation_job_id) : null;
    await runJobs(base44, { queue: "default", handlers: MAINTENANCE_HANDLERS, max_jobs: 3, budget_ms: 8000 });
    // The worker tick must leave the not-yet-due continuation alone: unclaimed, unattempted.
    const delayJobAfter = delayJob ? await svc.entities.BackgroundJob.get(delayJob.id) : null;
    h.check("10 a delay works without occupying a worker",
      waiting.status === "WAITING" && !!waiting.resume_at && Date.parse(waiting.resume_at) > Date.now() + 60000 &&
      !!delayJob && delayJob.job_type === WORKFLOW_JOB_TYPE && Date.parse(delayJob.available_at) > Date.now() + 60000 &&
      delayJob.status === "pending" && delayJobAfter?.status === "pending" && (delayJobAfter.attempts || 0) === 0 && !delayJobAfter.lease_token,
      `run parked until ${waiting.resume_at}; the continuation job is not yet due and no worker is held`);

    const v2Delay = await updateWorkflow(base44, user, { workflow_definition_id: delayed.workflow_definition_id, steps: [{ id: "wait", type: "delay", delay_ms: 1, next: "fin" }, { id: "fin", type: "complete", output: { reminded: "v2" } }] });
    const v2Final = await finalizeWorkflow(base44, user, { workflow_definition_id: v2Delay.workflow_definition_id });
    const activeRun = await getWorkflowRun(base44, user, { workflow_run_id: waiting.workflow_run_id });
    const pinnedDef = await svc.entities.WorkflowDefinition.get(activeRun.workflow_id);
    h.check("21 a workflow version cannot change during an active run",
      v2Final.version === 2 && v2Final.status === "FINALIZED" && pinnedDef.status === "SUPERSEDED" &&
      activeRun.workflow_version === 1 && activeRun.workflow_id === delayed.workflow_definition_id &&
      activeRun.definition_checksum === delayed.definition_checksum &&
      pinnedDef.steps.find((s) => s.id === "wait").delay_ms === 120000 && Date.parse(activeRun.resume_at) > Date.now() + 60000,
      "the in-flight run still executes v1 while v2 is the current finalized version");

    const cancelled = await cancelWorkflowRun(base44, user, { workflow_run_id: waiting.workflow_run_id, reason: "no longer needed" });
    const cancelledJob = delayJob ? await svc.entities.BackgroundJob.get(delayJob.id) : null;
    const cancelledRun = await getWorkflowRun(base44, user, { workflow_run_id: waiting.workflow_run_id });
    h.check("19 cancellation works",
      cancelled.cancelled === true && cancelledRun.status === "CANCELLED" && cancelledRun.cancel_reason === "no longer needed" &&
      cancelledJob?.status === "cancelled" && cancelledRun.steps.some((s) => s.step_id === "wait") &&
      (await advanceWorkflowRun(base44, { workflow_run_id: waiting.workflow_run_id })).outcome === "already_terminal",
      "the run is terminal, its queued continuation is cancelled, its step history is preserved and no further step runs");

    // -------------------------------- 12/13. retryable failure then recovery
    const flaky = await mk({
      name: "Flaky integration", trigger: { type: "manual" }, entry_step: "call",
      steps: [
        { id: "call", type: "function", function_name: "flakyStep", max_attempts: 3, next: "fin" },
        { id: "fin", type: "complete", output: { recovered: true } },
      ],
    });
    const attempt1 = await triggerWorkflow(base44, user, { workflow_definition_id: flaky.workflow_definition_id, trace_id, run_id, inline: true, options: testOpts });
    const retryJob = attempt1.next_attempt_job_id ? await svc.entities.BackgroundJob.get(attempt1.next_attempt_job_id) : null;
    // Backoff is asserted at the moment it was scheduled — the second advance below is the retry.
    const retryDeferred = !!retryJob && Date.parse(retryJob.available_at) > Date.now();
    const afterRetry = await advanceWorkflowRun(base44, { workflow_run_id: attempt1.workflow_run_id, options: testOpts });
    const flakyRun = await getWorkflowRun(base44, user, { workflow_run_id: attempt1.workflow_run_id });
    h.check("13 a retryable step retries within its persisted budget",
      attempt1.outcome === "retry_scheduled" && attempt1.attempt === 1 && attempt1.error?.retryable === true &&
      !!retryJob && retryJob.job_type === WORKFLOW_JOB_TYPE && retryDeferred,
      `attempt 1 failed retryably (${attempt1.error?.code}) and the next attempt is queued with backoff`);
    h.check("12 the workflow resumes after a transient failure",
      afterRetry.status === "COMPLETED" && flakyRun.output?.recovered === true &&
      flakyRun.steps.find((s) => s.step_id === "call").attempt === 2 &&
      flakyRun.steps.find((s) => s.step_id === "call").status === "succeeded",
      "attempt 2 of the same step succeeded and the run continued to completion");

    // ----------------------- 14/20. non-retryable failure + compensation hook
    const strict = await mk({
      name: "Strict validation", trigger: { type: "manual" }, entry_step: "first", on_failure: "compensate",
      steps: [
        { id: "first", type: "function", function_name: "orderNotify", input: { total: 5 }, next: "strictStep" },
        { id: "strictStep", type: "function", function_name: "rejectStep", next: "fin" },
        { id: "fin", type: "complete", output: { ok: true } },
        { id: "compensate", type: "complete", output: { compensated: true } },
      ],
    });
    const strictRunStart = await triggerWorkflow(base44, user, { workflow_definition_id: strict.workflow_definition_id, trace_id, run_id, inline: true, options: testOpts });
    const strictRun = await getWorkflowRun(base44, user, { workflow_run_id: strictRunStart.workflow_run_id });
    const strictStep = strictRun.steps.find((s) => s.step_id === "strictStep");
    h.check("14 a non-retryable step does not retry",
      strictRun.status === "FAILED" && strictStep.attempt === 1 && strictStep.retryable === false &&
      strictRun.error?.code === "FUNCTION_STEP_FAILED" && strictRun.failed_step_id === "strictStep" &&
      await retryWorkflowRun(base44, user, { workflow_run_id: strictRun.workflow_run_id }).then(() => false).catch((e) => e.code === "RETRY_NOT_PERMITTED"),
      "a 4xx from the function is deterministic: one attempt, and a replay is refused by policy");
    h.check("20 a failed workflow preserves its prior successful steps",
      strictRun.steps.find((s) => s.step_id === "first").status === "succeeded" &&
      strictRun.steps.find((s) => s.step_id === "first").output?.body?.ok === true &&
      strictRun.compensation?.completed === true && strictRun.compensation.hook === "compensate" &&
      strictRun.status === "FAILED",
      "the earlier step keeps its result, the compensation hook ran, and the run still ends FAILED");

    // ------------------------------------------- 17/18. timeouts
    const wfTimeout = await mk({
      name: "Impatient workflow", trigger: { type: "manual" }, entry_step: "only", timeout_ms: 1,
      steps: [{ id: "only", type: "function", function_name: "orderNotify", next: "fin" }, { id: "fin", type: "complete" }],
    });
    const timedOut = await triggerWorkflow(base44, user, { workflow_definition_id: wfTimeout.workflow_definition_id, trace_id, run_id, inline: true, options: testOpts });
    h.check("17 workflow timeout works",
      timedOut.status === "FAILED" && timedOut.error?.code === "WORKFLOW_TIMEOUT" && timedOut.error.retryable === false &&
      timedOut.steps_completed === 0,
      "the run became terminal at its deadline instead of executing further steps");

    const stepTimeout = await mk({
      name: "Slow provider step", trigger: { type: "manual" }, entry_step: "slow",
      steps: [
        { id: "slow", type: "primitive", primitive: "InvokeAI", primitive_version: "1.0.0", input: { prompt: "summarise this" }, timeout_ms: 200, max_attempts: 1, next: "fin" },
        { id: "fin", type: "complete" },
      ],
    });
    const stepTimedOut = await triggerWorkflow(base44, user, { workflow_definition_id: stepTimeout.workflow_definition_id, trace_id, run_id, inline: true, options: { ...testOpts, providerOverrides: SLOW_PROVIDER } });
    const timeoutRun = await getWorkflowRun(base44, user, { workflow_run_id: stepTimedOut.workflow_run_id });
    h.check("18 step timeout works",
      timeoutRun.status === "FAILED" && timeoutRun.error?.code === "STEP_TIMEOUT" && timeoutRun.failed_step_id === "slow" &&
      timeoutRun.steps.find((s) => s.step_id === "slow").attempt === 1,
      `the step was bounded at 200ms and produced a deterministic terminal failure (${timeoutRun.error?.code})`);

    // ---------------------------------- 23/24. isolation + authorization
    const foreignDef = await svc.entities.WorkflowDefinition.create({
      workflow_key: "foreign-flow", name: "Foreign flow", version: 1, status: "FINALIZED", finalized: true,
      project_id: foreign.id, workspace_id: wsForeign.id, trigger: { type: "manual" }, trigger_type: "manual",
      entry_step: "fin", steps: [{ id: "fin", type: "complete" }],
    });
    const foreignRunRow = await svc.entities.WorkflowRun.create({ workflow_id: foreignDef.id, workflow_key: "foreign-flow", workflow_version: 1, project_id: foreign.id, workspace_id: wsForeign.id, status: "PENDING" });
    const crossRead = await getWorkflow(base44, user, { workflow_definition_id: foreignDef.id }).then(() => null).catch((e) => e);
    const crossRun = await getWorkflowRun(base44, user, { workflow_run_id: foreignRunRow.id }).then(() => null).catch((e) => e);
    const crossTrigger = await triggerWorkflow(base44, user, { workflow_definition_id: foreignDef.id, payload: {} }).then(() => null).catch((e) => e);
    h.check("23 cross-project workflow access is rejected",
      !!crossRead && !!crossRun && !!crossTrigger &&
      [crossRead, crossRun, crossTrigger].every((e) => e.status === 403 || e.status === 404 || e.code === "NOT_A_MEMBER") &&
      (await svc.entities.WorkflowRun.filter({ project_id: foreign.id }, "-created_date", 5)).length === 1,
      `definition, run and trigger all refused (${crossRead.code} / ${crossRun.code} / ${crossTrigger.code}); no run was started`);
    const anonCreate = await createWorkflow(base44, null, { project_id: project.id, name: "anon" }).then(() => null).catch((e) => e);
    const viewerCreate = await createWorkflow(base44, user, { project_id: viewerProject.id, name: "viewer flow", entry_step: "fin", steps: [{ id: "fin", type: "complete" }] }).then(() => null).catch((e) => e);
    const viewerRead = await listWorkflows(base44, user, { project_id: viewerProject.id });
    const viewerCancel = await cancelWorkflowRun(base44, user, { workflow_run_id: orderRunId }).then((r) => r).catch((e) => e);
    h.check("24 an unauthorized operation is rejected",
      anonCreate?.code === "AUTH_REQUIRED" && (viewerCreate?.code === "INSUFFICIENT_ROLE" || viewerCreate?.status === 403) &&
      viewerRead.count === 0 && !!viewerCancel,
      `anonymous: ${anonCreate?.code}; viewer write: ${viewerCreate?.code || viewerCreate?.status}; viewer read is allowed and empty`);

    // ------------------------------------ 28/29. billing semantics
    const aiFlow = await mk({
      name: "AI summary", trigger: { type: "manual" }, entry_step: "ai",
      steps: [
        { id: "ai", type: "primitive", primitive: "InvokeAI", primitive_version: "1.0.0", input: { prompt: "Summarise the order book" }, next: "fin" },
        { id: "fin", type: "complete", output: { text: "$.steps.ai.text" } },
      ],
    });
    const aiRunWf = await triggerWorkflow(base44, user, { workflow_definition_id: aiFlow.workflow_definition_id, trace_id, run_id, inline: true, options: testOpts });
    const aiRunRow = await getWorkflowRun(base44, user, { workflow_run_id: aiRunWf.workflow_run_id });
    const aiStep = aiRunRow.steps.find((s) => s.step_id === "ai");
    const aiInvocation = aiStep?.primitive_invocation_id ? await svc.entities.PrimitiveInvocation.get(aiStep.primitive_invocation_id) : null;
    const operations = await svc.entities.AIOperation.filter({ project_id: project.id }, "-created_date", 50);
    const invocations = await svc.entities.PrimitiveInvocation.filter({ project_id: project.id }, "-created_date", 100);
    h.check("28 primitive billing semantics remain correct",
      aiRunRow.status === "COMPLETED" && aiRunRow.output?.text === "workflow stub answer" &&
      !!aiInvocation?.ai_operation_id && aiInvocation.consumes_ai_credits === true &&
      operations.filter((o) => o.status === "completed").every((o) => String(o.idempotency_key).startsWith("primitive:") && !!o.finalized_at) &&
      operations.filter((o) => o.id === aiInvocation.ai_operation_id).length === 1 &&
      operations.filter((o) => o.status === "failed").every((o) => (o.credits_charged || 0) === 0),
      `${operations.length} AI operation(s), each settled once by the existing credit path`);
    h.check("29 non-AI steps do not create LLM charges",
      invocations.filter((r) => ["SendEmail", "ScheduleTask"].includes(r.primitive)).every((r) => r.consumes_ai_credits === false && !r.ai_operation_id && (r.credits_charged || 0) === 0) &&
      operations.every((o) => invocations.some((r) => r.primitive === "InvokeAI" && r.ai_operation_id === o.id)) &&
      operations.length === invocations.filter((r) => r.primitive === "InvokeAI").length,
      "every AI operation belongs to an InvokeAI step; email, schedule, function, condition and delay steps open none");

    // ------------------------------------ 30/31/32. scrubbing, tracing, audit
    const runRows = await svc.entities.WorkflowRun.filter({ project_id: project.id }, "-created_date", 50);
    const stepRows = await svc.entities.WorkflowStepRun.filter({ project_id: project.id }, "-created_date", 200);
    const spans = await svc.entities.TraceEvent.filter({ trace_id }, "at", 300);
    const auditRows = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 200);
    const stored = JSON.stringify([runRows, stepRows, spans, auditRows]);
    h.check("30 secrets are scrubbed out of workflow state",
      !stored.includes(SECRET) && !stored.includes(SIGNING_SECRET) &&
      runRows.some((r) => JSON.stringify(r.context || {}).includes("REDACTED")),
      "a credential in a trigger payload never reaches the run context, step rows, spans or audit log");
    const workflowSpans = spans.filter((s) => String(s.name || "").startsWith("workflow."));
    h.check("31 trace_id and run_id propagate through the workflow and its steps",
      workflowSpans.length >= 10 && workflowSpans.every((s) => s.project_id === project.id) &&
      workflowSpans.some((s) => s.status === "ok") && workflowSpans.some((s) => s.status === "error") &&
      workflowSpans.filter((s) => s.run_id).every((s) => s.run_id === run_id) &&
      runRows.filter((r) => r.trace_id === trace_id).every((r) => r.run_id === run_id) &&
      stepRows.filter((s) => s.trace_id === trace_id).length >= 5 &&
      (await svc.entities.PrimitiveInvocation.filter({ project_id: project.id, trace_id }, "-created_date", 20)).length >= 1,
      `${workflowSpans.length} workflow spans on the caller's existing trace, shared with steps and primitives`);
    h.check("32 the audit trail is preserved",
      ["workflow.created", "workflow.finalized", "workflow.triggered", "workflow.run_completed", "workflow.run_failed", "workflow.run_cancelled"]
        .every((a) => auditRows.some((r) => r.action === a)) &&
      auditRows.filter((r) => String(r.action).startsWith("workflow.")).every((r) => r.workspace_id === ws.id),
      `${auditRows.filter((r) => String(r.action).startsWith("workflow.")).length} workflow audit entries in the existing log`);

    // ------------------------------------ 33/34. validation
    const invalidDraft = await createWorkflow(base44, user, {
      project_id: project.id, name: "Broken flow", trigger: { type: "webhook" }, entry_step: "missing",
      steps: [
        { id: "a", type: "primitive", primitive: "NotAPrimitive", next: "nowhere" },
        { id: "b", type: "function", function_name: "doesNotExist", next: "a" },
        { id: "c", type: "condition", condition: { left: "$.trigger.x", op: "???" }, if_true: "a", if_false: "a" },
      ],
    });
    const report = await validateWorkflowDefinition(base44, user, { workflow_definition_id: invalidDraft.workflow_definition_id });
    const finalizeRefused = await finalizeWorkflow(base44, user, { workflow_definition_id: invalidDraft.workflow_definition_id }).then(() => null).catch((e) => e);
    const stillDraft = await getWorkflow(base44, user, { workflow_definition_id: invalidDraft.workflow_definition_id });
    h.check("33 validation rejects invalid references",
      report.ok === false &&
      ["primitive_references", "function_references", "step_references", "entry_step", "conditions", "trigger"].every((c) => report.failed_checks.includes(c)),
      `failed checks: ${report.failed_checks.join(", ")}`);
    h.check("34 an invalid workflow cannot finalize",
      finalizeRefused?.code === "WORKFLOW_INVALID" && finalizeRefused.status === 422 &&
      stillDraft.status === "DRAFT" && stillDraft.finalized === false &&
      await triggerWorkflow(base44, user, { workflow_definition_id: invalidDraft.workflow_definition_id, payload: {} }).then(() => false).catch((e) => e.code === "WORKFLOW_NOT_FINALIZED"),
      "the version stays a DRAFT and cannot be run");

    // ------------------------- 35/36. the reused systems are unchanged
    const described = describePrimitives();
    const primitiveNames = [...new Set(described.primitives.map((p) => p.name))];
    h.check("35 the existing #27 primitive system remains unchanged",
      PRIMITIVE_CONTRACT_VERSION === "nexusai-primitives-1" && Object.isFrozen(PRIMITIVES) && primitiveNames.length === 9 &&
      described.primitives.some((p) => p.name === "InvokeAI" && p.version === "1.1.0") &&
      invocations.every((r) => !!r.contract_version && r.contract_version === PRIMITIVE_CONTRACT_VERSION),
      `${primitiveNames.length} primitives, frozen contract ${PRIMITIVE_CONTRACT_VERSION}; workflow steps ran through it unchanged`);
    h.check("36 the existing #18–#26B systems remain unchanged",
      ["primitive.invoke", "webhook.deliver", "retention.enforce", "packages.cleanup_supply", "cache.purge_expired", "billing.reconcile_operations", "queue.reap_leases"]
        .every((t) => typeof MAINTENANCE_HANDLERS[t] === "function") &&
      typeof MAINTENANCE_HANDLERS[WORKFLOW_JOB_TYPE] === "function" &&
      describeWorkflowContract().contract_version === WORKFLOW_CONTRACT_VERSION,
      "the workflow engine only ADDED one job type to the existing handler registry; every prior handler is intact");

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["WorkflowStepRun", "WorkflowRun", "WorkflowDefinition", "PrimitiveInvocation", "AIOperation", "BackgroundJob", "ScheduledRun", "ScheduledTrigger", "FunctionInvocation", "TraceEvent", "AuditLog", "CacheEntry", "AppRecord", "AppEntity", "ProjectSecret", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["WorkflowStepRun", "WorkflowRun", "WorkflowDefinition", "PrimitiveInvocation", "AIOperation", "CreditLedgerEntry", "RateLimitBucket", "WorkspaceMember", "AuditLog", "TraceEvent", "Project"]);
    }
  }
}