// Focused certification for #32 Stage 2 — GitHub Push Webhook → Auto-Import.
//
// Everything runs through the REAL shared handler (handleGithubWebhook) and the REAL shared
// verification module (githubWebhook.ts), against throwaway projects. Only the network
// boundary to api.github.com is scripted, for the github.ts webhook management functions.
//
// Scope: webhook verification, parsing, replay protection, repo/branch/project isolation,
// import enqueue, and audit. The existing durable import worker (runGitSyncStep) is NOT
// driven here — Stage 1 already certifies it end-to-end; this suite certifies that a valid
// push event enqueues exactly one QUEUED GitSyncRun with the correct idempotency key.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy } from "../../shared/testHarness.ts";
import {
  computeGithubSignature, constantTimeEqual, generateWebhookSecret,
  storeWebhookSecret, storeWebhookToken, readWebhookToken, deleteWebhookToken,
  handleGithubWebhook, parsePushEvent, claimDeliveryOnce,
  GITHUB_EVENT_HEADER, GITHUB_DELIVERY_HEADER, GITHUB_SIGNATURE_HEADER,
} from "../../shared/githubWebhook.ts";
import { createWebhook, deleteWebhook, listWebhooks, GitHubError, toBase64 } from "../../shared/github.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a GitHub push event payload for a repo+branch+headSha.
const pushEvent = (repo, branch, headSha, extra = {}) => JSON.stringify({
  ref: `refs/heads/${branch}`,
  repository: { full_name: repo, pushed_at: new Date().toISOString() },
  head_commit: { id: headSha, timestamp: new Date().toISOString(), message: "test push" },
  after: headSha,
  ...extra,
});

