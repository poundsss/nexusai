// Clone / Fork / Templates (#33).
//
// One materialization path, three sources:
//   • clone    ... the source project's CURRENT canonical state
//   • fork     ... an immutable ProjectVersion snapshot (lineage kept at that version)
//   • template ... a published, checksum-verified MarketplaceVersion artifact
//
// Everything is derived server-side. Four invariants govern this module:
//
//   1. SECRET VALUES ARE NEVER COPIED. A copy carries secret NAMES and whether they are
//      required — never a value. The new project starts with every credential unset, so
//      cloning somebody else's project can never hand over their credentials.
//   2. NOTHING RUNTIME-IDENTIFYING IS COPIED. Slug, deployment pointers, GitHub links,
//      run/build history and the generated app's DATA stay with the source. A clone is new
//      source code, not a second claim on the original's production identity.
//   3. BOTH ENDS ARE AUTHORIZED. The caller needs project.read on the SOURCE and
//      project.create on the TARGET workspace, resolved through the same rbac matrix every
//      other control-plane surface uses. A cross-workspace clone therefore requires
//      membership of both, and the target's plan project limit is claimed concurrency-safely.
//   4. A FAILED COPY LEAVES NOTHING. The project row is created first (it is what the plan
//      limit is claimed against), so any later failure deletes every record it wrote rather
//      than leaving a half-populated project behind.
import { resolveRole, requireCapability } from "./rbac.ts";
import { loadAuthorizedProject, loadProjectState, audit } from "./authz.ts";
import { createProjectWithinLimit } from "./planLimits.ts";
import { createFs, writeFile } from "./projectFs.ts";
import { commitFiles, commitEntities, commitSecrets, createVersion } from "./persistence.ts";
import { unpackSnapshot } from "./blobStore.ts";
import { getListing, getListingBySlug, getVersion, install, MarketplaceError } from "./marketplace.ts";

export class CloneError extends Error {
  constructor(message, code = "CLONE_ERROR", status = 400, detail = null) {
    super(message); this.code = code; this.status = status; this.detail = detail;
  }
}

const MAX_CLONE_FILES = 500;
const ORIGINS = ["clone", "fork", "template"];
const trim = (v, n) => String(v ?? "").trim().slice(0, n);

// Secret REFERENCES only. This projection is the enforcement point for invariant 1: it is the
// single shape the materializer accepts, and it has no field a value could travel in.
const secretRefs = (rows) => (rows || [])
  .filter((s) => s && s.name)
  .map((s) => ({ name: String(s.name), description: String(s.description || ""), required: s.required !== false }));

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? "")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The target workspace is resolved to a real row and then authorized by membership, so a forged
// id belonging to another account reports "not a member" exactly like an unknown one.
async function authorizeTarget(base44, user, workspaceId, capability = "project.create") {
  const svc = base44.asServiceRole || base44;
  const workspace = workspaceId ? await svc.entities.Workspace.get(String(workspaceId)).catch(() => null) : null;
  if (!workspace) throw new CloneError("You do not have access to that workspace", "NOT_A_MEMBER", 403);
  if (workspace.status && workspace.status !== "active") throw new CloneError("This workspace is not active", "WORKSPACE_INACTIVE", 403);
  const role = await resolveRole(base44, workspace, user);
  if (!role) throw new CloneError("You do not have access to that workspace", "NOT_A_MEMBER", 403);
  requireCapability(role, capability);
  return { workspace, role };
}

// Deletes every record a failed materialization wrote. Scoped to the project it just created,
// so it can never reach the source project's rows.
async function discardProject(svc, projectId) {
  for (const entity of ["ProjectVersion", "ProjectFile", "AppEntity", "ProjectSecret"]) {
    const rows = await svc.entities[entity].filter({ project_id: projectId }, "-created_date", 1000).catch(() => []);
    for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
  }
  await svc.entities.Project.delete(projectId).catch(() => {});
}

/**
 * THE materialization path. Writes a new project from a plain {files, entities, secrets} source
 * through the same persistence functions the AI builder uses, so the result is an ordinary
 * project with an ordinary version 1 — not a special "cloned" kind of record.
 */
