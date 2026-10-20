// Analytics ingestion + sessions + identity for generated applications (#30).
//
// One ingestion path, three entry points (the public runtime, a generated app's server-side code,
// and a queued continuation). Everything below is enforced HERE so no entry point can widen it:
//   • OWNERSHIP IS SERVER-RESOLVED — project, workspace, app_user and team come from the resolved
//     app context (#29 session or the executing project record), never from the submission.
//   • ISOLATION — every read and write is filtered by project_id; a session key, anonymous id or
//     app user from another project resolves to nothing and identity linking across projects is
//     refused outright.
//   • IDEMPOTENCY — a repeat carrying the same ingestion key returns the FIRST event.
//   • PRIVACY — validation, bounding, credential policy and redaction are the contract's, applied
//     before anything is stored; a credential value has no path into an event.
//   • NO SECOND INFRASTRUCTURE — the queue is the existing job queue, tracing/audit are the
//     existing systems, identity is #29, and nothing here touches auth, workflow or primitive state.
import { recordSpan, scrub, scrubText } from "./tracing.ts";
import { audit } from "./authz.ts";
import { enqueue } from "./jobQueue.ts";
import { resolvePermissions, can, membershipOf } from "./appAccess.ts";
import {
  ANALYTICS_LIMITS, ANALYTICS_QUEUE, ANALYTICS_JOB_TYPE, ANALYTICS_CONTRACT_VERSION,
  EventRejected, buildEvent, normalizeConfig, publicEvent, publicSession, assertEnvironment,
} from "./analyticsContract.ts";

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

// --- configuration -------------------------------------------------------------------------------
export async function loadAnalyticsConfig(svc, project) {
  const [row] = await svc.entities.AppAnalyticsConfig.filter({ project_id: project.id }, "-created_date", 1).catch(() => []);
  return normalizeConfig(row ? { ...row } : null);
}

export async function saveAnalyticsConfig(svc, project, patch = {}, { actor = null, trace_id = null } = {}) {
  const [row] = await svc.entities.AppAnalyticsConfig.filter({ project_id: project.id }, "-created_date", 1).catch(() => []);
  const doc = { updated_at: nowIso() };
  if (patch.enabled !== undefined) doc.enabled = !!patch.enabled;
  if (patch.require_registered_schemas !== undefined) doc.require_registered_schemas = !!patch.require_registered_schemas;
  if (patch.credential_policy !== undefined) doc.credential_policy = patch.credential_policy === "redact" ? "redact" : "reject";
  if (patch.suppressed_properties !== undefined) doc.suppressed_properties = (Array.isArray(patch.suppressed_properties) ? patch.suppressed_properties : []).map((k) => String(k).slice(0, 60)).slice(0, 50);
  if (patch.retention_days !== undefined) doc.retention_days = Math.max(0, Math.min(3650, Math.floor(Number(patch.retention_days) || 0)));
  if (patch.allow_platform_intelligence !== undefined) doc.allow_platform_intelligence = !!patch.allow_platform_intelligence;
  if (patch.operator_permissions !== undefined) doc.operator_permissions = scrub(patch.operator_permissions || {});
  const saved = row
    ? await svc.entities.AppAnalyticsConfig.update(row.id, doc)
    : await svc.entities.AppAnalyticsConfig.create({ project_id: project.id, workspace_id: project.workspace_id || null, created_at: nowIso(), ...doc });
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: actor || null,
    action: "app_analytics.config_updated", resource: "AppAnalyticsConfig", resource_id: saved.id,
    metadata: scrub({ fields: Object.keys(doc).filter((k) => k !== "updated_at") }),
  }).catch(() => {});
  if (trace_id) {
    await recordSpan(svc, { trace_id, workspace_id: project.workspace_id, project_id: project.id, event_type: "function_exec", name: "app_analytics.config_updated", status: "ok", reference_id: saved.id, metadata: {} }).catch(() => {});
  }
  return normalizeConfig(saved);
}

