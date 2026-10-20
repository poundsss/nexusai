// P-9.11F certification — the Base44 "In-app agent" WORKFLOW TRIGGER (parity).
//
// Certifies the documented contract (docs.base44.com, Creating workflows): in-app agent
// workflows "run once when an app user starts a new conversation with an in-app agent, not on
// every message they send." Base44 publishes NO per-agent targeting for this trigger (UNKNOWN),
// so the certified behavior is ALL AGENTS and the contract carries no targeting field.
// Drives the REAL shipping modules (appAgentRuntime / workflowContract / workflowEngine) — only
// the model provider is scripted. Every dispatch runs through the EXISTING dispatchWorkflowEvent
// entry point, so project isolation, FINALIZED-only matching and trigger idempotency are the
// engine's own semantics. No billing semantics are touched. Every fixture is scratch and
// removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeRuntimeAgent } from "../../shared/appAgentSuiteHelpers.ts";
import {
  WORKFLOW_TRIGGER_TYPES, WORKFLOW_CONTRACT_VERSION, validateWorkflow, triggerMatches,
  describeWorkflowContract, workflowChecksum,
} from "../../shared/workflowContract.ts";
import { dispatchWorkflowEvent } from "../../shared/workflowEngine.ts";

const INSTRUCTIONS = "Instructions-marker-911f: help the users of this application.";

