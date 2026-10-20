// P-9.13G — WhatsApp GROUP support: an extension of the certified P-9.10C channel ONLY.
//
// Evidence (official Meta Groups API + Base44's own documentation), never assumptions:
//   • VERIFIED (developers.facebook.com, Group messaging): a group message webhook carries
//     `messages[].group_id` while `from` stays the PARTICIPANT; group sends ride the SAME
//     messages endpoint with recipient_type "group" and the SAME documented relay rate.
//   • VERIFIED (docs.base44.com, changelog July 2026): in-app agents can create and manage
//     WhatsApp groups. The invite link arrives ASYNCHRONOUSLY in the provider's
//     group_lifecycle_update webhook and is delivered here to the requester as a DM.
//   • Eligibility is the PROVIDER's gate; its errors are surfaced scrubbed, never retried.
//
// Durability (R-2 family): every read fails closed (503, provider redelivers); a lifecycle
// event is claimed once per group; the invite is matched to the pending request of THAT group
// only (never "the latest create"), sent at most once per successful send with a stable relay
// charge key, and a failed send stays retryable by redelivery. UNKNOWN: atomicity under
// concurrent redelivery depends on database read consistency (no unique constraint).
import { fail, limit, recordAuthEvent } from "./appAuth.ts";
import { scrub, scrubText } from "./tracing.ts";
import { chargeWorkspace } from "./integrationCharges.ts";
import { deliverReplyOnce } from "./telegramDelivery.ts";
import {
  whatsappHttp, requireWhatsAppSecret, sendWithRelayCharge, claimDeliveryOnce, GRAPH_API_VERSION,
  WHATSAPP_TOKEN_SECRET, WHATSAPP_PHONE_NUMBER_ID_SECRET, WHATSAPP_OUTBOUND_MAX_CHARS,
} from "./appAgentChannels.ts";

export const WHATSAPP_GROUP_SUBJECT_MAX_CHARS = 128;   // the provider's own subject cap
export const WHATSAPP_GROUP_DESCRIPTION_MAX_CHARS = 2048;
export const WHATSAPP_GROUP_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const pendingKey = (projectId, groupId) => `wa_group_pending:${projectId}:${groupId}`;
const unavailable = () => fail(503, "WHATSAPP_GROUP_READ_UNAVAILABLE", "The WhatsApp group state could not be read; retry later.");

async function whatsappGraphPost(http, token, path, body) {
  let res;
  try {
    res = await http(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).split(token).join("[redacted]") };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) return { ok: false, error: scrubText(String(data?.error?.message || res.statusText || "WhatsApp API error"), 200).split(token).join("[redacted]") };
  return { ok: true, result: data };
}

/** Creates a WhatsApp group; the invite link is delivered later by the lifecycle webhook. */
export async function whatsappCreateGroup(svc, { project, payload, user, agentName, resolveSecret, http = whatsappHttp, subject, description, meta = {} }) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);
  await limit(svc, project, "channel_activation", `user:${user.id}`);
  const waToken = await requireWhatsAppSecret(resolveSecret, WHATSAPP_TOKEN_SECRET);
  const phoneNumberId = await requireWhatsAppSecret(resolveSecret, WHATSAPP_PHONE_NUMBER_ID_SECRET);
  const name = scrubText(String(subject || ""), WHATSAPP_GROUP_SUBJECT_MAX_CHARS).trim();
  if (!name) fail(400, "WHATSAPP_GROUP_SUBJECT_REQUIRED", "A WhatsApp group needs a subject");
  const desc = scrubText(String(description || ""), WHATSAPP_GROUP_DESCRIPTION_MAX_CHARS);
  const created = await whatsappGraphPost(http, waToken, `${encodeURIComponent(phoneNumberId)}/groups`, {
    messaging_product: "whatsapp", subject: name, ...(desc ? { description: desc } : {}),
  });
  if (!created.ok) fail(502, "WHATSAPP_GROUP_UNAVAILABLE", `The WhatsApp group could not be created: ${created.error}`);
  const groupId = String(created.result?.id || "");
  // Without the provider's group id the invite could never be matched to this request safely.
  if (!groupId) fail(502, "WHATSAPP_GROUP_UNAVAILABLE", "The WhatsApp group was created without an id");
  const now = Date.now();
  await svc.entities.CacheEntry.create({
    namespace: "whatsapp_group_pending", cache_key: pendingKey(project.id, groupId),
    value: scrub({ app_user_id: user.id, agent: agent.name, group_id: groupId, requested_at: new Date(now).toISOString() }),
    expires_at: new Date(now + WHATSAPP_GROUP_PENDING_TTL_MS).toISOString(),
    stale_at: new Date(now + WHATSAPP_GROUP_PENDING_TTL_MS).toISOString(),
    size_bytes: 128, version: 1,
  });
  await recordAuthEvent(svc, project, {
    action: "whatsapp_group_create_requested", resource: "Project", resource_id: project.id,
    metadata: { channel: "whatsapp", agent: agent.name, app_user_id: user.id, group_id: groupId }, meta,
  });
  return {
    channel: "whatsapp", agent: agent.name, op: "group_create", subject: name,
    group_id: groupId, invite_link: "pending",
    note: "The invite link arrives through the provider's group_lifecycle_update webhook and is delivered to your WhatsApp chat.",
  };
}