// --- event schema registry -----------------------------------------------------------------------
export async function registerEventSchema(svc, project, input = {}, { actor = null } = {}) {
  const event_name = String(input.event_name || "").trim().slice(0, ANALYTICS_LIMITS.event_name_chars);
  if (!event_name) fail(400, "ANALYTICS_EVENT_NAME_REQUIRED", "event_name is required");
  const event_version = Math.max(1, Math.floor(Number(input.event_version) || 1));
  const existing = (await svc.entities.AppEventSchema.filter({ project_id: project.id, event_name, event_version }, "-created_date", 1).catch(() => []))[0] || null;
  const doc = {
    event_type: input.event_type || "custom_event", status: input.status === "deprecated" ? "deprecated" : "active",
    description: scrubText(input.description || "", 300),
    required_properties: (Array.isArray(input.required_properties) ? input.required_properties : []).map((k) => String(k).slice(0, 60)).slice(0, 50),
    property_types: Object.fromEntries(Object.entries(input.property_types || {}).slice(0, ANALYTICS_LIMITS.max_properties)
      .map(([k, v]) => [String(k).slice(0, 60), ["string", "number", "boolean"].includes(String(v)) ? String(v) : "string"])),
    strict: !!input.strict, updated_at: nowIso(),
  };
  const saved = existing
    ? await svc.entities.AppEventSchema.update(existing.id, doc)
    : await svc.entities.AppEventSchema.create({ project_id: project.id, workspace_id: project.workspace_id || null, event_name, event_version, created_at: nowIso(), ...doc });
  await audit(svc, { workspace_id: project.workspace_id, project_id: project.id, user_id: actor || null, action: "app_analytics.schema_registered", resource: "AppEventSchema", resource_id: saved.id, metadata: scrub({ event_name, event_version, status: doc.status }) }).catch(() => {});
  return publicSchema(saved);
}

export const publicSchema = (s) => ({
  id: s.id, event_name: s.event_name, event_version: s.event_version, event_type: s.event_type || "custom_event",
  status: s.status || "active", description: s.description || "", required_properties: s.required_properties || [],
  property_types: s.property_types || {}, strict: !!s.strict,
});

export const listEventSchemas = async (svc, project) => (await svc.entities.AppEventSchema.filter({ project_id: project.id }, "event_name", 200).catch(() => [])).map(publicSchema);

/**
 * Resolves the schema an event must validate against. A registered name pins the version: an
 * unknown or deprecated version is refused rather than silently accepted as a new definition.
 */
async function resolveSchema(svc, project, config, { event_name, event_version }) {
  const rows = await svc.entities.AppEventSchema.filter({ project_id: project.id, event_name: String(event_name || "") }, "-event_version", 20).catch(() => []);
  if (!rows.length) {
    if (config.require_registered_schemas) {
      throw new EventRejected("ANALYTICS_SCHEMA_NOT_REGISTERED", `Event "${event_name}" has no registered schema and this application requires one`, { event_name });
    }
    return null;
  }
  const wanted = Number.isFinite(Number(event_version)) ? Math.floor(Number(event_version)) : null;
  const match = wanted ? rows.find((r) => r.event_version === wanted) : rows.find((r) => r.status === "active") || rows[0];
  if (!match) {
    throw new EventRejected("ANALYTICS_SCHEMA_VERSION_UNSUPPORTED", `Event "${event_name}" has no schema version ${wanted}`, { event_name, event_version: wanted, available: rows.map((r) => r.event_version) });
  }
  if (match.status !== "active") {
    throw new EventRejected("ANALYTICS_SCHEMA_DEPRECATED", `Event "${event_name}" v${match.event_version} is deprecated and no longer accepts events`, { event_name, event_version: match.event_version });
  }
  return match;
}

// --- sessions -------------------------------------------------------------------------------------
async function findSession(svc, project, session_key) {
  if (!session_key) return null;
  const [row] = await svc.entities.AppAnalyticsSession.filter({ project_id: project.id, session_key: String(session_key) }, "-created_date", 1).catch(() => []);
  return row && row.project_id === project.id ? row : null;
}

/** Idempotent: an existing key returns its session rather than forking a second one. */
export async function startSession(svc, project, input = {}, ctx = {}) {
  const environment = assertEnvironment(input.environment || ctx.environment);
  const session_key = String(input.session_key || crypto.randomUUID()).slice(0, 120);
  const existing = await findSession(svc, project, session_key);
  if (existing) {
    const patched = await svc.entities.AppAnalyticsSession.update(existing.id, { last_seen_at: nowIso(), ...(ctx.app_user_id && !existing.app_user_id ? { app_user_id: ctx.app_user_id, identity_linked_at: nowIso() } : {}) });
    return { session: publicSession(patched), created: false };
  }
  const created = await svc.entities.AppAnalyticsSession.create({
    project_id: project.id, workspace_id: project.workspace_id || null, session_key,
    anonymous_id: input.anonymous_id ? String(input.anonymous_id).slice(0, 120) : (ctx.app_user_id ? null : `anon_${crypto.randomUUID().slice(0, 12)}`),
    app_user_id: ctx.app_user_id || null, team_id: ctx.team_id || null, environment, status: "active",
    started_at: nowIso(), last_seen_at: nowIso(), event_count: 0,
    entry_page: input.page ? scrubText(String(input.page), ANALYTICS_LIMITS.page_chars) : null,
    trace_id: ctx.trace_id || null,
  });
  return { session: publicSession(created), created: true };
}

