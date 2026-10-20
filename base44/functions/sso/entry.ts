// Enterprise SSO / SCIM control plane.
//
// Dispatches organization management, SSO connection configuration, domain verification,
// group mappings, SCIM provisioning, SAML response validation, and OIDC exchange.
//
// SECURITY: every write resolves the caller's workspace role server-side and requires
// sso.manage or scim.manage. SAML/OIDC validation endpoints are authenticated by the
// connection's org, not by a user session — they are the IdP callback targets.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { audit } from "../../shared/authz.ts";
import { resolveRole, requireCapability, requireActiveWorkspace } from "../../shared/rbac.ts";
import { enforceLimit, identityFor } from "../../shared/apiLimits.ts";
import {
  getOrganization, createOrganization, updateOrganization, suspendOrganization, reinstateOrganization,
  listConnections, getConnection, createConnection, updateConnection, disableConnection,
  decryptConnectionCert, decryptConnectionSecret, safeConnection,
  listDomains, createDomain, verifyDomain, removeDomain,
  listGroupMappings, createGroupMapping, removeGroupMapping,
  isSsoEnforced, resolveSsoConnectionForEmail, checkReplay,
} from "../../shared/sso.ts";
import {
  provisionUser, suspendUser, deprovisionUser, provisionGroup, syncUserGroups, listScimRecords,
} from "../../shared/scim.ts";
import { validateSamlResponse } from "../../shared/saml.ts";
import { buildAuthorizeUrl, exchangeOidcCode, fetchOidcUserInfo, mapOidcClaims } from "../../shared/oidc.ts";
import { assertSsoEntitlement, assertScimEntitlement } from "../../shared/planLimits.ts";

const WRITES = ["create_org", "update_org", "suspend_org", "reinstate_org", "create_connection", "update_connection", "disable_connection", "create_domain", "verify_domain", "remove_domain", "create_group_mapping", "remove_group_mapping", "provision_user", "suspend_user", "deprovision_user", "provision_group", "sync_groups"];

