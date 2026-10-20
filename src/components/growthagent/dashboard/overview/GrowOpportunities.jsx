import React from "react";
import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { UNAVAILABLE } from "../dashBits";

// Growth opportunities — ONLY the approval-gated recommendations the certified managedAds
// surface itself produced, plus launch blockers already recorded. Nothing is fabricated.
const TONE = {
  pending: { icon: Clock, cls: "text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/10" },
  approved: { icon: CheckCircle2, cls: "text-emerald-700 dark:text-emerald-300 border-emerald-500/30 bg-emerald-500/10" },
};
export default function GrowOpportunities({ recs, accounts }) {
  const blockers = Object.entries(accounts || {})
    .filter(([, a]) => a.account && a.account.status !== "active" && Array.isArray(a.blockers) && a.blockers.length)
    .map(([id, a]) => ({ channel: a.label, items: a.blockers }));
  const empty = !(recs || []).length && !blockers.length;
  if (empty) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[12.5px] font-semibold text-foreground">Growth opportunities</p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">No recommendations or blockers recorded yet — recommendations appear here once the optimization loop produces them, and each executes only after your approval.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[12.5px] font-semibold text-foreground">Growth opportunities</p>
      <div className="mt-2.5 space-y-2">
        {(recs || []).map((r, i) => {
          const state = String(r.state || r.status || "pending").toLowerCase();
          const tone = TONE[state] || TONE.pending;
          const Icon = tone.icon;
          return (
            <div key={`${r.id || i}`} className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
              <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${state === "approved" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-foreground">{r.type || r.kind || "Recommendation"} · {r.channel}</p>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{r.reason || r.detail || r.summary || UNAVAILABLE}</p>
              </div>
              <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone.cls}`}>{state}</span>
            </div>
          );
        })}
        {blockers.map((b) => (
          <div key={b.channel} className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium text-foreground">{b.channel} launch blocker</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{b.items.join(" · ")}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}