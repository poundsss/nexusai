// Minimal runtime-logs projection for the Logs page.
//
// Reuses the EXISTING certified observability backend — TraceEvent (the correlation layer),
// FunctionInvocation (function-call detail) and AuditLog (entity operations + user actions) —
// and adds NO new event type, storage or retention. Every read is project-scoped AFTER the
// caller's project authorization (loadAuthorizedProject, project.read), mirroring the analytics
// operator. The authoritative detail stays in the referenced record; this is only the read
// surface. AuditLog is system-write-only (RLS read:false), so it is read here through the
// service role — never exposed to a client token directly.

import { loadAuthorizedProject } from "./authz.ts";
import { enforceLimit, identityFor } from "./apiLimits.ts";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 50;
const OFFSET_MAX = 1000;

// The exact event_type enum from the certified TraceEvent schema — nothing is invented here.
const TRACE_EVENT_TYPES = [
  "ai_run", "ai_run_phase", "ai_run_step", "tool_call", "mcp_call", "function_exec",
  "background_job", "deployment", "frontend_error", "diagnostic_query",
];
const TRACE_SET = new Set(TRACE_EVENT_TYPES);

const boundLimit = (n) => Math.max(1, Math.min(Number(n) || LIMIT_DEFAULT, LIMIT_MAX));
const boundOffset = (n) => Math.max(0, Math.min(Number(n) || 0, OFFSET_MAX));

function mapTrace(r) {
  return {
    id: r.id, source: "trace", at: r.at || r.created_date, event_type: r.event_type, name: r.name,
    status: r.status, error_code: r.error_code || null, error_message: r.error_message || null,
    duration_ms: r.duration_ms ?? null, trace_id: r.trace_id || null, reference_id: r.reference_id || null,
    metadata: r.metadata || {}, user_id: null, action: null, resource: null, resource_id: null,
  };
}

function mapAudit(r) {
  return {
    id: r.id, source: "audit", at: r.created_date, event_type: "audit", name: r.action,
    status: "ok", error_code: null, error_message: null, duration_ms: null,
    trace_id: null, reference_id: null, metadata: r.metadata || {},
    user_id: r.user_id || null, action: r.action, resource: r.resource || null, resource_id: r.resource_id || null,
  };
}

function scrubInvocation(inv) {
  return {
    id: inv.id, function_name: inv.function_name, trigger: inv.trigger, method: inv.method || null,
    status: inv.status ?? null, ok: inv.ok !== false, error_class: inv.error_class || null,
    error_message: inv.error_message || null, duration_ms: inv.duration_ms ?? null,
    request_id: inv.request_id || null, trace_id: inv.trace_id || null,
    logs: Array.isArray(inv.logs) ? inv.logs : [],
    external_calls: Array.isArray(inv.external_calls) ? inv.external_calls : [],
  };
}

/** Unified, bounded, newest-first runtime event list for one project. */
export async function queryLogEvents(svc, project, params = {}) {
  const limit = boundLimit(params.limit);
  const offset = boundOffset(params.offset);
  const errorsOnly = !!params.errors_only;
  const typeFilter = params.event_type ? String(params.event_type) : null;
  const includeAudit = !errorsOnly && (!typeFilter || typeFilter === "audit");
  const includeTrace = !typeFilter || typeFilter !== "audit";

  const events = [];
  if (includeTrace) {
    const q = {
      project_id: project.id,
      ...(errorsOnly ? { status: "error" } : {}),
      ...(typeFilter && TRACE_SET.has(typeFilter) ? { event_type: typeFilter } : {}),
    };
    const rows = await svc.entities.TraceEvent.filter(q, "-at", limit + 1, offset).catch(() => []);
    for (const r of rows) events.push(mapTrace(r));
  }
  if (includeAudit) {
    const rows = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", limit + 1, offset).catch(() => []);
    for (const r of rows) events.push(mapAudit(r));
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { events: events.slice(0, limit), has_more: events.length > limit, limit, offset };
}

/** Detail for one event: the event, the authoritative record it points at, and any trace span tree. */
export async function getLogDetail(svc, project, params = {}) {
  const out = { event: null, invocation: null, audit: null, spans: [], invocations: [] };

  if (params.trace_id) {
    const spans = await svc.entities.TraceEvent.filter({ project_id: project.id, trace_id: String(params.trace_id) }, "at", 200).catch(() => []);
    out.spans = spans;
    const invs = await svc.entities.FunctionInvocation.filter({ project_id: project.id, trace_id: String(params.trace_id) }, "-created_date", 50).catch(() => []);
    out.invocations = invs.map(scrubInvocation);
    out.event = spans[0] ? mapTrace(spans[0]) : null;
    return out;
  }

  const source = String(params.source || "");
  const id = String(params.id || "");
  if (!id) fail(400, "LOGS_DETAIL_ID", "id is required for detail");

  if (source === "trace") {
    const r = await svc.entities.TraceEvent.get(id).catch(() => null);
    if (!r || r.project_id !== project.id) fail(404, "LOGS_NOT_FOUND", "Event not found");
    out.event = mapTrace(r);
    if (r.reference_id) {
      const inv = await svc.entities.FunctionInvocation.get(r.reference_id).catch(() => null);
      if (inv && inv.project_id === project.id) out.invocation = scrubInvocation(inv);
    }
    return out;
  }
  if (source === "audit") {
    const r = await svc.entities.AuditLog.get(id).catch(() => null);
    if (!r || r.project_id !== project.id) fail(404, "LOGS_NOT_FOUND", "Audit entry not found");
    out.audit = { id: r.id, action: r.action, resource: r.resource || null, resource_id: r.resource_id || null, user_id: r.user_id || null, metadata: r.metadata || {}, created_date: r.created_date };
    out.event = mapAudit(r);
    return out;
  }
  fail(400, "LOGS_DETAIL_SOURCE", "source must be trace or audit, or supply trace_id");
}

export function describeLogsApi() {
  return { event_types: TRACE_EVENT_TYPES, sources: ["trace", "audit"], limits: { max_limit: LIMIT_MAX, max_offset: OFFSET_MAX } };
}

/** Authorized operator boundary — mirrors the analytics operator. */
export async function handleLogsRequest(base44, body = {}) {
  const action = String(body.action || "capabilities");
  if (action === "capabilities") return describeLogsApi();
  if (action !== "events" && action !== "detail") fail(400, "LOGS_OP_UNSUPPORTED", `Unknown action: ${action}`);

  const project_id = String(body.project_id || "");
  if (!project_id) fail(400, "LOGS_PROJECT_REQUIRED", "project_id is required");

  const user = await base44.auth.me().catch(() => null);
  if (!user) fail(401, "AUTH_REQUIRED", "Unauthorized");
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  await enforceLimit(base44, { identity: identityFor({ user, workspace_id: project.workspace_id }), action: "default", workspace_id: project.workspace_id });

  const svc = base44.asServiceRole || base44;
  if (action === "events") return await queryLogEvents(svc, project, body.params || {});
  return await getLogDetail(svc, project, body.params || {});
}