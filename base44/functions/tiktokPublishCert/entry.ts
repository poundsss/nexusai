// Targeted certification for the TikTok organic-publishing FAIL-CLOSED contract (shared/
// socialPublish.ts publishTikTok). The TikTok connector supports PROFILE READS ONLY ("Content
// API and video uploading not supported" — the connector's own contract) and the Zernio Ads
// API is ads-only — no organic publish contract exists, so NOTHING is published and NO
// network call of any kind is made (the adapter is synchronous and call-free).
// Certified:
//   1. the adapter is registered in PUBLISHERS; TikTok is NOT in PUBLISHABLE_PLATFORMS;
//   2. the adapter refuses with the VERBATIM blocker (501 TIKTOK_PUBLISH_UNAVAILABLE) on any
//      row;
//   3. scheduling a tiktok row still fails it IMMEDIATELY (documented) — the row is failed
//      with "tiktok has no publisher" and no publish job exists;
//   4. a direct publish dispatch surfaces the verbatim blocker as the row's terminal
//      publish_error (not retried);
//   5. no Ads/Zernio side effects and no unintended persistence: zero Ads rows, zero
//      BackgroundJobs;
//   6. project isolation: the second project's rows are untouched and its publish dispatch
//      for a foreign post is post_gone;
//   7. the other publishers' registry entries are unchanged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { PUBLISHERS, publishTikTok } from "../../shared/socialPublish.ts";
import { PUBLISHABLE_PLATFORMS } from "../../shared/virality.ts";
import { executeViralityPublishJob, executeViralityScheduleJob, schedulingJobBody } from "../../shared/socialCalendar.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    // ---- 1. registry invariants ------------------------------------------------------------------------
    h.check("the tiktok adapter is registered in PUBLISHERS; tiktok is NOT in PUBLISHABLE_PLATFORMS",
      PUBLISHERS.tiktok === publishTikTok && !PUBLISHABLE_PLATFORMS.includes("tiktok"),
      JSON.stringify({ publishers: Object.keys(PUBLISHERS), publishable: PUBLISHABLE_PLATFORMS }));

    // ---- 2. the verbatim fail-closed refusal ------------------------------------------------------------
    const refused = await captureCall(() => publishTikTok(svc, { platform: "tiktok", body: "anything", image_url: null }));
    h.check("the adapter refuses with the verbatim blocker (501 TIKTOK_PUBLISH_UNAVAILABLE)",
      refused.threw && refused.code === "TIKTOK_PUBLISH_UNAVAILABLE" && Number(refused.status) === 501,
      JSON.stringify(refused.code || "no-throw"));

    // ---- fixtures: a member workspace and two projects ---------------------------------------------------
    const ws = await svc.entities.Workspace.create({ name: `ttcert-${stamp}`, owner_id: `ownerTT_${stamp}` });
    workspaces.push(ws.id);
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "starter_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `ttcert-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `ttcert-2-${stamp}`, status: "ready", version_count: 0 });
    projects.push(proj2.id);

    const mkPost = async (projectId, platform, extra = {}) => svc.entities.ViralityScheduledPost.create({
      project_id: projectId, workspace_id: ws.id, plan_id: null, platform, title: null,
      body: "Nowhere to publish.", hashtags: [], status: "scheduled",
      scheduled_at: new Date(stamp - 1000).toISOString(), image_url: null, ...extra,
    });

    // ---- 3. scheduling still fails a tiktok row IMMEDIATELY (documented, unchanged) ---------------------
    const scheduled = await mkPost(proj.id, "tiktok", { scheduled_at: new Date(stamp + 6000 * 1000).toISOString() });
    const range = await executeViralityScheduleJob(svc, {
      project_id: proj.id,
      scheduled_from: new Date(stamp).toISOString(),
      scheduled_until: new Date(stamp + 3 * 3600 * 1000).toISOString(),
    }, { getConnection: async () => null });
    const scheduledAfter = await svc.entities.ViralityScheduledPost.get(scheduled.id);
    h.check("scheduling a tiktok row fails it immediately with the documented error and materializes no publish job",
      range.selected === 1 && range.failed === 1 && range.materialized === 0 &&
      scheduledAfter.status === "failed" && scheduledAfter.publish_error === "tiktok has no publisher" && !scheduledAfter.workflow_id,
      JSON.stringify({ range, status: scheduledAfter.status, err: scheduledAfter.publish_error }));

    // ---- 4. a direct publish dispatch surfaces the verbatim blocker, terminal ----------------------------
    const direct = await mkPost(proj.id, "tiktok");
    const dispatch = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: direct.id }, { publishers: PUBLISHERS });
    const directAfter = await svc.entities.ViralityScheduledPost.get(direct.id);
    const notRetried = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: direct.id }, { publishers: PUBLISHERS });
    h.check("a direct dispatch surfaces the verbatim blocker as the row's terminal publish_error and is NOT retried",
      dispatch.status === "failed" && String(directAfter.publish_error || "").includes("Content Posting API and video upload are not supported") &&
      notRetried.skipped === "already_failed",
      JSON.stringify({ dispatch, err: directAfter.publish_error }));

    // ---- 5. no Ads/Zernio side effects, no unintended persistence ---------------------------------------
    const adsCounts = {};
    for (const name of ["AdsAccount", "AdsCampaign", "AdsBrief", "AdsAssetSession"]) {
      adsCounts[name] = (await svc.entities[name].filter({ project_id: proj.id }, "-created_date", 10)).length;
    }
    const jobs = await svc.entities.BackgroundJob.filter({ project_id: proj.id, job_type: "virality.publish" }, "created_date", 10);
    h.check("no Ads/Zernio side effects and no publish jobs: zero Ads rows, zero BackgroundJobs",
      Object.values(adsCounts).every((n) => n === 0) && jobs.length === 0,
      JSON.stringify({ adsCounts, jobs: jobs.length }));

    // ---- 6. project isolation ----------------------------------------------------------------------------
    const stranger = await executeViralityPublishJob(svc, { project_id: proj2.id, post_id: direct.id }, { publishers: PUBLISHERS });
    const proj2Rows = await svc.entities.ViralityScheduledPost.filter({ project_id: proj2.id }, "-created_date", 10);
    h.check("isolation: another project's dispatch is post_gone and its calendar is empty",
      stranger.skipped === "post_gone" && proj2Rows.length === 0,
      JSON.stringify({ stranger, proj2Rows: proj2Rows.length }));

    // ---- 7. the certified publishers are unchanged -------------------------------------------------------
    h.check("the certified instagram/linkedin/facebook/x publishers are unchanged (registry keys)",
      JSON.stringify(Object.keys(PUBLISHERS).filter((k) => ["linkedin", "facebook", "instagram", "x"].includes(k))) === JSON.stringify(["linkedin", "facebook", "instagram", "x"]),
      JSON.stringify(Object.keys(PUBLISHERS)));
    h.check("the scheduling job projection is unchanged (status mapping, display-only phase)",
      schedulingJobBody({ id: "j1", status: "pending" }).status === "pending" &&
      schedulingJobBody({ id: "j1", status: "dead_letter" }).status === "failed",
      JSON.stringify({}));
  } catch (e) {
    h.check("unexpected certification error", false, String(e?.message || e));
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "ViralityScheduledPost", { project_id: pid });
      await purgeBy(svc, "ViralityPlanPost", { project_id: pid });
      await purgeBy(svc, "ViralityPlan", { project_id: pid });
      await purgeBy(svc, "ViralityState", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) {
      await purgeBy(svc, "Subscription", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  const s = h.summary();
  return Response.json({ ok: s.ok, passed: s.passed, failed: s.failed, failures: s.failures });
}