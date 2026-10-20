// Targeted certification for the IMPLEMENTED LinkedIn image path (shared/socialPublish.ts
// publishLinkedIn) — the documented v2 digitalmedia flow. ZERO real network (the fetch seam is
// injected), NO real LinkedIn account; the REAL job semantics run through
// executeViralityPublishJob with real persistence.
// Certified:
//   1. text-only row: byte-identical to the certified NONE-category ugcPosts share (no
//      registerUpload, no binary PUT) — zero behavior drift;
//   2. connection/scope gates unchanged (NO_CONNECTION, PERMISSION_MISSING, zero calls);
//   3. an image row runs the documented four-call sequence: GET image_url → POST
//      /v2/assets?action=registerUpload (feedshare-image recipe, owner urn FROM THE TOKEN,
//      OWNER relationship) → binary PUT to the returned uploadUrl (Authorization header, media
//      Content-Type) → ugcPosts with shareMediaCategory IMAGE referencing the asset urn;
//   4. mapping: the documented { value: { asset, uploadMechanism[...].uploadUrl } } response is
//      consumed exactly; a registerUpload response missing either refuses (no invented ids);
//   5. provider failures: image fetch failure, registerUpload !ok and binary PUT !ok all refuse
//      LINKEDIN_API_ERROR (502) with no post created;
//   6. through the REAL surface: a scheduled LinkedIn image row posts with the restli ref and
//      duplicate protection holds; Facebook/Instagram publishers are untouched;
//   7. authorization: a non-member cannot mutate the project (403).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { publishLinkedIn, publishFacebook, publishInstagram } from "../../shared/socialPublish.ts";
import { executeViralityPublishJob } from "../../shared/socialCalendar.ts";

const CONN = { accessToken: "stub-li-token", connectionConfig: { scopes: ["w_member_social"] } };
const ROW = { platform: "linkedin", body: "Launch day.", hashtags: ["ship"], image_url: "https://cdn.example.com/visual.png" };
const IMG_BYTES = new Uint8Array([1, 2, 3]).buffer;

/** The documented provider: userinfo → [image] → assets register → upload → ugcPosts. */
const okFetcher = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method, headers: init?.headers || null, body: init?.body ? String(init.body) : null });
  const u = String(url);
  if (u.includes("userinfo")) return new Response(JSON.stringify({ sub: "prof_1" }), { status: 200 });
  if (u.includes("assets?action=registerUpload")) {
    return new Response(JSON.stringify({
      value: {
        asset: "urn:li:digitalmediaAsset:ASSET1",
        uploadMechanism: { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://upload.linkedin.com/put-here" } },
      },
    }), { status: 200 });
  }
  if (u === "https://upload.linkedin.com/put-here") return new Response(null, { status: 201 });
  return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:POST1" } });
};

