// Scheduled maintenance: retention, staging blobs, verification namespaces, logs, dead letters.
//
// Every sweep here is:
//   • server-side and system-authorized — only the job worker's handler registry calls it, with
//     the service role; no caller-supplied scope widens what it touches;
//   • deterministic and idempotent — candidates are selected by explicit, re-derivable rules,
//     processed oldest-first under a per-run cap, and a repeated sweep over the same state
//     changes nothing (a row deleted by a concurrent worker is simply absent);
//   • conservative — anything immutable (ProjectVersion), live (current deployments and their
//     artifacts, in-flight runs, active verification namespaces, required audit/security records)
//     or still retriable (pending/leased/backoff jobs) is never a candidate.
// Concurrency between workers is bounded by `assertSingleton`: one leased job per job type.
import { getRetentionPolicy, recordEvent } from "./compliance.ts";
import { log } from "./observability.ts";
import { applyScheduledChanges, subscriptionFor } from "./subscriptions.ts";
import { grantFreePeriodCredits } from "./billing.ts";
import { periodKeyFor } from "./paymentProviders.ts";
import { audit } from "./authz.ts";

// Mirrors runPipeline.TERMINAL_STATUSES without importing the whole pipeline into the worker.
const RUN_TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];

export const MAINTENANCE_DEFAULTS = {
  staging_ttl_ms: 24 * 3600000,           // terminal run's staging blob reference kept for 24h
  verification_grace_ms: 3600000,         // a verification namespace younger than 1h is presumed live
  log_retention_days: 30,                 // FunctionInvocation + SystemMetric, unless a policy says otherwise
  security_log_retention_days: 365,       // 401/403 invocations are security evidence
  dead_letter_retention_days: 30,
  job_history_retention_days: 7,          // succeeded/cancelled jobs
  package_fetch_retention_days: 30,       // per-project package preparation history
  package_cache_unused_days: 30,          // a verified artifact nothing has reused
  max_per_run: 400,
};

const DAY = 86400000;
const svcOf = (b) => b.asServiceRole || b;
const oldest = (a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id));
const before = (iso, cutoffMs) => { const t = Date.parse(iso || ""); return Number.isFinite(t) && t < cutoffMs; };

// Idempotent delete: a row another worker already removed is not a failure.
async function del(svc, entity, id) {
  try { await svc.entities[entity].delete(id); return true; } catch (e) {
    if (await svc.entities[entity].get(id).catch(() => null)) throw e; // still there: a real failure
    return false; // already gone (concurrent worker or earlier attempt)
  }
}

