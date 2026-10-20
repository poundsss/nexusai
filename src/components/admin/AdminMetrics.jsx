import React from "react";

const CARDS = [
  ["Workspaces", "workspaces"], ["Projects", "projects"], ["AI runs", "runs"],
  ["Failed runs", "failed_runs"], ["Live deployments", "live_deployments"], ["Subscriptions", "active_subscriptions"],
  ["Credits held", "credits_balance"], ["Dead letters", "dead_letters"], ["Suspended", "suspended_workspaces"],
];

// Dense platform header: one row of counts, no decorative cards.
export default function AdminMetrics({ totals }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 divide-x divide-border border-y border-border">
      {CARDS.map(([label, key]) => (
        <div key={key} className="px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground truncate">{label}</div>
          <div className="text-[16px] font-semibold tabular-nums leading-tight mt-0.5">{(totals?.[key] ?? 0).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}