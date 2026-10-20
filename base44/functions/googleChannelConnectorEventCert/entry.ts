// Targeted certification for the Google Calendar / Drive connector-EVENT receiver + watch-channel
// lifecycle (Phase 1, Calendar + Drive only; Gmail/Pub/Sub deliberately NOT implemented).
//
// Exercises the REAL receiver (shared/googleChannelConnectorEvent.ts) and the REAL watch-channel
// management (shared/googleWatchSubscriptions.ts) with scripted, locally-built X-Goog-* payloads
// only. No real Google delivery, no provider watch, no external state. A scripted `http` stands
// in for googleapis.com so no production Google notification is ever sent or received.
//
// Google Calendar/Drive push carries an EMPTY body with all metadata in X-Goog-* headers, so this
// cert builds header objects (no JSON body) — mirroring the audited contract.
//
// Mirrors the certified githubConnectorEventCert / slackConnectorEventCert / msGraphConnectorEventCert
// harness shape. Coverage (15 checks, including Calendar/Drive event normalization):
//   1.  Calendar sync → no dispatch;
//   2.  Drive sync → no dispatch;
//   3.  Calendar exists/not_exists normalize to the Base44 "events" workflow event;
//   4.  Drive states normalize to "file" and the DOCUMENTED file-scoped file.update /
//       file.trash / file.untrash / file.delete, the change feed to "changes";
//   5.  Drive X-Goog-Changed preserved;
//   6.  invalid channel token rejected;
//   7.  unknown channel rejected;
//   8.  inactive/expired/deleted channel rejected;
//   9.  replay produces no duplicate run;
//   10. project/channel mismatch rejected;
//   11. create persists;
//   12. renew re-watches and updates the existing row without duplicates;
//   13. stop/delete state behaves per contract;
//   14. revoked delegated credential fails closed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { handleGoogleChannelConnectorEvent } from "../../shared/googleChannelConnectorEvent.ts";
import {
  createGoogleWatch, renewGoogleWatch, stopGoogleWatch, resolveGoogleAccessToken,
  GOOGLE_CHANNEL_TOKEN_SECRET,
} from "../../shared/googleWatchSubscriptions.ts";
import { WORKFLOW_CONTRACT_VERSION, validateWorkflow, workflowChecksum } from "../../shared/workflowContract.ts";
import { encryptSecretValue, encryptWithAad } from "../../shared/secretCrypto.ts";

const CHANNEL_TOKEN = "cert-google-channel-token";
const CAL_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch";
const DRIVE_ENDPOINT = "https://www.googleapis.com/drive/v3/changes/watch";
const CAL_RESOURCE_URI = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const DRIVE_RESOURCE_URI = "https://www.googleapis.com/drive/v3/changes";

// Scripted Google REST transport — stands in for googleapis.com so the cert never touches
// production Google. POST …/watch → new channel; POST …/channels/stop → 204.
function scriptedGoogleHttp(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "POST" && url.endsWith("/watch")) {
    let body = {}; try { body = JSON.parse(options.body || "{}"); } catch { /* keep empty */ }
    const id = String(body.id || `ch-${Math.random().toString(36).slice(2, 10)}`);
    return { ok: true, status: 200, body: { id, resourceId: `goog-res-${id.slice(-6)}`, resourceUri: url.replace(/\/watch$/, ""), expiration: String(Date.now() + 24 * 3600 * 1000) } };
  }
  if (method === "POST" && url.endsWith("/channels/stop")) return { ok: true, status: 204, body: null };
  return { ok: false, status: 404, body: { error: { message: `not scripted: ${method} ${url}` } } };
}

function finalizeWf(svc, { project, workspace, connector, event, key, name }) {
  const def = { name, trigger: { type: "connector", connector, event }, steps: [{ id: "s1", type: "complete", message: "ok" }], entry_step: "s1" };
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

function storeChannelToken(svc, projectId, value) {
  return (async () => {
    const sealed = await encryptSecretValue(projectId, GOOGLE_CHANNEL_TOKEN_SECRET, value);
    const existing = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: GOOGLE_CHANNEL_TOKEN_SECRET }, "name", 1))[0] || null;
    if (existing) return svc.entities.ProjectSecret.update(existing.id, { value: sealed });
    return svc.entities.ProjectSecret.create({ project_id: projectId, name: GOOGLE_CHANNEL_TOKEN_SECRET, value: sealed, required: true });
  })();
}

