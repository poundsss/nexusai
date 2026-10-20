// The public webhook endpoint's request handling, in one place so the shipping endpoint and
// the end-to-end test exercise exactly the same code.
//
// Authenticity is proven by the REQUEST, before any project code runs: every delivery must
// carry a fresh timestamp and an HMAC-SHA256 signature made with the receiving project's own
// WEBHOOK_SIGNING_SECRET. The gate in webhookSecurity.ts applies a durable rate limit, then
// rejects missing, invalid, expired and replayed signatures. A request failing any of those
// checks never reaches the function executor.
//
// Authorization beyond that is unchanged: the function must still opt in with
// `export const config = { webhook: true }`, and the payload it receives — method, query,
// headers, body — is exactly what it always was.
import { verifyWebhookRequest, WebhookRejected, clientIp } from "./webhookSecurity.ts";
import { runWebhookFunction, scheduleWebhookRetry, isFailedDelivery } from "./webhookDelivery.ts";
import { audit } from "./authz.ts";

const STRIPPED_HEADERS = ["authorization", "cookie", "x-forwarded-for"];

export async function handleWebhookRequest(svc, req) {
  let project = null;
  let name = null;

  const record = async (action, metadata) => {
    if (!project) return;
    await audit(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: null,
      action, resource: "Webhook", resource_id: name || "unknown", metadata,
    }).catch(() => {});
  };

  try {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id");
    name = url.searchParams.get("fn");
    if (!projectId || !name) return Response.json({ error: "project_id and fn query parameters are required" }, { status: 400 });

    project = await svc.entities.Project.get(projectId).catch(() => null);
    if (!project) return Response.json({ error: "Not found" }, { status: 404 });

    // The raw bytes are what the signature covers, so they are read once and verified as-is.
    const raw = await req.text();
    const allHeaders = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const headers = Object.fromEntries(Object.entries(allHeaders).filter(([k]) => !STRIPPED_HEADERS.includes(k)));
    const ip = clientIp(allHeaders);

    const verified = await verifyWebhookRequest(svc, { project, name, rawBody: raw, now: Date.now(), headers: allHeaders });

    let payload = null;
    if (raw) { try { payload = JSON.parse(raw); } catch { payload = raw; } }

    const request = {
      method: req.method.toUpperCase(),
      query: Object.fromEntries([...url.searchParams.entries()].filter(([k]) => k !== "project_id" && k !== "fn")),
      headers,
      body: payload,
    };

    let result;
    try {
      result = await runWebhookFunction(svc, { project, name, request });
    } catch (e) {
      // The function could not be run at all: the verified delivery is queued rather than lost.
      const retry = await scheduleWebhookRetry(svc, { project, name, request, delivery_id: verified.delivery_id, reason: e.message }).catch(() => null);
      await record("webhook.delivery_failed", { fn: name, ip, error: String(e.message).slice(0, 300), retry_job_id: retry?.job_id || null, max_attempts: retry?.max_attempts || null });
      return Response.json({ error: e.message, code: "WEBHOOK_DELIVERY_FAILED", retry_scheduled: !!retry }, { status: e.status || 500 });
    }

    if (isFailedDelivery(result.status)) {
      const retry = await scheduleWebhookRetry(svc, { project, name, request, delivery_id: verified.delivery_id, reason: `status ${result.status}` }).catch(() => null);
      await record("webhook.delivery_failed", { fn: name, ip, status: result.status, retry_job_id: retry?.job_id || null, max_attempts: retry?.max_attempts || null });
    } else {
      await record("webhook.accepted", { fn: name, ip, status: result.status, delivery_id: verified.delivery_id, remaining: verified.rate_limit?.remaining ?? null });
    }

    return Response.json(result.body ?? { ok: result.status < 400 }, { status: result.status });
  } catch (error) {
    if (error instanceof WebhookRejected) {
      await record("webhook.rejected", { fn: name, code: error.code, reason: error.message.slice(0, 200) });
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}