// P-9.11N certification suite: deployed in-app agent MODEL PINNING parity (`model`).
//
// Base44 documents (in-app agents): `model` — the model the agent runs on. This suite
// certifies the pin against the EXISTING contracts only:
//   • the agent DOCUMENT contract (parseAgentDocument) — owned key, fail-closed on a
//     non-string/empty value, canonical round-trip, pin wins over model_tier when both are
//     declared, and an agent without a pin round-trips with no key (byte compatibility);
//   • the in-app runtime (handleAppAgent) — a valid documented pin REACHES the model gateway
//     (the executed model id is the pinned one), an agent without a pin keeps the EXACT
//     Automatic tier routing (compared against a direct routeModel call under the same
//     access), unknown / unavailable / plan-unauthorized pins fail closed with deterministic
//     4xx and NEVER substitute another model (no model step, no charge), and tools +
//     idempotency semantics are unchanged on a pinned agent;
//   • billing — P-9.11E per-turn integration billing is unchanged: identical turns on the
//     same pinned model charge identically through the EXISTING canonical economics engine
//     (per-model catalog pricing, no multiplier invented), and the message pool never moves.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { routeModel } from "../../shared/modelGateway.ts";
import { resolveModelAccess } from "../../shared/subscriptions.ts";
import { parseAgentDocument, agentDocumentContent } from "../../shared/agentResource.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

