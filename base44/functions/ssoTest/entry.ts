// Enterprise SSO / SAML / SCIM — production verification suite.
//
// Exercises the full SSO lifecycle against live storage: organization setup, SAML connection
// with real RSA signature verification, domain verification, SCIM provisioning, group sync,
// SSO enforcement, cross-org isolation, org suspension, seat limits, encryption-at-rest, and
// RBAC. All work runs in a scratch workspace that is torn down at the end.
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  getOrganization, createOrganization, updateOrganization, suspendOrganization, reinstateOrganization,
  listConnections, createConnection, updateConnection, disableConnection, getConnection,
  decryptConnectionCert, decryptConnectionSecret, safeConnection,
  listDomains, createDomain, verifyDomain, removeDomain,
  listGroupMappings, createGroupMapping, removeGroupMapping, resolveRoleForGroups,
  orgForEmail, resolveSsoConnectionForEmail, isSsoEnforced, checkReplay,
} from "../../shared/sso.ts";
import {
  provisionUser, suspendUser, deprovisionUser, provisionGroup, syncUserGroups, listScimRecords,
} from "../../shared/scim.ts";
import { validateSamlResponse, canonicalizeAssertion, signAssertion } from "../../shared/saml.ts";
import { buildAuthorizeUrl, mapOidcClaims } from "../../shared/oidc.ts";
import { can, CAPABILITIES } from "../../shared/rbac.ts";

const KEY_MATERIAL = "sso-test-encryption-key-material-v1";
const AUDIENCE = "nexusai";
const ACS_URL = "https://app.nexusai.com/sso/acs";

function pemForPublicKey(spkiDer) {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(spkiDer)));
  return "-----BEGIN PUBLIC KEY-----\n" + b64.match(/.{1,64}/g).join("\n") + "\n-----END PUBLIC KEY-----";
}

