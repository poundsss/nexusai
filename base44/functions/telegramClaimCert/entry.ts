// In-memory regression for the Telegram duplicate-delivery claim (R-2c). No database, no paid calls.
// The test agent rejects unlinked chats, so a delivery that PASSES the claim ends at CHANNEL_NOT_LINKED
// (before the agent executor); a duplicate returns { duplicate: true } and never gets that far.
import { handleTelegramUpdate } from "../../shared/appAgentChannels.ts";

export const config = { method: "POST" };

function stub({ failCacheRead = 0 } = {}) {
  const tables = {};
  let cacheReads = 0, seq = 0;
  const table = (name) => ({
    filter: async (q = {}) => {
      if (name === "CacheEntry" && ++cacheReads === failCacheRead) throw new Error("simulated read failure");
      return (tables[name] || []).filter((r) => Object.entries(q).every(([k, v]) => typeof v !== "object" || v === null ? r[k] === v : true))
        .sort((a, b) => a.created_date.localeCompare(b.created_date));
    },
    create: async (d) => { const r = { ...d, id: `${name}${++seq}`, created_date: new Date(Date.now() + seq).toISOString() }; (tables[name] ||= []).push(r); return r; },
    update: async (id, d) => { const r = (tables[name] || []).find((x) => x.id === id); Object.assign(r || {}, d); return r; },
    get: async (id) => (tables[name] || []).find((x) => x.id === id) || null,
    delete: async () => ({}),
  });
  const entities = new Proxy({}, { get: (_, n) => table(String(n)) });
  return { svc: { entities }, tables };
}

const SECRET = "tg-claim-cert-secret";
const project = { id: "p-tg", workspace_id: "w-tg" };
const payload = { agents: [{ name: "a", allow_anonymous_access: false }] };
const resolveSecret = async (n) => (n === "TELEGRAM_BOT_TOKEN" ? "bot-token" : SECRET);
const http = async () => { throw new Error("no provider call expected"); };
const deliver = (s, update_id) => handleTelegramUpdate(s.svc, {
  project, payload, agentName: "a", secretTokenHeader: SECRET, resolveSecret, http,
  update: { update_id, message: { chat: { id: 42 }, text: "hello" } },
});
const outcome = async (p) => { try { return { v: await p }; } catch (e) { return { code: e?.code || e?.body?.code || String(e?.message || e), status: e?.status }; } };
const claims = (s) => (s.tables.CacheEntry || []).filter((r) => r.namespace === "telegram_replay").length;
const passed = (o) => /CHANNEL_NOT_LINKED|not linked/.test(String(o.code));

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail).slice(0, 240) });

  const s1 = stub();
  const first = await outcome(deliver(s1, 1001));
  const replay = await outcome(deliver(s1, 1001));
  add("first delivery passes the claim (reaches owner resolution)", passed(first) && claims(s1) === 1, first);
  add("replay is a duplicate and never reaches the agent", replay.v?.duplicate === true, replay);

  const s2 = stub();
  const race = await Promise.all([outcome(deliver(s2, 2002)), outcome(deliver(s2, 2002))]);
  add("two concurrent deliveries: exactly one winner", race.filter(passed).length === 1 && race.filter((o) => o.v?.duplicate).length === 1, race);

  const s3 = stub({ failCacheRead: 1 });
  const r3 = await outcome(deliver(s3, 3003));
  add("initial-read failure is a retryable 503 and claims nothing", r3.status === 503 && claims(s3) === 0, r3);

  const s4 = stub({ failCacheRead: 2 });
  const r4 = await outcome(deliver(s4, 4004));
  add("winner re-read failure is a retryable 503 (never a won claim)", r4.status === 503 && !passed(r4), r4);

  // Malformed update_id: refused with 400 before any claim (and so before agent or charge).
  for (const [label, bad] of [["missing", undefined], ["string", "5005"], ["zero", 0], ["negative", -7], ["fractional", 1.5], ["object", { id: 1 }]]) {
    const s = stub();
    const o = await outcome(deliver(s, bad));
    // Only the (already-passed) rate limiter may have written; nothing after it may.
    const writes = Object.entries(s.tables).filter(([n]) => !/RateLimit/.test(n)).reduce((n, [, rows]) => n + rows.length, 0);
    add(`${label} update_id is refused 400 before any claim`, o.status === 400 && o.code === "TELEGRAM_UPDATE_INVALID" && claims(s) === 0 && writes === 0, { o, writes });
  }

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});