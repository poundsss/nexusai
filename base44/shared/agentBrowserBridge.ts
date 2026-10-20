// P-9.13B — the browser-extension bridge: the smallest NexusAI-native browser bridge.
//
// Evidence, never assumptions:
//   • VERIFIED (docs.base44.com, Browsing with your Superagent): the browser extension is
//     Base44's OWN platform artifact ("Superagent by Base44", Chrome Web Store) — platform
//     infrastructure a workspace cannot publish, exactly like the documented Slack app. What
//     the DOCUMENTED capability consists of: work directly in Chrome; browse sites and fill
//     in forms; "authenticated Agent authorization only"; and "If the extension is not
//     connected, your Superagent browses from chat instead" (chat browsing is the EXISTING
//     web_search tool, unchanged here). Base44 publishes NO extension↔backend transport
//     contract (UNKNOWN) — none is claimed.
//   • The smallest NexusAI-native bridge therefore:
//       pairing — the SAME single-use channel-activation token contract as every certified
//                 channel (channel "browser_extension", dispatched from the certified
//                 handleAppChannelConnect and issued by the bridge's own pair action).
//       session — a hashed, expiring bridge session (AppAuthToken kind "browser_bridge_session",
//                 24h) bound server-side to (project, agent, app user), looked up by hash and
//                 never stored in plain text.
//       browse  — a bounded, SSRF-guarded, READ-ONLY https fetch + best-effort extraction
//                 (title, text, links, forms). The bridge never executes page scripts.
//       fill    — an LLM fill PLAN (values only) the extension applies to the live DOM itself.
//                 The bridge never returns executable code, and password / file / checkbox /
//                 radio / color / range fields are NEVER fillable — no unrestricted browser
//                 control, and the existing Agent permission model is untouched (no new tool
//                 is registered; the executor is not modified).
//   • Authorization fails closed at every step: pairing requires the signed-in app user and an
//     agent inside the deployment; activation consumes the token exactly once; every browse/
//     fill call carries a live session; a session is bound to its agent for the record and the
//     channel identity row uses the EXISTING AppIdentity contract.
import { fail, limit, issueToken, consumeToken, getAppUser, recordAuthEvent, nowIso } from "./appAuth.ts";
import { findIdentity } from "./appOAuth.ts";
import { scrub, scrubText } from "./tracing.ts";

export const BRIDGE_CHANNEL = "browser_extension";
export const BRIDGE_PAIRING_TTL_MS = 10 * 60 * 1000; // the SAME 10-minute activation TTL
export const BRIDGE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const BRIDGE_BROWSE_TIMEOUT_MS = 10000;
export const BRIDGE_BROWSE_MAX_BYTES = 262144;
export const BRIDGE_MAX_FILL_FIELDS = 30;
export const BRIDGE_FILL_VALUE_MAX_CHARS = 500;

// Fail-closed hostname guard (pattern-based; a DNS-level check is not available in this
// runtime — documented as a guard that may over-block, never under-block).
const PRIVATE_HOSTNAME_RE = /^(localhost$|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|.*\.local$|.*\.internal$)/i;
const BRIDGE_TOKEN_RE = /^[a-f0-9]{64}$/;
const FILLABLE_TYPES = new Set(["text", "email", "search", "tel", "url", "number", "textarea", "select", "date", "time"]);
const FILL_SCHEMA = {
  type: "object",
  properties: {
    fills: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, value: { type: "string" } },
        required: ["name", "value"],
        additionalProperties: false,
      },
    },
    notes: { type: "string" },
  },
  required: ["fills"],
  additionalProperties: false,
};

const sha256Hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s ?? ""))))].map((b) => b.toString(16).padStart(2, "0")).join("");

// --- pairing (the certified channel-activation contract) --------------------------------------

/**
 * Issues the extension's pairing token for the CURRENT signed-in app user: the SAME single-use
 * AppAuthToken (kind "channel_activation", hash-at-rest) as every certified channel, bound
 * server-side to (project, agent, app user). Its raw value appears exactly once — in this
 * response — and in no log, audit row or later response.
 */
export async function connectBrowserExtension(svc, { project, payload, user, agentName, meta = {} }) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);
  await limit(svc, project, "channel_activation", `user:${user.id}`);
  const { token, row } = await issueToken(svc, project, {
    user, kind: "channel_activation", ttl_ms: BRIDGE_PAIRING_TTL_MS,
    data: { channel: BRIDGE_CHANNEL, agent: agent.name },
  });
  await recordAuthEvent(svc, project, {
    action: "channel_activation_requested", resource: "AppAuthToken", resource_id: row.id,
    metadata: { channel: BRIDGE_CHANNEL, agent: agent.name, app_user_id: user.id, expires_in_ms: BRIDGE_PAIRING_TTL_MS }, meta,
  });
  return { channel: BRIDGE_CHANNEL, agent: agent.name, token, expires_in_ms: BRIDGE_PAIRING_TTL_MS };
}

