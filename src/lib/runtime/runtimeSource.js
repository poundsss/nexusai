// Source of the 'runtime' module injected into every generated app.
// Keep exports in sync with base44/shared/runtimeExports.ts.
//
// The htm/preact standalone runtime is VENDORED locally (no esm.sh CDN) so that the
// production CSP (script-src 'unsafe-inline' data: https://cdn.tailwindcss.com) can load
// it: the module is embedded as a data: URL alongside the rest of the runtime source.
// Previously the runtime imported from https://esm.sh, which the production CSP blocks.
// Migration note: the preview proxy strips URL queries, so the vendored source is imported
// from a string-export sibling instead of via "?raw" (identical content).
import htmPreactSource from "./htmPreactStandalone.source.js";
import agentChatSource from "./agentChatSource.js";

function toModuleDataUrl(code) {
  const bytes = new TextEncoder().encode(code);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:text/javascript;base64," + btoa(bin);
}

const htmPreactUrl = toModuleDataUrl(htmPreactSource);

export const RUNTIME_EXPORTS = [
  "html", "render", "h",
  "useState", "useEffect", "useMemo", "useRef", "useCallback", "useReducer",
  "db", "auth", "users", "files", "server", "analytics", "navigate", "useRoute", "Link",
  // AppLogsModule parity (SDK 0.8.52): the DOCUMENTED public method logUserInApp(pageName) —
  // available in ALL auth modes. Thin bridge call to the SAME analytics dispatcher
  // (shared/analyticsRuntime.ts → analyticsIngest.ts); see the appLogs export below.
  "appLogs",
  "connectors",
  // AppModule parity (SDK 0.8.52): base44.app.getPublicSettings() — the documented "before app
  // boot" surface; the deployed runtime and the builder preview dispatch the SAME server-side
  // handler (shared/appPublicSettings.ts) over the EXISTING public-serving gate.
  "app",
  // IntegrationsModule parity: Core.* platform endpoints + custom.call — thin bridges over the
  // SAME server-side primitives the deployed runtime and the builder preview dispatch to.
  "integrations",
  // In-app notification inbox (read side of SendPushNotification).
  "notifications",
  // Deployed in-app agents (P-9.10B/P-9.10C/P-9.11H): createConversation / getConversations /
  // listConversations / getConversation / updateConversation / addMessage /
  // subscribeToConversation / getTelegramConnectURL / getWhatsAppConnectURL.
  "agents",
  // AgentChat (P-9.12): the compact in-app conversation widget, composed ONLY of the
  // certified agents methods. Its source is embedded from src/lib/runtime/agentChatSource.js.
  "AgentChat",
  // ActorsModule parity (SDK 0.8.52): base44.actors.<Name>(instanceId) — the actors adapter over
  // the EXISTING realtime bridge ops — plus base44.cleanup() (closes live actor connections).
  "actors", "cleanup",
  "sdk", "types",
];

