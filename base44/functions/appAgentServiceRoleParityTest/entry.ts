// P-9.11P Tier 1 certification suite: the backend service-role agents READ surface
// (`base44.asServiceRole.agents` — getConversations / getConversation / listConversations).
//
// Documented Base44 semantics are certified as parity ONLY where documented (the three read
// methods and the documented filter fields). Everything derived — project scoping through the
// executor's data namespace, elevated cross-user reads, the bounded streaming read plan — is
// certified as the EXISTING NexusAI sandbox contract, and every refused op is certified as a
// NEXUSAI fail-closed boundary (documented backend semantics UNKNOWN), never as Base44
// behavior. Tier 2 (the write/notify ops) is certified as an AUDITED REFUSED boundary (variant
// A): the suite statically checks the module's refused-op contract names exactly the audited
// ops with the audited reason, and that every non-read op — audited or arbitrary — refuses
// with AGENT_OP_NOT_SUPPORTED. The suite also re-drives the certified user-mode agent ops to
// prove they are unchanged, and that no credits move anywhere in the read surface.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { handleAppAgent, CONVERSATIONS_ENTITY, MESSAGES_ENTITY } from "../../shared/appAgentRuntime.ts";
import { createAppAgentsServiceRole, REFUSED_OPS, AUDITED_REFUSAL } from "../../shared/appAgentServiceRole.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// Sandbox probe: asserts ctx.agents exists with exactly the three documented read methods, and
// that the executor-captured project scope makes another project's conversation read as missing.
const PROBE = `
export default async function (ctx) {
  const a = ctx.agents;
  const fns = typeof a.getConversations + "," + typeof a.getConversation + "," + typeof a.listConversations;
  const foreign = await a.getConversation(String(ctx.request.body.cross_id || ""));
  const missing = await a.getConversation("no-such-conversation");
  return { status: 200, body: { fns: fns, foreign_missing: !foreign, missing_missing: !missing } };
}`;

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const client = { asServiceRole: { entities: db.entities } };
  const run = async (project, user, op, args) => {
    await appAgentPace(1200);
    return handleAppAgent(client, { project, payload, user, op, args });
  };
  const pace = () => appAgentPace(700);

  const agentDoc = (name, extra = {}) => ({ ...appAgentDoc(name, {}, "Answer briefly. SECRET-INSTRUCTION-MARKER"), ...extra });
  const payload = { agents: [agentDoc("helper"), agentDoc("artist")], entities: [] };
  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911p");

  try {
    const plan = await makeBillingPlan(db, created, `p911p${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911p${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 100);
    await grant(A.ws.id, "integration", 100);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const projA = await makeAgentProject(db, projectIds, A, stamp, "p911p");
    const projB = await makeAgentProject(db, projectIds, A, stamp, "p911p"); // cross-project probe
    const projR = await makeAgentProject(db, projectIds, A, stamp, "p911p"); // RLS-enabled probe
    await db.entities.Project.update(projR.id, { rls_enabled: true });
    const userA1 = { id: `p911p_userA1_${stamp}`, email: "a1@p911p.test" };
    const userA2 = { id: `p911p_userA2_${stamp}`, email: "a2@p911p.test" };

    // ---- fixtures: conversations of TWO users across TWO agents, a cross-project probe, an
    // RLS-enabled project with both users' rows, and message rows on the OTHER user's
    // conversation (the cross-user get must embed them).
    const convH1 = await run(projA, userA1, "create", { agent_name: "helper", metadata: { priority: "high", order_id: "ORD-1" } });
    const convL = await run(projA, userA1, "create", { agent_name: "helper", metadata: { priority: "low" } });
    const convArt = await run(projA, userA2, "create", { agent_name: "artist", metadata: { priority: "high" } });
    const convR1 = await run(projR, userA1, "create", { agent_name: "helper" });
    const convR2 = await run(projR, userA2, "create", { agent_name: "artist" });
    const convB = await run(projB, userA1, "create", { agent_name: "helper" });
    const idOf = (c) => c.conversation.conversation_id;
    const mkMsg = (project, owner, convId, role, content) => db.entities.AppRecord.create({
      project_id: project.id, entity_name: MESSAGES_ENTITY, owner_id: owner.id,
      data: { conversation_id: convId, role, content, created_at: new Date().toISOString() },
    });
    await mkMsg(projA, userA2, idOf(convArt), "user", "hello from userA2");
    await mkMsg(projA, userA2, idOf(convArt), "assistant", "hello back");

    // ---- 1. the surface exists ONLY as the backend ctx.agents read module -------------------
    const api = createAppAgentsServiceRole(db, { projectId: projA.id });
    const apiB = createAppAgentsServiceRole(db, { projectId: projB.id });
    const apiR = createAppAgentsServiceRole(db, { projectId: projR.id });
    const refused = {};
    for (const op of ["createConversation", "updateConversation", "addMessage", "subscribeToConversation", "getWhatsAppConnectURL", "getTelegramConnectURL", "connect_link"]) {
      refused[op] = await captureCall(() => api[op]({}));
    }
    const refusedCodes = Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.code || (v.threw ? "no-code" : "no-throw")]));
    harness.check("boundary: every non-read AgentsModule op is refused fail-closed (NEXUSAI boundary, backend semantics UNKNOWN)",
      Object.values(refused).every((r) => r.threw && r.code === "AGENT_OP_NOT_SUPPORTED" && r.status === 400),
      JSON.stringify(refusedCodes));
    // Tier 2 AUDITED REFUSAL (P-9.11P, variant A): the refusal itself is the certified contract.
    const arbitrary = await captureCall(() => api.deleteConversation({ id: "x" }));
    harness.check("boundary: an arbitrary undocumented op hits the same generic fail-closed refusal",
      arbitrary.threw && arbitrary.code === "AGENT_OP_NOT_SUPPORTED" && arbitrary.status === 400,
      JSON.stringify(arbitrary));
    harness.check("boundary (audited): each audited Tier 2 op's refusal names the op and the audited-refusal reason",
      Object.entries(refused).every(([op, r]) => r.threw && r.message.includes(op) && r.message.includes(AUDITED_REFUSAL)),
      JSON.stringify(refusedCodes));
    harness.check("boundary (static): the module's refused-op contract names exactly the audited Tier 2 ops",
      REFUSED_OPS === "createConversation, updateConversation, addMessage, subscribeToConversation, getWhatsAppConnectURL, getTelegramConnectURL, connect_link",
      JSON.stringify(REFUSED_OPS));
    harness.check("boundary: the frontend SDK namespace list grows no asServiceRole surface",
      RUNTIME_EXPORTS.includes("agents") && !RUNTIME_EXPORTS.includes("asServiceRole"),
      JSON.stringify(RUNTIME_EXPORTS.filter((e) => e.includes("agents") || e.toLowerCase().includes("servicerole"))));
    const probe = await executeProjectFunction(db, {
      project: projA, entities: [], integrations: [], name: "probeAgentsCtx", source: PROBE,
      trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: { cross_id: idOf(convB) } },
      user: null,
    });
    harness.check("ctx.agents: the sandbox receives exactly the three documented read methods",
      probe.status === 200 && probe.body.fns === "function,function,function",
      JSON.stringify({ status: probe.status, body: probe.body, error: probe.error }));
    harness.check("ctx.agents: the executor-captured project scope — another project's conversation reads as missing",
      probe.status === 200 && probe.body.foreign_missing === true && probe.body.missing_missing === true,
      JSON.stringify(probe.body));

    // ---- 2. getConversations: cross-user, strictly project-scoped ---------------------------
    await pace();
    const all = await api.getConversations();
    const allIds = all.conversations.map((c) => c.conversation_id);
    harness.check("getConversations: returns conversations of BOTH users in the executing project",
      all.count === 3 && allIds.includes(idOf(convH1)) && allIds.includes(idOf(convL)) && allIds.includes(idOf(convArt)),
      JSON.stringify({ count: all.count, ids: allIds }));
    harness.check("getConversations: never returns another project's conversations (elevated is never cross-project)",
      !allIds.includes(idOf(convB)) && !allIds.includes(idOf(convR1)) && !allIds.includes(idOf(convR2)),
      JSON.stringify({ leakB: allIds.includes(idOf(convB)), leakR: allIds.includes(idOf(convR1)) || allIds.includes(idOf(convR2)) }));
    await pace();
    const allB = await apiB.getConversations();
    harness.check("getConversations: a project-scoped surface for projB sees only projB's own row",
      allB.count === 1 && allB.conversations[0].conversation_id === idOf(convB),
      JSON.stringify({ count: allB.count }));

    // ---- 3. getConversation: cross-user within the project, messages embedded ---------------
    await pace();
    const other = await api.getConversation(idOf(convArt));
    const otherMsgs = (other && other.messages) || [];
    harness.check("getConversation: reads ANOTHER user's conversation in the same project, its messages embedded",
      !!other && other.agent_name === "artist" && otherMsgs.length === 2
        && otherMsgs.map((m) => m.content).sort().join(",") === "hello back,hello from userA2",
      JSON.stringify({ agent: other && other.agent_name, messages: otherMsgs.length }));

    // ---- 4. cross-project is indistinguishable from missing ---------------------------------
    const foreign = await api.getConversation(idOf(convB));
    const foreignB = await apiB.getConversation(idOf(convArt));
    harness.check("getConversation: a conversation of ANOTHER project resolves to undefined (no cross-project access)",
      foreign === undefined && foreignB === undefined, JSON.stringify({ foreign: String(foreign), foreignB: String(foreignB) }));
    const missing = await api.getConversation("no-such-conversation");
    harness.check("getConversation: a missing conversation resolves to undefined (documented behavior)",
      missing === undefined, JSON.stringify({ missing: String(missing) }));
    const noId = await captureCall(() => api.getConversation());
    harness.check("getConversation: an absent id is refused fail-closed",
      noId.threw && noId.code === "AGENT_CONVERSATION_ID_REQUIRED" && noId.status === 400, JSON.stringify(noId));

    // ---- 5. listConversations: the documented filter surface, fail-closed --------------------
    await pace();
    const byAgent = await api.listConversations({ q: { agent_name: "helper" } });
    harness.check("listConversations: q.agent_name narrows across users (documented field)",
      byAgent.count === 2 && byAgent.conversations.every((c) => c.agent_name === "helper"), JSON.stringify({ count: byAgent.count }));
    await pace();
    const queryAlias = await api.listConversations({ query: { agent_name: "artist" } });
    harness.check("listConversations: the documented `query` filter name behaves exactly like q",
      queryAlias.count === 1 && queryAlias.conversations[0].conversation_id === idOf(convArt), JSON.stringify({ count: queryAlias.count }));
    await pace();
    const byMeta = await api.listConversations({ q: { "metadata.priority": "high" } });
    harness.check("listConversations: q['metadata.priority'] filters by the persisted metadata across users",
      byMeta.count === 2 && byMeta.conversations.some((c) => c.conversation_id === idOf(convH1)) && byMeta.conversations.some((c) => c.conversation_id === idOf(convArt)),
      JSON.stringify({ count: byMeta.count }));
    await pace();
    const combined = await api.listConversations({ q: { agent_name: "helper", "metadata.order_id": "ORD-1" } });
    harness.check("listConversations: q combines agent_name with a metadata field",
      combined.count === 1 && combined.conversations[0].conversation_id === idOf(convH1), JSON.stringify({ count: combined.count }));
    await pace();
    const asc = await api.listConversations({ sort: "created_date" });
    const ascIds = asc.conversations.map((c) => c.conversation_id);
    harness.check("listConversations: sort 'created_date' returns ascending order",
      ascIds.length === 3 && ascIds[0] === idOf(convH1) && ascIds[1] === idOf(convL) && ascIds[2] === idOf(convArt), JSON.stringify(ascIds));
    await pace();
    const defaultSort = await api.listConversations({});
    harness.check("listConversations: the default sort is newest-first, matching the user-mode default",
      defaultSort.count === 3 && defaultSort.conversations[0].conversation_id === idOf(convArt),
      JSON.stringify(defaultSort.conversations.map((c) => c.conversation_id)));
    await pace();
    const sortByAlias = await api.listConversations({ sort_by: "created_date", limit: 1 });
    harness.check("listConversations: the sort_by alias and limit return the documented page",
      sortByAlias.count === 1 && sortByAlias.conversations[0].conversation_id === idOf(convH1), JSON.stringify({ count: sortByAlias.count }));
    await pace();
    const page2 = await api.listConversations({ sort: "created_date", skip: 1, limit: 1 });
    harness.check("listConversations: skip pages past the first match",
      page2.count === 1 && page2.conversations[0].conversation_id === idOf(convL), JSON.stringify({ count: page2.count }));
    await pace();
    const fieldsSel = await api.listConversations({ sort: "created_date", fields: ["agent_name", "conversation_id"] });
    harness.check("listConversations: fields projects exactly the requested documented fields",
      fieldsSel.count === 3 && fieldsSel.conversations.every((c) => Object.keys(c).sort().join(",") === "agent_name,conversation_id"),
      JSON.stringify(fieldsSel.conversations[0]));
    const badParam = await captureCall(() => api.listConversations("x"));
    const badKey = await captureCall(() => api.listConversations({ cursor: 1 }));
    const badQ = await captureCall(() => api.listConversations({ q: "helper" }));
    const badQField = await captureCall(() => api.listConversations({ q: { title: "x" } }));
    const badSort = await captureCall(() => api.listConversations({ sort: "title" }));
    const badLimit0 = await captureCall(() => api.listConversations({ limit: 0 }));
    const badLimitBig = await captureCall(() => api.listConversations({ limit: 51 }));
    const badSkip = await captureCall(() => api.listConversations({ skip: -1 }));
    const badFields = await captureCall(() => api.listConversations({ fields: ["nope"] }));
    harness.check("listConversations: unsupported keys, fields and values are refused fail-closed",
      badParam.threw && badParam.code === "AGENT_PARAMS_INVALID"
        && badKey.threw && badKey.code === "AGENT_PARAMS_INVALID"
        && badQ.threw && badQ.code === "AGENT_QUERY_INVALID"
        && badQField.threw && badQField.code === "AGENT_QUERY_INVALID"
        && badSort.threw && badSort.code === "AGENT_SORT_INVALID"
        && badLimit0.threw && badLimit0.code === "AGENT_LIMIT_INVALID"
        && badLimitBig.threw && badLimitBig.code === "AGENT_LIMIT_INVALID"
        && badSkip.threw && badSkip.code === "AGENT_SKIP_INVALID"
        && badFields.threw && badFields.code === "AGENT_FIELDS_INVALID",
      JSON.stringify({ param: badParam.code, key: badKey.code, q: badQ.code, qfield: badQField.code, sort: badSort.code, limit0: badLimit0.code, limitBig: badLimitBig.code, skip: badSkip.code, fields: badFields.code }));

    // ---- 6/7. an RLS-enabled project: service-role reads are unrestricted by owner/RLS --------
    await pace();
    const allR = await apiR.getConversations();
    const otherR = await apiR.getConversation(idOf(convR2));
    harness.check("reads: an RLS-enabled project's service-role reads carry no end-user owner/RLS restriction",
      allR.count === 2 && allR.conversations.map((c) => c.conversation_id).includes(idOf(convR1))
        && allR.conversations.map((c) => c.conversation_id).includes(idOf(convR2))
        && !!otherR && otherR.agent_name === "artist",
      JSON.stringify({ count: allR.count, crossUserGet: !!(otherR && otherR.agent_name === "artist") }));

    // ---- 8. regression: the certified user-mode agent API is unchanged -----------------------
    const own = await run(projA, userA1, "conversations", {});
    harness.check("regression: user-mode getConversations still returns ONLY the caller's own conversations",
      own.count === 2 && own.conversations.every((c) => c.agent_name === "helper")
        && !own.conversations.some((c) => c.conversation_id === idOf(convArt)),
      JSON.stringify({ count: own.count }));
    const otherGet = await captureCall(() => run(projA, userA1, "get", { conversation_id: idOf(convArt) }));
    harness.check("regression: user-mode get still refuses another user's conversation (404, indistinguishable from missing)",
      otherGet.threw && otherGet.code === "CONVERSATION_NOT_FOUND" && otherGet.status === 404, JSON.stringify(otherGet));
    const otherUpd = await captureCall(() => run(projA, userA1, "update", { conversation_id: idOf(convArt), metadata: { x: "y" } }));
    harness.check("regression: user-mode update still refuses another user's conversation (404)",
      otherUpd.threw && otherUpd.code === "CONVERSATION_NOT_FOUND" && otherUpd.status === 404, JSON.stringify(otherUpd));
    const projGet = await captureCall(() => run(projB, userA1, "get", { conversation_id: idOf(convH1) }));
    harness.check("regression: user-mode get still refuses cross-project conversations (404)",
      projGet.threw && projGet.code === "CONVERSATION_NOT_FOUND" && projGet.status === 404, JSON.stringify(projGet));
    const ownGet = await run(projA, userA2, "get", { conversation_id: idOf(convArt) });
    harness.check("regression: user-mode get of one's OWN conversation still works and embeds its messages",
      ownGet.conversation.agent_name === "artist" && ownGet.messages.length === 2
        && !JSON.stringify(ownGet).includes("SECRET-INSTRUCTION-MARKER"),
      JSON.stringify({ agent: ownGet.conversation.agent_name, messages: ownGet.messages.length }));

    // ---- billing: the read surface moves no credits in either pool --------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: the Tier 1 read surface moves no credits in either pool",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911p-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911p" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.FunctionInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911p_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911p[0-9]+$" } }).catch(() => {});
  }
}