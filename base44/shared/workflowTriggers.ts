// Emitters for the two DOCUMENTED Base44 workflow triggers that fire from PLATFORM lifecycle
// paths rather than from a caller:
//   • app_publish — the project's successful production LIVE publication;
//   • app_payment — a successfully settled payment or refund (the platform's billing processor).
// Both dispatch through the ONE existing dispatch entry point (dispatchWorkflowEvent), so
// authorization, idempotency, version pinning and the bounded context are the ENGINE's existing
// behavior, unchanged. Both emitters are fail-safe: their host paths (the deployment outcome and
// billing settlement) are already durable when they run, and a dispatch failure never breaks them.
import { boundValue } from "./workflowContract.ts";
import { scrub } from "./tracing.ts";

const svcOf = (b) => b.asServiceRole || b;

/**
 * app_publish: one event per successful production LIVE deployment. The deployment id is the
 * idempotency key, so a recovered or re-run worker can never fire the publication twice.
 */
export async function emitAppPublish(base44, {
  project, workspace_id, deployment_id, version_number = null, deployment_url = null, trace_id = null,
} = {}) {
  try {
    const { dispatchWorkflowEvent } = await import("./workflowEngine.ts");
    return await dispatchWorkflowEvent(base44, {
      project, workspace: { id: workspace_id }, source: "app_publish", event: null,
      payload: boundValue(scrub({ deployment_id, version_number, deployment_url }), 1000),
      idempotency_key: `app_publish:${deployment_id}`, actor: "system", triggered_by: null, trace_id,
    });
  } catch { return null; }
}

/**
 * app_payment: one event per successfully settled payment or refund, dispatched to every project
 * of the workspace (a billing event is workspace-scoped; a project without a matching workflow
 * costs only the empty candidate query). The billing event's id is the idempotency key — the
 * processor's own replay protection already stops duplicates upstream.
 */
export async function emitAppPayment(base44, { workspace_id, event, trace_id = null } = {}) {
  try {
    const { dispatchWorkflowEvent } = await import("./workflowEngine.ts");
    const svc = svcOf(base44);
    const projects = await svc.entities.Project.filter({ workspace_id }, "created_date", 50).catch(() => []);
    const payload = boundValue(scrub({
      billing_event_id: event?.id || null, event_type: event?.event_type || null,
      amount_cents: event?.amount_cents ?? 0, currency: event?.currency || null,
      plan_code: event?.plan_code || null, provider: event?.provider || null,
    }), 1000);
    const results = [];
    for (const project of projects) {
      results.push(await dispatchWorkflowEvent(base44, {
        project, workspace: { id: workspace_id }, source: "app_payment", event: null,
        payload, idempotency_key: `app_payment:${event?.id || ""}`, actor: "system", triggered_by: null, trace_id,
      }).catch(() => null));
    }
    return { projects: projects.length, results };
  } catch { return null; }
}

/**
 * app_user_auth: one event per app-user signup or login, dispatched to the project's matching
 * finalized workflows. DOCUMENTED (Base44): "Fires when an app user signs up or logs in." The
 * auth path that calls this is ALREADY durable when it runs (the AppUser row exists; for login,
 * the session exists too), and a dispatch failure never breaks auth — the emitter is fail-safe
 * and returns null on any error, exactly like emitAppPublish/emitAppPayment.
 *
 * Deterministic idempotency: signup is keyed by user_id (a user signs up once); login is keyed by
 * user_id + session_id, so each login — a distinct session — fires exactly once. No targeting
 * field is carried: Base44 publishes none; signup-vs-login routing is a workflow condition step.
 */
export async function emitAppUserAuth(base44, { project, workspace_id, user_id, event_type, session_id = null, trace_id = null } = {}) {
  try {
    const { dispatchWorkflowEvent } = await import("./workflowEngine.ts");
    const key = `app_user_auth:${user_id || ""}:${event_type}${session_id ? `:${session_id}` : ""}`;
    return await dispatchWorkflowEvent(base44, {
      project, workspace: { id: workspace_id }, source: "app_user_auth", event: null,
      payload: boundValue(scrub({ user_id: user_id || null, event_type, session_id: session_id || null }), 1000),
      idempotency_key: key, actor: "system", triggered_by: null, trace_id,
    });
  } catch { return null; }
}

/**
 * connector: one event for a connector-tool delivery, dispatched to the project's matching
 * finalized workflows. DOCUMENTED (Base44): a connector trigger "fires when a connected tool
 * sends an event." The audit confirmed only the two targeting fields Base44 publishes — which
 * connector (connector) and which event name (event) — so those are the only matching keys; the
 * payload is the connector event, bounded by the engine's own context bound.
 *
 * WHAT IS DELIBERATELY NOT HERE: provider webhook ingestion, provider signature verification,
 * the per-connector event catalog and connected-account targeting are all UNKNOWN and out of
 * scope. The caller of emitConnector is responsible for having ALREADY verified the delivery as a
 * recognized, authorized connector event (mirroring the existing appWebhook/githubWebhook pattern);
 * this emitter only turns a verified connector event into a workflow dispatch. It reuses the ONE
 * existing dispatch entry point (dispatchWorkflowEvent), so project isolation, FINALIZED-only
 * matching, trigger-idempotency and the bounded context are the engine's own semantics.
 *
 * Deterministic idempotency: the caller-supplied delivery_id is the idempotency key, so a
 * redelivered connector event resolves to the FIRST run instead of starting a second one — the
 * same mechanism app_publish/app_payment/app_user_auth use.
 */
export async function emitConnector(base44, {
  project, workspace_id, connector, event, payload = null, delivery_id = null, trace_id = null,
} = {}) {
  if (!project || !connector || !event) return null;
  try {
    const { dispatchWorkflowEvent } = await import("./workflowEngine.ts");
    return await dispatchWorkflowEvent(base44, {
      project, workspace: { id: workspace_id }, source: "connector",
      event: String(event), entity: String(connector),
      payload: boundValue(scrub(payload), 1000),
      idempotency_key: delivery_id ? `connector:${project.id}:${connector}:${delivery_id}` : null,
      actor: "system", triggered_by: null, trace_id,
    });
  } catch { return null; }
}