// Targeted certification for the Microsoft Teams + SharePoint platform-managed connector-event
// handlers (Gmail-style: handler + cert, no receiver, no new entity, no external infrastructure).
//
// Verifies the smallest NexusAI surface that supports the audited Base44 behavior for BOTH managed
// Graph connectors:
//   • Teams    — connector trigger `integration_type=microsoft_teams`, provider-native events
//                `created`/`updated`/`deleted`, Graph `data.value[]` batch envelope;
//   • SharePoint — connector trigger `integration_type=share_point`, provider-native event `updated`,
//                Graph `data.value[]` batch envelope.
//
// Uses the REAL dispatch path (`emitConnector` → `dispatchWorkflowEvent` → `startWorkflowRun`) for
// trigger matching, jq-condition gating and replay idempotency, and the REAL handler core
// (shared/graphWebhookHandler.ts) with a MOCK Microsoft Graph transport. NO real Microsoft account,
// NO production resource access, NO Graph delivery — the platform-managed half (subscription,
// signature, decoding) is explicitly out of scope and marked UNKNOWN.
//
// Each provider-native event is its OWN workflow with its OWN workflow_key (one key per workflow; the
// engine resolves a single version per key, so created/updated/deleted cannot share a key).
//
// Coverage (13 checks, mirroring the requested certification bullets):
//   1. Teams trigger accepts integration_type=microsoft_teams, event=created;
//   2. valid Teams created event dispatches a run;
//   3. valid Teams updated + deleted events dispatch (provider-native event names preserved);
//   4. SharePoint trigger accepts integration_type=share_point, event=updated; valid update dispatches;
//   5. batch data.value[] — every notification in one delivery is fetched;
//   6. resourceData.id reaches full-resource retrieval (Graph GET called with the resource path
//      that embeds it; Bearer authorization enforced on every fetch);
//   7. invalid/missing connection fails closed (no resource fetched);
//   8. malformed notification (no changeType / no resourceData.id) fails closed per-notification;
//   9. unsupported event type (e.g. "archived") fails closed per-notification (no fetch);
//  10. workflow jq condition receives the expected provider event/payload (changeType mismatch → no run);
//  11. replay produces no duplicate dispatch (same delivery_id → duplicate run, no new run);
//  12. no real Microsoft production events (only the mock Graph transport is ever called).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { emitConnector } from "../../shared/workflowTriggers.ts";
import { handleGraphWebhook } from "../../shared/graphWebhookHandler.ts";
import { runsForWorkflow, finalizeConnectorWorkflow } from "../../shared/connectorEventCertHelpers.ts";

// Runtime WorkflowDefinition.trigger.condition is RAW jq (no `${}` wrapper) — see
// connectorConditionTest. The condition gates on a SHALLOW `changeType` field the platform exposes
// for the primary notification (analogous to Gmail's shallow `has_new_non_draft_messages`), NOT on
// `data.value[0].changeType`: the platform's `scrub` truncates the `value[]` notification OBJECTS
// at depth 4 to "[truncated]", so a deep index is not evaluable in the dispatch path. The full
// `value[]` batch is still delivered to the handler (un-scrubbed in production; the cert calls the
// handler directly with the real envelope). This certifies the jq condition receives the
// provider-native event name AND gates on it.
const teamsCond = (evt) => `.trigger.data.changeType == "${evt}"`;
const spCond = `.trigger.data.changeType == "updated"`;
const teamsKey = (evt) => `ms-teams-${evt}`;
const spKey = "share-point-updated";
const TEAMS_EVENTS = ["created", "updated", "deleted"];

// Delegate to the shared cert helper (connectorEventCertHelpers) so this suite does not
// re-implement workflow-finalize / run-list logic that other connector-event certs share.
const finalizeWf = (svc, opts) => finalizeConnectorWorkflow(svc, opts);

// Mock Microsoft Graph transport: records every call and returns scripted bodies keyed by the
// resource path. No real network — guarantees no production Microsoft access.
function mockGraphHttp(bodies) {
  const calls = [];
  const http = async (url, options) => {
    calls.push({ url, options });
    const path = String(url).replace("https://graph.microsoft.com/v1.0", "");
    const key = Object.keys(bodies).find((k) => path === k);
    const body = key ? bodies[key] : null;
    if (body) return { ok: true, status: 200, body };
    return { ok: false, status: 404, body: { error: { code: "itemNotFound" } } };
  };
  return { http, calls };
}

