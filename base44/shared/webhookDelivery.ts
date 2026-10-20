// Webhook delivery: the single path that runs a project's webhook function, plus bounded retry
// and dead-lettering for deliveries that fail.
//
// Behaviour for a healthy webhook is exactly what it always was: the verified request executes
// synchronously and its result is returned to the caller. What is new is what happens when the
// delivery FAILS (the function throws, or answers 5xx). Instead of the event being lost, the
// verified delivery is handed to the durable "webhooks" queue, which retries it with exponential
// backoff up to its attempt budget and then dead-letters it with the full attempt history. A
// client error (4xx) is the function's own considered answer, so it is delivered, not retried.
import { executeProjectFunction, loadProjectFunction } from "./functionRuntime.ts";
import { loadProjectIntegrations } from "./integrations.ts";
import { enqueue, queueConfig } from "./jobQueue.ts";

const svcOf = (client) => client.asServiceRole || client;

export const WEBHOOK_QUEUE = "webhooks";
export const isFailedDelivery = (status) => Number(status) >= 500;

// Runs the project's webhook function against a verified request.
export async function runWebhookFunction(client, { project, name, request, trigger = "webhook" }) {
  const svc = svcOf(client);
  const { source } = await loadProjectFunction(svc, project.id, name);
  const entities = (await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 200))
    .map((e) => ({ id: e.id, name: e.name, fields: e.fields || {} }));
  const integrations = await loadProjectIntegrations(svc, project.id);
  return executeProjectFunction(svc, {
    project, entities, integrations, name, source, trigger, requestId: crypto.randomUUID(), request,
  });
}

// Hands a failed delivery to the durable queue. Keyed on the verified delivery id, so the same
// delivery is queued once no matter how the failure was observed.
export async function scheduleWebhookRetry(client, { project, name, request, delivery_id, reason }) {
  const cfg = queueConfig(WEBHOOK_QUEUE);
  const { job, duplicate } = await enqueue(client, {
    queue: WEBHOOK_QUEUE, job_type: "webhook.deliver",
    payload: { project_id: project.id, name, request, delivery_id, first_error: String(reason || "").slice(0, 300) },
    idempotency_key: `webhook.deliver:${project.id}:${name}:${delivery_id}`,
    workspace_id: project.workspace_id, project_id: project.id,
    max_attempts: cfg.max_attempts, delay_ms: 2000,
  });
  return { job_id: job.id, duplicate, max_attempts: job.max_attempts };
}

// The queue handler's work. Throwing is what drives retry → dead-letter in jobQueue.
export async function deliverQueuedWebhook(client, payload) {
  const svc = svcOf(client);
  const project = await svc.entities.Project.get(String(payload?.project_id || "")).catch(() => null);
  if (!project) throw Object.assign(new Error("Webhook target project no longer exists"), { retryable: false, code: "PROJECT_NOT_FOUND" });
  const name = String(payload?.name || "");
  if (!name) throw Object.assign(new Error("Webhook delivery payload has no function name"), { retryable: false, code: "INVALID_PAYLOAD" });

  const result = await runWebhookFunction(svc, { project, name, request: payload.request || {}, trigger: "webhook_retry" });
  if (isFailedDelivery(result.status)) {
    throw Object.assign(new Error(`Webhook function "${name}" failed with status ${result.status}`), { code: "WEBHOOK_DELIVERY_FAILED" });
  }
  return { project_id: project.id, name, status: result.status, delivery_id: payload.delivery_id || null };
}