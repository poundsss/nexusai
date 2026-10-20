// Crash-safe commit of an AI run's result into canonical project state.
//
// The previous sequence (entities → secrets → files → build → version) mutated canonical
// state directly, so a worker killed halfway left the project partially changed with no
// version and no record of what was intended.
//
// This module turns the commit into a journalled, recoverable transaction:
//
//   1. PREPARE   — both the PREVIOUS canonical state and the COMPLETE TARGET state are
//                  written durably to a CommitJournal. Nothing canonical has changed yet,
//                  and the target version number is fixed here, so a retry can never
//                  produce a second version.
//   2. APPLY     — canonical rows (ProjectFile / AppEntity / ProjectSecret references) are
//                  synced to match the target snapshot. The operation is a convergence, not
//                  an append: running it again on a half-applied project finishes the job
//                  and changes nothing else.
//   3. FINALIZE  — the immutable ProjectVersion is created (or re-used if this run already
//                  created one) and the project pointer is updated. Only now is the journal
//                  'committed', and only a 'committed' journal may be reported as success.
//
// Recovery (recoverPendingCommits) treats a journal past the stale cutoff as an abandoned
// commit and resolves it deterministically:
//   • 'applied'              → roll FORWARD: canonical state already matches the target in
//                              full, so the missing step is only the version.
//   • 'prepared' / 'applying' → roll BACK to the previous snapshot, so no partial canonical
//                              state remains.
// Either way the project ends up wholly in one of the two states, never between them.
import { packSnapshot, unpackSnapshot, packFileContent, unpackFileContent, unpackJson } from "./blobStore.ts";
import { restoreAppData } from "./restoreSchema.ts";
import { enqueueAutoPush } from "./githubAutoPush.ts";

export const STALE_COMMIT_MS = 3 * 60 * 1000;
const svcOf = (base44) => base44.asServiceRole || base44;

// --- snapshots ---------------------------------------------------------------

// The full canonical state of a project, in the same shape a ProjectVersion snapshot uses.
export async function readCanonicalSnapshot(base44, projectId) {
  const svc = svcOf(base44);
  const [files, entities, secrets] = await Promise.all([
    svc.entities.ProjectFile.filter({ project_id: projectId }, { sort: "path", limit: 500 }).then((p) => p.items || []),
    svc.entities.AppEntity.filter({ project_id: projectId }, { sort: "name", limit: 200 }).then((p) => p.items || []),
    svc.entities.ProjectSecret.filter({ project_id: projectId }, { sort: "name", limit: 100 }).then((p) => p.items || []),
  ]);
  return {
    files: await Promise.all(files.map(async (f) => ({ path: f.path, content: await unpackFileContent(f), frozen: !!f.frozen }))),
    // `rls` is always recorded (null = no rules), so applying this snapshot — e.g. a rollback —
    // restores an entity's security rules exactly, including their absence.
    entities: entities.map((e) => ({ name: e.name, fields: e.fields || {}, rls: e.rls ?? null })),
    // Secret REFERENCES only — a snapshot never carries a value.
    secrets: secrets.map((s) => ({ name: s.name, description: s.description || "", required: s.required !== false })),
  };
}

