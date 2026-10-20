// THE Base44 resource PUSH / PULL layer (E14).
//
//        local project resources  ⇅  push / pull  ⇅  remote project state
//
// This module owns no resource format, no validator and no persistence model of its own. Every
// resource kind already has exactly one canonical representation in this platform, and push/pull
// goes through those same implementations:
//
//   config          base44/config.jsonc            → validateConfigDocument (base44Layout)
//   entities        base44/entities/<Name>.jsonc    → parseEntitySchema / entitySchemaContent, AppEntity
//   functions       base44/functions/<name>/entry.ts (canonical) or functions/<name>.js (legacy)
//   workflows       base44/workflows/<Name>.jsonc   → workflowResource + the EXISTING workflow API
//   types           base44/.types/                  → generated declarations, carried verbatim
//   agents · agent-skills · connectors · actors      → reserved, declared UNSUPPORTED, never dropped
//
// Persistence is the EXISTING journalled path: the virtual filesystem (projectFs) enforces canonical
// paths, commitFiles/commitEntities write the project's own records, and createVersion produces the
// project's next immutable version — so a pushed resource travels with versions, snapshots, restore,
// build and deploy exactly like a resource created any other way.
//
// DETERMINISTIC SEMANTICS
//   identical source/target      → unchanged; nothing written, NO version created (idempotent)
//   local exists, remote missing → created
//   local changed, remote exists → updated as the project's next version
//   local missing, remote exists → mode "full": removed · mode "merge": preserved and reported
//   remote advanced past the caller's `expected_version` → RESOURCE_CONFLICT, nothing applied
//   malformed / duplicate / bad name / wrong kind → refused BEFORE anything is applied
// Pruning is confined to the synchronized SCOPE (the resource kinds being pushed); frontend code,
// integration definitions and every resource kind outside the scope are never touched.
import { audit, loadAuthorizedProject, loadProjectState } from "./authz.ts";
import { scrub } from "./tracing.ts";
import { createFs, writeFile, deleteFile, activeFiles, computeChanges, normalizePath } from "./projectFs.ts";
import { commitFiles, commitEntities, createVersion } from "./persistence.ts";
import {
  CONFIG_FILE, isConfigPath, isEntityFilePath, isTypesPath, isUnsupportedResourcePath,
  entityNameFromPath, entityFilePath, entitySchemaContent, parseEntitySchema, validateConfigDocument,
  ACTORS_DIR, CONNECTORS_DIR, AUTH_DIR, isAgentFilePath, agentNameFromPath,
  isActorFilePath, actorNameFromPath,
} from "./base44Layout.ts";
// Actor resources (E8) reuse the ONE actor document contract — its path grammar, its parse and the
// same sandbox-syntax rules the function build applies. No actor logic is duplicated here.
import { parseActorDocument } from "./actorResource.ts";
// `.app.jsonc` and assets reuse the ONE app-surface contract — its path grammar and its parse.
import { isAppConfigPath, isAssetPath, assetName, parseAppConfig, APP_CONFIG_FILE } from "./appResource.ts";
import { parseAgentDocument, validateAgentReferences } from "./agentResource.ts";
// Agent policy immutability: the same live-run guard restoreProjectVersion applies, so a
// resource push cannot modify or remove the policy of an agent that is actively executing.
import { assertNoActiveAgentPolicyWrite } from "./agentPolicyGuard.ts";
import { isAgentSkillFilePath, agentSkillNameFromPath, parseAgentSkillDocument, collectAgentSkills, MAX_SKILLS_PER_APP } from "./agentSkillResource.ts";
import { isFunctionPath, functionNameFromPath, resolveFunctionPath, FUNCTION_NAME_RE } from "./functionPaths.ts";
import { isWorkflowFilePath, workflowKeyFromPath, parseWorkflowDocument } from "./workflowResource.ts";
// Connector resources (E12) reuse the ONE connector contract: its path grammar, its parse and its
// projection onto the EXISTING integration runtime. No connector logic is duplicated here.
import { isConnectorFilePath, connectorNameFromPath, parseConnectorDocument, connectorRuntimePath, connectorRuntimeContent, adoptableConnectors } from "./connectorResource.ts";
import { syncWorkflowResources, exportWorkflowResource } from "./workflowSync.ts";
import { publicDefinition } from "./workflowApi.ts";
import { resourceError } from "./resourceErrors.ts";

