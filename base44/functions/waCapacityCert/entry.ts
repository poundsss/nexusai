// In-memory regression for R-6: WhatsApp connected-agent capacity. No database, no provider calls.
// Race coverage here is IN-MEMORY interleaving only; it is not a database atomicity guarantee.
import { assertWhatsAppAgentCapacity, connectedWhatsAppAgents, WHATSAPP_MAX_CONNECTED_AGENTS } from "../../shared/whatsappCapacity.ts";

export const config = { method: "POST" };

function stub({ projects = 1, identities = [], failOn = null } = {}) {
  const P = Array.from({ length: projects }, (_, i) => ({ id: `p${i}`, workspace_id: "w1", created_date: String(i).padStart(6, "0") }));
  const I = identities.map((x, i) => ({ id: `i${i}`, provider: "whatsapp", status: "linked", created_date: String(i).padStart(6, "0"), ...x }));
  const C = [];
  let seq = 0;
  const page = (rows, limit, skip = 0) => rows.slice(skip, skip + limit);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const svc = { entities: {
    Project: { filter: async (q, s, limit, skip) => { if (failOn === "project") throw new Error("x"); return page(P.filter((p) => p.workspace_id === q.workspace_id), limit, skip); } },
    AppIdentity: { filter: async (q, s, limit, skip) => { if (failOn === "identity") throw new Error("x"); return page(I.filter((r) => q.project_id.$in.includes(r.project_id)), limit, skip); } },
    CacheEntry: {
      filter: async (q) => { await tick(); if (failOn === "claim") throw new Error("x"); return C.filter((r) => r.cache_key === q.cache_key).sort((a, b) => a.created_date.localeCompare(b.created_date)); },
      create: async (d) => { await tick(); const r = { ...d, id: `c${++seq}`, created_date: String(seq).padStart(6, "0") }; C.push(r); return r; },
    },
  } };
  return { svc, I, C };
}
const outcome = async (p) => { try { await p; return { ok: true }; } catch (e) { return { code: e?.code, status: e?.status }; } };
const proj = (id) => ({ id, workspace_id: "w1" });
const ids = (n, pid = "p0") => Array.from({ length: n }, (_, i) => ({ project_id: pid, profile: { agent: `a${i}` } }));

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail).slice(0, 240) });

  for (const failOn of ["project", "identity"]) {
    const r = await outcome(assertWhatsAppAgentCapacity(stub({ failOn }).svc, proj("p0"), "new"));
    add(`${failOn} read failure: 503 WHATSAPP_CAPACITY_UNAVAILABLE`, r.status === 503 && r.code === "WHATSAPP_CAPACITY_UNAVAILABLE", r);
  }
  const rc = await outcome(assertWhatsAppAgentCapacity(stub({ failOn: "claim", identities: ids(WHATSAPP_MAX_CONNECTED_AGENTS - 1) }).svc, proj("p0"), "new"));
  add("final-slot claim read failure: 503", rc.status === 503 && rc.code === "WHATSAPP_CAPACITY_UNAVAILABLE", rc);

  // >500 identities (duplicates of 3 pairs) spread over >200 projects: all pages are read.
  const many = stub({ projects: 450, identities: [...Array.from({ length: 600 }, () => ({ project_id: "p0", profile: { agent: "a0" } })), { project_id: "p420", profile: { agent: "late" } }] });
  const pairs = await connectedWhatsAppAgents(many.svc, "w1");
  add("pages through >200 projects and >500 identities", pairs.has("p420:late") && pairs.size === 2, [...pairs]);

  const full = stub({ identities: ids(WHATSAPP_MAX_CONNECTED_AGENTS) });
  const rf = await outcome(assertWhatsAppAgentCapacity(full.svc, proj("p0"), "new"));
  add("full workspace refuses a new agent (409)", rf.status === 409 && rf.code === "WHATSAPP_AGENT_LIMIT", rf);
  const rr = await outcome(assertWhatsAppAgentCapacity(full.svc, proj("p0"), "a1"));
  add("reconnecting an already-connected agent at capacity is allowed", rr.ok, rr);

  const free = stub({ identities: ids(WHATSAPP_MAX_CONNECTED_AGENTS - 2) });
  const rn = await outcome(assertWhatsAppAgentCapacity(free.svc, proj("p0"), "new"));
  add("non-final slot: allowed without a claim", rn.ok && free.C.length === 0, { rn, claims: free.C.length });

  const race = stub({ identities: ids(WHATSAPP_MAX_CONNECTED_AGENTS - 1) });
  const [x, y] = await Promise.all([
    outcome(assertWhatsAppAgentCapacity(race.svc, proj("p0"), "newX")),
    outcome(assertWhatsAppAgentCapacity(race.svc, proj("p0"), "newY")),
  ]);
  add("two racers for the final slot: exactly one admitted (in-memory interleaving)",
    [x, y].filter((r) => r.ok).length === 1 && [x, y].some((r) => r.code === "WHATSAPP_AGENT_LIMIT"), { x, y });
  const winner = x.ok ? "newX" : "newY";
  const again = await outcome(assertWhatsAppAgentCapacity(race.svc, proj("p0"), winner));
  add("the claim winner retrying (activation after code issue) is still admitted", again.ok, again);

  // Winner re-check: a slot filled by someone else between claim and re-read is refused.
  const late = stub({ identities: ids(WHATSAPP_MAX_CONNECTED_AGENTS - 1) });
  const origCreate = late.svc.entities.CacheEntry.create;
  late.svc.entities.CacheEntry.create = async (d) => { late.I.push({ id: "iz", project_id: "p0", provider: "whatsapp", status: "linked", created_date: "999999", profile: { agent: "other" } }); return origCreate(d); };
  const rl = await outcome(assertWhatsAppAgentCapacity(late.svc, proj("p0"), "new"));
  add("claim winner re-checks capacity and refuses when the slot filled meanwhile", rl.code === "WHATSAPP_AGENT_LIMIT", rl);

  const issue = stub({ identities: ids(WHATSAPP_MAX_CONNECTED_AGENTS - 1) });
  const ri = await outcome(assertWhatsAppAgentCapacity(issue.svc, proj("p0"), "pending", { reserve: false }));
  const rb = await outcome(assertWhatsAppAgentCapacity(issue.svc, proj("p0"), "binder"));
  add("link issuance never reserves the final slot; a later binding still gets it", ri.ok && rb.ok && issue.C.length === 1, { ri, rb, claims: issue.C.length });

  const expired = stub({ identities: ids(WHATSAPP_MAX_CONNECTED_AGENTS - 1) });
  expired.C.push({ id: "old", cache_key: "whatsapp_capacity:w1", value: { pair: "p0:ghost" }, expires_at: new Date(Date.now() - 1000).toISOString(), created_date: "000000" });
  const re = await outcome(assertWhatsAppAgentCapacity(expired.svc, proj("p0"), "new"));
  add("an expired claim does not block the final slot", re.ok, re);

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});