const hdr = (event, deliveryId, sig) => ({
  "content-type": "application/json",
  [GITHUB_EVENT_HEADER]: event,
  [GITHUB_DELIVERY_HEADER]: deliveryId,
  [GITHUB_SIGNATURE_HEADER]: sig ? `sha256=${sig}` : "",
});

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const realFetch = globalThis.fetch;

  // Scripted GitHub API for webhook management (createWebhook/deleteWebhook/listWebhooks).
  let ghHits = 0;
  const ghHooks = {}; // repo → [{id, url, events, active}]
  let hookSeq = 1000;

  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.github.com") return realFetch(url, options);
    ghHits++;
    const path = u.pathname;
    const method = String(options.method || "GET").toUpperCase();
    const ghJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    // POST /repos/:owner/:repo/hooks — createWebhook
    const createMatch = path.match(/^\/repos\/([^/]+\/[^/]+)\/hooks$/) && method === "POST";
    if (createMatch) {
      const repo = path.match(/^\/repos\/([^/]+\/[^/]+)\/hooks$/)[1];
      const body = JSON.parse(options.body);
      const id = ++hookSeq;
      if (!ghHooks[repo]) ghHooks[repo] = [];
      ghHooks[repo].push({ id, url: body.config?.url, events: body.events || ["push"], active: body.active !== false, config: body.config });
      return ghJson({ id, config: body.config, events: body.events, active: true });
    }

    // GET /repos/:owner/:repo/hooks — listWebhooks
    const listMatch = path.match(/^\/repos\/([^/]+\/[^/]+)\/hooks$/) && method === "GET";
    if (listMatch) {
      const repo = path.match(/^\/repos\/([^/]+\/[^/]+)\/hooks$/)[1];
      return ghJson(ghHooks[repo] || []);
    }

    // DELETE /repos/:owner/:repo/hooks/:id — deleteWebhook
    const delMatch = path.match(/^\/repos\/([^/]+\/[^/]+)\/hooks\/(\d+)$/) && method === "DELETE";
    if (delMatch) {
      const [, repo, idStr] = path.match(/^\/repos\/([^/]+\/[^/]+)\/hooks\/(\d+)$/);
      const id = Number(idStr);
      if (ghHooks[repo]) ghHooks[repo] = ghHooks[repo].filter((hk) => hk.id !== id);
      return new Response(null, { status: 204 });
    }

    return ghJson({ message: `unexpected ${method} ${path}` }, 404);
  };

  let workspace = null, otherWs = null;
  let project = null, otherProj = null;
  let link = null, otherLink = null;
  let webhook = null, otherWebhook = null;
  let secret = null, otherSecret = null;

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `WH ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    otherWs = await svc.entities.Workspace.create({ name: `WH Other ${Date.now()}`, owner_id: `other_${Date.now()}`, credits_balance: 0 });
    // R-8 fixture: GitHub requires Builder+, so the test workspaces carry an active Builder plan.
    for (const w of [workspace, otherWs]) await svc.entities.Subscription.create({ workspace_id: w.id, plan_code: "builder_monthly", status: "active" });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `WH ${Date.now()}`, slug: `wh-${Date.now()}` });
    otherProj = await svc.entities.Project.create({ workspace_id: otherWs.id, name: `WH Other ${Date.now()}`, slug: `who-${Date.now()}` });

    link = await svc.entities.GitHubLink.create({
      project_id: project.id, workspace_id: workspace.id, connector_id: "test-connector",
      connected_login: "test-user", connected_by: caller.id, repo_full_name: "test-org/test-repo",
      repo_default_branch: "main", branch: "main", subdirectory: "", status: "connected",
      connected_at: new Date().toISOString(),
    });
    otherLink = await svc.entities.GitHubLink.create({
      project_id: otherProj.id, workspace_id: otherWs.id, connector_id: "test-connector",
      connected_login: "other-user", connected_by: `other_${Date.now()}`, repo_full_name: "test-org/other-repo",
      repo_default_branch: "main", branch: "main", subdirectory: "", status: "connected",
      connected_at: new Date().toISOString(),
    });

    // ---- 1. Signature computation and constant-time comparison ----
    const testSig = await computeGithubSignature("test-secret", "hello world");
    h.check("1a. computeGithubSignature returns a hex string", /^[0-9a-f]{64}$/.test(testSig), testSig);
    h.check("1b. constantTimeEqual matches identical strings", constantTimeEqual(testSig, testSig), "");
    h.check("1c. constantTimeEqual rejects different strings", !constantTimeEqual(testSig, "deadbeef"), "");
    h.check("1d. constantTimeEqual rejects different lengths", !constantTimeEqual("abc", "abcd"), "");

    // ---- 2. parsePushEvent ----
    const validPush = JSON.parse(pushEvent("test-org/test-repo", "main", "abc123def456"));
    const parsed = parsePushEvent(validPush);
    h.check("2a. parsePushEvent extracts repo", parsed.repo === "test-org/test-repo", parsed.repo);
    h.check("2b. parsePushEvent extracts branch from refs/heads/", parsed.branch === "main", parsed.branch);
    h.check("2c. parsePushEvent extracts headSha", parsed.headSha === "abc123def456", parsed.headSha);

    h.check("2d. parsePushEvent rejects non-object", (() => { try { parsePushEvent(null); return false; } catch (e) { return e.code === "WEBHOOK_MALFORMED_PAYLOAD"; } })());
    h.check("2e. parsePushEvent rejects missing repo", (() => { try { parsePushEvent({ ref: "refs/heads/main", head_commit: { id: "abc" } }); return false; } catch (e) { return e.code === "WEBHOOK_MALFORMED_PAYLOAD"; } })());
    h.check("2f. parsePushEvent rejects missing ref", (() => { try { parsePushEvent({ repository: { full_name: "a/b" }, head_commit: { id: "abc" } }); return false; } catch (e) { return e.code === "WEBHOOK_MALFORMED_PAYLOAD"; } })());
    h.check("2g. parsePushEvent rejects missing head commit", (() => { try { parsePushEvent({ repository: { full_name: "a/b" }, ref: "refs/heads/main" }); return false; } catch (e) { return e.code === "WEBHOOK_MALFORMED_PAYLOAD"; } })());

    // ---- 3. Registration: store secret + token, create GitHubWebhook record ----
    secret = generateWebhookSecret();
    h.check("3a. generateWebhookSecret returns a 64-char hex string", /^[0-9a-f]{64}$/.test(secret), secret.slice(0, 16) + "...");
    await storeWebhookSecret(svc, project.id, secret);
    const tokenName = await storeWebhookToken(svc, workspace.id, project.id, "ghp_test_token_1234567890");
    h.check("3b. storeWebhookToken returns the token name", tokenName === `GITHUB_WEBHOOK_TOKEN_${project.id}`, tokenName);

    // Verify the secret is encrypted at rest (ProjectSecret value is not plaintext).
    const secretRow = (await svc.entities.ProjectSecret.filter({ project_id: project.id, name: "GITHUB_WEBHOOK_SECRET" }, "name", 1))[0];
    h.check("3c. webhook secret is stored encrypted (not plaintext)", !!secretRow?.value && secretRow.value !== secret && secretRow.value.startsWith("enc:v1:"), String(secretRow?.value || "").slice(0, 10));

    // Verify the token is stored encrypted (WorkspaceSecret value is not plaintext).
    const tokenRow = (await svc.entities.WorkspaceSecret.filter({ workspace_id: workspace.id, name: tokenName }, "name", 1))[0];
    h.check("3d. webhook token is stored encrypted (not plaintext)", !!tokenRow?.value && tokenRow.value !== "ghp_test_token_1234567890" && tokenRow.value.startsWith("enc:v1:"), String(tokenRow?.value || "").slice(0, 10));

    // Read the token back — should decrypt correctly.
    const readTok = await readWebhookToken(svc, workspace.id, project.id);
    h.check("3e. readWebhookToken decrypts the stored token", readTok === "ghp_test_token_1234567890", readTok ? "present" : "null");

    // Create the GitHub webhook via the API (mocked).
    const hook = await createWebhook("ghp_test_token", "test-org/test-repo", { url: `https://app.example.com/functions/githubWebhook?project_id=${project.id}`, secret, events: ["push"] });
    h.check("3f. createWebhook returns a hook id", typeof hook.id === "number" && hook.id > 0, String(hook.id));

    // Create the GitHubWebhook record.
    webhook = await svc.entities.GitHubWebhook.create({
      project_id: project.id, workspace_id: workspace.id, github_link_id: link.id,
      repo_full_name: "test-org/test-repo", branch: "main",
      webhook_secret_name: "GITHUB_WEBHOOK_SECRET", webhook_token_name: tokenName,
      github_hook_id: hook.id, webhook_url: `https://app.example.com/functions/githubWebhook?project_id=${project.id}`,
      active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    h.check("3g. GitHubWebhook record created", !!webhook.id, webhook.id);

    // List webhooks via the API (mocked).
    const hooks = await listWebhooks("ghp_test_token", "test-org/test-repo");
    h.check("3h. listWebhooks returns the created hook", hooks.length === 1 && hooks[0].id === hook.id, String(hooks.length));

    // ---- 4. Valid push event → import enqueued ----
    const delivery1 = `del-${Date.now()}-1`;
    const headSha1 = `commit-push-${Date.now()}`;
    const rawBody1 = pushEvent("test-org/test-repo", "main", headSha1);
    const sig1 = await computeGithubSignature(secret, rawBody1);
    const res1 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody1, headers: hdr("push", delivery1, sig1), now: Date.now() });
    h.check("4a. valid push returns 202", res1.status === 202, JSON.stringify(res1));
    h.check("4b. valid push enqueues a GitSyncRun", !!res1.body?.sync_run_id, res1.body?.sync_run_id || "");

    const run1 = await svc.entities.GitSyncRun.get(res1.body.sync_run_id);
    h.check("4c. the enqueued run is an import", run1.direction === "import", run1.direction);
    h.check("4d. the enqueued run is QUEUED", run1.status === "QUEUED", run1.status);
    h.check("4e. the run has the correct commit_sha", run1.commit_sha === headSha1, run1.commit_sha);
    h.check("4f. the run has the correct repo", run1.repo_full_name === "test-org/test-repo", run1.repo_full_name);
    h.check("4g. the run has the correct branch", run1.branch === "main", run1.branch);
    h.check("4h. the run has the correct idempotency_key", run1.idempotency_key === `import:${project.id}:test-org/test-repo:${headSha1}`, run1.idempotency_key);
    h.check("4i. the run has a credential_ref (job token)", !!run1.credential_ref, run1.credential_ref);
    h.check("4j. the run has the link_id", run1.link_id === link.id, run1.link_id);
    h.check("4k. the run has no user_id (webhook-triggered)", run1.user_id === null, String(run1.user_id));

    // ---- 5. Duplicate delivery → rejected as replay ----
    const res5 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody1, headers: hdr("push", delivery1, sig1), now: Date.now() });
    h.check("5a. duplicate delivery returns 409", res5.status === 409, JSON.stringify(res5));
    h.check("5b. duplicate delivery rejected as WEBHOOK_REPLAYED", res5.body?.code === "WEBHOOK_REPLAYED", res5.body?.code);

    // ---- 6. Invalid signature → rejected ----
    const delivery6 = `del-${Date.now()}-6`;
    const res6 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody1, headers: hdr("push", delivery6, "deadbeef".repeat(8)), now: Date.now() });
    h.check("6a. invalid signature returns 401", res6.status === 401, JSON.stringify(res6));
    h.check("6b. invalid signature rejected as WEBHOOK_SIGNATURE_INVALID", res6.body?.code === "WEBHOOK_SIGNATURE_INVALID", res6.body?.code);

    // ---- 7. Missing signature → rejected ----
    const delivery7 = `del-${Date.now()}-7`;
    const res7 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody1, headers: hdr("push", delivery7, ""), now: Date.now() });
    h.check("7a. missing signature returns 401", res7.status === 401, JSON.stringify(res7));
    h.check("7b. missing signature rejected as WEBHOOK_SIGNATURE_MISSING", res7.body?.code === "WEBHOOK_SIGNATURE_MISSING", res7.body?.code);

    // ---- 8. Wrong repository → rejected ----
    const delivery8 = `del-${Date.now()}-8`;
    const rawBody8 = pushEvent("test-org/wrong-repo", "main", "wrongsha");
    const sig8 = await computeGithubSignature(secret, rawBody8);
    const res8 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody8, headers: hdr("push", delivery8, sig8), now: Date.now() });
    h.check("8a. wrong repo returns 403", res8.status === 403, JSON.stringify(res8));
    h.check("8b. wrong repo rejected as WEBHOOK_REPO_MISMATCH", res8.body?.code === "WEBHOOK_REPO_MISMATCH", res8.body?.code);

    // ---- 9. Wrong branch → rejected ----
    const delivery9 = `del-${Date.now()}-9`;
    const rawBody9 = pushEvent("test-org/test-repo", "develop", "devsha");
    const sig9 = await computeGithubSignature(secret, rawBody9);
    const res9 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody9, headers: hdr("push", delivery9, sig9), now: Date.now() });
    h.check("9a. wrong branch returns 202 (ignored, not an error)", res9.status === 202, JSON.stringify(res9));
    h.check("9b. wrong branch rejected as WEBHOOK_BRANCH_MISMATCH", res9.body?.code === "WEBHOOK_BRANCH_MISMATCH", res9.body?.code);

    // ---- 10. Cross-project isolation ----
    // Set up a second webhook for otherProj.
    otherSecret = generateWebhookSecret();
    await storeWebhookSecret(svc, otherProj.id, otherSecret);
    await storeWebhookToken(svc, otherWs.id, otherProj.id, "ghp_other_token_9876543210");
    const otherHook = await createWebhook("ghp_test_token", "test-org/other-repo", { url: `https://app.example.com/functions/githubWebhook?project_id=${otherProj.id}`, secret: otherSecret, events: ["push"] });
    otherWebhook = await svc.entities.GitHubWebhook.create({
      project_id: otherProj.id, workspace_id: otherWs.id, github_link_id: otherLink.id,
      repo_full_name: "test-org/other-repo", branch: "main",
      webhook_secret_name: "GITHUB_WEBHOOK_SECRET", webhook_token_name: `GITHUB_WEBHOOK_TOKEN_${otherProj.id}`,
      github_hook_id: otherHook.id, webhook_url: `https://app.example.com/functions/githubWebhook?project_id=${otherProj.id}`,
      active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    // Send a push for project A's repo to project B's receiver — should fail (repo mismatch or signature).
    const delivery10 = `del-${Date.now()}-10`;
    const rawBody10 = pushEvent("test-org/test-repo", "main", "crosssha");
    const sig10 = await computeGithubSignature(secret, rawBody10); // signed with project A's secret
    const res10 = await handleGithubWebhook(svc, { projectId: otherProj.id, rawBody: rawBody10, headers: hdr("push", delivery10, sig10), now: Date.now() });
    h.check("10a. project A's push to project B's receiver is rejected", res10.status !== 202, JSON.stringify(res10));
    h.check("10b. cross-project rejection is signature or repo mismatch", ["WEBHOOK_SIGNATURE_INVALID", "WEBHOOK_REPO_MISMATCH"].includes(res10.body?.code), res10.body?.code);

    // Project B's own push should work.
    const delivery10b = `del-${Date.now()}-10b`;
    const rawBody10b = pushEvent("test-org/other-repo", "main", "othersha");
    const sig10b = await computeGithubSignature(otherSecret, rawBody10b);
    const res10b = await handleGithubWebhook(svc, { projectId: otherProj.id, rawBody: rawBody10b, headers: hdr("push", delivery10b, sig10b), now: Date.now() });
    h.check("10c. project B's own push enqueues a run", res10b.status === 202 && !!res10b.body?.sync_run_id, JSON.stringify(res10b));

    // Verify project A's runs don't include project B's run.
    const projARuns = await svc.entities.GitSyncRun.filter({ project_id: project.id }, "-created_date", 50);
    const projBRuns = await svc.entities.GitSyncRun.filter({ project_id: otherProj.id }, "-created_date", 50);
    h.check("10d. project A's runs don't include project B's run", !projARuns.some((r) => r.id === res10b.body.sync_run_id), "");
    h.check("10e. project B's runs don't include project A's run", !projBRuns.some((r) => r.id === res1.body.sync_run_id), "");

    // ---- 11. Malformed payload (valid signature, invalid JSON) ----
    const delivery11 = `del-${Date.now()}-11`;
    const rawBody11 = "{ not valid json";
    const sig11 = await computeGithubSignature(secret, rawBody11);
    const res11 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody11, headers: hdr("push", delivery11, sig11), now: Date.now() });
    h.check("11a. malformed JSON returns 400", res11.status === 400, JSON.stringify(res11));
    h.check("11b. malformed JSON rejected as WEBHOOK_MALFORMED_PAYLOAD", res11.body?.code === "WEBHOOK_MALFORMED_PAYLOAD", res11.body?.code);

    // ---- 12. Non-push event → ignored ----
    const delivery12 = `del-${Date.now()}-12`;
    const rawBody12 = JSON.stringify({ action: "opened", repository: { full_name: "test-org/test-repo" } });
    const sig12 = await computeGithubSignature(secret, rawBody12);
    const res12 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody12, headers: hdr("pull_request", delivery12, sig12), now: Date.now() });
    h.check("12a. non-push event returns 202 (ignored)", res12.status === 202, JSON.stringify(res12));
    h.check("12b. non-push event rejected as WEBHOOK_EVENT_IGNORED", res12.body?.code === "WEBHOOK_EVENT_IGNORED", res12.body?.code);

    // ---- 13. Inactive webhook → rejected ----
    await svc.entities.GitHubWebhook.update(webhook.id, { active: false, updated_at: new Date().toISOString() });
    const delivery13 = `del-${Date.now()}-13`;
    const rawBody13 = pushEvent("test-org/test-repo", "main", "inactive-sha");
    const sig13 = await computeGithubSignature(secret, rawBody13);
    const res13 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody13, headers: hdr("push", delivery13, sig13), now: Date.now() });
    h.check("13a. inactive webhook returns 404", res13.status === 404, JSON.stringify(res13));
    h.check("13b. inactive webhook rejected as WEBHOOK_NOT_FOUND", res13.body?.code === "WEBHOOK_NOT_FOUND", res13.body?.code);
    // Reactivate for subsequent tests.
    await svc.entities.GitHubWebhook.update(webhook.id, { active: true, updated_at: new Date().toISOString() });

    // ---- 14. Webhook removal (delete GitHub webhook + deactivate record) ----
    const delOk = await deleteWebhook("ghp_test_token", "test-org/test-repo", hook.id);
    h.check("14a. deleteWebhook returns true", delOk === true, String(delOk));
    const hooksAfter = await listWebhooks("ghp_test_token", "test-org/test-repo");
    h.check("14b. listWebhooks returns empty after deletion", hooksAfter.length === 0, String(hooksAfter.length));
    await svc.entities.GitHubWebhook.update(webhook.id, { active: false, last_error: null, updated_at: new Date().toISOString() });
    await deleteWebhookToken(svc, workspace.id, project.id);
    const tokenGone = await readWebhookToken(svc, workspace.id, project.id);
    h.check("14c. webhook token deleted after removal", !tokenGone, tokenGone ? "present" : "gone");
    // After removal, pushes are rejected.
    const delivery14 = `del-${Date.now()}-14`;
    const rawBody14 = pushEvent("test-org/test-repo", "main", "after-remove-sha");
    const sig14 = await computeGithubSignature(secret, rawBody14);
    const res14 = await handleGithubWebhook(svc, { projectId: project.id, rawBody: rawBody14, headers: hdr("push", delivery14, sig14), now: Date.now() });
    h.check("14d. push after removal rejected as WEBHOOK_NOT_FOUND", res14.status === 404 && res14.body?.code === "WEBHOOK_NOT_FOUND", JSON.stringify(res14));

    // ---- 15. Secret never exposed ----
    // The webhook secret value should never appear in any audit log, GitSyncRun, or response.
    const allAudits = await svc.entities.AuditLog.filter({ project_id: project.id, resource: "GitHubWebhook" }, "-created_date", 50);
    const auditJson = JSON.stringify(allAudits);
    h.check("15a. webhook secret never appears in audit logs", !auditJson.includes(secret), `secret in audit: ${auditJson.includes(secret)}`);
    const allRuns = await svc.entities.GitSyncRun.filter({ project_id: project.id }, "-created_date", 50);
    const runsJson = JSON.stringify(allRuns);
    h.check("15b. webhook secret never appears in GitSyncRun records", !runsJson.includes(secret), "");
    h.check("15c. webhook secret never appears in any response body", !JSON.stringify([res1, res5, res6, res8, res9, res11, res13, res14]).includes(secret), "");

    // ---- 16. Audit trail ----
    h.check("16a. audit records github.webhook.received", allAudits.some((a) => a.action === "github.webhook.received"), `actions: ${[...new Set(allAudits.map((a) => a.action))].join(", ")}`);
    h.check("16b. audit records github.webhook.rejected", allAudits.some((a) => a.action === "github.webhook.rejected"), "");
    const importAudits = await svc.entities.AuditLog.filter({ project_id: project.id, action: "github.import.started" }, "-created_date", 10);
    h.check("16c. audit records github.import.started with webhook trigger", importAudits.some((a) => a.metadata?.trigger === "webhook"), JSON.stringify(importAudits[0]?.metadata));
    h.check("16d. audit metadata carries repo and commit_sha", allAudits.some((a) => a.metadata?.repo && a.metadata?.commit_sha), JSON.stringify(allAudits[0]?.metadata));

    // ---- 17. Webhook record state after deliveries ----
    const finalWh = await svc.entities.GitHubWebhook.get(webhook.id);
    h.check("17a. webhook records last_delivery_id", !!finalWh.last_delivery_id, finalWh.last_delivery_id);
    h.check("17b. webhook records last_delivery_at", !!finalWh.last_delivery_at, finalWh.last_delivery_at);
    h.check("17c. webhook records last_delivery_status (enqueued before removal)", finalWh.last_delivery_status === "enqueued" || finalWh.last_delivery_status === "rejected", finalWh.last_delivery_status);

    // ---- 18. Replay protection (claimDeliveryOnce) ----
    const replayId = `replay-test-${Date.now()}`;
    const claimed1 = await claimDeliveryOnce(svc, { projectId: project.id, deliveryId: replayId, now: Date.now() });
    h.check("18a. first claim succeeds", claimed1 === true, String(claimed1));
    const claimed2 = await claimDeliveryOnce(svc, { projectId: project.id, deliveryId: replayId, now: Date.now() });
    h.check("18b. second claim with same delivery ID is rejected", claimed2 === false, String(claimed2));

    // ---- 19. No project_id → 400 ----
    const res19 = await handleGithubWebhook(svc, { projectId: "", rawBody: rawBody1, headers: hdr("push", delivery1, sig1), now: Date.now() });
    h.check("19a. missing project_id returns 400", res19.status === 400, JSON.stringify(res19));

    // ---- 20. Nonexistent project → 404 ----
    const res20 = await handleGithubWebhook(svc, { projectId: "nonexistent-id", rawBody: rawBody1, headers: hdr("push", `del-${Date.now()}-20`, await computeGithubSignature(secret, rawBody1)), now: Date.now() });
    h.check("20a. nonexistent project returns 404", res20.status === 404, JSON.stringify(res20));

  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}\n${String(e.stack || "").slice(0, 600)}`);
  } finally {
    globalThis.fetch = realFetch;
    // Cleanup: delete all test entities.
    for (const p of [project, otherProj]) {
      if (!p) continue;
      for (const entity of ["GitSyncRun", "GitCommitMap", "GitHubWebhook", "GitHubLink", "ProjectVersion", "ProjectFile", "AppEntity", "Build", "AuditLog", "ProjectSecret", "CacheEntry"]) {
        await purgeBy(svc, entity, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const ws of [workspace, otherWs]) {
      if (!ws) continue;
      await purgeBy(svc, "Subscription", { workspace_id: ws.id });
      const secrets = await svc.entities.WorkspaceSecret.filter({ workspace_id: ws.id }, "-created_date", 100).catch(() => []);
      for (const s of secrets) await svc.entities.WorkspaceSecret.delete(s.id).catch(() => {});
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }

  return harnessResponse(h);
}