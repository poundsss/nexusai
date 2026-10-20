// Targeted certification for the IMPLEMENTED X organic publisher (shared/socialPublish.ts
// publishX) — the metered connector's documented proxy text-post contract. ZERO real network,
// NO real X account, NO connector authorization: every call rides the injected callApi seam,
// and the REAL job semantics run through executeViralityPublishJob with real persistence.
// Certified:
//   1. fail-closed BEFORE any call: an image row refuses X_IMAGE_UNSUPPORTED (media upload is
//      not supported on the X connector);
//   2. request mapping: exactly ONE proxy call — POST /2/tweets with EXACTLY { text }, the
//      hashtags composed after the body;
//   3. response mapping: the provider's post id returned verbatim;
//   4. provider/proxy failures: a thrown proxy call → NO_CONNECTION; the provider's 403
//      (missing tweet.write / dead connection) → NO_CONNECTION (needs_reconnect downstream);
//      a provider 400 → X_API_ERROR (502), never a guessed success;
//   5. through the REAL surface: posted with the provider ref, duplicate-publication
//      protection, a terminal failure NOT retried, a dead connection → needs_reconnect, and
//      the row's publish_error carries the verbatim refusal;
//   6. registry invariants: x IS in PUBLISHABLE_PLATFORMS; tiktok and reddit are NOT;
//      resolveConnection("x") returns a truthy metered marker while linkedin keeps its null;
//   7. project isolation: a publish dispatch from another project is post_gone and the row is
//      untouched;
//   8. regression: the certified instagram/linkedin/facebook publishers are unchanged
//      (their registry entries and the exact PUBLISHERS key set).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { PUBLISHERS, publishX, publishLinkedIn, publishFacebook, publishInstagram, resolveConnection } from "../../shared/socialPublish.ts";
import { PUBLISHABLE_PLATFORMS } from "../../shared/virality.ts";
import { executeViralityPublishJob } from "../../shared/socialCalendar.ts";

const ROW = { platform: "x", body: "Launch day.", hashtags: ["ship"], image_url: null };
const TWEET_ID = "18000000000000001";

