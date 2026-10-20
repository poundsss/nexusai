// Focused certification for #31D — Per-Project Integration Call Quotas.
//
// Everything runs through the REAL production path (executeProjectFunction → createIntegrationsApi
// → executeExternalTool → breaker gate → quota consume → adapters → #31A observer), against
// throwaway projects. Only the network boundary is scripted, and every upstream hit is counted so
// "zero upstream attempts on refusal" is proven rather than assumed.
//
// Scope: the quota only. Adapter behaviour, OAuth2, the breaker and the rate-limit window are
// #31/#31A/#31B/#31C's tests; they are asserted here only where the quota must agree with them.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { normalizeIntegration } from "../../shared/integrations.ts";
import { clearOAuthCache } from "../../shared/externalTools.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { listIntegrationInvocations } from "../../shared/integrationObservability.ts";
import { listIntegrationQuotas, quotaConfig, quotaKeyOf, QUOTA_DEFAULTS } from "../../shared/integrationQuota.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";

const FN = (body) => `export const config = { method: 'POST' };\nexport default async function handler(ctx) {\n${body}\n}\n`;
const CALL = (integ, op, args = "{}") => FN(
  `  try { const r = await ctx.integrations.${integ}.${op}(${args}); return { status: 200, body: { ok: true, attempts: r.attempts } }; }\n` +
  `  catch (e) { const d = e.details || {}; return { status: 200, body: { ok: false, code: e.code, kind: d.kind, attempts: d.attempts, quota: d.quota, breaker: d.breaker, rate_limit: d.rate_limit } }; }`,
);

