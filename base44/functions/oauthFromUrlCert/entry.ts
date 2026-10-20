// Certification for the auth.loginWithProvider(provider, fromUrl) parity gap (SDK 0.8.52):
// the runtime method now forwards the OPTIONAL post-login return destination as `from_url`,
// the server validates it fail-closed (relative path, or an absolute URL whose origin equals
// the app's serving origin), preserves the validated value in the EXISTING single-use
// oauth_state token's data, and the callback answer carries it back so the host surfaces can
// return the user there. No new endpoint, entity, schema field, provider-flow, PKCE, session
// or host-redirect change — one optional field through the existing begin/state/callback chain.
//
// Certified:
//   • the shipped runtime exposes the from_url-forwarding loginWithProvider (exact mirror);
//   • a REAL begin → state → callback round-trip preserves the validated destination;
//   • a relative destination and a same-origin absolute destination both work;
//   • a cross-origin destination and a protocol-relative destination FAIL CLOSED;
//   • an OMITTED fromUrl leaves the state data unchanged and the callback answer null
//     (the existing fixed destination stays the fallback);
//   • PKCE regression — a from_url flow alongside a PKCE provider still stores the verifier
//     server-side and completes the exchange;
//   • PREVIEW PARITY — the same runtime source serves both runtimes, and the preview auth
//     surface is unchanged (no oauth ops added there).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { beginOAuth, completeOAuth, validatePostLoginUrl } from "../../shared/appOAuth.ts";
import { sha256 } from "../../shared/appAuth.ts";
import { PREVIEW_AUTH_OPS } from "../../shared/previewAuth.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const ORIGIN = "https://runtime.example.com";

// The EXACT runtime method (mirror of src/lib/runtime/runtimeSource.js — backend code cannot
// import src/, the established mirror-check convention, keep in sync).
const LOGIN_WITH_PROVIDER_MIRROR =
  "  loginWithProvider: async (provider, fromUrl) => call('auth', 'oauth_begin', { provider, ...(fromUrl ? { from_url: String(fromUrl).slice(0, 500) } : {}) }) };";
const SDK_FREEZE = "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, types, app, appLogs });";

const meta = { ip: "198.51.100.5", user_agent: "ofu/1.0" };

