import React from "react";
import { AlertCircle, Send, Share2, Sprout, Store, Radar, Megaphone } from "lucide-react";
import { UNAVAILABLE, fmtInt, fmtUsdFromMicros, fmtWhen } from "../dashBits";

// Compact per-channel cards. Each card shows only metrics its certified surface actually
// carries, plus the honest connection status (connected / not connected / provider not
// configured / unavailable). Clicking opens that module's own dashboard.
const STATUS = {
  connected: "text-emerald-700 dark:text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
  not_connected: "text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/10",
  not_configured: "text-muted-foreground border-border bg-muted/40",
  unavailable: "text-destructive border-destructive/40 bg-destructive/10",
};
const STATUS_LABEL = {
  connected: "Connected", not_connected: "Not connected",
  not_configured: "Provider not configured", unavailable: "Unavailable",
};

const errTone = (has) => (has ? STATUS.unavailable : STATUS.not_connected);

export default function GrowChannelCards({ data, kpis, onOpen, errors }) {
  const spendByChannel = {};
  (kpis.pts || []).forEach(() => {});
  // Per-channel spend for the selected range comes from the reports themselves.
  const rows = data.reports || [];
  const adCards = Object.entries(data.accounts).map(([id, a]) => {
    const status = a.account?.status === "active" ? "connected"
      : a.account?.provider_configured === false ? "not_configured" : "not_connected";
    const chSpend = rows.filter((r) => r.channel === id)
      .reduce((s, r) => s + (r.campaigns || []).reduce((x, c) => x + Number(c.metrics?.cost_micros || 0), 0), 0) / 1e6;
    return { key: `ads:${id}`, icon: Megaphone, name: a.label, status, metric: status === "connected" && chSpend ? `$${chSpend.toFixed(2)} spend` : null, error: errors[a.label] };
  });
  const emailSteps = data.emailStats ? data.emailStats.reduce((a, r) => a + Number(r.count || 0), 0) : null;
  const channelCards = [
    ...adCards,
    { key: "email", icon: Send, name: "Email outreach", status: emailSteps ? "connected" : errTone(!!errors.Email), metric: emailSteps != null ? `${fmtInt(emailSteps)} steps run` : null, error: errors.Email },
    { key: "calls", icon: Radar, name: "Cold calling", status: data.callCount ? "connected" : errTone(!!errors.Calls), metric: data.callCount != null ? `${fmtInt(data.callCount)} calls scheduled` : null, error: errors.Calls },
    { key: "organic_growth", icon: Sprout, name: "Organic growth", status: (data.scans?.length || data.probes?.length) ? "connected" : errTone(!!errors.Organic), metric: `${fmtInt(data.scans?.length || null)} SEO audits · ${fmtInt(data.probes?.length || null)} AEO probes` },
    { key: "social_listening", icon: Radar, name: "Social listening", status: (data.terms?.length || data.prospects?.length) ? "connected" : errTone(!!errors["Social Listening"]), metric: `${fmtInt(data.terms?.length || null)} terms · ${fmtInt(data.prospects?.length || null)} prospects` },
    { key: "social_media", icon: Share2, name: "Social media", status: (data.postCount || data.posts?.length) ? "connected" : errTone(!!errors["Social Media"]), metric: data.postCount != null ? `${fmtInt(data.postCount)} calendar posts` : null },
    { key: "my_business", icon: Store, name: "My Business", status: "unavailable", metric: data.gbp?.code ? `GBP unavailable · ${data.gbp.code}` : "GBP unavailable (fail-closed)" },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {channelCards.map((c) => {
        const Icon = c.icon;
        return (
          <button key={c.key} type="button" onClick={() => onOpen(c.key.startsWith("ads:") ? "running_ads" : c.key)}
            className="group flex flex-col rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-foreground/25">
            <div className="flex items-center gap-2">
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">{c.name}</span>
            </div>
            <span className={`mt-2 inline-flex w-fit rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS[c.status] || STATUS.unavailable}`}>
              {STATUS_LABEL[c.status]}
            </span>
            {c.metric ? <p className="mt-1.5 truncate text-[11.5px] text-muted-foreground">{c.metric}</p> : null}
            {c.error ? (
              <span className="mt-1.5 inline-flex items-center gap-1 text-[10.5px] text-destructive"><AlertCircle className="h-3 w-3" />{c.error}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// Recent campaigns and activity — ads campaigns, email jobs and calls with status, last
// execution and their real recorded errors. Read-only.
const TAG = {
  campaign: "Ads", email: "Email", call: "Calls",
};
const toneOf = (status) => {
  const s = String(status || "").toLowerCase();
  if (["active", "done", "posted", "success", "succeeded", "completed", "dialing"].includes(s)) return "text-emerald-700 dark:text-emerald-300";
  if (["failed", "error", "canceled"].includes(s)) return "text-destructive";
  if (["pending", "queued", "scheduled", "proposal"].includes(s)) return "text-amber-700 dark:text-amber-300";
  return "text-muted-foreground";
};

export function GrowCampaignActivity({ data, onInspect }) {
  const rows = [
    ...(data.campaigns || []).map((c) => ({
      key: `c:${c.id}`, tag: TAG.campaign, name: c.name || c.campaign_name || "Campaign", status: c.status,
      at: c.last_synced_at || c.created_date, result: c.metrics_pending ? "pending sync" : c.metrics?.cost_micros != null ? fmtUsdFromMicros(c.metrics.cost_micros) : UNAVAILABLE,
      error: c.error || null, inspect: true,
    })),
    ...(data.emailJobs || []).map((j) => ({
      key: `j:${j.id}`, tag: TAG.email, name: j.name || "Email step", status: j.status,
      at: j.created_date, result: j.result || null, error: j.error || null,
    })),
    ...(data.calls || []).map((k) => ({
      key: `k:${k.id}`, tag: TAG.call, name: "Cold call", status: k.status,
      at: k.dialed_at || k.created_at || k.created_date, result: k.summary || null, error: k.blocker_code || null,
    })),
  ].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 10);
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[12.5px] font-semibold text-foreground">Recent activity</p>
        <p className="mt-1 text-[11.5px] text-muted-foreground">No campaigns, email steps or calls recorded for this project yet.</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <p className="px-3 pt-3 text-[12.5px] font-semibold text-foreground">Recent campaigns &amp; activity</p>
      <table className="mt-2 w-full text-[12px]">
        <thead><tr className="border-b border-border text-left text-muted-foreground">
          <th className="px-3 py-1.5 font-medium">Type</th><th className="px-3 py-1.5 font-medium">Item</th>
          <th className="px-3 py-1.5 font-medium">Status</th><th className="px-3 py-1.5 font-medium">Last run</th>
          <th className="px-3 py-1.5 font-medium">Result</th><th className="px-3 py-1.5 font-medium">Error</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-border/60 last:border-0">
              <td className="px-3 py-2 text-muted-foreground">{r.tag}</td>
              <td className="max-w-[220px] truncate px-3 py-2 font-medium text-foreground">
                {r.inspect ? <button type="button" onClick={() => onInspect?.("running_ads")} className="underline decoration-dotted underline-offset-2 hover:decoration-solid">{r.name}</button> : r.name}
              </td>
              <td className={`px-3 py-2 font-medium ${toneOf(r.status)}`}>{r.status || UNAVAILABLE}</td>
              <td className="px-3 py-2 text-muted-foreground">{fmtWhen(r.at) || UNAVAILABLE}</td>
              <td className="max-w-[160px] truncate px-3 py-2 text-muted-foreground">{r.result || UNAVAILABLE}</td>
              <td className="max-w-[160px] truncate px-3 py-2 text-destructive">{r.error || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}