const svcOf = (b) => b.asServiceRole || b;

/** Resource kinds this layer can synchronize today. */
export const SUPPORTED_KINDS = ["config", "app-config", "assets", "entities", "functions", "workflows", "agents", "agent-skills", "connectors", "actors", "types"];
/** Reserved kinds the layout declares but the platform cannot define yet. Reported, never dropped. */
export const RESERVED_KINDS = ["auth"];
export const RESOURCE_KINDS = [...SUPPORTED_KINDS, ...RESERVED_KINDS];

const RESERVED_DIRS = [[AUTH_DIR, "auth"]];

/** The resource kind a path declares, using the EXISTING path contracts. `null` = not a resource. */
export function resourceKindOf(path) {
  const p = normalizePath(path);
  if (isConfigPath(p)) return "config";
  if (isAppConfigPath(p)) return "app-config";
  if (isAssetPath(p)) return "assets";
  if (isEntityFilePath(p)) return "entities";
  if (isFunctionPath(p)) return "functions";
  if (isWorkflowFilePath(p)) return "workflows";
  if (isAgentFilePath(p)) return "agents";
  if (isAgentSkillFilePath(p)) return "agent-skills";
  if (isConnectorFilePath(p)) return "connectors";
  if (isActorFilePath(p)) return "actors";
  if (isTypesPath(p)) return "types";
  for (const [dir, kind] of RESERVED_DIRS) if (p.startsWith(dir)) return kind;
  return null;
}

/**
 * The stable identity of ONE resource — what "the same resource" means across push, pull and a
 * layout change. Derived from the same names the creation paths use, so a function that moves
 * between the legacy and canonical layouts keeps ONE identity instead of becoming two resources.
 */
export function resourceIdentity(path, kind = null) {
  const p = normalizePath(path);
  const k = kind || resourceKindOf(p);
  if (k === "config") return "config";
  if (k === "app-config") return "app";
  if (k === "assets") return assetName(p);
  if (k === "entities") return entityNameFromPath(p);
  if (k === "functions") return functionNameFromPath(p);
  if (k === "workflows") return workflowKeyFromPath(p);
  if (k === "agents") return agentNameFromPath(p);
  if (k === "agent-skills") return agentSkillNameFromPath(p);
  if (k === "connectors") return connectorNameFromPath(p);
  if (k === "actors") return actorNameFromPath(p);
  return p;
}

const keyOf = (kind, identity) => `${kind}:${identity}`;

/**
 * Validates ONE resource with the SAME rules its creation path uses — no second validator exists
 * for any kind. Every rejection is a deterministic code naming the resource.
 */
