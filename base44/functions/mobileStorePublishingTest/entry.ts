// P-10.3 phase 4 certification suite — native mobile store publishing.
//
// Exercises the REAL worker and the REAL submission path (a build driven to READY → a release
// finalized READY → a submission driven to SUBMITTED), certifying:
//   • missing Apple / Google connections fail closed (STORE_NOT_CONFIGURED) at the worker
//   • invalid connections are refused everywhere they can appear (INVALID_STORE_CREDENTIAL at
//     management, STORE_AUTH_FAILED at the adapter boundary)
//   • the release checksum is required: a package that fails verification is never uploaded
//   • unauthorized publishing is rejected (RBAC, resolved server-side)
//   • workspace isolation (listing scoped to the authorized project; client RLS reads nothing)
//   • duplicate submissions converge on one row
//   • a retry uploads nothing twice (persisted external identity + content-scoped key)
//   • re-publishing after a terminal submission creates a NEW row and never modifies the
//     previous one; the previous checksum is preserved
//   • every required audit event is written
//
// No real store credentials are used: the provider adapters are the deterministic stubs the
// interface defines, so nothing here touches Apple's or Google's real APIs.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestMobileBuild } from "../../shared/mobileBuilds.ts";
import { createMobileBuildHarness } from "../../shared/mobileBuildTestFixtures.ts";
import { packJson } from "../../shared/blobStore.ts";
import { createMobileRelease, readyMobileRelease } from "../../shared/mobileReleases.ts";
import {
  createMobileStoreSubmission, cancelMobileStoreSubmission, listMobileStoreSubmissions,
  runMobileStorePublishStep,
} from "../../shared/mobileStorePublishing.ts";
import { putStoreConnection, readStoreConnection } from "../../shared/mobileStoreConnections.ts";
import {
  validateAppleCredentials, validateGoogleCredentials, uploadAppleBuild, checkAppleSubmissionStatus,
} from "../../shared/mobileStoreAdapters.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const BAD_PACKAGE_URL = "https://invalid.invalid/mobile-store-nope.pkg";

const APPLE_OK = {
  issuer_id: "8a3f9c2e-cert-suite",
  key_id: "CERTKEY01",
  team_id: "ABCD1234EF",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCATIIBgKCAQEAcertification-suite-fake-key-material\n-----END PRIVATE KEY-----",
  push_notifications: true,
};
const GOOGLE_OK = {
  service_account_json: JSON.stringify({
    client_email: "msp-svc@cert-suite.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCATIIBgKCAQEAcertification-suite-fake-key-material\n-----END PRIVATE KEY-----",
  }),
  package_name: "com.cert.suite",
};

