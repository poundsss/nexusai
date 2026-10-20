// Version restore service. ONE rollback implementation, shared by the builder UI and the MCP
// server.
//
// A restore is a TRANSACTION over three things that must agree afterwards: the project's files,
// its entity declarations, and the generated app's data. It therefore runs on the same journalled,
// crash-safe commit infrastructure as an AI commit (prepare → migrate data → apply → version),
// so the project ends up wholly at the restored state or wholly at the state it started from —
// never with an old schema over newer-shaped records.
import { createFs, computeChanges } from "./projectFs.ts";
import { runBuild } from "./buildEngine.ts";
import { loadProjectState, audit } from "./authz.ts";
import { recordBuild } from "./persistence.ts";
import { unpackSnapshot, packJson, unpackJson } from "./blobStore.ts";
import { prepareCommit, finalizeCommit, rollbackCommit } from "./commitJournal.ts";
import { planRestoreSchema, assessRestoreSchema, backupAppData, applyRestoreSchema } from "./restoreSchema.ts";
import { safeSyncProjectIndex } from "./projectIndex.ts";
import { integrationsView } from "./tools.ts";
import { assertNoActiveAgentPolicyWrite } from "./agentPolicyGuard.ts";
import { reconcileArchitectureAfterMutation } from "./architectureReconcile.ts";

const svcOf = (base44) => base44.asServiceRole || base44;

// One journal per (project, restored version, base version): a retry of the SAME restore resumes
// that journal — so it can never produce a second version — while a later restore of the same
// version from a new base is a new operation.
const restoreRunId = (project, version, baseVersion) => `restore:${project.id}:${version.id}:${baseVersion}`;

