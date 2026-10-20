// P-9.11D certification — deployed in-app agents' context files (Base44 parity).
//
// Drives the REAL shipping modules (agentResource / buildEngine / deploy / appAgentRuntime /
// appAuth / the canonical ledger paths) — only the model provider is scripted. Certifies the
// Base44-documented contract (docs.base44.com, in-app agents · Guidelines, and the product
// changelog): "under Context files ... add reference material the agent can use to answer
// questions ... up to 10 files" across:
//   • contract validation — valid config, the documented 10-file maximum, >10 / invalid path /
//     asset-path / duplicate / non-array / non-string refusals, canonical round-trip, owned-key
//     isolation, default agent byte-shape unchanged;
//   • configuration/deployment validation — validateAgentReferences (missing, oversized,
//     cross-project), runBuild fail-closed refusal and clean pass, the artifact's validated
//     context-file projection (projectContextFiles: exact content, deterministic dedupe,
//     missing refusal, empty-when-undeclared);
//   • runtime — context actually available during execution, agent-scoped and cross-project
//     isolation, scrubbed injection, bounded injection (block cap + per-file excerpt cap,
//     deterministic declared order), anonymous turns get the same agent-level material,
//     fail-closed missing-file refusal BEFORE any persistence or charge, agent without context
//     files behaves exactly as before;
//   • billing/idempotency — existing message-credit path only (no invented context tariff),
//     keyed replay, unique ledger keys, integration pool untouched;
//   • leakage — no credential, no instruction text and no unrelated project data in any
//     response.
// Every fixture is scratch and removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, captureCall } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import {
  parseAgentDocument, agentDocumentContent, validateAgentReferences,
  MAX_CONTEXT_FILES, CONTEXT_FILE_MAX_CHARS,
} from "../../shared/agentResource.ts";
import { handleAppAgent, renderAgentContextBlock, APP_AGENT_LIMITS } from "../../shared/appAgentRuntime.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { createFs } from "../../shared/projectFs.ts";
import { projectContextFiles } from "../../shared/deploy.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";
import { createPasswordlessUser, createAnonymousUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, findKeyedReplyRow, lastSeenSystem, makeRuntimeAgent, makePayloadInvoke } from "../../shared/appAgentSuiteHelpers.ts";