export function validateResource(resource) {
  const r = resource || {};
  const path = normalizePath(r.path);
  if (!path) throw resourceError("RESOURCE_INVALID_PATH", "a resource must declare a 'path'", { resource: r.path ?? null });
  if (typeof r.content !== "string") throw resourceError("RESOURCE_MALFORMED", `${path} must carry its content as a string`, { path, kind: r.kind || null });

  const kind = resourceKindOf(path);
  if (!kind) {
    throw resourceError("RESOURCE_INVALID_PATH", `${path} is not a canonical Base44 resource path`, { path, supported_kinds: SUPPORTED_KINDS });
  }
  // A declared kind that disagrees with the path is a stated mismatch, never silently re-filed.
  if (r.kind && String(r.kind) !== kind) {
    throw resourceError("RESOURCE_KIND_MISMATCH", `${path} is a '${kind}' resource but was declared as '${r.kind}'`, { path, declared_kind: String(r.kind), actual_kind: kind });
  }
  if (RESERVED_KINDS.includes(kind) || isUnsupportedResourcePath(path)) {
    throw resourceError("RESOURCE_UNSUPPORTED", `${path} is a reserved '${kind}' resource that this platform cannot define yet — it is reported, never discarded`, { path, kind });
  }

  const identity = resourceIdentity(path, kind);
  if (kind === "config") {
    const check = validateConfigDocument(r.content);
    if (!check.ok) throw resourceError("RESOURCE_MALFORMED", `${CONFIG_FILE} ${check.error}`, { path, kind });
  } else if (kind === "entities") {
    let parsed;
    try { parsed = parseEntitySchema(r.content); }
    catch (e) { throw resourceError("RESOURCE_MALFORMED", `${path} is not a valid entity declaration: ${e.message}`, { path, kind }); }
    // The FILE NAME is the entity's identity, so a document naming a different entity is refused
    // rather than quietly creating or overwriting the wrong entity.
    if (parsed.name !== identity) {
      throw resourceError("RESOURCE_INVALID_NAME", `${path} declares entity '${parsed.name}' but its file name says '${identity}'`, { path, kind, declared_name: parsed.name, expected_name: identity });
    }
    return { path, kind, identity, content: r.content, entity: parsed };
  } else if (kind === "functions") {
    if (!FUNCTION_NAME_RE.test(identity)) {
      throw resourceError("RESOURCE_INVALID_NAME", `${path} declares an invalid backend function name '${identity}'`, { path, kind, name: identity });
    }
    if (!r.content.trim()) throw resourceError("RESOURCE_MALFORMED", `${path} is empty — a backend function must export a handler`, { path, kind });
  } else if (kind === "workflows") {
    const parsed = parseWorkflowDocument(path, r.content);
    if (!parsed.ok) throw resourceError("RESOURCE_MALFORMED", `${path} ${parsed.error}`, { path, kind });
    return { path, kind, identity, content: r.content, workflow: parsed };
  } else if (kind === "agents") {
    // The SAME parser the runtime resolves an agent with, so a document that syncs is a document
    // the agent engine can actually run — including its tool grants, which fail closed.
    const parsed = parseAgentDocument(path, r.content);
    if (!parsed.ok) throw resourceError("RESOURCE_MALFORMED", `${path} ${parsed.error}`, { path, kind, ...(parsed.details || {}) });
    return { path, kind, identity, content: r.content, agent: parsed.agent };
  } else if (kind === "agent-skills") {
    const parsed = parseAgentSkillDocument(path, r.content);
    if (!parsed.ok) throw resourceError("RESOURCE_MALFORMED", `${path} ${parsed.error}`, { path, kind, ...(parsed.details || {}) });
    return { path, kind, identity, content: r.content, skill: parsed.skill };
  } else if (kind === "connectors") {
    // The SAME parse the connector contract uses, which in turn defers to the ONE integration
    // validator — so a connector that syncs is a connector the existing runtime can execute.
    const parsed = parseConnectorDocument(path, r.content);
    if (!parsed.ok) throw resourceError("RESOURCE_MALFORMED", `${path} ${parsed.error}`, { path, kind, ...(parsed.details || {}) });
    return { path, kind, identity, content: r.content, connector: parsed.connector };
  } else if (kind === "app-config") {
    // The SAME parse the build validates app metadata with, so a document that syncs is a document
    // the build and the deploy can read.
    const parsed = parseAppConfig(path, r.content);
    if (!parsed.ok) throw resourceError("RESOURCE_MALFORMED", `${APP_CONFIG_FILE} ${parsed.error}`, { path, kind });
    return { path, kind, identity, content: r.content, app: parsed.app };
  } else if (kind === "assets") {
    // An asset is static content: its PATH is the whole contract, already enforced by the grammar
    // that classified it. Nothing about its bytes is interpreted.
    if (!r.content.length) throw resourceError("RESOURCE_MALFORMED", `${path} is an empty asset`, { path, kind });
  } else if (kind === "actors") {
    // The SAME parse the actor runtime resolves a room with, so an actor that syncs is an actor the
    // stateful runtime can actually execute — including the capability its invocation requires.
    const parsed = parseActorDocument(path, r.content);
    if (!parsed.ok) throw resourceError("RESOURCE_MALFORMED", `${path} ${parsed.error}`, { path, kind, ...(parsed.details || {}) });
    return { path, kind, identity, content: r.content, actor: parsed.actor };
  }
  return { path, kind, identity, content: r.content };
}