async function materialize(base44, { user, workspace, name, description, files, entities, secrets, message, lineage }) {
  const svc = base44.asServiceRole || base44;
  const projectName = trim(name, 120);
  if (!projectName) throw new CloneError("A project name is required", "INVALID_INPUT", 400);

  const source = (files || []).filter((f) => f && f.path);
  if (!source.length) throw new CloneError("The source contains no files to copy", "EMPTY_SOURCE", 422);
  if (source.length > MAX_CLONE_FILES) {
    throw new CloneError(`The source has ${source.length} files, above the ${MAX_CLONE_FILES}-file copy limit.`, "SOURCE_TOO_LARGE", 422);
  }
  if (!ORIGINS.includes(lineage?.origin)) throw new CloneError("Unknown copy origin", "INVALID_ORIGIN", 400);

  // The plan limit is claimed here — before any file, entity or version exists, so a refused
  // copy writes nothing at all.
  const project = await createProjectWithinLimit(svc, workspace, {
    name: projectName,
    description: trim(description, 2000),
    framework: lineage.framework || "preact-htm",
    status: "draft",
    version_count: 0,
    last_build_status: "none",
    origin: lineage.origin,
    origin_project_id: lineage.project_id || undefined,
    origin_version_number: lineage.version_number || undefined,
    origin_listing_id: lineage.listing_id || undefined,
    origin_listing_version_id: lineage.listing_version_id || undefined,
  });

  try {
    // writeFile applies the virtual filesystem's own path validation, so a source carrying an
    // unacceptable path is refused here rather than producing an unbuildable project.
    const fs = createFs([]);
    for (const f of source) writeFile(fs, f.path, f.content ?? "");

    const changed = await commitFiles(svc, project.id, fs);
    const entityState = (entities || [])
      .filter((e) => e && e.name)
      .map((e) => ({ id: null, name: String(e.name), fields: e.fields || {}, dirty: true }));
    await commitEntities(svc, project.id, entityState);

    const secretState = secretRefs(secrets).map((s) => ({ ...s, dirty: true }));
    await commitSecrets(svc, project.id, secretState);

    const version = await createVersion(svc, {
      project, fs, entities: entityState, secrets: secretState, message, changedFiles: changed,
    });

    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: { clone: "project.cloned", fork: "project.forked", template: "project.created_from_template" }[lineage.origin],
      resource: "Project", resource_id: project.id,
      metadata: {
        origin: lineage.origin, name: projectName,
        source_project_id: lineage.project_id || null, source_version_number: lineage.version_number || null,
        listing_id: lineage.listing_id || null, listing_version_id: lineage.listing_version_id || null,
        files: changed.length, entities: entityState.length, secrets_declared: secretState.length,
      },
    });

    return {
      project: (await svc.entities.Project.get(project.id)) || project,
      version,
      files_created: changed.length,
      entities_created: entityState.length,
      // Names only — the count of credentials the new project must have configured before it runs.
      secrets_declared: secretState.map((s) => s.name),
    };
  } catch (e) {
    await discardProject(svc, project.id);
    throw e;
  }
}

/** Clones the source project's CURRENT canonical state into a new project. */
export async function cloneProject(base44, user, { source_project_id, target_workspace_id = null, name = null, description = null } = {}) {
  if (!user?.id) throw new CloneError("Sign in to copy a project", "AUTH_REQUIRED", 401);
  const { project: sourceProject } = await loadAuthorizedProject(base44, user, source_project_id, "project.read");
  const { workspace } = await authorizeTarget(base44, user, target_workspace_id || sourceProject.workspace_id);

  const state = await loadProjectState(base44, sourceProject.id);
  return materialize(base44, {
    user, workspace,
    name: name || `${sourceProject.name} copy`,
    description: description ?? sourceProject.description,
    files: state.files,
    entities: state.entities,
    // loadProjectState already projects secrets through secretMetadata (no values); secretRefs
    // narrows them again, so neither path can widen into a value.
    secrets: state.secrets,
    message: `Cloned from ${sourceProject.name}`,
    lineage: { origin: "clone", project_id: sourceProject.id, version_number: sourceProject.version_count || null, framework: sourceProject.framework },
  });
}

/**
 * Forks an IMMUTABLE version of the source project. The fork's content is the snapshot, so a
 * fork of version 3 is exactly version 3 even after the source moves on.
 */
export async function forkProject(base44, user, { source_project_id, version_number = null, target_workspace_id = null, name = null, description = null } = {}) {
  if (!user?.id) throw new CloneError("Sign in to fork a project", "AUTH_REQUIRED", 401);
  const { project: sourceProject } = await loadAuthorizedProject(base44, user, source_project_id, "project.read");
  const { workspace } = await authorizeTarget(base44, user, target_workspace_id || sourceProject.workspace_id);
  const svc = base44.asServiceRole || base44;

  const versions = version_number
    ? await svc.entities.ProjectVersion.filter({ project_id: sourceProject.id, number: Number(version_number) }, "-number", 1)
    : await svc.entities.ProjectVersion.filter({ project_id: sourceProject.id }, "-number", 1);
  const version = versions[0] || null;
  if (!version) throw new CloneError(version_number ? `Version ${version_number} does not exist in this project.` : "This project has no versions to fork.", "VERSION_NOT_FOUND", 404);

  const snapshot = await unpackSnapshot(version);
  return materialize(base44, {
    user, workspace,
    name: name || `${sourceProject.name} fork`,
    description: description ?? sourceProject.description,
    files: snapshot.files,
    entities: snapshot.entities,
    // A snapshot stores secret references by design; it has no values to leak.
    secrets: snapshot.secrets,
    message: `Forked from ${sourceProject.name} version ${version.number}`,
    lineage: { origin: "fork", project_id: sourceProject.id, version_number: version.number, framework: sourceProject.framework },
  });
}