export const runtimeSource = [
  `import { html, render, h, useState, useEffect, useMemo, useRef, useCallback, useReducer } from ${JSON.stringify(htmPreactUrl)};`,
  "export { html, render, h, useState, useEffect, useMemo, useRef, useCallback, useReducer };",
  "const pending = new Map(); let seq = 0;",
  // Streaming (functions.fetch, additive): live chunk consumers keyed by their bridge call id.
  "const streams = new Map();",
  // Actor WS push subscriptions (additive transport): subId → live actor connection.
  "const wsSubs = new Map();",
  "const b64ToBytes = (b64) => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };",
  "window.addEventListener('message', (e) => {",
  "  const m = e.data; if (!m) return;",
  "  if (m.type === 'bridge:stream-chunk') { const s = streams.get(m.id); if (s && !s.closed) { try { s.controller.enqueue(b64ToBytes(m.b64)); } catch (e2) {} } return; }",
  "  if (m.type === 'bridge:stream-done' || m.type === 'bridge:stream-error') { const s = streams.get(m.id); if (s && !s.closed) { s.closed = true; try { s.controller.close(); } catch (e2) {} } if (s) { streams.delete(m.id); if (s.signal && s.onAbort) s.signal.removeEventListener('abort', s.onAbort); } return; }",
  // Actor WS push frames (additive transport): the HOST owns the socket; these frames carry the
  // relay's room events and subscription lifecycle only — never a credential.
  "  if (m.type === 'bridge:rt-ws-ready') { const c = wsSubs.get(m.subId); if (c && !c._dead) { c._wsLive = true; if (c._wsTimer) { clearTimeout(c._wsTimer); c._wsTimer = null; } if (c._stopPoll) c._stopPoll(); } return; }",
  "  if (m.type === 'bridge:rt-ws-event') { const c = wsSubs.get(m.subId); if (c && !c._dead && c._wsLive && m.event && c._apply) c._apply(m.event); return; }",
  "  if (m.type === 'bridge:rt-ws-closed' || m.type === 'bridge:rt-ws-error') { const c = wsSubs.get(m.subId); if (c) { c._wsLive = false; wsSubs.delete(m.subId); if (c._wsTimer) { clearTimeout(c._wsTimer); c._wsTimer = null; } if (c._startPoll) c._startPoll(); } return; }",
  "  if (m.type !== 'bridge:result') return;",
  "  const p = pending.get(m.id); if (!p) return; pending.delete(m.id);",
  "  if (m.error) p.reject(m.error_detail ? Object.assign(new Error(m.error), m.error_detail) : new Error(m.error)); else p.resolve(m.result);",
  "});",
  "function post(scope, op, args) { const id = ++seq; parent.postMessage({ type: 'bridge:call', id, scope, op, args }, '*'); return id; }",
  "function call(scope, op, args) { return new Promise((resolve, reject) => { const id = post(scope, op, args); pending.set(id, { resolve, reject }); }); }",
  "export const db = new Proxy({}, { get(_, entity) { if (typeof entity !== 'string') return undefined; return {",
  // Phase B1 (records-mode v2/list page form): list(options) / filter(query, options) — an
  // options OBJECT as the first (list) / second (filter) argument mirrors the SDK's own
  // dispatch and returns ONE cursor page { items, next_cursor, has_more }. A later page
  // needs only { cursor, limit } — the server recovers the walk's query/sort/fields from
  // the VERIFIED cursor state (SDK 0.8.51 DOCUMENTED); explicitly repeated values must
  // match or the call is refused. An OMITTED query stays omitted (never coerced to {}),
  // so absence stays meaningful end-to-end; filter(query, options) passes its query
  // VERBATIM. Token format, TTL and error bodies are NEXUSAI-DERIVED server-side.
  // `distinct` is not in this phase.
  "  list: (sort, limit, skip, fields) => (sort !== null && typeof sort === 'object') ? call('db', 'page', { entity, options: sort }) : call('db', 'filter', { entity, query: {}, sort, limit, skip, fields }),",
  "  filter: (query, sort, limit, skip, fields) => (sort !== null && typeof sort === 'object') ? call('db', 'page', { entity, query, options: sort }) : call('db', 'filter', { entity, query, sort, limit, skip, fields }),",
  "  get: (id) => call('db', 'get', { entity, id }),",
  "  create: (data) => call('db', 'create', { entity, data }),",
  "  update: (id, data) => call('db', 'update', { entity, id, data }),",
  "  count: (query) => call('db', 'count', { entity, query }),",
  // Phase B3: aggregate(spec) — DOCUMENTED (Base44 SDK 0.8.51): the spec travels VERBATIM to the
  // server aggregate surface and the result is { rows, truncated }. Undocumented server
  // semantics are bounded server-side and marked NEXUSAI-derived there (appData.ts).
  "  aggregate: (spec) => call('db', 'aggregate', { entity, spec }),",
  // Upsert (SDK 0.8.51, PR #287): records + key travel VERBATIM — the bridge forwards only the
  // caller's own records/options and never normalizes anything client-side (fail-closed is
  // the server's, in appData.ts).
  "  upsert: (records, options) => call('db', 'upsert', { entity, records, key: options && options.key }),",
  "  bulkCreate: (items) => call('db', 'bulkCreate', { entity, items }),",
  "  bulkUpdate: (updates) => call('db', 'bulkUpdate', { entity, updates }),",
  "  bulkDelete: (ids) => call('db', 'bulkDelete', { entity, ids }),",
  "  updateWhere: (query, data) => call('db', 'updateWhere', { entity, query, data }),",
  "  deleteWhere: (query, options) => call('db', 'deleteWhere', { entity, query, options }),",
  "  updateMany: (query, data) => call('db', 'updateMany', { entity, query, data }),",
  "  deleteMany: (query) => call('db', 'deleteMany', { entity, query }),",
  // DOCUMENTED (Base44 SDK reference): entities.<Entity>.importEntities(file) — browser-only.
  // The File is base64-encoded HERE (browser side, like files.upload); parsing, validation,
  // RLS and events all happen server-side through the existing bulkCreate machine. Undocumented
  // Base44 semantics (delimiter/encoding/header rules, size cap, malformed-row and duplicate
  // behavior, status values) are NexusAI-derived and marked in shared/appImport.ts.
  "  importEntities: async (file) => { if (!file || typeof file.arrayBuffer !== 'function') throw new Error('importEntities requires a browser File'); const content_base64 = toBase64(await file.arrayBuffer()); return call('db', 'importEntities', { entity, filename: file.name, content_type: file.type, content_base64 }); },",
  // entities.subscribe (B-stage): the DOCUMENTED Realtime SDK contract — entity.subscribe(callback)
  // returns an unsubscribe function and the callback receives { id, type, data, timestamp } with
  // type = create|update|delete and id the RECORD's id; timestamp is the event's own time (at),
  // passed through when provided and never minted. The TRANSPORT is a NexusAI-derived bounded 4s
  // poll over the SAME events read (the db 'events' op) — the documented WebSocket/instant
  // transport is NOT claimed, and no ordering/replay/reconnect guarantee is claimed (UNKNOWN).
  // A transient read error skips the tick — the poll continues; unsubscribe stops everything.
  "  subscribe: (callback) => {",
  "    let stopped = false, after = null, timer = null;",
  "    const seen = new Set();",
  "    const poll = async () => {",
  "      if (stopped) return;",
  "      let r;",
  "      try { r = await call('db', 'events', { entity, after }); } catch (e) { return; }",
  "      if (stopped) return;",
  "      for (const ev of (r && r.events) || []) { if (seen.has(ev.event_id)) continue; seen.add(ev.event_id); after = ev.at; if (typeof callback === 'function') callback({ id: ev.id, type: ev.type, data: ev.data, ...(ev.at != null ? { timestamp: ev.at } : {}) }); }",
  "    };",
  "    poll();",
  "    timer = setInterval(poll, 4000);",
  "    return () => { stopped = true; if (timer) clearInterval(timer); }; },",
  "  delete: (id) => call('db', 'delete', { entity, id }) }; } });",
  // auth.* — the GENERATED APP's own end-user identity (never a NexusAI platform account).
  // Every call returns the server's identity envelope { authenticated, user, session, roles,
  // permissions }; the helpers below only read it, so the app decides nothing about its own
  // permissions and never holds a session token.
  "async function identity(op, args) { const r = await call('auth', op, args || {}); return r || { authenticated: false, user: null, session: null, roles: [], permissions: [] }; }",
  "export const auth = {",
  "  identity: () => identity('me'),",
  "  me: async () => (await identity('me')).user,",
  "  isAuthenticated: async () => (await identity('me')).authenticated === true,",
  "  session: async () => (await identity('me')).session,",
  "  roles: async () => (await identity('me')).roles || [],",
  "  permissions: async () => (await identity('me')).permissions || [],",
  "  can: async (permission) => (await identity('can', { permission })).allowed === true,",
  // G-2 (Base44 register contract, PROVEN): register leaves the user unverified with NO
  // session; verifyOtp({email, otpCode}) is the transition that verifies the user and
  // establishes the session (the token itself stays host-side, like every session-creating
  // op); resendOtp(email) is pre-auth and email-keyed.
  "  signup: async (d) => (await identity('signup', d || {})).user,",
  // AnalyticsModule-style SDK parity (SDK 0.8.52): the DOCUMENTED AuthModule method
  // register(params: { email, password, turnstile_token?, referral_code? }) — the payload travels
  // VERBATIM to the EXISTING 'signup' op (which already accepts turnstile_token/referral_code,
  // G-4) and the response is the op's registration projection ({ user, verification_sent } with
  // authenticated:false — NEXUSAI-DERIVED; Base44 publishes no registration response shape).
  // auth.signup stays unchanged alongside it.
  "  register: async (params) => call('auth', 'signup', params || {}),",
  "  verifyOtp: async (d) => (await identity('verify_otp', d || {})).user,",
  "  resendOtp: async (email) => identity('resend_otp', { email }),",
  "  login: async (d) => (await identity('login', d || {})).user,",
  // AnalyticsModule-style SDK parity (SDK 0.8.52): the DOCUMENTED AuthModule method
  // loginViaEmailPassword(email, password, turnstileToken?) — the documented login method for app
  // code, resolving { access_token, user }. Thin bridge call over the EXISTING 'login' op (which
  // already accepts the turnstile_token wire field verbatim, G-4): the access_token is the op's
  // session_token (NEXUSAI-derived mapping — the token stays host-side; the app cannot hand it
  // back through this bridge, so it is a faithful RESPONSE shape only, never reusable transport).
  // auth.login is unchanged and remains available alongside it.
  "  loginViaEmailPassword: async (email, password, turnstileToken) => { const r = await identity('login', { email: email, password: password, ...(turnstileToken ? { turnstile_token: turnstileToken } : {}) }); return { access_token: r.session_token, user: r.user }; },",
  // logout(redirectUrl) parity (SDK 0.8.52): the OPTIONAL post-logout destination travels as
  // redirect_url; validation is SERVER-side (the same fail-closed validator the OAuth from_url
  // uses — a relative path or a same-origin absolute URL only) and the HOST page performs the
  // top-level navigation after the session is cleared. Omitted → the existing behavior, unchanged.
  "  logout: async (redirectUrl) => { await identity('logout', redirectUrl == null || redirectUrl === '' ? {} : { redirect_url: String(redirectUrl).slice(0, 500) }); return true; },",
  // Account management (SDK parity): updateMe / changePassword / resetPasswordRequest / resetPassword —
  // thin bridges over the SAME server-side primitives both runtimes dispatch to (appAuth.ts). The
  // update allowlist, current-password verification, single-use hashed reset tokens, session
  // revocation, durable rate limits and anti-enumeration answers are all enforced SERVER-side;
  // nothing is validated or normalized here. SDK param names map 1:1 at the bridge; changePassword
  // deliberately forwards NO caller-supplied user id — identity is derived from the session
  // server-side (upstream user_id semantics UNKNOWN). updateMe mirrors the SDK's Promise<User> by
  // unwrapping the op's { user } envelope; the other three return the server's op-specific
  // bodies, which are NEXUSAI-DERIVED (upstream publishes none).
  "  updateMe: async (data) => (await call('auth', 'update_profile', (data && typeof data === 'object' && !Array.isArray(data)) ? data : {})).user,",
  "  changePassword: async (d) => call('auth', 'change_password', { current_password: d && d.currentPassword, new_password: d && d.newPassword }),",
  "  resetPasswordRequest: (email) => call('auth', 'request_password_reset', { email }),",
  "  resetPassword: async (d) => call('auth', 'confirm_password_reset', { token: d && d.resetToken, new_password: d && d.newPassword }),",
  // Social sign-in (P-9.8). Buttons should render ONLY for the providers the server reports as
  // configured (auth.providers()); loginWithProvider asks the host to begin the flow — the HOST
  // page performs the redirect, because the sandboxed frame cannot navigate the top window.
  "  providers: async () => { const r = await call('auth', 'providers'); return (r && r.providers) || []; },",
  // G-5: the DOCUMENTED invitation surface — auth.inviteUser(userEmail, role) posts the wire
  // payload { user_email, role } (snake_case user_email, role REQUIRED — no default). Thin bridge
  // call: authorization, the single-use hashed invitation token, delivery, audit and rate limits
  // all live server-side on the existing primitives; no second invitation subsystem exists.
  "  inviteUser: (user_email, role) => call('auth', 'invite_user', { user_email, role }),",
  // redirectToLogin(nextUrl) parity (documented SDK surface): browser-only. The destination
  // resolves against the app's serving origin (the HOST page's origin — the sandboxed frame is
  // opaque) and DEFAULTS to the current URL; the resolution, the SERVER-side validation (the SAME
  // fail-closed validator the logout redirect_url uses) and the navigation to the existing login
  // surface all live in the HOST layer. An external/cross-origin destination is refused and
  // navigates nowhere. Resolves to the validated from_url (NEXUSAI-DERIVED shape).
  "  redirectToLogin: (nextUrl) => call('auth', 'redirect_login', nextUrl == null || nextUrl === '' ? {} : { next_url: String(nextUrl).slice(0, 500) }),",
  // loginWithProvider parity (SDK 0.8.52): the OPTIONAL `fromUrl` (post-login return destination,
  // default "/") travels as from_url and is validated + preserved in the OAuth state SERVER-side;
  // the callback host honors it. Validation lives entirely server-side (fail-closed cross-origin).
  "  loginWithProvider: async (provider, fromUrl) => call('auth', 'oauth_begin', { provider, ...(fromUrl ? { from_url: String(fromUrl).slice(0, 500) } : {}) }) };",
  // users — the DOCUMENTED Users module (docs.base44.com: users.inviteUser(user_email, role) with
  // role 'user'|'admin', published as EQUIVALENT to auth.inviteUser). ONE alias over the same op.
  "export const users = { inviteUser: (user_email, role) => call('auth', 'invite_user', { user_email, role }) };",
  // files.* — upload/read/delete the app's user files. `upload` takes a browser File/Blob and
  // base64-encodes it here; the bytes go to PRIVATE server-side storage. `access` returns a
  // short-lived signed URL. The app never receives a storage handle or any credential.
  "function toBase64(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }",
  "export const files = {",
  "  upload: async (file) => { if (!file) throw new Error('files.upload requires a File'); const content_base64 = toBase64(await file.arrayBuffer()); return call('files', 'upload', { filename: file.name, content_type: file.type, content_base64 }); },",
  "  get: (id) => call('files', 'get', { id }),",
  "  list: (limit) => call('files', 'list', { limit }),",
  "  access: (id) => call('files', 'access', { id }),",
  "  delete: (id) => call('files', 'delete', { id }) };",
  // server.<functionName>(payload) — the app's only way to reach a backend function.
  // The call leaves the sandbox; the function body, its secrets and its outbound HTTP all run server-side.
  // server.fetch(path, init) — the DOCUMENTED functions.fetch surface ("a direct HTTP request to a
  // backend function path", native Response). 'fetch' is the one reserved name: the bridge op 'fetch'
  // never resolves a project function of that name. Request bodies: strings verbatim, binary
  // (ArrayBuffer/typed view/Blob) base64-encoded losslessly; FormData is not supported (UNKNOWN).
  // The bridge returns ONE raw envelope { status, ok, headers, has_body, body_text } and the native
  // Response is reconstructed here — a function's 4xx/5xx is a Response, never a rejected promise;
  // only an infrastructure refusal rejects. Note: the Response constructor cannot carry statuses
  // outside 200–599, so such a function status rejects the promise (platform boundary).
  // Streaming (functions.fetch, additive): when the bridge reports a streamed result
  // ({ __stream__: true } carrying the status/headers that travel BEFORE the first chunk), the
  // native Response is reconstructed over a ReadableStream fed by the host's chunk frames
  // (bridge:stream-chunk / bridge:stream-done) — body reads return chunks AS THEY ARRIVE, and a
  // mid-stream failure reaches the client as a clean early close. init.signal aborts by telling
  // the host to stop its pump (bridge:stream-abort); the host's fetch then aborts server-side.
  // A buffered result keeps the exact previous contract. SDK aliasing is automatic: sdk.functions
  // IS server, so sdk.functions.fetch exists.
  "const functionsFetch = async (path, init) => {",
  "  const i = init || {};",
  "  const hdr = i.headers;",
  "  const args = { path: String(path == null ? '' : path), method: i.method, headers: (hdr && typeof hdr.entries === 'function') ? Object.fromEntries(hdr.entries()) : ((hdr && typeof hdr === 'object' && !Array.isArray(hdr)) ? hdr : undefined) };",
  "  if (i.body !== undefined && i.body !== null) {",
  "    if (typeof i.body === 'string') args.body = i.body;",
  "    else if (i.body instanceof ArrayBuffer || ArrayBuffer.isView(i.body) || (typeof Blob !== 'undefined' && i.body instanceof Blob)) { const buf = ((typeof Blob !== 'undefined' && i.body instanceof Blob) ? await i.body.arrayBuffer() : (i.body instanceof ArrayBuffer ? i.body : i.body.buffer.slice(i.body.byteOffset, i.body.byteOffset + i.body.byteLength))); args.body_base64 = toBase64(buf); }",
  "    else throw new Error('functions.fetch body must be a string or binary data');",
  "  }",
  "  const id = post('fn', 'fetch', args);",
  "  const r = await new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });",
  "  if (r && r.__stream__ === true) {",
  "    const s = { closed: false };",
  "    const body = new ReadableStream({ start(c) { s.controller = c; } });",
  "    streams.set(id, s);",
  "    if (i.signal && typeof i.signal.addEventListener === 'function') { s.signal = i.signal; s.onAbort = () => { const t = streams.get(id); if (t && !t.closed) { t.closed = true; try { t.controller.close(); } catch (e2) {} } streams.delete(id); if (s.signal) s.signal.removeEventListener('abort', s.onAbort); parent.postMessage({ type: 'bridge:stream-abort', id }, '*'); }; i.signal.addEventListener('abort', s.onAbort); }",
  "    return new Response(body, { status: r.status, headers: r.headers || {} });",
  "  }",
  "  return new Response(r.has_body ? r.body_text : null, { status: r.status, headers: r.headers || {} });",
  "};",
  // sdk.functions.invoke(name, data?) — the DOCUMENTED FunctionsModule invoke surface (SDK 0.8.52):
  // the function's JSON result arrives on `.data` of an axios-like response ({ data, status,
  // statusText, headers, config }) carrying the function's REAL status (response fidelity — the
  // bridge returns { __invoke__: true, status, body }; a bare resolved value is legacy and stays
  // status 200); a function status >= 400 REJECTS the promise with the response reachable as
  // { response: { status, data } } on the caught error (SDK/axios parity — the structured
  // bridgeDetail rides the SAME error_detail channel the AppModule error uses). A string `data`
  // is rejected client-side with the SDK's own message. 'fetch' and 'invoke' are the ONLY
  // reserved proxy names. File/multipart parameters ARE supported (G-A): a top-level File/Blob
  // parameter is base64-encoded into a file descriptor here (the invoke bridge transport is
  // JSON — postMessage — exactly like files.upload), and the server-side executor restores it
  // as the function's named parameter { filename, content_type, size, content_base64 }. The
  // server ALSO accepts genuine multipart/form-data invoke requests (the SDK 0.8.52 wire),
  // parsed into the same envelope (shared/multipartInvoke.ts). asServiceRole.functions
  // (G-B) and streaming are NOT part of this surface and not claimed.
  "const encodeInvokeFile = async (f) => ({ __base44file__: true, filename: (f && f.name) || 'file', content_type: (f && f.type) || 'application/octet-stream', size: f && typeof f.size === 'number' ? f.size : null, content_base64: toBase64(await f.arrayBuffer()) });",
  "const functionsInvoke = async (name, data) => { if (typeof name !== 'string' || !name.trim()) throw new Error('functions.invoke requires a function name'); if (typeof data === 'string') throw new Error(`Function ${name} must receive an object with named parameters, received: ${data}`); let payload = data === undefined ? null : data; if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof Blob !== 'undefined') { const enc = {}; let has = false; for (const k of Object.keys(payload)) { const v = payload[k]; if (v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && v instanceof Blob) { enc[k] = await encodeInvokeFile(v); has = true; } } if (has) payload = Object.assign({}, payload, enc); } const r = await call('fn', name, { payload }); const env = (r && typeof r === 'object' && r.__invoke__ === true) ? r : { status: 200, body: r }; return { data: env.body, status: env.status, statusText: 'OK', headers: {}, config: {} }; };",
  "export const server = new Proxy({}, { get(_, fn) { if (typeof fn !== 'string') return undefined; if (fn === 'fetch') return functionsFetch; if (fn === 'invoke') return functionsInvoke; return (payload) => functionsInvoke(fn, payload).then((r) => r.data); } });",
  // analytics.* — the app's product analytics. It holds ONLY the current session key: the event
  // itself is validated, scrubbed, attributed and stored by the server-side analytics contract, so
  // no event logic is duplicated here and the app can never claim a project, environment or user.
  "let analyticsSession = null;",
  "function analyticsKey() { return 'as-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }",
  "export const analytics = {",
  "  startSession: async (opts) => { const o = opts || {}; const key = o.session_key || analyticsSession || analyticsKey(); const r = await call('analytics', 'session_start', { session_key: key, page: o.page || location.pathname }); analyticsSession = (r && r.session && r.session.session_key) || key; return (r && r.session) || null; },",
  "  getCurrentSession: async () => { if (!analyticsSession) return null; const r = await call('analytics', 'session_current', { session_key: analyticsSession }); return (r && r.session) || null; },",
  "  endSession: async () => { if (!analyticsSession) return null; const r = await call('analytics', 'session_end', { session_key: analyticsSession }); analyticsSession = null; return (r && r.session) || null; },",
  // DOCUMENTED (Base44 AnalyticsModule, SDK 0.8.52): the module's single public method —
  // analytics.track({ eventName, properties }) ("tracks a custom event that appears as a card in
  // your Analytics dashboard"). Thin bridge call onto the EXISTING analytics scope: validation,
  // redaction, limits, attribution and storage all live server-side in
  // shared/analyticsRuntime.ts (op 'track' → ingestEvent) — nothing is validated or normalized
  // here. The SDK's internal batching/heartbeat/queue transport is NOT claimed (UNKNOWN,
  // NEXUSAI-derived substitute: one synchronous dispatch per call). trackEvent and every other
  // analytics method are untouched.
  "  track: async (params) => { const p = params || {}; if (!analyticsSession) await analytics.startSession(); return call('analytics', 'track', { session_key: analyticsSession, event: { event_name: p.eventName, event_type: 'custom_event', page: location.pathname, properties: p.properties || {} } }); },",
  "  trackEvent: async (event_name, properties, opts) => { const o = opts || {}; if (!analyticsSession) await analytics.startSession(); return call('analytics', 'track', { session_key: analyticsSession, event: { event_name, event_type: o.event_type, page: o.page || location.pathname, properties: properties || {}, duration_ms: o.duration_ms, conversion_value: o.conversion_value, error_code: o.error_code, error_category: o.error_category, ingestion_key: o.ingestion_key } }); },",
  "  linkIdentity: async () => { if (!analyticsSession) await analytics.startSession(); return call('analytics', 'link_identity', { session_key: analyticsSession }); } };",
  // appLogs — the DOCUMENTED Base44 AppLogsModule public surface (SDK 0.8.52): the single
  // non-internal method logUserInApp(pageName) (fetchLogs/getStats are @internal, NOT implemented).
  // Thin bridge call routed through the EXISTING analytics scope: validation, redaction, limits,
  // attribution and auth behavior live server-side in shared/analyticsRuntime.ts, which maps the
  // call onto the existing ingestion contract as a page_view event named for the page (the
  // NEXUSAI-DERIVED mapping — Base44 publishes no storage/dashboard semantics). The deployed
  // runtime and the builder preview both already forward the analytics scope, so parity is free.
  "export const appLogs = { logUserInApp: (pageName) => call('analytics', 'log_user_in_app', { page: pageName }) };",
  // ActorsModule parity (SDK 0.8.52): base44.actors.<ActorName>(instanceId) → ActorRef →
  // connect({ id? }) → Connection { id, subscribe(cb) → { unsubscribe() }, send(data), close() }.
  // A thin adapter over the EXISTING realtime bridge ops (list/connect/disconnect/send/events).
  // Transport (NEXUSAI): event delivery rides a persistent WebSocket push served by the host page
  // over the platform's NexusActorRelay Durable Object when the host bridge acks it — with the
  // certified bounded 4s events poll kept as the automatic fallback whenever the WS is unavailable,
  // refused or closed. Writes (connect/disconnect/send/signal) always ride the certified HTTP path.
  // Identity: the participant label is per-connection, and the server derives it to `user:<id>`
  // whenever a verified end-user session exists (never a client claim); conn.id is the DOCUMENTED
  // client-chosen connection id, reused as the participant label when it fits the server grammar.
  // The actor name is resolved/validated against the realtime 'list' op and FAILS CLOSED for an
  // unknown actor; connect() is idempotent per ref; every property access mints a NEW ref.
  // base44.cleanup() closes every live actor connection (DOCUMENTED SDK client method).
  "const GUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;",
  "const liveConnections = new Set();",
  "function mintRuntimeId() { return 'c-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }",
  "function makeActorRef(actorName, instanceId) {",
  "  const ref = {",
  "    _conn: null,",
  "    connect(options) {",
  "      if (ref._conn) return ref._conn;",
  "      const opts = options || {};",
  "      const cid = opts.id != null ? String(opts.id) : mintRuntimeId();",
  "      const conn = { id: cid, _listeners: [], _seq: 0, _dead: false, _participant: GUEST_ID_RE.test(cid) ? cid : mintRuntimeId() };",
  "      ref._conn = conn;",
  "      liveConnections.add(conn);",
  "      conn._ready = (async () => {",
  "        const listing = await call('realtime', 'list', {});",
  "        if (!((listing && listing.actors) || []).some((a) => a.name === actorName)) throw new Error('Actor ' + JSON.stringify(actorName) + ' is not part of this application');",
  "        const r = await call('realtime', 'connect', { actor: actorName, room: instanceId, participant: conn._participant });",
  "        conn._seq = Number(r && r.seq) || 0;",
  "        const applyEvent = (e2) => { if (Number(e2 && e2.seq) <= conn._seq) return; conn._seq = Number(e2.seq); for (const cb of conn._listeners.slice()) { try { cb(e2); } catch (e3) {} } };",
  "        let timer = null;",
  "        const poll = async () => {",
  "          if (conn._dead || conn._wsLive) return;",
  "          let evs;",
  "          try { evs = await call('realtime', 'events', { actor: actorName, room: instanceId, since: conn._seq }); } catch (e) { return; }",
  "          if (conn._dead || conn._wsLive) return;",
  "          for (const e2 of (evs && evs.events) || []) applyEvent(e2);",
  "        };",
  "        poll();",
  "        timer = setInterval(poll, 4000);",
  "        // Poll pause/resume: the certified 4s poll is the FALLBACK transport — it pauses only",
  "        // while a WS subscription is live and resumes on any WS close/failure/refusal.",
  "        conn._stopPoll = () => { if (timer) { clearInterval(timer); timer = null; } };",
  "        conn._startPoll = () => { if (conn._dead || timer || conn._wsLive) return; timer = setInterval(poll, 4000); poll(); };",
  "        conn._apply = applyEvent;",
  "        // WebSocket push (additive transport): the HOST page owns the socket (this frame is",
  "        // opaque-origin and holds no token). If the host bridge acks the subscription, the poll",
  "        // pauses and events arrive over the persistent WS; any close/failure/no-host restores",
  "        // the certified 4s poll automatically. The public SDK surface is unchanged.",
  "        const subId = 'ws-' + Math.random().toString(36).slice(2) + Date.now().toString(36);",
  "        wsSubs.set(subId, conn);",
  "        conn._wsLive = false;",
  "        conn._wsTimer = setTimeout(() => { if (wsSubs.get(subId) === conn) wsSubs.delete(subId); }, 3000);",
  "        parent.postMessage({ type: 'bridge:rt-ws-sub', subId, actor: actorName, room: instanceId, since: conn._seq }, '*');",
  "        return r;",
  "      })();",
  "      conn._ready.catch(() => { conn._dead = true; liveConnections.delete(conn); });",
  "      conn.subscribe = (cb) => { if (typeof cb !== 'function') throw new Error('subscribe requires a callback'); conn._listeners.push(cb); return { unsubscribe: () => { const i = conn._listeners.indexOf(cb); if (i >= 0) conn._listeners.splice(i, 1); } }; };",
  "      conn.send = (data) => { if (conn._dead) return; conn._ready.then(() => call('realtime', 'send', { actor: actorName, room: instanceId, participant: conn._participant, message: data })).catch(() => {}); };",
  "      // Ephemeral collaboration signal (cursor/selection) over the SAME connection identity,",
  "      // routed to the deployed runtime's certified signalActor primitive (presence, no event).",
  "      conn.signal = (data) => { if (conn._dead) return; const s = data || {}; conn._ready.then(() => call('realtime', 'signal', { actor: actorName, room: instanceId, participant: conn._participant, cursor: s.cursor == null ? null : s.cursor, selection: s.selection == null ? null : s.selection })).catch(() => {}); };",
  "      conn.close = () => {",
  "        if (conn._dead) return;",
  "        conn._dead = true;",
  "        liveConnections.delete(conn);",
  "        if (conn._stopPoll) conn._stopPoll();",
  "        if (conn._wsSubId) { wsSubs.delete(conn._wsSubId); if (conn._wsTimer) clearTimeout(conn._wsTimer); parent.postMessage({ type: 'bridge:rt-ws-unsub', subId: conn._wsSubId }, '*'); }",
  "        conn._listeners.length = 0;",
  "        conn._ready.then(() => call('realtime', 'disconnect', { actor: actorName, room: instanceId, participant: conn._participant })).catch(() => {});",
  // SDK parity: a fresh connect() after close() opens a NEW connection (the ref forgets the closed one).
  "        if (ref._conn === conn) ref._conn = null;",
  "      };",
  "      return conn;",
  "    }",
  "  };",
  "  return ref;",
  "}",
  // `then` resolves to undefined (SDK parity: the module is never mistaken for a thenable when
  // awaited); any other string key is an actor name.
  "export const actors = new Proxy({}, { get(_, actorName) { return typeof actorName === 'string' && actorName !== 'then' ? (instanceId) => makeActorRef(actorName, instanceId == null ? '' : String(instanceId)) : undefined; } });",
  "export const cleanup = () => { const live = Array.from(liveConnections); for (const conn of live) conn.close(); return { closed: live.length }; };",
  // types — the descriptor of the project's GENERATED declarations (base44/.types/types.d.ts).
  // A developer-surface pointer only: the declarations are an editor artifact, so nothing here
  // carries a schema the runtime could disagree with.
  "export const types = Object.freeze({ path: 'base44/.types/types.d.ts', generated: true });",
  // connectors.* — App User Connectors (P-9.9). connectAppUser(connectorId) mirrors Base44's
  // SDK (0.8.52): it resolves to the provider redirect URL STRING (data.redirect_url parity —
  // the unwrap over the server op's envelope, a bare-string result passing through unchanged);
  // the HOST page performs the redirect (the sandboxed frame cannot navigate the top window);
  // no credential, token or client secret ever crosses the bridge — only the redirect URL.
  // connections()/disconnectAppUser() act on the CURRENT signed-in app user's own connections,
  // metadata only.
  "export const connectors = {",
  "  connections: async (connector) => call('connectors', 'connections', connector ? { connector } : {}),",
  "  connectAppUser: async (connector) => { const r = await call('connectors', 'connect', { connector }); return (r && r.authorization_url) || r; },",
  "  disconnectAppUser: async (connector) => call('connectors', 'disconnect', { connector }) };",
  // agents.* — the deployed app's declared in-app agents (P-9.10B/P-9.10C). Every method is a
  // thin bridge call: the server resolves the session, the agent registry, model access and
  // every credit charge through the EXISTING P-9.4 runtime; the sandbox never sees
  // instructions, credentials or activation tokens. getTelegramConnectURL and
  // getWhatsAppConnectURL reuse the P-9.10A/C server channel flows — only the redirect URL
  // crosses the bridge.
  // subscribeToConversation: the initial snapshot is the SAME HTTP read (getConversation) —
  // unchanged; afterwards the DOCUMENTED instant-update transport is served by a persistent
  // WebSocket push (the certified NexusActorRelay over the host's rt bridge — same transports
  // the actors module uses), with the bounded 4s poll kept as the AUTOMATIC fallback whenever
  // the WS is unavailable, refused or closed. Frames are the server's EXISTING projections
  // only (durable Message frames, in-flight draft frames, retirement markers); they are merged
  // by message id into the projected conversation — the same merge semantics as the poll. A
  // guaranteed stop after unsubscribe or on the first refused read (e.g. a cross-user
  // conversation) is preserved, and no polling happens after stop. Token-level streaming is
  // UNKNOWN and is not implemented.
  // Agent response streaming (additive, non-parity): during an in-flight turn the projection
  // may embed ONE ephemeral draft message (`streaming: true`, the turn id as its stable
  // message_id, accumulated running text, certified tool-call statuses). The callback fires
  // when the draft's content or tool statuses change (not only on the message count), the
  // draft is merged by message_id, and the durable persisted Message supersedes it — the
  // server retires the draft before the reply row is written. The transport stays the
  // bounded poll; no WebSocket/socket.io is added.
  "export const agents = {",
  "  createConversation: async (agent_name, metadata) => (await call('agent', 'create', { agent_name, metadata })).conversation,",
  // P-9.11H: the documented conversation surfaces — getConversations() returns every
  // conversation across all agents; updateConversation(id, { metadata }) re-uses the server's
  // bounded metadata contract. Thin bridges, like every other method here.
  "  getConversations: async () => (await call('agent', 'conversations', {})).conversations,",
  "  listConversations: async (params) => call('agent', 'conversations', params || {}),",
  "  getConversation: async (conversation_id) => call('agent', 'get', { conversation_id }),",
  "  updateConversation: async (conversation_id, data) => (await call('agent', 'update', { conversation_id, metadata: data && typeof data === 'object' && !Array.isArray(data) ? data.metadata : undefined })).conversation,",
  // P-9.11G: the documented addMessage attachment field — optional `file_urls: string[]`
  // ("URLs to files attached to the message"). The bridge forwards it ONLY when it is an array
  // (anything else is absent, exactly as for every other message field); element validation is
  // the server's, so the documented shape is enforced fail-closed in one place.
  // P-9.11H: the documented message OBJECT form also carries `role`; only 'user' is a
  // documented inbound role and the server enforces that fail-closed — the bridge forwards
  // the value untouched, exactly as for file_urls.
  "  addMessage: async (conversation, message) => call('agent', 'invoke', { conversation_id: typeof conversation === 'object' && conversation ? (conversation.conversation_id || conversation.id) : conversation, message: typeof message === 'object' && message ? String(message.content || '') : String(message || ''), role: typeof message === 'object' && message && message.role !== undefined && message.role !== null ? String(message.role) : undefined, file_urls: typeof message === 'object' && message && Array.isArray(message.file_urls) ? message.file_urls : undefined }),",
  "  subscribeToConversation: (conversation_id, onUpdate) => {",
  "    let stopped = false, seen = -1, timer = null, base = null, msgs = [];",
  "    let wsLive = false, subId = null;",
  "    // The change signal is the message count PLUS the in-flight draft's identity/content/tool",
  "    // statuses (the same signal the poll uses) — progressively generated content and",
  "    // tool-status updates fire the callback. No draft = the documented count-only signal.",
  "    const emit = () => {",
  "      if (!base) return;",
  "      const sorted = msgs.slice().sort((a, b) => (!!a && !!a.streaming) === (!!b && !!b.streaming) ? String((a && a.created_date) || '').localeCompare(String((b && b.created_date) || '')) : (a && a.streaming ? 1 : -1));",
  "      const conversation = Object.assign({}, base, { messages: sorted });",
  "      const draft = sorted.find((m) => m && m.streaming) || null;",
  "      const sig = draft ? [sorted.length, draft.message_id, String(draft.content || '').length, (draft.tool_calls || []).map((t) => t.status || '').join(',')].join('|') : String(sorted.length);",
  "      if (sig !== seen) { seen = sig; if (typeof onUpdate === 'function') onUpdate(conversation); }",
  "    };",
  "    // WS frames (message-level projections only) merge by id into the current model — the",
  "    // SAME merge semantics as the poll, never a second state shape. A durable message frame",
  "    // supersedes any draft (server retires first); a retirement marker removes its draft.",
  "    const apply = (e2) => {",
  "      const d = e2 && e2.data;",
  "      if (!d) return;",
  "      if (e2.type === 'message') {",
  "        const i = msgs.findIndex((m) => m && (m.id === d.id || m.message_id === d.message_id));",
  "        if (i >= 0) msgs[i] = d; else msgs.push(d);",
  "        msgs = msgs.filter((m) => !(m && m.streaming));",
  "        emit();",
  "      } else if (e2.type === 'draft') {",
  "        const i = msgs.findIndex((m) => m && m.message_id === d.message_id);",
  "        if (d.retired) { if (i >= 0) { msgs.splice(i, 1); emit(); } }",
  "        else if (i >= 0) { msgs[i] = d; emit(); } else { msgs.push(d); emit(); }",
  "      }",
  "    };",
  "    const get = async () => {",
  "      if (stopped) return null;",
  "      let r;",
  "      try { r = await call('agent', 'get', { conversation_id }); } catch (e) { if (!stopped) { stopped = true; if (timer) clearInterval(timer); if (subId) { wsSubs.delete(subId); parent.postMessage({ type: 'bridge:rt-ws-unsub', subId: subId }, '*'); } if (typeof onUpdate === 'function') onUpdate({ error: String((e && e.message) || e) }); } return null; }",
  "      if (stopped) return null;",
  "      const conversation = (r && r.conversation) || null;",
  "      if (conversation) { base = conversation; msgs = (Array.isArray(conversation.messages) ? conversation.messages : []).slice(); }",
  "      emit();",
  "      return conversation;",
  "    };",
  "    const poll = async () => { if (stopped || wsLive) return; await get(); };",
  "    get(); // the HTTP initial snapshot is ALWAYS the first read — never a WS-only state",
  "    timer = setInterval(poll, 4000);",
  "    // Poll pause/resume: the certified 4s poll is the FALLBACK transport — it pauses only",
  "    // while a WS subscription is live and resumes on any WS close/failure/refusal.",
  "    const stopPoll = () => { if (timer) { clearInterval(timer); timer = null; } };",
  "    const startPoll = () => { if (stopped || timer || wsLive) return; timer = setInterval(poll, 4000); poll(); };",
  "    const wsConn = { _apply: apply, _stopPoll: stopPoll, _startPoll: () => { wsLive = false; startPoll(); } };",
  "    if (conversation_id != null && typeof parent !== 'undefined') {",
  "      subId = 'ws-' + Math.random().toString(36).slice(2) + Date.now().toString(36);",
  "      wsSubs.set(subId, wsConn);",
  "      // Same expiry as the actors transport: a host that never answers (e.g. no rt bridge in",
  "      // this preview surface) just leaves the 4s poll running.",
  "      wsConn._wsTimer = setTimeout(() => { if (wsSubs.get(subId) === wsConn) wsSubs.delete(subId); }, 3000);",
  "      parent.postMessage({ type: 'bridge:rt-ws-sub', subId: subId, actor: 'AgentConversation', room: 'agent-conversations:' + String(conversation_id), since: 0 }, '*');",
  "    }",
  "    return () => { stopped = true; if (timer) clearInterval(timer); if (subId) { wsSubs.delete(subId); parent.postMessage({ type: 'bridge:rt-ws-unsub', subId: subId }, '*'); } }; },",
  "  getTelegramConnectURL: async (agent) => call('channel', 'connect', { channel: 'telegram', agent }),",
  "  getWhatsAppConnectURL: async (agent) => call('channel', 'connect', { channel: 'whatsapp', agent }) };",
  // integrations — the DOCUMENTED Base44 IntegrationsModule client surface (SDK `integrations`):
  // Core.InvokeLLM / GenerateImage / UploadFile / SendEmail / ExtractDataFromUploadedFile /
  // UploadPrivateFile / CreateFileSignedUrl, the DOCUMENTED media endpoints GenerateVideo /
  // GenerateSpeech / TranscribeAudio, and custom.call(slug, operationId, params). Thin
  // bridge calls only: validation, authorization, charging, redaction and the upstream engines
  // all live server-side on the EXISTING primitives. Upload params (a browser File) are
  // base64-encoded HERE exactly like files.upload, so bytes cross the bridge the same way.
  // Response shapes: UploadFile → { file_url } (DOCUMENTED); custom.call → { success,
  // status_code, data } (DOCUMENTED); UploadPrivateFile / CreateFileSignedUrl preserve the
  // EXISTING handle model (metadata + id; the internal storage handle never reaches the app)
  // — NEXUSAI-DERIVED, marked in shared/appIntegrations.ts.
  "const coreUploadArgs = async (file) => { if (!file || typeof file.arrayBuffer !== 'function') throw new Error('upload requires a browser File'); return { filename: file.name, content_type: file.type, content_base64: toBase64(await file.arrayBuffer()) }; };",
  "export const integrations = {",
  "  Core: {",
  "    InvokeLLM: (params) => call('integrations', 'InvokeLLM', params || {}),",
  "    GenerateImage: (params) => call('integrations', 'GenerateImage', params || {}),",
  "    UploadFile: async (params) => call('integrations', 'UploadFile', await coreUploadArgs(params && params.file)),",
  "    SendEmail: (params) => call('integrations', 'SendEmail', params || {}),",
  "    ExtractDataFromUploadedFile: (params) => call('integrations', 'ExtractDataFromUploadedFile', params || {}),",
  "    UploadPrivateFile: async (params) => call('integrations', 'UploadPrivateFile', await coreUploadArgs(params && params.file)),",
  "    CreateFileSignedUrl: (params) => call('integrations', 'CreateFileSignedUrl', params || {}),",
  // DOCUMENTED (Base44) media endpoints — same thin-bridge form; validation, duration/aspect
  // resolution, credit hold/settle and the provider call all live server-side
  // (shared/appIntegrations.ts, certified in mediaIntegrationCert).
  "    GenerateVideo: (params) => call('integrations', 'GenerateVideo', params || {}),",
  "    GenerateSpeech: (params) => call('integrations', 'GenerateSpeech', params || {}),",
  "    TranscribeAudio: (params) => call('integrations', 'TranscribeAudio', params || {}),",
  "  },",
  "  custom: { call: (slug, operationId, params) => call('integrations', 'custom_call', { slug, operation_id: operationId, params: params || {} }) },",
  "};",
  // notifications — the signed-in end user's OWN in-app inbox (read side of the server-only
  // SendPushNotification). NEXUSAI-DERIVED: thin bridge; ownership is enforced server-side.
  "export const notifications = {",
  "  list: (options) => call('notifications', 'list', options || {}),",
  "  unreadCount: async () => (await call('notifications', 'unread_count', {})).count,",
  "  markRead: (id) => call('notifications', 'mark_read', { id }),",
  "  markAllRead: () => call('notifications', 'mark_all_read', {}),",
  "};",
  // sdk — the UNIFIED developer surface. Pure aliasing: every namespace IS the existing runtime
  // object, so a call through sdk.entities and a call through db reach the identical contract and
  // no second data, function, auth, analytics or file engine exists.
  // app — the DOCUMENTED AppModule (SDK 0.8.52): getPublicSettings() is the "before app boot"
  // surface — the app's ONE public access-policy read ({ id, public_settings }). Thin bridge
  // call: the serving gate, the visibility→public_settings mapping and the documented 403
  // envelope (data.extra_data.reason) all live server-side in shared/appPublicSettings.ts,
  // shared verbatim with the deployed runtime's "app" action. The documented Base44Error shape
  // (status + data.extra_data.reason) rides the bridge as a structured error_detail.
  "export const app = { getPublicSettings: () => call('app', 'get_public_settings', {}) };",
  "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, actors, types, app, appLogs, cleanup });",
  "let currentPath = '/'; const routeListeners = new Set();",
  "export function navigate(path) { currentPath = path; routeListeners.forEach((l) => l(path)); parent.postMessage({ type: 'runtime:navigate', path }, '*'); }",
  "export function useRoute() { const [path, setPath] = useState(currentPath); useEffect(() => { routeListeners.add(setPath); return () => routeListeners.delete(setPath); }, []); return path; }",
  // The Builder (page overview, page picker) can ask the frame to show a route. Inert in a
  // deployed app, which receives no such message.
  "window.addEventListener('message', (e) => { const m = e.data; if (m && m.type === 'runtime:goto' && typeof m.path === 'string') navigate(m.path); });",
  "export function Link(props) { return h('a', { href: props.href, class: props.class || '', onClick: (e) => { e.preventDefault(); navigate(props.href); } }, props.children); }",
  "window.addEventListener('error', (e) => parent.postMessage({ type: 'runtime:error', message: e.message }, '*'));",
  "window.addEventListener('unhandledrejection', (e) => parent.postMessage({ type: 'runtime:error', message: String((e.reason && e.reason.message) || e.reason) }, '*'));",
  // AgentChat (P-9.12): the in-app conversation widget, embedded verbatim after the agents
  // surface it rides. See agentChatSource.js for the certified flow it composes.
  agentChatSource,
].join("\n");