import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, UNAVAILABLE, fmtInt, fmtUsdFromMicros } from "./dashBits";
import GrowAdsCampaignActions from "./GrowAdsCampaignActions";

// One ad channel: status, KPI cards, campaign table with pause/resume + budget edit, budget tips.
// Reads only certified googleAds / managedAds surfaces; "—" = no data, never a fake zero.
const LEGACY = { google_ads: ["google", "Google Ads"], meta_ads: ["zernio:meta", "Meta Ads"] };
const errOf = (e) => e?.response?.data?.code || e?.message || "Request failed";

export default function GrowModuleDetail({ moduleId, channel: ch, title: t, projectId, onConfigure }) {
  const channel = ch || LEGACY[moduleId]?.[0];
  const title = t || LEGACY[moduleId]?.[1];
  const [data, setData] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const call = (fn, action) => base44.functions.invoke(fn, { action, project_id: projectId, channel }).then((r) => r.data);
    const [campaigns, recs] = await Promise.allSettled([call("googleAds", "campaign_list"), call("managedAds", "recommend_list")]);
    setData({ campaigns: campaigns.value, recs: recs.value });
    setError(campaigns.status === "rejected" ? errOf(campaigns.reason) : null);
    setLoading(false);
  }, [projectId, channel]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="grid place-items-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const campaigns = data.campaigns?.campaigns || [];
  const notConnected = data.campaigns?.provider_sync === "skipped_not_configured";
  const synced = campaigns.filter((c) => !c.metrics_pending);
  const has = synced.length > 0;
  const sum = (k) => synced.reduce((a, c) => a + Number(c[k] || 0), 0);
  const cost = sum("cost_micros"), clicks = sum("clicks"), conv = sum("conversions"), impr = sum("impressions");
  const v = (x) => (has ? x : UNAVAILABLE);
  const recs = data.recs?.recommendations || [];
  const status = notConnected ? "Не подключено" : campaigns.length === 0 ? "Нет кампаний" : has ? "Активно" : "Ждём данные";

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[16px] font-semibold text-foreground">{title}</h2>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{status}</span>
        <button type="button" onClick={load} title="Обновить"
          className="ml-auto grid h-8 w-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-accent">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        {onConfigure ? (
          <button type="button" onClick={() => onConfigure("runable_managed")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90">
            <Plus className="h-3.5 w-3.5" /> {notConnected ? "Подключить и запустить" : "Запустить рекламу"}
          </button>
        ) : null}
      </div>

      {error ? <StateNote tone="error" title="Не удалось загрузить статистику" detail={error} /> : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Потрачено" value={v(fmtUsdFromMicros(cost))} />
        <Stat label="Показы" value={v(fmtInt(impr))} />
        <Stat label="Клики" value={v(fmtInt(clicks))} />
        <Stat label="CTR" value={has && impr > 0 ? `${((clicks / impr) * 100).toFixed(2)}%` : UNAVAILABLE} />
        <Stat label="Конверсии" value={v(fmtInt(conv))} hint={has && conv > 0 ? `$${(cost / 1e6 / conv).toFixed(2)} за конверсию` : null} />
      </div>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold text-foreground">Кампании</h3>
        {campaigns.length === 0 ? (
          <StateNote tone={notConnected ? "disconnected" : "empty"}
            title={notConnected ? "Аккаунт не подключён" : "Кампаний пока нет"}
            detail={notConnected ? "Подключите рекламный аккаунт кнопкой выше." : "Запустите первую кампанию — статистика появится здесь."} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[12.5px]">
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">Кампания</th>
                  <th className="px-3 py-2 font-medium">Статус</th>
                  <th className="px-3 py-2 text-right font-medium">Потрачено</th>
                  <th className="px-3 py-2 text-right font-medium">Клики</th>
                  <th className="px-3 py-2 text-right font-medium">Конверсии</th>
                  <th className="px-3 py-2 text-right font-medium">Управление</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-border/60 last:border-0">
                    <td className="max-w-[220px] truncate px-3 py-2.5 font-medium text-foreground" title={c.campaign_name}>{c.campaign_name}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{c.status}</td>
                    <td className="px-3 py-2.5 text-right">{c.metrics_pending ? UNAVAILABLE : fmtUsdFromMicros(c.cost_micros)}</td>
                    <td className="px-3 py-2.5 text-right">{c.metrics_pending ? UNAVAILABLE : fmtInt(c.clicks)}</td>
                    <td className="px-3 py-2.5 text-right">{c.metrics_pending ? UNAVAILABLE : fmtInt(c.conversions)}</td>
                    <td className="px-3 py-2.5"><div className="flex justify-end"><GrowAdsCampaignActions projectId={projectId} channel={channel} campaign={c} onChanged={load} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {recs.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[13px] font-semibold text-foreground">Рекомендации по бюджету</h3>
          <div className="space-y-1.5 rounded-xl border border-border bg-card p-3">
            {recs.map((r, i) => (
              <p key={i} className="text-[12.5px] text-muted-foreground">
                <span className="font-medium text-foreground">{r.campaign_name || r.campaign_id}</span> · {r.recommendation?.suggested_action} — {r.recommendation?.reason}
              </p>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}