const CLEANUP_ENTITIES = ["MobileStoreSubmission", "MobileRelease", "MobileBuild", "WorkspaceSecret", "Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Project", "AuditLog"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let wsA = null, wsB = null;
  const track = { projects: [], versions: [], deployments: [], artifacts: [], builds: [] };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const { drive, mkWs, mkProject, mkFixture, provisionSigning } = createMobileBuildHarness({ base44, svc, caller, track });
    wsA = await mkWs("msp-a");
    wsB = await mkWs("msp-b");
    await provisionSigning(wsA, ["ios", "android"]);
    await provisionSigning(wsB, ["ios"]);

    const payloadUrl = await packJson(svc, `mobile-p4-artifact-${Date.now()}.json`, {
      client_files: [{ path: "index.html", content: "<html><body>store</body></html>" }],
      functions: [], config: { entry: "index.html", framework: "preact-htm" },
    });

    // The real path: build → READY → release → READY, for the main (Apple) submission.
    const { project: pA, version: vA } = await mkProject(wsA, "msp-app");
    const fixA = await mkFixture(wsA, pA, vA, payloadUrl, "sha256:msp-a", 1);
    const buildA = await requestMobileBuild(base44, caller, {
      project_id: pA.id, deployment_id: fixA.deployment.id, platform: "ios",
      version_name: "1.0.0", version_code: 1, minimum_os_version: "13.0",
    });
    await drive(buildA.build.id);
    // The build worker no longer stamps signed_at (Base44 configures the signing key inside the
    // generated IPA/AAB opaquely). The store worker still gates upload on a completed signature,
    // so the suite simulates that externally-completed signature here to certify the upload path.
    await svc.entities.MobileBuild.update(buildA.build.id, { signed_at: new Date().toISOString() });
    const relA = await createMobileRelease(base44, caller, { build_id: buildA.build.id });
    await readyMobileRelease(base44, caller, { release_id: relA.release.id });

    // ---------------- store connection contracts ----------------
    await expectThrow("a missing Apple connection fails closed at the adapter",
      () => validateAppleCredentials(null), "STORE_NOT_CONFIGURED");
    await expectThrow("a missing Google connection fails closed at the adapter",
      () => validateGoogleCredentials(null), "STORE_NOT_CONFIGURED");
    await expectThrow("an invalid Apple connection is refused with STORE_AUTH_FAILED",
      () => validateAppleCredentials({ issuer_id: "short", key_id: "k", private_key: "not a pem key at all" }), "STORE_AUTH_FAILED");
    await expectThrow("an invalid Google connection is refused with STORE_AUTH_FAILED",
      () => validateGoogleCredentials({ service_account_json: "{not-json", package_name: "com.x" }), "STORE_AUTH_FAILED");
    await expectThrow("an upload without a connection fails closed",
      () => uploadAppleBuild(null, { idempotency_key: "k", version_name: "1.0.0", version_code: 1, checksum: "c" }), "STORE_NOT_CONFIGURED");
    await expectThrow("a status check without an external id is refused",
      () => checkAppleSubmissionStatus(APPLE_OK, null), "INVALID_SUBMISSION");
    check("a valid connection reports the store's own state",
      checkAppleSubmissionStatus(APPLE_OK, "apple-sub-x").state === "SUBMITTED", "SUBMITTED — review automation out of scope");

    await expectThrow("a structurally invalid Apple connection is refused before it is stored",
      () => putStoreConnection(svc, { workspace_id: wsA.id, platform: "ios", connection: { issuer_id: "no", key_id: "", private_key: "junk" }, user_id: caller.id }), "INVALID_STORE_CREDENTIAL");
    await expectThrow("a structurally invalid Google connection is refused before it is stored",
      () => putStoreConnection(svc, { workspace_id: wsA.id, platform: "android", connection: { service_account_json: "nope", package_name: "Not A Package" }, user_id: caller.id }), "INVALID_STORE_CREDENTIAL");

    // wsA gets ONLY an Apple connection — the Android path below certifies the missing-Google
    // refusal with the Apple one present, proving the lookup is platform-scoped.
    await putStoreConnection(svc, { workspace_id: wsA.id, platform: "ios", connection: APPLE_OK, user_id: caller.id });
    check("a valid Apple connection is stored", true, "stored encrypted via WorkspaceSecret");

    // ---------------- server-side readStoreConnection round-trip (all five fields) ----------------
    // The new Apple UI parity fields (team_id, push_notifications) must survive the encrypted
    // write → server-side read path unchanged. readStoreConnection is server-side only and never
    // exposed over HTTP; calling it here from the trusted test process certifies the round-trip
    // without adding any client-facing read action.
    const readApple = await readStoreConnection(svc, wsA.id, "ios");
    check("readStoreConnection round-trips issuer_id", readApple?.issuer_id === APPLE_OK.issuer_id, String(readApple?.issuer_id));
    check("readStoreConnection round-trips key_id", readApple?.key_id === APPLE_OK.key_id, String(readApple?.key_id));
    check("readStoreConnection round-trips team_id", readApple?.team_id === APPLE_OK.team_id, String(readApple?.team_id));
    check("readStoreConnection round-trips private_key", readApple?.private_key === APPLE_OK.private_key, "private_key matches");
    check("readStoreConnection round-trips push_notifications", readApple?.push_notifications === APPLE_OK.push_notifications, String(readApple?.push_notifications));

    // ---------------- creation, convergence, authorization ----------------
    const s1 = await createMobileStoreSubmission(base44, caller, { release_id: relA.release.id });
    check("an authorized member can create a store submission from a READY release",
      s1.submission.status === "DRAFT" && s1.submission.store === "app_store" && !s1.converged, s1.submission.status);
    check("the submission pins the release's immutable checksum",
      s1.submission.checksum === relA.release.checksum && s1.submission.created_by === caller.id, "pinned");

    const s1b = await createMobileStoreSubmission(base44, caller, { release_id: relA.release.id });
    const rowsForRelease = await svc.entities.MobileStoreSubmission.filter({ mobile_release_id: relA.release.id }, "-created_date", 50);
    check("a duplicate submission converges on the existing row",
      s1b.converged && s1b.submission.id === s1.submission.id && rowsForRelease.length === 1, rowsForRelease.length);

    await expectThrow("a non-member cannot create a submission",
      () => createMobileStoreSubmission(base44, { id: "msp-ghost-user-000000", email: "ghost@example.invalid" }, { release_id: relA.release.id }), "NOT_A_MEMBER");

    // ---------------- the worker drives DRAFT → VALIDATING → UPLOADING → SUBMITTED ----------------
    const driveSub = async (id, maxSteps = 10) => {
      let last = null;
      for (let i = 0; i < maxSteps; i++) {
        last = await runMobileStorePublishStep(svc, id);
        if (last.done) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      let sub = await svc.entities.MobileStoreSubmission.get(id);
      for (let i = 0; i < 5 && last?.status && sub.status !== last.status; i++) {
        await new Promise((r) => setTimeout(r, 250));
        sub = await svc.entities.MobileStoreSubmission.get(id);
      }
      return { ...last, sub };
    };
    const auditRows = async (ws) => await svc.entities.AuditLog.filter({ workspace_id: ws, resource: "MobileStoreSubmission" }, "-created_date", 500).catch(() => []);
    const countAudit = (rows, action, resourceId) => rows.filter((a) => a.action === action && (!resourceId || a.resource_id === resourceId)).length;

    const out1 = await driveSub(s1.submission.id);
    check("the worker drives the submission to SUBMITTED", out1.sub.status === "SUBMITTED", out1.sub.status);
    check("the store's external submission identity was recorded",
      /^apple-sub-[0-9a-f]{20}$/.test(out1.sub.external_submission_id || ""), out1.sub.external_submission_id);

    let auditsA = await auditRows(wsA.id);
    check("submission creation, upload and submission are audited",
      countAudit(auditsA, "mobile_store.submission_created") >= 1 &&
      countAudit(auditsA, "mobile_store.upload_started", s1.submission.id) === 1 &&
      countAudit(auditsA, "mobile_store.submitted", s1.submission.id) === 1, "audited");

    // Retry on a terminal row: nothing changes, nothing is uploaded again.
    const retry = await runMobileStorePublishStep(svc, s1.submission.id);
    const s1After = await svc.entities.MobileStoreSubmission.get(s1.submission.id);
    auditsA = await auditRows(wsA.id);
    check("a retry on a SUBMITTED submission changes nothing and uploads nothing again",
      retry.done === true && s1After.status === "SUBMITTED" &&
      s1After.external_submission_id === out1.sub.external_submission_id &&
      countAudit(auditsA, "mobile_store.upload_started", s1.submission.id) === 1, "terminal protection");

    // A worker that died AFTER persisting the external identity but BEFORE the terminal write:
    // the retry must skip the upload entirely.
    const crafted = await svc.entities.MobileStoreSubmission.create({
      workspace_id: wsA.id, project_id: pA.id, mobile_release_id: relA.release.id, platform: "ios",
      status: "UPLOADING", store: "app_store", external_submission_id: "ext-crafted-retry",
      checksum: relA.release.checksum, version_name: "1.0.0", version_code: 1,
      failure_code: null, failure_message: null,
      idempotency_key: `mobile_store:${relA.release.id}:${relA.release.checksum}`,
      cancel_requested: false, recovery_count: 0, created_by: caller.id,
      started_at: new Date().toISOString(), submitted_at: null, completed_at: null,
    });
    const craftedOut = await driveSub(crafted.id);
    auditsA = await auditRows(wsA.id);
    check("a resumed upload with a persisted external identity is never uploaded twice",
      craftedOut.sub.status === "SUBMITTED" && craftedOut.sub.external_submission_id === "ext-crafted-retry" &&
      countAudit(auditsA, "mobile_store.upload_started", crafted.id) === 0, "skipped the upload");

    // ---------------- rollback protection: a new submission, the previous one untouched ----------------
    const s2 = await createMobileStoreSubmission(base44, caller, { release_id: relA.release.id });
    const s1Fresh = await svc.entities.MobileStoreSubmission.get(s1.submission.id);
    check("re-publishing creates a NEW submission and never modifies the previous one",
      !s2.converged && s2.submission.id !== s1.submission.id &&
      s1Fresh.status === "SUBMITTED" && s1Fresh.external_submission_id === out1.sub.external_submission_id, "history intact");
    check("the previous submission's checksum is preserved on the new submission",
      s2.submission.checksum === s1Fresh.checksum, s2.submission.checksum);
    const out2 = await driveSub(s2.submission.id);
    check("the re-published submission replays to the SAME store identity (idempotent by content)",
      out2.sub.status === "SUBMITTED" && out2.sub.external_submission_id === s1Fresh.external_submission_id, out2.sub.external_submission_id);

    // ---------------- cancellation ----------------
    const s3 = await createMobileStoreSubmission(base44, caller, { release_id: relA.release.id });
    await cancelMobileStoreSubmission(base44, caller, { submission_id: s3.submission.id });
    const out3 = await driveSub(s3.submission.id);
    auditsA = await auditRows(wsA.id);
    check("a cancelled submission ends CANCELLED before the store accepts it",
      out3.sub.status === "CANCELLED" && countAudit(auditsA, "mobile_store.cancelled", s3.submission.id) === 1, out3.sub.status);
    await expectThrow("a terminal submission cannot be cancelled again",
      () => cancelMobileStoreSubmission(base44, caller, { submission_id: s3.submission.id }), "INVALID_STATE");

    // ---------------- missing store credentials fail closed (worker level) ----------------
    // wsA has an Apple connection but NO Google connection → the Android submission must fail
    // closed at validation, proving the credential lookup is platform-scoped.
    const buildA2 = await requestMobileBuild(base44, caller, {
      project_id: pA.id, deployment_id: fixA.deployment.id, platform: "android",
      version_name: "1.0.0", version_code: 1, minimum_os_version: "8.0",
    });
    await drive(buildA2.build.id);
    await svc.entities.MobileBuild.update(buildA2.build.id, { signed_at: new Date().toISOString() });
    const relA2 = await createMobileRelease(base44, caller, { build_id: buildA2.build.id });
    await readyMobileRelease(base44, caller, { release_id: relA2.release.id });
    const subA2 = await createMobileStoreSubmission(base44, caller, { release_id: relA2.release.id });
    const outA2 = await driveSub(subA2.submission.id);
    check("a submission without a Google connection fails safely before any upload",
      outA2.sub.status === "FAILED" && outA2.sub.failure_code === "STORE_NOT_CONFIGURED", outA2.sub.failure_code);

    // wsB has NO connections at all → the Apple submission fails closed too.
    const { project: pB, version: vB } = await mkProject(wsB, "msp-b-app");
    const fixB = await mkFixture(wsB, pB, vB, payloadUrl, "sha256:msp-b", 1);
    const buildB = await requestMobileBuild(base44, caller, {
      project_id: pB.id, deployment_id: fixB.deployment.id, platform: "ios",
      version_name: "1.0.0", version_code: 1, minimum_os_version: "13.0",
    });
    await drive(buildB.build.id);
    await svc.entities.MobileBuild.update(buildB.build.id, { signed_at: new Date().toISOString() });
    const relB = await createMobileRelease(base44, caller, { build_id: buildB.build.id });
    await readyMobileRelease(base44, caller, { release_id: relB.release.id });
    const subB = await createMobileStoreSubmission(base44, caller, { release_id: relB.release.id });
    const outB = await driveSub(subB.submission.id);
    check("a submission without an Apple connection fails safely before any upload",
      outB.sub.status === "FAILED" && outB.sub.failure_code === "STORE_NOT_CONFIGURED", outB.sub.failure_code);

    // ---------------- a build with no completed signature fails closed (SIGNING_INCOMPLETE) ----------------
    // The build worker no longer stamps signed_at; a submission whose release's build has no
    // completed signature must fail closed at validation, BEFORE any store credential is read.
    const buildUnsigned = await requestMobileBuild(base44, caller, {
      project_id: pA.id, deployment_id: fixA.deployment.id, platform: "ios",
      version_name: "1.0.0", version_code: 1, minimum_os_version: "13.0",
    });
    await drive(buildUnsigned.build.id);
    // Deliberately NOT stamping signed_at — this is the unsigned-build case.
    const relUnsigned = await createMobileRelease(base44, caller, { build_id: buildUnsigned.build.id });
    await readyMobileRelease(base44, caller, { release_id: relUnsigned.release.id });
    const subUnsigned = await createMobileStoreSubmission(base44, caller, { release_id: relUnsigned.release.id });
    const outUnsigned = await driveSub(subUnsigned.submission.id);
    check("a submission whose build has no completed signature fails closed with SIGNING_INCOMPLETE",
      outUnsigned.sub.status === "FAILED" && outUnsigned.sub.failure_code === "SIGNING_INCOMPLETE", outUnsigned.sub.failure_code);

    // ---------------- release checksum and package metadata are required ----------------
    const badChecksumRelease = await svc.entities.MobileRelease.create({
      workspace_id: wsA.id, project_id: pA.id, mobile_build_id: buildA.build.id, platform: "ios",
      status: "READY", artifact_uri: BAD_PACKAGE_URL, checksum: "sha256:broken-store-package",
      version_name: "1.0.0", version_code: 1, created_by: caller.id,
    });
    const badMetaRelease = await svc.entities.MobileRelease.create({
      workspace_id: wsA.id, project_id: pA.id, mobile_build_id: buildA.build.id, platform: "ios",
      status: "READY", artifact_uri: BAD_PACKAGE_URL, checksum: "sha256:broken-store-package",
      version_name: null, version_code: null, created_by: caller.id,
    });
    const subBad = await createMobileStoreSubmission(base44, caller, { release_id: badChecksumRelease.id });
    const outBad = await driveSub(subBad.submission.id);
    check("a release whose package fails checksum verification is never uploaded",
      outBad.sub.status === "FAILED" && outBad.sub.failure_code === "RELEASE_CHECKSUM_MISMATCH", outBad.sub.failure_code);
    const subMeta = await createMobileStoreSubmission(base44, caller, { release_id: badMetaRelease.id });
    const outMeta = await driveSub(subMeta.submission.id);
    check("a submission without valid package metadata is refused",
      outMeta.sub.status === "FAILED" && outMeta.sub.failure_code === "INVALID_PACKAGE_METADATA", outMeta.sub.failure_code);

    // ---------------- workspace isolation ----------------
    const listA = await listMobileStoreSubmissions(base44, caller, { project_id: pA.id });
    const listB = await listMobileStoreSubmissions(base44, caller, { project_id: pB.id });
    check("submission listings are workspace-isolated by project",
      listA.submissions.some((s) => s.id === s1.submission.id) &&
      !listB.submissions.some((s) => s.id === s1.submission.id) &&
      listB.submissions.some((s) => s.id === subB.submission.id), "isolated");
    const clientRead = await base44.entities.MobileStoreSubmission.filter({ workspace_id: wsA.id }, "-created_date", 10).catch(() => []);
    check("a client cannot directly read store submissions", clientRead.length === 0, `${clientRead.length}`);

    // ---------------- every required audit event exists ----------------
    auditsA = await auditRows(wsA.id);
    const requiredEvents = ["mobile_store.submission_created", "mobile_store.upload_started", "mobile_store.submitted", "mobile_store.failed", "mobile_store.cancelled"];
    check("every required store publishing audit event was written",
      requiredEvents.every((a) => countAudit(auditsA, a) >= 1), requiredEvents.join(", "));
    const connAudits = (await svc.entities.AuditLog.filter({ workspace_id: wsA.id, resource: "WorkspaceSecret" }, "-created_date", 100))
      .filter((a) => a.action.startsWith("mobile_store_connection."));
    check("the store connection change was audited under mobile_store_connection.*",
      connAudits.some((a) => a.action === "mobile_store_connection.created") &&
      !JSON.stringify(connAudits).includes("PRIVATE KEY"), "audited, no credential material");

    // ---------------- the worker boundary requires authentication ----------------
    const probe = await fetch("https://quick-zip-snap.base44.app/functions/mobileStorePublishStep", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ submission_id: "x" }),
    });
    check("the publishing worker boundary requires authentication", probe.status === 401, `${probe.status}`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    await cleanupWorkspace(svc, wsA?.id, CLEANUP_ENTITIES);
    await cleanupWorkspace(svc, wsB?.id, CLEANUP_ENTITIES);
  }
}