// --- activation → bridge session ---------------------------------------------------------------

/**
 * Consumes the pairing token EXACTLY once and issues the hashed, expiring bridge session
 * bound to (project, agent, app user) on the EXISTING AppIdentity contract (provider
 * "browser_extension"). A wrong channel or agent is refused; a disabled account is refused.
 */
export async function activateBridgeSession(svc, project, { token, agentName = "" }) {
  const raw = String(token || "");
  if (!BRIDGE_TOKEN_RE.test(raw)) fail(400, "TOKEN_INVALID", "This pairing code is not valid");
  const used = await consumeToken(svc, project, { token: raw, kind: "channel_activation" });
  if (String(used.data?.channel || "") !== BRIDGE_CHANNEL) {
    fail(400, "CHANNEL_STATE_MISMATCH", "This activation does not belong to the browser extension");
  }
  const agent = String(used.data?.agent || "");
  if (agentName && agentName !== agent) {
    fail(409, "CHANNEL_AGENT_MISMATCH", "This activation was issued for a different agent");
  }
  if (!agent) fail(400, "CHANNEL_STATE_MISMATCH", "This activation carries no agent binding");
  const linkedUser = await getAppUser(svc, project, used.app_user_id);
  if (!linkedUser || linkedUser.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");
  const subject = `user:${used.app_user_id}`;
  const existing = await findIdentity(svc, project, BRIDGE_CHANNEL, subject);
  const profile = scrub({ agent });
  const identity = existing
    ? await svc.entities.AppIdentity.update(existing.id, { last_login_at: nowIso(), profile })
    : await svc.entities.AppIdentity.create({
        project_id: project.id, app_user_id: linkedUser.id, provider: BRIDGE_CHANNEL, provider_subject: subject,
        profile, status: "linked", linked_at: nowIso(), last_login_at: nowIso(),
      });
  const session = await issueToken(svc, project, {
    user: linkedUser, kind: "browser_bridge_session", ttl_ms: BRIDGE_SESSION_TTL_MS,
    data: { channel: BRIDGE_CHANNEL, agent },
  });
  await recordAuthEvent(svc, project, {
    action: "browser_bridge_activated", resource: "AppIdentity", resource_id: identity.id,
    metadata: { channel: BRIDGE_CHANNEL, agent, app_user_id: linkedUser.id, expires_in_ms: BRIDGE_SESSION_TTL_MS },
  });
  return { session_token: session.token, expires_in_ms: BRIDGE_SESSION_TTL_MS, agent, channel: BRIDGE_CHANNEL };
}

/**
 * Resolves a bridge session WITHOUT consuming it: the row must exist for this project, carry
 * kind "browser_bridge_session", still be pending and unexpired. Anything else → null, and the
 * caller refuses fail-closed.
 */
export async function resolveBridgeSession(svc, project, { sessionToken }) {
  const raw = String(sessionToken || "");
  if (!BRIDGE_TOKEN_RE.test(raw)) return null;
  const [row] = await svc.entities.AppAuthToken.filter(
    { project_id: project.id, kind: "browser_bridge_session", token_hash: await sha256Hex(raw) },
    "-created_date", 1,
  ).catch(() => []);
  if (!row || row.project_id !== project.id) return null;
  if (row.status !== "pending") return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
  return { app_user_id: String(row.app_user_id || ""), agent: String(row.data?.agent || "") };
}

// --- browse (bounded, SSRF-guarded, read-only) --------------------------------------------------

/** https-only, no credentials in the URL, no private/loopback/link-local/metadata host. */
export function assertBridgeUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch {
    fail(400, "BRIDGE_URL_REFUSED", "The bridge only fetches a valid https:// URL");
  }
  if (url.protocol !== "https:") fail(400, "BRIDGE_URL_REFUSED", "The bridge only fetches https:// URLs");
  if (PRIVATE_HOSTNAME_RE.test(url.hostname)) fail(400, "BRIDGE_URL_REFUSED", "This address is not fetchable through the bridge");
  if (url.username || url.password) fail(400, "BRIDGE_URL_REFUSED", "The bridge never fetches a URL carrying credentials");
  return url;
}

