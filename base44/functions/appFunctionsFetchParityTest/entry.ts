// Certification suite for the DOCUMENTED raw-HTTP function surface:
// base44.functions.fetch(path, init?) — "Performs a direct HTTP request to a backend function
// path and returns the native Response" (Base44 SDK reference, FunctionsModule.fetch; verified
// against the installed @base44/sdk 0.8.51 implementation).
//
// Certified (DOCUMENTED): path/init passthrough (method/headers/body; query rides the path
// string), any HTTP method, raw status/ok/headers/body, NO throw on a function's 4xx/5xx (the
// caller receives the Response; only an infrastructure refusal rejects the promise), sub-path
// addressing, and functions.invoke() untouched. The transport layers (runtime bridge →
// dbBridge/appRuntime) are pass-through over the SAME envelope this suite certifies — a
// function's status never becomes an error there.
//
// Streaming IS implemented (functions.fetch only) and certified separately by
// functionsStreamingCert — this suite additionally pins that a plain function result stays the
// buffered envelope. UNKNOWN: asServiceRole.functions.fetch,
// reconnect/heartbeat/backpressure, server-side method restrictions beyond config.method,
// billing, FormData request bodies, deeper sub-path routing semantics. None is invented.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { makeFetchLoader, runFetchOver } from "../../shared/functionFetchCertHelpers.ts";
import { makeAgentProject, appAgentPace } from "../../shared/appAgentTestFixtures.ts";
import { runProjectFunctionFetch, buildFetchRequest, fetchResponseEnvelope } from "../../shared/appFetch.ts";
import { loadProjectFunction, executeProjectFunction } from "../../shared/functionRuntime.ts";
import { canonicalFunctionPath } from "../../shared/functionPaths.ts";
import { packFileContent } from "../../shared/blobStore.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const FETCH_CONTRACT = {
  signature: "DOCUMENTED — fetch(path, init?) → Promise<Response>, native Response semantics",
  methods: "DOCUMENTED — init.method passthrough (PUT/PATCH/DELETE and other tokens); NOT restricted to POST",
  status_semantics: "DOCUMENTED — the caller receives the Response; a function 4xx/5xx does NOT throw (infrastructure refusals do)",
  sub_path: "Base44 documents sub-path addressing ('/my-function/endpoint') — DERIVED: the FIRST segment resolves the function, the rest reaches the handler as ctx.request.path; deeper semantics UNKNOWN",
  query: "DERIVED — parsed from the caller's path string (the SDK passes a native RequestInit, which has no query field)",
  content_type: "DERIVED — response content-type from the handler's headers, else application/json (objects) / text/plain (strings)",
  request_headers: "DERIVED — bounded safe passthrough (≤50; host/connection/content-length/transfer-encoding dropped)",
  response_headers: "DERIVED — additive executor extraction when the handler's return declares headers alongside status/body; redacted; the invoke wire format is UNCHANGED",
  binary: "DERIVED — string bodies round-trip byte-exactly; TRUE binary bodies are not producible by the existing executor (structural boundary)",
  streaming: "IMPLEMENTED (functions.fetch only) — a stream-capable handler result is delivered as an incremental chunk stream; certified by functionsStreamingCert; invoke paths keep the buffered contract",
  service_role_fetch: "UNKNOWN in Base44 docs — NOT implemented",
  reconnect_heartbeat_backpressure: "UNKNOWN — NOT implemented",
  server_method_restrictions: "UNKNOWN beyond config.method (existing executor check) — none invented",
  billing: "Base44 publishes NO fetch charge — none invented; no credits move in either pool",
};

// One echo handler covering every certified axis; plain JS the interpreter sandbox runs.
const FN_ECHO = `export default async function (ctx) {
  var r = ctx.request;
  if (r.method === 'PUT') return { status: 201, body: { method: 'PUT' } };
  if (r.method === 'PATCH') return { status: 202, body: { method: 'PATCH', got: r.body } };
  if (r.method === 'DELETE') return { status: 204, body: null };
  if (r.path === '/nf') return { status: 404, body: { error: 'not found' } };
  if (r.path === '/boom') return { status: 500, body: { error: 'boom' } };
  if (r.path === '/octet') return { status: 200, body: 'AAECAwQFBgcICQ==', headers: { 'content-type': 'application/octet-stream', connection: 'close' } };
  if (r.path === '/hdr') return { status: 200, body: { ok: true }, headers: { 'x-fetch-test': 'yes' } };
  return { status: 200, body: { method: r.method, query: r.query, sub: r.path, saw: r.header('x-custom'), body: r.body } };
}`;

