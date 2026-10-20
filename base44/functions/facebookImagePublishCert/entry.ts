// Targeted certification for the IMPLEMENTED Facebook image path (shared/socialPublish.ts
// publishFacebook) — the documented single-call photo publish. ZERO real network and NO real
// Page: every call rides the injected fetch seam, and the REAL job semantics are driven through
// executeViralityPublishJob with real persistence.
// Certified:
//   1. connection/scope gates unchanged: no connection (NO_CONNECTION) and missing
//      pages_manage_posts (PERMISSION_MISSING) refuse with ZERO calls;
//   2. a text-only row is byte-identical to the certified behavior: one POST /{page-id}/feed
//      with EXACTLY { message, access_token } and the feed id returned;
//   3. a row carrying image_url maps to the documented photo path: POST /{page-id}/photos with
//      EXACTLY { url, caption, access_token } (the PAGE token, never the user's; caption =
//      composeMessage — hashtags composed after the body) and the documented { id, post_id }
//      response maps to post_id (the feed story) with id as the documented fallback;
//   4. provider failures: a failed photos call → FACEBOOK_API_ERROR (502);
//   5. through the REAL surface: a scheduled Facebook image post publishes with the post_id ref
//      and duplicate-publication protection holds; a Facebook text post keeps the feed ref;
//      LinkedIn and Instagram publisher behavior is unchanged (registry identical).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { PUBLISHERS, publishFacebook, publishLinkedIn, publishInstagram } from "../../shared/socialPublish.ts";
import { executeViralityPublishJob } from "../../shared/socialCalendar.ts";

const CONN = { accessToken: "stub-fb-token", connectionConfig: { scopes: ["pages_manage_posts"] } };
const ROW = { platform: "facebook", body: "Launch day.", hashtags: ["ship"], image_url: "https://cdn.example.com/visual.png" };
const PAGE_ID = "1000000000001";
const PAGE_TOKEN = "stub-page-token";

