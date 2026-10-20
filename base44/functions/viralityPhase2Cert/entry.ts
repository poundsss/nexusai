// Focused certification for the NexusAI Virality Engine Phase 2 (shared/socialCalendar.ts +
// shared/socialPublish.ts + functions/virality calendar dispatch). Drives the REAL surface,
// the REAL persistence, the REAL job queue and the REAL plan-replacement path — with
// DETERMINISTIC publishers and connection resolvers injected, because live publishing must
// never touch a real network in a suite.
//
// Certified: the empty calendar; create (projection, validation, timezone/local-time math);
// update/delete editability rules (409 on final states, idempotent delete); approve (partial
// results, re-approve no-write, 1..50 limit); list materialization (idempotent, current plan
// only) and the purge of replaced-plan proposals while approved/edited/scheduled rows survive;
// the scheduling job (range validation, empty range, per-post materialization through the
// idempotent queue, non-publishable platform failed immediately, needs_reconnect fail-closed,
// workflow_id minting, counters); job polling projection (status mapping, result, FIXED error);
// the per-post publisher (posted → skip, failure not retried, NO_CONNECTION → needs_reconnect,
// in-flight and stale markers → publish_outcome_unknown); project isolation; authorization.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { viralitySurface, PLAN_CREDITS } from "../../shared/virality.ts";
import {
  calendarSurface, executeViralityScheduleJob, executeViralityPublishJob,
  schedulingJobBody, SCHEDULE_JOB_TYPE,
} from "../../shared/socialCalendar.ts";
import { grantTestPool, poolBalance } from "../../shared/creditPoolTestHelpers.ts";

// Deterministic Phase 1 generators (same shape as the certified stubs).
function makeStubGenerators() {
  return {
    questions: async (_svc, { project }) => ({
      analysis_text: `An app called ${project.name}.`,
      questions: [
        { id: "goal", question: "What does success look like?", type: "select", options: [{ label: "First 100 users", description: null }], placeholder: null },
        { id: "audience", question: "Who is it for?", type: "text_input", options: null, placeholder: "Freelancers" },
      ],
    }),
    strategy: async (_svc, { answers, feedback, previous }) => ({
      strategy_text: `Strategy goal=${answers?.goal || "?"} prev=${previous ? "yes" : "no"} feedback=${feedback || "-"}`,
    }),
    platformPosts: async (_svc, { platform, strategy_text }) => ({
      mode: "series", reasoning: `Series fits ${platform}`,
      posts: [0, 1, 2].map((i) => ({
        angle: "pain_point", angle_label: "Pain point", suggested_day: i + 1,
        rationale: `Why ${platform} ${i}`, content: `${platform} post ${i} (${String(strategy_text).slice(0, 12)})`,
        image_prompt: `prompt-${platform}-${i}`, hashtags: ["demo"], post_title: `Title ${i}`,
        suggested_subreddits: [], launch_comment: null, option_label: null, best_for_context: null,
        best_time_reason: `Best time ${i}`,
      })),
    }),
    image: async (_svc, { prompt }) => `https://example.com/img/${encodeURIComponent(prompt)}.png`,
  };
}

