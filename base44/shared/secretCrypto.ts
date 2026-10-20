// Encryption at rest for project secrets.
//
// Established authenticated encryption only — AES-256-GCM from Web Crypto. No custom
// cryptography, no home-made key schedule, no reversible encoding pretending to be
// encryption.
//
// Key management:
//   • The master key material comes from the platform-managed app secret
//     SECRET_ENCRYPTION_KEY. It is read here and nowhere else, and never travels into a
//     project row, an artifact, a log line, an AI prompt or a response.
//   • The AES key is derived from it with PBKDF2-SHA256 (100k iterations, fixed domain
//     salt) so the stored key material is never used directly as a cipher key.
//   • Tests pass explicit key material instead, so no production credential is involved.
//
// Project isolation is CRYPTOGRAPHIC, not just a query filter: every ciphertext is sealed
// with additional authenticated data binding it to `project_id` + secret NAME. Moving a
// ciphertext to another project, or renaming it onto another secret, makes authentication
// fail — it cannot be decrypted, only rejected.
//
// Stored format:  enc:v1:<base64(iv)>:<base64(ciphertext||tag)>
// A value without the prefix is legacy plaintext and is returned as-is on read, so existing
// secrets keep working until migration encrypts them.

export const ENCRYPTED_PREFIX = "enc:v1:";
// 100k is the runtime's supported ceiling for PBKDF2 iterations.
const PBKDF2_ITERATIONS = 100000;
const DOMAIN_SALT = "nexusai:project-secret:v1";
const IV_BYTES = 12;
export const ENCRYPTION_KEY_SECRET = "SECRET_ENCRYPTION_KEY";

const keyCache = new Map();

function cryptoError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

export function readKeyMaterial(explicit) {
  if (explicit) return String(explicit);
  try {
    const v = Deno.env.get(ENCRYPTION_KEY_SECRET);
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

export function hasEncryptionKey(opts = {}) {
  return !!readKeyMaterial(opts.keyMaterial);
}

async function aesKey(keyMaterial) {
  if (keyCache.has(keyMaterial)) return keyCache.get(keyMaterial);
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(keyMaterial), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(DOMAIN_SALT), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  keyCache.set(keyMaterial, key);
  return key;
}

function requireKey(opts) {
  const material = readKeyMaterial(opts.keyMaterial);
  if (!material) {
    throw cryptoError(
      `Secret encryption is not configured. Set the ${ENCRYPTION_KEY_SECRET} app secret before storing project secrets.`,
      "SECRET_ENCRYPTION_UNAVAILABLE", 503,
    );
  }
  return material;
}

// AAD: what this ciphertext is allowed to be. Any mismatch fails authentication.
function aad(projectId, name) {
  return new TextEncoder().encode(`project:${projectId}|secret:${name}`);
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
function fromB64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const isEncrypted = (value) => typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);

export async function encryptSecretValue(projectId, name, plaintext, opts = {}) {
  const key = await aesKey(requireKey(opts));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(projectId, name) },
    key, new TextEncoder().encode(String(plaintext ?? "")),
  );
  return `${ENCRYPTED_PREFIX}${b64(iv)}:${b64(sealed)}`;
}

// Decrypt is only ever called from trusted server-side paths (the function executor, the
// deploy-time leak scan, the migration). It returns plaintext to that caller and to nobody
// else. A corrupt, truncated or foreign ciphertext raises a deterministic error instead of
// returning a partial or garbage value.
export async function decryptSecretValue(projectId, name, stored, opts = {}) {
  if (typeof stored !== "string" || stored === "") return "";
  if (!isEncrypted(stored)) return stored; // legacy plaintext, pre-migration
  const parts = stored.slice(ENCRYPTED_PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw cryptoError(`Secret "${name}" is stored in an unreadable form and could not be decrypted.`, "SECRET_DECRYPT_FAILED", 503);
  }
  const key = await aesKey(requireKey(opts));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(parts[0]), additionalData: aad(projectId, name) },
      key, fromB64(parts[1]),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Authentication failure: tampering, truncation, a different key, or a ciphertext from
    // another project/secret. The message never includes the ciphertext or key material.
    throw cryptoError(`Secret "${name}" could not be decrypted.`, "SECRET_DECRYPT_FAILED", 503);
  }
}

// Generic authenticated encryption for non-project secrets (SSO certs, OIDC client secrets,
// etc.). Same AES-256-GCM + PBKDF2 key, but the AAD is a caller-supplied domain string so a
// ciphertext sealed for one context (e.g. an SSO connection) cannot be replayed in another.
export async function encryptWithAad(aadStr, plaintext, opts = {}) {
  const key = await aesKey(requireKey(opts));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(String(aadStr)) },
    key, new TextEncoder().encode(String(plaintext ?? "")),
  );
  return `${ENCRYPTED_PREFIX}${b64(iv)}:${b64(sealed)}`;
}

export async function decryptWithAad(aadStr, stored, opts = {}) {
  if (typeof stored !== "string" || stored === "") return "";
  if (!isEncrypted(stored)) return stored; // legacy plaintext
  const parts = stored.slice(ENCRYPTED_PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw cryptoError("Stored value could not be decrypted.", "SECRET_DECRYPT_FAILED", 503);
  }
  const key = await aesKey(requireKey(opts));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(parts[0]), additionalData: new TextEncoder().encode(String(aadStr)) },
      key, fromB64(parts[1]),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw cryptoError("Stored value could not be decrypted.", "SECRET_DECRYPT_FAILED", 503);
  }
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Bulk read for trusted callers. Returns plaintext by name plus the names that failed, so a
// single corrupt row can be reported precisely instead of taking a whole request down.
export async function resolveSecretValues(rows, projectId, opts = {}) {
  const values = new Map();
  const failed = [];
  for (const row of rows || []) {
    if (!row?.name) continue;
    try {
      values.set(row.name, await decryptSecretValue(projectId, row.name, row.value || "", opts));
    } catch {
      failed.push(row.name);
    }
  }
  return { values, failed };
}

// Idempotent migration of plaintext rows to ciphertext.
//   • Already-encrypted rows are counted and skipped — running it again does nothing.
//   • Empty (declared-but-unset) rows are left empty.
//   • Each row is verified by decrypting the new ciphertext BEFORE the update is written, so
//     a migration can never replace a readable secret with an unreadable one.
export async function migrateProjectSecrets(svc, projectId, opts = {}) {
  const rows = await svc.entities.ProjectSecret.filter({ project_id: projectId }, "name", 200);
  const result = { scanned: rows.length, encrypted: 0, already_encrypted: 0, empty: 0, failed: [] };
  for (const row of rows) {
    const value = row.value || "";
    if (!value) { result.empty++; continue; }
    if (isEncrypted(value)) { result.already_encrypted++; continue; }
    try {
      const sealed = await encryptSecretValue(projectId, row.name, value, opts);
      const check = await decryptSecretValue(projectId, row.name, sealed, opts);
      if (check !== value) throw new Error("verification failed");
      await svc.entities.ProjectSecret.update(row.id, { value: sealed });
      result.encrypted++;
    } catch {
      result.failed.push(row.name); // row is left untouched and still readable
    }
  }
  return result;
}