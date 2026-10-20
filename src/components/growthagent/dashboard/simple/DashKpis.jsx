import React from "react";

const usd = (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

function Kpi({ label, value, note }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-[20px] font-semibold tracking-tight text-foreground">{value}</p>
      {note ? <p className="text-[11.5px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

// Revenue, Orders and Profit need Stripe (and cost data) — shown as a prompt, never a fake number.
export default function DashKpis({ channels }) {
  const live = channels.filter((c) => c.hasData);
  const spend = live.reduce((a, c) => a + c.spend, 0);
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Kpi label="Ad spend" value={live.length ? usd(spend) : "—"} note={live.length ? "Synced ad platforms" : "No synced campaigns"} />
      <Kpi label="Revenue" value="—" note="Connect Stripe to track" />
      <Kpi label="Orders" value="—" note="Connect Stripe to track" />
      <Kpi label="Profit" value="—" note="Needs revenue and cost data" />
    </div>
  );
}