// First-entry workspace bootstrap.
//
// The account's internal workspace is provisioned SERVER-SIDE, so every surface that resolves
// "the workspace for this account" (the MCP control plane, the Builder, background workers, the
// UI) sees the same row regardless of which one the user reached first. Previously provisioning
// lived only in the browser hook, so a server-side caller found no workspace at all until a
// browser session happened to run, and no WorkspaceMember row was ever written.
//
// Isolation is preserved: the workspace is keyed on the AUTHENTICATED user's id (never a
// client-supplied value), exactly one is ever created per account, and no project is created.

// Ensures the caller's own membership row exists. The owner role itself is derived from
// Workspace.owner_id (rbac.resolveRole) — this row makes the owner visible to every
// membership-driven surface without ever granting access that ownership did not already imply.
async function ensureOwnerMembership(svc, workspace, user) {
  const rows = await svc.entities.WorkspaceMember.filter({ workspace_id: workspace.id }, "-created_date", 200);
  const email = String(user.email || "").trim().toLowerCase();
  const existing = rows.find((r) => r.user_id === user.id || (email && String(r.email || "").trim().toLowerCase() === email));
  if (existing) {
    if (existing.status !== "active" || existing.user_id !== user.id) {
      return await svc.entities.WorkspaceMember.update(existing.id, {
        user_id: user.id, status: "active", accepted_at: existing.accepted_at || new Date().toISOString(), invite_token: null,
      });
    }
    return existing;
  }
  return await svc.entities.WorkspaceMember.create({
    workspace_id: workspace.id, email, user_id: user.id, role: "admin", status: "active",
    accepted_at: new Date().toISOString(),
  });
}

// Resolves the account's single internal workspace, creating it (and its owner membership) on
// first entry. Idempotent: a second call returns the same workspace and the same membership row.
// No one-time welcome grant is issued here: Base44-confirmed Free allowance (25 message / 100
// integration per cycle) is granted by the billing path (grantFreePeriodCredits), and the
// referral +30 grant is handled by referral.ts.
export async function ensureWorkspaceForUser(base44, user) {
  if (!user?.id) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const svc = base44.asServiceRole || base44;
  const existing = await svc.entities.Workspace.filter({ owner_id: user.id }, "created_date", 1);
  let workspace = existing[0];
  let created = false;

  if (!workspace) {
    const first = String(user.full_name || user.email || "My").split(" ")[0];
    workspace = await svc.entities.Workspace.create({ name: `${first}'s Workspace`, owner_id: user.id, status: "active" });
    created = true;
    // Re-read after the write: if two entries raced, keep the earliest row so exactly one
    // workspace ever represents the account.
    const all = await svc.entities.Workspace.filter({ owner_id: user.id }, "created_date", 5);
    if (all.length > 1) {
      for (const dup of all.slice(1)) await svc.entities.Workspace.delete(dup.id).catch(() => {});
      workspace = all[0];
    }
  }

  const member = await ensureOwnerMembership(svc, workspace, user);
  return { workspace, member, created };
}