// Converges canonical rows onto `snapshot`. Idempotent by construction: identity is the
// file path / entity name, so re-running after a crash repairs rather than duplicates.
// `heartbeat` (optional) is refreshed every `heartbeatEveryFiles` writes or `heartbeatEveryMs`
// — whichever comes first — so a live (even slow) application keeps its journal from being
// mistaken for an abandoned one by the recovery sweep.
export async function applySnapshot(base44, projectId, snapshot, { heartbeat = null, heartbeatEveryFiles = 25, heartbeatEveryMs = 20 * 1000 } = {}) {
  const svc = svcOf(base44);
  const stats = { files_created: 0, files_updated: 0, files_deleted: 0, entities_written: 0, entities_deleted: 0, secrets_written: 0 };
  let sinceBeatFiles = 0; let lastBeatAt = Date.now();
  const beatIfDue = async () => {
    sinceBeatFiles++;
    if (sinceBeatFiles < heartbeatEveryFiles && Date.now() - lastBeatAt < heartbeatEveryMs) return;
    sinceBeatFiles = 0; lastBeatAt = Date.now();
    if (heartbeat) await heartbeat().catch(() => {});
  };

  const existingFiles = await svc.entities.ProjectFile.filter({ project_id: projectId }, { sort: "path", limit: 500 }).then((p) => p.items || []);
  const byPath = new Map(existingFiles.map((f) => [f.path, f]));
  for (const target of snapshot.files || []) {
    const row = byPath.get(target.path);
    if (!row) {
      const stored = await packFileContent(svc, target.path, target.content);
      await svc.entities.ProjectFile.create({ project_id: projectId, path: target.path, ...stored, frozen: !!target.frozen });
      stats.files_created++;
    } else {
      const current = await unpackFileContent(row);
      if (current !== String(target.content ?? "")) {
        await svc.entities.ProjectFile.update(row.id, await packFileContent(svc, target.path, target.content));
        stats.files_updated++;
      }
      byPath.delete(target.path);
    }
    await beatIfDue();
  }
  // Anything the target does not contain is not part of the project state being applied.
  for (const orphan of byPath.values()) {
    await svc.entities.ProjectFile.delete(orphan.id);
    stats.files_deleted++;
    await beatIfDue();
  }

  const existingEntities = await svc.entities.AppEntity.filter({ project_id: projectId }, { sort: "name", limit: 200 }).then((p) => p.items || []);
  const byName = new Map(existingEntities.map((e) => [e.name, e]));
  for (const target of snapshot.entities || []) {
    const row = byName.get(target.name);
    // Security metadata is applied only when the snapshot carries it. A snapshot written before
    // it was recorded has no `rls` key and keeps the previous behaviour: an existing row's rules
    // are left as they are and a re-created entity gets none.
    const hasRls = Object.prototype.hasOwnProperty.call(target, "rls");
    const rls = hasRls ? (target.rls ?? null) : undefined;
    if (!row) {
      await svc.entities.AppEntity.create({ project_id: projectId, name: target.name, fields: target.fields || {}, ...(rls ? { rls } : {}) });
      stats.entities_written++;
    } else {
      const fieldsChanged = JSON.stringify(row.fields || {}) !== JSON.stringify(target.fields || {});
      const rlsChanged = hasRls && JSON.stringify(row.rls ?? null) !== JSON.stringify(rls);
      if (fieldsChanged || rlsChanged) {
        await svc.entities.AppEntity.update(row.id, { fields: target.fields || {}, ...(hasRls ? { rls } : {}) });
        stats.entities_written++;
      }
      byName.delete(target.name);
    }
    await beatIfDue();
  }
  for (const orphan of byName.values()) {
    await svc.entities.AppEntity.delete(orphan.id);
    stats.entities_deleted++;
    await beatIfDue();
  }

  // Secret REFERENCES are created/updated but never removed: a value the user already set
  // must survive both a commit and a rollback.
  const existingSecrets = await svc.entities.ProjectSecret.filter({ project_id: projectId }, { sort: "name", limit: 100 }).then((p) => p.items || []);
  const secretByName = new Map(existingSecrets.map((s) => [s.name, s]));
  for (const target of snapshot.secrets || []) {
    const row = secretByName.get(target.name);
    if (!row) {
      await svc.entities.ProjectSecret.create({ project_id: projectId, name: target.name, value: "", description: target.description || "", required: target.required !== false, access: "backend_only" });
      stats.secrets_written++;
    } else if ((row.description || "") !== (target.description || "") || (row.required !== false) !== (target.required !== false)) {
      await svc.entities.ProjectSecret.update(row.id, { description: target.description || row.description, required: target.required !== false });
      stats.secrets_written++;
    }
    await beatIfDue();
  }
  return stats;
}

export async function journalSnapshots(journal) {
  return {
    previous: await unpackSnapshot({ snapshot: journal.previous_snapshot, snapshot_url: journal.previous_snapshot_url }),
    target: await unpackSnapshot({ snapshot: journal.target_snapshot, snapshot_url: journal.target_snapshot_url }),
  };
}

// --- lifecycle ---------------------------------------------------------------