// The runtime's DNS-rebinding guard resolves hostnames for real and fails closed when a name
// cannot be resolved — the sandbox has no external DNS. A PUBLIC IP literal skips the DNS layer
// (assertResolvedUrl passes literals through after assertAllowedUrl), while the scripted fetch
// mock still intercepts every call by hostname before any packet is sent.
const HOST = "93.184.216.34";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const realFetch = globalThis.fetch;
  const TRACE = `t_q_${Date.now().toString(36)}`;
  let project = null, other = null, workspace = null;

  const hits = {};
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== HOST) return realFetch(url, options);
    const key = `${u.hostname}${u.pathname}`;
    hits[key] = (hits[key] || 0) + 1;
    if (u.pathname === "/v1/ok") return json({ state: "ok" });
    if (u.pathname === "/v1/flaky") return json({ error: "boom" }, 503);
    if (u.pathname === "/v1/down") return json({ error: "boom" }, 503);
    if (u.pathname === "/v1/limited") return json({ error: "slow down" }, 429, { "retry-after": "0" });
    return json({ error: "unexpected path" }, 500);
  };

  try {
    // ---- 0. configuration bounds & defaults (pure) ----
    const def = quotaConfig({});
    const tuned = quotaConfig({ quota: { limit: 50, window_ms: 60_000 } });
    const off = quotaConfig({ quota: { enabled: false } });
    const clamped = quotaConfig({ quota: { limit: 999_999, window_ms: 10 } });
    check("0a. defaults are bounded: limit 1000, window 1h", def.enabled === true && def.limit === QUOTA_DEFAULTS.limit && def.window_ms === QUOTA_DEFAULTS.window_ms, JSON.stringify(def));
    check("0b. a configured quota is preserved within bounds", tuned.limit === 50 && tuned.window_ms === 60_000, JSON.stringify(tuned));
    check("0c. enabled:false is preserved verbatim — the only opt-out", off.enabled === false && off.limit === QUOTA_DEFAULTS.limit, JSON.stringify(off));
    check("0d. an unbounded quota is clamped to the platform limits", clamped.limit === 100_000 && clamped.window_ms === 1_000, JSON.stringify(clamped));

    // ---- workspace + projects (one for the main suite, one for isolation) ----
    const ownerId = `q-owner-${crypto.randomUUID().slice(0, 8)}`;
    workspace = await svc.entities.Workspace.create({ name: `Quota WS ${Date.now()}`, owner_id: ownerId, credits_balance: 0 });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Quota ${Date.now()}`, slug: `q-${Date.now()}` });
    other = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Quota Other ${Date.now()}`, slug: `q-other-${Date.now()}` });

    const viewer = { id: `q-viewer-${crypto.randomUUID().slice(0, 8)}`, email: "viewer@quota.test" };
    const outsider = { id: `q-out-${crypto.randomUUID().slice(0, 8)}`, email: "outsider@quota.test" };
    const mViewer = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active" });

    const base = { auth: { type: "none" }, retry: { max_attempts: 1, backoff_ms: 20 }, timeout_ms: 5000 };
    const mk = (name, { path = "/ok", attempts = 1, quota, breaker } = {}) => {
      const doc = normalizeIntegration({ ...base, name, base_url: `https://${HOST}/v1`, retry: { max_attempts: attempts, backoff_ms: 20 }, operations: [{ name: "go", method: "GET", path }], ...(quota ? { quota } : {}) });
      return breaker ? { ...doc, breaker } : doc;
    };

    const ok = mk("ok", { quota: { limit: 3, window_ms: 3_600_000 } });          // configured + exhaustion
    const defInt = mk("def");                                                    // no quota block → defaults
    const retried = mk("retried", { path: "/flaky", attempts: 3, quota: { limit: 5 } });
    const brk = mk("brk", { path: "/down", quota: { limit: 5 }, breaker: { threshold: 1, open_ms: 60_000 } });
    const limited = mk("limited", { path: "/limited", attempts: 3, quota: { limit: 5 } });
    const conc = mk("conc", { quota: { limit: 1, window_ms: 3_600_000 } });
    const roll = mk("roll", { quota: { limit: 1, window_ms: 1_000 } });
    const offInt = mk("offq", { quota: { enabled: false } });
    const sib = mk("sib", { quota: { limit: 2 } });                              // integration isolation

    const run = (proj, name, source, integrations) => executeProjectFunction(svc, {
      project: proj, entities: [], integrations, name, source, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: {} }, messagingTransport: "test", trace_id: TRACE,
    });
    const qrow = async (proj, integration_name) => {
      const rows = await svc.entities.IntegrationQuota.filter({ project_id: proj.id, integration_name }, "-updated_at", 1);
      return rows[0] || null;
    };

    // ---- 1. configured quota + logical-call consumption ----
    const r1 = await run(project, "ok1", CALL("ok", "go"), [ok]);
    const row1 = await qrow(project, "ok");
    check("1a. a configured quota is materialized with the declared limit and window", r1.body.ok === true && row1.allowed === 3 && row1.window_ms === 3_600_000 && row1.used === 1 && row1.status === "ok", JSON.stringify({ ok: r1.body.ok, allowed: row1?.allowed, used: row1?.used }));
    check("1b. the quota key is project + integration — never shared", row1.quota_key === quotaKeyOf(project.id, "ok") && row1.project_id === project.id, row1.quota_key);
    await run(project, "ok2", CALL("ok", "go"), [ok]);
    await run(project, "ok3", CALL("ok", "go"), [ok]);
    const row3 = await qrow(project, "ok");
    check("1c. each logical call consumes exactly one unit", row3.used === 3 && row3.status === "exhausted", JSON.stringify({ used: row3.used, status: row3.status }));

    // ---- 2. exhaustion: the next call is refused BEFORE the upstream is contacted ----
    const hitsBefore = hits[`${HOST}/v1/ok`];
    const r4 = await run(project, "ok4", CALL("ok", "go"), [ok]);
    const refusedState = r4.body.quota || {};
    check("2a. an exhausted quota refuses with QUOTA_EXCEEDED and zero attempts", r4.body.ok === false && r4.body.code === "QUOTA_EXCEEDED" && r4.body.kind === "quota_exceeded" && r4.body.attempts === 0, JSON.stringify(r4.body));
    check("2b. the refusal contacts NO upstream — the hit counter does not move", hits[`${HOST}/v1/ok`] === hitsBefore, `${hitsBefore} → ${hits[`${HOST}/v1/ok`]}`);
    check("2c. the refusal reports the window it is honouring and counts as a refusal", refusedState.refused_before_call === true && refusedState.reason === "quota_exceeded" && refusedState.remaining === 0 && (await qrow(project, "ok")).refusals >= 1, JSON.stringify(refusedState));

    // ---- 3. retries: ONE logical call → ONE quota unit ----
    const flakyBefore = hits[`${HOST}/v1/flaky`] || 0;
    const rr = await run(project, "retried1", CALL("retried", "go"), [retried]);
    const retryRow = await qrow(project, "retried");
    check("3a. three internal attempts count as ONE quota unit", rr.body.attempts === 3 && hits[`${HOST}/v1/flaky`] === flakyBefore + 3 && retryRow.used === 1, JSON.stringify({ attempts: rr.body.attempts, used: retryRow.used, hits: hits[`${HOST}/v1/flaky`] }));

    // ---- 4. a breaker refusal consumes nothing (#31C agreement) ----
    const brk1 = await run(project, "brk1", CALL("brk", "go"), [brk]);
    const brkRowAfter1 = await qrow(project, "brk");
    check("4a. the call that trips the breaker still consumes its unit", brk1.body.ok === false && brk1.body.kind === "server_error" && brkRowAfter1.used === 1, JSON.stringify({ kind: brk1.body.kind, used: brkRowAfter1.used }));
    const brkHitsBefore = hits[`${HOST}/v1/down`];
    const brk2 = await run(project, "brk2", CALL("brk", "go"), [brk]);
    const brkRowAfter2 = await qrow(project, "brk");
    check("4b. a breaker OPEN refusal consumes NOTHING — used does not move", brk2.body.ok === false && brk2.body.kind === "circuit_open" && brk2.body.attempts === 0 && brkRowAfter2.used === 1, JSON.stringify({ kind: brk2.body.kind, used: brkRowAfter2.used }));
    check("4c. the breaker refusal contacts no upstream", hits[`${HOST}/v1/down`] === brkHitsBefore, `${brkHitsBefore} → ${hits[`${HOST}/v1/down`]}`);

    // ---- 5. a 429 does not double-consume (#31B agreement) ----
    const limBefore = hits[`${HOST}/v1/limited`] || 0;
    const rl = await run(project, "limited1", CALL("limited", "go"), [limited]);
    const rlRow = await qrow(project, "limited");
    check("5a. a 429 retried three times is still ONE logical call → ONE quota unit", rl.body.attempts === 3 && hits[`${HOST}/v1/limited`] === limBefore + 3 && rlRow.used === 1, JSON.stringify({ attempts: rl.body.attempts, used: rlRow.used, hits: hits[`${HOST}/v1/limited`] }));

    // ---- 6. project + integration isolation ----
    // project isolation: project A exhausted `ok`; project B's `ok` is untouched.
    const isoBefore = hits[`${HOST}/v1/ok`];
    const isoRun = await run(other, "okOther", CALL("ok", "go"), [ok]);
    const isoRow = await qrow(other, "ok");
    check("6a. one project's exhausted quota never refuses another project's call", isoRun.body.ok === true && hits[`${HOST}/v1/ok`] === isoBefore + 1 && isoRow.used === 1 && isoRow.project_id === other.id, JSON.stringify({ ok: isoRun.body.ok, used: isoRow?.used, project: isoRow?.project_id }));
    check("6b. each project owns its own quota row, keyed apart", row1.project_id === project.id && isoRow.project_id === other.id && row1.id !== isoRow.id, `${row1.id} vs ${isoRow?.id}`);
    // integration isolation: `sib` in the same project has its own quota, unaffected by `ok`.
    const sibRun = await run(project, "sib1", CALL("sib", "go"), [sib]);
    const sibRow = await qrow(project, "sib");
    check("6c. two integrations in one project are counted apart", sibRun.body.ok === true && sibRow.used === 1 && sibRow.allowed === 2 && sibRow.integration_name === "sib", JSON.stringify({ used: sibRow.used, allowed: sibRow.allowed }));

    // ---- 7. concurrent last-unit consumption: exactly one winner ----
    const [cA, cB] = await Promise.all([run(project, "concA", CALL("conc", "go"), [conc]), run(project, "concB", CALL("conc", "go"), [conc])]);
    const concRow = await qrow(project, "conc");
    const concHits = hits[`${HOST}/v1/ok`] - isoBefore - 1; // conc shares /ok; subtract the iso + sib calls on /ok since isoBefore
    const winners = [cA, cB].filter((r) => r.body.ok === true).length;
    const refusers = [cA, cB].filter((r) => r.body.ok === false).length;
    check("7a. two concurrent calls on a one-unit quota produce exactly one winner", winners === 1 && refusers === 1, JSON.stringify({ winners, refusers, a: cA.body.ok, b: cB.body.ok }));
    check("7b. the quota row records one consumed unit and one refusal", concRow.used === 1 && concRow.refusals >= 1 && concRow.status === "exhausted", JSON.stringify({ used: concRow.used, refusals: concRow.refusals, status: concRow.status }));

    // ---- 8. window rollover is lazy and deterministic ----
    await run(project, "roll1", CALL("roll", "go"), [roll]);
    const rollExhausted = await qrow(project, "roll");
    check("8a. a one-unit quota exhausts after the first call", rollExhausted.used === 1 && rollExhausted.status === "exhausted" && rollExhausted.windows === 1, JSON.stringify({ used: rollExhausted.used, windows: rollExhausted.windows }));
    await sleep(1100);
    const rollAgain = await run(project, "roll2", CALL("roll", "go"), [roll]);
    const rollRow2 = await qrow(project, "roll");
    check("8b. after the window elapses the next call rolls the window forward and succeeds", rollAgain.body.ok === true && rollRow2.windows === 2 && rollRow2.used === 1 && rollRow2.status === "exhausted", JSON.stringify({ ok: rollAgain.body.ok, windows: rollRow2.windows, used: rollRow2.used, status: rollRow2.status }));

    // ---- 9. a disabled quota consumes nothing and keeps no state ----
    await run(project, "off1", CALL("offq", "go"), [offInt]);
    await run(project, "off2", CALL("offq", "go"), [offInt]);
    const offRow = await qrow(project, "offq");
    check("9. a quota with enabled:false keeps no row and every call is allowed", offRow === null, `row=${offRow ? "present" : "none"}`);

    // ---- 10. defaults: an integration with no quota block gets the bounded defaults ----
    const defRun = await run(project, "def1", CALL("def", "go"), [defInt]);
    const defRow = await qrow(project, "def");
    check("10. an integration with no quota block is bounded by the platform defaults", defRun.body.ok === true && defRow.allowed === QUOTA_DEFAULTS.limit && defRow.window_ms === QUOTA_DEFAULTS.window_ms, JSON.stringify({ allowed: defRow?.allowed, window_ms: defRow?.window_ms }));

    // ---- 11. observability: quota_state + quota error category in IntegrationInvocation ----
    const inv = await listIntegrationInvocations(svc, { project_id: project.id, limit: 300 });
    const okInv = inv.filter((r) => r.integration_name === "ok" && r.ok === true)[0] || {};
    const refusedInv = inv.filter((r) => r.integration_name === "ok" && r.ok === false && r.failure_kind === "quota_exceeded")[0] || {};
    const breakerInv = inv.filter((r) => r.integration_name === "brk" && r.failure_kind === "circuit_open")[0] || {};
    const limitedInv = inv.filter((r) => r.integration_name === "limited")[0] || {};
    check("11a. a successful call records its consumed quota state and no error category", okInv.ok === true && okInv.quota_state?.consumed === 1 && !okInv.error_category, JSON.stringify({ consumed: okInv.quota_state?.consumed, cat: okInv.error_category }));
    check("11b. a quota refusal is categorized 'quota' with zero attempts and its refusal state", refusedInv.error_category === "quota" && refusedInv.error_code === "QUOTA_EXCEEDED" && refusedInv.attempts === 0 && refusedInv.quota_state?.refused_before_call === true, JSON.stringify({ cat: refusedInv.error_category, attempts: refusedInv.attempts, state: refusedInv.quota_state }));
    check("11c. a breaker refusal carries no quota state (it never reached the quota layer)", breakerInv.error_category === "upstream" && breakerInv.attempts === 0 && !breakerInv.quota_state, JSON.stringify({ cat: breakerInv.error_category, hasQuota: !!breakerInv.quota_state }));
    check("11d. a 429 keeps its rate-limit category AND the quota unit it consumed", limitedInv.error_category === "rate_limit" && limitedInv.quota_state?.consumed === 1, JSON.stringify({ cat: limitedInv.error_category, consumed: limitedInv.quota_state?.consumed }));

    // ---- 12. authorized read surface ----
    const owner = { id: ownerId, email: "owner@quota.test" };
    const authz = async (u, cap) => {
      try { const r = await loadAuthorizedProject(svc, u, project.id, cap); return { allowed: true, role: r.role }; }
      catch (e) { return { allowed: false, status: e.status, code: e.code }; }
    };
    check("12a. the workspace owner may read the project's quotas", (await authz(owner, "project.read")).allowed, "owner → project.read");
    check("12b. a viewer may read the project's quotas", (await authz(viewer, "project.read")).allowed, "viewer → project.read");
    const outAuthz = await authz(outsider, "project.read");
    check("12c. a non-member is refused with NOT_A_MEMBER", !outAuthz.allowed && outAuthz.status === 403 && outAuthz.code === "NOT_A_MEMBER", JSON.stringify(outAuthz));
    const mine = await listIntegrationQuotas(svc, { project_id: project.id, limit: 50 });
    const theirs = await listIntegrationQuotas(svc, { project_id: other.id, limit: 50 });
    check("12d. the read surface returns only the authorized project's quota rows", mine.every((r) => r.project_id === project.id) && !mine.some((r) => r.project_id === other.id) && theirs.every((r) => r.project_id === other.id), JSON.stringify({ mine: mine.length, theirs: theirs.length }));
    let unscoped = null;
    try { await listIntegrationQuotas(svc, {}); } catch (e) { unscoped = e; }
    check("12e. an unscoped read is refused outright (project_id is mandatory)", !!unscoped && unscoped.code === "INVALID_INPUT", unscoped?.message);

    await svc.entities.WorkspaceMember.delete(mViewer.id).catch(() => {});
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    globalThis.fetch = realFetch;
    clearOAuthCache();
    for (const p of [project, other]) {
      if (!p) continue;
      for (const entity of ["IntegrationQuota", "IntegrationBreaker", "IntegrationRateLimit", "IntegrationInvocation", "TraceEvent", "AuditLog", "FunctionInvocation"]) {
        const rows = await svc.entities[entity].filter({ project_id: p.id }, "-created_date", 300).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    if (workspace) await svc.entities.Workspace.delete(workspace.id).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}