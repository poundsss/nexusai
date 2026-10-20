// Data Version History / Backup & Restore — parity from the completed Base44 audit.
//
// AUDITED CONTRACT (docs.base44.com: Enterprise/data-version-history + the api-reference
// data-version endpoints) — the behavior target, implemented here:
//   • info     GET /entities/versions/info → { state: enabled | needs_upgrade | unavailable,
//              retention_days|null, history_available_since|null }
//   • list     GET /entities/versions/checkpoints → { items: [{ checkpoint_id, data_as_of,
//              entity_name, trigger_type }], next_cursor } — cursor pagination, limit default
//              50 (larger treated as 200), entity_name[] (≤200), from/to (ISO; `to` exclusive),
//              newest first. Unknown entity names match nothing rather than failing.
//   • download .../checkpoints/{checkpoint_id}/snapshot → { fields, records } — fields are the
//              entity's declared fields then the record built-ins; records exactly as stored.
//   • restore  POST .../checkpoints/{checkpoint_id}/restore { entity_names: 1..300 } → 202
//              { batch_id, launched: [{ entity_name, operation_id }], skipped_entities } —
//              an entity another restore is already running on is SKIPPED, never queued twice.
//   • status   GET .../restores/batch/{batch_id} → { operations: [{ counts: { deleted,
//              reinserted, reverted }, entity_name, operation_id, pre_restore_checkpoint_id,
//              status }], restore_to, undo_checkpoint_id|null } — operations EMPTY for an
//              unknown batch id (existence of a foreign batch never leaks).
//   • Retention: Elite 7 days, Enterprise 30 days; backups are AUTOMATIC (trigger_type crud) —
//     no manual data-checkpoint creation exists in the contract and none is added.
//   • Restore semantics: record IDs preserved; field values restored exactly; fields removed
//     from the current schema are NOT restored; records added after the point go to Entity
//     Trash (never a hard delete); User records and media are outside data history; editing
//     of a restoring entity is paused until the restore finishes.
//
// NEXUSAI-derived / NON-PARITY (bounded, fail-closed — the contract does not pin these):
//   • capture deduplicates to at most ONE checkpoint per entity per second (a write burst
//     snapshots once; the next capture covers the remainder);
//   • a record PERMANENTLY purged from trash after the checkpoint cannot come back under its
//     original id (the platform mints ids) — it is re-created with a NEW id; trash-routed
//     deletes preserve the id through the trash rename;
//   • error codes are DATA_HISTORY_* / DATABASE_RESTORE_PAUSED (this platform's structured
//     error shape; the upstream HTTP codes for these refusals are UNKNOWN);
//   • a running operation with no progress for RESTORE_STALE_MS no longer pauses edits and is
//     healed (failed) by the next status/restore call — its worker's bounded retries have
//     dead-lettered;
//   • `unavailable` (data in the workspace's own database) is not derivable here and is never
//     returned; history_available_since is always null (retention alone bounds how far back);
//   • the restore executor is idempotent: a retried batch converges (re-running a restore
//     re-derives the same target state and never duplicates work).
import { effectivePlan } from "./planLimits.ts";
import { packJson, unpackJson } from "./blobStore.ts";
import { TRASH_PREFIX, trashName, moveToTrash, restoreFromTrash } from "./appTrash.ts";
import { mintPageCursor, verifyPageCursor } from "./appCursor.ts";
import { enqueue } from "./jobQueue.ts";

const svcOf = (base44) => base44.asServiceRole || base44;

export const DATA_VERSION_ACTIONS = ["info", "list", "download", "restore", "status", "undo"];

const HISTORY_CURSOR_SCOPE = "__data_checkpoints";
const RESTORE_STALE_MS = 15 * 60 * 1000;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;      // DOCUMENTED: larger values are treated as 200
const ENTITY_NAMES_MAX = 300;    // DOCUMENTED: 1 to 300 entity names per restore
const ENTITY_FILTER_MAX = 200;   // DOCUMENTED: at most 200 entity_name list params
const CAPTURE_DEDUPE_MS = 1000;
const STREAM_BATCH = 500;

