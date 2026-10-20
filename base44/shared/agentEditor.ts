// The member-facing Agent create/edit surface (Superagent parity gap #4).
//
// A THIN composition over systems that already exist — no second agent model, no second
// version store, no second validation:
//   • the document is parsed/canonicalized by the CERTIFIED agentResource contract
//     (parseAgentDocument + agentDocumentContent), so every documented owned key keeps its
//     exact validation (tools against the tool registry, tool_configs grammar, memory_config,
//     greetings, caps) — nothing new is validated here;
//   • cross-resource references (skills, selected skills, connectors, context files, function
//     and entity grants) run through the CERTIFIED validateAgentReferences against the file set
//     that WILL exist, with the project's own entity names;
//   • the write goes through the EXISTING journalled projectEdit commit path (collaboration
//     .commitMemberEdit): authorization, the lifecycle gate, the optimistic version check,
//     agent-policy immutability during a live run, the build gate and audit all stay exactly
//     as they are — the editor adds only the document composition in front of it.
// An agent's identity is its file name: creating uses a NEW base44/agents/<name>.jsonc, editing
// rewrites that same file, and a rename is refused (AGENT_NAME_FIXED) rather than silently
// moving identity. Non-editor keys of an existing document (channel-specific and other
// metadata) are preserved verbatim — only the editor-managed documented keys are replaced.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { requireCapability, requireActiveWorkspace } from "./rbac.ts";
import { parseAgentDocument, agentDocumentContent, validateAgentReferences, MEMORY_CONFIG_SCOPES } from "./agentResource.ts";
import { agentFilePath, agentNameFromPath, isAgentFilePath, RESOURCE_NAME_RE, parseJsonc } from "./base44Layout.ts";
import { getModel } from "./modelCatalog.ts";
import { readCanonicalSnapshot } from "./commitJournal.ts";
import { unpackSnapshot } from "./blobStore.ts";
import { commitMemberEdit } from "./collaboration.ts";

const svcOf = (b) => b.asServiceRole || b;
const fail = (status, code, message, details = {}) => { throw Object.assign(new Error(message), { status, code, details }); };

// The documented owned keys the editor manages. Anything NOT here (and not `name`) in an
// existing document passes through untouched — never dropped by a save.
export const EDITOR_MANAGED_KEYS = [
  "display_name", "description", "instructions", "tools", "skills", "selected_skill_names",
  "connectors", "model", "model_tier", "max_steps", "telegram_greeting", "whatsapp_greeting",
  "tool_configs", "context_files", "memory_config", "allow_anonymous_access",
  "automations_model", "cross_app_access",
];

// Restore composes from the project's own version history: how many recent versions it scans
// for a deleted agent's last live content. There is no separate trash architecture.
const AGENT_RESTORE_VERSIONS = 50;

