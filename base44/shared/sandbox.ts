// THE sandbox / remote-development surface.
//
//   Project → Sandbox → filesystem → read / write / edit → run → build → checkpoint
//
// A "sandbox" here is NOT a second machine, filesystem, runtime, command executor, versioning system
// or permission system. It is the ONE authorized session view over a project's existing state:
//
//   authorization     shared/authz.ts (loadAuthorizedProject / loadProjectState) + shared/rbac.ts
//   filesystem        shared/projectFs.ts (the same virtual FS the builder and agent mutate)
//   resource writes   shared/resourceSync.ts (E14/E15) — every canonical resource keeps ITS OWN
//                     parser/validator; the sandbox never re-implements one
//   run               the project's OWN declared site commands, mapped to the EXISTING engines
//                     (build → shared/buildEngine.ts, install → shared/packageLock.ts resolution,
//                      serve → the same build plus the entry the preview/runtime loads)
//   checkpoint        shared/persistence.ts (commitFiles / commitEntities / createVersion) — the
//                     project's existing immutable versions, which restore already understands
//   errors            shared/resourceErrors.ts (E15) — no new error vocabulary is invented
//
// Remote development therefore has exactly the same semantics as local development, because it IS
// the same code path: read → edit → run → build → checkpoint.
import { audit, loadAuthorizedProject, loadProjectState } from "./authz.ts";
import { scrub } from "./tracing.ts";
import { createFs, readFile, writeFile, patchFile, deleteFile, listFiles, activeFiles, searchProject, computeChanges, normalizePath } from "./projectFs.ts";
import { commitFiles, commitEntities, createVersion, recordBuild } from "./persistence.ts";
import { runBuild } from "./buildEngine.ts";
import { ENTRY_FILE } from "./runtimeExports.ts";
import { CONFIG_FILE, isConfigPath, validateConfigDocument, SITE_FIELDS } from "./base44Layout.ts";
import { installedPackages } from "./packageLock.ts";
import { pushResources, resourceKindOf, resourceIdentity } from "./resourceSync.ts";
import { resourceError } from "./resourceErrors.ts";

const svcOf = (b) => b.asServiceRole || b;

/** Every sandbox operation, and the capability it requires. Reads need read, mutations need write. */
export const SANDBOX_OPS = {
  read_file: "project.read",
  list_directory: "project.read",
  grep: "project.read",
  info: "project.read",
  write_file: "project.write",
  edit_file: "project.write",
  delete_file: "project.write",
  run_command: "project.write",
  create_checkpoint: "project.write",
};

/** The commands a sandbox may run: the project's declared site commands, by canonical alias. */
export const SANDBOX_COMMANDS = ["install", "build", "serve"];
const COMMAND_FIELD = { install: "installCommand", build: "buildCommand", serve: "serveCommand" };

const MAX_READ_BYTES = 400_000;
const MAX_GREP_MATCHES = 200;

/**
 * THE path guard of the sandbox boundary.
 *
 * `projectFs` already refuses a path outside the project's allowed roots, but it does not RESOLVE a
 * path, so `src/../../etc/passwd` would satisfy a naive prefix check. Every sandbox path passes
 * through here first: no traversal segment, no absolute path, no scheme, no NUL. The write guard in
 * projectFs then still runs, so there are two independent refusals, not a replacement for one.
 */
export function sandboxPath(input) {
  const raw = String(input ?? "");
  if (!raw.trim()) throw resourceError("RESOURCE_INVALID_PATH", "a path is required", { path: raw });
  if (raw.includes("\0")) throw resourceError("RESOURCE_INVALID_PATH", "a path may not contain a NUL byte", { path: "(binary)" });
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || raw.startsWith("//")) {
    throw resourceError("RESOURCE_INVALID_PATH", `'${raw}' is a URL, not a project path`, { path: raw });
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw resourceError("RESOURCE_INVALID_PATH", `'${raw}' is an absolute path; sandbox paths are relative to the project root`, { path: raw });
  }
  const path = normalizePath(raw);
  if (path.split("/").some((s) => s === "..")) {
    throw resourceError("RESOURCE_INVALID_PATH", `'${raw}' escapes the project root`, { path: raw });
  }
  if (!path) throw resourceError("RESOURCE_INVALID_PATH", "a path is required", { path: raw });
  return path;
}

