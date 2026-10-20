// External Tool abstraction: the execution-side view of an integration operation.
//
//   ExternalTool = { name, description, input_schema, output_schema, auth_ref, adapter }
//
// Each tool is executed by an ADAPTER, and both adapters are real:
//   `http`  — routes through the function runtime's outbound HTTP path (timeouts, host guard,
//             diagnostics, redaction), with OAuth2 token exchange and bounded, idempotency-aware
//             retries for transient upstream failures.
//   `mcp`   — executes a real MCP server tool over JSON-RPC Streamable HTTP using the same
//             protocol client as the builder's MCP connections.
// Credentials (static secrets AND minted OAuth2 access tokens) are resolved server-side here
// and never enter the sandbox.

import { createMcpClient, normalizeToolResult } from "./mcp.ts";
import { parseRetryAfter } from "./integrationRateLimit.ts";
import { breakerConfig } from "./integrationBreaker.ts";
import { quotaConfig } from "./integrationQuota.ts";

export const INTEGRATION_ERROR_CODES = ["INTEGRATION_NOT_FOUND", "OPERATION_NOT_FOUND", "INVALID_INPUT", "AUTH_FAILURE", "TIMEOUT", "UPSTREAM_FAILURE", "PLATFORM_FAILURE", "QUOTA_EXCEEDED", "NOT_IMPLEMENTED"];
// Failures caused by the external service (or its credentials), as opposed to the platform.
export const UPSTREAM_CODES = ["AUTH_FAILURE", "TIMEOUT", "UPSTREAM_FAILURE"];

export function integrationError(code, message, details) {
  return Object.assign(new Error(message), { name: "IntegrationError", code, details: details || {} });
}

// Blocks loopback/link-local/private/metadata targets so generated code (or an imported
// OpenAPI document) cannot use the platform's network position to reach internal services.
// Two layers share ONE address blocklist:
//   assertAllowedUrl  — the synchronous fast check: URL shape, hostname rules, and IP
//                       literals (dotted IPv4 and bracketed IPv6, incl. IPv4-mapped tails).
//   assertResolvedUrl — the DNS-rebinding check: resolves the hostname and validates EVERY
//                       address it maps to before an outbound request is dispatched. A
//                       hostname resolving to any non-public address — or failing to
//                       resolve at all — is refused (fail closed).

