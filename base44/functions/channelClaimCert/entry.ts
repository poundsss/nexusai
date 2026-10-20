// In-memory regression for claimDeliveryOnce (R-2a). No database, no paid calls.
import { claimDeliveryOnce } from "../../shared/appAgentChannels.ts";

export const config = { method: "POST" };

function stub(seed = [], { failRead = 0 } = {}) {
  const rows = [...seed];
  let reads = 0, seq = 0;
  const CacheEntry = {
    filter: async (q) => {
      reads++;
      if (reads === failRead) throw new Error("simulated read failure");
      return rows.filter((r) => r.cache_key === q.cache_key).sort((a, b) => a.created_date.localeCompare(b.created_date));
    },
    create: async (d) => {
      const r = { ...d, id: `c${++seq}`, created_date: new Date(Date.now() + seq).toISOString() };
      rows.push(r);
      return r;
    },
  };
  return { entities: { CacheEntry }, rows };
}
const NOW = Date.now();

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) });
  const attempt = async (fn) => { try { return { v: await fn() }; } catch (e) { return { err: String(e.message) }; } };

  const fresh = stub();
  const first = await claimDeliveryOnce(fresh, "k", NOW);
  const replay = await claimDeliveryOnce(fresh, "k", NOW);
  add("first claim wins, replay is a duplicate", first === true && replay === false, `${first}/${replay}`);

  const r1 = stub([], { failRead: 1 });
  const a = await attempt(() => claimDeliveryOnce(r1, "k", NOW));
  add("first-read failure throws and writes nothing", a.err && r1.rows.length === 0, JSON.stringify(a));

  const r2 = stub([], { failRead: 2 });
  const b = await attempt(() => claimDeliveryOnce(r2, "k", NOW));
  add("re-read failure throws (never a won claim)", b.err && b.v === undefined, JSON.stringify(b));

  const race = stub();
  const out = await Promise.all([claimDeliveryOnce(race, "k", NOW), claimDeliveryOnce(race, "k", NOW)]);
  add("two concurrent claims: exactly one winner", out.filter(Boolean).length === 1, JSON.stringify(out));

  const expired = stub([{ id: "old", cache_key: "k", created_date: "2000-01-01T00:00:00.000Z", expires_at: new Date(NOW - 1000).toISOString() }]);
  const c = await claimDeliveryOnce(expired, "k", NOW);
  add("expired claim does not block a new claim", c === true, c);

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});