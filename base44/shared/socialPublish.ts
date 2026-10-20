// Virality Phase 2 publishing adapters — each publishes the VERIFIED extent only, fail-closed.
//
// LinkedIn: the CONFIRMED UGC Posts contract (extracted verbatim from the certified
// functions/linkedinPublish) — personal profile, w_member_social gate, author resolved FROM
// THE TOKEN, copy text alone (image asset registration is a separate UNVERIFIED contract).
//
// Facebook: the connector-VERIFIED path — facebook_pages connection, pages_manage_posts scope
// gate, page access token via GET /me/accounts (the documented connector guide), then the
// standard Page feed message post. A row carrying image_url publishes the DOCUMENTED
// single-call photo path instead: POST /{page-id}/photos with { url, caption } → { id, post_id }
// (post_id is the feed story the photo lands on). Multi-photo, video, stories and album
// publishing remain UNKNOWN.
//
// Instagram: the connector-VERIFIED connection + scope gate, the verified token check against
// graph.instagram.com (token as a query param, never the Authorization header), and the
// DOCUMENTED two-step media-container publish (Meta's Instagram Graph API): POST
// /{ig-user-id}/media with { image_url, caption } → creation_id, then POST /{ig-user-id}/media_publish
// with { creation_id } → the published post id. Instagram has NO text-only post, so the row's
// image_url (a DOCUMENTED field) is the required media; a post without one refuses BEFORE any call.
//
// UNKNOWN (never invented):
//   • long-lived token exchange — the connector does not perform Meta's fb_exchange_token;
//     tokens are treated as expiring (a dead token surfaces as NO_CONNECTION → needs_reconnect).
//   • per-page selection for Facebook (the FIRST managed page is used — NEXUSAI-DERIVED).
//   • LinkedIn image publishing IS implemented — the DOCUMENTED v2 digitalmedia flow:
//     POST /v2/assets?action=registerUpload (feedshare-image recipe) → { asset, uploadUrl },
//     the image bytes PUT to uploadUrl, then the ugcPosts share with shareMediaCategory IMAGE
//     and the asset urn. Facebook publishes the documented single photo (photos endpoint);
//     Instagram's ONLY documented mode is an image post (the media-container flow below).
//   • LinkedIn video/carousel/multi-image publishing — not implemented (UNKNOWN, never invented).
//   • publishing retry semantics — a failed post is NOT retried (documented); the caller of
//     executeViralityPublishJob decides nothing about retries.
import { err } from "./virality.ts";
import { publishOwnTikTok } from "./tiktokPublishing.ts";

export const NO_CONNECTION = "NO_CONNECTION";
export const PERMISSION_MISSING = "PERMISSION_MISSING";

/** The default connection resolver: the EXISTING shared connector, fail-closed on absence. */
export const defaultGetConnection = async (svc, type) => {
  try {
    const conn = await svc.connectors.getConnection(type);
    return conn?.accessToken ? conn : null;
  } catch {
    return null;
  }
};

export async function resolveConnection(svc, platform, { getConnection = null } = {}) {
  const get = getConnection || defaultGetConnection;
  const type = platform === "facebook" ? "facebook_pages" : platform;
  // The metered X connector exposes NO token (getConnection is refused), so the shared
  // connection is never resolvable through it — the X publisher checks the connection itself
  // through the proxy. A truthy marker keeps the scheduling pre-check from marking
  // needs_reconnect before the post ever reaches its publisher (NEXUSAI-DERIVED).
  if (type === "x") return { metered: true };
  return (await get(svc, type)) || null;
}

// Fail-closed on scope when the connector reports its scopes; never refuses on absence of data
// (the same rule the certified LinkedIn publisher uses).
const hasScope = (conn, scope) => {
  const scopes = conn?.connectionConfig?.scopes;
  return !Array.isArray(scopes) || !scopes.length || scopes.includes(scope);
};

/** The documented composition: the body followed by the hashtags (tags never inside the body). */
export function composeMessage(row) {
  const tags = (row.hashtags || []).map((t) => `#${String(t).replace(/^#/, "")}`).filter(Boolean).join(" ");
  return tags ? `${row.body || ""}\n\n${tags}` : String(row.body || "");
}

