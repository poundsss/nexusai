// THE Builder tool execution boundary.
//
// Every Builder tool call — model-issued or platform-issued — goes through a session created
// here. The session is what makes an execution legitimate: it resolves authorization from
// server-side facts BEFORE a tool runs, refuses a tool the caller's mode or role may not use,
// executes it through the existing registry (shared/tools.ts) or an existing platform service,
// and records the audit row + correlation span afterwards. Nothing in this module re-implements
// a tool's business logic: build, commit/version and restore are delegated to buildEngine,
// commitJournal and versionRestore exactly as the pipeline and the UI already use them.
//
// TRUST MODEL — nothing about authorization comes from the caller's payload:
//   • the user is the authenticated identity;
//   • the project is loaded by id and the WORKSPACE is read off the resolved project;
//   • the role is resolved from Workspace.owner_id / an active WorkspaceMember row (rbac.ts);
//   • the capability required is the TOOL's, declared here, not stated by the caller;
//   • a run may only be used with the project it actually belongs to;
//   • a rejected call throws BEFORE the handler runs, so it can have no side effect.
import { TOOL_REGISTRY, allowedTools, executeTool, summarizeToolCall } from "./tools.ts";
import { loadAuthorizedProject, audit } from "./authz.ts";
import { can, resolveRole } from "./rbac.ts";
import { runBuild } from "./buildEngine.ts";
import { activeFiles, computeChanges } from "./projectFs.ts";
import { prepareCommit, finalizeCommit, rollbackCommit } from "./commitJournal.ts";
import { restoreProjectVersion } from "./versionRestore.ts";
import { recordBuild } from "./persistence.ts";
import { recordSpan, newSpanId } from "./tracing.ts";
import { reconcileArchitectureAfterMutation } from "./architectureReconcile.ts";

const svcOf = (base44) => base44.asServiceRole || base44;
export const routerError = (code, message, status = 403) => Object.assign(new Error(message), { code, status });

// Tool metadata the registry does not carry: what the tool belongs to, which workspace
// capability it requires, and whether its execution is auditable. Declared explicitly and
// verified to cover the whole registry (see toolContracts), so a NEW tool cannot be routed
// until its authorization and audit posture have been stated — it fails closed.
const TOOL_META = {
  read_file: { category: "filesystem", capability: "project.read" },
  list_files: { category: "filesystem", capability: "project.read" },
  search_project: { category: "filesystem", capability: "project.read" },
  get_project_state: { category: "inspect", capability: "project.read" },
  list_functions: { category: "inspect", capability: "project.read" },
  list_secrets: { category: "secrets", capability: "project.read" },
  list_integrations: { category: "integration", capability: "project.read" },
  get_integration: { category: "integration", capability: "project.read" },
  list_operations: { category: "integration", capability: "project.read" },
  get_operation: { category: "integration", capability: "project.read" },
  list_mcp_connections: { category: "mcp", capability: "project.read" },
  mcp_call: { category: "mcp", capability: "project.read", audit: true },
  // Scheduled Superagent automations (Phase 16C-4D): router contracts for the agent_schedule_*
  // registry tools. They are platform-level lifecycle tools — the metadata keeps toolContracts()
  // complete (a registry entry without it cannot route), capability project.write keeps viewers
  // out, and the AGENT loop is their only executor.
  // Cross-app data access (Superagent parity): a read-only workspace-scoped tool. Read
  // capability, audited — every cross-app read leaves an audit trail like every write does.
  read_app_data: { category: "cross_app", capability: "project.read", audit: true },
  agent_schedule_create: { category: "schedule", capability: "project.write", audit: true },
  agent_schedule_update: { category: "schedule", capability: "project.write", audit: true },
  agent_schedule_pause: { category: "schedule", capability: "project.write", audit: true },
  agent_schedule_resume: { category: "schedule", capability: "project.write", audit: true },
  agent_schedule_archive: { category: "schedule", capability: "project.write", audit: true },
  agent_schedule_restore: { category: "schedule", capability: "project.write", audit: true },
  declare_secret: { category: "secrets", capability: "project.write", audit: true },
  create_integration: { category: "integration", capability: "integration.manage", audit: true },
  update_integration: { category: "integration", capability: "integration.manage", audit: true },
  import_openapi: { category: "integration", capability: "integration.manage", audit: true },
  delete_integration: { category: "integration", capability: "integration.manage", audit: true },
  write_file: { category: "filesystem", capability: "project.write" },
  patch_file: { category: "filesystem", capability: "project.write" },
  delete_file: { category: "filesystem", capability: "project.write", audit: true },
  apply_patches: { category: "code", capability: "project.write" },
  insert_at: { category: "code", capability: "project.write" },
  replace_range: { category: "code", capability: "project.write" },
  replace_symbol: { category: "code", capability: "project.write" },
  rename_symbol: { category: "code", capability: "project.write" },
  move_file: { category: "filesystem", capability: "project.write" },
  copy_file: { category: "filesystem", capability: "project.write" },
  delete_files: { category: "filesystem", capability: "project.write", audit: true },
  create_entity: { category: "data", capability: "project.write", audit: true },
  update_entity: { category: "data", capability: "project.write", audit: true },
  // System tools: the platform issues these, not the model. Each delegates to the service that
  // already owns the behaviour.
  run_build: { category: "system", capability: "project.read", system: true },
  create_snapshot: { category: "system", capability: "project.write", system: true, audit: true },
  restore_snapshot: { category: "system", capability: "version.restore", system: true, audit: true },
};

