// First-entry bootstrap endpoint: resolves (or provisions) the authenticated account's single
// internal workspace and its owner membership. Takes no identity-bearing input at all — the
// account is taken from the authenticated identity, so a caller cannot bootstrap or address
// anyone else's workspace. It never creates a project.
//
// Referral program (Slice 1), ADDITIVE only: an OPTIONAL referral_code may be handed back for
// server-side redemption (one-time attribution + the ledger's 30-credit referred grant, with a
// workspace-scoped idempotency key), and every caller now receives its own lazily-issued
// referral_code for the shareable link. No one-time welcome grant is issued at bootstrap; the
// Base44-confirmed Free allowance is granted by the billing path, and a referral failure never
// breaks the bootstrap itself.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { ensureWorkspaceForUser } from "../../shared/workspaceBootstrap.ts";
import { ensureReferralCode, applyReferralCode } from "../../shared/referral.ts";
import { resolveRole, capabilitiesFor } from "../../shared/rbac.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const svc = base44.asServiceRole || base44;
    const body = await req.json().catch(() => ({}));

    const { workspace, member, created } = await ensureWorkspaceForUser(base44, user);
    const role = await resolveRole(base44, workspace, user);

    // Referral (Slice 1): lazy issuance for this account + optional one-time redemption of a
    // handed-back code. Fail-safe by design — any referral error leaves the bootstrap result
    // exactly as it would have been without the referral code.
    let referral_code = null;
    try {
      referral_code = await ensureReferralCode(svc, user);
      if (body && typeof body.referral_code === "string" && body.referral_code.trim()) {
        await applyReferralCode(svc, user, workspace, body.referral_code);
      }
    } catch {
      referral_code = null;
    }

    return Response.json({
      workspace, created, member_id: member?.id || null,
      role, capabilities: capabilitiesFor(role),
      referral_code,
    });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}