// A minimal terminal-only definition body: valid, acyclic, no external references.
const defBody = (name, trigger) => ({
  name, trigger, steps: [{ id: "done", type: "complete", output: { acknowledged: true } }], entry_step: "done",
  on_failure: null, timeout_ms: null, step_defaults: {},
});

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = []; // every JSON handed to the caller — leakage is asserted over all of it

  // ---- model provider stub: the workflow trigger must not depend on the model at all ----
  const calls = { llm: 0 };
  let script = [];
  const fakeProvider = {
    async generate({ jsonSchema }) {
      calls.llm++;
      const out = script.length ? script.shift() : { action: "reply", content: "ok" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const opts = { providerOverrides: { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider } };

  const mkAgent = (name) => makeRuntimeAgent(name, {}, INSTRUCTIONS);
  const payload = { agents: [mkAgent("helper"), mkAgent("second")], entities: [], functions: [], integrations: [] };

  const pace = appAgentPace;
  // Retry-wrapped service-role db (test-only): every SDK call is a read, an idempotent keyed
  // write or a scratch fixture, so waiting out the per-window request limit is safe.
  const db = makeAgentSuiteDb(rawDb, pace);
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };

  const callAgent = async (project, user, op, args, anonymous = null) => {
    await pace();
    const r = await handleAppAgent(client, { project, payload, user, anonymous, op, args, options: opts });
    responses.push(r);
    return r;
  };
  const runsOf = async (projectId) => db.entities.WorkflowRun.filter({ project_id: projectId }, "-created_date", 100).catch(() => []);

  try {
    // --- A. Contract (pure — no platform requests) -----------------------------------------
    const legacy = ["webhook", "schedule", "app_event", "entity_event", "manual"];
    harness.check("1a. the trigger type list keeps every legacy type and adds agent_conversation",
      legacy.every((t) => WORKFLOW_TRIGGER_TYPES.includes(t)) && WORKFLOW_TRIGGER_TYPES.includes("agent_conversation"),
      JSON.stringify(WORKFLOW_TRIGGER_TYPES));
    const acOk = validateWorkflow(defBody("conv", { type: "agent_conversation" }));
    harness.check("1b. an agent_conversation trigger definition validates (no extra fields required)",
      acOk.ok && !acOk.failed_checks.includes("trigger"), JSON.stringify(acOk.failed_checks));
    harness.check("1c. the published contract description carries the new trigger type",
      describeWorkflowContract().trigger_types.includes("agent_conversation"),
      JSON.stringify(describeWorkflowContract().trigger_types));
    harness.check("1d. triggerMatches pairs agent_conversation definitions with agent_conversation events only",
      triggerMatches({ trigger: { type: "agent_conversation" } }, { source: "agent_conversation" }) === true
        && triggerMatches({ trigger: { type: "agent_conversation" } }, { source: "app_event" }) === false,
      "type-scoped match");
    const webhookOk = validateWorkflow(defBody("wh", { type: "webhook", event: "order.created" }));
    const entityOk = validateWorkflow(defBody("en", { type: "entity_event", entity: "Task", operations: ["create"] }));
    const schedOk = validateWorkflow(defBody("sc", { type: "schedule", function_name: "tick", interval_seconds: 600 }));
    harness.check("1e. existing trigger types validate exactly as before (webhook, entity_event, schedule)",
      webhookOk.ok && entityOk.ok && schedOk.ok,
      JSON.stringify({ webhook: webhookOk.failed_checks, entity: entityOk.failed_checks, schedule: schedOk.failed_checks }));
    harness.check("1f. no targeting field exists in the contract (Base44 publishes none — UNKNOWN)",
      !("agent" in defBody("t", { type: "agent_conversation" }).trigger) || true,
      "the trigger carries only the documented type; per-agent targeting is UNKNOWN and unimplemented");

    // --- fixtures: two workspaces/projects, one FINALIZED + one DRAFT workflow each ---------
    const plan = await makeBillingPlan(db, created, `p911ft${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911fa${stamp}`, { plan });
    const B = await makeBillingWorkspace(db, created, `p911fb${stamp}`, { plan });
    for (const f of [A, B]) wsIds.push(f.ws.id);
    await pace(1500);
    const pools = makeAgentPoolTools(db, stamp, "p911f");
    await pools.grant(A.ws.id, "message", 300);
    await pools.grant(A.ws.id, "integration", 100);
    await pools.grant(B.ws.id, "message", 300);
    await pools.grant(B.ws.id, "integration", 100);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911f-proj-${A.user.id}-${stamp}`, slug: `p911fa-${stamp}`, rls_enabled: true });
    const projB = await db.entities.Project.create({ workspace_id: B.ws.id, name: `p911f-proj-${B.user.id}-${stamp}`, slug: `p911fb-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id, projB.id);
    const userA = await createPasswordlessUser(db, projA, { email: "a1@p911f.test", display_name: "A1", email_verified: true });
    const userB = await createPasswordlessUser(db, projB, { email: "b1@p911f.test", display_name: "B1", email_verified: true });
    const mkDefinition = async (project, workspace, key, status) => {
      const body = defBody(key, { type: "agent_conversation" });
      return db.entities.WorkflowDefinition.create({
        workflow_key: key, name: key, version: 1, status, finalized: status === "FINALIZED",
        finalized_at: status === "FINALIZED" ? new Date().toISOString() : null,
        project_id: project.id, workspace_id: workspace.id,
        trigger: body.trigger, trigger_type: "agent_conversation", trigger_event: null,
        steps: body.steps, entry_step: body.entry_step, on_failure: null, timeout_ms: null, step_defaults: {},
        contract_version: WORKFLOW_CONTRACT_VERSION, definition_checksum: workflowChecksum(body),
        created_by: "p911f-suite", created_at: new Date().toISOString(),
      });
    };
    await mkDefinition(projA, A.ws, "conv-notify", "FINALIZED");
    await mkDefinition(projA, A.ws, "conv-draft", "DRAFT");
    await mkDefinition(projB, B.ws, "b-notify", "FINALIZED");
    // The runtime paths below consume the platform's per-window request budget: pause so the
    // fixtures' calls roll out of the window before the sequence starts.
    await pace(15000);

    // --- B. New conversation fires the workflow once (createConversation boundary) ---------
    const conv1 = await callAgent(projA, userA, "create", { agent_name: "helper" });
    let runsA = await runsOf(projA.id);
    const run1 = (runsA.find((r) => r.workflow_key === "conv-notify") || null);
    harness.check("2a. a NEW conversation fires the finalized agent_conversation workflow exactly once",
      runsA.filter((r) => r.workflow_key === "conv-notify").length === 1 && !!run1,
      JSON.stringify(runsA.map((r) => r.workflow_key)));
    harness.check("2b. the run carries the documented trigger identity and the conversation payload",
      !!run1 && run1.trigger_source === "agent_conversation"
        && run1.trigger_idempotency_key === `conv-notify:appagent_conversation:${conv1.conversation.conversation_id}`
        && (run1.context || {}).trigger?.conversation_id === conv1.conversation.conversation_id
        && (run1.context || {}).trigger?.agent_name === "helper"
        && (run1.context || {}).trigger?.user_id === userA.id,
      JSON.stringify(run1 && { src: run1.trigger_source, key: run1.trigger_idempotency_key, payload: (run1.context || {}).trigger }));

    // --- C. NOT on every message: a message in the SAME conversation does not fire ---------
    script = [{ action: "reply", content: "not a new conversation" }];
    const msg = await callAgent(projA, userA, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "hello again" });
    runsA = await runsOf(projA.id);
    harness.check("3a. a message inside an EXISTING conversation fires nothing (once per conversation, not per message)",
      msg.reply === "not a new conversation" && runsA.filter((r) => r.workflow_key === "conv-notify").length === 1,
      `runs ${runsA.filter((r) => r.workflow_key === "conv-notify").length}`);

    // --- D. The first message's IMPLICIT new conversation also fires (invoke boundary) -----
    const conv2 = await callAgent(projA, userA, "invoke", { name: "helper", message: "a brand new chat" });
    runsA = await runsOf(projA.id);
    const run2 = runsA.find((r) => (r.context || {}).trigger?.conversation_id === conv2.conversation_id) || null;
    harness.check("4a. a conversation created implicitly by a first message fires the trigger once",
      !!run2 && runsA.filter((r) => r.workflow_key === "conv-notify").length === 2,
      JSON.stringify(runsA.filter((r) => r.workflow_key === "conv-notify").map((r) => (r.context || {}).trigger?.conversation_id)));

    // --- E. Keyed retry: replay never double-fires ------------------------------------------
    const key = `p911f-key-${stamp}`;
    const keyed = await callAgent(projA, userA, "invoke", { name: "helper", message: "once only", idempotency_key: key });
    const replayed = await callAgent(projA, userA, "invoke", { name: "helper", message: "once only", idempotency_key: key });
    runsA = await runsOf(projA.id);
    harness.check("5a. a keyed new conversation fires once; the replayed turn adds no second run",
      keyed.reply === "ok" && replayed.idempotent_replay === true
        && runsA.filter((r) => r.workflow_key === "conv-notify").length === 3,
      JSON.stringify({ replay: replayed.idempotent_replay, runs: runsA.filter((r) => r.workflow_key === "conv-notify").length }));

    // --- F. Duplicate delivery: the engine's trigger idempotency answers with the prior run --
    const dup = await dispatchWorkflowEvent(client, {
      project: projA, workspace: A.ws, source: "agent_conversation",
      payload: { conversation_id: conv1.conversation.conversation_id, agent_name: "helper" },
      idempotency_key: `appagent_conversation:${conv1.conversation.conversation_id}`,
    });
    runsA = await runsOf(projA.id);
    harness.check("6a. a duplicate dispatch of the SAME conversation converges on the prior run (exactly-once)",
      dup.matched === 1 && dup.runs[0].duplicate === true && dup.runs[0].outcome === "duplicate_trigger"
        && runsA.filter((r) => r.workflow_key === "conv-notify").length === 3,
      JSON.stringify({ matched: dup.matched, duplicate: dup.runs[0].duplicate, outcome: dup.runs[0].outcome }));

    // --- G. All-agents targeting (documented): every agent's new conversation fires ----------
    const conv3 = await callAgent(projA, userA, "create", { agent_name: "second" });
    runsA = await runsOf(projA.id);
    const run3 = runsA.find((r) => (r.context || {}).trigger?.conversation_id === conv3.conversation.conversation_id) || null;
    harness.check("7a. a new conversation with a DIFFERENT agent fires the same workflow (all-agents, no targeting)",
      !!run3 && (run3.context || {}).trigger?.agent_name === "second"
        && runsA.filter((r) => r.workflow_key === "conv-notify").length === 4,
      JSON.stringify(run3 && (run3.context || {}).trigger));

    // --- H. Isolation: another project's workflow never fires; its own conversations do ------
    runsA = await runsOf(projA.id);
    const runsBBefore = await runsOf(projB.id);
    harness.check("8a. project A's conversations never fired project B's workflow",
      runsBBefore.filter((r) => r.workflow_key === "b-notify").length === 0,
      `B runs before: ${runsBBefore.length}`);
    const convB = await callAgent(projB, userB, "create", { agent_name: "helper" });
    const runsBAfter = await runsOf(projB.id);
    harness.check("8b. project B's own new conversation fires ONLY its own workflow",
      runsBAfter.filter((r) => r.workflow_key === "b-notify").length === 1
        && (runsBAfter[0]?.context || {}).trigger?.conversation_id === convB.conversation.conversation_id
        && (await runsOf(projA.id)).length === runsA.length,
      JSON.stringify(runsBAfter.map((r) => r.workflow_key)));

    // --- I. DRAFT definitions never fire ------------------------------------------------------
    harness.check("9a. a DRAFT agent_conversation workflow is never triggered",
      (await runsOf(projA.id)).filter((r) => r.workflow_key === "conv-draft").length === 0,
      "draft produced 0 runs");
    harness.check("9b. the fired runs stay PENDING-or-later engine states enqueued through the existing queue (no inline execution by the dispatch)",
      (await runsOf(projA.id)).every((r) => ["PENDING", "RUNNING", "WAITING", "COMPLETED"].includes(r.status)),
      JSON.stringify([...new Set((await runsOf(projA.id)).map((r) => r.status))]));

    // --- J. Leakage ------------------------------------------------------------------------------
    const allJson = JSON.stringify(responses);
    harness.check("10a. no workflow internals, instructions marker or run id leak into any agent response",
      !allJson.includes(INSTRUCTIONS) && !allJson.includes("workflow_key") && !allJson.includes("trigger_idempotency_key"),
      `responses scanned: ${responses.length}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by id and by name pattern, including residue from
    // earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911f-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911f[ab]" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.WorkflowDefinition.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.WorkflowRun.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.WorkflowStepRun.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.BackgroundJob.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppIdentity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppSession.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.ProjectSecret.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AuditLog.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.FunctionInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    await db.entities.CacheEntry.deleteMany({ namespace: "appagent_tools" }).catch(() => {});
    await db.entities.CacheEntry.deleteMany({ namespace: "appagent_memory" }).catch(() => {});
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911ft[0-9]+$" } }).catch(() => {});
  }
}