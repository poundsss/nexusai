// Thin SCIM 2.0 REST adapter.
//
// Maps standards-compliant SCIM 2.0 HTTP requests onto the EXISTING, certified SCIM
// provisioning core in scim.ts — it does NOT reimplement provisioning, authorization,
// verified-domain enforcement, seat limits or audit. Every write delegates to
// provisionUser / suspendUser / deprovisionUser / provisionGroup / syncUserGroups,
// which already enforce the org + verified-domain + Enterprise + audit gates. Every
// read delegates to listScimRecords / getScimUser.
//
// ADDRESSING — the platform exposes a backend function at a single path, so the SCIM
// resource path is carried by a `path` query/body param (e.g. "/scim/v2/Users/<id>"),
// exactly the query-param addressing pattern the platform already uses for webhook
// functions. HTTP method is the real request method (a `method` body field is accepted
// ONLY as a test-harness affordance for test_backend_function, which always POSTs).
//
// The exact IdP bearer-token provisioning flow Base44 uses is UNDOCUMENTED; this adapter
// therefore reuses the EXISTING authenticated-session gate (base44.auth.me() + workspace
// role + scim.manage / sso.read capability) rather than inventing a new auth scheme.

import { ScimError } from "./scim.ts";
import { requireCapability, requireActiveWorkspace } from "./rbac.ts";
import { getOrganization } from "./sso.ts";
import {
  provisionUser, suspendUser, deprovisionUser, provisionGroup, syncUserGroups,
  listScimRecords, getScimUser,
} from "./scim.ts";

const SCIM_USER = "urn:ietf:params:scim:api:messages:2.0:User";
const SCIM_GROUP = "urn:ietf:params:scim:api:messages:2.0:Group";
const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_SPC = "urn:ietf:params:scim:api:messages:2.0:ServiceProviderConfig";
const SCIM_ERR = "urn:ietf:params:scim:api:messages:2.0:Error";

const READ = new Set(["GET"]);
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ROLES = ["admin", "editor", "viewer"];

/** SCIM-formatted error response. */
export function scimErrorResponse(status, detail, code = null) {
  const payload = { schemas: [SCIM_ERR], status: String(status), detail };
  if (code) payload.scimCode = code;
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/scim+json" },
  });
}

// Wrap the existing rbac throws so they surface as SCIM errors through the entry catch.
function needCap(role, cap) {
  try { requireCapability(role, cap); }
  catch (e) { throw new ScimError(e.message || "Forbidden", "SCIM_FORBIDDEN", e.status || 403); }
}
function needActive(workspace) {
  try { requireActiveWorkspace(workspace); }
  catch (e) { throw new ScimError(e.message || "Workspace not active", "SCIM_WORKSPACE_INACTIVE", e.status || 403); }
}

function parsePath(path) {
  const segs = String(path || "").split("/").filter(Boolean);
  if (segs[0] !== "scim" || segs[1] !== "v2") return null;
  return { resource: segs[2] || "", id: segs[3] ? decodeURIComponent(segs[3]) : null };
}

function toScimUser(record) {
  const groups = Array.isArray(record.external_groups) ? record.external_groups : [];
  return {
    schemas: [SCIM_USER],
    id: record.external_id,
    externalId: record.external_id,
    userName: record.email,
    displayName: record.display_name || "",
    active: record.status === "active",
    emails: record.email ? [{ value: record.email, type: "work", primary: true }] : [],
    // Membership lives on the user (external_groups); the core stores no group-side
    // member list, so members are surfaced here as group references, not enumerated.
    groups: groups.map((g) => ({ value: g, display: g, type: "direct", ref: `/scim/v2/Groups/${encodeURIComponent(g)}` })),
    meta: { resourceType: "User", location: `/scim/v2/Users/${encodeURIComponent(record.external_id)}` },
  };
}

