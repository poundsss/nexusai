// functions.fetch(path, init) — the SERVER side of the DOCUMENTED raw-HTTP function surface:
// "Performs a direct HTTP request to a backend function path and returns the native Response"
// (Base44 SDK reference, FunctionsModule.fetch; verified against @base44/sdk 0.8.51).
//
// This module owns ONLY what is additive: bounded validation of the caller's path/init,
// resolution of the function through the EXISTING project-scoped loaders, execution through
// the EXISTING executor (quotas, redaction, size cap and the FunctionInvocation audit are that
// machine's, unchanged) and the raw response envelope the browser reconstructs a native
// Response from. functions.invoke() is untouched everywhere.
//
// PARITY BOUNDARY (audited against the installed SDK implementation):
//   DOCUMENTED: path/init passthrough (method/headers/body; query rides the path string —
//     RequestInit has no query field), any HTTP method token, raw Response semantics
//     (status/ok/headers/body), NO throw on a function's 4xx/5xx, sub-path addressing
//     ("/streaming_demo", "/my-function/endpoint"), optional leading slash.
//   DERIVED (bounded; Base44 publishes none of it): the FIRST path segment resolves the
//     function and the remainder reaches the handler as ctx.request.path; query parsed from
//     the path string; JSON request bodies parsed when the request declares a JSON
//     content-type, any other body verbatim; response content-type derived (handler header,
//     else application/json / text/plain); caps listed in FETCH_LIMITS; null-body statuses
//     (204/205/304) carry no body.
//   STREAMING (implemented, functions.fetch only; certified by functionsStreamingCert): a handler
//     may return a stream-capable result (a plain { next } chunk iterator — the one form the
//     closed sandbox can produce — or a ReadableStream/Response on runtimes that have one).
//     The executor pumps chunks while its stream's start() is pending (the ONE pattern the
//     serving layer delivers incrementally), bounded by the SAME output-size quota and a
//     wall-clock stream ceiling, with the client's AbortSignal threaded to the pump. Status and
//     sanitized headers travel before the first chunk; a mid-stream source failure reaches the
//     client as a clean early close (never an invented error payload). functions.invoke of a
//     streaming function is a deterministic 400 refusal — the invoke envelope is untouched.
//   SERVICE-ROLE (asServiceRole.functions.fetch; certified by appFunctionsServiceRoleFetchParityTest
//     + asrFetchStreamingCert): the SAME machinery with streaming: true and a genuine init.signal
//     threaded to the pump; a stream-capable inner result is a NATIVE stream-capable Response
//     (status + sanitized headers before the body, the executor-owned ReadableStream as body),
//     and every non-streaming result keeps the buffered G-C envelope unchanged.
//   UNKNOWN (never invented): reconnect/heartbeat/backpressure, billing for fetch, FormData
//     request bodies, deeper sub-path routing semantics, error mapping beyond this envelope.
import { executeProjectFunction } from "./functionRuntime.ts";
import { FUNCTION_NAME_RE } from "./functionPaths.ts";

export const FETCH_LIMITS = {
  MAX_PATH_CHARS: 2048,
  MAX_METHOD_CHARS: 16,
  MAX_HEADERS: 50,
  MAX_HEADER_NAME: 128,
  MAX_HEADER_VALUE: 8192,
  MAX_QUERY_PARAMS: 50,
  MAX_QUERY_VALUE: 2048,
  MAX_BODY_CHARS: 524288,
};