// Existing capabilities exposed through the router. Both are READ-ONLY projections of records
// the platform already maintains (GitHubLink, Deployment); credentials, tokens and installation
// secrets are not part of either projection, so no tool output can carry one.
const EXTRA_TOOLS = [
  {
    name: "github_status", permission: "read", description: "Report whether this project is linked to a GitHub repository, and the state of its most recent sync. Credentials and tokens are never included.",
    input: {}, output: { linked: "boolean", repository: "string", sync: "object" },
  },
  {
    name: "deployment_status", permission: "read", description: "Report this project's most recent deployments per environment (status, version, timestamps). Read-only: deploying is not a tool.",
    input: {}, output: { deployments: "array" },
  },
];

const EXTRA_META = {
  github_status: { category: "source_control", capability: "project.read", platform: true },
  deployment_status: { category: "deployment", capability: "project.read", platform: true },
};

/**
 * The full contract of every routable tool: name, category, permission, input schema, output
 * schema, the capability it requires, its audit/trace posture and whether a handler exists.
 * This is the registry EXTENDED, not replaced — TOOL_REGISTRY remains the source of the tools
 * the model is offered.
 */
export function toolContracts() {
  return [...TOOL_REGISTRY, ...EXTRA_TOOLS].map((t) => {
    const meta = TOOL_META[t.name] || EXTRA_META[t.name];
    if (!meta) throw routerError("TOOL_CONTRACT_MISSING", `Tool '${t.name}' has no router contract (category/capability); it cannot be executed`, 500);
    return {
      name: t.name,
      category: meta.category,
      permission: t.permission,
      description: t.description,
      input_schema: t.input || {},
      output_schema: t.output || {},
      required: t.required || [],
      capability: meta.capability,
      system: !!meta.system,
      platform: !!meta.platform,
      // Audit/trace metadata: every execution is traced; these tools additionally write an
      // immutable audit row.
      audit: !!meta.audit,
      audit_action: `tool.${t.name}`,
      traced: true,
      handler: meta.system || meta.platform ? "platform" : "registry",
    };
  });
}

export const toolContract = (name) => toolContracts().find((t) => t.name === name) || null;

/** Tools a mode may use, as full contracts. Mode restrictions come from the existing registry. */
export function routableTools(mode) {
  const permitted = new Set(allowedTools(mode).map((t) => t.name));
  return toolContracts().filter((t) => permitted.has(t.name) || (t.permission === "read" && EXTRA_META[t.name]) || t.system);
}

// --- platform / system handlers (delegating, never re-implementing) -----------

async function handleRunBuild(base44, session, ctx) {
  if (!ctx?.fs) throw routerError("INVALID_CONTEXT", "run_build needs the run's project state", 400);
  const build = runBuild(ctx.fs, ctx.entities || [], ctx.secrets || []);
  const record = await recordBuild(base44, session.project.id, session.run_id || null, build);
  return { build_id: record.id, status: build.status, errors: build.errors, file_count: build.file_count, duration_ms: build.duration_ms, logs: build.logs.slice(0, 40) };
}

