// P-10.3 phase 2 — binary mobile package storage and deterministic packaging.
//
// Mobile packages are BINARY artifacts kept deliberately separate from the JSON/file-content
// storage blobStore serves: they go to PRIVATE storage (reachable only through short-lived
// signed URLs), under content-addressed names derived from the package checksum, so a retry or
// a rebuild of the same artifact converges on the same bytes and the same checksum.
//
// The bundle input is derived ONLY from the immutable DeploymentArtifact payload and its
// identity — never from the project's mutable working files — and is canonically serialized,
// so the same artifact always packages to the same checksum. The stored reference is written
// once and never rewritten; expiry of a signed URL is the only way access stops.
const encoder = new TextEncoder();

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Canonical JSON: object keys sorted at every depth, no whitespace — a stable byte-level
// serialization, so identical input always produces identical bytes.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The deterministic bundle input packaged into the mobile artifact. Everything here comes from
 * the immutable artifact payload and its identity — the worker never consults project source.
 */
export function buildMobilePackageInput({ platform, artifactId, artifactChecksum, versionNumber, payload }) {
  const config = payload?.config || {};
  const clientFiles = [...(payload?.client_files || [])].sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return {
    manifest_version: 1,
    platform,
    source: {
      artifact_id: artifactId,
      artifact_checksum: artifactChecksum,
      version_number: versionNumber ?? null,
    },
    app: {
      entry: config.entry || null,
      framework: config.framework || null,
      client_file_count: clientFiles.length,
      client_files: clientFiles.map((f) => ({ path: f.path, content: String(f.content ?? "") })),
      function_names: [...(payload?.functions || [])].map((f) => f.name).sort(),
      entity_names: [...(payload?.entities || [])].map((e) => e.name).sort(),
    },
  };
}

export const packageBytes = (input) => encoder.encode(canonicalJson(input));

// Private BINARY storage — a separate store from blobStore's public JSON/file content.
export async function packBinaryPackage(svc, name, bytes) {
  const file = new File([bytes], name, { type: "application/octet-stream" });
  const { file_uri } = await svc.integrations.Core.UploadPrivateFile({ file });
  return file_uri;
}

// Checksum verification against what storage actually serves, before the phase is committed.
export async function verifyStoredPackage(svc, file_uri, expectedChecksum) {
  const { signed_url } = await svc.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: 60 });
  const res = await fetch(signed_url);
  if (!res.ok) throw new Error(`Could not read back the stored package (${res.status})`);
  const checksum = await sha256Hex(new Uint8Array(await res.arrayBuffer()));
  return checksum === expectedChecksum;
}

// Signed, short-lived download URL with a clamped TTL (1 minute .. 1 hour).
export async function createPackageDownloadUrl(svc, file_uri, expires_in) {
  const ttl = Math.min(Math.max(Math.floor(Number(expires_in) || 300), 60), 3600);
  const { signed_url } = await svc.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: ttl });
  return { signed_url, expires_in: ttl };
}