// --- LinkedIn (the confirmed UGC Posts contract) ---------------------------------------------
const UGC_POSTS_URL = "https://api.linkedin.com/v2/ugcPosts";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

// The DOCUMENTED LinkedIn image flow (v2 digitalmedia assets): registerUpload with the
// feedshare-image recipe → { value: { asset, uploadMechanism[...].uploadUrl } }, then the
// BINARY PUT to uploadUrl (the token in the Authorization header — no Restli header on this
// call), then the post references the asset urn. Only the feed-share IMAGE recipe is used;
// video/carousel/multi-image behavior is UNKNOWN and never invented. `f` is the certification's
// deterministic network seam (production never passes one — the platform fetch runs).
const ASSETS_REGISTER_URL = "https://api.linkedin.com/v2/assets?action=registerUpload";
const LINKEDIN_IMAGE_RECIPE = "urn:li:digitalmediaRecipe:feedshare-image";

async function uploadLinkedInImage(f, token, personUrn, image_url) {
  const img = await f(image_url, {});
  if (!img.ok) throw err(`The post's image could not be fetched (HTTP ${img.status})`, 502, "LINKEDIN_API_ERROR");
  const bytes = await img.arrayBuffer();
  const registered = await f(ASSETS_REGISTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [LINKEDIN_IMAGE_RECIPE],
        owner: personUrn,
        serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
      },
    }),
  });
  if (!registered.ok) throw err(`LinkedIn registerUpload error ${registered.status}`, 502, "LINKEDIN_API_ERROR");
  const regJson = await registered.json().catch(() => null);
  const asset = regJson?.value?.asset || null;
  const uploadUrl = regJson?.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl || null;
  if (!asset || !uploadUrl) {
    throw err("LinkedIn registerUpload returned no asset/uploadUrl", 502, "LINKEDIN_API_ERROR");
  }
  const uploaded = await f(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": img.headers?.get?.("content-type") || "image/jpeg" },
    body: bytes,
  });
  if (!uploaded.ok) throw err(`LinkedIn image upload error ${uploaded.status}`, 502, "LINKEDIN_API_ERROR");
  return asset;
}

