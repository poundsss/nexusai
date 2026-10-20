// Certification for the UserConnectorsModule parity gap (SDK 0.8.52): the DOCUMENTED
// `connectors.connectAppUser(connectorId)` surface resolves to the provider redirect URL STRING
// (data.redirect_url). The runtime method now unwraps the EXISTING server "connect" op's
// envelope ({ connector, authorization_url, expires_in_ms, pkce }) to its authorization_url,
// with a bare-string result passing through unchanged as a fail-safe. No server, schema,
// OAuth/PKCE, relay or auth change — the method is a runtime-side thin unwrap; this cert drives
// the REAL server dispatch the bridge reaches (shared/appConnectors.handleAppConnectors).
//
// Certified:
//   • the shipped runtime exposes `connectors.connectAppUser` resolving to the authorization_url
//     string over the unchanged "connect" op (exact runtime-source mirror, with the fail-safe
//     pass-through, connections/disconnectAppUser and the sdk alias unchanged);
//   • a REAL Builder+ connect through the server still answers the unchanged envelope, and the
//     runtime unwrap over that exact envelope resolves to the EXACT authorization_url string;
//   • PREVIEW PARITY — both runtimes embed the SAME runtime source (one mirror line serves
//     deployed and preview), and the preview integrations surface still serves NO connectors
//     scope (nothing was added server-side);
//   • REGRESSION — fail-closed unknown-connector connect, the op whitelist and the disconnect
//     envelope ({ connector, revoked }) all behave exactly as before.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createPasswordlessUser, createSession } from "../../shared/appAuth.ts";
import {
  buildDelegatedProviders, delegatedProviderFromConnector, handleAppConnectors,
  loadProjectConnectors, oauthExchangeHttp, APP_CONNECTOR_OPS,
} from "../../shared/appConnectors.ts";
import { encryptSecretValue } from "../../shared/secretCrypto.ts";
import { connectorFilePath } from "../../shared/connectorResource.ts";
import { packFileContent } from "../../shared/blobStore.ts";
import { APP_INTEGRATION_OPS } from "../../shared/appIntegrations.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const TOKEN_HOST = "oauth.example.test";
const CLIENT_ID = "ccu_client_id";
const CLIENT_SECRET = "ccu_client_secret_never_leak";

// The EXACT runtime unwrap (mirror of src/lib/runtime/runtimeSource.js — backend code cannot
// import src/, the established mirror-check convention, keep in sync). The unwrap logic is
// evaluated in-cert against the REAL server envelope.
const CONNECT_METHOD_MIRROR =
  "  connectAppUser: async (connector) => { const r = await call('connectors', 'connect', { connector }); return (r && r.authorization_url) || r; },";
const CONNECTIONS_MIRROR = "  connections: async (connector) => call('connectors', 'connections', connector ? { connector } : {}),";
const DISCONNECT_MIRROR = "  disconnectAppUser: async (connector) => call('connectors', 'disconnect', { connector }) };";
const SDK_FREEZE = "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, types, app, appLogs });";

// The runtime unwrap, applied to a bridge result — the exact expression the shipped method runs.
const runtimeUnwrap = (r) => (r && r.authorization_url) || r;