// A snapshot IS a commit: the same journalled, crash-safe path the AI pipeline uses, so a
// snapshot and an AI commit can never diverge in what they persist or how they recover.
async function handleCreateSnapshot(base44, session, ctx, args) {
  if (!ctx?.fs) throw routerError("INVALID_CONTEXT", "create_snapshot needs the run's project state", 400);
  const changes = computeChanges(ctx.fs);
  const run = { id: session.run_id || `snapshot:${session.project.id}:${Date.now()}`, base_version_number: session.project.version_count || 0 };
  const journal = await prepareCommit(base44, {
    project: session.project, workspace: session.workspace, run,
    message: String(args.message || "Snapshot").slice(0, 120),
    changedFiles: changes,
    target: {
      files: activeFiles(ctx.fs),
      // `rls` always recorded (null = no rules), so restoring this snapshot is exact.
      entities: (ctx.entities || []).map((e) => ({ name: e.name, fields: e.fields, rls: e.rls ?? null })),
      // Secret REFERENCES only. A snapshot never carries a value.
      secrets: (ctx.secrets || []).map((s) => ({ name: s.name, description: s.description || "", required: s.required !== false })),
    },
  });
  try {
    const out = await finalizeCommit(base44, journal, { runId: run.id });
    // Architecture reconciliation — AFTER the snapshot commit, best-effort via the shared wrapper.
    // `session.user` is the authenticated caller whose session authorized the commit; a failure
    // never fails the snapshot that already landed.
    if (session.user) await reconcileArchitectureAfterMutation(base44, session.user, { project_id: session.project.id, run_id: session.run_id || null });
    return { version: out.version.number, version_id: out.version.id, changed_files: changes.length };
  } catch (e) {
    await rollbackCommit(base44, journal, e.message).catch(() => {});
    throw e;
  }
}

async function handleRestoreSnapshot(base44, session, _ctx, args) {
  const out = await restoreProjectVersion(base44, {
    project: session.project, workspace: session.workspace, user: session.user,
    versionId: String(args.version_id || ""), baseVersionNumber: args.base_version_number ?? null, force: !!args.force,
  });
  return { version: out.version, version_id: out.version_id, restored_from_version: out.restored_from_version, changed_files: out.changed_files.length };
}

// Read-only projection: link state and last sync only. No token, installation id or credential
// is read here, so nothing of the sort can reach the model or a tool result.
async function handleGithubStatus(base44, session) {
  const svc = svcOf(base44);
  const links = await svc.entities.GitHubLink.filter({ project_id: session.project.id }, "-created_date", 1).catch(() => []);
  const link = links[0];
  if (!link) return { linked: false, repository: null, sync: null };
  const runs = await svc.entities.GitSyncRun.filter({ project_id: session.project.id }, "-created_date", 1).catch(() => []);
  const run = runs[0];
  return {
    linked: link.status === "linked" || !!link.repo_full_name,
    repository: link.repo_full_name || null,
    branch: link.branch || null,
    status: link.status || null,
    sync: run ? { status: run.status, direction: run.direction || null, started_at: run.created_date, error: run.error || null } : null,
  };
}

async function handleDeploymentStatus(base44, session) {
  const rows = await svcOf(base44).entities.Deployment.filter({ project_id: session.project.id }, "-created_date", 10).catch(() => []);
  return {
    deployments: rows.map((d) => ({
      id: d.id, environment: d.environment || "production", status: d.status,
      version_number: d.version_number ?? null, completed_at: d.completed_at || null, error: d.error || null,
    })),
  };
}

const PLATFORM_HANDLERS = {
  run_build: handleRunBuild,
  create_snapshot: handleCreateSnapshot,
  restore_snapshot: handleRestoreSnapshot,
  github_status: handleGithubStatus,
  deployment_status: handleDeploymentStatus,
};

// --- the session (authorization resolved once, enforced per call) -------------

/**
 * Creates the authoritative execution boundary for one Builder operation.
 *
 * Authorization is resolved HERE, server-side: the project is loaded by id, its workspace is
 * read off the project record, and the caller's role is resolved from workspace facts. A run id
 * is accepted only if the persisted run actually belongs to that project, so a run cannot be
 * used to reach across projects. A caller who is not a member never gets a session at all.
 */
