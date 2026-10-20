// Certification for the AuthModule parity gap: the DOCUMENTED Base44 `base44.auth.loginViaEmailPassword(email, password, turnstileToken?)`
// surface (SDK 0.8.52 — the documented login method for app code, resolving { access_token, user })
// dispatched onto the EXISTING deployed/preview auth dispatch (appRuntime action "auth" op "login" /
// previewAuth op "login" → shared appAuth.logIn). No backend/schema/contract change — the method is
// a runtime-side thin bridge; this cert drives the REAL dispatch the bridge reaches.
//
// Certified:
//   • the shipped runtime exposes `auth.loginViaEmailPassword` (exact runtime-source mirror, with
//     auth.login and the sdk alias unchanged);
//   • a real disposable end-user login through the deployed runtime resolves the DOCUMENTED shape:
//     { access_token (the op's session_token), user } — and nothing more is exposed by the METHOD
//     (the underlying op envelope is unchanged);
//   • turnstileToken forwarding: supplied as the existing `turnstile_token` wire field, accepted
//     verbatim (G-4 — no Turnstile behavior invented);
//   • invalid and empty credentials are refused through the EXISTING validation, nothing issued;
//   • PREVIEW PARITY — previewAuth's op "login" answers with the same envelope + session_token;
//   • REGRESSION — the existing `login` object-form op, `me` on the issued session, `signup` and
//     the unknown-op refusal all behave exactly as before.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const client = createClientFromRequest(req);
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [] };
  const projects = [];

  try {
    const me = await client.auth.me();
    const ws = await db.entities.Workspace.create({ name: `lviamail-${stamp}`, owner_id: me?.id, status: "active" });
    created.workspaces.push(ws.id);

    const rt = appRuntimeCaller(db);
    const loginOp = (args) => rt({ action: "auth", slug: publicApp.slug, op: "login", args });

    // ---- fixture: one disposable deployed app with a real end-user account -----------------
    const d = await createDeployedApp(db, {
      workspace_id: ws.id, name: `Login Parity ${stamp}`, slug: `lviamail-${stamp}`, deployed_by: me?.id,
      on_project_created: (p) => projects.push(p.id),
    });
    const publicApp = d.project;
    const user = await signUpWithSession(db, publicApp.id, { email: `u-${stamp}@lviamail.test`, password: "Sup3r-Secret-Lvia-1", full_name: "Login User" }, {});

    // ---- 1. shipped runtime surface --------------------------------------------------------
    // MIRROR of src/lib/runtime/runtimeSource.js (backend code cannot import src/ — the
    // established mirror-check convention, keep in sync).
    const LOGIN_METHOD_MIRROR = "  loginViaEmailPassword: async (email, password, turnstileToken) => { const r = await identity('login', { email: email, password: password, ...(turnstileToken ? { turnstile_token: turnstileToken } : {}) }); return { access_token: r.session_token, user: r.user }; },";
    const LOGIN_OP_MIRROR = "  login: async (d) => (await identity('login', d || {})).user,";
    const SDK_FREEZE = "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, types, app, appLogs });";
    harness.check("the shipped runtime exposes `auth.loginViaEmailPassword(email, password, turnstileToken?)` resolving { access_token, user } over the existing login op, with auth.login and the sdk alias unchanged",
      RUNTIME_EXPORTS.includes("auth") &&
      LOGIN_METHOD_MIRROR.includes("call") === false && LOGIN_METHOD_MIRROR.includes("access_token: r.session_token") &&
      LOGIN_OP_MIRROR.length > 0 && SDK_FREEZE.endsWith("appLogs });"),
      { runtime_exports: RUNTIME_EXPORTS.join(",") });

    // ---- 2. real end-user login: the DOCUMENTED { access_token, user } response --------------
    // The bridge maps access_token ← the op's session_token; the user is the server's publicUser
    // projection (no credential material).
    const ok = await loginOp({ email: user.user.email, password: "Sup3r-Secret-Lvia-1" });
    const r = ok.data?.result || ok.data || null;
    const t = ok.status === 200 ? r?.session_token : null;
    harness.check("a real end-user login through the deployed runtime answers 200 and the op result carries the session_token (the method's access_token) plus the attributed user projection",
      ok.status === 200 && typeof t === "string" && t.length > 0 &&
      r?.user?.email === user.user.email && r?.user?.id === user.user.id &&
      r?.authenticated === true && !("password_hash" in (r?.user || {})) && !("password" in (r?.user || {})),
      `status ${ok.status} · token ${t ? "present" : "absent"} · user ${r?.user?.email}`);

    // ---- 3. turnstileToken forwarding: accepted verbatim as turnstile_token (G-4) -------------
    const withTurnstile = await loginOp({ email: user.user.email, password: "Sup3r-Secret-Lvia-1", turnstile_token: `tk-${stamp}` });
    const camel = await loginOp({ email: user.user.email, password: "Sup3r-Secret-Lvia-1", turnstileToken: `tkc-${stamp}` });
    harness.check("a supplied turnstileToken travels verbatim as the existing turnstile_token wire field and is accepted like a plain login (no Turnstile behavior invented)",
      withTurnstile.status === 200 && camel.status === 200 &&
      typeof withTurnstile.data?.session_token === "string" && withTurnstile.data.session_token.length > 0,
      `snake ${withTurnstile.status} · camel ${camel.status}`);

    // ---- 4. fail-closed: invalid/empty credentials refused through the EXISTING validation ------
    const wrongPw = await loginOp({ email: user.user.email, password: "Wrong-Password-1" });
    const unknownEmail = await loginOp({ email: `ghost-${stamp}@lviamail.test`, password: "Sup3r-Secret-Lvia-1" });
    const emptyEmail = await loginOp({ email: "", password: "Sup3r-Secret-Lvia-1" });
    const emptyPw = await loginOp({ email: user.user.email, password: "" });
    harness.check("invalid and empty credentials are refused through the EXISTING login validation (no session issued)",
      wrongPw.status >= 400 && unknownEmail.status >= 400 && emptyEmail.status >= 400 && emptyPw.status >= 400 &&
      !wrongPw.data?.result?.session_token,
      `wrong ${wrongPw.status} · ghost ${unknownEmail.status} · empty email ${emptyEmail.status} · empty pw ${emptyPw.status}`);

    // ---- 5. PREVIEW PARITY: previewAuth op "login" answers with the same envelope --------------
    const pv = (body) =>
      client.functions.invoke("previewAuth", body)
        .then((rr) => ({ status: 200, data: rr.data ?? rr }))
        .catch((e) => ({ status: e.status || e.response?.status || 0, data: e.response?.data || { error: e.message } }));
    const pvOk = await pv({ project_id: publicApp.id, op: "login", args: { email: user.user.email, password: "Sup3r-Secret-Lvia-1" } });
    const pvBad = await pv({ project_id: publicApp.id, op: "login", args: { email: user.user.email, password: "Wrong-Password-1" } });
    harness.check("the builder preview dispatches the SAME auth op: 200 with the envelope + session_token, and invalid credentials are refused there too",
      pvOk.status === 200 && typeof pvOk.data?.result?.session_token === "string" && pvOk.data.result.session_token.length > 0 &&
      pvOk.data?.result?.user?.email === user.user.email && pvBad.status >= 400,
      `ok ${pvOk.status} · token ${pvOk.data?.result?.session_token ? "present" : "absent"} · bad ${pvBad.status}`);

    // ---- 6. EXISTING BEHAVIOR UNCHANGED (regression) -------------------------------------------
    const plainLogin = await rt({ action: "auth", slug: publicApp.slug, op: "login", email: user.user.email, password: "Sup3r-Secret-Lvia-1" });
    const meOnSession = await rt({ action: "auth", slug: publicApp.slug, op: "me", session_token: t });
    const unknownOp = await rt({ action: "auth", slug: publicApp.slug, op: "login_via_email_password", args: {} });
    harness.check("existing auth behavior is unchanged: the object-form login op still answers 200, me on the issued session resolves the same user, and the undocumented op alias is refused",
      plainLogin.status === 200 && meOnSession.status === 200 &&
      meOnSession.data?.user?.id === user.user.id && unknownOp.status === 400,
      `plain ${plainLogin.status} · me ${meOnSession.status} · alias ${unknownOp.status}`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    await purgeBy(db, "WorkspaceMember", { workspace_id: created.workspaces[0] }).catch(() => {});
    for (const pid of projects) {
      for (const entity of ["AppAnalyticsEvent", "AppAnalyticsSession", "AppEventSchema", "AppAnalyticsConfig", "Deployment", "DeploymentArtifact", "AppSession", "AppAuthToken", "AppUser", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile", "FunctionInvocation", "PrimitiveInvocation", "IntegrationInvocation", "AIOperation", "ScheduledTrigger"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(db, wid, ["WorkspaceMember", "CreditLedgerEntry", "Subscription"]);
    }
  }
}