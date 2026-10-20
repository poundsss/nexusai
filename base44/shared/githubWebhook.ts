// GitHub push-webhook verification, parsing and replay protection.
//
// GitHub signs every webhook delivery with HMAC-SHA256 using the webhook secret configured at
// registration time. The signature covers the EXACT raw request body — not a re-serialized
// version — so verification reads the bytes as received and never re-encodes.
//
// The secret is a ProjectSecret (encrypted at rest, decrypted only here, server-side). It is
// never returned to a client, logged, or included in an error message. A project with no
// secret configured cannot receive deliveries — the receiver refuses rather than falling
// back to accepting unsigned requests.
//
// Replay protection uses GitHub's own delivery ID (x-github-delivery), a UUID unique per
// delivery. A delivery is accepted at most once inside a bounded window, recorded durably
// in CacheEntry, so a captured and re-sent request is refused too.
import { decryptSecretValue } from "./secretCrypto.ts";
import { GitHubError } from "./github.ts";
import { audit } from "./authz.ts";
import { GIT_ACTIVE, stashJobToken } from "./gitSync.ts";
import { githubEntitlement, githubPlanMessage, GITHUB_PLAN_NOT_ENTITLED } from "./githubEntitlement.ts";

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);

// GitHub's webhook headers.
export const GITHUB_EVENT_HEADER = "x-github-event";
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
export const GITHUB_HOOK_ID_HEADER = "x-github-hook-id";

export const WEBHOOK_SECRET_NAME = "GITHUB_WEBHOOK_SECRET";
export const REPLAY_WINDOW_MS = 300000; // 5 minutes
const REPLAY_TTL_MS = REPLAY_WINDOW_MS * 2;

const svcOf = (client) => client.asServiceRole || client;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// HMAC-SHA256(secret, rawBody) → hex string. This is the exact computation GitHub performs.
export async function computeGithubSignature(secret, rawBody) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(rawBody ?? ""))));
}

// Length-independent comparison: a byte-by-byte early return would leak how much of a guessed
// signature was correct.
export function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Extract the hex signature from the `x-hub-signature-256: sha256=<hex>` header.
export function extractSignature(headers) {
  const raw = String(headers[GITHUB_SIGNATURE_HEADER] || headers[GITHUB_SIGNATURE_HEADER.toLowerCase()] || "");
  return raw.replace(/^sha256=/, "").trim();
}

export function extractDeliveryId(headers) {
  return String(headers[GITHUB_DELIVERY_HEADER] || headers[GITHUB_DELIVERY_HEADER.toLowerCase()] || "").trim();
}

export function extractEventType(headers) {
  return String(headers[GITHUB_EVENT_HEADER] || headers[GITHUB_EVENT_HEADER.toLowerCase()] || "").trim();
}

// The project's webhook secret, decrypted at the point of verification.
export async function resolveWebhookSecret(client, projectId) {
  const svc = svcOf(client);
  const row = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: WEBHOOK_SECRET_NAME }, "name", 1))[0] || null;
  if (!row?.value) {
    throw new GitHubError("WEBHOOK_SECRET_NOT_CONFIGURED", "This project has no GitHub webhook secret configured.", 503);
  }
  return decryptSecretValue(projectId, WEBHOOK_SECRET_NAME, row.value);
}

// Verify the HMAC signature against the exact raw body. Throws on mismatch; returns the
// computed signature on success (used as a secondary delivery fingerprint).
export async function verifyGithubSignature(secret, rawBody, providedSignature) {
  if (!providedSignature) {
    throw new GitHubError("WEBHOOK_SIGNATURE_MISSING", "The webhook delivery has no signature header.", 401);
  }
  const expected = await computeGithubSignature(secret, rawBody);
  if (!constantTimeEqual(providedSignature, expected)) {
    throw new GitHubError("WEBHOOK_SIGNATURE_INVALID", "The webhook signature does not match the request body.", 401);
  }
  return expected;
}