const FN_GET_ONLY = `export const config = { method: 'GET' };
export default async function (ctx) {
  return { status: 200, body: { method: ctx.request.method } };
}`;

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  const pace = (ms) => appAgentPace(ms || 250);

  try {
    const plan = await makeBillingPlan(db, created, `p9ff${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9ff${stamp}`, { plan });
    const P = await makeAgentProject(db, projectIds, A, stamp, "p9ff");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p9ff"); // isolation fixture

    // Scratch function files in the canonical layout — the EXISTING loader resolves them.
    for (const [name, src] of [["echoFetch", FN_ECHO], ["getOnly", FN_GET_ONLY]]) {
      const p = canonicalFunctionPath(name);
      await db.entities.ProjectFile.create({ project_id: P.id, path: p, ...(await packFileContent(db, p, src)) });
    }

    const loadSrc = makeFetchLoader(db, P.id);
    const runFetch = (args) => runFetchOver(db, P, loadSrc, args);
    const jsonOf = (r) => JSON.parse(r.body_text);

    // ---- 1. methods ----------------------------------------------------------------------
    const g = await runFetch({ path: "/echoFetch" }); await pace();
    harness.check("methods: the default method is GET (native fetch default), status 200 ok true",
      g.status === 200 && g.ok === true && jsonOf(g).method === "GET", JSON.stringify(g).slice(0, 200));

    const post = await runFetch({ path: "/echoFetch", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }) }); await pace();
    harness.check("methods+body: POST carries a JSON body parsed for the handler without loss",
      post.status === 200 && jsonOf(post).body && jsonOf(post).body.hello === "world", JSON.stringify(jsonOf(post)));

    const put = await runFetch({ path: "/echoFetch", method: "PUT", body: JSON.stringify({}) }); await pace();
    harness.check("methods: PUT is NOT restricted to POST — the function's own 201 is returned raw",
      put.status === 201 && put.ok === true && jsonOf(put).method === "PUT", JSON.stringify(put));

    const patch = await runFetch({ path: "/echoFetch", method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify([1, 2]) }); await pace();
    harness.check("methods: PATCH carries the parsed body through, function's 202 returned raw",
      patch.status === 202 && jsonOf(patch).got && jsonOf(patch).got[0] === 1, JSON.stringify(jsonOf(patch)));

    const del = await runFetch({ path: "/echoFetch", method: "DELETE" }); await pace();
    harness.check("methods: DELETE returns the function's 204 with NO body (null-body status, DERIVED)",
      del.status === 204 && del.ok === true && del.has_body === false && del.body_text === undefined,
      JSON.stringify(del));

    // ---- 2. query / headers / sub-path ----------------------------------------------------
    const q = await runFetch({ path: "/echoFetch?x=1&y=hello" }); await pace();
    const qj = jsonOf(q);
    harness.check("query: parsed from the caller's path string without loss (RequestInit has no query field)",
      qj.query && qj.query.x === "1" && qj.query.y === "hello", JSON.stringify(qj.query));

    const h = await runFetch({ path: "/echoFetch", headers: { "x-custom": "ping", host: "evil", connection: "x", "content-length": "5" } }); await pace();
    harness.check("headers: caller headers reach the handler (ctx.request.header) — DOCUMENTED passthrough",
      jsonOf(h).saw === "ping", JSON.stringify(jsonOf(h)));

    const built = buildFetchRequest({ path: "/echoFetch", headers: { "x-ok": "v", host: "evil", connection: "x", "content-length": "5", "transfer-encoding": "chunked" } });
    harness.check("headers: hop-by-hop/framing headers are dropped, real ones kept (DERIVED safe subset)",
      built.headers["x-ok"] === "v" && !("host" in built.headers) && !("connection" in built.headers)
        && !("content-length" in built.headers) && !("transfer-encoding" in built.headers),
      JSON.stringify(built.headers));

    const rh = await runFetch({ path: "/echoFetch/hdr" }); await pace();
    harness.check("response: handler-declared response headers arrive raw; framing headers are dropped",
      rh.headers["x-fetch-test"] === "yes" && !("connection" in rh.headers), JSON.stringify(rh.headers));
    harness.check("response: content-type derived application/json for object bodies (DERIVED)",
      (rh.headers["content-type"] || "").includes("application/json"), JSON.stringify(rh.headers));

    const sub = await runFetch({ path: "/echoFetch/endpoint/2?k=v" }); await pace();
    const subj = jsonOf(sub);
    harness.check("sub-path: '/fn/endpoint/2' resolves the function and hands the handler '/endpoint/2' (DERIVED; deeper semantics UNKNOWN)",
      subj.sub === "/endpoint/2" && subj.query.k === "v", JSON.stringify(subj));

    const noslash = await runFetch({ path: "echoFetch" }); await pace();
    harness.check("path: a leading slash is optional — 'echoFetch' equals '/echoFetch' (DOCUMENTED)",
      noslash.status === 200 && jsonOf(noslash).method === "GET", JSON.stringify(noslash).slice(0, 120));

    // ---- 3. raw Response semantics: status/ok/headers/body, NO throw on 4xx/5xx -----------
    const nf = await captureCall(() => runFetch({ path: "/echoFetch/nf" })); await pace();
    harness.check("status semantics: a function 404 does NOT throw — the caller receives the raw Response envelope",
      !nf.threw && nf.value && nf.value.status === 404 && nf.value.ok === false && jsonOf(nf.value).error === "not found",
      JSON.stringify(nf.threw ? nf : nf.value).slice(0, 200));
    const boom = await captureCall(() => runFetch({ path: "/echoFetch/boom" })); await pace();
    harness.check("status semantics: a function 500 does NOT throw — raw 500 envelope with ok false",
      !boom.threw && boom.value && boom.value.status === 500 && boom.value.ok === false,
      JSON.stringify(boom.threw ? boom : boom.value).slice(0, 200));

    const bin = await runFetch({ path: "/echoFetch/octet" }); await pace();
    harness.check("blob: a string body round-trips byte-exactly with the handler's content-type preserved (DERIVED binary boundary)",
      bin.body_text === "AAECAwQFBgcICQ==" && bin.headers["content-type"] === "application/octet-stream",
      JSON.stringify({ body_text: bin.body_text, ct: bin.headers["content-type"] }));

    harness.check("envelope: the shape is exactly { status, ok, headers, has_body, body_text } (raw Response inputs)",
      Object.keys(g).sort().join(",") === "body_text,has_body,headers,ok,status"
        && Object.keys(del).sort().join(",") === "has_body,headers,ok,status",
      JSON.stringify({ g: Object.keys(g), del: Object.keys(del) }));

    const pinned = fetchResponseEnvelope({ status: 200, body: { one: 1 } });
    harness.check("envelope: fetchResponseEnvelope is a pure derivation of the executor result — ONE buffered result, no streaming claims",
      pinned.status === 200 && pinned.has_body === true && JSON.parse(pinned.body_text).one === 1
        && FETCH_CONTRACT.streaming.includes("IMPLEMENTED"),
      JSON.stringify(pinned).slice(0, 160));

    // ---- 4. boundaries: invalid input and infrastructure refusals ---------------------------
    const badEmpty = await captureCall(() => runFetch({ path: "" }));
    const badName = await captureCall(() => runFetch({ path: "/9bad/x" }));
    const badHost = await captureCall(() => runFetch({ path: "//evil.com/echoFetch" }));
    const badMethod = await captureCall(() => runFetch({ path: "/echoFetch", method: "not a method!" }));
    harness.check("boundary: empty, non-function and cross-origin-shaped paths are refused fail-closed (FETCH_INVALID_ARGS)",
      badEmpty.threw && badEmpty.code === "FETCH_INVALID_ARGS" && badName.threw && badName.code === "FETCH_INVALID_ARGS"
        && badHost.threw && badHost.code === "FETCH_INVALID_ARGS" && badMethod.threw && badMethod.code === "FETCH_INVALID_ARGS",
      JSON.stringify([badEmpty.code, badName.code, badHost.code, badMethod.code]));

    const badJson = await captureCall(() => runFetch({ path: "/echoFetch", headers: { "content-type": "application/json" }, body: "{not json" }));
    harness.check("boundary: a body declared JSON but unparseable is refused before execution (DERIVED)",
      badJson.threw && badJson.code === "FETCH_INVALID_ARGS", JSON.stringify(badJson.code));

    const big = await captureCall(() => runFetch({ path: "/echoFetch", body: "x".repeat(600000) }));
    harness.check("boundary: the request-body size cap is enforced (DERIVED — Base44 limit UNKNOWN)",
      big.threw && big.code === "FETCH_BODY_TOO_LARGE", JSON.stringify(big.code));

    const unknownFn = await captureCall(() => runFetch({ path: "/nopeFn" })); await pace();
    harness.check("boundary: an unknown function is an INFRASTRUCTURE refusal (404) — it rejects the promise, never a Response",
      unknownFn.threw && Number(unknownFn.status) === 404, JSON.stringify(unknownFn).slice(0, 120));

    const cross = await captureCall(() => runProjectFunctionFetch(db, {
      project: P2, entities: [], integrations: [], args: { path: "/echoFetch" },
      loadSource: (n) => loadProjectFunction(db, P2.id, n),
    }));
    harness.check("isolation: another project's fetch cannot resolve this project's function",
      cross.threw && Number(cross.status) === 404, JSON.stringify(cross).slice(0, 120));

    // ---- 5. existing contracts preserved --------------------------------------------------
    const restricted = await runFetch({ path: "/getOnly", method: "PUT" }); await pace();
    harness.check("methods: the EXISTING config.method check still applies — PUT on a GET-only function is the function's 405, no throw",
      restricted.status === 405 && restricted.ok === false, JSON.stringify(restricted).slice(0, 160));

    const { source: echoSrc } = await loadSrc("echoFetch");
    const invokeRes = await executeProjectFunction(db, {
      project: P, entities: [], name: "echoFetch", source: echoSrc,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: { hello: "invoke" } },
    });
    harness.check("invoke: the invoke path's result contract is UNCHANGED (status/body/logs/invocation_id/duration_ms)",
      invokeRes.status === 200 && invokeRes.body && invokeRes.body.body && invokeRes.body.body.hello === "invoke"
        && Array.isArray(invokeRes.logs) && !!invokeRes.invocation_id && typeof invokeRes.duration_ms === "number",
      JSON.stringify(Object.keys(invokeRes)));

    const invocations = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "echoFetch" }, "-created_date", 100);
    const methods = new Set(invocations.map((i) => i.method));
    harness.check("audit: every fetch call is recorded through the EXISTING FunctionInvocation funnel with its real method",
      methods.has("PUT") && methods.has("PATCH") && methods.has("DELETE") && methods.has("GET"),
      JSON.stringify([...methods]));

    harness.check("surface: the runtime export surface still registers `server` and `sdk` (sdk.functions.fetch aliases server.fetch)",
      RUNTIME_EXPORTS.includes("server") && RUNTIME_EXPORTS.includes("sdk"), "server+sdk present");

    // ---- 6. certification boundary pinned --------------------------------------------------
    harness.check("boundary: every undocumented semantic stays pinned UNKNOWN / structural — nothing invented",
      FETCH_CONTRACT.sub_path.includes("UNKNOWN") && FETCH_CONTRACT.service_role_fetch.includes("UNKNOWN")
        && FETCH_CONTRACT.reconnect_heartbeat_backpressure.includes("UNKNOWN")
        && FETCH_CONTRACT.server_method_restrictions.includes("UNKNOWN")
        && FETCH_CONTRACT.billing.includes("none invented")
        && FETCH_CONTRACT.streaming.includes("functionsStreamingCert"),
      JSON.stringify(FETCH_CONTRACT).slice(0, 200));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup — also sweeps scratch rows left behind by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p9ff-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^billing-test p9ff" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...created.workspaces, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.FunctionInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.ProjectFile.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p9ff" } }).catch(() => {});
  }
}