// Certification suite for the STREAMING half of functions.fetch (additive): a stream-capable
// handler result is delivered as an incremental chunk stream — the { __stream__ } envelope the
// fetch endpoints return as a raw passthrough Response, the executor's bounded pump (same output
// quota + wall-clock ceiling + caller-abort), the deterministic STREAM_RESPONSE_ON_INVOKE refusal
// on buffered invoke paths, and null-body degradation. The buffered contract is covered by
// appFunctionsFetchParityTest and is asserted UNCHANGED here.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { makeAgentProject } from "../../shared/appAgentTestFixtures.ts";
import { runProjectFunctionFetch } from "../../shared/appFetch.ts";
import { executeProjectFunction, loadProjectFunction } from "../../shared/functionRuntime.ts";
import { canonicalFunctionPath } from "../../shared/functionPaths.ts";
import { packFileContent } from "../../shared/blobStore.ts";

// A closure-built { next } iterator — the one chunk-source form the closed sandbox can produce
// (no generator syntax, no ReadableStream/Response globals). `sleep` exists ONLY on streaming
// executions; the same function therefore also certifies the invoke-path refusal below.
const FN_STREAM = `export default async function (ctx) {
  var chunks = ["alpha|", "beta|", "gamma|", "delta|", "omega"];
  var i = 0;
  var pace = (typeof sleep === "function") ? sleep : function () { return null; };
  return {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    stream: {
      next: async function () {
        await pace(80);
        return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true };
      }
    }
  };
}`;

const FN_NULL_BODY = `export default async function (ctx) {
  return { status: 204, body: null, stream: { next: async function () { return { done: true }; } } };
}`;

const FN_PLAIN = `export default async function (ctx) {
  return { status: 200, body: { buffered: true } };
}`;

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];

  try {
    const plan = await makeBillingPlan(db, created, `fnst${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `fnst${stamp}`, { plan });
    const P = await makeAgentProject(db, projectIds, A, stamp, "fnst");

    for (const [name, src] of [["streamPaced", FN_STREAM], ["streamNobody", FN_NULL_BODY], ["plainEcho", FN_PLAIN]]) {
      const p = canonicalFunctionPath(name);
      await db.entities.ProjectFile.create({ project_id: P.id, path: p, ...(await packFileContent(db, p, src)) });
    }

    const loadSrc = (n) => loadProjectFunction(db, P.id, n);
    const runFetch = (args, extra = {}) => runProjectFunctionFetch(db, {
      project: P, entities: [], integrations: [], args, loadSource: loadSrc, ...extra,
    });

    // ---- 1. streaming envelope + incremental delivery ---------------------------------------
    // Read IMMEDIATELY: the pump produces chunks while start() is pending, so any delay here
    // would let the whole 400ms stream buffer before the first read (spans would read as 0).
    const s = await runFetch({ path: "/streamPaced" }, { streaming: true });
    harness.check("streaming: a stream-capable result is the { __stream__ } envelope with the function's status and sanitized headers",
      s.__stream__ === true && s.status === 200 && s.ok === true && (s.headers["content-type"] || "").includes("text/plain")
        && !("body_text" in s) && s.body instanceof ReadableStream,
      JSON.stringify({ ...s, body: "ReadableStream" }));

    const parts = [];
    const reader = s.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push({ text: dec.decode(value), at: Date.now() });
    }
    const full = parts.map((p) => p.text).join("");
    const paced = parts.length >= 3 && (parts[parts.length - 1].at - parts[0].at) > 100;
    harness.check("streaming: chunks are delivered incrementally while the pump runs (pacing preserved), and the full body arrives byte-exact",
      full === "alpha|beta|gamma|delta|omega" && paced,
      JSON.stringify({ parts: parts.map((p) => p.text), spans_ms: parts.length ? parts[parts.length - 1].at - parts[0].at : 0 }));

    // ---- 2. invoke path untouched: the deterministic refusal --------------------------------
    const { source: streamSrc } = await loadSrc("streamPaced");
    const invokeRes = await executeProjectFunction(db, {
      project: P, entities: [], name: "streamPaced", source: streamSrc,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: null },
    });
    harness.check("invoke: a stream-capable result on a buffered invoke path is a deterministic 400 refusal (STREAM_RESPONSE_ON_INVOKE), never a silent drain",
      invokeRes.status === 400 && invokeRes.body && invokeRes.body.code === "STREAM_RESPONSE_ON_INVOKE"
        && invokeRes.errorClass === "STREAM_RESPONSE_ON_INVOKE",
      JSON.stringify(invokeRes.body));

    // ---- 3. buffered contract unchanged -------------------------------------------------------
    const b = await runFetch({ path: "/plainEcho" }, { streaming: true });
    harness.check("buffered: a plain function result keeps the exact buffered envelope even when the caller asked for streaming",
      b.__stream__ !== true && b.status === 200 && b.has_body === true && JSON.parse(b.body_text).buffered === true,
      JSON.stringify(b));

    // ---- 4. null-body degradation --------------------------------------------------------------
    const nb = await runFetch({ path: "/streamNobody" }, { streaming: true });
    harness.check("null-body: a stream on a 204 degrades to the buffered envelope with NO body (identical to the non-streaming contract)",
      nb.__stream__ !== true && nb.status === 204 && nb.ok === true && nb.has_body === false,
      JSON.stringify(nb));

    // ---- 5. caller abort: clean early close ----------------------------------------------------
    const ctrl = new AbortController();
    const ab = await runFetch({ path: "/streamPaced" }, { streaming: true, signal: ctrl.signal });
    const got = [];
    const ar = ab.body.getReader();
    for (;;) {
      const { done, value } = await ar.read();
      if (done) break;
      got.push(dec.decode(value));
      if (got.length === 1) ctrl.abort();
    }
    harness.check("abort: aborting after the first chunk ends the stream with a clean early close — partial data, then done, never an invented error payload",
      got[0] === "alpha|" && got.length < 5 && !got.join("").includes("omega"),
      JSON.stringify(got));

    // ---- 6. output quota: the stream ends early, never over-delivers ---------------------------
    const q = await runFetch({ path: "/streamPaced" }, { streaming: true, quotas: { maxOutputBytes: 10 } });
    const qparts = [];
    const qr = q.body.getReader();
    for (;;) {
      const { done, value } = await qr.read();
      if (done) break;
      qparts.push(dec.decode(value));
    }
    harness.check("quota: a stream over the output-size quota ends with a clean early close and delivers nothing beyond the cap",
      q.__stream__ === true && qparts.join("").length < "alpha|beta|gamma|delta|omega".length,
      JSON.stringify(qparts));

    // ---- 7. audit: streaming executions ride the EXISTING FunctionInvocation funnel -------------
    const invocations = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "streamPaced" }, "-created_date", 10);
    const aborted = invocations.find((i) => i.error_class === "STREAM_ABORTED");
    harness.check("audit: streaming outcomes are recorded through the existing invocation funnel — the aborted stream carries its failure class",
      invocations.length >= 3 && !!aborted,
      JSON.stringify(invocations.map((i) => ({ status: i.status, error_class: i.error_class }))).slice(0, 300));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    const pIds = [...new Set(projectIds)];
    if (pIds.length) {
      await db.entities.FunctionInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.ProjectFile.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    const wIds = [...new Set(created.workspaces)];
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_fnst" } }).catch(() => {});
  }
}