export async function publishLinkedIn(svc, row, { getConnection = null, fetch: injectedFetch = null } = {}) {
  const f = injectedFetch || fetch.bind(globalThis);
  const conn = await resolveConnection(svc, "linkedin", { getConnection });
  if (!conn) throw err("No connected LinkedIn account", 409, NO_CONNECTION);
  if (!hasScope(conn, "w_member_social")) {
    throw err("The connected LinkedIn account lacks publishing permission (w_member_social)", 409, PERMISSION_MISSING);
  }
  // The authorized personal profile is resolved FROM THE TOKEN, never from a client value.
  const me = await f(USERINFO_URL, { headers: { Authorization: `Bearer ${conn.accessToken}` } });
  const meJson = me.ok ? await me.json().catch(() => null) : null;
  if (!me.ok || !meJson?.sub) throw err("The LinkedIn connection is no longer valid", 409, NO_CONNECTION);
  const personUrn = `urn:li:person:${meJson.sub}`;
  const image_url = String(row.image_url || "").trim();
  // A text-only row keeps the EXACT certified NONE-category share. An image row publishes the
  // DOCUMENTED IMAGE-category share referencing the registered asset urn — same endpoint,
  // author and visibility; nothing else about the contract changes.
  const shareContent = {
    shareCommentary: { text: composeMessage(row) },
    shareMediaCategory: image_url ? "IMAGE" : "NONE",
    ...(image_url ? { media: [{ status: "READY", media: await uploadLinkedInImage(f, conn.accessToken, personUrn, image_url) }] } : {}),
  };
  const res = await f(UGC_POSTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      author: personUrn,
      lifecycleState: "PUBLISHED",
      specificContent: { "com.linkedin.ugc.ShareContent": shareContent },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  if (!res.ok) throw err(`LinkedIn API error ${res.status}`, 502, "LINKEDIN_API_ERROR");
  return res.headers.get("x-restli-id") || null;
}

// --- Facebook (the connector-verified Pages path; feed message or the documented photo) --------
// Text-only rows keep the DOCUMENTED feed post (POST /{page-id}/feed with { message }). A row
// carrying image_url publishes the DOCUMENTED single-call photo path instead — POST
// /{page-id}/photos with { url, caption, access_token } (published defaults to true) →
// { id, post_id }; post_id is the feed story the photo lands on, so it is the provider ref
// (id is the fallback, a documented field of the same response). The PAGE token is used —
// never the user's. NO multi-photo (attached_media), video, stories or album behavior is
// implemented (UNKNOWN, never invented). `opts.fetch` is the certification's deterministic
// network seam (production never passes one — the platform fetch runs).
export async function publishFacebook(svc, row, { getConnection = null, fetch: injectedFetch = null } = {}) {
  const f = injectedFetch || fetch.bind(globalThis);
  const conn = await resolveConnection(svc, "facebook", { getConnection });
  if (!conn) throw err("No connected Facebook Pages account", 409, NO_CONNECTION);
  if (!hasScope(conn, "pages_manage_posts")) {
    throw err("The connected Facebook account lacks publishing permission (pages_manage_posts)", 409, PERMISSION_MISSING);
  }
  const list = await f("https://graph.facebook.com/v25.0/me/accounts?fields=id,name,access_token", {
    headers: { Authorization: `Bearer ${conn.accessToken}` },
  });
  const listJson = list.ok ? await list.json().catch(() => null) : null;
  const pages = Array.isArray(listJson?.data) ? listJson.data.filter((p) => p?.id && p?.access_token) : [];
  if (!list.ok || !pages.length) {
    throw err("No managed Facebook Page is available on this connection", 409, NO_CONNECTION);
  }
  // NEXUSAI-DERIVED (UNKNOWN): per-page selection is not documented — the first managed page is used.
  const page = pages[0];
  const image_url = String(row.image_url || "").trim();
  const payload = image_url
    ? { url: image_url, caption: composeMessage(row), access_token: page.access_token }
    : { message: composeMessage(row), access_token: page.access_token };
  const res = await f(`https://graph.facebook.com/v25.0/${page.id}/${image_url ? "photos" : "feed"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw err(`Facebook API error ${res.status}`, 502, "FACEBOOK_API_ERROR");
  const out = await res.json().catch(() => null);
  return (image_url ? (out?.post_id || out?.id) : out?.id) || null;
}

// --- Instagram (the documented media-container publish; image + caption) -----------------------
// Meta's Instagram Graph API on the VERIFIED host + token convention (graph.instagram.com, the
// token as a query/body param, never the Authorization header). Instagram has no text-only
// post: a publish is the DOCUMENTED two-step container flow —
//   1. POST /{ig-user-id}/media          { image_url, caption, access_token } → { id: creation_id }
//   2. POST /{ig-user-id}/media_publish   { creation_id, access_token }       → { id: the post id }
// The IG user id comes FROM THE TOKEN (GET /me — the already-verified step). The row's
// image_url is the required media; a post without one refuses BEFORE any call — no invented
// fallback. UNKNOWN (never invented): video/carousel containers, story/reel publishing,
// container-status polling (the documented IN_PROGRESS/FINISHED wait) and long-lived token
// exchange — the connector's token is used as issued. `opts.fetch` is the certification's
// deterministic network seam (production never passes one — the platform fetch runs).
export async function publishInstagram(svc, row, { getConnection = null, fetch: injectedFetch = null } = {}) {
  const f = injectedFetch || fetch.bind(globalThis);
  const conn = await resolveConnection(svc, "instagram", { getConnection });
  if (!conn) throw err("No connected Instagram Business account", 409, NO_CONNECTION);
  if (!hasScope(conn, "instagram_business_content_publish")) {
    throw err("The connected Instagram account lacks publishing permission (instagram_business_content_publish)", 409, PERMISSION_MISSING);
  }
  const image_url = String(row.image_url || "").trim();
  if (!image_url) {
    throw err("Instagram publishing requires the post's image (a media container needs image_url; video publishing is not implemented)", 409, "PUBLISH_IMAGE_REQUIRED");
  }
  // The VERIFIED step: the token only works against graph.instagram.com, passed as a query param.
  const me = await f(`https://graph.instagram.com/me?fields=id,username&access_token=${encodeURIComponent(conn.accessToken)}`);
  const meJson = me.ok ? await me.json().catch(() => null) : null;
  if (!me.ok || !meJson?.id) throw err("The Instagram connection is no longer valid", 409, NO_CONNECTION);
  const base = `https://graph.instagram.com/v25.0/${meJson.id}`;
  const container = await f(`${base}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url, caption: composeMessage(row), access_token: conn.accessToken }),
  });
  const containerJson = container.ok ? await container.json().catch(() => null) : null;
  if (!container.ok || !containerJson?.id) {
    throw err(`Instagram media-container error ${container.status}`, 502, "INSTAGRAM_API_ERROR");
  }
  const published = await f(`${base}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: containerJson.id, access_token: conn.accessToken }),
  });
  const publishedJson = published.ok ? await published.json().catch(() => null) : null;
  if (!published.ok || !publishedJson?.id) {
    throw err(`Instagram media-publish error ${published.status}`, 502, "INSTAGRAM_API_ERROR");
  }
  return publishedJson.id;
}