// Lowercased hostname without the brackets URL.hostname keeps around IPv6 literals.
export function normalizeHostname(raw) {
  const h = String(raw || "").toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

// Expands an IPv6 literal (with or without brackets, optional dotted-IPv4 tail) to its 8
// groups. Returns null when the literal does not parse; the caller treats that as blocked.
function expandIpv6(raw) {
  let h = normalizeHostname(raw);
  if (!h.includes(":")) return null;
  const v4 = h.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = v4[2].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    h = `${v4[1]}${(((o[0] << 8) | o[1]) & 0xffff).toString(16)}:${(((o[2] << 8) | o[3]) & 0xffff).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/i.test(h)) return null;
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

// ONE answer to "may this IP be an outbound target": false only for public unicast.
// Unparseable input is blocked (fail closed). Covers IPv4 loopback/private/link-local/
// metadata/CGNAT/multicast/reserved ranges and their IPv6 equivalents, including
// IPv4-mapped IPv6 whose embedded IPv4 is itself non-public.
export function isBlockedIpAddress(ip) {
  const s = String(ip || "").trim();
  if (s.includes(":")) {
    const g = expandIpv6(s);
    if (!g) return true;
    // ::/80 region: unspecified (::), loopback (::1), and IPv4-mapped (::ffff:0:0/96).
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
      if (g[5] === 0xffff) {
        return isBlockedIpAddress(`${(g[6] >> 8) & 255}.${g[6] & 255}.${(g[7] >> 8) & 255}.${g[7] & 255}`);
      }
      return true;
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local (private)
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true;
  const a = Number(m[1]), b = Number(m[2]);
  if (a > 255 || Number(m[2]) > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a >= 224;
}

// The synchronous fast check. IP literals are validated against the shared blocklist; other
// hostnames keep the original name-based rules until assertResolvedUrl re-checks what they
// actually resolve to.
export function assertAllowedUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error(`http: invalid URL "${raw}"`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`http: protocol ${url.protocol} is not allowed`);
  const host = normalizeHostname(url.hostname);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    if (isBlockedIpAddress(host)) throw new Error(`http: host ${url.hostname} is not allowed`);
    return url;
  }
  const blocked = host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error(`http: host ${host} is not allowed`);
  return url;
}

// DNS-rebinding guard, run before the outbound request is dispatched. Resolves the hostname
// through node:dns/promises (supported by both the Deno runtime and Node tooling) and
// refuses the URL when ANY resolved address is non-public, or when resolution fails /
// returns nothing — fail closed. IP literals were already validated by assertAllowedUrl
// and pass through untouched.
// Optional test hook: DNS resolution is part of the outbound network boundary, so a test
// that scripts that boundary may install a lookup here. It receives the hostname and returns
// { address, family }[] entries for the hosts it scripts (or throws, which reads as
// "could not resolve"). Production NEVER installs one — the real resolver below stays the
// only path in every non-test execution.
let testDnsLookup = null;
export function setDnsLookupForTests(fn) { testDnsLookup = fn || null; }

export async function assertResolvedUrl(url) {
  const host = normalizeHostname(url.hostname);
  if (!host || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return url;
  let entries;
  try {
    if (testDnsLookup) {
      entries = await testDnsLookup(host);
    } else {
      const dns = await import("node:dns/promises").then((m) => m.default ?? m);
      entries = await dns.lookup(host, { all: true, verbatim: true });
    }
  } catch {
    throw new Error(`http: could not resolve host ${host}`);
  }
  if (!entries?.length) throw new Error(`http: could not resolve host ${host}`);
  for (const e of entries) {
    if (isBlockedIpAddress(e.address)) throw new Error(`http: host ${host} resolves to a non-public address (${e.address})`);
  }
  return url;
}

function inputSchemaOf(op) {
  if (op.tool) return op.input_schema || { type: "object" };
  const properties = {}; const required = [];
  for (const p of op.parameters || []) { properties[p.name] = { type: p.type || "string", ...(p.description ? { description: p.description } : {}), location: p.in }; if (p.required) required.push(p.name); }
  if (op.request_body) properties.body = op.request_body.schema || { type: "object" };
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

export function toExternalTools(integration) {
  return (integration.operations || []).map((op) => ({
    name: `${integration.name}.${op.name}`, integration: integration.name, operation: op.name,
    description: op.description || (op.tool ? `MCP tool ${op.tool}` : `${op.method} ${op.path}`),
    input_schema: inputSchemaOf(op), output_schema: op.response_schema || { type: "object" },
    auth_ref: integration.auth?.secret || null,
    adapter: integration.type === "mcp" ? "mcp" : "http",
  }));
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return { code: "AUTH_FAILURE", kind: status === 401 ? "unauthorized" : "forbidden" };
  if (status === 404) return { code: "UPSTREAM_FAILURE", kind: "not_found" };
  if (status === 429) return { code: "UPSTREAM_FAILURE", kind: "rate_limited" };
  if (status >= 500) return { code: "UPSTREAM_FAILURE", kind: "server_error" };
  return { code: "UPSTREAM_FAILURE", kind: "client_error" };
}

const preview = (body) => { const t = typeof body === "string" ? body : JSON.stringify(body ?? null); return String(t).slice(0, 200); };

// --- OAuth2 ------------------------------------------------------------------
// Machine-to-machine OAuth2 (client_credentials and refresh_token). The stored credential is
// exchanged for a short-lived access token HERE, server-side: the token is cached in memory
// for its lifetime, handed to the redactor so it can never appear in a log or response body,
// injected as a bearer header by the adapter, and never persisted or exposed to the sandbox.
const tokenCache = new Map();
const TOKEN_SAFETY_MS = 15000;
const MAX_TOKEN_CACHE = 50;

// Project-scoped key: the cache key includes the calling project's id, so two projects with
// IDENTICAL OAuth configuration (same integration name, grant, token_url, client_id, scope,
// audience) can never reuse each other's cached token. A caller that supplies no project id
// (tests, direct tool execution) degrades to an unscoped key and behaves as before.
export function oauthCacheKey(integration, projectId = null) {
  const a = integration.auth || {};
  return [projectId || "", integration.name, a.grant, a.token_url, a.client_id, a.scope || "", a.audience || ""].join("|");
}

export function clearOAuthCache() { tokenCache.clear(); }

async function resolveOAuthToken(integration, op, deps) {
  const a = integration.auth;
  const ref = { integration: integration.name, operation: op.name };
  const key = oauthCacheKey(integration, deps.projectId);
  const hit = tokenCache.get(key);
  if (hit && hit.expires_at > Date.now() + TOKEN_SAFETY_MS) { deps.protect?.(hit.token); return hit.token; }

  const credential = deps.resolveSecret(a.secret);
  if (!credential) throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: project secret ${a.secret} is not set — add it in the Secrets panel`, { ...ref, kind: "secret_not_set", secret: a.secret });
  const clientSecret = a.client_secret ? deps.resolveSecret(a.client_secret) : null;
  if (a.client_secret && !clientSecret) throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: project secret ${a.client_secret} is not set — add it in the Secrets panel`, { ...ref, kind: "secret_not_set", secret: a.client_secret });

  const form = new URLSearchParams();
  form.set("grant_type", a.grant);
  if (a.grant === "refresh_token") form.set("refresh_token", credential);
  if (a.scope) form.set("scope", a.scope);
  if (a.audience) form.set("audience", a.audience);
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const secretForRequest = a.grant === "client_credentials" ? credential : clientSecret;
  if (a.credentials_in === "basic_header" && secretForRequest) {
    headers.Authorization = `Basic ${btoa(`${a.client_id}:${secretForRequest}`)}`;
  } else {
    form.set("client_id", a.client_id);
    if (secretForRequest) form.set("client_secret", secretForRequest);
  }

  // The OAuth2 token endpoint is an outbound target too: the same SSRF gate as any other URL.
  try { await assertResolvedUrl(assertAllowedUrl(a.token_url)); }
  catch (e) { throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, kind: "oauth_unreachable" }); }

  let res;
  try {
    res = await deps.http(a.token_url, { method: "POST", headers, body: form.toString(), timeoutMs: integration.timeout_ms });
  } catch (e) {
    const host = (() => { try { return new URL(a.token_url).hostname; } catch { return "token endpoint"; } })();
    if (e.kind === "timeout") throw integrationError("TIMEOUT", `${integration.name}.${op.name}: the OAuth2 token endpoint ${host} did not respond within ${integration.timeout_ms}ms`, { ...ref, host, kind: "oauth_timeout" });
    throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: could not reach the OAuth2 token endpoint ${host} (${e.message})`, { ...ref, host, kind: "oauth_unreachable" });
  }
  const payload = res.body && typeof res.body === "object" ? res.body : {};
  if (!res.ok) {
    throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: the OAuth2 token endpoint rejected the ${a.grant} grant (HTTP ${res.status}${payload.error ? `, ${payload.error}` : ""})`, { ...ref, status: res.status, kind: "oauth_rejected", upstream_body: preview(res.body) });
  }
  const token = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!token) throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: the OAuth2 token endpoint returned no access_token`, { ...ref, kind: "oauth_no_token", upstream_body: preview(res.body) });
  // The token is a live credential from this moment on: register it for redaction before it
  // can reach a header, a log line or an error message.
  deps.protect?.(token);
  const ttl = Math.max(30000, (Number(payload.expires_in) || 300) * 1000);
  if (tokenCache.size >= MAX_TOKEN_CACHE) tokenCache.clear();
  tokenCache.set(key, { token, expires_at: Date.now() + ttl });
  deps.log?.(`[oauth2] ${integration.name}: obtained a ${a.grant} access token (expires in ${Math.round(ttl / 1000)}s)`);
  return token;
}

