import React, { useState } from "react";
import { fmtInt } from "../dashBits";
import useOverviewData, { AD_CHANNELS } from "./useOverviewData";
import { UNAVAILABLE, fmtWhen } from "../dashBits";
import { base44 } from "@/api/base44Client";

// KPI row — only metrics the project's real data supports; an absent metric renders
// "unavailable", never zero. The visible chart metric is selectable.
const CARDS = [
  { k: "spend", label: "Ad spend", money: true },
  { k: "impressions", label: "Impressions" },
  { k: "clicks", label: "Clicks" },
  { k: "conversions", label: "Conversions" },
  { k: "leads", label: "Leads" },
  { k: "revenue", label: "Revenue" },
];

const fmtMoney = (v) => (v == null ? UNAVAILABLE : `$${v.toFixed(2)}`);

export default function GrowKpiRow({ kpis }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {CARDS.map((c) => {
        const v = kpis[c.k];
        const shown = v == null ? UNAVAILABLE : c.money ? fmtMoney(v) : fmtInt(v);
        return (
          <div key={c.k} className="rounded-xl border border-border bg-card p-3">
            <p className="text-[11px] font-medium text-muted-foreground">{c.label}</p>
            <p className={`mt-1 truncate text-[18px] font-semibold tracking-tight ${v == null ? "text-muted-foreground" : "text-foreground"}`}>{shown}</p>
          </div>
        );
      })}
    </div>
  );
}

// Time-series over the certified weekly ad reports; a metric selector picks the series.
const METRICS = [
  { k: "spend", label: "Spend", money: true },
  { k: "impressions", label: "Impressions" },
  { k: "clicks", label: "Clicks" },
  { k: "conversions", label: "Conversions" },
];

export function GrowPerformanceChart({ kpis, days, loading, emptyHint }) {
  const [metric, setMetric] = useState("spend");
  if (loading) return null;
  if (!kpis.adsReports) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[12.5px] font-semibold text-foreground">Performance over time</p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">{emptyHint || "No ad reports synced yet for this range — connect an ads account in Running Ads and the weekly reports will appear here."}</p>
      </div>
    );
  }
  const pts = kpis.pts;
  const sel = METRICS.find((m) => m.k === metric);
  const max = Math.max(...pts.map((p) => p[metric] || 0), 1);
  const fmt = (v) => (sel.money ? `$${v.toFixed(0)}` : fmtInt(v));
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[12.5px] font-semibold text-foreground">Performance · last {days} days</p>
        <div className="flex gap-1">
          {METRICS.map((m) => (
            <button key={m.k} type="button" onClick={() => setMetric(m.k)} aria-pressed={m.k === metric}
              className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${m.k === metric ? "border-foreground/30 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex h-28 items-end gap-1.5">
        {pts.map((p) => {
          const v = p[metric] || 0;
          return (
            <div key={p.period} className="group relative flex-1 min-w-[6px]" title={`${p.period}: ${fmt(v)}`}>
              <div className="w-full rounded-t-md bg-brand/70 transition-all group-hover:bg-brand" style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{pts[0]?.period}</span><span>{pts[pts.length - 1]?.period}</span>
      </div>
    </div>
  );
}