// Best-effort, bounded extraction — the extension reads the LIVE DOM itself for form filling;
// this surface only gives the agent something readable to reason about.
function extractPage(html) {
  const title = (html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i) || [])[1];
  const text = scrubText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim(),
    8000,
  );
  const links = [];
  const linkRe = /<a[^>]+href\s*=\s*"([^"#]{1,500})"/gi;
  let m;
  while ((m = linkRe.exec(html)) && links.length < 50) links.push(scrubText(m[1], 500));
  const forms = [];
  const formRe = /<form[^>]*>([\s\S]{0,20000}?)<\/form>/gi;
  while ((m = formRe.exec(html)) && forms.length < 10) {
    const fields = [];
    const fieldRe = /<(input|textarea|select)[^>]*>/gi;
    let f;
    while ((f = fieldRe.exec(m[1])) && fields.length < 30) {
      const tag = f[1];
      const attrs = f[0];
      const attr = (n) => (attrs.match(new RegExp(`${n}\\s*=\\s*"([^"]{0,300})"`, "i")) || [])[1] || "";
      const type = tag === "input" ? (attr("type").toLowerCase() || "text") : tag;
      fields.push(scrub({ name: attr("name"), type, label: attr("placeholder") }));
    }
    forms.push(scrub({ fields }));
  }
  return { title: title ? scrubText(title, 300) : null, text, links, forms };
}

/**
 * ONE bounded, read-only page fetch: https-only and host-guarded, a hard timeout, a hard size
 * cap, and HTML/plain-text only. Never executes anything from the page — extraction is
 * best-effort string work, and the result is scrubbed before it is returned.
 */
export async function bridgeBrowse({ url, fetchImpl = null }) {
  const target = assertBridgeUrl(url);
  const doFetch = fetchImpl || ((u, init) => fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_BROWSE_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(target.toString(), {
      redirect: "follow", signal: controller.signal,
      headers: { "user-agent": "NexusAI-AgentBridge/1.0", accept: "text/html,text/plain" },
    });
  } catch (e) {
    clearTimeout(timer);
    fail(502, "BRIDGE_BROWSE_FAILED", `The page could not be fetched: ${scrubText(String(e?.message || e), 200)}`);
  }
  clearTimeout(timer);
  if (!res.ok) fail(502, "BRIDGE_BROWSE_FAILED", `The page answered ${res.status}`);
  const contentType = String(res.headers?.get?.("content-type") || "");
  if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
    fail(415, "BRIDGE_BROWSE_UNSUPPORTED", `The bridge reads HTML and text pages only, received "${contentType.slice(0, 60)}"`);
  }
  let html = "";
  try { html = String(await res.text()).slice(0, BRIDGE_BROWSE_MAX_BYTES); } catch { html = ""; }
  if (!html) fail(502, "BRIDGE_BROWSE_EMPTY", "The page returned no readable content");
  return { url: target.toString().slice(0, 500), status: res.status, ...extractPage(html) };
}

// --- fill (an LLM plan the extension applies locally) --------------------------------------------

/**
 * Computes the fill PLAN for the fields the extension collected from the LIVE DOM. Values only,
 * never code; names outside the submitted set are dropped; sensitive field types were already
 * refused on the way in; the plan is bounded (≤30 fills, ≤500 chars per value). The extension's
 * content script applies the plan with element.value assignments only — no script injection.
 */
export async function buildFillPlan({ llm, intent, page_text, fields }) {
  if (!Array.isArray(fields) || !fields.length) fail(400, "BRIDGE_FILL_INVALID", "fill needs the form fields to fill");
  if (fields.length > BRIDGE_MAX_FILL_FIELDS) {
    fail(400, "BRIDGE_TOO_MANY_FIELDS", `fill accepts at most ${BRIDGE_MAX_FILL_FIELDS} fields`);
  }
  const fillable = fields
    .map((f, i) => ({
      name: String(f?.name || `field_${i}`),
      label: scrubText(String(f?.label || f?.placeholder || ""), 200),
      type: String(f?.type || "text").toLowerCase(),
    }))
    .filter((f) => FILLABLE_TYPES.has(f.type));
  if (!fillable.length) {
    fail(422, "BRIDGE_NOTHING_FILLABLE", "The form has no fillable fields — password, file and choice-locking fields are never filled");
  }
  const prompt =
    "You are filling a web form on the user's behalf. Given the intent and the page, propose a " +
    "value for each field by name. Use an empty string when you cannot confidently fill a field. " +
    "Never invent sensitive data such as passwords, payment details or identity numbers. " +
    `Intent: ${scrubText(String(intent || ""), 500)}. Page text: ${scrubText(String(page_text || ""), 3000)}. ` +
    `Fields (JSON): ${JSON.stringify(fillable.map(({ name, label }) => ({ name, label })))}`;
  let out = null;
  try {
    out = await llm({ prompt, response_json_schema: FILL_SCHEMA });
  } catch (e) {
    fail(502, "BRIDGE_FILL_UNAVAILABLE", `The fill plan could not be computed: ${scrubText(String(e?.message || e), 200)}`);
  }
  const allowed = new Map(fillable.map((f) => [f.name, f]));
  const fills = (Array.isArray(out?.fills) ? out.fills : [])
    .map((f) => ({ name: String(f?.name || ""), value: scrubText(String(f?.value ?? ""), BRIDGE_FILL_VALUE_MAX_CHARS) }))
    .filter((f) => allowed.has(f.name) && f.value);
  return { fills, notes: scrubText(String(out?.notes || ""), 300) };
}