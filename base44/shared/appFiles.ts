// File upload / storage primitives for DEPLOYED generated apps.
//
// Storage model — two halves, deliberately split:
//   • BYTES live in the platform's PRIVATE file storage (Core.UploadPrivateFile). They are
//     never world-readable, so possessing a URL is not enough to read someone's file.
//   • METADATA lives in the project's own data as AppRecord rows under the reserved
//     entity name `__files` — the same storage primitive auth (`__users`/`__sessions`)
//     already uses, so no new entity schema and no second database is introduced.
//
// Security model:
//   • `file_uri` (the internal storage handle) is NEVER returned to frontend code. The only
//     way to read bytes is `access`, which mints a short-lived signed URL server-side after
//     an ownership check. Storage credentials and the service role never leave this module.
//   • Every operation is bound to one project id, so an app can never see another app's files.
//   • When the project has RLS enabled, every file row carries a top-level `owner_id`
//     (the same indexed field createServerDb uses) and reads/writes are restricted to that
//     user. Another user's file is reported as "not found" so existence never leaks.
//     Anonymous (rls off) apps keep open, shared, project-scoped files.
//   • Anonymous callers on an RLS app are rejected with AUTH_REQUIRED before any data is touched.
//   • Size and MIME type are enforced server-side, on the DECODED byte length — a client
//     cannot lie about either by sending a different declared size or content type.

import { holdIntegrationCredits, chargeWorkspace, INTEGRATION_CREDIT_RATES } from "./integrationCharges.ts";

export const FILES_ENTITY = "__files";
// Tombstones for storage objects whose metadata row is gone. Written by delete, consumed by
// cleanupOrphanedFiles — so byte cleanup is a separate, retryable, idempotent step and a
// failed cleanup can never take a delete down with it.
export const FILE_GC_ENTITY = "__file_gc";
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
export const SIGNED_URL_TTL_SECONDS = 300;     // 5 minutes

// Allowlist, not a denylist: an unlisted type is rejected. Executables, HTML and SVG are
// intentionally absent — HTML/SVG can carry script and must never be served from storage.
export const ALLOWED_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf",
  "text/plain", "text/csv",
  "application/json",
]);

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// Storage-safe display name: no path separators, no traversal, bounded length.
function safeFilename(name) {
  const base = String(name || "file").split(/[\\/]/).pop().replace(/[^\w.\- ]/g, "_").trim();
  const cleaned = base.replace(/^\.+/, "").slice(0, 120);
  return cleaned || "file";
}

