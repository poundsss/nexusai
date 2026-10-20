// In-memory regression for R-2e: anonymous channel identity creation fails closed on claim-read
// failure and concurrent first messages produce one identity. No database, no provider calls.
import { ensureAnonymousChannelIdentity } from "../../shared/appAgentChannels.ts";

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
    list: async () => tables[name] || [],
    create: async (d) => { const r = { ...d, id: `${name}${++seq}`, created_date: new Date(Date.now() + seq).toISOString() }; (tables[name] ||= []).push(r); return r; },
    update: async (id, d) => { const r = (tables[name] || []).find((x) => x.id === id); Object.assign(r || {}, d); return r; },
    get: async (id) => (tables[name] || []).find((x) => x.id === id) || null,
    delete: async () => ({}),
  });
  return { svc: { entities: new Proxy({}, { get: (_, n) => table(String(n)) }) }, tables };
}

const project = { id: "p-anon", workspace_id: "w-anon" };
const agent = { name: "a", allow_anonymous_access: true };
const run = (s) => ensureAnonymousChannelIdentity(s.svc, { project, provider: "telegram", subject: "chat-1", agent });
const outcome = async (p) => { try { return { v: await p }; } catch (e) { return { code: e?.code || e?.body?.code || String(e?.message || e), status: e?.status }; } };
const count = (s, n) => (s.tables[n] || []).length;
const identities = (s) => (s.tables.AppIdentity || []).filter((r) => r.provider_subject === "chat-1").length;

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail).slice(0, 240) });

  const s0 = stub();
  const ok = await outcome(run(s0));
  const again = await outcome(run(s0));
  add("success path creates one anonymous user + identity", ok.v?.created === true && identities(s0) === 1 && count(s0, "AppUser") === 1, ok);
  add("repeat resolves the existing identity", again.v?.created === false && identities(s0) === 1, again);

  const s1 = stub({ failCacheRead: 1 });
  const r1 = await outcome(run(s1));
  add("first-read failure: retryable 503, no claim/user/identity", r1.status === 503 && count(s1, "CacheEntry") === 0 && count(s1, "AppUser") === 0 && identities(s1) === 0, r1);

  const s2 = stub({ failCacheRead: 2 });
  const r2 = await outcome(run(s2));
  add("winner re-read failure: retryable 503, no user/identity", r2.status === 503 && count(s2, "AppUser") === 0 && identities(s2) === 0, r2);

  const s3 = stub();
  const race = await Promise.all([outcome(run(s3)), outcome(run(s3))]);
  add("two concurrent first messages: exactly one identity and one user",
    identities(s3) === 1 && count(s3, "AppUser") === 1 && race.filter((o) => o.v?.created).length === 1 && race.every((o) => o.v || o.status === 503), race);

  const s4 = stub();
  await s4.svc.entities.CacheEntry.create({ namespace: "anon_channel", cache_key: "anon_channel:p-anon:telegram:chat-1", value: { claimed: true }, expires_at: new Date(Date.now() - 1000).toISOString() });
  const r4 = await outcome(run(s4));
  add("expired leftover claim does not block a later retry", r4.v?.created === true && identities(s4) === 1, r4);

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});