/** The documented happy-path provider: one POST /2/tweets — calls recorded, nothing real. */
const okCallApi = (calls) => async (method, path, body) => {
  calls.push({ method, path, body });
  return { success: true, status: 200, data: { data: { id: TWEET_ID } }, creditsCharged: 1 };
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    // ---- 1. fail-closed BEFORE any call -------------------------------------------------------------
    const zeroCalls = [];
    const imageRefused = await captureCall(() => publishX(svc, { ...ROW, image_url: "https://cdn.example.com/pic.png" }, { callApi: okCallApi(zeroCalls) }));
    h.check("an image row refuses X_IMAGE_UNSUPPORTED BEFORE any call (media upload is not supported on the X connector)",
      imageRefused.threw && imageRefused.code === "X_IMAGE_UNSUPPORTED" && zeroCalls.length === 0,
      JSON.stringify(imageRefused.code || "no-throw"));

    // ---- 2+3. request/response mapping through the injected seam --------------------------------------
    const calls = [];
    const ref = await publishX(svc, ROW, { callApi: okCallApi(calls) });
    h.check("the request is exactly ONE proxy call: POST /2/tweets with EXACTLY { text } (hashtags composed after the body)",
      calls.length === 1 && calls[0].method === "POST" && calls[0].path === "/2/tweets" &&
      JSON.stringify(calls[0].body) === JSON.stringify({ text: "Launch day.\n\n#ship" }),
      JSON.stringify(calls));
    h.check("the response maps to the provider's post id, returned verbatim",
      ref === TWEET_ID, String(ref));

    // ---- 4. provider/proxy failures -------------------------------------------------------------------
    const proxyThrew = await captureCall(() => publishX(svc, ROW, { callApi: async () => { throw new Error("proxy down"); } }));
    h.check("a thrown proxy call is NO_CONNECTION (needs_reconnect downstream), never a guessed success",
      proxyThrew.threw && proxyThrew.code === "NO_CONNECTION" && proxyThrew.status === 409,
      JSON.stringify(proxyThrew.code || "no-throw"));

    const forbidden = await captureCall(() => publishX(svc, ROW, { callApi: async () => ({ success: false, status: 403, data: null }) }));
    h.check("the provider's 403 (missing tweet.write / dead connection) is NO_CONNECTION",
      forbidden.threw && forbidden.code === "NO_CONNECTION" && forbidden.status === 409,
      JSON.stringify(forbidden.code || "no-throw"));

    const providerError = await captureCall(() => publishX(svc, ROW, { callApi: async () => ({ success: false, status: 400, data: null }) }));
    h.check("a provider 400 is X_API_ERROR (502), never a guessed success",
      providerError.threw && providerError.code === "X_API_ERROR" && Number(providerError.status) === 502,
      JSON.stringify(providerError.code || "no-throw"));

    // ---- 5. through the REAL surface (executeViralityPublishJob, real persistence) ---------------------
    const ws = await svc.entities.Workspace.create({ name: `xcert-${stamp}`, owner_id: `ownerX_${stamp}` });
    workspaces.push(ws.id);
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "starter_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `xcert-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `xcert-2-${stamp}`, status: "ready", version_count: 0 });
    projects.push(proj2.id);

    const publishers = {
      ...PUBLISHERS,
      x: (s, row) => publishX(s, row, { callApi: okCallApi([]) }),
    };
    const mkPost = async (platform, extra = {}) => svc.entities.ViralityScheduledPost.create({
      project_id: proj.id, workspace_id: ws.id, plan_id: null, platform, title: null,
      body: "Launch day.", hashtags: ["ship"], status: "scheduled",
      scheduled_at: new Date(stamp - 1000).toISOString(), image_url: null, ...extra,
    });

    const good = await mkPost("x");
    const posted = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: good.id }, { publishers });
    h.check("the scheduled X post publishes: posted with the provider ref",
      posted.status === "posted" && posted.ref === TWEET_ID, JSON.stringify(posted));
    const republished = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: good.id }, { publishers });
    h.check("duplicate-publication protection holds for X (posted → never published twice)",
      republished.skipped === "already_published", JSON.stringify(republished));

    const deadRow = await mkPost("x");
    const deadPub = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: deadRow.id }, {
      publishers: { ...publishers, x: () => publishX(svc, ROW, { callApi: async () => ({ success: false, status: 403, data: null }) }) },
    });
    const deadRowAfter = await svc.entities.ViralityScheduledPost.get(deadRow.id);
    h.check("a dead X connection maps to the documented needs_reconnect with the verbatim refusal stored",
      deadPub.status === "needs_reconnect" && String(deadRowAfter.publish_error || "").includes("tweet.write"),
      JSON.stringify({ status: deadPub.status, err: deadRowAfter.publish_error }));

    const failRow = await mkPost("x");
    const failedRun = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: failRow.id }, {
      publishers: { ...publishers, x: () => publishX(svc, ROW, { callApi: async () => ({ success: false, status: 400, data: null }) }) },
    });
    const notRetried = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: failRow.id }, { publishers });
    h.check("a refused X post (provider 400) fails terminally and is NOT retried",
      failedRun.status === "failed" && notRetried.skipped === "already_failed",
      JSON.stringify({ failedRun, notRetried: notRetried.skipped }));

    // ---- 6. registry invariants ------------------------------------------------------------------------
    h.check("x IS in PUBLISHABLE_PLATFORMS; tiktok and reddit are NOT",
      PUBLISHABLE_PLATFORMS.includes("x") && !PUBLISHABLE_PLATFORMS.includes("tiktok") && !PUBLISHABLE_PLATFORMS.includes("reddit"),
      JSON.stringify(PUBLISHABLE_PLATFORMS));
    const metered = await resolveConnection(svc, "x", { getConnection: async () => { throw new Error("getConnection refused"); } });
    const linkedinConn = await resolveConnection(svc, "linkedin", { getConnection: async () => null });
    h.check("resolveConnection: x returns a truthy metered marker (the pre-check never marks needs_reconnect); linkedin keeps its null",
      !!metered && linkedinConn === null, JSON.stringify({ metered: !!metered, linkedin: linkedinConn }));

    // ---- 7. project isolation ---------------------------------------------------------------------------
    const stranger = await executeViralityPublishJob(svc, { project_id: proj2.id, post_id: good.id }, { publishers });
    const goodAfter = await svc.entities.ViralityScheduledPost.get(good.id);
    h.check("isolation: a publish dispatch from another project is post_gone and the row is untouched",
      stranger.skipped === "post_gone" && goodAfter.status === "posted" && goodAfter.project_id === proj.id,
      JSON.stringify({ stranger, status: goodAfter.status }));

    // ---- 8. regression: the certified publishers are unchanged ------------------------------------------
    h.check("the certified instagram/linkedin/facebook publishers are unchanged (registry keys)",
      JSON.stringify(Object.keys(PUBLISHERS).filter((k) => ["linkedin", "facebook", "instagram"].includes(k))) === JSON.stringify(["linkedin", "facebook", "instagram"]) &&
      PUBLISHERS.linkedin === publishLinkedIn && PUBLISHERS.facebook === publishFacebook && PUBLISHERS.instagram === publishInstagram,
      JSON.stringify(Object.keys(PUBLISHERS)));
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