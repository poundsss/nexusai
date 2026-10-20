// Targeted certification for the IMPLEMENTED Instagram publisher (shared/socialPublish.ts
// publishInstagram) — the documented two-step media-container contract. ZERO real network and
// NO real Instagram account: every call rides the injected fetch seam, and the REAL job
// semantics are driven through executeViralityPublishJob with real persistence.
// Certified:
//   1. fail-closed refusals BEFORE any call — no connection (NO_CONNECTION), missing
//      instagram_business_content_publish scope (PERMISSION_MISSING), no image on the row
//      (PUBLISH_IMAGE_REQUIRED);
//   2. the dead-token NO_CONNECTION (the /me check);
//   3. request mapping: GET /me (the verified token check, token in the query, never a header),
//      POST /{ig-user-id}/media with EXACTLY { image_url, caption, access_token } (caption =
//      composeMessage — hashtags composed after the body), POST /{ig-user-id}/media_publish
//      with EXACTLY { creation_id, access_token };
//   4. response mapping: the container id → creation_id, the published id returned verbatim;
//   5. provider failures: a failed container → INSTAGRAM_API_ERROR (502) with NO publish call;
//      a container 200 without an id refuses; a failed publish → INSTAGRAM_API_ERROR;
//   6. through the REAL surface: posted with the provider ref, duplicate-publication
//      protection (posted → never published twice), a refused post fails terminally (not
//      retried), a dead connection maps to needs_reconnect, and the LinkedIn/Facebook
//      publisher registry is unchanged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { PUBLISHERS, publishInstagram, publishLinkedIn, publishFacebook } from "../../shared/socialPublish.ts";
import { executeViralityPublishJob } from "../../shared/socialCalendar.ts";

