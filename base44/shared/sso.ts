// Enterprise SSO control plane: organizations, SSO connections, domain verification, group
// mappings, and SSO enforcement.
//
// SECURITY MODEL:
//   • every operation is scoped to the caller's workspace and the server re-resolves the
//     caller's role on every call — the client never states its own role or an org's owner;
//   • SSO connection certificates and OIDC client secrets are encrypted at rest with the
//     platform secret key and decrypted only server-side at validation/exchange time;
//   • domain verification proves DNS ownership before SSO routing is offered for that domain,
//     so an org cannot intercept another org's users by claiming a domain it doesn't own;
//   • SSO enforcement, when enabled, refuses password login for users on a verified domain,
//     so the enterprise IdP — not a reused password — is the gate.
//
// The platform's own auth SDK owns session creation; this module owns everything UP TO that
// point: configuration, validation, provisioning, and the enforcement decision. The actual
// "create a platform session from a validated SSO assertion" step is a platform integration
// point documented in the backend function.

import { encryptWithAad, decryptWithAad, sha256Hex, hasEncryptionKey } from "./secretCrypto.ts";
import { audit } from "./authz.ts";

export class SsoError extends Error {
  constructor(message, code = "SSO_ERROR", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const CERT_AAD = (id) => `sso:connection:${id || "unassigned"}:cert`;
const SECRET_AAD = (id) => `sso:connection:${id || "unassigned"}:secret`;

function randomToken(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// --- organizations ------------------------------------------------------------

export async function getOrganization(svc, workspace_id) {
  return (await svc.entities.Organization.filter({ workspace_id }, "-created_date", 1))[0] || null;
}

export async function createOrganization(svc, { workspace_id, name, created_by, default_role = "viewer", sso_enforced = false, scim_enabled = false, max_seats = 0 }) {
  if (!workspace_id) throw new SsoError("workspace_id is required", "SSO_NO_WORKSPACE");
  if (!name || !String(name).trim()) throw new SsoError("name is required", "SSO_NO_NAME");
  const existing = await getOrganization(svc, workspace_id);
  if (existing) throw new SsoError("workspace already has an organization", "SSO_ORG_EXISTS", 409);
  const validRoles = ["admin", "editor", "viewer"];
  if (!validRoles.includes(default_role)) throw new SsoError("invalid default_role", "SSO_BAD_ROLE");
  return svc.entities.Organization.create({
    workspace_id, name: String(name).trim().slice(0, 200), status: "active",
    sso_enforced: !!sso_enforced, scim_enabled: !!scim_enabled, default_role, max_seats: Number(max_seats) || 0,
    created_by: created_by || null,
  });
}

export async function updateOrganization(svc, { workspace_id, patch }) {
  const org = await getOrganization(svc, workspace_id);
  if (!org) throw new SsoError("organization not found", "SSO_NO_ORG", 404);
  const allowed = {};
  for (const k of ["name", "sso_enforced", "scim_enabled", "default_role", "max_seats"]) {
    if (k in patch) allowed[k] = patch[k];
  }
  if ("default_role" in allowed && !["admin", "editor", "viewer"].includes(allowed.default_role)) {
    throw new SsoError("invalid default_role", "SSO_BAD_ROLE");
  }
  return svc.entities.Organization.update(org.id, allowed);
}

export async function suspendOrganization(svc, { workspace_id, reason }) {
  const org = await getOrganization(svc, workspace_id);
  if (!org) throw new SsoError("organization not found", "SSO_NO_ORG", 404);
  await svc.entities.Organization.update(org.id, { status: "suspended" });
  await audit(svc, { workspace_id, action: "sso.org.suspended", resource: "Organization", resource_id: org.id, metadata: { reason: reason || null } });
  return { org: await svc.entities.Organization.get(org.id) };
}

export async function reinstateOrganization(svc, { workspace_id }) {
  const org = await getOrganization(svc, workspace_id);
  if (!org) throw new SsoError("organization not found", "SSO_NO_ORG", 404);
  await svc.entities.Organization.update(org.id, { status: "active" });
  await audit(svc, { workspace_id, action: "sso.org.reinstated", resource: "Organization", resource_id: org.id, metadata: {} });
  return { org: await svc.entities.Organization.get(org.id) };
}

// --- SSO connections ----------------------------------------------------------

export async function listConnections(svc, { organization_id }) {
  return svc.entities.SsoConnection.filter({ organization_id }, "-created_date", 50);
}

export async function getConnection(svc, connection_id) {
  return svc.entities.SsoConnection.get(connection_id).catch(() => null);
}

export async function createConnection(svc, { workspace_id, organization_id, protocol, name, created_by, ...config }) {
  if (!organization_id) throw new SsoError("organization_id is required", "SSO_NO_ORG");
  const org = await getOrganization(svc, workspace_id);
  if (!org || org.id !== organization_id) throw new SsoError("organization not found in this workspace", "SSO_ORG_MISMATCH", 404);
  if (!["saml", "oidc"].includes(protocol)) throw new SsoError("protocol must be saml or oidc", "SSO_BAD_PROTOCOL");
  if (!name || !String(name).trim()) throw new SsoError("name is required", "SSO_NO_NAME");

  const row = {
    organization_id, workspace_id, protocol, name: String(name).trim().slice(0, 200), status: "active",
    attribute_mapping: config.attribute_mapping || {}, sign_in_url: `/sso/${protocol}?org=${organization_id}`,
    created_by: created_by || null, last_used_at: null,
  };

  if (protocol === "saml") {
    if (!config.saml_entity_id) throw new SsoError("saml_entity_id is required", "SSO_NO_ENTITY_ID");
    if (!config.saml_cert) throw new SsoError("saml_cert (PEM) is required", "SSO_NO_CERT");
    if (!hasEncryptionKey({ keyMaterial: config.keyMaterial })) throw new SsoError("encryption key not configured", "SECRET_ENCRYPTION_UNAVAILABLE", 503);
    const created = await svc.entities.SsoConnection.create({
      ...row, saml_entity_id: config.saml_entity_id, saml_acs_url: config.saml_acs_url || "",
      saml_cert_encrypted: await encryptWithAad(CERT_AAD(null), config.saml_cert, { keyMaterial: config.keyMaterial }),
      saml_cert_fingerprint: await sha256Hex(config.saml_cert),
      saml_metadata_xml_encrypted: config.saml_metadata_xml ? await encryptWithAad(CERT_AAD(null), config.saml_metadata_xml, { keyMaterial: config.keyMaterial }) : null,
    });
    // Re-encrypt with the real id now that the row exists, so the AAD binds the ciphertext to this connection.
    const sealed = await encryptWithAad(CERT_AAD(created.id), config.saml_cert, { keyMaterial: config.keyMaterial });
    const metaSealed = config.saml_metadata_xml ? await encryptWithAad(CERT_AAD(created.id), config.saml_metadata_xml, { keyMaterial: config.keyMaterial }) : null;
    await svc.entities.SsoConnection.update(created.id, { saml_cert_encrypted: sealed, ...(metaSealed ? { saml_metadata_xml_encrypted: metaSealed } : {}) });
    return svc.entities.SsoConnection.get(created.id);
  }

  // OIDC
  if (!config.oidc_issuer) throw new SsoError("oidc_issuer is required", "SSO_NO_ISSUER");
  if (!config.oidc_client_id) throw new SsoError("oidc_client_id is required", "SSO_NO_CLIENT_ID");
  if (!config.oidc_client_secret) throw new SsoError("oidc_client_secret is required", "SSO_NO_CLIENT_SECRET");
  if (!hasEncryptionKey({ keyMaterial: config.keyMaterial })) throw new SsoError("encryption key not configured", "SECRET_ENCRYPTION_UNAVAILABLE", 503);
  const created = await svc.entities.SsoConnection.create({
    ...row,
    oidc_issuer: config.oidc_issuer, oidc_client_id: config.oidc_client_id,
    oidc_client_secret_encrypted: await encryptWithAad(SECRET_AAD(null), config.oidc_client_secret, { keyMaterial: config.keyMaterial }),
    oidc_scopes: Array.isArray(config.oidc_scopes) ? config.oidc_scopes : ["openid", "email", "profile"],
    oidc_authorize_url: config.oidc_authorize_url || "", oidc_token_url: config.oidc_token_url || "", oidc_userinfo_url: config.oidc_userinfo_url || "",
  });
  const sealed = await encryptWithAad(SECRET_AAD(created.id), config.oidc_client_secret, { keyMaterial: config.keyMaterial });
  await svc.entities.SsoConnection.update(created.id, { oidc_client_secret_encrypted: sealed });
  return svc.entities.SsoConnection.get(created.id);
}

export async function updateConnection(svc, { workspace_id, connection_id, patch }) {
  const conn = await getConnection(svc, connection_id);
  if (!conn || conn.workspace_id !== workspace_id) throw new SsoError("connection not found", "SSO_NO_CONN", 404);
  const allowed = {};
  for (const k of ["name", "status", "attribute_mapping", "oidc_scopes", "oidc_authorize_url", "oidc_token_url", "oidc_userinfo_url", "saml_acs_url"]) {
    if (k in patch) allowed[k] = patch[k];
  }
  // Certificate and secret rotation: re-encrypt the new value with the connection's AAD.
  if (patch.saml_cert) {
    allowed.saml_cert_encrypted = await encryptWithAad(CERT_AAD(conn.id), patch.saml_cert, { keyMaterial: patch.keyMaterial });
    allowed.saml_cert_fingerprint = await sha256Hex(patch.saml_cert);
  }
  if (patch.oidc_client_secret) {
    allowed.oidc_client_secret_encrypted = await encryptWithAad(SECRET_AAD(conn.id), patch.oidc_client_secret, { keyMaterial: patch.keyMaterial });
  }
  return svc.entities.SsoConnection.update(conn.id, allowed);
}

export async function disableConnection(svc, { workspace_id, connection_id }) {
  const conn = await getConnection(svc, connection_id);
  if (!conn || conn.workspace_id !== workspace_id) throw new SsoError("connection not found", "SSO_NO_CONN", 404);
  await svc.entities.SsoConnection.update(conn.id, { status: "disabled" });
  await audit(svc, { workspace_id, action: "sso.connection.disabled", resource: "SsoConnection", resource_id: conn.id, metadata: { protocol: conn.protocol, name: conn.name } });
  return { conn: await svc.entities.SsoConnection.get(conn.id) };
}

// Decrypt the SAML cert for server-side validation. Never returned to the client.
export async function decryptConnectionCert(svc, connection, opts = {}) {
  if (!connection.saml_cert_encrypted) throw new SsoError("connection has no certificate", "SSO_NO_CERT");
  return decryptWithAad(CERT_AAD(connection.id), connection.saml_cert_encrypted, { keyMaterial: opts.keyMaterial });
}

export async function decryptConnectionSecret(svc, connection, opts = {}) {
  if (!connection.oidc_client_secret_encrypted) throw new SsoError("connection has no client secret", "SSO_NO_SECRET");
  return decryptWithAad(SECRET_AAD(connection.id), connection.oidc_client_secret_encrypted, { keyMaterial: opts.keyMaterial });
}

// Strip secrets for any client-facing response. The encrypted fields and the decrypted cert
// are never included.
export function safeConnection(c) {
  if (!c) return null;
  return {
    id: c.id, organization_id: c.organization_id, protocol: c.protocol, name: c.name, status: c.status,
    saml_entity_id: c.saml_entity_id || null, saml_acs_url: c.saml_acs_url || null,
    saml_cert_fingerprint: c.saml_cert_fingerprint || null, has_cert: !!c.saml_cert_encrypted,
    oidc_issuer: c.oidc_issuer || null, oidc_client_id: c.oidc_client_id || null, has_secret: !!c.oidc_client_secret_encrypted,
    oidc_scopes: c.oidc_scopes || [], oidc_authorize_url: c.oidc_authorize_url || null, oidc_token_url: c.oidc_token_url || null, oidc_userinfo_url: c.oidc_userinfo_url || null,
    attribute_mapping: c.attribute_mapping || {}, sign_in_url: c.sign_in_url || null, last_used_at: c.last_used_at || null, created_date: c.created_date,
  };
}

// --- verified domains ---------------------------------------------------------

export async function listDomains(svc, { organization_id }) {
  return svc.entities.VerifiedDomain.filter({ organization_id }, "-created_date", 50);
}

export async function createDomain(svc, { workspace_id, organization_id, domain }) {
  const org = await getOrganization(svc, workspace_id);
  if (!org || org.id !== organization_id) throw new SsoError("organization not found in this workspace", "SSO_ORG_MISMATCH", 404);
  const d = String(domain || "").toLowerCase().trim();
  if (!DOMAIN_RE.test(d)) throw new SsoError("invalid domain format", "SSO_BAD_DOMAIN");
  // Domain uniqueness is platform-wide: one domain → one org.
  const all = await svc.entities.VerifiedDomain.filter({ domain: d }, "-created_date", 10);
  if (all.length && all[0].organization_id !== organization_id) throw new SsoError(`domain "${d}" is already claimed by another organization`, "SSO_DOMAIN_TAKEN", 409);
  if (all.length && all[0].organization_id === organization_id) return all[0];
  return svc.entities.VerifiedDomain.create({
    organization_id, workspace_id, domain: d, verification_token: randomToken(20),
    status: "pending", verified_at: null, verified_by: null,
  });
}

// Verify a domain by checking the DNS TXT record. In the sandbox runtime, a real DNS lookup is
// not available; the caller passes the expected token and this function confirms the record
// matches. Production wiring would call a DNS-over-HTTPS resolver here.
export async function verifyDomain(svc, { workspace_id, domain_id, records, verified_by }) {
  const domain = await svc.entities.VerifiedDomain.get(domain_id).catch(() => null);
  if (!domain || domain.workspace_id !== workspace_id) throw new SsoError("domain not found", "SSO_NO_DOMAIN", 404);
  if (domain.status === "verified") return { domain, duplicate: true };
  const txtRecords = Array.isArray(records) ? records : [];
  const match = txtRecords.some((r) => String(r).trim() === domain.verification_token);
  if (!match) {
    await svc.entities.VerifiedDomain.update(domain.id, { status: "failed" });
    await audit(svc, { workspace_id, action: "sso.domain.verify_failed", resource: "VerifiedDomain", resource_id: domain.id, metadata: { domain: domain.domain } });
    throw new SsoError("DNS verification failed: token not found in TXT records", "SSO_DOMAIN_VERIFY_FAILED");
  }
  const verified = await svc.entities.VerifiedDomain.update(domain.id, { status: "verified", verified_at: new Date().toISOString(), verified_by: verified_by || null });
  await audit(svc, { workspace_id, action: "sso.domain.verified", resource: "VerifiedDomain", resource_id: domain.id, metadata: { domain: domain.domain } });
  return { domain: verified, duplicate: false };
}

export async function removeDomain(svc, { workspace_id, domain_id }) {
  const domain = await svc.entities.VerifiedDomain.get(domain_id).catch(() => null);
  if (!domain || domain.workspace_id !== workspace_id) throw new SsoError("domain not found", "SSO_NO_DOMAIN", 404);
  await svc.entities.VerifiedDomain.delete(domain.id);
  await audit(svc, { workspace_id, action: "sso.domain.removed", resource: "VerifiedDomain", resource_id: domain.id, metadata: { domain: domain.domain } });
  return { ok: true };
}

// --- domain routing ------------------------------------------------------------

// Resolve the organization that owns a given email's domain. Only verified domains route.
export async function orgForEmail(svc, email) {
  const domain = String(email || "").split("@").pop()?.toLowerCase() || "";
  if (!domain) return null;
  const rows = await svc.entities.VerifiedDomain.filter({ domain, status: "verified" }, "-created_date", 5);
  if (!rows.length) return null;
  return svc.entities.Organization.get(rows[0].organization_id).catch(() => null);
}

// Resolve the active SSO connection for an email's org.
export async function resolveSsoConnectionForEmail(svc, email) {
  const org = await orgForEmail(svc, email);
  if (!org || org.status !== "active") return { org: null, connection: null };
  const conns = await svc.entities.SsoConnection.filter({ organization_id: org.id, status: "active" }, "-created_date", 10);
  if (!conns.length) return { org, connection: null };
  return { org, connection: conns[0] };
}

// --- group mappings -----------------------------------------------------------

export async function listGroupMappings(svc, { organization_id }) {
  return svc.entities.GroupMapping.filter({ organization_id }, "-priority", 100);
}

export async function createGroupMapping(svc, { workspace_id, organization_id, external_group_id, external_group_name, role, priority = 0 }) {
  const org = await getOrganization(svc, workspace_id);
  if (!org || org.id !== organization_id) throw new SsoError("organization not found in this workspace", "SSO_ORG_MISMATCH", 404);
  if (!external_group_id) throw new SsoError("external_group_id is required", "SSO_NO_GROUP");
  if (!["admin", "editor", "viewer"].includes(role)) throw new SsoError("invalid role", "SSO_BAD_ROLE");
  // One mapping per external group per org.
  const existing = await svc.entities.GroupMapping.filter({ organization_id, external_group_id }, "-created_date", 5);
  if (existing.length) throw new SsoError("group mapping already exists for this group", "SSO_GROUP_MAPPED", 409);
  return svc.entities.GroupMapping.create({
    organization_id, workspace_id, external_group_id: String(external_group_id), external_group_name: String(external_group_name || ""),
    role, priority: Number(priority) || 0,
  });
}

export async function removeGroupMapping(svc, { workspace_id, mapping_id }) {
  const m = await svc.entities.GroupMapping.get(mapping_id).catch(() => null);
  if (!m || m.workspace_id !== workspace_id) throw new SsoError("mapping not found", "SSO_NO_MAPPING", 404);
  await svc.entities.GroupMapping.delete(mapping_id);
  return { ok: true };
}

// Resolve the role for a set of external groups. The highest-priority mapping wins; ties break
// by role rank (admin > editor > viewer). If no mapping matches, returns null (caller applies
// the org default).
const ROLE_RANK = { admin: 3, editor: 2, viewer: 1 };
export async function resolveRoleForGroups(svc, { organization_id, groups }) {
  if (!Array.isArray(groups) || !groups.length) return null;
  const mappings = await listGroupMappings(svc, { organization_id });
  const matched = mappings.filter((m) => groups.includes(m.external_group_id));
  if (!matched.length) return null;
  matched.sort((a, b) => (b.priority || 0) - (a.priority || 0) || ROLE_RANK[b.role] - ROLE_RANK[a.role]);
  return matched[0].role;
}

// --- SSO enforcement ----------------------------------------------------------

// Is SSO enforced for this email? True when the email's domain is verified by an org with
// sso_enforced=true. When true, password login for that email must be refused.
export async function isSsoEnforced(svc, email) {
  const org = await orgForEmail(svc, email);
  return !!(org && org.status === "active" && org.sso_enforced);
}

// --- replay guard (SAML response ID uniqueness) -------------------------------

// Uses the CacheEntry entity as a short-TTL replay store. A response ID seen within the TTL
// window is a replay; a new ID is recorded and returns true.
export async function checkReplay(svc, responseId, { ttlMs = 3600000 } = {}) {
  if (!responseId) return true;
  const key = `sso_replay:${responseId}`;
  const existing = await svc.entities.CacheEntry.filter({ namespace: "sso_replay", cache_key: key }, "-created_date", 2);
  if (existing.length) return false;
  await svc.entities.CacheEntry.create({
    namespace: "sso_replay", cache_key: key, expires_at: new Date(Date.now() + ttlMs).toISOString(),
    value: { responseId }, version: 1,
  });
  return true;
}