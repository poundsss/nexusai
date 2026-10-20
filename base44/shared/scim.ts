// SCIM 2.0 user and group provisioning.
//
// SCIM is how an enterprise IdP or HR system pushes user lifecycle changes into the platform
// without manual invitations. Every provisioning call is idempotent on `external_id`: a
// replayed SCIM request updates the same record and the same membership instead of creating
// a duplicate.
//
// SECURITY MODEL:
//   • provisioning is scoped to the caller's workspace and org; a SCIM call for org A can never
//     create a membership in workspace B;
//   • a provisioned user's email must be on a verified domain owned by the org, so a SCIM
//     payload cannot inject a user onto a domain the org hasn't proven it controls;
//   • deprovisioning removes the workspace membership (status 'removed'), which is the same
//     revocation path as a manual removal — the user loses access immediately;
//   • group sync resolves the effective role from group mappings and updates the membership
//     role, so an IdP group change propagates to platform RBAC in the same request.

import { audit } from "./authz.ts";
import { getOrganization, resolveRoleForGroups } from "./sso.ts";

export class ScimError extends Error {
  constructor(message, code = "SCIM_ERROR", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = ["admin", "editor", "viewer"];

function normalizeEmail(v) {
  return String(v || "").toLowerCase().trim();
}

function domainOf(email) {
  return String(email || "").split("@").pop()?.toLowerCase() || "";
}

async function verifiedDomainFor(svc, organization_id, email) {
  const domain = domainOf(email);
  if (!domain) return null;
  const rows = await svc.entities.VerifiedDomain.filter({ organization_id, domain, status: "verified" }, "-created_date", 3);
  return rows.length ? rows[0] : null;
}

async function findScimRecord(svc, { organization_id, resource_type, external_id }) {
  const rows = await svc.entities.ScimRecord.filter({ organization_id, resource_type, external_id }, "-created_date", 5);
  return rows[0] || null;
}

// --- user provisioning ---------------------------------------------------------

export async function provisionUser(svc, { workspace_id, organization_id, external_id, email, display_name, groups, active = true, user_id }) {
  if (!organization_id) throw new ScimError("organization_id is required", "SCIM_NO_ORG");
  if (!external_id) throw new ScimError("external_id is required", "SCIM_NO_EXTERNAL_ID");
  const org = await getOrganization(svc, workspace_id);
  if (!org || org.id !== organization_id) throw new ScimError("organization not found in this workspace", "SCIM_ORG_MISMATCH", 404);
  if (org.status !== "active") throw new ScimError("organization is suspended; provisioning paused", "SCIM_ORG_SUSPENDED", 403);
  if (!org.scim_enabled) throw new ScimError("SCIM is not enabled for this organization", "SCIM_DISABLED", 403);

  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_RE.test(normalizedEmail)) throw new ScimError("a valid email is required", "SCIM_BAD_EMAIL");

  // The email must be on a verified domain owned by this org.
  const domain = await verifiedDomainFor(svc, organization_id, normalizedEmail);
  if (!domain) throw new ScimError(`email domain "${domainOf(normalizedEmail)}" is not a verified domain for this organization`, "SCIM_DOMAIN_NOT_VERIFIED", 403);

  // Seat ceiling.
  if (org.max_seats > 0) {
    const activeUsers = await svc.entities.ScimRecord.filter({ organization_id, resource_type: "user", status: "active" }, "-created_date", 10000);
    if (activeUsers.length >= org.max_seats) {
      const existing = await findScimRecord(svc, { organization_id, resource_type: "user", external_id });
      if (!existing || existing.status !== "active") throw new ScimError("seat limit reached", "SCIM_SEAT_LIMIT", 403);
    }
  }

  const external_groups = Array.isArray(groups) ? groups.map(String) : [];
  // Resolve the effective role: group mapping wins, else org default.
  const mappedRole = await resolveRoleForGroups(svc, { organization_id, groups: external_groups });
  const role = mappedRole || org.default_role || "viewer";
  if (!ROLES.includes(role)) throw new ScimError("invalid resolved role", "SCIM_BAD_ROLE");

  const existing = await findScimRecord(svc, { organization_id, resource_type: "user", external_id });
  const now = new Date().toISOString();

  if (existing) {
    // Update the SCIM record and the linked membership.
    const member = existing.workspace_member_id ? await svc.entities.WorkspaceMember.get(existing.workspace_member_id).catch(() => null) : null;
    const targetStatus = active ? "active" : "suspended";
    if (member) {
      await svc.entities.WorkspaceMember.update(member.id, {
        email: normalizedEmail, role, status: targetStatus,
        ...(targetStatus === "active" && !member.accepted_at ? { accepted_at: now } : {}),
      });
    } else {
      // The membership was removed externally; re-create it.
      const newMember = await svc.entities.WorkspaceMember.create({
        workspace_id, email: normalizedEmail, role, status: targetStatus, invited_by: user_id || null,
        ...(targetStatus === "active" ? { accepted_at: now } : {}),
      });
      await svc.entities.ScimRecord.update(existing.id, { workspace_member_id: newMember.id });
    }
    const updated = await svc.entities.ScimRecord.update(existing.id, {
      email: normalizedEmail, display_name: String(display_name || "").slice(0, 200),
      external_groups, mapped_role: role, status: targetStatus, last_synced_at: now,
    });
    await audit(svc, { workspace_id, user_id: user_id || null, action: "scim.user.provisioned", resource: "ScimRecord", resource_id: updated.id, metadata: { external_id, email: normalizedEmail, role, status: targetStatus } });
    return { record: updated, duplicate: false };
  }

  // New provisioning. Check for an existing membership with the same email (e.g. a manual invite).
  const existingMembers = await svc.entities.WorkspaceMember.filter({ workspace_id, email: normalizedEmail }, "-created_date", 5);
  const member = existingMembers[0] || null;
  let memberId = null;
  if (member) {
    await svc.entities.WorkspaceMember.update(member.id, { role, status: active ? "active" : "suspended", ...(active && !member.accepted_at ? { accepted_at: now } : {}) });
    memberId = member.id;
  } else {
    const newMember = await svc.entities.WorkspaceMember.create({
      workspace_id, email: normalizedEmail, role, status: active ? "active" : "suspended", invited_by: user_id || null,
      ...(active ? { accepted_at: now } : {}),
    });
    memberId = newMember.id;
  }
  const created = await svc.entities.ScimRecord.create({
    organization_id, workspace_id, external_id: String(external_id), resource_type: "user",
    email: normalizedEmail, display_name: String(display_name || "").slice(0, 200),
    external_groups, mapped_role: role, status: active ? "active" : "suspended",
    workspace_member_id: memberId, last_synced_at: now,
  });
  await audit(svc, { workspace_id, user_id: user_id || null, action: "scim.user.provisioned", resource: "ScimRecord", resource_id: created.id, metadata: { external_id, email: normalizedEmail, role, status: created.status } });
  return { record: created, duplicate: false };
}

export async function suspendUser(svc, { workspace_id, organization_id, external_id, user_id }) {
  const existing = await findScimRecord(svc, { organization_id, resource_type: "user", external_id });
  if (!existing || existing.workspace_id !== workspace_id) throw new ScimError("user not found", "SCIM_NO_USER", 404);
  await svc.entities.ScimRecord.update(existing.id, { status: "suspended", last_synced_at: new Date().toISOString() });
  if (existing.workspace_member_id) {
    await svc.entities.WorkspaceMember.update(existing.workspace_member_id, { status: "suspended" }).catch(() => {});
  }
  await audit(svc, { workspace_id, user_id: user_id || null, action: "scim.user.suspended", resource: "ScimRecord", resource_id: existing.id, metadata: { external_id, email: existing.email } });
  return { record: await svc.entities.ScimRecord.get(existing.id) };
}

export async function deprovisionUser(svc, { workspace_id, organization_id, external_id, user_id }) {
  const existing = await findScimRecord(svc, { organization_id, resource_type: "user", external_id });
  if (!existing || existing.workspace_id !== workspace_id) throw new ScimError("user not found", "SCIM_NO_USER", 404);
  await svc.entities.ScimRecord.update(existing.id, { status: "deprovisioned", last_synced_at: new Date().toISOString() });
  if (existing.workspace_member_id) {
    await svc.entities.WorkspaceMember.update(existing.workspace_member_id, { status: "removed", removed_at: new Date().toISOString() }).catch(() => {});
  }
  await audit(svc, { workspace_id, user_id: user_id || null, action: "scim.user.deprovisioned", resource: "ScimRecord", resource_id: existing.id, metadata: { external_id, email: existing.email } });
  return { record: await svc.entities.ScimRecord.get(existing.id) };
}

// --- group provisioning --------------------------------------------------------

export async function provisionGroup(svc, { workspace_id, organization_id, external_id, display_name, role, user_id }) {
  if (!organization_id) throw new ScimError("organization_id is required", "SCIM_NO_ORG");
  const org = await getOrganization(svc, workspace_id);
  if (!org || org.id !== organization_id) throw new ScimError("organization not found in this workspace", "SCIM_ORG_MISMATCH", 404);
  if (!org.scim_enabled) throw new ScimError("SCIM is not enabled for this organization", "SCIM_DISABLED", 403);
  if (!ROLES.includes(role)) throw new ScimError("invalid role", "SCIM_BAD_ROLE");
  const existing = await findScimRecord(svc, { organization_id, resource_type: "group", external_id });
  const now = new Date().toISOString();
  if (existing) {
    const updated = await svc.entities.ScimRecord.update(existing.id, { display_name: String(display_name || "").slice(0, 200), mapped_role: role, last_synced_at: now });
    await audit(svc, { workspace_id, user_id: user_id || null, action: "scim.group.provisioned", resource: "ScimRecord", resource_id: updated.id, metadata: { external_id, role } });
    return { record: updated, duplicate: false };
  }
  const created = await svc.entities.ScimRecord.create({
    organization_id, workspace_id, external_id: String(external_id), resource_type: "group",
    display_name: String(display_name || "").slice(0, 200), mapped_role: role, status: "active", last_synced_at: now,
  });
  await audit(svc, { workspace_id, user_id: user_id || null, action: "scim.group.provisioned", resource: "ScimRecord", resource_id: created.id, metadata: { external_id, role } });
  return { record: created, duplicate: false };
}

// --- group sync ---------------------------------------------------------------

// Re-resolve the role for a user based on their current external_groups and update the
// membership. Called after a group membership change in the IdP, or on each SSO login.
export async function syncUserGroups(svc, { workspace_id, organization_id, external_id, groups, user_id }) {
  const existing = await findScimRecord(svc, { organization_id, resource_type: "user", external_id });
  if (!existing || existing.workspace_id !== workspace_id) throw new ScimError("user not found", "SCIM_NO_USER", 404);
  const org = await getOrganization(svc, workspace_id);
  if (!org) throw new ScimError("organization not found", "SCIM_NO_ORG", 404);
  const external_groups = Array.isArray(groups) ? groups.map(String) : [];
  const mappedRole = await resolveRoleForGroups(svc, { organization_id, groups: external_groups });
  const role = mappedRole || org.default_role || "viewer";
  await svc.entities.ScimRecord.update(existing.id, { external_groups, mapped_role: role, last_synced_at: new Date().toISOString() });
  if (existing.workspace_member_id) {
    await svc.entities.WorkspaceMember.update(existing.workspace_member_id, { role }).catch(() => {});
  }
  await audit(svc, { workspace_id, user_id: user_id || null, action: "scim.user.group_sync", resource: "ScimRecord", resource_id: existing.id, metadata: { external_id, groups: external_groups, role } });
  return { record: await svc.entities.ScimRecord.get(existing.id), role };
}

// --- listing ------------------------------------------------------------------

export async function listScimRecords(svc, { organization_id, resource_type = null, status = null, limit = 200 }) {
  const query = { organization_id };
  if (resource_type) query.resource_type = resource_type;
  if (status) query.status = status;
  return svc.entities.ScimRecord.filter(query, "-created_date", limit);
}

export async function getScimUser(svc, { organization_id, external_id }) {
  return findScimRecord(svc, { organization_id, resource_type: "user", external_id });
}