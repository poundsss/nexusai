// Workspace role-based access control.
//
// One capability matrix, consulted by every control-plane surface. Authorization is always
// resolved SERVER-SIDE from two facts the caller cannot influence:
//   1. Workspace.owner_id                 → the 'owner' role, which is derived, never granted
//   2. an ACTIVE WorkspaceMember row      → admin / editor / viewer
// A caller with neither is not a member and gets nothing. An invited-but-not-accepted row,
// a removed row, or a row whose user_id does not match the authenticated user all resolve
// to no access, so possessing an invitation is not the same as holding access.
export const ROLES = ["owner", "admin", "editor", "viewer"];
export const ASSIGNABLE_ROLES = ["admin", "editor", "viewer"];

// Capability → the roles that hold it. Deliberately explicit: a new capability is denied to
// everyone until it is listed here, so forgetting an entry fails closed.
export const CAPABILITIES = {
  // Reading the project: files, versions, build state, data.
  "project.read": ["owner", "admin", "editor", "viewer"],
  // Mutating the project: AI runs, file writes, entity changes, data writes.
  "project.write": ["owner", "admin", "editor"],
  "project.create": ["owner", "admin", "editor"],
  "project.delete": ["owner", "admin"],
  "version.restore": ["owner", "admin", "editor"],
  "integration.manage": ["owner", "admin", "editor"],
  "github.manage": ["owner", "admin"],
  // Anything that can reach production or a credential is owner/admin only.
  "deploy.manage": ["owner", "admin"],
  "domain.manage": ["owner", "admin"],
  "secret.manage": ["owner", "admin"],
  // Commercial surfaces. A member may see the account's credits and their own usage;
  // real provider cost and margin are admin-only; moving money or changing limits is owner-only.
  "billing.read": ["owner", "admin", "editor", "viewer"],
  "billing.admin": ["owner", "admin"],
  "billing.manage": ["owner"],
  // Marketplace / ecosystem. Every member may browse and install; publishing a listing is an
  // editor-level action; moderation (resolving reports, suspending) is admin-only.
  "marketplace.read": ["owner", "admin", "editor", "viewer"],
  "marketplace.install": ["owner", "admin", "editor", "viewer"],
  "marketplace.publish": ["owner", "admin", "editor"],
  "marketplace.moderate": ["owner", "admin"],
  // Enterprise SSO / SCIM. Configuring identity providers, verifying domains, and managing
  // SCIM provisioning are admin-only — they control who can enter the workspace and as what.
  "sso.read": ["owner", "admin"],
  "sso.manage": ["owner", "admin"],
  "scim.manage": ["owner", "admin"],
  // Legal / compliance / abuse. Every member may file an abuse report and accept terms; reading
  // the compliance audit trail and managing DSRs, retention, and breach response are admin-only.
  "compliance.read": ["owner", "admin"],
  "compliance.manage": ["owner", "admin"],
  "abuse.report": ["owner", "admin", "editor", "viewer"],
  "abuse.moderate": ["owner", "admin"],
  "dsr.manage": ["owner", "admin"],
  "breach.manage": ["owner", "admin"],
  "retention.manage": ["owner", "admin"],
  // Granting a safety approval for a risky AI-proposed operation. Deliberately owner/admin only:
  // approving is not the same as being able to perform the work, and the actor's OWN capability is
  // still re-checked at execution, so an approval can never hand out a capability.
  "approval.grant": ["owner", "admin"],
  // Changing who can do all of the above.
  "member.manage": ["owner", "admin"],
  "workspace.manage": ["owner"],
  // Renaming the workspace itself. The workspace's identity/plan/credits stay owner-only
  // ('workspace.manage'); the display name is admin-delegable.
  "workspace.rename": ["owner", "admin"],
};

export function can(role, capability) {
  const allowed = CAPABILITIES[capability];
  if (!allowed) return false; // unknown capability → denied
  return !!role && allowed.includes(role);
}

export function requireCapability(role, capability) {
  if (!role) throw Object.assign(new Error("Forbidden"), { status: 403, code: "NOT_A_MEMBER" });
  if (!can(role, capability)) {
    throw Object.assign(new Error(`Your role (${role}) is not allowed to ${capability}`), { status: 403, code: "INSUFFICIENT_ROLE", capability });
  }
  return role;
}

