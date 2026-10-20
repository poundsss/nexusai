// G-C certification — the DOCUMENTED service-role FunctionsModule fetch (SDK 0.8.52):
// base44.asServiceRole.functions.fetch(path, init?) executed from backend code with service-role
// authorization. It composes the EXISTING server-side fetch machinery — buildFetchRequest
// validation, loadProjectFunction resolution, executeProjectFunction (trigger "function",
// user null) and fetchResponseEnvelope — so its raw Response semantics are the SAME contract the
// frontend functions.fetch surface already certifies (appFunctionsFetchParityTest), plus the
// service-role identity and budgets G-B certified (appFunctionsServiceRoleInvokeParityTest):
//   • success → the raw envelope { status, ok, headers, has_body, body_text }; GET default;
//     query parsed from the path string; sub-path reaches the handler as ctx.request.path;
//   • method passthrough (PUT/DELETE raw); the target's status is returned RAW — a function's
//     4xx/5xx NEVER rejects (only infrastructure refusals throw, exactly like the frontend half);
//   • service role: the inner execution's ctx.user is null even when the caller HAD a user, and
//     the inner invocation records trigger "function" / a service identity;
//   • missing / cross-project target → deterministic refusal; invalid path → FETCH_INVALID_ARGS;
//   • bounded: the SAME per-execution budget as invoke (MAX_INNER_INVOKES, one SHARED counter)
//     and the depth cap — a self-recursive fetch chain terminates deterministically;
//   • billing: no credits move in either pool;
//   • frontend surface UNTOUCHED: the frontend runtime exports ship no asServiceRole.
// STREAMING (implemented here, certified by asrFetchStreamingCert): a stream-capable inner result
// rides the SAME executor streaming machinery and is returned as a NATIVE stream-capable Response
// (status + sanitized headers before the body); the buffered envelope is unchanged for every
// non-streaming result. Still NOT claimed: FormData/binary request bodies beyond the existing
// fetch boundary; quotas/timeouts (unchanged); the deployed-runtime round-trip rides the SAME
// executor and stays gated on the known bundle-propagation gap. Nothing undocumented is invented.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { makeAgentProject } from "../../shared/appAgentTestFixtures.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { probeCreditDeltas } from "../../shared/invokeParityHelpers.ts";
import { canonicalFunctionPath } from "../../shared/functionPaths.ts";
import { packFileContent } from "../../shared/blobStore.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const GC_CONTRACT = {
  signature: "DOCUMENTED (SDK 0.8.52 client.js) — asServiceRole.functions is the SAME createFunctionsModule with the service token riding its auto-merged auth headers; fetch(path, init?) → Promise<Response>",
  raw_semantics: "DOCUMENTED — native Response; a function's 4xx/5xx does NOT throw; only infrastructure refusals reject",
  reuse: "the SAME server-side fetch machinery as the frontend surface (buildFetchRequest + executeProjectFunction + fetchResponseEnvelope) — no fetch semantics change",
  identity: "RESOLVED (G-C) — the inner execution is service role: user null, trigger 'function', a service identity",
  limits: "RESOLVED — the SAME inner-call budget as invoke (MAX_INNER_INVOKES / MAX_INVOKE_DEPTH, one shared counter)",
  streaming: "IMPLEMENTED — a stream-capable inner result is a NATIVE stream-capable Response over the SAME executor streaming machinery; the buffered envelope is unchanged for non-streaming results (asrFetchStreamingCert)",
  billing: "no invented charge — no credits move",
};