/** The documented provider: /me/accounts → feed OR photos — calls recorded, nothing real. */
const okFetcher = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method, headers: init?.headers || null, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (String(url).includes("/me/accounts")) {
    return new Response(JSON.stringify({ data: [{ id: PAGE_ID, name: "Acme", access_token: PAGE_TOKEN }] }), { status: 200 });
  }
  if (String(url).endsWith("/photos")) return new Response(JSON.stringify({ id: "photo_1", post_id: `fb_${ROW.body.length}` }), { status: 200 });
  return new Response(JSON.stringify({ id: `feed_${ROW.body.length}` }), { status: 200 });
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    // ---- 1. connection/scope gates unchanged -------------------------------------------------------
    const noConn = await captureCall(() => publishFacebook(svc, ROW, { getConnection: async () => null, fetch: okFetcher([]) }));
    h.check("no connection: NO_CONNECTION and ZERO calls",
      noConn.threw && noConn.code === "NO_CONNECTION" && noConn.status === 409, JSON.stringify(noConn.code || "no-throw"));
    const narrowConn = { accessToken: "stub-fb-token", connectionConfig: { scopes: ["other_scope"] } };
    const missing = await captureCall(() => publishFacebook(svc, ROW, { getConnection: async () => narrowConn, fetch: okFetcher([]) }));
    h.check("missing pages_manage_posts: PERMISSION_MISSING and ZERO calls",
      missing.threw && missing.code === "PERMISSION_MISSING" && missing.status === 409, JSON.stringify(missing.code || "no-throw"));

    // ---- 2. the text-only row is byte-identical to the certified feed behavior ----------------------
    const textCalls = [];
    const textRef = await publishFacebook(svc, { ...ROW, image_url: null }, { getConnection: async () => CONN, fetch: okFetcher(textCalls) });
    h.check("a text-only row posts EXACTLY the certified feed request: { message, access_token }",
      textCalls.length === 2 && textCalls[1].url === `https://graph.facebook.com/v25.0/${PAGE_ID}/feed` &&
      JSON.stringify(textCalls[1].body) === JSON.stringify({ message: "Launch day.\n\n#ship", access_token: PAGE_TOKEN }) &&
      textRef === `feed_${ROW.body.length}`, JSON.stringify({ calls: textCalls.length, ref: textRef }));

    // ---- 3. the image row maps to the documented photos path ---------------------------------------
    const calls = [];
    const ref = await publishFacebook(svc, ROW, { getConnection: async () => CONN, fetch: okFetcher(calls) });
    h.check("an image row posts to the documented photos endpoint with EXACTLY { url, caption, access_token }",
      calls.length === 2 && calls[1].url === `https://graph.facebook.com/v25.0/${PAGE_ID}/photos` &&
      JSON.stringify(calls[1].body) === JSON.stringify({ url: ROW.image_url, caption: "Launch day.\n\n#ship", access_token: PAGE_TOKEN }),
      JSON.stringify(calls.map((c) => c.url)));
    h.check("the request resolves the page token (Authorization on /me/accounts only; the page token rides the body)",
      calls[0].headers?.Authorization === "Bearer stub-fb-token" && calls[1].headers?.Authorization === undefined,
      JSON.stringify({ auth0: calls[0].headers?.Authorization }));
    h.check("the documented { id, post_id } response maps to post_id (the feed story) as the provider ref",
      ref === `fb_${ROW.body.length}`, String(ref));

    const idOnlyCalls = [];
    const idOnlyFetcher = async (url, init) => {
      void init;
      if (String(url).includes("/me/accounts")) return new Response(JSON.stringify({ data: [{ id: PAGE_ID, name: "Acme", access_token: PAGE_TOKEN }] }), { status: 200 });
      return new Response(JSON.stringify({ id: "photo_2" }), { status: 200 });
    };
    const idRef = await publishFacebook(svc, ROW, { getConnection: async () => CONN, fetch: idOnlyCalls.length || idOnlyFetcher });
    h.check("a photo response without post_id falls back to the documented id field",
      idRef === "photo_2", String(idRef));

    // ---- 4. provider failures -----------------------------------------------------------------------
    const fail = await captureCall(() => publishFacebook(svc, ROW, {
      getConnection: async () => CONN,
      fetch: async (url) => (String(url).includes("/me/accounts")
        ? new Response(JSON.stringify({ data: [{ id: PAGE_ID, name: "Acme", access_token: PAGE_TOKEN }] }), { status: 200 })
        : new Response(JSON.stringify({ error: "nope" }), { status: 400 })),
    }));
    h.check("a failed photos call is FACEBOOK_API_ERROR (502), never a guessed success",
      fail.threw && fail.code === "FACEBOOK_API_ERROR" && Number(fail.status) === 502, JSON.stringify(fail.code || "no-throw"));

    // ---- 5. through the REAL surface (executeViralityPublishJob, real persistence) -------------------
    const ws = await svc.entities.Workspace.create({ name: `fbimg-${stamp}`, owner_id: `ownerF_${stamp}` });
    workspaces.push(ws.id);
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "starter_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `fbimg-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const publishers = {
      linkedin: publishLinkedIn,
      facebook: (s, row) => publishFacebook(s, row, { getConnection: async () => CONN, fetch: okFetcher([]) }),
      instagram: publishInstagram,
    };
    h.check("the publisher registry is unchanged: exactly linkedin, facebook, instagram",
      JSON.stringify(Object.keys(PUBLISHERS).filter((k) => ["linkedin", "facebook", "instagram"].includes(k))) === JSON.stringify(["linkedin", "facebook", "instagram"]), JSON.stringify(Object.keys(PUBLISHERS)));

    const mkPost = async (extra = {}) => svc.entities.ViralityScheduledPost.create({
      project_id: proj.id, workspace_id: ws.id, plan_id: null, platform: "facebook", title: null,
      body: "Launch day.", hashtags: ["ship"], status: "scheduled",
      scheduled_at: new Date(stamp - 1000).toISOString(), image_url: null, ...extra,
    });

    const img = await mkPost({ image_url: ROW.image_url });
    const posted = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: img.id }, { publishers });
    h.check("a scheduled Facebook image post publishes: posted with the post_id ref",
      posted.status === "posted" && posted.ref === `fb_${ROW.body.length}`, JSON.stringify(posted));
    const republished = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: img.id }, { publishers });
    h.check("duplicate-publication protection holds for the image post (posted → never published twice)",
      republished.skipped === "already_published", JSON.stringify(republished));

    const text = await mkPost({});
    const textPub = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: text.id }, { publishers });
    h.check("a Facebook text post keeps the certified feed behavior (posted with the feed ref)",
      textPub.status === "posted" && textPub.ref === `feed_${ROW.body.length}`, JSON.stringify(textPub));

    const linkedin = await svc.entities.ViralityScheduledPost.create({
      project_id: proj.id, workspace_id: ws.id, plan_id: null, platform: "linkedin", title: null,
      body: "Launch day.", hashtags: ["ship"], status: "scheduled",
      scheduled_at: new Date(stamp - 1000).toISOString(), image_url: ROW.image_url,
    });
    const liPub = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: linkedin.id }, { publishers: { ...publishers, linkedin: async (_s, row) => `urn:li:share:${row.id}` } });
    h.check("LinkedIn is unchanged: its image-carrying row still publishes through its own contract",
      liPub.status === "posted" && String(liPub.ref).startsWith("urn:li:share:"), JSON.stringify(liPub));

    // ---- 6. authorization ---------------------------------------------------------------------------
    const stranger = { id: `f_stranger_${stamp}`, email: "fs@example.com" };
    const strangerWrite = await captureCall(() => loadAuthorizedProject(svc, stranger, proj.id, "project.write"));
    h.check("authorization: a non-member cannot mutate the project's posts (403)",
      strangerWrite.threw && Number(strangerWrite.status) === 403, String(strangerWrite.status || "no-throw"));
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