// --- X (the metered shared connector's proxy; text-only) ---------------------------------------
// The X connector is METERED: getConnection is REFUSED — no token is ever available, so every
// call rides the platform's proxy (callApi), which injects the credential server-side. The
// documented extent here is the text post POST /2/tweets { text } → { data: { id } } — the
// connector does NOT support media upload, so a row carrying image_url refuses BEFORE any
// call. A publishing refusal (missing tweet.write or a dead connection) surfaces as the
// provider's own 401/403, mapped to NO_CONNECTION so the row converges to the documented
// needs_reconnect. UNKNOWN (never invented): threads, reply/quote targeting, media,
// long-form — the row is published exactly as composed. `opts.callApi` is the certification's
// deterministic network seam (production never passes one — the platform proxy runs).
const X_CONNECTOR = "x";
export async function publishX(svc, row, { callApi = null } = {}) {
  const image_url = String(row.image_url || "").trim();
  if (image_url) {
    throw err("X publishing is text-only here: the X connector does not support media upload — a post with an image refuses before any call", 409, "X_IMAGE_UNSUPPORTED");
  }
  const call = callApi || ((method, path, body) => svc.connectors.callApi(X_CONNECTOR, { method, path, body }));
  let res = null;
  try {
    res = await call("POST", "/2/tweets", { text: composeMessage(row) });
  } catch {
    throw err("No usable X connection (the metered connector's proxy call failed)", 409, NO_CONNECTION);
  }
  const status = Number(res?.status ?? res?.status_code ?? 0);
  if (!res?.success || status >= 400) {
    if (status === 401 || status === 403) throw err("The X connection cannot publish (tweet.write missing or the connection is no longer valid)", 409, NO_CONNECTION);
    throw err(`X API error ${status || "unknown"}`, 502, "X_API_ERROR");
  }
  return res?.data?.data?.id || null;
}

// TikTok's shared read/list connector remains unchanged. Only explicitly authorized,
// project-owned TikTok OAuth credentials can reach the isolated Content Posting adapter.
export async function publishTikTok(svc, row, options = {}) {
  if (row?.tiktok_credential_id) return publishOwnTikTok(svc, row, options);
  throw err("TikTok organic publishing is unavailable: the TikTok connector supports profile reads only (Content Posting API and video upload are not supported)", 501, "TIKTOK_PUBLISH_UNAVAILABLE");
}

export const PUBLISHERS = {
  linkedin: publishLinkedIn,
  facebook: publishFacebook,
  instagram: publishInstagram,
  x: publishX,
  tiktok: publishTikTok,
};