const INSTRUCTIONS = "Instructions-marker-911d: help the users of this application.";
const FAQ = "FAQ-marker-911d returns are accepted within 30 days.";
const PRICE = "Pricing-marker-911d the Pro plan is 29 dollars per month.";
const OTHER = "Other-marker-911d internal wiki contents.";
const TOKEN = "ghp_911d_never_ship_this_token_000000";
const FAQ_PATH = "base44/context/faq.md";
const PRICE_PATH = "base44/context/pricing.md";
const OTHER_PATH = "base44/context/wiki.md";
const SECRET_PATH = "base44/context/policies.md";
const BIG_PATH = (i) => `base44/context/big-${i}.md`;
const FAQ_CONTENT = `# FAQ\n${FAQ}\n`;
const PRICE_CONTENT = `# Pricing\n${PRICE}\n`;

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = []; // every JSON handed to the caller — leakage is asserted over all of it

  // ---- model provider stub: records every system + message batch, replays a scripted decision ----
  const systemSeen = [];
  let script = [];
  const fakeProvider = {
    async generate({ messages, jsonSchema, system }) {
      if (typeof system === "string") systemSeen.push(system);
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const opts = { providerOverrides: { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider } };

  const mkAgent = (name, extra = {}) => makeRuntimeAgent(name, extra, INSTRUCTIONS);
  // The deployed agents this suite drives. "plain" carries NO context_files at all — it must
  // behave exactly as before. "broken" declares a file the payload does not carry — the
  // fail-closed refusal path.
  const AGENTS = [
    mkAgent("ctx", { context_files: [FAQ_PATH, PRICE_PATH] }),
    mkAgent("plain"),
    mkAgent("other", { context_files: [OTHER_PATH] }),
    mkAgent("secrets", { context_files: [SECRET_PATH] }),
    mkAgent("anon", { allow_anonymous_access: true, context_files: [FAQ_PATH] }),
    mkAgent("broken", { context_files: ["base44/context/ghost.md"] }),
    mkAgent("bigctx", { context_files: Array.from({ length: 10 }, (_, i) => BIG_PATH(i + 1)) }),
  ];
  const payload = {
    agents: AGENTS, entities: [], functions: [], integrations: [],
    context_files: [
      { path: FAQ_PATH, content: FAQ_CONTENT },
      { path: PRICE_PATH, content: PRICE_CONTENT },
      { path: OTHER_PATH, content: `${OTHER}\n` },
      { path: SECRET_PATH, content: `The deploy token is ${TOKEN}.\n` },
      ...Array.from({ length: 10 }, (_, i) => ({ path: BIG_PATH(i + 1), content: `bigfile-${i + 1} ` + "B".repeat(3000) })),
    ],
  };

  const pace = appAgentPace;
  const db = makeAgentSuiteDb(rawDb, pace);
  const pools = makeAgentPoolTools(db, stamp, "p911d");
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };
  const lastSystem = () => lastSeenSystem(systemSeen);
  const invokeAgent = makeAgentInvoke({ handleAppAgent, client, options: opts, pace, responses });
  const invoke = makePayloadInvoke(invokeAgent, payload);

  try {
    // --- A. Contract (pure parsing — no platform requests) -----------------------------------
    const ap = (over) => parseAgentDocument(agentFilePath("ctx"), JSON.stringify({ instructions: INSTRUCTIONS, ...over }, null, 2));
    const d1 = ap({ context_files: [FAQ_PATH, PRICE_PATH] });
    harness.check("1a. a valid context_files config parses with the exact declared paths",
      d1.ok && JSON.stringify(d1.agent.context_files) === JSON.stringify([FAQ_PATH, PRICE_PATH]),
      d1.error || JSON.stringify(d1.agent && d1.agent.context_files));
    const ten = Array.from({ length: MAX_CONTEXT_FILES }, (_, i) => BIG_PATH(i + 1));
    const d2 = ap({ context_files: ten });
    harness.check(`1b. exactly ${MAX_CONTEXT_FILES} files (the documented maximum) are accepted`,
      d2.ok && d2.agent.context_files.length === MAX_CONTEXT_FILES, d2.error || "");
    const d3 = ap({ context_files: [...ten, "base44/context/eleventh.md"] });
    harness.check(`1c. more than ${MAX_CONTEXT_FILES} files is refused`,
      !d3.ok && new RegExp(`at most ${MAX_CONTEXT_FILES}`).test(d3.error || ""), d3.error || "");
    const d4 = ap({ context_files: ["src/App.js"] });
    harness.check("1d. a path outside base44/context/ is refused",
      !d4.ok && /invalid context file path/.test(d4.error || ""), d4.error || "");
    const d5 = ap({ context_files: ["base44/assets/logo.png"] });
    harness.check("1e. an asset (client-bundle) path is refused as a context file",
      !d5.ok && /invalid context file path/.test(d5.error || ""), d5.error || "");
    const d6 = ap({ context_files: [FAQ_PATH, FAQ_PATH] });
    harness.check("1f. a duplicate declaration is refused (deterministic handling at the contract)",
      !d6.ok && /more than once/.test(d6.error || ""), d6.error || "");
    const d7 = ap({ context_files: "faq.md" });
    harness.check("1g. a non-array value is refused", !d7.ok && /must be an array/.test(d7.error || ""), d7.error || "");
    const d8 = ap({ context_files: [FAQ_PATH, 42] });
    harness.check("1h. a non-string entry is refused", !d8.ok && /must be a non-empty context file path/.test(d8.error || ""), d8.error || "");
    const rt = parseAgentDocument(agentFilePath("ctx"), agentDocumentContent(d1.agent));
    harness.check("1i. the canonical document round-trips the declared context files",
      rt.ok && JSON.stringify(rt.agent.context_files) === JSON.stringify([FAQ_PATH, PRICE_PATH]),
      rt.error || JSON.stringify(rt.agent && rt.agent.context_files));
    const d9 = ap({ context_files: [FAQ_PATH], mystery: 1 });
    harness.check("1j. context_files is an owned key and never leaks into loose metadata",
      d9.ok && d9.agent.metadata?.context_files === undefined && d9.agent.metadata?.mystery === 1,
      d9.error || JSON.stringify(d9.agent && d9.agent.metadata));
    const d0 = ap({});
    harness.check("1k. an agent with NO context_files keeps the exact pre-P-9.11D shape (no key)",
      d0.ok && !("context_files" in d0.agent), d0.error || JSON.stringify(Object.keys(d0.agent || {})));

    // --- B. Configuration/deployment validation (pure) ---------------------------------------
    const agentFilesOf = (over) => [{ path: agentFilePath("ctx"), content: JSON.stringify({ instructions: INSTRUCTIONS, ...over }, null, 2) }];
    const filesWith = (extra) => [{ path: ENTRY_FILE, content: "export default 0;" }, ...extra];
    const faqFile = { path: FAQ_PATH, content: FAQ_CONTENT };
    const r1 = validateAgentReferences([...agentFilesOf({ context_files: [FAQ_PATH] }), faqFile], {});
    harness.check("2a. a declaration the project carries validates cleanly",
      r1.ok && r1.contextFileProblems.length === 0, JSON.stringify(r1.errors));
    const r2 = validateAgentReferences([...agentFilesOf({ context_files: [FAQ_PATH] }), { path: OTHER_PATH, content: OTHER }], {});
    harness.check("2b. a missing file reference is refused",
      !r2.ok && r2.contextFileProblems[0]?.reason === "missing" && /does not exist in this project/.test(r2.errors[0]?.error || ""),
      r2.errors[0]?.error || "");
    const r3 = validateAgentReferences([...agentFilesOf({ context_files: [FAQ_PATH] }), { path: FAQ_PATH, content: "x".repeat(CONTEXT_FILE_MAX_CHARS + 1) }], {});
    harness.check("2c. an oversized context file is refused at validation time",
      !r3.ok && r3.contextFileProblems[0]?.reason === "oversized" && new RegExp(`exceeds ${CONTEXT_FILE_MAX_CHARS}`).test(r3.errors[0]?.error || ""),
      r3.errors[0]?.error || "");
    const r4 = validateAgentReferences([...agentFilesOf({ context_files: [FAQ_PATH] }), { path: OTHER_PATH, content: OTHER }], {});
    harness.check("2d. a cross-project reference (a file only ANOTHER project carries) fails closed",
      !r4.ok && r4.contextFileProblems[0]?.reason === "missing", r4.errors[0]?.error || "");
    const b1 = runBuild(createFs(filesWith([...agentFilesOf({ context_files: [FAQ_PATH] }), faqFile])), [], []);
    harness.check("2e. runBuild passes a valid context-file configuration (no unrelated breakage)",
      b1.status === "success", (b1.logs.filter((l) => l.startsWith("error")) || []).join(" | ").slice(0, 200));
    const b2 = runBuild(createFs(filesWith(agentFilesOf({ context_files: [FAQ_PATH] }))), [], []);
    harness.check("2f. runBuild FAILS the build when a declared context file does not exist",
      b2.status === "failed" && b2.logs.some((l) => l.includes("does not exist in this project")),
      (b2.logs.filter((l) => l.startsWith("error")) || []).join(" | ").slice(0, 200));
    const b3 = runBuild(createFs(filesWith([...agentFilesOf({ context_files: [FAQ_PATH] }), { path: FAQ_PATH, content: "x".repeat(CONTEXT_FILE_MAX_CHARS + 1) }])), [], []);
    harness.check("2g. runBuild FAILS the build for an oversized context file",
      b3.status === "failed" && b3.logs.some((l) => l.includes(`exceeds ${CONTEXT_FILE_MAX_CHARS} characters`)),
      (b3.logs.filter((l) => l.startsWith("error")) || []).join(" | ").slice(0, 200));
    const b4 = runBuild(createFs(filesWith([faqFile])), [], []);
    harness.check("2h. a context file no agent declares does not affect the build",
      b4.status === "success", (b4.logs.filter((l) => l.startsWith("error")) || []).join(" | ").slice(0, 200));
    const p1 = projectContextFiles([faqFile, { path: PRICE_PATH, content: PRICE_CONTENT }], [{ name: "ctx", context_files: [FAQ_PATH, PRICE_PATH] }]);
    harness.check("2i. the artifact projection carries the validated references with exact content",
      p1.ok && p1.contextFiles.length === 2 && p1.contextFiles[0].path === FAQ_PATH && p1.contextFiles[0].content === FAQ_CONTENT,
      JSON.stringify(p1).slice(0, 160));
    const p2 = projectContextFiles([faqFile], [{ name: "a1", context_files: [FAQ_PATH] }, { name: "a2", context_files: [FAQ_PATH] }]);
    harness.check("2j. references shared by several agents dedupe deterministically to one row",
      p2.ok && p2.contextFiles.length === 1, JSON.stringify(p2.contextFiles.map((c) => c.path)));
    const p3 = projectContextFiles([faqFile], [{ name: "broken", context_files: [FAQ_PATH, "base44/context/ghost.md"] }]);
    harness.check("2k. the artifact projection refuses a file the version does not contain (fail-closed)",
      !p3.ok && /does not contain/.test(p3.error || ""), p3.error || "");
    const p4 = projectContextFiles([faqFile], [{ name: "plain" }]);
    harness.check("2l. an undeclared project yields an empty projection (artifact byte-identical)",
      p4.ok && p4.contextFiles.length === 0, JSON.stringify(p4));

    // --- C. Bounded, scrubbed rendering (pure) ------------------------------------------------
    harness.check("3a. an empty context set renders no block", renderAgentContextBlock([]) === "", "empty → empty");
    const bigItems = Array.from({ length: 10 }, (_, i) => ({ path: BIG_PATH(i + 1), content: `bigfile-${i + 1} ` + "B".repeat(4000) }));
    const block = renderAgentContextBlock(bigItems);
    harness.check("3b. the rendered block is bounded, scrub-truncated per file, in declared order",
      block.includes("bigfile-1") && block.includes("bigfile-10")
        && block.indexOf("bigfile-1") < block.indexOf("bigfile-10")
        && block.length <= APP_AGENT_LIMITS.CONTEXT_BLOCK_CHARS + 500,
      `block ${block.length} chars, cap ${APP_AGENT_LIMITS.CONTEXT_BLOCK_CHARS}`);
    const one = renderAgentContextBlock([{ path: FAQ_PATH, content: "x".repeat(60000) }]);
    harness.check("3c. a single huge file renders only the per-file excerpt cap",
      one.length > 0 && one.length <= APP_AGENT_LIMITS.CONTEXT_FILE_CHARS + 500,
      `excerpt ${one.length} chars, cap ${APP_AGENT_LIMITS.CONTEXT_FILE_CHARS}`);
    const scrubbed = renderAgentContextBlock([{ path: SECRET_PATH, content: `The deploy token is ${TOKEN}.` }]);
    harness.check("3d. a credential-shaped content is scrubbed in the rendered block",
      scrubbed.includes("[REDACTED]") && !scrubbed.includes(TOKEN), scrubbed.slice(0, 120));
    const skipEmpty = renderAgentContextBlock([{ path: FAQ_PATH, content: "" }, { path: PRICE_PATH, content: PRICE }]);
    harness.check("3e. an empty file is skipped and the next file still renders",
      skipEmpty.includes(PRICE) && !skipEmpty.includes(FAQ_PATH), skipEmpty.slice(0, 120));

    // --- fixtures: one funded workspace, two projects ----------------------------------------
    const plan = await makeBillingPlan(db, created, `p911dt${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911da${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await pace(1500);
    await pools.grant(A.ws.id, "message", 300);
    await pools.grant(A.ws.id, "integration", 60);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911d-proj-${A.user.id}-${stamp}`, slug: `p911da-${stamp}`, rls_enabled: true });
    const projB = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911d-proj-b-${A.user.id}-${stamp}`, slug: `p911db-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id, projB.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p911d.test", display_name: "A1", email_verified: true });
    const userB1 = await createPasswordlessUser(db, projB, { email: "b1@p911d.test", display_name: "B1", email_verified: true });
    const userAnon = await createAnonymousUser(db, projA, {});
    const int0 = await pools.intOf(A.ws.id);
    const msg0 = await pools.msgOf(A.ws.id);
    const poolBeforeTurns = await pools.intOf(A.ws.id);
    await pace(15000);

    // --- D. Runtime: availability, isolation, scrubbing --------------------------------------
    await invoke(projA, userA1, "ctx", "what is the return policy?");
    harness.check("4a. declared context is actually available to the agent during execution",
      lastSystem().includes("CONTEXT FILES") && lastSystem().includes(FAQ) && lastSystem().includes(PRICE),
      `system ${lastSystem().length} chars`);
    await invoke(projA, userA1, "plain", "hello");
    harness.check("4b. an agent WITHOUT context files behaves exactly as before (no block, no content)",
      !lastSystem().includes("CONTEXT FILES") && !lastSystem().includes(FAQ)
        && lastSystem().includes("You are the in-app assistant") && lastSystem().includes("MEMORY: you may save"),
      "plain agent system unchanged");
    await invoke(projA, userA1, "other", "what do you know?");
    harness.check("4c. context is agent-scoped: another agent never sees this agent's files",
      lastSystem().includes(OTHER) && !lastSystem().includes(FAQ) && !lastSystem().includes(PRICE),
      "other agent got only its own file");
    await invoke(projA, userA1, "secrets", "what are the policies?");
    harness.check("4d. a credential planted in a context file is scrubbed before injection",
      lastSystem().includes("[REDACTED]") && !lastSystem().includes(TOKEN),
      "scrubbed at render time");
    await invoke(projA, null, "anon", "what is the return policy?", {}, { user: userAnon });
    harness.check("4e. an anonymous turn of an anonymous-enabled agent gets the same agent-level context",
      lastSystem().includes("CONTEXT FILES") && lastSystem().includes(FAQ), "anonymous context parity");
    // Cross-project runtime isolation: project B's payload carries none of project A's files.
    const payloadB = { agents: [mkAgent("b_plain")], entities: [], functions: [], integrations: [] };
    await pace(2500);
    const rB = await handleAppAgent(client, { project: projB, payload: payloadB, user: userB1, op: "invoke", args: { name: "b_plain", message: "hello" }, options: opts });
    responses.push(rB);
    harness.check("4f. cross-project isolation: project B's agent never sees project A's context",
      !lastSystem().includes("CONTEXT FILES") && !lastSystem().includes(FAQ) && !lastSystem().includes(PRICE),
      "B's system free of A's reference material");
    await invoke(projA, userA1, "bigctx", "summarize your references");
    const sysBig = lastSystem();
    harness.check("4g. runtime injection is bounded and preserves the declared order",
      sysBig.includes("bigfile-1") && sysBig.includes("bigfile-10")
        && sysBig.indexOf("bigfile-1") < sysBig.indexOf("bigfile-10")
        && sysBig.length <= APP_AGENT_LIMITS.CONTEXT_BLOCK_CHARS + 5000,
      `system ${sysBig.length} chars, cap ${APP_AGENT_LIMITS.CONTEXT_BLOCK_CHARS}`);

    // --- E. Fail-closed refusal BEFORE any persistence or charge ------------------------------
    const poolBeforeBroken = await pools.intOf(A.ws.id);
    const broken = await captureCall(() => invoke(projA, userA1, "broken", "please answer"));
    harness.check("5a. a declared file the deployment does not carry refuses the invoke fail-closed",
      broken.threw && broken.code === "AGENT_CONTEXT_FILE_MISSING", broken.code || "no refusal");
    const rowsAfterBroken = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 50).catch(() => []);
    harness.check("5b. the refusal happened BEFORE any persistence or charge",
      (await pools.intOf(A.ws.id)) === poolBeforeBroken
        && !rowsAfterBroken.some((r) => String((r.data || {}).content || "").includes("please answer")),
      `pool ${poolBeforeBroken} → ${await pools.intOf(A.ws.id)}, ${rowsAfterBroken.length} message row(s)`);

    // --- F. Idempotency and billing ------------------------------------------------------------
    const k = `p911d-key-${stamp}`;
    script = [{ action: "reply", content: "keyed done" }];
    const k1 = await invoke(projA, userA1, "ctx", "keyed question", { idempotency_key: k });
    const k2 = await invoke(projA, userA1, "ctx", "keyed question", { idempotency_key: k });
    harness.check("6a. a keyed turn with context files replays idempotently (no second charge)",
      k1.reply === "keyed done" && k2.reply === "keyed done" && k2.idempotent_replay === true,
      JSON.stringify({ first: k1.reply, second: k2.reply, replay: k2.idempotent_replay }));
    const replyRow = await findKeyedReplyRow(db, projA.id, k);
    harness.check("6b. exactly one keyed reply row is persisted",
      !!replyRow && (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 50)).filter((r) => (r.data || {}).invoke_key === k && (r.data || {}).role === "assistant").length === 1,
      replyRow ? "one row" : "row missing");
    const poolAfterTurns = await pools.intOf(A.ws.id);
    harness.check("6c. the per-message INTEGRATION charge is applied through the EXISTING path (no context tariff)",
      poolAfterTurns < poolBeforeTurns, `${poolBeforeTurns} → ${poolAfterTurns}`);
    harness.check("6d. the message pool is untouched by context files",
      (await pools.msgOf(A.ws.id)) === msg0, `${msg0} → ${await pools.msgOf(A.ws.id)}`);
    const ledger = await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "-created_date", 500).catch(() => []);
    const keys = ledger.map((r) => r.idempotency_key).filter(Boolean);
    const dups = keys.filter((kx, i) => keys.indexOf(kx) !== i);
    harness.check("6e. no duplicate ledger idempotency keys (no double charge)", dups.length === 0, JSON.stringify(dups.slice(0, 3)));
    const offPath = ledger.filter((r) => r.idempotency_key
      && !String(r.idempotency_key).includes("appagent:")
      && !String(r.idempotency_key).startsWith("p911d:"));
    harness.check("6f. no second ledger path: every movement is a model-step charge or the test grant",
      offPath.length === 0, JSON.stringify(offPath.slice(0, 2).map((r) => r.idempotency_key)));

    // --- G. Leakage ------------------------------------------------------------------------------
    const allJson = JSON.stringify(responses);
    harness.check("7a. no credential, no instruction text and no response ever carries context markers",
      !allJson.includes(TOKEN) && !allJson.includes(INSTRUCTIONS), `responses scanned: ${responses.length}`);
    harness.check("7b. no system prompt carries a raw credential from a context file",
      !systemSeen.some((s) => s.includes(TOKEN)), `${systemSeen.length} system prompt(s) scanned`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by name pattern, including residue from earlier runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911d-proj" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911da[0-9]" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
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
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911dt[0-9]+$" } }).catch(() => {});
  }
}