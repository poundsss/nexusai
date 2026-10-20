// Platform administration: operational visibility across every workspace.
//
// AUTHORIZATION is platform-level and resolved SERVER-side from the authenticated user's own User
// record. Workspace roles are deliberately irrelevant here: being the owner or admin of a workspace
// grants nothing on this surface, so a workspace role can never be escalated into platform access.
// Nothing in the request body — no role, no flag, no workspace id — participates in the decision.
//
// SECURITY: every record is projected through an explicit key allowlist and then through the shared
// scrubber, so a secret value, OAuth token, API key or credential has no route into a response even
// if a future field is added to one of these entities. Reads are the default; the console performs
// no mutations of its own and calls no privileged operation that is not already protected by its
// own endpoint.
//
// OBSERVABILITY: this module reuses the existing AuditLog, TraceEvent, BackgroundJob and
// maintenance/queue diagnostics. It creates no second logging system.
import { scrub } from "./tracing.ts";
import { queueStats } from "./jobQueue.ts";
import { listDeadLetters } from "./maintenance.ts";

const svcOf = (base44) => base44.asServiceRole || base44;

/**
 * The ONE platform-admin gate. Resolves the caller's platform role from their stored User record;
 * anything other than the platform `admin` role is refused.
 */
export async function requirePlatformAdmin(base44, user) {
  if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401, code: "AUTH_REQUIRED" });
  const svc = svcOf(base44);
  // Read the stored record rather than trusting the session projection or anything client-supplied.
  const record = await svc.entities.User.get(user.id).catch(() => null);
  const role = String(record?.role || "");
  if (role !== "admin") {
    throw Object.assign(new Error("Platform administration is restricted to platform administrators"), { status: 403, code: "NOT_PLATFORM_ADMIN" });
  }
  return { user_id: user.id, email: record.email || user.email || null, role };
}

// --- projection ---------------------------------------------------------------

// Explicit allowlists. A key not named here is never returned, which is what keeps credential
// fields (ProjectSecret.value, WorkspaceSecret.value, MCP auth headers, GitHub tokens) out by
// construction rather than by pattern matching.
const FIELDS = {
  User: ["id", "email", "full_name", "role", "created_date"],
  Workspace: ["id", "name", "owner_id", "status", "credits_balance", "reserved_credits", "balance_synced_at", "created_date"],
  Project: ["id", "workspace_id", "name", "status", "version_count", "last_build_status", "public_slug", "created_date", "updated_date"],
  AIRun: ["id", "project_id", "status", "phase", "mode", "model", "provider", "trace_id", "error", "credits_charged", "repair_attempts", "version_number", "duration_ms", "created_date", "completed_at"],
  Subscription: ["id", "workspace_id", "plan_code", "plan_id", "status", "interval", "current_period_end", "cancel_at_period_end", "trial_ends_at", "created_date"],
  BillingPlan: ["id", "code", "name", "interval", "price_cents", "included_credits", "overage_policy", "active"],
  Deployment: ["id", "project_id", "workspace_id", "environment", "status", "version_number", "artifact_id", "error_code", "created_date", "completed_at", "superseded_at"],
  MCPConnection: ["id", "workspace_id", "name", "status", "enabled", "transport", "tool_count", "last_discovery_at", "last_error_code", "created_date"],
  GitHubLink: ["id", "project_id", "workspace_id", "repo_full_name", "repo", "owner", "branch", "status", "sync_direction", "last_synced_at", "last_error_code", "created_date"],
  AuditLog: ["id", "workspace_id", "project_id", "user_id", "action", "resource", "resource_id", "created_date"],
  TraceEvent: ["id", "trace_id", "project_id", "workspace_id", "event_type", "name", "status", "attempt", "error_code", "duration_ms", "at"],
  BackgroundJob: ["id", "queue", "job_type", "status", "attempts", "max_attempts", "error_code", "workspace_id", "project_id", "trace_id", "created_date", "completed_at"],
};

