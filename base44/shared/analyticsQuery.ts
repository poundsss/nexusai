// Analytics querying, aggregation, funnels, retention and export for generated apps (#30).
//
// Every query here is:
//   • PROJECT-SCOPED — the project is resolved and authorized by the caller before this module is
//     reached, and every read filters by project_id, so no result can span applications.
//   • ENVIRONMENT-SEPARATED — environment is part of every filter and defaults to production, so a
//     production number can never quietly include development or staging traffic.
//   • BOUNDED — a time range is clamped to the contract's maximum window, a page to its maximum
//     limit, and a scan to a maximum row budget. Nothing here reads an unbounded event stream.
import { scrubText } from "./tracing.ts";
import { ANALYTICS_LIMITS, boundRange, boundLimit, assertEnvironment, publicEvent, publicSession } from "./analyticsContract.ts";

const DAY = 86400000;
const inRange = (e, from, to) => {
  const t = String(e.occurred_at || e.created_date);
  return t >= from && t <= to;
};

/**
 * Reads a bounded slice of one project's events. The range and the row budget are hard ceilings:
 * a query that would exceed them returns `truncated: true` rather than scanning further.
 */
async function scanEvents(svc, project, { from, to, environment, event_names = null, event_types = null, app_user_id = null, session_id = null, page = null, budget = ANALYTICS_LIMITS.max_scan }) {
  const base = { project_id: project.id, environment };
  const out = [];
  let truncated = false;
  const names = event_names && event_names.length ? new Set(event_names.map(String)) : null;
  const types = event_types && event_types.length ? new Set(event_types.map(String)) : null;
  for (let skip = 0; skip < budget; skip += ANALYTICS_LIMITS.scan_page) {
    const rows = await svc.entities.AppAnalyticsEvent.filter(
      { ...base, ...(app_user_id ? { app_user_id: String(app_user_id) } : {}), ...(session_id ? { session_id: String(session_id) } : {}) },
      "-created_date", ANALYTICS_LIMITS.scan_page, skip,
    ).catch(() => []);
    if (!rows.length) break;
    for (const r of rows) {
      if (!inRange(r, from, to)) continue;
      if (names && !names.has(r.event_name)) continue;
      if (types && !types.has(r.event_type)) continue;
      if (page && r.page !== page) continue;
      out.push(r);
    }
    if (rows.length < ANALYTICS_LIMITS.scan_page) break;
    if (skip + ANALYTICS_LIMITS.scan_page >= budget) truncated = true;
  }
  return { rows: out, truncated };
}

const actorKey = (e) => e.app_user_id || (e.anonymous_id ? `anon:${e.anonymous_id}` : null);

/** Raw event list, newest first, with bounded pagination. */
export async function queryEvents(svc, project, params = {}) {
  const environment = assertEnvironment(params.environment);
  const range = boundRange({ from: params.from, to: params.to });
  const limit = boundLimit(params.limit, 100);
  const offset = Math.max(0, Math.min(Number(params.offset) || 0, ANALYTICS_LIMITS.max_scan));
  const { rows, truncated } = await scanEvents(svc, project, {
    ...range, environment,
    event_names: params.event_names || (params.event_name ? [params.event_name] : null),
    event_types: params.event_types || (params.event_type ? [params.event_type] : null),
    app_user_id: params.app_user_id || null, session_id: params.session_id || null, page: params.page || null,
  });
  const ordered = rows.sort((a, b) => String(b.occurred_at || b.created_date).localeCompare(String(a.occurred_at || a.created_date)));
  const window = ordered.slice(offset, offset + limit);
  return {
    project_id: project.id, environment, range, limit, offset,
    total_matched: ordered.length, returned: window.length,
    has_more: offset + window.length < ordered.length, scan_truncated: truncated,
    events: window.map(publicEvent),
  };
}

