// Executes a generated project's backend function, server-side.
//
// Flow: load the function's source from the project filesystem → parse + interpret it in
// the closed sandbox (jsInterp) → hand the handler a context containing ONLY:
//   request  – method, headers (safe subset), query, body
//   db       – project-scoped data access
//   secrets  – get(name), limited to the names the function declared in its config
//   http     – outbound HTTP with timeout and host restrictions
//   log      – captured, redacted log lines
// Secret VALUES never leave this module: they are read with the service role at execution
// time, injected into the sandbox, and redacted from every log line, error and response.
import { createInterpreter, parseModule, QuotaExceeded } from "./jsInterp.ts";
import { resolveQuotas, classifyQuotaError, enforceOutputSize } from "./functionQuotas.ts";
import { resolveSecretValues } from "./secretCrypto.ts";
import { createServerDb } from "./appData.ts";
import { createServerFiles } from "./appFiles.ts";
import { createServerMessaging } from "./appMessaging.ts";
import { assertAllowedUrl, assertResolvedUrl, createIntegrationsApi, UPSTREAM_CODES } from "./externalTools.ts";
import { createIntegrationObserver } from "./integrationObservability.ts";
import { createIntegrationRateLimitState } from "./integrationRateLimit.ts";
import { createIntegrationBreaker } from "./integrationBreaker.ts";
import { createIntegrationQuota } from "./integrationQuota.ts";
import { createDelegatedCredentialResolver } from "./delegatedOAuth.ts";
import { createAppPrimitives } from "./primitives.ts";
import { createAppWorkflows } from "./workflowApi.ts";
import { createAppAuthContext, executionIdentity } from "./appAuthContext.ts";
import { createAppAnalytics } from "./analyticsIngest.ts";
// P-9.11P Tier 1: the backend service-role agents READ surface — a narrow module over the SAME
// reserved conversation storage, importing only pure helpers from the agent runtime.
import { createAppAgentsServiceRole } from "./appAgentServiceRole.ts";
import { createCoreServiceRole } from "./coreServiceRole.ts";
import { unpackFileContent } from "./blobStore.ts";
// G-A: File parameters on the invoke payload are restored as the function's named parameters.
import { restoreFileParams } from "./multipartInvoke.ts";
import { FUNCTION_NAME_RE, functionPath, canonicalFunctionPath } from "./functionPaths.ts";
import { secretRefs } from "./integrations.ts";
// G-C: the service-role fetch composes the EXISTING server-side fetch machinery — the same
// bounded validation (buildFetchRequest), executor and raw Response envelope the frontend
// functions.fetch surface already runs. No fetch semantics change anywhere.
import { buildFetchRequest, fetchResponseEnvelope, streamResponseEnvelope } from "./appFetch.ts";
export { FUNCTIONS_DIR, functionPath, functionNameFromPath, isFunctionPath } from "./functionPaths.ts";

const OUTBOUND_TIMEOUT_MS = 12000;
const MAX_OUTBOUND_CALLS = 8;
const MAX_RESPONSE_CHARS = 200000;
// G-B: the service-role function-to-function invoke (asServiceRole.functions.invoke) reuses the
// SAME executor, so its runaway risk is bounded HERE like every other function-runtime budget:
// at most MAX_INNER_INVOKES inner calls per executing function and MAX_INVOKE_DEPTH chained
// invocations deep. Neither bound is raisable by any caller.
const MAX_INNER_INVOKES = 8;
const MAX_INVOKE_DEPTH = 3;

// Streaming (functions.fetch, additive): the sandbox has no timers, but a chunk producer must be
// able to pace itself (SSE). `sleep(ms)` is handed to the interpreter ONLY on streaming
// executions and resolves after at most 10s; it executes no callback and exposes no host handle,
// so the sandbox boundary is unchanged.
const STREAM_SLEEP_MAX_MS = 10000;
const streamSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Math.floor(Number(ms) || 0), 0), STREAM_SLEEP_MAX_MS)));

function redactor(values) {
  const secrets = values.filter((v) => typeof v === "string" && v.length >= 6);
  return (text) => {
    let out = String(text ?? "");
    for (const v of secrets) out = out.split(v).join("[REDACTED]");
    return out;
  };
}

// functions.fetch parity: response headers the handler's return object declares are extracted
// ADDITIVELY into result.response_headers — recognized only alongside status/body, so a plain
// value return can never be misread as headers. The invoke path's wire format is untouched:
// invoke endpoints build their responses from status/body only and never forward this field.
const RESPONSE_HEADER_DENY = new Set(["host", "connection", "content-length", "transfer-encoding"]);
function extractResponseHeaders(result, redact) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  if (!("status" in result || "body" in result)) return null;
  const raw = result.headers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const headers = {};
  for (const [k, v] of Object.entries(raw).slice(0, 25)) {
    const name = String(k).toLowerCase();
    if (!name || name.length > 128 || RESPONSE_HEADER_DENY.has(name)) continue;
    headers[name] = redact(String(v ?? "")).slice(0, 2048);
  }
  return Object.keys(headers).length ? headers : null;
}

