// Targeted certification for Zernio Ads ingestion: existing-account linking, external-campaign
// import (idempotent upsert), pagination/partial detection, project isolation and period-scoped
// weekly reports. ZERO real network calls (the fetch seam is injected), nothing is created or
// changed at any provider: the fake fetcher records every request and the cert asserts GET only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider } from "../../shared/zernioAdsProvider.ts";
import { makeAdsSurface, makeAdsStubProvider } from "../../shared/adsCertStubs.ts";
import { runWeeklyAdsReport, weekBucket } from "../../shared/adsReporting.ts";

const KEY = "test-zernio-key";
const camp = (id, spend) => ({ platformCampaignId: id, platform: "tiktok", campaignName: `Ext ${id}`, status: "active", metrics: { spend, impressions: 100, clicks: 10, conversions: 1, ctr: 0.1 } });

// pages: campaign pages to serve (each an array); pagesReported overrides pagination.pages.
function fakeZernio({ calls, accounts, pages, pagesReported }) {
  return async (url, init) => {
    const u = new URL(String(url));
    calls.push({ method: init?.method || "GET", path: u.pathname, query: Object.fromEntries(u.searchParams) });
    if (u.pathname.endsWith("/accounts")) {
      return new Response(JSON.stringify({ accounts, hasAnalyticsAccess: false, pagination: { page: 1, limit: 100, total: accounts.length, pages: 1 } }), { status: 200 });
    }
    const page = Number(u.searchParams.get("page") || 1);
    const total = pages.reduce((a, p) => a + p.length, 0);
    return new Response(JSON.stringify({ campaigns: pages[page - 1] || [], pagination: { page, limit: 100, total, pages: pagesReported || pages.length } }), { status: 200 });
  };
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  const ch = "zernio:tiktok";

  try {
    const ws = await svc.entities.Workspace.create({ name: `zing-${stamp}`, owner_id: `ownerI_${stamp}` });
    workspaces.push(ws.id);
    const mk = async (n) => { const p = await svc.entities.Project.create({ workspace_id: ws.id, name: `zing-${n}-${stamp}`, status: "ready", version_count: 1 }); projects.push(p.id); return p; };
    const projA = await mk("a"), projB = await mk("b");
    const user = { id: `ownerI_${stamp}`, email: "i@example.com" };
    const accounts = [
      { _id: `zacc-A-${stamp}`, platform: "tiktokads", displayName: "Shop TikTok", isActive: true, profileId: "p1" },
      { _id: `zacc-B-${stamp}`, platform: "tiktokads", displayName: "Other TikTok", isActive: true, profileId: "p1" },
      { _id: `zig-${stamp}`, platform: "instagram", displayName: "Not ads", isActive: true, profileId: "p1" },
    ];
    const calls = [];
    const fetcher = fakeZernio({ calls, accounts, pages: [[camp("c1", 5), camp("c2", 7)], [camp("c3", 9)]] });
    const provider = createZernioAdsProvider(ch, { fetcher, apiKey: KEY });
    const opts = { provider, fetcher, apiKey: KEY };

    // ---- 1. account connection ------------------------------------------------------------
    const opt = await surface(projA, user, { action: "account_options", channel: ch }, opts);
    h.check("account_options lists only this channel's Zernio ad accounts",
      opt.accounts.length === 2 && opt.accounts.every((a) => a.provider_account_ref.startsWith("zacc-")) && opt.complete === true,
      JSON.stringify(opt.accounts.map((a) => a.provider_account_ref)));
    const linked = await surface(projA, user, { action: "account_link", channel: ch, provider_account_ref: `zacc-A-${stamp}` }, opts);
    const accRow = (await svc.entities.AdsAccount.filter({ project_id: projA.id, channel: ch }, "-created_date", 5))[0];
    h.check("account_link stores the provider reference on THIS project's channel account",
      linked.account?.status === "active" && accRow?.provider_account_ref === `zacc-A-${stamp}` && accRow.workspace_id === ws.id,
      JSON.stringify({ ref: accRow?.provider_account_ref }));
    const again = await surface(projA, user, { action: "account_link", channel: ch, provider_account_ref: `zacc-A-${stamp}` }, opts);
    h.check("relinking the same account is idempotent (already_connected, one row)",
      again.already_connected === true && (await svc.entities.AdsAccount.filter({ project_id: projA.id, channel: ch }, "-created_date", 5)).length === 1, "idempotent");
    const unknown = await captureCall(() => surface(projA, user, { action: "account_link", channel: ch, provider_account_ref: "zacc-nope" }, opts));
    h.check("an account not connected in Zernio is refused (ACCOUNT_NOT_FOUND)", unknown.threw && unknown.code === "ACCOUNT_NOT_FOUND", unknown.code || "no-throw");
    const elsewhere = await captureCall(() => surface(projB, user, { action: "account_link", channel: ch, provider_account_ref: `zacc-A-${stamp}` }, opts));
    h.check("an account linked to another project is refused (ACCOUNT_LINKED_ELSEWHERE)", elsewhere.threw && elsewhere.code === "ACCOUNT_LINKED_ELSEWHERE", elsewhere.code || "no-throw");
    const google = await captureCall(() => surface(projA, user, { action: "account_link", channel: "google", provider_account_ref: "x" }, opts));
    h.check("non-Zernio channels cannot use account_link", google.threw && google.code === "CHANNEL_NOT_CONNECTABLE", google.code || "no-throw");
    const noKey = await captureCall(() => surface(projA, user, { action: "account_options", channel: ch }));
    h.check("without the provider configured, account_options fails closed", noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED", noKey.code || "no-throw");

    // ---- 2. import + idempotent upsert -----------------------------------------------------
    const first = await surface(projA, user, { action: "campaign_list", channel: ch }, opts);
    h.check("first sync walks both pages and imports all 3 external campaigns",
      first.provider_sync === "synced" && first.import?.created === 3 && first.import.complete === true && first.campaigns.length === 3,
      JSON.stringify(first.import));
    const second = await surface(projA, user, { action: "campaign_list", channel: ch }, opts);
    const rowsA = await svc.entities.AdsCampaign.filter({ project_id: projA.id, channel: ch }, "-created_date", 50);
    h.check("second sync creates nothing and updates the 3 rows (no duplicates)",
      second.import?.created === 0 && second.import.updated === 3 && rowsA.length === 3, JSON.stringify(second.import));
    h.check("imported rows are EXTERNAL, project/workspace/account-scoped, with labeled 90-day metrics",
      rowsA.every((r) => r.campaign_type === "EXTERNAL" && r.import_source === "zernio" && r.workspace_id === ws.id && r.account_id === accRow.id && r.metrics_window?.basis === "trailing_90_days"),
      JSON.stringify(rowsA.map((r) => r.metrics_window?.basis)));
    h.check("import made only GET requests to Zernio (nothing created or changed at the provider)",
      calls.every((c) => c.method === "GET"), JSON.stringify([...new Set(calls.map((c) => c.method))]));

    // ---- 3. isolation ---------------------------------------------------------------------
    const bList = await surface(projB, user, { action: "campaign_list", channel: ch }, opts);
    h.check("another project without a linked account sees none of A's campaigns and syncs nothing",
      bList.campaigns.length === 0 && bList.provider_sync === "skipped_not_configured", JSON.stringify(bList.campaigns.length));

    // ---- 4. partial import is reported, never silently complete ---------------------------
    const pCalls = [];
    const partialProvider = createZernioAdsProvider(ch, { fetcher: fakeZernio({ calls: pCalls, accounts, pages: [[camp("c1", 5)]], pagesReported: 99 }), apiKey: KEY });
    const partial = await surface(projA, user, { action: "campaign_list", channel: ch }, { provider: partialProvider });
    h.check("when the page cap stops the walk the sync is reported partial",
      partial.provider_sync === "partial" && partial.import?.complete === false, JSON.stringify(partial.import));

    // ---- 5. weekly report: period-scoped metrics, rows untouched --------------------------
    const before = (await svc.entities.AdsCampaign.filter({ project_id: projA.id, channel: ch }, "-created_date", 50)).map((r) => r.metrics?.cost_micros).sort().join(",");
    const rCalls = [];
    const repProvider = createZernioAdsProvider(ch, { fetcher: fakeZernio({ calls: rCalls, accounts, pages: [[camp("c1", 1), camp("c2", 2), camp("c3", 3)]] }), apiKey: KEY });
    const lastWeek = weekBucket(Date.now() - 7 * 86400000);
    const rep = await runWeeklyAdsReport(svc, projA, { id: ws.id }, ch, { provider: repProvider, providerLive: true, period: lastWeek });
    const q = rCalls.find((c) => c.path.endsWith("/ads/campaigns"))?.query || {};
    h.check("the weekly report requests the week's date window from Zernio",
      q.fromDate === lastWeek.start && q.toDate === lastWeek.end, JSON.stringify(q));
    const spend = rep.report.campaigns.reduce((a, c) => a + Number(c.metrics?.cost_micros || 0), 0);
    h.check("the report carries period metrics labeled basis=period, complete week",
      rep.report.status === "ok" && rep.report.metrics_window?.basis === "period" && rep.report.metrics_window.period_complete === true && spend === 6000000 && rep.report.import_complete === true,
      JSON.stringify({ w: rep.report.metrics_window, spend }));
    const after = (await svc.entities.AdsCampaign.filter({ project_id: projA.id, channel: ch }, "-created_date", 50)).map((r) => r.metrics?.cost_micros).sort().join(",");
    h.check("weekly metrics never overwrite the campaigns' stored (90-day) metrics", before === after, `${before} | ${after}`);
    await svc.entities.AdsAccount.create({ project_id: projB.id, workspace_id: ws.id, channel: "google", status: "active", provider_account_ref: "g-1" });
    const gRep = await runWeeklyAdsReport(svc, projB, { id: ws.id }, "google", { provider: makeAdsStubProvider(), providerLive: true });
    h.check("a Google report is labeled provider_cumulative (not presented as weekly spend)",
      gRep.report.metrics_window?.basis === "provider_cumulative", JSON.stringify(gRep.report.metrics_window));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      for (const ent of ["AdsAccount", "AdsCampaign", "AdsChangeLog", "AdsPerformanceReport", "AuditLog"]) await purgeBy(svc, ent, { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }
  return harnessResponse(h);
}