/**
 * Validates a whole source set and rejects two resources claiming ONE identity — including the same
 * function declared in both layouts, which would otherwise make "which copy is authoritative?"
 * ambiguous. Fail-fast: the first refusal aborts, so a bad set applies nothing.
 */
export function validateResourceSet(resources) {
  if (!Array.isArray(resources)) throw resourceError("RESOURCE_INVALID_SOURCE", "'resources' must be an array of { path, content }", { got: typeof resources });
  const seen = new Map();
  const out = [];
  for (const r of resources) {
    const v = validateResource(r);
    const key = keyOf(v.kind, v.identity);
    if (seen.has(key)) {
      throw resourceError("RESOURCE_DUPLICATE", `${v.path} declares the same ${v.kind} resource as ${seen.get(key)}`, { path: v.path, kind: v.kind, identity: v.identity, conflicting_path: seen.get(key) });
    }
    seen.set(key, v.path);
    out.push(v);
  }
  return out;
}

/** Every FINALIZED workflow definition of a project, latest version per lineage. */
async function finalizedWorkflows(svc, project_id) {
  const rows = await svc.entities.WorkflowDefinition.filter({ project_id: String(project_id) }, "-version", 200).catch(() => []);
  const latest = new Map();
  for (const d of rows) {
    if (d.status !== "FINALIZED") continue;
    const prev = latest.get(d.workflow_key);
    if (!prev || Number(d.version) > Number(prev.version)) latest.set(d.workflow_key, d);
  }
  return [...latest.values()];
}

/**
 * PULL — the project's current resource state, reconstructed into the canonical local
 * representation.
 *
 * Deterministic: entities are projected from the authoritative AppEntity rows through the SAME
 * emitter the creation path uses (so a pulled document is byte-identical to a re-emitted one, and
 * any foreign metadata already on the stored file is carried over rather than dropped), workflows
 * from their finalized definitions, and files that ARE the canonical representation (config,
 * functions, types) verbatim. Reserved resource kinds are reported in `unsupported` — a resource
 * this platform cannot represent is never silently discarded.
 */
export async function pullResources(base44, user, { project_id, kinds = null } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, String(project_id || ""), "project.read");
  const svc = svcOf(base44);
  const scope = new Set(kinds && kinds.length ? kinds.map(String) : SUPPORTED_KINDS);
  const state = await loadProjectState(base44, project.id);
  const byPath = new Map(state.files.map((f) => [normalizePath(f.path), f.content || ""]));
  const resources = [];
  const unsupported = [];

  for (const [path, content] of byPath) {
    const kind = resourceKindOf(path);
    if (!kind) continue;
    if (RESERVED_KINDS.includes(kind)) { unsupported.push({ path, kind, reason: "reserved resource kind is not representable yet" }); continue; }
    // Entities and workflows are projected from their authoritative records below.
    if (kind === "entities" || kind === "workflows") continue;
    if (scope.has(kind)) resources.push({ kind, identity: resourceIdentity(path, kind), path, content });
  }

  if (scope.has("entities")) {
    for (const e of state.entities) {
      const path = entityFilePath(e.name);
      resources.push({ kind: "entities", identity: e.name, path, content: entitySchemaContent(e.name, e.fields || {}, byPath.get(path) || null, e.rls) });
    }
  }
  if (scope.has("workflows")) {
    for (const d of await finalizedWorkflows(svc, project.id)) {
      const exported = exportWorkflowResource(publicDefinition(d));
      // The project's OWN resource document wins when it exists: a stored definition comes back with
      // every optional field materialized, so re-projecting it would hand back a different-but-
      // equivalent document and make an unchanged round-trip look like an edit. The projection is
      // what ADOPTS a definition that has no file yet (API-authored or legacy workflows).
      const onDisk = byPath.get(exported.path);
      resources.push({
        kind: "workflows", identity: exported.workflow_key, path: exported.path,
        content: onDisk !== undefined ? onDisk : exported.content,
        source: onDisk !== undefined ? "file" : "definition",
        version: d.version, definition_checksum: d.definition_checksum,
      });
    }
  }

  resources.sort((a, b) => a.path.localeCompare(b.path));
  return {
    project_id: project.id, ok: true, version: project.version_count || 0,
    count: resources.length, kinds: [...scope], resources, unsupported,
  };
}

