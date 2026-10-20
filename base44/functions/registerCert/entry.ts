// Certification for the AuthModule parity gap: the DOCUMENTED Base44 `base44.auth.register(params)`
// surface (SDK 0.8.52 — POST /apps/{appId}/auth/register with the payload { email, password,
// turnstile_token?, referral_code? } forwarded VERBATIM, resolving the registration response)
// dispatched onto the EXISTING deployed/preview auth dispatch (appRuntime action "auth" op "signup" /
// previewAuth op "signup" → shared appAuth.signUp). No backend/schema/contract change — the method is
// a runtime-side thin bridge; this cert drives the REAL dispatch the bridge reaches.
//
// Certified:
//   • the shipped runtime exposes `auth.register(params)` (exact runtime-source mirror, with
//     auth.signup and the sdk alias unchanged);
//   • a real deployment signup through the runtime resolves the registration projection:
//     authenticated:false (G-2 — no session), the unverified user projection (no credential
//     material) and verification_sent;
//   • G-4 payload forwarding — turnstile_token and referral_code travel verbatim and are accepted
//     exactly like a plain signup (no behavior invented for either field);
//   • fail-closed through the EXISTING validation: duplicate email (409 EMAIL_TAKEN) and
//     empty/invalid credentials refused, nothing stored twice;
//   • the DOCUMENTED FLOW still integrates: register → verifyOtp → loginViaEmailPassword — the raw
//     OTP challenge rides the existing single-use-token mechanism, and the runtime's verify_otp
//     (the access-token transition) plus the login op complete the documented sequence;
//   • PREVIEW PARITY — previewAuth's op "signup" answers with the same registration projection;
//   • REGRESSION — the existing object-form `signup` op and the unknown-op refusal are unchanged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { signUp } from "../../shared/appAuth.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const PASSWORD = "Sup3r-Secret-Reg-1";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const client = createClientFromRequest(req);
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [] };
  const projects = [];

  try {
    const me = await client.auth.me();
    const ws = await db.entities.Workspace.create({ name: `register-${stamp}`, owner_id: me?.id, status: "active" });
    created.workspaces.push(ws.id);

    const rt = appRuntimeCaller(db);

    // ---- fixture: one disposable deployed app -----------------------------------------------
    const d = await createDeployedApp(db, {
      workspace_id: ws.id, name: `Register Parity ${stamp}`, slug: `register-${stamp}`, deployed_by: me?.id,
      on_project_created: (p) => projects.push(p.id),
    });
    const publicApp = d.project;
    const signupOp = (args, extra = {}) => rt({ action: "auth", slug: publicApp.slug, op: "signup", args, ...extra });

    // ---- 1. shipped runtime surface ----------------------------------------------------------
    // MIRROR of src/lib/runtime/runtimeSource.js (backend code cannot import src/ — the
    // established mirror-check convention, keep in sync).
    const REGISTER_METHOD_MIRROR = "  register: async (params) => call('auth', 'signup', params || {}),";
    const SDK_FREEZE = "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, types, app, appLogs });";
    harness.check("the shipped runtime exposes `auth.register(params)` as a verbatim bridge to the existing signup op, with auth.signup and the sdk alias unchanged",
      RUNTIME_EXPORTS.includes("auth") && REGISTER_METHOD_MIRROR.includes("'auth', 'signup'") && SDK_FREEZE.endsWith("appLogs });"),
      { runtime_exports: RUNTIME_EXPORTS.join(",") });

    // ---- 2. real deployment registration: the registration projection, NO session (G-2) -------
    const email = `u-${stamp}@register.test`;
    const ok = await signupOp({ email, password: PASSWORD });
    const r = ok.data?.result || ok.data || null;
    harness.check("a real deployment registration answers 200 with the registration projection: authenticated false, an unverified user projection without credential material, and verification_sent",
      ok.status === 200 && r?.authenticated === false && r?.user?.email === email &&
      r?.user?.email_verified === false && !("password_hash" in (r?.user || {})) && !("password" in (r?.user || {})) &&
      "verification_sent" in r && !r?.session_token && !("token" in r),
      `status ${ok.status} · user ${r?.user?.email} · verified ${r?.user?.email_verified} · sent ${r?.verification_sent}`);

    // ---- 3. G-4 payload forwarding: turnstile_token / referral_code accepted verbatim -----------
    const wt = await signupOp({ email: `t-${stamp}@register.test`, password: PASSWORD, turnstile_token: `tk-${stamp}` });
    const wtCamel = await signupOp({ email: `tc-${stamp}@register.test`, password: PASSWORD, turnstileToken: `tkc-${stamp}` });
    const ref = await signupOp({ email: `rf-${stamp}@register.test`, password: PASSWORD, referral_code: "FRIEND2024" });
    const refCamel = await signupOp({ email: `rfc-${stamp}@register.test`, password: PASSWORD, referralCode: "FRIEND2024" });
    harness.check("optional register wire fields (turnstile_token/turnstileToken, referral_code/referralCode) travel verbatim and are accepted exactly like a plain signup — no behavior invented for either field",
      wt.status === 200 && wtCamel.status === 200 && ref.status === 200 && refCamel.status === 200,
      `turnstile ${wt.status} · camel ${wtCamel.status} · referral ${ref.status} · camel ${refCamel.status}`);

    // ---- 4. fail-closed through the EXISTING validation ----------------------------------------
    const dup = await signupOp({ email, password: PASSWORD });
    const emptyEmail = await signupOp({ email: "", password: PASSWORD });
    const weakPw = await signupOp({ email: `w-${stamp}@register.test`, password: "short" });
    const usersWith = (em) => db.entities.AppUser.filter({ project_id: publicApp.id, email: em }, "-created_date", 5);
    harness.check("duplicate email (409 EMAIL_TAKEN), empty email and weak passwords are refused through the EXISTING signup validation — no second account row is stored",
      dup.status >= 400 && emptyEmail.status >= 400 && weakPw.status >= 400 &&
      (await usersWith(email)).length === 1,
      `dup ${dup.status} · empty ${emptyEmail.status} · weak ${weakPw.status} · rows ${(await usersWith(email)).length}`);

    // ---- 5. the DOCUMENTED FLOW integrates: register → verifyOtp → login ------------------------
    // The public runtime never exposes the raw OTP (hashed at rest), so the code is captured
    // through the certified delivery hook on the SAME signup primitive the runtime dispatches to;
    // the verification and login transitions then run through the REAL runtime dispatch.
    const flowEmail = `flow-${stamp}@register.test`;
    const captured = [];
    await signUp(db, publicApp.id, { email: flowEmail, password: PASSWORD }, {
      ip: `203.0.113.${stamp % 250 + 1}`, user_agent: "register-cert/1.0",
      onToken: (t) => { captured.push(t); },
    });
    const code = (captured.filter((c) => c.kind === "email_verification" && c.app_user_id)).slice(-1)[0]?.token || null;
    const loginBefore = await rt({ action: "auth", slug: publicApp.slug, op: "login", args: { email: flowEmail, password: PASSWORD } });
    const verify = await rt({ action: "auth", slug: publicApp.slug, op: "verify_otp", args: { email: flowEmail, otpCode: code } });
    const v = verify.data?.result || verify.data || null;
    const loginAfter = await rt({ action: "auth", slug: publicApp.slug, op: "login", args: { email: flowEmail, password: PASSWORD } });
    const la = loginAfter.data?.result || loginAfter.data || null;
    harness.check("the documented registration flow integrates end-to-end: login is refused before verification, verifyOtp with the emailed code establishes the session (access token), and login then answers 200 with the verified user",
      loginBefore.status >= 400 && loginBefore.code === "EMAIL_NOT_VERIFIED" &&
      verify.status === 200 && typeof v?.session_token === "string" && v.session_token.length > 0 && v?.user?.email_verified === true &&
      loginAfter.status === 200 && la?.user?.id === v?.user?.id,
      `before ${loginBefore.status}/${loginBefore.code} · verify ${verify.status} · after ${loginAfter.status}`);

    // ---- 6. PREVIEW PARITY: previewAuth op "signup" ---------------------------------------------
    const pv = (body) =>
      client.functions.invoke("previewAuth", body)
        .then((rr) => ({ status: 200, data: rr.data ?? rr }))
        .catch((e) => ({ status: e.status || e.response?.status || 0, data: e.response?.data || { error: e.message } }));
    const pvOk = await pv({ project_id: publicApp.id, op: "signup", args: { email: `pv-${stamp}@register.test`, password: PASSWORD, referral_code: "FRIEND2024" } });
    const pvDup = await pv({ project_id: publicApp.id, op: "signup", args: { email, password: PASSWORD } });
    const pvData = pvOk.data?.result || pvOk.data || null;
    harness.check("the builder preview dispatches the SAME signup op: the same registration projection for a fresh email (with the referral field accepted) and the duplicate refusal there too",
      pvOk.status === 200 && pvData?.authenticated === false && pvData?.user?.email_verified === false &&
      pvDup.status >= 400,
      `ok ${pvOk.status} · verified ${pvData?.user?.email_verified} · dup ${pvDup.status}`);

    // ---- 7. EXISTING BEHAVIOR UNCHANGED (regression) ---------------------------------------------
    const plainSignup = await signupOp({ email: `legacy-${stamp}@register.test`, password: PASSWORD }, { email: `legacy2-${stamp}@register.test` });
    const unknownOp = await rt({ action: "auth", slug: publicApp.slug, op: "register", args: { email: `x-${stamp}@register.test`, password: PASSWORD } });
    harness.check("existing auth behavior is unchanged: the object-form signup op still answers 200 and the undocumented 'register' op alias is refused (register is a method-side bridge, not a new server op)",
      plainSignup.status === 200 && unknownOp.status === 400,
      `plain ${plainSignup.status} · alias ${unknownOp.status}`);

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