// Entity Trash storage model (parity from the completed Base44 audit: delete is recoverable).
//
// A trashed record's AppRecord row is RENAMED entity_name → "TRASH:<entity>" and stamped.
// The row never leaves storage, so id, created_date, updated_date and the data payload are
// preserved verbatim (the audited restore guarantee: the record KEEPS ITS ID and fields), and
// every live query path — which filters on exact entity_name — excludes it with zero changes
// to the query machine. Restore renames back; permanent delete removes the row.
export const TRASH_PREFIX = "TRASH:";
export const trashName = (entity) => `${TRASH_PREFIX}${entity}`;

// Deletion stamp. updated_date: any storage write bumps it (platform behavior — the trash
// marker is a write); the trash listing's `deleted_date` carries the real deletion time.
export async function moveToTrash(client, record, { by = null } = {}) {
  await client.entities.AppRecord.update(record.id, {
    entity_name: trashName(record.entity_name),
    trashed_at: new Date().toISOString(),
    ...(by ? { trashed_by: by } : {}),
  });
}

// Restore: rename back and clear the stamps. The record keeps its ORIGINAL id and fields.
export async function restoreFromTrash(client, record, entityName) {
  await client.entities.AppRecord.update(record.id, { entity_name: entityName, trashed_at: null, trashed_by: null });
}