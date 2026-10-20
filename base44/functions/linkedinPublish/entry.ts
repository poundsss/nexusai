// LinkedIn one-shot publishing — NexusAI-NATIVE, connector-backed. Publishes ONE ready-to-post
// LinkedIn variation from the Social content surface through the EXISTING shared LinkedIn
// connector. No new OAuth, no persistence, no scheduling, no app-user connector changes.
// This is NOT a reproduction of Base44's undocumented Social-content "Share" mechanics —
// no parity is claimed for that mechanism; the publish path is the confirmed official API.
//
// CONFIRMED official contract (Microsoft Learn, UGC Post API):
//   POST https://api.linkedin.com/v2/ugcPosts
//     headers: Authorization: Bearer <token>, X-Restli-Protocol-Version: 2.0.0, Content-Type: application/json
//     text-only post: author "urn:li:person:<sub>", lifecycleState "PUBLISHED",
//       specificContent["com.linkedin.ugc.ShareContent"] = { shareCommentary: { text }, shareMediaCategory: "NONE" },
//       visibility["com.linkedin.ugc.MemberNetworkVisibility"] = "PUBLIC"
//   the member urn comes from the token itself: GET https://api.linkedin.com/v2/userinfo → { sub }
//   created post id: the "x-restli-id" response header
// Personal-profile path only (w_member_social). Images are NOT published (asset registration
// is a separate unconfirmed contract) — the copy text alone is posted.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";

export const config = { public: true };

const UGC_POSTS_URL = "https://api.linkedin.com/v2/ugcPosts";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

const refused = async (svc, ctx, code, status, message) => {
  await audit(svc, {
    workspace_id: ctx.workspace_id, project_id: ctx.project_id, user_id: ctx.user_id,
    action: "social.post.publish_failed", resource: "Project", resource_id: ctx.project_id,
    metadata: { platform: "linkedin", error_code: code, status },
  });
  return Response.json({ error: message, code }, { status });
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const svc = base44.asServiceRole || base44;
    const { project, workspace } = await loadAuthorizedProject(svc, user, body.project_id, "project.write");
    const ctx = { workspace_id: workspace.id, project_id: project.id, user_id: user.id };

    const copy = String(body.copy || "").trim().slice(0, 4000);
    if (!copy) return Response.json({ error: "copy is required", code: "COPY_REQUIRED" }, { status: 400 });

    // Fail closed: the publish runs ONLY through the existing shared LinkedIn connector.
    let accessToken = null;
    let scopes = null;
    try {
      const conn = await svc.connectors.getConnection("linkedin");
      accessToken = conn?.accessToken || null;
      scopes = conn?.connectionConfig?.scopes ?? null;
    } catch {
      accessToken = null;
    }
    if (!accessToken) return refused(svc, ctx, "NO_LINKEDIN_CONNECTION", 409, "No connected LinkedIn account. Connect LinkedIn under Integrations and try again.");
    // Scope gate — enforced only when the connector reports its scopes (fail-closed on data, never on absence).
    if (Array.isArray(scopes) && scopes.length && !scopes.includes("w_member_social"))
      return refused(svc, ctx, "LINKEDIN_SCOPE_MISSING", 409, "The connected LinkedIn account lacks publishing permission (w_member_social).");

    // The authorized personal profile is resolved FROM THE TOKEN, never from a client value.
    const me = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const meJson = me.ok ? await me.json().catch(() => null) : null;
    if (!me.ok || !meJson?.sub) {
      await audit(svc, { ...ctx, action: "social.post.publish_failed", resource: "Project", resource_id: project.id, metadata: { platform: "linkedin", error_code: "CONNECTION_INVALID", status: me.status } });
      return Response.json({ error: "The LinkedIn connection is no longer valid. Reconnect LinkedIn under Integrations.", code: "CONNECTION_INVALID" }, { status: 409 });
    }

    const postRes = await fetch(UGC_POSTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        author: `urn:li:person:${meJson.sub}`,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: copy },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    if (!postRes.ok) {
      const detail = (await postRes.text().catch(() => "")).slice(0, 300);
      await audit(svc, { ...ctx, action: "social.post.publish_failed", resource: "Project", resource_id: project.id, metadata: { platform: "linkedin", error_code: "LINKEDIN_API_ERROR", status: postRes.status } });
      return Response.json({ error: `LinkedIn API error ${postRes.status}: ${detail}`, code: "LINKEDIN_API_ERROR" }, { status: 502 });
    }

    const post_urn = postRes.headers.get("x-restli-id") || null;
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: "social.post.published", resource: "Project", resource_id: project.id,
      metadata: { platform: "linkedin", post_urn },
    });
    return Response.json({ ok: true, post_urn });
  } catch (e) {
    const status = e.status || 500;
    return Response.json({ error: String(e.message || e), code: e.code || "LINKEDIN_PUBLISH_ERROR" }, { status });
  }
}