// Framing/hop-by-hop headers that can never travel through this surface.
const REQUEST_HEADER_DENY = new Set(["host", "connection", "content-length", "transfer-encoding"]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const fetchError = (code, status, message) => Object.assign(new Error(message), { code, status });

function parseFetchPath(raw) {
  const path = String(raw ?? "");
  if (!path || path.length > FETCH_LIMITS.MAX_PATH_CHARS) {
    throw fetchError("FETCH_INVALID_ARGS", 400, "fetch requires a function path such as '/myFunction'");
  }
  // The URL-parser's view of the input (tab/newline stripping + leading C0 trim), an optional
  // leading slash (DOCUMENTED: '/chat' and 'chat' are equivalent), then the same
  // one-leading-slash rule as the SDK's own origin guard: no scheme and no host ever.
  const asParsed = path.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "");
  const normalized = asParsed.startsWith("/") ? asParsed : `/${asParsed}`;
  if (normalized.startsWith("//") || normalized.startsWith("/\\")) {
    throw fetchError("FETCH_INVALID_ARGS", 400, `fetch path must be a relative function path, received "${path.slice(0, 100)}"`);
  }
  let url;
  try { url = new URL(normalized, "http://function.invalid"); } catch {
    throw fetchError("FETCH_INVALID_ARGS", 400, `fetch path is not a valid path: "${path.slice(0, 100)}"`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const name = segments[0] || "";
  if (!FUNCTION_NAME_RE.test(name)) {
    throw fetchError("FETCH_INVALID_ARGS", 400, `fetch path does not name a backend function: "${name || "/"}"`);
  }
  const query = {};
  let count = 0;
  for (const [k, v] of url.searchParams) {
    if (count >= FETCH_LIMITS.MAX_QUERY_PARAMS) break;
    if (!k || k.length > FETCH_LIMITS.MAX_HEADER_NAME || v.length > FETCH_LIMITS.MAX_QUERY_VALUE) continue;
    query[k] = v; // DERIVED: a repeated key keeps its last value, like a URLSearchParams view
    count++;
  }
  return { name, path: "/" + segments.slice(1).join("/"), query };
}

/**
 * Validates and shapes the caller's fetch(path, init) into the executor's request contract.
 * Throws a structured FETCH_* refusal for invalid input; invents no routing semantics.
 */
export function buildFetchRequest(args = {}) {
  const parsed = parseFetchPath(args.path);
  const method = args.method === undefined || args.method === null ? "GET" : String(args.method).toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(method) || method.length > FETCH_LIMITS.MAX_METHOD_CHARS) {
    throw fetchError("FETCH_INVALID_ARGS", 400, `unsupported fetch method "${String(args.method).slice(0, 32)}"`);
  }
  const headers = {};
  let headerCount = 0;
  if (args.headers !== undefined && args.headers !== null) {
    if (typeof args.headers !== "object" || Array.isArray(args.headers)) {
      throw fetchError("FETCH_INVALID_ARGS", 400, "fetch headers must be an object of name/value pairs");
    }
    for (const [k, v] of Object.entries(args.headers)) {
      if (headerCount >= FETCH_LIMITS.MAX_HEADERS) break;
      const name = String(k).toLowerCase();
      if (!name || name.length > FETCH_LIMITS.MAX_HEADER_NAME) continue;
      if (REQUEST_HEADER_DENY.has(name)) continue;
      headers[name] = String(v ?? "").slice(0, FETCH_LIMITS.MAX_HEADER_VALUE);
      headerCount++;
    }
  }
  let body = null;
  if (typeof args.body === "string") {
    if (args.body.length > FETCH_LIMITS.MAX_BODY_CHARS) throw fetchError("FETCH_BODY_TOO_LARGE", 413, "fetch body exceeds the size limit");
    body = args.body;
  } else if (typeof args.body_base64 === "string") {
    let decoded;
    try { decoded = atob(args.body_base64); } catch {
      throw fetchError("FETCH_INVALID_ARGS", 400, "fetch body_base64 is not valid base64");
    }
    if (decoded.length > FETCH_LIMITS.MAX_BODY_CHARS) throw fetchError("FETCH_BODY_TOO_LARGE", 413, "fetch body exceeds the size limit");
    body = decoded;
  } else if (args.body !== undefined && args.body !== null) {
    throw fetchError("FETCH_INVALID_ARGS", 400, "fetch body must be a string or binary data (body_base64)");
  }
  // DERIVED: a body declared JSON is parsed for the handler; any other body travels verbatim.
  if (typeof body === "string" && (headers["content-type"] || "").includes("json")) {
    try { body = JSON.parse(body); } catch {
      throw fetchError("FETCH_INVALID_ARGS", 400, "fetch body is not valid JSON despite its content-type");
    }
  }
  return { name: parsed.name, path: parsed.path, query: parsed.query, method, headers, body };
}

/**
 * Derives the raw Response envelope from the executor's result. Pure: no status is invented and
 * no error is thrown for a function-level 4xx/5xx — the caller receives it as the Response.
 * Only infrastructure refusals reject the promise, exactly like a failed network request.
 */
export function fetchResponseEnvelope(result) {
  const status = Number(result?.status) || 200;
  const headers = { ...(result?.response_headers || {}) };
  const body = result?.body;
  const hasBody = body !== undefined && body !== null && !NULL_BODY_STATUSES.has(status);
  let bodyText = null;
  if (hasBody) {
    bodyText = typeof body === "string" ? body : JSON.stringify(body);
    if (!("content-type" in headers)) {
      headers["content-type"] = typeof body === "string" ? "text/plain;charset=utf-8" : "application/json";
    }
  }
  return { status, ok: status >= 200 && status < 300, headers, has_body: hasBody, ...(hasBody ? { body_text: bodyText } : {}) };
}

/**
 * Runs ONE functions.fetch request end-to-end through the EXISTING machinery. `loadSource` is
 * the surface's own project-scoped resolver (preview: the project's files; deployed: the
 * immutable artifact), so resolution, quotas, redaction, the size cap and the invocation audit
 * are all the existing contracts, unchanged.
 */
export async function runProjectFunctionFetch(client, {
  project, entities = [], integrations = [], args = {}, user = null, session = null, loadSource,
  // Streaming (additive): when true, a stream-capable handler result is returned as a
  // { __stream__ } envelope carrying the executor-owned ReadableStream; when false, the buffered
  // envelope is returned unchanged.
  streaming = false,
  // Caller-abort signal, passed to the executor's stream pump (client AbortController threading).
  signal = null,
  // Executor quota overrides (tighten only), forwarded to the SAME execution the invoke path
  // serves — the stream pump's output-size cap and wall-clock ceiling read them.
  quotas = {},
}) {
  const request = buildFetchRequest(args);
  const { source } = await loadSource(request.name);
  const result = await executeProjectFunction(client, {
    project, entities, integrations, name: request.name, source,
    trigger: "frontend", requestId: crypto.randomUUID(),
    request: {
      method: request.method, query: request.query, headers: request.headers,
      body: request.body, path: request.path,
    },
    user, session, streaming, signal, quotas,
  });
  return streamResponseEnvelope(result);
}

/**
 * Streaming (additive): a stream-capable executor result ({ stream: true, body: ReadableStream })
 * becomes the { __stream__ } envelope the fetch endpoints return as a raw passthrough Response —
 * the function's status and sanitized headers travel BEFORE the body and no body content is
 * buffered or re-serialized here. Anything else is the existing buffered envelope, unchanged.
 * A stream on a null-body status (204/205/304) degrades to the buffered envelope (no body).
 */
export function streamResponseEnvelope(result) {
  if (!result || result.stream !== true) return fetchResponseEnvelope(result);
  const status = Number(result.status) || 200;
  if (NULL_BODY_STATUSES.has(status)) return fetchResponseEnvelope({ status, body: null });
  const headers = { ...(result.response_headers || {}) };
  if (!("content-type" in headers)) headers["content-type"] = "application/octet-stream";
  return { __stream__: true, status, ok: status >= 200 && status < 300, headers, body: result.body };
}