/**
 * Opens ONE sandbox session: the authorized project plus its current state, loaded through the
 * existing authorization and project-state paths. Every operation opens its own session, so a
 * revoked role, a deleted project or a concurrent change is re-checked on every call.
 */
export async function openSandbox(base44, user, { project_id, op }) {
  const capability = SANDBOX_OPS[op];
  if (!capability) {
    throw resourceError("RESOURCE_UNSUPPORTED", `'${op}' is not a sandbox operation (${Object.keys(SANDBOX_OPS).join(", ")})`, { op: String(op), operations: Object.keys(SANDBOX_OPS) });
  }
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, String(project_id || ""), capability);
  const state = await loadProjectState(base44, project.id);
  return { project, workspace, role, capability, state, fs: createFs(state.files) };
}

/** The project's manifest, when it declares one. Read through the EXISTING manifest validator. */
function manifestOf(files) {
  const file = files.find((f) => isConfigPath(f.path));
  if (!file) return null;
  const check = validateConfigDocument(file.content);
  return check.ok ? check.config : null;
}

/** Sandbox session description: what the project is, and what this sandbox can do with it. */
export async function sandboxInfo(base44, user, { project_id }) {
  const s = await openSandbox(base44, user, { project_id, op: "info" });
  const files = activeFiles(s.fs);
  const manifest = manifestOf(files);
  return {
    ok: true, project_id: s.project.id, workspace_id: s.workspace.id, role: s.role,
    version: Number(s.project.version_count || 0),
    file_count: files.length,
    entities: s.state.entities.map((e) => e.name),
    // Secret NAMES only, through the platform's existing secret projection — a sandbox never sees,
    // returns, greps or checkpoints a credential value.
    secrets: s.state.secrets.map((x) => ({ name: x.name, required: x.required, is_set: x.is_set })),
    layout: files.some((f) => isConfigPath(f.path)) ? "canonical" : "legacy",
    site: manifest?.site ? Object.fromEntries(SITE_FIELDS.filter((k) => manifest.site[k]).map((k) => [k, manifest.site[k]])) : null,
    commands: SANDBOX_COMMANDS,
    operations: Object.keys(SANDBOX_OPS),
  };
}

// --- read ---------------------------------------------------------------------
export async function sandboxRead(base44, user, { project_id, path }) {
  const p = sandboxPath(path);
  const s = await openSandbox(base44, user, { project_id, op: "read_file" });
  let content;
  try { content = readFile(s.fs, p); }
  catch { throw resourceError("RESOURCE_NOT_FOUND", `${p} does not exist in this project`, { path: p, project_id: s.project.id }); }
  if (content.length > MAX_READ_BYTES) {
    throw resourceError("RESOURCE_VALIDATION_FAILED", `${p} is ${content.length} bytes, larger than the ${MAX_READ_BYTES}-byte sandbox read limit`, { path: p, size: content.length });
  }
  return { ok: true, project_id: s.project.id, path: p, size: content.length, kind: resourceKindOf(p), content };
}