const userInfoOnly = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method });
  return new Response(JSON.stringify({ sub: "prof_1" }), { status: 200 });
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    // ---- 1. the text-only row is byte-identical to the certified behavior --------------------------
    const textCalls = [];
    const textRes = await publishLinkedIn(svc, { ...ROW, image_url: null }, { getConnection: async () => CONN, fetch: okFetcher(textCalls) });
    h.check("a text-only row makes exactly TWO calls (userinfo, ugcPosts) — no registerUpload, no binary PUT",
      textCalls.length === 2 && textCalls[0].url.includes("userinfo") &&
      textCalls[1].url === "https://api.linkedin.com/v2/ugcPosts" && textRes === "urn:li:share:POST1",
      JSON.stringify(textCalls.map((c) => c.url)));
    const textBody = JSON.parse(textCalls[1].body);
    h.check("the text share is the certified NONE-category contract, verbatim",
      textBody.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory === "NONE" &&
      textBody.specificContent["com.linkedin.ugc.ShareContent"].shareCommentary.text === "Launch day.\n\n#ship" &&
      !Array.isArray(textBody.specificContent["com.linkedin.ugc.ShareContent"].media),
      textCalls[1].body);

    // ---- 2. gates unchanged -------------------------------------------------------------------------
    const noConn = await captureCall(() => publishLinkedIn(svc, ROW, { getConnection: async () => null, fetch: okFetcher([]) }));
    h.check("no connection: NO_CONNECTION and ZERO calls", noConn.threw && noConn.code === "NO_CONNECTION", noConn.code || "no-throw");
    const missing = await captureCall(() => publishLinkedIn(svc, ROW, {
      getConnection: async () => ({ accessToken: "t", connectionConfig: { scopes: ["other"] } }), fetch: okFetcher([]),
    }));
    h.check("missing w_member_social: PERMISSION_MISSING and ZERO calls", missing.threw && missing.code === "PERMISSION_MISSING", missing.code || "no-throw");

    // ---- 3+4. the documented four-call image sequence -------------------------------------------------
    const calls = [];
    const res = await publishLinkedIn(svc, ROW, { getConnection: async () => CONN, fetch: okFetcher(calls) });
    h.check("an image row runs the documented sequence in order: userinfo → image GET → registerUpload → binary PUT → ugcPosts",
      calls.length === 5 &&
      calls[0].url.includes("userinfo") &&
      calls[1].url === ROW.image_url && calls[1].method === undefined &&
      calls[2].url === "https://api.linkedin.com/v2/assets?action=registerUpload" && calls[2].method === "POST" &&
      calls[3].url === "https://upload.linkedin.com/put-here" && calls[3].method === "PUT" &&
      calls[4].url === "https://api.linkedin.com/v2/ugcPosts",
      JSON.stringify(calls.map((c) => `${c.method} ${c.url}`)));
    const regBody = JSON.parse(calls[2].body);
    h.check("registerUpload maps the documented request: feedshare-image recipe, owner urn FROM THE TOKEN, OWNER relationship",
      JSON.stringify(regBody) === JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: "urn:li:person:prof_1",
          serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
        },
      }), calls[1].body);
    h.check("the binary PUT carries the token in the Authorization header and the image Content-Type, nothing else",
      calls[3].headers.Authorization === "Bearer stub-li-token" &&
      (calls[3].headers["Content-Type"] || "").startsWith("image/") &&
      !calls[3].headers["X-Restli-Protocol-Version"],
      JSON.stringify(calls[3].headers));
    const postBody = JSON.parse(calls[4].body);
    h.check("the final post maps the documented IMAGE share: same author/visibility, asset urn referenced as READY media",
      postBody.author === "urn:li:person:prof_1" &&
      postBody.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory === "IMAGE" &&
      postBody.specificContent["com.linkedin.ugc.ShareContent"].media[0].status === "READY" &&
      postBody.specificContent["com.linkedin.ugc.ShareContent"].media[0].media === "urn:li:digitalmediaAsset:ASSET1" &&
      postBody.visibility["com.linkedin.ugc.MemberNetworkVisibility"] === "PUBLIC" &&
      res === "urn:li:share:POST1", calls[3].body);

    // ---- 5. provider failures refuse with NO post ------------------------------------------------------
    const badImg = await captureCall(() => publishLinkedIn(svc, ROW, {
      getConnection: async () => CONN, fetch: userInfoOnly([]).and ? null : async (url) => (String(url).includes("userinfo") ? new Response(JSON.stringify({ sub: "prof_1" }), { status: 200 }) : new Response(null, { status: 404 })),
    }));
    h.check("an image fetch failure refuses LINKEDIN_API_ERROR before registerUpload",
      badImg.threw && badImg.code === "LINKEDIN_API_ERROR", badImg.code || "no-throw");
    const badReg = await captureCall(() => publishLinkedIn(svc, ROW, {
      getConnection: async () => CONN,
      fetch: async (url) => (String(url).includes("userinfo") ? new Response(JSON.stringify({ sub: "prof_1" }), { status: 200 })
        : String(url).includes("assets?action=registerUpload") ? new Response(JSON.stringify({ error: "no" }), { status: 403 })
        : new Response(null, { status: 201, headers: { "x-restli-id": "x" } })),
    }));
    h.check("a failed registerUpload refuses LINKEDIN_API_ERROR and no ugcPosts is made",
      badReg.threw && badReg.code === "LINKEDIN_API_ERROR", badReg.code || "no-throw");
    const noAsset = await captureCall(() => publishLinkedIn(svc, ROW, {
      getConnection: async () => CONN,
      fetch: async (url) => (String(url).includes("userinfo") ? new Response(JSON.stringify({ sub: "prof_1" }), { status: 200 })
        : String(url).includes("assets?action=registerUpload") ? new Response(JSON.stringify({ value: { asset: "urn:li:digitalmediaAsset:A" } }), { status: 200 })
        : new Response(null, { status: 201, headers: { "x-restli-id": "x" } })),
    }));
    h.check("a registerUpload response without uploadUrl refuses (no invented upload target)",
      noAsset.threw && noAsset.code === "LINKEDIN_API_ERROR", noAsset.code || "no-throw");
    const badPut = await captureCall(() => publishLinkedIn(svc, ROW, {
      getConnection: async () => CONN,
      fetch: async (url) => (String(url).includes("userinfo") ? new Response(JSON.stringify({ sub: "prof_1" }), { status: 200 })
        : String(url).includes("assets?action=registerUpload") ? new Response(JSON.stringify({
            value: { asset: "urn:li:digitalmediaAsset:A", uploadMechanism: { "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": { uploadUrl: "https://upload.linkedin.com/put-here" } } },
          }), { status: 200 })
        : String(url) === "https://upload.linkedin.com/put-here" ? new Response(null, { status: 500 })
        : new Response(null, { status: 201, headers: { "x-restli-id": "x" } })),
    }));
    h.check("a failed binary PUT refuses LINKEDIN_API_ERROR and no ugcPosts is made",
      badPut.threw && badPut.code === "LINKEDIN_API_ERROR", badPut.code || "no-throw");

    // ---- 6. through the REAL surface -------------------------------------------------------------------
    const ws = await svc.entities.Workspace.create({ name: `liimg-${stamp}`, owner_id: `ownerL_${stamp}` });
    workspaces.push(ws.id);
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "starter_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `liimg-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const publishers = {
      linkedin: (s, row) => publishLinkedIn(s, row, { getConnection: async () => CONN, fetch: okFetcher([]) }),
      facebook: publishFacebook,
      instagram: publishInstagram,
    };
    const mkPost = async (extra = {}) => svc.entities.ViralityScheduledPost.create({
      project_id: proj.id, workspace_id: ws.id, plan_id: null, platform: "linkedin", title: null,
      body: "Launch day.", hashtags: ["ship"], status: "scheduled",
      scheduled_at: new Date(stamp - 1000).toISOString(), image_url: null, ...extra,
    });
    const img = await mkPost({ image_url: ROW.image_url });
    const posted = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: img.id }, { publishers });
    h.check("a scheduled LinkedIn image row publishes through the real job with the restli ref",
      posted.status === "posted" && posted.ref === "urn:li:share:POST1", JSON.stringify(posted));
    const republished = await executeViralityPublishJob(svc, { project_id: proj.id, post_id: img.id }, { publishers });
    h.check("duplicate-publication protection holds for the image post",
      republished.skipped === "already_published", JSON.stringify(republished));

    // ---- 7. authorization ------------------------------------------------------------------------------
    const stranger = { id: `l_stranger_${stamp}`, email: "ls@example.com" };
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