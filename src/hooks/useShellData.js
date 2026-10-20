import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";

// ONE read of the data the shell chrome needs, from the EXISTING sources only:
// · plan / credits / renewal → commerce "billing_overview" (the same call the Billing page uses)
// · member count            → WorkspaceMember rows
// · recents                 → the workspace's Projects, newest first
// Nothing is fabricated: a value the platform does not track comes back null and the UI says so.
export function useShellData() {
  const { user, workspace, role, capabilities, loading, referralCode } = useWorkspace();
  const [billing, setBilling] = useState(null);
  const [memberCount, setMemberCount] = useState(null);
  const [recents, setRecents] = useState([]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    Promise.all([
      base44.functions.invoke("commerce", { action: "billing_overview", workspace_id: workspace.id }).then((r) => r.data).catch(() => null),
      workspaceRead("members", { workspace_id: workspace.id }).then((d) => (d.members || []).filter((m) => m.status === "active")).catch(() => []),
      workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 6 }).then((d) => d.projects || []).catch(() => []),
    ]).then(([b, members, projects]) => {
      if (cancelled) return;
      setBilling(b);
      setMemberCount(Array.isArray(members) ? members.length : null);
      setRecents(projects || []);
    });
    return () => { cancelled = true; };
  }, [workspace]);

  const plan = billing?.plan || null;
  const sub = billing?.subscription || null;
  const balance = billing?.balance || null;
  const includedCredits = plan?.included_credits ?? null;
  const available = balance?.available ?? workspace?.credits_balance ?? null;

  return {
    user, workspace, role, capabilities, loading, referralCode,
    memberCount, recents,
    // Effective-plan entitlement flags (server-resolved via billing_overview → entitlementsFor).
    // {} before the overview resolves; a lapsed subscription yields {} (no entitlements).
    entitlements: billing?.entitlements?.entitlements || {},
    plan: { code: plan?.code || sub?.plan_code || "free", name: plan?.name || null, tier_rank: plan?.tier_rank ?? null, entitlements: plan?.entitlements || billing?.entitlements?.entitlements || {} },
    renewalDate: sub?.current_period_end || null,
    credits: {
      available,
      total: balance?.balance ?? null,
      reserved: balance?.reserved ?? null,
      included: includedCredits,
      // Usage inside the current period, as the billing layer reports it.
      used: billing?.usage?.total_credits ?? null,
      // Ceiling the plan enforces through the budget engine, when it defines one.
      monthlyLimit: plan?.usage_limits?.monthly_credits ?? null,
      // Per-pool balances (ledger by_type) and each pool's plan inclusion — never summed.
      message: { available: balance?.by_type?.message?.available ?? null, included: plan?.included_credits ?? null },
      integration: { available: balance?.by_type?.integration?.available ?? null, included: plan?.included_integration_credits ?? null },
    },
  };
}