async function pages(svc, entity, query, { sort = "created_date", limit = 500, maxPages = 4 } = {}) {
  const out = [];
  for (let p = 0; p < maxPages; p++) {
    const rows = await svc.entities[entity].filter(query, sort, limit, p * limit);
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}

/** One leased job per job type. Called by every maintenance handler before it touches anything. */
export async function assertSingleton(base44, job) {
  const svc = svcOf(base44);
  const leased = await svc.entities.BackgroundJob.filter({ job_type: job.job_type, status: "leased" }, "-created_date", 50);
  const now = Date.now();
  const other = leased.find((j) => j.id !== job.id && j.lease_expires_at && Date.parse(j.lease_expires_at) > now);
  if (other) throw Object.assign(new Error(`Another ${job.job_type} worker holds the lease (${other.id}); retrying later`), { code: "CONCURRENT_MAINTENANCE", retryable: true });
}

// ------------------------------------------------------------------ retention

// Audit actions the platform must keep regardless of policy: billing, security, identity,
// compliance and the maintenance trail itself.
export const REQUIRED_AUDIT_ACTIONS = /^(billing\.|payment\.|security\.|auth\.|sso\.|scim\.|compliance\.|legal\.|dsr\.|breach\.|abuse\.|retention\.|job\.dead_letter\.)/;
export const isRequiredAudit = (row) => REQUIRED_AUDIT_ACTIONS.test(String(row.action || "")) || row.metadata?.legal_hold === true;

const RETENTION_TARGETS = {
  audit_logs: { entity: "AuditLog", eligible: (r) => !isRequiredAudit(r) },
  usage_events: { entity: "UsageEvent", eligible: () => true },
  ai_operations: { entity: "AIOperation", eligible: (r) => !!r.finalized_at && r.status !== "running" },
  deployments: { entity: "Deployment", eligible: (r, ctx) => (["FAILED", "CANCELLED", "ROLLED_BACK"].includes(r.status) || (r.status === "LIVE" && !!r.superseded_at)) && !ctx.liveDeployments.has(r.id) },
  billing_events: { entity: "BillingEvent", eligible: (r) => r.status !== "received" },
  abuse_reports: { entity: "AbuseReport", eligible: (r) => ["actioned", "dismissed"].includes(r.status) },
  dsr_records: { entity: "DataSubjectRequest", eligible: (r) => ["completed", "rejected", "expired"].includes(r.status) },
  // Learning data reuses this sweep rather than introducing its own cleanup: only a sealed
  // (terminal) episode is a candidate, so an in-flight run's trajectory is never removed, and its
  // append-only event history is governed by its own policy so a partially expired episode cannot
  // be produced by a single capped run.
  trajectories: { entity: "Trajectory", eligible: (r) => r.status !== "ACTIVE" && !!r.sealed },
  trajectory_events: { entity: "TrajectoryEvent", eligible: () => true },
  // Runtime memory reuses this sweep rather than introducing its own cleanup: only a row that is
  // no longer active memory is a candidate, so a live memory item is never removed while its
  // superseded and archived history ages out under policy.
  memories: { entity: "MemoryItem", eligible: (r) => r.status !== "active" },
};

async function anonymize(svc, entity, row) {
  const patch = { user_id: null };
  if (entity === "AuditLog") patch.metadata = { anonymized: true };
  if (row.user_id === null && (entity !== "AuditLog" || row.metadata?.anonymized)) return false;
  await svc.entities[entity].update(row.id, patch);
  return true;
}

// An artifact is live while ANY remaining deployment or environment pointer references it.
async function deleteOrphanArtifacts(svc, projectIds, liveArtifacts, out) {
  for (const project_id of projectIds) {
    const [artifacts, deployments] = await Promise.all([
      svc.entities.DeploymentArtifact.filter({ project_id }, "created_date", 200),
      svc.entities.Deployment.filter({ project_id }, "-created_date", 500),
    ]);
    const referenced = new Set(deployments.map((d) => d.artifact_id).filter(Boolean));
    for (const a of artifacts) {
      if (referenced.has(a.id) || liveArtifacts.has(a.id)) continue;
      if (await del(svc, "DeploymentArtifact", a.id)) out.artifacts_deleted++;
    }
  }
}

/**
 * Applies every active RetentionPolicy. A workspace policy overrides the platform default for
 * that data type; retention_days 0 is a legal hold. `workspace_ids` narrows the sweep (used by the
 * certification suite; the scheduled job always runs unscoped).
 */
export async function enforceRetention(base44, { now = Date.now(), workspace_ids = null, max = MAINTENANCE_DEFAULTS.max_per_run } = {}) {
  const svc = svcOf(base44);
  const policies = (await svc.entities.RetentionPolicy.filter({ active: true }, "created_date", 200)).filter((p) => RETENTION_TARGETS[p.data_type]);
  const out = { policies: policies.length, deleted: 0, anonymized: 0, skipped_protected: 0, artifacts_deleted: 0, by_type: {} };
  if (!policies.length) return out;

  // Live environment pointers: their deployments and artifacts are never candidates.
  const projects = await pages(svc, "Project", {}, { sort: "-updated_date", maxPages: 2 });
  const liveDeployments = new Set(projects.flatMap((p) => [p.production_deployment_id, p.staging_deployment_id]).filter(Boolean));
  const liveArtifacts = new Set();
  const ctx = { liveDeployments, liveArtifacts };

  let budget = max;
  const touchedDeploymentProjects = new Set();
  for (const type of Object.keys(RETENTION_TARGETS)) {
    const target = RETENTION_TARGETS[type];
    const typed = policies.filter((p) => p.data_type === type);
    if (!typed.length) continue;
    const platform = typed.find((p) => !p.workspace_id) || null;
    const byWorkspace = new Map(typed.filter((p) => p.workspace_id).map((p) => [p.workspace_id, p]));
    const stat = (out.by_type[type] = { deleted: 0, anonymized: 0, protected: 0, held: 0 });

    // Scope: named workspaces, else every workspace with its own policy, plus everything the
    // platform default covers.
    const rows = workspace_ids
      ? (await Promise.all(workspace_ids.map((w) => pages(svc, target.entity, { workspace_id: w }, { maxPages: 2 })))).flat()
      : platform
        ? await pages(svc, target.entity, {}, { maxPages: 4 })
        : (await Promise.all([...byWorkspace.keys()].map((w) => pages(svc, target.entity, { workspace_id: w }, { maxPages: 2 })))).flat();

    if (type === "deployments") {
      for (const d of rows) if (liveDeployments.has(d.id) && d.artifact_id) liveArtifacts.add(d.artifact_id);
    }

    for (const row of rows.sort(oldest)) {
      if (budget <= 0) break;
      const policy = byWorkspace.get(row.workspace_id) || platform;
      if (!policy) continue;
      if (!policy.retention_days || policy.retention_days <= 0) { stat.held++; continue; }
      if (!before(row.created_date, now - policy.retention_days * DAY)) continue;
      if (!target.eligible(row, ctx)) { stat.protected++; out.skipped_protected++; continue; }
      if (policy.action === "anonymize") {
        if (await anonymize(svc, target.entity, row)) { stat.anonymized++; out.anonymized++; budget--; }
        continue;
      }
      if (policy.action === "archive") { stat.protected++; continue; } // cold storage not available: retained
      if (await del(svc, target.entity, row.id)) {
        stat.deleted++; out.deleted++; budget--;
        if (type === "deployments" && row.project_id) touchedDeploymentProjects.add(row.project_id);
      }
    }
    if (stat.deleted || stat.anonymized) {
      for (const p of typed) {
        await recordEvent(svc, { workspace_id: p.workspace_id || null, event_type: "retention_applied", legal_basis: "gdpr_art_6_1_c_legal", description: `Retention applied to ${type}: ${stat.deleted} deleted, ${stat.anonymized} anonymized`, metadata: { policy_id: p.id, data_type: type, deleted: stat.deleted, anonymized: stat.anonymized, protected: stat.protected } }).catch(() => {});
      }
    }
  }
  if (touchedDeploymentProjects.size) await deleteOrphanArtifacts(svc, touchedDeploymentProjects, liveArtifacts, out);
  if (out.deleted || out.anonymized) log("info", "maintenance.retention_applied", out);
  return out;
}

// -------------------------------------------------------------- staging blobs

/**
 * Releases the staging blob reference of runs that are terminal for longer than the TTL. A run
 * still executing (or recently finished — its staging is the evidence for a failure) is kept.
 * Storage offers no delete primitive, so release = drop the reference; the blob is then
 * unreachable from any platform record.
 */
export async function cleanupStagingBlobs(base44, { now = Date.now(), ttl_ms = MAINTENANCE_DEFAULTS.staging_ttl_ms, project_ids = null, max = MAINTENANCE_DEFAULTS.max_per_run } = {}) {
  const svc = svcOf(base44);
  const out = { scanned: 0, released: 0, preserved_active: 0 };
  const cutoff = now - ttl_ms;
  const rows = [];
  for (const status of RUN_TERMINAL) {
    const q = { status };
    if (project_ids) for (const pid of project_ids) rows.push(...(await svc.entities.AIRun.filter({ ...q, project_id: pid }, "created_date", 500)));
    else rows.push(...(await pages(svc, "AIRun", q, { maxPages: 2 })));
  }
  for (const run of rows.sort(oldest)) {
    if (out.released >= max) break;
    if (!run.staging_url) continue;
    out.scanned++;
    if (!before(run.completed_at || run.updated_date, cutoff)) continue;
    // Re-read: the row is the lock. A run that is somehow non-terminal again is left alone.
    const fresh = await svc.entities.AIRun.get(run.id).catch(() => null);
    if (!fresh || !fresh.staging_url) continue;
    if (!RUN_TERMINAL.includes(fresh.status)) { out.preserved_active++; continue; }
    await svc.entities.AIRun.update(run.id, { staging_url: null });
    out.released++;
  }
  if (out.released) log("info", "maintenance.staging_released", out);
  return out;
}

// ----------------------------------------------------- verification namespaces

const VERIFY_PREFIX = "verify_";
const RUN_VERIFYING = ["VALIDATING", "REPAIRING", "EXECUTING"];
const DEPLOY_VERIFYING = ["BUILDING", "VERIFYING", "DEPLOYING"];

/**
 * Deletes scratch data left by verification runs whose worker died before the finally-block
 * cleanup. A namespace is IN USE when its project has a run or deployment in a verifying state, or
 * when it is younger than the grace period — both are preserved.
 */
export async function cleanupOrphanVerification(base44, { now = Date.now(), grace_ms = MAINTENANCE_DEFAULTS.verification_grace_ms, project_ids = null, max = MAINTENANCE_DEFAULTS.max_per_run } = {}) {
  const svc = svcOf(base44);
  const out = { namespaces_scanned: 0, namespaces_deleted: 0, records_deleted: 0, relations_deleted: 0, preserved_active: 0 };
  const isOurs = (pid) => String(pid || "").startsWith(VERIFY_PREFIX) && (!project_ids || project_ids.some((p) => pid.startsWith(`${VERIFY_PREFIX}${p}_`)));

  // No prefix filter exists, so the sweep scans newest-first: crash leftovers are recent by nature,
  // and each pass frees room for the next to reach further back.
  const records = (await pages(svc, "AppRecord", {}, { sort: "-created_date", maxPages: 4 })).filter((r) => isOurs(r.project_id));
  const relations = (await pages(svc, "AppRelation", {}, { sort: "-created_date", maxPages: 2 })).filter((r) => isOurs(r.project_id));
  const namespaces = new Map();
  for (const r of [...records, ...relations]) {
    const ns = namespaces.get(r.project_id) || { records: [], relations: [], newest: 0 };
    (r.entity_name !== undefined ? ns.records : ns.relations).push(r);
    ns.newest = Math.max(ns.newest, Date.parse(r.created_date) || 0);
    namespaces.set(r.project_id, ns);
  }
  out.namespaces_scanned = namespaces.size;

  const activeProjects = new Set();
  const ownerOf = (ns) => ns.slice(VERIFY_PREFIX.length).replace(/_[^_]+$/, "");
  const owners = [...new Set([...namespaces.keys()].map(ownerOf))];
  for (const pid of owners) {
    for (const status of RUN_VERIFYING) if ((await svc.entities.AIRun.filter({ project_id: pid, status }, "-created_date", 1)).length) { activeProjects.add(pid); break; }
    if (activeProjects.has(pid)) continue;
    for (const status of DEPLOY_VERIFYING) if ((await svc.entities.Deployment.filter({ project_id: pid, status }, "-created_date", 1)).length) { activeProjects.add(pid); break; }
  }

  let deleted = 0;
  for (const [ns, data] of [...namespaces.entries()].sort((a, b) => a[1].newest - b[1].newest)) {
    if (deleted >= max) break;
    if (activeProjects.has(ownerOf(ns)) || data.newest > now - grace_ms) { out.preserved_active++; continue; }
    for (const r of data.records) if (await del(svc, "AppRecord", r.id)) { out.records_deleted++; deleted++; }
    for (const r of data.relations) if (await del(svc, "AppRelation", r.id)) { out.relations_deleted++; deleted++; }
    out.namespaces_deleted++;
  }
  if (out.namespaces_deleted) log("info", "maintenance.verification_cleaned", out);
  return out;
}

// ------------------------------------------------------------------ log pruning

const isSecurityRecord = (inv) => inv.status === 401 || inv.status === 403 || /auth|signature|forbidden|csrf/i.test(String(inv.error_class || ""));

/**
 * Prunes FunctionInvocation logs and SystemMetric buckets. A workspace/platform `user_activity`
 * retention policy overrides the default window. Auth/security failures are kept for a full year;
 * AuditLog is never touched here (it is governed by the audit_logs retention policy only).
 */
export async function pruneLogs(base44, { now = Date.now(), project_ids = null, max = MAINTENANCE_DEFAULTS.max_per_run } = {}) {
  const svc = svcOf(base44);
  const policy = await getRetentionPolicy(svc, { workspace_id: null, data_type: "user_activity" }).catch(() => null);
  const days = policy?.retention_days > 0 ? policy.retention_days : MAINTENANCE_DEFAULTS.log_retention_days;
  const out = { retention_days: days, invocations_deleted: 0, security_preserved: 0, metrics_deleted: 0 };
  const cutoff = now - days * DAY;
  const securityCutoff = now - MAINTENANCE_DEFAULTS.security_log_retention_days * DAY;

  const rows = project_ids
    ? (await Promise.all(project_ids.map((p) => svc.entities.FunctionInvocation.filter({ project_id: p }, "created_date", 500)))).flat()
    : await pages(svc, "FunctionInvocation", {}, { maxPages: 2 });
  for (const inv of rows.sort(oldest)) {
    if (out.invocations_deleted >= max) break;
    if (!before(inv.created_date, cutoff)) continue;
    if (isSecurityRecord(inv) && !before(inv.created_date, securityCutoff)) { out.security_preserved++; continue; }
    if (await del(svc, "FunctionInvocation", inv.id)) out.invocations_deleted++;
  }
  if (!project_ids) {
    const metrics = await pages(svc, "SystemMetric", {}, { sort: "window_key", maxPages: 2 });
    for (const m of metrics) {
      if (out.metrics_deleted >= max) break;
      if (before(m.window_start || `${m.window_key}:00.000Z`, cutoff) && (await del(svc, "SystemMetric", m.id))) out.metrics_deleted++;
    }
  }
  if (out.invocations_deleted || out.metrics_deleted) log("info", "maintenance.logs_pruned", out);
  return out;
}

// -------------------------------------------------------- package supply chain

/**
 * Sweeps the package supply chain: abandoned STAGED fetches past their own expiry, aged terminal
 * fetch history, and verified cache entries nothing has reused for the unused window.
 *
 * Conservative by construction: a staged fetch is only a candidate once its `expires_at` has passed
 * (so a preparation in flight is never removed), and a cache entry is preserved while ANY project
 * dependency still pins its exact integrity — a project's lockfile can therefore never be left
 * pointing at an artifact the sweep deleted.
 */
export async function cleanupPackageSupply(base44, {
  now = Date.now(), project_ids = null,
  fetch_days = MAINTENANCE_DEFAULTS.package_fetch_retention_days,
  unused_days = MAINTENANCE_DEFAULTS.package_cache_unused_days,
  max = MAINTENANCE_DEFAULTS.max_per_run,
} = {}) {
  const svc = svcOf(base44);
  const out = { staged_expired: 0, fetches_deleted: 0, cache_entries_deleted: 0, preserved_in_use: 0, preserved_active: 0 };

  const fetches = project_ids
    ? (await Promise.all(project_ids.map((p) => svc.entities.PackageFetch.filter({ project_id: p }, "created_date", 500)))).flat()
    : await pages(svc, "PackageFetch", {}, { maxPages: 2 });

  for (const row of fetches.sort(oldest)) {
    if (out.staged_expired + out.fetches_deleted >= max) break;
    if (row.status === "staged") {
      // The fetch's own expiry is the lock: before it, the preparation may still be running.
      if (!row.expires_at || !before(row.expires_at, now)) { out.preserved_active++; continue; }
      const fresh = await svc.entities.PackageFetch.get(row.id).catch(() => null);
      if (!fresh || fresh.status !== "staged") { out.preserved_active++; continue; }
      await svc.entities.PackageFetch.update(row.id, { status: "expired", failure_class: fresh.failure_class || "registry_unavailable", detail: "the preparation was abandoned before it completed", expires_at: null });
      out.staged_expired++;
      continue;
    }
    if (before(row.created_at || row.created_date, now - fetch_days * DAY) && (await del(svc, "PackageFetch", row.id))) out.fetches_deleted++;
  }

  // Cache entries are shared across projects, so the scheduled (unscoped) sweep owns them.
  if (!project_ids) {
    const entries = await pages(svc, "PackageCacheEntry", {}, { maxPages: 2 });
    const pinned = new Set((await pages(svc, "ProjectDependency", {}, { sort: "package_name", maxPages: 2 })).map((d) => `${d.package_name}@${d.resolved_version}:${d.integrity || ""}`));
    for (const entry of entries.sort(oldest)) {
      if (out.cache_entries_deleted >= max) break;
      if (pinned.has(`${entry.package_name}@${entry.version}:${entry.integrity}`)) { out.preserved_in_use++; continue; }
      if (!before(entry.last_used_at || entry.verified_at || entry.created_date, now - unused_days * DAY)) continue;
      if (await del(svc, "PackageCacheEntry", entry.id)) out.cache_entries_deleted++;
    }
  }
  if (out.staged_expired || out.fetches_deleted || out.cache_entries_deleted) log("info", "maintenance.package_supply_cleaned", out);
  return out;
}

// ------------------------------------------------------- app analytics (#30)

/**
 * Applies each project's own analytics retention (AppAnalyticsConfig.retention_days) through THIS
 * existing sweep — the analytics layer runs no scheduler and no cleanup of its own.
 *
 * Conservative like every other sweep: a project with retention_days 0 is an explicit "keep
 * indefinitely" and is skipped, an ACTIVE session is never removed (only sessions ended longer ago
 * than the window), and the per-run cap bounds how much one tick may delete.
 */
export async function cleanupAppAnalytics(base44, { now = Date.now(), project_ids = null, max = MAINTENANCE_DEFAULTS.max_per_run } = {}) {
  const svc = svcOf(base44);
  const out = { projects: 0, events_deleted: 0, sessions_deleted: 0, held: 0, preserved_active: 0 };
  const configs = project_ids
    ? (await Promise.all(project_ids.map((p) => svc.entities.AppAnalyticsConfig.filter({ project_id: p }, "created_date", 5)))).flat()
    : await pages(svc, "AppAnalyticsConfig", {}, { maxPages: 2 });
  let budget = max;
  for (const cfg of configs) {
    if (budget <= 0) break;
    out.projects++;
    const days = Number(cfg.retention_days);
    if (!Number.isFinite(days) || days <= 0) { out.held++; continue; }
    const cutoff = now - days * DAY;
    for (const e of (await svc.entities.AppAnalyticsEvent.filter({ project_id: cfg.project_id }, "created_date", 500)).sort(oldest)) {
      if (budget <= 0) break;
      if (!before(e.occurred_at || e.created_date, cutoff)) continue;
      if (await del(svc, "AppAnalyticsEvent", e.id)) { out.events_deleted++; budget--; }
    }
    for (const s of (await svc.entities.AppAnalyticsSession.filter({ project_id: cfg.project_id }, "created_date", 500)).sort(oldest)) {
      if (budget <= 0) break;
      if (s.status !== "ended") { out.preserved_active++; continue; }
      if (!before(s.ended_at || s.created_date, cutoff)) continue;
      if (await del(svc, "AppAnalyticsSession", s.id)) { out.sessions_deleted++; budget--; }
    }
  }
  if (out.events_deleted || out.sessions_deleted) log("info", "maintenance.app_analytics_cleaned", out);
  return out;
}

// ------------------------------------------------------------ dead letters

export async function listDeadLetters(base44, { queue = null, limit = 50 } = {}) {
  const svc = svcOf(base44);
  const rows = await svc.entities.BackgroundJob.filter({ status: "dead_letter", ...(queue ? { queue } : {}) }, "-completed_at", limit);
  return rows.map((j) => ({
    id: j.id, queue: j.queue, job_type: j.job_type, attempts: j.attempts, error_code: j.error_code, last_error: j.last_error,
    attempt_log: j.attempt_log || [], workspace_id: j.workspace_id, project_id: j.project_id, trace_id: j.trace_id,
    created_date: j.created_date, completed_at: j.completed_at,
    expires_at: new Date((Date.parse(j.completed_at || j.created_date) || 0) + MAINTENANCE_DEFAULTS.dead_letter_retention_days * DAY).toISOString(),
  }));
}

/**
 * Removes dead-lettered jobs past retention — after writing a compact diagnostic AuditLog entry,
 * so the failure remains explainable after the row is gone — and compacts old succeeded/
 * cancelled jobs. Pending, leased and retrying jobs are never candidates.
 */
export async function cleanupDeadLetters(base44, { now = Date.now(), queues = null, dead_letter_days = MAINTENANCE_DEFAULTS.dead_letter_retention_days, history_days = MAINTENANCE_DEFAULTS.job_history_retention_days, max = MAINTENANCE_DEFAULTS.max_per_run } = {}) {
  const svc = svcOf(base44);
  const out = { dead_letters_expired: 0, dead_letters_retained: 0, history_compacted: 0 };
  const load = async (status) => queues
    ? (await Promise.all(queues.map((q) => svc.entities.BackgroundJob.filter({ status, queue: q }, "created_date", 500)))).flat()
    : pages(svc, "BackgroundJob", { status }, { maxPages: 2 });

  for (const job of (await load("dead_letter")).sort(oldest)) {
    if (out.dead_letters_expired >= max) break;
    if (!before(job.completed_at || job.created_date, now - dead_letter_days * DAY)) { out.dead_letters_retained++; continue; }
    // Diagnostics outlive the row. Idempotent through the resource id: a retry after a crash
    // between audit and delete finds the entry and does not write a second one.
    const existing = await svc.entities.AuditLog.filter({ action: "job.dead_letter.expired", resource_id: job.id }, "-created_date", 1);
    if (!existing.length) {
      await svc.entities.AuditLog.create({
        workspace_id: job.workspace_id || "platform", project_id: job.project_id || null, user_id: null,
        action: "job.dead_letter.expired", resource: "BackgroundJob", resource_id: job.id,
        metadata: { queue: job.queue, job_type: job.job_type, attempts: job.attempts, error_code: job.error_code, last_error: String(job.last_error || "").slice(0, 300), attempt_log: (job.attempt_log || []).slice(-5), trace_id: job.trace_id, created_date: job.created_date, completed_at: job.completed_at },
      });
    }
    if (await del(svc, "BackgroundJob", job.id)) out.dead_letters_expired++;
  }
  for (const status of ["succeeded", "cancelled"]) {
    for (const job of (await load(status)).sort(oldest)) {
      if (out.history_compacted >= max) break;
      if (before(job.completed_at || job.created_date, now - history_days * DAY) && (await del(svc, "BackgroundJob", job.id))) out.history_compacted++;
    }
  }
  if (out.dead_letters_expired || out.history_compacted) log("info", "maintenance.queue_compacted", out);
  return out;
}

// ------------------------------------------------- billing lifecycle (P-8.3)

const ENTITLED_SUB_STATUSES = ["active", "trialing"];

// A terminal one-time transition (expiry, trial end) carries no billing event of its own, so its
// audit entry is deduped by (action, subscription): a repeated sweep finds the entry and writes
// nothing — the same pattern the dead-letter diagnostics use.
async function auditOnce(svc, { workspace_id, action, resource_id, metadata }) {
  const existing = await svc.entities.AuditLog.filter({ action, resource_id }, "-created_date", 1);
  if (existing.length) return false;
  await audit(svc, { workspace_id, user_id: null, action, resource: "Subscription", resource_id, metadata: metadata || {} });
  return true;
}

/**
 * Scheduled billing maintenance: advances subscription lifecycle state that depends only on the
 * passage of time — the SAME transitions the on-read path (commerce, billingWebhook) applies via
 * applyScheduledChanges, so a workspace nobody visits still converges. Reuse, not a second model:
 *
 *   • a trial past its end and a cancel-at-period-end past its date expire,
 *   • a scheduled downgrade past its date takes effect through processBillingEvent — a
 *     period-keyed, idempotent credit grant, never a direct ledger write,
 *   • entitlements are re-derived from the canonical subscription state (a non-active
 *     subscription holds none; the stored projection is aligned with entitlementsFor's derivation),
 *   • the implicit Free-plan period grant rolls over for subscription-less workspaces.
 *
 * Suspended and terminated workspaces are skipped entirely — no transitions and no grants while a
 * workspace cannot serve; the on-read path re-derives state on reactivation. The ledger stays the
 * only credit truth: every grant flows through processBillingEvent → recordEvent, and no balance
 * field is ever written directly by this sweep.
 */
export async function runBillingMaintenance(base44, { now = Date.now(), workspace_ids = null, max = MAINTENANCE_DEFAULTS.max_per_run } = {}) {
  const svc = svcOf(base44);
  const at = new Date(now);
  const out = {
    workspaces_scanned: 0, processed: 0, skipped_suspended: 0, skipped_terminated: 0,
    transitions: { downgrade_applied: 0, expired: 0, trial_ended: 0, renewed: 0 },
    entitlements_cleared: 0, free_grants: 0, audits: 0,
  };
  const workspaces = workspace_ids
    ? (await Promise.all(workspace_ids.map((id) => svc.entities.Workspace.get(id).catch(() => null)))).filter(Boolean)
    : await pages(svc, "Workspace", {}, { maxPages: 4 });

  for (const ws of workspaces.sort(oldest)) {
    if (out.processed >= max) break;
    out.workspaces_scanned++;
    if (ws.status === "terminated") { out.skipped_terminated++; continue; }
    // No lifecycle action, and above all no credit grant, while a workspace cannot serve. The
    // on-read path re-derives state the moment the workspace is active again.
    if (ws.status === "suspended") { out.skipped_suspended++; continue; }
    out.processed++;

    const sub = await subscriptionFor(svc, ws.id);
    if (!sub) {
      // Free-plan rollover: the same period-keyed grant applyScheduledChanges performs on read,
      // so a repeated sweep (or one racing the on-read path) grants exactly once per period.
      const free = await grantFreePeriodCredits(svc, { workspace_id: ws.id, period_key: periodKeyFor("monthly", at) });
      if (free && !free.duplicate) out.free_grants++;
      continue;
    }

    // Due transitions, through the canonical lifecycle function — idempotent by its own design.
    const applied = await applyScheduledChanges(svc, { workspace_id: ws.id, now: at });
    if (applied.changed && applied.action) {
      out.transitions[applied.action] = (out.transitions[applied.action] || 0) + 1;
      if (applied.action === "downgrade_applied") {
        // A downgrade IS a money event: the audit anchors on the BillingEvent it produced, unique
        // per transition — idempotent by construction, like commerce's own billing audits.
        await audit(svc, {
          workspace_id: ws.id, user_id: null, action: "billing.scheduled.downgrade_applied",
          resource: "BillingEvent", resource_id: applied.event?.id || null,
          metadata: { plan_code: applied.plan_code, previous_plan_code: sub.plan_code },
        });
        out.audits++;
      } else if (applied.action === "renewed") {
        // A renewal IS a money event too: the audit anchors on the BillingEvent it produced, so
        // every cycle's renewal stays auditable without suppressing the next cycle's entry.
        await audit(svc, {
          workspace_id: ws.id, user_id: null, action: "billing.scheduled.renewed",
          resource: "BillingEvent", resource_id: applied.event?.id || null,
          metadata: { plan_code: applied.plan_code },
        });
        out.audits++;
      } else if (await auditOnce(svc, { workspace_id: ws.id, action: `billing.scheduled.${applied.action}`, resource_id: sub.id, metadata: { plan_code: sub.plan_code } })) {
        out.audits++;
      }
    }

    // Entitlement recalculation from canonical state: a lapsed subscription holds none, and the
    // stored projection is aligned with the derivation (entitlementsFor) so no reader can mistake
    // a lapsed subscription for an entitled one.
    const current = await subscriptionFor(svc, ws.id);
    if (current && !ENTITLED_SUB_STATUSES.includes(current.status) && current.entitlements && Object.keys(current.entitlements).length) {
      await svc.entities.Subscription.update(current.id, { entitlements: {} });
      out.entitlements_cleared++;
    }
  }
  if (out.processed) log("info", "maintenance.billing_lifecycle_applied", out);
  return out;
}