/** Normalizes the editor's own input: only PRESENT keys land in the patch; `null` clears. */
function normalizeInput(input) {
  const patch = {};
  if (!input || typeof input !== "object") return patch;
  const str = (v, max) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };
  const list = (v, itemMax, cap) => Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, itemMax)).filter(Boolean).slice(0, cap) : null;
  if (input.display_name !== undefined) patch.display_name = str(input.display_name, 120);
  if (input.description !== undefined) patch.description = str(input.description, 500);
  if (input.instructions !== undefined) patch.instructions = str(input.instructions, 50000);
  if (input.tools !== undefined) patch.tools = list(input.tools, 100, 50);
  if (input.skills !== undefined) patch.skills = list(input.skills, 100, 50);
  if (input.selected_skill_names !== undefined) patch.selected_skill_names = list(input.selected_skill_names, 100, 10);
  if (input.connectors !== undefined) patch.connectors = list(input.connectors, 100, 10);
  if (input.context_files !== undefined) patch.context_files = list(input.context_files, 500, 10);
  if (input.model !== undefined) patch.model = str(input.model, 120);
  if (input.model_tier !== undefined) patch.model_tier = str(input.model_tier, 20);
  if (input.max_steps !== undefined) {
    const n = Number(input.max_steps);
    patch.max_steps = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  if (input.telegram_greeting !== undefined) patch.telegram_greeting = str(input.telegram_greeting, 500);
  if (input.whatsapp_greeting !== undefined) patch.whatsapp_greeting = str(input.whatsapp_greeting, 500);
  if (input.tool_configs !== undefined) {
    patch.tool_configs = Array.isArray(input.tool_configs)
      ? input.tool_configs
          .filter((t) => t && typeof t === "object")
          .slice(0, 25)
          .map((t) => ({
            ...(t.entity_name ? { entity_name: String(t.entity_name).trim() } : {}),
            ...(t.function_name ? { function_name: String(t.function_name).trim() } : {}),
            ...(Array.isArray(t.allowed_operations) ? { allowed_operations: t.allowed_operations.map(String) } : {}),
            ...(typeof t.description === "string" && t.description.trim() ? { description: t.description.trim().slice(0, 500) } : {}),
          }))
          .filter((t) => t.entity_name || t.function_name)
      : null;
  }
  if (input.memory_config !== undefined) {
    patch.memory_config = input.memory_config && typeof input.memory_config === "object" ? {
      enabled: input.memory_config.enabled !== false,
      scope: MEMORY_CONFIG_SCOPES.includes(input.memory_config.scope) ? input.memory_config.scope : "both",
      ...(typeof input.memory_config.instructions === "string" && input.memory_config.instructions.trim()
        ? { instructions: input.memory_config.instructions.trim().slice(0, 500) } : {}),
    } : null;
  }
  if (input.automations_model !== undefined) {
    const am = String(input.automations_model ?? "").trim();
    // 'automatic' (case-insensitive) is the UI's way of clearing the pin.
    patch.automations_model = am && am.toLowerCase() !== "automatic" ? am.slice(0, 120) : null;
  }
  if (input.cross_app_access !== undefined) patch.cross_app_access = list(input.cross_app_access, 100, 25);
  if (input.allow_anonymous_access !== undefined) patch.allow_anonymous_access = input.allow_anonymous_access === true;
  return patch;
}

/**
 * Composes and validates the agent document WITHOUT writing anything: the raw merge
 * (existing document + editor patch), the certified parse, the canonical content, and the
 * certified cross-resource reference check against the target file set. Throws 422 with
 * structured `details.errors` on any invalid configuration.
 */