export async function createToolSession(base44, { user, project_id, run_id = null, mode = "default", trace = {} }) {
  if (!user?.id) throw routerError("AUTH_REQUIRED", "Sign in required", 401);
  // project.read is the floor for holding a session; each tool's own capability is enforced
  // per call, so a viewer may inspect but never mutate.
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, "project.read");

  let run = null;
  if (run_id) {
    run = await svcOf(base44).entities.AIRun.get(run_id).catch(() => null);
    if (!run) throw routerError("RUN_NOT_FOUND", "Run not found", 404);
    if (run.project_id !== project.id) throw routerError("RUN_PROJECT_MISMATCH", "That run does not belong to this project", 403);
  }
  return makeSession(base44, { user, project, workspace, role, run, mode, trace });
}

/**
 * The boundary for a BACKGROUND run. The worker holds no user session, so identity and
 * authorization are re-derived from persisted facts: the run's own project (and its workspace),
 * and the role its creator holds in that workspace right now. A run whose creator no longer has
 * access therefore stops executing tools instead of continuing on a stale grant.
 */
export async function createRunToolSession(base44, { run, project, workspace, mode = "default", trace = {} }) {
  if (!run?.id || !project?.id || !workspace?.id) throw routerError("INVALID_CONTEXT", "a run tool session needs the persisted run, project and workspace", 400);
  if (run.project_id !== project.id || project.workspace_id !== workspace.id) throw routerError("RUN_PROJECT_MISMATCH", "That run does not belong to this project", 403);
  // A delegated run acts for the user who initiated it; every other run for its creator.
  const user = { id: run.initiated_by_user_id ?? run.created_by_id ?? workspace.owner_id, email: null };
  const role = await resolveRole(base44, workspace, user);
  if (!role) throw routerError("NOT_A_MEMBER", "The user who started this run no longer has access to this project");
  // Every run session executes MODEL-issued tool calls (Build, Discuss and Agent-delegated runs).
  return makeSession(base44, { user, project, workspace, role, run, mode, trace, modelDriven: true });
}

/**
 * The boundary for an AGENT run's own tool calls. Same trust model as a background Builder run:
 * the agent run must belong to the project/workspace, and the role is re-derived from the user
 * who started it. Always model-driven and read-only ("discuss" permission set) — agent mutations
 * go through delegated Builder runs, never through this session.
 */
export async function createAgentToolSession(base44, { agentRun, project, workspace, trace = {} }) {
  if (!agentRun?.id || !project?.id || !workspace?.id) throw routerError("INVALID_CONTEXT", "an agent tool session needs the persisted agent run, project and workspace", 400);
  if (agentRun.project_id !== project.id || project.workspace_id !== workspace.id || (agentRun.workspace_id && agentRun.workspace_id !== workspace.id)) {
    throw routerError("RUN_PROJECT_MISMATCH", "That agent run does not belong to this project", 403);
  }
  const user = { id: agentRun.user_id ?? workspace.owner_id, email: null };
  const role = await resolveRole(base44, workspace, user);
  if (!role) throw routerError("NOT_A_MEMBER", "The user who started this agent no longer has access to this project");
  return makeSession(base44, {
    user, project, workspace, role, run: { id: agentRun.id, trace_id: agentRun.trace_id || null }, mode: "discuss", trace, modelDriven: true,
    meta: { agent_run_id: agentRun.id, initiated_by_user_id: user.id },
  });
}