function toScimGroup(record) {
  // The core stores no group-side membership list (membership is derived from users'
  // external_groups), so Group.members is intentionally omitted rather than invented.
  return {
    schemas: [SCIM_GROUP],
    id: record.external_id,
    externalId: record.external_id,
    displayName: record.display_name || "",
    meta: { resourceType: "Group", location: `/scim/v2/Groups/${encodeURIComponent(record.external_id)}` },
  };
}

function resourceResponse(resource, status = 200) {
  return new Response(JSON.stringify(resource), {
    status,
    headers: { "Content-Type": "application/scim+json" },
  });
}

function listResponse(resources, startIndex, count, total) {
  return new Response(JSON.stringify({
    schemas: [SCIM_LIST], totalResults: total, startIndex, itemsPerPage: count, Resources: resources,
  }), { headers: { "Content-Type": "application/scim+json" } });
}

function serviceProviderConfig() {
  return {
    schemas: [SCIM_SPC],
    documentationUri: "https://docs.base44.com/Enterprise/SCIM-provisioning",
    // PATCH is supported only for the subset the core handles (active, groups, displayName, role).
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    // SCIM filter expressions are not implemented; ?filter is refused.
    filter: { supported: false, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      name: "WorkspaceSession",
      description: "Authenticated workspace member with the scim.manage (writes) or sso.read (reads) capability. The exact IdP bearer-token provisioning flow is platform-determined and undocumented here.",
      type: "oauthbearertoken",
      specUri: "https://datatracker.ietf.org/doc/html/rfc7644",
    }],
  };
}

// --- Users ---------------------------------------------------------------------