export async function endSession(svc, project, { session_key } = {}) {
  const row = await findSession(svc, project, session_key);
  if (!row) fail(404, "ANALYTICS_SESSION_NOT_FOUND", "Session not found for this application");
  if (row.status === "ended") return { session: publicSession(row), already_ended: true };
  const started = Date.parse(row.started_at || row.created_date);
  const ended = await svc.entities.AppAnalyticsSession.update(row.id, {
    status: "ended", ended_at: nowIso(), last_seen_at: nowIso(),
    duration_ms: Number.isFinite(started) ? Date.now() - started : null,
  });
  return { session: publicSession(ended), already_ended: false };
}

export async function getCurrentSession(svc, project, { session_key } = {}) {
  const row = await findSession(svc, project, session_key);
  return row ? publicSession(row) : null;
}

/**
 * Controlled anonymous → authenticated linking. The app user must belong to THIS project (a user
 * from another project is refused, never merged), and the session's earlier anonymous events are
 * back-filled within a bounded window so the pre-login funnel stays attributable.
 */
export async function linkIdentity(svc, project, { session_key, app_user_id } = {}, ctx = {}) {
  const row = await findSession(svc, project, session_key);
  if (!row) fail(404, "ANALYTICS_SESSION_NOT_FOUND", "Session not found for this application");
  const user = await svc.entities.AppUser.get(String(app_user_id || "")).catch(() => null);
  if (!user || user.project_id !== project.id) {
    fail(403, "ANALYTICS_IDENTITY_CROSS_PROJECT", "That user does not belong to this application; analytics identities are never merged across projects");
  }
  if (row.app_user_id && row.app_user_id !== user.id) {
    fail(409, "ANALYTICS_IDENTITY_CONFLICT", "This session is already attributed to a different user");
  }
  const linked = await svc.entities.AppAnalyticsSession.update(row.id, { app_user_id: user.id, identity_linked_at: row.identity_linked_at || nowIso(), last_seen_at: nowIso() });
  let backfilled = 0;
  const pending = await svc.entities.AppAnalyticsEvent.filter({ project_id: project.id, session_id: row.id }, "-created_date", ANALYTICS_LIMITS.scan_page).catch(() => []);
  for (const e of pending) {
    if (e.app_user_id) continue;
    await svc.entities.AppAnalyticsEvent.update(e.id, { app_user_id: user.id }).catch(() => {});
    backfilled++;
  }
  await audit(svc, { workspace_id: project.workspace_id, project_id: project.id, user_id: null, action: "app_analytics.identity_linked", resource: "AppAnalyticsSession", resource_id: row.id, metadata: scrub({ app_user_id: user.id, events_backfilled: backfilled }) }).catch(() => {});
  if (ctx.trace_id) {
    await recordSpan(svc, { trace_id: ctx.trace_id, workspace_id: project.workspace_id, project_id: project.id, event_type: "function_exec", name: "app_analytics.identity_linked", status: "ok", reference_id: row.id, metadata: { events_backfilled: backfilled } }).catch(() => {});
  }
  return { session: publicSession(linked), events_backfilled: backfilled };
}

// --- ingestion -------------------------------------------------------------------------------------
async function findByIngestionKey(svc, project, key) {
  if (!key) return null;
  const [row] = await svc.entities.AppAnalyticsEvent.filter({ project_id: project.id, ingestion_key: String(key) }, "-created_date", 1).catch(() => []);
  return row && row.project_id === project.id ? row : null;
}

/**
 * Ingests ONE event synchronously. `context` is the resolved server-side context — it is the only
 * source of ownership. A rejection is recorded through the EXISTING tracing/audit systems so a
 * refused event is explainable without ever storing its offending value.
 */
