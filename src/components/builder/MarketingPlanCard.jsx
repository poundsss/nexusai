import React, { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, Target, DollarSign, Users, Trophy } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { formatDistanceToNow } from "date-fns";

// Marketing plan (Slice 1) — MINIMAL READ-ONLY card over the persisted, project-scoped
// MarketingPlan surface (base44/functions/marketingPlan: get through loadAuthorizedProject).
// No setup form, no actions, no tracking — display only, exactly like the audit scoped it.
const PRIORITY_LABELS = { must_have: "Must have", medium: "Medium", nice_to_have: "Nice to have" };

export default function MarketingPlanCard({ projectId }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await base44.functions.invoke("marketingPlan", { action: "get", project_id: projectId });
      setPlan(res.data?.plan || null);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Target className="h-3.5 w-3.5" />Marketing plan
        </h3>
      </div>

      {loading ? (
        <div className="p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
      ) : error ? (
        <div className="flex items-start gap-2 p-3 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="text-[12px]">{error}</div>
        </div>
      ) : !plan ? (
        <p className="p-3 text-[12px] text-muted-foreground/60">No marketing plan yet.</p>
      ) : (
        <div className="p-3 space-y-3 text-[12px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{plan.goal}</span>
            <span className="text-muted-foreground">· {plan.audience}</span>
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground/60">
              <DollarSign className="h-3 w-3" />
              {plan.budget_mode === "paid" ? `$${plan.budget_monthly_amount}/mo paid` : "Organic — no paid budget"}
            </span>
          </div>

          {plan.strategy && <p className="leading-relaxed text-foreground/90">{plan.strategy}</p>}

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Channels</p>
            <div className="mt-1 divide-y divide-border rounded-md border border-border">
              {plan.channels.map((c, i) => (
                <div key={i} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${c.priority === "must_have" ? "bg-destructive/10 text-destructive" : c.priority === "medium" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground"}`}>
                      {PRIORITY_LABELS[c.priority] || c.priority}
                    </span>
                  </div>
                  {c.tactics && <p className="mt-0.5 text-[11.5px] text-muted-foreground">{c.tactics}</p>}
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Key metrics</p>
            <div className="mt-1 divide-y divide-border rounded-md border border-border">
              {plan.metrics.map((m, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">{m.target}</span>
                </div>
              ))}
            </div>
          </div>

          {plan.include_competitors && plan.competitors.length > 0 && (
            <div>
              <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                <Users className="h-3 w-3" />Competitors
              </p>
              <div className="mt-1 divide-y divide-border rounded-md border border-border">
                {plan.competitors.map((c, i) => (
                  <div key={i} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                      {c.website && <span className="shrink-0 truncate text-[10.5px] text-muted-foreground/60">{c.website}</span>}
                    </div>
                    {c.description && <p className="mt-0.5 text-[11.5px] text-muted-foreground">{c.description}</p>}
                    {c.market_gap && (
                      <p className="mt-0.5 flex items-start gap-1 text-[11.5px] text-foreground/80">
                        <Trophy className="mt-0.5 h-3 w-3 shrink-0" />{c.market_gap}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10.5px] text-muted-foreground/60">
            Generated{plan.generated_at ? ` ${formatDistanceToNow(new Date(plan.generated_at), { addSuffix: true })}` : ""} · 10 integration credits per plan generation.
          </p>
        </div>
      )}
    </div>
  );
}