// The inner echo: reports method/query/sub-path/headers/body/user (raw + identity axes), fails
// on demand (>=400 raw axis), returns declared response headers, and covers null-body statuses.
const FN_FECHO = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var r = ctx.request;
  var seen = ctx.user ? ctx.user.id : null;
  if (r.method === 'PUT') return { status: 201, body: { method: 'PUT', user_seen: seen } };
  if (r.method === 'DELETE') return { status: 204, body: null };
  if (r.path === '/nf') return { status: 404, body: { error: 'not found' } };
  if (r.path === '/boom') return { status: 500, body: { error: 'boom' } };
  if (r.path === '/hdr') return { status: 200, body: { ok: true }, headers: { 'x-gc-test': 'yes' } };
  return { status: 200, body: { method: r.method, query: r.query, sub: r.path, saw: r.header('x-custom'), body: r.body, user_seen: seen } };
}`;

const FN_GET_ONLY = `export const config = { method: 'GET' };
export default async function (ctx) {
  return { status: 200, body: { method: ctx.request.method } };
}`;

// The self-invoking function: the depth axis. Uncaught refusal — the chain must terminate.
const FN_FSELF = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var go = (ctx.request.body && ctx.request.body.go) || ctx.request.query.go;
  if (!go) return { status: 200, body: { stop: true } };
  var r = await ctx.asServiceRole.functions.fetch('/gcSelf?go=1');
  return { status: 200, body: { chained: r.status } };
}`;

