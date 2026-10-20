// End-to-end verification of the public webhook endpoint's security and delivery reliability.
//
// The endpoint's real request handler is invoked with real signed requests against a real
// throwaway project, so every check exercises the shipping code path: signing, freshness,
// replay, rate limiting, audit, and the retry → dead-letter behaviour of a failing delivery.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleWebhookRequest } from "../../shared/webhookEndpoint.ts";
import { computeSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER, SIGNING_SECRET_NAME, REPLAY_WINDOW_MS, WEBHOOK_RATE_LIMIT } from "../../shared/webhookSecurity.ts";
import { encryptSecretValue } from "../../shared/secretCrypto.ts";
import { runJobs } from "../../shared/jobQueue.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";
import { functionPath } from "../../shared/functionPaths.ts";

const SECRET = "whsec_e2e_test_secret_9f3a2b71";

const OK_FN = `export const config = { webhook: true };
export default async function (ctx) {
  return { status: 200, body: { ok: true, event: ctx.request.body?.event ?? null, method: ctx.request.method } };
}`;

const FAILING_FN = `export const config = { webhook: true };
export default async function () {
  throw new Error("downstream unavailable");
}`;

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const origin = new URL(req.url).origin;
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail: String(detail ?? "") });
  const bad = (name, detail) => checks.push({ name, ok: false, detail: String(detail ?? "") });
  const expect = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));
  const cleanup = [];

  try {
    const ws = await svc.entities.Workspace.create({ name: "Webhook Test Workspace", owner_id: `wh-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    cleanup.push(() => svc.entities.Workspace.delete(ws.id));
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "Webhook Test Project", slug: `wh-${crypto.randomUUID().slice(0, 8)}` });
    cleanup.push(() => svc.entities.Project.delete(project.id));

    const secretRow = await svc.entities.ProjectSecret.create({
      project_id: project.id, name: SIGNING_SECRET_NAME, required: true,
      value: await encryptSecretValue(project.id, SIGNING_SECRET_NAME, SECRET),
    });
    cleanup.push(() => svc.entities.ProjectSecret.delete(secretRow.id));

    for (const [name, source] of [["hookOk", OK_FN], ["hookFail", FAILING_FN]]) {
      const file = await svc.entities.ProjectFile.create({ project_id: project.id, path: functionPath(name), content: source });
      cleanup.push(() => svc.entities.ProjectFile.delete(file.id));
    }

    // One signed delivery. `body` is the exact string that gets signed and sent.
    const deliver = async (fn, body, { signature, timestamp, omitHeaders = false } = {}) => {
      const ts = timestamp ?? String(Date.now());
      const sig = signature ?? (await computeSignature(SECRET, ts, body));
      const headers = { "content-type": "application/json", ...(omitHeaders ? {} : { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: sig }) };
      const res = await handleWebhookRequest(svc, new Request(`${origin}/functions/appWebhook?project_id=${project.id}&fn=${fn}`, { method: "POST", headers, body }));
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // --- 1. a valid signed webhook succeeds, with the payload behaviour unchanged ---------
    const payload = JSON.stringify({ event: "order.created", id: 42 });
    const good = await deliver("hookOk", payload);
    expect("valid_signature_accepted", good.status === 200 && good.body?.ok === true, `status=${good.status} body=${JSON.stringify(good.body)}`);
    expect("payload_behavior_unchanged", good.body?.event === "order.created" && good.body?.method === "POST", "the function saw the same method, body and result shape as before");

    // --- 2. missing signature ------------------------------------------------------------
    const unsigned = await deliver("hookOk", JSON.stringify({ event: "unsigned" }), { omitHeaders: true });
    expect("missing_signature_rejected", unsigned.status === 401 && unsigned.body?.code === "MISSING_SIGNATURE", `status=${unsigned.status} code=${unsigned.body?.code}`);

    // --- 3. invalid signature ------------------------------------------------------------
    const forged = await deliver("hookOk", JSON.stringify({ event: "forged" }), { signature: "f".repeat(64) });
    expect("invalid_signature_rejected", forged.status === 401 && forged.body?.code === "INVALID_SIGNATURE", `status=${forged.status} code=${forged.body?.code}`);
    // A signature valid for a DIFFERENT body must not authenticate this one.
    const tsSwap = String(Date.now());
    const swapped = await deliver("hookOk", JSON.stringify({ event: "tampered" }), { timestamp: tsSwap, signature: await computeSignature(SECRET, tsSwap, JSON.stringify({ event: "original" })) });
    expect("tampered_body_rejected", swapped.status === 401 && swapped.body?.code === "INVALID_SIGNATURE", `status=${swapped.status} code=${swapped.body?.code}`);

    // --- 4. expired timestamp ------------------------------------------------------------
    const oldTs = String(Date.now() - REPLAY_WINDOW_MS - 60000);
    const expired = await deliver("hookOk", JSON.stringify({ event: "old" }), { timestamp: oldTs });
    expect("expired_timestamp_rejected", expired.status === 401 && expired.body?.code === "EXPIRED_TIMESTAMP", `status=${expired.status} code=${expired.body?.code}`);

    // --- 5. replay -----------------------------------------------------------------------
    const replayTs = String(Date.now());
    const replayBody = JSON.stringify({ event: "replay.me" });
    const replaySig = await computeSignature(SECRET, replayTs, replayBody);
    const first = await deliver("hookOk", replayBody, { timestamp: replayTs, signature: replaySig });
    const second = await deliver("hookOk", replayBody, { timestamp: replayTs, signature: replaySig });
    expect("replay_rejected", first.status === 200 && second.status === 409 && second.body?.code === "REPLAYED_REQUEST", `first=${first.status} replay=${second.status}/${second.body?.code}`);

    // --- 6. failed delivery retries and eventually dead-letters --------------------------
    const failing = await deliver("hookFail", JSON.stringify({ event: "will.fail" }));
    expect("failed_delivery_reported", failing.status >= 500, `status=${failing.status}`);
    const queued = (await svc.entities.BackgroundJob.filter({ queue: "webhooks", project_id: project.id }, "-created_date", 5))[0] || null;
    for (const j of await svc.entities.BackgroundJob.filter({ queue: "webhooks", project_id: project.id }, "-created_date", 5)) cleanup.push(() => svc.entities.BackgroundJob.delete(j.id));
    expect("retry_enqueued", !!queued && queued.job_type === "webhook.deliver" && queued.status === "pending", `job=${queued?.id} status=${queued?.status} max_attempts=${queued?.max_attempts}`);

    let ticks = 0;
    let job = queued;
    // Each tick is one worker pass; backoff is skipped by making the job due, which is what
    // waiting out the delay would do.
    while (job && job.status !== "dead_letter" && ticks < (job.max_attempts || 6) + 3) {
      await svc.entities.BackgroundJob.update(job.id, { available_at: new Date().toISOString() });
      await runJobs(svc, { queue: "webhooks", handlers: MAINTENANCE_HANDLERS, worker_id: `wh_test_${ticks}`, max_jobs: 1, budget_ms: 8000 });
      job = await svc.entities.BackgroundJob.get(queued.id);
      ticks++;
      if (ticks === 1) expect("retry_attempted_with_backoff", job.attempts >= 1 && (job.status === "pending" || job.status === "dead_letter"), `attempt ${job.attempts}, status ${job.status}, log ${job.attempt_log?.length || 0} entr(ies)`);
    }
    expect("dead_letter_reached", job?.status === "dead_letter" && (job.attempts || 0) >= 2, `status=${job?.status} attempts=${job?.attempts} code=${job?.error_code}`);

    // --- 7. durable rate limiting --------------------------------------------------------
    // The limiter is shared, so the project's window is filled directly and the next real
    // delivery must be refused before any signature work.
    const identity = `webhook:${project.id}:ip:unknown`;
    const windowKey = new Date(Math.floor(Date.now() / WEBHOOK_RATE_LIMIT.window_ms) * WEBHOOK_RATE_LIMIT.window_ms).toISOString();
    const bucket = (await svc.entities.RateLimitBucket.filter({ identity, action: "webhook", window_key: windowKey }, "-created_date", 1))[0];
    if (bucket) await svc.entities.RateLimitBucket.update(bucket.id, { count: WEBHOOK_RATE_LIMIT.limit });
    else cleanup.push(async () => {
      const r = (await svc.entities.RateLimitBucket.filter({ identity, action: "webhook" }, "-created_date", 5));
      for (const b of r) await svc.entities.RateLimitBucket.delete(b.id).catch(() => {});
    });
    if (bucket) cleanup.push(() => svc.entities.RateLimitBucket.delete(bucket.id));
    const limited = await deliver("hookOk", JSON.stringify({ event: "flood" }));
    expect("rate_limit_enforced", limited.status === 429 && limited.body?.code === "RATE_LIMITED", `status=${limited.status} code=${limited.body?.code} (bucket ${bucket ? "filled" : "missing"})`);

    // --- 8. audit trail ------------------------------------------------------------------
    const logs = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 50);
    for (const l of logs) cleanup.push(() => svc.entities.AuditLog.delete(l.id));
    const actions = logs.map((l) => l.action);
    expect("accepted_audited", actions.includes("webhook.accepted"), `${actions.filter((a) => a === "webhook.accepted").length} accepted row(s)`);
    expect("rejected_audited", actions.includes("webhook.rejected"), `${actions.filter((a) => a === "webhook.rejected").length} rejected row(s)`);
    expect("failed_delivery_audited", actions.includes("webhook.delivery_failed"), `${actions.filter((a) => a === "webhook.delivery_failed").length} failed row(s)`);
    expect("audit_carries_no_secret", !JSON.stringify(logs).includes(SECRET), `${logs.length} audit row(s) scanned`);
  } catch (e) {
    bad("suite_execution", `${e.message}`);
  } finally {
    for (const c of await svc.entities.CacheEntry.filter({ namespace: "webhook_replay" }, "-created_date", 20).catch(() => [])) {
      await svc.entities.CacheEntry.delete(c.id).catch(() => {});
    }
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed, checks });
}