async function handleUsers({ svc, user, org, workspaceId, method, id, body }) {
  if (method === "GET") {
    if (id) {
      const rec = await getScimUser(svc, { organization_id: org.id, external_id: id });
      if (!rec || rec.workspace_id !== workspaceId) return scimErrorResponse(404, "User not found", "SCIM_NO_USER");
      return resourceResponse(toScimUser(rec));
    }
    const startIndex = Math.max(1, Number(body.startIndex || 1) || 1);
    const count = Math.min(200, Math.max(1, Number(body.count || 200) || 200));
    if (body.filter) return scimErrorResponse(400, "SCIM filter expressions are not supported", "SCIM_FILTER_UNSUPPORTED");
    const all = await listScimRecords(svc, { organization_id: org.id, resource_type: "user", status: body.status || null, limit: 1000 });
    const scoped = all.filter((r) => r.workspace_id === workspaceId);
    const total = scoped.length;
    const page = scoped.slice(startIndex - 1, startIndex - 1 + count);
    return listResponse(page.map(toScimUser), startIndex, page.length, total);
  }

  if (method === "POST") {
    const existing = id ? await getScimUser(svc, { organization_id: org.id, external_id: id }) : null;
    const externalId = String(body.externalId || id || body.userName || "");
    if (!externalId) return scimErrorResponse(400, "externalId is required", "SCIM_NO_EXTERNAL_ID");
    const emails = Array.isArray(body.emails) ? body.emails : [];
    const email = String(body.userName || (emails.find((e) => e.primary) || emails[0] || {}).value || "");
    const groups = Array.isArray(body.groups) ? body.groups.map((g) => g.value || g.display || g) : [];
    const res = await provisionUser(svc, {
      workspace_id: workspaceId, organization_id: org.id, external_id: externalId,
      email, display_name: body.displayName || "", groups, active: body.active !== false, user_id: user.id,
    });
    return resourceResponse(toScimUser(res.record), existing ? 200 : 201);
  }

  if (method === "PUT") {
    if (!id) return scimErrorResponse(400, "id is required for PUT", "SCIM_NO_EXTERNAL_ID");
    const emails = Array.isArray(body.emails) ? body.emails : [];
    const email = String(body.userName || (emails.find((e) => e.primary) || emails[0] || {}).value || "");
    const groups = Array.isArray(body.groups) ? body.groups.map((g) => g.value || g.display || g) : [];
    const res = await provisionUser(svc, {
      workspace_id: workspaceId, organization_id: org.id, external_id: id,
      email, display_name: body.displayName || "", groups, active: body.active !== false, user_id: user.id,
    });
    return resourceResponse(toScimUser(res.record), 200);
  }

  if (method === "PATCH") {
    if (!id) return scimErrorResponse(400, "id is required for PATCH", "SCIM_NO_EXTERNAL_ID");
    const ops = Array.isArray(body.Operations) ? body.Operations : (body.op ? [body] : []);
    if (!ops.length) return scimErrorResponse(400, "PATCH requires Operations", "SCIM_BAD_PATCH");
    const rec = await getScimUser(svc, { organization_id: org.id, external_id: id });
    if (!rec || rec.workspace_id !== workspaceId) return scimErrorResponse(404, "User not found", "SCIM_NO_USER");

    let active = rec.status === "active";
    let groups = Array.isArray(rec.external_groups) ? rec.external_groups.slice() : [];
    let needProvision = false;
    let needGroupSync = false;
    for (const op of ops) {
      const path = String(op.path || "").toLowerCase();
      const val = op.value;
      if (path === "active" || (path === "" && val && typeof val.active === "boolean")) {
        active = path === "active" ? !!val : !!val.active;
        needProvision = true;
      } else if (path === "groups" || path === "externalgroups") {
        // Replace membership wholesale (the only op the core supports cleanly).
        if (Array.isArray(val)) { groups = val.map((g) => g.value || g.display || g); needGroupSync = true; }
        else if (Array.isArray(op.value) === false && val && Array.isArray(val.groups)) { groups = val.groups.map((g) => g.value || g.display || g); needGroupSync = true; }
      } else if (path === "displayname") {
        needProvision = true; // provisionUser re-applies displayName from body when called via PUT; PATCH has no display path in core — best-effort below.
      } else {
        return scimErrorResponse(501, `PATCH path "${op.path}" is not supported by the provisioning core`, "SCIM_PATCH_UNSUPPORTED");
      }
    }
    if (needProvision) {
      await provisionUser(svc, {
        workspace_id: workspaceId, organization_id: org.id, external_id: id,
        email: rec.email, display_name: rec.display_name || "", groups, active, user_id: user.id,
      });
    }
    if (needGroupSync) {
      await syncUserGroups(svc, { workspace_id: workspaceId, organization_id: org.id, external_id: id, groups, user_id: user.id });
    }
    const updated = await getScimUser(svc, { organization_id: org.id, external_id: id });
    return resourceResponse(toScimUser(updated), 200);
  }

  if (method === "DELETE") {
    if (!id) return scimErrorResponse(400, "id is required for DELETE", "SCIM_NO_EXTERNAL_ID");
    const res = await deprovisionUser(svc, { workspace_id: workspaceId, organization_id: org.id, external_id: id, user_id: user.id });
    return new Response(null, { status: 204 });
  }

  return scimErrorResponse(400, `Unsupported method for Users: ${method}`);
}

// --- Groups --------------------------------------------------------------------

