// Generated-app END-USER auth inside the BUILDER PREVIEW (#29).
//
// The preview runs the same generated code the deployed app runs, so `auth.*` there must mean the
// same thing: a GENERATED-APP user of the previewed project. This module is the preview's auth
// surface, and it is deliberately thin — it owns no user model, no session model, no password
// handling and no permission model. Every one of those belongs to shared/appAuth.ts and
// shared/appAccess.ts, and this module only calls them.
//
// The two identity layers stay separate, in both directions:
//   • The NexusAI PLATFORM user is used ONLY to authorize the preview itself, through the
//     EXISTING authz path (`project.read` on the project's workspace). It is never returned to the
//     generated app, never written into AppUser, and a preview sign-out never touches it.
//   • The GENERATED-APP user is a project-scoped AppUser with its own AppSession. It grants
//     nothing on the builder, the workspace or the platform, and a session minted for one project
//     resolves to nothing in another.
import { loadAuthorizedProject } from "./authz.ts";
import {
  signUp, logIn, logOut, verifyOtp, resendOtp, resolveSessionRecord, publicUser, publicSession, fail,
  inviteAppUser, updateProfile, changePassword, requestPasswordReset, confirmPasswordReset,
} from "./appAuth.ts";
import { resolvePermissions, can } from "./appAccess.ts";
import { identityEnvelope } from "./appAuthContext.ts";
import { validatePostLoginUrl } from "./appOAuth.ts";

export const PREVIEW_AUTH_OPS = [
  "me", "signup", "login", "logout", "can", "verify_otp", "resend_otp", "invite_user",
  // Account-management parity cluster: the SAME four ops the deployed runtime dispatches, so
  // preview and production expose an identical auth surface.
  "update_profile", "change_password", "request_password_reset", "confirm_password_reset",
  // auth.redirectToLogin(nextUrl) parity: the SAME destination resolution/validation the deployed
  // runtime dispatches (the EXISTING fail-closed validator against the preview endpoint's own
  // origin). Pure resolution — the HOST page owns the navigation, like the logout redirect_url.
  "redirect_login",
];

/** The envelope for an already-resolved preview session. Permissions come from the existing resolver. */
async function envelopeFor(svc, project, row, session) {
  const { roles, permissions } = await resolvePermissions(svc, project, row);
  return identityEnvelope({ user: publicUser(row), session: session ? publicSession(session) : null, roles, permissions });
}

/**
 * Handles ONE preview auth operation.
 *
 * `platformUser` is the signed-in builder — used only for authorization. The generated-app session
 * token travels in `session_token`; it is re-resolved server-side on every call, so the browser
 * cannot assert who the end-user is.
 */
