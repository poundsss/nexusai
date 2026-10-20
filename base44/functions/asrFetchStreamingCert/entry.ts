// G-C-S certification — the service-role FunctionsModule fetch STREAMING surface (SDK 0.8.52):
// base44.asServiceRole.functions.fetch(path, init?) consuming a stream-capable inner handler.
// It reuses the EXISTING executor streaming machinery (detectStreamSource, startStreamPump,
// streamResponseEnvelope) that the certified frontend functions.fetch surface runs — no new
// streaming engine, no envelope change, no invoke change:
//   • a stream-capable inner result is returned as a NATIVE stream-capable Response — status and
//     sanitized handler headers are available BEFORE the body, and paced producers are read
//     paced (incremental chunks, never drained as one buffered blob);
//   • SSE / chunked / NDJSON content arrives intact through the same pump;
//   • the SAME output-size quota applies cumulatively: a stream that exceeds it ends in a clean
//     early close (never an invented error payload) and records FUNCTION_OUTPUT_TOO_LARGE;
//   • abort: the caller's AbortSignal threads to the pump; aborting mid-stream stops delivery
//     (clean early close) and records STREAM_ABORTED on the invocation row. Machinery-level
//     check: the closed sandbox cannot construct a signal, so the surface threads init.signal
//     and the pump honors it (the surface's threading is exercised by every other case);
//   • buffered fetch regression: a non-streaming target keeps the EXACT G-C envelope
//     { status, ok, headers, has_body, body_text };
//   • invoke remains untouched: a streaming target through asServiceRole.functions.invoke still
//     refuses deterministically (STREAM_RESPONSE_ON_INVOKE);
//   • the streaming fetch draws from the SAME shared inner-call budget (8 per execution);
//   • identity: the inner execution records trigger 'function' / a service identity; no credits move.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { makeAgentProject } from "../../shared/appAgentTestFixtures.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { probeCreditDeltas } from "../../shared/invokeParityHelpers.ts";
import { canonicalFunctionPath } from "../../shared/functionPaths.ts";
import { packFileContent } from "../../shared/blobStore.ts";

// Paced SSE producer (the certified streaming handler form: a plain { next } iterator). `sleep`
// is the executor's stream-pacing global, bound only on streaming executions — which the
// service-role fetch now requests for the inner execution.
const FN_SSE = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var n = Number((ctx.request.query && ctx.request.query.n) || 3);
  var i = 0;
  var src = {
    next: async function () {
      if (i >= n) return { done: true };
      await sleep(400);
      i += 1;
      return { done: false, value: 'data: chunk-' + i + '\\n\\n' };
    },
  };
  return { status: 200, headers: { 'content-type': 'text/event-stream', 'x-asr-stream': 'yes' }, stream: src };
}`;

const FN_NDJSON = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var i = 0;
  var src = { next: async function () {
    if (i >= 3) return { done: true };
    i += 1;
    return { done: false, value: JSON.stringify({ line: i, sq: i * i }) + '\\n' };
  } };
  return { status: 200, headers: { 'content-type': 'application/x-ndjson' }, stream: src };
}`;

const FN_CHUNKED = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var parts = ['he', 'llo ', 'chun', 'ked'];
  var i = 0;
  var src = { next: async function () {
    if (i >= parts.length) return { done: true };
    var v = parts[i];
    i += 1;
    return { done: false, value: v };
  } };
  return { status: 200, stream: src };
}`;

// Instant producer, for the budget axis (no pacing).
const FN_FAST = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var i = 0;
  var src = { next: async function () {
    if (i >= 2) return { done: true };
    i += 1;
    return { done: false, value: 'x' + i };
  } };
  return { status: 200, stream: src };
}`;