/**
 * Fetches and verifies a template artifact. The stored checksum is re-derived from the bytes that
 * were actually downloaded, so an artifact swapped behind a published version is REFUSED rather
 * than installed — this is what makes "an install resolves to the reviewed artifact" true.
 */
export async function readTemplateArtifact(version) {
  if (!version?.artifact_uri) throw new CloneError("This version has no installable artifact.", "MISSING_ARTIFACT", 422);
  let text;
  try {
    const res = await fetch(version.artifact_uri);
    if (!res.ok) throw new Error(`status ${res.status}`);
    text = await res.text();
  } catch (e) {
    throw new CloneError(`The template artifact could not be read: ${String(e.message).slice(0, 120)}`, "ARTIFACT_UNREADABLE", 502);
  }
  const actual = await sha256Hex(text);
  if (actual !== String(version.artifact_checksum || "").toLowerCase()) {
    throw new CloneError("The template artifact does not match the checksum recorded when this version was published.", "ARTIFACT_CHECKSUM_MISMATCH", 409);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new CloneError("The template artifact is not valid JSON.", "ARTIFACT_MALFORMED", 422); }
  if (!Array.isArray(parsed?.files) || !parsed.files.length) throw new CloneError("The template artifact contains no files.", "ARTIFACT_MALFORMED", 422);
  return { files: parsed.files, entities: Array.isArray(parsed.entities) ? parsed.entities : [], secrets: Array.isArray(parsed.secrets) ? parsed.secrets : [] };
}

/**
 * Creates a project FROM a marketplace template. The marketplace install path still runs in full
 * — trust gate, compatibility, capability consent and the idempotent paid charge — so a template
 * cannot bypass the checks a normal install faces. The project is materialized first because
 * install() records the install AGAINST it; if the install is refused the project is discarded,
 * leaving neither a project nor an install.
 */
export async function createProjectFromTemplate(base44, user, { listing_id = null, listing_slug = null, version_id = null, target_workspace_id, name = null, description = null, consented_capabilities = [] } = {}) {
  if (!user?.id) throw new CloneError("Sign in to use a template", "AUTH_REQUIRED", 401);
  const svc = base44.asServiceRole || base44;
  // A template creates a project AND installs a listing, so both capabilities are required.
  const { workspace } = await authorizeTarget(base44, user, target_workspace_id, "project.create");
  await authorizeTarget(base44, user, target_workspace_id, "marketplace.install");

  const listing = listing_id ? await getListing(svc, listing_id) : (listing_slug ? await getListingBySlug(svc, listing_slug) : null);
  if (!listing) throw new CloneError("Template not found", "NOT_FOUND", 404);
  if (listing.kind !== "template") throw new CloneError(`"${listing.name}" is a ${listing.kind} listing, not a template.`, "NOT_A_TEMPLATE", 409);

  const version = version_id ? await getVersion(svc, version_id) : (listing.current_version_id ? await getVersion(svc, listing.current_version_id) : null);
  if (!version || version.listing_id !== listing.id) throw new CloneError("Template version not found for this listing", "NOT_FOUND", 404);

  // Read and verify the artifact BEFORE creating anything, so a bad artifact never consumes a
  // project slot or a credit.
  const artifact = await readTemplateArtifact(version);

  const created = await materialize(base44, {
    user, workspace,
    name: name || listing.name,
    description: description ?? listing.summary,
    files: artifact.files,
    entities: artifact.entities,
    secrets: artifact.secrets,
    message: `Created from template ${listing.name} v${version.version_number}`,
    lineage: { origin: "template", listing_id: listing.id, listing_version_id: version.id, version_number: version.version_number },
  });

  try {
    const result = await install(svc, {
      workspace_id: workspace.id, project_id: created.project.id, listing_id: listing.id, version_id: version.id,
      consented_capabilities, user_id: user.id, project: created.project,
    });
    return { ...created, install: result.install, charged: result.charged, listing, listing_version: version };
  } catch (e) {
    await discardProject(svc, created.project.id);
    if (e instanceof MarketplaceError) throw new CloneError(e.message, e.code, e.status, e.detail);
    throw e;
  }
}

export { MAX_CLONE_FILES, ORIGINS };