/** Counts, unique users, unique sessions, top events, conversions, errors and a time series. */
export async function aggregate(svc, project, params = {}) {
  const environment = assertEnvironment(params.environment);
  const range = boundRange({ from: params.from, to: params.to });
  const interval = params.interval === "hour" ? "hour" : "day";
  const { rows, truncated } = await scanEvents(svc, project, {
    ...range, environment,
    event_names: params.event_names || (params.event_name ? [params.event_name] : null),
    event_types: params.event_types || null,
  });
  const users = new Set(), sessions = new Set(), anonymous = new Set();
  const byName = new Map(), byType = new Map(), byPage = new Map(), series = new Map();
  let conversions = 0, conversion_value = 0, errors = 0, performance_events = 0, latencyTotal = 0, latencySamples = 0;
  for (const e of rows) {
    if (e.app_user_id) users.add(e.app_user_id);
    else if (e.anonymous_id) anonymous.add(e.anonymous_id);
    if (e.session_id) sessions.add(e.session_id);
    byName.set(e.event_name, (byName.get(e.event_name) || 0) + 1);
    byType.set(e.event_type, (byType.get(e.event_type) || 0) + 1);
    if (e.page) byPage.set(e.page, (byPage.get(e.page) || 0) + 1);
    const stamp = String(e.occurred_at || e.created_date);
    const bucket = interval === "hour" ? `${stamp.slice(0, 13)}:00` : stamp.slice(0, 10);
    const slot = series.get(bucket) || { bucket, events: 0, users: new Set(), sessions: new Set() };
    slot.events++;
    if (e.app_user_id) slot.users.add(e.app_user_id);
    if (e.session_id) slot.sessions.add(e.session_id);
    series.set(bucket, slot);
    if (e.event_type === "conversion") { conversions++; conversion_value += Number(e.conversion_value) || 0; }
    if (e.event_type === "error") errors++;
    if (e.event_type === "performance") {
      performance_events++;
      if (Number.isFinite(Number(e.duration_ms))) { latencyTotal += Number(e.duration_ms); latencySamples++; }
    }
  }
  const list = (map) => [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return {
    project_id: project.id, environment, range, interval, scan_truncated: truncated,
    totals: {
      events: rows.length, unique_users: users.size, unique_anonymous: anonymous.size,
      unique_sessions: sessions.size, conversions, conversion_value: Math.round(conversion_value * 100) / 100,
      errors, performance_events,
      avg_duration_ms: latencySamples ? Math.round(latencyTotal / latencySamples) : null,
    },
    top_events: list(byName).slice(0, boundLimit(params.top, 20)),
    by_event_type: list(byType),
    top_pages: list(byPage).slice(0, boundLimit(params.top, 20)),
    time_series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
      .map((s) => ({ bucket: s.bucket, events: s.events, unique_users: s.users.size, unique_sessions: s.sessions.size })),
  };
}

/**
 * An ordered funnel: A → B → C. A step counts an actor only when it reached every earlier step
 * FIRST — the ordering is by event time per actor, so an out-of-order later event cannot fake a
 * completion. Deterministic and arithmetic; no model is involved.
 */
export async function funnel(svc, project, params = {}) {
  const environment = assertEnvironment(params.environment);
  const range = boundRange({ from: params.from, to: params.to });
  const steps = (Array.isArray(params.steps) ? params.steps : []).map((s) => String(typeof s === "string" ? s : s.event_name || "")).filter(Boolean).slice(0, 10);
  if (steps.length < 2) throw Object.assign(new Error("A funnel needs at least two steps"), { status: 400, code: "ANALYTICS_FUNNEL_INVALID" });
  const { rows, truncated } = await scanEvents(svc, project, { ...range, environment, event_names: steps });

  // First timestamp per actor per step.
  const actors = new Map();
  for (const e of rows) {
    const key = actorKey(e);
    if (!key) continue;
    const stamp = String(e.occurred_at || e.created_date);
    const record = actors.get(key) || {};
    if (!record[e.event_name] || stamp < record[e.event_name]) record[e.event_name] = stamp;
    actors.set(key, record);
  }
  const entered = [...actors.values()].filter((r) => r[steps[0]]);
  const results = [];
  let previous = entered;
  for (const [i, step] of steps.entries()) {
    const reached = i === 0 ? entered : previous.filter((r) => r[step] && r[step] >= r[steps[i - 1]]);
    results.push({
      step: i + 1, event_name: step, actors: reached.length,
      conversion_from_previous: previous.length ? Math.round((reached.length / previous.length) * 1000) / 10 : 0,
      conversion_from_entry: entered.length ? Math.round((reached.length / entered.length) * 1000) / 10 : 0,
    });
    previous = reached;
  }
  return {
    project_id: project.id, environment, range, scan_truncated: truncated,
    entered: entered.length, completed: previous.length,
    conversion_rate: entered.length ? Math.round((previous.length / entered.length) * 1000) / 10 : 0,
    steps: results,
  };
}

/**
 * Retention cohorts. An actor's cohort is the day of its FIRST session/event in the window; it is
 * retained when it returns inside the configured period. Bounded to the same window ceiling as
 * every other query.
 */
export async function retention(svc, project, params = {}) {
  const environment = assertEnvironment(params.environment);
  const range = boundRange({ from: params.from, to: params.to });
  const periodDays = Math.max(1, Math.min(Number(params.period_days) || 7, ANALYTICS_LIMITS.max_range_days));
  const { rows, truncated } = await scanEvents(svc, project, { ...range, environment });
  const first = new Map(), last = new Map();
  for (const e of rows) {
    const key = actorKey(e);
    if (!key) continue;
    const t = Date.parse(String(e.occurred_at || e.created_date));
    if (!Number.isFinite(t)) continue;
    if (!first.has(key) || t < first.get(key)) first.set(key, t);
    if (!last.has(key) || t > last.get(key)) last.set(key, t);
  }
  const cohorts = new Map();
  for (const [key, start] of first.entries()) {
    const day = new Date(start).toISOString().slice(0, 10);
    const c = cohorts.get(day) || { cohort: day, actors: 0, retained: 0 };
    c.actors++;
    const end = last.get(key);
    // Retained = came back on a LATER day, inside the configured period.
    if (end - start > 0 && end - start <= periodDays * DAY && new Date(end).toISOString().slice(0, 10) !== day) c.retained++;
    cohorts.set(day, c);
  }
  const list = [...cohorts.values()].sort((a, b) => a.cohort.localeCompare(b.cohort))
    .map((c) => ({ ...c, retention_rate: c.actors ? Math.round((c.retained / c.actors) * 1000) / 10 : 0 }));
  const actors = list.reduce((n, c) => n + c.actors, 0);
  const retained = list.reduce((n, c) => n + c.retained, 0);
  return {
    project_id: project.id, environment, range, period_days: periodDays, scan_truncated: truncated,
    totals: { actors, retained, retention_rate: actors ? Math.round((retained / actors) * 1000) / 10 : 0 },
    cohorts: list,
  };
}

/** Structured error analytics: counts by code, category and page. */
export async function errorAnalytics(svc, project, params = {}) {
  const environment = assertEnvironment(params.environment);
  const range = boundRange({ from: params.from, to: params.to });
  const { rows, truncated } = await scanEvents(svc, project, { ...range, environment, event_types: ["error"] });
  const byCode = new Map(), byCategory = new Map(), byPage = new Map();
  for (const e of rows) {
    byCode.set(e.error_code || "unknown", (byCode.get(e.error_code || "unknown") || 0) + 1);
    byCategory.set(e.error_category || "unknown", (byCategory.get(e.error_category || "unknown") || 0) + 1);
    if (e.page) byPage.set(e.page, (byPage.get(e.page) || 0) + 1);
  }
  const list = (m) => [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  const limit = boundLimit(params.limit, 50);
  return {
    project_id: project.id, environment, range, scan_truncated: truncated,
    total_errors: rows.length, affected_users: new Set(rows.map(actorKey).filter(Boolean)).size,
    by_code: list(byCode), by_category: list(byCategory), by_page: list(byPage).slice(0, 20),
    recent: rows.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, limit)
      .map((e) => ({ event_id: e.event_id, error_code: e.error_code || null, error_category: e.error_category || null, page: e.page || null, occurred_at: e.occurred_at, environment: e.environment, trace_id: e.trace_id || null })),
  };
}

/** Client/server timing analytics: latency distribution per event name and page. */
export async function performanceAnalytics(svc, project, params = {}) {
  const environment = assertEnvironment(params.environment);
  const range = boundRange({ from: params.from, to: params.to });
  const { rows, truncated } = await scanEvents(svc, project, { ...range, environment, event_types: ["performance"] });
  const groups = new Map();
  for (const e of rows) {
    const key = e.event_name;
    const g = groups.get(key) || { key, samples: [], pages: new Set() };
    if (Number.isFinite(Number(e.duration_ms))) g.samples.push(Number(e.duration_ms));
    if (e.page) g.pages.add(e.page);
    groups.set(key, g);
  }
  const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
  return {
    project_id: project.id, environment, range, scan_truncated: truncated, total_events: rows.length,
    by_event: [...groups.values()].map((g) => ({
      key: g.key, samples: g.samples.length, pages: [...g.pages].slice(0, 10),
      avg_duration_ms: g.samples.length ? Math.round(g.samples.reduce((a, b) => a + b, 0) / g.samples.length) : null,
      p50_duration_ms: pct(g.samples, 50), p95_duration_ms: pct(g.samples, 95),
    })).sort((a, b) => b.samples - a.samples),
  };
}

/**
 * Bounded, authorized export. Properties are re-redacted on the way out: a key the project's
 * privacy configuration suppresses is removed from the exported row even if it predates the
 * configuration, so an export can never widen what analytics reveals.
 */
export async function exportEvents(svc, project, params = {}, { config } = {}) {
  const result = await queryEvents(svc, project, { ...params, limit: boundLimit(params.limit, 200) });
  const suppressed = new Set((config?.suppressed_properties || []).map((k) => String(k).toLowerCase()));
  const rows = result.events.map((e) => {
    const properties = {}; const redactions = [...(e.redactions || [])];
    for (const [k, v] of Object.entries(e.properties || {})) {
      if (suppressed.has(k.toLowerCase())) { redactions.push(k); continue; }
      properties[k] = typeof v === "string" ? scrubText(v, ANALYTICS_LIMITS.property_value_chars) : v;
    }
    return { ...e, properties, redactions: [...new Set(redactions)] };
  });
  return {
    format: "json", project_id: project.id, environment: result.environment, range: result.range,
    limit: result.limit, offset: result.offset, returned: rows.length, has_more: result.has_more,
    redaction: { suppressed_properties: [...suppressed], credential_policy: config?.credential_policy || "reject" },
    rows,
  };
}

/** Session list for the operator UI, bounded and project-scoped. */
export async function querySessions(svc, project, params = {}) {
  const environment = assertEnvironment(params.environment);
  const limit = boundLimit(params.limit, 50);
  const rows = await svc.entities.AppAnalyticsSession.filter({ project_id: project.id, environment }, "-created_date", limit, Math.max(0, Number(params.offset) || 0)).catch(() => []);
  return { project_id: project.id, environment, returned: rows.length, sessions: rows.map(publicSession) };
}

/**
 * The controlled READ contract a future learning system must go through. It returns only events
 * whose project EXPLICITLY consented, so analytics can never be swept into intelligence by
 * default. Nothing in the platform consumes this today.
 */
export async function readForIntelligence(svc, project, params = {}, { config } = {}) {
  if (!config?.allow_platform_intelligence) {
    return { project_id: project.id, consented: false, events: [], reason: "This project has not consented to platform intelligence use of its analytics" };
  }
  const result = await queryEvents(svc, project, { ...params, limit: boundLimit(params.limit, 200) });
  return {
    project_id: project.id, consented: true, range: result.range, returned: result.events.length,
    events: result.events.map((e) => ({ event_name: e.event_name, event_type: e.event_type, event_version: e.event_version, page: e.page, properties: e.properties, occurred_at: e.occurred_at, environment: e.environment })),
  };
}

/**
 * Sales Overview for one project's owning workspace — Stripe-only, matching the documented Base44
 * "Sales Overview" surface (Dashboard → Analytics → Sales Overview; "covers Stripe payments only").
 *
 * Project-scoped in the same way every other operator query is: the caller is authorized against the
 * project server-side, then the project's workspace_id scopes the read. Derived from EXISTING
 * BillingEvent rows (the authoritative ledger feed) — no new billing data is written. Refunds are
 * read from `event_type: "refund"`; gross payments from the charge/subscription event types. A
 * customer is a unique provider_customer_id. The ledger remains authoritative; this is a read.
 */
export async function salesOverview(svc, project, params = {}) {
  const range = boundRange({ from: params.from, to: params.to });
  const limit = boundLimit(params.limit, 20);
  const workspaceId = project.workspace_id;
  const CHARGE_TYPES = new Set([
    "credit_purchase", "subscription_started", "subscription_renewed", "subscription_resumed", "trial_started",
  ]);
  const events = await svc.entities.BillingEvent.filter(
    { workspace_id: workspaceId, provider: "stripe" }, "-created_date", 500,
  ).catch(() => []);
  const inWindow = (e) => {
    const t = String(e.processed_at || e.created_date);
    return t >= range.from && t <= range.to;
  };
  let gross_cents = 0, transactions = 0, refunds_cents = 0, refund_count = 0;
  const customers = new Set();
  const windowed = [];
  for (const e of events) {
    if (!inWindow(e)) continue;
    windowed.push(e);
    const amount = Number(e.amount_cents) || 0;
    if (e.event_type === "refund") { refunds_cents += amount; refund_count++; }
    else if (CHARGE_TYPES.has(e.event_type)) { gross_cents += amount; transactions++; }
    if (e.provider_customer_id) customers.add(e.provider_customer_id);
  }
  const recent = windowed.slice(0, limit).map((e) => ({
    provider_event_id: e.provider_event_id || null,
    event_type: e.event_type,
    amount_cents: Number(e.amount_cents) || 0,
    currency: e.currency || "USD",
    status: e.status,
    occurred_at: e.processed_at || e.created_date,
    plan_code: e.plan_code || null,
    provider_invoice_id: e.provider_invoice_id || null,
  }));
  return {
    project_id: project.id,
    workspace_id: workspaceId,
    range,
    provider: "stripe",
    totals: {
      gross_cents,
      transactions,
      refunds_cents,
      refund_count,
      customers: customers.size,
      net_cents: gross_cents - refunds_cents,
    },
    recent,
  };
}