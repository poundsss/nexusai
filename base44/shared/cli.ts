// THE NexusAI CLI — a THIN developer-facing command layer.
//
//   nexusai init → link → pull → edit → push → types → sandbox → build → deploy → open → workflows (list · runs) · logs
//
// This module is a dispatcher, not an engine. Every command maps deterministically onto ONE existing
// platform contract and adds nothing underneath it:
//
//   init      shared/projectCreate (scaffold + Project + version 1 + audit), workspace via workspaceBootstrap
//   link      shared/authz (loadAuthorizedProject) through the sandbox session description
//   pull/push shared/resourceSync (E14/E15) — validation, idempotency, conflicts, full-sync
//   edit      shared/sandbox write/edit (→ resourceSync for canonical resources, projectFs otherwise)
//   types     shared/typeEmit (the ONE emit path) → shared/typeGen, exactly as the run pipeline emits
//   sandbox   shared/sandbox (read · write · edit · grep · ls · run · checkpoint · info)
//   build     shared/buildCommand → shared/buildEngine
//   deploy    shared/deploy (requestDeployment + runDeploymentStep — the executor's own worker)
//   open      shared/deploy currentLiveDeployment + shared/environments deploymentPath
//   errors    shared/resourceErrors (E15): the error's status IS the exit contract's source of truth
//
// Authorization is never decided here: the platform user comes from the caller's session and every
// command re-resolves the project through shared/authz. Generated-app end users are a different
// identity model and are never involved in a CLI command.
import { createProjectForUser } from "./projectCreate.ts";
import { ensureWorkspaceForUser } from "./workspaceBootstrap.ts";
import { loadAuthorizedProject, loadProjectState } from "./authz.ts";
import { pullResources, pushResources, SUPPORTED_KINDS } from "./resourceSync.ts";
import { sandboxExecute, sandboxInfo, sandboxWrite, sandboxEdit } from "./sandbox.ts";
import { emitProjectTypes } from "./typeEmit.ts";
import { createFs, readFile } from "./projectFs.ts";
import { typesFilePath, isConfigPath } from "./base44Layout.ts";
import { buildProjectForUser } from "./buildCommand.ts";
import { requestDeployment, runDeploymentStep, currentLiveDeployment, deploymentPath, normalizeEnvironment, DEPLOY_TERMINAL } from "./deploy.ts";
import { pointerFields } from "./environments.ts";
import { listWorkflows, listWorkflowRuns } from "./workflowApi.ts";
import { resourceError, commandFailure, commandStatus } from "./resourceErrors.ts";

export const CLI_NAME = "nexusai";
export const CLI_COMMANDS = ["init", "link", "pull", "edit", "push", "types", "sandbox", "build", "deploy", "open", "workflows", "logs"];

/** Where a linked project is recorded on the developer's machine. Deterministic content, see linkDocument. */
export const LINK_FILE = ".nexusai/project.json";
export const linkDocument = (project) => `${JSON.stringify({ project_id: project.id, workspace_id: project.workspace_id, name: project.name }, null, 2)}\n`;

/** Commands whose FIRST positional argument is a sub-command (e.g. `nexusai workflows list`). */
export const CLI_SUBCOMMANDS = { workflows: ["list", "runs"] };

/** CLI sandbox sub-command → the certified sandbox operation it names. Nothing else is reachable. */
export const SANDBOX_ALIASES = {
  read: "read_file", write: "write_file", edit: "edit_file", grep: "grep", ls: "list_directory",
  run: "run_command", checkpoint: "create_checkpoint", info: "info",
};

/**
 * THE exit-code contract. Derived from the E15 status the failure already carries — the status is
 * the source of truth, the exit code is its process-level projection. Success is always 0.
 */
