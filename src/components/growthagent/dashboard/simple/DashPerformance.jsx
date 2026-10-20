import React from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

// Weekly ad spend from stored weekly reports; revenue line appears only once revenue data exists.
function weekly(channels) {
  const byWeek = {};
  // Only period-scoped reports are weekly spend; cumulative-provider reports are excluded.
  channels.forEach((c) => c.reports.filter((r) => r.metrics_window?.basis === "period").forEach((r) => {
    const cost = (r.campaigns || []).reduce((a, x) => a + Number(x.metrics?.cost_micros || x.cost_micros || 0), 0) / 1e6;
    byWeek[r.period_start] = (byWeek[r.period_start] || 0) + cost;
  }));
  return Object.keys(byWeek).sort().map((w) => ({ week: w.slice(5), spend: Math.round(byWeek[w]) }));
}

const cell = "px-3 py-2 text-right";

export default function DashPerformance({ channels }) {
  const series = weekly(channels);
  const rows = channels.filter((c) => c.hasData);
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[14px] font-semibold text-foreground">Performance</h2>
        <span className="text-[11.5px] text-muted-foreground">Revenue vs. ad spend · revenue needs Stripe</span>
      </div>
      <div className="mt-2 h-40">
        {series.length ? (
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip />
              <Line type="monotone" dataKey="spend" name="Ad spend ($)" stroke="hsl(var(--brand))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : <p className="grid h-full place-items-center text-[12.5px] text-muted-foreground">No weekly report data yet.</p>}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Chart: spend per week from weekly reports. Table: totals from the latest sync (Zernio channels: last 90 days).
        {channels.some((c) => c.partial) ? " Some campaigns could not be fully imported — totals may be incomplete." : ""}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-medium">Channel</th>
              <th className={`${cell} font-medium`}>Spend</th><th className={`${cell} font-medium`}>Clicks</th>
              <th className={`${cell} font-medium`}>Leads</th><th className={`${cell} font-medium`}>Sales</th>
              <th className={`${cell} font-medium`}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((c) => (
              <tr key={c.id} className="border-b border-border/60 last:border-0 text-foreground">
                <td className="px-3 py-2">{c.label}</td>
                <td className={cell}>${c.spend.toFixed(0)}</td><td className={cell}>{c.clicks}</td>
                <td className={cell}>—</td><td className={cell}>{c.sales}</td><td className={cell}>—</td>
              </tr>
            )) : (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No synced campaigns yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}