export async function buildAgentDocument(svc, projectId, input, originalName = null) {
  const snapshot = await readCanonicalSnapshot(svcOf(svc), projectId);
  const name = String(input?.name || originalName || "").trim();
  if (!RESOURCE_NAME_RE.test(name)) {
    fail(422, "AGENT_NAME_INVALID", "the agent name must be lower-case letters, numbers and dashes", { errors: [`'${name}' is not a valid agent name`] });
  }
  const path = agentFilePath(name);
  const existingFile = snapshot.files.find((f) => f.path === path);
  if (originalName == null && existingFile) fail(409, "AGENT_EXISTS", `an agent named '${name}' already exists in this project`);
  if (originalName != null && originalName !== name) {
    fail(400, "AGENT_NAME_FIXED", "an agent's identity is its file name — renaming requires creating a new agent");
  }
  if (originalName != null && !existingFile) fail(404, "AGENT_NOT_FOUND", `this project does not declare an agent '${originalName}'`);

  // The base RAW document: an existing file is parsed by the certified parser first (a
  // malformed document is refused rather than silently overwritten), and its raw form keeps
  // every non-editor key verbatim for the merge.
  let raw = {};
  if (existingFile) {
    const parsedBase = parseAgentDocument(path, existingFile.content || "");
    if (!parsedBase.ok) fail(422, "AGENT_FILE_MALFORMED", `the existing agent document does not parse: ${parsedBase.error}`);
    raw = parseJsonc(existingFile.content || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  }
  const patch = normalizeInput(input);
  for (const k of EDITOR_MANAGED_KEYS) {
    if (!(k in patch)) continue;
    if (k === "memory_config" && patch.memory_config && typeof patch.memory_config === "object") {
      // A memory edit REPLACES the documented keys it carries and PRESERVES any the editor does
      // not manage (e.g. include_other_conversation_context from the existing document).
      const baseMc = typeof raw.memory_config === "object" && raw.memory_config && !Array.isArray(raw.memory_config) ? raw.memory_config : {};
      raw.memory_config = { ...baseMc, ...patch.memory_config };
    } else if (patch[k] === null) delete raw[k];
    else raw[k] = patch[k];
  }
  raw.name = name;

  // Superagent parity: the AUTOMATIONS model pin must resolve to an ACTIVE catalog model — a
  // background run has no user watching, so a dead model id is refused at save time, not
  // discovered by a failing schedule.
  if (raw.automations_model) {
    let pinned = null;
    try { pinned = getModel(String(raw.automations_model)); } catch { /* handled below */ }
    if (!pinned) fail(422, "AUTOMATIONS_MODEL_UNKNOWN", `the automations model '${raw.automations_model}' is not in the catalog`, { errors: [`unknown automations model '${raw.automations_model}'`] });
    if (pinned && !pinned.active) fail(422, "AUTOMATIONS_MODEL_UNAVAILABLE", `the automations model '${raw.automations_model}' is retired and cannot serve runs`, { errors: [`model '${raw.automations_model}' is not active`] });
  }
  // Cross-app grants must name real, live projects of the SAME workspace — a grant is a
  // workspace-scoped read capability, never a bridge between workspaces.
  if (Array.isArray(raw.cross_app_access) && raw.cross_app_access.length) {
    const own = await svcOf(svc).entities.Project.get(projectId).catch(() => null);
    const wsId = own?.workspace_id;
    const targets = [];
    for (const pid of raw.cross_app_access) {
      const t = pid === projectId ? own : await svcOf(svc).entities.Project.get(pid).catch(() => null);
      if (!t || t.status === "archived" || !wsId || t.workspace_id !== wsId) {
        fail(422, "CROSS_APP_PROJECT_INVALID", `'${pid}' is not an active project of this agent's workspace`, { errors: [`cross-app project '${pid}' is not an active project of this workspace`] });
      }
      targets.push(t.id);
    }
    raw.cross_app_access = targets;
  }
  const parsed = parseAgentDocument(path, JSON.stringify(raw));
  if (!parsed.ok) {
    fail(422, "AGENT_INVALID", `the agent configuration is invalid: ${parsed.error}`, { errors: [parsed.error] });
  }
  const content = agentDocumentContent(parsed.agent);

  // Cross-resource references against the file set that WILL exist (this file added/replaced),
  // with the project's own entity names — the same check the build runs, scoped to THIS agent.
  const targetFiles = [...snapshot.files.filter((f) => f.path !== path), { path, content }];
  const refs = validateAgentReferences(targetFiles, { entityNames: snapshot.entities.map((e) => e.name) });
  const mine = refs.errors.filter((e) => e.path === path);
  if (mine.length) {
    fail(422, "AGENT_INVALID", `the agent configuration is invalid: ${mine[0].error}`, { errors: mine.map((e) => e.error) });
  }
  return { path, content, agent: parsed.agent };
}

/**
 * Creates or edits ONE agent document through the EXISTING journalled commit path. `original_name`
 * null = create; otherwise the edit of that agent. Authorization (project.write, lifecycle gate),
 * conflict safety, live-run policy immutability, the build gate and the audit are all
 * commitMemberEdit's — unchanged.
 */
export async function saveAgentDocument(base44, user, { project_id, agent: input, original_name = null, expected_version = null, edit_id = null } = {}) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  requireCapability(role, "project.write");
  requireActiveWorkspace(workspace, "project.write");
  const { path, content, agent } = await buildAgentDocument(svcOf(base44), project.id, input, original_name);
  const result = await commitMemberEdit(base44, user, {
    project_id: project.id,
    edits: [{ path, content }],
    message: original_name ? `Update agent "${agent.name}"` : `Create agent "${agent.name}"`,
    expected_version,
    edit_id,
  });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: original_name ? "agent.updated" : "agent.created", resource: "ProjectFile", resource_id: path,
    metadata: { agent: agent.name, version: result.version?.number ?? null, role },
  }).catch(() => {});
  return result;
}

// =====================================================================
// Superagent parity: the agent's OWNER operations — clone, move, delete,
// restore. Each is a thin composition over the SAME journalled commit path
// saveAgentDocument uses (authorization, conflicts, live-run policy
// immutability, the build gate and the audit are all commitMemberEdit's);
// nothing here invents a second version store. A deleted agent is
// restorable from the project's OWN version history — there is no
// separate trash architecture.
// =====================================================================

/** Loads + parses ONE existing agent document of the project (fail-closed on either). */
async function existingAgentDocument(svc, projectId, agentName) {
  const snapshot = await readCanonicalSnapshot(svcOf(svc), projectId);
  const path = agentFilePath(String(agentName || "").trim());
  const file = snapshot.files.find((f) => f.path === path);
  if (!file) fail(404, "AGENT_NOT_FOUND", `this project does not declare an agent '${agentName}'`);
  const parsed = parseAgentDocument(path, file.content || "");
  if (!parsed.ok) fail(422, "AGENT_FILE_MALFORMED", `the existing agent document does not parse: ${parsed.error}`);
  return { snapshot, path, parsed };
}

