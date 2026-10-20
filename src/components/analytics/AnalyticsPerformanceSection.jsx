import React, { useEffect, useState } from "react";
import Section from "@/components/shell/Section";
import MetricRow from "@/components/shell/MetricRow";
import DataList from "@/components/shell/DataList";

// Latency analytics for this application.
//
// Reads the EXISTING `performance` operator action — the platform's one performance telemetry
// source — and renders only what it returns: sample counts and the averages/percentiles it already
// computed server-side. Nothing is timed or aggregated in the browser.
const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toLocaleString();
const ms = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toLocaleString()} ms` : "—");

export default function AnalyticsPerformanceSection({ query }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    query("performance")
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) { setData(null); setError(e.response?.data?.error || e.message || "Performance analytics unavailable"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  const rows = data?.by_event || [];
  const slowest = rows.reduce((worst, r) => (Number(r.p95_duration_ms) > Number(worst?.p95_duration_ms || -1) ? r : worst), null);

  return (
    <Section title="Performance" description="Latency carried by this application's performance events.">
      {error ? (
        <p className="text-[13px] text-destructive">{error}</p>
      ) : loading && !data ? (
        <p className="text-[13px] text-muted-foreground">Loading performance analytics…</p>
      ) : (
        <div className="space-y-4">
          <MetricRow
            items={[
              { label: "Performance events", value: fmt(data?.total_events) },
              { label: "Tracked operations", value: fmt(rows.length) },
              { label: "Slowest p95", value: ms(slowest?.p95_duration_ms), sub: slowest?.key || "No samples" },
              { label: "Environment", value: data?.environment || "production", sub: data?.scan_truncated ? "Partial scan" : "Full range scanned" },
            ]}
          />
          <DataList
            empty="No performance events in this range. Track an event with a duration to populate this."
            columns={[
              { key: "key", label: "Operation", mono: true, render: (r) => r.key },
              { key: "samples", label: "Samples", align: "right", render: (r) => fmt(r.samples) },
              { key: "avg", label: "Average", align: "right", render: (r) => ms(r.avg_duration_ms) },
              { key: "p50", label: "p50", align: "right", render: (r) => ms(r.p50_duration_ms) },
              { key: "p95", label: "p95", align: "right", render: (r) => ms(r.p95_duration_ms) },
              { key: "pages", label: "Pages", render: (r) => <span className="text-muted-foreground">{(r.pages || []).slice(0, 3).join(", ") || "—"}</span> },
            ]}
            rows={rows}
          />
        </div>
      )}
    </Section>
  );
}