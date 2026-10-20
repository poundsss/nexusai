// Enterprise frontend integration verification.
//
// Verifies the data contracts and security boundaries the Enterprise frontend depends on:
//   • safeConnection strips every secret field (cert, encrypted cert, OIDC secret) — the
//     ConnectionCard component never receives a value it could leak
//   • domain records carry the verification_token and status the DomainRow renders
//   • group mapping records carry the external_group_id, role and priority GroupMappingRow renders
//   • SCIM records carry the email, mapped_role, external_groups and status ScimUserRow renders
//   • the RBAC capability matrix the sidebar uses to show/hide enterprise nav is correct
//   • cross-org isolation: one org's connections/domains/mappings are invisible to another
//
// All work runs in a scratch workspace torn down at the end.
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  getOrganization, createOrganization, updateOrganization,
  listConnections, createConnection, safeConnection,
  listDomains, createDomain, verifyDomain,
  listGroupMappings, createGroupMapping,
} from "../../shared/sso.ts";
import { provisionUser, listScimRecords } from "../../shared/scim.ts";
import { can, CAPABILITIES, capabilitiesFor } from "../../shared/rbac.ts";

const KEY_MATERIAL = "enterprise-frontend-test-key-v1";

export default async function (req) {
  const h = createHarness();
  const svc = (await import("npm:@base44/sdk@0.8.53")).createClientFromRequest(req).asServiceRole;
  const track = { workspaces: [], orgs: [], connections: [], domains: [], mappings: [], scim: [], members: [] };

  try {
    // --- scratch workspace + two orgs (for isolation) ---
    const wsA = await svc.entities.Workspace.create({ name: "Ent FE Test A", owner_id: "u_ent_owner_a" });
    track.workspaces.push(wsA.id);
    const wsB = await svc.entities.Workspace.create({ name: "Ent FE Test B", owner_id: "u_ent_owner_b" });
    track.workspaces.push(wsB.id);

    const orgA = await createOrganization(svc, { workspace_id: wsA.id, name: "Acme Enterprise", created_by: "u_ent_owner_a", default_role: "viewer", keyMaterial: KEY_MATERIAL });
    const orgB = await createOrganization(svc, { workspace_id: wsB.id, name: "Beta Enterprise", created_by: "u_ent_owner_b", default_role: "editor", keyMaterial: KEY_MATERIAL });
    track.orgs.push(orgA.id, orgB.id);

    // =========================================================== RBAC visibility
    // The sidebar shows the Enterprise nav group only when the caller has sso.read.
    h.check("sso.read is held by owner and admin only", can("owner", "sso.read") && can("admin", "sso.read") && !can("editor", "sso.read") && !can("viewer", "sso.read"));
    h.check("sso.manage is held by owner and admin only", can("owner", "sso.manage") && can("admin", "sso.manage") && !can("editor", "sso.manage"));
    h.check("scim.manage is held by owner and admin only", can("owner", "scim.manage") && can("admin", "scim.manage") && !can("editor", "scim.manage"));
    h.check("capabilitiesFor(owner) includes all enterprise capabilities", ["sso.read", "sso.manage", "scim.manage", "member.manage"].every((c) => capabilitiesFor("owner").includes(c)));
    h.check("capabilitiesFor(viewer) excludes all enterprise capabilities", ["sso.read", "sso.manage", "scim.manage"].every((c) => !capabilitiesFor("viewer").includes(c)));

    // =========================================================== SAML connection — secret stripping
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    );
    const spkiDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const certPem = "-----BEGIN PUBLIC KEY-----\n" + btoa(String.fromCharCode(...new Uint8Array(spkiDer))).match(/.{1,64}/g).join("\n") + "\n-----END PUBLIC KEY-----";

    const samlConn = await createConnection(svc, { workspace_id: wsA.id, organization_id: orgA.id, protocol: "saml", name: "Okta IdP", saml_entity_id: "https://idp.acme.com", saml_cert: certPem, saml_acs_url: "https://app.nexusai.com/sso/acs", keyMaterial: KEY_MATERIAL });
    track.connections.push(samlConn.id);

    const safeSaml = safeConnection(samlConn);
    // The ConnectionCard component renders these fields — verify they exist and secrets don't.
    h.check("safeConnection returns the fields ConnectionCard renders", ["id", "protocol", "name", "status", "saml_entity_id", "saml_acs_url", "saml_cert_fingerprint", "has_cert", "sign_in_url"].every((k) => k in safeSaml));
    h.check("safeConnection strips the encrypted SAML cert", !("saml_cert_encrypted" in safeSaml) && !("saml_cert" in safeSaml));
    h.check("safeConnection exposes has_cert boolean, not the value", safeSaml.has_cert === true && typeof safeSaml.has_cert === "boolean");
    h.check("safeConnection exposes the fingerprint, not the cert", typeof safeSaml.saml_cert_fingerprint === "string" && safeSaml.saml_cert_fingerprint.length > 0);
    h.check("the raw connection has the encrypted cert at rest", typeof samlConn.saml_cert_encrypted === "string" && samlConn.saml_cert_encrypted.startsWith("enc:v1:"));

    // =========================================================== OIDC connection — secret stripping
    const oidcConn = await createConnection(svc, { workspace_id: wsA.id, organization_id: orgA.id, protocol: "oidc", name: "Google Workspace", oidc_issuer: "https://accounts.google.com", oidc_client_id: "test-client-id", oidc_client_secret: "super-secret-value", oidc_scopes: ["openid", "email", "profile"], keyMaterial: KEY_MATERIAL });
    track.connections.push(oidcConn.id);

    const safeOidc = safeConnection(oidcConn);
    h.check("safeConnection returns the OIDC fields ConnectionCard renders", ["oidc_issuer", "oidc_client_id", "has_secret", "oidc_scopes"].every((k) => k in safeOidc));
    h.check("safeConnection strips the encrypted OIDC secret", !("oidc_client_secret_encrypted" in safeOidc) && !("oidc_client_secret" in safeOidc));
    h.check("safeConnection exposes has_secret boolean, not the value", safeOidc.has_secret === true && typeof safeOidc.has_secret === "boolean");
    h.check("safeConnection exposes the client_id (not secret)", safeOidc.oidc_client_id === "test-client-id");
    h.check("safeConnection exposes scopes as an array", Array.isArray(safeOidc.oidc_scopes) && safeOidc.oidc_scopes.length === 3);
    h.check("the raw connection has the encrypted secret at rest", typeof oidcConn.oidc_client_secret_encrypted === "string" && oidcConn.oidc_client_secret_encrypted.startsWith("enc:v1:"));

    // =========================================================== Connections list — safe projection
    const allConns = await listConnections(svc, { organization_id: orgA.id });
    h.check("listConnections returns all connections", allConns.length === 2);
    const allSafe = allConns.map(safeConnection);
    h.check("every listed connection is safe (no encrypted fields)", allSafe.every((c) => !("saml_cert_encrypted" in c) && !("oidc_client_secret_encrypted" in c)));

    // =========================================================== Domain — record shape
    const domain = await createDomain(svc, { workspace_id: wsA.id, organization_id: orgA.id, domain: "acme-test.com" });
    track.domains.push(domain.id);
    h.check("a new domain starts pending", domain.status === "pending");
    h.check("the domain record carries a verification_token for DomainRow", typeof domain.verification_token === "string" && domain.verification_token.length > 0);
    h.check("the domain record carries the domain name", domain.domain === "acme-test.com");
    h.check("the domain record carries organization_id and workspace_id", domain.organization_id === orgA.id && domain.workspace_id === wsA.id);

    // Verify the domain (the verifyDomain function checks the token against provided records)
    const verified = await verifyDomain(svc, { workspace_id: wsA.id, domain_id: domain.id, records: [domain.verification_token], verified_by: "u_ent_owner_a" });
    h.check("domain verification succeeds with the correct token", verified.domain.status === "verified");
    h.check("verified domain carries verified_at", typeof verified.domain.verified_at === "string");

    // =========================================================== Group mapping — record shape
    const mapping = await createGroupMapping(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_group_id: "admins", external_group_name: "Administrators", role: "admin", priority: 10 });
    track.mappings.push(mapping.id);
    h.check("the group mapping carries external_group_id for GroupMappingRow", mapping.external_group_id === "admins");
    h.check("the group mapping carries role for GroupMappingRow", mapping.role === "admin");
    h.check("the group mapping carries priority for GroupMappingRow", mapping.priority === 10);
    h.check("the group mapping carries external_group_name", mapping.external_group_name === "Administrators");

    const allMappings = await listGroupMappings(svc, { organization_id: orgA.id });
    h.check("listGroupMappings returns the mapping", allMappings.length === 1 && allMappings[0].id === mapping.id);

    // =========================================================== SCIM — provisioning + record shape
    await updateOrganization(svc, { workspace_id: wsA.id, patch: { scim_enabled: true } });
    const provisioned = await provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "idp-alice-001", email: "alice@acme-test.com", display_name: "Alice Smith", groups: ["admins"], active: true, user_id: "u_ent_owner_a" });
    track.scim.push(provisioned.record.id);
    h.check("SCIM provisioning creates a record", !!provisioned.record.id);
    h.check("the SCIM record carries email for ScimUserRow", provisioned.record.email === "alice@acme-test.com");
    h.check("the SCIM record carries external_id for ScimUserRow", provisioned.record.external_id === "idp-alice-001");
    h.check("the SCIM record carries mapped_role for ScimUserRow", provisioned.record.mapped_role === "admin");
    h.check("the SCIM record carries external_groups for ScimUserRow", Array.isArray(provisioned.record.external_groups) && provisioned.record.external_groups.includes("admins"));
    h.check("the SCIM record carries status for ScimUserRow", provisioned.record.status === "active");
    h.check("the SCIM record carries display_name", provisioned.record.display_name === "Alice Smith");
    h.check("the SCIM record carries last_synced_at", typeof provisioned.record.last_synced_at === "string");

    // List SCIM records — the shape the ScimProvisionForm/ScimUserRow components consume
    const scimRecords = await listScimRecords(svc, { organization_id: orgA.id, resource_type: "user" });
    h.check("listScimRecords returns the provisioned user", scimRecords.length >= 1 && scimRecords.some((r) => r.external_id === "idp-alice-001"));

    // =========================================================== SSO enforcement toggle
    const enforced = await updateOrganization(svc, { workspace_id: wsA.id, patch: { sso_enforced: true } });
    h.check("SSO enforcement can be toggled on", enforced.sso_enforced === true);
    const unenforced = await updateOrganization(svc, { workspace_id: wsA.id, patch: { sso_enforced: false } });
    h.check("SSO enforcement can be toggled off", unenforced.sso_enforced === false);

    // =========================================================== Cross-org isolation
    const orgBConns = await listConnections(svc, { organization_id: orgB.id });
    const orgBDomains = await listDomains(svc, { organization_id: orgB.id });
    const orgBMappings = await listGroupMappings(svc, { organization_id: orgB.id });
    h.check("org B has no connections from org A", orgBConns.length === 0);
    h.check("org B has no domains from org A", orgBDomains.length === 0);
    h.check("org B has no group mappings from org A", orgBMappings.length === 0);

    // =========================================================== Organization record shape
    const orgRecord = await getOrganization(svc, wsA.id);
    h.check("the org record carries name for the Enterprise overview", orgRecord.name === "Acme Enterprise");
    h.check("the org record carries sso_enforced for the Enterprise overview", typeof orgRecord.sso_enforced === "boolean");
    h.check("the org record carries scim_enabled for the Enterprise overview", typeof orgRecord.scim_enabled === "boolean");
    h.check("the org record carries default_role for the Enterprise overview", orgRecord.default_role === "viewer");
    h.check("the org record carries status for the Enterprise overview", orgRecord.status === "active");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    await cleanupWorkspace(svc, track.workspaces[0], ["Organization", "SsoConnection", "VerifiedDomain", "GroupMapping", "ScimRecord", "WorkspaceMember", "AuditLog", "CacheEntry"]);
    await cleanupWorkspace(svc, track.workspaces[1], ["Organization", "SsoConnection", "VerifiedDomain", "GroupMapping", "ScimRecord", "WorkspaceMember", "AuditLog", "CacheEntry"]);
  }
}