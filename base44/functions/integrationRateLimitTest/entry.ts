// Focused certification for #31B — Retry-After handling and rate-limit window state.
//
// Everything runs through the REAL production path (executeProjectFunction →
// createIntegrationsApi → executeExternalTool → httpAdapter → retry engine → rate-limit state),
// against throwaway projects. Only the network boundary is scripted.
//
// Scope: the four #31B behaviours only — numeric Retry-After, HTTP-date Retry-After, the wait
// budget, and the project+integration+host window plus its effect on the NEXT call. Adapter
// behaviour, OAuth2, observability and tracing are covered by integrationEngineTest and
// integrationObservabilityTest, and are asserted here only where they must agree.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { normalizeIntegration } from "../../shared/integrations.ts";
import { retryDelay, waitBudgetOf, clearOAuthCache, setDnsLookupForTests } from "../../shared/externalTools.ts";
import { parseRetryAfter, stateKeyOf, listIntegrationRateLimits } from "../../shared/integrationRateLimit.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { listIntegrationInvocations } from "../../shared/integrationObservability.ts";

const FN = (body) => `export const config = { method: 'POST' };\nexport default async function handler(ctx) {\n${body}\n}\n`;
const CALL = (integ, op, args = "{}") => FN(
  `  try { const res = await ctx.integrations.${integ}.${op}(${args}); return { status: 200, body: { ok: true, attempts: res.attempts } }; }\n` +
  `  catch (e) { const d = e.details || {}; return { status: 200, body: { ok: false, code: e.code, kind: d.kind, attempts: d.attempts, rate_limit: d.rate_limit, message: e.message } }; }`,
);
const POST_CALL = FN(
  `  try { const res = await ctx.integrations.poster.submit({}, { body: { a: 1 } }); return { status: 200, body: { ok: true, attempts: res.attempts } }; }\n` +
  `  catch (e) { const d = e.details || {}; return { status: 200, body: { ok: false, code: e.code, attempts: d.attempts, rate_limit: d.rate_limit } }; }`,
);

