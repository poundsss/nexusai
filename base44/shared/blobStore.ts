// Entity text fields have a hard size ceiling (~16KB observed, rejected at 24KB).
// Anything larger is uploaded to file storage and the record keeps a URL instead.
// Writers call pack*(); readers call unpack*(). Small payloads stay inline, so the
// common case costs no extra network hop.
const MAX_INLINE = 12000;

async function upload(base44, name, text) {
  const file = new File([text], name, { type: "text/plain" });
  // Callers pass either the root client or an already-service-role client (background
  // workers only ever hold the latter). Uploading always runs with the service role.
  const svc = base44.asServiceRole || base44;
  const { file_url } = await svc.integrations.Core.UploadPublicFile({ file });
  return file_url;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load stored content (${res.status})`);
  return res.text();
}

// -- project file content ----------------------------------------------------

export function isOversize(content) {
  return String(content ?? "").length > MAX_INLINE;
}

// Returns the field set to write for a ProjectFile: inline content, or a pointer.
export async function packFileContent(base44, path, content) {
  const text = String(content ?? "");
  if (!isOversize(text)) return { content: text, content_url: null };
  const url = await upload(base44, `${path.replace(/[^\w.-]/g, "_")}.txt`, text);
  return { content: "", content_url: url };
}

export async function unpackFileContent(record) {
  if (record?.content_url) return download(record.content_url);
  return record?.content || "";
}

export async function unpackFileRecords(records) {
  return Promise.all(
    (records || []).map(async (r) => ({ ...r, content: await unpackFileContent(r) })),
  );
}

// -- background run staging --------------------------------------------------
// A run executes across several requests, so its in-flight state (virtual FS, entities,
// plan) is parked in storage between phases. Always out-of-band: it is far over the
// inline ceiling in any real project.

export async function packJson(base44, name, value) {
  return upload(base44, name, JSON.stringify(value));
}

export async function unpackJson(url) {
  return JSON.parse(await download(url));
}

// -- version snapshots -------------------------------------------------------

export async function packSnapshot(base44, projectId, snapshot) {
  const json = JSON.stringify(snapshot);
  if (json.length <= MAX_INLINE) return { snapshot, snapshot_url: null };
  const url = await upload(base44, `snapshot_${projectId}.json`, json);
  return { snapshot: null, snapshot_url: url };
}

export async function unpackSnapshot(version) {
  if (version?.snapshot_url) return JSON.parse(await download(version.snapshot_url));
  return version?.snapshot || { files: [], entities: [] };
}