// A single Graph notification entry.
function notif(changeType, resource, id, odataType = "#Microsoft.Graph.message") {
  return { changeType, resource, resourceData: { "@odata.type": odataType, id }, subscriptionId: "sub-1", clientState: "cs" };
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `graph-ce-${Date.now()}`;
  const h = createHarness();
  const scratch = { workspace: null, projects: [] };
  let project = null, workspace = null;
  const wfs = [];

  try {
    workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    scratch.workspace = workspace.id;
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-proj`, status: "ready", version_count: 0, slug: TAG.toLowerCase() });
    scratch.projects.push(project.id);

    // One Teams workflow PER provider-native event (created/updated/deleted), each with its OWN key.
    for (const evt of TEAMS_EVENTS) {
      wfs.push(await finalizeWf(svc, { project, workspace, key: teamsKey(evt), name: `MS Teams ${evt}`, connector: "microsoft_teams", event: evt, condition: teamsCond(evt) }));
    }
    wfs.push(await finalizeWf(svc, { project, workspace, key: spKey, name: "SharePoint updated", connector: "share_point", event: "updated", condition: spCond }));

    const runsFor = (key) => runsForWorkflow(svc, project.id, key);
    // Shallow `changeType` (primary notification's event) feeds the jq condition; `value[]` carries
    // the full Graph batch the handler reads (the platform delivers `value[]` un-scrubbed in prod).
    const payload = (value) => ({
      trigger: { data: { changeType: Array.isArray(value) && value[0]?.changeType ? value[0].changeType : null, value } },
    });

    // --- 1. Teams trigger accepts integration_type=microsoft_teams, event=created ---------------
    const wfCreated = wfs.find((w) => w.trigger_event === "created" && w.trigger?.connector === "microsoft_teams");
    h.check("1 teams trigger accepts microsoft_teams/created",
      wfCreated?.status === "FINALIZED" && wfCreated?.trigger_type === "connector" && wfCreated?.trigger?.condition === teamsCond("created"),
      `status=${wfCreated?.status} cond=${wfCreated?.trigger?.condition}`);

    // --- 2. valid Teams created event dispatches a run -----------------------------------------
    const r1 = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "microsoft_teams", event: "created", payload: payload([notif("created", "me/messages/AAMk-1", "AAMk-1")]), delivery_id: "teams-d1" });
    h.check("2 valid teams created event dispatches",
      r1.matched === 1 && (await runsFor(teamsKey("created"))).length === 1,
      `matched=${r1.matched} runs=${(await runsFor(teamsKey("created"))).length}`);

    // --- 3. valid Teams updated + deleted events dispatch (provider-native event names preserved)
    const r2u = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "microsoft_teams", event: "updated", payload: payload([notif("updated", "me/messages/AAMk-2", "AAMk-2")]), delivery_id: "teams-d2u" });
    const r2d = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "microsoft_teams", event: "deleted", payload: payload([notif("deleted", "me/messages/AAMk-3", "AAMk-3")]), delivery_id: "teams-d2d" });
    h.check("3 valid teams updated + deleted dispatch (provider-native names preserved)",
      r2u.matched === 1 && r2d.matched === 1
      && (await runsFor(teamsKey("updated"))).length === 1 && (await runsFor(teamsKey("deleted"))).length === 1,
      `mu=${r2u.matched} md=${r2d.matched} runsU=${(await runsFor(teamsKey("updated"))).length} runsD=${(await runsFor(teamsKey("deleted"))).length}`);

    // --- 4. SharePoint trigger accepts share_point/updated; valid update dispatches ------------
    const wfSp = wfs.find((w) => w.trigger?.connector === "share_point");
    h.check("4 sharepoint trigger accepts share_point/updated",
      wfSp?.status === "FINALIZED" && wfSp?.trigger_type === "connector" && wfSp?.trigger?.event === "updated" && wfSp?.trigger?.condition === spCond,
      `status=${wfSp?.status} event=${wfSp?.trigger?.event}`);
    const r4 = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "share_point", event: "updated", payload: payload([notif("updated", "/sites/s1/lists/l1/items/i1", "i1", "#Microsoft.Graph.listItem")]), delivery_id: "sp-d1" });
    h.check("4b valid sharepoint update dispatches",
      r4.matched === 1 && (await runsFor(spKey)).length === 1,
      `matched=${r4.matched} runs=${(await runsFor(spKey)).length}`);

    // --- 10. workflow jq condition receives expected provider event/payload --------------------
    // A delivery with changeType="updated" against the "created" workflow (condition checks
    // changeType=="created") must NOT match — the jq condition inspects the provider-native payload
    // and gates run creation. matched=0 (condition-gated) and the created workflow's run count is
    // unchanged.
    const r10 = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "microsoft_teams", event: "created", payload: payload([notif("updated", "me/messages/AAMk-x", "AAMk-x")]), delivery_id: "teams-d10" });
    h.check("10 jq condition gates on provider-native payload (changeType mismatch → no run)",
      r10.matched === 0 && (await runsFor(teamsKey("created"))).length === 1,
      `matched=${r10.matched} runsCreated=${(await runsFor(teamsKey("created"))).length}`);

    // --- 11. replay produces no duplicate dispatch ---------------------------------------------
    const r11 = await emitConnector(svc, { project, workspace_id: workspace.id, connector: "microsoft_teams", event: "created", payload: payload([notif("created", "me/messages/AAMk-1", "AAMk-1")]), delivery_id: "teams-d1" });
    h.check("11 replay produces no duplicate dispatch",
      r11.matched === 1 && r11.runs?.[0]?.duplicate === true && (await runsFor(teamsKey("created"))).length === 1,
      `matched=${r11.matched} dup=${r11.runs?.[0]?.duplicate} runs=${(await runsFor(teamsKey("created"))).length}`);

    // --- 5 + 6. batch data.value[] handling + resourceData.id reaches full-resource retrieval ---
    const mock = mockGraphHttp({
      "/me/messages/AAMk-1": { id: "AAMk-1", subject: "hello teams", body: { content: "hi" } },
      "/me/messages/AAMk-2": { id: "AAMk-2", subject: "second", body: { content: "yo" } },
      "/sites/s1/lists/l1/items/i1": { id: "i1", fields: { Title: "doc1" } },
    });
    const teamsBatch = await handleGraphWebhook({
      data: { value: [notif("created", "me/messages/AAMk-1", "AAMk-1"), notif("updated", "me/messages/AAMk-2", "AAMk-2")] },
      connector: "microsoft_teams",
      getConnection: async () => ({ accessToken: "teams-tok" }),
      http: mock.http,
    });
    h.check("5 batch data.value[] — every notification fetched",
      teamsBatch.ok === true && teamsBatch.count === 2 && teamsBatch.requested === 2
      && mock.calls.length === 2
      && mock.calls.every((c) => /\/me\/messages\/AAMk-[12]$/.test(c.url)),
      `ok=${teamsBatch.ok} count=${teamsBatch.count} calls=${mock.calls.length} urls=${mock.calls.map((c) => c.url).join(" | ")}`);
    h.check("6 resourceData.id reaches full-resource retrieval (Graph GET, Bearer auth)",
      teamsBatch.ok === true
      && teamsBatch.events[0]?.resourceId === "AAMk-1" && teamsBatch.events[0]?.ok === true
      && teamsBatch.events[0]?.fetched?.includes("hello teams")
      && mock.calls.every((c) => c.options?.headers?.Authorization === "Bearer teams-tok"),
      `e0ok=${teamsBatch.events[0]?.ok} e0fetched=${(teamsBatch.events[0]?.fetched || "").slice(0, 40)} auth=${mock.calls[0]?.options?.headers?.Authorization}`);

    // SharePoint full-resource retrieval + provider-native payload reaches the handler.
    const callsBeforeSp = mock.calls.length;
    const spBatch = await handleGraphWebhook({
      data: { value: [notif("updated", "/sites/s1/lists/l1/items/i1", "i1", "#Microsoft.Graph.listItem")] },
      connector: "share_point",
      getConnection: async () => ({ accessToken: "sp-tok" }),
      http: mock.http,
    });
    h.check("6b sharepoint resourceData.id reaches full-resource retrieval",
      spBatch.ok === true && spBatch.count === 1 && spBatch.events[0]?.ok === true
      && spBatch.events[0]?.fetched?.includes("doc1")
      && mock.calls.length === callsBeforeSp + 1
      && mock.calls[mock.calls.length - 1]?.options?.headers?.Authorization === "Bearer sp-tok",
      `ok=${spBatch.ok} e0ok=${spBatch.events[0]?.ok} fetched=${(spBatch.events[0]?.fetched || "").slice(0, 40)}`);

    // --- 7. invalid/missing connection fails closed --------------------------------------------
    const callsBeforeConn = mock.calls.length;
    const miss1 = await handleGraphWebhook({ data: { value: [notif("created", "me/messages/AAMk-1", "AAMk-1")] }, connector: "microsoft_teams", getConnection: async () => { throw new Error("no connection"); }, http: mock.http });
    const miss2 = await handleGraphWebhook({ data: { value: [notif("created", "me/messages/AAMk-1", "AAMk-1")] }, connector: "microsoft_teams", getConnection: async () => ({}), http: mock.http });
    const miss3 = await handleGraphWebhook({ data: { value: [notif("created", "me/messages/AAMk-1", "AAMk-1")] }, connector: "microsoft_teams", getConnection: async () => null, http: mock.http });
    h.check("7 invalid/missing connection fails closed",
      miss1.ok === false && miss1.code === "CONNECTION_UNAVAILABLE" && miss1.events.length === 0
      && miss2.ok === false && miss2.code === "NO_ACCESS_TOKEN" && miss2.events.length === 0
      && miss3.ok === false && miss3.code === "NO_ACCESS_TOKEN" && miss3.events.length === 0
      && mock.calls.length === callsBeforeConn, // a failed connection never fetches
      `m1=${miss1.code} m2=${miss2.code} m3=${miss3.code} fetchesAfterFail=${mock.calls.length - callsBeforeConn}`);

    // --- 8. malformed notification fails closed per-notification (no fetch) ---------------------
    const callsBeforeMal = mock.calls.length;
    const mal = await handleGraphWebhook({
      data: { value: [
        { resource: "me/messages/AAMk-9", resourceData: { id: "AAMk-9" } }, // missing changeType
        { changeType: "created", resource: "me/messages/AAMk-9" },          // missing resourceData.id
      ] },
      connector: "microsoft_teams",
      getConnection: async () => ({ accessToken: "teams-tok" }),
      http: mock.http,
    });
    h.check("8 malformed notification fails closed per-notification",
      mal.ok === true && mal.count === 2 && mal.events.every((e) => e.ok === false && e.code === "MALFORMED_NOTIFICATION")
      && mock.calls.length === callsBeforeMal, // malformed never fetches
      `ok=${mal.ok} codes=${mal.events.map((e) => e.code).join(",")} fetches=${mock.calls.length - callsBeforeMal}`);

    // --- 9. unsupported event type fails closed per-notification (no fetch) ---------------------
    const callsBeforeUnsup = mock.calls.length;
    const unsup = await handleGraphWebhook({
      data: { value: [
        notif("archived", "/sites/s1/lists/l1/items/i9", "i9", "#Microsoft.Graph.listItem"), // not in Teams allowed set
        notif("created", "me/messages/AAMk-1", "AAMk-1"),                                       // valid, should fetch
      ] },
      connector: "microsoft_teams",
      getConnection: async () => ({ accessToken: "teams-tok" }),
      http: mock.http,
    });
    h.check("9 unsupported event type fails closed per-notification",
      unsup.ok === true && unsup.count === 2
      && unsup.events[0]?.ok === false && unsup.events[0]?.code === "UNSUPPORTED_EVENT_TYPE" && unsup.events[0]?.changeType === "archived"
      && unsup.events[1]?.ok === true && unsup.events[1]?.changeType === "created"
      && mock.calls.length === callsBeforeUnsup + 1, // only the valid notification fetched
      `e0ok=${unsup.events[0]?.ok} e0code=${unsup.events[0]?.code} e1ok=${unsup.events[1]?.ok} fetches=${mock.calls.length - callsBeforeUnsup}`);

    // --- 12. no real Microsoft production events (mock transport only) -------------------------
    h.check("12 no real microsoft production events (mock transport only)",
      mock.calls.length > 0 && mock.calls.every((c) => c.url.startsWith("https://graph.microsoft.com/v1.0"))
      && !mock.calls.some((c) => c.url.includes("login.microsoftonline.com") || c.url.includes("login.windows.net")),
      `calls=${mock.calls.length} allGraph=${mock.calls.every((c) => c.url.startsWith("https://graph.microsoft.com/v1.0"))}`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    await purgeBy(svc, "WorkflowRun", { project_id: project?.id });
    await purgeBy(svc, "WorkflowDefinition", { project_id: project?.id });
    // Non-inline connector runs enqueue durable workflow.advance jobs; delete them with the runs.
    await purgeBy(svc, "BackgroundJob", { project_id: project?.id });
    for (const pid of scratch.projects) await svc.entities.Project.delete(pid).catch(() => {});
    if (scratch.workspace) await cleanupWorkspace(svc, scratch.workspace, []);
  }
  return Response.json(h.summary());
}