export function decodeBase64(b64) {
  let binary;
  try {
    binary = atob(String(b64 || "").replace(/^data:[^;]*;base64,/, ""));
  } catch {
    throw httpError(400, "File content must be base64 encoded", "FILE_INVALID_ENCODING");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// What frontend code is allowed to see. Note the absence of `file_uri` and `owner_id`.
function publicMeta(row) {
  const d = row.data || {};
  return {
    id: row.id,
    filename: d.filename || "",
    content_type: d.content_type || "application/octet-stream",
    size: Number(d.size) || 0,
    uploaded_at: d.uploaded_at || row.created_date,
    // PUBLIC rows carry the storage file_url so get/list can hand it back (P-9.7). Private
    // rows never have this field, so their shape is unchanged.
    ...(d.file_url ? { url: d.file_url } : {}),
  };
}

function requireUser(rls, user) {
  if (rls && !user?.id) throw httpError(401, "Sign in required", "AUTH_REQUIRED");
}

// Loads a file row, enforcing project scope and (under RLS) ownership. A file that exists
// but belongs to someone else is indistinguishable from one that does not exist.
async function ownedFile(svc, projectId, id, { rls, user }) {
  let row = null;
  try { row = await svc.entities.AppRecord.get(id); } catch { row = null; }
  if (!row || row.project_id !== projectId || row.entity_name !== FILES_ENTITY) {
    throw httpError(404, "File not found", "FILE_NOT_FOUND");
  }
  if (rls && row.owner_id !== user.id) throw httpError(404, "File not found", "FILE_NOT_FOUND");
  return row;
}

export async function uploadFile(svc, projectId, { filename, content_base64, content_type }, { rls = false, user = null } = {}) {
  requireUser(rls, user);
  const type = String(content_type || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_MIME_TYPES.has(type)) {
    throw httpError(415, `Unsupported file type "${type || "unknown"}". Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`, "FILE_TYPE_REJECTED");
  }
  const bytes = decodeBase64(content_base64);
  if (!bytes.length) throw httpError(400, "File is empty", "FILE_EMPTY");
  // Enforced on the DECODED length, so a forged declared size cannot get past this.
  if (bytes.length > MAX_FILE_BYTES) {
    throw httpError(413, `File exceeds the ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB limit`, "FILE_TOO_LARGE");
  }
  const name = safeFilename(filename);
  // P-9.2: 1 integration credit per successful upload (Base44-verified rate). The hold is placed
  // BEFORE storage is touched and refuses the upload fail-closed when the workspace has nothing
  // to spend; a storage failure releases the hold and charges nothing. An unresolvable project
  // id (a verification namespace) charges nobody.
  const charge_ws = await chargeWorkspace(svc, projectId);
  const hold = charge_ws ? await holdIntegrationCredits(svc, {
    workspace_id: charge_ws, project_id: projectId,
    credits: INTEGRATION_CREDIT_RATES.upload,
    key: `upload:${crypto.randomUUID()}`,
    reason: `UploadFile · ${INTEGRATION_CREDIT_RATES.upload} credit per upload`,
  }) : null;
  let stored;
  try {
    stored = await svc.integrations.Core.UploadPrivateFile({
      file: new File([bytes], name, { type }),
    });
  } catch (e) {
    await hold?.fail().catch(() => {});
    throw e;
  }
  await hold?.settle(INTEGRATION_CREDIT_RATES.upload, "UploadFile · integration charge", { operation: "upload", size: bytes.length });
  const { file_uri } = stored;
  const record = {
    project_id: projectId, entity_name: FILES_ENTITY,
    data: { filename: name, content_type: type, size: bytes.length, file_uri, uploaded_at: new Date().toISOString() },
  };
  if (rls) record.owner_id = user.id;
  return publicMeta(await svc.entities.AppRecord.create(record));
}

// PUBLIC upload (P-9.7 — Base44 UploadFile parity). Same bytes pipeline, same MIME/size
// checks, same charge path as the private upload; the ONLY differences are the storage
// destination (world-readable public storage through the EXISTING Core.UploadPublicFile
// primitive) and what the caller receives: a public `file_url`. Whether that URL is
// permanent is deliberately NOT asserted anywhere — it is what the platform's storage
// serves, nothing more. Private upload, signed-URL and GC behavior are untouched.
export async function uploadPublicFile(svc, projectId, { filename, content_base64, content_type, idempotency_key = null }, { rls = false, user = null } = {}) {
  requireUser(rls, user);
  const type = String(content_type || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_MIME_TYPES.has(type)) {
    throw httpError(415, `Unsupported file type "${type || "unknown"}". Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`, "FILE_TYPE_REJECTED");
  }
  const bytes = decodeBase64(content_base64);
  if (!bytes.length) throw httpError(400, "File is empty", "FILE_EMPTY");
  if (bytes.length > MAX_FILE_BYTES) {
    throw httpError(413, `File exceeds the ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB limit`, "FILE_TOO_LARGE");
  }
  const name = safeFilename(filename);
  // Exactly-once: a replayed operation key resolves to the already-uploaded file — no second
  // provider upload, no second metadata row, no second charge.
  const opKey = String(idempotency_key || "").trim().slice(0, 180);
  if (opKey) {
    const rows = await svc.entities.AppRecord.filter({ project_id: projectId, entity_name: FILES_ENTITY }, "-created_date", 500).catch(() => []);
    const existing = rows.find((r) => (r.data || {}).idempotency_key === opKey && (r.data || {}).file_url);
    if (existing) return { ...publicMeta(existing), url: (existing.data || {}).file_url };
  }
  // P-9.2: 1 integration credit per successful upload (Base44-verified rate). The hold is
  // placed BEFORE public storage is touched and refuses fail-closed when the workspace has
  // nothing to spend; a storage failure releases the hold and charges nothing. Message
  // credits are never touched — every movement is integration pool.
  const charge_ws = await chargeWorkspace(svc, projectId);
  const hold = charge_ws ? await holdIntegrationCredits(svc, {
    workspace_id: charge_ws, project_id: projectId,
    credits: INTEGRATION_CREDIT_RATES.upload,
    key: `upload_public:${opKey || crypto.randomUUID()}`,
    reason: `UploadPublicFile · ${INTEGRATION_CREDIT_RATES.upload} credit per upload`,
  }) : null;
  let stored;
  try {
    stored = await svc.integrations.Core.UploadPublicFile({
      file: new File([bytes], name, { type }),
    });
  } catch (e) {
    await hold?.fail().catch(() => {});
    throw e;
  }
  if (!stored?.file_url) {
    await hold?.fail().catch(() => {});
    throw httpError(502, "Public storage returned no file URL", "UPLOAD_FAILED");
  }
  await hold?.settle(INTEGRATION_CREDIT_RATES.upload, "UploadPublicFile · integration charge", { operation: "upload_public", size: bytes.length });
  const record = {
    project_id: projectId, entity_name: FILES_ENTITY,
    data: {
      filename: name, content_type: type, size: bytes.length, file_url: stored.file_url,
      visibility: "public", uploaded_at: new Date().toISOString(),
      ...(opKey ? { idempotency_key: opKey } : {}),
    },
  };
  if (rls) record.owner_id = user.id;
  return { ...publicMeta(await svc.entities.AppRecord.create(record)), url: stored.file_url };
}

export async function getFileMeta(svc, projectId, id, { rls = false, user = null } = {}) {
  requireUser(rls, user);
  return publicMeta(await ownedFile(svc, projectId, id, { rls, user }));
}

export async function listFiles(svc, projectId, { limit = 100 } = {}, { rls = false, user = null } = {}) {
  requireUser(rls, user);
  // owner_id is a top-level field, so under RLS the per-user filter is pushed to the server.
  const query = rls
    ? { project_id: projectId, entity_name: FILES_ENTITY, owner_id: user.id }
    : { project_id: projectId, entity_name: FILES_ENTITY };
  const rows = await svc.entities.AppRecord.filter(query, "-created_date", Math.min(Number(limit) || 100, 500));
  return rows.map(publicMeta);
}

// Mints a short-lived signed URL. This is the ONLY read path for bytes, and it runs only
// after the ownership check above — so a guessed file id belonging to another user fails.
// `expires_in` is OPTIONAL (CreateFileSignedUrl parity, SDK 0.8.52): when supplied by the
// signed-URL integration path it is forwarded VERBATIM to the platform primitive, which owns
// all TTL validation (LIVE-VERIFIED 2026-10-03: bounds enforced server-side, <60 / >3600
// refused). Default stays the standard 300s; `files.access` never passes it and is unchanged.
export async function accessFile(svc, projectId, id, { rls = false, user = null, expires_in = null } = {}) {
  requireUser(rls, user);
  const row = await ownedFile(svc, projectId, id, { rls, user });
  const uri = (row.data || {}).file_uri;
  if (!uri) throw httpError(404, "File not found", "FILE_NOT_FOUND");
  const ttl = expires_in === null || expires_in === undefined ? SIGNED_URL_TTL_SECONDS : expires_in;
  const { signed_url } = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: uri, expires_in: ttl });
  return { ...publicMeta(row), url: signed_url, expires_in: ttl };
}

