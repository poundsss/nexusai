// Shared contract for the Superagent-style file store (Agent → More → Files).
//
//   • RECORDS live in the AgentStoreFile entity (folders + files, one row per entry).
//   • BYTES live in the platform's PRIVATE file storage (Core.UploadPrivateFile /
//     Core.CreateFileSignedUrl) — the existing storage path, never a second store.
//   • AUTHORIZATION is fail-closed: every action resolves the workspace and the EXISTING
//     rbac.resolveRole gate first; a non-member is refused before anything runs.
//   • The artifacts folder (ARTIFACTS_FOLDER) holds chat-generated artifacts saved
//     with "Save in files"; it is ensured idempotently so browsing always shows it.
//
// Handlers (agentStoreFiles) authorize, then call these helpers; the certification suite
// (agentFilesStoreCert) exercises the SAME helpers in-process.

import { resolveRole } from "./rbac.ts";

export const ROOT = "";
export const ARTIFACTS_FOLDER = "artifacts";
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // per-file cap for uploads and artifact saves
export const MAX_ZIP_BYTES = 15 * 1024 * 1024; // total cap for one folder ZIP download

const NAME_RE = /^[^/\\]+$/;

export function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Fail-closed authorization: the caller must be a member of the named workspace.
export async function requireWorkspaceMember(svc, workspaceId, user) {
  const wsId = String(workspaceId || "");
  if (!wsId) throw httpError(400, "workspace_id is required", "WORKSPACE_REQUIRED");
  if (!user) throw httpError(401, "Unauthorized", "AUTH_REQUIRED");
  const workspace = await svc.entities.Workspace.get(wsId).catch(() => null);
  if (!workspace) throw httpError(404, "Workspace not found", "WORKSPACE_NOT_FOUND");
  const role = await resolveRole(svc, workspace, user);
  if (!role) throw httpError(403, "You do not have access to this workspace", "FORBIDDEN");
  return { workspace_id: wsId, role };
}

function agentOf(body) {
  const agent = String(body.agent_name || "").trim();
  if (!agent || agent.length > 120) throw httpError(400, "agent_name is required", "AGENT_REQUIRED");
  return agent;
}

function cleanParent(p) {
  return String(p === undefined || p === null ? ROOT : p).replace(/^\/+|\/+$/g, "");
}

export function entryPath(parentPath, name) {
  return parentPath ? `${parentPath}/${name}` : String(name || "");
}

export function validEntryName(name) {
  const n = String(name || "").trim();
  return !!n && NAME_RE.test(n) && n.length <= 200 ? n : null;
}

async function requireFolder(svc, ctx, agent, fullPath) {
  const idx = fullPath.lastIndexOf("/");
  const parent = idx === -1 ? ROOT : fullPath.slice(0, idx);
  const name = fullPath.slice(idx + 1);
  const page = await svc.entities.AgentStoreFile.filter(
    { agent_name: agent, workspace_id: ctx.workspace_id, parent_path: parent, name, type: "folder" },
    { limit: 1 }
  );
  if (!(page.items || []).length) throw httpError(404, "Folder not found", "FOLDER_NOT_FOUND");
}

async function refuseDuplicate(svc, ctx, agent, parent, name) {
  const page = await svc.entities.AgentStoreFile.filter(
    { agent_name: agent, workspace_id: ctx.workspace_id, parent_path: parent, name },
    { limit: 1 }
  );
  if ((page.items || []).length) throw httpError(409, "An entry with this name already exists here", "ALREADY_EXISTS");
}

// Ensure the artifacts folder record exists (idempotent) so browsing always shows it.
export async function ensureArtifactsFolder(svc, ctx, agent) {
  const page = await svc.entities.AgentStoreFile.filter(
    { agent_name: agent, workspace_id: ctx.workspace_id, parent_path: ROOT, name: ARTIFACTS_FOLDER, type: "folder" },
    { limit: 1 }
  );
  if ((page.items || []).length) return page.items[0];
  try {
    return await svc.entities.AgentStoreFile.create({
      agent_name: agent, workspace_id: ctx.workspace_id, parent_path: ROOT, name: ARTIFACTS_FOLDER, type: "folder",
    });
  } catch {
    return null; // lost race — the folder exists
  }
}

export async function listFolder(svc, ctx, body) {
  const agent = agentOf(body);
  const parent = cleanParent(body.parent_path);
  if (parent === ROOT) await ensureArtifactsFolder(svc, ctx, agent);
  const page = await svc.entities.AgentStoreFile.filter(
    { agent_name: agent, workspace_id: ctx.workspace_id, parent_path: parent },
    { sort: "name", limit: 200 }
  );
  const entries = (page.items || []).slice();
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
  return entries;
}

export async function createFolder(svc, ctx, body) {
  const agent = agentOf(body);
  const parent = cleanParent(body.parent_path);
  const name = validEntryName(body.name);
  if (!name) throw httpError(400, "Invalid folder name", "BAD_NAME");
  if (parent) await requireFolder(svc, ctx, agent, parent);
  await refuseDuplicate(svc, ctx, agent, parent, name);
  return svc.entities.AgentStoreFile.create({
    agent_name: agent, workspace_id: ctx.workspace_id, parent_path: parent, name, type: "folder",
  });
}