// SCIM provisioning actions dispatched through this entry — gated by the scim entitlement, not sso.
const SCIM_ACTIONS = ["provision_user", "suspend_user", "deprovision_user", "provision_group", "sync_groups", "list_scim_records"];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "get_org");
    const workspaceId = String(body.workspace_id || "");

    const isPublic = ["validate_saml", "oidc_authorize", "oidc_callback", "enforcement_check"].includes(action);

    let role = null, workspace = null;
    if (workspaceId) {
      workspace = await svc.entities.Workspace.get(workspaceId).catch(() => null);
      if (!workspace && !isPublic) return Response.json({ error: "Workspace not found" }, { status: 404 });
      if (workspace) role = await resolveRole(base44, workspace, user);
      if (workspace && !role && !isPublic) return Response.json({ error: "Forbidden", code: "NOT_A_MEMBER" }, { status: 403 });
    } else if (!isPublic) {
      return Response.json({ error: "workspace_id is required" }, { status: 400 });
    }

    // G-2 lifecycle: identity, domain and SCIM configuration is refused while the workspace
    // is suspended/terminated; reads and the public SSO flows stay available.
    if (WRITES.includes(action)) requireActiveWorkspace(workspace);

    // SSO/SCIM are workspace Enterprise entitlements: every authenticated management action (and
    // the non-public reads) requires a plan whose entitlements.sso / entitlements.scim is true.
    // The public IdP flows (validate_saml, oidc_*, enforcement_check) are authenticated by the
    // connection's org, not a user session, and stay ungated. Resolved server-side; the existing
    // role/capability checks below still run unchanged.
    if (workspace && !isPublic) {
      if (SCIM_ACTIONS.includes(action)) await assertScimEntitlement(base44, workspace);
      else await assertSsoEntitlement(base44, workspace);
    }

    if (WRITES.includes(action)) {
      await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspaceId }), action: "billing_write", workspace_id: workspaceId });
      requireCapability(role, (action.startsWith("provision") || action === "sync_groups") ? "scim.manage" : "sso.manage");
    }

    // --- organization ---
    if (action === "get_org") {
      const org = await getOrganization(svc, workspaceId);
      return Response.json({ org });
    }
    if (action === "create_org") {
      const org = await createOrganization(svc, { workspace_id: workspaceId, name: body.name, created_by: user.id, default_role: body.default_role, sso_enforced: body.sso_enforced, scim_enabled: body.scim_enabled, max_seats: body.max_seats });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.org.created", resource: "Organization", resource_id: org.id, metadata: { name: org.name } });
      return Response.json({ org });
    }
    if (action === "update_org") {
      const org = await updateOrganization(svc, { workspace_id: workspaceId, patch: body.patch || {} });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.org.updated", resource: "Organization", resource_id: org.id, metadata: body.patch || {} });
      return Response.json({ org });
    }
    if (action === "suspend_org") {
      const res = await suspendOrganization(svc, { workspace_id: workspaceId, reason: body.reason });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.org.suspended", resource: "Organization", resource_id: res.org.id, metadata: { reason: body.reason || null } });
      return Response.json({ org: res.org });
    }
    if (action === "reinstate_org") {
      const res = await reinstateOrganization(svc, { workspace_id: workspaceId });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.org.reinstated", resource: "Organization", resource_id: res.org.id, metadata: {} });
      return Response.json({ org: res.org });
    }

    // --- connections ---
    if (action === "list_connections") {
      requireCapability(role, "sso.read");
      const org = await getOrganization(svc, workspaceId);
      const connections = org ? await listConnections(svc, { organization_id: org.id }) : [];
      return Response.json({ connections: connections.map(safeConnection) });
    }
    if (action === "create_connection") {
      const org = await getOrganization(svc, workspaceId);
      if (!org) return Response.json({ error: "Create an organization first" }, { status: 400 });
      const conn = await createConnection(svc, { workspace_id: workspaceId, organization_id: org.id, protocol: body.protocol, name: body.name, created_by: user.id, saml_entity_id: body.saml_entity_id, saml_cert: body.saml_cert, saml_acs_url: body.saml_acs_url, saml_metadata_xml: body.saml_metadata_xml, oidc_issuer: body.oidc_issuer, oidc_client_id: body.oidc_client_id, oidc_client_secret: body.oidc_client_secret, oidc_scopes: body.oidc_scopes, oidc_authorize_url: body.oidc_authorize_url, oidc_token_url: body.oidc_token_url, oidc_userinfo_url: body.oidc_userinfo_url, attribute_mapping: body.attribute_mapping });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.connection.created", resource: "SsoConnection", resource_id: conn.id, metadata: { protocol: conn.protocol, name: conn.name } });
      return Response.json({ connection: safeConnection(conn) });
    }
    if (action === "update_connection") {
      const conn = await updateConnection(svc, { workspace_id: workspaceId, connection_id: body.connection_id, patch: body.patch || {} });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.connection.updated", resource: "SsoConnection", resource_id: conn.id, metadata: { fields: Object.keys(body.patch || {}) } });
      return Response.json({ connection: safeConnection(conn) });
    }
    if (action === "disable_connection") {
      const res = await disableConnection(svc, { workspace_id: workspaceId, connection_id: body.connection_id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.connection.disabled", resource: "SsoConnection", resource_id: res.conn.id, metadata: {} });
      return Response.json({ connection: safeConnection(res.conn) });
    }

    // --- domains ---
    if (action === "list_domains") {
      requireCapability(role, "sso.read");
      const org = await getOrganization(svc, workspaceId);
      const domains = org ? await listDomains(svc, { organization_id: org.id }) : [];
      return Response.json({ domains });
    }
    if (action === "create_domain") {
      const org = await getOrganization(svc, workspaceId);
      if (!org) return Response.json({ error: "Create an organization first" }, { status: 400 });
      const domain = await createDomain(svc, { workspace_id: workspaceId, organization_id: org.id, domain: body.domain });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.domain.created", resource: "VerifiedDomain", resource_id: domain.id, metadata: { domain: domain.domain } });
      return Response.json({ domain });
    }
    if (action === "verify_domain") {
      const org = await getOrganization(svc, workspaceId);
      const domains = org ? await listDomains(svc, { organization_id: org.id }) : [];
      const domain = domains.find((d) => d.id === body.domain_id);
      if (!domain) return Response.json({ error: "Domain not found" }, { status: 404 });
      const res = await verifyDomain(svc, { workspace_id: workspaceId, domain_id: domain.id, records: body.records, verified_by: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.domain.verified", resource: "VerifiedDomain", resource_id: res.domain.id, metadata: { domain: res.domain.domain, duplicate: res.duplicate === true } });
      return Response.json({ domain: res.domain, duplicate: res.duplicate });
    }
    if (action === "remove_domain") {
      const res = await removeDomain(svc, { workspace_id: workspaceId, domain_id: body.domain_id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.domain.removed", resource: "VerifiedDomain", resource_id: body.domain_id, metadata: {} });
      return Response.json(res);
    }

    // --- group mappings ---
    if (action === "list_group_mappings") {
      requireCapability(role, "sso.read");
      const org = await getOrganization(svc, workspaceId);
      const mappings = org ? await listGroupMappings(svc, { organization_id: org.id }) : [];
      return Response.json({ mappings });
    }
    if (action === "create_group_mapping") {
      const org = await getOrganization(svc, workspaceId);
      if (!org) return Response.json({ error: "Create an organization first" }, { status: 400 });
      const mapping = await createGroupMapping(svc, { workspace_id: workspaceId, organization_id: org.id, external_group_id: body.external_group_id, external_group_name: body.external_group_name, role: body.role, priority: body.priority });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.group_mapping.created", resource: "GroupMapping", resource_id: mapping.id, metadata: { external_group_id: body.external_group_id, role: body.role } });
      return Response.json({ mapping });
    }
    if (action === "remove_group_mapping") {
      const res = await removeGroupMapping(svc, { workspace_id: workspaceId, mapping_id: body.mapping_id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "sso.group_mapping.removed", resource: "GroupMapping", resource_id: body.mapping_id, metadata: {} });
      return Response.json(res);
    }

    // --- SCIM ---
    if (action === "provision_user") {
      const org = await getOrganization(svc, workspaceId);
      if (!org) return Response.json({ error: "Create an organization first" }, { status: 400 });
      const res = await provisionUser(svc, { workspace_id: workspaceId, organization_id: org.id, external_id: body.external_id, email: body.email, display_name: body.display_name, groups: body.groups, active: body.active !== false, user_id: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "scim.user.provisioned", resource: "ScimRecord", resource_id: res.record.id, metadata: { external_id: body.external_id, duplicate: res.duplicate === true } });
      return Response.json({ record: res.record, duplicate: res.duplicate });
    }
    if (action === "suspend_user") {
      const org = await getOrganization(svc, workspaceId);
      if (!org) return Response.json({ error: "Create an organization first" }, { status: 400 });
      const res = await suspendUser(svc, { workspace_id: workspaceId, organization_id: org.id, external_id: body.external_id, user_id: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "scim.user.suspended", resource: "ScimRecord", resource_id: res.record.id, metadata: { external_id: body.external_id } });
      return Response.json({ record: res.record });
    }
    if (action === "deprovision_user") {
      const org = await getOrganization(svc, workspaceId);
      if (!org) return Response.json({ error: "Create an organization first" }, { status: 400 });
      const res = await deprovisionUser(svc, { workspace_id: workspaceId, organization_id: org.id, external_id: body.external_id, user_id: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "scim.user.deprovisioned", resource: "ScimRecord", resource_id: res.record.id, metadata: { external_id: body.external_id } });
      return Response.json({ record: res.record });
    }
    if (action === "provision_group") {
      const org = await getOrganization(svc, workspaceId);
      if (!org) return Response.json({ error: "Create an organization first" }, { status: 400 });
      const res = await provisionGroup(svc, { workspace_id: workspaceId, organization_id: org.id, external_id: body.external_id, display_name: body.display_name, role: body.role, user_id: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "scim.group.provisioned", resource: "ScimRecord", resource_id: res.record.id, metadata: { external_id: body.external_id, role: body.role || null } });
      return Response.json({ record: res.record });
    }
    if (action === "sync_groups") {
      const org = await getOrganization(svc, workspaceId);
      if (!org) return Response.json({ error: "Create an organization first" }, { status: 400 });
      const res = await syncUserGroups(svc, { workspace_id: workspaceId, organization_id: org.id, external_id: body.external_id, groups: body.groups, user_id: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "scim.user.groups_synced", resource: "ScimRecord", resource_id: res.record.id, metadata: { external_id: body.external_id, role: res.role || null } });
      return Response.json({ record: res.record, role: res.role });
    }
    if (action === "list_scim_records") {
      requireCapability(role, "sso.read");
      const org = await getOrganization(svc, workspaceId);
      const records = org ? await listScimRecords(svc, { organization_id: org.id, resource_type: body.resource_type, status: body.status, limit: body.limit || 200 }) : [];
      return Response.json({ records });
    }

    // --- SAML validation (ACS endpoint) ---
    if (action === "validate_saml") {
      const conn = await getConnection(svc, String(body.connection_id || ""));
      if (!conn || conn.status !== "active") return Response.json({ error: "Connection not found or disabled" }, { status: 404 });
      const org = await svc.entities.Organization.get(conn.organization_id).catch(() => null);
      if (!org || org.status !== "active") return Response.json({ error: "Organization suspended" }, { status: 403 });
      const certPem = await decryptConnectionCert(svc, conn);
      const result = await validateSamlResponse(String(body.saml_response || ""), { ...conn, saml_cert_decrypted: certPem }, {
        audience: body.audience || "nexusai",
        acsUrl: conn.saml_acs_url,
        checkReplay: (id) => checkReplay(svc, id),
      });
      if (result.ok) {
        await svc.entities.SsoConnection.update(conn.id, { last_used_at: new Date().toISOString() }).catch(() => {});
        await audit(svc, { workspace_id: conn.workspace_id, action: "sso.login.succeeded", resource: "SsoConnection", resource_id: conn.id, metadata: { email: result.email, responseId: result.responseId } });
      } else {
        await audit(svc, { workspace_id: conn.workspace_id, action: "sso.login.failed", resource: "SsoConnection", resource_id: conn.id, metadata: { errors: result.errors } });
      }
      return Response.json(result);
    }

    // --- OIDC ---
    if (action === "oidc_authorize") {
      const conn = await getConnection(svc, String(body.connection_id || ""));
      if (!conn || conn.status !== "active" || conn.protocol !== "oidc") return Response.json({ error: "Connection not found" }, { status: 404 });
      const res = buildAuthorizeUrl(conn, { redirectUri: body.redirect_uri });
      return Response.json(res);
    }
    if (action === "oidc_callback") {
      const conn = await getConnection(svc, String(body.connection_id || ""));
      if (!conn || conn.status !== "active" || conn.protocol !== "oidc") return Response.json({ error: "Connection not found" }, { status: 404 });
      const clientSecret = await decryptConnectionSecret(svc, conn);
      const tokens = await exchangeOidcCode(conn, { code: body.code, redirectUri: body.redirect_uri, client_secret: clientSecret });
      const userinfo = await fetchOidcUserInfo(tokens.access_token, conn);
      const mapped = mapOidcClaims(userinfo, conn);
      await svc.entities.SsoConnection.update(conn.id, { last_used_at: new Date().toISOString() }).catch(() => {});
      await audit(svc, { workspace_id: conn.workspace_id, action: "sso.oidc.login", resource: "SsoConnection", resource_id: conn.id, metadata: { email: mapped.email } });
      return Response.json({ user: mapped, tokens: { access_token: tokens.access_token, id_token: tokens.id_token } });
    }

    // --- enforcement ---
    if (action === "enforcement_check") {
      const enforced = await isSsoEnforced(svc, String(body.email || ""));
      const { org, connection } = await resolveSsoConnectionForEmail(svc, String(body.email || ""));
      return Response.json({ enforced, org: org ? { id: org.id, name: org.name, sso_enforced: org.sso_enforced } : null, connection: connection ? safeConnection(connection) : null });
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}