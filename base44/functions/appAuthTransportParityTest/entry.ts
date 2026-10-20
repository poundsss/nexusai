// G-4 transport-parity certification: the PROVEN optional auth wire fields travel from the
// client surface through the dispatch into the existing auth calls, and VANISH there —
// not validated, not transformed, not persisted, not logged, not exposed.
//
// DOCUMENTED (G-4 audit, PROVEN from @base44/sdk@0.8.51 source + docs.base44.com):
//   • loginViaEmailPassword(..., turnstileToken?) maps to the optional wire field
//     `turnstile_token` (sent only when truthy);
//   • register({ email, password, turnstile_token?, referral_code? }) posts the payload
//     VERBATIM — both optional fields ride unchanged;
//   • NO authoritative source proves any server-side semantics for either field
//     (validation, attribution, error behavior: UNKNOWN). This suite therefore certifies
//     TRANSPORT ONLY and asserts the fields change nothing and leak nowhere.
//
// The pass-through is exercised on the REAL shipping layers:
//   • the real auth layer (shared/appAuth.ts signUp/logIn) — called directly with the
//     optional fields present;
//   • the real preview dispatch (shared/previewAuth.ts handlePreviewAuth) — the same
//     one-line forwarding the deployed runtime dispatch (functions/appRuntime) carries;
//     preview has no email transport, so a code cannot be delivered there — the register →
//     verifyOtp transition itself is certified in appAuthOtpParityTest.
//
// Values are sentinel strings: their appearance in ANY persisted row, audit row or response
// is a failure. Their absence proves the fields neither persist nor leak anywhere.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handlePreviewAuth } from "../../shared/previewAuth.ts";
import { signUp, logIn, logOut, verifyOtp, resolveSessionRecord } from "../../shared/appAuth.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const PASSWORD = "Sup3r-Secret-Pass!";
const TS_TOKEN = "ts-transport-cert-0157f9d2";
const REF_CODE = "ref-transport-cert-9931";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let ws = null;
  try {
    const platformUser = await base44.auth.me();
    if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });
    ws = await svc.entities.Workspace.create({ name: "G-4 Transport Parity", owner_id: platformUser.id, credits_balance: 0 });
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "G4 App", slug: `g4-${crypto.randomUUID().slice(0, 8)}` });
    const captured = [];
    const mkMeta = (n) => ({ ip: `203.0.113.${n}`, user_agent: "g4-cert/1.0", onToken: (t) => { captured.push(t); } });
    const preview = (op, body = {}) => handlePreviewAuth(base44, platformUser, { project_id: project.id, op, ...body });
    const uid = crypto.randomUUID().slice(0, 8);
    const email1 = `g4a-${uid}@example.com`;   // register/login WITHOUT optional fields
    const email2 = `g4b-${uid}@example.com`;   // register/login WITH optional fields
    const email3 = `g4c-${uid}@example.com`;   // dispatch register WITH optional fields
    const codeFor = (userId) => { const list = captured.filter((c) => c.kind === "email_verification" && c.app_user_id === userId); return list.length ? list[list.length - 1].token : null; };

    // --- 1. register: optional fields change nothing ----------------------------------------
    const control = await signUp(svc, project.id, { email: email1, password: PASSWORD }, mkMeta(20));
    const withFields = await signUp(svc, project.id, { email: email2, password: PASSWORD, turnstile_token: TS_TOKEN, referral_code: REF_CODE }, mkMeta(21));
    const shape = (r) => ({ has_user: !!r.user.id, verified: r.user.email_verified === false, no_session: !("token" in r) && !("session" in r), sent: typeof r.verification_sent === "boolean" });
    const a = shape(control), b = shape(withFields);
    h.check("register_without_optional_fields_unchanged", a.has_user && a.verified && a.no_session, "G-2 contract intact for the control register");
    h.check("register_with_optional_fields_reaches_auth_layer", b.has_user && b.verified && b.no_session, "the auth layer accepted the register call carrying both optional fields");
    h.check("register_with_optional_fields_changes_nothing", JSON.stringify(a) === JSON.stringify(b), `identical contract shape with and without the fields (${Object.keys(b).join(",")})`);
    const row2 = await svc.entities.AppUser.get(withFields.user.id);
    h.check("register_optional_fields_not_persisted", !JSON.stringify(row2).includes(TS_TOKEN) && !JSON.stringify(row2).includes(REF_CODE), "neither value appears on the created user row");

    // --- 2. dispatch register: the wire fields cross the real dispatch ------------------------
    const dispatched = await preview("signup", { args: { email: email3, password: PASSWORD, full_name: "G4", turnstile_token: TS_TOKEN, referral_code: REF_CODE } });
    h.check("register_optional_fields_via_dispatch", !!dispatched.user.id && dispatched.user.email === email3 && dispatched.authenticated === false && !dispatched.session_token, "dispatch register with both fields succeeds with unchanged semantics");
    h.check("register_optional_fields_not_exposed_in_responses",
      !JSON.stringify(dispatched).includes(TS_TOKEN) && !JSON.stringify(dispatched).includes(REF_CODE) &&
      !JSON.stringify(withFields).includes(TS_TOKEN) && !JSON.stringify(withFields).includes(REF_CODE),
      "neither value appears in any register response");

    // --- 3. login: optional field changes nothing ---------------------------------------------
    const code1 = codeFor(control.user.id), code2 = codeFor(withFields.user.id);
    await verifyOtp(svc, project.id, { email: email1, otpCode: code1 }, mkMeta(22));
    await verifyOtp(svc, project.id, { email: email2, otpCode: code2 }, mkMeta(22));
    const loginControl = await logIn(svc, project.id, { email: email1, password: PASSWORD }, mkMeta(23));
    const loginWithToken = await logIn(svc, project.id, { email: email2, password: PASSWORD, turnstile_token: TS_TOKEN }, mkMeta(23));
    h.check("login_without_token_unchanged", !!loginControl.token && /^[a-f0-9]{64}$/.test(loginControl.token) && !!(await resolveSessionRecord(svc, project.id, loginControl.token)), "control login issues a resolvable session");
    h.check("login_with_turnstile_token_reaches_auth_layer", !!loginWithToken.token && /^[a-f0-9]{64}$/.test(loginWithToken.token), "the auth layer accepted the login call carrying the turnstile field");
    h.check("login_with_turnstile_token_changes_nothing",
      (await resolveSessionRecord(svc, project.id, loginWithToken.token))?.user.id === withFields.user.id &&
      Object.keys(loginControl).join(",") === Object.keys(loginWithToken).join(","),
      "identical login contract shape with and without the field");

    // --- 4. dispatch login: the wire field crosses the real dispatch --------------------------
    const dispatchedLogin = await preview("login", { args: { email: email2, password: PASSWORD, turnstile_token: TS_TOKEN } });
    h.check("login_with_turnstile_token_via_dispatch",
      !!dispatchedLogin.session_token && !!(await resolveSessionRecord(svc, project.id, dispatchedLogin.session_token)),
      "dispatch login with the turnstile field succeeds and the session resolves");
    h.check("login_optional_field_not_exposed_in_responses",
      !JSON.stringify(dispatchedLogin).includes(TS_TOKEN) && !JSON.stringify(loginWithToken).includes(TS_TOKEN),
      "the value appears in no login response");

    // --- 5. session semantics unchanged ---------------------------------------------------------
    await logOut(svc, project.id, loginWithToken.token, mkMeta(23));
    h.check("session_semantics_unchanged_with_optional_field",
      (await resolveSessionRecord(svc, project.id, loginWithToken.token)) === null &&
      !!(await resolveSessionRecord(svc, project.id, loginControl.token)),
      "logout revokes the session minted alongside a turnstile field and leaves others intact");

    // --- 6. nothing anywhere persists the values -------------------------------------------------
    let residue = [];
    for (const name of ["AppUser", "AppSession", "AppAuthToken", "AuditLog"]) {
      const rows = await svc.entities[name].filter({ project_id: project.id }, "-created_date", 500).catch(() => []);
      const wsRows = name === "AuditLog" ? await svc.entities.AuditLog.filter({ workspace_id: ws.id }, "-created_date", 500).catch(() => []) : [];
      for (const r of [...rows, ...wsRows]) {
        const dump = JSON.stringify(r);
        if (dump.includes(TS_TOKEN) || dump.includes(REF_CODE)) residue.push(`${name}:${r.id}`);
      }
    }
    h.check("optional_values_not_persisted_or_logged", residue.length === 0, residue.length ? `LEAKED in ${residue.join(", ")}` : "no row, session, token or audit entry carries either value");

    for (const name of ["AppUser", "AppSession", "AppAuthToken", "AuditLog"]) {
      for (const r of await svc.entities[name].filter({ project_id: project.id }, "-created_date", 500).catch(() => [])) {
        await svc.entities[name].delete(r.id).catch(() => {});
      }
    }
    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await cleanupWorkspace(svc, ws ? ws.id : null, ["Project", "AuditLog"]).catch(() => {});
  }
}