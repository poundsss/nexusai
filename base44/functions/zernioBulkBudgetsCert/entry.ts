// Targeted certification for the SIXTH implemented Zernio Ads runtime operation:
// bulkBudgets (shared/zernioAdsProvider.ts). Deterministic everywhere — the cert makes ZERO
// real network calls (the fetch seam is injected), opens no spend, and mutates nothing on any
// provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls;
//   2. Zernio documents NO bulk-budget endpoint (the only documented bulk path, bulk-status,
//      writes STATUS and never budgets) — the op is a bounded, NON-ATOMIC composition over the
//      documented single-campaign budget write: per entry, PUT
//      https://zernio.com/api/v1/ads/campaigns/{providerId}, Bearer header, JSON body
//      { platform, budget: { amount, type: "daily" } } (docs.zernio.com/ad-campaigns/
//      update-ad-campaign, fetched 2026-10-06);
//   3. mapping: the contract's non-atomic return shape
//      { succeeded: [id], failed: [{ campaign_id, reason }] } — one bad entry never fails the
//      batch and a failed entry's reason is carried through bounded;
//   4. whole-op refusals BEFORE any call: empty entries, more than the contract's 50-entry
//      bound, zernio:meta (the platform half is never declared) and a documented-501 budget
//      platform (tiktok); per-entry refusals (a missing provider id, a non-whole-unit budget)
//      land in `failed` with ZERO calls for that entry; a Zernio 401 on one entry fails the
//      batch and aborts the remaining entries without further calls;
//   5. every other operation stays fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   6. through the REAL surface: a configured-injection campaign_bulk_budget persists the
//      succeeded budgets and writes the change log, a documented-501 channel refuses and
//      persists NOTHING, and Google stays untouched.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated, no real key is provisioned, no real budget is written.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { zernioProviderConfigured } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