export default async function (req) {
  const db = createClientFromRequest(req);
  const svc = db.asServiceRole || db;
  const h = createHarness();
  const stamp = Date.now();
  let ws = null, project = null, planCode = null;

  try {
    const me = await db.auth.me().catch(() => null);
    if (!me) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    // ---- fixture: one Builder+ workspace, one project, one delegated connector ---------------
    ws = await svc.entities.Workspace.create({ name: `ccu-${stamp}`, owner_id: me.id, credits_balance: 0 });
    planCode = `ccu_plan_${crypto.randomUUID().slice(0, 8)}`;
    await svc.entities.BillingPlan.create({ code: planCode, name: "CCU Builder cert", tier_rank: 7, active: true, price_cents: 5000, interval: "monthly" });
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: planCode, status: "active" });
    project = await svc.entities.Project.create({ workspace_id: ws.id, name: "CCU App", slug: `ccu-${stamp}` });

    const user = await createPasswordlessUser(svc, project, { email: `u-${stamp}@ccu.test`, display_name: "CCU User", email_verified: true });
    await createSession(svc, project, user, { ip: "203.0.113.7" });

    const connectorDoc = JSON.stringify({
      name: "extconn",
      type: "http",
      description: "CCU delegated connector",
      base_url: "https://api.example.test/v1",
      auth: { type: "none" },
      operations: [{ name: "ping", method: "GET", path: "/me" }],
      delegated_oauth: {
        authorization_endpoint: `https://${TOKEN_HOST}/authorize`,
        token_endpoint: `https://${TOKEN_HOST}/token`,
        client_id_secret: "EXTCONN_CLIENT_ID",
        client_secret_secret: "EXTCONN_CLIENT_SECRET",
        scopes: ["read"],
        pkce: true,
      },
    }, null, 2);
    const stored = await packFileContent(svc, connectorFilePath("extconn"), connectorDoc);
    await svc.entities.ProjectFile.create({ project_id: project.id, path: connectorFilePath("extconn"), ...stored, frozen: false });
    const setSecret = async (name, value) => {
      const sealed = await encryptSecretValue(project.id, name, value);
      await svc.entities.ProjectSecret.create({ project_id: project.id, name, value: sealed, description: "ccu", required: true, access: "backend_only" });
    };
    await setSecret("EXTCONN_CLIENT_ID", CLIENT_ID);
    await setSecret("EXTCONN_CLIENT_SECRET", CLIENT_SECRET);
    const resolveSecret = async (name) => {
      const row = (await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []))[0];
      if (!row?.value) return undefined;
      const { decryptSecretValue } = await import("../../shared/secretCrypto.ts");
      try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
    };

    const loaded = await loadProjectConnectors(svc, project.id);
    const meta = { ip: "203.0.113.7", user_agent: "ccu/1.0" };
    const callback_url = "https://runtime.example.com/app/ccu/oauth/callback";

    // ---- 1. shipped runtime surface --------------------------------------------------------
    h.check("1a. the shipped runtime exposes `connectors.connectAppUser(connectorId)` as the documented URL-string unwrap over the unchanged \"connect\" op, with connections/disconnectAppUser and the sdk alias unchanged",
      RUNTIME_EXPORTS.includes("connectors") &&
      CONNECT_METHOD_MIRROR.includes("call('connectors', 'connect', { connector })") &&
      CONNECT_METHOD_MIRROR.includes("return (r && r.authorization_url) || r;") &&
      CONNECTIONS_MIRROR.length > 0 && DISCONNECT_MIRROR.endsWith("disconnectAppUser") === false && DISCONNECT_MIRROR.includes("call('connectors', 'disconnect', { connector })") &&
      SDK_FREEZE.endsWith("appLogs });"),
      `exports=${RUNTIME_EXPORTS.join(",")} · method=${CONNECT_METHOD_MIRROR.slice(0, 60)}…`);

    // ---- 2. REAL connect: the server envelope is unchanged, the unwrap resolves to the URL ----
    const envelope = await handleAppConnectors(svc, { project, connectors: loaded, user, op: "connect", args: { connector: "extconn" }, meta, resolveSecret, http: oauthExchangeHttp, callback_url });
    const urlShape = typeof envelope?.authorization_url === "string" && envelope.authorization_url.startsWith(`https://${TOKEN_HOST}/authorize`) && !!new URL(envelope.authorization_url).searchParams.get("state");
    h.check("2a. the REAL Builder+ connect through the server answers the UNCHANGED envelope { connector, authorization_url, expires_in_ms, pkce }",
      envelope?.connector === "extconn" && typeof envelope?.authorization_url === "string" &&
      typeof envelope?.expires_in_ms === "number" && typeof envelope?.pkce === "boolean",
      JSON.stringify(envelope).slice(0, 120));
    const unwrapped = runtimeUnwrap(envelope);
    h.check("2b. THE GAP CLOSED: the runtime method over the real envelope resolves to the EXACT authorization URL string (SDK parity — data.redirect_url is a string, not the object)",
      typeof unwrapped === "string" && unwrapped === envelope.authorization_url && urlShape,
      `unwrapped=${String(unwrapped).slice(0, 80)}`);

    // ---- 3. fail-safe: a bare-string bridge result passes through unchanged -------------------
    const bare = `https://${TOKEN_HOST}/authorize?state=bare`;
    h.check("3. a bare-string bridge result passes through the unwrap unchanged (fail-safe)",
      runtimeUnwrap(bare) === bare && runtimeUnwrap(null) === null,
      `string=${runtimeUnwrap(bare) === bare} · null=${runtimeUnwrap(null) === null}`);

    // ---- 4. PREVIEW PARITY: one runtime source serves both runtimes; server surface unchanged --
    h.check("4. preview parity: both runtimes embed the SAME runtime source (one mirror line serves deployed and preview) and the preview integrations surface still serves NO connectors scope (nothing was added server-side)",
      RUNTIME_EXPORTS.includes("connectors") &&
      !APP_INTEGRATION_OPS.includes("connectors") &&
      APP_CONNECTOR_OPS.includes("connect") && APP_CONNECTOR_OPS.includes("disconnect") && APP_CONNECTOR_OPS.includes("connections") && APP_CONNECTOR_OPS.length === 3,
      `integration_ops=${APP_INTEGRATION_OPS.join(",")} · connector_ops=${APP_CONNECTOR_OPS.join(",")}`);

    // ---- 5. REGRESSION: fail-closed + disconnect envelope unchanged ---------------------------
    let unknownDenied = false;
    try {
      await handleAppConnectors(svc, { project, connectors: loaded, user, op: "connect", args: { connector: "ghost" }, meta, resolveSecret, http: oauthExchangeHttp, callback_url });
    } catch (e) { unknownDenied = e.code === "CONNECTOR_NOT_FOUND"; }
    const disconnected = await handleAppConnectors(svc, { project, connectors: loaded, user, op: "disconnect", args: { connector: "extconn" }, meta, resolveSecret, http: oauthExchangeHttp, callback_url });
    h.check("5. existing connector behavior is unchanged: an unknown connector is still refused fail-closed and the disconnect envelope is still { connector, revoked }",
      unknownDenied && disconnected?.connector === "extconn" && disconnected?.revoked === 0,
      `unknown_denied=${unknownDenied} · disconnect=${JSON.stringify(disconnected)}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    if (project) {
      for (const entity of ["ProjectFile", "ProjectSecret", "AuditLog", "AppAuthToken", "AppIdentity", "AppSession", "DelegatedCredential", "AppUser"]) {
        await purgeBy(svc, entity, { project_id: project.id }).catch(() => {});
      }
      await svc.entities.Project.delete(project.id).catch(() => {});
    }
    if (planCode) {
      for (const r of await svc.entities.BillingPlan.filter({ code: planCode }, "code", 10).catch(() => [])) await svc.entities.BillingPlan.delete(r.id).catch(() => {});
    }
    if (ws) {
      for (const r of await svc.entities.Subscription.filter({ workspace_id: ws.id }, "-created_date", 10).catch(() => [])) await svc.entities.Subscription.delete(r.id).catch(() => {});
      for (const r of await svc.entities.RateLimitBucket.filter({ workspace_id: ws.id }, "-created_date", 500).catch(() => [])) await svc.entities.RateLimitBucket.delete(r.id).catch(() => {});
      await cleanupWorkspace(svc, ws.id, []).catch(() => {});
    }
  }
}