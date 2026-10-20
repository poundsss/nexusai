// Entity Trash control plane — parity from the completed Base44 audit.
//
// AUDITED CONTRACT (docs.base44.com api-reference, trash beta):
//   • list: `q` (JSON filter, the same operator set as the entity list), `limit` 1..10000
//     (omitted → EVERY matching deleted record in one response), `skip`, single-field `sort`
//     ('-' = descending), `fields` projection (comma-separated, dot paths, id always kept);
//     the response is the records array with `deleted_date` added; RLS does NOT apply.
//   • restore one: the record comes back keeping its ID and fields.
//   • restore matching: a filter body, `{}` restores EVERYTHING; response
//     { success: true, restored: n }; does not trigger webhooks.
//   • permanent delete: a separate explicit action; erases a record ALREADY IN TRASH only,
//     and it can't be restored afterwards.
// Unresolved in the audit, deliberately NOT approximated (UNKNOWN):
//   • automatic trash retention / purge after N days
//   • whether the single-record restore triggers webhooks (the bulk restore provably does
//     not) — no event is emitted on either restore path here
//   • a permanent-delete-ALL endpoint (the audit documents only the per-record one)
//
// The deployed app's runtime db gains NO trash operations: the audited trash surface is
// management-level (editor access), so only the builder-facing function below exposes it.

import { dbError, toItem } from "./appData.ts";
import { matches, sortItems } from "./appQuery.ts";
import { TRASH_PREFIX, trashName, moveToTrash, restoreFromTrash } from "./appTrash.ts";

const TRASH_LIMIT_MAX = 10000; // DOCUMENTED (list trash): limit from 1 to 10000
const STREAM_BATCH = 500;

// The DOCUMENTED trash view: the record with its fields, plus deleted_date.
const view = (r) => ({ ...toItem(r), deleted_date: r.trashed_at || null });

// fields projection (DOCUMENTED list param): comma-separated, dot paths into objects.
// id (and the trash's deleted_date) are always kept.
function projectFields(item, fields) {
  const wanted = String(fields || "").split(",").map((f) => f.trim()).filter(Boolean);
  if (!wanted.length) return item;
  const out = { id: item.id, deleted_date: item.deleted_date };
  for (const f of wanted) {
    const value = f.split(".").reduce((acc, k) => (acc == null || acc[k] === undefined ? undefined : acc[k]), item);
    if (value === undefined) continue;
    let cur = out;
    const parts = f.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

async function streamTrash(svc, projectId, entityName) {
  const out = [];
  let skip = 0;
  for (;;) {
    const rows = await svc.entities.AppRecord.filter({ project_id: projectId, entity_name: trashName(entityName) }, "created_date", STREAM_BATCH, skip);
    if (!rows.length) break;
    out.push(...rows);
    skip += rows.length;
    if (rows.length < STREAM_BATCH) break;
  }
  return out;
}

export async function entityTrashSurface(svc, input = {}) {
  const action = String(input.action || "");
  if (!["list", "delete", "restore", "restore_many", "permanent"].includes(action)) {
    throw dbError("DATABASE_INVALID_ACTION", `Unsupported trash action "${action}"`, { action });
  }
  const projectId = input.project_id;
  const entityName = String(input.entity_name || "");
  if (!entityName || entityName.startsWith(TRASH_PREFIX) || entityName === "__entity_events") {
    throw dbError("DATABASE_ENTITY_NOT_FOUND", `Unknown entity "${entityName}"`, { entity: entityName });
  }
  const notInTrash = (recordId) => dbError("DATABASE_RECORD_NOT_FOUND", `Record not found in ${entityName} trash`, { entity: entityName, record_id: String(recordId) });
  const loadTrashRow = async (recordId) => {
    const r = await svc.entities.AppRecord.get(recordId).catch(() => null);
    // Project mismatch, entity mismatch, a LIVE record or a record of another entity are all
    // uniformly "not found in trash" — existence never leaks across projects or entities.
    if (!r || r.project_id !== projectId || r.entity_name !== trashName(entityName)) throw notInTrash(recordId);
    return r;
  };

  // A live record must exist in THIS project + entity to be trashed through this surface.
  if (action === "delete") {
    const r = await svc.entities.AppRecord.get(input.record_id).catch(() => null);
    if (!r || r.project_id !== projectId || r.entity_name !== entityName) throw notInTrash(input.record_id);
    await moveToTrash(svc, r, { by: input.deleted_by || null });
    return { success: true };
  }

  if (action === "list") {
    let limit = null;
    if (input.limit != null) {
      limit = Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > TRASH_LIMIT_MAX) {
        throw dbError("DATABASE_INVALID_PAGING", `limit must be an integer from 1 to ${TRASH_LIMIT_MAX}, or omitted to get the whole trash in one response`, { limit: input.limit });
      }
    }
    const skip = Math.max(0, Number(input.skip) || 0);
    const rows = await streamTrash(svc, projectId, entityName);
    let items = rows.map(view);
    const q = input.query || {};
    if (Object.keys(q).length) items = items.filter((item) => matches(item, q));
    items = sortItems(items, input.sort || "-created_date");
    if (skip) items = items.slice(skip);
    if (limit != null) items = items.slice(0, limit);
    return items.map((item) => projectFields(item, input.fields));
  }

  if (action === "restore") {
    const r = await loadTrashRow(input.record_id);
    await restoreFromTrash(svc, r, entityName);
    // The restored record has its original id and fields — and no deleted_date.
    return toItem({ ...r, entity_name: entityName });
  }

  if (action === "restore_many") {
    const rows = await streamTrash(svc, projectId, entityName);
    const q = input.query || {};
    const targets = Object.keys(q).length ? rows.filter((r) => matches(view(r), q)) : rows;
    for (const r of targets) await restoreFromTrash(svc, r, entityName);
    // DOCUMENTED: { success: true, restored: n }; no webhooks are triggered.
    return { success: true, restored: targets.length };
  }

  // permanent: erases a record ALREADY IN TRASH for good — the explicit separate action.
  const r = await loadTrashRow(input.record_id);
  await svc.entities.AppRecord.delete(r.id);
  return { success: true };
}