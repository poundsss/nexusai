import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// Real project data only, via the existing googleAds surface + entity counts. Nothing invented.
export const CHANNELS = [
  { id: "google", label: "Google Ads" },
  { id: "zernio:meta", label: "Meta Ads" },
  { id: "zernio:tiktok", label: "TikTok Ads" },
  { id: "zernio:linkedin", label: "LinkedIn Ads" },
  { id: "zernio:openai", label: "ChatGPT Ads" },
];

const inv = (action, project_id, channel) =>
  base44.functions.invoke("googleAds", { action, project_id, channel }).then((r) => r.data);
const val = (r) => (r.status === "fulfilled" ? r.value : null);

export default function useGrowDashboardData(projectId) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) { setData(null); return; }
    setLoading(true);
    const channels = await Promise.all(CHANNELS.map(async (c) => {
      const [acc, camps, reps] = await Promise.allSettled([
        inv("account_get", projectId, c.id), inv("campaign_list", projectId, c.id), inv("report_list", projectId, c.id),
      ]);
      const campaigns = (val(camps)?.campaigns || []).filter((x) => !x.metrics_pending);
      const sum = (k) => campaigns.reduce((a, x) => a + Number(x[k] || 0), 0);
      return {
        ...c,
        status: val(acc)?.account?.status || null,
        accountError: acc.status === "rejected" ? (acc.reason?.response?.data?.error || acc.reason?.message || "Could not load account") : null,
        hasData: campaigns.length > 0,
        partial: val(camps)?.provider_sync === "partial",
        spend: sum("cost_micros") / 1e6, clicks: sum("clicks"), sales: sum("conversions"),
        reports: (val(reps)?.reports || []).filter((r) => r.status === "ok"),
      };
    }));
    const [leads, calls] = await Promise.allSettled([
      base44.entities.Customer.count({ project_id: projectId }),
      base44.entities.ColdCall.count({ project_id: projectId }),
    ]);
    setData({ channels, leads: val(leads), calls: val(calls) });
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  return { data, loading, reload: load };
}