// --- retry engine ------------------------------------------------------------
// Bounded, idempotency-aware retries for transient upstream failures. A non-idempotent
// operation (POST/PATCH without an explicit idempotent flag) is NEVER retried, so the engine
// can never duplicate a side effect on the third-party service.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

export function isRetryable(integration, op, outcome) {
  const policy = integration.retry || { max_attempts: 1, retry_on_status: [] };
  if (policy.max_attempts <= 1) return false;
  if (!(op.idempotent === true || IDEMPOTENT_METHODS.has(String(op.method || "").toUpperCase()) || (op.tool && op.read_only))) return false;
  if (outcome.kind === "timeout" || outcome.kind === "network") return true;
  return typeof outcome.status === "number" && (policy.retry_on_status || []).includes(outcome.status);
}

// The wait before one retry, and WHY it is that long.
//
// An upstream that states a delay is obeyed: both forms of Retry-After are honoured (numeric
// seconds and HTTP-date), and the stated delay is no longer silently clamped to 2000ms — a
// service asking for 30s gets 30s or the call is not retried at all (see the wait budget below).
export function retryDelay(integration, attempt, retryAfterHeader, now = Date.now()) {
  const base = (integration.retry?.backoff_ms || 200) * attempt;
  const parsed = parseRetryAfter(retryAfterHeader, now);
  if (parsed && parsed.source !== "invalid") {
    return { wait_ms: Math.max(base, parsed.ms), retry_after_ms: parsed.ms, retry_after_source: parsed.source };
  }
  return { wait_ms: base, retry_after_ms: null, retry_after_source: parsed ? "invalid" : "absent" };
}

/**
 * Total time one logical call may spend WAITING between attempts. Bounded by the operation's own
 * timeout budget, so honouring a long Retry-After can never turn a 12s operation into a minute
 * of silent sleeping — the call is refused deterministically instead.
 */
export const waitBudgetOf = (integration) => Number(integration.retry?.max_wait_ms) || integration.timeout_ms || 12000;