export async function restoreProjectVersion(base44, { project, workspace, user, versionId, baseVersionNumber = null, force = false }) {
  const svc = svcOf(base44);
  const version = await base44.entities.ProjectVersion.get(versionId).catch(() => null);
  if (!version || version.project_id !== project.id) {
    throw Object.assign(new Error("Version not found"), { status: 404, code: "VERSION_NOT_FOUND" });
  }

  // Optimistic concurrency, checked up front when the caller states what it saw: a restore built
  // on a stale view of version history is refused before anything is read or written. The same
  // rule is re-checked inside the journal at the moment of application.
  const baseVersion = project.version_count || 0;
  if (baseVersionNumber != null && Number(baseVersionNumber) !== baseVersion) {
    throw Object.assign(new Error(`Version conflict: restore started from v${baseVersionNumber}, project is at v${baseVersion}`), { status: 409, code: "VERSION_CONFLICT" });
  }

  const snapshot = await unpackSnapshot(version);
  const state = await loadProjectState(base44, project.id);
  const fs = createFs(state.files);

  // Overlay the snapshot on the current filesystem (tracks adds/modifies/deletes for the diff).
  const snapPaths = new Set(snapshot.files.map((f) => f.path));
  for (const f of snapshot.files) {
    const cur = fs.files.get(f.path);
    if (cur) { cur.content = f.content; cur.deleted = false; }
    else fs.files.set(f.path, { id: null, content: f.content, original: null, frozen: false, deleted: false });
  }
  for (const [path, f] of fs.files.entries()) if (!snapPaths.has(path)) { if (f.id) f.deleted = true; else fs.files.delete(path); }

  // Security rules travel with the entity exactly as the snapshot recorded them. An older snapshot
  // without an `rls` key stays without one, so applySnapshot keeps its previous fallback behaviour.
  const entities = (snapshot.entities || []).map((e) => ({
    name: e.name, fields: e.fields || {},
    ...(Object.prototype.hasOwnProperty.call(e, "rls") ? { rls: e.rls ?? null } : {}),
  }));

  // Gate 1 — the snapshot must build. Nothing has been mutated at this point.
  const build = runBuild(fs, entities, state.secrets);
  const buildRec = await recordBuild(base44, project.id, null, build);
  if (build.status !== "success") {
    throw Object.assign(new Error("Snapshot does not build; restore aborted"), { status: 409, code: "RESTORE_BUILD_FAILED", build_id: buildRec.id, logs: build.logs });
  }

  // Gate 2 — the app's DATA must be migratable to the restored schema. The verdict comes from the
  // existing migration engine's dry run, so a value-level incompatibility is refused here rather
  // than discovered halfway through a mutation.
  const plan = planRestoreSchema(state.entities, entities);
  const assessment = await assessRestoreSchema(base44, project.id, plan, { toVersionId: version.id, fromVersionId: null, force });
  if (!assessment.safe) {
    throw Object.assign(
      new Error(`Restoring version ${version.number} would require an unsafe data migration: ${assessment.blocking.map((b) => `${b.entity}.${b.field} (${b.op}, ${b.affected} record(s)) — ${b.reason}`).join("; ")}`),
      { status: 409, code: "SCHEMA_MIGRATION_UNSAFE", blocking: assessment.blocking },
    );
  }

  const changes = computeChanges(fs);

  // Agent policy immutability: a restore rewrites or removes whatever agent documents the
  // snapshot carries, so a policy file of an agent with a LIVE run cannot be restored over
  // (AGENT_POLICY_IMMUTABLE, 409). Restores touching no live agent's policy are unchanged.
  await assertNoActiveAgentPolicyWrite(base44, project.id, changes.map((c) => c.path));

  // Secret REFERENCES: the snapshot's, plus any the project has since declared (applySnapshot
  // never deletes a secret, so a value the user set survives a rollback).
  const secretRefs = [
    ...(snapshot.secrets || []).map((s) => ({ name: s.name, description: s.description || "", required: s.required !== false })),
    ...state.secrets.filter((s) => !(snapshot.secrets || []).some((x) => x.name === s.name)).map((s) => ({ name: s.name, description: s.description || "", required: s.required !== false })),
  ];

  const run = { id: restoreRunId(project, version, baseVersion), base_version_number: baseVersion };
  const journal = await prepareCommit(base44, {
    project, workspace, run,
    message: `Restored version ${version.number}`,
    changedFiles: changes,
    target: { files: snapshot.files.map((f) => ({ path: f.path, content: f.content, frozen: !!f.frozen })), entities, secrets: secretRefs },
  });

  try {
    if (plan.requires_migration) {
      // The data's "before" state is made durable BEFORE the first data write, so a rollback —
      // including one performed later by the recovery sweep — can put the records back.
      let backupUrl = journal.records_backup_url || null;
      if (!backupUrl) {
        const backup = await backupAppData(base44, project.id, plan);
        backupUrl = await packJson(svc, `restore_backup_${project.id}_${version.id}.json`, backup);
        await svc.entities.CommitJournal.update(journal.id, { records_backup_url: backupUrl, heartbeat_at: new Date().toISOString() });
        journal.records_backup_url = backupUrl;
      }
      var migration = await applyRestoreSchema(base44, project.id, plan, { toVersionId: version.id, fromVersionId: null, assessment, force });
    }
    // Files, entity declarations, secret references and the single new version, all applied by
    // the shared commit path (which re-checks optimistic concurrency at the moment of writing).
    var committed = await finalizeCommit(base44, journal, { runId: run.id });
  } catch (e) {
    // Any failure returns the project — schema AND data — to the state it started from.
    // R-9/R-10 (provisional, PA-26): a rollback that did not fully undo is surfaced beside the
    // original error; the journal stays recoverable for the existing sweep.
    let undo;
    try { undo = await rollbackCommit(base44, journal, e.message); } catch (re) { undo = { rolled_back: false, undo_failures: ["rollback"], rollback_error: re?.message }; }
    if (undo?.rolled_back === false && (undo.partial || undo.undo_failures)) {
      e.rollback = { complete: false, undo_failures: undo.undo_failures, recovery: "pending_sweep" };
      e.message = `${e.message} (rollback incomplete: ${undo.undo_failures.join(", ")}; recovery pending)`;
    }
    throw e;
  }

  const newVersion = committed.version;
  // Provenance: the new version records which historical version it reproduces. Set after the
  // fact (and only once) because the shared commit path is generic over commits and restores.
  if (!newVersion.restored_from_version_id) {
    try {
      await svc.entities.ProjectVersion.update(newVersion.id, { restored_from_version_id: version.id });
      newVersion.restored_from_version_id = version.id;
    } catch {
      var provenanceUnsaved = true; // reported below; never claimed as saved
    }
  }
  // Rollback changes what the project IS, so the semantic index must follow it: entries for files
  // the snapshot does not contain are deleted and changed files are re-indexed, leaving no stale
  // object retrievable after a restore.
  await safeSyncProjectIndex(base44, {
    project, fs, entities,
    integrations: integrationsView({ fs, entities, secrets: state.secrets }),
    version_number: newVersion.number,
  });

  // Audit rows are server-written only (the entity refuses app-user creates), so the service role
  // records the restore.
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "version.restored",
    resource: "ProjectVersion", resource_id: newVersion.id,
    metadata: {
      from_version: version.number, to_version: newVersion.number,
      entities_migrated: (migration?.migrations || []).length,
      entities_dropped: migration?.entities_dropped || [],
      records_deleted: migration?.records_deleted || 0,
    },
  });

  // Architecture reconciliation — AFTER the restored version lands, best-effort via the shared
  // wrapper. A restore changes files/entities/data, so the graph must follow it; `user` is the
  // authenticated caller who authorized the restore. A failure never undoes the restore.
  await reconcileArchitectureAfterMutation(base44, user, { project_id: project.id });

  return {
    version: newVersion.number, version_id: newVersion.id, restored_from_version: version.number,
    changed_files: changes, already_restored: committed.already_committed === true,
    restored_from_link_saved: newVersion.restored_from_version_id === version.id && !provenanceUnsaved,
    schema: {
      required_migration: plan.requires_migration,
      migrations: (migration?.migrations || []).map((m) => ({ entity: m.entity, status: m.status, changes: (m.changes || []).map((c) => `${c.op}:${c.field || c.to || ""}`), records_modified: m.records_modified || 0 })),
      entities_dropped: migration?.entities_dropped || [],
      records_deleted: migration?.records_deleted || 0,
      warnings: assessment.warnings,
    },
  };
}

// Restores the record blobs a rolled-back restore had already migrated. Exposed for the recovery
// sweep, which resolves journals whose worker disappeared.
export async function readRecordsBackup(url) {
  return url ? unpackJson(url) : null;
}