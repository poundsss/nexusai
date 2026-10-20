import React, { useCallback, useEffect, useState } from "react";
import { Trophy, Loader2, RefreshCw, Info } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Project reward history — the certified `reward` list surface (read-only).
// Rewards are RL episode rewards derived server-side from an evaluation + authoritative outcome;
// this panel only displays them. No reward is created or modified here, and the referral reward
// (a different domain with no backend) is NOT wired here — see the audit's UNKNOWN notes.
// Phase UI-3: reward history/status — `list` (history of episode rewards) + `policies` (current
// reward policy version). Referral-domain rewards have NO backend (UNKNOWN) — the Reward backend is
// project-scoped RL episode rewards, not referral payouts; no redemption/payout/eligibility is invented.
const STATUS_TONE = {
  active: "bg-emerald-500/10 text-emerald-600",
  superseded: "bg-muted text-muted-foreground",
  insufficient_evidence: "bg-amber-500/10 text-amber-600",
};
const OUTCOME_TONE = { known: "text-emerald-600", partial: "text-amber-600", unknown: "text-muted-foreground" };

export default function RewardsPanel({ projectId }) {
  const [data, setData] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [res, pol] = await Promise.all([
        base44.functions.invoke("reward", { action: "list", project_id: projectId, limit: 20 }),
        base44.functions.invoke("reward", { action: "policies" }).catch(() => null),
      ]);
      setData(res.data);
      if (pol?.data) setPolicy(pol.data);
    } catch (e) {
      setData({ error: e.response?.data?.error || e.message });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const rewards = data?.rewards || [];
  const policyVersions = policy?.versions || [];

  return (
    <div className="mt-4 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 mb-2">
        <Trophy className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Reward history</h3>
        <span className="text-[11px] text-muted-foreground/60">{rewards.length}</span>
        <button onClick={load} className="ml-auto text-muted-foreground hover:text-foreground transition-colors" aria-label="Refresh"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      <p className="text-[12px] text-muted-foreground mb-2">
        Episode rewards derived from evaluations and user outcomes for this app. Read-only — rewards are computed server-side, never submitted from the UI.
      </p>
      {policy && (
        <div className="flex items-center gap-2 mb-2 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" />
          <span>Reward policy <span className="font-mono">{policy.current}</span>{policyVersions.length > 1 && <span className="text-muted-foreground/70"> · {policyVersions.length} versions on record</span>}</span>
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : data?.error ? (
        <p className="text-[12px] text-destructive">{data.error}</p>
      ) : rewards.length === 0 ? (
        <p className="text-[12px] text-muted-foreground/60 py-3 text-center">No reward records yet.</p>
      ) : (
        <ul className="divide-y divide-border/40 rounded-md border border-border">
          {rewards.map((r) => (
            <li key={r.id} className="px-2.5 py-1.5">
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${STATUS_TONE[r.status] || "bg-muted text-muted-foreground"}`}>{r.status}</span>
                <span className="font-mono text-[11px] text-muted-foreground">rev {r.revision}</span>
                <span className="font-mono text-[11px] text-muted-foreground">policy {r.reward_policy_version}</span>
                {r.version_number != null && <span className="font-mono text-[11px] text-muted-foreground">v{r.version_number}</span>}
                <span className="ml-auto font-mono text-[12px]">reward {r.final_reward == null ? "—" : Number(r.final_reward).toFixed(3)}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
                <span>objective {r.objective_reward == null ? "—" : Number(r.objective_reward).toFixed(3)}</span>
                <span>outcome {r.outcome_reward == null ? "—" : Number(r.outcome_reward).toFixed(3)}</span>
                <span className={OUTCOME_TONE[r.outcome_status] || ""}>outcome: {r.outcome_status}</span>
                {r.user_outcome && <span>· {r.user_outcome}</span>}
                {r.calculated_at && <span className="ml-auto">{new Date(r.calculated_at).toLocaleString()}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}