// Referral program (Slice 1): code issuance + signup attribution + the referred-user grant.
//
// Smallest server-side model that supports reliable lookup and one-time attribution:
// a dedicated Referral entity (the built-in User row has no reliable server-side lookup by
// custom fields). One deterministic code per referrer; redemption creates an append-only
// attribution row; the 30-credit grant rides the EXISTING authoritative ledger with a
// workspace-scoped idempotency key, so replayed or concurrent bootstraps can never grant
// twice. NO referrer rewards exist in this slice (publish/message/paid-plan rewards are
// deliberately deferred), and no client ever names a referrer — it may only hand back a CODE
// for server-side resolution.
import { recordEvent, findByKey } from "./ledger.ts";
import { audit } from "./authz.ts";

export const REFERRAL_GRANT_CREDITS = 30;

// Referrer reward (Slice 2): the referred user earns the referrer exactly +30 promotional
// credits once they have BOTH published their first app to production AND sent a message.
// Detection rides the two EXISTING production hooks only — the single user-message enqueue
// path (runEnqueue) and the deployment LIVE switch (deploy) — there is no second event
// system, and a client can never claim a reward. Requires an existing valid Referral
// attribution row; no attribution, no reward. One grant per attribution through the ledger
// under `referral:publish_message:{referral_id}`. The Slice 1 grant (the referred user's
// +30) is untouched, and no paid-plan reward exists in this slice.
export const REFERRAL_REWARD_CREDITS = 30;

export async function maybeGrantReferrerReward(svc, { user_id, workspace_id, project_id, event }) {
  try {
    if (!user_id) return { granted: false, reason: "no_user" };
    // Valid existing attribution, resolved SERVER-side — never from a client claim.
    const rows = await svc.entities.Referral.filter({ referred_user_id: user_id }, "created_date", 1);
    const attribution = rows[0];
    if (!attribution || !attribution.referrer_user_id) return { granted: false, reason: "no_referral" };
    // Activity isolation: the publish/message must happen in the referred user's OWN
    // workspace (stored on the attribution row) — another workspace's deploy or message
    // never counts.
    if (!workspace_id || workspace_id !== attribution.referred_workspace_id) {
      return { granted: false, reason: "outside_workspace" };
    }

    const referrerWsRows = await svc.entities.Workspace.filter({ owner_id: attribution.referrer_user_id }, "created_date", 1);
    const referrerWsId = referrerWsRows[0]?.id;
    if (!referrerWsId) return { granted: false, reason: "no_referrer_workspace" };
    const key = `referral:publish_message:${attribution.id}`;
    // Idempotency first: once granted, nothing is re-evaluated or re-granted.
    if (await findByKey(svc, referrerWsId, key)) return { granted: false, reason: "already_granted" };

    // Condition 1 — published: at least one LIVE production deployment in the referred workspace.
    const live = await svc.entities.Deployment.filter(
      { workspace_id, environment: "production", status: "LIVE" }, "created_date", 1,
    ).catch(() => []);
    // Condition 2 — messaged: at least one user message in any project of the referred
    // workspace. On the message hook the condition is satisfied by the event itself.
    let messaged = event === "message";
    if (!messaged) {
      const projects = await svc.entities.Project.filter({ workspace_id }, "created_date", 50).catch(() => []);
      for (const p of projects) {
        const msgs = await svc.entities.Message.filter({ project_id: p.id, role: "user" }, "created_date", 1).catch(() => []);
        if (msgs.length) { messaged = true; break; }
      }
    }
    if (!live.length) return { granted: false, reason: "not_published" };
    if (!messaged) return { granted: false, reason: "no_message" };

    // The referrer's grant through the EXISTING authoritative ledger (workspace-scoped
    // idempotency key), then the existing audit infrastructure.
    await recordEvent(svc, {
      workspace_id: referrerWsId, user_id: attribution.referrer_user_id, project_id: null,
      event_type: "promotional", amount: REFERRAL_REWARD_CREDITS,
      idempotency_key: key, reason: "Referral publish+message reward",
    });
    await audit(svc, {
      workspace_id: referrerWsId, project_id: null, user_id: attribution.referrer_user_id,
      action: "referral.reward.granted", resource: "Referral", resource_id: attribution.id,
      metadata: { referred_user_id: user_id, trigger: event || null, amount: REFERRAL_REWARD_CREDITS },
    }).catch(() => {});
    return { granted: true, referrer_workspace_id: referrerWsId, referral_id: attribution.id };
  } catch (e) {
    // A reward problem never breaks the publish or the message enqueue it rode in on.
    return { granted: false, reason: "error", error: String(e?.message || e).slice(0, 200) };
  }
}

// Referrer upgrade reward (Slice 3): when a referred workspace completes its FIRST qualifying
// paid-plan upgrade — a PAID subscription start with real money (amount_cents > 0), settled
// non-duplicated through the canonical processBillingEvent, or the P-8.9 paid conversion of a
// running trial — the referrer earns exactly +100 promotional credits, granted ONCE through the
// ledger under `referral:upgrade:{referral_id}`. Server-side only (the detection rides the
// existing billing paths; no client surface exists), requires an existing valid Referral
// attribution row matched by referred_workspace_id (so a foreign workspace's billing event can
// never earn anything), renewals/downgrades/trial/free grants are other event types or zero
// amounts and never qualify. The Slice 1 (+30 referred) and Slice 2 (+30 publish+message)
// grants are untouched, and a reward failure never breaks the billing flow it rode in on.
export const REFERRAL_UPGRADE_REWARD_CREDITS = 100;

