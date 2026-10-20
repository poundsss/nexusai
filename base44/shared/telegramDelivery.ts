// Telegram reply-delivery recovery. The agent reply itself is saved and replayed by the keyed
// executor (idempotency_key = telegram:<update_id>); this module makes the SEND at-most-once per
// successful delivery and retryable after a failed one.
//   • a durable send claim (tg_sent:<project>:<update_id>) is taken BEFORE sendMessage, so a
//     duplicate update after a successful send never sends again;
//   • a failed send releases the send claim AND the update claim (tg_replay:…), so the next
//     delivery of the same update reaches the keyed replay and retries the SAVED reply — the
//     agent never reruns and nothing is charged again.
// UNKNOWN: atomicity of the claim depends on production database read consistency, and a send
// whose outcome is lost (Telegram accepted it but the response failed) may be retried once.
const SENT_TTL_MS = 24 * 60 * 60 * 1000;

async function release(svc, cacheKey) {
  const rows = await svc.entities.CacheEntry.filter({ cache_key: cacheKey }, "created_date", 5).catch(() => []);
  for (const r of rows) await svc.entities.CacheEntry.delete(r.id).catch(() => {});
}

// R-6: the inbound replay claim is taken BEFORE the agent turn. A turn that fails RETRYABLY
// (5xx, 429, or an in-progress 409 — e.g. a tool result that could not be saved) releases the
// claim and rethrows, so the provider's redelivery reaches the keyed executor: completed tool
// steps replay from their durable claims (never re-run), and the saved reply replays if it
// exists. A deterministic 4xx keeps the claim (a redelivery would fail identically).
export const isRetryableTurnFailure = (e) => {
  const s = Number(e?.status) || 500;
  return s >= 500 || s === 429 || (s === 409 && /IN_PROGRESS/.test(String(e?.code || "")));
};
export async function runTurnReleasingReplay(svc, replayKey, runTurn) {
  try { return await runTurn(); } catch (e) {
    if (isRetryableTurnFailure(e)) await release(svc, replayKey);
    throw e;
  }
}

export async function deliverTelegramReplyOnce(svc, { projectId, updateId, claim, send }) {
  return deliverReplyOnce(svc, {
    sentKey: `tg_sent:${projectId}:${updateId}`, replayKey: `tg_replay:${projectId}:${updateId}`,
    namespace: "telegram_sent", claim, send,
  });
}

// Channel-generic form (Telegram, Slack, WhatsApp): send claim before the provider call; a failed
// send releases the send claim and the inbound replay claim so a redelivery retries the SAVED reply.
export async function deliverReplyOnce(svc, { sentKey, replayKey, namespace, claim, send }) {
  if (!(await claim(svc, sentKey, Date.now(), { namespace, ttlMs: SENT_TTL_MS }))) {
    return { ok: true, already_sent: true };
  }
  const sent = await send();
  if (!sent.ok) {
    await release(svc, sentKey);
    await release(svc, replayKey);
  }
  return sent;
}