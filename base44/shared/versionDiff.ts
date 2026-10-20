// Version-to-version diff.
//
// A ProjectVersion is an immutable snapshot of canonical state, so a diff is a pure READ: both
// versions are loaded, their snapshots are hydrated out of storage and compared in memory. Nothing
// here writes to a version, a project file, an entity or the project pointer — which is what keeps
// the existing restore path the only way canonical state ever moves.
//
// ISOLATION: both versions must belong to the project the caller was already authorized against.
// A version id from another project is refused rather than silently diffed, so the diff can never
// become a read channel into another workspace's code.
//
// BOUNDING: a real project's snapshot is far larger than any response should be, so the changed
// file list is paginated and file CONTENT is only returned for explicitly requested paths, each
// truncated to a fixed ceiling. The unchanged set is reported as a count, never enumerated.
import { unpackSnapshot } from "./blobStore.ts";

export const DIFF_LIMITS = {
  files_per_page: 100,   // changed-file entries per response
  max_paths: 3,          // paths whose full before/after content may be inlined
  max_content: 40000,    // characters per inlined side
};

const svcOf = (base44) => base44.asServiceRole || base44;
const lines = (text) => (text === "" ? 0 : String(text).split("\n").length);
const bytes = (text) => String(text ?? "").length;

async function loadVersion(base44, project, versionId, label) {
  if (!versionId) throw Object.assign(new Error(`${label} version id is required`), { status: 400, code: "INVALID_INPUT" });
  const version = await svcOf(base44).entities.ProjectVersion.get(versionId).catch(() => null);
  if (!version) throw Object.assign(new Error(`${label} version not found`), { status: 404, code: "VERSION_NOT_FOUND" });
  // The authorization the caller passed was for THIS project; a version belonging to another one
  // is a cross-project read attempt, not a missing record.
  if (version.project_id !== project.id) {
    throw Object.assign(new Error("That version belongs to a different project"), { status: 403, code: "CROSS_PROJECT_VERSION" });
  }
  return version;
}

// Line-level change counts, computed without building a full LCS: enough for a Builder list row,
// cheap enough for a snapshot with hundreds of files.
function lineDelta(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const counts = new Map();
  for (const l of a) counts.set(l, (counts.get(l) || 0) + 1);
  let common = 0;
  for (const l of b) {
    const n = counts.get(l) || 0;
    if (n > 0) { counts.set(l, n - 1); common++; }
  }
  return { lines_added: b.length - common, lines_removed: a.length - common };
}

function diffFields(beforeFields = {}, afterFields = {}) {
  const added = [], removed = [], changed = [];
  for (const [name, def] of Object.entries(afterFields)) {
    if (!(name in beforeFields)) { added.push(name); continue; }
    if (JSON.stringify(beforeFields[name]) !== JSON.stringify(def)) {
      changed.push({ field: name, before: beforeFields[name], after: def });
    }
  }
  for (const name of Object.keys(beforeFields)) if (!(name in afterFields)) removed.push(name);
  return { added, removed, changed };
}

const versionRef = (v) => ({
  id: v.id, number: v.number, message: v.message || "", created_date: v.created_date,
  run_id: v.run_id || null, restored_from_version_id: v.restored_from_version_id || null,
});

/**
 * Compares two immutable versions of ONE project and returns a structured, bounded diff.
 *
 * `project` is the already-authorized project record — this function performs no authorization of
 * its own, it enforces that both versions belong to that project.
 */