/** The provider's group_lifecycle_update webhook: delivers the invite link to the requester once. */
export async function handleWhatsAppGroupLifecycle(svc, { project, payload, agentName, resolveSecret, value, http = whatsappHttp, meta = {} }) {
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) return { ok: true, ignored: true };
  const raw = scrubText(JSON.stringify(value ?? ""), 4000);
  const groupId = (raw.match(/"group_id"\s*:\s*"([^"]{1,256})"/) || [])[1] || "";
  const inviteLink = (raw.match(/"invite_link"\s*:\s*"(https:\/\/chat\.whatsapp\.com\/[^"]{1,512})"/) || [])[1] || "";
  if (!groupId || !inviteLink) return { ok: true, ignored: true };

  const pendingRows = await svc.entities.CacheEntry.filter({ cache_key: pendingKey(project.id, groupId) }, "-created_date", 5).catch(unavailable);
  const pending = pendingRows.find((r) => new Date(r.expires_at).getTime() > Date.now()
    && String(r.value?.group_id || "") === groupId && String(r.value?.app_user_id || "") && r.value?.agent === agent.name);
  if (!pending) return { ok: true, ignored: true };

  const claimKey = `wa_group_invite:${project.id}:${groupId}`;
  const claimed = await claimDeliveryOnce(svc, claimKey, Date.now(), { namespace: "whatsapp_group_invite" }).catch(unavailable);
  if (!claimed) return { ok: true, duplicate: true };

  const requesterId = String(pending.value.app_user_id);
  const identityRows = await svc.entities.AppIdentity.filter(
    { project_id: project.id, app_user_id: requesterId, provider: "whatsapp", status: "linked" }, "-created_date", 5,
  ).catch(unavailable);
  const identity = identityRows[0];
  if (!identity) return { ok: true, ignored: true, reason: "requester_not_linked" };
  const waToken = await requireWhatsAppSecret(resolveSecret, WHATSAPP_TOKEN_SECRET);
  const phoneNumberId = await requireWhatsAppSecret(resolveSecret, WHATSAPP_PHONE_NUMBER_ID_SECRET);
  const workspace_id = await chargeWorkspace(svc, project.id);
  const text = scrubText(`Your WhatsApp group is ready. Invite link: ${inviteLink}`, WHATSAPP_OUTBOUND_MAX_CHARS);
  const sent = await deliverReplyOnce(svc, {
    sentKey: `wa_group_sent:${project.id}:${groupId}`, replayKey: claimKey, namespace: "whatsapp_group_sent", claim: claimDeliveryOnce,
    send: () => sendWithRelayCharge(svc, { workspace_id, project, http, token: waToken, phoneNumberId, to: identity.provider_subject, text, chargeKey: `group_invite:${groupId}` }),
  });
  if (sent.already_sent) return { ok: true, duplicate: true };
  if (sent.ok) await svc.entities.CacheEntry.delete(pending.id).catch(() => {}); // best-effort; TTL bounds it
  await recordAuthEvent(svc, project, {
    action: "whatsapp_group_invite_delivered", resource: "Project", resource_id: project.id,
    metadata: { channel: "whatsapp", agent: agent.name, app_user_id: requesterId, group_id: groupId, delivered: !!sent.ok }, meta,
  });
  return { ok: true, group_id: groupId, invite_delivered: !!sent.ok, delivery_error: sent.ok ? null : sent.error };
}