/**
 * Clone: a NEW agent file with every documented key (and the document's own metadata) copied
 * verbatim; only the name differs. An agent document never carries credentials — connectors are
 * declared names and credentials live in app-user DelegatedCredentials — so the copy is safe.
 */
export async function cloneAgentDocument(base44, user, { project_id, original_name, new_name, expected_version = null, edit_id = null } = {}) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  requireCapability(role, "project.write");
  requireActiveWorkspace(workspace, "project.write");
  const { path: srcPath, parsed: src } = await existingAgentDocument(svcOf(base44), project.id, original_name);
  const name = String(new_name || "").trim();
  if (!RESOURCE_NAME_RE.test(name)) {
    fail(422, "AGENT_NAME_INVALID", "the agent name must be lower-case letters, numbers and dashes", { errors: [`'${name}' is not a valid agent name`] });
  }
  const path = agentFilePath(name);
  const snapshot = await readCanonicalSnapshot(svcOf(base44), project.id);
  if (snapshot.files.some((f) => f.path === path)) fail(409, "AGENT_EXISTS", `an agent named '${name}' already exists in this project`);
  const content = agentDocumentContent({ ...src.agent, name });
  const result = await commitMemberEdit(base44, user, {
    project_id: project.id, edits: [{ path, content }],
    message: `Clone agent "${original_name}" as "${name}"`, expected_version, edit_id,
  });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "agent.cloned", resource: "ProjectFile", resource_id: path,
    metadata: { from: src.agent.name, to: name, version: result.version?.number ?? null, role },
  }).catch(() => {});
  return { ...result, agent_name: name, cloned_from: src.agent.name, path };
}

/**
 * Delete: the evidenced tombstone over the journalled commit path — the file leaves the
 * canonical state and the agent stays restorable from the project's version history.
 */
export async function deleteAgentDocument(base44, user, { project_id, agent_name, expected_version = null, edit_id = null } = {}) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  requireCapability(role, "project.write");
  requireActiveWorkspace(workspace, "project.write");
  const { path } = await existingAgentDocument(svcOf(base44), project.id, agent_name);
  const result = await commitMemberEdit(base44, user, {
    project_id: project.id, edits: [{ path, delete: true }],
    message: `Delete agent "${agent_name}"`, expected_version, edit_id,
  });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "agent.deleted", resource: "ProjectFile", resource_id: path,
    metadata: { agent: agent_name, version: result.version?.number ?? null, role },
  }).catch(() => {});
  return { ...result, deleted: agent_name, path };
}

/**
 * Lists agents that a recent version of the project still carries but the canonical state no
 * longer does — the recently-deleted set, with the version that can restore each.
 */
export async function listRecentlyDeletedAgents(base44, user, { project_id } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const snapshot = await readCanonicalSnapshot(svcOf(base44), project.id);
  const present = new Set(snapshot.files.map((f) => f.path));
  const versions = await svcOf(base44).entities.ProjectVersion.filter({ project_id: project.id }, "-number", AGENT_RESTORE_VERSIONS).catch(() => []);
  const found = new Map();
  for (const v of versions) {
    const hydrated = await unpackSnapshot(v).catch(() => null);
    const files = hydrated?.files || [];
    for (const f of Array.isArray(files) ? files : []) {
      if (!f || typeof f.path !== "string" || !isAgentFilePath(f.path) || present.has(f.path) || found.has(f.path)) continue;
      if (typeof f.content !== "string") continue;
      found.set(f.path, { agent_name: agentNameFromPath(f.path), path: f.path, restorable_from_version: v.number });
    }
  }
  return { project_id: project.id, recently_deleted: [...found.values()] };
}

/**
 * Restore: the newest version that still carries the file is the source; the document is
 * re-validated through the certified parser BEFORE the commit, so a restore can never land a
 * malformed agent.
 */
