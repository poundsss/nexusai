// P-10.3 phase 4 — mobile STORE connection credentials, stored through the EXISTING
// WorkspaceSecret pattern: AES-256-GCM encrypted at rest, sealed with AAD binding each
// ciphertext to its workspace_id + secret NAME (a ciphertext moved to another workspace fails
// to decrypt instead of leaking), backend/service-role access only, never returned to a
// client and never placed in AI context, prompts, tool results or logs.
//
// One connection per platform per workspace:
//   Apple  → { issuer_id, key_id, private_key }         (App Store Connect API key)
//   Google → { service_account_json, package_name }    (Play service account + Android id)
//
// Management requires the EXISTING secret.manage capability (owner/admin). Every change is
// audited under mobile_store_connection.*; the audit trail records the credential's IDENTITY
// (platform + secret name) only — never a value.
import { audit } from "./authz.ts";
import { writeWorkspaceSecret, readWorkspaceSecret, deleteWorkspaceSecret } from "./workspaceSecrets.ts";

export const STORE_CONNECTION_PLATFORMS = ["ios", "android"];

export const storeConnectionSecretName = (platform) => `MOBILE_STORE_${platform === "ios" ? "APPLE" : "GOOGLE"}`;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const svcOf = (client) => client.asServiceRole || client;

const validPlatform = (platform) => {
  if (!STORE_CONNECTION_PLATFORMS.includes(platform)) {
    throw fail(400, "INVALID_PLATFORM", `platform must be one of: ${STORE_CONNECTION_PLATFORMS.join(", ")}`);
  }
};

/**
 * Structural validation, shared by the management path and the provider adapters so the two can
 * never disagree about what a well-formed connection is. Normalizes and returns the connection;
 * anything malformed is refused BEFORE it is stored.
 */
export function validateStoreConnectionShape(platform, connection) {
  if (platform === "ios") {
    const issuer_id = String(connection?.issuer_id ?? "").trim();
    const key_id = String(connection?.key_id ?? "").trim();
    const private_key = String(connection?.private_key ?? "").trim();
    if (issuer_id.length < 6 || issuer_id.length > 255) {
      throw fail(400, "INVALID_STORE_CREDENTIAL", "issuer_id must be 6-255 characters");
    }
    if (key_id.length < 4 || key_id.length > 64) {
      throw fail(400, "INVALID_STORE_CREDENTIAL", "key_id must be 4-64 characters");
    }
    if (private_key.length < 32 || !private_key.includes("PRIVATE KEY")) {
      throw fail(400, "INVALID_STORE_CREDENTIAL", "private_key must be a PEM private key");
    }
    // Base44 Apple UI parity: Team ID (10-char Apple Team identifier) and an optional push
    // notifications toggle, both captured at generation time. team_id is optional here so an
    // existing stored connection that predates the field keeps working; if supplied it must be
    // exactly 10 alphanumeric characters (Apple's Team ID format). push_notifications defaults
    // to false and never affects the existing upload/signing path.
    const team_id = String(connection?.team_id ?? "").trim();
    if (team_id && !/^[A-Z0-9]{10}$/.test(team_id)) {
      throw fail(400, "INVALID_STORE_CREDENTIAL", "team_id must be 10 alphanumeric characters");
    }
    const push_notifications = connection?.push_notifications === true;
    return { issuer_id, key_id, private_key, team_id, push_notifications };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(connection?.service_account_json ?? ""));
  } catch {
    throw fail(400, "INVALID_STORE_CREDENTIAL", "service_account_json must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" ||
    typeof parsed.client_email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.client_email) ||
    typeof parsed.private_key !== "string" || !parsed.private_key.includes("PRIVATE KEY")) {
    throw fail(400, "INVALID_STORE_CREDENTIAL", "service_account_json must carry client_email and a PEM private_key");
  }
  const package_name = String(connection?.package_name ?? "").trim();
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(package_name)) {
    throw fail(400, "INVALID_STORE_CREDENTIAL", "package_name must be a valid Android package name");
  }
  return { service_account_json: parsed, package_name };
}

/**
 * Upsert one platform's store connection. The plaintext never reaches the database; the audit
 * trail records the credential's IDENTITY (platform + secret name), never its value.
 */
export async function putStoreConnection(client, { workspace_id, platform, connection, user_id = "platform", description } = {}) {
  validPlatform(platform);
  const normalized = validateStoreConnectionShape(platform, connection);
  const svc = svcOf(client);
  const name = storeConnectionSecretName(platform);
  const rows = await svc.entities.WorkspaceSecret.filter({ workspace_id, name }, "name", 1);
  const existing = rows[0] || null;
  const row = await writeWorkspaceSecret(svc, workspace_id, name, JSON.stringify(normalized), { description });
  await audit(svc, {
    workspace_id, user_id,
    action: existing ? "mobile_store_connection.updated" : "mobile_store_connection.created",
    resource: "WorkspaceSecret", resource_id: (existing || row)?.id || null,
    metadata: { platform, secret_name: name },
  });
  return { platform, secret_name: name, existed: !!existing };
}

/**
 * Server-side-only read for the publishing worker. Returns the parsed connection, or null when
 * unset. The value is used at the moment of upload and never leaves the trusted path.
 */
export async function readStoreConnection(client, workspace_id, platform) {
  validPlatform(platform);
  const raw = await readWorkspaceSecret(svcOf(client), workspace_id, storeConnectionSecretName(platform));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A value that no longer parses fails closed — the worker sees it as unconfigured.
    return null;
  }
}

export async function removeStoreConnection(client, { workspace_id, platform, user_id = "platform" } = {}) {
  validPlatform(platform);
  const svc = svcOf(client);
  const name = storeConnectionSecretName(platform);
  const rows = await svc.entities.WorkspaceSecret.filter({ workspace_id, name }, "name", 1);
  const existing = rows[0] || null;
  const deleted = await deleteWorkspaceSecret(svc, workspace_id, name);
  if (existing) {
    await audit(svc, {
      workspace_id, user_id, action: "mobile_store_connection.deleted",
      resource: "WorkspaceSecret", resource_id: existing.id,
      metadata: { platform, secret_name: name },
    });
  }
  return { platform, deleted };
}

/**
 * The client-safe view: presence and metadata only — values are never returned by any read path.
 */
export async function describeStoreConnections(client, workspace_id) {
  const svc = svcOf(client);
  const rows = await svc.entities.WorkspaceSecret.filter({ workspace_id }, "name", 100).catch(() => []);
  return STORE_CONNECTION_PLATFORMS.map((platform) => {
    const name = storeConnectionSecretName(platform);
    const row = rows.find((r) => r.name === name);
    return {
      platform, secret_name: name, is_set: !!row,
      description: row?.description || "", last_used_at: row?.last_used_at || null,
    };
  });
}