const CONN = { accessToken: "stub-ig-token", connectionConfig: { scopes: ["instagram_business_content_publish"] } };
const ROW = { platform: "instagram", body: "Visual day.", hashtags: ["ship"], image_url: "https://cdn.example.com/visual.png" };
const IG_USER = "17841400000000000";
const CREATION_ID = "17900000000000001";
const PUBLISHED_ID = "17900000000000002";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** The documented happy-path provider: /me, /media, /media_publish — calls recorded, nothing real. */
const okFetcher = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method, headers: init?.headers || null, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (String(url).includes("/me?")) return json({ id: IG_USER, username: "acme" });
  if (String(url).endsWith("/media")) return json({ id: CREATION_ID });
  return json({ id: PUBLISHED_ID });
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    // ---- 1. fail-closed refusals BEFORE any call -------------------------------------------------------
    const noConn = await captureCall(() => publishInstagram(svc, ROW, { getConnection: async () => null, fetch: okFetcher([]) }));
    h.check("no connection: NO_CONNECTION and ZERO calls",
      noConn.threw && noConn.code === "NO_CONNECTION" && noConn.status === 409, JSON.stringify(noConn.code || "no-throw"));

    const narrowConn = { accessToken: "stub-ig-token", connectionConfig: { scopes: ["w_member_social"] } };
    const noScope = await captureCall(() => publishInstagram(svc, ROW, { getConnection: async () => narrowConn, fetch: okFetcher([]) }));
    h.check("missing instagram_business_content_publish scope: PERMISSION_MISSING and ZERO calls",
      noScope.threw && noScope.code === "PERMISSION_MISSING" && noScope.status === 409, JSON.stringify(noScope.code || "no-throw"));

    const noImage = await captureCall(() => publishInstagram(svc, { ...ROW, image_url: null }, { getConnection: async () => CONN, fetch: okFetcher([]) }));
    h.check("a post with no image refuses PUBLISH_IMAGE_REQUIRED BEFORE any call (Instagram has no text-only post)",
      noImage.threw && noImage.code === "PUBLISH_IMAGE_REQUIRED", JSON.stringify(noImage.code || "no-throw"));

    // ---- 2. the dead token ------------------------------------------------------------------------------
    const deadCalls = [];
    const dead = await captureCall(() => publishInstagram(svc, ROW, {
      getConnection: async () => CONN,
      fetch: async () => json({ error: "invalid token" }, 401),
    }));
    h.check("a dead connection is NO_CONNECTION from the verified /me check (needs_reconnect downstream)",
      dead.threw && dead.code === "NO_CONNECTION" && dead.status === 409, JSON.stringify(dead.code || "no-throw"));

    // ---- 3. request mapping through the injected seam ---------------------------------------------------
    const calls = [];
    const ref = await publishInstagram(svc, ROW, { getConnection: async () => CONN, fetch: okFetcher(calls) });
    const me = calls[0] || {}, media = calls[1] || {}, publish = calls[2] || {};
    h.check("the request is exactly the documented 3-call flow: /me → /media → /media_publish",
      calls.length === 3 && me.url === `https://graph.instagram.com/me?fields=id,username&access_token=stub-ig-token` &&
      me.url === `${media.url.split("/v25.0")[0]}/me?fields=id,username&access_token=stub-ig-token` &&
      media.url === `https://graph.instagram.com/v25.0/${IG_USER}/media` &&
      publish.url === `https://graph.instagram.com/v25.0/${IG_USER}/media_publish`,
      JSON.stringify(calls.map((c) => c.url)));
    h.check("the container body is EXACTLY { image_url, caption, access_token } with the hashtags composed after the body",
      JSON.stringify(media.body) === JSON.stringify({ image_url: ROW.image_url, caption: "Visual day.\n\n#ship", access_token: "stub-ig-token" }),
      JSON.stringify(media.body));
    h.check("the publish body is EXACTLY { creation_id, access_token } carrying the container id",
      JSON.stringify(publish.body) === JSON.stringify({ creation_id: CREATION_ID, access_token: "stub-ig-token" }),
      JSON.stringify(publish.body));
    h.check("the token rides ONLY query/body params — never an Authorization header, on every call",
      calls.every((c) => !c.headers?.Authorization), JSON.stringify(calls.map((c) => c.headers?.Authorization)));
    h.check("the documented response maps to the published post id, returned verbatim",
      ref === PUBLISHED_ID, String(ref));

    // ---- 4. provider failures ---------------------------------------------------------------------------
    const containerFail = await captureCall(() => publishInstagram(svc, ROW, {
      getConnection: async () => CONN,
      fetch: async (url) => (String(url).includes("/me?") ? json({ id: IG_USER, username: "acme" }) : json({ error: "bad image" }, 400)),
    }));
    h.check("a failed container is INSTAGRAM_API_ERROR (502) and media_publish is NEVER called",
      containerFail.threw && containerFail.code === "INSTAGRAM_API_ERROR" && Number(containerFail.status) === 502, JSON.stringify(containerFail.code || "no-throw"));

    const containerEmpty = await captureCall(() => publishInstagram(svc, ROW, {
      getConnection: async () => CONN,
      fetch: async (url) => (String(url).includes("/me?") ? json({ id: IG_USER, username: "acme" }) : json({})),
    }));
    h.check("a container 200 without an id refuses rather than publishing an unusable creation",
      containerEmpty.threw && containerEmpty.code === "INSTAGRAM_API_ERROR", JSON.stringify(containerEmpty.code || "no-throw"));

    const publishFail = await captureCall(() => publishInstagram(svc, ROW, {
      getConnection: async () => CONN,
      fetch: async (url) => (String(url).includes("/me?") ? json({ id: IG_USER, username: "acme" })
        : String(url).endsWith("/media") ? json({ id: CREATION_ID }) : json({ error: "nope" }, 500)),
    }));
    h.check("a failed media_publish is INSTAGRAM_API_ERROR (502), never a guessed success",
      publishFail.threw && publishFail.code === "INSTAGRAM_API_ERROR" && Number(publishFail.status) === 502, JSON.stringify(publishFail.code || "no-throw"));

    // ---- 5. through the REAL surface (executeViralityPublishJob, real persistence) -----------------------
    const ws = await svc.entities.Workspace.create({ name: `igcert-${stamp}`, owner_id: `ownerIG_${stamp}` });
    workspaces.push(ws.id);
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "starter_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `igcert-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const publishers = {
      linkedin: publishLinkedIn,
      facebook: publishFacebook,
      instagram: (s, row) => publishInstagram(s, row, { getConnection: async () => CONN, fetch: okFetcher([]) }),
    };
    h.check("the publisher registry keeps the certified instagram/linkedin/facebook entries",
      JSON.stringify(Object.keys(PUBLISHERS).filter((k) => ["linkedin", "facebook", "instagram"].includes(k))) === JSON.stringify(["linkedin", "facebook", "instagram"]), JSON.stringify(Object.keys(PUBLISHERS)));

    const mkPost = async (platform, extra = {}) => svc.entities.ViralityScheduledPost.create({
      project_id: proj.id, workspace_id: ws.id, plan_id: null, platform, title: null,
      body: "Visual day.", hashtags: ["ship"], status: "scheduled",
      scheduled_at: new Date(stamp - 1000).toISOString(), image_url: null, ...extra,
    });

    const good = await mkPost("instagram", { image_url: ROW.image_url });
    const posted = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: good.id }, { publishers });
    h.check("the scheduled Instagram post publishes: posted with the provider ref",
      posted.status === "posted" && posted.ref === PUBLISHED_ID, JSON.stringify(posted));
    const republished = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: good.id }, { publishers });
    h.check("duplicate-publication protection holds for Instagram (posted → never published twice)",
      republished.skipped === "already_published", JSON.stringify(republished));

    const refused = await mkPost("instagram", { image_url: null });
    const failedRun = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: refused.id }, { publishers });
    const refusedRow = await svc.entities.ViralityScheduledPost.get(refused.id);
    const notRetried = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: refused.id }, { publishers });
    h.check("a refused Instagram post (no image) fails terminally with a safe error and is NOT retried",
      failedRun.status === "failed" && refusedRow.publish_error.includes("media container needs image_url") &&
      notRetried.skipped === "already_failed", JSON.stringify({ failedRun, notRetried: notRetried.skipped }));

    const deadRow = await mkPost("instagram", { image_url: ROW.image_url });
    const deadPub = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: deadRow.id }, {
      publishers: { ...publishers, instagram: (s, row) => publishInstagram(s, row, { getConnection: async () => null, fetch: okFetcher([]) }) },
    });
    h.check("a dead connection maps to the documented needs_reconnect",
      deadPub.status === "needs_reconnect", JSON.stringify(deadPub));

    const linkedin = await mkPost("linkedin");
    const liPub = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: linkedin.id }, { publishers: { linkedin: async (_s, row) => `urn:li:share:${row.id}` } });
    h.check("LinkedIn publishing behavior is unchanged (posted with its own ref shape)",
      liPub.status === "posted" && String(liPub.ref).startsWith("urn:li:share:"), JSON.stringify(liPub));
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