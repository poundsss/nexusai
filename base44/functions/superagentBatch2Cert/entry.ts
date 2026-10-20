// Batch 2 Superagent parity certification — sub-agents, chat web browsing, artifacts.
//
// Drives the REAL shipping modules (agentSubagents / agentWebBrowse / the agentLoop decision
// contract / appAgentRuntime / agentFileStore) — only the model provider and the HTTP page
// boundary are scripted. Everything is sandbox scratch data, all fixtures are synthetic, no
// real external call, message or browser action ever happens, and every fixture is removed in
// the finally block.
//
// Realtime Voice is NOT certified here: the repository contains NO verified realtime
// transport/provider contract (the ActorRelay contract is downstream-only; Base44 publishes no
// realtime voice protocol) — realtime Voice is reported UNKNOWN, and the certified turn-based
// Voice Mode is untouched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, captureCall } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { grantTestPool } from "../../shared/creditPoolTestHelpers.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, makeRuntimeAgent } from "../../shared/appAgentSuiteHelpers.ts";
import {
  delegateSubagents, subagentsStatus, cancelSubagentsOf,
  SUBAGENT_MAX_TASKS, SUBAGENT_MAX_DELEGATION_DEPTH,
} from "../../shared/agentSubagents.ts";
import { runWebBrowse, WEB_BROWSE_LIMITS } from "../../shared/agentWebBrowse.ts";
import { ACTION_SCHEMA, gateAction, AGENT_TERMINAL } from "../../shared/agentLoop.ts";
import { registerUpload, listFolder, saveArtifact, ARTIFACTS_FOLDER, ROOT } from "../../shared/agentFileStore.ts";

const apiResponse = (status, body, contentType = "text/html") =>
  new Response(body, { status, headers: { "content-type": contentType } });
