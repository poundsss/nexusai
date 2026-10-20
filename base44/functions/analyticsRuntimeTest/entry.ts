// FOCUSED test for the newly wired analytics runtime surface (#30) — not the full certification.
//
// It exercises exactly the code the public `analytics` action executes: the shared runtime
// dispatcher, over real entities, in a scratch workspace that is deleted again at the end.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { handleAnalyticsRuntime, ANALYTICS_RUNTIME_OPS } from "../../shared/analyticsRuntime.ts";

const nowIso = () => new Date().toISOString();

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let workspace = null, project = null, other = null;

  try {
    workspace = await svc.entities.Workspace.create({ name: "Analytics Runtime #30", owner_id: `ar-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: "Analytics Runtime", slug: `ar-${crypto.randomUUID().slice(0, 8)}` });
    other = await svc.entities.Project.create({ workspace_id: workspace.id, name: "Other App", slug: `ao-${crypto.randomUUID().slice(0, 8)}` });
    const user = await svc.entities.AppUser.create({ project_id: project.id, workspace_id: workspace.id, email: "u@example.com", status: "active", roles: ["user"], created_at: nowIso() });
    const foreign = await svc.entities.AppUser.create({ project_id: other.id, workspace_id: workspace.id, email: "f@example.com", status: "active", roles: ["user"], created_at: nowIso() });

    const call = (op, args, { user: u = null } = {}) => handleAnalyticsRuntime(svc, { project, environment: "production", user: u, op, args });

    // 1) contract + op allowlist
    const contract = await call("contract", {});
    h.check("contract exposes the client API", !!contract.contract.client_api.includes("trackEvent"), contract.contract.contract_version);
    await h.expectThrow("an unknown op is refused", () => call("sneak", {}), "ANALYTICS_OP_UNSUPPORTED");
    h.check("op allowlist is closed", ANALYTICS_RUNTIME_OPS.length === 8, ANALYTICS_RUNTIME_OPS.join(","));

    // 2) sessions: created once, idempotent by key
    const s1 = await call("session_start", { session_key: "sess-1", page: "/home" });
    const s2 = await call("session_start", { session_key: "sess-1" });
    h.check("session_start creates then reuses", s1.created === true && s2.created === false, `${s1.session.session_id}`);

    // 3) anonymous tracking is attributed to the session, not to a user
    const anon = await call("track", { event_name: "page_view", event_type: "page_view", page: "/home", session_key: "sess-1", properties: { plan: "free", steps: 3 } });
    h.check("anonymous event stored with session + no user", anon.event.session_id === s1.session.session_id && anon.event.app_user_id === null, anon.event.event_id);
    h.check("event environment is server-resolved", anon.event.environment === "production" && anon.event.source === "client");

    // 4) authenticated tracking is attributed to the VERIFIED caller
    const authed = await call("track", { event_name: "checkout", event_type: "conversion", conversion_value: 12.5, session_key: "sess-1" }, { user: { id: user.id } });
    h.check("authenticated event attributed to caller", authed.event.app_user_id === user.id && authed.event.conversion_value === 12.5);

    // 5) credential-like properties never reach storage
    await h.expectThrow("credential property refused", () => call("track", { event_name: "leak", properties: { api_key: "sk_live_abcdefghijklmnop" } }), "ANALYTICS_CREDENTIAL_PROPERTY");
    await h.expectThrow("nested object property refused", () => call("track", { event_name: "bad", properties: { nested: { a: 1 } } }), "ANALYTICS_PROPERTY_TYPE");

    // 6) idempotency: the same ingestion key returns the FIRST event
    const k = `idem-${Date.now()}`;
    const first = await call("track", { event_name: "signup", ingestion_key: k });
    const again = await call("track", { event_name: "signup", ingestion_key: k });
    h.check("ingestion key deduplicates", again.duplicate === true && again.event.event_id === first.event.event_id);

    // 7) identity linking is caller-bound and never crosses projects
    await h.expectThrow("link_identity requires a signed-in caller", () => call("link_identity", { session_key: "sess-1" }), "AUTH_REQUIRED");
    const linked = await call("link_identity", { session_key: "sess-1" }, { user: { id: user.id } });
    h.check("anonymous session links + backfills", linked.session.app_user_id === user.id && linked.events_backfilled >= 1, `backfilled=${linked.events_backfilled}`);
    await h.expectThrow("foreign user cannot be linked", () => call("link_identity", { session_key: "sess-1" }, { user: { id: foreign.id } }), "ANALYTICS_IDENTITY_CROSS_PROJECT");

    // 8) batch + queued ingestion (the EXISTING job queue, no second worker)
    const batch = await call("track_batch", { events: [{ event_name: "a" }, { event_name: "b", properties: { token: "x" } }] });
    h.check("batch accepts good and reports bad", batch.accepted === 1 && batch.rejected === 1, JSON.stringify(batch.failures));
    const queued = await call("track_async", { events: [{ event_name: "queued_event" }], idempotency_key: `q-${Date.now()}` });
    const job = await svc.entities.BackgroundJob.get(queued.job_id);
    h.check("async ingestion enqueues on the analytics queue", job.queue === "analytics" && job.job_type === "analytics.ingest" && job.project_id === project.id, job.status);

    // 9) session_end closes the session
    const ended = await call("session_end", { session_key: "sess-1" });
    h.check("session_end marks it ended", ended.session.status === "ended" && !!ended.session.ended_at);

    // 10) isolation: another project's runtime sees none of these events
    const foreignEvents = await svc.entities.AppAnalyticsEvent.filter({ project_id: other.id }, "-created_date", 10);
    h.check("events never leak into another project", foreignEvents.length === 0);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const p of [project, other].filter(Boolean)) {
      for (const name of ["AppAnalyticsEvent", "AppAnalyticsSession", "AppAnalyticsConfig", "AppEventSchema", "AppUser", "AppRole", "BackgroundJob"]) {
        await purgeBy(svc, name, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    await cleanupWorkspace(svc, workspace?.id, ["BackgroundJob", "AuditLog", "TraceEvent"]);
  }
}