/** The deterministic per-identity comparison push and status both answer from. */
export function diffResources(local, remote) {
  const l = new Map(local.map((r) => [keyOf(r.kind, r.identity), r]));
  const rm = new Map(remote.map((r) => [keyOf(r.kind, r.identity), r]));
  const out = [];
  for (const [key, r] of l) {
    const other = rm.get(key);
    const state = !other ? "local_only" : other.content === r.content ? "identical" : "changed";
    out.push({ kind: r.kind, identity: r.identity, path: r.path, remote_path: other?.path || null, state });
  }
  for (const [key, r] of rm) if (!l.has(key)) out.push({ kind: r.kind, identity: r.identity, path: null, remote_path: r.path, state: "remote_only" });
  return out.sort((a, b) => `${a.kind}${a.identity}`.localeCompare(`${b.kind}${b.identity}`));
}

/** What a push WOULD do, with nothing written. Same authorization and comparison as the push. */
export async function resourceStatus(base44, user, { project_id, resources = [], kinds = null, mode = "full" } = {}) {
  const local = validateResourceSet(resources);
  const remote = await pullResources(base44, user, { project_id, kinds });
  return {
    project_id: remote.project_id, ok: true, version: remote.version, mode: String(mode),
    resources: diffResources(local, remote.resources), unsupported: remote.unsupported,
  };
}

/**
 * PUSH — apply the local resource state to the project.
 *
 * Everything is validated BEFORE anything is applied, so a set containing one bad resource changes
 * nothing. Application then reuses the project's existing machinery end to end: the virtual
 * filesystem re-checks every canonical path, commitFiles/commitEntities write the project's own
 * records, createVersion produces the next immutable version (ONLY when something actually
 * changed), and workflows are materialized by the EXISTING workflow resource sync — which keeps
 * definition immutability, versioning, validation and scheduling entirely in that path.
 */
