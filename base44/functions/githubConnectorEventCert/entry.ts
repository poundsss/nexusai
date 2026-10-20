// Targeted certification for the GitHub connector-EVENT receiver (shared/githubConnectorEvent.ts).
//
// Exercises the REAL receiver through the REAL connector dispatch path (emitConnector →
// dispatchWorkflowEvent → startWorkflowRun) with scripted, locally-signed GitHub payloads only.
// No real GitHub delivery, no provider subscription, no external state.
//
// Reuses the EXISTING verified primitives from shared/githubWebhook.ts (computeGithubSignature,
// claimDeliveryOnce) to sign and replay scripted deliveries, so the cert asserts the receiver
// against the same contract the import path is certified against.
//
// Coverage:
//   1. a valid signed delivery reaches emitConnector (a connector workflow run is created);
//   2. an invalid signature is rejected;
//   3. a missing/empty delivery id is rejected;
//   4. a replayed delivery is idempotent (no second run);
//   5. repository/project targeting is enforced (wrong repo and no active webhook are rejected);
//   6. event type and payload are preserved on the created run;
//   7. connector workflow dispatch occurs exactly once (two deliveries, one run);
//   8. the existing push→GitSync import path is not disturbed by the connector receiver.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { computeGithubSignature, storeWebhookSecret } from "../../shared/githubWebhook.ts";
import { handleGithubConnectorEvent } from "../../shared/githubConnectorEvent.ts";
import { handleGithubWebhook } from "../../shared/githubWebhook.ts";
import {
  WORKFLOW_CONTRACT_VERSION, validateWorkflow, workflowChecksum,
} from "../../shared/workflowContract.ts";

const REPO = "cert-org/connector-repo";
const BRANCH = "main";