export async function diffVersions(base44, { project, from_version_id, to_version_id, offset = 0, limit = DIFF_LIMITS.files_per_page, paths = [] }) {
  const [from, to] = await Promise.all([
    loadVersion(base44, project, from_version_id, "Base"),
    loadVersion(base44, project, to_version_id, "Target"),
  ]);

  // Read-only hydration of both snapshots. `unpackSnapshot` never writes.
  const [fromSnap, toSnap] = await Promise.all([unpackSnapshot(from), unpackSnapshot(to)]);
  const beforeFiles = new Map((fromSnap.files || []).map((f) => [f.path, String(f.content ?? "")]));
  const afterFiles = new Map((toSnap.files || []).map((f) => [f.path, String(f.content ?? "")]));

  const changed = [];
  let unchanged = 0;
  for (const [path, after] of afterFiles) {
    if (!beforeFiles.has(path)) {
      changed.push({ path, change: "added", before_bytes: 0, after_bytes: bytes(after), before_lines: 0, after_lines: lines(after), lines_added: lines(after), lines_removed: 0 });
      continue;
    }
    const before = beforeFiles.get(path);
    if (before === after) { unchanged++; continue; }
    changed.push({ path, change: "modified", before_bytes: bytes(before), after_bytes: bytes(after), before_lines: lines(before), after_lines: lines(after), ...lineDelta(before, after) });
  }
  for (const [path, before] of beforeFiles) {
    if (afterFiles.has(path)) continue;
    changed.push({ path, change: "removed", before_bytes: bytes(before), after_bytes: 0, before_lines: lines(before), after_lines: 0, lines_added: 0, lines_removed: lines(before) });
  }
  changed.sort((a, b) => a.path.localeCompare(b.path));

  const counts = {
    added: changed.filter((c) => c.change === "added").length,
    removed: changed.filter((c) => c.change === "removed").length,
    modified: changed.filter((c) => c.change === "modified").length,
    unchanged,
    total_changed: changed.length,
    total_files_before: beforeFiles.size,
    total_files_after: afterFiles.size,
  };

  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.min(Math.max(1, Number(limit) || DIFF_LIMITS.files_per_page), DIFF_LIMITS.files_per_page);
  const page = changed.slice(safeOffset, safeOffset + safeLimit);

  // Entity / schema changes, field-level.
  const beforeEntities = new Map((fromSnap.entities || []).map((e) => [e.name, e.fields || {}]));
  const afterEntities = new Map((toSnap.entities || []).map((e) => [e.name, e.fields || {}]));
  const entities = { added: [], removed: [], modified: [], unchanged: 0 };
  for (const [name, fields] of afterEntities) {
    if (!beforeEntities.has(name)) { entities.added.push({ name, fields: Object.keys(fields) }); continue; }
    const d = diffFields(beforeEntities.get(name), fields);
    if (!d.added.length && !d.removed.length && !d.changed.length) { entities.unchanged++; continue; }
    entities.modified.push({ name, fields_added: d.added, fields_removed: d.removed, fields_changed: d.changed });
  }
  for (const [name, fields] of beforeEntities) if (!afterEntities.has(name)) entities.removed.push({ name, fields: Object.keys(fields) });

  // Full content only for explicitly requested paths, bounded on both sides.
  const contents = {};
  for (const path of (Array.isArray(paths) ? paths : []).slice(0, DIFF_LIMITS.max_paths)) {
    if (!beforeFiles.has(path) && !afterFiles.has(path)) continue;
    const before = beforeFiles.get(path) ?? "";
    const after = afterFiles.get(path) ?? "";
    contents[path] = {
      before: before.slice(0, DIFF_LIMITS.max_content),
      after: after.slice(0, DIFF_LIMITS.max_content),
      truncated: before.length > DIFF_LIMITS.max_content || after.length > DIFF_LIMITS.max_content,
    };
  }

  return {
    project_id: project.id,
    from: versionRef(from),
    to: versionRef(to),
    identical: counts.total_changed === 0 && !entities.added.length && !entities.removed.length && !entities.modified.length,
    files: {
      ...counts,
      entries: page,
      page: { offset: safeOffset, limit: safeLimit, returned: page.length, has_more: safeOffset + page.length < changed.length },
    },
    entities,
    contents,
    limits: DIFF_LIMITS,
  };
}