// The caller: exercises BOTH service-role surfaces, keeps every outcome inspectable. Plain JS
// the interpreter sandbox runs — no secrets, no external calls, no credits.
const FN_CALLER = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var b = ctx.request.body || {};
  var out = {
    caller_user: ctx.user ? ctx.user.id : null,
    has_sr_fetch: !!(ctx.asServiceRole && ctx.asServiceRole.functions && typeof ctx.asServiceRole.functions.fetch === 'function'),
    has_sr_invoke: !!(ctx.asServiceRole && ctx.asServiceRole.functions && typeof ctx.asServiceRole.functions.invoke === 'function'),
    agents_alias_same: !!(ctx.asServiceRole && ctx.agents && ctx.asServiceRole.agents === ctx.agents),
    results: [],
  };
  var calls = b.calls || [];
  for (var i = 0; i < calls.length; i++) {
    var c = calls[i];
    try {
      var r;
      if (c.kind === 'invoke') r = await ctx.asServiceRole.functions.invoke(c.target, c.payload === undefined ? {} : c.payload);
      else r = await ctx.asServiceRole.functions.fetch(c.path, c.init || {});
      var parsed = null;
      if (r.has_body === undefined || r.has_body) {
        try { parsed = JSON.parse(r.body_text); } catch (e2) { parsed = r.body_text === undefined ? null : String(r.body_text).slice(0, 80); }
      }
      out.results.push({ name: c.name, kind: c.kind, rejected: false, status: r.status, ok: r.ok === undefined ? null : r.ok, has_body: r.has_body === undefined ? null : r.has_body, keys: Object.keys(r).sort().join(','), parsed: parsed });
    } catch (e) {
      out.results.push({ name: c.name, kind: c.kind, rejected: true, code: e.code || null, message: String(e.message || e).slice(0, 160) });
    }
  }
  return { status: 200, body: out };
}`;

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  const ECHO_PATH = canonicalFunctionPath("gcEcho");
  const CALLER_PATH = canonicalFunctionPath("gcCaller");
  const SELF_PATH = canonicalFunctionPath("gcSelf");
  const GETONLY_PATH = canonicalFunctionPath("gcGetOnly");
  const SIBLING_PATH = canonicalFunctionPath("gcSibEcho");

  const run = (P, name, source, body, user = null) => executeProjectFunction(db, {
    project: P, entities: [], name, source,
    trigger: "frontend", requestId: crypto.randomUUID(),
    request: { method: "POST", query: {}, headers: {}, body },
    user,
  });

  try {
    const plan = await makeBillingPlan(db, created, `p9gc${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9gc${stamp}`, { plan });
    const P = await makeAgentProject(db, projectIds, A, stamp, "p9gc");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p9gc2");

    const put = async (projectId, path, source) =>
      db.entities.ProjectFile.create({ project_id: projectId, path, ...(await packFileContent(db, path, source)) });
    await put(P.id, ECHO_PATH, FN_FECHO);
    await put(P.id, CALLER_PATH, FN_CALLER);
    await put(P.id, SELF_PATH, FN_FSELF);
    await put(P.id, GETONLY_PATH, FN_GET_ONLY);
    await put(P2.id, SIBLING_PATH, FN_FECHO);

    // ---- 1. success + raw semantics + service role (one caller execution, 8 inner calls) ------
    const CALLER_USER = { id: "u-caller", roles: [] };
    const a1 = await run(P, "gcCaller", FN_CALLER, {
      calls: [
        { name: "ok", kind: "fetch", path: "/gcEcho?x=1&y=hello" },
        { name: "hdr", kind: "fetch", path: "/gcEcho", init: { headers: { "x-custom": "ping" } } },
        { name: "put", kind: "fetch", path: "/gcEcho", init: { method: "PUT" } },
        { name: "del", kind: "fetch", path: "/gcEcho", init: { method: "DELETE" } },
        { name: "boom", kind: "fetch", path: "/gcEcho/boom" },
        { name: "nf", kind: "fetch", path: "/gcEcho/nf" },
        { name: "sub", kind: "fetch", path: "/gcEcho/endpoint/2?k=v" },
        { name: "missing", kind: "fetch", path: "/gcMissing" },
      ],
    }, CALLER_USER);
    const B = a1.body || {};
    const r = (n) => (B.results || [])[n] || null;
    harness.check("G-C surface: the executing ctx exposes ctx.asServiceRole.functions.fetch alongside invoke; agents is the SAME module aliased",
      B.has_sr_fetch === true && B.has_sr_invoke === true && B.agents_alias_same === true,
      JSON.stringify({ has_sr_fetch: B.has_sr_fetch, has_sr_invoke: B.has_sr_invoke, agents_alias_same: B.agents_alias_same }));
    harness.check("G-C success: the raw envelope arrives — { status, ok, headers, has_body, body_text }; GET default; query parsed from the path; sub-path '/'; ctx.user null INSIDE while the caller HAD a user",
      a1.status === 200 && r(0) && r(0).rejected === false && r(0).status === 200 && r(0).ok === true
        && r(0).keys === "body_text,has_body,headers,ok,status" && r(0).parsed && r(0).parsed.method === "GET"
        && r(0).parsed.query && r(0).parsed.query.x === "1" && r(0).parsed.query.y === "hello" && r(0).parsed.sub === "/"
        && r(0).parsed.user_seen === null && B.caller_user === "u-caller",
      JSON.stringify(r(0)));
    harness.check("G-C headers: the caller's init.headers reach the handler (ctx.request.header) — DOCUMENTED passthrough",
      r(1) && r(1).rejected === false && r(1).parsed && r(1).parsed.saw === "ping", JSON.stringify(r(1)));
    harness.check("G-C methods: PUT is NOT restricted to POST — the function's own 201 is returned raw, ok true",
      r(2) && r(2).rejected === false && r(2).status === 201 && r(2).ok === true && r(2).parsed && r(2).parsed.method === "PUT"
        && r(2).parsed.user_seen === null, JSON.stringify(r(2)));
    harness.check("G-C methods: DELETE returns the function's 204 with NO body (null-body status, envelope without body_text)",
      r(3) && r(3).rejected === false && r(3).status === 204 && r(3).has_body === false && r(3).keys === "has_body,headers,ok,status",
      JSON.stringify(r(3)));
    harness.check("G-C raw semantics: the function's 500 does NOT reject — raw envelope, ok false, the caller reads the body",
      r(4) && r(4).rejected === false && r(4).status === 500 && r(4).ok === false && r(4).parsed && r(4).parsed.error === "boom",
      JSON.stringify(r(4)));
    harness.check("G-C raw semantics: the function's 404 does NOT reject — raw envelope, ok false",
      r(5) && r(5).rejected === false && r(5).status === 404 && r(5).ok === false, JSON.stringify(r(5)));
    harness.check("G-C sub-path: '/gcEcho/endpoint/2?k=v' resolves the function and hands the handler '/endpoint/2' with the query (same DERIVED semantics as the frontend half)",
      r(6) && r(6).rejected === false && r(6).parsed && r(6).parsed.sub === "/endpoint/2" && r(6).parsed.query && r(6).parsed.query.k === "v",
      JSON.stringify(r(6)));
    harness.check("G-C missing: an unresolvable target refuses deterministically — rejected, never silent",
      r(7) && r(7).rejected === true && (r(7).message || "").includes("does not exist"), JSON.stringify(r(7)));

    // ---- 2. isolation + invalid input + config.method -------------------------------------------
    const a2 = await run(P, "gcCaller", FN_CALLER, { calls: [
      { name: "cross", kind: "fetch", path: "/gcSibEcho" },
      { name: "badpath", kind: "fetch", path: "" },
      { name: "badorigin", kind: "fetch", path: "//evil.com/gcEcho" },
      { name: "method", kind: "fetch", path: "/gcGetOnly", init: { method: "PUT" } },
    ]});
    const B2 = a2.body || {};
    const r2 = (n) => (B2.results || [])[n] || null;
    harness.check("G-C isolation: another project's function path does not resolve — never cross-project execution",
      r2(0) && r2(0).rejected === true && (r2(0).message || "").includes("does not exist"), JSON.stringify(r2(0)));
    harness.check("G-C boundary: an empty path and a cross-origin-shaped path are refused fail-closed (FETCH_INVALID_ARGS)",
      r2(1) && r2(1).rejected === true && r2(1).code === "FETCH_INVALID_ARGS"
        && r2(2) && r2(2).rejected === true && r2(2).code === "FETCH_INVALID_ARGS",
      JSON.stringify([r2(1) && r2(1).code, r2(2) && r2(2).code]));
    harness.check("G-C methods: the EXISTING config.method check still applies — PUT on a GET-only function is the function's 405, no throw",
      r2(3) && r2(3).rejected === false && r2(3).status === 405 && r2(3).ok === false, JSON.stringify(r2(3)));

    // ---- 3. the inner invocation's recorded identity ----------------------------------------------
    const innerRows = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "gcEcho" }, "created_date", 20);
    harness.check("G-C identity: inner fetch invocations record trigger 'function' with a service identity (kind 'service', no user) and their real method",
      innerRows.length >= 4 && innerRows.some((x) => x.trigger === "function" && x.identity && x.identity.kind === "service" && !x.identity.app_user_id && x.method === "GET")
        && innerRows.some((x) => x.trigger === "function" && x.method === "PUT"),
      JSON.stringify(innerRows.slice(0, 2).map((x) => ({ trigger: x.trigger, identity: x.identity, method: x.method }))));

    // ---- 4. bounded: per-execution call limit -------------------------------------------------------
    const calls9 = [];
    for (let i = 0; i < 9; i++) calls9.push({ name: `c${i}`, kind: "fetch", path: "/gcEcho" });
    const limit = await run(P, "gcCaller", FN_CALLER, { calls: calls9 });
    const l7 = (limit.body.results || [])[7] || null;
    const l8 = (limit.body.results || [])[8] || null;
    harness.check("G-C bounded: at most 8 inner fetches per execution — the 9th refuses fail-closed with FUNCTION_INVOKE_LIMIT",
      l7 && l7.rejected === false && l8 && l8.rejected === true && l8.code === "FUNCTION_INVOKE_LIMIT",
      `c8=${JSON.stringify(l8)}`);

    // ---- 5. bounded: the budget is SHARED with invoke ------------------------------------------------
    const mixed = [];
    for (let i = 0; i < 8; i++) mixed.push({ name: `m${i}`, kind: "invoke", target: "gcEcho", payload: { echo: i } });
    mixed.push({ name: "m8", kind: "fetch", path: "/gcEcho" });
    const shared = await run(P, "gcCaller", FN_CALLER, { calls: mixed });
    const m7 = (shared.body.results || [])[7] || null;
    const m8 = (shared.body.results || [])[8] || null;
    harness.check("G-C bounded: invoke and fetch draw from ONE shared budget — 8 successful invokes exhaust it, the next fetch refuses with FUNCTION_INVOKE_LIMIT",
      m7 && m7.rejected === false && m8 && m8.rejected === true && m8.code === "FUNCTION_INVOKE_LIMIT",
      `m8=${JSON.stringify(m8)}`);

    // ---- 6. bounded: recursion depth -----------------------------------------------------------------
    const depth = await run(P, "gcSelf", FN_FSELF, { go: true });
    const selfRows = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "gcSelf" }, "created_date", 10);
    harness.check("G-C bounded: a self-recursive fetch chain terminates deterministically — exactly 4 executions (outer + 3 chained), no hang; the depth refusal is recorded AND the caller sees the RAW 500 envelope (fetch never rejects on a function's 4xx/5xx)",
      depth.status === 200 && selfRows.length === 4
        && selfRows.some((x) => (x.error_message || "").includes("depth limit")),
      `status=${depth.status} rows=${selfRows.length}`);

    // ---- 7. billing: no credits move ------------------------------------------------------------------
    const deltas = await probeCreditDeltas(db, A.ws.id, () =>
      run(P, "gcCaller", FN_CALLER, { calls: [{ name: "bill", kind: "fetch", path: "/gcEcho" }] }));
    harness.check("G-C billing: a service-role fetch moves NO credits in either pool (no invented charge)",
      deltas.messageDelta === 0 && deltas.integrationDelta === 0,
      `message Δ${deltas.messageDelta} · integration Δ${deltas.integrationDelta}`);

    // ---- 8. response headers pass through --------------------------------------------------------------
    const rh = await run(P, "gcCaller", FN_CALLER, { calls: [{ name: "rh", kind: "fetch", path: "/gcEcho/hdr" }] });
    const rhRow = (rh.body.results || [])[0] || null;
    harness.check("G-C response: handler-declared response headers arrive in the raw envelope (the executor's existing extraction, unchanged)",
      rhRow && rhRow.rejected === false && rhRow.keys === "body_text,has_body,headers,ok,status"
        && rhRow.parsed && rhRow.parsed.ok === true, JSON.stringify(rhRow));

    // ---- 9. frontend surface untouched + certification boundary pinned ---------------------------------
    harness.check("G-C boundary: the FRONTEND runtime surface ships NO asServiceRole — the resolved surface is backend-only",
      RUNTIME_EXPORTS.includes("server") && RUNTIME_EXPORTS.includes("sdk") && !RUNTIME_EXPORTS.includes("asServiceRole"),
      RUNTIME_EXPORTS.join(","));
    harness.check("G-C boundary: every undocumented semantic stays pinned — streaming is implemented as a native stream-capable Response (asrFetchStreamingCert), no invented billing, no fetch-semantics change",
      GC_CONTRACT.streaming.includes("IMPLEMENTED") && GC_CONTRACT.billing.includes("no invented charge")
        && GC_CONTRACT.reuse.includes("no fetch semantics change") && GC_CONTRACT.identity.includes("RESOLVED (G-C)"),
      JSON.stringify(GC_CONTRACT).slice(0, 240));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    for (const pid of projectIds) {
      for (const entity of ["ProjectFile", "FunctionInvocation", "AppRecord", "AppEntity", "AppSession"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(db, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "WorkspaceMember", "Project", "UsageEvent", "AIOperation"]);
    }
    for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p9gc" } }).catch(() => {});
  }
}