export const EXIT_CODES = {
  OK: 0, INTERNAL: 1, USAGE: 2, UNAUTHENTICATED: 3, FORBIDDEN: 4, NOT_FOUND: 5, CONFLICT: 6,
  BUILD_FAILED: 7, DEPLOY_FAILED: 8,
};
export function exitCodeForStatus(status) {
  const s = Number(status) || 500;
  if (s < 300) return EXIT_CODES.OK;
  if (s === 401) return EXIT_CODES.UNAUTHENTICATED;
  if (s === 403) return EXIT_CODES.FORBIDDEN;
  if (s === 404) return EXIT_CODES.NOT_FOUND;
  if (s === 409) return EXIT_CODES.CONFLICT;
  if (s >= 400 && s < 500) return EXIT_CODES.USAGE;
  return EXIT_CODES.INTERNAL;
}
export const exitCodeFor = (error) => exitCodeForStatus(commandStatus(error));

const usage = (message, details = {}) => resourceError("RESOURCE_INVALID_SOURCE", message, details);

/** `nexusai <command> [--key value] [--key=value] [--flag] [--json]` → { command, args, json }. */
export function parseArgv(argv = []) {
  const [command, ...rest] = (argv || []).map(String);
  const args = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    // `-n` is the documented short form of --limit; a missing value surfaces as an invalid
    // limit in the command that accepts it, not as a silently ignored flag.
    if (tok === "-n" && rest[i + 1] !== undefined) { args.n = rest[++i]; continue; }
    if (!tok.startsWith("--")) {
      if (CLI_SUBCOMMANDS[command] && args.subcommand === undefined && CLI_SUBCOMMANDS[command].includes(tok)) args.subcommand = tok;
      else if (args.project_id === undefined && command !== "init") args.project_id = tok;
      else if (command === "init" && args.name === undefined) args.name = tok;
      continue;
    }
    const eq = tok.indexOf("=");
    const key = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).replace(/-/g, "_");
    const value = eq !== -1 ? tok.slice(eq + 1) : rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : true;
    if (key === "json") json = value !== "false";
    else if (key === "project") args.project_id = value;
    else args[key] = value;
  }
  return { command: command || "", args, json };
}

