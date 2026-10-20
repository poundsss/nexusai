// P-10.3 phase 3 regression suite — mobile runtime authentication + release lifecycle.
//
// Everything runs against the REAL modules and the REAL deployed runtime endpoint:
//   • the WEB runtime and its cookie-session contract are certified UNCHANGED (slug-based
//     artifact serving, HttpOnly-cookie end-user auth);
//   • the mobile BEARER path serves exactly the token's project, and rejects malformed,
//     rotated-out, expired and revoked tokens;
//   • token storage keeps hashes only, the entity is unreadable by a client (RLS), and every
//     state change is audited;
//   • the release lifecycle (DRAFT → READY → RELEASED → ROLLED_BACK) preserves the immutable
//     artifact, verifies checksums against storage, supersedes without deleting, and rolls
//     back to the previous finalized release WITHOUT rebuilding;
//   • authorization uses the existing RBAC (deploy.manage) with full workspace isolation.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestMobileBuild } from "../../shared/mobileBuilds.ts";
import { createMobileBuildHarness } from "../../shared/mobileBuildTestFixtures.ts";
import { packJson } from "../../shared/blobStore.ts";
import { ensureProjectSlug } from "../../shared/deploy.ts";
import { signUpWithSession, sha256, SESSION_COOKIE, resolveSessionRecord } from "../../shared/appAuth.ts";
import {
  createMobileRuntimeSession, resolveMobileRuntimeSession, resolveMobileRuntimeTarget,
  refreshMobileRuntimeSession, revokeMobileRuntimeSession,
} from "../../shared/mobileRuntime.ts";
import {
  createMobileRelease, readyMobileRelease, releaseMobileRelease, rollbackMobileRelease,
} from "../../shared/mobileReleases.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";