const PAGE_HTML = `<html><head><title>Base44 Docs</title></head><body><p>${"hello page ".repeat(30)}</p><a href="https://docs.example.test/next">next</a></body></html>`;

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const runIds = [];

  // ---- model provider stub: scripted decisions; captures the system prompt + messages ---------
  let script = [];
  const messagesSeen = [];
  const systemSeen = [];
  const fakeProvider = {
    async generate({ system, messages, jsonSchema }) {
      if (typeof system === "string") systemSeen.push(system);
      if (Array.isArray(messages)) messagesSeen.push(messages);
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };

  // ---- page HTTP boundary stub: records fetches, serves one synthetic page --------------------
  const pages = { calls: 0, urls: [] };
  const pageFetch = async (url) => {
    pages.calls++;
    pages.urls.push(String(url));
    return apiResponse(200, PAGE_HTML, "text/html");
  };

  const TASK = { name: "task", fields: { title: { type: "string", required: true }, done: { type: "boolean" } } };
  const runtimeAgent = makeRuntimeAgent("helper", {}, "Answer briefly.");
  const payload = { agents: [runtimeAgent], entities: [TASK], functions: [], integrations: [] };

  try {
    // --- fixtures: one funded RLS workspace, one project, one user ---------------------------
    const db = makeAgentSuiteDb(rawDb, appAgentPace);
    const plan = await makeBillingPlan(db, created, `b2pl${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `b2wsa${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "message", amount: 200, key: `b2:msg:A:${stamp}`, reason: "Batch 2 cert grant" });
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "integration", amount: 200, key: `b2:int:A:${stamp}`, reason: "Batch 2 cert grant" });
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `b2-proj-${stamp}`, slug: `b2-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: `a1-b2-${stamp}@b2.test`, display_name: "A1", email_verified: true });
    await appAgentPace(8000);

    // helper: an AgentRun fixture the sub-agent layer can delegate FROM
    const parent = async () => db.entities.AgentRun.create({
      project_id: projA.id, workspace_id: A.ws.id, user_id: userA1.id, agent_name: "helper",
      trace_id: `trc-${stamp}`, goal: "research two topics and combine", status: "RUNNING",
      current_phase: "acting", current_step: 1, max_steps: 20, cancel_requested: false,
      delegation_depth: 0, started_at: new Date().toISOString(),
    });
    const p1 = await parent();
    runIds.push(p1.id);

    // =================== S. SUB-AGENTS / BACKGROUND DELEGATION ===============================
    // Delegate three independent tasks: REAL child AgentRun rows the deployed Agent Executor
    // workflow drives in the background with its own lease and per-run usage settlement.
    const delegated = await delegateSubagents(db, { run: p1, tasksJson: JSON.stringify([
      { goal: "Topic A research" }, { goal: "Topic B research" }, { goal: "Topic C research" },
    ]) });
    const childRows = (await db.entities.AgentRun.filter({ parent_agent_run_id: p1.id }, "created_date", 10));
    harness.check("S1. delegation creates parallel QUEUED child AgentRuns bound to the parent",
      delegated.ok === true && delegated.mode === "delegated" && delegated.tasks.length === 3
        && childRows.length === 3
        && childRows.every((c) => c.status === "QUEUED" && (Number(c.delegation_depth) || 0) === 1
          && c.parent_agent_run_id === p1.id && c.trace_id === `trc-${stamp}`
          && c.agent_name === "helper" && c.user_id === userA1.id && !c.lease_token && !c.usage_event_id),
      JSON.stringify(childRows.map((c) => ({ s: c.status, d: c.delegation_depth, p: c.parent_agent_run_id }))));
    runIds.push(...childRows.map((c) => c.id));

    const tooMany = await delegateSubagents(db, { run: p1, tasksJson: JSON.stringify(Array.from({ length: SUBAGENT_MAX_TASKS + 1 }, () => ({ goal: "extra" }))) });
    const badTasks = await delegateSubagents(db, { run: p1, tasksJson: JSON.stringify([{ goal: "  " }]) });
    const badJson = await delegateSubagents(db, { run: p1, tasksJson: "{nope" });
    harness.check("S2. input is validated before any child is created (task cap, empty goal, bad JSON)",
      !tooMany.ok && tooMany.code === "SUBAGENT_TASKS_INVALID"
        && !badTasks.ok && badTasks.code === "SUBAGENT_TASKS_INVALID"
        && !badJson.ok && badJson.code === "SUBAGENT_TASKS_INVALID",
      JSON.stringify([tooMany.code, badTasks.code, badJson.code]));

    // Recursion guard: a child may never delegate further.
    const child1 = childRows.find((c) => c.goal === "Topic A research");
    const depthRefused = await delegateSubagents(db, { run: child1, tasksJson: JSON.stringify([{ goal: "nested" }]) });
    harness.check("S3. delegation cannot recurse: a child delegating further is refused",
      !depthRefused.ok && depthRefused.code === "DELEGATION_DEPTH_EXCEEDED"
        && SUBAGENT_MAX_DELEGATION_DEPTH === 1, depthRefused.code || "not refused");

    // Terminal child outcomes (kept work) + failure propagation through the persisted panel.
    await db.entities.AgentRun.update(child1.id, { status: "COMPLETED", result_summary: "Found 3 sources.", completed_at: new Date().toISOString() });
    const child2 = childRows.find((c) => c.goal === "Topic B research");
    await db.entities.AgentRun.update(child2.id, { status: "FAILED", failure_code: "AGENT_ERROR", error: "boom", completed_at: new Date().toISOString() });
    const statusProbe = await delegateSubagents(db, { run: p1, tasksJson: "" });
    harness.check("S4. the persisted task panel shows terminal outcomes from the parent (failure propagated, running visible)",
      statusProbe.ok === true && statusProbe.mode === "status" && statusProbe.completed === 1 && statusProbe.failed === 1
        && statusProbe.running === 1 && /Found 3 sources/.test(statusProbe.block) && /FAILED/.test(statusProbe.block),
      statusProbe.block);

    // Stop propagation: non-terminal children are marked, terminal work is kept.
    const p2 = await parent();
    runIds.push(p2.id);
    const delegated2 = await delegateSubagents(db, { run: p2, tasksJson: JSON.stringify([{ goal: "one task" }]) });
    const childP2 = (await db.entities.AgentRun.filter({ parent_agent_run_id: p2.id }, "created_date", 5))[0];
    runIds.push(childP2.id);
    const stopped = await cancelSubagentsOf(db, p2.id);
    const childP2After = await db.entities.AgentRun.get(childP2.id);
    const keptChild = await db.entities.AgentRun.get(child2.id);
    harness.check("S5. stopping a parent marks its running sub-agents cancel_requested and keeps finished work",
      delegated2.ok && stopped.stopped === 1 && childP2After.cancel_requested === true
        && keptChild.cancel_requested !== true, JSON.stringify({ stopped, kept: keptChild.cancel_requested }));

    // Isolation: every child is an independent run — its OWN lease is claimed by its OWN
    // executor worker and its OWN usage settlement; nothing is shared with the parent.
    const freshChildren = await db.entities.AgentRun.filter({ parent_agent_run_id: { $in: [p1.id, p2.id] } }, "created_date", 20);
    harness.check("S6. budget/lease isolation: each child is its own run (no shared lease or usage)",
      freshChildren.length === 4
        && new Set(freshChildren.map((c) => c.id)).size === 4
        && freshChildren.every((c) => !c.lease_token && !c.usage_event_id && (Number(c.input_tokens) || 0) === 0),
      `${freshChildren.length} children`);

    // The loop integration: the action exists in the decision contract and is platform-issued.
    harness.check("S7. the loop's decision contract carries delegate_subagents as a platform-issued action",
      (ACTION_SCHEMA.properties.action.enum || []).includes("delegate_subagents")
        && (ACTION_SCHEMA.required || []).includes("tasks_json")
        && gateAction(null, "delegate_subagents") === null
        && gateAction(() => ({ allowed: false, code: "AGENT_TOOL_NOT_GRANTED", reason: "no grant" }), "delegate_subagents") === null
        && gateAction(() => ({ allowed: false, code: "AGENT_TOOL_NOT_GRANTED", reason: "no grant" }), "read_file") !== null,
      "action present, platform-issued, non-subagent grants unchanged");

    // =================== B. WEB BROWSING FROM SUPERAGENT CHAT ================================
    const okPage = await runWebBrowse({ url: "https://docs.example.test/page", fetchImpl: pageFetch });
    harness.check("B1. a https page browses to bounded read-only content",
      okPage.ok === true && okPage.page.title === "Base44 Docs" && /hello page/.test(okPage.page.text)
        && okPage.page.links[0] === "https://docs.example.test/next"
        && okPage.page.text.length <= WEB_BROWSE_LIMITS.PAGE_TEXT_CHARS && pages.calls === 1,
      JSON.stringify({ title: okPage.page?.title, calls: pages.calls }));

    let fetchCounter = pages.calls;
    const httpRefused = await runWebBrowse({ url: "http://docs.example.test/page", fetchImpl: pageFetch });
    const privateRefused = await runWebBrowse({ url: "https://192.168.1.10/page", fetchImpl: pageFetch });
    const localhostRefused = await runWebBrowse({ url: "https://localhost:8080/", fetchImpl: pageFetch });
    harness.check("B2. the documented SSRF guard: non-https and private/local hosts refused BEFORE any fetch",
      httpRefused.ok === false && httpRefused.code === "BRIDGE_URL_REFUSED"
        && privateRefused.ok === false && privateRefused.code === "BRIDGE_URL_REFUSED"
        && localhostRefused.ok === false && localhostRefused.code === "BRIDGE_URL_REFUSED"
        && pages.calls === fetchCounter,
      JSON.stringify({ http: httpRefused.code, private: privateRefused.code, calls: pages.calls }));

    const bigPage = await runWebBrowse({ url: "https://docs.example.test/big", fetchImpl: async () =>
      apiResponse(200, `<html><body>${"x".repeat(12000)}</body></html>`, "text/html") });
    harness.check("B3. oversized page text is bounded before it reaches the model",
      bigPage.ok === true && bigPage.page.text.length <= WEB_BROWSE_LIMITS.PAGE_TEXT_CHARS, `${bigPage.page?.text?.length} chars`);

    const notFound = await runWebBrowse({ url: "https://docs.example.test/missing", fetchImpl: async () => apiResponse(404, "nope") });
    const blankBody = await runWebBrowse({ url: "https://docs.example.test/blank", fetchImpl: async () => apiResponse(200, "", "text/html") });
    const noText = await runWebBrowse({ url: "https://docs.example.test/empty", fetchImpl: async () => apiResponse(200, "<html></html>", "text/html") });
    harness.check("B4. provider-side failures are normalized, never-thrown errors (404 refused; blank body and a markup-only page read as no content)",
      !notFound.ok && notFound.code === "BRIDGE_BROWSE_FAILED"
        && !blankBody.ok && blankBody.code === "BRIDGE_BROWSE_EMPTY"
        && noText.ok === true && (noText.page.text || "") === "" && (noText.page.title || "") === "",
      JSON.stringify([notFound.code, blankBody.code, noText.ok]));

    // End-to-end: a full Superagent turn that browses from chat; the activity is watchable
    // through the EXISTING tool_calls projection and the result reaches the model.
    script = [
      { action: "tool", tool: { name: "browse_page", input: { url: "https://docs.example.test/page" } } },
      { action: "reply", content: "The page says hello." },
    ];
    const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };
    const invoke = makeAgentInvoke({ handleAppAgent, client, options: { providerOverrides, webSearch: { fetchImpl: pageFetch } }, pace: appAgentPace, responses: [] });
    const turn = await invoke({ project: projA, payload, user: userA1, name: "helper", message: "read the docs page for me" });
    const replyRow = turn.message_id ? await db.entities.AppRecord.get(turn.message_id) : null;
    harness.check("B5. a Superagent turn browses from chat and the result is watchable in the persisted message",
      turn.reply === "The page says hello." && pages.calls >= fetchCounter + 1
        && !!replyRow && (replyRow.data.tool_calls || []).some((t) => t.tool === "browse_page" && t.ok === true)
        && systemSeen.some((s) => s.includes('"browse_page"'))
        && messagesSeen.some((m) => JSON.stringify(m).includes("[tool browse_page result]")),
      JSON.stringify(turn).slice(0, 200));

    // The tool is advertised with NO setup (documented "no setup" browsing), unlike the
    // key-gated google_search.
    harness.check("B6. browsing is advertised with no provider key configured",
      systemSeen.some((s) => s.includes('"browse_page"')), "not advertised");

    // =================== A. AGENT ARTIFACTS (audit of the certified flow) ====================
    const ctx = { workspace_id: A.ws.id };
    // Under the suite's write load the store's secondary index lags a few seconds behind its
    // writes; every read below waits for visibility instead of failing on that lag.
    const waitVisible = async (query, tries = 10) => {
      let lastErr = "";
      for (let i = 0; i < tries; i++) {
        try {
          const page = await db.entities.AgentStoreFile.filter(query, { limit: 1 });
          if ((page.items || []).length) return true;
          lastErr = "no rows";
        } catch (e) { lastErr = `${e.status || ""} ${e.code || ""}: ${String(e.message || "").slice(0, 140)}`; }
        await appAgentPace(4000);
      }
      ensureErr = `waitVisible exhausted: ${lastErr}`;
      return false;
    };
    let ensureErr = "";
    try { await listFolder(db, ctx, { agent_name: "helper", parent_path: ROOT }); }
    catch (e) { ensureErr = `listFolder threw ${e.code}: ${e.message}`; }
    const rootEntries = await listFolder(db, ctx, { agent_name: "helper", parent_path: ROOT }).catch(() => []);
    harness.check("A1. the artifacts folder is ensured on first browse of the store root",
      Array.isArray(rootEntries) && rootEntries.some((r) => r.name === ARTIFACTS_FOLDER && r.type === "folder"),
      JSON.stringify({ ensureErr, root: (rootEntries || []).map((r) => r.name) }));

    const bytes = new TextEncoder().encode(`artifact-${stamp}`);
    let stored = null;
    for (let a = 0; a < 3 && !stored; a++) {
      try { stored = await db.integrations.Core.UploadPrivateFile({ file: new File([bytes], "b2-artifact.txt", { type: "text/plain" }) }); }
      catch (e) { if (a === 2) throw e; await appAgentPace(8000); }
    }
    const saved = await registerUpload(db, ctx, {
      agent_name: "helper", parent_path: ARTIFACTS_FOLDER, name: `b2-artifact-${stamp}.txt`,
      file_uri: stored.file_uri, size_bytes: bytes.length, mime_type: "text/plain",
      source: "artifact", artifact_url: `https://media.example.test/b2-artifact-${stamp}.txt`,
    });
    harness.check("A2. a chat artifact saves into the artifacts folder as source=artifact with its origin URL",
      saved?.type === "file" && saved?.source === "artifact" && saved?.parent_path === ARTIFACTS_FOLDER
        && saved?.artifact_url?.startsWith("https://") && !!saved.file_uri,
      JSON.stringify({ s: saved?.source, p: saved?.parent_path }));

    await waitVisible({ agent_name: "helper", workspace_id: A.ws.id, parent_path: ARTIFACTS_FOLDER, name: saved.name });
    const artifacts = await listFolder(db, ctx, { agent_name: "helper", parent_path: ARTIFACTS_FOLDER }).catch(() => []);
    harness.check("A3. the saved artifact persists and re-opens from the artifacts folder",
      (artifacts || []).some((r) => r.id === saved.id && r.source === "artifact" && r.file_uri === saved.file_uri),
      `${(artifacts || []).length} entries`);

    const badUrl = await (async () => { try { await saveArtifact(db, ctx, { agent_name: "helper", url: "http://insecure.example.test/x" }); return null; } catch (e) { return e.code || "ERR"; } })();
    harness.check("A4. artifact saving stays https-only fail-closed (no fetch attempted)",
      badUrl === "BAD_URL", badUrl || "not refused");

    return Response.json({ ...harness.summary(), failures: harness.summary().failures });
  } catch (error) {
    const { passed, failed, failures } = harness.summary();
    return Response.json({ ok: false, error: error.message, passed, failed, failures }, { status: 500 });
  } finally {
    // Scratch cleanup: run fixtures, app data, projects, workspaces, billing.
    for (const id of runIds) await rawDb.entities.AgentRun.delete(id).catch(() => {});
    await rawDb.entities.AgentStep.deleteMany({ agent_run_id: { $in: runIds } }).catch(() => {});
    const scratchProjects = await rawDb.entities.Project.filter({ name: { $regex: "^b2-proj-" } }, "created_date", 50).catch(() => []);
    const scratchWorkspaces = await rawDb.entities.Workspace.filter({ name: { $regex: "^b2ws" } }, "created_date", 50).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await rawDb.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await rawDb.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await rawDb.entities.AuditLog.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await rawDb.entities.AgentRun.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await rawDb.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await rawDb.entities.AgentStoreFile.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
    }
    if (wIds.length) {
      await rawDb.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await rawDb.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await rawDb.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await rawDb.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await rawDb.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await rawDb.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await rawDb.entities.BillingPlan.delete(planId).catch(() => {});
  }
}