// Streaming (functions.fetch, additive): recognizes ONE stream-capable handler result shape.
const isStreamable = (s) => !!s && typeof s === "object" &&
  (typeof s.getReader === "function" || typeof s.next === "function" || typeof s[Symbol.asyncIterator] === "function");

function detectStreamSource(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  if (typeof Response === "function" && result instanceof Response) {
    const body = result.body;
    if (body && typeof body.getReader === "function") {
      return { stream: body, status: result.status, headers: Object.fromEntries(result.headers.entries()) };
    }
    return null;
  }
  return isStreamable(result.stream) ? { stream: result.stream, status: result.status, headers: result.headers } : null;
}

/**
 * Streams a handler's chunk source through an executor-owned ReadableStream. The pump runs inside
 * `start()` and resolves it only when the source completes — so every chunk is enqueued while
 * start() is pending, the one pattern the serving layer delivers incrementally (live-confirmed).
 * Bounded: cumulative bytes at the SAME output quota and a wall-clock stream ceiling; the
 * caller-abort signal stops the pump. A source failure or a quota violation ends the stream the
 * way every mid-stream failure reaches a client — a clean early close, never an invented error
 * payload — and is recorded on the invocation row.
 */
function startStreamPump({ finish, stream, status, quotas, signal, redact, secrets }) {
  return new ReadableStream({
    start(controller) {
      (async () => {
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        const reader = typeof stream.getReader === "function" ? stream.getReader() : null;
        const deadline = Date.now() + quotas.maxStreamMs;
        let bytes = 0, failure = null, it = null;
        try {
          for (;;) {
            if (signal && signal.aborted) { failure = { code: "STREAM_ABORTED", message: "aborted by the caller" }; break; }
            if (Date.now() > deadline) { failure = { code: "FUNCTION_TIMEOUT", message: "stream exceeded its time limit" }; break; }
            const step = reader ? await reader.read() : await (it = it || stream).next();
            if (step.done) break;
            let chunk = step.value;
            if (typeof chunk === "string") chunk = enc.encode(chunk);
            else if (chunk instanceof ArrayBuffer) chunk = new Uint8Array(chunk);
            else if (ArrayBuffer.isView(chunk)) chunk = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            else if (chunk && typeof chunk === "object") chunk = enc.encode(JSON.stringify(chunk));
            if (!chunk || !chunk.byteLength) continue;
            bytes += chunk.byteLength;
            if (bytes > quotas.maxOutputBytes) {
              failure = { code: "FUNCTION_OUTPUT_TOO_LARGE", message: `stream exceeded the ${quotas.maxOutputBytes}-byte response limit` };
              break;
            }
            // Secret redaction applies to the stream too: chunks are decoded as UTF-8 text and
            // re-encoded (a stream decoder, so multi-byte boundaries stay coherent). With no
            // secret values in play the bytes travel untouched.
            controller.enqueue(secrets ? enc.encode(redact(dec.decode(chunk, { stream: true }))) : chunk);
          }
        } catch (e) {
          failure = { code: "STREAM_SOURCE_FAILED", message: String((e && e.message) || e).slice(0, 300) };
        }
        try { if (reader) await reader.cancel(); else if (it && typeof it.return === "function") await it.return(); } catch { /* already gone */ }
        try {
          await finish(failure ? { status, error: `${failure.code}: ${failure.message}`, errorClass: failure.code } : { status });
        } catch { /* invocation row best-effort */ }
        try { controller.close(); } catch { /* already closed */ }
      })();
    },
  });
}

// Resolves ONE function by name, in either supported layout — the canonical Base44 resource
// (base44/functions/<name>/entry.ts) first, then the legacy flat path (functions/<name>.js).
// Both lookups are EXACT-path reads derived from the validated name, so no entity schema, no
// frontend file and no other project file can ever be resolved as a function, and a flat-layout
// project keeps resolving exactly the file it always did.
export async function loadProjectFunction(client, projectId, name) {
  if (!FUNCTION_NAME_RE.test(String(name || ""))) throw Object.assign(new Error("Invalid function name"), { status: 400 });
  for (const path of [canonicalFunctionPath(name), functionPath(name)]) {
    const rows = await client.entities.ProjectFile.filter({ project_id: projectId, path }, "path", 1);
    if (rows.length) return { record: rows[0], source: await unpackFileContent(rows[0]) };
  }
  throw Object.assign(new Error(`Backend function "${name}" does not exist in this project`), { status: 404 });
}

