// G-2 targeted certification: the PROVEN Base44 register/OTP state machine, on the REAL
// shipping modules (shared/appAuth.ts), in a throwaway workspace with two projects so
// cross-project isolation is exercised with actual data.
//
// DOCUMENTED (Base44 contract, PROVEN from @base44/sdk@0.8.51 JSDoc/source, the official
// Auth SDK docs, the platform-shipped Register.jsx boilerplate and the platform operating
// contract):
//   • register → unverified user + NO authenticated session; an OTP challenge is issued;
//   • "Users cannot log in until they complete OTP verification";
//   • verifyOtp({ email, otpCode }) → verification + "an access token for the now-verified
//     user" — the transition that ESTABLISHES the authenticated session;
//   • resendOtp(email) → pre-auth, email-keyed.
//
// NEXUSAI-derived bounded choices certified alongside (upstream publishes no server detail):
//   • EMAIL_NOT_VERIFIED (403) for login before verification;
//   • email-hash keys for the pre-verification durable limits;
//   • a non-enumerable resend answer ({ ok: true } for unknown emails);
//   • a strict email/token binding, pre-checked WITHOUT consuming, so a mistyped email
//     cannot burn a valid code.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  signUp, logIn, logOut, verifyOtp, resendOtp, resolveSessionRecord, findUserByEmail,
} from "../../shared/appAuth.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const PASSWORD = "Sup3r-Secret-Pass!";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const h = createHarness();
  let ws = null;
  try {
    ws = await svc.entities.Workspace.create({ name: "G-2 OTP Parity", owner_id: `g2-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "G2 App", slug: `g2-${crypto.randomUUID().slice(0, 8)}` });
    const other = await svc.entities.Project.create({ workspace_id: ws.id, name: "G2 Other", slug: `g2o-${crypto.randomUUID().slice(0, 8)}` });
    const captured = [];
    // Distinct ips keep the per-ip signup limiter out of the way; the delivery hook captures
    // the raw OTP codes exactly like appAuthTest's certification-only capture.
    const mkMeta = (n) => ({ ip: `203.0.113.${n}`, user_agent: "g2-cert/1.0", onToken: (t) => { captured.push(t); } });
    const codeFor = (userId) => { const list = captured.filter((c) => c.kind === "email_verification" && c.app_user_id === userId); return list.length ? list[list.length - 1].token : null; };
    const email = `g2-${crypto.randomUUID().slice(0, 8)}@example.com`;

    // --- 1. register: user created, unverified, NO session -----------------------------------
    const reg = await signUp(svc, project.id, { email, password: PASSWORD }, mkMeta(10));
    h.check("1_register_creates_unverified_user", !!reg.user.id && reg.user.email === email && reg.user.email_verified === false, `user=${reg.user.id}`);
    h.check("1_register_mints_no_session", !("token" in reg) && !("session" in reg) && (await svc.entities.AppSession.filter({ project_id: project.id, app_user_id: reg.user.id }, "-created_date", 5)).length === 0, "no token in the answer, no session row in storage");
    const challenges = await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "email_verification", status: "pending" }, "-created_date", 5);
    h.check("1_register_issues_otp_challenge", captured.length === 1 && challenges.length >= 1 && challenges.every((c) => c.token_hash !== captured[0].token), "the challenge rides the existing hashed single-use-token mechanism");
    h.check("1_register_never_returns_the_code", !("otpCode" in reg) && !("token" in reg), "the raw code went to the delivery hook only");

    // --- 2. login before verification is rejected --------------------------------------------
    await h.expectThrow("2_login_before_verification_rejected", () => logIn(svc, project.id, { email, password: PASSWORD }, mkMeta(10)), "EMAIL_NOT_VERIFIED");

    // --- 3. verifyOtp verifies the user and establishes the session ----------------------------
    const code = codeFor(reg.user.id);
    const verified = await verifyOtp(svc, project.id, { email, otpCode: code }, mkMeta(11));
    h.check("3_verify_otp_returns_access_token", verified.ok === true && /^[a-f0-9]{64}$/.test(verified.access_token), `access_token len=${verified.access_token.length}`);
    h.check("3_verify_otp_marks_user_verified", verified.user.email_verified === true && (await svc.entities.AppUser.get(reg.user.id)).email_verified === true, "verified in the answer and in storage");
    const otpResolved = await resolveSessionRecord(svc, project.id, verified.access_token);
    h.check("3_verify_otp_establishes_session", !!otpResolved && otpResolved.user.id === reg.user.id, "the access token resolves as the live authenticated session");
    const postVerify = await logIn(svc, project.id, { email, password: PASSWORD }, mkMeta(11));
    h.check("3_login_works_after_verification", !!postVerify.token && postVerify.user.id === reg.user.id, "the documented post-verification login");

    // --- 4. resendOtp works pre-auth, keyed by email --------------------------------------------
    const email2 = `g2b-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const reg2 = await signUp(svc, project.id, { email: email2, password: PASSWORD }, mkMeta(12));
    const ack = await resendOtp(svc, project.id, { email: email2 }, mkMeta(12));
    h.check("4_resend_otp_pre_auth", ack.ok === true, "no session is required or implied");
    const pending2 = (await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "email_verification", status: "pending" }, "-created_date", 10)).filter((t) => t.app_user_id === reg2.user.id);
    h.check("4_resend_otp_reissues_challenge", pending2.length === 1, `exactly one pending challenge after the resend (${pending2.length})`);
    const ghost = await resendOtp(svc, project.id, { email: `ghost-${crypto.randomUUID().slice(0, 6)}@example.com` }, mkMeta(12));
    h.check("4_resend_otp_non_enumerable", ghost.ok === true, "an unknown email gets the same answer");
    const verifiedAck = await resendOtp(svc, project.id, { email }, mkMeta(12));
    const noChallengeForVerified = !(await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "email_verification", status: "pending" }, "-created_date", 20)).some((t) => t.app_user_id === reg.user.id);
    h.check("4_resend_otp_noop_when_verified", verifiedAck.ok === true && noChallengeForVerified, "no challenge is issued for an already-verified user");

    // --- 5. invalid cases stay fail-closed ------------------------------------------------------
    const code2 = codeFor(reg2.user.id);
    await h.expectThrow("5_verify_wrong_email_refused", () => verifyOtp(svc, project.id, { email, otpCode: code2 }, mkMeta(13)), "TOKEN_INVALID");
    await h.expectThrow("5_verify_malformed_code_refused", () => verifyOtp(svc, project.id, { email: email2, otpCode: "not-a-code" }, mkMeta(13)), "TOKEN_INVALID");
    const done2 = await verifyOtp(svc, project.id, { email: email2, otpCode: code2 }, mkMeta(13));
    h.check("5_verify_wrong_email_does_not_burn_code", !!done2.access_token, "the code survived the mismatched-email attempt and still verifies");
    await h.expectThrow("5_verify_otp_single_use", () => verifyOtp(svc, project.id, { email: email2, otpCode: code2 }, mkMeta(13)), "TOKEN_USED");
    const email3 = `g2c-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const reg3 = await signUp(svc, project.id, { email: email3, password: PASSWORD }, mkMeta(14));
    const code3 = codeFor(reg3.user.id);
    const tokRow = (await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "email_verification", status: "pending" }, "-created_date", 20)).find((t) => t.app_user_id === reg3.user.id);
    await svc.entities.AppAuthToken.update(tokRow.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await h.expectThrow("5_verify_expired_refused", () => verifyOtp(svc, project.id, { email: email3, otpCode: code3 }, mkMeta(14)), "TOKEN_EXPIRED");
    await h.expectThrow("5_resend_invalid_email_refused", () => resendOtp(svc, project.id, { email: "not-an-email" }, mkMeta(14)), "EMAIL_INVALID");
    await h.expectThrow("5_verify_invalid_email_refused", () => verifyOtp(svc, project.id, { email: "not-an-email", otpCode: code3 }, mkMeta(14)), "EMAIL_INVALID");
    h.check("5_email_still_unique_per_project", !!(await findUserByEmail(svc, project, email)), "the lookup path is untouched");

    // --- 6. existing verified-user login/logout still work ----------------------------------------
    const session = await logIn(svc, project.id, { email, password: PASSWORD }, mkMeta(15));
    h.check("6_verified_login_works", !!session.token && session.user.email_verified === true, "a verified user signs in");
    await logOut(svc, project.id, session.token, mkMeta(15));
    h.check("6_logout_revokes_session", (await resolveSessionRecord(svc, project.id, session.token)) === null, "logout ends the session");
    const again = await logIn(svc, project.id, { email, password: PASSWORD }, mkMeta(15));
    h.check("6_relogin_works", !!again.token, "the user can sign in again after logout");

    // --- 7. project isolation ------------------------------------------------------------------------
    const emailB = `g2x-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const regB = await signUp(svc, other.id, { email: emailB, password: PASSWORD }, mkMeta(16));
    const codeB = codeFor(regB.user.id);
    await h.expectThrow("7_cross_project_code_refused", () => verifyOtp(svc, project.id, { email: emailB, otpCode: codeB }, mkMeta(16)), "TOKEN_INVALID");
    const verifiedB = await verifyOtp(svc, other.id, { email: emailB, otpCode: codeB }, mkMeta(16));
    h.check("7_code_works_in_own_project", !!verifiedB.access_token, "the same flow completes in the issuing project");
    h.check("7_session_never_crosses_projects", (await resolveSessionRecord(svc, project.id, verifiedB.access_token)) === null, "one project's session resolves to nothing in another");
    const dup = await signUp(svc, project.id, { email: emailB, password: PASSWORD }, mkMeta(16));
    h.check("7_same_email_independent_per_project", !!dup.user.id && dup.user.id !== regB.user.id, "identities do not collide across projects");

    for (const name of ["AppUser", "AppSession", "AppAuthToken", "AuditLog"]) {
      for (const p of [project.id, other.id]) {
        for (const r of await svc.entities[name].filter({ project_id: p }, "-created_date", 500).catch(() => [])) {
          await svc.entities[name].delete(r.id).catch(() => {});
        }
      }
    }
    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await cleanupWorkspace(svc, ws ? ws.id : null, ["Project", "AuditLog"]).catch(() => {});
  }
}