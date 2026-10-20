// Focused certification for #31C — Integration Circuit Breaker.
//
// Everything runs through the REAL production path (executeProjectFunction → createIntegrationsApi
// → executeExternalTool → breaker + adapters → #31A observer), against throwaway projects. Only
// the network boundary is scripted, and every upstream hit is counted so "no upstream contact while
// OPEN" is proven rather than assumed.
//
// Scope: the breaker only. Adapter behaviour, OAuth2, SSRF guards and webhooks are #31/#31A/#31B's
// tests; they are asserted here only where the breaker must agree with them.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { normalizeIntegration } from "../../shared/integrations.ts";
import { clearOAuthCache, setDnsLookupForTests } from "../../shared/externalTools.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { listIntegrationInvocations } from "../../shared/integrationObservability.ts";
import { countsAsBreakerFailure, breakerConfig, BREAKER_DEFAULTS } from "../../shared/integrationBreaker.ts";

const CALL = (integration, operation, args = "{}") => `export const config = { method: 'POST' };
export default async function handler(ctx) {
  try { const r = await ctx.integrations.${integration}.${operation}(${args}); return { status: 200, body: { ok: true, attempts: r.attempts } }; }
  catch (e) { return { status: 200, body: { ok: false, code: e.code, kind: e.details?.kind || null, attempts: e.details?.attempts ?? null } }; }
}
`;
const HOSTS = ["api.example.com", "api2.example.com"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const realFetch = globalThis.fetch;
  const TRACE = `t_brk_${Date.now().toString(36)}`;
  let project = null, other = null;

  const hits = {};
  let downHealthy = false;
  setDnsLookupForTests((host) => {
    if (!HOSTS.includes(host)) throw new Error(`unscripted host ${host}`);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (!HOSTS.includes(u.hostname)) return realFetch(url, options);
    const key = `${u.hostname}${u.pathname}`;
    hits[key] = (hits[key] || 0) + 1;
    if (u.pathname === "/v1/down") return downHealthy ? json({ state: "ok" }) : json({ error: "boom" }, 503);
    if (u.pathname === "/v1/gone") return json({ error: "no such widget" }, 404);
    if (u.pathname === "/v1/locked") return json({ error: "nope" }, 401);
    if (u.pathname === "/v1/limited") return json({ error: "slow down" }, 429);
    if (u.pathname === "/v1/flaky") return json({ error: "boom" }, 503);
    return json({ error: "unexpected path" }, 500);
  };

  try {
    const ws = `brk-ws-${Date.now()}`;
    project = await svc.entities.Project.create({ workspace_id: ws, name: `Breaker ${Date.now()}`, slug: `brk-${Date.now()}` });
    other = await svc.entities.Project.create({ workspace_id: `brk-ws2-${Date.now()}`, name: `Breaker Other ${Date.now()}`, slug: `brk-other-${Date.now()}` });

    const BRK = { threshold: 2, window_ms: 60_000, open_ms: 2_500, half_open_max_probes: 1 };
    const mk = (name, { path = "/down", host = "api.example.com", attempts = 1, breaker = BRK, auth = { type: "none" }, secret } = {}) => ({
      ...normalizeIntegration({
        name, base_url: `https://${host}/v1`, auth: secret ? { type: "bearer", secret } : auth,
        retry: { max_attempts: attempts, backoff_ms: 20 },
        operations: [{ name: "go", method: "GET", path }],
      }),
      breaker,
    });

    const down = mk("down");
    const sibling = mk("sibling");                              // same host, different integration
    const elsewhere = mk("elsewhere", { host: "api2.example.com" });
    const gone = mk("gone", { path: "/gone" });                 // 404 business error
    const locked = mk("locked", { path: "/locked", secret: "NOT_SET_KEY" }); // auth/config failure
    const limited = mk("limited", { path: "/limited" });         // 429, #31B's business
    const retried = mk("retried", { path: "/flaky", attempts: 3 });
    const conc = mk("conc", { breaker: { threshold: 2, window_ms: 60_000, open_ms: 30_000, half_open_max_probes: 1 } });
    const off = mk("off", { breaker: { enabled: false } });

    const run = (proj, name, source, integrations) => executeProjectFunction(svc, {
      project: proj, entities: [], integrations, name, source, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: {} }, messagingTransport: "test", trace_id: TRACE,
    });
    const state = async (proj, integration_name, host = "api.example.com") =>
      (await svc.entities.IntegrationBreaker.filter({ project_id: proj.id, integration_name, host }, "-updated_at", 1))[0] || null;

    // ---- 0. configuration bounds & failure policy (pure) ----
    const conf = breakerConfig({ breaker: { threshold: 9999, window_ms: 1, open_ms: 0, half_open_max_probes: 99 } });
    check("0a. configuration is clamped to bounded limits — never unbounded, never permanent", conf.threshold === 20 && conf.window_ms === 1000 && conf.open_ms === 100 && conf.half_open_max_probes === 5, JSON.stringify(conf));
    check("0b. defaults are bounded and self-recovering", BREAKER_DEFAULTS.threshold === 5 && BREAKER_DEFAULTS.open_ms > 0 && breakerConfig({}).open_ms === BREAKER_DEFAULTS.open_ms, JSON.stringify(BREAKER_DEFAULTS));
    const counts = {
      s503: countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 503, failure_kind: "server_error" }),
      timeout: countsAsBreakerFailure({ ok: false, code: "TIMEOUT", status: 0, failure_kind: "timeout" }),
      network: countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 0, failure_kind: "network" }),
      ok: countsAsBreakerFailure({ ok: true, status: 200 }),
      auth: countsAsBreakerFailure({ ok: false, code: "AUTH_FAILURE", status: 401, failure_kind: "secret_not_set" }),
      invalid: countsAsBreakerFailure({ ok: false, code: "INVALID_INPUT", failure_kind: "missing_parameter" }),
      notFound: countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 404, failure_kind: "not_found" }),
      client4xx: countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 422, failure_kind: "client_error" }),
      rate: countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 429, failure_kind: "rate_limited" }),
      platform: countsAsBreakerFailure({ ok: false, code: "PLATFORM_FAILURE", status: 0, failure_kind: "invalid_url" }),
      refusal: countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 0, failure_kind: "circuit_open" }),
    };
    check("0c. only upstream faults count: 5xx, timeout, connection failure", counts.s503 && counts.timeout && counts.network && !counts.ok, JSON.stringify(counts));
    check("0d. auth, validation, 4xx, rate-limit, platform and refusals never count", !counts.auth && !counts.invalid && !counts.notFound && !counts.client4xx && !counts.rate && !counts.platform && !counts.refusal, JSON.stringify(counts));

    // ---- 1. CLOSED → OPEN at the threshold ----
    const d1 = await run(project, "down1", CALL("down", "go"), [down]);
    const afterOne = await state(project, "down");
    check("1a. the first counted failure is remembered but does NOT open the breaker", d1.body.ok === false && afterOne?.state === "CLOSED" && afterOne.failure_count === 1, JSON.stringify({ code: d1.body.code, state: afterOne?.state, count: afterOne?.failure_count }));
    await run(project, "down2", CALL("down", "go"), [down]);
    const opened = await state(project, "down");
    check("1b. reaching the threshold opens the breaker, with a bounded open window", opened?.state === "OPEN" && opened.failure_count === 2 && !!opened.open_until && Date.parse(opened.open_until) > Date.now() && opened.trips === 1, JSON.stringify({ state: opened?.state, count: opened?.failure_count, open_until: opened?.open_until }));

    // ---- 2. OPEN fast refusal, with NO upstream contact ----
    const hitsBefore = hits["api.example.com/v1/down"];
    const refused = await run(project, "down3", CALL("down", "go"), [down]);
    check("2a. an OPEN breaker refuses deterministically before the call", refused.body.ok === false && refused.body.code === "UPSTREAM_FAILURE" && refused.body.kind === "circuit_open" && refused.body.attempts === 0, JSON.stringify(refused.body));
    check("2b. the upstream is NOT contacted while OPEN", hits["api.example.com/v1/down"] === hitsBefore, `${hitsBefore} → ${hits["api.example.com/v1/down"]}`);
    const refusedRow = await state(project, "down");
    check("2c. the refusal is counted and does not inflate the failure window", refusedRow.refusals >= 1 && refusedRow.failure_count === 2, JSON.stringify({ refusals: refusedRow.refusals, count: refusedRow.failure_count }));

    // ---- 3. HALF_OPEN probe → successful recovery (CLOSED → OPEN → HALF_OPEN → CLOSED) ----
    await sleep(2600);
    downHealthy = true;
    const probeBefore = hits["api.example.com/v1/down"];
    const recovered = await run(project, "down4", CALL("down", "go"), [down]);
    const closed = await state(project, "down");
    check("3a. after the open duration a bounded probe reaches the upstream", recovered.body.ok === true && hits["api.example.com/v1/down"] === probeBefore + 1 && closed.probe_count >= 1, JSON.stringify({ ok: recovered.body.ok, hits: hits["api.example.com/v1/down"], probes: closed.probe_count }));
    check("3b. a successful probe closes the breaker and clears the window", closed.state === "CLOSED" && closed.failure_count === 0 && !closed.probe_token, JSON.stringify({ state: closed.state, count: closed.failure_count }));

    // ---- 4. failed probe returns to OPEN (CLOSED → OPEN → HALF_OPEN → OPEN) ----
    downHealthy = false;
    await run(project, "down5", CALL("down", "go"), [down]);
    await run(project, "down6", CALL("down", "go"), [down]);
    const reopened = await state(project, "down");
    await sleep(2600);
    const probe2Before = hits["api.example.com/v1/down"];
    const failedProbe = await run(project, "down7", CALL("down", "go"), [down]);
    const backOpen = await state(project, "down");
    check("4a. the closed breaker re-opens on a fresh threshold of failures", reopened.state === "OPEN" && reopened.trips === 2, JSON.stringify({ state: reopened.state, trips: reopened.trips }));
    check("4b. a FAILED probe returns to OPEN immediately, not on a second threshold", failedProbe.body.ok === false && failedProbe.body.kind === "server_error" && hits["api.example.com/v1/down"] === probe2Before + 1 && backOpen.state === "OPEN" && !backOpen.probe_token, JSON.stringify({ kind: failedProbe.body.kind, state: backOpen.state }));
    const secondRefusal = await run(project, "down8", CALL("down", "go"), [down]);
    check("4c. the re-opened breaker refuses again without contacting the upstream", secondRefusal.body.kind === "circuit_open" && hits["api.example.com/v1/down"] === probe2Before + 1, `hits=${hits["api.example.com/v1/down"]}`);

    // ---- 5. ignored failure categories never open a breaker ----
    for (let i = 0; i < 3; i++) await run(project, `gone${i}`, CALL("gone", "go"), [gone]);
    for (let i = 0; i < 3; i++) await run(project, `locked${i}`, CALL("locked", "go"), [locked]);
    const goneRow = await state(project, "gone");
    const lockedRow = await state(project, "locked");
    check("5a. repeated 4xx business errors never open the breaker", (goneRow === null || goneRow.state === "CLOSED") && hits["api.example.com/v1/gone"] === 3, JSON.stringify({ state: goneRow?.state, hits: hits["api.example.com/v1/gone"] }));
    check("5b. an auth/configuration failure never opens the breaker", lockedRow === null || lockedRow.state === "CLOSED", JSON.stringify({ state: lockedRow?.state }));

    // ---- 6. rate limiting stays #31B's, never laundered into an outage ----
    for (let i = 0; i < 3; i++) await run(project, `limited${i}`, CALL("limited", "go"), [limited]);
    const limitedRow = await state(project, "limited");
    const rl = await svc.entities.IntegrationRateLimit.filter({ project_id: project.id, integration_name: "limited" }, "-observed_at", 1);
    check("6a. repeated 429s do not open the breaker", limitedRow === null || limitedRow.state === "CLOSED", JSON.stringify({ state: limitedRow?.state, count: limitedRow?.failure_count }));
    check("6b. the 429 is still recorded by the existing rate-limit state", rl[0]?.status === 429 && rl[0].occurrences >= 3, JSON.stringify({ status: rl[0]?.status, occurrences: rl[0]?.occurrences }));

    // ---- 7. retries: ONE logical call → ONE breaker decision ----
    const flakyBefore = hits["api.example.com/v1/flaky"] || 0;
    const r1 = await run(project, "retried1", CALL("retried", "go"), [retried]);
    const afterRetry = await state(project, "retried");
    check("7a. three internal attempts count as ONE breaker failure", r1.body.attempts === 3 && hits["api.example.com/v1/flaky"] === flakyBefore + 3 && afterRetry.failure_count === 1 && afterRetry.state === "CLOSED", JSON.stringify({ attempts: r1.body.attempts, count: afterRetry.failure_count, state: afterRetry.state }));
    await run(project, "retried2", CALL("retried", "go"), [retried]);
    const retryOpen = await state(project, "retried");
    check("7b. the second logical call reaches the threshold and opens it", retryOpen.state === "OPEN" && retryOpen.failure_count === 2, JSON.stringify({ state: retryOpen.state, count: retryOpen.failure_count }));

    // ---- 8. isolation: project, integration, host ----
    const siblingBefore = hits["api.example.com/v1/down"];
    const siblingRun = await run(project, "sibling1", CALL("sibling", "go"), [sibling]);
    check("8a. integration A being OPEN never blocks integration B on the same host", siblingRun.body.kind === "server_error" && hits["api.example.com/v1/down"] === siblingBefore + 1, JSON.stringify({ kind: siblingRun.body.kind }));
    const elseRun = await run(project, "elsewhere1", CALL("elsewhere", "go"), [elsewhere]);
    check("8b. host A being OPEN never blocks host B", elseRun.body.kind === "server_error" && (hits["api2.example.com/v1/down"] || 0) === 1, JSON.stringify({ kind: elseRun.body.kind, hits: hits["api2.example.com/v1/down"] }));
    const foreignBefore = hits["api.example.com/v1/down"];
    const foreignRun = await run(other, "downOther", CALL("down", "go"), [down]);
    const foreignRow = await state(other, "down");
    check("8c. project A's OPEN breaker never opens project B", foreignRun.body.kind === "server_error" && hits["api.example.com/v1/down"] === foreignBefore + 1 && foreignRow.state === "CLOSED" && foreignRow.failure_count === 1, JSON.stringify({ kind: foreignRun.body.kind, state: foreignRow?.state }));
    check("8d. each breaker is keyed by project + integration + host", foreignRow.breaker_key === `${other.id}|down|api.example.com` && foreignRow.project_id === other.id, foreignRow.breaker_key);

    // ---- 9. concurrency: simultaneous failures must not corrupt the count ----
    await Promise.all([run(project, "conc1", CALL("conc", "go"), [conc]), run(project, "conc2", CALL("conc", "go"), [conc])]);
    const concRow = await state(project, "conc");
    const concRows = await svc.entities.IntegrationBreaker.filter({ project_id: project.id, integration_name: "conc" }, "-updated_at", 5);
    check("9a. two concurrent failures produce one breaker row with both counted", concRows.length === 1 && concRow.failure_count === 2 && concRow.state === "OPEN", JSON.stringify({ rows: concRows.length, count: concRow?.failure_count, state: concRow?.state }));
    const concRefused = await run(project, "conc3", CALL("conc", "go"), [conc]);
    check("9b. state stays consistent afterwards — the next call is refused", concRefused.body.kind === "circuit_open" && concRow.version >= 2, JSON.stringify({ kind: concRefused.body.kind, version: concRow?.version }));

    // ---- 10. observability: reuse #31A only ----
    const rows = await listIntegrationInvocations(svc, { project_id: project.id, limit: 200 });
    const inv = (integration, i = 0) => rows.filter((r) => r.integration_name === integration).reverse()[i] || {};
    const refusalInv = rows.filter((r) => r.integration_name === "down" && r.breaker_state?.refused_before_call)[0] || {};
    const openInv = rows.find((r) => r.integration_name === "down" && r.breaker_state?.state === "OPEN" && !r.breaker_state?.refused_before_call && r.breaker_state?.trips === 1) || {};
    check("10a. a refused call is recorded with its breaker state and no upstream attempt", refusalInv.ok === false && refusalInv.attempts === 0 && refusalInv.status === 0 && refusalInv.failure_kind === "circuit_open" && refusalInv.error_code === "UPSTREAM_FAILURE" && refusalInv.breaker_state?.state === "OPEN", JSON.stringify({ attempts: refusalInv.attempts, kind: refusalInv.failure_kind, state: refusalInv.breaker_state }));
    check("10b. the failure that TRIPPED the breaker records the resulting OPEN state", !!openInv.invocation_id && openInv.breaker_state?.failure_count === 2 && openInv.breaker_state?.threshold === 2, JSON.stringify(openInv.breaker_state || {}));
    const retryInv = rows.filter((r) => r.integration_name === "retried");
    check("10c. a retried logical call is still ONE invocation with attempts=3", retryInv.length === 2 && retryInv.every((r) => r.attempts === 3) && retryInv.some((r) => r.breaker_state?.state === "OPEN"), JSON.stringify(retryInv.map((r) => ({ attempts: r.attempts, state: r.breaker_state?.state }))));
    const recoveredInv = rows.filter((r) => r.integration_name === "down" && r.ok === true)[0] || {};
    check("10d. the successful probe records the CLOSED state it produced", recoveredInv.breaker_state?.state === "CLOSED" && recoveredInv.attempts === 1, JSON.stringify(recoveredInv.breaker_state || {}));
    const limitedInv = rows.filter((r) => r.integration_name === "limited")[0] || {};
    check("10e. a 429 invocation keeps its rate-limit state and claims no breaker failure", limitedInv.error_category === "rate_limit" && limitedInv.rate_limit_state?.limited === true && (limitedInv.breaker_state?.state || "CLOSED") === "CLOSED", JSON.stringify({ category: limitedInv.error_category, breaker: limitedInv.breaker_state }));

    // ---- 11. trace correlation through the EXISTING tracing system ----
    const spans = (await svc.entities.TraceEvent.filter({ trace_id: TRACE, project_id: project.id }, "at", 300)).filter((s) => s.event_type === "integration_call");
    check("11a. every invocation still writes exactly one span in the existing trace", spans.length === rows.length && spans.every((s) => s.trace_id === TRACE), `${spans.length} span(s) for ${rows.length} invocation(s)`);
    const downSpans = spans.filter((s) => s.name === "down.go" && s.status === "error");
    const refusalSpan = downSpans.filter((s) => s.attempt === 0)[0];
    check("11b. a refused call's span is an error with attempt 0 and no host contact claimed", !!refusalSpan && refusalSpan.error_code === "UPSTREAM_FAILURE" && refusalSpan.metadata?.error_category === "upstream", JSON.stringify({ code: refusalSpan?.error_code, attempt: refusalSpan?.attempt, seen: downSpans.map((s) => ({ a: s.attempt, m: s.metadata?.attempts, c: s.error_code })) }));
    check("11c. no second correlation id or health system is minted", rows.every((r) => r.trace_id === TRACE), "one trace id");

    // ---- 12. the breaker can be disabled, leaving prior behaviour exactly as it was ----
    for (let i = 0; i < 3; i++) await run(project, `off${i}`, CALL("off", "go"), [off]);
    const offRow = await state(project, "off");
    check("12. with the breaker disabled no state is kept and every call is attempted", offRow === null && hits["api.example.com/v1/down"] > 0, `row=${offRow ? "present" : "none"}`);
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    globalThis.fetch = realFetch;
    setDnsLookupForTests(null);
    clearOAuthCache();
    for (const p of [project, other]) {
      if (!p) continue;
      for (const entity of ["IntegrationBreaker", "IntegrationRateLimit", "IntegrationInvocation", "TraceEvent", "AuditLog", "FunctionInvocation"]) {
        const rows = await svc.entities[entity].filter({ project_id: p.id }, "-created_date", 300).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}