// Targeted certification for the Grow Briefs section over the EXISTING googleAds brief actions:
// project isolation, empty-output generation still saves a visible warned draft, edit persistence
// (incl. budget carried via brief_update), and NO provider side effects (no account/campaign rows,
// provider stub never called). Deterministic generators; scratch fixtures purged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const caller = await base44.auth.me().catch(() => null);
  if (!caller || caller.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  let providerCalls = 0;
  const spy = new Proxy({}, { get: () => async () => { providerCalls++; return {}; } });
  const gens = (out) => ({ brief: async () => out });

  try {
    const wsA = await svc.entities.Workspace.create({ name: `briefs-A-${stamp}`, owner_id: `oA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `briefs-B-${stamp}`, owner_id: `oB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    const pA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `briefs-a-${stamp}`, status: "ready" });
    const pB = await svc.entities.Project.create({ workspace_id: wsB.id, name: `briefs-b-${stamp}`, status: "ready" });
    projects.push(pA.id, pB.id);
    const user = { id: `oA_${stamp}` };

    const empty = await surface(pA, user, { action: "brief_generate", campaign_type: "SEARCH", goal: "signups" }, { provider: spy, generators: gens({ headlines: [], descriptions: [] }) });
    h.check("empty generation still saves a draft brief with a warning",
      !!empty.brief.id && empty.brief.status === "draft" && !!empty.brief.generation_warning && empty.brief.headlines.length === 0, JSON.stringify(empty.brief));
    const listed = await surface(pA, user, { action: "brief_list" });
    h.check("the warned empty brief stays visible in the list with its warning",
      listed.briefs.some((b) => b.id === empty.brief.id && b.generation_warning), String(listed.briefs.length));

    const good = await surface(pA, user, { action: "brief_generate", goal: "signups" }, { provider: spy, generators: gens({ headlines: ["H"], descriptions: ["D"] }) });
    await surface(pA, user, { action: "brief_update", brief_id: good.brief.id, budget_micros: 25000000 }, { provider: spy });
    await surface(pA, user, { action: "brief_update", brief_id: empty.brief.id, headlines: ["New H"], descriptions: ["New D"], keywords: ["k"], landing_page: "https://x.test" }, { provider: spy });
    const reread = await surface(pA, user, { action: "brief_get", brief_id: empty.brief.id });
    const rereadGood = await surface(pA, user, { action: "brief_get", brief_id: good.brief.id });
    h.check("edits persist on re-read (copy, keywords, landing page)",
      reread.brief.headlines[0] === "New H" && reread.brief.keywords[0] === "k" && reread.brief.landing_page === "https://x.test", JSON.stringify(reread.brief));
    h.check("budget from the generate form persists via brief_update", rereadGood.brief.budget_micros === 25000000, String(rereadGood.brief.budget_micros));

    const listB = await surface(pB, user, { action: "brief_list" });
    h.check("project B sees none of project A's briefs", listB.briefs.length === 0, String(listB.briefs.length));
    const cross = await captureCall(() => surface(pB, user, { action: "brief_update", brief_id: good.brief.id, headlines: ["hijack"] }));
    h.check("project B cannot edit project A's brief (BRIEF_NOT_FOUND)", cross.threw && cross.code === "BRIEF_NOT_FOUND", JSON.stringify({ code: cross.code }));

    // ── Marketing-plan integration ──
    const noPlanSeen = [];
    await surface(pA, user, { action: "brief_generate", goal: "manual goal" }, { provider: spy, generators: { brief: async (a) => { noPlanSeen.push(a); return { headlines: ["H"], descriptions: ["D"] }; } } });
    h.check("absent plan: generator gets plan_context=null and the manual goal", noPlanSeen[0]?.plan_context === null && noPlanSeen[0]?.goal === "manual goal", JSON.stringify(noPlanSeen[0]?.plan_context));

    await svc.entities.MarketingPlan.create({
      project_id: pA.id, workspace_id: wsA.id, user_id: user.id, goal: "plan goal", audience: "plan audience",
      budget_mode: "paid", budget_monthly_amount: 900, strategy: "Win SMB search intent",
      channels: [{ name: "Google Ads", priority: "must_have", tactics: "Bid on competitor terms" }, { name: "TikTok", priority: "medium", tactics: "UGC videos" }],
      competitors: [{ name: "Rival", website: "https://rival.test", description: "Big incumbent", market_gap: "No free tier" }],
    });
    const seen = [];
    const withPlan = await surface(pA, user, { action: "brief_generate", goal: "my own goal", audience: "my own audience" }, { provider: spy, generators: { brief: async (a) => { seen.push(a); return { headlines: ["H"], descriptions: ["D"] }; } } });
    const ctx = seen[0]?.plan_context;
    h.check("strategy context: strategy, Google tactics, market gap and competitors reach the generator",
      ctx?.strategy === "Win SMB search intent" && ctx.google_tactics.join() === "Bid on competitor terms" && ctx.market_gaps[0] === "No free tier" && ctx.competitors[0]?.name === "Rival", JSON.stringify(ctx));
    h.check("non-Google tactics are not passed as Google tactics", !JSON.stringify(ctx).includes("UGC videos"), JSON.stringify(ctx?.google_tactics));
    h.check("manual override: the typed goal/audience win over the plan's", seen[0]?.goal === "my own goal" && seen[0]?.audience === "my own audience", JSON.stringify({ g: seen[0]?.goal, a: seen[0]?.audience }));
    const rawBrief = await svc.entities.AdsBrief.get(withPlan.brief.id);
    h.check("no duplicate strategy persisted on AdsBrief", !["strategy", "plan_context", "market_gaps", "google_tactics", "competitors"].some((k) => k in rawBrief), Object.keys(rawBrief).join(","));
    h.check("budget: the plan's monthly budget is never applied automatically", withPlan.brief.budget_micros === null, String(withPlan.brief.budget_micros));
    const seenB = [];
    await surface(pB, user, { action: "brief_generate", goal: "b" }, { provider: spy, generators: { brief: async (a) => { seenB.push(a); return { headlines: ["H"], descriptions: ["D"] }; } } });
    h.check("project isolation: project B's generation never sees project A's plan", seenB[0]?.plan_context === null, JSON.stringify(seenB[0]?.plan_context));
    const planB = await svc.entities.MarketingPlan.filter({ project_id: pB.id }, "-created_date", 1);
    const planA = await svc.entities.MarketingPlan.filter({ project_id: pA.id }, "-created_date", 1);
    h.check("prefill source: A's plan read returns its goal/audience; B has no plan (manual input stays empty)",
      planA[0]?.goal === "plan goal" && planA[0]?.audience === "plan audience" && planB.length === 0, JSON.stringify({ a: planA.length, b: planB.length }));

    const accs = await svc.entities.AdsAccount.filter({ project_id: pA.id }, "created_date", 5);
    const camps = await svc.entities.AdsCampaign.filter({ project_id: pA.id }, "created_date", 5);
    h.check("no provider side effects: provider never called, no account or campaign rows",
      providerCalls === 0 && accs.length === 0 && camps.length === 0, JSON.stringify({ providerCalls, accs: accs.length, camps: camps.length }));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      for (const ent of ["AdsBrief", "AdsChangeLog", "AdsAccount", "AdsCampaign", "MarketingPlan"]) await purgeBy(svc, ent, { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }
  return harnessResponse(h);
}