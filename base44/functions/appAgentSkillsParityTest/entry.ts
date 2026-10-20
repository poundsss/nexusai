// P-9.11J certification suite: deployed in-app agent SKILLS parity (selected_skill_names).
//
// Base44 documents (docs.base44.com, in-app agents · Skills): an in-app agent may have up to
// 10 skills selected from the project's skill library, declared as `selected_skill_names`.
// This suite certifies the P-9.11J implementation against the EXISTING contracts only:
//   • the agent DOCUMENT contract (parseAgentDocument) — owned key, fail-closed on a non-array,
//     an invalid name, a duplicate or more than the documented 10; canonical round-trip;
//   • the cross-resource check (validateAgentReferences) — a selected skill the project does
//     not declare fails closed against the SAME skill storage as the legacy `skills` field;
//   • the in-app runtime (handleAppAgent) — resolution from the artifact's persisted
//     payload.agent_skills (no second skill storage), bounded+scrubbed AUTHORITATIVE injection
//     into the system context in declared order, fail-closed AGENT_SKILL_MISSING before any
//     persistence or charge, NO injection for agents without a selection, NO injection of the
//     legacy builder-loop `skills` field (unchanged P-9.4 behavior), no skill tariff (identical
//     turns charge identically) and no message-pool movement.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent, renderAgentSkillsBlock, APP_AGENT_LIMITS } from "../../shared/appAgentRuntime.ts";
import { parseAgentDocument, validateAgentReferences, agentDocumentContent } from "../../shared/agentResource.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  // ---- provider boundary stub (handlers, ledger and executor are the REAL ones) ----
  const calls = { llm: 0 };
  let script = [];          // queued model decisions; empty → default reply
  let lastSystem = "";     // the EXACT system context the model received — the injection probe
  const fakeProvider = {
    async generate({ system, messages, jsonSchema }) {
      calls.llm++;
      lastSystem = String(system || "");
      const out = script.length ? script.shift() : { action: "reply", content: "OK, noted." };
      return {
        output: jsonSchema ? out : (out.action === "reply" ? out.content : JSON.stringify(out)),
        usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" },
      };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const client = { asServiceRole: { entities: db.entities } };
  const opts = { providerOverrides };
  const pace = appAgentPace;
  const run = async (project, user, op, args) => {
    await pace();
    return handleAppAgent(client, { project, payload, user, op, args, options: opts });
  };

  // The artifact-shaped payload: agents as the document contract produces them, and the
  // EXISTING skill resource's persisted projection (payload.agent_skills) — the SAME server
  // half deploy.ts already packs, so the suite exercises resolution exactly as deployed.
  const skill = (name, body) => ({ name, title: name, description: "test skill", version: "1", tags: [], path: `base44/agent-skills/${name}.md`, body });
  const agentDoc = (name, owned = {}) => ({ ...appAgentDoc(name), ...owned });
  const payload = {
    agents: [
      agentDoc("skilled", { selected_skill_names: ["greeting", "refund-policy"] }),
      agentDoc("plain"),
      agentDoc("legacy", { skills: ["old-skill"] }),
      agentDoc("missing", { selected_skill_names: ["ghost-skill"] }),
    ],
    entities: [],
    agent_skills: [
      skill("greeting", "Always greet the user warmly. GREETING-SKILL-MARKER. Never expose sk_live_abcdef0123456789."),
      skill("refund-policy", "Refunds within 30 days. REFUND-SKILL-MARKER."),
      skill("old-skill", "Legacy builder-loop guidance. OLD-SKILL-MARKER."),
    ],
  };
  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911j");

  // ---- pure contract probes (no entities touched) --------------------------------------
  const docText = (doc) => `${JSON.stringify(doc, null, 2)}\n`;
  const skillDocText = (name, body) => `---\nname: ${name}\ndescription: A test skill\n---\n\n${body}\n`;

  try {
    const p11 = parseAgentDocument("base44/agents/over.jsonc", docText({ instructions: "x", selected_skill_names: Array.from({ length: 11 }, (_, i) => `s${i}`) }));
    harness.check("document contract: more than the documented 10 selected skills fails closed",
      !p11.ok && /at most 10/.test(p11.error), p11.error || "parsed");
    const pBad = parseAgentDocument("base44/agents/bad.jsonc", docText({ instructions: "x", selected_skill_names: ["Bad_Name"] }));
    harness.check("document contract: an invalid selected skill name fails closed",
      !pBad.ok && /invalid agent-skill name/.test(pBad.error), pBad.error || "parsed");
    const pNotArray = parseAgentDocument("base44/agents/na.jsonc", docText({ instructions: "x", selected_skill_names: "nope" }));
    harness.check("document contract: a non-array selected_skill_names fails closed",
      !pNotArray.ok && /must be an array/.test(pNotArray.error), pNotArray.error || "parsed");
    const pOk = parseAgentDocument("base44/agents/ok.jsonc", docText({ instructions: "x", selected_skill_names: ["a", "b", "a"] }));
    harness.check("document contract: selected_skill_names parse with dedupe and round-trip through the canonical document",
      pOk.ok && pOk.agent.selected_skill_names.join(",") === "a,b"
        && parseAgentDocument("base44/agents/ok.jsonc", agentDocumentContent(pOk.agent)).agent.selected_skill_names.join(",") === "a,b",
      JSON.stringify(pOk.ok ? pOk.agent.selected_skill_names : pOk.error));
    const plainDoc = parseAgentDocument("base44/agents/plain.jsonc", docText({ instructions: "x" }));
    harness.check("document contract: an agent without a selection round-trips with NO key (byte compatibility)",
      plainDoc.ok && !agentDocumentContent(plainDoc.agent).includes("selected_skill_names"),
      agentDocumentContent(plainDoc.agent).slice(0, 120));

    const vMissing = validateAgentReferences([
      { path: "base44/agents/refs.jsonc", content: docText({ instructions: "x", selected_skill_names: ["ghost"] }) },
    ]);
    harness.check("cross-resource: a selected skill the project does not declare fails closed",
      !vMissing.ok && vMissing.errors.some((e) => e.error.includes("ghost")), JSON.stringify(vMissing.errors));
    const vOk = validateAgentReferences([
      { path: "base44/agents/refs.jsonc", content: docText({ instructions: "x", selected_skill_names: ["real"] }) },
      { path: "base44/agent-skills/real.md", content: skillDocText("real", "Real skill guidance.") },
    ]);
    harness.check("cross-resource: a declared selected skill resolves against the SAME skill storage",
      vOk.ok, JSON.stringify(vOk.errors));

    const bigBlock = renderAgentSkillsBlock([skill("big", "x".repeat(6000))]);
    const xs = bigBlock.split("x").length - 1;
    harness.check("render: one selected skill's excerpt is bounded to the per-skill cap",
      bigBlock.includes("AGENT SKILLS") && xs === APP_AGENT_LIMITS.SKILL_CHARS, `x count: ${xs}`);

    // ---- runtime probes (the REAL handler, ledger and db paths) ---------------------------
    const plan = await makeBillingPlan(db, created, `p911j${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911j${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);

    const projA = await makeAgentProject(db, projectIds, A, stamp, "p911j");
    const userA1 = { id: `p911j_userA1_${stamp}`, email: "a1@p911j.test" };

    const convSkilled = await run(projA, userA1, "create", { agent_name: "skilled" });
    script = [{ action: "reply", content: "skills loaded" }];
    const int0 = await intOf(A.ws.id);
    const turnSkilled = await run(projA, userA1, "invoke", { conversation_id: convSkilled.conversation.conversation_id, message: "hello" });
    const int1 = await intOf(A.ws.id);
    harness.check("invoke: a selected-skills agent runs and charges only the per-turn integration credit",
      turnSkilled.reply === "skills loaded" && int1 < int0 && turnSkilled.usage.integration_credits >= 1,
      `int ${int0} → ${int1}`);
    harness.check("injection: BOTH selected skills' content reaches the in-app system context, in declared order",
      lastSystem.includes("AGENT SKILLS") && lastSystem.includes("GREETING-SKILL-MARKER") && lastSystem.includes("REFUND-SKILL-MARKER")
        && lastSystem.indexOf("GREETING-SKILL-MARKER") < lastSystem.indexOf("REFUND-SKILL-MARKER"),
      JSON.stringify({ header: lastSystem.includes("AGENT SKILLS"), greeting: lastSystem.includes("GREETING-SKILL-MARKER"), refund: lastSystem.includes("REFUND-SKILL-MARKER") }));
    harness.check("injection: the skill content is scrubbed through the existing platform contract",
      lastSystem.includes("[REDACTED]") && !lastSystem.includes("sk_live_abcdef0123456789"),
      JSON.stringify({ redacted: lastSystem.includes("[REDACTED]"), leaked: lastSystem.includes("sk_live_abcdef0123456789") }));

    const convPlain = await run(projA, userA1, "create", { agent_name: "plain" });
    script = [{ action: "reply", content: "plain answer" }];
    const turnPlain = await run(projA, userA1, "invoke", { conversation_id: convPlain.conversation.conversation_id, message: "hello" });
    harness.check("isolation: an agent with no selection receives NO skill content",
      turnPlain.reply === "plain answer" && !lastSystem.includes("AGENT SKILLS") && !lastSystem.includes("GREETING-SKILL-MARKER"),
      JSON.stringify({ reply: turnPlain.reply, has_skills: lastSystem.includes("AGENT SKILLS") }));

    const convLegacy = await run(projA, userA1, "create", { agent_name: "legacy" });
    script = [{ action: "reply", content: "legacy answer" }];
    const turnLegacy = await run(projA, userA1, "invoke", { conversation_id: convLegacy.conversation.conversation_id, message: "hello" });
    harness.check("backward compatibility: the legacy builder-loop `skills` field is NOT injected in-app (unchanged behavior)",
      turnLegacy.reply === "legacy answer" && !lastSystem.includes("OLD-SKILL-MARKER") && !lastSystem.includes("AGENT SKILLS"),
      JSON.stringify({ reply: turnLegacy.reply, leaked: lastSystem.includes("OLD-SKILL-MARKER") }));
    harness.check("billing: a selected-skills turn charges the SAME as an identical plain turn (no skill tariff)",
      turnSkilled.usage.integration_credits === turnPlain.usage.integration_credits,
      JSON.stringify({ skilled: turnSkilled.usage.integration_credits, plain: turnPlain.usage.integration_credits }));

    const intBefore = await intOf(A.ws.id);
    const missing = await captureCall(() => run(projA, userA1, "invoke", { name: "missing", message: "hi" }));
    const intAfter = await intOf(A.ws.id);
    harness.check("fail-closed: a selected skill the deployment does not carry refuses the invoke before any charge",
      missing.threw && missing.code === "AGENT_SKILL_MISSING" && missing.status === 500 && intAfter === intBefore,
      JSON.stringify({ code: missing.code, status: missing.status, int: `${intBefore} → ${intAfter}` }));
    const convsAfter = await run(projA, userA1, "conversations", {});
    harness.check("fail-closed: the refused invoke persists nothing",
      convsAfter.count === 3, JSON.stringify({ count: convsAfter.count }));

    harness.check("billing: the message pool is never moved by agent turns",
      (await msgOf(A.ws.id)) === 200, JSON.stringify({ msg: await msgOf(A.ws.id) }));

    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after the skills surface usage", integrity.ok, JSON.stringify(integrity));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911j-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911j" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911j_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911j[0-9]+$" } }).catch(() => {});
  }
}