/** Projects one row onto its allowlist and scrubs what remains. */
export function project(entity, row) {
  const allow = FIELDS[entity] || [];
  const out = {};
  for (const key of allow) if (row && key in row) out[key] = row[key];
  return scrub(out);
}

const projectAll = (entity, rows) => (rows || []).map((r) => project(entity, r));

// --- read-only sections -------------------------------------------------------

const RUN_FAILED = ["FAILED", "STALE"];

/**
 * The console's single read. Every section is bounded, cross-workspace by design (this is the
 * platform view) and projected — the caller has already been proven to be a platform admin.
 */
export async function platformOverview(base44, { limit = 20 } = {}) {
  const svc = svcOf(base44);
  const n = Math.min(Math.max(1, Number(limit) || 20), 100);

  const [users, workspaces, projects, runs, subscriptions, plans, deployments, mcp, github, audit, traces, jobs] = await Promise.all([
    svc.entities.User.list("-created_date", n).catch(() => []),
    svc.entities.Workspace.filter({}, "-created_date", n).catch(() => []),
    svc.entities.Project.filter({}, "-updated_date", n).catch(() => []),
    svc.entities.AIRun.filter({}, "-created_date", n * 2).catch(() => []),
    svc.entities.Subscription.filter({}, "-created_date", n).catch(() => []),
    svc.entities.BillingPlan.filter({ active: true }, "tier_rank", 20).catch(() => []),
    svc.entities.Deployment.filter({}, "-created_date", n).catch(() => []),
    svc.entities.MCPConnection.filter({}, "-created_date", n).catch(() => []),
    svc.entities.GitHubLink.filter({}, "-created_date", n).catch(() => []),
    svc.entities.AuditLog.filter({}, "-created_date", n).catch(() => []),
    svc.entities.TraceEvent.filter({}, "-created_date", n).catch(() => []),
    svc.entities.BackgroundJob.filter({}, "-created_date", n).catch(() => []),
  ]);

  const [queues, deadLetters] = await Promise.all([
    queueStats(svc).catch(() => ({ queues: {}, totals: {} })),
    listDeadLetters(svc, { limit: n }).catch(() => []),
  ]);

  const failures = runs.filter((r) => RUN_FAILED.includes(r.status));
  const creditsTotal = workspaces.reduce((sum, w) => sum + (w.credits_balance || 0), 0);

  return {
    generated_at: new Date().toISOString(),
    totals: {
      users: users.length,
      workspaces: workspaces.length,
      projects: projects.length,
      runs: runs.length,
      failed_runs: failures.length,
      active_subscriptions: subscriptions.filter((s) => ["active", "trialing"].includes(String(s.status))).length,
      live_deployments: deployments.filter((d) => String(d.status) === "LIVE").length,
      mcp_connections: mcp.length,
      github_links: github.length,
      credits_balance: creditsTotal,
      dead_letters: deadLetters.length,
      suspended_workspaces: workspaces.filter((w) => w.status !== "active").length,
    },
    users: projectAll("User", users),
    workspaces: projectAll("Workspace", workspaces),
    projects: projectAll("Project", projects),
    runs: projectAll("AIRun", runs.slice(0, n)),
    run_failures: projectAll("AIRun", failures.slice(0, n)),
    billing: {
      subscriptions: projectAll("Subscription", subscriptions),
      plans: projectAll("BillingPlan", plans),
      credits: workspaces.map((w) => ({ workspace_id: w.id, name: w.name, balance: w.credits_balance || 0, reserved: w.reserved_credits || 0 })),
    },
    deployments: projectAll("Deployment", deployments),
    connections: {
      mcp: projectAll("MCPConnection", mcp),
      github: projectAll("GitHubLink", github),
    },
    jobs: {
      queues: queues.queues || {},
      totals: queues.totals || {},
      recent: projectAll("BackgroundJob", jobs),
      dead_letters: projectAll("BackgroundJob", deadLetters),
    },
    diagnostics: {
      audit: projectAll("AuditLog", audit),
      traces: projectAll("TraceEvent", traces),
    },
  };
}