const projectOf = (args) => {
  const id = String(args.project_id || "");
  if (!id) throw usage(`a linked project is required — run \`${CLI_NAME} link <project_id>\` or pass --project <id>`, { link_file: LINK_FILE });
  return id;
};
const kindsOf = (args) => (Array.isArray(args.kinds) ? args.kinds.map(String) : typeof args.kinds === "string" && args.kinds ? args.kinds.split(",").map((k) => k.trim()).filter(Boolean) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- commands -------------------------------------------------------------------------------
// Each returns { result, exit_code?, status? }. A thrown error is rendered by runCli through E15.

async function init(base44, user, args) {
  const name = String(args.name || "").trim();
  if (!name) throw usage(`init requires a project name: ${CLI_NAME} init <name>`);
  // The account's own workspace, provisioned by the EXISTING bootstrap; an explicit id is a hint the
  // creation path authorizes by membership like every other surface.
  const workspace_id = args.workspace_id || (await ensureWorkspaceForUser(base44, user)).workspace.id;
  const out = await createProjectForUser(base44, user, { workspace_id, name, description: args.description || "" });
  const svc = base44.asServiceRole || base44;
  const files = await svc.entities.ProjectFile.filter({ project_id: out.project.id }, "path", 100);
  return {
    result: {
      project_id: out.project.id, workspace_id: out.project.workspace_id, name: out.project.name,
      version: out.version.number, role: out.role, layout: "canonical",
      files: files.map((f) => f.path).sort(),
      link_file: LINK_FILE, link: linkDocument(out.project),
    },
  };
}

async function link(base44, user, args) {
  const project_id = projectOf(args);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const info = await sandboxInfo(base44, user, { project_id: project.id });
  return {
    result: {
      link_file: LINK_FILE, link: linkDocument(project),
      project: { id: project.id, name: project.name, slug: project.slug || null, workspace_id: project.workspace_id, version: info.version, role: info.role, layout: info.layout, file_count: info.file_count },
    },
  };
}

async function pull(base44, user, args) {
  return { result: await pullResources(base44, user, { project_id: projectOf(args), kinds: kindsOf(args) }) };
}

async function push(base44, user, args) {
  const project_id = projectOf(args);
  if (!Array.isArray(args.resources)) throw usage("push requires 'resources': an array of { path, content }", { supported_kinds: SUPPORTED_KINDS });
  const mode = args.mode === undefined ? "full" : String(args.mode);
  if (!["full", "merge"].includes(mode)) throw usage(`push mode must be 'full' or 'merge', not '${mode}'`, { mode });
  return {
    result: await pushResources(base44, user, {
      project_id, resources: args.resources, kinds: kindsOf(args), mode,
      expected_version: args.expected_version ?? null, message: args.message || null,
    }),
  };
}

async function edit(base44, user, args) {
  const project_id = projectOf(args);
  const common = { project_id, path: args.path, message: args.message || null, expected_version: args.expected_version ?? null };
  if (typeof args.find === "string") return { result: await sandboxEdit(base44, user, { ...common, find: args.find, replace: typeof args.replace === "string" ? args.replace : "" }) };
  if (typeof args.content === "string") return { result: await sandboxWrite(base44, user, { ...common, content: args.content }) };
  throw usage("edit requires --path with either --find/--replace or --content");
}

async function types(base44, user, args) {
  const project_id = projectOf(args);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const state = await loadProjectState(base44, project.id);
  const fs = createFs(state.files);
  // EXACTLY what the run pipeline feeds the generator, so a CLI-generated file and a pipeline-
  // generated file for the same project are byte-identical.
  const content = emitProjectTypes(fs, state.entities);
  const path = typesFilePath();
  let current = null;
  try { current = readFile(fs, path); } catch { /* not emitted yet */ }
  const canonical = state.files.some((f) => isConfigPath(f.path));
  const result = { project_id: project.id, path, content, changed: current !== content, layout: canonical ? "canonical" : "legacy", written: false, version: Number(project.version_count || 0) };
  if (!args.write) return { result };
  if (!canonical) throw resourceError("RESOURCE_UNSUPPORTED", "a legacy flat-layout project carries no generated declarations; add base44/config.jsonc first", { project_id: project.id });
  const pushed = await pushResources(base44, user, { project_id: project.id, resources: [{ path, content }], kinds: ["types"], mode: "merge", message: `${CLI_NAME} types` });
  return { result: { ...result, written: true, version: pushed.version, version_created: pushed.version_created } };
}

async function sandbox(base44, user, args) {
  const project_id = projectOf(args);
  const alias = String(args.op || "");
  const op = SANDBOX_ALIASES[alias];
  if (!op) throw resourceError("RESOURCE_UNSUPPORTED", `'${alias}' is not a sandbox sub-command (${Object.keys(SANDBOX_ALIASES).join(", ")})`, { op: alias, operations: Object.keys(SANDBOX_ALIASES) });
  const raw = await sandboxExecute(base44, user, op, { ...args, project_id });
  // The sandbox names its executed command `command`, which is ALSO the envelope's own field; it is
  // surfaced as `sandbox_command` so neither value can overwrite the other.
  const { command: sandboxCommand, ...rest } = raw;
  const result = sandboxCommand === undefined ? rest : { ...rest, sandbox_command: sandboxCommand };
  // run reports its own engine outcome; a failed build is a failed command, never a false success.
  const failed = result.ok === false;
  return { result, exit_code: failed ? EXIT_CODES.BUILD_FAILED : EXIT_CODES.OK, status: failed ? 400 : 200 };
}

async function build(base44, user, args) {
  const result = await buildProjectForUser(base44, user, { project_id: projectOf(args) });
  const ok = result.status === "success";
  return { result: { ok, ...result, build_status: result.status }, exit_code: ok ? EXIT_CODES.OK : EXIT_CODES.BUILD_FAILED, status: ok ? 200 : 400 };
}

async function deploy(base44, user, args) {
  const project_id = projectOf(args);
  const r = await requestDeployment(base44, user, { project_id, environment: args.environment || "production", version_id: args.version_id || null });
  const svc = base44.asServiceRole || base44;
  let deployment = r.deployment;
  const base = { project_id: r.project.id, deployment_id: deployment.id, environment: r.environment, version_number: r.version.number, url: deploymentPath(r.slug, r.environment) };
  if (args.wait === false || args.wait === "false") return { result: { ...base, status: "QUEUED", waited: false }, status: 202 };
  // Drive the deployment with THE executor's own worker (the same call the background workflow
  // makes); a lease held by a concurrent worker just means we wait for its result.
  for (let i = 0; i < 24 && !DEPLOY_TERMINAL.includes(deployment.status); i++) {
    const step = await runDeploymentStep(svc, deployment.id);
    if (step.busy) await sleep(400);
    deployment = await svc.entities.Deployment.get(deployment.id);
  }
  const live = deployment.status === "LIVE";
  return {
    result: {
      ...base, waited: true, status: deployment.status,
      artifact_id: deployment.artifact_id || null, artifact_checksum: deployment.artifact_checksum || null,
      failure_code: deployment.failure_code || null, failure_summary: deployment.failure_summary || null,
      diagnostics: deployment.build_diagnostics || [],
    },
    exit_code: live ? EXIT_CODES.OK : EXIT_CODES.DEPLOY_FAILED, status: live ? 200 : 400,
  };
}

async function open(base44, user, args) {
  const project_id = projectOf(args);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const target = String(args.target || args.environment || "production");
  if (target === "preview") return { result: { project_id: project.id, target, url: `/projects/${project.id}` } };
  const environment = normalizeEnvironment(target);
  const svc = base44.asServiceRole || base44;
  const live = await currentLiveDeployment(svc, project, environment);
  if (!live) throw Object.assign(new Error(`Nothing is deployed to ${environment} for this project`), { status: 404, code: "DEPLOYMENT_NOT_FOUND", details: { project_id: project.id, environment } });
  const pointer = project[pointerFields(environment).deployment] || null;
  return {
    result: {
      project_id: project.id, target: environment, environment,
      url: live.deployment_url || deploymentPath(project.slug, environment),
      deployment_id: live.id, version_number: live.version_number, artifact_checksum: live.artifact_checksum || null,
      pointer_deployment_id: pointer, pointer_matches: pointer === live.id,
    },
  };
}

// ---- workflows (Phase 16C-3A): read-only projections over the CERTIFIED workflowApi -----------
// Every value shown comes from listWorkflows / listWorkflowRuns; nothing is persisted and no
// workflow contract changes. Values the platform does not record are reported as null, never invented.

const WORKFLOW_RUN_STATUSES = { running: "RUNNING", completed: "COMPLETED", failed: "FAILED", cancelled: "CANCELLED" };

/** `--since`/`--until`: ISO datetime (normalized to UTC when no timezone is given) or a relative shorthand. */
const parseSince = (value, flag = "--since") => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const rel = raw.match(/^(\d+)([smhd])$/i);
  if (rel) return new Date(Date.now() - Number(rel[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[rel[2].toLowerCase()]).toISOString();
  const ms = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(ms)) throw usage(`${flag} must be an ISO datetime or a relative shorthand (1h, 30m, 2d), not '${raw}'`);
  return new Date(ms).toISOString();
};

const boundedLimit = (args, fallback) => Math.min(Math.max(Number(args.limit) || fallback, 1), 200);

async function workflowsList(base44, user, args) {
  const project_id = projectOf(args);
  const { workflows } = await listWorkflows(base44, user, { project_id, limit: boundedLimit(args, 30) });
  // Run aggregates are derived from the project's most recent runs (bounded by the same 200-run
  // page there is no CLI paging past) — no new persistence fields.
  const { runs } = await listWorkflowRuns(base44, user, { project_id, limit: 200 });
  const byKey = new Map();
  for (const r of runs) {
    const lineage = byKey.get(r.workflow_key) || [];
    lineage.push(r);
    byKey.set(r.workflow_key, lineage);
  }
  const rows = workflows.map((w) => {
    const lineage = (byKey.get(w.workflow_key) || []).sort((a, b) => String(b.started_at || b.created_date || "").localeCompare(String(a.started_at || a.created_date || "")));
    const last = lineage[0] || null;
    let consecutiveFailures = 0;
    for (const r of lineage) { if (r.status === "FAILED") consecutiveFailures++; else break; }
    return {
      id: w.workflow_definition_id, name: w.name, description: w.description || null,
      status: w.status, statusReason: null,
      totalRuns: lineage.length, consecutiveFailures,
      lastRunAt: last?.started_at || null, lastRunStatus: last?.status || null,
    };
  });
  const human = rows.length
    ? rows.map((r) => `${r.name}  [${r.status}]  runs: ${r.totalRuns}${r.lastRunAt ? `, last run ${String(r.lastRunStatus || "?").toLowerCase()} at ${String(r.lastRunAt).replace("T", " ").slice(0, 19)}` : ""}${r.consecutiveFailures > 0 ? ` (${r.consecutiveFailures} consecutive failures)` : ""}`).join("\n")
    : `No workflows in this project.`;
  return { result: { project_id, count: rows.length, workflows: rows, human }, status: 200 };
}

async function workflowsRuns(base44, user, args) {
  const project_id = projectOf(args);
  const status = args.status ? WORKFLOW_RUN_STATUSES[String(args.status).toLowerCase()] : null;
  if (args.status && !status) throw usage(`--status must be one of ${Object.keys(WORKFLOW_RUN_STATUSES).join(", ")}`, { status: String(args.status) });
  const since = parseSince(args.since);
  const limit = boundedLimit(args, 30);
  // A --since filter is applied to the newest page (the API's own 200 cap), then cut to the limit.
  const { runs } = await listWorkflowRuns(base44, user, { project_id, status, limit: since ? 200 : limit });
  const filtered = (since ? runs.filter((r) => r.started_at && r.started_at >= since) : runs).slice(0, limit);
  const names = new Map((await listWorkflows(base44, user, { project_id, limit: 200 })).workflows.map((w) => [w.workflow_definition_id, w.name]));
  const rows = filtered.map((r) => ({
    runId: r.workflow_run_id, workflowId: r.workflow_id, workflowName: names.get(r.workflow_id) || null,
    triggerType: r.trigger_source || "manual", status: r.status,
    startedAt: r.started_at || null, completedAt: r.completed_at || null, durationMs: r.duration_ms ?? null,
    stepsCount: r.steps_completed ?? 0, errorMessage: r.error?.message || null,
    // A manual dispatch by a user is this platform's "run now" — the analog of Base44's test tag.
    isTestRun: r.trigger_source === "manual" && r.actor === "user",
    statusReason: r.error?.code || null,
  }));
  const human = rows.length
    ? rows.map((r) => {
        const line = `${String(r.startedAt || "").replace("T", " ").slice(0, 19)} ${String(r.status).padEnd(9)} ${r.workflowName || r.workflowId} (${r.triggerType}${r.isTestRun ? ", test" : ""})${r.durationMs != null ? ` ${(r.durationMs / 1000).toFixed(1)}s` : ""}`;
        return r.errorMessage ? `${line}\n    Error: ${r.errorMessage}` : line;
      }).join("\n")
    : `No workflow runs matched the given filters.`;
  return { result: { project_id, count: rows.length, runs: rows, human }, status: 200 };
}

async function workflows(base44, user, args) {
  const sub = String(args.subcommand || "");
  if (sub === "list") return workflowsList(base44, user, args);
  if (sub === "runs") return workflowsRuns(base44, user, args);
  throw usage(`'${sub || "(missing)"}' is not a ${CLI_NAME} workflows sub-command (${CLI_SUBCOMMANDS.workflows.join(", ")})`);
}

// ---- logs (Phase 16C-3B): a member-authorized read path over FunctionInvocation ---------------
// Read-only: every value shown comes from an existing FunctionInvocation row; no field is added,
// no invocation is written, and level is DERIVED only from existing data (failed → error,
// successful → info). Levels this platform does not record on FunctionInvocation yield an EMPTY
// result — never a fabricated classification.

export const LOG_LEVELS = ["info", "warning", "error", "debug"];

export const invocationLevel = (inv) => (inv && inv.ok === false ? "error" : "info");

/**
 * THE member-authorized read path for FunctionInvocation: requires project.read, is resolved
 * through loadAuthorizedProject (so workspace/project isolation is enforced server-side), and
 * returns only the authorized project's own invocations. Filters: function names, since/until
 * bounds on created_date, derived level, a 1..500 limit and an asc/desc created_date order.
 */
export async function logsRead(base44, user, { project_id, functions = null, since = null, until = null, level = null, limit = 500, order = "desc" }) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  if (level && !LOG_LEVELS.includes(level)) throw usage(`--level must be one of ${LOG_LEVELS.join(", ")}`, { level: String(level) });
  // warning/debug: no underlying data — an authorized, read-only EMPTY result.
  if (level === "warning" || level === "debug") return { project_id: project.id, invocations: [] };
  const created_date = {};
  if (since) created_date.$gte = since;
  if (until) created_date.$lte = until;
  const query = {
    project_id: project.id,
    ...(functions?.length ? { function_name: { $in: functions } } : {}),
    ...(Object.keys(created_date).length ? { created_date } : {}),
  };
  const clamped = Math.min(Math.max(Number(limit) || 500, 1), 500);
  const rows = await base44.entities.FunctionInvocation.filter(query, order === "asc" ? "created_date" : "-created_date", clamped);
  return { project_id: project.id, invocations: (level ? rows.filter((r) => invocationLevel(r) === level) : rows).slice(0, clamped) };
}