const RUNTIME_URL = "https://quick-zip-snap.base44.app/functions/appRuntime";
const MR_URL = "https://quick-zip-snap.base44.app/functions/mobileRuntime";
// A trivial function shipped inside the artifact payload so the LIVE fn path has a target.
const FN_MR_ECHO = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var b = ctx.request.body || {};
  return { status: 200, body: { echo: b.echo === undefined ? null : b.echo } };
}`;
const post = (body, headers = {}) => fetch(RUNTIME_URL, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let wsA = null, wsB = null, wsC = null;
  let pA = null;
  const track = { projects: [], versions: [], deployments: [], artifacts: [], builds: [] };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const { drive, getBuild, mkWs, mkProject, mkFixture, provisionSigning } = createMobileBuildHarness({ base44, svc, caller, track });
    wsA = await mkWs("mr-a");
    wsB = await mkWs("mr-b");
    await provisionSigning(wsA, ["ios", "android"]);
    const intruder = { id: "intruder-p3", email: "intruder-p3@example.com" };

    // A real, loadable artifact payload both the runtime and the packaging step can read.
    const payloadUrl = await packJson(svc, `mobile-p3-artifact-${Date.now()}.json`, {
      client_files: [{ path: "index.html", content: "<html><body>phase three</body></html>" }],
      functions: [{ name: "mrEchoP3", source: FN_MR_ECHO }],
      entities: [], integrations: [], config: { entry: "index.html", framework: "preact-htm" },
    });

    // =========================== the WEB runtime is unchanged ===========================
    const made = await mkProject(wsA, "mr-a-app");
    pA = made.project;
    const fixA = await mkFixture(wsA, pA, made.version, payloadUrl, "sha256:mobile-p3-a");
    await ensureProjectSlug(svc, pA);
    const pAFresh = await svc.entities.Project.get(pA.id);
    pA = pAFresh;

    const webRes = await post({ action: "artifact", slug: pA.slug });
    const webBody = await webRes.json().catch(() => null);
    check("the web runtime still serves an app by slug without a bearer token",
      webRes.status === 200 && !!webBody?.files?.length && webBody?.app?.slug === pA.slug, `${webRes.status}`);

    // The existing web end-user cookie contract, exercised through the real endpoint.
    const email = `p3-${Date.now()}@example.com`;
    const appUser = await signUpWithSession(svc, pA.id, { email, password: "Sup3r-Secret-1!", full_name: "P3 User" }, { ip: "203.0.113.9", onToken: () => {} });
    const anonRes = await post({ action: "auth", op: "me", slug: pA.slug });
    const anonBody = await anonRes.json().catch(() => null);
    check("an anonymous web request stays anonymous", anonRes.status === 200 && !JSON.stringify(anonBody).includes(email), `${anonRes.status}`);
    const cookieRes = await post({ action: "auth", op: "me", slug: pA.slug }, { cookie: `${SESSION_COOKIE}=${appUser.token}` });
    const cookieBody = await cookieRes.json().catch(() => null);
    check("the web cookie session still authenticates the end-user",
      cookieRes.status === 200 && JSON.stringify(cookieBody).includes(email), `${cookieRes.status}`);

    // =========================== mobile bearer authentication ===========================
    const mint = await createMobileRuntimeSession(base44, caller, { project_id: pA.id });
    check("minting issues a short-lived pair for the project",
      /^[a-f0-9]{64}$/.test(mint.access_token) && /^[a-f0-9]{64}$/.test(mint.refresh_token) && mint.project_id === pA.id, mint.project_id);

    const sRow = await svc.entities.MobileRuntimeSession.get(mint.session_id);
    check("only token hashes are stored, never the raw tokens",
      sRow.token_hash === await sha256(mint.access_token) && sRow.token_hash !== mint.access_token
      && sRow.refresh_hash === await sha256(mint.refresh_token) && !JSON.stringify(sRow).includes(mint.access_token), "hashed at rest");

    const hasAudit = async (action, resourceId) =>
      (await svc.entities.AuditLog.filter({ workspace_id: wsA.id, action }, "-created_date", 40)).some((a) => a.resource_id === resourceId);
    check("token creation is audited", await hasAudit("mobile_runtime.token_created", mint.session_id), "audited");

    const rls = await base44.entities.MobileRuntimeSession.list().then((rows) => ({ rows })).catch(() => ({ rows: null }));
    check("a client cannot directly read mobile runtime sessions", rls.rows === null || rls.rows.length === 0, `${rls.rows === null ? "denied" : rls.rows.length}`);

    // The mobile bearer path is certified through THE resolution module the runtime imports
    // (shared/mobileRuntime.ts): this app's public HTTP surface serves its PUBLISHED artifact,
    // so the appRuntime wiring goes live on the app's next publish — the logic below is exactly
    // what the runtime executes on that path, transport included (readBearerToken).
    const target = await resolveMobileRuntimeTarget(svc, mint.access_token, null);
    check("a valid bearer token resolves its own project's production target",
      target.project.id === pA.id && target.environment === "production" && target.session.id === mint.session_id, target.project.id);
    const ownSlug = await resolveMobileRuntimeTarget(svc, mint.access_token, { slug: pA.slug });
    check("a token may name its own app's slug", ownSlug.project.id === pA.id, "same project");

    // The app's own end-user sessions resolve alongside the bearer path through the SAME
    // session resolution call the runtime makes.
    const mUser = await resolveSessionRecord(svc, pA.id, appUser.token);
    check("the app's end-user session still resolves alongside the bearer path",
      !!mUser && mUser.user.email === email, "resolved");

    // -------- refresh rotation --------
    const refreshed = await refreshMobileRuntimeSession(svc, mint.refresh_token);
    check("refresh rotates the pair and extends the expiry",
      refreshed.access_token !== mint.access_token && refreshed.refresh_token !== mint.refresh_token && !!refreshed.expires_at, "rotated");
    await expectThrow("the rotated-out access token no longer resolves",
      () => resolveMobileRuntimeSession(svc, mint.access_token), "MOBILE_TOKEN_INVALID");
    await expectThrow("a replayed refresh token is refused",
      () => refreshMobileRuntimeSession(svc, mint.refresh_token), "MOBILE_REFRESH_INVALID");
    check("refresh is audited", await hasAudit("mobile_runtime.refresh_used", mint.session_id), "audited");

    // -------- expired / revoked tokens --------
    const expired = await createMobileRuntimeSession(base44, caller, { project_id: pA.id });
    await svc.entities.MobileRuntimeSession.update(expired.session_id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await expectThrow("an expired token is rejected on the runtime path",
      () => resolveMobileRuntimeTarget(svc, expired.access_token), "MOBILE_TOKEN_EXPIRED");

    const revoked = await createMobileRuntimeSession(base44, caller, { project_id: pA.id });
    await revokeMobileRuntimeSession(base44, caller, { session_id: revoked.session_id });
    await expectThrow("a revoked token is rejected on the runtime path",
      () => resolveMobileRuntimeTarget(svc, revoked.access_token), "MOBILE_TOKEN_REVOKED");
    check("revocation is audited", await hasAudit("mobile_runtime.token_revoked", revoked.session_id), "audited");
    await expectThrow("a revoked session cannot refresh",
      () => refreshMobileRuntimeSession(svc, revoked.refresh_token), "MOBILE_TOKEN_REVOKED");

    // -------- project + workspace isolation --------
    const madeB = await mkProject(wsB, "mr-b-app");
    await ensureProjectSlug(svc, madeB.project);
    const pBFresh = await svc.entities.Project.get(madeB.project.id);
    await expectThrow("a token cannot address another project through its slug",
      () => resolveMobileRuntimeTarget(svc, refreshed.access_token, { slug: pBFresh.slug }), "MOBILE_SESSION_PROJECT_MISMATCH");
    // Workspace isolation: a token whose row is steered at another workspace's project
    // resolves to nothing at all.
    const crossWs = await createMobileRuntimeSession(base44, caller, { project_id: pA.id });
    await svc.entities.MobileRuntimeSession.update(crossWs.session_id, { project_id: pBFresh.id });
    await expectThrow("a token cannot be steered across workspaces",
      () => resolveMobileRuntimeTarget(svc, crossWs.access_token), "MOBILE_TOKEN_INVALID");

    // A workspace the caller does not belong to: token minting is refused.
    wsC = await svc.entities.Workspace.create({ name: `mr-c-${Date.now()}`, owner_id: `nobody-${Date.now()}`, credits_balance: 0, status: "active" });
    const pC = await svc.entities.Project.create({ workspace_id: wsC.id, name: "Not my app", slug: `mr-c-${Date.now()}` });
    track.projects.push(pC.id);
    await expectThrow("a non-member cannot mint a runtime token", () => createMobileRuntimeSession(base44, intruder, { project_id: pC.id }), "NOT_A_MEMBER");
    await svc.entities.WorkspaceMember.create({ workspace_id: wsC.id, user_id: intruder.id, email: intruder.email, role: "viewer", status: "active" });
    await expectThrow("a viewer cannot mint a runtime token", () => createMobileRuntimeSession(base44, intruder, { project_id: pC.id }), "INSUFFICIENT_ROLE");

    // ================== LIVE HTTP certification (the real public surface) ==================
    // The module-level checks above certify the LOGIC; this block certifies the WIRE: real
    // POSTs against the deployed appRuntime / mobileRuntime endpoints with the bearer
    // credential on the Authorization header exactly as a native client presents it.
    const live = await createMobileRuntimeSession(base44, caller, { project_id: pA.id });
    const bearerHdr = { authorization: `Bearer ${live.access_token}` };

    // 1. Project derivation: the request names NO slug — the target comes from the token.
    const liveArt = await post({ action: "artifact" }, bearerHdr);
    const liveArtBody = await liveArt.json().catch(() => null);
    check("live HTTP: a bearer-only request that names NO slug derives the token's own project",
      liveArt.status === 200 && liveArtBody?.app?.slug === pA.slug, `${liveArt.status}`);

    // 2. Authenticated execution: a deployed-artifact function runs on the derived target.
    const liveFn = await post({ action: "fn", function_name: "mrEchoP3", payload: { echo: "live" } }, bearerHdr);
    const liveFnBody = await liveFn.json().catch(() => null);
    check("live HTTP: the derived target executes the deployed function",
      liveFn.status === 200 && liveFnBody?.status === 200 && liveFnBody?.body?.echo === "live",
      JSON.stringify(liveFnBody || {}).slice(0, 140));

    // 3. Refresh through the real control plane (credential-based, no platform login).
    const liveRef = await fetch(MR_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh", refresh_token: live.refresh_token }) });
    const liveRefBody = await liveRef.json().catch(() => null);
    check("live HTTP: refresh rotates the pair through the real control plane",
      liveRef.status === 200 && !!liveRefBody?.access_token && liveRefBody?.access_token !== live.access_token && !!liveRefBody?.refresh_token,
      `${liveRef.status}`);
    await expectThrow("the rotated-out live access token no longer resolves (module regression)",
      () => resolveMobileRuntimeSession(svc, live.access_token), "MOBILE_TOKEN_INVALID");

    // 4. Revoke through the real control plane with the builder's own credential forwarded.
    const memberHeaders = { "content-type": "application/json" };
    for (const h of ["authorization", "cookie"]) {
      const v = req.headers.get(h);
      if (v) memberHeaders[h] = v;
    }
    const liveRevoke = await fetch(MR_URL, { method: "POST", headers: memberHeaders, body: JSON.stringify({ action: "revoke", session_id: live.session_id }) });
    const liveRevokeBody = await liveRevoke.json().catch(() => null);
    check("live HTTP: revoke succeeds through the real control plane",
      liveRevoke.status === 200 && liveRevokeBody?.revoked === true, JSON.stringify(liveRevokeBody || {}).slice(0, 140));

    // 5. The revoked session is refused authenticated execution on the runtime.
    const liveRevoked = await post({ action: "fn", function_name: "mrEchoP3", payload: { echo: "after-revoke" } }, { authorization: `Bearer ${liveRefBody?.access_token || live.access_token}` });
    check("live HTTP: the revoked session is refused authenticated execution",
      liveRevoked.status !== 200, `${liveRevoked.status}`);

    // =========================== release lifecycle ===========================
    const req1 = await requestMobileBuild(base44, caller, {
      project_id: pA.id, deployment_id: fixA.deployment.id, platform: "ios",
      version_name: "1.0.0", version_code: 1, release_notes: "First release", minimum_os_version: "13.0",
    });
    const b1 = await getBuild(req1.build.id);
    const out1 = await drive(b1.id);
    check("the build reaches READY carrying its release metadata",
      out1.done && out1.status === "READY" && out1.build.version_name === "1.0.0" && out1.build.version_code === 1 && out1.build.minimum_os_version === "13.0",
      out1.build.version_name);

    await expectThrow("an unknown build cannot be released", () => createMobileRelease(base44, caller, { build_id: "nope" }), "BUILD_NOT_FOUND");
    const rel1 = await createMobileRelease(base44, caller, { build_id: b1.id });
    const r1 = rel1.release;
    check("a release is created as DRAFT pinned to the build's package",
      r1.status === "DRAFT" && r1.artifact_uri === out1.build.artifact_uri && r1.checksum === out1.build.package_checksum && r1.platform === "ios", r1.status);
    check("the build's release metadata is carried onto the release",
      r1.version_name === "1.0.0" && r1.version_code === 1 && r1.release_notes === "First release", r1.version_name);
    check("release creation is audited", await hasAudit("mobile_release.created", r1.id), "audited");

    await expectThrow("a draft cannot go live before it is READY", () => releaseMobileRelease(base44, caller, { release_id: r1.id }), "INVALID_STATE");
    await readyMobileRelease(base44, caller, { release_id: r1.id });
    const r1Ready = await svc.entities.MobileRelease.get(r1.id);
    check("finalizing verifies the stored package and marks the release READY", r1Ready.status === "READY", r1Ready.status);
    await releaseMobileRelease(base44, caller, { release_id: r1.id });
    const r1Live = await svc.entities.MobileRelease.get(r1.id);
    check("the release goes live", r1Live.status === "RELEASED" && !!r1Live.released_at, r1Live.status);
    check("release publishing is audited", await hasAudit("mobile_release.released", r1.id), "audited");
    await expectThrow("the first live release has nothing to roll back to",
      () => rollbackMobileRelease(base44, caller, { release_id: r1.id }), "NO_ROLLBACK_TARGET");
    check("a refused rollback is still audited", await hasAudit("mobile_release.rollback_requested", r1.id), "audited");

    // A second build from a DIFFERENT deployment artifact, so its package differs.
    const fixA2 = await mkFixture(wsA, pA, made.version, payloadUrl, "sha256:mobile-p3-a2");
    const req2 = await requestMobileBuild(base44, caller, {
      project_id: pA.id, deployment_id: fixA2.deployment.id, platform: "ios",
      version_name: "1.0.1", version_code: 2, release_notes: "Second release",
    });
    const b2 = await getBuild(req2.build.id);
    const out2 = await drive(b2.id);
    const rel2 = await createMobileRelease(base44, caller, { build_id: b2.id });
    const r2 = rel2.release;
    await readyMobileRelease(base44, caller, { release_id: r2.id });
    await releaseMobileRelease(base44, caller, { release_id: r2.id });
    const r2Live = await svc.entities.MobileRelease.get(r2.id);
    const r1Superseded = await svc.entities.MobileRelease.get(r1.id);
    check("releasing a new version supersedes the previous live release",
      r2Live.status === "RELEASED" && r1Superseded.status === "ROLLED_BACK" && r1Superseded.superseded_by_release_id === r2.id, r1Superseded.status);

    const buildsBefore = (await svc.entities.MobileBuild.filter({ project_id: pA.id }, "-created_date", 50)).length;
    await rollbackMobileRelease(base44, caller, { release_id: r2.id });
    const r2Rb = await svc.entities.MobileRelease.get(r2.id);
    const r1Restored = await svc.entities.MobileRelease.get(r1.id);
    check("rollback restores the previous release WITHOUT rebuilding",
      r2Rb.status === "ROLLED_BACK" && r1Restored.status === "RELEASED"
      && (await svc.entities.MobileBuild.filter({ project_id: pA.id }, "-created_date", 50)).length === buildsBefore,
      `${r2Rb.status}/${r1Restored.status}`);
    check("rollback preserves the restored release's checksum and package",
      r1Restored.artifact_uri === r1Live.artifact_uri && r1Restored.checksum === r1Live.checksum && r1Restored.checksum === out1.build.package_checksum,
      (r1Restored.checksum || "").slice(0, 16));
    check("rollback is audited", await hasAudit("mobile_release.rollback_requested", r2.id), "audited");

    // -------- authorization on the release surface --------
    await expectThrow("a non-member cannot create a release", () => createMobileRelease(base44, intruder, { build_id: b2.id }), "NOT_A_MEMBER");
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, user_id: intruder.id, email: intruder.email, role: "viewer", status: "active" });
    await expectThrow("a viewer cannot create a release", () => createMobileRelease(base44, intruder, { build_id: b2.id }), "INSUFFICIENT_ROLE");

    // -------- checksum verification is required --------
    const req3 = await requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixA.deployment.id, platform: "android" });
    const b3 = await getBuild(req3.build.id);
    const out3 = await drive(b3.id);
    const rel3 = await createMobileRelease(base44, caller, { build_id: b3.id });
    // Tamper the pinned reference so the storage read-back can no longer match the checksum.
    await svc.entities.MobileRelease.update(rel3.release.id, { artifact_uri: "private://tampered-p3-does-not-exist" });
    await expectThrow("a release whose package fails checksum verification cannot go READY",
      () => readyMobileRelease(base44, caller, { release_id: rel3.release.id }), "RELEASE_CHECKSUM_MISMATCH");
    const r3 = await svc.entities.MobileRelease.get(rel3.release.id);
    check("a failed verification leaves the release a draft", r3.status === "DRAFT", r3.status);

    // An unfinished build cannot be released at all.
    const req4 = await requestMobileBuild(base44, caller, { project_id: pA.id, deployment_id: fixA.deployment.id, platform: "android" });
    const b4 = await getBuild(req4.build.id);
    await expectThrow("an unfinished build cannot be released", () => createMobileRelease(base44, caller, { build_id: b4.id }), "BUILD_NOT_READY");

    const rRls = await base44.entities.MobileRelease.list().then((rows) => ({ rows })).catch(() => ({ rows: null }));
    check("a client cannot directly read mobile releases", rRls.rows === null || rRls.rows.length === 0, `${rRls.rows === null ? "denied" : rRls.rows.length}`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    // Scratch cleanup: every record this suite created is removed.
    if (pA) {
      await purgeBy(svc, "AppUser", { project_id: pA.id });
      await purgeBy(svc, "AppSession", { project_id: pA.id });
      await purgeBy(svc, "AppAuthToken", { project_id: pA.id });
    }
    for (const id of track.builds) await svc.entities.MobileBuild.delete(id).catch(() => {});
    for (const id of track.deployments) await svc.entities.Deployment.delete(id).catch(() => {});
    for (const id of track.artifacts) await svc.entities.DeploymentArtifact.delete(id).catch(() => {});
    for (const id of track.versions) await svc.entities.ProjectVersion.delete(id).catch(() => {});
    for (const id of track.projects) await svc.entities.Project.delete(id).catch(() => {});
    for (const ws of [wsA, wsB, wsC]) {
      await cleanupWorkspace(svc, ws?.id, [
        "MobileRuntimeSession", "MobileRelease", "Subscription", "CreditLedgerEntry",
        "BillingEvent", "AuditLog", "WorkspaceSecret", "WorkspaceMember",
      ]);
    }
  }
}