export async function handlePreviewAuth(base44, platformUser, body = {}, ctx = {}) {
  if (!platformUser?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const op = String(body.op || "me");
  if (!PREVIEW_AUTH_OPS.includes(op)) fail(400, "AUTH_OP_UNSUPPORTED", `Unsupported auth operation ${op}`);
  // The builder's own authorization, through the EXISTING path. A project the caller cannot read is
  // refused here — before any app user, session or credential is touched.
  const { project } = await loadAuthorizedProject(base44, platformUser, String(body.project_id || ""), "project.read");
  const svc = base44.asServiceRole || base44;
  const args = body.args || {};
  const token = typeof body.session_token === "string" ? body.session_token : null;
  const meta = { user_agent: "nexusai-builder-preview" };

  if (op === "signup") {
    // G-2: register leaves the user UNVERIFIED with no session — the envelope states
    // unauthenticated and the generated app proceeds to its OTP screen. The preview has no
    // email transport, so a code cannot be DELIVERED here; the deployed runtime delivers
    // through the project's own transport, and the ops below exist so the same generated
    // code runs unmodified in both surfaces.
    // G-4 transport parity: register's optional wire fields travel VERBATIM into the auth call
    // — accepted, never validated/persisted/logged (server semantics UNKNOWN, G-4 audit).
    const r = await signUp(svc, project, { email: args.email, password: args.password, full_name: args.full_name || args.display_name, turnstile_token: args.turnstile_token ?? args.turnstileToken, referral_code: args.referral_code ?? args.referralCode }, meta);
    return { ...identityEnvelope({}), user: r.user, verification_sent: r.verification_sent };
  }
  if (op === "verify_otp") {
    const r = await verifyOtp(svc, project, { email: args.email, otpCode: args.otpCode }, meta);
    const row = await svc.entities.AppUser.get(r.user.id);
    return { ...(await envelopeFor(svc, project, row, r.session)), session_token: r.access_token };
  }
  if (op === "resend_otp") {
    return await resendOtp(svc, project, { email: args.email }, meta);
  }
  if (op === "invite_user") {
    // G-5: the documented app-user invitation, on the SAME shared primitive the deployed runtime
    // dispatches to. The caller must hold a live generated-app session; the role rule is enforced
    // inside the primitive through the EXISTING app permission model. Preview has no email
    // transport, so the single-use invitation token is issued but not DELIVERED here — exactly
    // like signup's OTP challenge. PROVEN (Base44 runtime probe): the successful response is
    // HTTP 200 with the EXACT body { "id": "<app_id>" }; the primitive's { ok, user,
    // invitation_sent } answer stays the internal projection, never the public body.
    const resolved = token ? await resolveSessionRecord(svc, project, token).catch(() => null) : null;
    if (!resolved) fail(401, "AUTH_REQUIRED", "Sign in required");
    const env = await envelopeFor(svc, project, resolved.user, resolved.session);
    await inviteAppUser(svc, project, { id: resolved.user.id, roles: env.roles }, { user_email: args.user_email, role: args.role }, meta);
    return { id: project.id };
  }
  if (op === "update_profile") {
    // Account-management parity: the SAME allowlisted primitive the deployed runtime dispatches
    // to, with the deployed response shape { user }. The session is required and re-resolved
    // server-side; roles, status, email and every credential field stay unreachable through this
    // op — the upstream updateMe field set is NOT adopted blindly (the NexusAI allowlist is
    // NEXUSAI-DERIVED; role mutation stays unavailable pending proven editor-access evidence).
    const resolved = token ? await resolveSessionRecord(svc, project, token).catch(() => null) : null;
    if (!resolved) fail(401, "AUTH_REQUIRED", "Sign in required");
    return { user: await updateProfile(svc, project, publicUser(resolved.user), args, meta) };
  }
  if (op === "change_password") {
    // The EXISTING primitive, unchanged: current-password verification, other-session revocation
    // and the initiating session kept. No caller-supplied user id is forwarded — identity is the
    // session's own user (upstream user_id semantics UNKNOWN).
    const resolved = token ? await resolveSessionRecord(svc, project, token).catch(() => null) : null;
    if (!resolved) fail(401, "AUTH_REQUIRED", "Sign in required");
    return await changePassword(svc, project, { user: publicUser(resolved.user), session: publicSession(resolved.session) }, { current_password: args.current_password, new_password: args.new_password }, meta);
  }
  if (op === "request_password_reset") {
    // Pre-auth and email-keyed, always { ok: true } (anti-enumeration) — the EXISTING primitive.
    // Preview has no email transport, so the single-use secret is issued but not DELIVERED here,
    // exactly like signup's OTP challenge.
    return await requestPasswordReset(svc, project, { email: args.email }, meta);
  }
  if (op === "confirm_password_reset") {
    // The EXISTING primitive, unchanged: single-use hashed-token consumption + full session revocation.
    return await confirmPasswordReset(svc, project, { token: args.token, new_password: args.new_password }, meta);
  }
  if (op === "redirect_login") {
    // auth.redirectToLogin(nextUrl) parity: the EXISTING fail-closed validator (the same one the
    // logout redirect_url uses) against the preview endpoint's own origin. Pure destination
    // resolution — no session, user or token semantics; a cross-origin/external destination is
    // REFUSED (thrown), exactly like the deployed dispatch.
    return { from_url: validatePostLoginUrl(args.next_url ?? null, ctx.origin || null) };
  }
  if (op === "login") {
    // G-4 transport parity: the optional turnstile wire field travels VERBATIM into the auth
    // call — accepted, never validated/persisted/logged (server semantics UNKNOWN, G-4 audit).
    const r = await logIn(svc, project, { email: args.email, password: args.password, turnstile_token: args.turnstile_token ?? args.turnstileToken }, meta);
    const row = await svc.entities.AppUser.get(r.user.id);
    return { ...(await envelopeFor(svc, project, row, r.session)), session_token: r.token };
  }
  if (op === "logout") {
    // Ends the GENERATED-APP session only. The builder's platform session is untouched.
    // SDK logout(redirectUrl) parity (SDK 0.8.52): the optional post-logout destination travels
    // as redirect_url and is validated with the SAME fail-closed validator the OAuth from_url
    // uses — relative path, or a same-origin absolute URL against the app's serving origin (the
    // preview has none, so absolute destinations are refused here exactly as they would be for
    // an origin-less serving context). The session is ALWAYS cleared first — a refused
    // destination never blocks the logout — and the HOST page (the only layer that can navigate
    // top-level) performs the redirect when one validates. Omitted → unchanged behavior.
    await logOut(svc, project, token, meta);
    let redirect_url = null;
    try { redirect_url = validatePostLoginUrl(args.redirect_url, null); } catch { redirect_url = null; }
    return { ok: true, ...(redirect_url ? { redirect_url } : {}), ...identityEnvelope({}) };
  }

  const resolved = token ? await resolveSessionRecord(svc, project, token).catch(() => null) : null;
  if (op === "can") {
    if (!resolved) return { allowed: false, ...identityEnvelope({}) };
    const env = await envelopeFor(svc, project, resolved.user, resolved.session);
    return { allowed: can(env.permissions, String(args.permission || "")), ...env };
  }
  return resolved ? envelopeFor(svc, project, resolved.user, resolved.session) : identityEnvelope({});
}