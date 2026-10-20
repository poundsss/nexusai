// Targeted certification for the Microsoft Graph connector-EVENT receiver + subscription
// lifecycle (Phase 1, BASIC notifications only).
//
// Exercises the REAL receiver (shared/msGraphConnectorEvent.ts) and the REAL subscription
// management (shared/msGraphSubscriptions.ts) with scripted, locally-signed payloads only. No
// real Microsoft Graph delivery, no provider subscription, no external state. A scripted `http`
// stands in for Graph REST so no production Microsoft notification is ever sent or received.
//
// Mirrors the certified githubConnectorEventCert / slackConnectorEventCert harness shape.
//
// Coverage:
//   1.  validation handshake returns the exact raw token as text/plain (URL-decoded);
//   2.  a valid basic notification dispatches exactly once;
//   3.  changeType, resource, subscription id, and connector reach emitConnector correctly;
//   4.  invalid clientState is rejected with no dispatch;
//   5.  unknown subscription is rejected;
//   6.  inactive/expired subscription is rejected;
//   7.  replay produces no duplicate workflow run;
//   8.  lifecycle notification does not dispatch a workflow;
//   9.  create persists the subscription;
//   10. renew updates expiration;
//   11. delete marks/removes the subscription;
//   12. revoked/invalid delegated credential fails closed;
//   13. renewal does not create duplicate subscriptions.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { handleMsGraphConnectorEvent, resolveGraphSubscription } from "../../shared/msGraphConnectorEvent.ts";
import {
  createGraphSubscription, renewGraphSubscription, deleteGraphSubscription,
  renewExpiringSubscriptions, resolveGraphAccessToken, MS_GRAPH_CLIENT_STATE_SECRET,
} from "../../shared/msGraphSubscriptions.ts";
import { WORKFLOW_CONTRACT_VERSION, validateWorkflow, workflowChecksum } from "../../shared/workflowContract.ts";
import { encryptSecretValue, encryptWithAad } from "../../shared/secretCrypto.ts";

const CONNECTOR = "outlook";
const EVENT = "created";
const RESOURCE = "/me/messages/AAMkAGcert001";
const CLIENT_STATE = "cert-client-state-secret";

// Scripted Graph REST transport — stands in for graph.microsoft.com so the cert never touches
// production Microsoft. POST → new subscription; PATCH → renewed expiration; DELETE → 204.
function scriptedGraphHttp(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "POST" && url.endsWith("/subscriptions")) {
    return { ok: true, status: 201, body: { id: "sub-cert-1", expirationDateTime: new Date(Date.now() + 3 * 86400000).toISOString() } };
  }
  if (method === "PATCH" && url.includes("/subscriptions/")) {
    const id = decodeURIComponent(url.split("/subscriptions/")[1].split("?")[0]);
    return { ok: true, status: 200, body: { id, expirationDateTime: new Date(Date.now() + 6 * 86400000).toISOString() } };
  }
  if (method === "DELETE" && url.includes("/subscriptions/")) {
    return { ok: true, status: 204, body: null };
  }
  return { ok: false, status: 404, body: { error: { message: `not scripted: ${method} ${url}` } } };
}

function finalizeConnectorWorkflow(svc, { project, workspace, key, name, event }) {
  const def = {
    name,
    trigger: { type: "connector", connector: CONNECTOR, event },
    steps: [{ id: "s1", type: "complete", message: "ok" }],
    entry_step: "s1",
  };
  const v = validateWorkflow(def, { functionNames: [] });
  if (!v.ok) throw new Error(`fixture invalid: ${v.errors.join("; ")}`);
  return svc.entities.WorkflowDefinition.create({
    workflow_key: key, name, version: 1, status: "FINALIZED", finalized: true,
    project_id: project.id, workspace_id: workspace.id,
    trigger: def.trigger, trigger_type: "connector", trigger_event: event,
    steps: def.steps, entry_step: "s1", definition_checksum: workflowChecksum(def),
    contract_version: WORKFLOW_CONTRACT_VERSION, created_at: new Date().toISOString(),
  });
}