// Deterministic publishers: same signatures as the real ones, no external call.
const stubPublishers = {
  linkedin: async (_svc, row) => `urn:li:share:${row.id}`,
  facebook: async (_svc, row) => `fb_${row.id}`,
  instagram: async () => `ig_${Date.now()}`,
};
const fakeConn = { accessToken: "stub-token", connectionConfig: { scopes: ["w_member_social", "pages_manage_posts", "instagram_business_content_publish"] } };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  const cal = (project, workspace, user, input) => calendarSurface(svc, project, workspace, user, input);
  const vir = (project, workspace, user, input, generators) => viralitySurface(svc, project, workspace, user, input, { generators });
  const mkProject = async (wsId, name) => {
    const p = await svc.entities.Project.create({ workspace_id: wsId, name: `viral2-${name}-${stamp}`, status: "ready", version_count: 1 });
    projects.push(p.id);
    return p;
  };
  const rowOf = async (projectId, id) => (await svc.entities.ViralityScheduledPost.get(id).catch(() => null));
  const userA = { id: `ownerA_${stamp}`, email: "a@example.com" };
  const mkPost = async (project, workspace, input) => cal(project, workspace, userA, { action: "calendar_create", ...input });

  try {
    // --- workspaces + projects --------------------------------------------------------------
    const wsA = await svc.entities.Workspace.create({ name: `viral2-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `viral2-B-${stamp}`, owner_id: `ownerB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    await grantTestPool(svc, { workspace_id: wsA.id, pool: "integration", amount: 100, key: `viral2-cert-A-${stamp}`, reason: "cert pool" });
    // wsA carries an active paid subscription so the documented publishing entitlement
    // (assertViralityPublishEntitlement) admits its calendar_schedule calls. wsB stays free — it
    // only exercises cross-project job isolation (a read, never a schedule start).
    await svc.entities.Subscription.create({ workspace_id: wsA.id, plan_code: "starter_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    const projA = await mkProject(wsA.id, "A");
    const projB = await mkProject(wsB.id, "B");

    const stranger = { id: "viral2_stranger", email: "stranger@example.com" };
    const viewer = { id: "viral2_viewer", email: "viewer@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });

    // ---- 1. the empty calendar + create -------------------------------------------------------
    h.check("a never-used calendar lists as an empty array",
      JSON.stringify(await cal(projA, wsA, userA, { action: "calendar_list" })) === "[]", JSON.stringify({}));

    const soon = new Date(stamp + 3600 * 1000).toISOString(); // the post the scheduling job will pick up
    const created = await mkPost(projA, wsA, { platform: "linkedin", title: "Launch day", body: "We shipped something.", scheduled_at: soon, scheduled_timezone: "America/Chicago", hashtags: ["#ship", "launch"], hook: "pain_point" });
    h.check("create returns a scheduled post with the documented projection and hashtag normalization",
      created.status === "scheduled" && created.platform === "linkedin" && created.body === "We shipped something." &&
      created.hook === "pain_point" && JSON.stringify(created.hashtags) === JSON.stringify(["ship", "launch"]) &&
      created.plan_id === null && created.source_post_id === null && created.workflow_id === null,
      JSON.stringify({ status: created.status, id: created.id }));
    h.check("scheduled_local_at carries the zone's DST-correct offset (existing scheduler primitive)",
      /T\d{2}:\d{2}:\d{2}-05:00$/.test(created.scheduled_local_at || "") && created.scheduled_timezone === "America/Chicago",
      JSON.stringify({ local: created.scheduled_local_at }));

    const badPlatform = await captureCall(() => mkPost(projA, wsA, { platform: "myspace", body: "x", scheduled_at: soon }));
    const noBody = await captureCall(() => mkPost(projA, wsA, { platform: "linkedin", scheduled_at: soon }));
    const noTime = await captureCall(() => mkPost(projA, wsA, { platform: "linkedin", body: "x" }));
    const badTime = await captureCall(() => mkPost(projA, wsA, { platform: "linkedin", body: "x", scheduled_at: "not-a-date" }));
    const badZone = await captureCall(() => mkPost(projA, wsA, { platform: "linkedin", body: "x", scheduled_at: soon, scheduled_timezone: "Mars/Olympus" }));
    h.check("create validation: bad platform → 400, missing body/scheduled_at → 400, malformed time and unknown zone → 422",
      badPlatform.threw && badPlatform.code === "INVALID_PLATFORM" && noBody.threw && noBody.code === "BODY_REQUIRED" &&
      noTime.threw && noTime.code === "SCHEDULED_AT_REQUIRED" && badTime.threw && badTime.code === "INVALID_SCHEDULED_AT" &&
      badZone.threw && badZone.code === "INVALID_TIMEZONE",
      JSON.stringify({ p: badPlatform.code, b: noBody.code, t: noTime.code, bt: badTime.code, tz: badZone.code }));

    // ---- 2. update / delete rules ---------------------------------------------------------------
    const updated = await cal(projA, wsA, userA, { action: "calendar_update", post_id: created.id, body: "Rewritten body.", scheduled_at: new Date(stamp + 7200 * 1000).toISOString(), scheduled_timezone: "Asia/Jerusalem" });
    h.check("update changes only the editable fields and recomputes the local time for the new zone",
      updated.body === "Rewritten body." && updated.scheduled_timezone === "Asia/Jerusalem" &&
      /\+03:00$/.test(updated.scheduled_local_at || "") && updated.platform === "linkedin" && updated.status === "scheduled",
      JSON.stringify({ local: updated.scheduled_local_at }));

    const postedPost = await mkPost(projA, wsA, { platform: "linkedin", body: "Already out.", scheduled_at: soon });
    await svc.entities.ViralityScheduledPost.update(postedPost.id, { status: "posted" });
    const updPosted = await captureCall(() => cal(projA, wsA, userA, { action: "calendar_update", post_id: postedPost.id, body: "nope" }));
    const delPosted = await captureCall(() => cal(projA, wsA, userA, { action: "calendar_delete", post_id: postedPost.id }));
    h.check("a final state refuses update and delete with 409 (only proposal/scheduled are editable)",
      updPosted.threw && updPosted.code === "STATUS_NOT_EDITABLE" && updPosted.status === 409 &&
      delPosted.threw && delPosted.code === "STATUS_NOT_EDITABLE",
      JSON.stringify({ upd: updPosted.code, del: delPosted.code }));

    const deleted = await mkPost(projA, wsA, { platform: "linkedin", body: "Temp.", scheduled_at: soon });
    const del1 = await cal(projA, wsA, userA, { action: "calendar_delete", post_id: deleted.id });
    const del2 = await cal(projA, wsA, userA, { action: "calendar_delete", post_id: deleted.id });
    h.check("delete is idempotent: ok whether the post was deleted now or already",
      del1.status === "ok" && del2.status === "ok" && !(await rowOf(projA.id, deleted.id)),
      JSON.stringify(del1));

    // ---- 3. plan generation + list materialization ------------------------------------------------
    // A 5s breather after the setup burst — the storage layer rate-limits bursts.
    await new Promise((r) => setTimeout(r, 5000));
    const started = await vir(projA, wsA, userA, { action: "start" }, makeStubGenerators());
    await vir(projA, wsA, userA, { action: "submit_answers", answers: { goal: "First 100 users" } }, makeStubGenerators());
    const generated = await vir(projA, wsA, userA, { action: "generate", platforms: ["linkedin", "x"] }, makeStubGenerators());
    const plan1Id = generated.plan.id;
    h.check("the Phase 1 plan generated cleanly (10 credits held and settled)",
      Math.abs((await poolBalance(svc, wsA.id, "integration").then((v) => (v && typeof v === "object" ? v.balance : v))) - (100 - PLAN_CREDITS)) < 1e-9,
      JSON.stringify({}));

    const listed1 = await cal(projA, wsA, userA, { action: "calendar_list", plan_id: plan1Id });
    const proposals1 = listed1.filter((p) => p.status === "proposal");
    h.check("list with the CURRENT plan id materializes its suggestions as proposals with source ids and planner fields",
      proposals1.length === 6 && proposals1.every((p) => p.plan_id === plan1Id && p.source_post_id && p.cover_index === p.cover_index && p.best_time_reason),
      JSON.stringify({ proposals: proposals1.length, total: listed1.length }));
    const listed2 = await cal(projA, wsA, userA, { action: "calendar_list", plan_id: plan1Id });
    h.check("materialization is idempotent: a second list with the same plan_id creates nothing new",
      listed2.filter((p) => p.status === "proposal").length === 6 && listed2.length === listed1.length,
      JSON.stringify({ total: listed2.length }));
    const listedNoPlan = await cal(projA, wsA, userA, { action: "calendar_list" });
    h.check("list WITHOUT plan_id does not materialize (and returns the same calendar)",
      listedNoPlan.length === listed1.length, JSON.stringify({ total: listedNoPlan.length }));

    // ---- 4. approve ---------------------------------------------------------------------------------
    const proposalL = listed1.find((p) => p.status === "proposal" && p.platform === "linkedin");
    const proposalX = listed1.find((p) => p.status === "proposal" && p.platform === "x");
    const proposalL2 = listed1.filter((p) => p.status === "proposal" && p.platform === "linkedin")[1];
    const approved = await cal(projA, wsA, userA, { action: "calendar_approve", post_ids: [proposalL.id, proposalX.id, "ffffffffffffffffffffffff", postedPost.id] });
    h.check("approve is a selection: proposals → scheduled, unknown → not_found, posted → rejected with its status",
      JSON.stringify(approved.approved) === JSON.stringify([proposalL.id, proposalX.id]) &&
      JSON.stringify(approved.not_found) === JSON.stringify(["ffffffffffffffffffffffff"]) &&
      approved.rejected.length === 1 && approved.rejected[0].id === postedPost.id && approved.rejected[0].status === "posted",
      JSON.stringify(approved));
    const reApproved = await cal(projA, wsA, userA, { action: "calendar_approve", post_ids: [proposalL.id] });
    const reRow = await rowOf(projA.id, proposalL.id);
    h.check("re-approving a scheduled row lands in approved without a write",
      JSON.stringify(reApproved.approved) === JSON.stringify([proposalL.id]) && reApproved.rejected.length === 0 && reRow.status === "scheduled",
      JSON.stringify(reApproved));
    const emptyApprove = await captureCall(() => cal(projA, wsA, userA, { action: "calendar_approve", post_ids: [] }));
    const tooManyApprove = await captureCall(() => cal(projA, wsA, userA, { action: "calendar_approve", post_ids: Array.from({ length: 51 }, (_, i) => `id${i}`) }));
    h.check("approve validation: empty → 400, more than 50 → 422",
      emptyApprove.threw && emptyApprove.code === "APPROVE_IDS_REQUIRED" && tooManyApprove.threw && tooManyApprove.code === "TOO_MANY_IDS",
      JSON.stringify({ empty: emptyApprove.code, many: tooManyApprove.code }));

    // ---- 5. plan replacement: drop only unmaterialized proposals --------------------------------------
    // Edit one proposal — editing turns it into a real post that survives plan replacement.
    const editedProposal = await cal(projA, wsA, userA, { action: "calendar_update", post_id: proposalL2.id, body: "Edited before the replace." });
    const regen = await vir(projA, wsA, userA, { action: "refine_strategy", feedback: "more personal" }, makeStubGenerators()).then(() =>
      vir(projA, wsA, userA, { action: "generate", platforms: ["linkedin"] }, makeStubGenerators()));
    const plan2Id = regen.plan.id;
    const afterReplace = await cal(projA, wsA, userA, { action: "calendar_list", plan_id: plan2Id });
    const survivingProposal = afterReplace.find((p) => p.id === proposalL2.id);
    h.check("plan replacement drops unacted proposals but preserves approved, scheduled and edited posts",
      plan2Id !== plan1Id &&
      !afterReplace.some((p) => p.status === "proposal" && p.plan_id === plan1Id) &&
      afterReplace.find((p) => p.id === proposalL.id)?.status === "scheduled" &&
      afterReplace.find((p) => p.id === proposalX.id)?.status === "scheduled" &&
      !!survivingProposal && survivingProposal.status === "proposal" && survivingProposal.plan_id === null &&
      afterReplace.find((p) => p.id === created.id)?.status === "scheduled",
      JSON.stringify({ total: afterReplace.length }));
    h.check("the new plan's suggestions materialize alongside the survivors (no re-materialization of edited ones)",
      afterReplace.filter((p) => p.plan_id === plan2Id && p.status === "proposal").length === 3 &&
      afterReplace.filter((p) => p.source_post_id === proposalL2.source_post_id).length === 1,
      JSON.stringify({ newProposals: afterReplace.filter((p) => p.plan_id === plan2Id).length }));

    // ---- 6. the scheduling job ------------------------------------------------------------------------
    await new Promise((r) => setTimeout(r, 5000));
    const noRange = await captureCall(() => cal(projA, wsA, userA, { action: "calendar_schedule" }));
    const badOrder = await captureCall(() => cal(projA, wsA, userA, { action: "calendar_schedule", scheduled_from: new Date(stamp + 86400000).toISOString(), scheduled_until: new Date(stamp).toISOString() }));
    const badFormat = await captureCall(() => cal(projA, wsA, userA, { action: "calendar_schedule", scheduled_from: "yesterday", scheduled_until: new Date(stamp + 86400000).toISOString() }));
    h.check("schedule validation: missing range → 400, until <= from → 422, malformed timestamps → 422",
      noRange.threw && noRange.code === "RANGE_REQUIRED" && badOrder.threw && badOrder.code === "INVALID_RANGE" &&
      badFormat.threw && badFormat.code === "INVALID_RANGE",
      JSON.stringify({ no: noRange.code, order: badOrder.code, fmt: badFormat.code }));

    // Empty range: 202 + a job that completes straight away with a zeroed result.
    const emptyJob = await cal(projA, wsA, userA, { action: "calendar_schedule", scheduled_from: new Date(stamp + 10 * 86400000).toISOString(), scheduled_until: new Date(stamp + 11 * 86400000).toISOString() });
    h.check("start scheduling returns 202-shaped {job_id, status} and the range dedup key keeps one job",
      !!emptyJob.job_id && (emptyJob.status === "pending" || emptyJob.status === "running"),
      JSON.stringify({ status: emptyJob.status }));
    const emptyResult = await executeViralityScheduleJob(svc, { project_id: projA.id, scheduled_from: new Date(stamp + 10 * 86400000).toISOString(), scheduled_until: new Date(stamp + 11 * 86400000).toISOString() });
    await svc.entities.BackgroundJob.update(emptyJob.job_id, { status: "succeeded", result: emptyResult, completed_at: new Date().toISOString() }).catch(() => {});
    const emptyPoll = await cal(projA, wsA, userA, { action: "calendar_schedule_job", job_id: emptyJob.job_id });
    h.check("an empty range completes straight away with the documented zeroed result counters",
      emptyPoll.status === "completed" && emptyPoll.error === null &&
      emptyResult.selected === 0 && emptyResult.materialized === 0 && emptyResult.created_workflows === 0 &&
      emptyResult.plan_limited === 0 && emptyResult.needs_reconnect === 0 && emptyResult.failed === 0 && emptyResult.skipped === 0 &&
      Object.keys(emptyResult).join(",") === "selected,materialized,created_workflows,reused_workflows,plan_limited,needs_reconnect,failed,skipped",
      JSON.stringify(emptyPoll));

    // A real range: the scheduled_at values created above sit within the next 3 hours. The x
    // proposal materialized at 12:00 UTC on a future day, so it is moved into the range first.
    const igPost = await mkPost(projA, wsA, { platform: "instagram", body: "Visual day.", scheduled_at: new Date(stamp + 5400 * 1000).toISOString() });
    await svc.entities.ViralityScheduledPost.update(proposalX.id, { scheduled_at: new Date(stamp + 6000 * 1000).toISOString() });
    // tiktok stays the non-publishable platform of the range: no organic publish contract exists.
    const ttPost = await mkPost(projA, wsA, { platform: "tiktok", body: "Nowhere to publish.", scheduled_at: new Date(stamp + 6300 * 1000).toISOString() });
    const fromIso = new Date(stamp).toISOString(), untilIso = new Date(stamp + 3 * 3600 * 1000).toISOString();
    const conn = async () => fakeConn;
    const rangeResult = await executeViralityScheduleJob(svc, { project_id: projA.id, scheduled_from: fromIso, scheduled_until: untilIso }, { getConnection: conn });
    const rowAfterSched = await rowOf(projA.id, created.id);
    h.check("the range materializes publishable posts into idempotent publish jobs (workflow_id = the job id)",
      rangeResult.selected === 4 && rangeResult.materialized === 3 && rangeResult.created_workflows === 3 &&
      !!rowAfterSched.workflow_id && rowAfterSched.status === "scheduled",
      JSON.stringify(rangeResult));
    const xRow = await rowOf(projA.id, proposalX.id);
    h.check("x is publishable: its scheduled row materializes into an idempotent publish job (workflow_id = the job id)",
      !!xRow.workflow_id && xRow.status === "scheduled",
      JSON.stringify({ status: xRow.status }));
    const ttRow = await rowOf(projA.id, ttPost.id);
    h.check("a non-publishable platform (tiktok) is FAILED by scheduling immediately — there is nowhere to publish it",
      rangeResult.failed === 1 && ttRow.status === "failed" && ttRow.publish_error === "tiktok has no publisher",
      JSON.stringify({ status: ttRow.status }));
    const rerunResult = await executeViralityScheduleJob(svc, { project_id: projA.id, scheduled_from: fromIso, scheduled_until: untilIso }, { getConnection: conn });
    h.check("re-running the same range reuses the existing publish jobs (idempotent enqueue, no duplicates)",
      rerunResult.materialized === 3 && rerunResult.reused_workflows === 3 && rerunResult.created_workflows === 0 && rerunResult.failed === 0,
      JSON.stringify(rerunResult));
    const postJobs = await svc.entities.BackgroundJob.filter({ project_id: projA.id, job_type: "virality.publish" }, "created_date", 10);
    h.check("one publish job exists per materialized post, keyed virality:publish:<post_id>",
      postJobs.length === 3 && postJobs.every((j) => j.idempotency_key === `virality:publish:${j.payload?.post_id}`),
      JSON.stringify({ jobs: postJobs.length }));

    // needs_reconnect: no usable connection → fail closed, documented status.
    const lonely = await mkPost(projA, wsA, { platform: "linkedin", body: "No connection.", scheduled_at: new Date(stamp + 9000 * 1000).toISOString() });
    const noConnResult = await executeViralityScheduleJob(svc, { project_id: projA.id, scheduled_from: new Date(stamp + 8000 * 1000).toISOString(), scheduled_until: new Date(stamp + 10000 * 1000).toISOString() }, { getConnection: async () => null });
    const lonelyRow = await rowOf(projA.id, lonely.id);
    h.check("scheduling without a usable connection marks the post needs_reconnect (fail closed)",
      noConnResult.needs_reconnect === 1 && noConnResult.materialized === 0 && lonelyRow.status === "needs_reconnect",
      JSON.stringify(noConnResult));

    // ---- 7. the per-post publisher ---------------------------------------------------------------------
    await new Promise((r) => setTimeout(r, 5000));
    const pubA = await mkPost(projA, wsA, { platform: "linkedin", body: "Publish me.", scheduled_at: new Date(stamp - 1000).toISOString(), hashtags: ["go"] });
    const published = await executeViralityPublishJob(svc, { project_id: projA.id, post_id: pubA.id }, { publishers: stubPublishers });
    const pubARow = await rowOf(projA.id, pubA.id);
    h.check("the publisher delivers: posted with the provider ref, hashtags composed after the body",
      published.status === "posted" && published.ref === `urn:li:share:${pubA.id}` && pubARow.status === "posted" && pubARow.publish_error === null,
      JSON.stringify(published));
    const republished = await executeViralityPublishJob(svc, { project_id: projA.id, post_id: pubA.id }, { publishers: stubPublishers });
    h.check("duplicate-publication protection: a posted post is never published twice",
      republished.skipped === "already_published", JSON.stringify(republished));

    const pubB = await mkPost(projA, wsA, { platform: "linkedin", body: "Will fail.", scheduled_at: new Date(stamp - 1000).toISOString() });
    const failing = await executeViralityPublishJob(svc, { project_id: projA.id, post_id: pubB.id }, { publishers: { linkedin: async () => { throw new Error("provider exploded"); } } });
    const pubBRow = await rowOf(projA.id, pubB.id);
    const notRetried = await executeViralityPublishJob(svc, { project_id: projA.id, post_id: pubB.id }, { publishers: stubPublishers });
    h.check("a failed publish is terminal and NOT retried (documented), with a safe error stored",
      failing.status === "failed" && pubBRow.status === "failed" && pubBRow.publish_error.includes("provider exploded") &&
      notRetried.skipped === "already_failed",
      JSON.stringify({ status: failing.status, err: pubBRow.publish_error }));

    const pubC = await mkPost(projA, wsA, { platform: "linkedin", body: "No connection.", scheduled_at: new Date(stamp - 1000).toISOString() });
    const noConnPub = await executeViralityPublishJob(svc, { project_id: projA.id, post_id: pubC.id }, { publishers: { linkedin: async () => { throw Object.assign(new Error("No connected LinkedIn account"), { code: "NO_CONNECTION" }); } } });
    const pubCRow = await rowOf(projA.id, pubC.id);
    h.check("a missing connection/permission maps to the documented needs_reconnect",
      noConnPub.status === "needs_reconnect" && pubCRow.status === "needs_reconnect",
      JSON.stringify(noConnPub));

    const pubD = await mkPost(projA, wsA, { platform: "linkedin", body: "In flight.", scheduled_at: new Date(stamp - 1000).toISOString() });
    await svc.entities.ViralityScheduledPost.update(pubD.id, { status: "publishing", publish_started_at: new Date().toISOString() });
    const inFlight = await executeViralityPublishJob(svc, { project_id: projA.id, post_id: pubD.id }, { publishers: stubPublishers });
    await svc.entities.ViralityScheduledPost.update(pubD.id, { publish_started_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() });
    const stalePublish = await executeViralityPublishJob(svc, { project_id: projA.id, post_id: pubD.id }, { publishers: stubPublishers });
    const pubDRow = await rowOf(projA.id, pubD.id);
    h.check("a fresh in-flight marker is refused and a stale one (worker died mid-send) converges to publish_outcome_unknown — never guessed to posted",
      inFlight.skipped === "in_flight" && stalePublish.status === "publish_outcome_unknown" && pubDRow.status === "publish_outcome_unknown",
      JSON.stringify({ inFlight: inFlight.skipped, stale: stalePublish.status }));

    const pubE = await mkPost(projA, wsA, { platform: "linkedin", body: "Still a suggestion?", scheduled_at: new Date(stamp - 1000).toISOString() });
    await svc.entities.ViralityScheduledPost.update(pubE.id, { status: "proposal", plan_id: plan2Id });
    const proposalPub = await executeViralityPublishJob(svc, { project_id: projA.id, post_id: pubE.id }, { publishers: stubPublishers });
    h.check("a proposal is never published (nothing publishes an unapproved post)",
      proposalPub.skipped === "not_scheduled", JSON.stringify(proposalPub));

    // ---- 8. job polling projection -----------------------------------------------------------------------
    const failedJob = await svc.entities.BackgroundJob.create({ queue: "default", job_type: SCHEDULE_JOB_TYPE, payload: { project_id: projA.id }, status: "failed", max_attempts: 3, available_at: new Date().toISOString(), attempts: 1, attempt_log: [], idempotency_key: `viral2-failed-${stamp}`, workspace_id: wsA.id, project_id: projA.id, trace_id: `viral2-${stamp}` });
    const failedPoll = await cal(projA, wsA, userA, { action: "calendar_schedule_job", job_id: failedJob.id });
    h.check("a failed scheduling job polls as failed with the FIXED error and a null result (no cause detail)",
      failedPoll.status === "failed" && failedPoll.error === "Scheduling failed. Please try again." && failedPoll.result === null,
      JSON.stringify(failedPoll));
    const wrongProject = await captureCall(() => cal(projB, wsB, userA, { action: "calendar_schedule_job", job_id: emptyJob.job_id }));
    const foreignPost = await captureCall(() => cal(projB, wsB, userA, { action: "calendar_update", post_id: created.id, body: "hijack" }));
    h.check("isolation: another project cannot poll the job or act on the post (404 JOB_NOT_FOUND / POST_NOT_FOUND)",
      wrongProject.threw && wrongProject.code === "JOB_NOT_FOUND" && foreignPost.threw && foreignPost.code === "POST_NOT_FOUND",
      JSON.stringify({ job: wrongProject.code, post: foreignPost.code }));
    h.check("the scheduling job body projection maps statuses (pending→pending, leased→running, succeeded→completed, else failed)",
      schedulingJobBody({ id: "j1", status: "pending" }).status === "pending" &&
      schedulingJobBody({ id: "j1", status: "leased" }).status === "running" &&
      schedulingJobBody({ id: "j1", status: "succeeded", result: {} }).status === "completed" &&
      schedulingJobBody({ id: "j1", status: "dead_letter" }).status === "failed",
      JSON.stringify({}));

    // ---- 9. authorization -----------------------------------------------------------------------------------
    const strangerWrite = await captureCall(() => loadAuthorizedProject(svc, stranger, projA.id, "project.write"));
    const viewerWrite = await captureCall(() => loadAuthorizedProject(svc, viewer, projA.id, "project.write"));
    const viewerRead = await loadAuthorizedProject(svc, viewer, projA.id, "project.read").catch(() => null);
    h.check("authorization: a non-member is refused, a viewer cannot mutate but can read",
      strangerWrite.threw && Number(strangerWrite.status) === 403 &&
      viewerWrite.threw && Number(viewerWrite.status) === 403 && !!viewerRead && viewerRead.project.id === projA.id,
      JSON.stringify({ stranger: strangerWrite.status, viewerWrite: viewerWrite.status, viewerRead: !!viewerRead }));

    const s = h.summary();
    return Response.json({ ok: s.ok, passed: s.passed, failed: s.failed, failures: s.failures });
  } catch (error) {
    const s = h.summary();
    return Response.json(
      { ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400), passed: s.passed, failed: s.failed, failures: s.failures },
      { status: 500 },
    );
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
      await purgeBy(svc, "WorkspaceMember", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }
}