// Registers bytes ALREADY stored through Core.UploadPrivateFile (the client uploads directly;
// the artifact-save path uploads server-side). Both go through this single recording path.
export async function registerUpload(svc, ctx, body) {
  const agent = agentOf(body);
  const parent = cleanParent(body.parent_path);
  const name = validEntryName(body.name);
  const fileUri = String(body.file_uri || "");
  if (!fileUri) throw httpError(400, "file_uri is required (upload the bytes through Core.UploadPrivateFile first)", "FILE_URI_REQUIRED");
  if (!name) throw httpError(400, "Invalid file name", "BAD_NAME");
  if (parent) await requireFolder(svc, ctx, agent, parent);
  await refuseDuplicate(svc, ctx, agent, parent, name);
  const size = Number(body.size_bytes) || 0;
  return svc.entities.AgentStoreFile.create({
    agent_name: agent, workspace_id: ctx.workspace_id, parent_path: parent, name, type: "file",
    file_uri: fileUri,
    mime_type: String(body.mime_type || "application/octet-stream"),
    size_bytes: size,
    source: body.source === "artifact" ? "artifact" : "upload",
    artifact_url: String(body.artifact_url || ""),
  });
}

// "Save in files" for a chat-generated artifact: the public artifact URL is fetched and its
// bytes are stored through the platform's private storage, then recorded under artifacts.
export async function saveArtifact(svc, ctx, body) {
  const agent = agentOf(body);
  const url = String(body.url || "");
  if (!/^https:\/\//i.test(url)) throw httpError(400, "Only https artifact URLs can be saved", "BAD_URL");
  await ensureArtifactsFolder(svc, ctx, agent);
  const fromUrl = decodeURIComponent((url.split("/").pop() || "").split("?")[0]);
  const name = validEntryName(body.name) || validEntryName(fromUrl) || `artifact-${Date.now()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw httpError(502, "Artifact download failed", "ARTIFACT_FETCH_FAILED");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw httpError(400, "Artifact is empty", "ARTIFACT_EMPTY");
  if (bytes.length > MAX_FILE_BYTES) throw httpError(413, "Artifact exceeds the size limit", "ARTIFACT_TOO_LARGE");
  const mime = res.headers.get("content-type") || "application/octet-stream";
  const stored = await svc.integrations.Core.UploadPrivateFile({ file: new File([bytes], name, { type: mime }) });
  return registerUpload(svc, ctx, {
    agent_name: agent, parent_path: ARTIFACTS_FOLDER, name,
    file_uri: stored.file_uri, size_bytes: bytes.length, mime_type: mime,
    source: "artifact", artifact_url: url,
  });
}

// --- Folder ZIP (store method, no compression; bounded by MAX_ZIP_BYTES) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function buildZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const size = e.bytes.length;
    const local = [
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(Uint8Array.from(local), nameBytes, e.bytes);
    central.push(Uint8Array.from([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u16(0), ...u32(crc), ...u32(size), ...u32(size), ...u16(nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), nameBytes);
    offset += local.length + nameBytes.length + size;
  }
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const end = Uint8Array.from([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length), ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  return concat([...chunks, ...central, end]);
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Download a folder (or the store root) as a ZIP: every file under it is signed through the
// EXISTING CreateFileSignedUrl, fetched and packed. Bounded, with per-file failures reported.
export async function zipFolder(svc, ctx, body) {
  const agent = agentOf(body);
  const start = cleanParent(body.parent_path);
  if (start) await requireFolder(svc, ctx, agent, start);
  const rootName = start ? start.split("/").pop() : "files";
  const page = await svc.entities.AgentStoreFile.filter(
    { agent_name: agent, workspace_id: ctx.workspace_id, type: "file" },
    { limit: 1000, fields: ["parent_path", "name", "file_uri", "size_bytes"] }
  );
  const prefix = start ? start + "/" : "";
  const files = (page.items || []).filter((r) => !start || r.parent_path === start || r.parent_path.startsWith(prefix));
  const results = [];
  for (let i = 0; i < files.length; i += 6) { // bounded batches, never one await per file
    const batch = files.slice(i, i + 6);
    results.push(...await Promise.all(batch.map(async (f) => {
      const s = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: f.file_uri });
      const res = await fetch(s.signed_url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error("fetch failed");
      const bytes = new Uint8Array(await res.arrayBuffer());
      const rel = start ? f.parent_path.slice(start.length + 1) + "/" : "";
      return { name: `${rootName}/${rel}${f.name}`, bytes };
    })));
  }
  const ok = results.filter((r) => r && r.bytes && r.bytes.length);
  const failed = files.length - ok.length;
  const total = ok.reduce((n, e) => n + e.bytes.length, 0);
  if (total > MAX_ZIP_BYTES) throw httpError(413, "Folder exceeds the download size limit", "ZIP_TOO_LARGE");
  return { filename: `${rootName}.zip`, zip_base64: toBase64(buildZip(ok)), failed_count: failed };
}