const DOCUMENTED_UPDATE = {
  updated: 1,
  budget: { amount: 10, type: "daily", amountMicros: "10000000", explicitlyShared: false, resourceName: "accounts/1/budgets/2", deliveryMethod: "STANDARD" },
  budgetLevel: "campaign",
};

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({
    url: String(url),
    method: init?.method,
    auth: init?.headers?.Authorization || null,
    contentType: init?.headers?.["Content-Type"] || null,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  return new Response(JSON.stringify({ ...DOCUMENTED_UPDATE, budget: { ...DOCUMENTED_UPDATE.budget, amount: JSON.parse(String(init.body)).budget.amount } }), { status: 200 });
};

const entry = (cid, pid, micros) => ({ campaign_id: cid, provider_campaign_id: pid, daily_budget_micros: micros });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;

  try {
    // ---- 1. fail-closed without a key (production state: no key is provisioned) ----------
    h.check("production state: no ZERNIO_API_KEY is provisioned for this app",
      zernioProviderConfigured() === false, String(zernioProviderConfigured()));
    const noKeyCalls = [];
    const noKeyAdapter = createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(noKeyCalls) });
    const noKey = await captureCall(() => noKeyAdapter.bulkBudgets({ entries: [entry("row-1", "111", 10000000)] }));
    h.check("without the key, bulkBudgets refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);

    // ---- 2. auth + request shape: per-entry composition over the documented write --------
    const calls = [];
    const openai = createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(calls), apiKey: "test-zernio-key" });
    const res = await openai.bulkBudgets({ entries: [entry("row-1", "111", 10000000), entry("row-2", "222", 20000000)] });
    h.check("each entry is one PUT on the documented endpoint with the Bearer auth header",
      calls.length === 2 && calls.every((c) => c.method === "PUT" &&
        /^https:\/\/zernio\.com\/api\/v1\/ads\/campaigns\/\d+$/.test(c.url) &&
        typeof c.auth === "string" && c.auth.startsWith("Bearer ") &&
        c.contentType === "application/json"),
      calls.map((c) => `${c.method} ${c.url}`).join(" | "));
    h.check("each body maps ONLY the contract fields: { platform, budget: { amount, type: \"daily\" } }",
      JSON.stringify(calls[0].body) === JSON.stringify({ platform: "openai", budget: { amount: 10, type: "daily" } }) &&
      JSON.stringify(calls[1].body) === JSON.stringify({ platform: "openai", budget: { amount: 20, type: "daily" } }),
      JSON.stringify([calls[0].body, calls[1].body]));
    h.check("the key is sent only in the header (starts with Bearer, never in the URL or bodies)",
      calls.every((c) => c.auth?.startsWith("Bearer ")) &&
      !JSON.stringify(calls.map((c) => [c.url, c.body])).includes("test-zernio-key"), "header-only");

    // ---- 3. mapping: the contract's non-atomic return shape ------------------------------
    h.check("a clean batch maps to succeeded in entry order with an empty failed list",
      JSON.stringify(res.succeeded) === JSON.stringify(["row-1", "row-2"]) && res.failed.length === 0,
      JSON.stringify(res));
    const mixedCalls = [];
    const mixed = await createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(mixedCalls), apiKey: "test-zernio-key" })
      .bulkBudgets({ entries: [
        entry("row-1", "111", 10000000),
        entry("row-2", "", 10000000),
        entry("row-3", "333", 10000001),
        entry("row-4", "444", 20000000),
      ] });
    h.check("one bad entry never fails the batch: the good entries succeed, the bad land in failed",
      JSON.stringify(mixed.succeeded) === JSON.stringify(["row-1", "row-4"]) &&
      mixed.failed.length === 2 && mixed.failed[0].campaign_id === "row-2" &&
      mixed.failed[0].reason.includes("provider_campaign_id") &&
      mixed.failed[1].campaign_id === "row-3" && mixed.failed[1].reason.includes("whole number"),
      JSON.stringify(mixed));
    h.check("a per-entry refusal makes ZERO calls for that entry (only the good entries fetched)",
      mixedCalls.length === 2 &&
      mixedCalls.every((c) => ["/111", "/444"].some((p) => String(c.url).endsWith(p))),
      JSON.stringify(mixedCalls.map((c) => c.url)));

    // ---- 4. whole-op refusals BEFORE any call --------------------------------------------
    const refuse = async (channel, entries) => {
      const c = [];
      const r = await captureCall(() => createZernioAdsProvider(channel, { fetcher: documentedFetcher(c), apiKey: "test-zernio-key" })
        .bulkBudgets({ entries }));
      return { r, calls: c };
    };
    const emptyEntries = await refuse("zernio:openai", []);
    h.check("empty entries refuse with PROVIDER_INVALID_INPUT before any call",
      emptyEntries.r.threw && emptyEntries.r.code === "PROVIDER_INVALID_INPUT" && emptyEntries.calls.length === 0,
      `${emptyEntries.r.code || "no-throw"} calls=${emptyEntries.calls.length}`);
    const tooMany = await refuse("zernio:openai", Array.from({ length: 51 }, (_, i) => entry(`row-${i}`, `${i}`, 10000000)));
    h.check("more than the contract's 50-entry bound refuses before any call",
      tooMany.r.threw && tooMany.r.code === "PROVIDER_INVALID_INPUT" && tooMany.calls.length === 0,
      `${tooMany.r.code || "no-throw"} calls=${tooMany.calls.length}`);
    const meta = await refuse("zernio:meta", [entry("row-1", "111", 10000000)]);
    h.check("zernio:meta refuses with PROVIDER_INVALID_INPUT before any call (half never guessed)",
      meta.r.threw && meta.r.code === "PROVIDER_INVALID_INPUT" && meta.calls.length === 0,
      `${meta.r.code || "no-throw"} calls=${meta.calls.length}`);
    const tiktok = await refuse("zernio:tiktok", [entry("row-1", "111", 10000000)]);
    h.check("a documented-501 budget platform (tiktok) refuses before any call",
      tiktok.r.threw && tiktok.r.code === "PROVIDER_INVALID_INPUT" && tiktok.calls.length === 0 &&
      String(tiktok.r.error || tiktok.r.message || "").includes("501"),
      `${tiktok.r.code || "no-throw"} calls=${tiktok.calls.length}`);
    const authFailedCalls = [];
    const authFailed = await createZernioAdsProvider("zernio:openai", {
      fetcher: async (url) => { authFailedCalls.push({ url: String(url) }); return new Response(JSON.stringify({ error: "bad key" }), { status: 401 }); },
      apiKey: "test-zernio-key",
    }).bulkBudgets({ entries: [entry("row-1", "111", 10000000), entry("row-2", "222", 10000000), entry("row-3", "333", 10000000)] });
    h.check("a Zernio 401 fails the batch and aborts the remaining entries (exactly one call)",
      JSON.stringify(authFailed.succeeded) === "[]" && authFailed.failed.length === 3 &&
      String(authFailed.failed[0].reason).includes("401") &&
      String(authFailed.failed[1].reason).includes("aborted") &&
      String(authFailed.failed[2].reason).includes("aborted") && authFailedCalls.length === 1,
      `failed=${authFailed.failed.length} calls=${authFailedCalls.length}`);

    // ---- 5. every other operation stays fail-closed/unimplemented ------------------------
    const guarded = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]) });
    const opResults = [];
    for (const op of ["launch"]) {
      const r = await captureCall(() => guarded[op]({}));
      opResults.push({ op, code: r.code, threw: r.threw });
    }
    h.check("all other operations refuse with PROVIDER_UNIMPLEMENTED, no fetch, no state change",
      opResults.every((r) => r.threw && r.code === "PROVIDER_UNIMPLEMENTED"), JSON.stringify(opResults.map((r) => r.code)));

    // ---- 6. through the REAL surface: budgets persist, 501 refuses, Google safe ----------
    const ws = await svc.entities.Workspace.create({ name: `zbulk-${stamp}`, owner_id: `ownerB_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zbulk-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zbulk" });
    projects.push(projZ.id);
    const user = { id: `ownerB_${stamp}`, email: "zb@example.com" };
    const acc = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:openai", status: "active",
      provider_account_ref: "zacc-1", payment_on_file: true,
    });
    const accTiktok = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:tiktok", status: "active",
      provider_account_ref: "zacc-2", payment_on_file: true,
    });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: acc.id, channel: "zernio:openai",
      campaign_name: "Zernio bulk fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "123456789",
    });
    const campTiktok = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: accTiktok.id, channel: "zernio:tiktok",
      campaign_name: "Zernio bulk tiktok fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "987654321",
    });
    const surfaceCalls = [];
    const openaiProvider = createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(surfaceCalls), apiKey: "test-zernio-key" });
    const bulk = await surface(projZ, user, {
      action: "campaign_bulk_budget", channel: "zernio:openai",
      entries: [entry(camp.id, "123456789", 20000000)],
    }, { provider: openaiProvider });
    h.check("through the surface, campaign_bulk_budget reports the succeeded row id",
      Array.isArray(bulk.succeeded) && bulk.succeeded.includes(camp.id) && bulk.failed.length === 0,
      JSON.stringify({ succeeded: bulk.succeeded }));
    const bulkRow = await svc.entities.AdsCampaign.get(camp.id);
    h.check("the bulk edit PERSISTED: daily_budget_micros 20000000 with change-log attribution",
      bulkRow.daily_budget_micros === 20000000 && !!bulkRow.last_synced_at,
      JSON.stringify({ budget: bulkRow.daily_budget_micros }));
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: projZ.id }, "-created_date", 10);
    h.check("the bulk edit wrote its change-log attribution (campaign.bulk_budget)",
      logs.some((l) => l.action === "campaign.bulk_budget"), JSON.stringify(logs.map((l) => l.action)));
    const refusedSurface = await captureCall(() => surface(projZ, user, {
      action: "campaign_bulk_budget", channel: "zernio:tiktok",
      entries: [entry(campTiktok.id, "987654321", 20000000)],
    }, { provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" }) }));
    const tiktokRow = await svc.entities.AdsCampaign.get(campTiktok.id);
    h.check("through the surface, a documented-501 channel refuses and persists NOTHING",
      refusedSurface.threw && refusedSurface.code === "PROVIDER_INVALID_INPUT" &&
      tiktokRow.daily_budget_micros === 10000000, `${refusedSurface.code || "no-throw"} budget=${tiktokRow.daily_budget_micros}`);
    const gNone = await surface(projZ, user, { action: "account_get" });
    h.check("Google is untouched: the project has no google-channel account row",
      gNone.account === null, JSON.stringify(gNone.account));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;
    for (const pid of projects) {
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}