function storeClientState(svc, projectId, value) {
  return (async () => {
    const sealed = await encryptSecretValue(projectId, MS_GRAPH_CLIENT_STATE_SECRET, value);
    const existing = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: MS_GRAPH_CLIENT_STATE_SECRET }, "name", 1))[0] || null;
    if (existing) return svc.entities.ProjectSecret.update(existing.id, { value: sealed });
    return svc.entities.ProjectSecret.create({ project_id: projectId, name: MS_GRAPH_CLIENT_STATE_SECRET, value: sealed, required: true });
  })();
}

function notification({ subscriptionId, changeType, resource, clientState, lifecycleEvent = null, tenantId = "tid-cert" }) {
  const entry = lifecycleEvent
    ? { subscriptionId, tenantId, changeType: "lifecycleNotification", lifecycleEvent, clientState, subscriptionExpirationDateTime: new Date(Date.now() + 3600000).toISOString() }
    : { subscriptionId, tenantId, changeType, resource, clientState, resourceData: { id: resource.split("/").pop() }, subscriptionExpirationDateTime: new Date(Date.now() + 86400000).toISOString() };
  return { value: [entry] };
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `msgraph-${Date.now()}`;
  const h = createHarness();
  const scratch = { workspace: null, projects: [], credentials: [], users: [], runs: [] };
  let project = null, workspace = null, def = null;
  let credId1 = null, credId2 = null;
  const wfKey = "msgraph-msg";
  const aadFor = (pid, cid) => `delegated-credential:${pid}:${cid}`;

  try {
    // --- scratch workspace, project, app user, two delegated credentials, clientState, workflow ---
    workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    scratch.workspace = workspace.id;
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-proj`, status: "ready", version_count: 0, slug: TAG.toLowerCase() });
    scratch.projects.push(project.id);

    const appUser = await svc.entities.AppUser.create({ project_id: project.id, workspace_id: workspace.id, email: `${TAG}@cert.test`, status: "active", display_name: "Graph Cert" });
    scratch.users.push(appUser.id);

    credId1 = `dc_msgraph_${Date.now().toString(36)}`;
    credId2 = `dc_msgraph_revoked_${Date.now().toString(36)}`;
    const encToken1 = await encryptWithAad(aadFor(project.id, credId1), "fake-graph-token-1");
    const cred1 = await svc.entities.DelegatedCredential.create({
      credential_id: credId1, project_id: project.id, workspace_id: workspace.id, app_user_id: appUser.id,
      provider_id: "microsoft_graph", external_subject: "msa-cert-1", status: "active",
      encrypted_access_token: encToken1, expires_at: new Date(Date.now() + 3600000).toISOString(),
      token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token", pkce: false, created_at: new Date().toISOString(),
    });
    scratch.credentials.push(cred1.id);
    const cred2 = await svc.entities.DelegatedCredential.create({
      credential_id: credId2, project_id: project.id, workspace_id: workspace.id, app_user_id: appUser.id,
      provider_id: "microsoft_graph", external_subject: "msa-cert-2", status: "revoked",
      encrypted_access_token: await encryptWithAad(aadFor(project.id, credId2), "fake-graph-token-2"),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token", pkce: false, created_at: new Date().toISOString(),
    });
    scratch.credentials.push(cred2.id);

    await storeClientState(svc, project.id, CLIENT_STATE);
    def = await finalizeConnectorWorkflow(svc, { project, workspace, key: wfKey, name: "Outlook Messages", event: EVENT });

    const runsFor = () => svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: wfKey }, "-created_date", 20);
    const subRows = () => svc.entities.GraphSubscription.filter({ project_id: project.id }, "-created_date", 20);
    const notifUrl = `https://cert.test/functions/msGraphConnectorEvent?project_id=${project.id}`;

    // --- 9. create persists the subscription -------------------------------------------
    const created = await createGraphSubscription(svc, {
      project, connector: CONNECTOR, resource: "/me/messages", changeTypes: ["created", "updated", "deleted"],
      delegatedCredentialId: credId1, expirationDateTime: new Date(Date.now() + 3 * 86400000).toISOString(),
      notificationUrl: notifUrl, lifecycleNotificationUrl: notifUrl, http: scriptedGraphHttp,
    });
    const afterCreate = await subRows();
    h.check("9 create persists the subscription",
      created.subscription_id === "sub-cert-1" && afterCreate.some((r) => r.subscription_id === "sub-cert-1" && r.connector === CONNECTOR && r.resource === "/me/messages" && r.status === "active"),
      `sub_id=${created.subscription_id} rows=${afterCreate.length}`);

    // --- 1. validation handshake returns exact raw token as text/plain (URL-decoded) ----
    const encodedToken = "abc%20def%2Fg%3Dh";
    let r = await handleMsGraphConnectorEvent(svc, { projectId: project.id, rawBody: decodeURIComponent(encodedToken), headers: { "content-type": "text/plain" }, validationToken: encodedToken, now: Date.now() });
    h.check("1 validation handshake returns exact raw token as text/plain",
      r.status === 200 && r.contentType === "text/plain" && r.body === decodeURIComponent(encodedToken),
      `status=${r.status} ct=${r.contentType} body=${r.body}`);

    // --- 2 & 3. valid basic notification dispatches exactly once; metadata reaches emitConnector
    const runsBefore2 = (await runsFor()).length;
    const payload2 = notification({ subscriptionId: "sub-cert-1", changeType: EVENT, resource: RESOURCE, clientState: CLIENT_STATE });
    r = await handleMsGraphConnectorEvent(svc, { projectId: project.id, rawBody: JSON.stringify(payload2), headers: { "content-type": "application/json" }, now: Date.now() });
    const runsAfter2 = await runsFor();
    const run1 = runsAfter2[0];
    h.check("2 a valid basic notification dispatches exactly once",
      r.status === 202 && r.body.ok === true && r.body.results[0]?.matched === 1 && runsAfter2.length === runsBefore2 + 1,
      `status=${r.status} matched=${r.body.results?.[0]?.matched} runsDelta=${runsAfter2.length - runsBefore2}`);
    h.check("3 changeType, resource, subscription id, and connector reach emitConnector correctly",
      run1?.workflow_id === def.id && run1?.trigger?.source === "connector" && run1?.trigger?.event === EVENT
      && run1?.context?.trigger?.subscriptionId === "sub-cert-1"
      && run1?.context?.trigger?.changeType === EVENT
      && run1?.context?.trigger?.resource === RESOURCE
      && run1?.context?.trigger?.tenantId === "tid-cert",
      `wf=${run1?.workflow_id} src=${run1?.trigger?.source} ev=${run1?.trigger?.event} sub=${run1?.context?.trigger?.subscriptionId} res=${run1?.context?.trigger?.resource}`);

    // --- 4. invalid clientState is rejected with no dispatch ----------------------------
    const runsBefore4 = (await runsFor()).length;
    const payload4 = notification({ subscriptionId: "sub-cert-1", changeType: EVENT, resource: RESOURCE, clientState: "WRONG-STATE" });
    r = await handleMsGraphConnectorEvent(svc, { projectId: project.id, rawBody: JSON.stringify(payload4), headers: { "content-type": "application/json" }, now: Date.now() });
    h.check("4 invalid clientState is rejected with no dispatch",
      r.status === 202 && r.body.results[0]?.rejected === "clientState" && (await runsFor()).length === runsBefore4,
      `status=${r.status} rejected=${r.body.results?.[0]?.rejected} runsDelta=${(await runsFor()).length - runsBefore4}`);

    // --- 5. unknown subscription is rejected -------------------------------------------
    const runsBefore5 = (await runsFor()).length;
    const payload5 = notification({ subscriptionId: "sub-does-not-exist", changeType: EVENT, resource: RESOURCE, clientState: CLIENT_STATE });
    r = await handleMsGraphConnectorEvent(svc, { projectId: project.id, rawBody: JSON.stringify(payload5), headers: { "content-type": "application/json" }, now: Date.now() });
    h.check("5 unknown subscription is rejected",
      r.status === 202 && r.body.results[0]?.rejected === "unknown_or_inactive" && (await runsFor()).length === runsBefore5,
      `status=${r.status} rejected=${r.body.results?.[0]?.rejected} runsDelta=${(await runsFor()).length - runsBefore5}`);

    // --- 7. replay produces no duplicate workflow run -----------------------------------
    const runsBefore7 = (await runsFor()).length;
    r = await handleMsGraphConnectorEvent(svc, { projectId: project.id, rawBody: JSON.stringify(payload2), headers: { "content-type": "application/json" }, now: Date.now() });
    const runsAfter7 = await runsFor();
    h.check("7 replay produces no duplicate workflow run",
      r.status === 202 && r.body.results[0]?.duplicate === true && runsAfter7.length === runsBefore7,
      `status=${r.status} dup=${r.body.results?.[0]?.duplicate} runsDelta=${runsAfter7.length - runsBefore7}`);

    // --- 6. inactive/expired subscription is rejected -----------------------------------
    const subRow = (await subRows()).find((x) => x.subscription_id === "sub-cert-1");
    await svc.entities.GraphSubscription.update(subRow.id, { status: "expired", updated_at: new Date().toISOString() });
    const runsBefore6 = (await runsFor()).length;
    r = await handleMsGraphConnectorEvent(svc, { projectId: project.id, rawBody: JSON.stringify(payload2), headers: { "content-type": "application/json" }, now: Date.now() });
    h.check("6 inactive/expired subscription is rejected",
      r.status === 202 && r.body.results[0]?.rejected === "unknown_or_inactive" && (await runsFor()).length === runsBefore6,
      `status=${r.status} rejected=${r.body.results?.[0]?.rejected} runsDelta=${(await runsFor()).length - runsBefore6}`);

    // --- 10. renew updates expiration (revives the expired row, no new row) ------------
    const rowsBefore10 = (await subRows()).length;
    const renewed = await renewGraphSubscription(svc, { subscriptionId: "sub-cert-1", expirationDateTime: new Date(Date.now() + 6 * 86400000).toISOString(), http: scriptedGraphHttp });
    const subAfter10 = (await subRows()).find((x) => x.subscription_id === "sub-cert-1");
    h.check("10 renew updates expiration",
      renewed.expiration_date_time === subAfter10?.expiration_date_time && subAfter10?.status === "active" && !!subAfter10?.last_renewed_at && (await subRows()).length === rowsBefore10,
      `exp=${renewed.expiration_date_time} status=${subAfter10?.status} rows=${(await subRows()).length}`);

    // --- 13. renewal does not create duplicate subscriptions ---------------------------
    // A second subscription expiring soon (created directly), then the sweeper renews it via PATCH.
    const due = await svc.entities.GraphSubscription.create({
      subscription_id: "sub-due", project_id: project.id, workspace_id: workspace.id, connector: CONNECTOR,
      resource: "/me/drive/root", change_types: ["updated"], delegated_credential_id: credId1,
      notification_url: notifUrl, lifecycle_notification_url: notifUrl,
      expiration_date_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      client_state_secret_name: MS_GRAPH_CLIENT_STATE_SECRET, status: "active", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    scratch.runs.push(due.id);
    const rowsBefore13 = (await subRows()).length;
    const sweep = await renewExpiringSubscriptions(svc, { now: Date.now(), renewalLeadMs: 60 * 60 * 1000, http: scriptedGraphHttp });
    const subDueAfter = (await subRows()).find((x) => x.subscription_id === "sub-due");
    h.check("13 renewal does not create duplicate subscriptions",
      sweep.renewed >= 1 && (await subRows()).length === rowsBefore13 && subDueAfter?.status === "active" && Date.parse(subDueAfter.expiration_date_time) > Date.now() + 5 * 86400000,
      `renewed=${sweep.renewed} rows=${(await subRows()).length} rowsDelta=${(await subRows()).length - rowsBefore13} dueExp=${subDueAfter?.expiration_date_time}`);

    // --- 8. lifecycle notification does not dispatch a workflow -------------------------
    const runsBefore8 = (await runsFor()).length;
    const payload8 = notification({ subscriptionId: "sub-cert-1", changeType: "lifecycleNotification", resource: "", clientState: CLIENT_STATE, lifecycleEvent: "reauthorizationRequired" });
    r = await handleMsGraphConnectorEvent(svc, { projectId: project.id, rawBody: JSON.stringify(payload8), headers: { "content-type": "application/json" }, now: Date.now(), http: scriptedGraphHttp });
    h.check("8 lifecycle notification does not dispatch a workflow",
      r.status === 202 && r.body.results[0]?.dispatched === false && (await runsFor()).length === runsBefore8,
      `status=${r.status} dispatched=${r.body.results?.[0]?.dispatched} runsDelta=${(await runsFor()).length - runsBefore8}`);

    // --- 11. delete marks/removes the subscription --------------------------------------
    const del = await deleteGraphSubscription(svc, { subscriptionId: "sub-cert-1", http: scriptedGraphHttp });
    const subAfterDel = (await subRows()).find((x) => x.subscription_id === "sub-cert-1");
    const runsBefore11 = (await runsFor()).length;
    r = await handleMsGraphConnectorEvent(svc, { projectId: project.id, rawBody: JSON.stringify(payload2), headers: { "content-type": "application/json" }, now: Date.now() });
    h.check("11 delete marks/removes the subscription and it no longer dispatches",
      del.deleted === true && subAfterDel?.status === "deleted" && r.body.results[0]?.rejected === "unknown_or_inactive" && (await runsFor()).length === runsBefore11,
      `deleted=${del.deleted} status=${subAfterDel?.status} afterDelRejected=${r.body.results?.[0]?.rejected}`);

    // --- 12. revoked/invalid delegated credential fails closed -------------------------
    let revokedThrew = false, revokedCode = null;
    try { await resolveGraphAccessToken(svc, project, credId2, { http: scriptedGraphHttp }); }
    catch (e) { revokedThrew = true; revokedCode = e.code; }
    let createWithRevokedThrew = false;
    try {
      await createGraphSubscription(svc, {
        project, connector: CONNECTOR, resource: "/me/messages", changeTypes: ["created"],
        delegatedCredentialId: credId2, expirationDateTime: new Date(Date.now() + 86400000).toISOString(),
        notificationUrl: notifUrl, http: scriptedGraphHttp,
      });
    } catch { createWithRevokedThrew = true; }
    const revokedRows = (await subRows()).filter((x) => x.delegated_credential_id === credId2);
    h.check("12 revoked/invalid delegated credential fails closed",
      revokedThrew && revokedCode === "DELEGATED_CREDENTIAL_REVOKED" && createWithRevokedThrew && revokedRows.length === 0,
      `threw=${revokedThrew} code=${revokedCode} createThrew=${createWithRevokedThrew} rows=${revokedRows.length}`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    // dependency order: runs, definitions, subscriptions, credentials, users, then project, workspace.
    for (const entity of ["WorkflowRun", "WorkflowDefinition", "BackgroundJob", "GraphSubscription", "DelegatedCredential", "AppUser"]) {
      const q = scratch.projects.length ? { project_id: { $in: scratch.projects } } : {};
      await purgeBy(svc, entity, q);
    }
    // GraphSubscription replay CacheEntry rows for the scratch project (shared namespace).
    const replayRows = await svc.entities.CacheEntry.filter({ namespace: "github_webhook_replay" }, "-created_date", 300).catch(() => []);
    for (const row of replayRows) {
      if (scratch.projects.some((pid) => String(row.cache_key || "").includes(pid))) {
        await svc.entities.CacheEntry.delete(row.id).catch(() => {});
      }
    }
    for (const pid of scratch.projects) {
      await purgeBy(svc, "ProjectSecret", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    if (scratch.workspace) await cleanupWorkspace(svc, scratch.workspace, []);
  }

  return Response.json(h.summary());
}