const HOSTS = ["api.example.com", "api2.example.com"];

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const realFetch = globalThis.fetch;
  const TRACE = `t_rl_${Date.now().toString(36)}`;
  let project = null, other = null;

  // Upstream hit counters, per path — the fast-refusal assertions depend on these NOT moving.
  const hits = {};
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const dateIn = (ms) => new Date(Date.now() + ms).toUTCString();
  setDnsLookupForTests((host) => {
    if (!HOSTS.includes(host)) throw new Error(`unscripted host ${host}`);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (!HOSTS.includes(u.hostname)) return realFetch(url, options);
    const key = `${u.hostname}${u.pathname}`;
    hits[key] = (hits[key] || 0) + 1;
    if (u.pathname === "/v1/limited-long") return json({ error: "slow down" }, 429, { "retry-after": "60" });
    if (u.pathname === "/v1/limited-date") return json({ error: "slow down" }, 429, { "retry-after": dateIn(90_000) });
    if (u.pathname === "/v1/limited-brief") return json({ error: "slow down" }, 429, { "retry-after": "0" });
    if (u.pathname === "/v1/submit") return json({ error: "slow down" }, 429, { "retry-after": "60" });
    if (u.pathname === "/v1/flap") return hits[key] < 3 ? json({ error: "unavailable" }, 503, { "retry-after": "0" }) : json({ state: "ok" });
    if (u.pathname === "/v1/ok") return json({ state: "ok" });
    return json({ error: "unexpected path" }, 500);
  };

  try {
    // ---- 1 & 2. Retry-After parsing, both specified forms (pure, no I/O) ----------------
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const seconds = parseRetryAfter("120", now);
    const fractional = parseRetryAfter("1.5", now);
    check("1a. numeric Retry-After is read as SECONDS and converted to ms", seconds?.ms === 120_000 && seconds.source === "header_seconds" && fractional?.ms === 1500, JSON.stringify({ seconds, fractional }));
    const future = parseRetryAfter(new Date(now + 45_000).toUTCString(), now);
    const past = parseRetryAfter(new Date(now - 60_000).toUTCString(), now);
    check("2a. an HTTP-date Retry-After is measured against the server clock", future?.source === "header_date" && Math.abs(future.ms - 45_000) <= 1000, JSON.stringify(future));
    check("2b. an HTTP-date already in the past clamps to 0, never a negative wait", past?.source === "header_date" && past.ms === 0, JSON.stringify(past));
    check("2c. absent is absent, unusable is 'invalid' — neither is guessed", parseRetryAfter(undefined) === null && parseRetryAfter("") === null && parseRetryAfter("soon")?.source === "invalid", JSON.stringify({ blank: parseRetryAfter(""), junk: parseRetryAfter("soon") }));

    const policy = { retry: { max_attempts: 3, backoff_ms: 200 }, timeout_ms: 5000 };
    const wSeconds = retryDelay(policy, 1, "30", now);
    const wDate = retryDelay(policy, 1, new Date(now + 30_000).toUTCString(), now);
    const wNone = retryDelay(policy, 2, undefined, now);
    const wJunk = retryDelay(policy, 1, "whenever", now);
    check("1b. a stated 30s delay is honoured in full, not clamped to 2s", wSeconds.wait_ms === 30_000 && wSeconds.retry_after_source === "header_seconds", JSON.stringify(wSeconds));
    check("2d. the same delay stated as an HTTP-date produces the same wait", Math.abs(wDate.wait_ms - 30_000) <= 1000 && wDate.retry_after_source === "header_date", JSON.stringify(wDate));
    check("1c. with no usable header the existing backoff is unchanged", wNone.wait_ms === 400 && wNone.retry_after_source === "absent" && wJunk.wait_ms === 200 && wJunk.retry_after_source === "invalid", JSON.stringify({ wNone, wJunk }));
    check("1d. a stated delay shorter than the backoff never shortens the backoff", retryDelay(policy, 2, "0", now).wait_ms === 400, JSON.stringify(retryDelay(policy, 2, "0", now)));

    // ---- 3. wait budget ------------------------------------------------------------------
    check("3a. the wait budget comes from the operation's own timeout unless overridden", waitBudgetOf(policy) === 5000 && waitBudgetOf({ retry: { max_wait_ms: 800 }, timeout_ms: 5000 }) === 800, `${waitBudgetOf(policy)} / ${waitBudgetOf({ retry: { max_wait_ms: 800 }, timeout_ms: 5000 })}`);

    const ws = `rl-ws-${Date.now()}`;
    project = await svc.entities.Project.create({ workspace_id: ws, name: `RL Test ${Date.now()}`, slug: `rl-${Date.now()}` });
    other = await svc.entities.Project.create({ workspace_id: `rl-ws2-${Date.now()}`, name: `RL Other ${Date.now()}`, slug: `rl-other-${Date.now()}` });

    const base = { auth: { type: "none" }, retry: { max_attempts: 3, backoff_ms: 50 }, timeout_ms: 5000 };
    const limited = normalizeIntegration({ ...base, name: "limited", base_url: "https://api.example.com/v1", operations: [{ name: "getLong", method: "GET", path: "/limited-long" }] });
    const dated = normalizeIntegration({ ...base, name: "dated", base_url: "https://api.example.com/v1", operations: [{ name: "getDated", method: "GET", path: "/limited-date" }] });
    const brief = normalizeIntegration({ ...base, name: "brief", base_url: "https://api.example.com/v1", operations: [{ name: "getBrief", method: "GET", path: "/limited-brief" }] });
    const sibling = normalizeIntegration({ ...base, name: "sibling", base_url: "https://api.example.com/v1", operations: [{ name: "getLong", method: "GET", path: "/limited-long" }] });
    const alt = normalizeIntegration({ ...base, name: "alt", base_url: "https://api2.example.com/v1", operations: [{ name: "ping", method: "GET", path: "/ok" }] });
    const flap = normalizeIntegration({ ...base, name: "flap", base_url: "https://api.example.com/v1", operations: [{ name: "getFlap", method: "GET", path: "/flap" }] });
    const poster = normalizeIntegration({ ...base, name: "poster", base_url: "https://api.example.com/v1", operations: [{ name: "submit", method: "POST", path: "/submit" }] });

    const run = (proj, name, source, integrations) => executeProjectFunction(svc, {
      project: proj, entities: [], integrations, name, source, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: {} }, messagingTransport: "test", trace_id: TRACE,
    });

    // Existing retry behaviour first, on a host with no window: unchanged.
    const flapRun = await run(project, "callFlap", CALL("flap", "getFlap"), [flap]);
    check("3b. existing retry limits and backoff still work when the delay fits the budget", flapRun.body.ok === true && flapRun.body.attempts === 3 && hits["api.example.com/v1/flap"] === 3, JSON.stringify(flapRun.body));

    // A 429 asking for 60s against a 5s operation: refused deterministically, tried once.
    const longRun = await run(project, "callLong", CALL("limited", "getLong"), [limited]);
    const longState = longRun.body.rate_limit || {};
    check("3c. a stated delay longer than the remaining budget is refused, not slept off", longRun.body.ok === false && longRun.body.code === "UPSTREAM_FAILURE" && longRun.body.attempts === 1 && hits["api.example.com/v1/limited-long"] === 1, JSON.stringify({ body: longRun.body, hits: hits["api.example.com/v1/limited-long"] }));
    check("3d. the refusal explains itself: requested wait, remaining budget, skip reason", longState.retry_skipped === true && longState.skip_reason === "wait_exceeds_budget" && longState.requested_wait_ms === 60_000 && longState.remaining_budget_ms === 5000 && longState.retry_after_source === "header_seconds", JSON.stringify(longState));

    // ---- 4. project + integration + host window -----------------------------------------
    const datedRun = await run(project, "callDated", CALL("dated", "getDated"), [dated]);
    const briefRun = await run(project, "callBrief", CALL("brief", "getBrief"), [brief]);
    let windows = await listIntegrationRateLimits(svc, { project_id: project.id, limit: 50 });
    const win = (name) => windows.find((w) => w.integration_name === name) || {};
    const longWin = win("limited"), dateWin = win("dated"), briefWin = win("brief");
    check("4a. a 429 records one window keyed by project + integration + host", !!longWin.id && longWin.state_key === stateKeyOf(project.id, "limited", "api.example.com") && longWin.project_id === project.id && longWin.workspace_id === ws && longWin.host === "api.example.com" && longWin.status === 429, JSON.stringify({ key: longWin.state_key, host: longWin.host, status: longWin.status }));
    check("4b. the numeric delay is stored as a retry_until instant", longWin.retry_after_source === "header_seconds" && longWin.retry_after_ms === 60_000 && Date.parse(longWin.retry_until) - Date.now() > 50_000, JSON.stringify({ source: longWin.retry_after_source, ms: longWin.retry_after_ms, until: longWin.retry_until }));
    check("4c. an HTTP-date delay is stored the same way, from the date form", datedRun.body.ok === false && dateWin.retry_after_source === "header_date" && Date.parse(dateWin.retry_until) - Date.now() > 80_000, JSON.stringify({ source: dateWin.retry_after_source, until: dateWin.retry_until }));
    check("4d. a 429 with no stated delay is remembered WITHOUT inventing a retry_until", briefRun.body.ok === false && !!briefWin.id && (briefWin.retry_until === null || briefWin.retry_until === undefined) && briefWin.retry_after_ms === 0, JSON.stringify({ until: briefWin.retry_until, ms: briefWin.retry_after_ms, source: briefWin.retry_after_source }));
    check("4e. no window is recorded for a host that never returned 429", !windows.some((w) => w.integration_name === "flap"), windows.map((w) => w.integration_name).join(","));
    check("4f. the window stores a host, never a URL", windows.every((w) => !String(w.host).includes("/") && !String(w.host).includes("?")), windows.map((w) => w.host).join(","));

    // ---- 5. next-call behaviour during an active window ----------------------------------
    const before = hits["api.example.com/v1/limited-long"];
    const deferred = await run(project, "callLongAgain", CALL("limited", "getLong"), [limited]);
    const state = deferred.body.rate_limit || {};
    check("5a. the next call inside the window is refused BEFORE the upstream is contacted", deferred.body.ok === false && deferred.body.code === "UPSTREAM_FAILURE" && deferred.body.kind === "rate_limited" && hits["api.example.com/v1/limited-long"] === before, `upstream hits ${before} → ${hits["api.example.com/v1/limited-long"]}`);
    check("5b. the refusal reports the window it is honouring", state.refused_before_call === true && state.skip_reason === "window_open" && state.retry_after_ms > 0 && !!state.retry_until, JSON.stringify(state));
    const briefAgainBefore = hits["api.example.com/v1/limited-brief"];
    await run(project, "callBriefAgain", CALL("brief", "getBrief"), [brief]);
    // The upstream stated no delay, so nothing is deferred: the call is made again and the
    // existing retry policy spends its full attempt budget exactly as before.
    check("5c. a remembered 429 with NO stated delay refuses nothing — the call is still made", hits["api.example.com/v1/limited-brief"] === briefAgainBefore + 3, `${briefAgainBefore} → ${hits["api.example.com/v1/limited-brief"]}`);
    const siblingRun = await run(project, "callSibling", CALL("sibling", "getLong"), [sibling]);
    check("5d. a different integration on the SAME host is not deferred by another's window", hits["api.example.com/v1/limited-long"] === before + 1 && siblingRun.body.attempts === 1, `hits=${hits["api.example.com/v1/limited-long"]}`);
    const altRun = await run(project, "callAlt", CALL("alt", "ping"), [alt]);
    check("5e. a different host is unaffected", altRun.body.ok === true && hits["api2.example.com/v1/ok"] === 1, JSON.stringify(altRun.body));
    windows = await listIntegrationRateLimits(svc, { project_id: project.id, limit: 50 });
    const reused = windows.find((w) => w.integration_name === "limited") || {};
    check("5f. repeat 429s reuse the one window and count the refusals it prevented", windows.filter((w) => w.integration_name === "limited").length === 1 && reused.refusals >= 1, JSON.stringify({ rows: windows.filter((w) => w.integration_name === "limited").length, refusals: reused.refusals, occurrences: reused.occurrences }));

    // ---- preserved: idempotency, isolation, observability --------------------------------
    const postRun = await run(project, "callSubmit", POST_CALL, [poster]);
    check("6a. a stated Retry-After still does not make a non-idempotent POST retryable", postRun.body.ok === false && postRun.body.attempts === 1 && hits["api.example.com/v1/submit"] === 1, JSON.stringify({ body: postRun.body, hits: hits["api.example.com/v1/submit"] }));
    const postAgain = await run(project, "callSubmitAgain", POST_CALL, [poster]);
    check("6b. the POST's own window then defers the next POST instead of re-sending it", postAgain.body.ok === false && hits["api.example.com/v1/submit"] === 1, `hits=${hits["api.example.com/v1/submit"]}`);

    const otherHitsBefore = hits["api.example.com/v1/limited-long"];
    const otherRun = await run(other, "callLong", CALL("limited", "getLong"), [limited]);
    const otherWindows = await listIntegrationRateLimits(svc, { project_id: other.id, limit: 50 });
    check("7a. one project's window never defers another project's call", otherRun.body.ok === false && otherRun.body.attempts === 1 && hits["api.example.com/v1/limited-long"] === otherHitsBefore + 1, `hits=${hits["api.example.com/v1/limited-long"]}`);
    check("7b. each project owns its own window rows", otherWindows.length === 1 && otherWindows[0].project_id === other.id && otherWindows[0].state_key === stateKeyOf(other.id, "limited", "api.example.com") && !windows.some((w) => w.project_id === other.id), JSON.stringify({ other: otherWindows.length, mine: windows.length }));
    let unscoped = null;
    try { await listIntegrationRateLimits(svc, {}); } catch (e) { unscoped = e; }
    check("7c. an unscoped read of windows is refused outright", !!unscoped && unscoped.code === "INVALID_INPUT", unscoped?.message);

    const rows = await listIntegrationInvocations(svc, { project_id: project.id, limit: 100 });
    const inv = (integration, operation) => rows.filter((r) => r.integration_name === integration && r.operation === operation);
    const budgetInv = inv("limited", "getLong").find((r) => r.rate_limit_state?.skip_reason === "wait_exceeds_budget");
    const deferredInv = inv("limited", "getLong").find((r) => r.rate_limit_state?.refused_before_call === true);
    check("8a. #31A observability still records ONE invocation per logical call", inv("flap", "getFlap").length === 1 && inv("flap", "getFlap")[0].attempts === 3 && inv("limited", "getLong").length === 2, JSON.stringify({ flap: inv("flap", "getFlap").length, limited: inv("limited", "getLong").length }));
    check("8b. the budget refusal is recorded as rate_limit with its retry-after source", !!budgetInv && budgetInv.error_category === "rate_limit" && budgetInv.status === 429 && budgetInv.rate_limit_state.retry_after_source === "header_seconds" && budgetInv.trace_id === TRACE, JSON.stringify(budgetInv?.rate_limit_state || {}));
    check("8c. the pre-call refusal is recorded too, and shows no upstream contact", !!deferredInv && deferredInv.error_category === "rate_limit" && deferredInv.rate_limit_state.retry_skipped === true && deferredInv.host === "api.example.com", JSON.stringify(deferredInv?.rate_limit_state || {}));
    const fnRow = await svc.entities.FunctionInvocation.filter({ project_id: project.id, function_name: "callLongAgain" }, "-created_date", 1);
    check("8d. a deferred call makes no external_calls entry, because none was made", (fnRow[0]?.external_calls || []).length === 0, JSON.stringify(fnRow[0]?.external_calls || []));
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    globalThis.fetch = realFetch;
    setDnsLookupForTests(null);
    clearOAuthCache();
    for (const p of [project, other]) {
      if (!p) continue;
      for (const entity of ["IntegrationRateLimit", "IntegrationInvocation", "TraceEvent", "AuditLog", "FunctionInvocation"]) {
        const rows = await svc.entities[entity].filter({ project_id: p.id }, "-created_date", 200).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}