export async function maybeGrantReferrerUpgradeReward(svc, { workspace_id, plan_code = null }) {
  try {
    if (!workspace_id) return { granted: false, reason: "no_workspace" };
    // Valid existing attribution, resolved SERVER-side by the referred workspace stamped on it.
    const rows = await svc.entities.Referral.filter({ referred_workspace_id: workspace_id }, "created_date", 1);
    const attribution = rows[0];
    if (!attribution || !attribution.referrer_user_id) return { granted: false, reason: "no_referral" };
    const referrerWsRows = await svc.entities.Workspace.filter({ owner_id: attribution.referrer_user_id }, "created_date", 1);
    const referrerWsId = referrerWsRows[0]?.id;
    if (!referrerWsId) return { granted: false, reason: "no_referrer_workspace" };
    const key = `referral:upgrade:${attribution.id}`;
    // Idempotency first: once granted, nothing is re-evaluated or re-granted.
    if (await findByKey(svc, referrerWsId, key)) return { granted: false, reason: "already_granted" };
    await recordEvent(svc, {
      workspace_id: referrerWsId, user_id: attribution.referrer_user_id, project_id: null,
      event_type: "promotional", amount: REFERRAL_UPGRADE_REWARD_CREDITS,
      idempotency_key: key, reason: "Referral paid-upgrade reward",
    });
    await audit(svc, {
      workspace_id: referrerWsId, project_id: null, user_id: attribution.referrer_user_id,
      action: "referral.upgrade_reward.granted", resource: "Referral", resource_id: attribution.id,
      metadata: { referred_workspace_id: workspace_id, plan_code: plan_code || null, amount: REFERRAL_UPGRADE_REWARD_CREDITS },
    }).catch(() => {});
    return { granted: true, referrer_workspace_id: referrerWsId, referral_id: attribution.id };
  } catch (e) {
    // A reward problem never breaks the billing event or subscription flow it rode in on.
    return { granted: false, reason: "error", error: String(e?.message || e).slice(0, 200) };
  }
}

const normalizeCode = (raw) => String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);

// Deterministic per-account code: two bootstraps of the same account always agree, so
// issuance races can never mint two different codes for one referrer, and the code is not
// reversible into the account id.
async function deriveCode(userId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`referral-v1:${userId}`));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// One referral code per referrer, issued lazily at workspace bootstrap. Idempotent: an
// existing row for the account wins; concurrent first bootstraps all derive the SAME code,
// so any duplicate rows are equivalent and every lookup still resolves the same referrer.
export async function ensureReferralCode(svc, user) {
  const code = await deriveCode(user.id);
  const mine = await svc.entities.Referral.filter({ referrer_user_id: user.id }, "created_date", 1);
  if (mine.length) return mine[0].code;
  await svc.entities.Referral.create({ referrer_user_id: user.id, code }).catch(() => {});
  return code;
}

// Redeems a code at first-entry bootstrap: exactly one attribution row per referred account
// (query-first + earliest-wins dedup, mirroring the workspace bootstrap race pattern), and
// exactly one 30-credit promotional grant per referred workspace through the ledger
// (`referral:welcome:{workspace_id}`). Self-referral, already-attributed accounts, and
// unknown codes fail SAFELY — the caller's bootstrap proceeds exactly as if no code was
// given. Never throws for an unusable code.
export async function applyReferralCode(svc, user, workspace, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code || !workspace?.id || !user?.id) return { applied: false, reason: "no_code" };

  const already = await svc.entities.Referral.filter({ referred_user_id: user.id }, "created_date", 1);
  if (already.length) return { applied: false, reason: "already_attributed" };

  const rows = await svc.entities.Referral.filter({ code }, "created_date", 5);
  const issuance = rows.find((r) => r.referrer_user_id && r.referrer_user_id !== user.id);
  if (!issuance) return { applied: false, reason: "unknown_or_self" };

  await svc.entities.Referral.create({
    referrer_user_id: issuance.referrer_user_id, code,
    referred_user_id: user.id, referred_workspace_id: workspace.id,
    attributed_at: new Date().toISOString(), granted_credits: REFERRAL_GRANT_CREDITS,
  });
  // Concurrent redemptions raced: every duplicate keeps the same values, and the earliest
  // attribution row always survives the mutual dedup.
  const dups = await svc.entities.Referral.filter({ referred_user_id: user.id }, "created_date", 5);
  for (const dup of dups.slice(1)) await svc.entities.Referral.delete(dup.id).catch(() => {});

  await recordEvent(svc, {
    workspace_id: workspace.id, event_type: "promotional", amount: REFERRAL_GRANT_CREDITS,
    idempotency_key: `referral:welcome:${workspace.id}`, reason: "Referral welcome credits",
  }).catch(() => {});

  return { applied: true, referrer_user_id: issuance.referrer_user_id };
}