// In-memory regression for R-8 / PA-35 (GitHub plan entitlement). No database, no GitHub calls.
import { githubEntitlement, requireGitHubEntitlement, GITHUB_PLAN_NOT_ENTITLED } from "../../shared/githubEntitlement.ts";
import { runGitSyncStep } from "../../shared/gitSync.ts";
import { handleGithubWebhook, storeWebhookSecret, computeGithubSignature } from "../../shared/githubWebhook.ts";
import { DEFAULT_PLANS } from "../../shared/billing.ts";

export const config = { method: "POST" };

import { memStore } from "../../shared/memStoreCert.ts";

const plans = DEFAULT_PLANS.filter((p) => ["free", "starter_monthly", "builder_monthly", "pro_monthly"].includes(p.code));
const subFor = (plan_code, status = "active") => plan_code ? [{ id: "s1", workspace_id: "w1", plan_code, status, updated_date: "2026-01-01" }] : [];
const CASES = [
  ["Free (no subscription)", null, "active", false],
  ["Starter", "starter_monthly", "active", false],
  ["Builder", "builder_monthly", "active", true],
  ["Pro", "pro_monthly", "active", true],
  ["Builder canceled (expired)", "builder_monthly", "canceled", false],
  ["Builder past_due (lapsed)", "builder_monthly", "past_due", false],
];

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail ?? "").slice(0, 240) });

  // 1. The shared check, through the REAL plan resolution (effectivePlan) over in-memory rows.
  for (const [label, code, status, expected] of CASES) {
    const { svc } = memStore({ BillingPlan: plans, Subscription: subFor(code, status) });
    const e = await githubEntitlement(svc, "w1");
    add(`entitlement ${label} → ${expected ? "allowed" : "refused"}`, e.allowed === expected, e);
    const err = await requireGitHubEntitlement(svc, "w1").then(() => null, (x) => x);
    add(`require ${label}: ${expected ? "passes" : "403 " + GITHUB_PLAN_NOT_ENTITLED}`,
      expected ? err === null : err?.status === 403 && err?.code === GITHUB_PLAN_NOT_ENTITLED && /kept/.test(err.message), err ? { code: err.code, msg: err.message } : "ok");
  }
  const lapsedErr = await requireGitHubEntitlement(memStore({ BillingPlan: plans, Subscription: subFor("builder_monthly", "canceled") }).svc, "w1").catch((x) => x);
  add("expired subscription gets the 'no longer active' message", /no longer active/.test(lapsedErr.message), lapsedErr.message);
  add("no workspace fails closed", (await githubEntitlement(memStore({}).svc, null)).allowed === false, "");
  const readFail = await githubEntitlement(memStore({}).svc, "w1", { resolvePlan: async () => { throw new Error("injected"); } }).then(() => "allowed", () => "threw");
  add("a plan-read failure is never treated as entitled", readFail === "threw", readFail);

  // 2. Queued sync work re-checks the plan when it executes (downgrade after enqueue).
  const syncFixture = (code, status, runExtra = {}) => memStore({
    BillingPlan: plans, Subscription: subFor(code, status),
    Project: [{ id: "p1", workspace_id: "w1" }],
    GitHubLink: [{ id: "l1", project_id: "p1", status: "connected", repo_full_name: "o/r", branch: "main" }],
    GitSyncRun: [{ id: "run1", project_id: "p1", workspace_id: "w1", link_id: "l1", direction: "export", status: "QUEUED", version_id: "other", repo_full_name: "o/r", branch: "main", created_date: "2026-01-01", ...runExtra }],
  });
  const down = syncFixture("starter_monthly", "active");
  const out = await runGitSyncStep(down.svc, "run1");
  const run = down.tables("GitSyncRun")[0];
  const link = down.tables("GitHubLink")[0];
  add("downgraded workspace: queued sync stops FAILED with the plan code", out.status === "FAILED" && run.failure_code === GITHUB_PLAN_NOT_ENTITLED && /Builder/.test(run.failure_summary), { status: out.status, code: run.failure_code });
  add("downgrade keeps the link (not unlinked, status unchanged) and records the reason", down.tables("GitHubLink").length === 1 && link.status === "connected" && link.last_error_code === GITHUB_PLAN_NOT_ENTITLED, link);
  add("the stop is recorded in the audit trail", down.tables("AuditLog").some((a) => a.metadata?.failure_code === GITHUB_PLAN_NOT_ENTITLED), down.tables("AuditLog").length);
  const expired = syncFixture("builder_monthly", "canceled");
  await runGitSyncStep(expired.svc, "run1");
  add("expired subscription: queued sync stops with the plan code", expired.tables("GitSyncRun")[0].failure_code === GITHUB_PLAN_NOT_ENTITLED, expired.tables("GitSyncRun")[0].failure_code);
  const cancelled = syncFixture(null, "active", { cancel_requested: true });
  await runGitSyncStep(cancelled.svc, "run1");
  add("cancellation still works on a disallowed plan", cancelled.tables("GitSyncRun")[0].status === "CANCELLED", cancelled.tables("GitSyncRun")[0].status);
  const ok = syncFixture("builder_monthly", "active");
  for (let i = 0; i < 3 && !["FAILED", "COMPLETED"].includes(ok.tables("GitSyncRun")[0].status); i++) {
    ok.tables("GitSyncRun")[0].lease_expires_at = null;
    await runGitSyncStep(ok.svc, "run1");
  }
  add("Builder: the sync passes the gate and proceeds to its own checks (unchanged behavior)", ok.tables("GitSyncRun")[0].failure_code !== GITHUB_PLAN_NOT_ENTITLED && ok.tables("GitSyncRun")[0].failure_code === "SYNC_ERROR", ok.tables("GitSyncRun")[0].failure_code);

  // 3. Incoming webhook on a disallowed plan: acknowledged, skipped, recorded, delivery not burned.
  const hook = async (code, status, deliveryId) => {
    const f = memStore({
      BillingPlan: plans, Subscription: subFor(code, status),
      Project: [{ id: "p1", workspace_id: "w1" }],
      GitHubLink: [{ id: "l1", project_id: "p1", status: "connected", repo_full_name: "o/r", branch: "main" }],
      GitHubWebhook: [{ id: "h1", project_id: "p1", github_link_id: "l1", active: true, repo_full_name: "o/r", branch: "main" }],
    });
    await storeWebhookSecret(f.svc, "p1", "s3cret");
    const rawBody = JSON.stringify({ ref: "refs/heads/main", after: "abc123", repository: { full_name: "o/r" } });
    const sig = await computeGithubSignature("s3cret", rawBody);
    const res = await handleGithubWebhook(f.svc, { projectId: "p1", rawBody, headers: { "x-hub-signature-256": `sha256=${sig}`, "x-github-delivery": deliveryId, "x-github-event": "push" } });
    return { res, f };
  };
  const free = await hook(null, "active", "d1");
  add("Free webhook: acknowledged with 202 and the plan code", free.res.status === 202 && free.res.body.code === GITHUB_PLAN_NOT_ENTITLED, free.res);
  add("Free webhook: nothing enqueued or applied", free.f.tables("GitSyncRun").length === 0, free.f.tables("GitSyncRun").length);
  add("Free webhook: skip recorded on the webhook and in the audit trail",
    free.f.tables("GitHubWebhook")[0].last_delivery_status === "rejected" && free.f.tables("AuditLog").some((a) => a.metadata?.code === GITHUB_PLAN_NOT_ENTITLED && a.metadata?.skipped === true), free.f.tables("AuditLog").map((a) => a.metadata?.code));
  add("Free webhook: delivery is not claimed (not burned for a later upgrade)", free.f.tables("CacheEntry").length === 0, free.f.tables("CacheEntry").length);
  const exp = await hook("builder_monthly", "canceled", "d2");
  add("expired subscription webhook: skipped the same way", exp.res.status === 202 && exp.res.body.code === GITHUB_PLAN_NOT_ENTITLED, exp.res.body.code);
  const builder = await hook("builder_monthly", "active", "d3");
  add("Builder webhook: passes the gate (claims the delivery, continues to its existing steps)", builder.res.body.code !== GITHUB_PLAN_NOT_ENTITLED && builder.f.tables("CacheEntry").length === 1, builder.res);

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});