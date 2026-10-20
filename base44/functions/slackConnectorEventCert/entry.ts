// Targeted certification for the Slack connector-EVENT receiver (shared/slackConnectorEvent.ts).
//
// Exercises the REAL receiver through the REAL connector dispatch path (emitConnector →
// dispatchWorkflowEvent → startWorkflowRun) with scripted, locally-signed Slack payloads only.
// No real Slack delivery, no provider subscription, no external state.
//
// Mirrors the certified githubConnectorEventCert harness shape, so the Slack receiver is
// asserted against the same dispatch contract the GitHub receiver is certified against.
//
// Reuses the EXISTING verified primitives the receiver itself uses:
//   • computeSlackSignature ........ to sign scripted deliveries
//   • claimDeliveryOnce ............. the replay primitive the receiver calls (asserted via the
//                                     shared CacheEntry cache key)
//   • DelegatedCredential ........... the existing per-project connector credential, used as the
//                                     Slack connection fixture (provider_id "slack", team_id)
//   • ProjectSecret ................. SLACK_SIGNING_SECRET, sealed with encryptSecretValue
//
// Coverage:
//   1. a valid signed event dispatches a connector workflow;
//   2. an invalid signature is rejected;
//   3. a stale timestamp is rejected;
//   4. a replayed event_id is idempotent (no second run);
//   5. a delivery for the wrong team is rejected, and an unknown project is rejected;
//   6. a delivery with no active Slack connection is rejected;
//   7. the provider-native event name and payload reach emitConnector (verified on the run);
//   8. rejected deliveries persist nothing: no WorkflowRun, no replay CacheEntry.
//   9-12. DOCUMENTED condition enforcement: slack/slackbot automations REQUIRE trigger conditions
//     (valid accepted, missing rejected, malformed rejected, other connectors unchanged).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  computeSlackSignature, SLACK_SIGNING_SECRET_NAME, handleSlackConnectorEvent,
} from "../../shared/slackConnectorEvent.ts";
import {
  WORKFLOW_CONTRACT_VERSION, validateWorkflow, workflowChecksum,
} from "../../shared/workflowContract.ts";
import { encryptSecretValue, encryptWithAad } from "../../shared/secretCrypto.ts";

const TEAM = "T0SLACKCERT";
const EVENT = "message";
// DOCUMENTED (Base44): slack/slackbot connector automations REQUIRE a trigger condition. The
// platform jq condition the fixture matches the delivered payload on (`.event.type == "message"`).
const COND = '.event.type == "message"';

// A finalized connector-trigger workflow that listens for the Slack event. Mirrors the fixture
// shape githubConnectorEventCert uses, so the dispatch contract is the real one.
function finalizeConnectorWorkflow(svc, { project, workspace, key, name, event }) {
  const def = {
    name,
    trigger: { type: "connector", connector: "slack", event, condition: COND },
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

// Store the Slack signing secret as an encrypted ProjectSecret — the same shape the receiver
// resolves at verification time.
async function storeSlackSigningSecret(svc, projectId, secret) {
  const sealed = await encryptSecretValue(projectId, SLACK_SIGNING_SECRET_NAME, secret);
  const existing = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: SLACK_SIGNING_SECRET_NAME }, "name", 1))[0] || null;
  if (existing) return svc.entities.ProjectSecret.update(existing.id, { value: sealed });
  return svc.entities.ProjectSecret.create({ project_id: projectId, name: SLACK_SIGNING_SECRET_NAME, value: sealed, required: true });
}