// Reads and evaluates only `export const config` — used by the build engine and the
// executor to learn a function's trigger, method and declared secrets.
export async function readFunctionConfig(source, { maxSteps = 1000000, timeoutMs = 15000, globals = null } = {}) {
  const interp = createInterpreter({ maxSteps, timeoutMs, ...(globals ? { globals } : {}) });
  const exports = await interp.runModule(parseModule(source));
  return { config: exports.named.config || {}, handler: exports.default, exports };
}

export async function executeProjectFunction(client, {
  project, entities, name, source, request, trigger = "frontend", requestId, integrations = [], user = null,
  messagingTransport = "platform", quotas: quotaOverrides = {}, secretEncryption = {},
  // Data namespace for this execution. Defaults to the project itself; the runtime verifier
  // passes a throwaway namespace so a smoke test cannot touch the project's real records.
  // Secrets and telemetry always stay bound to the real project id.
  dataProjectId = null,
  // Correlation context, supplied by whatever caused this execution (an AI run's runtime
  // verification, a preview call, a webhook). Carried through onto the invocation row so a
  // failure inside generated code stays attributable to that operation. Never minted here —
  // a per-execution id would break the very correlation it is meant to provide.
  trace_id = null, run_id = null,
  // The app session the end-user was resolved from (public projection, never the token). Together
  // with `user` and `trigger` it forms the EXPLICIT execution identity recorded on the invocation.
  session = null,
  // G-B: chained service-role invoke depth of THIS execution (0 = a top-level execution).
  invoke_depth = 0,
  // Streaming (functions.fetch, additive): when true, a handler result carrying a chunk source is
  // returned as a stream-capable result; when false (every invoke path), such a result is a
  // deterministic 400 refusal — the buffered invoke envelope is untouched.
  streaming = false,
  // The caller-abort signal (client AbortController → host → endpoint). Observed by the stream
  // pump and handed to the handler as ctx.request.signal.
  signal = null,
}) {
  const dataId = dataProjectId || project.id;
  const identity = executionIdentity({ user, session, trigger });
  // Quotas are resolved from server-side defaults; a caller may tighten them (tests do).
  // Nothing in the function's own source or config can influence them.
  const quotas = resolveQuotas(quotaOverrides);
  // "test" transport records messages and delivers nothing — used by tests so no real email
  // or notification is ever sent. Production callers leave this at "platform".
  const messaging = createServerMessaging(client, dataId, { transport: messagingTransport });
  const started = Date.now();
  const logs = [];
  const externalCalls = [];
  let redact = (t) => t;

  const finish = async (result) => {
    const invocation = await client.entities.FunctionInvocation.create({
      project_id: project.id, function_name: name, trigger, method: request.method, identity,
      status: result.status, ok: result.status < 400, error_class: result.errorClass, error_message: result.error ? redact(result.error).slice(0, 500) : undefined,
      duration_ms: Date.now() - started, request_id: requestId,
      trace_id: trace_id || null, run_id: run_id || null,
      logs: logs.slice(-50), external_calls: externalCalls.slice(-20),
    });
    return { ...result, logs: logs.slice(-50), invocation_id: invocation.id, duration_ms: Date.now() - started };
  };

  // G-A: File parameters on the invoke payload are restored HERE — ONE point covering both
  // invoke entry points (deployed runtime + preview), the generated-app JSON bridge and genuine
  // multipart requests. A malformed or oversized descriptor is a deterministic 413 refusal;
  // a payload with no file-like values is returned UNTOUCHED (the original object), so the JSON
  // invoke behavior is byte-identical to before. The executor architecture is unchanged.
  let restoredBody;
  try {
    restoredBody = restoreFileParams(request.body);
  } catch (e) {
    return finish({
      status: e.status || 413, body: { error: e.message, code: e.code || "FILE_PARAM_INVALID" },
      error: `${e.code || "FILE_PARAM_INVALID"}: ${e.message}`, errorClass: e.code || "FILE_PARAM_INVALID",
    });
  }

  let parsed;
  try {
    parsed = await readFunctionConfig(source, {
      maxSteps: quotas.maxSteps,
      timeoutMs: streaming ? Math.max(quotas.timeoutMs, quotas.maxStreamMs) : quotas.timeoutMs,
      globals: streaming ? { sleep: streamSleep } : null,
    });
  } catch (e) {
    // Module-level code can blow a quota too (e.g. a top-level infinite loop).
    const quota = classifyQuotaError(e, quotas);
    if (quota) {
      return finish({ status: quota.status, body: { error: quota.message, code: quota.code }, error: `${quota.code}: module load`, errorClass: quota.code });
    }
    return finish({ status: 500, body: { error: "Function failed to load" }, error: `load: ${e.message}`, errorClass: "LoadError" });
  }
  const config = parsed.config || {};
  if (typeof parsed.handler !== "function") {
    return finish({ status: 500, body: { error: "Function has no default export handler" }, error: "no default export", errorClass: "LoadError" });
  }
  if (trigger === "webhook" && !config.webhook) {
    return finish({ status: 404, body: { error: "Not a webhook endpoint" }, error: "function is not exposed as a webhook", errorClass: "TriggerError" });
  }
  if (config.method && trigger !== "test" && String(config.method).toUpperCase() !== "ANY" && request.method !== String(config.method).toUpperCase()) {
    return finish({ status: 405, body: { error: `Method not allowed, expected ${config.method}` }, error: "method not allowed", errorClass: "MethodError" });
  }

  // Secrets: the names this function declared, plus the credentials referenced by the
  // project's integrations (those are injected into outbound requests by the http adapter
  // and are NOT readable through secrets.get). Only this project's rows are ever loaded.
  const declared = Array.isArray(config.secrets) ? config.secrets.map(String) : [];
  const integrationSecrets = integrations.flatMap((i) => secretRefs(i));
  const wanted = new Set([...declared, ...integrationSecrets]);
  const secretRows = wanted.size
    ? await client.entities.ProjectSecret.filter({ project_id: project.id }, "name", 100)
    : [];
  const relevant = secretRows.filter((s) => wanted.has(s.name));
  // Values are stored encrypted (AES-256-GCM, bound to this project id + secret name).
  // Decryption happens HERE — the deepest trusted server-side point — and the plaintext
  // lives only in this closure: it is injected into the sandbox on demand and redacted from
  // every log line, error and response body below.
  const { values: secretMap, failed: undecryptable } = await resolveSecretValues(relevant, project.id, secretEncryption);
  if (undecryptable.length) {
    return finish({
      status: 503,
      body: { error: `Secret(s) unavailable: ${undecryptable.join(", ")}. Re-enter them in the builder's Secrets panel.`, code: "SECRET_DECRYPT_FAILED" },
      error: `SECRET_DECRYPT_FAILED: ${undecryptable.join(", ")}`, errorClass: "SECRET_DECRYPT_FAILED",
    });
  }
  // A secret the user marked optional may legitimately be unset — the function is expected
  // to handle its absence. Only required (the default) secrets block execution.
  const optional = new Set(relevant.filter((s) => s.required === false).map((s) => s.name));
  // Live credentials this execution mints (OAuth2 access tokens) join the redaction set the
  // moment they exist, so a token can never reach a log line, an error or a response body.
  const dynamicSecrets = [];
  const rebuildRedactor = () => { redact = redactor([...secretMap.values(), ...dynamicSecrets]); };
  const protect = (value) => { if (typeof value === "string" && value.length >= 6 && !dynamicSecrets.includes(value)) { dynamicSecrets.push(value); rebuildRedactor(); } };
  rebuildRedactor();
  const usedSecrets = new Set();

  const missing = declared.filter((n) => !secretMap.get(n) && !optional.has(n));
  if (missing.length) {
    return finish({
      status: 503,
      body: { error: `Missing project secret(s): ${missing.join(", ")}. Set them in the builder's Secrets panel.` },
      error: `missing secret(s): ${missing.join(", ")}`, errorClass: "MissingSecret",
    });
  }

  const log = (...args) => {
    logs.push(redact(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).slice(0, 500));
  };

  const http = async (url, options = {}) => {
    if (externalCalls.length >= MAX_OUTBOUND_CALLS) throw new Error(`http: outbound call limit (${MAX_OUTBOUND_CALLS}) reached`);
    const target = assertAllowedUrl(url);
    // DNS-rebinding gate: the same shared SSRF guard the integration adapters use, applied
    // before the request is dispatched. Fail closed on private/loopback/metadata resolution
    // and on DNS failures — identical to base_url, OAuth token and MCP server requests.
    await assertResolvedUrl(target);
    for (const [k, v] of Object.entries(options.query || {})) target.searchParams.set(k, String(v));
    const method = String(options.method || "GET").toUpperCase();
    const headers = { ...(options.headers || {}) };
    let body;
    if (options.json !== undefined) { body = JSON.stringify(options.json); headers["Content-Type"] = headers["Content-Type"] || "application/json"; }
    else if (options.body !== undefined) body = options.body;
    const callStart = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || OUTBOUND_TIMEOUT_MS);
    try {
      const res = await fetch(target.toString(), { method, headers, body, signal: controller.signal });
      const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
      let parsedBody = text;
      const type = res.headers.get("content-type") || "";
      if (type.includes("json")) { try { parsedBody = JSON.parse(text); } catch { /* keep text */ } }
      externalCalls.push({ host: target.hostname, method, status: res.status, duration_ms: Date.now() - callStart });
      return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsedBody };
    } catch (e) {
      externalCalls.push({ host: target.hostname, method, status: 0, duration_ms: Date.now() - callStart });
      const timedOut = e.name === "AbortError";
      throw Object.assign(new Error(`http ${method} ${target.hostname} failed: ${timedOut ? "timed out" : redact(e.message)}`), { kind: timedOut ? "timeout" : "network" });
    } finally {
      clearTimeout(timer);
    }
  };

  // P-9.11P: the service-role agents READ surface, created once so the documented
  // `asServiceRole` namespace below can project it unchanged.
  const agentsServiceRole = createAppAgentsServiceRole(client, { projectId: dataId });
  const coreServiceRole = createCoreServiceRole(client, { project, integrations, user, session, transport: messagingTransport });
  // G-B — the DOCUMENTED service-role FunctionsModule invoke (`base44.asServiceRole.functions.
  // invoke(functionName, data?)`, SDK 0.8.51/0.8.52): backend code calling ANOTHER function of
  // the SAME project with service-role authorization. It rides the EXISTING executor — no new
  // execution runtime, no new auth subsystem: the target is resolved through loadProjectFunction
  // (validated name, exact-path reads, THIS project only — project isolation by construction),
  // the inner execution runs with user = null (service role — never the caller's identity, its
  // session or tokens) and records trigger "function" / a service identity, inherits this
  // execution's data namespace, messaging transport, quotas, secret decryption and trace/run
  // correlation, and is bounded by MAX_INNER_INVOKES / MAX_INVOKE_DEPTH. Response semantics are
  // the certified invoke contract: the axios-like envelope { data, status: 200, statusText,
  // headers, config } on success; the target's status >= 400 REJECTS (thrown with .response
  // carrying the target's envelope for inspection — Base44 publishes no rejection shape, so that
  // field set is NEXUSAI-DERIVED). No credits move (the executor charges none on invoke paths).
  let innerInvokeCount = 0;
  const serviceRoleFunctions = {
    invoke: async (fnName, data) => {
      if (invoke_depth >= MAX_INVOKE_DEPTH) {
        throw Object.assign(new Error(`functions.invoke: chained invocation depth limit (${MAX_INVOKE_DEPTH}) reached`), { code: "FUNCTION_INVOKE_DEPTH" });
      }
      if (innerInvokeCount >= MAX_INNER_INVOKES) {
        throw Object.assign(new Error(`functions.invoke: call limit (${MAX_INNER_INVOKES}) per execution reached`), { code: "FUNCTION_INVOKE_LIMIT" });
      }
      innerInvokeCount += 1;
      const { source } = await loadProjectFunction(client, project.id, fnName);
      const res = await executeProjectFunction(client, {
        project, entities, integrations, name: fnName, source,
        trigger: "function", requestId: crypto.randomUUID(),
        request: { method: "POST", query: {}, headers: {}, body: data === undefined ? null : data },
        user: null, session: null, messagingTransport, quotas: quotaOverrides, secretEncryption,
        dataProjectId: dataId, trace_id: trace_id || null, run_id: run_id || null,
        invoke_depth: invoke_depth + 1,
      });
      if (res.status >= 400) {
        throw Object.assign(
          new Error(`functions.invoke: "${fnName}" failed with status ${res.status}`),
          { code: "FUNCTION_INVOKE_FAILED", status: res.status, response: { data: res.body, status: res.status, statusText: null, headers: {}, config: {} } },
        );
      }
      return { data: res.body, status: 200, statusText: "OK", headers: {}, config: {} };
    },
    // G-C — the DOCUMENTED service-role FunctionsModule fetch (`base44.asServiceRole.functions.
    // fetch(path, init?)`, SDK 0.8.52 client.js: the SAME createFunctionsModule with the service
    // token riding its auto-merged auth headers): backend code doing a raw HTTP request to
    // ANOTHER function of the SAME project. It composes the EXISTING server-side fetch machinery —
    // buildFetchRequest validation, loadProjectFunction resolution (THIS project only),
    // executeProjectFunction with trigger "function" / user null (service role) and the shared
    // envelope layer — so the raw Response semantics are the certified frontend half's, unchanged:
    // the buffered envelope is { status, ok, headers, has_body, body_text }, the target's status
    // is returned RAW (a function's 4xx/5xx NEVER rejects; only infrastructure refusals throw,
    // e.g. an unknown function or FETCH_INVALID_ARGS). It shares the SAME inner-call budget with
    // invoke (MAX_INNER_INVOKES / MAX_INVOKE_DEPTH, one shared counter) and the same inherited
    // context. No credits move (the executor charges none on fetch paths).
    // STREAMING (additive): a stream-capable inner result rides the SAME executor streaming
    // machinery (streaming: true; a genuine AbortSignal on init.signal threads to the pump) and
    // is returned as a NATIVE stream-capable Response — the function's status and sanitized
    // headers travel BEFORE the body and the executor-owned ReadableStream is the body, bounded
    // by the SAME output-size quota and wall-clock ceiling, with mid-stream failures reaching the
    // caller as a clean early close. Every non-streaming result keeps the exact buffered
    // envelope, byte-for-byte unchanged (streaming:true only widens the module-load ceiling and
    // injects the pacing sleep). functions.invoke of a streaming function is STILL the
    // deterministic STREAM_RESPONSE_ON_INVOKE refusal — invoke is untouched.
    fetch: async (fnPath, init = {}) => {
      if (invoke_depth >= MAX_INVOKE_DEPTH) {
        throw Object.assign(new Error(`functions.fetch: chained invocation depth limit (${MAX_INVOKE_DEPTH}) reached`), { code: "FUNCTION_INVOKE_DEPTH" });
      }
      if (innerInvokeCount >= MAX_INNER_INVOKES) {
        throw Object.assign(new Error(`functions.fetch: call limit (${MAX_INNER_INVOKES}) per execution reached`), { code: "FUNCTION_INVOKE_LIMIT" });
      }
      innerInvokeCount += 1;
      const i = init && typeof init === "object" && !Array.isArray(init) ? init : {};
      const request = buildFetchRequest({
        path: String(fnPath ?? ""),
        method: i.method,
        headers: i.headers,
        body: i.body,
      });
      const { source } = await loadProjectFunction(client, project.id, request.name);
      const signal = i.signal && typeof i.signal === "object" && typeof i.signal.addEventListener === "function" ? i.signal : null;
      const result = await executeProjectFunction(client, {
        project, entities, integrations, name: request.name, source,
        trigger: "function", requestId: crypto.randomUUID(),
        request: {
          method: request.method, query: request.query, headers: request.headers,
          body: request.body, path: request.path,
        },
        user: null, session: null, messagingTransport, quotas: quotaOverrides, secretEncryption,
        dataProjectId: dataId, trace_id: trace_id || null, run_id: run_id || null,
        invoke_depth: invoke_depth + 1,
        streaming: true, signal,
      });
      const envelope = streamResponseEnvelope(result);
      if (envelope.__stream__ === true) {
        return new Response(envelope.body, { status: envelope.status, headers: envelope.headers });
      }
      return envelope;
    },
  };

  const serviceDb = createServerDb(client, dataId, entities);
  const ctx = {
    request: {
      method: request.method,
      query: request.query || {},
      body: restoredBody,
      headers: request.headers || {},
      // functions.fetch sub-path addressing: the caller's path after the function-name
      // segment, "/" when absent. Additive — existing callers never set it.
      path: request.path || "/",
      header: (n) => (request.headers || {})[String(n).toLowerCase()],
      // Caller-abort signal, threaded from the client's AbortController (streaming fetches only;
      // null elsewhere). The handler may observe it; the executor's pump observes it regardless.
      signal: signal || null,
    },
    db: serviceDb,
    // ctx.entities — the CALLER-scoped data client (Base44 `createClientFromRequest(req).entities`):
    // the same RLS / field rules the published runtime applies to this end user (anonymous when
    // ctx.user is null). Unrestricted access stays explicit via ctx.asServiceRole.entities / ctx.db.
    entities: createServerDb(client, dataId, entities, { rls: !!project.rls_enabled, user, fieldRules: true }),
    // ctx.files — project-scoped file storage. Ownership is enforced inside the primitive
    // (per end-user when the project has RLS on); the storage handle and the service role
    // never reach the sandbox, only metadata and short-lived signed URLs.
    files: createServerFiles(client, dataId, { rls: !!project.rls_enabled, user, allowCleanup: true }),
    // ctx.email / ctx.push — project-scoped messaging. The provider call happens outside the
    // sandbox, so no provider credential, endpoint or handle is ever reachable from generated
    // code; validation and per-project daily quotas are enforced before any send.
    email: messaging.email,
    push: messaging.push,
    // ctx.primitives — THE app-facing primitive surface (#27). The project is captured from this
    // execution's own project record, so the sandbox cannot point a primitive at another project;
    // every call is validated, authorized, idempotency-checked, traced and billed by the single
    // server-side executor, and generated code only ever sees validated outputs.
    primitives: createAppPrimitives(client, {
      project, end_user: user, trace_id: trace_id || null, run_id: run_id || null,
      options: { messagingTransport },
    }),
    // ctx.workflows — THE app-facing workflow surface (#28). The executing project is captured
    // here, so generated code can only dispatch, trigger and inspect ITS OWN project's workflows;
    // every run is authorized, versioned, idempotent and durable in the engine, not in the sandbox.
    workflows: createAppWorkflows(client, {
      project, end_user: user, trace_id: trace_id || null, run_id: run_id || null,
      options: { messagingTransport },
    }),
    secrets: {
      get: (n) => {
        const key = String(n);
        if (!declared.includes(key)) throw new Error(`secret "${key}" is not declared in this function's config.secrets`);
        const value = secretMap.get(key);
        if (!value) return undefined;
        usedSecrets.add(key);
        return value;
      },
      has: (n) => declared.includes(String(n)) && !!secretMap.get(String(n)),
      names: () => [...declared],
    },
    http,
    // Project integrations: integrations.<name>.<operation>(params, { body }). Credentials are
    // resolved here and injected by the adapter; the sandbox never sees them.
    integrations: createIntegrationsApi(integrations, {
      http, log, protect, projectId: project.id,
      resolveSecret: (n) => { const v = secretMap.get(String(n)); if (v) usedSecrets.add(String(n)); return v; },
      // Delegated credential (#31G): an app user authorized this call on their behalf. The resolver
      // validates ownership, refreshes expired tokens, and hands the bearer to `protect` for redaction.
      resolveDelegatedCredential: createDelegatedCredentialResolver(client, {
        project, user, resolveSecret: (n) => { const v = secretMap.get(String(n)); if (v) usedSecrets.add(String(n)); return v; },
        http, protect, trace_id: trace_id || null,
      }),
      // MCP calls bypass ctx.http (JSON-RPC transport), so they claim a slot in the same
      // outbound budget and report into the same telemetry as any other external call.
      reserve: () => { if (externalCalls.length >= MAX_OUTBOUND_CALLS) throw new Error(`integration: outbound call limit (${MAX_OUTBOUND_CALLS}) reached`); },
      track: (call) => { externalCalls.push(call); },
      // Bounded, project+integration+host circuit breaker over LOGICAL call outcomes.
      breaker: createIntegrationBreaker(client, { project, trace_id: trace_id || null }),
      // Bounded per-project + integration call quota over LOGICAL calls, claimed before execution.
      quota: createIntegrationQuota(client, { project, trace_id: trace_id || null }),
      // Upstream-declared 429 windows, isolated per project + integration + host.
      rateLimit: createIntegrationRateLimitState(client, { project, trace_id: trace_id || null }),
      // One durable IntegrationInvocation + one span in the EXISTING trace per logical call.
      // `redact` is read live, so an OAuth token minted mid-call is already in the redaction set.
      observe: createIntegrationObserver(client, {
        project, trace_id: trace_id || null, run_id: run_id || null,
        function_name: name, trigger, redact: (t) => redact(t),
      }),
    }),
    log,
    console: { log, error: log, warn: log },
    // Authenticated end-user for this request, or null for anonymous calls. Generated
    // functions read ctx.user to identify the caller; it never contains tokens or secrets.
    user,
    // ctx.auth — the app-user identity surface (#29): who is calling, their project roles and
    // permissions, team (tenant) membership checks and the execution identity. Every check
    // re-reads the project's own AppRole / AppTeam rows server-side; the sandbox can assert nothing.
    auth: createAppAuthContext(client, { project, user, session, identity, trace_id }),
    // ctx.analytics — THE app-facing analytics surface (#30). Ownership is captured from this
    // execution's own project record and the verified end-user, so the sandbox cannot attribute an
    // event to another project or another user; validation, credential policy, redaction and
    // idempotency are the server-side contract's, and high-volume writes go through the existing queue.
    analytics: createAppAnalytics(client, { project, user, session, trace_id: trace_id || null, run_id: run_id || null }),
    // ctx.agents — the documented `base44.asServiceRole.agents` READ surface (P-9.11P Tier 1).
    // The project id is captured HERE by the executor — the SAME data-namespace contract ctx.db
    // uses — so the sandbox can never name another project and elevated access can never become
    // cross-project access. Only the three documented read methods exist; every other
    // AgentsModule op is refused fail-closed inside the module (documented backend semantics
    // UNKNOWN — never invented), and none of these reads moves any credits.
    agents: agentsServiceRole,
    // ctx.asServiceRole — the DOCUMENTED service-role namespace (G-B invoke / G-C fetch):
    // functions.invoke and functions.fetch ride the existing executor with service-role
    // authorization and THIS project's scope; agents is
    // the SAME P-9.11P read module ctx.agents projects, unchanged. The sandbox can never name
    // another project — the project id and every elevated path stay captured by the executor.
    // integrations.Core — the DOCUMENTED backend Core surface (`base44.asServiceRole.integrations.
    // Core.<Method>(params)`), dispatched onto the SAME certified handlers the frontend bridge
    // uses (billing, quotas, validation unchanged) with trigger "function", which is what unlocks
    // the server-only SendPushNotification. Project and transport stay captured by the executor.
    asServiceRole: { entities: serviceDb, functions: serviceRoleFunctions, agents: agentsServiceRole, integrations: { Core: coreServiceRole } },
  };

  try {
    const result = await parsed.handler(ctx);
    if (usedSecrets.size) {
      const stamp = new Date().toISOString();
      for (const row of secretRows.filter((s) => usedSecrets.has(s.name))) {
        await client.entities.ProjectSecret.update(row.id, { last_used_at: stamp });
      }
    }
    // Streaming convention (additive, functions.fetch only): a handler result may carry a chunk
    // source — a plain { next } iterator (the one form the closed sandbox can produce: it has no
    // ReadableStream/Response globals), an async-iterable, or a native ReadableStream/Response.
    // Anything else is the buffered contract, byte-for-byte unchanged. On an invoke path a
    // stream-capable result is a deterministic refusal, never a silent buffered drain.
    const streamSrc = detectStreamSource(result);
    if (streamSrc && !streaming) {
      return finish({
        status: 400,
        body: { error: "Function returned a streaming response; it is only consumable through functions.fetch", code: "STREAM_RESPONSE_ON_INVOKE" },
        error: "STREAM_RESPONSE_ON_INVOKE", errorClass: "STREAM_RESPONSE_ON_INVOKE",
      });
    }
    if (streamSrc) {
      const sStatus = Number(streamSrc.status) || 200;
      const sHeaders = extractResponseHeaders({ status: sStatus, headers: streamSrc.headers }, redact);
      const body = startStreamPump({
        finish, stream: streamSrc.stream, status: sStatus, quotas, signal,
        redact, secrets: dynamicSecrets.length + secretMap.size > 0,
      });
      return { stream: true, status: sStatus, ...(sHeaders ? { response_headers: sHeaders } : {}), body, config: { webhook: !!config.webhook, method: config.method || "ANY" } };
    }
    const status = Number(result?.status) || 200;
    const body = result && "body" in (result || {}) ? result.body : result;
    const responseHeaders = extractResponseHeaders(result, redact);
    // Response-size quota, enforced on the serialized payload. An oversized response is
    // rejected outright rather than truncated, so a caller never receives a clipped body
    // that looks complete.
    const sized = enforceOutputSize(body, quotas);
    if (sized.violation) {
      return finish({
        status: sized.violation.status, body: { error: sized.violation.message, code: sized.violation.code },
        error: `${sized.violation.code}: ${sized.violation.bytes} bytes`, errorClass: sized.violation.code,
      });
    }
    // Redaction is applied to the outgoing payload too: a function that accidentally
    // echoes a credential must not be able to leak it to the browser.
    const safeBody = JSON.parse(redact(sized.json));
    return finish({ status, body: safeBody, config: { webhook: !!config.webhook, method: config.method || "ANY" }, ...(responseHeaders ? { response_headers: responseHeaders } : {}) });
  } catch (e) {
    // Quota termination: deterministic code, never reported as success, and recorded on the
    // invocation row like any other terminal outcome.
    const quota = e instanceof QuotaExceeded ? classifyQuotaError(e, quotas) : classifyQuotaError(e?.value || e, quotas);
    if (quota) {
      return finish({
        status: quota.status, body: { error: quota.message, code: quota.code },
        error: `${quota.code}: ${quota.kind} limit reached`, errorClass: quota.code,
      });
    }
    const inner = e?.value && typeof e.value === "object" ? e.value : e;
    const message = redact(inner?.message || e?.message || String(e));
    // Structured diagnostics (DatabaseError etc.) keep their code and details for the AI
    // repair loop; the browser still receives only the safe, redacted message.
    const code = inner?.code || null;
    const details = inner?.details ? redact(JSON.stringify(inner.details)).slice(0, 500) : null;
    // An external service failing is reported as an upstream failure (502), never as a
    // platform error (500) or as success. Bad call input from the function is a 400.
    // A per-project usage limit is a deterministic refusal with a known reset, not a platform fault.
    const status = UPSTREAM_CODES.includes(code) ? 502 : code === "INVALID_INPUT" ? 400 : code === "QUOTA_EXCEEDED" ? 429 : 500;
    return finish({
      status,
      body: { error: message.slice(0, 300), ...(code ? { code } : {}) },
      error: code ? `${code}: ${message}${details ? ` ${details}` : ""}` : message,
      errorClass: code || inner?.name || e?.name || "Error",
    });
  }
}