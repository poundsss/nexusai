// Parent-side handler for the generated app's database/auth calls.
//
// Database calls are NOT executed here: they are forwarded to the previewData backend function,
// which authorizes the project against the signed-in user's workspace membership, loads the
// entity definitions from the project's own records and runs the CRUD server-side through the
// same accessor deployed backend functions use. The browser therefore cannot name a project it
// has no access to, reach another project's records, or bypass validation — while the preview's
// behavior and error messages stay exactly the same.
import { base44 } from "@/api/base44Client";

export function toItem(r) {
  return { id: r.id, created_date: r.created_date, updated_date: r.updated_date, ...(r.data || {}) };
}

const DB_OPS = ["filter", "list", "get", "count", "create", "update", "delete", "bulkCreate", "bulkUpdate", "bulkDelete", "updateWhere", "deleteWhere", "updateMany", "deleteMany", "events", "importEntities", "page", "aggregate", "upsert"];

// The previewed app's END-USER session token. Host-page only, like the deployed runtime's token.
let previewSessionToken = null;
export const resetPreviewSession = () => { previewSessionToken = null; };

export async function handleBridgeCall(projectId, entities, msg) {
  const { scope, op, args = {} } = msg;
  if (scope === "fn") {
    // functions.fetch (documented raw-HTTP surface): the path/init travel verbatim and the RAW
    // envelope returns whatever the function's status is — a function 4xx/5xx is a Response
    // for the caller, never a bridge error. Only an infrastructure refusal ({ error })
    // rejects the promise, exactly like a failed network request would. The invoke branch
    // below is untouched.
    if (op === "fetch") {
      // Streaming (multi-frame bridge): the call rides the DOCUMENTED functions.fetch surface so
      // the platform delivers the endpoint's raw passthrough Response incrementally; the
      // x-nexus-stream marker distinguishes a streamed result (returned as a { __stream_bridge__ }
      // descriptor the host pumps to the iframe) from the buffered envelope, whose semantics are
      // byte-identical to before.
      const res = await base44.functions.fetch("/appFunction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, mode: "fetch", fetch: args || {}, stream: true }),
      });
      if (res.headers.get("x-nexus-stream") === "1") return { __stream_bridge__: true, response: res };
      let data;
      try { data = JSON.parse(await res.text()); } catch { throw new Error(`functions.fetch failed (${res.status})`); }
      if (data && data.error) {
        const e2 = new Error(data.error);
        e2.bridgeDetail = { response: { status: res.status, data } };
        throw e2;
      }
      return data.result;
    }
    // Backend function call: executed on the server. Nothing about the function's
    // implementation or its secrets is available to the preview iframe.
    // invoke fidelity (SDK 0.8.52): the server already returns the function's real status
    // (appFunction: { status, body, logs, duration_ms }) — the body AND status travel through
    // the structured bridge result, so the runtime wrapper can resolve the real status; on a
    // function 4xx/5xx the status and body ride the thrown error as
    // { response: { status, data } }, reachable from the app's catch like the SDK's axios
    // rejection. No headers exist on the invoke path — none are invented.
    const res = await base44.functions.invoke("appFunction", { project_id: projectId, function_name: op, payload: args.payload ?? null });
    const { status, body } = res.data || {};
    if (status >= 400) {
      const e2 = new Error((body && body.error) || `Backend function ${op} failed (${status})`);
      e2.bridgeDetail = { response: { status, data: body } };
      throw e2;
    }
    return { __invoke__: true, status, body };
  }
  if (scope === "auth") {
    // auth.redirectToLogin(nextUrl) parity (SDK): the destination DEFAULTS to the current URL —
    // this host page's location, as the RELATIVE path + search (always same-origin with the
    // serving origin by construction). Validation is SERVER-side (the previewAuth dispatch, the
    // same validator as logout).
    if (op === "redirect_login" && !args.next_url) {
      args.next_url = window.location.pathname + window.location.search;
    }
    // GENERATED-APP end-user auth, never the NexusAI platform identity: the preview resolves a
    // project-scoped AppUser + AppSession through the previewAuth surface, exactly as the deployed
    // runtime does. The session token stays on this host page (the sandboxed iframe never sees it),
    // and signing out here ends only that generated-app session — the builder stays signed in.
    const res = await base44.functions.invoke("previewAuth", {
      project_id: projectId, op, args, session_token: previewSessionToken,
    });
    const data = res.data || {};
    if (data.error) throw new Error(data.error);
    const result = data.result || {};
    if (result.session_token) previewSessionToken = result.session_token;
    if (op === "logout" || (op === "me" && !result.authenticated)) previewSessionToken = null;
    // auth.logout(redirectUrl) parity (SDK 0.8.52): the HOST performs the navigation after the
    // session cleared — only a server-validated destination (relative path or same-origin
    // absolute) is ever present; a refused destination yields no redirect, identical to the
    // deployed host layer.
    if (op === "logout" && result.redirect_url) { window.location.href = result.redirect_url; }
    // auth.redirectToLogin(nextUrl) parity: the HOST performs the navigation to the validated
    // destination — the same top-document pattern the logout redirect uses above.
    if (op === "redirect_login" && result.from_url) { window.location.href = result.from_url; }
    return result;
  }
  if (scope === "analytics") {
    // Product analytics for the previewed app, through the SAME server-side analytics contract the
    // deployed runtime uses: the event is validated, scrubbed, attributed and stored there. Preview
    // traffic is recorded as the `development` environment, so it never mixes into the deployed
    // app's production numbers. The end-user attribution is the preview's own #29 session.
    const res = await base44.functions.invoke("previewAnalytics", {
      project_id: projectId, op, args, session_token: previewSessionToken,
    });
    const data = res.data || {};
    if (data.error) throw new Error(data.error);
    return data.result;
  }
  if (scope === "files" || scope === "integrations" || scope === "notifications") {
    // The previewed app's file storage and integrations surface (IntegrationsModule parity):
    // forwarded to the previewIntegrations backend function, which authorizes the project
    // server-side and dispatches through the SAME certified primitives the deployed runtime
    // serves — over the project's WORKING files and integrations, not a deployment. The
    // generated app's end-user session token rides along exactly like the auth scope, so RLS
    // ownership behaves identically in preview and production.
    const res = await base44.functions.invoke("previewIntegrations", {
      project_id: projectId, scope, op, args, session_token: previewSessionToken,
    });
    const data = res.data || {};
    if (data.error) throw new Error(data.error);
    return data.result;
  }
  if (scope === "app") {
    // AppModule parity (SDK 0.8.52 `base44.app.getPublicSettings()`): forwarded to the
    // previewIntegrations surface, which authorizes the project and serves the SAME shared
    // handler (shared/appPublicSettings.ts) the deployed runtime's "app" action dispatches to.
    // The documented Base44Error shape (status + data.extra_data.reason) rides the bridge as
    // error_detail, exactly like the deployed runtime's relay.
    if (op !== "get_public_settings") throw new Error(`Unknown app operation ${op}`);
    try {
      const res = await base44.functions.invoke("previewIntegrations", { project_id: projectId, scope: "app", op, args, session_token: previewSessionToken });
      return res.data?.result;
    } catch (err) {
      const e2 = new Error(err.response?.data?.error || err.message);
      e2.bridgeDetail = { status: err.response?.status || 0, data: err.response?.data || {} };
      throw e2;
    }
  }
  if (scope === "realtime") {
    // ActorsModule parity (SDK 0.8.52): the runtime's actors adapter uses the SAME op vocabulary
    // as the deployed "realtime" action, dispatched here through the EXISTING actorInvoke control
    // plane (builder-authorized, the project's WORKING actor files). "send" maps onto
    // actorInvoke's "invoke" — the same op the deployed send action serves — and the
    // control-plane envelope (ok/project_id/invalid) is stripped so the runtime sees the SAME
    // result shape the deployed path returns.
    const res = await base44.functions.invoke("actorInvoke", { project_id: projectId, op: op === "send" ? "invoke" : op, ...(args || {}) });
    const data = res.data || {};
    if (data.error) throw new Error(data.error);
    const { ok, project_id, invalid, ...result } = data;
    return result;
  }
  if (!DB_OPS.includes(op)) throw new Error(`Unknown db operation ${op}`);
  // The entity name travels with the call, but the DEFINITIONS are resolved server-side from
  // the project's own records — a browser-supplied schema is never trusted.
  const res = await base44.functions.invoke("previewData", { project_id: projectId, op, args, session_token: previewSessionToken });
  const data = res.data || {};
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ---------------------------------------------------------------------------
// Streaming (functions.fetch, multi-frame host bridging)
// ---------------------------------------------------------------------------
// The platform delivers a streaming function response incrementally ONLY to a native
// functions.fetch consumer, and the iframe bridge is postMessage — so the HOST reads the
// passthrough Response body and forwards the chunks as frames:
//   bridge:result       { __stream__: true, status, ok, headers } — sent BEFORE the first chunk,
//                       so the runtime builds its Response immediately
//   bridge:stream-chunk { id, b64 } — one chunk, base64-encoded
//   bridge:stream-done  { id } — clean end of stream
// The iframe aborts through bridge:stream-abort, which aborts the host's fetch; the executor's
// pump observes the signal and the stream ends with a clean early close.
const toB64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const activeStreams = new Map();

export function startStreamFrames(response, win, callId) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  delete headers["x-nexus-stream"]; // transport marker — never part of the app's Response
  win.postMessage({ type: "bridge:result", id: callId, result: { __stream__: true, status: response.status, ok: response.ok, headers } }, "*");
  const ctrl = new AbortController();
  activeStreams.set(callId, ctrl);
  (async () => {
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || ctrl.signal.aborted) break;
        win.postMessage({ type: "bridge:stream-chunk", id: callId, b64: toB64(new Uint8Array(value)) }, "*");
      }
    } catch {
      // A mid-stream failure reaches the client the way every such failure does: a clean early close.
    }
    activeStreams.delete(callId);
    try { win.postMessage({ type: "bridge:stream-done", id: callId }, "*"); } catch { /* window gone */ }
  })();
}

// Control-plane messages from the iframe (only the abort exists today). Returns true when
// the message was a stream control message the host consumed.
export function handleStreamControlMessage(m) {
  if (m && m.type === "bridge:stream-abort") {
    const ctrl = activeStreams.get(m.id);
    if (ctrl) ctrl.abort();
    return true;
  }
  return false;
}