export async function restoreAgentDocument(base44, user, { project_id, agent_name, expected_version = null, edit_id = null } = {}) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  requireCapability(role, "project.write");
  requireActiveWorkspace(workspace, "project.write");
  const snapshot = await readCanonicalSnapshot(svcOf(base44), project.id);
  const path = agentFilePath(String(agent_name || "").trim());
  if (snapshot.files.some((f) => f.path === path)) fail(409, "AGENT_EXISTS", `an agent named '${agent_name}' is already live in this project`);
  const versions = await svcOf(base44).entities.ProjectVersion.filter({ project_id: project.id }, "-number", AGENT_RESTORE_VERSIONS).catch(() => []);
  let source = null, fromVersion = null;
  for (const v of versions) {
    const hydrated = await unpackSnapshot(v).catch(() => null);
    const files = hydrated?.files || [];
    const f = (Array.isArray(files) ? files : []).find((x) => x && x.path === path && typeof x.content === "string");
    if (f) { source = f; fromVersion = v.number; break; }
  }
  if (!source) fail(404, "AGENT_RESTORE_UNAVAILABLE", `no recent version carries the agent '${agent_name}' — it cannot be restored`);
  const parsed = parseAgentDocument(path, source.content);
  if (!parsed.ok) fail(422, "AGENT_FILE_MALFORMED", `the deleted agent document does not parse: ${parsed.error}`);
  const result = await commitMemberEdit(base44, user, {
    project_id: project.id, edits: [{ path, content: source.content }],
    message: `Restore agent "${agent_name}"`, expected_version, edit_id,
  });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "agent.restored", resource: "ProjectFile", resource_id: path,
    metadata: { agent: agent_name, from_version: fromVersion, version: result.version?.number ?? null, role },
  }).catch(() => {});
  return { ...result, restored: agent_name, path, restored_from_version: fromVersion };
}

/**
 * Move: the agent document is committed to the target project FIRST, then deleted from the
 * source — the agent is never in neither. Moving cross-workspace clears the workspace-scoped
 * cross-app grants (they would be invalid in the target workspace).
 */
export async function moveAgentDocument(base44, user, { project_id, agent_name, target_project_id, edit_id = null } = {}) {
  const source = await loadAuthorizedProject(base44, user, project_id, "project.write");
  requireCapability(source.role, "project.write");
  requireActiveWorkspace(source.workspace, "project.write");
  if (String(target_project_id || "") === String(project_id)) fail(400, "MOVE_TO_SELF", "the agent already lives in this project");
  const target = await loadAuthorizedProject(base44, user, target_project_id, "project.write");
  requireCapability(target.role, "project.write");
  requireActiveWorkspace(target.workspace, "project.write");

  const { path, parsed: src } = await existingAgentDocument(svcOf(base44), source.project.id, agent_name);
  const targetSnapshot = await readCanonicalSnapshot(svcOf(base44), target.project.id);
  if (targetSnapshot.files.some((f) => f.path === path)) fail(409, "AGENT_EXISTS", `the target app already declares an agent named '${agent_name}'`);
  const crossWorkspace = target.workspace.id !== source.workspace.id;
  const content = agentDocumentContent({ ...src.agent, ...(crossWorkspace ? { cross_app_access: [] } : {}) });

  const created = await commitMemberEdit(base44, user, {
    project_id: target.project.id, edits: [{ path, content }],
    message: `Move agent "${agent_name}" from "${source.project.name || source.project.id}"`, edit_id,
  });
  await audit(svcOf(base44), {
    workspace_id: target.workspace.id, project_id: target.project.id, user_id: user.id,
    action: "agent.moved_in", resource: "ProjectFile", resource_id: path,
    metadata: { from_project: source.project.id, to_project: target.project.id, agent: agent_name, version: created.version?.number ?? null, role: target.role },
  }).catch(() => {});

  try {
    const deleted = await deleteAgentDocument(base44, user, { project_id: source.project.id, agent_name });
    await audit(svcOf(base44), {
      workspace_id: source.workspace.id, project_id: source.project.id, user_id: user.id,
      action: "agent.moved_out", resource: "ProjectFile", resource_id: path,
      metadata: { from_project: source.project.id, to_project: target.project.id, agent: agent_name, role: source.role },
    }).catch(() => {});
    return { moved: true, agent_name, path, source_project_id: source.project.id, target_project_id: target.project.id, target_version: created.version?.number ?? null, source_version: deleted.version?.number ?? null };
  } catch (e) {
    // The agent now lives in BOTH projects — never in neither. Surfaced, not swallowed.
    return { moved: true, agent_name, path, source_project_id: source.project.id, target_project_id: target.project.id, target_version: created.version?.number ?? null, source_delete_failed: String(e && e.message || e).slice(0, 300) };
  }
}