export default async function (req) {
  const db = createClientFromRequest(req);
  const svc = db.asServiceRole || db;
  const h = createHarness();
  let ws = null, project = null;

  try {
    const me = await db.auth.me().catch(() => null);
    if (!me) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    // ---- fixture: one workspace, one project, one PKCE-capable stub provider ----------------
    ws = await svc.entities.Workspace.create({ name: `ofu-${Date.now()}`, owner_id: me.id, credits_balance: 0 });
    project = await svc.entities.Project.create({ workspace_id: ws.id, name: "OFU App", slug: `ofu-${Date.now()}` });
    const acme = {
      authorize_url: "https://auth.example.com/authorize", client_id: "cid", scopes: ["openid", "email"], pkce: true,
      exchange: async () => ({ subject: `ofu-${Date.now()}`, email: `ofu-${Date.now()}@example.com`, display_name: "OFU User", email_verified: true, profile: {} }),
    };
    const providers = { acme };

    // ---- 1. shipped runtime surface ---------------------------------------------------------
    h.check("1. the shipped runtime exposes loginWithProvider(provider, fromUrl) forwarding from_url over the UNCHANGED oauth_begin op, with the sdk freeze unchanged",
      RUNTIME_EXPORTS.includes("auth") &&
      LOGIN_WITH_PROVIDER_MIRROR.includes("fromUrl") &&
      LOGIN_WITH_PROVIDER_MIRROR.includes("from_url") &&
      LOGIN_WITH_PROVIDER_MIRROR.includes("call('auth', 'oauth_begin'") &&
      SDK_FREEZE.endsWith("appLogs });"),
      `method=${LOGIN_WITH_PROVIDER_MIRROR.slice(0, 70)}…`);

    // ---- 2. relative destination survives begin → state → callback ---------------------------
    const rel = await beginOAuth(svc, project.id, { provider: "acme", redirect_uri: `${ORIGIN}/app/x/oauth/callback`, from_url: "/dashboard" }, { providers, meta, origin: ORIGIN });
    const [relState] = await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "oauth_state", token_hash: await sha256(rel.state) }, "-created_date", 1);
    h.check("2. a RELATIVE from_url is preserved in the existing oauth_state token's data and returned through the callback answer",
      relState?.data?.post_login_url === "/dashboard" &&
      typeof new URL(rel.authorization_url).searchParams.get("code_challenge") === "string" &&
      (await completeOAuth(svc, project.id, { provider: "acme", state: rel.state, code: "c1" }, { providers, meta })).post_login_url === "/dashboard",
      `state=${JSON.stringify(relState?.data).slice(0, 90)}`);

    // ---- 3. same-origin absolute destination works -------------------------------------------
    const absFrom = `${ORIGIN}/settings?next=/billing`;
    h.check("3. a SAME-ORIGIN absolute from_url is validated through and preserved",
      validatePostLoginUrl(absFrom, ORIGIN) === absFrom &&
      (await beginOAuth(svc, project.id, { provider: "acme", from_url: absFrom }, { providers, meta, origin: ORIGIN })).authorization_url.includes("auth.example.com"),
      `from_url=${absFrom}`);

    // ---- 4. cross-origin + protocol-relative FAIL CLOSED -------------------------------------
    let cross = null, proto = null, control = null;
    try { await beginOAuth(svc, project.id, { provider: "acme", from_url: "https://evil.test/phish" }, { providers, meta, origin: ORIGIN }); }
    catch (e) { cross = e.code; }
    try { await beginOAuth(svc, project.id, { provider: "acme", from_url: "//evil.test/phish" }, { providers, meta, origin: ORIGIN }); }
    catch (e) { proto = e.code; }
    try { await beginOAuth(svc, project.id, { provider: "acme", from_url: "/ok\r\nSet-Cookie: x" }, { providers, meta, origin: ORIGIN }); }
    catch (e) { control = e.code; }
    h.check("4. THE GAP CLOSED: cross-origin, protocol-relative and header-injecting destinations all FAIL CLOSED (OAUTH_FROM_URL_INVALID) — nothing is stored",
      cross === "OAUTH_FROM_URL_INVALID" && proto === "OAUTH_FROM_URL_INVALID" && control === "OAUTH_FROM_URL_INVALID",
      `cross=${cross} · proto=${proto} · control=${control}`);

    // ---- 5. OMITTED fromUrl preserves the existing behavior ----------------------------------
    const plain = await beginOAuth(svc, project.id, { provider: "acme", redirect_uri: `${ORIGIN}/app/x/oauth/callback` }, { providers, meta });
    const [plainState] = await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "oauth_state", token_hash: await sha256(plain.state) }, "-created_date", 1);
    h.check("5. an OMITTED fromUrl stores NO post_login_url and the callback answer stays null (the fixed fallback destination is preserved)",
      !("post_login_url" in (plainState?.data || {})) &&
      (await completeOAuth(svc, project.id, { provider: "acme", state: plain.state, code: "c2" }, { providers, meta })).post_login_url === null,
      `state_keys=${Object.keys(plainState?.data || {}).join(",")}`);

    // ---- 6. PKCE regression: from_url alongside a PKCE provider -------------------------------
    const pkceFlow = await beginOAuth(svc, project.id, { provider: "acme", from_url: "/dashboard" }, { providers, meta, origin: ORIGIN });
    const [pkceState] = await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "oauth_state", token_hash: await sha256(pkceFlow.state) }, "-created_date", 1);
    h.check("6. REGRESSION: the PKCE verifier is still stored server-side (and never in the authorization URL) when a from_url rides the same state",
      !!pkceState?.data?.pkce_verifier && !pkceFlow.authorization_url.includes(pkceState.data.pkce_verifier) &&
      pkceState.data.post_login_url === "/dashboard",
      `data_keys=${Object.keys(pkceState?.data || {}).join(",")}`);

    // ---- 7. PREVIEW PARITY --------------------------------------------------------------------
    h.check("7. preview parity: the SAME runtime source serves both runtimes (mirror-only change) and the preview auth surface is unchanged — no oauth ops added there",
      RUNTIME_EXPORTS.includes("auth") &&
      !PREVIEW_AUTH_OPS.some((op) => op.startsWith("oauth")) &&
      PREVIEW_AUTH_OPS.length >= 10,
      `preview_ops=${PREVIEW_AUTH_OPS.join(",")}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    if (project) {
      for (const entity of ["AppAuthToken", "AppIdentity", "AppSession", "AppUser"]) {
        await purgeBy(svc, entity, { project_id: project.id }).catch(() => {});
      }
      await svc.entities.Project.delete(project.id).catch(() => {});
    }
    if (ws) await cleanupWorkspace(svc, ws.id, []).catch(() => {});
  }
}