// deps = { http(url, options), resolveSecret(name) → value | undefined, log }
async function httpAdapter(integration, op, params, options, deps) {
  const ref = { integration: integration.name, operation: op.name, method: op.method };
  if (integration.status === "disabled") throw integrationError("PLATFORM_FAILURE", `Integration "${integration.name}" is disabled`, { ...ref, kind: "disabled" });
  const input = params && typeof params === "object" ? params : {};
  const opts = options && typeof options === "object" ? options : {};

  let path = op.path;
  const query = {}; const headers = { ...(integration.headers || {}), ...(opts.headers || {}) };
  const declared = new Set();
  for (const p of op.parameters || []) {
    declared.add(p.name);
    const v = input[p.name];
    if (v === undefined || v === null || v === "") {
      if (p.required) throw integrationError("INVALID_INPUT", `${integration.name}.${op.name}: missing required ${p.in} parameter "${p.name}"`, { ...ref, kind: "missing_parameter", parameter: p.name, location: p.in });
      continue;
    }
    if (p.in === "path") path = path.replace(new RegExp(`\\{${p.name}\\}`, "g"), encodeURIComponent(String(v)));
    else if (p.in === "query") query[p.name] = v;
    else headers[p.name] = String(v);
  }
  for (const [k, v] of Object.entries(input)) if (!declared.has(k) && k !== "body" && v !== undefined && v !== null) query[k] = v;

  let url;
  try { url = assertAllowedUrl(integration.base_url + path); } catch (e) { throw integrationError("PLATFORM_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, kind: "invalid_url" }); }
  // A well-formed but UNRESOLVABLE host is an upstream-unhealthy signal the circuit breaker counts
  // (kind "network"), NOT a config error (kind "invalid_url"). Keeping the two apart is what lets
  // repeated DNS failures trip the breaker instead of being silently excluded as bad configuration.
  try { await assertResolvedUrl(url); } catch (e) { throw integrationError("PLATFORM_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, host: url.hostname, kind: "network" }); }

  // If this project+integration+host is still inside a window the upstream itself declared,
  // refuse deterministically instead of hitting it again. Checked BEFORE any credential is
  // resolved, so a deferred call never touches a secret.
  let rateLimit = null;
  if (deps.rateLimit) {
    const known = await deps.rateLimit.check({ integration: integration.name, host: url.hostname }).catch(() => null);
    if (known) {
      throw integrationError("UPSTREAM_FAILURE", `${integration.name}.${op.name}: ${url.hostname} rate limited this integration (HTTP 429) and asked to wait until ${known.retry_until}; the request was not sent`, {
        ...ref, host: url.hostname, status: 429, kind: "rate_limited", attempts: 0,
        rate_limit: { limited: true, status: 429, ...known, refused_before_call: true, retry_skipped: true, skip_reason: "window_open" },
      });
    }
  }

  // Credential injection happens here, server-side only. The value never enters the sandbox.
  // Delegated credential (#31G): an app user authorized this call ON THEIR BEHALF. The resolver
  // validates the credential belongs to the executing user, refreshes if expired, and hands the
  // bearer to `protect` for redaction before it can reach a header, log or error. Takes precedence
  // over the integration's own auth — a delegated call never falls back to a static secret.
  if (opts.credential?.kind === "delegated" && deps.resolveDelegatedCredential) {
    try {
      headers["Authorization"] = `Bearer ${await deps.resolveDelegatedCredential(opts.credential)}`;
    } catch (e) {
      throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, kind: e.details?.kind || "delegated_error" });
    }
  } else {
    const auth = integration.auth || { type: "none" };
    if (auth.type === "oauth2") {
      headers["Authorization"] = `Bearer ${await resolveOAuthToken(integration, op, deps)}`;
    } else if (auth.type !== "none") {
      const value = deps.resolveSecret(auth.secret);
      if (!value) throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: project secret ${auth.secret} is not set — add it in the Secrets panel`, { ...ref, kind: "secret_not_set", secret: auth.secret });
      if (auth.type === "bearer") headers["Authorization"] = `Bearer ${value}`;
      else if (auth.in === "query") query[auth.header_name] = value;
      else headers[auth.header_name] = value;
    }
  }

  const body = opts.body !== undefined ? opts.body : input.body;
  const maxAttempts = integration.retry?.max_attempts || 1;
  const waitBudget = waitBudgetOf(integration);
  let waitSpent = 0;
  let attempt = 0;
  for (;;) {
    attempt++;
    let res, failure = null;
    try {
      res = await deps.http(url.toString(), { method: op.method, query, headers, ...(body !== undefined && op.method !== "GET" ? { json: body } : {}), timeoutMs: integration.timeout_ms });
    } catch (e) {
      if (e.kind !== "timeout" && e.kind !== "network") throw integrationError("PLATFORM_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, host: url.hostname, kind: "runtime" });
      failure = { kind: e.kind, message: e.message };
    }
    const outcome = failure || { kind: res.ok ? "ok" : "status", status: res.status };
    if (!failure && res.ok) {
      if (attempt > 1) deps.log?.(`[integration] ${integration.name}.${op.name} succeeded on attempt ${attempt}/${maxAttempts}`);
      return { ok: true, status: res.status, headers: res.headers, body: res.body, attempts: attempt, ...(rateLimit ? { rate_limit: rateLimit } : {}) };
    }
    // A 429 is the upstream declaring a limit. Remember exactly what it said (nothing more), so
    // the next call for THIS project+integration+host does not walk into the same closed door.
    if (!failure && res.status === 429) {
      const parsed = parseRetryAfter(res.headers?.["retry-after"]);
      rateLimit = {
        limited: true, status: 429,
        retry_after_ms: parsed && parsed.source !== "invalid" ? parsed.ms : null,
        retry_after_source: parsed ? parsed.source : "absent",
        retry_until: parsed && parsed.source !== "invalid" && parsed.ms > 0 ? new Date(Date.now() + parsed.ms).toISOString() : null,
      };
      if (deps.rateLimit) {
        try { await deps.rateLimit.note({ integration: integration.name, host: url.hostname, ...rateLimit }); } catch { /* observability must not fail the call */ }
      }
    }
    // Retry only when the policy allows it AND the operation is safe to repeat. This idempotency
    // rule is unchanged: a POST/PATCH without an explicit idempotent flag is never retried,
    // whatever the upstream asked for.
    if (attempt < maxAttempts && isRetryable(integration, op, outcome)) {
      const { wait_ms, retry_after_ms, retry_after_source } = retryDelay(integration, attempt, res?.headers?.["retry-after"]);
      const remaining = waitBudget - waitSpent;
      if (wait_ms > remaining) {
        // The upstream asked for longer than this operation has left. Deterministic refusal —
        // never a silent clamp that ignores what the service said.
        const state = { ...(rateLimit || { limited: res?.status === 429, status: res?.status ?? 0 }), retry_after_ms, retry_after_source, requested_wait_ms: wait_ms, remaining_budget_ms: remaining, wait_budget_ms: waitBudget, retry_skipped: true, skip_reason: "wait_exceeds_budget" };
        throw integrationError("UPSTREAM_FAILURE", `${integration.name}.${op.name}: ${url.hostname} asked to wait ${Math.round(wait_ms / 1000)}s before retrying, which exceeds the ${Math.round(remaining / 1000)}s this operation has left; the call was not retried`, {
          ...ref, host: url.hostname, status: res?.status ?? 0, kind: res?.status === 429 ? "rate_limited" : outcome.kind,
          attempts: attempt, rate_limit: state,
        });
      }
      waitSpent += wait_ms;
      if (rateLimit) rateLimit = { ...rateLimit, chosen_wait_ms: wait_ms, retry_after_source };
      deps.log?.(`[integration] ${integration.name}.${op.name} attempt ${attempt}/${maxAttempts} failed (${failure ? failure.kind : `HTTP ${res.status}`}); retrying in ${wait_ms}ms (retry-after: ${retry_after_source})`);
      await sleep(wait_ms);
      continue;
    }
    if (failure) {
      const code = failure.kind === "timeout" ? "TIMEOUT" : "UPSTREAM_FAILURE";
      const message = failure.kind === "timeout"
        ? `${integration.name}.${op.name}: ${url.hostname} did not respond within ${integration.timeout_ms}ms`
        : `${integration.name}.${op.name}: could not reach ${url.hostname} (${failure.message})`;
      throw integrationError(code, message, { ...ref, host: url.hostname, kind: failure.kind, attempts: attempt, ...(rateLimit ? { rate_limit: rateLimit } : {}) });
    }
    const { code, kind } = classifyStatus(res.status);
    throw integrationError(code, `${integration.name}.${op.name}: ${url.hostname} responded ${res.status}`, { ...ref, host: url.hostname, status: res.status, kind, attempts: attempt, upstream_body: preview(res.body), ...(rateLimit ? { rate_limit: { ...rateLimit, retry_skipped: attempt >= maxAttempts ? false : !isRetryable(integration, op, { kind: "status", status: res.status }), ...(isRetryable(integration, op, { kind: "status", status: res.status }) ? {} : { skip_reason: "not_idempotent_or_not_retryable" }) } } : {}) });
  }
}

// Executable MCP: a project integration of type "mcp" calls a real MCP server through the
// SAME protocol client the builder's MCP connections use (JSON-RPC over Streamable HTTP,
// initialize → tools/call, host guard, redaction). Credentials are resolved server-side and
// never enter the sandbox; MCP protocol failures are mapped onto the integration error
// vocabulary so generated code and the AI repair loop see one consistent contract.
function requiredFromSchema(schema, args) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return required.filter((k) => args?.[k] === undefined || args?.[k] === null || args?.[k] === "");
}

const MCP_TO_INTEGRATION = {
  MCP_TIMEOUT: "TIMEOUT",
  MCP_AUTH_FAILURE: "AUTH_FAILURE",
  MCP_INVALID_INPUT: "INVALID_INPUT",
  MCP_TOOL_NOT_FOUND: "OPERATION_NOT_FOUND",
  MCP_CONNECTION_FAILURE: "UPSTREAM_FAILURE",
  MCP_INITIALIZATION_FAILURE: "UPSTREAM_FAILURE",
  MCP_TOOL_EXECUTION_FAILURE: "UPSTREAM_FAILURE",
};

async function mcpAdapter(integration, op, params, options, deps) {
  const ref = { integration: integration.name, operation: op.name, tool: op.tool, adapter: "mcp" };
  if (integration.status === "disabled") throw integrationError("PLATFORM_FAILURE", `Integration "${integration.name}" is disabled`, { ...ref, kind: "disabled" });
  const args = params && typeof params === "object" ? params : {};
  const missing = requiredFromSchema(op.input_schema, args);
  if (missing.length) throw integrationError("INVALID_INPUT", `${integration.name}.${op.name}: missing required argument(s) ${missing.join(", ")} for MCP tool "${op.tool}"`, { ...ref, kind: "missing_parameter", missing });

  const auth = integration.auth || { type: "none" };
  let conn = { server_url: integration.server_url, auth_type: "none" };
  let credential = null;
  // Delegated credential (#31G): an app user authorized this call ON THEIR BEHALF. The resolver
  // validates ownership, refreshes expired tokens, and hands the bearer to `protect` for redaction.
  // Takes precedence over the integration's own auth — a delegated call never falls back to a secret.
  if (options?.credential?.kind === "delegated" && deps.resolveDelegatedCredential) {
    try {
      credential = await deps.resolveDelegatedCredential(options.credential);
    } catch (e) {
      throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, kind: e.details?.kind || "delegated_error" });
    }
    conn = { server_url: integration.server_url, auth_type: "bearer" };
  } else if (auth.type === "oauth2") {
    credential = await resolveOAuthToken(integration, op, deps);
    conn = { server_url: integration.server_url, auth_type: "bearer" };
  } else if (auth.type !== "none") {
    credential = deps.resolveSecret(auth.secret);
    if (!credential) throw integrationError("AUTH_FAILURE", `${integration.name}.${op.name}: project secret ${auth.secret} is not set — add it in the Secrets panel`, { ...ref, kind: "secret_not_set", secret: auth.secret });
    conn = auth.type === "bearer"
      ? { server_url: integration.server_url, auth_type: "bearer" }
      : { server_url: integration.server_url, auth_type: "header", auth_header_name: auth.header_name || "X-API-Key" };
  }

  // The MCP server is an outbound target too: the same SSRF gate as any other URL. The MCP
  // client re-applies the literal check; this adds the DNS-resolution layer before any
  // request is made.
  let mcpUrl;
  try { mcpUrl = assertAllowedUrl(integration.server_url); } catch (e) { throw integrationError("PLATFORM_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, kind: "invalid_url" }); }
  // DNS resolution failure on a well-formed MCP server URL is upstream-unhealthy (kind "network"),
  // so repeated failures engage the circuit breaker — distinct from a malformed URL (invalid_url).
  try { await assertResolvedUrl(mcpUrl); } catch (e) { throw integrationError("PLATFORM_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, host: mcpUrl.hostname, kind: "network" }); }

  // Claim an outbound-call slot before talking to the server, so an MCP integration cannot
  // exceed the function's external-call budget.
  try { deps.reserve?.(); } catch (e) { throw integrationError("PLATFORM_FAILURE", `${integration.name}.${op.name}: ${e.message}`, { ...ref, kind: "budget" }); }
  const started = Date.now();
  let host = "";
  try {
    const client = deps.createMcpClient(conn, credential, { timeoutMs: integration.timeout_ms });
    host = client.host;
    await client.initialize();
    const raw = await client.callTool(op.tool, { ...args, ...(options?.arguments && typeof options.arguments === "object" ? options.arguments : {}) });
    const normalized = deps.normalizeToolResult(raw, client.safe);
    deps.track?.({ host, method: "MCP", status: normalized.is_error ? 502 : 200, duration_ms: Date.now() - started });
    if (normalized.is_error) {
      throw integrationError("UPSTREAM_FAILURE", `${integration.name}.${op.name}: MCP tool "${op.tool}" reported an error: ${normalized.text.slice(0, 300)}`, { ...ref, host, kind: "tool_error" });
    }
    return { ok: true, status: 200, body: { text: normalized.text, structured: normalized.structured, content_types: normalized.content_types }, attempts: 1 };
  } catch (e) {
    if (e.name === "IntegrationError") throw e;
    const code = MCP_TO_INTEGRATION[e.code] || "UPSTREAM_FAILURE";
    deps.track?.({ host, method: "MCP", status: code === "TIMEOUT" ? 0 : 502, duration_ms: Date.now() - started });
    throw integrationError(code, `${integration.name}.${op.name}: ${e.message}`, { ...ref, host, mcp_code: e.code || null, ...(e.details || {}) });
  }
}

export const ADAPTERS = { http: httpAdapter, mcp: mcpAdapter };

// MCP protocol primitives are injected (with the shared implementation as the default) so the
// adapter has one real transport and tests can drive it against a controlled server.
export function withAdapterDefaults(deps) {
  return { createMcpClient, normalizeToolResult, ...deps };
}

const hostOf = (integration) => {
  try { return new URL(integration.type === "mcp" ? integration.server_url : integration.base_url).hostname; } catch { return ""; }
};

// Observability wrapper. It measures ONE logical call — the operation the generated code asked
// for — and reports it once, whatever the retry engine did inside. It changes nothing about
// execution: the adapter, its retries and the error the caller receives are untouched, and a
// failed observation is swallowed so telemetry can never break an integration.
export async function executeExternalTool(integration, op, params, options, deps) {
  const adapter = ADAPTERS[integration.type === "mcp" ? "mcp" : "http"];
  const full = withAdapterDefaults(deps);

  // Circuit breaker (#31C). It judges the LOGICAL call — consulted once before it, settled once
  // after it — so a call that spent three retry attempts still produces one breaker decision. A
  // rate-limit window remains #31B's: it is checked inside the adapter and is never counted here.
  const breakerHost = hostOf(integration);
  const breakerConf = full.breaker ? breakerConfig(integration) : null;
  const gate = full.breaker && breakerConf.enabled
    ? await full.breaker.check({ integration: integration.name, host: breakerHost, config: breakerConf }).catch(() => null)
    : null;
  const refusal = gate && gate.allow === false
    ? integrationError("UPSTREAM_FAILURE", `${integration.name}.${op.name}: the circuit breaker for ${breakerHost} is ${gate.breaker_state?.state || "OPEN"} after repeated upstream failures; the request was not sent`, {
      integration: integration.name, operation: op.name, host: breakerHost, status: 0,
      kind: "circuit_open", attempts: 0, breaker: gate.breaker_state,
    })
    : null;
  const settle = async (outcome) => {
    // A quota refusal never reached the upstream and says nothing about its health, so it produces
    // no breaker decision and never spends a half-open probe.
    if (!full.breaker || !breakerConf.enabled || refusal || outcome.failure_kind === "quota_exceeded") return gate?.breaker_state || null;
    return await full.breaker.record({ integration: integration.name, host: breakerHost, config: breakerConf, probe_token: gate?.probe_token || null, ...outcome }).catch(() => null);
  };

  // Per-project integration quota (#31D). Claimed for the LOGICAL call, once, only after the
  // breaker allowed it — so a breaker refusal consumes nothing — and before the adapter contacts
  // anything, so an exhausted quota means zero upstream attempts. The retry engine lives inside
  // the adapter, so however many attempts it spends, exactly one unit is consumed.
  const quotaConf = full.quota ? quotaConfig(integration) : null;
  let quotaState = null;
  let quotaRefusal = null;
  if (!refusal && full.quota && quotaConf.enabled) {
    const claim = await full.quota.consume({ integration: integration.name, config: quotaConf }).catch(() => null);
    quotaState = claim?.quota_state || null;
    if (claim && claim.allow === false) {
      quotaRefusal = integrationError("QUOTA_EXCEEDED", `${integration.name}.${op.name}: this project has used all ${quotaState?.allowed} calls allowed for integration "${integration.name}" in the current window (resets at ${quotaState?.window_end}); the request was not sent`, {
        integration: integration.name, operation: op.name, host: breakerHost, status: 0,
        kind: "quota_exceeded", attempts: 0, quota: quotaState, breaker: gate?.breaker_state || null,
      });
    }
  }
  const blocked = refusal || quotaRefusal;

  if (typeof full.observe !== "function") {
    if (blocked) throw blocked;
    try {
      const res = await adapter(integration, op, params, options, full);
      await settle({ ok: true, status: res.status });
      return res;
    } catch (e) {
      await settle({ ok: false, code: e.code, status: Number(e.details?.status) || 0, failure_kind: e.details?.kind || null });
      throw e;
    }
  }

  // Which project secrets this call actually consumed — NAMES only, captured by wrapping the
  // resolver the adapter already uses (a value never leaves this closure).
  const secretNames = new Set();
  const instrumented = {
    ...full,
    resolveSecret: (name) => {
      const value = full.resolveSecret?.(name);
      if (value) secretNames.add(String(name));
      return value;
    },
  };
  const base = {
    integration_name: integration.name, integration_id: integration.id || null,
    integration_type: integration.type === "mcp" ? "mcp" : integration.type === "openapi" ? "openapi" : "http",
    operation: op.name, method: integration.type === "mcp" ? "MCP" : op.method,
    ...(op.tool ? { tool: op.tool } : {}),
  };
  const started_at = new Date().toISOString();
  const t0 = Date.now();
  const report = (extra) => Promise.resolve(full.observe({
    ...base, ...extra, host: extra.host || hostOf(integration),
    latency_ms: Date.now() - t0, started_at, completed_at: new Date().toISOString(),
    secret_names: [...secretNames],
  })).catch(() => null);

  try {
    if (blocked) throw blocked;
    const res = await adapter(integration, op, params, options, instrumented);
    const breaker_state = await settle({ ok: true, status: res.status });
    await report({ status: res.status, attempts: res.attempts || 1, ...(res.rate_limit ? { rate_limit_state: res.rate_limit } : {}), ...(breaker_state ? { breaker_state } : {}), ...(quotaState ? { quota_state: quotaState } : {}) });
    return res;
  } catch (e) {
    const details = e.details || {};
    const status = Number(details.status) || 0;
    const outcome = { kind: details.kind === "timeout" || details.kind === "network" ? details.kind : "status", status };
    // One breaker decision for the whole logical call. `details.breaker` is the refusal's own
    // snapshot, which must not be re-counted as a fresh failure.
    const breaker_state = details.breaker || await settle({ ok: false, code: e.code, status, failure_kind: details.kind || null });
    await report({
      ...(breaker_state ? { breaker_state } : {}),
      // The quota posture this call saw: for a refusal it is the refusal's own snapshot (allowed,
      // used, remaining), for an executed call the unit it consumed.
      ...(details.quota || quotaState ? { quota_state: details.quota || quotaState } : {}),
      error: { code: e.code || "UPSTREAM_FAILURE", message: e.message }, status,
      // A refused call made ZERO attempts, and must be recorded as zero — never rounded up to 1,
      // which would claim the upstream was contacted.
      attempts: Number.isFinite(Number(details.attempts)) ? Number(details.attempts) : 1, host: details.host || "",
      failure_kind: details.kind || null,
      retryable: isRetryable(integration, op, outcome),
      // The adapter's own rate-limit findings (retry-after source, chosen wait, whether a retry
      // was skipped and why) are authoritative when present.
      ...(details.rate_limit ? { rate_limit_state: details.rate_limit } : status === 429 ? { rate_limit_state: { limited: true, status: 429 } } : {}),
    });
    throw e;
  }
}

// The `integrations` object handed to a generated backend function:
//   await integrations.weather.getForecast({ city: 'Paris' }, { body })
// Unknown integrations/operations raise structured errors (like db for unknown entities).
// Properties the runtime/interpreter probes on ordinary objects. They must read as absent —
// synthesizing a thrower for `then` would make the object thenable and crash the worker.
const PROBE_PROPS = new Set(["then", "catch", "finally", "toJSON", "constructor", "prototype", "valueOf", "toString", "inspect", "length", "call", "apply", "bind"]);
const isOwn = (target, prop) => Object.prototype.hasOwnProperty.call(target, prop);

export function createIntegrationsApi(integrations, deps) {
  const known = integrations.map((i) => i.name);
  const api = {};
  for (const integ of integrations) {
    const ops = {};
    const opNames = integ.operations.map((o) => o.name);
    for (const op of integ.operations) ops[op.name] = (params, options) => executeExternalTool(integ, op, params, options, deps);
    api[integ.name] = new Proxy(ops, {
      get(target, prop) {
        if (typeof prop !== "string" || isOwn(target, prop) || PROBE_PROPS.has(prop)) return target[prop];
        // Throws synchronously so the failure surfaces at the call site whether or not it is awaited.
        return () => { throw integrationError("OPERATION_NOT_FOUND", `Integration "${integ.name}" has no operation "${prop}". Declared operations: ${opNames.join(", ") || "none"}`, { integration: integ.name, operation: prop, known_operations: opNames }); };
      },
    });
  }
  return new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== "string" || isOwn(target, prop) || PROBE_PROPS.has(prop)) return target[prop];
      return new Proxy({}, { get: (_, op) => (typeof op !== "string" || PROBE_PROPS.has(op)) ? undefined : () => { throw integrationError("INTEGRATION_NOT_FOUND", `Unknown integration "${prop}" (integrations.${prop}.${op}). Declared integrations: ${known.join(", ") || "none"}`, { integration: prop, operation: op, known_integrations: known }); } });
    },
  });
}