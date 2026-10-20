// Targeted certification for the Phase 2 Gmail connector workflow integration (MANAGED connector).
//
// Verifies the smallest NexusAI surface that supports the audited Base44 behavior:
//   • a connector trigger with integration_type=gmail / event=mailbox + the documented jq
//     condition `${ .trigger.data.has_new_non_draft_messages == true }`;
//   • a handler that reads `trigger.data.new_message_ids` and fetches message content through
//     `getConnection('gmail')`, failing closed on a missing/invalid connection.
//
// Uses the REAL dispatch path (`emitConnector` → `dispatchWorkflowEvent` → `startWorkflowRun`) for
// trigger matching, condition gating and replay idempotency, and the REAL handler core
// (shared/gmailMailboxHandler.ts) with a MOCK Gmail API transport. NO real Gmail account, NO
// production message access, NO Pub/Sub delivery — the platform-managed half is explicitly out of
// scope and marked UNKNOWN.
//
// Coverage (12 checks, mirroring the requested certification bullets; 9-12 add the confirmed
// has_new_messages payload-parity coverage — internal fields preserved, nothing else changed):
//   1. gmail connector trigger accepts integration_type=gmail, event=mailbox;
//   2. has_new_non_draft_messages=true matches and dispatches a run;
//   3. has_new_non_draft_messages=false does NOT match (no run);
//   4. new_message_ids reaches the handler (each id is fetched);
//   5. getConnection('gmail') authorization is enforced (Bearer token used on every fetch);
//   6. Gmail message retrieval works against the test/mock contract;
//   7. invalid/missing connection fails closed (no messages fetched);
//   8. no duplicate workflow execution for the same trigger delivery.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { emitConnector } from "../../shared/workflowTriggers.ts";
import { ingestConnectorDelivery } from "../../shared/managedConnectorIngest.ts";
import { handleGmailMailbox } from "../../shared/gmailMailboxHandler.ts";
import { WORKFLOW_CONTRACT_VERSION, validateWorkflow, workflowChecksum } from "../../shared/workflowContract.ts";

// Runtime WorkflowDefinition.trigger.condition is RAW jq (no `${}` wrapper) — see
// connectorConditionTest (`.event == "message"`). The `${}` form is the SWF-file template syntax.
const COND = ".trigger.data.has_new_non_draft_messages == true";
const WF_KEY = "gmail-mailbox";
// The Base44-documented public condition field, for payload-parity coverage.
const DOC_COND = ".trigger.data.has_new_messages == true";
const WF_KEY_DOCUMENTED = "gmail-mailbox-documented";

function finalizeGmailWf(svc, { project, workspace, key = WF_KEY, condition = COND } = {}) {
  const def = {
    name: "Gmail Mailbox",
    trigger: { type: "connector", connector: "gmail", event: "mailbox", condition },
    steps: [{ id: "fetch", type: "complete", message: "ok" }],
    entry_step: "fetch",
  };
  const v = validateWorkflow(def, { functionNames: [] });
  if (!v.ok) throw new Error(`fixture invalid: ${v.errors.join("; ")}`);
  return svc.entities.WorkflowDefinition.create({
    workflow_key: key, name: def.name, version: 1, status: "FINALIZED", finalized: true,
    project_id: project.id, workspace_id: workspace.id,
    trigger: def.trigger, trigger_type: "connector", trigger_event: "mailbox",
    steps: def.steps, entry_step: "fetch", definition_checksum: workflowChecksum(def),
    contract_version: WORKFLOW_CONTRACT_VERSION, created_at: new Date().toISOString(),
  });
}