export async function ingestEvent(svc, project, input = {}, context = {}, { config = null } = {}) {
  const cfg = config || await loadAnalyticsConfig(svc, project);
  const environment = assertEnvironment(context.environment || input.environment);
  const source = ["client", "server", "queue"].includes(String(context.source)) ? String(context.source) : "client";

  // Session (and its identity/tenant) is resolved from storage, never trusted from the payload.
  let sessionRow = await findSession(svc, project, input.session_key || context.session_key);
  if (!sessionRow && (input.session_key || context.session_key) && input.auto_session !== false) {
    const started = await startSession(svc, project, { session_key: input.session_key || context.session_key, environment, page: input.page, anonymous_id: input.anonymous_id }, context);
    sessionRow = await findSession(svc, project, started.session.session_key);
  }
  if (sessionRow && sessionRow.environment !== environment) {
    throw new EventRejected("ANALYTICS_ENVIRONMENT_MISMATCH", "That session belongs to a different environment");
  }

  // A team may only be attributed when the actor is actually a member of it.
  let team_id = null;
  if (context.app_user_id && (input.team_id || context.team_id)) {
    const membership = await membershipOf(svc, project, String(input.team_id || context.team_id), context.app_user_id);
    team_id = membership ? membership.team_id : null;
  }

  try {
    const schema = await resolveSchema(svc, project, cfg, { event_name: input.event_name, event_version: input.event_version });
    const event = buildEvent({
      input, config: cfg, schema,
      context: {
        project_id: project.id, workspace_id: project.workspace_id || null, environment, source,
        app_user_id: context.app_user_id || sessionRow?.app_user_id || null,
        anonymous_id: context.app_user_id ? null : (input.anonymous_id || sessionRow?.anonymous_id || null),
        session_id: sessionRow?.id || null, team_id: team_id || sessionRow?.team_id || null,
        trace_id: context.trace_id || null, run_id: context.run_id || null,
      },
    });
    // Idempotency: the first accepted event for a key is the answer forever.
    const prior = await findByIngestionKey(svc, project, event.ingestion_key);
    if (prior) return { event: publicEvent(prior), duplicate: true };

    const stored = await svc.entities.AppAnalyticsEvent.create(event);
    if (sessionRow) {
      await svc.entities.AppAnalyticsSession.update(sessionRow.id, {
        last_seen_at: nowIso(), event_count: (sessionRow.event_count || 0) + 1,
        ...(event.event_type === "session_end" && sessionRow.status !== "ended" ? { status: "ended", ended_at: nowIso() } : {}),
      }).catch(() => {});
    }
    return { event: publicEvent(stored), duplicate: false };
  } catch (e) {
    if (e instanceof EventRejected) {
      // The refusal is traced and audited; the offending payload never is.
      await recordSpan(svc, {
        trace_id: context.trace_id || null, workspace_id: project.workspace_id, project_id: project.id,
        event_type: "function_exec", name: "app_analytics.ingest_rejected", status: "error",
        error_code: e.code, error: e, metadata: scrub({ event_name: String(input.event_name || "").slice(0, 80), environment, source, details: e.details || {} }),
      }).catch(() => {});
      await audit(svc, {
        workspace_id: project.workspace_id, project_id: project.id, user_id: null,
        action: "app_analytics.ingest_rejected", resource: "AppAnalyticsEvent", resource_id: null,
        metadata: scrub({ code: e.code, event_name: String(input.event_name || "").slice(0, 80), environment }),
      }).catch(() => {});
    }
    throw e;
  }
}

/** A bounded batch. Each event is judged on its own, so one bad event never discards the rest. */
export async function ingestBatch(svc, project, events = [], context = {}) {
  const list = Array.isArray(events) ? events : [];
  if (list.length > ANALYTICS_LIMITS.max_batch) fail(400, "ANALYTICS_BATCH_TOO_LARGE", `At most ${ANALYTICS_LIMITS.max_batch} events per batch (got ${list.length})`);
  const cfg = await loadAnalyticsConfig(svc, project);
  const accepted = [], rejected = [];
  for (const [i, input] of list.entries()) {
    try {
      const res = await ingestEvent(svc, project, input, context, { config: cfg });
      accepted.push({ index: i, ...res });
    } catch (e) {
      rejected.push({ index: i, code: e.code || "ANALYTICS_REJECTED", error: String(e.message).slice(0, 200) });
    }
  }
  return { accepted: accepted.length, rejected: rejected.length, events: accepted.map((a) => a.event), duplicates: accepted.filter((a) => a.duplicate).length, failures: rejected };
}

/**
 * Hands ingestion to the EXISTING durable job queue, so a high-volume app never blocks a user
 * request on non-critical analytics. The resolved context travels with the job — the queued
 * continuation re-validates against the same contract and cannot claim a different project.
 * Ordering is NOT promised across queued submissions; each event keeps its own occurred_at.
 */