const fail = (code, message, status = 400) =>
  Object.assign(new Error(message), { name: "DatabaseError", code, status });

// Deterministic JSON (sorted keys) — used only for cursor-mismatch and value comparisons.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

// User records and reserved namespaces are outside data history (DOCUMENTED exclusions).
export function isHistoryEligibleEntity(name) {
  const n = String(name || "");
  return !!n && n !== "User" && !n.startsWith(TRASH_PREFIX) && !n.startsWith("__");
}

// DOCUMENTED retention: Elite keeps 7 days, Enterprise 30; every other plan has no history
// (the versions/info state is then needs_upgrade).
export function historyRetentionDays(plan) {
  if (!plan) return null;
  if (plan.code === "enterprise") return 30;
  if (Number(plan.tier_rank) >= 20) return 7; // Elite (the scale_* tiers), the documented 7-day tier
  return null;
}

// DOCUMENTED versions/info. `history_available_since` is null whenever retention_days alone
// bounds how far back (the only case here).
export async function historyState(svc, workspaceId) {
  const { plan } = await effectivePlan(svc, workspaceId);
  const retention = historyRetentionDays(plan);
  return retention == null
    ? { state: "needs_upgrade", retention_days: null, history_available_since: null }
    : { state: "enabled", retention_days: retention, history_available_since: null };
}

export async function streamLiveRecords(svc, projectId, entityName) {
  const out = [];
  let skip = 0;
  for (;;) {
    const rows = await svc.entities.AppRecord.filter({ project_id: projectId, entity_name: entityName }, "created_date", STREAM_BATCH, skip);
    if (!rows.length) break;
    out.push(...rows);
    skip += rows.length;
    if (rows.length < STREAM_BATCH) break;
  }
  return out;
}

async function currentDeclaredFields(svc, projectId, entityName) {
  const ent = (await svc.entities.AppEntity.filter({ project_id: projectId, name: entityName }, "name", 1).catch(() => []))[0] || null;
  return ent ? Object.keys(ent.fields || {}) : [];
}

// --- automatic capture ---------------------------------------------------------

// One capture per (project, entity) per burst window — a write burst produces one checkpoint.
// The timestamp is stamped AFTER a capture completes and an in-flight capture is awaited
// (never doubled), so even a slow capture cannot split one burst into two checkpoints.
const lastCaptureDone = new Map(); // `${projectId}:${entityName}` → epoch ms of the last completed capture
const captureInFlight = new Map(); // `${projectId}:${entityName}` → promise of the capture running now

export async function captureCheckpoint(svc, projectId, workspaceId, entityName) {
  if (!isHistoryEligibleEntity(entityName)) return null;
  try {
    const { plan } = await effectivePlan(svc, workspaceId);
    const retention = historyRetentionDays(plan);
    if (retention == null) return null;
    const records = (await streamLiveRecords(svc, projectId, entityName)).map((r) => ({
      id: r.id, created_date: r.created_date, updated_date: r.updated_date,
      created_by_id: r.created_by_id || null, owner_id: r.owner_id || null, data: r.data || {},
    }));
    const fields = await currentDeclaredFields(svc, projectId, entityName);
    const snapshot_url = await packJson(svc, `data_checkpoint_${projectId}_${entityName}_${Date.now()}.json`, { records, fields });
    const row = await svc.entities.DataCheckpoint.create({
      project_id: projectId, workspace_id: workspaceId, entity_name: entityName,
      data_as_of: new Date().toISOString(), trigger_type: "crud",
      record_count: records.length, fields, snapshot_url,
    });
    // Retention enforcement at the point of capture: everything past the plan's window goes.
    const cutoff = new Date(Date.now() - retention * 86400000).toISOString();
    await svc.entities.DataCheckpoint.deleteMany({ project_id: projectId, entity_name: entityName, data_as_of: { $lt: cutoff } }).catch(() => {});
    return row;
  } catch {
    return null; // fail-safe: the write already succeeded; a failed backup never breaks it
  }
}

