import React from "react";

// Secondary, compact list — leads, calls, emails — instead of more cards.
export default function DashActivity({ leads, calls }) {
  const items = [
    ["Leads", leads],
    ["Calls", calls],
    ["Emails", null],
  ];
  return (
    <section className="rounded-lg border border-border bg-card px-3 py-2">
      <h2 className="pt-1 text-[14px] font-semibold text-foreground">Activity</h2>
      <div className="divide-y divide-border">
        {items.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between py-2 text-[13px]">
            <span className="text-foreground">{k}</span>
            <span className="text-muted-foreground">{v == null ? "Not tracked yet" : v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}