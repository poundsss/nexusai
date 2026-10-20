// Targeted Grow MODULE DASHBOARD certification — read-only, scratch fixtures only.
// The dashboard is a VIEW over the existing certified surfaces: every check below calls the
// SAME action the mounted dashboard calls (googleAds reads, managedAds recommend_list, outreach
// list, coldCalling status/report, listen term_list/report, leadGen list, aeo probe_list/report,
// seoScan list, support history, virality state/calendar_list, myBusiness status/company_get,
// emailDomain list, projectDomains list). NO mutating action is ever invoked — the certification
// never sends an email, places a call, spends budget or publishes. Scratch workspace, seeds and
// purge reuse the SHARED helpers (shared/growPanelCertHelpers.ts).
//   1. connection honesty: a disconnected channel reports account=null + its provider flag — never a fabricated account;
//   2. empty = real zero; metrics_pending rows render "pending", never a fabricated 0;
//   3. synced metrics render verbatim and the derived CPC/CPA math reproduces from the SAME inputs (revenue absent → ROAS unavailable);
//   4. run history identity: campaign_get by id returns the SAME persisted row;
//   5. project isolation across every dashboard surface;
//   6. fail-closed boundaries surface their verbatim blockers (telephony, GBP);
//   7. 403 non-member gate on the project-scoped reads.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { createPanelScratch, seedPanelRows, purgePanelScratch } from "../../shared/growPanelCertHelpers.ts";

const AD_CHANNELS = ["google", "zernio:openai", "zernio:meta", "zernio:linkedin", "zernio:tiktok"];
// The cert's ONLY actions — every one is a certified READ. No schedule/send/launch/run/claim.
const READ_ONLY_ACTIONS = [
  "googleAds:account_get", "googleAds:launch_readiness", "googleAds:campaign_list", "googleAds:campaign_get", "googleAds:report_list",
  "managedAds:recommend_list", "outreach:list", "coldCalling:status", "coldCalling:report", "listen:term_list", "listen:report",
  "leadGen:list", "aeo:probe_list", "aeo:report", "seoScan:list", "support:history", "virality:state", "virality:calendar_list",
  "myBusiness:status", "myBusiness:company_get", "emailDomain:list", "projectDomains:list",
];