// The write-path hook, called after a successful data write (from the appData event emission —
// the one choke point every per-record write passes). Fully fail-safe.
export async function captureAfterWrite(client, projectId, entityName) {
  if (!isHistoryEligibleEntity(entityName)) return;
  const key = `${projectId}:${entityName}`;
  const pending = captureInFlight.get(key);
  if (pending) { try { await pending; } catch { /* fail-safe */ } return; }
  if (Date.now() - (lastCaptureDone.get(key) || 0) < CAPTURE_DEDUPE_MS) return;
  const run = (async () => {
    const svc = svcOf(client);
    const project = await svc.entities.Project.get(projectId).catch(() => null);
    if (!project) return;
    await captureCheckpoint(svc, projectId, project.workspace_id, entityName);
    lastCaptureDone.set(key, Date.now());
  })();
  captureInFlight.set(key, run);
  try { await run; } catch { /* fail-safe: the write already succeeded */ }
  finally { if (captureInFlight.get(key) === run) captureInFlight.delete(key); }
}

// --- the edit pause ------------------------------------------------------------

const isStaleOp = (op) => Date.now() - new Date(op.updated_date || op.created_date || 0).getTime() > RESTORE_STALE_MS;

// Editing pauses while a restore is running on the entity (DOCUMENTED: "Editing pauses while a
// restore runs"). The running-operation query is cached briefly (a long-lived storage instance
// must still notice a restore launched mid-flight); a stale operation never pauses (its worker
// dead-lettered — healed by the next status/restore call).
export function historyWriteGuard(svc, projectId) {
  const PAUSE_CACHE_MS = 1500;
  let runningPromise = null;
  let cachedAt = 0;
  const runningOps = () => {
    const now = Date.now();
    if (!runningPromise || now - cachedAt > PAUSE_CACHE_MS) {
      runningPromise = svc.entities.DataRestoreOperation.filter({ project_id: projectId, status: "running" }, "created_date", 200).catch(() => []);
      cachedAt = now;
    }
    return runningPromise;
  };
  return {
    assertWritable: async (entityName) => {
      if (!isHistoryEligibleEntity(entityName)) return;
      const ops = await runningOps();
      if (ops.some((o) => o.entity_name === entityName && !isStaleOp(o))) {
        throw fail("DATABASE_RESTORE_PAUSED", `Editing ${entityName} is paused while a data restore is running`, 409);
      }
    },
  };
}

// --- list (cursor pagination) --------------------------------------------------