// Parse a GitHub push event payload after signature verification. Extracts the repo, branch,
// and head commit SHA — the minimum the receiver needs to enqueue an import.
export function parsePushEvent(payload) {
  if (!payload || typeof payload !== "object") {
    throw new GitHubError("WEBHOOK_MALFORMED_PAYLOAD", "The push event payload is not a valid JSON object.", 400);
  }
  const repo = payload.repository?.full_name;
  const ref = payload.ref;
  const headSha = payload.head_commit?.id || payload.after;
  const pushedAt = payload.head_commit?.timestamp || payload.repository?.pushed_at;

  if (!repo) throw new GitHubError("WEBHOOK_MALFORMED_PAYLOAD", "The push event has no repository.full_name.", 400);
  if (!ref) throw new GitHubError("WEBHOOK_MALFORMED_PAYLOAD", "The push event has no ref.", 400);
  if (!headSha) throw new GitHubError("WEBHOOK_MALFORMED_PAYLOAD", "The push event has no head commit.", 400);

  // ref is "refs/heads/<branch>"
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;

  return { repo, branch, headSha, pushedAt };
}

// Durable single-use claim on one delivery. The row is created, then re-read: if two workers
// raced, only the earliest row wins and the loser is treated as a replay.
export async function claimDeliveryOnce(client, { projectId, deliveryId, now = Date.now() }) {
  const svc = svcOf(client);
  const cacheKey = `github_webhook_replay:${projectId}:${deliveryId}`;
  // Fail closed: a failed read throws (never "unseen" or "won"). Only live claims compete.
  // UNKNOWN: atomicity still depends on database read consistency (no unique constraint).
  const live = (rows) => rows.filter((r) => new Date(r.expires_at).getTime() > now);
  const existing = await svc.entities.CacheEntry.filter({ cache_key: cacheKey }, "created_date", 5);
  if (live(existing).length) return false;
  const mine = await svc.entities.CacheEntry.create({
    namespace: "github_webhook_replay", cache_key: cacheKey, value: { claimed_at: new Date(now).toISOString() },
    expires_at: new Date(now + REPLAY_TTL_MS).toISOString(), stale_at: new Date(now + REPLAY_TTL_MS).toISOString(),
    size_bytes: 64, version: 1,
  });
  const all = live(await svc.entities.CacheEntry.filter({ cache_key: cacheKey }, "created_date", 5));
  return (all[0]?.id || mine.id) === mine.id;
}

// Generate a cryptographically random webhook secret.
export function generateWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Store the webhook secret as an encrypted ProjectSecret.
export async function storeWebhookSecret(svc, projectId, secret) {
  const { encryptSecretValue } = await import("./secretCrypto.ts");
  const sealed = await encryptSecretValue(projectId, WEBHOOK_SECRET_NAME, secret);
  const existing = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: WEBHOOK_SECRET_NAME }, "name", 1))[0] || null;
  if (existing) return svc.entities.ProjectSecret.update(existing.id, { value: sealed });
  return svc.entities.ProjectSecret.create({ project_id: projectId, name: WEBHOOK_SECRET_NAME, value: sealed, required: true });
}

// Store the webhook token as an encrypted WorkspaceSecret (for webhook-triggered imports).
export async function storeWebhookToken(svc, workspaceId, projectId, token) {
  const { writeWorkspaceSecret } = await import("./workspaceSecrets.ts");
  const name = `GITHUB_WEBHOOK_TOKEN_${projectId}`;
  await writeWorkspaceSecret(svc, workspaceId, name, token, {
    description: "GitHub OAuth token for webhook-triggered imports. Refreshed on re-registration.",
  });
  return name;
}

export async function readWebhookToken(svc, workspaceId, projectId) {
  const { readWorkspaceSecret } = await import("./workspaceSecrets.ts");
  return readWorkspaceSecret(svc, workspaceId, `GITHUB_WEBHOOK_TOKEN_${projectId}`);
}

export async function deleteWebhookToken(svc, workspaceId, projectId) {
  const { deleteWorkspaceSecret } = await import("./workspaceSecrets.ts");
  return deleteWorkspaceSecret(svc, workspaceId, `GITHUB_WEBHOOK_TOKEN_${projectId}`);
}

