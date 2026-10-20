// R-3 caller-level certification: tool-claim failures end the turn through the normal cleanup
// path (hold settled/released, draft cleared), an in-progress step stops the turn, and same-key
// retries never re-run a side effect. Real runtime + scratch DB fixtures; only the model is
// scripted (no paid calls). Fault injection wraps CacheEntry calls on the tool-claim namespace.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { parseAgentDocument } from "../../shared/agentResource.ts";
import { handleAppAgent, MESSAGES_ENTITY } from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb } from "../../shared/appAgentSuiteHelpers.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";
import { agentProgressKey, readAgentProgress } from "../../shared/agentProgress.ts";
import { taskCreateStep, countTasks } from "../../shared/agentTurnCertHelpers.ts";
import { invokeIndexKey } from "../../shared/agentInvokeIndex.ts";
import { TOOL_CLAIM_STALE_MS, OUTCOME_UNKNOWN_REPLY } from "../../shared/agentToolClaim.ts";

const isToolKey = (q) => String(q?.cache_key || "").startsWith("appagent_tools:");

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [], wsIds = [];
  const db = makeAgentSuiteDb(rawDb, appAgentPace);
  const faults = { toolRead: false, toolSave: false, indexSave: false };
  const cacheProxy = new Proxy(db.entities.CacheEntry, {
    get(e, m) {
      if (m === "filter") return async (q, ...rest) => { if (faults.toolRead && isToolKey(q)) throw new Error("simulated claim read failure"); return e.filter(q, ...rest); };
      if (m === "update") return async (id, d) => { if (faults.indexSave && d?.value?.turn_id) throw new Error("simulated index save failure"); if (faults.toolSave && d?.value?.claimed && "result" in d.value) throw new Error("simulated save failure"); return e.update(id, d); };
      return e[m];
    },
  });
  const entities = new Proxy(db.entities, { get: (ents, n) => (n === "CacheEntry" ? cacheProxy : ents[n]) });
  const client = { asServiceRole: { entities, integrations: { Core: {} } } };

  const calls = { llm: 0 };
  let script = [];
  const fake = { async generate({ jsonSchema }) {
    calls.llm++;
    const out = script.length ? script.shift() : { action: "reply", content: "OK" };
    if (out === "THROW") throw Object.assign(new Error("simulated provider outage"), { status: 502, code: "PROVIDER_ERROR" });
    return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
  } };
  const options = { providerOverrides: { "base44-core": fake, [NEXUS_PROVIDER]: fake } };
  const TASK = { name: "task", fields: { title: { type: "string", required: true } } };
  const agent = parseAgentDocument(agentFilePath("t"), JSON.stringify({
    name: "t", display_name: "t", description: "d", instructions: "Help.", tools: [], skills: [], model_tier: "fast", max_steps: 4,
    tool_configs: [{ entity_name: "task", allowed_operations: ["create", "read"] }],
  })).agent;
  const payload = { agents: [agent], entities: [TASK], functions: [], integrations: [] };
  const create = taskCreateStep;

  try {
    const plan = await makeBillingPlan(db, created, `r3ct${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `r3ca${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const pools = makeAgentPoolTools(db, stamp, "r3c");
    await pools.grant(A.ws.id, "integration", 60);
    const project = await db.entities.Project.create({ workspace_id: A.ws.id, name: `r3c-proj-${stamp}`, slug: `r3c-${stamp}` });
    projectIds.push(project.id);
    const user = await createPasswordlessUser(db, project, { email: "u@r3c.test", display_name: "U", email_verified: true });
    await appAgentPace(5000);

    const invoke = async (key) => { await appAgentPace(2000); return handleAppAgent(client, { project, payload, user, op: "invoke", args: { name: "t", message: `msg ${key}`, idempotency_key: key }, options }); };
    const tasks = () => countTasks(db, project.id);
    const turnOf = async (key) => (await db.entities.AppRecord.filter({ project_id: project.id, entity_name: MESSAGES_ENTITY }, "created_date", 100))
      .find((r) => (r.data || {}).role === "user" && (r.data || {}).invoke_key === key);
    const opOf = async (turn) => (await db.entities.AIOperation.filter({ workspace_id: A.ws.id, idempotency_key: `appagent:${turn.id}` }, "-created_date", 5))[0];
    const replies = async (key) => (await db.entities.AppRecord.filter({ project_id: project.id, entity_name: MESSAGES_ENTITY }, "created_date", 100))
      .filter((r) => (r.data || {}).role === "assistant" && (r.data || {}).invoke_key === key).length;

    // 1. Result-save failure: 503 through cleanup — hold settled, draft cleared, action ran once.
    const k1 = `r3c-k1-${stamp}`;
    faults.toolSave = true; script = [create("ONE"), { action: "reply", content: "never" }];
    const llm1 = calls.llm;
    const r1 = await captureCall(() => invoke(k1));
    faults.toolSave = false;
    const t1 = await turnOf(k1);
    const op1 = t1 ? await opOf(t1) : null;
    const draft1 = t1 ? await readAgentProgress(db, agentProgressKey(project, (t1.data || {}).conversation_id)) : "missing";
    harness.check("1a. result-save failure surfaces AGENT_TOOL_RESULT_UNSAVED (503)", r1.threw && r1.code === "AGENT_TOOL_RESULT_UNSAVED" && r1.status === 503, JSON.stringify(r1));
    harness.check("1b. the action ran exactly once and the turn stopped at that step", (await tasks()) === 1 && calls.llm - llm1 === 1, `tasks=${await tasks()} llm=${calls.llm - llm1}`);
    harness.check("1c. the turn's hold was finalized (not left reserved) and the draft was cleared",
      !!op1 && !["reserved", "running"].includes(op1.status) && draft1 === null, JSON.stringify({ status: op1?.status, draft: draft1 }));

    // 2. Same-key retry: the result-less claim is in-progress → the turn stops, nothing re-runs.
    script = [create("ONE"), create("TWO"), { action: "reply", content: "never" }];
    const llm2 = calls.llm;
    const r2 = await captureCall(() => invoke(k1));
    const op2 = await opOf(t1);
    harness.check("2a. same-key retry stops with AGENT_TOOL_STEP_IN_PROGRESS (409)", r2.threw && r2.code === "AGENT_TOOL_STEP_IN_PROGRESS" && r2.status === 409, JSON.stringify(r2));
    harness.check("2b. in-progress stops the WHOLE turn: no re-run, no later step executed", (await tasks()) === 1 && calls.llm - llm2 === 1, `tasks=${await tasks()} llm=${calls.llm - llm2}`);
    harness.check("2c. no reply persisted and the SAME turn operation (no second hold)", (await replies(k1)) === 0 && op2?.id === op1?.id && !["reserved", "running"].includes(op2?.status), JSON.stringify({ op2: op2?.status }));

    // 3. Claim read failure: 503 through cleanup, the action never runs.
    const k3 = `r3c-k3-${stamp}`;
    faults.toolRead = true; script = [create("THREE"), { action: "reply", content: "never" }];
    const r3 = await captureCall(() => invoke(k3));
    faults.toolRead = false;
    const t3 = await turnOf(k3);
    const op3 = t3 ? await opOf(t3) : null;
    harness.check("3a. claim read failure surfaces AGENT_TOOL_CLAIM_UNAVAILABLE (503) and runs nothing",
      r3.threw && r3.code === "AGENT_TOOL_CLAIM_UNAVAILABLE" && (await tasks()) === 1, JSON.stringify(r3));
    harness.check("3b. its hold was finalized, not left reserved", !!op3 && !["reserved", "running"].includes(op3.status), JSON.stringify({ status: op3?.status }));

    // 4. Successful saved-result replay is unchanged.
    const k4 = `r3c-k4-${stamp}`;
    script = [create("FOUR"), { action: "reply", content: "done4" }];
    const r4 = await invoke(k4);
    const llm4 = calls.llm;
    script = [{ action: "reply", content: "SHOULD-NOT-RUN" }];
    const r4b = await invoke(k4);
    harness.check("4a. a normal tool turn completes and executes once", r4.reply === "done4" && (await tasks()) === 2, JSON.stringify({ reply: r4.reply }));
    harness.check("4b. same-key replay returns the saved reply with no model step or re-run",
      r4b.idempotent_replay === true && r4b.reply === "done4" && calls.llm === llm4 && (await tasks()) === 2, JSON.stringify({ replay: r4b.idempotent_replay }));

    // 6. Crash recovery for the stuck k1 turn (tool ran, result never saved, runner died).
    const lk = `${await invokeIndexKey(project.id, user.id, k1)}:lease`;
    const lease = await db.entities.CacheEntry.create({ namespace: "appagent_invoke", cache_key: lk, value: {}, expires_at: new Date(Date.now() + 600000).toISOString(), stale_at: new Date(Date.now() + 600000).toISOString(), size_bytes: 8, version: 1 });
    const llm6 = calls.llm;
    const r6a = await captureCall(() => invoke(k1));
    harness.check("6a. a crashed runner's live lease refuses retryably (409), nothing runs",
      r6a.code === "AGENT_TURN_IN_PROGRESS" && calls.llm === llm6 && (await tasks()) === 2, JSON.stringify(r6a));
    await db.entities.CacheEntry.update(lease.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const claim = (await db.entities.CacheEntry.filter({ cache_key: `appagent_tools:${t1.id}:t1` }, "created_date", 5))[0];
    await db.entities.CacheEntry.update(claim.id, { value: { ...claim.value, claimed_at: new Date(Date.now() - TOOL_CLAIM_STALE_MS - 1000).toISOString() } });
    script = [create("ONE"), { action: "reply", content: "never" }];
    const r6b = await invoke(k1);
    const op6 = await opOf(t1);
    harness.check("6b. after lease expiry + stale claim: completes with the unknown-outcome reply, action NOT repeated, same op",
      r6b.reply === OUTCOME_UNKNOWN_REPLY && (await tasks()) === 2 && op6?.id === op1?.id && (await replies(k1)) === 1, JSON.stringify({ reply: r6b.reply, tasks: await tasks() }));
    const llm6c = calls.llm;
    const r6c = await invoke(k1);
    harness.check("6c. later retries replay that reply (no model call, no re-run)", r6c.idempotent_replay === true && calls.llm === llm6c && (await tasks()) === 2, JSON.stringify(r6c));

    // 7. R-6: the turn index cannot be saved → no orphan user message; a retry runs one clean turn.
    const k7 = `r3c-k7-${stamp}`;
    faults.indexSave = true; script = [create("SEVEN"), { action: "reply", content: "never" }];
    const llm7 = calls.llm;
    const r7 = await captureCall(() => invoke(k7));
    faults.indexSave = false;
    harness.check("7a. an unsaved turn index fails retryably (503) before any model step or tool",
      r7.threw && r7.code === "AGENT_INVOKE_INDEX_UNSAVED" && r7.status === 503 && calls.llm === llm7 && (await tasks()) === 2, JSON.stringify(r7));
    harness.check("7b. the orphan user message was removed", !(await turnOf(k7)), "");
    script = [create("SEVEN"), { action: "reply", content: "done7" }];
    const r7b = await invoke(k7);
    const userTurns7 = (await db.entities.AppRecord.filter({ project_id: project.id, entity_name: MESSAGES_ENTITY }, "created_date", 100)).filter((r) => (r.data || {}).role === "user" && (r.data || {}).invoke_key === k7).length;
    harness.check("7c. the retry completes once: one user message, one reply, one action", r7b.reply === "done7" && userTurns7 === 1 && (await replies(k7)) === 1 && (await tasks()) === 3, JSON.stringify({ userTurns7 }));

    // 8. R-6: an interrupted turn whose retry asks for a DIFFERENT call at a used step.
    const k8 = `r3c-k8-${stamp}`;
    script = [create("EIGHT-A"), "THROW"];
    const r8a = await captureCall(() => invoke(k8));
    harness.check("8a. a turn interrupted after a completed tool step fails without a reply", r8a.threw && (await tasks()) === 4 && (await replies(k8)) === 0, JSON.stringify({ code: r8a.code, status: r8a.status }));
    script = [create("EIGHT-B"), create("EIGHT-B"), { action: "reply", content: "done8" }];
    const r8b = await invoke(k8);
    const titles = (await db.entities.AppRecord.filter({ project_id: project.id, entity_name: "task" }, "-created_date", 50)).map((r) => (r.data || {}).title);
    harness.check("8b. the used step is NOT re-run nor reused for the new call; the new call runs once at a fresh step",
      r8b.reply === "done8" && titles.filter((t) => t === "EIGHT-A").length === 1 && titles.filter((t) => t === "EIGHT-B").length === 1
        && (r8b.usage?.tool_calls || 0) >= 2,
      JSON.stringify({ titles: titles.filter((t) => String(t).startsWith("EIGHT")) }));
    const r8c = await invoke(k8);
    harness.check("8c. a later duplicate replays the saved reply (no re-run)", r8c.idempotent_replay === true && (await tasks()) === 5, "");

    // 5. No double settlement: ledger idempotency keys are unique.
    const ledger = await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "-created_date", 500);
    const keys = ledger.map((r) => r.idempotency_key).filter(Boolean);
    harness.check("5a. no duplicate ledger idempotency keys (no double settlement)", keys.length === new Set(keys).size, `${keys.length} keys`);

    return harnessResponse(harness);
  } catch (error) {
    return Response.json({ ...harness.summary(), ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    if (projectIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: projectIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: projectIds } }).catch(() => {});
      await db.entities.AppSession.deleteMany({ project_id: { $in: projectIds } }).catch(() => {});
      await db.entities.AuditLog.deleteMany({ project_id: { $in: projectIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: projectIds } }).catch(() => {});
    }
    await db.entities.CacheEntry.deleteMany({ namespace: "appagent_tools" }).catch(() => {});
    for (const id of projectIds) await db.entities.CacheEntry.deleteMany({ namespace: "appagent_invoke", cache_key: { $regex: `^appagent_invoke:${id}:` } }).catch(() => {});
    if (wsIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wsIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wsIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wsIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wsIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wsIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wsIds } }).catch(() => {});
    }
    for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
  }
}