// Google sends metadata in X-Goog-* headers with an EMPTY body. This builds the lowercased header
// object the receiver expects (the HTTP wrapper lowercases header keys).
function googHeaders({ channelId, resourceId, resourceUri, state, messageNumber, token = CHANNEL_TOKEN, changed = null }) {
  const h = {
    "content-type": "application/json; utf-8",
    "x-goog-channel-id": channelId,
    "x-goog-resource-id": resourceId,
    "x-goog-resource-state": state,
    "x-goog-message-number": String(messageNumber),
    "x-goog-resource-uri": resourceUri,
    "x-goog-channel-token": token,
  };
  if (changed) h["x-goog-changed"] = changed;
  return h;
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `ggl-${Date.now()}`;
  const h = createHarness();
  const scratch = { workspace: null, projects: [], credentials: [], users: [], runs: [], extraChannels: [] };
  let project = null, workspace = null;
  let credId1 = null, credId2 = null;
  let wfCalEvents = null, wfDriveFile = null, wfDriveChanges = null;
  let chA = null, chB = null, chC = null, chD = null, mismatchRow = null;
  const aadFor = (pid, cid) => `delegated-credential:${pid}:${cid}`;
  const notifUrl = `https://cert.test/functions/googleChannelConnectorEvent?project_id=${project ? project.id : ""}`;

  try {
    // --- scratch workspace, project, app user, two delegated credentials, channel token, workflows ---
    workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    scratch.workspace = workspace.id;
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-proj`, status: "ready", version_count: 0, slug: TAG.toLowerCase() });
    scratch.projects.push(project.id);

    const appUser = await svc.entities.AppUser.create({ project_id: project.id, workspace_id: workspace.id, email: `${TAG}@cert.test`, status: "active", display_name: "Google Cert" });
    scratch.users.push(appUser.id);

    credId1 = `dc_google_${Date.now().toString(36)}`;
    credId2 = `dc_google_revoked_${Date.now().toString(36)}`;
    const encToken1 = await encryptWithAad(aadFor(project.id, credId1), "fake-google-token-1");
    const cred1 = await svc.entities.DelegatedCredential.create({
      credential_id: credId1, project_id: project.id, workspace_id: workspace.id, app_user_id: appUser.id,
      provider_id: "google", external_subject: "g-cert-1", status: "active",
      encrypted_access_token: encToken1, expires_at: new Date(Date.now() + 3600000).toISOString(),
      token_endpoint: "https://oauth2.googleapis.com/token", pkce: true, created_at: new Date().toISOString(),
    });
    scratch.credentials.push(cred1.id);
    const cred2 = await svc.entities.DelegatedCredential.create({
      credential_id: credId2, project_id: project.id, workspace_id: workspace.id, app_user_id: appUser.id,
      provider_id: "google", external_subject: "g-cert-2", status: "revoked",
      encrypted_access_token: await encryptWithAad(aadFor(project.id, credId2), "fake-google-token-2"),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      token_endpoint: "https://oauth2.googleapis.com/token", pkce: true, created_at: new Date().toISOString(),
    });
    scratch.credentials.push(cred2.id);

    await storeChannelToken(svc, project.id, CHANNEL_TOKEN);

    wfCalEvents = await finalizeWf(svc, { project, workspace, connector: "googlecalendar", event: "events", key: "gcal-events", name: "Calendar Events" });
    wfDriveFile = await finalizeWf(svc, { project, workspace, connector: "googledrive", event: "file", key: "gdrive-file", name: "Drive File" });
    wfDriveChanges = await finalizeWf(svc, { project, workspace, connector: "googledrive", event: "changes", key: "gdrive-changes", name: "Drive Changes" });
    // The DOCUMENTED (Base44) file-scoped Drive events — one finalized fixture per event, so the
    // normalized dispatch provably reaches a workflow authored for exactly that event.
    await finalizeWf(svc, { project, workspace, connector: "googledrive", event: "file.update", key: "gdrive-file-update", name: "Drive File Updated" });
    await finalizeWf(svc, { project, workspace, connector: "googledrive", event: "file.trash", key: "gdrive-file-trash", name: "Drive File Trashed" });
    await finalizeWf(svc, { project, workspace, connector: "googledrive", event: "file.untrash", key: "gdrive-file-untrash", name: "Drive File Untrashed" });
    await finalizeWf(svc, { project, workspace, connector: "googledrive", event: "file.delete", key: "gdrive-file-delete", name: "Drive File Deleted" });

    const notif = `https://cert.test/functions/googleChannelConnectorEvent?project_id=${project.id}`;
    // Create four channels: A (calendar), B (drive), C (calendar, renew), D (calendar, stop).
    chA = await createGoogleWatch(svc, { project, provider: "googlecalendar", watchEndpoint: CAL_ENDPOINT, delegatedCredentialId: credId1, expirationMs: Date.now() + 7 * 86400000, notificationUrl: notif, http: scriptedGoogleHttp });
    chB = await createGoogleWatch(svc, { project, provider: "googledrive", watchEndpoint: DRIVE_ENDPOINT, delegatedCredentialId: credId1, expirationMs: Date.now() + 23 * 3600 * 1000, notificationUrl: notif, http: scriptedGoogleHttp });
    chC = await createGoogleWatch(svc, { project, provider: "googlecalendar", watchEndpoint: CAL_ENDPOINT, delegatedCredentialId: credId1, expirationMs: Date.now() + 7 * 86400000, notificationUrl: notif, http: scriptedGoogleHttp });
    chD = await createGoogleWatch(svc, { project, provider: "googlecalendar", watchEndpoint: CAL_ENDPOINT, delegatedCredentialId: credId1, expirationMs: Date.now() + 7 * 86400000, notificationUrl: notif, http: scriptedGoogleHttp });

    const chanRows = () => svc.entities.GoogleWatchChannel.filter({ workspace_id: workspace.id }, "-created_date", 50);
    const runsFor = (key) => svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: key }, "-created_date", 20);

    // --- 11. create persists -----------------------------------------------------------
    const afterCreate = await chanRows();
    h.check("11 create persists",
      [chA, chB, chC, chD].every((c) => c.channel_id && c.resource_id) && afterCreate.some((r) => r.channel_id === chA.channel_id && r.provider === "googlecalendar" && r.status === "active"),
      `rows=${afterCreate.length} chA=${chA.channel_id}`);

    // --- 1. Calendar sync → no dispatch ------------------------------------------------
    let r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chA.channel_id, resourceId: chA.resource_id, resourceUri: CAL_RESOURCE_URI, state: "sync", messageNumber: 1 }), now: Date.now() });
    h.check("1 Calendar sync does not dispatch",
      r.status === 200 && r.body.sync === true && (await runsFor("gcal-events")).length === 0,
      `status=${r.status} sync=${r.body.sync} runs=${(await runsFor("gcal-events")).length}`);

    // --- 2. Drive sync → no dispatch ---------------------------------------------------
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chB.channel_id, resourceId: chB.resource_id, resourceUri: DRIVE_RESOURCE_URI, state: "sync", messageNumber: 1 }), now: Date.now() });
    h.check("2 Drive sync does not dispatch",
      r.status === 200 && r.body.sync === true && (await runsFor("gdrive-file")).length === 0,
      `status=${r.status} sync=${r.body.sync} runs=${(await runsFor("gdrive-file")).length}`);

    // --- 3. valid Calendar states dispatch exactly once --------------------------------
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chA.channel_id, resourceId: chA.resource_id, resourceUri: CAL_RESOURCE_URI, state: "exists", messageNumber: 10 }), now: Date.now() });
    const rCalExists = r;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chA.channel_id, resourceId: chA.resource_id, resourceUri: CAL_RESOURCE_URI, state: "not_exists", messageNumber: 11 }), now: Date.now() });
    const calEventsRuns = await runsFor("gcal-events");
    h.check("3 Calendar exists/not_exists normalize to the events workflow event",
      rCalExists.status === 200 && rCalExists.body.matched === 1 && r.status === 200 && r.body.matched === 1
      && rCalExists.body.workflow_event === "events" && r.body.workflow_event === "events"
      && calEventsRuns.length === 2
      && calEventsRuns.every((x) => x.trigger?.source === "connector" && x.trigger?.event === "events")
      && calEventsRuns.map((x) => x.context?.trigger?.resourceState).sort().join(",") === "exists,not_exists",
      `existsMatched=${rCalExists.body.matched} notExistsMatched=${r.body.matched} runs=${calEventsRuns.length} states=${calEventsRuns.map((x) => x.context?.trigger?.resourceState).join(",")}`);

    // --- 4 & 5. Drive states normalize to file + the documented file-scoped events; provider
    // state preserved. Drive "add" stays generic "file" (no documented scoped name); the
    // update/trash/untrash/remove states map to file.update/file.trash/file.untrash/file.delete.
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chB.channel_id, resourceId: chB.resource_id, resourceUri: DRIVE_RESOURCE_URI, state: "add", messageNumber: 20 }), now: Date.now() });
    const rDriveAdd = r;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chB.channel_id, resourceId: chB.resource_id, resourceUri: DRIVE_RESOURCE_URI, state: "update", messageNumber: 21, changed: "content,properties" }), now: Date.now() });
    const rDriveUpdate = r;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chB.channel_id, resourceId: chB.resource_id, resourceUri: DRIVE_RESOURCE_URI, state: "trash", messageNumber: 22 }), now: Date.now() });
    const rDriveTrash = r;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chB.channel_id, resourceId: chB.resource_id, resourceUri: DRIVE_RESOURCE_URI, state: "untrash", messageNumber: 23 }), now: Date.now() });
    const rDriveUntrash = r;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chB.channel_id, resourceId: chB.resource_id, resourceUri: DRIVE_RESOURCE_URI, state: "remove", messageNumber: 24 }), now: Date.now() });
    const rDriveRemove = r;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chB.channel_id, resourceId: chB.resource_id, resourceUri: DRIVE_RESOURCE_URI, state: "change", messageNumber: 25 }), now: Date.now() });
    const rDriveChange = r;
    const driveChangesRuns = await runsFor("gdrive-changes");
    h.check("4 Drive states normalize to file and the documented file-scoped events, the change feed to changes",
      rDriveAdd.status === 200 && rDriveAdd.body.matched === 1 && rDriveAdd.body.workflow_event === "file"
      && rDriveUpdate.status === 200 && rDriveUpdate.body.matched === 1 && rDriveUpdate.body.workflow_event === "file.update"
      && rDriveTrash.status === 200 && rDriveTrash.body.matched === 1 && rDriveTrash.body.workflow_event === "file.trash"
      && rDriveUntrash.status === 200 && rDriveUntrash.body.matched === 1 && rDriveUntrash.body.workflow_event === "file.untrash"
      && rDriveRemove.status === 200 && rDriveRemove.body.matched === 1 && rDriveRemove.body.workflow_event === "file.delete"
      && rDriveChange.status === 200 && rDriveChange.body.matched === 1 && rDriveChange.body.workflow_event === "changes"
      && (await runsFor("gdrive-file")).length === 1
      && (await runsFor("gdrive-file-update")).length === 1
      && (await runsFor("gdrive-file-trash")).length === 1
      && (await runsFor("gdrive-file-untrash")).length === 1
      && (await runsFor("gdrive-file-delete")).length === 1
      && driveChangesRuns.length === 1 && driveChangesRuns[0]?.trigger?.event === "changes",
      `add=${rDriveAdd.body.matched} upd=${rDriveUpdate.body.matched} trash=${rDriveTrash.body.matched} untrash=${rDriveUntrash.body.matched} remove=${rDriveRemove.body.matched} chg=${rDriveChange.body.matched} changesRuns=${driveChangesRuns.length}`);
    const updRun = (await runsFor("gdrive-file-update"))[0];
    h.check("5 provider state + Drive X-Goog-Changed preserved",
      !!updRun && updRun.context.trigger.resourceState === "update" && updRun.context.trigger.changed === "content,properties" && updRun.context.trigger.channelId === chB.channel_id,
      `state=${updRun?.context?.trigger?.resourceState} changed=${updRun?.context?.trigger?.changed} channelId=${updRun?.context?.trigger?.channelId}`);

    // --- 3b. an unmapped provider state passes through verbatim (existing handling) ------
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chA.channel_id, resourceId: chA.resource_id, resourceUri: CAL_RESOURCE_URI, state: "resync", messageNumber: 12 }), now: Date.now() });
    h.check("3b an unmapped Calendar state passes through verbatim",
      r.status === 200 && r.body.matched === 0 && !r.body.workflow_event && r.body.resource_state === "resync"
      && (await runsFor("gcal-events")).length === 2,
      `status=${r.status} matched=${r.body.matched} event=${r.body.workflow_event} runs=${(await runsFor("gcal-events")).length}`);

    // --- 6. invalid channel token rejected --------------------------------------------
    const runsBefore6 = (await runsFor("gcal-events")).length;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chA.channel_id, resourceId: chA.resource_id, resourceUri: CAL_RESOURCE_URI, state: "exists", messageNumber: 30, token: "WRONG-TOKEN" }), now: Date.now() });
    h.check("6 invalid channel token rejected with no dispatch",
      r.status === 200 && r.body.rejected === "channel_token" && (await runsFor("gcal-events")).length === runsBefore6,
      `status=${r.status} rejected=${r.body.rejected} runsDelta=${(await runsFor("gcal-events")).length - runsBefore6}`);

    // --- 7. unknown channel rejected ---------------------------------------------------
    const runsBefore7 = (await runsFor("gcal-events")).length;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: "ch-does-not-exist", resourceId: "goog-res-x", resourceUri: CAL_RESOURCE_URI, state: "exists", messageNumber: 31 }), now: Date.now() });
    h.check("7 unknown channel rejected",
      r.status === 200 && r.body.rejected === "unknown_channel" && (await runsFor("gcal-events")).length === runsBefore7,
      `status=${r.status} rejected=${r.body.rejected} runsDelta=${(await runsFor("gcal-events")).length - runsBefore7}`);

    // --- 10. project/channel mismatch rejected ----------------------------------------
    mismatchRow = await svc.entities.GoogleWatchChannel.create({
      channel_id: "ch-mismatch", resource_id: "goog-res-mismatch", provider: "googlecalendar",
      project_id: `${TAG}-other`, workspace_id: workspace.id, delegated_credential_id: credId1,
      expiration: new Date(Date.now() + 86400000).toISOString(), token_secret_name: GOOGLE_CHANNEL_TOKEN_SECRET,
      watch_resource_uri: CAL_RESOURCE_URI, notification_url: notif, status: "active",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    scratch.extraChannels.push(mismatchRow.id);
    const runsBefore10 = (await runsFor("gcal-events")).length;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: "ch-mismatch", resourceId: "goog-res-mismatch", resourceUri: CAL_RESOURCE_URI, state: "exists", messageNumber: 32 }), now: Date.now() });
    h.check("10 project/channel mismatch rejected",
      r.status === 200 && r.body.rejected === "project_mismatch" && (await runsFor("gcal-events")).length === runsBefore10,
      `status=${r.status} rejected=${r.body.rejected} runsDelta=${(await runsFor("gcal-events")).length - runsBefore10}`);

    // --- 9. replay produces no duplicate run -------------------------------------------
    const runsBefore9 = (await runsFor("gcal-events")).length;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chA.channel_id, resourceId: chA.resource_id, resourceUri: CAL_RESOURCE_URI, state: "exists", messageNumber: 10 }), now: Date.now() });
    h.check("9 replay produces no duplicate run",
      r.status === 200 && r.body.duplicate === true && (await runsFor("gcal-events")).length === runsBefore9,
      `status=${r.status} dup=${r.body.duplicate} runsDelta=${(await runsFor("gcal-events")).length - runsBefore9}`);

    // --- 8. inactive/expired/deleted channel rejected ----------------------------------
    const aRow = (await chanRows()).find((x) => x.channel_id === chA.channel_id);
    await svc.entities.GoogleWatchChannel.update(aRow.id, { status: "expired", updated_at: new Date().toISOString() });
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chA.channel_id, resourceId: chA.resource_id, resourceUri: CAL_RESOURCE_URI, state: "exists", messageNumber: 33 }), now: Date.now() });
    const expiredRejected = r.body.rejected === "inactive_channel" && r.body.channel_status === "expired";
    await svc.entities.GoogleWatchChannel.update(aRow.id, { status: "deleted", updated_at: new Date().toISOString() });
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chA.channel_id, resourceId: chA.resource_id, resourceUri: CAL_RESOURCE_URI, state: "exists", messageNumber: 34 }), now: Date.now() });
    const deletedRejected = r.body.rejected === "inactive_channel" && r.body.channel_status === "deleted";
    h.check("8 inactive/expired/deleted channel rejected",
      expiredRejected && deletedRejected,
      `expiredRejected=${expiredRejected} deletedRejected=${deletedRejected}`);

    // --- 12. renew re-watches and updates the existing row without duplicates ----------
    const rowsBefore12 = (await chanRows()).length;
    const oldC = (await chanRows()).find((x) => x.channel_id === chC.channel_id);
    const renewed = await renewGoogleWatch(svc, { channelId: chC.channel_id, http: scriptedGoogleHttp });
    const newC = (await chanRows()).find((x) => x.channel_id === renewed.channel_id);
    h.check("12 renew re-watches and updates the existing row without duplicates",
      renewed.channel_id !== chC.channel_id && newC?.id === oldC?.id && newC?.status === "active"
      && !!newC?.last_renewed_at && newC?.channel_id === renewed.channel_id
      && (await chanRows()).length === rowsBefore12,
      `oldCh=${chC.channel_id} newCh=${renewed.channel_id} sameRow=${newC?.id === oldC?.id} rows=${(await chanRows()).length} rowsDelta=${(await chanRows()).length - rowsBefore12}`);

    // --- 13. stop/delete state behaves per contract ------------------------------------
    const stopped = await stopGoogleWatch(svc, { channelId: chD.channel_id, http: scriptedGoogleHttp });
    const dRow = (await chanRows()).find((x) => x.channel_id === chD.channel_id);
    const runsBefore13 = (await runsFor("gcal-events")).length;
    r = await handleGoogleChannelConnectorEvent(svc, { projectId: project.id, headers: googHeaders({ channelId: chD.channel_id, resourceId: chD.resource_id, resourceUri: CAL_RESOURCE_URI, state: "exists", messageNumber: 40 }), now: Date.now() });
    h.check("13 stop/delete state behaves per contract",
      stopped.stopped === true && dRow?.status === "deleted" && r.body.rejected === "inactive_channel" && (await runsFor("gcal-events")).length === runsBefore13,
      `stopped=${stopped.stopped} status=${dRow?.status} afterStopRejected=${r.body.rejected} runsDelta=${(await runsFor("gcal-events")).length - runsBefore13}`);

    // --- 14. revoked delegated credential fails closed ---------------------------------
    let revokedThrew = false, revokedCode = null;
    try { await resolveGoogleAccessToken(svc, project, credId2, { http: scriptedGoogleHttp }); }
    catch (e) { revokedThrew = true; revokedCode = e.code; }
    let createWithRevokedThrew = false;
    try {
      await createGoogleWatch(svc, { project, provider: "googlecalendar", watchEndpoint: CAL_ENDPOINT, delegatedCredentialId: credId2, expirationMs: Date.now() + 86400000, notificationUrl: notif, http: scriptedGoogleHttp });
    } catch { createWithRevokedThrew = true; }
    const revokedRows = (await chanRows()).filter((x) => x.delegated_credential_id === credId2);
    h.check("14 revoked delegated credential fails closed",
      revokedThrew && revokedCode === "DELEGATED_CREDENTIAL_REVOKED" && createWithRevokedThrew && revokedRows.length === 0,
      `threw=${revokedThrew} code=${revokedCode} createThrew=${createWithRevokedThrew} rows=${revokedRows.length}`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    // dependency order: runs, definitions, channels (by workspace), credentials, users, project.
    for (const entity of ["WorkflowRun", "WorkflowDefinition", "BackgroundJob"]) {
      const q = scratch.projects.length ? { project_id: { $in: scratch.projects } } : {};
      await purgeBy(svc, entity, q);
    }
    await purgeBy(svc, "GoogleWatchChannel", { workspace_id: scratch.workspace });
    await purgeBy(svc, "DelegatedCredential", { workspace_id: scratch.workspace });
    await purgeBy(svc, "AppUser", { workspace_id: scratch.workspace });
    // Replay CacheEntry rows for the scratch project (shared github_webhook_replay namespace).
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