const logsLimit = (args) => {
  const raw = args.limit ?? args.n;
  if (raw === undefined) return 500; // no invented default below the documented 500 cap
  const s = String(raw).trim();
  if (raw === true || !/^\d+$/.test(s)) throw usage(`-n/--limit must be an integer between 1 and 500, not '${String(raw)}'`);
  return Math.min(Math.max(Number(s), 1), 500);
};

async function logs(base44, user, args) {
  const project_id = projectOf(args);
  const level = args.level ? String(args.level).toLowerCase() : null;
  if (args.level && !LOG_LEVELS.includes(level)) throw usage(`--level must be one of ${LOG_LEVELS.join(", ")}`, { level: String(args.level) });
  const order = args.order ? String(args.order).toLowerCase() : "desc";
  if (args.order && !["asc", "desc"].includes(order)) throw usage(`--order must be 'asc' or 'desc', not '${args.order}'`, { order: String(args.order) });
  const functions = typeof args.function === "string"
    ? args.function.split(",").map((s) => s.trim()).filter(Boolean)
    : Array.isArray(args.function) ? args.function.map(String) : null;
  const rows = (await logsRead(base44, user, {
    project_id, functions, level, order, limit: logsLimit(args),
    since: parseSince(args.since), until: parseSince(args.until, "--until"),
  })).invocations.map((inv) => {
    const logLines = Array.isArray(inv.logs) ? inv.logs : [];
    return {
      timestamp: inv.created_date || null, level: invocationLevel(inv), function: inv.function_name || null,
      status: inv.status ?? null, ok: inv.ok !== false, durationMs: inv.duration_ms ?? null,
      requestId: inv.request_id || null, traceId: inv.trace_id || null, runId: inv.run_id || null,
      trigger: inv.trigger || null, identity: inv.identity || null, logs: logLines,
      message: inv.error_message || logLines.filter(Boolean).slice(-1)[0] || "",
    };
  });
  const human = rows.length
    ? rows.map((r) => `${String(r.timestamp || "").replace("T", " ").slice(0, 19)} ${String(r.level).padEnd(7)} ${r.function || "?"}${r.message ? `  ${r.message}` : ""}`).join("\n")
    : `No function invocations matched the given filters.`;
  return { result: { project_id, count: rows.length, logs: rows, human }, status: 200 };
}