// The core webhook receiver logic, shared by the HTTP handler and the test harness so both
// exercise exactly the same code. Returns { status, body } — the handler wraps it in a
// Response, the test inspects it directly.
export async function handleGithubWebhook(svc, { projectId, rawBody, headers, now = Date.now(), resolvePlan = null }) {
  let project = null;
  let webhook = null;
  let deliveryId = null;

  const recordAudit = async (action, metadata) => {
    if (!project) return;
    await audit(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: null,
      action, resource: "GitHubWebhook", resource_id: webhook?.id || null,
      metadata: { delivery_id: deliveryId, ...metadata },
    }).catch(() => {});
  };

  const reject = async (code, message, status = 401, extra = {}) => {
    await recordAudit("github.webhook.rejected", { code, reason: trunc(message), ...extra });
    if (webhook) {
      await svc.entities.GitHubWebhook.update(webhook.id, {
        last_delivery_id: deliveryId || null,
        last_delivery_at: new Date().toISOString(),
        last_delivery_status: "rejected",
        last_error: trunc(message),
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return { status, body: { error: message, code } };
  };

  // 1. Resolve the project from the URL — never from the body.
  if (!projectId) return { status: 400, body: { error: "project_id query parameter is required" } };

  project = await svc.entities.Project.get(projectId).catch(() => null);
  if (!project) return { status: 404, body: { error: "Not found" } };

  deliveryId = extractDeliveryId(headers);
  const eventType = extractEventType(headers);
  const providedSig = extractSignature(headers);

  // 2. Find the active GitHubWebhook for this project.
  const webhooks = await svc.entities.GitHubWebhook.filter({ project_id: project.id, active: true }, "-created_date", 5);
  webhook = webhooks[0] || null;
  if (!webhook) {
    return reject("WEBHOOK_NOT_FOUND", "This project has no active GitHub webhook.", 404);
  }

  // 3. Verify the HMAC signature.
  let secret;
  try {
    secret = await resolveWebhookSecret(svc, project.id);
  } catch (e) {
    return reject(e.code || "WEBHOOK_SECRET_NOT_CONFIGURED", e.message, 503);
  }

  try {
    await verifyGithubSignature(secret, rawBody, providedSig);
  } catch (e) {
    return reject(e.code, e.message, 401);
  }

  // 4. Check the event type.
  if (eventType !== "push") {
    return reject("WEBHOOK_EVENT_IGNORED", `Event type "${eventType}" is not handled. Only push events trigger imports.`, 202, { event_type: eventType });
  }

  // 5. Parse the push event (after signature verification, so malformed JSON is safe).
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reject("WEBHOOK_MALFORMED_PAYLOAD", "The webhook body is not valid JSON.", 400);
  }

  let pushInfo;
  try {
    pushInfo = parsePushEvent(payload);
  } catch (e) {
    return reject(e.code, e.message, 400);
  }

  // 6. Validate repo + branch against the webhook and link.
  if (pushInfo.repo !== webhook.repo_full_name) {
    return reject("WEBHOOK_REPO_MISMATCH", `The push event is for ${pushInfo.repo}, but this webhook watches ${webhook.repo_full_name}.`, 403, { push_repo: pushInfo.repo });
  }
  if (pushInfo.branch !== webhook.branch) {
    return reject("WEBHOOK_BRANCH_MISMATCH", `The push event is on branch "${pushInfo.branch}", but this webhook watches "${webhook.branch}".`, 202, { push_branch: pushInfo.branch });
  }

  // 7. Resolve the GitHubLink for this webhook.
  const link = await svc.entities.GitHubLink.get(webhook.github_link_id).catch(() => null);
  if (!link || link.status === "disconnected") {
    return reject("WEBHOOK_LINK_INACTIVE", "The GitHub repository link for this webhook is disconnected.", 428);
  }

  // 7b. R-8: a workspace whose plan does not include GitHub gets the event ACKNOWLEDGED (202)
  // and skipped — nothing is enqueued or applied, and the skip is recorded on the webhook and in
  // the audit trail. The delivery is NOT claimed, so it is not burned. (Base44's own behavior for
  // inbound GitHub events on a lower plan is unpublished — UNKNOWN; this is NexusAI behavior.)
  const ent = await githubEntitlement(svc, project.workspace_id, resolvePlan ? { resolvePlan } : {});
  if (!ent.allowed) {
    return reject(GITHUB_PLAN_NOT_ENTITLED, `Skipped: ${githubPlanMessage(ent)}`, 202, { skipped: true, plan_code: ent.plan_code, plan_source: ent.source });
  }

  // 8. Replay protection — one delivery is accepted at most once.
  let claimed;
  try {
    claimed = await claimDeliveryOnce(svc, { projectId: project.id, deliveryId: deliveryId || pushInfo.headSha, now });
  } catch {
    return reject("DELIVERY_CLAIM_UNAVAILABLE", "Delivery could not be verified; retry later.", 503);
  }
  if (!claimed) {
    return reject("WEBHOOK_REPLAYED", "This webhook delivery was already processed.", 409);
  }

  // 9. Check for an active sync run (concurrency: one operation per project at a time).
  for (const status of GIT_ACTIVE) {
    const active = await svc.entities.GitSyncRun.filter({ project_id: project.id, status }, "-created_date", 1);
    if (active.length) {
      return reject("WEBHOOK_SYNC_IN_PROGRESS", `A GitHub ${active[0].direction} is already in progress for this project.`, 409, { sync_run_id: active[0].id });
    }
  }

  // 10. Check idempotency — if this commit was already imported, don't re-import.
  const idempotency_key = `import:${project.id}:${pushInfo.repo}:${pushInfo.headSha}`;
  const prior = await svc.entities.GitSyncRun.filter({ project_id: project.id, idempotency_key, status: "COMPLETED" }, "-created_date", 1);
  if (prior.length) {
    await svc.entities.GitHubWebhook.update(webhook.id, {
      last_delivery_id: deliveryId, last_delivery_at: new Date().toISOString(),
      last_delivery_status: "accepted", last_error: null, updated_at: new Date().toISOString(),
    }).catch(() => {});
    await recordAudit("github.webhook.received", { repo: pushInfo.repo, branch: pushInfo.branch, commit_sha: pushInfo.headSha, duplicate: true });
    return { status: 200, body: { ok: true, duplicate: true, sync_run_id: prior[0].id, commit_sha: pushInfo.headSha } };
  }

  // 11. Enqueue the import — read the webhook token, stash it as a per-run job token.
  const token = await readWebhookToken(svc, project.workspace_id, project.id);
  if (!token) {
    return reject("WEBHOOK_TOKEN_UNAVAILABLE", "The GitHub token for webhook-triggered imports is not available. Re-register the webhook.", 503);
  }

  const jobRef = `GITHUB_JOB_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await stashJobToken(svc, { workspace_id: project.workspace_id, name: jobRef, token });

  const run = await svc.entities.GitSyncRun.create({
    project_id: project.id, workspace_id: project.workspace_id,
    user_id: null, link_id: link.id,
    direction: "import", status: "QUEUED", current_phase: "queued",
    repo_full_name: pushInfo.repo, branch: pushInfo.branch, subdirectory: link.subdirectory || "",
    commit_sha: pushInfo.headSha,
    idempotency_key, credential_ref: jobRef,
    heartbeat_at: new Date().toISOString(),
  });

  // 12. Update the webhook record with delivery info.
  await svc.entities.GitHubWebhook.update(webhook.id, {
    last_delivery_id: deliveryId, last_delivery_at: new Date().toISOString(),
    last_delivery_status: "enqueued", last_error: null, updated_at: new Date().toISOString(),
  }).catch(() => {});

  await recordAudit("github.webhook.received", { repo: pushInfo.repo, branch: pushInfo.branch, commit_sha: pushInfo.headSha, sync_run_id: run.id });
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: null,
    action: "github.import.started", resource: "GitSyncRun", resource_id: run.id,
    metadata: { repo: pushInfo.repo, branch: pushInfo.branch, commit_sha: pushInfo.headSha, trigger: "webhook", delivery_id: deliveryId },
  });

  return { status: 202, body: { ok: true, sync_run_id: run.id, commit_sha: pushInfo.headSha, status: "QUEUED" } };
}

// Sanitized webhook record for API responses. Never includes the secret value or token.
export const publicWebhook = (w) =>
  w && {
    id: w.id, project_id: w.project_id, github_link_id: w.github_link_id,
    repo_full_name: w.repo_full_name, branch: w.branch,
    active: w.active, github_hook_id: w.github_hook_id || null,
    webhook_url: w.webhook_url || null,
    last_delivery_id: w.last_delivery_id || null,
    last_delivery_at: w.last_delivery_at || null,
    last_delivery_status: w.last_delivery_status || null,
    last_error: w.last_error || null,
    created_at: w.created_at || null, updated_at: w.updated_at || null,
  };