const PINNED = "claude-sonnet-5";       // active, ga, canonical catalog id
const UNAVAILABLE = "claude-opus-5";     // active:false in the canonical catalog
const ALLOWED_ONLY = "gemini-3-flash";  // the restricted plan B allows exactly this model

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  // ---- provider boundary stub (handlers, ledger and executor are the REAL ones) ----
  const calls = { llm: 0, image: 0 };
  const seenModels = [];       // every model id the gateway actually executed — the probe
  let script = [];             // queued model decisions; empty → default reply
  const fakeProvider = {
    async generate({ model, messages, jsonSchema }) {
      calls.llm++;
      seenModels.push(String(model?.model_id || model?.id || "?"));
      const out = script.length ? script.shift() : { action: "reply", content: "OK, noted." };
      return {
        output: jsonSchema ? out : (out.action === "reply" ? out.content : JSON.stringify(out)),
        usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" },
      };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const client = {
    asServiceRole: {
      entities: db.entities,
      integrations: { Core: { GenerateImage: async () => { calls.image++; return { url: `https://cdn.test/p911n-${calls.image}.png` }; } } },
    },
  };
  const opts = { providerOverrides };
  const run = (project, user, op, args) => appAgentPace().then(() => handleAppAgent(client, { project, payload, user, op, args, options: opts }));

  // The artifact-shaped payload: agents as the document contract produces them (with the
  // documented `model` pin), no other surface differs from the certified P-9.4 shape.
  const payload = {
    agents: [
      { ...appAgentDoc("pinned"), model: PINNED },
      { ...appAgentDoc("artist", { app_tools: ["GenerateImage"] }), model: PINNED },
      appAgentDoc("default"),
      { ...appAgentDoc("unknown-model"), model: "gpt-nonexistent-000" },
      { ...appAgentDoc("unavailable-model"), model: UNAVAILABLE },
    ],
    entities: [],
  };
  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911n");

  try {
    // ---- pure document-contract probes (no entities touched) ------------------------------
    const docText = (doc) => `${JSON.stringify(doc, null, 2)}\n`;
    const pModel = parseAgentDocument("base44/agents/m.jsonc", docText({ instructions: "x", model: PINNED, model_tier: "advanced" }));
    harness.check("document contract: `model` parses, round-trips, and a declared pin wins over model_tier",
      pModel.ok && pModel.agent.model === PINNED
        && parseAgentDocument("base44/agents/m.jsonc", agentDocumentContent(pModel.agent)).agent.model === PINNED,
      JSON.stringify(pModel.ok ? pModel.agent.model : pModel.error));
    const pNoModel = parseAgentDocument("base44/agents/n.jsonc", docText({ instructions: "x" }));
    harness.check("document contract: an agent without `model` round-trips with NO key (byte compatibility)",
      pNoModel.ok && !/^ {2}"model":/m.test(agentDocumentContent(pNoModel.agent)),
      agentDocumentContent(pNoModel.agent).slice(0, 100));
    const pBadModel = parseAgentDocument("base44/agents/b.jsonc", docText({ instructions: "x", model: "" }));
    harness.check("document contract: an empty `model` fails closed",
      !pBadModel.ok && /must be a non-empty string/.test(pBadModel.error), pBadModel.error || "parsed");

    // ---- runtime probes (the REAL handler, ledger and db paths) ---------------------------
    const plan = await makeBillingPlan(db, created, `p911n${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911n${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);
    const projA = await makeAgentProject(db, projectIds, A, stamp, "p911n");
    const userA1 = { id: `p911n_userA1_${stamp}`, email: "a1@p911n.test" };

    // valid documented model selection — the pin actually reaches the gateway
    script = [{ action: "reply", content: "pinned reply" }];
    const intA0 = await intOf(A.ws.id);
    const turnPinned = await run(projA, userA1, "invoke", { name: "pinned", message: "hello" });
    const intA1 = await intOf(A.ws.id);
    harness.check("pin: a documented model runs the turn — the executed model id IS the pinned one",
      turnPinned.reply === "pinned reply" && seenModels[seenModels.length - 1] === PINNED,
      JSON.stringify({ reply: turnPinned.reply, executed: seenModels[seenModels.length - 1] }));
    harness.check("billing: the pinned turn charges the per-turn integration credit (P-9.11E unchanged)",
      intA1 < intA0 && turnPinned.usage.integration_credits >= 1,
      `int ${intA0} → ${intA1}`);

    // default/no model preserves the current Automatic routing
    const accessA = await resolveModelAccess(db, { workspace_id: A.ws.id });
    const directRoute = routeModel({ mode: "default", prompt: "hello", strategy: "fastest", modelAccess: accessA });
    script = [{ action: "reply", content: "default reply" }];
    const turnDefault = await run(projA, userA1, "invoke", { name: "default", message: "hello" });
    harness.check("default: an agent WITHOUT a pin keeps the exact Automatic tier routing (unchanged)",
      turnDefault.reply === "default reply" && seenModels[seenModels.length - 1] === directRoute.model.model_id,
      JSON.stringify({ executed: seenModels[seenModels.length - 1], direct: directRoute.model.model_id }));

    // identical turns on the same pinned model charge identically (existing economics engine)
    script = [{ action: "reply", content: "pinned reply 2" }];
    const turnPinned2 = await run(projA, userA1, "invoke", { name: "pinned", message: "again", idempotency_key: `p911n-key-${stamp}` });
    harness.check("billing: identical turns on the SAME pinned model charge identically (canonical economics, no multiplier)",
      turnPinned2.reply === "pinned reply 2" && turnPinned2.usage.integration_credits === turnPinned.usage.integration_credits,
      JSON.stringify({ a: turnPinned.usage.integration_credits, b: turnPinned2.usage.integration_credits }));

    // unknown model fails closed — deterministic 4xx, no substitution
    const llmBefore = calls.llm;
    const intBefore = await intOf(A.ws.id);
    const unknown = await captureCall(() => run(projA, userA1, "invoke", { name: "unknown-model", message: "hello" }));
    harness.check("fail-closed: a pin unknown to the canonical catalog refuses with a deterministic 4xx",
      unknown.threw && unknown.code === "AGENT_MODEL_UNKNOWN" && unknown.status === 404,
      JSON.stringify({ code: unknown.code, status: unknown.status }));

    // unavailable model fails closed
    const unavailable = await captureCall(() => run(projA, userA1, "invoke", { name: "unavailable-model", message: "hello" }));
    harness.check("fail-closed: a pin inactive/unavailable in the catalog refuses with a deterministic 4xx",
      unavailable.threw && unavailable.code === "AGENT_MODEL_UNAVAILABLE" && unavailable.status === 409,
      JSON.stringify({ code: unavailable.code, status: unavailable.status }));
    harness.check("no substitution: BOTH refused pins executed no model step and charged nothing",
      calls.llm === llmBefore && (await intOf(A.ws.id)) === intBefore,
      `llm ${llmBefore} → ${calls.llm}`);

    // plan-unauthorized pin fails closed — the workspace boundary, deterministic 4xx
    const planB = await makeBillingPlan(db, created, `p911nB${stamp}`, { model_access: [ALLOWED_ONLY] });
    const B = await makeBillingWorkspace(db, created, `p911nB${stamp}`, { plan: planB });
    wsIds.push(B.ws.id);
    await grant(B.ws.id, "message", 200);
    await grant(B.ws.id, "integration", 100);
    const projB = await makeAgentProject(db, projectIds, B, stamp, "p911nB");
    const userB1 = { id: `p911n_userB1_${stamp}`, email: "b1@p911n.test" };
    const llmB0 = calls.llm;
    const intB0 = await intOf(B.ws.id);
    const denied = await captureCall(() => run(projB, userB1, "invoke", { name: "pinned", message: "hello" }));
    harness.check("fail-closed: a pin the workspace's plan does not include refuses with a deterministic 4xx",
      denied.threw && denied.code === "AGENT_MODEL_NOT_ALLOWED_BY_PLAN" && denied.status === 403,
      JSON.stringify({ code: denied.code, status: denied.status }));
    harness.check("no substitution: the unauthorized pin executed no model step and charged nothing",
      calls.llm === llmB0 && (await intOf(B.ws.id)) === intB0, `llm ${llmB0} → ${calls.llm}`);

    // the plan boundary itself is unchanged: an agent WITHOUT a pin routes within the plan
    script = [{ action: "reply", content: "b default reply" }];
    const turnBDefault = await run(projB, userB1, "invoke", { name: "default", message: "hello" });
    harness.check("plan boundary: an unpinned agent still routes within the plan's allowed models (unchanged)",
      turnBDefault.reply === "b default reply" && seenModels[seenModels.length - 1] === ALLOWED_ONLY,
      JSON.stringify({ executed: seenModels[seenModels.length - 1] }));

    // unrelated behavior is unchanged on a pinned agent: tools execute beside the turn charge
    script = [
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "a cat" } } },
      { action: "reply", content: "drew it" },
    ];
    const turnTool = await run(projA, userA1, "invoke", { name: "artist", message: "draw" });
    harness.check("unrelated behavior: tools execute unchanged on a pinned agent",
      turnTool.reply === "drew it" && calls.image >= 1 && turnTool.usage.integration_credits >= 1,
      JSON.stringify({ reply: turnTool.reply, images: calls.image }));

    // unrelated behavior: idempotency semantics unchanged on a pinned agent
    script = [{ action: "reply", content: "replay me" }];
    const key = `p911n-replay-${stamp}`;
    const first = await run(projA, userA1, "invoke", { name: "pinned", message: "once", idempotency_key: key });
    const intR = await intOf(A.ws.id);
    const replay = await run(projA, userA1, "invoke", { name: "pinned", message: "once", idempotency_key: key });
    harness.check("unrelated behavior: idempotency semantics are unchanged for a pinned agent",
      first.reply === "replay me" && replay.idempotent_replay === true && replay.message_id === first.message_id
        && (await intOf(A.ws.id)) === intR,
      JSON.stringify({ replay: replay.idempotent_replay }));

    harness.check("billing: the message pools were never moved by any agent turn",
      (await msgOf(A.ws.id)) === 200 && (await msgOf(B.ws.id)) === 200,
      JSON.stringify({ a: await msgOf(A.ws.id), b: await msgOf(B.ws.id) }));

    const integrityA = await verifyBalanceIntegrity(db, A.ws.id);
    const integrityB = await verifyBalanceIntegrity(db, B.ws.id);
    harness.check("ledger integrity holds after pinned-model usage", integrityA.ok && integrityB.ok,
      JSON.stringify({ a: integrityA.ok, b: integrityB.ok }));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911nB?-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "p911n" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911n_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p911n" } }).catch(() => {});
  }
}