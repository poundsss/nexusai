// Client-side mirror of base44/shared/blobStore.ts: large file content and version
// snapshots live in file storage, with the record holding only a URL.
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load stored content (${res.status})`);
  return res.text();
}

export async function resolveFileRecords(records) {
  return Promise.all(
    (records || []).map(async (r) =>
      r.content_url ? { ...r, content: await download(r.content_url) } : r,
    ),
  );
}

export async function resolveVersionRecords(versions) {
  return Promise.all(
    (versions || []).map(async (v) =>
      v.snapshot_url ? { ...v, snapshot: JSON.parse(await download(v.snapshot_url)) } : v,
    ),
  );
}