const HANDLERS = { init, link, pull, edit, push, types, sandbox, build, deploy, open, workflows, logs };

// ---- output channels --------------------------------------------------------------------------
// stdout carries the command's answer — in --json mode ONE parseable JSON document, nothing else.
// stderr carries human diagnostics. The two never mix, so a failure cannot corrupt machine output.
function humanLines(command, ok, body) {
  const lines = [`${CLI_NAME} ${command}: ${ok ? "ok" : "failed"}`];
  for (const [k, v] of Object.entries(body)) {
    if (k === "ok" || k === "command" || k === "content" || k === "link" || k === "human") continue;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) lines.push(`  ${k}: ${v}`);
    else if (Array.isArray(v)) lines.push(`  ${k}: ${v.length} item(s)`);
  }
  return lines.join("\n");
}

function render({ command, ok, exit_code, status, result, diagnostics }, json) {
  const body = { ok, command, exit_code, ...result };
  return {
    command, ok, exit_code, status, result,
    stdout: json ? `${JSON.stringify(body)}\n` : result?.human !== undefined ? `${result.human}\n` : `${humanLines(command, ok, body)}\n`,
    stderr: diagnostics.length ? `${diagnostics.join("\n")}\n` : "",
  };
}

/**
 * THE CLI entry point. `user` is the authenticated PLATFORM user (or null); `command`/`args` name one
 * command; `json` selects machine-readable stdout. Never throws: every outcome is rendered through
 * the E15 failure body and the centralized exit-code mapping.
 */
