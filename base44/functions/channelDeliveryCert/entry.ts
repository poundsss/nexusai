// In-memory regression for channel-generic reply delivery (Slack/WhatsApp/Telegram). No database.
import { deliverReplyOnce, runTurnReleasingReplay } from "../../shared/telegramDelivery.ts";
import { claimDeliveryOnce } from "../../shared/appAgentChannels.ts";

function store() {
  const rows = []; let seq = 0;
  const CacheEntry = {
    filter: async (q) => rows.filter((r) => r.cache_key === q.cache_key),
    create: async (d) => { const r = { ...d, id: `c${++seq}`, created_date: String(seq).padStart(6, "0") }; rows.push(r); return r; },
    delete: async (id) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); },
  };
  return { svc: { entities: { CacheEntry } }, rows };
}

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail ?? "") });
  for (const ch of ["slack", "whatsapp", "line"]) {
    const { svc, rows } = store();
    const keys = { sentKey: `${ch}_sent:p:m1`, replayKey: `${ch}_replay:p:m1`, namespace: `${ch}_sent`, claim: claimDeliveryOnce };
    await claimDeliveryOnce(svc, keys.replayKey);
    let sends = 0;
    const f = await deliverReplyOnce(svc, { ...keys, send: async () => { sends++; return { ok: false, error: "down" }; } });
    add(`${ch}: failed send releases send + replay claims`, !f.ok && rows.length === 0, { f, rows: rows.length });
    const s = await deliverReplyOnce(svc, { ...keys, send: async () => { sends++; return { ok: true }; } });
    add(`${ch}: retry after failure sends once`, s.ok && sends === 2, { sends });
    const d = await deliverReplyOnce(svc, { ...keys, send: async () => { sends++; return { ok: true }; } });
    add(`${ch}: after success a duplicate never sends again`, d.already_sent === true && sends === 2, { sends });
  }
  // R-6: an agent turn that fails retryably releases the inbound replay claim (all four channels).
  for (const ch of ["tg", "wa", "line", "slack"]) {
    const { svc, rows } = store();
    const replayKey = `${ch}_replay:p:m2`;
    await claimDeliveryOnce(svc, replayKey);
    const boom = (status, code) => async () => { throw Object.assign(new Error(code), { status, code }); };
    const r503 = await runTurnReleasingReplay(svc, replayKey, boom(503, "AGENT_TOOL_RESULT_UNSAVED")).catch((e) => e.code);
    add(`${ch}: a retryable turn failure (503) rethrows and releases the replay claim`, r503 === "AGENT_TOOL_RESULT_UNSAVED" && rows.length === 0, { rows: rows.length });
    const again = await claimDeliveryOnce(svc, replayKey);
    add(`${ch}: the redelivery is then admitted (reaches the keyed replay)`, again === true, { again });
    const r409 = await runTurnReleasingReplay(svc, replayKey, boom(409, "AGENT_TOOL_STEP_IN_PROGRESS")).catch((e) => e.code);
    add(`${ch}: an in-progress 409 also releases (retry later)`, r409 === "AGENT_TOOL_STEP_IN_PROGRESS" && rows.length === 0, { rows: rows.length });
    await claimDeliveryOnce(svc, replayKey);
    const r413 = await runTurnReleasingReplay(svc, replayKey, boom(413, "AGENT_MESSAGE_TOO_LONG")).catch((e) => e.code);
    add(`${ch}: a deterministic 4xx keeps the claim (no endless redelivery)`, r413 === "AGENT_MESSAGE_TOO_LONG" && rows.length === 1, { rows: rows.length });
    const ok = await runTurnReleasingReplay(svc, replayKey, async () => ({ reply: "x" }));
    add(`${ch}: a successful turn passes through and keeps the claim`, ok.reply === "x" && rows.length === 1, { rows: rows.length });
  }
  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});