// Mock Gmail messages API transport: records every call and returns scripted message bodies.
// No real network — guarantees no production Gmail access.
function mockGmailHttp(messages) {
  const calls = [];
  const http = async (url, options) => {
    calls.push({ url, options });
    const id = String(url).split("/messages/")[1]?.split("?")[0];
    const m = messages[id];
    if (m) return { ok: true, status: 200, body: m };
    return { ok: false, status: 404, body: { error: "not found" } };
  };
  return { http, calls };
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `gmail-${Date.now()}`;
  const h = createHarness();
  const scratch = { workspace: null, projects: [] };
  let project = null, workspace = null, wf = null;

  try {
    workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    scratch.workspace = workspace.id;
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-proj`, status: "ready", version_count: 0, slug: TAG.toLowerCase() });
    scratch.projects.push(project.id);
    wf = await finalizeGmailWf(svc, { project, workspace });
    await finalizeGmailWf(svc, { project, workspace, key: WF_KEY_DOCUMENTED, condition: DOC_COND });

    const runsFor = () => svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: WF_KEY }, "-created_date", 20);
    const payload = (hasNonDraft, ids) => ({ trigger: { data: { has_new_non_draft_messages: hasNonDraft, new_message_ids: ids } } });

    // --- 1. trigger accepts integration_type=gmail, event=mailbox ---------------------
    h.check("1 gmail connector trigger accepts integration_type=gmail event=mailbox",
      wf.status === "FINALIZED" && wf.trigger_type === "connector" && wf.trigger_event === "mailbox" && wf.trigger?.connector === "gmail" && wf.trigger?.condition === COND,
      `status=${wf.status} type=${wf.trigger_type} event=${wf.trigger_event} connector=${wf.trigger?.connector}`);

    // --- 2. has_new_non_draft_messages=true matches ----------------------------------
    const r1 = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "gmail", event: "mailbox", payload: payload(true, ["m1", "m2"]), delivery_id: "gmail-d1" });
    h.check("2 has_new_non_draft_messages=true matches and dispatches",
      r1.matched === 1 && (await runsFor()).length === 1,
      `matched=${r1.matched} runs=${(await runsFor()).length}`);

    // --- 3. has_new_non_draft_messages=false does not match ---------------------------
    const r2 = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "gmail", event: "mailbox", payload: payload(false, ["m3"]), delivery_id: "gmail-d2" });
    h.check("3 has_new_non_draft_messages=false does not match",
      r2.matched === 0 && (await runsFor()).length === 1,
      `matched=${r2.matched} runs=${(await runsFor()).length}`);

    // --- 8. no duplicate workflow execution for the same trigger delivery ------------
    const r3 = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "gmail", event: "mailbox", payload: payload(true, ["m1"]), delivery_id: "gmail-d1" });
    h.check("8 no duplicate workflow execution for the same trigger delivery",
      r3.matched === 1 && r3.runs?.[0]?.duplicate === true && (await runsFor()).length === 1,
      `matched=${r3.matched} dup=${r3.runs?.[0]?.duplicate} runs=${(await runsFor()).length}`);

    // --- 4 + 5 + 6. new_message_ids reaches handler; auth enforced; retrieval works ---
    const mock = mockGmailHttp({
      m1: { id: "m1", threadId: "t1", snippet: "hello world", labelIds: ["INBOX"] },
      m2: { id: "m2", threadId: "t2", snippet: "second message", labelIds: ["INBOX", "UNREAD"] },
    });
    const hres = await handleGmailMailbox({
      data: { has_new_non_draft_messages: true, new_message_ids: ["m1", "m2"] },
      getConnection: async () => ({ accessToken: "gmail-tok" }),
      http: mock.http,
    });
    h.check("4 new_message_ids reaches the handler",
      hres.ok === true && mock.calls.length === 2 && mock.calls.every((c) => /\/messages\/(m1|m2)\?format=full$/.test(c.url)),
      `ok=${hres.ok} calls=${mock.calls.length} urls=${mock.calls.map((c) => c.url).join(" | ")}`);
    h.check("5 getConnection('gmail') authorization is enforced",
      hres.ok === true && mock.calls.every((c) => c.options?.headers?.Authorization === "Bearer gmail-tok"),
      `auth=${mock.calls[0]?.options?.headers?.Authorization}`);
    h.check("6 Gmail message retrieval works against the test/mock contract",
      hres.ok === true && hres.count === 2 && hres.requested === 2
      && hres.messages[0]?.id === "m1" && hres.messages[0]?.snippet === "hello world" && hres.messages[0]?.threadId === "t1"
      && hres.messages[1]?.id === "m2" && hres.messages[1]?.labelIds?.includes("UNREAD"),
      `ok=${hres.ok} count=${hres.count} m0=${hres.messages[0]?.id} m1=${hres.messages[1]?.id}`);

    // --- 7. invalid/missing connection fails closed -----------------------------------
    const missing1 = await handleGmailMailbox({ data: { new_message_ids: ["m1"] }, getConnection: async () => { throw new Error("no connection"); }, http: mock.http });
    const missing2 = await handleGmailMailbox({ data: { new_message_ids: ["m1"] }, getConnection: async () => ({}), http: mock.http });
    const callsBefore = mock.calls.length;
    await handleGmailMailbox({ data: { new_message_ids: ["m1"] }, getConnection: async () => null, http: mock.http });
    h.check("7 invalid/missing connection fails closed",
      missing1.ok === false && missing1.code === "CONNECTION_UNAVAILABLE" && missing1.messages.length === 0
      && missing2.ok === false && missing2.code === "NO_ACCESS_TOKEN" && missing2.messages.length === 0
      && mock.calls.length === callsBefore, // a failed connection never fetches
      `m1ok=${missing1.ok} m1code=${missing1.code} m2ok=${missing2.ok} m2code=${missing2.code} fetchesAfterFail=${mock.calls.length - callsBefore}`);

    // --- 9-12. documented `has_new_messages` payload parity (managed-connector ingest core) ---
    const documentedRunsFor = () => svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: WF_KEY_DOCUMENTED }, "-created_date", 20);
    // The dispatched gmail payload carries the engine trigger envelope: conditions reference
    // `.trigger.data.…`, and the enriched fields live in payload.trigger.data.
    const ingest = (delivery_id, data) => ingestConnectorDelivery(svc, { project, connector: "gmail", event: "mailbox", delivery_id, payload: { trigger: { data } } });

    // 9. a new-message delivery derives the documented field; internal fields preserved verbatim.
    // (Both workflows match: the internal condition AND the documented condition.)
    const newMail = await ingest("gmail-e1", { has_new_non_draft_messages: true, new_message_ids: ["m9"] });
    const newRun = (await documentedRunsFor())[0];
    const runData = newRun?.context?.trigger?.trigger?.data;
    h.check("9 has_new_messages=true derived for new-message delivery (internal fields preserved)",
      newMail.ok === true && newMail.matched === 2
      && runData?.has_new_messages === true
      && runData?.has_new_non_draft_messages === true
      && Array.isArray(runData?.new_message_ids) && runData.new_message_ids[0] === "m9",
      `matched=${newMail.matched} hasNew=${runData?.has_new_messages} nonDraft=${runData?.has_new_non_draft_messages} ids=${JSON.stringify(runData?.new_message_ids)}`);

    // 10. a no-new-message mailbox change derives has_new_messages=false; nothing dispatches.
    const noMail = await ingest("gmail-e2", { has_new_non_draft_messages: false, new_message_ids: [] });
    h.check("10 has_new_messages=false for a no-new-message mailbox change (no documented-condition run)",
      noMail.ok === true && noMail.matched === 0 && (await documentedRunsFor()).length === 1,
      `matched=${noMail.matched} documentedRuns=${(await documentedRunsFor()).length}`);

    // 11. a platform-supplied has_new_messages is preserved verbatim, never re-derived
    // (supplied true over non-draft=false would have derived false — the run shows true).
    const supplied = await ingest("gmail-e3", { has_new_messages: true, has_new_non_draft_messages: false, new_message_ids: [] });
    const suppliedRuns = (await documentedRunsFor()).filter((r) => Array.isArray(r.context?.trigger?.trigger?.data?.new_message_ids) && r.context.trigger.trigger.data.new_message_ids.length === 0);
    h.check("11 a platform-supplied has_new_messages is preserved verbatim (not re-derived)",
      supplied.ok === true && supplied.matched === 1 && suppliedRuns.length === 1
      && suppliedRuns[0].context.trigger.trigger.data.has_new_messages === true && suppliedRuns[0].context.trigger.trigger.data.has_new_non_draft_messages === false,
      `matched=${supplied.matched} runs=${suppliedRuns.length} hasNew=${suppliedRuns[0]?.context?.trigger?.trigger?.data?.has_new_messages}`);

    // 12. the existing internal condition matching is UNCHANGED through the changed ingest path.
    const runsBefore12 = (await runsFor()).length;
    const still = await ingest("gmail-e4", { has_new_non_draft_messages: true, new_message_ids: ["m11"] });
    h.check("12 the existing internal condition matching is unchanged through the ingest core",
      still.matched === 2 && (await runsFor()).length === runsBefore12 + 1 && (await documentedRunsFor()).length === 3,
      `matched=${still.matched} runsDelta=${(await runsFor()).length - runsBefore12} documentedRuns=${(await documentedRunsFor()).length}`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    await purgeBy(svc, "WorkflowRun", { project_id: project?.id });
    await purgeBy(svc, "WorkflowDefinition", { project_id: project?.id });
    // Non-inline connector runs enqueue durable workflow.advance jobs; delete them with the runs.
    await purgeBy(svc, "BackgroundJob", { project_id: project?.id });
    // Replay CacheEntry rows for the scratch project (shared github_webhook_replay namespace).
    const replayRows = await svc.entities.CacheEntry.filter({ namespace: "github_webhook_replay" }, "-created_date", 300).catch(() => []);
    for (const row of replayRows) {
      if (scratch.projects.some((pid) => String(row.cache_key || "").includes(pid))) {
        await svc.entities.CacheEntry.delete(row.id).catch(() => {});
      }
    }
    for (const pid of scratch.projects) await svc.entities.Project.delete(pid).catch(() => {});
    if (scratch.workspace) await cleanupWorkspace(svc, scratch.workspace, []);
  }
  return Response.json(h.summary());
}