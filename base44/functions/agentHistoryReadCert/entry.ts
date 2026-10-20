// R-4 certification: history/conversation reads fail closed (503 AGENT_HISTORY_UNAVAILABLE)
// before any side effect; long histories replay recent keys; same-key concurrency converges on
// one billable operation. Real runtime + scratch fixtures; the model is scripted (no paid calls).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { parseAgentDocument } from "../../shared/agentResource.ts";
import { handleAppAgent, MESSAGES_ENTITY, HISTORY_WINDOW } from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb } from "../../shared/appAgentSuiteHelpers.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";
import { taskCreateStep, countTasks } from "../../shared/agentTurnCertHelpers.ts";

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [], wsIds = [];
  const db = makeAgentSuiteDb(rawDb, appAgentPace);
  const faults = { historyRead: false };
  const recProxy = new Proxy(db.entities.AppRecord, {
    get(e, m) {
      if (m === "filter") return async (q, ...rest) => {
        if (faults.historyRead && /^__agent_/.test(String(q?.entity_name || "")) && q?.owner_id) throw new Error("simulated history read failure");
        return e.filter(q, ...rest);
      };
      return e[m];
    },
  });
  const entities = new Proxy(db.entities, { get: (ents, n) => (n === "AppRecord" ? recProxy : ents[n]) });
  const client = { asServiceRole: { entities, integrations: { Core: {} } } };

  const calls = { llm: 0 };
  let script = [];
  const fake = { async generate({ jsonSchema }) {
    calls.llm++;
    const out = script.length ? script.shift() : { action: "reply", content: "OK" };
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
    const plan = await makeBillingPlan(db, created, `r4ht${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `r4ha${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await makeAgentPoolTools(db, stamp, "r4h").grant(A.ws.id, "integration", 80);
    const project = await db.entities.Project.create({ workspace_id: A.ws.id, name: `r4h-proj-${stamp}`, slug: `r4h-${stamp}` });
    projectIds.push(project.id);
    const user = await createPasswordlessUser(db, project, { email: "u@r4h.test", display_name: "U", email_verified: true });
    await appAgentPace(5000);

    const call = (op, args) => handleAppAgent(client, { project, payload, user, op, args, options });
    const invoke = async (key, extra = {}) => { await appAgentPace(1500); return call("invoke", { name: "t", message: `msg ${key}`, ...(key ? { idempotency_key: key } : {}), ...extra }); };
    const msgs = async () => db.entities.AppRecord.filter({ project_id: project.id, entity_name: MESSAGES_ENTITY }, "-created_date", 500);
    const tasks = () => countTasks(db, project.id);
    const ops = async () => db.entities.AIOperation.filter({ workspace_id: A.ws.id }, "-created_date", 100);
    const byKey = (rows, key, role) => rows.filter((r) => (r.data || {}).invoke_key === key && (r.data || {}).role === role);

    // 1. Fresh invoke with a failed history read: 503 before turn, charge, tool or reply.
    faults.historyRead = true; script = [create("X")];
    const r1 = await captureCall(() => invoke(`r4h-k0-${stamp}`));
    faults.historyRead = false;
    harness.check("1. fresh invoke read failure: 503 AGENT_HISTORY_UNAVAILABLE, no turn/op/tool/model call",
      r1.code === "AGENT_HISTORY_UNAVAILABLE" && r1.status === 503 && (await msgs()).length === 0 && (await ops()).length === 0 && (await tasks()) === 0 && calls.llm === 0,
      JSON.stringify({ r1, llm: calls.llm }));
    script = [];

    // 2. Normal keyed invoke, then a same-key retry whose history read fails.
    const k1 = `r4h-k1-${stamp}`;
    script = [create("ONE"), { action: "reply", content: "done1" }];
    const ok1 = await invoke(k1);
    const before = { m: (await msgs()).length, o: (await ops()).length, llm: calls.llm };
    faults.historyRead = true;
    const r2 = await captureCall(() => invoke(k1));
    faults.historyRead = false;
    harness.check("2a. normal keyed invoke completes once", ok1.reply === "done1" && (await tasks()) === 1, JSON.stringify({ reply: ok1.reply }));
    harness.check("2b. keyed retry read failure: 503, no new turn/op/tool/model call",
      r2.code === "AGENT_HISTORY_UNAVAILABLE" && (await msgs()).length === before.m && (await ops()).length === before.o && (await tasks()) === 1 && calls.llm === before.llm,
      JSON.stringify(r2));
    const replay1 = await invoke(k1);
    harness.check("2c. keyed retry after recovery replays the saved reply", replay1.idempotent_replay === true && replay1.reply === "done1" && calls.llm === before.llm, JSON.stringify(replay1));

    // 3. List / messages / get fail closed instead of answering empty.
    faults.historyRead = true;
    const lst = await captureCall(() => call("conversations", {}));
    const ms = await captureCall(() => call("messages", { conversation_id: ok1.conversation_id }));
    const gt = await captureCall(() => call("get", { conversation_id: ok1.conversation_id }));
    faults.historyRead = false;
    harness.check("3. conversations/messages/get read failure: 503, never an empty result",
      [lst, ms, gt].every((o) => o.code === "AGENT_HISTORY_UNAVAILABLE" && o.status === 503), JSON.stringify([lst.code, ms.code, gt.code]));

    // 4. Long history: > window older rows, then a recent keyed turn replays and appears in history.
    const filler = Array.from({ length: HISTORY_WINDOW + 5 }, (_, i) => ({
      project_id: project.id, entity_name: MESSAGES_ENTITY, owner_id: user.id,
      data: { conversation_id: `filler-${stamp}`, role: "user", content: `old ${i}`, created_at: new Date().toISOString() },
    }));
    await db.entities.AppRecord.bulkCreate(filler);
    await appAgentPace(3000);
    const k2 = `r4h-k2-${stamp}`;
    script = [{ action: "reply", content: "done2" }];
    const ok2 = await invoke(k2);
    const llm2 = calls.llm;
    const replay2 = await invoke(k2);
    const hist = await call("get", { conversation_id: ok2.conversation_id });
    harness.check("4a. long history: recent keyed retry replays (no model call, no new op)",
      replay2.idempotent_replay === true && replay2.reply === "done2" && calls.llm === llm2, JSON.stringify(replay2));
    harness.check("4b. long history: get returns the newest turn (user + assistant)",
      hist.count === 2 && hist.messages.some((m) => m.content === "done2"), `count=${hist.count}`);

    // 5. Same-key concurrency: converge on ONE billable operation.
    const k3 = `r4h-k3-${stamp}`;
    script = [];
    const race = await Promise.all([captureCall(() => call("invoke", { name: "t", message: "race", idempotency_key: k3 })), captureCall(() => call("invoke", { name: "t", message: "race", idempotency_key: k3 }))]);
    await appAgentPace(2000);
    const all = await msgs();
    const turnIds = byKey(all, k3, "user").map((r) => r.id);
    const k3ops = (await ops()).filter((o) => turnIds.some((id) => o.idempotency_key === `appagent:${id}`));
    const k3replies = byKey(all, k3, "assistant").length;
    harness.check("5a. two concurrent same-key invokes: one billable operation, one user row, one reply",
      k3ops.length === 1 && turnIds.length === 1 && k3replies === 1, JSON.stringify({ users: turnIds.length, replies: k3replies, ops: k3ops.length }));
    harness.check("5b. the duplicate is refused retryably (409 AGENT_TURN_IN_PROGRESS) or replays — never a second run",
      race.filter((o) => !o.threw).length >= 1 && race.every((o) => !o.threw || o.code === "AGENT_TURN_IN_PROGRESS"), JSON.stringify(race.map((o) => o.code || "ok")));
    const k3replay = await invoke(k3);
    harness.check("5c. after the race, the key replays the single reply", k3replay.idempotent_replay === true && byKey(await msgs(), k3, "user").length === 1, JSON.stringify(k3replay));

    // 7. Retry BEYOND the history window: > window newer rows bury the keyed turn.
    const k4 = `r4h-k4-${stamp}`;
    script = [create("FOUR"), { action: "reply", content: "done4" }];
    const ok4 = await invoke(k4);
    await db.entities.AppRecord.bulkCreate(Array.from({ length: HISTORY_WINDOW + 5 }, (_, i) => ({
      project_id: project.id, entity_name: MESSAGES_ENTITY, owner_id: user.id,
      data: { conversation_id: `newer-${stamp}`, role: "user", content: `new ${i}`, created_at: new Date().toISOString() },
    })));
    await appAgentPace(3000);
    const window = await db.entities.AppRecord.filter({ project_id: project.id, entity_name: MESSAGES_ENTITY, owner_id: user.id }, "-created_date", HISTORY_WINDOW);
    const buried = !window.some((r) => (r.data || {}).invoke_key === k4);
    const st7 = { llm: calls.llm, ops: (await ops()).length, tasks: await tasks(), users: byKey(await msgs(), k4, "user").length };
    const replay4 = await invoke(k4);
    const after7 = { llm: calls.llm, ops: (await ops()).length, tasks: await tasks(), users: byKey(await msgs(), k4, "user").length, replies: byKey(await msgs(), k4, "assistant").length };
    harness.check("7a. keyed turn is outside the newest-200 window", buried && ok4.reply === "done4", `buried=${buried}`);
    harness.check("7b. retry beyond the window replays: no model call, no new op/tool/user row/reply",
      replay4.idempotent_replay === true && replay4.reply === "done4" && after7.llm === st7.llm && after7.ops === st7.ops && after7.tasks === st7.tasks && after7.users === 1 && after7.replies === 1,
      JSON.stringify({ st7, after7 }));
    const idx = await db.entities.CacheEntry.filter({ namespace: "appagent_invoke" }, "-created_date", 50);
    const own = idx.filter((r) => String(r.cache_key).includes(`:${project.id}:`) && !String(r.cache_key).endsWith(":lease"));
    harness.check("7c. index rows persisted with turn + reply ids; no leftover leases",
      own.length >= 4 && own.every((r) => r.value?.turn_id && r.value?.reply_id) && !idx.some((r) => String(r.cache_key).includes(`:${project.id}:`) && String(r.cache_key).endsWith(":lease")),
      `index=${own.length}`);

    // 6. Normal unkeyed invoke + history unchanged.
    script = [{ action: "reply", content: "plain" }];
    const p = await invoke(null);
    const pm = await call("messages", { conversation_id: p.conversation_id });
    harness.check("6. normal invoke and messages read unchanged", p.reply === "plain" && pm.count === 2, `count=${pm.count}`);

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