export const normalizeEmail = (v) => String(v || "").trim().toLowerCase();

// --- Workspace lifecycle (G-2) ------------------------------------------------
//
// A non-active workspace (suspended / terminated) is read-only: reads of status, audit and
// history stay available to an already-authorized caller, and every mutating operation fails
// closed with WORKSPACE_INACTIVE. The check consults only the SERVER-loaded workspace row, so
// a client cannot state a lifecycle it wants. Rows created before the field existed have no
// `status` and read as active, so no data migration is needed.
export const LIFECYCLE_READ_CAPABILITIES = ["project.read", "billing.read", "marketplace.read", "compliance.read", "sso.read"];

// `capability` follows the SAME classification the caller already uses for its role check:
// a capability in LIFECYCLE_READ_CAPABILITIES is a read and passes; anything else (including
// null, for call sites that gate on action names) is a mutation and is refused on a
// non-active workspace.
export function requireActiveWorkspace(workspace, capability = null) {
  const status = workspace?.status || "active";
  if (status === "active" || LIFECYCLE_READ_CAPABILITIES.includes(capability)) return;
  throw Object.assign(new Error(`This workspace is ${status}; mutating operations are disabled until it is active again.`), { status: 403, code: "WORKSPACE_INACTIVE", workspace_status: status });
}

// The single membership resolver. Reads with the service role because a member must be able
// to resolve their OWN membership without holding read access to the membership table.
// A service-role membership read is REJECTED by the platform when the escalation is not
// permitted for the acting token ("Admin permissions required for this operation"). That is a
// privilege restriction on the read path, not a denial of this caller's access, so the SAME
// query is retried with the caller-scoped client. Only that failure is tolerated: any other
// database/API error is rethrown untouched, and the role is still derived from the same two
// server-side facts (owner_id, active WorkspaceMember).
const isEscalationDenied = (e) => {
  const msg = String(e?.message || "");
  const code = String(e?.code || "");
  return /admin permission/i.test(msg) || ["ADMIN_REQUIRED", "SERVICE_ROLE_FORBIDDEN"].includes(code) ||
    (e?.status === 403 && /service.?role|escalat|admin/i.test(msg));
};

async function readActiveMembers(base44, workspaceId) {
  const query = { workspace_id: workspaceId, status: "active" };
  try {
    // Obtaining the escalation is INSIDE the try: the platform can refuse the service-role
    // handle at access time, not only on the query, and that refusal must reach the guard below.
    const svc = base44.asServiceRole || base44;
    return await svc.entities.WorkspaceMember.filter(query, "-created_date", 200);
  } catch (e) {
    if (!isEscalationDenied(e)) throw e;
    return base44.entities.WorkspaceMember.filter(query, "-created_date", 200);
  }
}

export async function resolveRole(base44, workspace, user) {
  if (!workspace || !user) return null;
  if (workspace.owner_id === user.id) return "owner";
  const rows = await readActiveMembers(base44, workspace.id);
  const email = normalizeEmail(user.email);
  const row = rows.find((r) => r.user_id === user.id) || rows.find((r) => !r.user_id && normalizeEmail(r.email) === email && email);
  if (!row) return null;
  // A row that was created by invite but never linked to a user id is linked on first use,
  // so the email match happens exactly once and later checks are id-based.
  if (!row.user_id && email) {
    // The escalation is obtained HERE, after membership has already been resolved, so a refused
    // service-role handle can never pre-empt the read (and its fallback) above — and the access
    // itself sits inside the same swallowing guard, so a refusal cannot escape either.
    await (async () => {
      const svc = base44.asServiceRole || base44;
      await svc.entities.WorkspaceMember.update(row.id, { user_id: user.id });
    })().catch(() => {});
  }
  return ASSIGNABLE_ROLES.includes(row.role) ? row.role : "viewer";
}

// Capabilities a role holds, for the UI to reflect (never to enforce with).
export function capabilitiesFor(role) {
  return Object.keys(CAPABILITIES).filter((c) => can(role, c));
}