/** Directory listing over the ONE project filesystem: immediate children of a path prefix. */
export async function sandboxListDirectory(base44, user, { project_id, path = "" }) {
  const prefix = path ? `${sandboxPath(path).replace(/\/$/, "")}/` : "";
  const s = await openSandbox(base44, user, { project_id, op: "list_directory" });
  const all = listFiles(s.fs);
  const files = [];
  const dirs = new Map();
  for (const f of all) {
    if (prefix && !f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.push({ name: rest, path: f.path, type: "file", size: f.size, frozen: f.frozen, kind: resourceKindOf(f.path) });
    else {
      const name = rest.slice(0, slash);
      dirs.set(name, (dirs.get(name) || 0) + 1);
    }
  }
  if (prefix && !files.length && !dirs.size) {
    throw resourceError("RESOURCE_NOT_FOUND", `${prefix} does not exist in this project`, { path: prefix, project_id: s.project.id });
  }
  const entries = [
    ...[...dirs.entries()].map(([name, count]) => ({ name, path: `${prefix}${name}`, type: "directory", entry_count: count })),
    ...files,
  ].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  return { ok: true, project_id: s.project.id, path: prefix || ".", count: entries.length, entries };
}

/** Grep: the EXISTING project search, bounded and optionally scoped to a path prefix. */
export async function sandboxGrep(base44, user, { project_id, query, path = null }) {
  const q = String(query ?? "");
  if (!q.trim()) throw resourceError("RESOURCE_INVALID_SOURCE", "grep requires a non-empty 'query'", { query: q });
  const prefix = path ? sandboxPath(path) : null;
  const s = await openSandbox(base44, user, { project_id, op: "grep" });
  const matches = searchProject(s.fs, q)
    .filter((m) => !prefix || m.path === prefix || m.path.startsWith(`${prefix}/`))
    .slice(0, MAX_GREP_MATCHES);
  return { ok: true, project_id: s.project.id, query: q, path: prefix, count: matches.length, matches };
}

// --- write / edit --------------------------------------------------------------
// A canonical RESOURCE write goes through the resource sync layer, so the resource's own validator
// runs, its runtime projections are materialized and its E14/E15 semantics (conflict, malformed,
// kind mismatch) apply unchanged. Any other project file is committed through the journalled
// filesystem commit. Neither path invents a second persistence model.
async function applyWrite(base44, user, s, { path, content, message, expected_version }) {
  const kind = resourceKindOf(path);
  if (kind) {
    const pushed = await pushResources(base44, user, {
      project_id: s.project.id, resources: [{ path, content }], kinds: [kind], mode: "merge",
      expected_version: expected_version ?? null, message: message || `Sandbox wrote ${path}`,
    });
    return {
      ok: true, project_id: s.project.id, path, kind, identity: resourceIdentity(path, kind),
      via: "resource_sync", persisted: true,
      changed: pushed.created + pushed.updated > 0,
      version: pushed.version, version_created: pushed.version_created,
    };
  }
  if (expected_version != null && Number(expected_version) !== Number(s.project.version_count || 0)) {
    throw resourceError("RESOURCE_CONFLICT", `the project has moved to version ${s.project.version_count || 0} since version ${expected_version} was read — read again before writing`, { project_id: s.project.id, expected_version: Number(expected_version), actual_version: Number(s.project.version_count || 0) });
  }
  try { writeFile(s.fs, path, content); }
  catch (e) { throw resourceError("RESOURCE_INVALID_PATH", e.message, { path }); }
  const changes = computeChanges(s.fs);
  try { if (changes.length) await commitFiles(svcOf(base44), s.project.id, s.fs); }
  catch (e) { throw resourceError("RESOURCE_PERSISTENCE_FAILED", `${path} could not be persisted: ${e.message}`, { path, project_id: s.project.id }); }
  await audit(svcOf(base44), {
    workspace_id: s.workspace.id, project_id: s.project.id, user_id: user?.id || null,
    action: "sandbox.file_written", resource: "ProjectFile", resource_id: null,
    metadata: scrub({ path, changes: changes.length }),
  }).catch(() => {});
  return {
    ok: true, project_id: s.project.id, path, kind: null, via: "filesystem", persisted: true,
    changed: changes.length > 0, changed_files: changes,
    version: Number(s.project.version_count || 0), version_created: false,
  };
}

export async function sandboxWrite(base44, user, { project_id, path, content, message = null, expected_version = null }) {
  const p = sandboxPath(path);
  if (typeof content !== "string") throw resourceError("RESOURCE_MALFORMED", `${p} must be written with string content`, { path: p });
  const s = await openSandbox(base44, user, { project_id, op: "write_file" });
  return applyWrite(base44, user, s, { path: p, content, message, expected_version });
}

/** edit_file: ONE exact, unique find/replace, applied through the existing FS patch primitive. */
export async function sandboxEdit(base44, user, { project_id, path, find, replace = "", message = null, expected_version = null }) {
  const p = sandboxPath(path);
  if (typeof find !== "string" || !find.length) throw resourceError("RESOURCE_INVALID_SOURCE", "edit_file requires a non-empty 'find'", { path: p });
  const s = await openSandbox(base44, user, { project_id, op: "edit_file" });
  try { readFile(s.fs, p); }
  catch { throw resourceError("RESOURCE_NOT_FOUND", `${p} does not exist in this project`, { path: p, project_id: s.project.id }); }
  try { patchFile(s.fs, p, find, replace); }
  catch (e) { throw resourceError("RESOURCE_VALIDATION_FAILED", e.message, { path: p }); }
  const edited = readFile(s.fs, p);
  return { ...(await applyWrite(base44, user, s, { path: p, content: edited, message: message || `Sandbox edited ${p}`, expected_version })), edited: true };
}

export async function sandboxDelete(base44, user, { project_id, path, message = null }) {
  const p = sandboxPath(path);
  const s = await openSandbox(base44, user, { project_id, op: "delete_file" });
  try { deleteFile(s.fs, p); }
  catch (e) { throw resourceError(/not found/i.test(e.message) ? "RESOURCE_NOT_FOUND" : "RESOURCE_VALIDATION_FAILED", e.message, { path: p }); }
  const changes = computeChanges(s.fs);
  await commitFiles(svcOf(base44), s.project.id, s.fs);
  await audit(svcOf(base44), {
    workspace_id: s.workspace.id, project_id: s.project.id, user_id: user?.id || null,
    action: "sandbox.file_deleted", resource: "ProjectFile", resource_id: null, metadata: scrub({ path: p }),
  }).catch(() => {});
  return { ok: true, project_id: s.project.id, path: p, deleted: true, changed_files: changes, message: message || null };
}

// --- run ----------------------------------------------------------------------
/**
 * run_command — bounded, declarative execution.
 *
 * A sandbox command is NOT a shell: no arbitrary string is executed anywhere, so there is nothing
 * for a command to escape into. A caller names one of the project's declared site commands by its
 * canonical alias (install / build / serve) — or its exact declared command string — and the
 * platform runs the ENGINE that alias means. Anything else is refused deterministically.
 */
export async function sandboxRun(base44, user, { project_id, command }) {
  const raw = String(command ?? "").trim();
  if (!raw) throw resourceError("RESOURCE_INVALID_SOURCE", `run_command requires a 'command' (${SANDBOX_COMMANDS.join(", ")})`, { commands: SANDBOX_COMMANDS });
  const s = await openSandbox(base44, user, { project_id, op: "run_command" });
  const files = activeFiles(s.fs);
  const site = manifestOf(files)?.site || {};

  let alias = SANDBOX_COMMANDS.includes(raw) ? raw : null;
  if (!alias) {
    // An exact declared command string resolves to the alias that declares it; nothing else does.
    alias = SANDBOX_COMMANDS.find((a) => site[COMMAND_FIELD[a]] && String(site[COMMAND_FIELD[a]]).trim() === raw) || null;
  }
  if (!alias) {
    throw resourceError("RESOURCE_UNSUPPORTED", `'${raw}' is not a runnable command in this sandbox — only the project's declared commands may run (${SANDBOX_COMMANDS.join(", ")}). A sandbox never executes an arbitrary shell command.`, { command: raw, commands: SANDBOX_COMMANDS, declared: Object.fromEntries(SANDBOX_COMMANDS.filter((a) => site[COMMAND_FIELD[a]]).map((a) => [a, site[COMMAND_FIELD[a]]])) });
  }

  const declared = site[COMMAND_FIELD[alias]] || null;
  if (alias === "install") {
    // Dependency resolution is READ from the project's own lockfile — the same resolved state the
    // build links against. No package is fetched and no registry is contacted here.
    const packages = installedPackages(files);
    return {
      ok: true, project_id: s.project.id, command: alias, declared_command: declared, exit_status: 200,
      packages: packages.map((p) => ({ name: p.name, version: p.version })), logs: [`[install] ${packages.length} resolved package(s)`],
    };
  }

  const build = runBuild(s.fs, s.state.entities, s.state.secrets);
  await recordBuild(svcOf(base44), s.project.id, null, build).catch(() => {});
  const base = {
    project_id: s.project.id, command: alias, declared_command: declared,
    status: build.status, errors: build.errors, duration_ms: build.duration_ms,
    logs: build.logs.slice(-60), diagnostics: build.logs.filter((l) => l.startsWith("error:")).slice(0, 20),
  };
  if (alias === "build") return { ok: build.status === "success", exit_status: build.status === "success" ? 200 : 400, ...base };
  // serve: the preview/runtime loads the built entry, so "serving" means a successful build that
  // actually carries that entry. No second runtime is started.
  const hasEntry = files.some((f) => f.path === ENTRY_FILE);
  const servable = build.status === "success" && hasEntry;
  return {
    ok: servable, exit_status: servable ? 200 : 400, ...base,
    servable, entry: hasEntry ? ENTRY_FILE : null,
    ...(servable ? {} : { diagnostics: [...base.diagnostics, ...(hasEntry ? [] : [`missing ${ENTRY_FILE} entry file`])] }),
  };
}

// --- checkpoint ---------------------------------------------------------------
/**
 * create_checkpoint — an immutable project version, through the project's EXISTING version
 * primitive, so restore, diff, fork, artifact and deploy all already understand it.
 *
 * The state is verified BEFORE the version is written: a failing build refuses the checkpoint and
 * writes nothing, so a failure can never be reported as a successful checkpoint. `require_build:
 * false` records a checkpoint of a knowingly-broken state, and the version then states that.
 */
export async function sandboxCheckpoint(base44, user, { project_id, message = null, require_build = true, expected_version = null }) {
  const s = await openSandbox(base44, user, { project_id, op: "create_checkpoint" });
  if (expected_version != null && Number(expected_version) !== Number(s.project.version_count || 0)) {
    throw resourceError("RESOURCE_CONFLICT", `the project has moved to version ${s.project.version_count || 0} since version ${expected_version} was read — read again before checkpointing`, { project_id: s.project.id, expected_version: Number(expected_version), actual_version: Number(s.project.version_count || 0) });
  }
  const build = runBuild(s.fs, s.state.entities, s.state.secrets);
  await recordBuild(svcOf(base44), s.project.id, null, build).catch(() => {});
  if (require_build && build.status !== "success") {
    throw resourceError("RESOURCE_VALIDATION_FAILED", `the project does not build, so no checkpoint was created (${build.errors} error(s))`, {
      project_id: s.project.id, build_status: build.status, errors: build.errors,
      diagnostics: build.logs.filter((l) => l.startsWith("error:")).slice(0, 10),
    });
  }
  const changes = computeChanges(s.fs);
  let version;
  try {
    if (changes.length) await commitFiles(svcOf(base44), s.project.id, s.fs);
    await commitEntities(base44, s.project.id, s.state.entities);
    version = await createVersion(svcOf(base44), {
      project: s.project, fs: s.fs, entities: s.state.entities, secrets: s.state.secrets,
      message: message || `Sandbox checkpoint (${build.status})`, changedFiles: changes,
    });
  } catch (e) {
    throw resourceError("RESOURCE_PERSISTENCE_FAILED", `the checkpoint could not be persisted: ${e.message}`, { project_id: s.project.id });
  }
  await audit(svcOf(base44), {
    workspace_id: s.workspace.id, project_id: s.project.id, user_id: user?.id || null,
    action: "sandbox.checkpoint_created", resource: "ProjectVersion", resource_id: version.id,
    metadata: scrub({ version: version.number, build_status: build.status, changes: changes.length }),
  }).catch(() => {});
  return {
    ok: true, project_id: s.project.id, version_id: version.id, version: version.number,
    build_status: build.status, changed_files: changes, file_count: activeFiles(s.fs).length,
    entities: s.state.entities.map((e) => e.name),
  };
}

/** THE sandbox dispatcher. One operation per call, each authorized and validated on its own. */
export async function sandboxExecute(base44, user, op, body = {}) {
  const args = { ...body, project_id: String(body.project_id || "") };
  switch (String(op)) {
    case "info": return sandboxInfo(base44, user, args);
    case "read_file": return sandboxRead(base44, user, args);
    case "list_directory": return sandboxListDirectory(base44, user, args);
    case "grep": return sandboxGrep(base44, user, args);
    case "write_file": return sandboxWrite(base44, user, args);
    case "edit_file": return sandboxEdit(base44, user, args);
    case "delete_file": return sandboxDelete(base44, user, args);
    case "run_command": return sandboxRun(base44, user, args);
    case "create_checkpoint": return sandboxCheckpoint(base44, user, args);
    default:
      throw resourceError("RESOURCE_UNSUPPORTED", `'${op}' is not a sandbox operation (${Object.keys(SANDBOX_OPS).join(", ")})`, { op: String(op), operations: Object.keys(SANDBOX_OPS) });
  }
}