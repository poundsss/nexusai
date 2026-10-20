import React from "react";
import Section from "@/components/shell/Section";
import MetricRow from "@/components/shell/MetricRow";
import DataList from "@/components/shell/DataList";

const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toLocaleString();

// Server-aggregated counts, a bounded time series and the top event names. Nothing here scans the
// event stream in the browser — these are the operator API's own aggregates.
export default function AnalyticsOverviewSection({ overview }) {
  const totals = overview?.totals || {};
  const series = overview?.time_series || [];
  const peak = series.reduce((m, s) => Math.max(m, s.events || 0), 0);

  return (
    <div className="space-y-7">
      <MetricRow
        items={[
          { label: "Events", value: fmt(totals.events), sub: "in the selected range" },
          { label: "Unique users", value: fmt(totals.unique_users), sub: `${fmt(totals.unique_anonymous)} anonymous` },
          { label: "Unique sessions", value: fmt(totals.unique_sessions), sub: "distinct visits" },
          { label: "Errors", value: fmt(totals.errors), sub: "error events" },
        ]}
      />

      <Section title="Over time" description="Event volume per bucket, aggregated server-side.">
        {series.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No events in this range yet.</p>
        ) : (
          <div className="space-y-1.5">
            {series.map((s) => (
              <div key={s.bucket} className="flex items-center gap-3 text-[12px]">
                <span className="w-28 font-mono text-muted-foreground">{s.bucket}</span>
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-foreground/70" style={{ width: `${peak ? Math.round((s.events / peak) * 100) : 0}%` }} />
                </div>
                <span className="w-16 text-right tabular-nums">{fmt(s.events)}</span>
                <span className="w-24 text-right tabular-nums text-muted-foreground">{fmt(s.unique_sessions)} sess.</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Top events" description="The event names this application records most.">
        <DataList
          empty="No events recorded yet."
          columns={[
            { key: "key", label: "Event", mono: true, render: (r) => r.key },
            { key: "count", label: "Count", align: "right", render: (r) => fmt(r.count) },
          ]}
          rows={overview?.top_events || []}
        />
      </Section>
    </div>
  );
}