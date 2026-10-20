import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { Loader2, AlertTriangle, X } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { bundlePreview, PREVIEW_CSP } from "@/lib/runtime/previewBundle";
import { startStreamFrames, handleStreamControlMessage } from "@/lib/runtime/dbBridge";
import AppHeadMeta from "@/components/runtime/AppHeadMeta";
import PublicAppConnections from "@/components/runtime/PublicAppConnections";
import PublicAppSignIn from "@/components/runtime/PublicAppSignIn";
import PlatformBadge from "@/components/runtime/PlatformBadge";
import RealtimeWsBridge from "@/components/runtime/RealtimeWsBridge";

// PUBLIC production runtime page.
//
// It knows only a slug. Everything it renders comes from the immutable artifact of that
// slug's LIVE deployment, and every db/backend call is forwarded to the public runtime
// endpoint, which re-derives the scope server-side. No builder identity, project id,
// version id or secret is involved on this page.
export default function PublicApp() {
  const { slug } = useParams();
  const target = useMemo(() => (slug ? { slug } : { host: window.location.host }), [slug]);
  const publicUrl = useMemo(() => {
    const origin = window.location.origin;
    return target.slug ? `${origin}/app/${target.slug}` : `${origin}/`;
  }, [target]);
  const [state, setState] = useState({ loading: true });
  const [signedIn, setSignedIn] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Deployed-host runtime:error surfacing: display-only, bounded, dismissible (see onMessage).
  const [runtimeError, setRuntimeError] = useState(null);
  const iframeRef = useRef(null);
  const location = useLocation();
  // Boot-time deep-link: the in-app path this host loaded with, e.g. /app/<slug>/todos -> '/todos'
  // (or the verbatim path on a custom domain). Captured ONCE at mount; nulled when the runtime
  // acks it, so the boot delivery never re-fires.
  const bootDeepLink = useMemo(() => {
    if (!slug) return window.location.pathname + window.location.search;
    const prefix = `/app/${slug}`;
    const rest = location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : "";
    return rest ? rest + window.location.search : null;
  }, [slug, location.pathname]);
  const deepLinkRef = useRef(bootDeepLink);
  // Pending auth.redirectToLogin destination: stored when the host shows the login surface,
  // honored once sign-in completes (the visitor lands on the validated destination).
  const pendingFromUrlRef = useRef(null);
  // Published-app session persistence (additive): the SAME host-owned session token also
  // rides sessionStorage (per app), so a page reload restores the signed-in session instead
  // of bouncing back to the sign-in screen. Storage only — the token's owner, shape and
  // server TTL are unchanged, and no auth contract moves.
  const sessionKey = `nexus_pub_session:${target.slug || target.host || ""}`;
  const readStoredSession = () => { try { return window.sessionStorage.getItem(sessionKey) || null; } catch { return null; } };
  const storeSession = (token) => { try { if (token) window.sessionStorage.setItem(sessionKey, token); else window.sessionStorage.removeItem(sessionKey); } catch { /* storage unavailable */ } };
  const sessionTokenRef = useRef(readStoredSession());
  const anonTokenRef = useRef(null);
  // Current in-app page path (per-page document title): tracks the runtime's own navigation
  // (boot deep-link, runtime:navigate, browser back/forward). App-level title stays the fallback.
  const [pagePath, setPagePath] = useState(() => (deepLinkRef.current ? String(deepLinkRef.current).split("?")[0] : "/"));

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    setRuntimeError(null);
    (async () => {
      try {
        // Published SEO surfaces (additive): /sitemap.xml and /robots.txt are served from the
        // runtime's own data instead of the app bundle — the URL base is this host's origin only.
        const seoPath = target.slug
          ? (deepLinkRef.current ? String(deepLinkRef.current).split("?")[0] : null)
          : window.location.pathname;
        if (seoPath === "/sitemap.xml" || seoPath === "/robots.txt") {
          // The restored session rides this call too (like every other bridge call): a
          // signed-in visitor of a private/workspace app keeps getting robots.txt and
          // sitemap.xml after a reload, exactly as they did before it.
          const seoRes = await base44.functions.invoke("appRuntime", { ...target, action: "seo", op: seoPath === "/sitemap.xml" ? "sitemap" : "robots", base_url: window.location.origin, ...(sessionTokenRef.current ? { session_token: sessionTokenRef.current } : {}) });
          if (cancelled) return;
          setState({ loading: false, seo: { kind: seoPath, content: (seoRes.data || {}).content || "" } });
          return;
        }
        // Path-level 301 redirects apply to the published site's own URLs (custom domain and the
        // built-in domain), which arrive in host mode. The `/app/:slug` builder preview path is
        // not a published-site URL, so it sends no path and is never redirected.
        const page = target.slug ? {} : { path: window.location.pathname, search: window.location.search };
        // The session token rides the artifact request: for a private/workspace app the serving
        // gate accepts an authenticated app user, so a signed-in visitor (including one who just
        // signed in on this host page) loads the app. Anonymous public apps are unaffected.
        const res = await base44.functions.invoke("appRuntime", {
          ...target, action: "artifact", ...page,
          ...(sessionTokenRef.current ? { session_token: sessionTokenRef.current } : {}),
        });
        if (cancelled) return;
        if (res.data?.redirect) { window.location.replace(res.data.redirect.location); return; }
        setState({ loading: false, data: res.data });
      } catch (e) {
        if (!cancelled) {
          // App Visibility gate: a private/workspace app refused an anonymous visitor (401
          // AUTH_REQUIRED). The host shows its sign-in screen (the same auth operations the
          // runtime serves) instead of the generic unavailable error — every other refusal
          // (archive, unpublish, suspension, unknown app, not-a-member) keeps its error state.
          const authRequired = e.response?.status === 401 &&
            (!e.response?.data?.code || e.response.data.code === "AUTH_REQUIRED");
          // A refused or expired RESTORED session is cleared, so the next sign-in starts clean.
          if (authRequired) { sessionTokenRef.current = null; storeSession(null); }
          setState({ loading: false, needsSignIn: authRequired, error: authRequired ? null : (e.response?.data?.error || e.message) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [target, attempt]);

  // Sign-in screen callback: keep the minted session token host-side (like every bridge
  // session token) and reload the artifact — the gate now resolves the authenticated user.
  const handleAuthenticated = (token) => {
    sessionTokenRef.current = token;
    storeSession(token);
    // Honor a pending auth.redirectToLogin destination: the host URL moves to it and the boot
    // deep-link lands the freshly signed-in app on the same in-app path.
    const dest = pendingFromUrlRef.current;
    pendingFromUrlRef.current = null;
    if (dest) {
      try {
        const u = new URL(dest, window.location.origin);
        const path = u.pathname + u.search;
        const prefix = target.slug ? `/app/${target.slug}` : "";
        const inApp = prefix && path.startsWith(prefix) ? (path.slice(prefix.length) || "/") : path;
        window.history.replaceState({}, "", prefix ? prefix + inApp : path);
        if (deepLinkRef.current == null) deepLinkRef.current = inApp;
        setPagePath(inApp);
      } catch { /* malformed destination: keep the existing post-sign-in behavior */ }
    }
    setSignedIn(true);
    setAttempt((a) => a + 1);
  };

  const bundle = useMemo(() => {
    if (!state.data) return null;
    try { return { srcdoc: bundlePreview(state.data.files, { csp: state.data.security?.csp || PREVIEW_CSP, packages: state.data.package_modules || null }) }; } catch (e) { return { error: e.message }; }
  }, [state.data]);

  useEffect(() => {
    const onMessage = async (e) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const m = e.data || {};
      if (handleStreamControlMessage(m)) return;
      // Deployed-host runtime messages (additive, display/history only — no app behavior change):
      //  * runtime:error — the sandboxed app's window.onerror / unhandledrejection. Surfaced
      //    visibly (bounded to 300 chars, no HTML) and logged; never alters app execution.
      if (m.type === "runtime:error") {
        const text = String(m.message || "Unknown runtime error").slice(0, 300);
        console.error("[app runtime]", text);
        setRuntimeError(text);
        return;
      }
      //  * runtime:navigate — the app's navigate(): history synchronization on the host URL under
      //    the /app/<slug> prefix (verbatim on a custom domain). pushState/replaceState are
      //    same-origin by construction. A URL equal to the current one is replaceState'd, so
      //    back/forward acks never create duplicate history entries.
      if (m.type === "runtime:navigate") {
        const p = typeof m.path === "string" && m.path.startsWith("/") && !m.path.startsWith("//") && !m.path.includes("://") && m.path.length <= 2048 ? m.path : null;
        if (p) {
          const url = (target.slug ? `/app/${target.slug}` : "") + p;
          // Trailing-slash-insensitive comparison: "/x" and "/x/" are the same location.
          const norm = (u) => { const q = u.indexOf("?"); return ((q === -1 ? u : u.slice(0, q)).replace(/\/+$/, "") || "/") + (q === -1 ? "" : u.slice(q)); };
          if (norm(url) === norm(window.location.pathname + window.location.search)) window.history.replaceState({}, "", url);
          else window.history.pushState({}, "", url);
          if (deepLinkRef.current != null && p === deepLinkRef.current) deepLinkRef.current = null; // deep-link boot acked
          setPagePath(p); // per-page document title follows the runtime's navigation
        }
        return;
      }
      if (m.type !== "bridge:call") return;
      try {
        let result;
        if (m.scope === "auth") {
          const op = m.op;
          const unauthenticated = { authenticated: false, user: null, session: null, roles: [], permissions: [] };
          // Account-management ops (SDK AuthModule parity): forwarded to the SAME certified
          // appRuntime auth ops — no new auth surface here. Session-token pass-through,
          // error/status fidelity and the login/logout/OAuth handling above are unchanged.
          if (!["me", "can", "signup", "login", "logout", "verify_otp", "resend_otp", "providers", "oauth_begin", "update_profile", "change_password", "request_password_reset", "confirm_password_reset", "invite_user", "redirect_login"].includes(op)) throw new Error(`Unknown auth operation ${op}`);
          // auth.redirectToLogin(nextUrl) parity (SDK): the destination DEFAULTS to the current
          // URL — THIS host page's location, the only layer that owns it (the sandboxed frame is
          // opaque). It travels as the RELATIVE path + search (always same-origin with the serving
          // origin by construction, so it validates on both the built-in domain and a custom one);
          // final validation stays SERVER-side.
          if (op === "redirect_login" && (!m.args || !m.args.next_url)) {
            m.args = { ...(m.args || {}), next_url: window.location.pathname + window.location.search };
          }
          if (!sessionTokenRef.current && (op === "me" || op === "can" || op === "logout")) {
            result = op === "can" ? { allowed: false, ...unauthenticated } : op === "logout" ? { ok: true, ...unauthenticated } : unauthenticated;
          } else {
            const res = await base44.functions.invoke("appRuntime", { ...target, action: "auth", op, args: m.args || {}, session_token: sessionTokenRef.current });
            const data = res.data || {};
            if (data.session_token) { sessionTokenRef.current = data.session_token; storeSession(data.session_token); setSignedIn(true); }
            if (op === "logout" || (op !== "signup" && op !== "login" && op !== "oauth_begin" && data.authenticated === false)) { sessionTokenRef.current = null; storeSession(null); setSignedIn(false); }
            if (op === "oauth_begin" && data.authorization_url) window.location.href = data.authorization_url;
            result = data;
          }
        } else if (m.scope === "analytics") {
          const res = await base44.functions.invoke("appRuntime", { ...target, action: "analytics", op: m.op, args: m.args || {}, session_token: sessionTokenRef.current });
          result = res.data.result;
        } else if (m.scope === "files") {
          const res = await base44.functions.invoke("appRuntime", { ...target, action: "files", op: m.op, args: m.args || {}, session_token: sessionTokenRef.current });
          result = res.data.result;
        } else if (m.scope === "notifications") {
          const res = await base44.functions.invoke("appRuntime", { ...target, action: "notifications", op: m.op, args: m.args || {}, session_token: sessionTokenRef.current });
          const data = res.data || {};
          if (data.error) throw new Error(data.error);
          result = data.result;
        } else if (m.scope === "integrations") {
          const res = await base44.functions.invoke("appRuntime", { ...target, action: "integrations", op: m.op, args: m.args || {}, session_token: sessionTokenRef.current });
          const data = res.data || {};
          if (data.error) throw new Error(data.error);
          result = data.result;
        } else if (m.scope === "fn") {
          if (m.op === "fetch") {
            // Streaming (multi-frame bridge): the call rides the DOCUMENTED functions.fetch surface
            // so the platform delivers the endpoint's raw passthrough Response incrementally; the
            // marker header distinguishes a streamed result (pumped to the iframe in chunk frames)
            // from the buffered envelope, whose semantics are unchanged.
            const res = await base44.functions.fetch("/appRuntime", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...target, action: "fn", mode: "fetch", fetch: m.args || {}, stream: true, session_token: sessionTokenRef.current }),
            });
            if (res.headers.get("x-nexus-stream") === "1") { startStreamFrames(res, e.source, m.id); return; }
            const data = JSON.parse(await res.text());
            if (data.error) throw new Error(data.error);
            result = data.result;
          } else {
            // invoke fidelity (SDK 0.8.52): the real status travels with the body (structured
            // result + { response: { status, data } } on a function 4xx/5xx); no headers are
            // invented. Mirrors the preview bridge (dbBridge.js) exactly.
            const res = await base44.functions.invoke("appRuntime", { ...target, action: "fn", function_name: m.op, payload: m.args?.payload ?? null, session_token: sessionTokenRef.current });
            const { status, body } = res.data || {};
            if (status >= 400) {
              const e2 = new Error((body && body.error) || `Backend function ${m.op} failed (${status})`);
              e2.bridgeDetail = { response: { status, data: body } };
              throw e2;
            }
            result = { __invoke__: true, status, body };
          }
        } else if (m.scope === "connectors") {
          const res = await base44.functions.invoke("appRuntime", { ...target, action: "connectors", op: m.op, args: m.args || {}, session_token: sessionTokenRef.current });
          result = res.data?.result;
          if (m.op === "connect" && result?.authorization_url) window.location.href = result.authorization_url;
        } else if (m.scope === "agent" || m.scope === "channel") {
          const res = await base44.functions.invoke("appRuntime", { ...target, action: m.scope, op: m.op, args: m.args || {}, session_token: sessionTokenRef.current, ...(m.scope === "agent" ? { anonymous_token: anonTokenRef.current } : {}) });
          const data = res.data || {};
          if (data.error) throw new Error(data.error);
          result = data.result;
          if (result?.anonymous_session_token) anonTokenRef.current = result.anonymous_session_token;
        } else if (m.scope === "app") {
          // AppModule parity (SDK 0.8.52 `base44.app.getPublicSettings()`): forwarded to the
          // public runtime's "app" action, which resolves the EXISTING serving gate and returns
          // only { id, public_settings }. The documented Base44Error shape (status +
          // data.extra_data.reason) rides the bridge as error_detail; the message-only
          // transport for every other scope is unchanged.
          const res = await base44.functions.invoke("appRuntime", { ...target, action: "app", op: m.op, args: m.args || {}, session_token: sessionTokenRef.current });
          const data = res.data || {};
          if (data.error) {
            const e2 = new Error(data.error);
            e2.bridgeDetail = { status: res.status || 0, data };
            throw e2;
          }
          result = data.result;
        } else if (m.scope === "realtime") {
          // ActorsModule parity (SDK 0.8.52): the runtime's actors adapter rides the deployed
          // runtime's EXISTING "realtime" action (certified in realtimeParityTest) — the session
          // token rides along exactly like every other authenticated scope.
          const res = await base44.functions.invoke("appRuntime", { ...target, action: "realtime", op: m.op, args: m.args || {}, session_token: sessionTokenRef.current });
          const data = res.data || {};
          if (data.error) throw new Error(data.error);
          result = data.result;
        } else {
          const res = await base44.functions.invoke("appRuntime", { ...target, action: "db", op: m.op, args: m.args, session_token: sessionTokenRef.current });
          result = res.data.result;
        }
        e.source.postMessage({ type: "bridge:result", id: m.id, result }, "*");
        // auth.logout(redirectUrl) parity (SDK 0.8.52): the HOST performs the top-level
        // navigation AFTER the result was delivered and the session cleared — only a
        // server-validated destination (relative path or same-origin absolute) ever reaches
        // this line; a refused destination yields no redirect and no navigation.
        if (m.scope === "auth" && m.op === "logout" && result?.redirect_url) window.location.href = result.redirect_url;
        // auth.redirectToLogin(nextUrl) parity (SDK): the HOST is the app's existing login
        // surface — the SAME sign-in screen the serving gate renders for gated apps. A
        // server-validated destination is stored and honored after sign-in (the visitor lands on
        // it); an external/cross-origin destination was refused server-side and navigates
        // nowhere. The trigger is deferred by one task so the frame receives the bridge result
        // (and can record it) before it is replaced.
        if (m.scope === "auth" && m.op === "redirect_login" && result?.from_url) {
          const dest = result.from_url;
          setTimeout(() => {
            pendingFromUrlRef.current = dest;
            setSignedIn(false);
            setState((s) => ({ ...s, needsSignIn: true }));
          }, 0);
        }
      } catch (err) {
        e.source.postMessage({ type: "bridge:result", id: m.id, error: err.response?.data?.error || err.message, ...(err.bridgeDetail ? { error_detail: err.bridgeDetail } : {}) }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [target]);

  // Boot-time deep-link: deliver the loaded path into the app once its runtime is up. The
  // runtime answers with a runtime:navigate ack, which nulls deepLinkRef and stops the retry.
  useEffect(() => {
    const p = deepLinkRef.current;
    if (!bundle?.srcdoc || !p) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (deepLinkRef.current == null || tries > 60) { clearInterval(timer); return; }
      iframeRef.current?.contentWindow?.postMessage({ type: "runtime:goto", path: p }, "*");
    }, 400);
    return () => clearInterval(timer);
  }, [bundle?.srcdoc]);

  // Browser back/forward: translate the host URL back into the app's path and hand it to the
  // runtime (the same runtime:goto message the Builder preview uses). Outside the app's own
  // prefix the host stays out of the way.
  useEffect(() => {
    const prefix = target.slug ? `/app/${target.slug}` : "";
    const onPop = () => {
      const search = window.location.search;
      const p = prefix
        ? (window.location.pathname.startsWith(prefix) ? (window.location.pathname.slice(prefix.length) || "/") + search : null)
        : window.location.pathname + search;
      if (p) setPagePath(p);
      if (p && iframeRef.current?.contentWindow) iframeRef.current.contentWindow.postMessage({ type: "runtime:goto", path: p }, "*");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [target]);

  if (state.loading) return <div className="h-screen grid place-items-center text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  // Published SEO surfaces: the served well-known file, rendered verbatim as plain text.
  if (state.seo) {
    return (
      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }} className="min-h-screen overflow-auto bg-white p-6 font-mono text-[13px] text-slate-800">
        {state.seo.content}
      </pre>
    );
  }
  if (state.needsSignIn) return <PublicAppSignIn target={target} onAuthenticated={handleAuthenticated} />;
  if (state.error || bundle?.error) {
    return (
      <div className="h-screen grid place-items-center p-8 text-center">
        <div>
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-500" />
          <p className="mt-2 font-medium">This application is not available</p>
          <p className="mt-1 font-mono text-[12px] text-slate-500">{state.error || bundle.error}</p>
        </div>
      </div>
    );
  }
  return (
    <React.Fragment>
      <AppHeadMeta title={state.data?.app?.name || ""} description={state.data?.app?.description || ""} url={publicUrl} logoUrl={state.data?.app?.logo_url || null} pagePath={pagePath} />
      <PublicAppConnections target={target} sessionRef={sessionTokenRef} signedIn={signedIn} />
      <RealtimeWsBridge iframeRef={iframeRef} target={target} sessionTokenRef={sessionTokenRef} />
      {state.data?.badge?.visible && <PlatformBadge />}
      {runtimeError && (
        <div role="alert" className="fixed bottom-3 left-3 z-[9998] flex max-w-sm items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 shadow-sm">
          <span className="break-all font-mono">{runtimeError}</span>
          <button onClick={() => setRuntimeError(null)} aria-label="Dismiss error" className="shrink-0 rounded p-0.5 text-amber-700 hover:text-amber-900">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        title={state.data?.app?.name || "Application"}
        sandbox={state.data?.security?.sandbox || "allow-scripts allow-forms allow-modals allow-popups"}
        referrerPolicy="no-referrer"
        srcDoc={bundle.srcdoc}
        className="h-screen w-full border-0"
      />
    </React.Fragment>
  );
}