export async function pushResources(base44, user, { project_id, resources = [], kinds = null, mode = "full", expected_version = null, message = null } = {}) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, String(project_id || ""), "project.write");
  const syncMode = String(mode) === "merge" ? "merge" : "full";
  const local = validateResourceSet(resources);

  // Optimistic concurrency, using the project's EXISTING version counter: a caller that read the
  // project at one version and pushes after someone else advanced it is refused, never merged.
  if (expected_version != null && Number(expected_version) !== Number(project.version_count || 0)) {
    throw resourceError("RESOURCE_CONFLICT", `the project has moved to version ${project.version_count || 0} since version ${expected_version} was read — pull again before pushing`, { project_id: project.id, expected_version: Number(expected_version), actual_version: Number(project.version_count || 0) });
  }

  // The synchronized SCOPE. Explicit `kinds` win; otherwise it is exactly the kinds the source
  // declares, so a push of workflows can never prune entities it said nothing about.
  const scope = new Set(kinds && kinds.length ? kinds.map(String) : local.map((r) => r.kind));
  for (const k of scope) if (!SUPPORTED_KINDS.includes(k)) throw resourceError("RESOURCE_UNSUPPORTED", `'${k}' is not a synchronizable resource kind (${SUPPORTED_KINDS.join(", ")})`, { kind: k, supported_kinds: SUPPORTED_KINDS });

  const state = await loadProjectState(base44, project.id);
  const fs = createFs(state.files);
  const existingPaths = state.files.map((f) => normalizePath(f.path));
  const remoteByKey = new Map();
  for (const p of existingPaths) {
    const kind = resourceKindOf(p);
    if (kind && !RESERVED_KINDS.includes(kind)) remoteByKey.set(keyOf(kind, resourceIdentity(p, kind)), p);
  }
  const contentOf = new Map(state.files.map((f) => [normalizePath(f.path), f.content || ""]));
  const entities = state.entities.map((e) => ({ ...e }));
  const applied = [];

  // ---- apply the source ----------------------------------------------------
  for (const r of local) {
    // A function keeps the layout the project already uses, so pushing into a legacy project never
    // creates a second copy of the same function in the canonical directory.
    const target = r.kind === "functions" ? resolveFunctionPath(r.identity, existingPaths) : r.path;
    const before = contentOf.get(target);
    const fileUnchanged = before === r.content;

    if (r.kind === "entities") {
      const existing = entities.find((e) => e.name === r.identity);
      const nextRls = r.entity.rls || null;
      const changed = !existing || JSON.stringify(existing.fields || {}) !== JSON.stringify(r.entity.fields || {}) || JSON.stringify(existing.rls || null) !== JSON.stringify(nextRls);
      if (existing) { existing.fields = r.entity.fields; existing.rls = nextRls; existing.dirty = changed || existing.dirty; }
      else entities.push({ id: null, name: r.identity, fields: r.entity.fields, ...(nextRls ? { rls: nextRls } : {}), dirty: true });
      if (!fileUnchanged) writeFile(fs, target, r.content);
      applied.push({ kind: r.kind, identity: r.identity, path: target, action: fileUnchanged && !changed ? "unchanged" : before === undefined ? "created" : "updated" });
      continue;
    }

    if (fileUnchanged) { applied.push({ kind: r.kind, identity: r.identity, path: target, action: "unchanged" }); continue; }
    writeFile(fs, target, r.content);   // the existing canonical-path guard runs again here
    applied.push({ kind: r.kind, identity: r.identity, path: target, action: before === undefined ? "created" : "updated" });
  }

  // ---- connectors: materialize the EXISTING integration runtime projection --
  // The connector document is authoritative; `integrations/<name>.json` is its materialization, so
  // no second connector runtime is created and the existing integration runtime is reached
  // unchanged. Written only when the projection actually differs, keeping a re-push idempotent.
  for (const r of local) {
    if (r.kind !== "connectors") continue;
    const runtimePath = connectorRuntimePath(r.identity);
    const runtimeContent = connectorRuntimeContent(r.connector);
    if (contentOf.get(runtimePath) !== runtimeContent) writeFile(fs, runtimePath, runtimeContent);
  }

  // ---- full-sync: a resource absent from the source leaves the target -------
  const removed = [];
  if (syncMode === "full") {
    const sourceKeys = new Set(local.map((r) => keyOf(r.kind, r.identity)));
    for (const [key, path] of remoteByKey) {
      const kind = key.slice(0, key.indexOf(":"));
      if (!scope.has(kind) || sourceKeys.has(key)) continue;
      deleteFile(fs, path);
      if (kind === "connectors") {
        // The projection exists only because the connector declared it, so it leaves with it.
        const runtimePath = connectorRuntimePath(resourceIdentity(path, kind));
        if (contentOf.has(runtimePath)) deleteFile(fs, runtimePath);
      }
      if (kind === "entities") {
        // The DECLARATION is removed; stored records are never deleted by a resource sync.
        const row = entities.find((e) => e.name === resourceIdentity(path, kind));
        // R-9/R-10 (provisional, PA-18): a failed removal fails the sync before anything is
        // reported removed; a retry is idempotent.
        if (row?.id) {
          try { await base44.entities.AppEntity.delete(row.id); }
          catch { throw resourceError("RESOURCE_PERSISTENCE_FAILED", `entity "${row.name}" could not be removed; nothing was reported removed — retry the sync`, { kind, identity: row.name }); }
        }
        if (row) entities.splice(entities.indexOf(row), 1);
      }
      removed.push({ kind, identity: resourceIdentity(path, kind), path });
    }
  }

  // ---- cross-resource check, BEFORE anything is persisted -------------------
  // An agent may only reference an agent-skill that actually exists in the project after this
  // push. Checked against the resulting file set, so removing a skill an agent still declares is
  // refused rather than leaving the agent pointing at guidance that is not there.
  if (scope.has("agents") || scope.has("agent-skills")) {
    const refs = validateAgentReferences(activeFiles(fs));
    if (!refs.ok) {
      throw resourceError("RESOURCE_VALIDATION_FAILED", refs.errors[0]?.error || `agent '${refs.missing[0]?.path}' references missing agent-skill '${refs.missing[0]?.skill}'`, { errors: refs.errors.map((e) => e.error), missing: refs.missing });
    }
    // Same DOCUMENTED per-app limit the build enforces (fail closed above 100 valid skills),
    // applied to the RESULTING file set before anything is persisted — a push that would take
    // the project over the limit leaves the project untouched. Exact Base44 above-limit
    // semantics are NOT published (UNKNOWN); this mirrors the build's deterministic refusal.
    const skillCheck = collectAgentSkills(activeFiles(fs));
    if (skillCheck.skills.length > MAX_SKILLS_PER_APP) {
      throw resourceError("RESOURCE_VALIDATION_FAILED", `the project declares ${skillCheck.skills.length} agent skills (base44/agent-skills/<name>.md) but an app may declare at most ${MAX_SKILLS_PER_APP}`, { count: skillCheck.skills.length, limit: MAX_SKILLS_PER_APP });
    }
  }

  // ---- persist through the EXISTING journalled path ------------------------
  const changes = computeChanges(fs);
  // Agent policy immutability: a live agent's policy file cannot be modified or removed by a
  // resource push (AGENT_POLICY_IMMUTABLE, 409). Checked AFTER validation, BEFORE anything is
  // persisted — so a refused push leaves the project untouched. All other files are unchanged.
  await assertNoActiveAgentPolicyWrite(base44, project.id, changes.map((c) => c.path));
  let version = null;
  try {
    if (changes.length) await commitFiles(svcOf(base44), project.id, fs);
    await commitEntities(base44, project.id, entities);
    if (changes.length) {
      version = await createVersion(svcOf(base44), {
        project, fs, entities, secrets: state.secrets,
        message: message || `Pushed ${changes.length} resource change(s)`,
        changedFiles: changes,
      });
    }
  } catch (e) {
    throw resourceError("RESOURCE_PERSISTENCE_FAILED", `the project's resources could not be persisted: ${e.message}`, { project_id: project.id, changes: changes.length });
  }

  // ---- workflows are materialized by the EXISTING resource sync -------------
  let workflows = null;
  if (scope.has("workflows")) {
    workflows = await syncWorkflowResources(base44, user, { project_id: project.id, files: activeFiles(fs) });
  }

  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user?.id || null,
    action: "resource.pushed", resource: "ProjectVersion", resource_id: version?.id || null,
    metadata: scrub({ mode: syncMode, kinds: [...scope], applied: applied.length, removed: removed.length, changes: changes.length, version: version?.number || null }),
  }).catch(() => {});

  return {
    project_id: project.id,
    ok: workflows ? workflows.ok : true,
    mode: syncMode, kinds: [...scope],
    created: applied.filter((a) => a.action === "created").length,
    updated: applied.filter((a) => a.action === "updated").length,
    unchanged: applied.filter((a) => a.action === "unchanged").length,
    removed: removed.length,
    resources: applied, removed_resources: removed,
    changed_files: changes,
    version: version ? version.number : Number(project.version_count || 0),
    version_created: !!version,
    workflows,
  };
}