export async function deleteFile(svc, projectId, id, { rls = false, user = null } = {}) {
  requireUser(rls, user);
  const row = await ownedFile(svc, projectId, id, { rls, user });
  const uri = (row.data || {}).file_uri;
  await svc.entities.AppRecord.delete(row.id);
  // The metadata row is the only reachability path to the bytes, so it goes first: after
  // this point the object is unreachable regardless of whether cleanup succeeds. The
  // tombstone records the orphaned handle for the cleanup pass.
  if (uri) {
    await svc.entities.AppRecord.create({
      project_id: projectId, entity_name: FILE_GC_ENTITY,
      data: { file_uri: uri, deleted_at: new Date().toISOString(), source_file_id: row.id },
    }).catch(() => { /* best effort: a lost tombstone leaks bytes, never data */ });
  }
  return true;
}

// Reclaims storage for deleted files. Idempotent and safe by construction:
//   • It only ever considers tombstoned handles.
//   • REACHABILITY IS RE-VERIFIED before touching anything: if any live `__files` row in
//     this project still references the same handle, the tombstone is dropped and the bytes
//     are left completely alone. A reachable file is never deleted.
//   • Each tombstone is removed once processed, so a second pass finds nothing and reports
//     zero work — repeated runs are harmless.
// LIMITATION: the platform exposes upload and signed-read for private storage but no delete
// primitive, so the bytes cannot be erased from here. Cleanup therefore guarantees
// unreachability (handle destroyed, no metadata, no signed URL possible) and records the
// residual object; `purged` counts handles retired this way.
export async function cleanupOrphanedFiles(svc, projectId, { limit = 100 } = {}) {
  const tombstones = await svc.entities.AppRecord.filter(
    { project_id: projectId, entity_name: FILE_GC_ENTITY }, "-created_date", Math.min(Number(limit) || 100, 500),
  );
  if (!tombstones.length) return { scanned: 0, purged: 0, skipped_reachable: 0, residual: 0 };

  const live = await svc.entities.AppRecord.filter(
    { project_id: projectId, entity_name: FILES_ENTITY }, "-created_date", 1000,
  );
  const reachable = new Set(live.map((r) => (r.data || {}).file_uri).filter(Boolean));

  let purged = 0, skippedReachable = 0, residual = 0;
  for (const t of tombstones) {
    const uri = (t.data || {}).file_uri;
    if (uri && reachable.has(uri)) { skippedReachable++; await svc.entities.AppRecord.delete(t.id).catch(() => {}); continue; }
    let deletedBytes = false;
    const del = svc.integrations?.Core?.DeletePrivateFile;
    if (uri && typeof del === "function") {
      try { await del({ file_uri: uri }); deletedBytes = true; } catch { deletedBytes = false; }
    }
    if (!deletedBytes) residual++;
    await svc.entities.AppRecord.delete(t.id).catch(() => {});
    purged++;
  }
  return { scanned: tombstones.length, purged, skipped_reachable: skippedReachable, residual };
}

// The `files` API handed to generated backend functions (ctx.files) and driven by the
// public runtime's "files" action. One shape, one enforcement path, no duplicated logic.
export function createServerFiles(svc, projectId, { rls = false, user = null, allowCleanup = false } = {}) {
  const opts = { rls, user };
  return {
    // Storage reclamation is a maintenance operation, so it is exposed to trusted
    // server-side callers (backend functions) only — never to the public runtime bridge.
    ...(allowCleanup ? { cleanup: (options) => cleanupOrphanedFiles(svc, projectId, options || {}) } : {}),
    upload: (input) => uploadFile(svc, projectId, input || {}, opts),
    uploadPublic: (input) => uploadPublicFile(svc, projectId, input || {}, opts),
    get: (id) => getFileMeta(svc, projectId, id, opts),
    list: (options) => listFiles(svc, projectId, options || {}, opts),
    access: (id) => accessFile(svc, projectId, id, opts),
    delete: (id) => deleteFile(svc, projectId, id, opts),
    limits: { max_bytes: MAX_FILE_BYTES, allowed_types: [...ALLOWED_MIME_TYPES] },
  };
}