export async function findJournalForRun(base44, runId) {
  const rows = await svcOf(base44).entities.CommitJournal.filter({ run_id: runId }, { sort: "-created_date", limit: 1 }).then((p) => p.items || []);
  return rows[0] || null;
}

/**
 * Step 1 — write the recovery journal. Canonical state is NOT touched here.
 * Re-entrant: a run that already has a journal resumes it instead of preparing a second one.
 */
export async function prepareCommit(base44, { project, workspace, run, target, message, changedFiles }) {
  const svc = svcOf(base44);
  const existing = await findJournalForRun(base44, run.id);
  if (existing) {
    await svc.entities.CommitJournal.update(existing.id, { heartbeat_at: new Date().toISOString() });
    return { ...existing, heartbeat_at: new Date().toISOString(), resumed: true };
  }
  const previous = await readCanonicalSnapshot(base44, project.id);
  const prevStored = await packSnapshot(svc, project.id, previous);
  const targetStored = await packSnapshot(svc, project.id, target);
  return svc.entities.CommitJournal.create({
    project_id: project.id, workspace_id: workspace?.id || project.workspace_id, run_id: run.id,
    status: "prepared",
    base_version_number: run.base_version_number || project.version_count || 0,
    // Fixed here so a retry re-uses this number instead of allocating another version.
    target_version_number: (project.version_count || 0) + 1,
    message: String(message || "").slice(0, 200),
    changed_files: changedFiles || [],
    previous_snapshot: prevStored.snapshot, previous_snapshot_url: prevStored.snapshot_url,
    target_snapshot: targetStored.snapshot, target_snapshot_url: targetStored.snapshot_url,
    heartbeat_at: new Date().toISOString(),
  });
}

/**
 * Steps 2 + 3 — apply the target snapshot, then create the single version and update the
 * project pointer. Idempotent: safe to call again on any non-committed journal, and a
 * journal that already produced a version returns that same version.
 */
export async function finalizeCommit(base44, journal, { runId = null } = {}) {
  const svc = svcOf(base44);
  const beat = () => svc.entities.CommitJournal.update(journal.id, { heartbeat_at: new Date().toISOString() }).catch(() => {});

  if (journal.status === "committed" && journal.version_id) {
    const existing = await svc.entities.ProjectVersion.get(journal.version_id).catch(() => null);
    if (existing) return { version: existing, journal, already_committed: true, stats: null };
  }

  // Optimistic concurrency, re-checked at the moment of application: if another commit landed
  // after this one was prepared, the target is stale and applying it would silently overwrite
  // that work. Refusing here means a crashed-then-recovered commit is held to the same rule as
  // a live one.
  const project = await svc.entities.Project.get(journal.project_id).catch(() => null);
  if (!project) throw Object.assign(new Error("Project no longer exists"), { status: 404, code: "PROJECT_NOT_FOUND" });
  // D4: a crash after the project pointer advanced but before the journal was marked committed
  // leaves this run's version as the project's current one. Finish the journal, never conflict.
  const priorRunId = runId || journal.run_id;
  if (priorRunId && journal.status !== "prepared") {
    const prior = await svc.entities.ProjectVersion.filter({ project_id: journal.project_id, run_id: priorRunId }, { sort: "-number", limit: 1 }).then((p) => p.items?.[0] || null);
    if (prior && (project.version_count || 0) === prior.number) {
      const committed = await svc.entities.CommitJournal.update(journal.id, { status: "committed", version_id: prior.id, heartbeat_at: new Date().toISOString() });
      return { version: prior, journal: committed, already_committed: true, stats: null };
    }
  }
  if ((project.version_count || 0) !== (journal.base_version_number || 0)) {
    throw Object.assign(
      new Error(`Version conflict: this commit started from v${journal.base_version_number}, project is at v${project.version_count}`),
      { status: 409, code: "VERSION_CONFLICT" },
    );
  }

  const { target } = await journalSnapshots(journal);
  await svc.entities.CommitJournal.update(journal.id, { status: "applying", heartbeat_at: new Date().toISOString() });
  // The application can legitimately outlast the stale cutoff on a large project, so it
  // heartbeats the journal as it goes: recovery sees a live worker and leaves it alone.
  const stats = await applySnapshot(base44, journal.project_id, target, { heartbeat: beat });
  await svc.entities.CommitJournal.update(journal.id, { status: "applied", heartbeat_at: new Date().toISOString() });
  await beat();

  // Version creation is idempotent on the run: a crashed worker that already created the
  // version must never create a second one.
  const run_id = runId || journal.run_id;
  let version = null;
  if (journal.version_id) version = await svc.entities.ProjectVersion.get(journal.version_id).catch(() => null);
  if (!version) {
    const forRun = await svc.entities.ProjectVersion.filter({ project_id: journal.project_id, run_id }, { sort: "-number", limit: 1 }).then((p) => p.items || []);
    version = forRun[0] || null;
  }
  if (!version) {
    const latest = await svc.entities.ProjectVersion.filter({ project_id: journal.project_id }, { sort: "-number", limit: 1 }).then((p) => p.items || []);
    const parent = latest[0] || null;
    const number = journal.target_version_number || (parent ? parent.number : 0) + 1;
    const stored = await packSnapshot(svc, journal.project_id, target);
    version = await svc.entities.ProjectVersion.create({
      project_id: journal.project_id, number,
      parent_version_id: parent ? parent.id : undefined,
      run_id: run_id || undefined,
      message: journal.message, changed_files: journal.changed_files || [],
      ...stored,
    });
  }
  await beat();
  await svc.entities.Project.update(journal.project_id, { version_count: version.number, status: "ready", last_build_status: "success" });
  const committed = await svc.entities.CommitJournal.update(journal.id, { status: "committed", version_id: version.id, heartbeat_at: new Date().toISOString() });
  // PA-12: fail-safe — records/queues the automatic GitHub push; never fails the commit.
  await enqueueAutoPush(svc, journal.project_id, version);
  return { version, journal: committed, already_committed: false, stats };
}

