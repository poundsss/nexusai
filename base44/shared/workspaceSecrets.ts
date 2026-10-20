// Encryption at rest and scoped access for ACCOUNT-level secrets (WorkspaceSecret).
//
// Project secrets already used AES-256-GCM (secretCrypto.ts); workspace secrets — MCP server
// credentials and the short-lived GitHub job tokens — did not. They do now, through the same
// established primitives, with two rules:
//
//   1. ENCRYPTED AT WRITE, DECRYPTED ONLY AT USE. Every value is sealed with
//      encryptWithAad before it touches the database, and decryptWithAad is called only from
//      trusted server-side paths at the moment the credential is actually used. Nothing here
//      returns a value to a client, a prompt, a tool response or a log line.
//   2. WORKSPACE-SCOPED, CRYPTOGRAPHICALLY. The AAD binds each ciphertext to its
//      workspace_id + secret NAME, so a ciphertext copied to another workspace or renamed
//      onto another secret fails authentication instead of decrypting. Every lookup also
//      filters by workspace_id, so a name alone — even a guessed one — resolves nothing
//      outside its own account.
//
// A value stored before this change has no ciphertext prefix and is returned as-is on read,
// so existing MCP connections keep working until they are re-saved or migrated.
import { encryptWithAad, decryptWithAad, isEncrypted } from "./secretCrypto.ts";

const svcOf = (client) => client.asServiceRole || client;

// What this ciphertext is allowed to be.
export const workspaceSecretAad = (workspaceId, name) => `workspace:${workspaceId}|secret:${name}`;

async function findRow(svc, workspaceId, name) {
  if (!workspaceId || !name) return null;
  const rows = await svc.entities.WorkspaceSecret.filter({ workspace_id: workspaceId, name }, "name", 1);
  return rows[0] || null;
}

// Upsert a credential. The plaintext never reaches the database.
export async function writeWorkspaceSecret(client, workspaceId, name, value, { description } = {}) {
  if (!workspaceId || !name) throw Object.assign(new Error("workspace_id and name are required"), { status: 400 });
  const svc = svcOf(client);
  const sealed = await encryptWithAad(workspaceSecretAad(workspaceId, name), String(value ?? ""));
  const existing = await findRow(svc, workspaceId, name);
  if (existing) return svc.entities.WorkspaceSecret.update(existing.id, { value: sealed, ...(description ? { description } : {}) });
  return svc.entities.WorkspaceSecret.create({
    workspace_id: workspaceId, name, value: sealed, access: "backend_only",
    ...(description ? { description } : {}),
  });
}

// Read a credential for immediate server-side use. Returns null when unset; a value that
// cannot be authenticated raises rather than returning something unusable.
export async function readWorkspaceSecret(client, workspaceId, name) {
  const svc = svcOf(client);
  const row = await findRow(svc, workspaceId, name);
  if (!row?.value) return null;
  const plaintext = await decryptWithAad(workspaceSecretAad(workspaceId, name), row.value);
  svc.entities.WorkspaceSecret.update(row.id, { last_used_at: new Date().toISOString() }).catch(() => {});
  return plaintext || null;
}

export async function deleteWorkspaceSecret(client, workspaceId, name) {
  const svc = svcOf(client);
  const row = await findRow(svc, workspaceId, name);
  if (row) await svc.entities.WorkspaceSecret.delete(row.id).catch(() => {});
  return !!row;
}

// Idempotent migration of pre-existing plaintext rows, verified before it overwrites: a row
// is only replaced once its ciphertext has been decrypted back to the original value.
export async function migrateWorkspaceSecrets(client, workspaceId) {
  const svc = svcOf(client);
  const rows = await svc.entities.WorkspaceSecret.filter({ workspace_id: workspaceId }, "name", 200);
  const result = { scanned: rows.length, encrypted: 0, already_encrypted: 0, empty: 0, failed: [] };
  for (const row of rows) {
    const value = row.value || "";
    if (!value) { result.empty++; continue; }
    if (isEncrypted(value)) { result.already_encrypted++; continue; }
    try {
      const aad = workspaceSecretAad(workspaceId, row.name);
      const sealed = await encryptWithAad(aad, value);
      if ((await decryptWithAad(aad, sealed)) !== value) throw new Error("verification failed");
      await svc.entities.WorkspaceSecret.update(row.id, { value: sealed });
      result.encrypted++;
    } catch {
      result.failed.push(row.name); // left untouched and still readable
    }
  }
  return result;
}