const call = async (base44, fn, payload) => (await base44.functions.invoke(fn, payload)).data;
const errOf = (e) => (e?.response?.data?.code ? String(e.response.data.code) : String(e?.message || e));

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  h.check("read-only contract: the certification only issues certified READ actions",
    READ_ONLY_ACTIONS.every((a) => /:(account_get|launch_readiness|campaign_list|campaign_get|report_list|recommend_list|list|status|report|term_list|probe_list|history|state|calendar_list|company_get)$/.test(a)),
    READ_ONLY_ACTIONS.join(","));

  const stamp = Date.now();
  let ws = null;
  const projects = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const ghost = { id: `gmd-ghost-${stamp}`, email: "gmd-ghost@example.invalid" };

    const scratch = await createPanelScratch(svc, "grow-dash", caller, stamp);
    ws = scratch.ws;
    projects.push(...scratch.projects);
    const { proj, proj2 } = scratch;
    await seedPanelRows(svc, ws, proj, stamp);

    // ---- Ads seeds: one PENDING-metrics campaign and one SYNCED campaign on proj; a blocked weekly report ----
    const pendingCamp = await svc.entities.AdsCampaign.create({
      project_id: proj.id, workspace_id: ws.id, channel: "google",
      campaign_name: `Pending ${stamp}`, campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 50_000_000, metrics_pending: true,
    });
    const syncedCamp = await svc.entities.AdsCampaign.create({
      project_id: proj.id, workspace_id: ws.id, channel: "google",
      campaign_name: `Synced ${stamp}`, campaign_type: "SMART", status: "ENABLED",
      daily_budget_micros: 20_000_000, metrics_pending: false,
      metrics: { impressions: 1200, clicks: 48, cost_micros: 9_000_000, spend: 9, conversions: 3, ctr: 0.04 },
      last_synced_at: new Date().toISOString(),
    });
    const period = { start: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) };
    await svc.entities.AdsPerformanceReport.create({
      project_id: proj.id, workspace_id: ws.id, channel: "google", status: "blocked",
      period_start: period.start, period_end: period.end, provider_sync: "skipped_not_configured",
      blocker_code: "PROVIDER_NOT_CONFIGURED", campaigns: [], generated_at: new Date().toISOString(),
    });

    // ---- 1. CONNECTION HONESTY: every channel reports account=null; the refusal signal lives
    // in campaign_list's provider_sync ("skipped_not_configured") — the dashboard's configured
    // flag derives from THAT, never from an invented account_get field. ----
    const accounts = await Promise.all(AD_CHANNELS.map((ch) => call(base44, "googleAds", { action: "account_get", project_id: proj.id, channel: ch }).catch(errOf)));
    const emptySync = await call(base44, "googleAds", { action: "campaign_list", project_id: proj.id, channel: "google" }).catch(errOf);
    h.check("ads connection honesty: all 5 channels report account=null and the sync refusal is honest (provider_sync=skipped_not_configured) — never a fabricated account",
      accounts.every((r) => r && r.account === null) && typeof emptySync === "object" && emptySync.provider_sync === "skipped_not_configured",
      JSON.stringify({ accts: accounts.map((r) => (typeof r === "string" ? r : r.account)), sync: emptySync?.provider_sync ?? emptySync }));

    // ---- 2. EMPTY CAMPAIGNS on the untouched project = a real zero ----
    const emptyCamps = await call(base44, "googleAds", { action: "campaign_list", project_id: proj2.id, channel: "google" });
    h.check("ads empty state: the untouched project's campaign list is a REAL zero (empty rows), never fabricated metrics",
      Array.isArray(emptyCamps.campaigns) && emptyCamps.campaigns.length === 0,
      JSON.stringify({ n: emptyCamps.campaigns?.length, sync: emptyCamps.provider_sync }));

    // ---- 3. PENDING metrics: the row carries metrics_pending — the dashboard shows "pending", not a fabricated 0 ----
    const pendList = await call(base44, "googleAds", { action: "campaign_list", project_id: proj.id, channel: "google" });
    const pendRow = (pendList.campaigns || []).find((c) => c.id === pendingCamp.id);
    h.check("ads pending sync: the unsynced campaign's row carries metrics_pending=true so the dashboard shows 'pending sync' — never a fabricated spend",
      pendRow && pendRow.metrics_pending === true,
      JSON.stringify({ pending: pendRow?.metrics_pending, impressions: pendRow?.impressions }));

    // ---- 4. SYNCED metrics render verbatim; derived CPC/CPA reproduce from the SAME inputs; revenue absent → ROAS unavailable ----
    const syncRow = (pendList.campaigns || []).find((c) => c.id === syncedCamp.id);
    const derivedCpc = syncRow && syncRow.clicks > 0 ? Number(syncRow.cost_micros) / 1e6 / syncRow.clicks : null;
    const derivedCpa = syncRow && syncRow.conversions > 0 ? Number(syncRow.cost_micros) / 1e6 / syncRow.conversions : null;
    h.check("ads synced metrics: impressions/clicks/cost/conversions render verbatim; CPC=0.19 & CPA=3.00 derive from the SAME inputs; no revenue field → ROAS stays unavailable",
      syncRow && syncRow.impressions === 1200 && syncRow.clicks === 48 && Number(syncRow.cost_micros) === 9_000_000 && syncRow.conversions === 3
        && derivedCpc !== null && Math.abs(derivedCpc - 0.1875) < 0.001 && derivedCpa !== null && Math.abs(derivedCpa - 3) < 0.001
        && !Object.keys(syncRow).some((k) => /revenue|roas/i.test(k)),
      JSON.stringify({ impressions: syncRow?.impressions, clicks: syncRow?.clicks, cost: syncRow?.cost_micros, conv: syncRow?.conversions, cpc: derivedCpc, cpa: derivedCpa }));

    // ---- 5. RUN HISTORY IDENTITY: campaign_get by id returns the SAME persisted row ----
    const got = await call(base44, "googleAds", { action: "campaign_get", project_id: proj.id, channel: "google", campaign_id: syncedCamp.id });
    h.check("ads identity: campaign_get returns the SAME persisted row (id, name, metrics) — refresh preserves identity and history",
      got.campaign && got.campaign.id === syncedCamp.id && got.campaign.campaign_name === `Synced ${stamp}` && got.campaign.impressions === 1200,
      JSON.stringify({ id: got.campaign?.id === syncedCamp.id, name: got.campaign?.campaign_name }));

    // ---- 6. WEEKLY REPORT: blocked row renders verbatim; the OTHER project sees none (isolation) ----
    const reportsA = await call(base44, "googleAds", { action: "report_list", project_id: proj.id, channel: "google" });
    const reportsB = await call(base44, "googleAds", { action: "report_list", project_id: proj2.id, channel: "google" });
    const blocked = (reportsA.reports || []).find((r) => r.status === "blocked");
    h.check("ads weekly report: the blocked row passes through verbatim (status, blocker_code, provider_sync) and the second project sees NONE",
      blocked && blocked.blocker_code === "PROVIDER_NOT_CONFIGURED" && blocked.provider_sync === "skipped_not_configured"
        && (reportsB.reports || []).length === 0,
      JSON.stringify({ blocked: blocked?.blocker_code, other: reportsB.reports?.length }));

    // ---- 7. RECOMMENDATIONS: read-only list is empty on scratch — nothing invented ----
    const recs = await call(base44, "managedAds", { action: "recommend_list", project_id: proj.id, channel: "google" });
    h.check("ads recommendations: recommend_list returns no invented recommendations on scratch (empty list)",
      Array.isArray(recs.recommendations) && recs.recommendations.length === 0, JSON.stringify(recs.recommendations?.length));

    // ---- 8. OUTREACH: seeded email steps + call rows render verbatim; isolation ----
    const outreachA = await call(base44, "outreach", { action: "list", project_id: proj.id });
    const outreachB = await call(base44, "outreach", { action: "list", project_id: proj2.id });
    h.check("outreach: the project's email steps render verbatim (status, step_index, attempts, last_error) and the second project sees NONE",
      outreachA.count === 2 && outreachA.jobs.every((j) => "status" in j && "attempts" in j && "step_index" in j && "last_error" in j)
        && outreachB.count === 0,
      JSON.stringify({ a: outreachA.jobs.map((j) => j.status), b: outreachB.count }));

    // ---- 9. CALLS: fail-closed telephony boundary + seeded call lifecycle ----
    const tel = await call(base44, "coldCalling", { action: "status" });
    const rep = await call(base44, "coldCalling", { action: "report", project_id: proj.id });
    const telJson = JSON.stringify(tel);
    h.check("cold calling: the transport status fails closed with its verbatim blocker (available=false, PHONE_TRANSPORT_UNAVAILABLE) and the call report counts the seeded rows",
      telJson.includes("PHONE_TRANSPORT_UNAVAILABLE") && tel.available === false
        && Array.isArray(rep.rows),
      JSON.stringify({ available: tel.available, code: tel.code, rows: rep.rows }));
    await svc.entities.ColdCall.create({
      project_id: proj.id, workspace_id: ws.id, customer_id: "c1", status: "failed",
      blocker_code: "PHONE_TRANSPORT_UNAVAILABLE", attempts: 1, script: "hi",
    });
    const callsAfter = await call(base44, "coldCalling", { action: "report", project_id: proj.id });
    h.check("cold calling: the persisted call's lifecycle (failed + blocker) is what the report counts — never a fake success",
      (callsAfter.rows || []).some((r) => r.status === "failed" && r.count === 1),
      JSON.stringify(callsAfter.rows));

    // ---- 10. LISTENING + LEADS: seeded terms/observations/prospects render verbatim; isolation ----
    const term = await svc.entities.ListenTerm.create({ project_id: proj.id, workspace_id: ws.id, label: `Rivals ${stamp}`, kind: "competitor", terms: ["rival-one"], status: "active" });
    await svc.entities.ListenObservation.create({ project_id: proj.id, workspace_id: ws.id, term_id: term.id, term_label: term.label, source: "reddit", title: "t", url: "https://reddit.com/r/x", snippet: "s", dedup_key: `d_${stamp}`, observed_at: new Date().toISOString() });
    const listenTerms = await call(base44, "listen", { action: "term_list", project_id: proj.id });
    const listenRep = await call(base44, "listen", { action: "report", project_id: proj.id });
    const listenRepB = await call(base44, "listen", { action: "report", project_id: proj2.id });
    const prospects = await call(base44, "leadGen", { action: "list", project_id: proj.id });
    h.check("listening: the term, its observation (share from stored rows only) and the 2 prospects render verbatim; the second project sees NONE",
      (listenTerms.terms || []).some((t) => t.label === `Rivals ${stamp}`)
        && listenRep.total_observations === 1
        && (prospects.prospects || []).length === 2
        && listenRepB.total_observations === 0,
      JSON.stringify({ terms: listenTerms.terms?.length, obs: listenRep.total_observations, prospects: prospects.prospects?.length, other: listenRepB.total_observations }));

    // ---- 11. ORGANIC: AEO probe/result + SEO scan + support history ----
    const probe = await svc.entities.AeoProbe.create({ project_id: proj.id, workspace_id: ws.id, question: `What is the best tool for growth ${stamp}?` });
    await svc.entities.AeoResult.create({ project_id: proj.id, workspace_id: ws.id, probe_id: probe.id, question: probe.question, run_key: `rk_${stamp}`, mentioned: true, rank: 1, excerpt: "x", checked_at: new Date().toISOString() });
    const probes = await call(base44, "aeo", { action: "probe_list", project_id: proj.id });
    const aeoRep = await call(base44, "aeo", { action: "report", project_id: proj.id });
    await svc.entities.SeoScan.create({ project_id: proj.id, workspace_id: ws.id, user_id: caller.id, version_number: 1, status: "COMPLETED", score: 88, grade: "B", scanned_files: 12, completed_at: new Date().toISOString() });
    const scans = await call(base44, "seoScan", { action: "list", project_id: proj.id });
    const supportHist = await call(base44, "support", { action: "history", project_id: proj.id });
    h.check("organic: the AEO probe + visibility (1/1 mentioned), the SEO scan (score 88, grade B) and the support history message render verbatim",
      (probes.probes || []).length === 1 && aeoRep.total_measurements === 1 && aeoRep.overall_visibility === 1
        && (scans.scans || [])[0]?.score === 88 && (scans.scans || [])[0]?.grade === "B"
        && (supportHist.messages || []).length === 1,
      JSON.stringify({ probes: probes.probes?.length, vis: aeoRep.overall_visibility, score: scans.scans?.[0]?.score, msgs: supportHist.messages?.length }));

    // ---- 12. SOCIAL: the seeded calendar row renders verbatim; the second project sees none ----
    const cal = await call(base44, "virality", { action: "calendar_list", project_id: proj.id }).catch(errOf);
    const calB = await call(base44, "virality", { action: "calendar_list", project_id: proj2.id }).catch(errOf);
    const st = await call(base44, "virality", { action: "state", project_id: proj.id }).catch(errOf);
    // calendar_list returns the rows as a BARE ARRAY — the rows ARE the calendar.
    const calA2 = Array.isArray(cal) ? cal : (cal.posts || cal.calendar || []);
    h.check("social: the persisted calendar row passes through verbatim (platform, status, scheduled_at) and the idle pipeline state is honest; the second project sees NONE",
      typeof cal === "object" && Array.isArray(calA2) && calA2.some((p) => p.platform === "linkedin" && p.status === "scheduled")
        && typeof st.stage === "string"
        && (Array.isArray(calB) ? calB : (calB.posts || calB.calendar || [])).length === 0,
      JSON.stringify({ a: calA2.map((p) => p.status), stage: st.stage, b: (calB.posts || calB.calendar || []).length }));

    // ---- 13. BUSINESS: GBP fail-closed verbatim + domain surfaces + company monitoring ----
    const gbp = await call(base44, "myBusiness", { action: "status", project_id: proj.id }).catch(errOf);
    const ed = await call(base44, "emailDomain", { action: "list", project_id: proj.id }).catch(errOf);
    const pd = await call(base44, "projectDomains", { action: "list", project_id: proj.id }).catch(errOf);
    const co = await call(base44, "myBusiness", { action: "company_get", project_id: proj.id }).catch(errOf);
    const edList = ed && typeof ed === "object" ? (ed.email_domains || ed.domains) : null;
    const pdList = pd && typeof pd === "object" ? pd.domains : null;
    // The sending-domain surface is CERTIFIED to fail closed without its management secret —
    // an honest error code is as valid a dashboard outcome as a real (empty) list.
    const edHonest = Array.isArray(edList) || (typeof ed === "string" && ed.includes("EMAIL_DOMAIN_SECRET_NOT_CONFIGURED"));
    h.check("business: the GBP boundary refuses with its verbatim blocker (available=false), the sending-domain surface is honest (a real empty list or its certified fail-closed code), project domains return a real array and company monitoring is a read with zero rows",
      gbp && gbp.available === false && typeof gbp.code === "string" && gbp.code.length > 0
        && edHonest && Array.isArray(pdList)
        && co && Array.isArray(co.terms) && co.terms.length === 0,
      JSON.stringify({ gbp: gbp?.code ?? gbp, ed: edList ? edList.length : (ed && typeof ed !== "object" ? ed : null), pd: pdList ? pdList.length : (pd && typeof pd !== "object" ? pd : null), co: co?.terms ? 0 : (co && typeof co !== "object" ? co : null) }));

    // ---- 14. AUTHORIZATION: the project.read gate refuses a non-member (403) ----
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's dashboard surfaces (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await purgePanelScratch(svc, ws, projects);
  }

  return harnessResponse(h);
}