/**
 * Undo an unfinished commit: restore the canonical state captured at prepare time and drop
 * any version this run may have started. Never touches a committed journal.
 */
export async function rollbackCommit(base44, journal, reason = "commit aborted") {
  const svc = svcOf(base44);
  if (journal.status === "committed") return { rolled_back: false, reason: "already committed" };
  const { previous } = await journalSnapshots(journal);
  // A rollback applies a snapshot too, so it heartbeats the journal for the same reason the
  // forward application does: a slow rollback must not be mistaken for an abandoned journal.
  const beat = () => svc.entities.CommitJournal.update(journal.id, { heartbeat_at: new Date().toISOString() }).catch(() => {});
  const stats = await applySnapshot(base44, journal.project_id, previous, { heartbeat: beat });
  // A commit that migrated the generated app's DATA (a version restore) also has to put those
  // records back, or the project would end up with the previous schema over migrated records —
  // the exact inconsistency the journal exists to prevent.
  // R-9/R-10 (provisional, PA-26): every required undo step is checked. A failed step is
  // reported, never treated as done.
  const undo_failures = [];
  const step = async (name, fn) => { try { return await fn(); } catch { undo_failures.push(name); return null; } };
  let data = null;
  if (journal.records_backup_url) {
    data = await step("app_data", async () => restoreAppData(base44, await unpackJson(journal.records_backup_url)));
  }
  // A version created by this run before the crash is removed, so version history stays a
  // truthful record of committed state only.
  const orphanVersions = (await step("orphan_versions_read", () => svc.entities.ProjectVersion.filter({ project_id: journal.project_id, run_id: journal.run_id }, { sort: "-number", limit: 5 }).then((p) => p.items || []))) || [];
  for (const v of orphanVersions) await step("orphan_version_delete", () => svc.entities.ProjectVersion.delete(v.id));
  await step("version_count", () => svc.entities.Project.update(journal.project_id, { version_count: journal.base_version_number || 0 }));
  if (undo_failures.length) {
    // Partial undo: the journal is left in the recoverable partial state ('applying'), so the
    // existing recovery sweep rolls it back again instead of rolling it forward.
    const failed = [...new Set(undo_failures)];
    await svc.entities.CommitJournal.update(journal.id, { status: "applying", error: `rollback incomplete (${failed.join(", ")}): ${String(reason).slice(0, 200)}` }).catch(() => {});
    return { rolled_back: false, partial: true, undo_failures: failed, stats, data };
  }
  const updated = await svc.entities.CommitJournal.update(journal.id, { status: "rolled_back", error: String(reason).slice(0, 300), heartbeat_at: new Date().toISOString() });
  return { rolled_back: true, stats, data, versions_removed: orphanVersions.length, journal: updated };
}