export async function runCli(base44, user, { command, args = {}, json = false } = {}) {
  const cmd = String(command || "");
  try {
    if (!user?.id) throw resourceError("RESOURCE_UNAUTHENTICATED", `sign in required — ${CLI_NAME} commands run as your platform account`);
    const handler = HANDLERS[cmd];
    if (!handler) throw resourceError("RESOURCE_UNSUPPORTED", `'${cmd}' is not a ${CLI_NAME} command (${CLI_COMMANDS.join(", ")})`, { command: cmd, commands: CLI_COMMANDS });
    const out = await handler(base44, user, args || {});
    const exit_code = out.exit_code ?? EXIT_CODES.OK;
    const ok = exit_code === EXIT_CODES.OK;
    const diagnostics = ok ? [] : [`${CLI_NAME} ${cmd}: exit ${exit_code}${out.result?.failure_code ? ` (${out.result.failure_code})` : ""}`];
    return render({ command: cmd, ok, exit_code, status: out.status ?? 200, result: out.result, diagnostics }, json);
  } catch (error) {
    const failure = commandFailure(error);
    const exit_code = exitCodeForStatus(failure.status);
    return render({ command: cmd, ok: false, exit_code, status: failure.status, result: failure, diagnostics: [`${CLI_NAME} ${cmd || "?"}: ${failure.code}: ${failure.error} (exit ${exit_code})`] }, json);
  }
}

/** argv form: `runCliArgv(base44, user, ["push", "--project", id, "--json"])`. */
export const runCliArgv = (base44, user, argv, extraArgs = {}) => {
  const parsed = parseArgv(argv);
  return runCli(base44, user, { command: parsed.command, args: { ...parsed.args, ...extraArgs }, json: parsed.json });
};