// P-10.3 phase 2 — mobile signing credentials, stored through the EXISTING WorkspaceSecret
// pattern (P-8.1): AES-256-GCM encrypted at rest, sealed with AAD binding each ciphertext to
// its workspace_id + secret NAME (so a ciphertext moved to another workspace fails to decrypt
// instead of leaking), backend/service-role access only, never returned to a client and never
// placed in AI context, prompts, tool results or logs.
//
// This module adds the mobile naming convention, validation and the audit trail. The plaintext
// is decrypted only inside the trusted build worker at the moment of signing.
import { audit } from "./authz.ts";
import { writeWorkspaceSecret, readWorkspaceSecret, deleteWorkspaceSecret } from "./workspaceSecrets.ts";

export const SIGNING_PLATFORMS = ["ios", "android"];
const MIN_LEN = 8;
const MAX_LEN = 20000;

export const signingSecretName = (platform) => `MOBILE_SIGNING_${platform === "ios" ? "APPLE" : "ANDROID"}`;

const svcOf = (client) => client.asServiceRole || client;

const validPlatform = (platform) => {
  if (!SIGNING_PLATFORMS.includes(platform)) {
    throw Object.assign(new Error(`platform must be one of: ${SIGNING_PLATFORMS.join(", ")}`), { status: 400, code: "INVALID_PLATFORM" });
  }
};

async function findRow(svc, workspaceId, name) {
  if (!workspaceId || !name) return null;
  const rows = await svc.entities.WorkspaceSecret.filter({ workspace_id: workspaceId, name }, "name", 1);
  return rows[0] || null;
}

/**
 * Upsert one platform's signing credential. The plaintext never reaches the database; the audit
 * trail records the credential's IDENTITY (platform + secret name), never its value.
 */
export async function putSigningCredential(client, { workspace_id, platform, value, user_id = "platform", description } = {}) {
  validPlatform(platform);
  const text = String(value ?? "").trim();
  if (text.length < MIN_LEN || text.length > MAX_LEN) {
    throw Object.assign(new Error(`A signing credential must be ${MIN_LEN}-${MAX_LEN} characters`), { status: 400, code: "INVALID_CREDENTIAL" });
  }
  const svc = svcOf(client);
  const name = signingSecretName(platform);
  const existing = await findRow(svc, workspace_id, name);
  const row = await writeWorkspaceSecret(svc, workspace_id, name, text, { description });
  await audit(svc, {
    workspace_id, user_id,
    action: existing ? "mobile_signing_credentials.updated" : "mobile_signing_credentials.created",
    resource: "WorkspaceSecret", resource_id: (existing || row)?.id || null,
    metadata: { platform, secret_name: name },
  });
  return { platform, secret_name: name, existed: !!existing };
}

/**
 * Server-side-only read for the build worker. Returns null when unset; the value is used at the
 * moment of signing and never leaves the trusted path.
 */
export async function readSigningCredential(client, workspace_id, platform) {
  validPlatform(platform);
  return readWorkspaceSecret(svcOf(client), workspace_id, signingSecretName(platform));
}

export async function removeSigningCredential(client, { workspace_id, platform, user_id = "platform" } = {}) {
  validPlatform(platform);
  const svc = svcOf(client);
  const name = signingSecretName(platform);
  const existing = await findRow(svc, workspace_id, name);
  const deleted = await deleteWorkspaceSecret(svc, workspace_id, name);
  if (existing) {
    await audit(svc, {
      workspace_id, user_id, action: "mobile_signing_credentials.deleted",
      resource: "WorkspaceSecret", resource_id: existing.id,
      metadata: { platform, secret_name: name },
    });
  }
  return { platform, deleted };
}

/**
 * The client-safe view: presence and metadata only — values are never returned by any read path.
 */
export async function describeSigningCredentials(client, workspace_id) {
  const svc = svcOf(client);
  const rows = await svc.entities.WorkspaceSecret.filter({ workspace_id }, "name", 100).catch(() => []);
  return SIGNING_PLATFORMS.map((platform) => {
    const name = signingSecretName(platform);
    const row = rows.find((r) => r.name === name);
    return {
      platform, secret_name: name, is_set: !!row,
      description: row?.description || "", last_used_at: row?.last_used_at || null,
    };
  });
}