function makeSession(base44, { user, project, workspace, role, run, mode, trace, modelDriven = false, meta = {} }) {
  const session = {
    user, project, workspace, role, run, run_id: run?.id || null, meta,
    mode: mode === "discuss" ? "discuss" : mode,
    // True for sessions whose calls come from a model. Platform/admin sessions stay false.
    modelDriven: !!modelDriven,
    trace: { trace_id: trace.trace_id || run?.trace_id || null, parent_span_id: trace.span_id || trace.parent_span_id || null },
  };

  /** Resolves the effective authorization for one tool, without executing it. */
  session.authorize = (name) => {
    const contract = toolContract(name);
    if (!contract) throw routerError("TOOL_NOT_FOUND", `Tool '${name}' does not exist`, 404);
    // Run-mode permission: discuss mode is read-only, enforced from the registry.
    const modeAllows = routableTools(session.mode).some((t) => t.name === name);
    if (!modeAllows) throw routerError("TOOL_NOT_IN_MODE", `Tool '${name}' is not available in ${session.mode} mode`);
    // Model-driven sessions: system tools (build/save/restore) belong to the pipeline's own
    // commit flow, never to a model call; discuss mode is strictly read-only.
    if (session.modelDriven && (contract.system || (session.mode === "discuss" && contract.permission !== "read"))) {
      throw routerError("TOOL_NOT_IN_MODE", `Tool '${name}' is not available in ${session.mode} mode`);
    }
    if (!can(session.role, contract.capability)) {
      throw routerError("INSUFFICIENT_ROLE", `Your role (${session.role}) is not allowed to ${contract.capability}`);
    }
    return contract;
  };

  /**
   * Executes one tool through the boundary. Authorization first, then the handler, then audit +
   * trace. A refused call throws before any handler runs, so it leaves no trace of work — only
   * a denial span.
   */
  session.call = async (name, input = {}, ctx = null) => {
    const started = Date.now();
    let contract;
    try {
      contract = session.authorize(name);
    } catch (e) {
      await recordSpan(base44, {
        trace_id: session.trace.trace_id, parent_span_id: session.trace.parent_span_id, workspace_id: workspace.id,
        project_id: project.id, run_id: session.run_id, event_type: "tool_call", name, status: "error",
        error: e, error_code: e.code, duration_ms: Date.now() - started, metadata: { denied: true, role, mode: session.mode, ...session.meta },
      });
      return { ok: false, error: `${e.code}: ${e.message}`, code: e.code, denied: true };
    }

    const span_id = newSpanId();
    let res;
    if (contract.handler === "platform") {
      try {
        res = { ok: true, result: await PLATFORM_HANDLERS[name](base44, session, ctx, input || {}) };
      } catch (e) {
        res = { ok: false, error: e.message, code: e.code || "TOOL_FAILED" };
      }
    } else {
      // The registry executor stays the single implementation of the model-facing tools; the
      // tool's own child spans (an MCP call) parent onto this one.
      if (!ctx) return { ok: false, error: `${name}: no project state is available in this phase`, code: "INVALID_CONTEXT" };
      ctx.trace = { ...(ctx.trace || {}), parent_span_id: span_id };
      res = await executeTool(ctx, name, input, session.mode);
    }

    const duration_ms = Date.now() - started;
    await recordSpan(base44, {
      trace_id: session.trace.trace_id, span_id, parent_span_id: session.trace.parent_span_id, workspace_id: workspace.id,
      project_id: project.id, run_id: session.run_id, event_type: "tool_call", name,
      status: res.ok ? "ok" : "error", error: res.ok ? null : res.error, error_code: res.ok ? null : (res.code || "TOOL_FAILED"),
      duration_ms, metadata: { category: contract.category, permission: contract.permission, summary: summarizeToolCall(name, input, res), role, mode: session.mode, ...session.meta },
    });
    if (contract.audit) {
      // Metadata is scrubbed by the audit path's own trace scrubbing; only bounded identifiers
      // are recorded, never file content or arguments in full.
      await audit(svcOf(base44), {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: contract.audit_action,
        resource: contract.category, resource_id: session.run_id,
        metadata: { ok: res.ok, target: String(input?.path || input?.name || input?.version_id || input?.tool || "").slice(0, 120), mode: session.mode, role, duration_ms, ...session.meta },
      }).catch(() => {});
    }
    return res;
  };

  return session;
}

/** One-shot routed execution for endpoints that run a single tool. */
export async function routeTool(base44, { user, project_id, run_id = null, mode = "default", tool, input = {}, ctx = null, trace = {} }) {
  const session = await createToolSession(base44, { user, project_id, run_id, mode, trace });
  return { session, ...(await session.call(tool, input, ctx)) };
}

// --- OpenAI-compatible tool definitions ---------------------------------------
// The Agent loop's native tool-calling path offers the SAME tools the session authorizes:
// toolContracts() names, descriptions and inputs, converted from the registry's descriptive
// pseudo-types (`{ path: "string" }`) into a minimal JSON Schema. No tool is invented, renamed
// or re-contracted here — the authorization boundary above remains the only executor.

const PSEUDO_TYPE_RE = /^\s*(string|number|boolean|object|array)\b/i;
function pseudoTypeToSchema(value) {
  const m = PSEUDO_TYPE_RE.exec(String(value || ""));
  return { type: m ? m[1].toLowerCase() : "string" };
}

/** The mode-routable tool contracts as OpenAI function-tool definitions. */
export function openaiToolDefinitions(mode = "discuss") {
  return routableTools(mode).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(Object.entries(t.input_schema || {}).map(([key, v]) => [key, pseudoTypeToSchema(v)])),
        ...(t.required?.length ? { required: t.required } : {}),
      },
    },
  }));
}