const isoOrThrow = (v) => {
  let s = String(v || "");
  if (!s.trim()) throw fail("DATA_HISTORY_INVALID", "from/to must be an ISO 8601 timestamp");
  // DOCUMENTED: a timestamp with no offset is read as UTC.
  if (/T/.test(s) && !/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += "Z";
  const d = new Date(s);
  if (isNaN(d.getTime())) throw fail("DATA_HISTORY_INVALID", "from/to must be an ISO 8601 timestamp");
  return d.toISOString();
};

export async function listCheckpoints(svc, projectId, { entity_names = null, from = null, to = null, limit = LIST_LIMIT_DEFAULT, cursor = null } = {}) {
  let names = entity_names == null ? [] : (Array.isArray(entity_names) ? entity_names : [entity_names]).map((n) => String(n));
  if (names.length > ENTITY_FILTER_MAX) throw fail("DATA_HISTORY_INVALID", `entity_names accepts at most ${ENTITY_FILTER_MAX} names`);
  const filters = { entity_names: names, from: from != null ? isoOrThrow(from) : null, to: to != null ? isoOrThrow(to) : null };
  const q = { project_id: projectId };
  // DOCUMENTED: a name the app has no entity for matches nothing rather than failing.
  if (names.length) q.entity_name = { $in: names };
  if (filters.from) q.data_as_of = { ...(q.data_as_of || {}), $gte: filters.from };
  if (filters.to) q.data_as_of = { ...(q.data_as_of || {}), $lt: filters.to }; // DOCUMENTED: `to` is exclusive
  let offset = 0;
  if (cursor) {
    const state = await verifyPageCursor(cursor, { projectId, entity: HISTORY_CURSOR_SCOPE });
    if (stableStringify(state.q) !== stableStringify(filters)) {
      throw fail("DATA_HISTORY_CURSOR_MISMATCH", "cursor does not match this request's filters");
    }
    offset = state.offset;
  }
  const want = Math.min(Math.max(Number(limit) || LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
  const fetched = await svc.entities.DataCheckpoint.filter(q, "-data_as_of", want + 1, offset).catch(() => []);
  const items = fetched.slice(0, want).map((c) => ({
    checkpoint_id: c.id, data_as_of: c.data_as_of, entity_name: c.entity_name, trigger_type: c.trigger_type,
  }));
  const next_cursor = fetched.length > want
    ? await mintPageCursor({ projectId, entity: HISTORY_CURSOR_SCOPE, q: filters, offset: offset + want })
    : null;
  return { items, next_cursor };
}

// --- download ------------------------------------------------------------------

async function loadCheckpoint(svc, projectId, entityName, checkpointId) {
  const cp = await svc.entities.DataCheckpoint.get(String(checkpointId || "")).catch(() => null);
  // Another project's checkpoint is indistinguishable from one that never existed.
  if (!cp || cp.project_id !== projectId || (entityName != null && cp.entity_name !== entityName)) {
    throw fail("DATA_HISTORY_CHECKPOINT_NOT_FOUND", "Checkpoint not found", 404);
  }
  return cp;
}

export async function downloadCheckpoint(svc, projectId, entityName, checkpointId) {
  const cp = await loadCheckpoint(svc, projectId, entityName, checkpointId);
  const snap = await unpackJson(cp.snapshot_url).catch(() => ({ records: [], fields: [] }));
  // DOCUMENTED: the entity's declared fields, then the built-ins Base44 adds to every record.
  const fields = [...(cp.fields || []), "id", "created_date", "updated_date", "created_by_id"];
  const records = (snap.records || []).map((r) => {
    const out = {};
    for (const f of fields) {
      const v = f === "id" ? r.id : f === "created_date" ? r.created_date : f === "updated_date" ? r.updated_date
        : f === "created_by_id" ? r.created_by_id : (r.data || {})[f];
      if (v !== undefined) out[f] = v;
    }
    return out;
  });
  return { fields, records };
}

// --- restore -------------------------------------------------------------------

function sanitizeRestoreEntities(raw) {
  if (!Array.isArray(raw)) throw fail("DATA_HISTORY_INVALID", "entity_names must be an array of 1 to 300 entity names");
  const names = [...new Set(raw.map((n) => String(n)))];
  if (!names.length || names.length > ENTITY_NAMES_MAX) {
    throw fail("DATA_HISTORY_INVALID", `entity_names accepts between 1 and ${ENTITY_NAMES_MAX} names`);
  }
  for (const n of names) {
    if (n === "User") throw fail("DATA_HISTORY_ENTITY_EXCLUDED", "User records are outside data history");
    if (!isHistoryEligibleEntity(n)) throw fail("DATA_HISTORY_ENTITY_EXCLUDED", `"${n}" is not a history-eligible entity`);
  }
  return names;
}

// Heals operations whose worker is gone (stale RUNNING) — they stop pausing edits.
export async function healStale(svc, projectId) {
  const ops = await svc.entities.DataRestoreOperation.filter({ project_id: projectId, status: "running" }, "created_date", 200).catch(() => []);
  const stale = ops.filter(isStaleOp);
  for (const op of stale) {
    await svc.entities.DataRestoreOperation.update(op.id, { status: "failed", error: "restore worker lost; healed on the next status call", completed_at: new Date().toISOString() }).catch(() => {});
  }
  for (const id of new Set(stale.map((o) => o.batch_id))) {
    const batch = await svc.entities.DataRestoreBatch.get(id).catch(() => null);
    if (batch && batch.status === "running") {
      await svc.entities.DataRestoreBatch.update(id, { status: "failed", error: "restore worker lost", completed_at: new Date().toISOString() }).catch(() => {});
    }
  }
  return stale.length;
}

// Launches a restore: validates, skips busy entities, persists the batch + operations and
// hands execution to the existing job queue. The 202 body is returned before any data moves.
export async function startRestore(svc, { project, user = null, checkpoint_id, entity_names }) {
  const projectId = project.id, workspaceId = project.workspace_id;
  const names = sanitizeRestoreEntities(entity_names);
  const cp = await loadCheckpoint(svc, projectId, null, checkpoint_id);
  await healStale(svc, projectId);
  const running = await svc.entities.DataRestoreOperation.filter({ project_id: projectId, status: "running" }, "created_date", 500).catch(() => []);
  const busy = new Set(running.filter((o) => !isStaleOp(o)).map((o) => o.entity_name));
  const launchedNames = names.filter((n) => !busy.has(n));
  const skipped = names.filter((n) => busy.has(n));
  const batch = await svc.entities.DataRestoreBatch.create({
    project_id: projectId, workspace_id: workspaceId,
    checkpoint_id: cp.id, restore_to: cp.data_as_of,
    entity_names: launchedNames, status: launchedNames.length ? "running" : "succeeded",
    undo_checkpoint_id: null, error: null, created_by: user?.id || null,
    ...(launchedNames.length ? {} : { completed_at: new Date().toISOString() }),
  });
  const launched = [];
  for (const name of launchedNames) {
    const op = await svc.entities.DataRestoreOperation.create({
      project_id: projectId, workspace_id: workspaceId, batch_id: batch.id,
      entity_name: name, checkpoint_id: cp.id, pre_restore_checkpoint_id: null,
      status: "running", counts: { deleted: 0, reinserted: 0, reverted: 0 }, error: null,
    });
    launched.push({ entity_name: name, operation_id: op.id });
  }
  if (launched.length) {
    await enqueue(svc, {
      queue: "default", job_type: "data.restore_batch", payload: { batch_id: batch.id },
      idempotency_key: `data.restore_batch:${batch.id}`, workspace_id: workspaceId, project_id: projectId,
    });
  }
  return { batch_id: batch.id, launched, skipped_entities: skipped };
}

// One entity's restore, exactly per the documented semantics.
async function applyRestore(svc, projectId, entityName, checkpointId) {
  const cp = await loadCheckpoint(svc, projectId, entityName, checkpointId);
  const snap = await unpackJson(cp.snapshot_url).catch(() => null);
  const snapRecords = (snap && snap.records) || [];
  const declared = new Set(await currentDeclaredFields(svc, projectId, entityName));
  const live = await streamLiveRecords(svc, projectId, entityName);
  const liveById = new Map(live.map((r) => [r.id, r]));
  const snapIds = new Set(snapRecords.map((r) => r.id));
  let deleted = 0, reinserted = 0, reverted = 0;
  // Records added after the point go to Entity Trash — never a hard delete (DOCUMENTED).
  for (const r of live) {
    if (snapIds.has(r.id)) continue;
    await moveToTrash(svc, r, { by: "data_restore" });
    deleted++;
  }
  for (const r of snapRecords) {
    const current = liveById.get(r.id);
    if (current) {
      // Fields removed from the current schema are NOT restored (DOCUMENTED); declared fields
      // the snapshot holds come back to their exact checkpoint values, in place — same id.
      const target = {};
      for (const [f, v] of Object.entries(r.data || {})) if (declared.has(f)) target[f] = v;
      const merged = { ...(current.data || {}), ...target };
      if (stableStringify(merged) !== stableStringify(current.data || {})) {
        await svc.entities.AppRecord.update(current.id, { data: merged });
        reverted++;
      }
    } else {
      const trashed = await svc.entities.AppRecord.get(r.id).catch(() => null);
      if (trashed && trashed.project_id === projectId && trashed.entity_name === trashName(entityName)) {
        // Deleted after the point and recoverable from the trash: the id comes back verbatim.
        await restoreFromTrash(svc, trashed, entityName);
      } else {
        // Permanently purged: the platform mints ids, so the record returns with a NEW id
        // (the one known id-preservation gap; see the module notes).
        await svc.entities.AppRecord.create({
          project_id: projectId, entity_name: entityName,
          ...(r.owner_id ? { owner_id: r.owner_id } : {}), data: r.data || {},
        });
      }
      reinserted++;
    }
  }
  return { deleted, reinserted, reverted };
}

// The queued executor (job type data.restore_batch). Idempotent: a retry converges.
export async function executeRestoreBatch(svc, batchId) {
  const batch = await svc.entities.DataRestoreBatch.get(String(batchId || "")).catch(() => null);
  if (!batch || batch.status !== "running") return { executed: false };
  const ops = await svc.entities.DataRestoreOperation.filter({ batch_id: batch.id }, "created_date", 300).catch(() => []);
  let succeeded = 0, failed = 0;
  let undoId = batch.undo_checkpoint_id || null;
  for (const op of ops) {
    if (op.status === "succeeded") { succeeded++; undoId = undoId || op.pre_restore_checkpoint_id; continue; }
    if (op.status === "failed") { failed++; continue; }
    try {
      // The pre-restore checkpoint is captured BEFORE this operation's first write — the
      // documented per-operation undo source. A retry keeps the FIRST one.
      if (!op.pre_restore_checkpoint_id) {
        const pre = await captureCheckpoint(svc, batch.project_id, batch.workspace_id, op.entity_name);
        if (pre) {
          op.pre_restore_checkpoint_id = pre.id;
          await svc.entities.DataRestoreOperation.update(op.id, { pre_restore_checkpoint_id: pre.id });
        }
      }
      const counts = await applyRestore(svc, batch.project_id, op.entity_name, op.checkpoint_id);
      await svc.entities.DataRestoreOperation.update(op.id, { status: "succeeded", counts, completed_at: new Date().toISOString() });
      undoId = undoId || op.pre_restore_checkpoint_id || null;
      succeeded++;
    } catch (error) {
      await svc.entities.DataRestoreOperation.update(op.id, {
        status: "failed", error: String(error.message || error).slice(0, 500), completed_at: new Date().toISOString(),
      }).catch(() => {});
      failed++;
    }
  }
  const finalStatus = failed ? (succeeded ? "partial" : "failed") : "succeeded";
  await svc.entities.DataRestoreBatch.update(batch.id, {
    status: finalStatus, undo_checkpoint_id: undoId, completed_at: new Date().toISOString(),
    ...(failed ? { error: `${failed} of ${ops.length} entity restore(s) failed` } : {}),
  }).catch(() => {});
  return { executed: true, status: finalStatus };
}

// DOCUMENTED status surface: operations empty for an unknown batch id — a foreign restore's
// existence never leaks.
export async function restoreStatus(svc, projectId, batchId) {
  await healStale(svc, projectId);
  const batch = await svc.entities.DataRestoreBatch.get(String(batchId || "")).catch(() => null);
  if (!batch || batch.project_id !== projectId) {
    return { operations: [], restore_to: null, undo_checkpoint_id: null };
  }
  const ops = await svc.entities.DataRestoreOperation.filter({ batch_id: batch.id }, "created_date", 300).catch(() => []);
  return {
    operations: ops.map((o) => ({
      counts: o.counts || { deleted: 0, reinserted: 0, reverted: 0 },
      entity_name: o.entity_name,
      operation_id: o.id,
      pre_restore_checkpoint_id: o.pre_restore_checkpoint_id || null,
      status: o.status,
    })),
    restore_to: batch.restore_to || null,
    undo_checkpoint_id: batch.undo_checkpoint_id || null,
  };
}

// Undo: re-restores every entity of a finished batch from ITS OWN pre-restore checkpoint, so
// the whole restore is put back the way it was (DOCUMENTED: a restore is reversible; records
// added since go to trash). Same skip rule as a restore.
export async function undoRestore(svc, { project, user = null, batch_id }) {
  const projectId = project.id;
  const batch = await svc.entities.DataRestoreBatch.get(String(batch_id || "")).catch(() => null);
  if (!batch || batch.project_id !== projectId) throw fail("DATA_HISTORY_BATCH_NOT_FOUND", "Restore not found", 404);
  if (batch.status === "running") throw fail("DATA_HISTORY_RESTORE_RUNNING", "This restore is still running", 409);
  await healStale(svc, projectId);
  const ops = (await svc.entities.DataRestoreOperation.filter({ batch_id: batch.id }, "created_date", 300).catch(() => []))
    .filter((o) => o.pre_restore_checkpoint_id);
  if (!ops.length) throw fail("DATA_HISTORY_UNDO_UNAVAILABLE", "This restore has no undo checkpoint to restore from", 409);
  const running = await svc.entities.DataRestoreOperation.filter({ project_id: projectId, status: "running" }, "created_date", 500).catch(() => []);
  const busy = new Set(running.filter((o) => !isStaleOp(o)).map((o) => o.entity_name));
  const launchedNames = ops.map((o) => o.entity_name).filter((n) => !busy.has(n));
  const skipped = ops.map((o) => o.entity_name).filter((n) => busy.has(n));
  if (!launchedNames.length) {
    return { batch_id: null, launched: [], skipped_entities: skipped };
  }
  const first = ops.find((o) => o.entity_name === launchedNames[0]);
  const firstCp = await svc.entities.DataCheckpoint.get(first.pre_restore_checkpoint_id).catch(() => null);
  const newBatch = await svc.entities.DataRestoreBatch.create({
    project_id: projectId, workspace_id: batch.workspace_id,
    checkpoint_id: first.pre_restore_checkpoint_id,
    restore_to: firstCp?.data_as_of || batch.restore_to,
    entity_names: launchedNames, status: "running",
    undo_checkpoint_id: null, error: null, created_by: user?.id ? `undo:${user.id}` : "undo",
  });
  const launched = [];
  for (const op of ops) {
    if (!launchedNames.includes(op.entity_name)) continue;
    const row = await svc.entities.DataRestoreOperation.create({
      project_id: projectId, workspace_id: batch.workspace_id, batch_id: newBatch.id,
      entity_name: op.entity_name, checkpoint_id: op.pre_restore_checkpoint_id,
      pre_restore_checkpoint_id: null, status: "running",
      counts: { deleted: 0, reinserted: 0, reverted: 0 }, error: null,
    });
    launched.push({ entity_name: op.entity_name, operation_id: row.id });
  }
  await enqueue(svc, {
    queue: "default", job_type: "data.restore_batch", payload: { batch_id: newBatch.id },
    idempotency_key: `data.restore_batch:${newBatch.id}`, workspace_id: batch.workspace_id, project_id: projectId,
  });
  return { batch_id: newBatch.id, launched, skipped_entities: skipped };
}

// --- the control-plane surface -------------------------------------------------

export async function dataVersionsSurface(svc, input = {}) {
  const action = String(input.action || "");
  if (!DATA_VERSION_ACTIONS.includes(action)) throw fail("DATA_HISTORY_ACTION_UNKNOWN", `Unsupported action "${action}"`);
  const projectId = input.project_id;
  if (!projectId) throw fail("DATA_HISTORY_INVALID", "project_id is required");
  if (action === "info") return historyState(svc, input.workspace_id);
  if (action === "list") {
    return listCheckpoints(svc, projectId, {
      entity_names: input.entity_names, from: input.from, to: input.to, limit: input.limit, cursor: input.cursor,
    });
  }
  if (action === "download") {
    const entityName = String(input.entity_name || "");
    if (!entityName) throw fail("DATA_HISTORY_INVALID", "entity_name is required");
    return downloadCheckpoint(svc, projectId, entityName, input.checkpoint_id);
  }
  if (action === "restore") {
    return startRestore(svc, {
      project: { id: projectId, workspace_id: input.workspace_id },
      user: input.user || null, checkpoint_id: input.checkpoint_id, entity_names: input.entity_names,
    });
  }
  if (action === "status") return restoreStatus(svc, projectId, input.batch_id);
  return undoRestore(svc, {
    project: { id: projectId, workspace_id: input.workspace_id },
    user: input.user || null, batch_id: input.batch_id,
  });
}