/**
 * Resolve a journal whose target was NEVER applied — used when the optimistic-concurrency
 * check at finalize time refuses the commit because another writer advanced the project
 * first. Nothing canonical was mutated, so no snapshot restore and no pointer writes
 * happen: the journal is simply marked rolled_back so the recovery sweep never re-resolves
 * it. This is the safe counterpart of rollbackCommit, which restores state for a commit
 * that DID (start to) apply.
 */
export async function abandonCommit(base44, journal, reason = "commit superseded") {
  const svc = svcOf(base44);
  const updated = await svc.entities.CommitJournal.update(journal.id, {
    status: "rolled_back", error: String(reason).slice(0, 300), heartbeat_at: new Date().toISOString(),
  });
  return { abandoned: true, journal: updated };
}

/**
 * Recovery sweep for commits whose worker disappeared. A journal is only touched once its
 * heartbeat is past the stale cutoff AND a fresh re-read still shows it stale in the same
 * state, so a live (even slow) application — which heartbeats from inside applySnapshot — is
 * never taken over; only a genuinely dead commit is rolled forward or back.
 */
export async function recoverPendingCommits(base44, { staleAfterMs = STALE_COMMIT_MS, now = Date.now(), limit = 50 } = {}) {
  const svc = svcOf(base44);
  const recovered = [];
  for (const status of ["prepared", "applying", "applied"]) {
    const rows = await svc.entities.CommitJournal.filter({ status }, { sort: "-created_date", limit }).then((p) => p.items || []).catch(() => []);
    for (const journal of rows) {
      const last = Date.parse(journal.heartbeat_at || journal.created_date);
      if (!Number.isFinite(last) || last > now - staleAfterMs) continue;
      // Active vs dead, re-checked under the row: between this sweep's read and its action a
      // worker may have resumed the journal (fresh heartbeat — a live application or rollback)
      // or another recovery may already have resolved it (status changed). Both are left
      // untouched; only a journal that is STILL stale in the SAME state is dead work.
      const fresh = await svc.entities.CommitJournal.get(journal.id).catch(() => null);
      if (!fresh) continue;
      if (fresh.status !== status) continue;
      const freshLast = Date.parse(fresh.heartbeat_at || fresh.created_date);
      if (Number.isFinite(freshLast) && freshLast > last) continue;
      await svc.entities.CommitJournal.update(journal.id, { recovery_count: (fresh.recovery_count || 0) + 1 }).catch(() => {});
      const project = await svc.entities.Project.get(journal.project_id).catch(() => null);
      if (!project) { await svc.entities.CommitJournal.update(journal.id, { status: "failed", error: "project no longer exists" }).catch(() => {}); continue; }

      // Canonical state already matches the target in full: the only missing step is the
      // version, so completing is the safe resolution and yields exactly one version.
      if (status === "applied") {
        const out = await finalizeCommit(base44, journal).catch((e) => ({ error: e.message }));
        recovered.push({ journal_id: journal.id, run_id: journal.run_id, was: status, action: out?.error ? "FAILED" : "ROLLED_FORWARD", version: out?.version?.number ?? null, error: out?.error || null });
        continue;
      }
      // Partial or not-yet-started canonical writes: restore the previous state.
      const out = await rollbackCommit(base44, journal, `worker lost during ${status}`).catch((e) => ({ error: e.message }));
      const partial = out?.partial === true;
      recovered.push({ journal_id: journal.id, run_id: journal.run_id, was: status, action: out?.error || partial ? "FAILED" : "ROLLED_BACK", error: out?.error || (partial ? `rollback incomplete: ${out.undo_failures.join(", ")}` : null) });
    }
  }
  return { recovered_count: recovered.length, recovered };
}