// A scratch Slack connection: a DelegatedCredential (provider_id "slack", external_subject =
// team_id, status active) — the existing per-project connector credential contract, reused as
// the connection record. No new entity.
async function createSlackConnection(svc, { project, workspace, teamId, appUserId }) {
  const credId = `dc_slack_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return svc.entities.DelegatedCredential.create({
    credential_id: credId, project_id: project.id, workspace_id: workspace.id, app_user_id: appUserId,
    provider_id: "slack", external_subject: teamId, status: "active",
    encrypted_access_token: await encryptWithAad(`delegated-credential:${project.id}:${credId}`, "slack-bot-token-placeholder"),
    expires_at: new Date(Date.now() + 3600000).toISOString(), token_endpoint: "https://slack.com/api/oauth.token",
    client_id_secret: "SLACK_CLIENT_ID", pkce: false, created_at: new Date().toISOString(),
  });
}

// Build a signed Slack Events API delivery: raw body + the two headers the receiver reads.
async function signedDelivery(secret, { eventId, eventType, teamId, payload, timestampSec }) {
  const body = {
    token: "verification-token", team_id: teamId, event_id: eventId,
    api_app_id: "A0CERT", type: "event_callback",
    event: { type: eventType, user: "U0CERT", text: "cert hello", ts: `${timestampSec}.000100`, channel: "C0CERT" },
    ...(payload || {}),
  };
  const rawBody = JSON.stringify(body);
  const sig = await computeSlackSignature(secret, String(timestampSec), rawBody);
  return { rawBody, headers: { "x-slack-signature": sig, "x-slack-request-timestamp": String(timestampSec) } };
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `slack-conn-${Date.now()}`;
  const h = createHarness();
  const scratch = { workspace: null, projects: [], connections: [], users: [], secrets: [], runs: [] };
  let secret = null;
  let project = null;
  let workspace = null;
  let def = null;
  const wfKey = "slack-msg";

  try {
    // --- scratch workspace, project, app user, Slack connection, signing secret, workflow ----
    workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    scratch.workspace = workspace.id;
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-proj`, status: "ready", version_count: 0, slug: TAG.toLowerCase() });
    scratch.projects.push(project.id);

    const appUser = await svc.entities.AppUser.create({ project_id: project.id, workspace_id: workspace.id, email: `${TAG}@cert.test`, status: "active", display_name: "Slack Cert" });
    scratch.users.push(appUser.id);

    secret = crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
    await storeSlackSigningSecret(svc, project.id, secret);

    const connection = await createSlackConnection(svc, { project, workspace, teamId: TEAM, appUserId: appUser.id });
    scratch.connections.push(connection.id);

    def = await finalizeConnectorWorkflow(svc, { project, workspace, key: wfKey, name: "Slack Messages", event: EVENT });

    const runsFor = () => svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: wfKey }, "-created_date", 10);
    const replayKey = (eventId) => `github_webhook_replay:${project.id}:slack:${eventId}`;
    const replayFor = (eventId) => svc.entities.CacheEntry.filter({ cache_key: replayKey(eventId) }, "created_date", 5).catch(() => []);
    const uid = () => `Ev${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const nowSec = () => Math.floor(Date.now() / 1000);

    // --- 1. a valid signed event dispatches a connector workflow -------------------------
    const d1 = await signedDelivery(secret, { eventId: uid(), eventType: EVENT, teamId: TEAM, timestampSec: nowSec() });
    let r = await handleSlackConnectorEvent(svc, { projectId: project.id, rawBody: d1.rawBody, headers: d1.headers, now: Date.now() });
    const runs1 = await runsFor();
    h.check("1 a valid signed event dispatches a connector workflow",
      r.status === 202 && r.body.ok === true && r.body.matched === 1 && r.body.event === EVENT && runs1.length === 1,
      `status=${r.status} matched=${r.body.matched} event=${r.body.event} runs=${runs1.length}`);

    // --- 7. the provider-native event name and payload reach emitConnector ----------------
    const run1 = runs1[0];
    h.check("7 the provider-native event name and payload reach emitConnector",
      run1?.workflow_id === def.id && run1?.trigger?.source === "connector" && run1?.trigger?.event === EVENT
      && run1?.context?.trigger?.event_id === r.body.delivery_id
      && run1?.context?.trigger?.team_id === TEAM
      && run1?.context?.trigger?.event?.type === EVENT,
      `wf=${run1?.workflow_id} src=${run1?.trigger?.source} ev=${run1?.trigger?.event} eid=${run1?.context?.trigger?.event_id} team=${run1?.context?.trigger?.team_id}`);

    // --- 2. an invalid signature is rejected ---------------------------------------------
    const ev2 = uid();
    const d2 = await signedDelivery(secret, { eventId: ev2, eventType: EVENT, teamId: TEAM, timestampSec: nowSec() });
    const tampered = { ...d2, rawBody: d2.rawBody.replace("cert hello", "EVIL") };
    const runsBefore2 = (await runsFor()).length;
    r = await handleSlackConnectorEvent(svc, { projectId: project.id, rawBody: tampered.rawBody, headers: d2.headers, now: Date.now() });
    const replay2 = await replayFor(ev2);
    h.check("2 an invalid signature is rejected with no persistence",
      r.status === 401 && r.body.code === "SLACK_SIGNATURE_INVALID" && (await runsFor()).length === runsBefore2 && replay2.length === 0,
      `status=${r.status} code=${r.body.code} runsDelta=${(await runsFor()).length - runsBefore2} replay=${replay2.length}`);

    // --- 3. a stale timestamp is rejected -----------------------------------------------
    const ev3 = uid();
    const staleSec = nowSec() - 600; // 10 min ago, outside the 5-min window
    const d3 = await signedDelivery(secret, { eventId: ev3, eventType: EVENT, teamId: TEAM, timestampSec: staleSec });
    const runsBefore3 = (await runsFor()).length;
    r = await handleSlackConnectorEvent(svc, { projectId: project.id, rawBody: d3.rawBody, headers: d3.headers, now: Date.now() });
    const replay3 = await replayFor(ev3);
    h.check("3 a stale timestamp is rejected with no persistence",
      r.status === 401 && r.body.code === "SLACK_TIMESTAMP_STALE" && (await runsFor()).length === runsBefore3 && replay3.length === 0,
      `status=${r.status} code=${r.body.code} runsDelta=${(await runsFor()).length - runsBefore3} replay=${replay3.length}`);

    // --- 4. a replayed event_id is idempotent (exactly one run) ---------------------------
    const runsBefore4 = (await runsFor()).length;
    const replayId = uid();
    const d4 = await signedDelivery(secret, { eventId: replayId, eventType: EVENT, teamId: TEAM, timestampSec: nowSec() });
    r = await handleSlackConnectorEvent(svc, { projectId: project.id, rawBody: d4.rawBody, headers: d4.headers, now: Date.now() });
    const firstOk = r.status === 202 && r.body.matched === 1;
    const runsAfterFirst = (await runsFor()).length;
    // Redeliver the EXACT same signed event: the receiver must acknowledge it as a duplicate and
    // dispatch NO second run. Use the same timestamp so the signature stays valid.
    r = await handleSlackConnectorEvent(svc, { projectId: project.id, rawBody: d4.rawBody, headers: d4.headers, now: Date.now() });
    const runsAfterReplay = (await runsFor()).length;
    h.check("4 a replayed event_id is idempotent (no second run)",
      firstOk && runsAfterFirst === runsBefore4 + 1 && r.status === 200 && r.body.duplicate === true && runsAfterReplay === runsAfterFirst,
      `first=${firstOk} before=${runsBefore4} afterFirst=${runsAfterFirst} second=${r.status} dup=${r.body.duplicate} afterReplay=${runsAfterReplay}`);

    // --- 5a. a delivery for the wrong team is rejected ----------------------------------
    const ev5 = uid();
    const d5 = await signedDelivery(secret, { eventId: ev5, eventType: EVENT, teamId: "T_OTHER_TEAM", timestampSec: nowSec() });
    const runsBefore5 = (await runsFor()).length;
    r = await handleSlackConnectorEvent(svc, { projectId: project.id, rawBody: d5.rawBody, headers: d5.headers, now: Date.now() });
    const replay5 = await replayFor(ev5);
    h.check("5a a delivery for the wrong team is rejected with no persistence",
      r.status === 404 && r.body.code === "SLACK_CONNECTION_NOT_FOUND" && (await runsFor()).length === runsBefore5 && replay5.length === 0,
      `status=${r.status} code=${r.body.code} runsDelta=${(await runsFor()).length - runsBefore5} replay=${replay5.length}`);

    // --- 5b. an unknown project is rejected ---------------------------------------------
    const ev5b = uid();
    const d5b = await signedDelivery(secret, { eventId: ev5b, eventType: EVENT, teamId: TEAM, timestampSec: nowSec() });
    r = await handleSlackConnectorEvent(svc, { projectId: "nonexistent-project-id", rawBody: d5b.rawBody, headers: d5b.headers, now: Date.now() });
    h.check("5b an unknown project is rejected",
      r.status === 404,
      `status=${r.status} code=${r.body.code}`);

    // --- 6. a delivery with no active Slack connection is rejected -----------------------
    await svc.entities.DelegatedCredential.update(connection.id, { status: "revoked" });
    const ev6 = uid();
    const d6 = await signedDelivery(secret, { eventId: ev6, eventType: EVENT, teamId: TEAM, timestampSec: nowSec() });
    const runsBefore6 = (await runsFor()).length;
    r = await handleSlackConnectorEvent(svc, { projectId: project.id, rawBody: d6.rawBody, headers: d6.headers, now: Date.now() });
    const replay6 = await replayFor(ev6);
    h.check("6 a delivery with no active Slack connection is rejected with no persistence",
      r.status === 404 && r.body.code === "SLACK_CONNECTION_NOT_FOUND" && (await runsFor()).length === runsBefore6 && replay6.length === 0,
      `status=${r.status} code=${r.body.code} runsDelta=${(await runsFor()).length - runsBefore6} replay=${replay6.length}`);
    await svc.entities.DelegatedCredential.update(connection.id, { status: "active" });

    // --- 8. url_verification handshake is echoed and dispatches nothing ------------------
    const handshake = { type: "url_verification", challenge: "cert-challenge-abc", token: "vk" };
    const rawHs = JSON.stringify(handshake);
    const sigHs = await computeSlackSignature(secret, String(nowSec()), rawHs);
    const runsBeforeHs = (await runsFor()).length;
    r = await handleSlackConnectorEvent(svc, { projectId: project.id, rawBody: rawHs, headers: { "x-slack-signature": sigHs, "x-slack-request-timestamp": String(nowSec()) }, now: Date.now() });
    h.check("8 the url_verification handshake is echoed and dispatches nothing",
      r.status === 200 && r.body.challenge === "cert-challenge-abc" && (await runsFor()).length === runsBeforeHs,
      `status=${r.status} challenge=${r.body.challenge} runsDelta=${(await runsFor()).length - runsBeforeHs}`);

    // --- 9-12. DOCUMENTED condition enforcement: slack/slackbot automations REQUIRE a condition ---
    // Enforced by the SAME contract the fixture validated through — asserted directly here.
    const val = (trigger) => validateWorkflow(
      { name: "Cond", trigger, steps: [{ id: "s1", type: "complete", message: "ok" }], entry_step: "s1" },
      { functionNames: [] },
    );
    const okCond = val({ type: "connector", connector: "slack", event: "message", condition: COND });
    const missingCond = val({ type: "connector", connector: "slack", event: "message" });
    const malformedCond = val({ type: "connector", connector: "slack", event: "message", condition: ".event.type ==" });
    const slackbotMissing = val({ type: "connector", connector: "slackbot", event: "message" });
    const githubNoCond = val({ type: "connector", connector: "github", event: "push" });
    h.check("9 a slack trigger with a valid condition is accepted",
      okCond.ok === true,
      `ok=${okCond.ok} errors=${JSON.stringify(okCond.errors || [])}`);
    h.check("10 a slack trigger without a condition is rejected",
      missingCond.ok === false && missingCond.errors.some((x) => /condition/.test(String(x))),
      `ok=${missingCond.ok} errors=${JSON.stringify(missingCond.errors || [])}`);
    h.check("11 a malformed slack condition is rejected, and slackbot requires one too",
      malformedCond.ok === false && slackbotMissing.ok === false,
      `malformed=${malformedCond.ok} slackbot=${slackbotMissing.ok} errors=${JSON.stringify(malformedCond.errors || [])}`);
    h.check("12 other connectors still accept a condition-less trigger (unchanged)",
      githubNoCond.ok === true,
      `ok=${githubNoCond.ok} errors=${JSON.stringify(githubNoCond.errors || [])}`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    // dependency order: runs, definitions, credentials, users, then project-scoped cleanup,
    // then the scratch project rows, then the workspace.
    for (const entity of ["WorkflowRun", "WorkflowDefinition", "BackgroundJob", "DelegatedCredential", "AppUser"]) {
      const q = scratch.projects.length ? { project_id: { $in: scratch.projects } } : {};
      await purgeBy(svc, entity, q);
    }
    // ProjectSecret + replay CacheEntry for the scratch project.
    for (const pid of scratch.projects) {
      await purgeBy(svc, "ProjectSecret", { project_id: pid });
    }
    // Replay CacheEntry rows: filter the shared namespace and keep only this project's keys.
    const replayRows = await svc.entities.CacheEntry.filter({ namespace: "github_webhook_replay" }, "-created_date", 300).catch(() => []);
    for (const row of replayRows) {
      if (scratch.projects.some((pid) => String(row.cache_key || "").includes(pid))) {
        await svc.entities.CacheEntry.delete(row.id).catch(() => {});
      }
    }
    // Delete the scratch PROJECT rows (a workspace delete does NOT cascade to its Project rows).
    for (const pid of scratch.projects) {
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    if (scratch.workspace) {
      await cleanupWorkspace(svc, scratch.workspace, []);
    }
  }

  return Response.json(h.summary());
}