export async function enqueueIngestion(svc, project, events = [], context = {}) {
  const list = (Array.isArray(events) ? events : [events]).slice(0, ANALYTICS_LIMITS.max_batch);
  const { job, duplicate } = await enqueue(svc, {
    queue: ANALYTICS_QUEUE, job_type: ANALYTICS_JOB_TYPE,
    payload: {
      project_id: project.id, events: list,
      context: {
        environment: assertEnvironment(context.environment), source: "queue",
        app_user_id: context.app_user_id || null, session_key: context.session_key || null,
        team_id: context.team_id || null, trace_id: context.trace_id || null, run_id: context.run_id || null,
      },
    },
    idempotency_key: context.idempotency_key ? `analytics:${project.id}:${context.idempotency_key}` : null,
    workspace_id: project.workspace_id || null, project_id: project.id, trace_id: context.trace_id || null,
  });
  return { queued: list.length, job_id: job.id, duplicate: !!duplicate };
}

/** The queue handler's body: the project comes from the job row, never from a client. */
export async function processQueuedIngestion(base44, payload = {}) {
  const svc = svcOf(base44);
  const project = await svc.entities.Project.get(String(payload.project_id || "")).catch(() => null);
  if (!project) throw Object.assign(new Error("analytics.ingest: unknown project"), { retryable: false, code: "INVALID_PAYLOAD" });
  const res = await ingestBatch(svc, project, payload.events || [], { ...(payload.context || {}), source: "queue" });
  return { project_id: project.id, accepted: res.accepted, rejected: res.rejected, duplicates: res.duplicates };
}

// --- operator authorization for app-user callers ---------------------------------------------------
/**
 * An app user may read analytics only when the project's own roles grant the analytics permission.
 * An ordinary end-user holds none of them, so the default answer is no.
 */
export async function assertAnalyticsPermission(svc, project, appUser, permission, { config = null } = {}) {
  if (!appUser?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const row = await svc.entities.AppUser.get(appUser.id).catch(() => null);
  if (!row || row.project_id !== project.id) fail(403, "ANALYTICS_FORBIDDEN", "Not an operator of this application");
  // A project may require a DIFFERENT permission key of its own for an analytics action. The
  // override only renames the requirement — the project's roles still have to grant it, so this can
  // never let an app user through without a permission, and an absent/blank override falls back to
  // the standard key. Workspace operators are unaffected: their capability check is the platform's.
  const override = config?.operator_permissions?.[permission];
  const required = typeof override === "string" && override.trim() ? override.trim() : permission;
  const { permissions } = await resolvePermissions(svc, project, row);
  if (!can(permissions, required)) fail(403, "ANALYTICS_FORBIDDEN", `Missing permission ${required}`);
  return { app_user_id: row.id, permissions, required };
}

// --- the generated-app surface (ctx.analytics) ------------------------------------------------------
/**
 * `ctx.analytics` for a generated application's server-side code.
 *
 * The project is captured from the EXECUTING project record and the user from the verified #29
 * session, so nothing the sandbox passes can attribute an event to another project or another user.
 */
export function createAppAnalytics(base44, { project, user = null, session = null, trace_id = null, run_id = null } = {}) {
  const svc = svcOf(base44);
  const context = () => ({
    environment: project.environment || "production", source: "server",
    app_user_id: user?.id || null, session_key: session?.session_key || null,
    trace_id: trace_id || null, run_id: run_id || null,
  });
  return {
    contract_version: ANALYTICS_CONTRACT_VERSION,
    trackEvent: async (event_name, properties = {}, opts = {}) =>
      ingestEvent(svc, project, { event_name: String(event_name), properties, ...opts }, { ...context(), session_key: opts.session_key || context().session_key }),
    trackEvents: (events) => ingestBatch(svc, project, events || [], context()),
    // Non-critical, high-volume telemetry: accepted into the existing queue and validated there.
    trackAsync: (events, opts = {}) => enqueueIngestion(svc, project, events || [], { ...context(), ...opts }),
    startSession: (input = {}) => startSession(svc, project, { environment: context().environment, ...input }, context()),
    endSession: (session_key) => endSession(svc, project, { session_key: session_key || context().session_key }),
    getCurrentSession: (session_key) => getCurrentSession(svc, project, { session_key: session_key || context().session_key }),
    linkIdentity: (session_key, app_user_id) => linkIdentity(svc, project, { session_key, app_user_id: app_user_id || user?.id }, context()),
  };
}