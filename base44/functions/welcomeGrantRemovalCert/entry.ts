// Certification: removing the NexusAI-native 1000-credit WELCOME_CREDITS grant.
//
// Verifies, against the real ledger and billing path, that a freshly provisioned workspace
// receives EXACTLY the Base44-confirmed Free allowance (25 message / 100 integration for the
// cycle) and NO one-time welcome bonus, while the referral +30 grant still behaves unchanged.
//
// Scope:
//   • new workspace → applyScheduledChanges (the on-read/maintenance path that grants Free) →
//     balance is 25 message / 100 integration / 0 promotional welcome.
//   • no ledger entry with idempotency_key `welcome:<workspace_id>` exists (the removed grant).
//   • referral flow still grants exactly +30 promotional under `referral:welcome:<workspace_id>`.
//
// All created rows (Workspace, WorkspaceMember, Referral, CreditLedgerEntry) are cleaned up in
// a finally block so the cert is repeatable and leaves no residue.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { ensureWorkspaceForUser } from "../../shared/workspaceBootstrap.ts";
import { ensureReferralCode, applyReferralCode, REFERRAL_GRANT_CREDITS } from "../../shared/referral.ts";
import { applyScheduledChanges } from "../../shared/subscriptions.ts";
import { seedPlans } from "../../shared/billing.ts";
import { deriveBalance, syncWorkspaceBalance, findByKey } from "../../shared/ledger.ts";
import { resolveRole } from "../../shared/rbac.ts";

const stamp = Date.now();
const rid = (s) => `${s}_${stamp}`;
const clean = async (svc, ids) => {
  for (const id of ids.workspaces || []) await svc.entities.Workspace.delete(id).catch(() => {});
  for (const id of ids.members || []) await svc.entities.WorkspaceMember.delete(id).catch(() => {});
  for (const id of ids.referrals || []) await svc.entities.Referral.delete(id).catch(() => {});
  for (const id of ids.ledger || []) await svc.entities.CreditLedgerEntry.delete(id).catch(() => {});
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const results = { checks: [], summary: { passed: 0, failed: 0 }, balances: null, referral: null };
  const h = {
    check: (label, ok) => {
      results.checks.push({ label, ok: !!ok });
      if (ok) results.summary.passed++; else results.summary.failed++;
    },
  };

  // Distinct synthetic accounts so this cert never collides with a real owner_id lookup.
  const referredUser = { id: rid("u_referred"), email: `${rid("referred")}@cert.test`, full_name: "Referred Cert" };
  const referrerUser = { id: rid("u_referrer"), email: `${rid("referrer")}@cert.test`, full_name: "Referrer Cert" };
  const ids = { workspaces: [], members: [], referrals: [], ledger: [] };

  try {
    // Plans must exist for the Free period grant to resolve (grantFreePeriodCredits → getPlan).
    await seedPlans(svc);

    // ---- 1. New workspace provisioning (the path that used to grant 1000) ------------------
    const provisioned = await ensureWorkspaceForUser(svc, referredUser);
    ids.workspaces.push(provisioned.workspace.id);
    if (provisioned.member?.id) ids.members.push(provisioned.member.id);

    h.check("workspace created", !!provisioned.created);
    h.check("workspace is active", provisioned.workspace.status === "active");

    // No welcome grant should be present immediately after provisioning.
    const welcomeBefore = await findByKey(svc, provisioned.workspace.id, `welcome:${provisioned.workspace.id}`);
    h.check("no welcome grant at provisioning (welcome key absent)", !welcomeBefore);

    // ---- 2. Free-period grant via the canonical on-read path ------------------------------
    await applyScheduledChanges(svc, { workspace_id: provisioned.workspace.id });

    const balance = await deriveBalance(svc, provisioned.workspace.id);
    await syncWorkspaceBalance(svc, provisioned.workspace.id);
    const wsReloaded = await svc.entities.Workspace.get(provisioned.workspace.id);
    results.balances = {
      message_available: balance.by_type?.message?.available ?? null,
      message_balance: balance.by_type?.message?.balance ?? null,
      integration_available: balance.by_type?.integration?.available ?? null,
      integration_balance: balance.by_type?.integration?.balance ?? null,
      total_balance: wsReloaded.credits_balance,
    };

    h.check("message credits available == 25 (Free cycle)", results.balances.message_available === 25);
    h.check("integration credits available == 100 (Free cycle)", results.balances.integration_available === 100);
    h.check("no 1000 welcome bonus in total balance", results.balances.total_balance === 25 + 100);

    const welcomeAfter = await findByKey(svc, provisioned.workspace.id, `welcome:${provisioned.workspace.id}`);
    h.check("no welcome ledger entry exists after Free grant", !welcomeAfter);

    // ---- 3. Referral +30 still behaves unchanged -------------------------------------------
    // Referrer issues a code; the referred user redeems it against its own workspace.
    const referrerWs = await ensureWorkspaceForUser(svc, referrerUser);
    ids.workspaces.push(referrerWs.workspace.id);
    if (referrerWs.member?.id) ids.members.push(referrerWs.member.id);
    const code = await ensureReferralCode(svc, referrerUser);
    h.check("referrer code issued", typeof code === "string" && code.length > 0);

    const before = await deriveBalance(svc, provisioned.workspace.id);
    const applied = await applyReferralCode(svc, referredUser, provisioned.workspace, code);
    const after = await deriveBalance(svc, provisioned.workspace.id);
    results.referral = { applied, granted_delta: (after.by_type?.message?.balance || 0) - (before.by_type?.message?.balance || 0) };

    h.check("referral applied", applied.applied === true);
    h.check(`referral granted exactly +${REFERRAL_GRANT_CREDITS}`, results.referral.granted_delta === REFERRAL_GRANT_CREDITS);

    const referralEntry = await findByKey(svc, provisioned.workspace.id, `referral:welcome:${provisioned.workspace.id}`);
    h.check("referral ledger entry exists under referral:welcome key", !!referralEntry);
    const stillNoWelcome = await findByKey(svc, provisioned.workspace.id, `welcome:${provisioned.workspace.id}`);
    h.check("welcome grant still absent after referral redemption", !stillNoWelcome);

    // Collect ledger rows for cleanup (the period grant + referral grant).
    const entries = await svc.entities.CreditLedgerEntry.filter({ workspace_id: provisioned.workspace.id }, "created_date", 50);
    for (const e of entries) ids.ledger.push(e.id);
    const refRows = await svc.entities.Referral.filter({ $or: [{ referrer_user_id: referrerUser.id }, { referred_user_id: referredUser.id }] }, "created_date", 20).catch(() => []);
    for (const r of refRows) ids.referrals.push(r.id);

    return Response.json(results);
  } catch (error) {
    return Response.json({ ...results, error: String(error?.message || error).slice(0, 400) }, { status: 500 });
  } finally {
    await clean(svc, ids);
  }
}