// 10 x 1KB producer — exceeds a tightened 4096-byte output quota on the 5th chunk.
const FN_BIG = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var blob = '';
  while (blob.length < 1024) blob += 'q';
  var i = 0;
  var src = { next: async function () {
    if (i >= 10) return { done: true };
    i += 1;
    return { done: false, value: blob };
  } };
  return { status: 200, stream: src };
}`;

// Buffered regression target.
const FN_BUF = `export const config = { method: 'ANY' };
export default async function (ctx) {
  return { status: 200, body: { echoed: (ctx.request.query && ctx.request.query.echo) || '' } };
}`;

// The caller: exercises the service-role streaming fetch from inside the sandbox, records the
// pre-body status/headers and every chunk (byte length + read gap). Chunk content is truncated
// so a tightened output quota can never trip on the CALLER's own response.
const FN_CALLER = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var b = ctx.request.body || {};
  var out = { results: [] };
  var calls = b.calls || [];
  for (var i = 0; i < calls.length; i++) {
    var c = calls[i];
    try {
      var res;
      if (c.kind === 'invoke') res = await ctx.asServiceRole.functions.invoke(c.target, {});
      else res = await ctx.asServiceRole.functions.fetch(c.path, c.init || {});
      var rec = {
        name: c.name,
        status: res.status,
        ok_flag: res.ok === undefined ? null : res.ok,
        has_reader: !!(res.body && typeof res.body.getReader === 'function'),
        ct: res.headers && res.headers.get ? res.headers.get('content-type') : null,
        xh: res.headers && res.headers.get ? res.headers.get('x-asr-stream') : null,
        keys: Object.keys(res).sort().join(','),
      };
      if (res.body && typeof res.body.getReader === 'function') {
        var reader = res.body.getReader();
        var chunks = [], times = [], lens = [], done = false;
        while (!done) {
          var step = await reader.read();
          if (step.done) { done = true; break; }
          var s = '';
          var v = step.value;
          for (var j = 0; j < v.length; j++) s += String.fromCharCode(v[j]);
          chunks.push(s.length > 48 ? s.slice(0, 48) : s);
          lens.push(v.byteLength);
          times.push(Date.now());
          if (chunks.length > 12) break;
        }
        rec.chunks = chunks;
        rec.lens = lens;
        rec.gaps = [];
        for (var k = 1; k < times.length; k++) rec.gaps.push(times[k] - times[k - 1]);
        rec.closed = done;
      }
      out.results.push(rec);
    } catch (e) {
      out.results.push({
        name: c.name,
        rejected: true,
        code: e.code || null,
        message: String((e && e.message) || e).slice(0, 160),
        response_status: e.response && e.response.status,
        response_code: e.response && e.response.data && e.response.data.code,
      });
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
  const SSE_PATH = canonicalFunctionPath("asrSse");
  const NDJSON_PATH = canonicalFunctionPath("asrNdjson");
  const CHUNKED_PATH = canonicalFunctionPath("asrChunked");
  const FAST_PATH = canonicalFunctionPath("asrFast");
  const BIG_PATH = canonicalFunctionPath("asrBig");
  const BUF_PATH = canonicalFunctionPath("asrBuf");
  const CALLER_PATH = canonicalFunctionPath("asrCaller");

  const run = (P, name, source, body, quotas = {}) => executeProjectFunction(db, {
    project: P, entities: [], name, source,
    trigger: "frontend", requestId: crypto.randomUUID(),
    request: { method: "POST", query: {}, headers: {}, body },
    user: null, quotas,
  });

  try {
    const plan = await makeBillingPlan(db, created, `asrs${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `asrs${stamp}`, { plan });
    const P = await makeAgentProject(db, projectIds, A, stamp, "asrs");

    const put = async (path, source) =>
      db.entities.ProjectFile.create({ project_id: P.id, path, ...(await packFileContent(db, path, source)) });
    await put(SSE_PATH, FN_SSE);
    await put(NDJSON_PATH, FN_NDJSON);
    await put(CHUNKED_PATH, FN_CHUNKED);
    await put(FAST_PATH, FN_FAST);
    await put(BIG_PATH, FN_BIG);
    await put(BUF_PATH, FN_BUF);
    await put(CALLER_PATH, FN_CALLER);

    // ---- 1. SSE: native stream-capable Response, headers before body, INCREMENTAL chunks -------
    const a1 = await run(P, "asrCaller", FN_CALLER, { calls: [
      { name: "sse", path: `/asrSse?n=3` },
      { name: "ndjson", path: "/asrNdjson" },
      { name: "chunked", path: "/asrChunked" },
      { name: "buffered", path: "/asrBuf?echo=ping" },
      { name: "invoke_streaming", kind: "invoke", target: "asrSse" },
    ]});
    const B = a1.body || {};
    const r = (n) => (B.results || [])[n] || null;
    const sse = r(0);
    harness.check("G-C-S SSE: the streaming result is a NATIVE stream-capable Response — res.status 200 and the handler's sanitized headers (content-type text/event-stream, x-asr-stream) available BEFORE the body, body a ReadableStream",
      sse && sse.status === 200 && sse.ok_flag === true && sse.has_reader === true
        && sse.ct === "text/event-stream" && sse.xh === "yes",
      JSON.stringify(sse));
    harness.check("G-C-S SSE incremental: 3 paced chunks arrive INCREMENTALLY (read gaps >= 250ms with 400ms production pacing), then a clean close — never one buffered blob",
      sse && sse.chunks && sse.chunks.length === 3
        && sse.chunks[0] === "data: chunk-1\n\n" && sse.chunks[2] === "data: chunk-3\n\n"
        && sse.closed === true && (sse.gaps || []).every((g) => g >= 250),
      JSON.stringify({ chunks: sse && sse.chunks, gaps: sse && sse.gaps }));

    // ---- 2. NDJSON + chunked content integrity ---------------------------------------------------
    const nd = r(1);
    const lines = nd && nd.chunks ? nd.chunks.join("").split("\n").filter((x) => x.length) : [];
    let ndOk = lines.length === 3;
    if (ndOk) { try { ndOk = JSON.parse(lines[0]).line === 1 && JSON.parse(lines[2]).sq === 9; } catch { ndOk = false; } }
    harness.check("G-C-S NDJSON: 3 JSON lines traverse the pump intact (content-type application/x-ndjson)",
      nd && nd.status === 200 && nd.ct === "application/x-ndjson" && ndOk, JSON.stringify(nd && nd.chunks));
    const ch = r(2);
    harness.check("G-C-S chunked: partial-string chunks arrive in order and reassemble ('hello chunked'); an undeclared content-type is derived (application/octet-stream)",
      ch && ch.status === 200 && ch.chunks && ch.chunks.join("") === "hello chunked" && ch.closed === true
        && ch.ct === "application/octet-stream",
      JSON.stringify(ch && ch.chunks));

    // ---- 3. buffered fetch regression: the G-C envelope, byte-for-byte ---------------------------
    const buf = r(3);
    harness.check("G-C-S regression: a non-streaming target keeps the EXACT buffered envelope { status, ok, headers, has_body, body_text } — body parseable, no stream shape",
      buf && buf.rejected !== true && buf.status === 200 && buf.keys === "body_text,has_body,headers,ok,status"
        && buf.has_reader === false && buf.parsed === undefined,
      JSON.stringify(buf));

    // ---- 4. invoke untouched: a streaming target still refuses -----------------------------------
    const inv = r(4);
    harness.check("G-C-S invoke unchanged: a streaming target through asServiceRole.functions.invoke STILL refuses deterministically (FUNCTION_INVOKE_FAILED, inner STREAM_RESPONSE_ON_INVOKE, raw 400)",
      inv && inv.rejected === true && inv.code === "FUNCTION_INVOKE_FAILED"
        && inv.response_status === 400 && inv.response_code === "STREAM_RESPONSE_ON_INVOKE",
      JSON.stringify(inv));

    // ---- 5. shared inner-call budget: 8 streaming fetches OK, the 9th refuses --------------------
    const a3 = await run(P, "asrCaller", FN_CALLER, { calls: [
      { name: "f0", path: "/asrFast" }, { name: "f1", path: "/asrFast" }, { name: "f2", path: "/asrFast" },
      { name: "f3", path: "/asrFast" }, { name: "f4", path: "/asrFast" }, { name: "f5", path: "/asrFast" },
      { name: "f6", path: "/asrFast" }, { name: "f7", path: "/asrFast" }, { name: "f8", path: "/asrFast" },
    ]});
    const f8 = ((a3.body || {}).results || [])[8] || null;
    const f7 = ((a3.body || {}).results || [])[7] || null;
    harness.check("G-C-S bounded: streaming fetches draw from the SAME shared budget — 8 OK, the 9th refuses with FUNCTION_INVOKE_LIMIT",
      f7 && f7.rejected !== true && f8 && f8.rejected === true && f8.code === "FUNCTION_INVOKE_LIMIT",
      JSON.stringify(f8));

    // ---- 6. output quota on the stream ------------------------------------------------------------
    const a2 = await run(P, "asrCaller", FN_CALLER, { calls: [{ name: "quota", path: "/asrBig" }] }, { maxOutputBytes: 4096 });
    const q = ((a2.body || {}).results || [])[0] || null;
    harness.check("G-C-S quota: the SAME cumulative output quota applies — 4x1KB delivered (4096), the exceeding 5th chunk NOT delivered, then a clean early close (never an invented error payload)",
      q && q.rejected !== true && q.chunks && q.chunks.length === 4 && q.closed === true
        && (q.lens || []).every((l) => l === 1024),
      JSON.stringify({ lens: q && q.lens, closed: q && q.closed, gaps: q && q.gaps }));
    const bigRows = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "asrBig" }, "created_date", 5);
    // The invocation row keeps the producer's returned status (the envelope's status) and records
    // the mid-stream failure on error_class — the same accounting the frontend streaming cert runs.
    harness.check("G-C-S quota: the violation is recorded on the inner invocation row (error_class FUNCTION_OUTPUT_TOO_LARGE + the failure message), so it is never silently silent",
      bigRows.length === 1 && bigRows[0].error_class === "FUNCTION_OUTPUT_TOO_LARGE"
        && String(bigRows[0].error_message || "").includes("FUNCTION_OUTPUT_TOO_LARGE"),
      JSON.stringify(bigRows.map((x) => ({ error_class: x.error_class, error_message: x.error_message }))));

    // ---- 7. abort: the caller's AbortSignal threads to the pump (machinery level) -----------------
    const ctrl = new AbortController();
    const ab = await executeProjectFunction(db, {
      project: P, entities: [], name: "asrSse", source: FN_SSE,
      trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "GET", query: { n: "6" }, headers: {}, body: null },
      user: null, streaming: true, signal: ctrl.signal,
    });
    const abReader = ab.stream === true ? ab.body.getReader() : null;
    const got = [];
    if (abReader) {
      got.push(await abReader.read());
      ctrl.abort();
      for (let i = 0; i < 6; i++) {
        const step = await abReader.read();
        if (step.done) break;
        got.push(step);
      }
    }
    const abRows = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "asrSse", error_class: "STREAM_ABORTED" }, "created_date", 5);
    harness.check("G-C-S abort: aborting mid-stream stops the pump — delivery ends early (2 of 6 produced chunks) with a clean close, and the invocation row records STREAM_ABORTED",
      ab.stream === true && got.length === 2 && abRows.length === 1,
      `chunks=${got.length} rows=${abRows.length}`);

    // ---- 8. identity + billing ---------------------------------------------------------------------
    const sseRows = await db.entities.FunctionInvocation.filter({ project_id: P.id, function_name: "asrSse" }, "created_date", 10);
    harness.check("G-C-S identity: the inner streaming execution records trigger 'function' with a service identity (kind 'service', no user) — the service role, unchanged",
      sseRows.some((x) => x.trigger === "function" && x.identity && x.identity.kind === "service" && !x.identity.app_user_id),
      JSON.stringify(sseRows.slice(0, 2).map((x) => ({ trigger: x.trigger, identity: x.identity }))));
    const deltas = await probeCreditDeltas(db, A.ws.id, () =>
      run(P, "asrCaller", FN_CALLER, { calls: [{ name: "bill", path: "/asrFast" }] }));
    harness.check("G-C-S billing: a streaming service-role fetch moves NO credits in either pool (no invented charge)",
      deltas.messageDelta === 0 && deltas.integrationDelta === 0,
      `message Δ${deltas.messageDelta} · integration Δ${deltas.integrationDelta}`);

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
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_asrs" } }).catch(() => {});
  }
}