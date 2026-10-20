// Commit an in-memory project state (fs + entities) to the platform database and create a version.
import { computeChanges, activeFiles } from "./projectFs.ts";
import { packFileContent, packSnapshot } from "./blobStore.ts";
import { enqueueAutoPush } from "./githubAutoPush.ts";

export async function commitFiles(base44, projectId, fs) {
  const changes = computeChanges(fs);
  for (const c of changes) {
    const f = fs.files.get(c.path);
    if (c.change === "added") {
      const stored = await packFileContent(base44, c.path, f.content);
      const created = await base44.entities.ProjectFile.create({ project_id: projectId, path: c.path, ...stored, frozen: false });
      f.id = created.id;
    } else if (c.change === "modified") {
      await base44.entities.ProjectFile.update(f.id, await packFileContent(base44, c.path, f.content));
    } else if (c.change === "deleted") {
      await base44.entities.ProjectFile.delete(f.id);
      fs.files.delete(c.path);
    }
    if (f && !f.deleted) f.original = f.content;
  }
  return changes;
}

export async function commitEntities(base44, projectId, entities) {
  for (const e of entities) {
    if (!e.dirty) continue;
    // `rls` rides BESIDE fields: an entity that declares row-level rules is still the same
    // { name, fields } record everything else already uses, so persisting it is additive and
    // an entity WITHOUT rules is written exactly as before.
    if (e.id) await base44.entities.AppEntity.update(e.id, { fields: e.fields, rls: e.rls || null });
    else {
      const created = await base44.entities.AppEntity.create({ project_id: projectId, name: e.name, fields: e.fields, ...(e.rls ? { rls: e.rls } : {}) });
      e.id = created.id;
    }
    e.dirty = false;
  }
}

// Secret REFERENCES only: a declared-but-unset secret is created so the app surfaces its
// configuration requirement. Values are never written here — this path has none.
export async function commitSecrets(base44, projectId, secrets) {
  // Same client-shape tolerance as loadProjectState: root client or service-role client.
  const svc = base44.asServiceRole || base44;
  for (const s of secrets || []) {
    if (!s.dirty) continue;
    const rows = await svc.entities.ProjectSecret.filter({ project_id: projectId, name: s.name }, "name", 1);
    if (rows.length) await svc.entities.ProjectSecret.update(rows[0].id, { description: s.description || rows[0].description, required: s.required !== false });
    else await svc.entities.ProjectSecret.create({ project_id: projectId, name: s.name, value: "", description: s.description || "", required: s.required !== false, access: "backend_only" });
    s.dirty = false;
  }
}

export async function createVersion(base44, { project, fs, entities, secrets, message, changedFiles, runId, restoredFromId }) {
  const latest = await base44.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1);
  const parent = latest[0] || null;
  const number = (parent ? parent.number : 0) + 1;
  const stored = await packSnapshot(base44, project.id, {
    files: activeFiles(fs),
    // A snapshot carries the entity's rules so a restore, a fork and a deployment all enforce
    // what that version actually declared. An entity with no rules snapshots unchanged.
    entities: entities.map((e) => ({ name: e.name, fields: e.fields, ...(e.rls ? { rls: e.rls } : {}) })),
    // Secret REFERENCES (names + whether they're required). Never values: a snapshot is
    // downloadable content, and rollback must restore configuration, not credentials.
    secrets: (secrets || []).map((s) => ({ name: s.name, description: s.description || "", required: s.required !== false })),
  });
  const version = await base44.entities.ProjectVersion.create({
    project_id: project.id,
    number,
    parent_version_id: parent ? parent.id : undefined,
    restored_from_version_id: restoredFromId || undefined,
    run_id: runId || undefined,
    message,
    changed_files: changedFiles,
    ...stored,
  });
  await (base44.asServiceRole || base44).entities.Project.update(project.id, { version_count: number, status: "ready", last_build_status: "success" });
  // PA-12: fail-safe — records/queues the automatic GitHub push; never fails the save.
  await enqueueAutoPush(base44, project.id, version);
  return version;
}

export async function recordBuild(base44, projectId, runId, build) {
  return base44.entities.Build.create({
    project_id: projectId, run_id: runId || undefined, status: build.status, logs: build.logs.slice(-200),
    error_count: build.errors, file_count: build.file_count, duration_ms: build.duration_ms,
  });
}