function buildSamlResponse({ responseId, assertionId, issuer, audience, acsUrl, nameId, notBefore, notOnOrAfter, groups, sigB64 }) {
  const now = new Date().toISOString();
  const nb = notBefore || new Date(Date.now() - 60000).toISOString();
  const noa = notOnOrAfter || new Date(Date.now() + 600000).toISOString();
  const groupsXml = (groups || []).map((g) => `<saml:Attribute Name="groups"><saml:AttributeValue>${g}</saml:AttributeValue></saml:Attribute>`).join("");
  return `<samlp:Response ID="${responseId}" Destination="${acsUrl}"><saml:Issuer>${issuer}</saml:Issuer><saml:Assertion ID="${assertionId}" IssueInstant="${now}"><saml:Issuer>${issuer}</saml:Issuer><ds:Signature><ds:SignedInfo><ds:SignatureValue>${sigB64 || "PLACEHOLDER"}</ds:SignatureValue></ds:SignedInfo></ds:Signature><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID></saml:Subject><saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AttributeStatement>${groupsXml}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
}

async function makeSignedResponse(keyPair, params) {
  const placeholder = buildSamlResponse({ ...params, sigB64: "PLACEHOLDER" });
  const canonicalized = canonicalizeAssertion(placeholder);
  const sigB64 = await signAssertion(canonicalized, keyPair.privateKey);
  return buildSamlResponse({ ...params, sigB64 });
}

export default async function (req) {
  const h = createHarness();
  const svc = (await import("npm:@base44/sdk@0.8.53")).createClientFromRequest(req).asServiceRole;
  const track = { workspaces: [], orgs: [], connections: [], domains: [], mappings: [], scim: [], members: [], cache: [] };

  try {
    // --- scratch workspace + users ---
    const wsA = await svc.entities.Workspace.create({ name: "SSO Test A", owner_id: "u_sso_owner" });
    track.workspaces.push(wsA.id);
    const wsB = await svc.entities.Workspace.create({ name: "SSO Test B", owner_id: "u_sso_owner_b" });
    track.workspaces.push(wsB.id);

    // =========================================================== organization
    h.check("an org is created active", !!(await createOrganization(svc, { workspace_id: wsA.id, name: "Acme Corp", created_by: "u_sso_owner", default_role: "viewer", keyMaterial: KEY_MATERIAL })).id);
    h.check("a workspace can have only one org", await h.expectThrow("duplicate org", () => createOrganization(svc, { workspace_id: wsA.id, name: "Dup", created_by: "u" }), "SSO_ORG_EXISTS") !== false);
    const orgA = await getOrganization(svc, wsA.id);
    h.check("the org is retrievable", orgA.name === "Acme Corp");
    h.check("a new org defaults to not enforced", orgA.sso_enforced === false);
    h.check("a new org defaults to scim disabled", orgA.scim_enabled === false);

    const orgB = await createOrganization(svc, { workspace_id: wsB.id, name: "Beta Inc", created_by: "u_sso_owner_b", default_role: "editor", keyMaterial: KEY_MATERIAL });
    track.orgs.push(orgA.id, orgB.id);

    const updated = await updateOrganization(svc, { workspace_id: wsA.id, patch: { sso_enforced: true, scim_enabled: true, default_role: "editor" } });
    h.check("the org can be updated to enforced + scim", updated.sso_enforced === true && updated.scim_enabled === true && updated.default_role === "editor");

    // =========================================================== RBAC
    h.check("sso.manage is admin+ only", can("owner", "sso.manage") && can("admin", "sso.manage") && !can("editor", "sso.manage") && !can("viewer", "sso.manage"));
    h.check("sso.read is admin+ only", can("owner", "sso.read") && can("admin", "sso.read") && !can("editor", "sso.read"));
    h.check("scim.manage is admin+ only", can("owner", "scim.manage") && can("admin", "scim.manage") && !can("editor", "scim.manage"));

    // =========================================================== SAML connection
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    );
    const spkiDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const certPem = pemForPublicKey(spkiDer);

    h.check("a saml connection requires an entity_id", await h.expectThrow("no entity_id", () => createConnection(svc, { workspace_id: wsA.id, organization_id: orgA.id, protocol: "saml", name: "Okta", saml_cert: certPem, keyMaterial: KEY_MATERIAL }), "SSO_NO_ENTITY_ID") !== false);
    h.check("a saml connection requires a cert", await h.expectThrow("no cert", () => createConnection(svc, { workspace_id: wsA.id, organization_id: orgA.id, protocol: "saml", name: "Okta", saml_entity_id: "https://idp.acme.com", keyMaterial: KEY_MATERIAL }), "SSO_NO_CERT") !== false);

    const conn = await createConnection(svc, { workspace_id: wsA.id, organization_id: orgA.id, protocol: "saml", name: "Okta IdP", saml_entity_id: "https://idp.acme.com", saml_cert: certPem, saml_acs_url: ACS_URL, attribute_mapping: { groups: "groups", full_name: "name" }, keyMaterial: KEY_MATERIAL });
    track.connections.push(conn.id);
    h.check("the saml connection is active", conn.status === "active" && conn.protocol === "saml");
    h.check("the cert is encrypted at rest", typeof conn.saml_cert_encrypted === "string" && conn.saml_cert_encrypted.startsWith("enc:v1:"));
    h.check("the cert fingerprint is stored", typeof conn.saml_cert_fingerprint === "string" && conn.saml_cert_fingerprint.length > 0);
    h.check("safeConnection strips the encrypted cert", safeConnection(conn).saml_cert_encrypted === undefined && safeConnection(conn).has_cert === true);

    // Decryption with the right AAD returns the original cert.
    const decryptedCert = await decryptConnectionCert(svc, conn, { keyMaterial: KEY_MATERIAL });
    h.check("the cert decrypts to the original PEM", decryptedCert === certPem);

    // =========================================================== SAML validation
    const baseParams = { responseId: "resp-1", assertionId: "assert-1", issuer: "https://idp.acme.com", audience: AUDIENCE, acsUrl: ACS_URL, nameId: "alice@acme.com", groups: ["admins"] };
    const seen = new Set();
    const replayGuard = async (id) => { if (seen.has(id)) return false; seen.add(id); return true; };

    const validXml = await makeSignedResponse(keyPair, baseParams);
    const validResult = await validateSamlResponse(validXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: { groups: "groups" } }, { audience: AUDIENCE, acsUrl: ACS_URL, checkReplay: replayGuard });
    h.check("a valid signed SAML response passes", validResult.ok, validResult.errors.join(";"));
    h.check("the nameId is extracted as email", validResult.email === "alice@acme.com");
    h.check("the groups attribute is extracted", JSON.stringify(validResult.attributes.groups) === JSON.stringify(["admins"]));

    // Tampered assertion: change the nameId after signing.
    const tamperedXml = (await makeSignedResponse(keyPair, baseParams)).replace("alice@acme.com", "mallory@acme.com");
    const tamperedResult = await validateSamlResponse(tamperedXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: {} }, { audience: AUDIENCE, acsUrl: ACS_URL });
    h.check("a tampered assertion fails signature verification", !tamperedResult.ok && tamperedResult.errors.some((e) => e.includes("signature")));

    // Unsigned assertion.
    const unsignedXml = buildSamlResponse({ ...baseParams, sigB64: "" }).replace(/<ds:Signature>.*?<\/ds:Signature>/, "");
    const unsignedResult = await validateSamlResponse(unsignedXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: {} }, { audience: AUDIENCE, acsUrl: ACS_URL });
    h.check("an unsigned assertion is rejected", !unsignedResult.ok && unsignedResult.errors.some((e) => e.includes("not signed")));

    // Expired assertion.
    const expiredXml = await makeSignedResponse(keyPair, { ...baseParams, responseId: "resp-exp", assertionId: "assert-exp", notOnOrAfter: new Date(Date.now() - 60000).toISOString() });
    const expiredResult = await validateSamlResponse(expiredXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: {} }, { audience: AUDIENCE, acsUrl: ACS_URL });
    h.check("an expired assertion is rejected", !expiredResult.ok && expiredResult.errors.some((e) => e.includes("expired")));

    // Future assertion (NotBefore in the future).
    const futureXml = await makeSignedResponse(keyPair, { ...baseParams, responseId: "resp-fut", assertionId: "assert-fut", notBefore: new Date(Date.now() + 600000).toISOString(), notOnOrAfter: new Date(Date.now() + 1200000).toISOString() });
    const futureResult = await validateSamlResponse(futureXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: {} }, { audience: AUDIENCE, acsUrl: ACS_URL });
    h.check("a not-yet-valid assertion is rejected", !futureResult.ok && futureResult.errors.some((e) => e.includes("NotBefore")));

    // Wrong audience.
    const wrongAudXml = await makeSignedResponse(keyPair, { ...baseParams, responseId: "resp-aud", assertionId: "assert-aud", audience: "wrong-sp" });
    const wrongAudResult = await validateSamlResponse(wrongAudXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: {} }, { audience: AUDIENCE, acsUrl: ACS_URL });
    h.check("a wrong audience is rejected", !wrongAudResult.ok && wrongAudResult.errors.some((e) => e.includes("audience")));

    // Wrong issuer.
    const wrongIssuerXml = await makeSignedResponse(keyPair, { ...baseParams, responseId: "resp-iss", assertionId: "assert-iss", issuer: "https://evil.com" });
    const wrongIssuerResult = await validateSamlResponse(wrongIssuerXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: {} }, { audience: AUDIENCE, acsUrl: ACS_URL });
    h.check("a wrong issuer is rejected", !wrongIssuerResult.ok && wrongIssuerResult.errors.some((e) => e.includes("issuer")));

    // Replay.
    const replayXml = await makeSignedResponse(keyPair, { ...baseParams, responseId: "resp-replay", assertionId: "assert-replay" });
    const replaySeen = new Set();
    const replayGuard2 = async (id) => { if (replaySeen.has(id)) return false; replaySeen.add(id); return true; };
    const firstReplay = await validateSamlResponse(replayXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: {} }, { audience: AUDIENCE, acsUrl: ACS_URL, checkReplay: replayGuard2 });
    const secondReplay = await validateSamlResponse(replayXml, { saml_cert_decrypted: certPem, saml_entity_id: "https://idp.acme.com", saml_acs_url: ACS_URL, attribute_mapping: {} }, { audience: AUDIENCE, acsUrl: ACS_URL, checkReplay: replayGuard2 });
    h.check("the first use of a response ID passes", firstReplay.ok);
    h.check("a replayed response ID is rejected", !secondReplay.ok && secondReplay.errors.some((e) => e.includes("replay")));

    // =========================================================== OIDC connection
    const oidcConn = await createConnection(svc, { workspace_id: wsA.id, organization_id: orgA.id, protocol: "oidc", name: "Google", oidc_issuer: "https://accounts.google.com", oidc_client_id: "client-123", oidc_client_secret: "secret-456", oidc_scopes: ["openid", "email", "profile"], oidc_authorize_url: "https://accounts.google.com/o/oauth2/v2/auth", oidc_token_url: "https://oauth2.googleapis.com/token", oidc_userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo", keyMaterial: KEY_MATERIAL });
    track.connections.push(oidcConn.id);
    h.check("the oidc connection is active", oidcConn.status === "active" && oidcConn.protocol === "oidc");
    h.check("the oidc secret is encrypted at rest", typeof oidcConn.oidc_client_secret_encrypted === "string" && oidcConn.oidc_client_secret_encrypted.startsWith("enc:v1:"));
    h.check("safeConnection strips the secret", safeConnection(oidcConn).oidc_client_secret_encrypted === undefined && safeConnection(oidcConn).has_secret === true);
    const decryptedSecret = await decryptConnectionSecret(svc, oidcConn, { keyMaterial: KEY_MATERIAL });
    h.check("the oidc secret decrypts to the original", decryptedSecret === "secret-456");

    const authRes = buildAuthorizeUrl(oidcConn, { redirectUri: "https://app.nexusai.com/sso/oidc/callback" });
    h.check("the authorize url includes the client_id", authRes.url.includes("client_id=client-123"));
    h.check("the authorize url includes the redirect_uri", authRes.url.includes("redirect_uri="));
    h.check("the state is a non-empty challenge", typeof authRes.state === "string" && authRes.state.length > 0);

    const mapped = mapOidcClaims({ email: "BOB@acme.com", name: "Bob", groups: ["devs"] }, oidcConn);
    h.check("oidc claims are mapped and email is lowercased", mapped.email === "bob@acme.com" && mapped.full_name === "Bob" && JSON.stringify(mapped.groups) === JSON.stringify(["devs"]));

    // =========================================================== domain verification
    const domain = await createDomain(svc, { workspace_id: wsA.id, organization_id: orgA.id, domain: "acme.com" });
    track.domains.push(domain.id);
    h.check("a domain starts pending", domain.status === "pending");
    h.check("a verification token is generated", typeof domain.verification_token === "string" && domain.verification_token.length > 0);

    h.check("verification with the wrong token fails", await h.expectThrow("wrong token", () => verifyDomain(svc, { workspace_id: wsA.id, domain_id: domain.id, records: ["wrong-token"], verified_by: "u" }), "SSO_DOMAIN_VERIFY_FAILED") !== false);

    const verified = await verifyDomain(svc, { workspace_id: wsA.id, domain_id: domain.id, records: [domain.verification_token], verified_by: "u_sso_owner" });
    h.check("verification with the right token succeeds", verified.domain.status === "verified");

    h.check("another org cannot claim the same domain", await h.expectThrow("domain taken", () => createDomain(svc, { workspace_id: wsB.id, organization_id: orgB.id, domain: "acme.com" }), "SSO_DOMAIN_TAKEN") !== false);

    const domainB = await createDomain(svc, { workspace_id: wsB.id, organization_id: orgB.id, domain: "beta.io" });
    track.domains.push(domainB.id);
    await verifyDomain(svc, { workspace_id: wsB.id, domain_id: domainB.id, records: [domainB.verification_token], verified_by: "u" });

    // Domain routing.
    const routedOrg = await orgForEmail(svc, "alice@acme.com");
    h.check("an email routes to the owning org", routedOrg?.id === orgA.id);
    h.check("an email on an unverified domain routes nowhere", (await orgForEmail(svc, "user@unverified.com")) === null);

    const ssoRoute = await resolveSsoConnectionForEmail(svc, "alice@acme.com");
    h.check("sso routing resolves an active connection", ssoRoute.connection?.id === conn.id || ssoRoute.connection?.id === oidcConn.id);

    // =========================================================== SCIM provisioning
    h.check("scim on a non-verified domain is refused", await h.expectThrow("bad domain", () => provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-1", email: "user@unverified.com", keyMaterial: KEY_MATERIAL }), "SCIM_DOMAIN_NOT_VERIFIED") !== false);

    const prov1 = await provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-alice", email: "alice@acme.com", display_name: "Alice", groups: [], user_id: "u_sso_owner", keyMaterial: KEY_MATERIAL });
    track.scim.push(prov1.record.id);
    track.members.push(prov1.record.workspace_member_id);
    h.check("a scim provision creates a record", prov1.record.status === "active");
    h.check("a scim provision creates a workspace member", !!prov1.record.workspace_member_id);
    const member1 = await svc.entities.WorkspaceMember.get(prov1.record.workspace_member_id);
    h.check("the provisioned member is active with the org default role", member1.status === "active" && member1.role === "editor");

    // Idempotent re-provision.
    const prov1b = await provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-alice", email: "alice@acme.com", display_name: "Alice Updated", groups: [], user_id: "u_sso_owner", keyMaterial: KEY_MATERIAL });
    h.check("re-provisioning is idempotent (same record)", prov1b.record.id === prov1.record.id);
    h.check("re-provisioning updates the display name", prov1b.record.display_name === "Alice Updated");
    const members = await svc.entities.WorkspaceMember.filter({ workspace_id: wsA.id, email: "alice@acme.com" }, "-created_date", 5);
    h.check("re-provisioning does not duplicate the member", members.length === 1);

    // =========================================================== group mapping + sync
    const mapping = await createGroupMapping(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_group_id: "admins", external_group_name: "Admins", role: "admin", priority: 10 });
    track.mappings.push(mapping.id);
    h.check("a group mapping is created", mapping.role === "admin");
    h.check("a duplicate group mapping is refused", await h.expectThrow("dup mapping", () => createGroupMapping(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_group_id: "admins", role: "admin" }), "SSO_GROUP_MAPPED") !== false);

    h.check("resolveRoleForGroups returns the mapped role", await resolveRoleForGroups(svc, { organization_id: orgA.id, groups: ["admins"] }) === "admin");
    h.check("resolveRoleForGroups returns null for unmapped groups", await resolveRoleForGroups(svc, { organization_id: orgA.id, groups: ["unknown"] }) === null);

    // Provision a user in the admins group → role should be admin.
    const prov2 = await provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-bob", email: "bob@acme.com", display_name: "Bob", groups: ["admins"], user_id: "u_sso_owner", keyMaterial: KEY_MATERIAL });
    track.scim.push(prov2.record.id);
    track.members.push(prov2.record.workspace_member_id);
    const member2 = await svc.entities.WorkspaceMember.get(prov2.record.workspace_member_id);
    h.check("a user in a mapped group gets the group role", member2.role === "admin");

    // Sync groups: remove from admins group → role falls back to org default.
    const synced = await syncUserGroups(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-bob", groups: [], user_id: "u_sso_owner" });
    const member2b = await svc.entities.WorkspaceMember.get(prov2.record.workspace_member_id);
    h.check("group sync falls back to the org default role", synced.role === "editor" && member2b.role === "editor");

    // =========================================================== suspend + deprovision
    const suspended = await suspendUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-alice", user_id: "u_sso_owner" });
    h.check("suspension marks the record suspended", suspended.record.status === "suspended");
    const member1b = await svc.entities.WorkspaceMember.get(prov1.record.workspace_member_id);
    h.check("suspension deactivates the member", member1b.status === "suspended");

    // Re-provision a suspended user reactivates them.
    const reactivated = await provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-alice", email: "alice@acme.com", groups: [], user_id: "u_sso_owner", keyMaterial: KEY_MATERIAL });
    const member1c = await svc.entities.WorkspaceMember.get(prov1.record.workspace_member_id);
    h.check("re-provisioning a suspended user reactivates them", reactivated.record.status === "active" && member1c.status === "active");

    const deprov = await deprovisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-alice", user_id: "u_sso_owner" });
    h.check("deprovisioning marks the record deprovisioned", deprov.record.status === "deprovisioned");
    const member1d = await svc.entities.WorkspaceMember.get(prov1.record.workspace_member_id);
    h.check("deprovisioning removes the member", member1d.status === "removed");

    // =========================================================== SSO enforcement
    h.check("sso is enforced for a verified domain email", await isSsoEnforced(svc, "alice@acme.com") === true);
    h.check("sso is not enforced for an unverified domain email", await isSsoEnforced(svc, "user@unverified.com") === false);

    // Disable enforcement → no longer enforced.
    await updateOrganization(svc, { workspace_id: wsA.id, patch: { sso_enforced: false } });
    h.check("disabling enforcement removes the enforcement flag", await isSsoEnforced(svc, "alice@acme.com") === false);

    // =========================================================== seat limit
    await updateOrganization(svc, { workspace_id: wsA.id, patch: { max_seats: 1 } });
    h.check("provisioning beyond the seat limit is refused", await h.expectThrow("seat limit", () => provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-carol", email: "carol@acme.com", user_id: "u_sso_owner", keyMaterial: KEY_MATERIAL }), "SCIM_SEAT_LIMIT") !== false);
    // An existing active user within the limit is still re-provisionable.
    const withinLimit = await provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-bob", email: "bob@acme.com", groups: [], user_id: "u_sso_owner", keyMaterial: KEY_MATERIAL });
    h.check("an existing user within the limit is re-provisionable", withinLimit.record.status === "active");
    await updateOrganization(svc, { workspace_id: wsA.id, patch: { max_seats: 0 } });

    // =========================================================== org suspension
    await suspendOrganization(svc, { workspace_id: wsA.id, reason: "compliance hold" });
    h.check("a suspended org refuses scim provisioning", await h.expectThrow("suspended org", () => provisionUser(svc, { workspace_id: wsA.id, organization_id: orgA.id, external_id: "ext-dave", email: "dave@acme.com", user_id: "u_sso_owner", keyMaterial: KEY_MATERIAL }), "SCIM_ORG_SUSPENDED") !== false);
    const suspendedRoute = await resolveSsoConnectionForEmail(svc, "alice@acme.com");
    h.check("a suspended org does not route sso", suspendedRoute.org === null && suspendedRoute.connection === null);
    await reinstateOrganization(svc, { workspace_id: wsA.id });

    // =========================================================== connection disable
    await disableConnection(svc, { workspace_id: wsA.id, connection_id: conn.id });
    const disabledConns = (await listConnections(svc, { organization_id: orgA.id })).filter((c) => c.status === "active");
    h.check("a disabled connection is not active", disabledConns.every((c) => c.id !== conn.id));

    // =========================================================== cross-org isolation
    const orgBConnections = await listConnections(svc, { organization_id: orgB.id });
    h.check("org B has no connections from org A", orgBConnections.length === 0);
    const orgBDomains = await listDomains(svc, { organization_id: orgB.id });
    h.check("org B cannot see org A's domains", orgBDomains.every((d) => d.organization_id === orgB.id));
    h.check("org A's scim records are not visible to org B", (await listScimRecords(svc, { organization_id: orgB.id })).length === 0);

    // =========================================================== audit events
    const auditLogs = await svc.entities.AuditLog.filter({ workspace_id: wsA.id, action: { $in: ["sso.org.created", "sso.connection.created", "sso.domain.verified", "scim.user.provisioned", "scim.user.deprovisioned", "sso.org.suspended", "sso.org.reinstated"] } }, "-created_date", 100).catch(() => []);
    h.check("sso/scim audit events are recorded", auditLogs.length >= 5, `${auditLogs.length} audit events`);

    // =========================================================== cleanup
    for (const id of track.scim) await svc.entities.ScimRecord.delete(id).catch(() => {});
    for (const id of track.members) await svc.entities.WorkspaceMember.delete(id).catch(() => {});
    for (const id of track.mappings) await svc.entities.GroupMapping.delete(id).catch(() => {});
    for (const id of track.domains) await svc.entities.VerifiedDomain.delete(id).catch(() => {});
    for (const id of track.connections) await svc.entities.SsoConnection.delete(id).catch(() => {});
    for (const id of track.orgs) await svc.entities.Organization.delete(id).catch(() => {});
    const replayEntries = await svc.entities.CacheEntry.filter({ namespace: "sso_replay" }, "-created_date", 100).catch(() => []);
    for (const r of replayEntries) await svc.entities.CacheEntry.delete(r.id).catch(() => {});
    const auditRows = await svc.entities.AuditLog.filter({ workspace_id: wsA.id }, "-created_date", 500).catch(() => []);
    for (const r of auditRows) await svc.entities.AuditLog.delete(r.id).catch(() => {});
    const auditRowsB = await svc.entities.AuditLog.filter({ workspace_id: wsB.id }, "-created_date", 500).catch(() => []);
    for (const r of auditRowsB) await svc.entities.AuditLog.delete(r.id).catch(() => {});
    await cleanupWorkspace(svc, wsA.id, []);
    await cleanupWorkspace(svc, wsB.id, []);

    return harnessResponse(h);
  } catch (error) {
    // Best-effort cleanup on failure.
    for (const id of track.scim) await svc.entities.ScimRecord.delete(id).catch(() => {});
    for (const id of track.members) await svc.entities.WorkspaceMember.delete(id).catch(() => {});
    for (const id of track.mappings) await svc.entities.GroupMapping.delete(id).catch(() => {});
    for (const id of track.domains) await svc.entities.VerifiedDomain.delete(id).catch(() => {});
    for (const id of track.connections) await svc.entities.SsoConnection.delete(id).catch(() => {});
    for (const id of track.orgs) await svc.entities.Organization.delete(id).catch(() => {});
    for (const id of track.workspaces) await svc.entities.Workspace.delete(id).catch(() => {});
    return harnessError(h, error);
  }
}