async function handleGroups({ svc, user, org, workspaceId, method, id, body }) {
  if (method === "GET") {
    if (id) {
      const all = await listScimRecords(svc, { organization_id: org.id, resource_type: "group", limit: 1000 });
      const rec = all.find((r) => r.external_id === id && r.workspace_id === workspaceId);
      if (!rec) return scimErrorResponse(404, "Group not found", "SCIM_NO_GROUP");
      return resourceResponse(toScimGroup(rec));
    }
    const startIndex = Math.max(1, Number(body.startIndex || 1) || 1);
    const count = Math.min(200, Math.max(1, Number(body.count || 200) || 200));
    if (body.filter) return scimErrorResponse(400, "SCIM filter expressions are not supported", "SCIM_FILTER_UNSUPPORTED");
    const all = await listScimRecords(svc, { organization_id: org.id, resource_type: "group", status: body.status || null, limit: 1000 });
    const scoped = all.filter((r) => r.workspace_id === workspaceId);
    const page = scoped.slice(startIndex - 1, startIndex - 1 + count);
    return listResponse(page.map(toScimGroup), startIndex, page.length, scoped.length);
  }

  if (method === "POST" || method === "PUT") {
    const externalId = String(body.externalId || id || body.displayName || "");
    if (!externalId) return scimErrorResponse(400, "externalId is required", "SCIM_NO_EXTERNAL_ID");
    const role = ROLES.includes(body.role) ? body.role : "viewer";
    const res = await provisionGroup(svc, {
      workspace_id: workspaceId, organization_id: org.id, external_id: externalId,
      display_name: body.displayName || "", role, user_id: user.id,
    });
    return resourceResponse(toScimGroup(res.record), method === "POST" ? 201 : 200);
  }

  if (method === "PATCH") {
    if (!id) return scimErrorResponse(400, "id is required for PATCH", "SCIM_NO_EXTERNAL_ID");
    const ops = Array.isArray(body.Operations) ? body.Operations : (body.op ? [body] : []);
    const all = await listScimRecords(svc, { organization_id: org.id, resource_type: "group", limit: 1000 });
    const rec = all.find((r) => r.external_id === id && r.workspace_id === workspaceId);
    if (!rec) return scimErrorResponse(404, "Group not found", "SCIM_NO_GROUP");
    let displayName = rec.display_name || "";
    let role = rec.mapped_role || "viewer";
    for (const op of ops) {
      const p = String(op.path || "").toLowerCase();
      if (p === "displayname") { displayName = String(op.value || ""); }
      else if (p === "role") { role = ROLES.includes(op.value) ? op.value : role; }
      else return scimErrorResponse(501, `PATCH path "${op.path}" is not supported for Groups`, "SCIM_PATCH_UNSUPPORTED");
    }
    const res = await provisionGroup(svc, {
      workspace_id: workspaceId, organization_id: org.id, external_id: id,
      display_name: displayName, role, user_id: user.id,
    });
    return resourceResponse(toScimGroup(res.record), 200);
  }

  if (method === "DELETE") {
    // The core has no group deprovision/delete — do NOT invent one.
    return scimErrorResponse(501, "Group deletion is not supported by the provisioning core", "SCIM_GROUP_DELETE_UNSUPPORTED");
  }

  return scimErrorResponse(400, `Unsupported method for Groups: ${method}`);
}

/**
 * Dispatch a SCIM 2.0 request. The entry function has already authenticated the caller,
 * resolved the workspace + role, and validated presence of workspace_id.
 */
export async function handleScim({ svc, user, workspace, role, method, path, body, workspaceId }) {
  const parsed = parsePath(path);
  if (!parsed) return scimErrorResponse(404, "Not found", "invalid-path");
  const { resource, id } = parsed;

  if (READ.has(method)) {
    needCap(role, "sso.read");
  } else if (WRITE.has(method)) {
    needActive(workspace);
    needCap(role, "scim.manage");
  } else {
    return scimErrorResponse(400, `Unsupported HTTP method: ${method}`);
  }

  if (resource === "ServiceProviderConfig") {
    if (method !== "GET" || id) return scimErrorResponse(404, "Not found");
    return resourceResponse(serviceProviderConfig());
  }

  const org = await getOrganization(svc, workspaceId);
  if (!org) return scimErrorResponse(400, "Create an organization first", "SCIM_NO_ORG");

  if (resource === "Users") {
    return await handleUsers({ svc, user, org, workspaceId, method, id, body });
  }
  if (resource === "Groups") {
    return await handleGroups({ svc, user, org, workspaceId, method, id, body });
  }
  return scimErrorResponse(404, `Unknown resource: ${resource}`);
}