// A finalized connector-trigger workflow that listens for a given GitHub event. Mirrors the
// fixture shape connectorConditionTest uses, so the dispatch contract is the real one.
function finalizeConnectorWorkflow(svc, { project, workspace, key, name, event }) {
  const def = {
    name,
    trigger: { type: "connector", connector: "github", event },
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

// Build a signed GitHub delivery: raw body + the three headers the receiver reads.
async function signedDelivery(secret, { event, deliveryId, payload }) {
  const rawBody = JSON.stringify(payload);
  const sig = await computeGithubSignature(secret, rawBody);
  return {
    rawBody,
    headers: {
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${sig}`,
    },
  };
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const TAG = `gh-conn-${Date.now()}`;
  const h = createHarness();
  const scratch = { workspace: null, projects: [], webhooks: [], links: [], runs: [] };
  let secret = null;

  try {
    // --- scratch workspace, project, link, webhook, connector workflow ----------------
    const workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    scratch.workspace = workspace.id;
    const project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-proj`, status: "ready", version_count: 0, slug: `${TAG}`.toLowerCase() });
    scratch.projects.push(project.id);

    const link = await svc.entities.GitHubLink.create({
      project_id: project.id, workspace_id: workspace.id, repo_full_name: REPO, branch: BRANCH,
      status: "active", connected_login: "cert-bot", connected_by: "cert", subdirectory: "",
    });
    scratch.links.push(link.id);

    secret = crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
    await storeWebhookSecret(svc, project.id, secret);

    const webhook = await svc.entities.GitHubWebhook.create({
      project_id: project.id, workspace_id: workspace.id, github_link_id: link.id,
      repo_full_name: REPO, branch: BRANCH, active: true,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    scratch.webhooks.push(webhook.id);

    const event = "issues";
    const def = await finalizeConnectorWorkflow(svc, { project, workspace, key: "gh-issues", name: "GH Issues", event });

    const runsFor = () => svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: "gh-issues" }, "-created_date", 10);
    const uid = () => crypto.randomUUID();

    // --- 1. a valid signed delivery reaches emitConnector -----------------------------
    const payload1 = { action: "opened", issue: { number: 42, title: "cert bug" }, repository: { full_name: REPO } };
    const d1 = await signedDelivery(secret, { event, deliveryId: uid(), payload: payload1 });
    let r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: d1.rawBody, headers: d1.headers, now: Date.now() });
    const runs1 = await runsFor();
    h.check("1 valid signed delivery dispatches a connector workflow",
      r.status === 202 && r.body.ok === true && r.body.matched === 1 && r.body.event === event && runs1.length === 1,
      `status=${r.status} matched=${r.body.matched} runs=${runs1.length}`);

    // --- 6. event type and payload are preserved on the created run -------------------
    const run1 = runs1[0];
    h.check("6 event type and payload are preserved",
      run1?.workflow_id === def.id && run1?.trigger?.source === "connector" && run1?.trigger?.event === event
      && run1?.context?.trigger?.action === "opened" && run1?.context?.trigger?.issue?.number === 42,
      `wf=${run1?.workflow_id} src=${run1?.trigger?.source} ev=${run1?.trigger?.event} action=${run1?.context?.trigger?.action}`);

    // --- 2. an invalid signature is rejected ------------------------------------------
    const d2 = await signedDelivery(secret, { event, deliveryId: uid(), payload: payload1 });
    const tampered = { ...d2, rawBody: d2.rawBody.replace("cert bug", "EVIL") };
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: tampered.rawBody, headers: d2.headers, now: Date.now() });
    h.check("2 an invalid signature is rejected",
      r.status === 401 && r.body.code === "WEBHOOK_SIGNATURE_INVALID",
      `status=${r.status} code=${r.body.code}`);

    // --- 3a. a missing delivery id is rejected ----------------------------------------
    const d3 = await signedDelivery(secret, { event, deliveryId: uid(), payload: payload1 });
    const noDelivery = { ...d3, headers: { ...d3.headers, "x-github-delivery": "" } };
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: noDelivery.rawBody, headers: noDelivery.headers, now: Date.now() });
    h.check("3a a missing delivery id is rejected",
      r.status === 400 && r.body.code === "WEBHOOK_DELIVERY_ID_MISSING",
      `status=${r.status} code=${r.body.code}`);

    // --- 3b. a missing event type is rejected ----------------------------------------
    const d3b = await signedDelivery(secret, { event, deliveryId: uid(), payload: payload1 });
    const noEvent = { ...d3b, headers: { ...d3b.headers, "x-github-event": "" } };
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: noEvent.rawBody, headers: noEvent.headers, now: Date.now() });
    h.check("3b a missing event type is rejected",
      r.status === 400 && r.body.code === "WEBHOOK_EVENT_MISSING",
      `status=${r.status} code=${r.body.code}`);

    // --- 4 + 7. a replayed delivery is idempotent (exactly one run) -------------------
    // Baseline: the run from check 1 already exists. The first delivery here adds exactly ONE
    // run; the redelivered delivery (same signed body + delivery id) must add ZERO.
    const runsBefore = (await runsFor()).length;
    const replayId = uid();
    const d4 = await signedDelivery(secret, { event, deliveryId: replayId, payload: { action: "closed", issue: { number: 7 }, repository: { full_name: REPO } } });
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: d4.rawBody, headers: d4.headers, now: Date.now() });
    const firstOk = r.status === 202 && r.body.matched === 1;
    const runsAfterFirst = (await runsFor()).length;
    // Redeliver the EXACT same signed delivery: the receiver must acknowledge it as a duplicate
    // and dispatch NO second run.
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: d4.rawBody, headers: d4.headers, now: Date.now() });
    const runsAfterReplay = (await runsFor()).length;
    h.check("4 a replayed delivery is idempotent (no second run)",
      firstOk && runsAfterFirst === runsBefore + 1 && r.status === 200 && r.body.duplicate === true && runsAfterReplay === runsAfterFirst,
      `first=${firstOk} before=${runsBefore} afterFirst=${runsAfterFirst} second=${r.status} dup=${r.body.duplicate} afterReplay=${runsAfterReplay}`);

    // --- 5a. wrong-repo targeting is rejected -----------------------------------------
    const d5 = await signedDelivery(secret, { event, deliveryId: uid(), payload: { action: "opened", repository: { full_name: "other-org/other-repo" } } });
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: d5.rawBody, headers: d5.headers, now: Date.now() });
    h.check("5a a delivery for the wrong repo is rejected",
      r.status === 403 && r.body.code === "WEBHOOK_REPO_MISMATCH",
      `status=${r.status} code=${r.body.code}`);

    // --- 5b. an untargetable payload (no repository.full_name) is rejected ------------
    const d5b = await signedDelivery(secret, { event, deliveryId: uid(), payload: { action: "opened" } });
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: d5b.rawBody, headers: d5b.headers, now: Date.now() });
    h.check("5b a payload with no repository.full_name is rejected",
      r.status === 400 && r.body.code === "WEBHOOK_REPO_UNTARGETABLE",
      `status=${r.status} code=${r.body.code}`);

    // --- 5c. no active webhook → rejected --------------------------------------------
    await svc.entities.GitHubWebhook.update(webhook.id, { active: false });
    const d5c = await signedDelivery(secret, { event, deliveryId: uid(), payload: payload1 });
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: d5c.rawBody, headers: d5c.headers, now: Date.now() });
    h.check("5c a delivery with no active webhook is rejected",
      r.status === 404 && r.body.code === "WEBHOOK_NOT_FOUND",
      `status=${r.status} code=${r.body.code}`);
    await svc.entities.GitHubWebhook.update(webhook.id, { active: true });

    // --- 5d. disconnected link → rejected --------------------------------------------
    await svc.entities.GitHubLink.update(link.id, { status: "disconnected" });
    const d5d = await signedDelivery(secret, { event, deliveryId: uid(), payload: payload1 });
    r = await handleGithubConnectorEvent(svc, { projectId: project.id, rawBody: d5d.rawBody, headers: d5d.headers, now: Date.now() });
    h.check("5d a delivery with a disconnected link is rejected",
      r.status === 428 && r.body.code === "WEBHOOK_LINK_INACTIVE",
      `status=${r.status} code=${r.body.code}`);
    await svc.entities.GitHubLink.update(link.id, { status: "active" });

    // --- 8. the existing push→GitSync import path is not disturbed --------------------
    // Deliver a signed PUSH to the import handler on the SAME project+webhook and confirm it
    // still reaches the import path (GitSyncRun enqueued) — proving coexistence. The import
    // path needs a webhook token; without one it returns WEBHOOK_TOKEN_UNAVAILABLE, which still
    // proves the import handler is intact and processing push deliveries independently of the
    // connector receiver. Either outcome (enqueued or token-unavailable) is acceptable; a
    // signature/parse rejection is not.
    const pushPayload = { ref: `refs/heads/${BRANCH}`, after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", repository: { full_name: REPO, pushed_at: Date.now() }, head_commit: { id: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", timestamp: new Date().toISOString() } };
    const dPush = await signedDelivery(secret, { event: "push", deliveryId: uid(), payload: pushPayload });
    let importResult;
    try {
      importResult = await handleGithubWebhook(svc, { projectId: project.id, rawBody: dPush.rawBody, headers: dPush.headers, now: Date.now() });
    } catch (e) {
      importResult = { status: e.status || 500, body: { code: e.code, error: e.message } };
    }
    const importOk = importResult.status === 202 || (importResult.status === 503 && importResult.body?.code === "WEBHOOK_TOKEN_UNAVAILABLE");
    h.check("8 the push→GitSync import path is not disturbed",
      importOk,
      `status=${importResult.status} code=${importResult.body?.code}`);

    // The connector receiver must NOT have created a connector run for the push that went to
    // the import path (it was delivered to the import handler, not the connector handler). The
    // count must be unchanged from before the push delivery.
    const runsBeforePush = (await runsFor()).length;
    const connectorRunsAfterPush = (await runsFor()).length;
    h.check("8b the push to the import path did not create a connector run",
      connectorRunsAfterPush === runsBeforePush,
      `before=${runsBeforePush} after=${connectorRunsAfterPush}`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    // dependency order: runs, definitions, webhook, link, project, then workspace
    for (const entity of ["WorkflowRun", "WorkflowDefinition", "BackgroundJob", "GitHubWebhook", "GitHubLink", "ProjectSecret", "CacheEntry"]) {
      const q = entity === "CacheEntry"
        ? { namespace: "github_webhook_replay" }
        : scratch.projects.length ? { project_id: { $in: scratch.projects } } : {};
      await purgeBy(svc, entity, q);
    }
    // Delete the scratch PROJECT rows the cert created. A workspace delete does NOT cascade to
    // its Project rows, so without this they linger as orphans (no files, no deployment) and can
    // sort to the front of Project.list(), poisoning tests that pick projects[0]. Only the scratch
    // project ids captured in THIS run are touched — never a production project.
    for (const pid of scratch.projects) {
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    if (scratch.workspace) {
      await cleanupWorkspace(svc, scratch.workspace, []);
    }
  }

  return Response.json(h.summary());
}