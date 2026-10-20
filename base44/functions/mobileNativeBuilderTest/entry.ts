// Certification suite for the external native mobile builder boundary.
//
// Exercises the REAL builds queue, the REAL MobileBuild row, the REAL immutable artifact, and the
// REAL private binary storage — nothing is simulated. Certifies:
//   * workerAuth fails closed without the WORKER_SECRET (and admits the workflow header)
//   * enqueue is idempotent per build
//   * claim returns a type-filtered native job + a metadata-only projection (no secret VALUE)
//   * the result callback stamps MobileBuild READY with artifact_uri, package_checksum, platform,
//     signed_at, signing_secret_name — all five round-trip unchanged
//   * best-effort checksum verification refuses a builder that lies about its own output
//   * lease ownership is enforced: a submit with the wrong lease_token is refused
//   * a platform mismatch is refused and terminalizes the build
//   * a terminal build is never overwritten
//   * the existing `.mobpkg` packaging path is untouched (a QUEUED build still READYs via the
//     internal worker)
//
// Native-path builds are created directly at status BUILDING so the Mobile Build Executor entity
// trigger (which fires on QUEUED creation) does not race the native builder; the fallback build
// is created through the real requestMobileBuild so the internal worker drives it. No real IPA/AAB
// is produced and no Apple/Google API is called; the "artifact" is a deterministic private-storage
// upload whose checksum the boundary verifies.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createMobileBuildHarness } from "../../shared/mobileBuildTestFixtures.ts";
import { requestMobileBuild } from "../../shared/mobileBuilds.ts";
import { packJson } from "../../shared/blobStore.ts";
import { sha256Hex, packBinaryPackage } from "../../shared/mobileArtifacts.ts";
import {
  enqueueNativeBuildJob, claimNativeBuildJob, submitNativeBuildResult, heartbeatNativeBuildJob,
  nativeBuildJobIdempotencyKey, NATIVE_BUILD_JOB_TYPE, validateNativeBuildResult,
} from "../../shared/mobileNativeBuilder.ts";
import { workerAuthDecision } from "../../shared/workerAuth.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const CLEANUP = ["BackgroundJob", "MobileBuild", "Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Project", "Workspace", "AuditLog", "WorkspaceSecret"];

const mkReq = (headers = {}) => {
  const h = new Map(Object.entries(headers));
  return { headers: { get: (k) => h.get(k.toLowerCase()) || null } };
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let ws = null;
  const track = { projects: [], versions: [], deployments: [], artifacts: [], builds: [] };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    // ---------------- worker auth fail-closed ----------------
    check("workerAuth admits the platform workflow header", workerAuthDecision(mkReq({ "x-workflow-run": "r1" }), null).ok === true, "workflow trusted");
    check("workerAuth fails closed when no secret is presented", workerAuthDecision(mkReq({}), "s3cr3t").ok === false, "WORKER_AUTH_REQUIRED");
    check("workerAuth fails closed when the secret is wrong", workerAuthDecision(mkReq({ "x-worker-secret": "nope" }), "s3cr3t").ok === false, "WORKER_AUTH_INVALID");
    check("workerAuth fails closed when no secret is configured", workerAuthDecision(mkReq({ "x-worker-secret": "x" }), null).ok === false, "WORKER_SECRET_NOT_CONFIGURED");
    check("workerAuth admits a correct shared secret", workerAuthDecision(mkReq({ "x-worker-secret": "s3cr3t" }), "s3cr3t").ok === true, "secret trusted");

    const { drive, mkWs, mkProject, mkFixture, provisionSigning } = createMobileBuildHarness({ base44, svc, caller, track });
    ws = await mkWs("mnb");
    // The `.mobpkg` fallback's SIGNING phase fails closed without a signing credential.
    await provisionSigning(ws, ["ios"]);

    const payloadUrl = await packJson(svc, `mnb-artifact-${Date.now()}.json`, {
      client_files: [{ path: "index.html", content: "<html><body>native</body></html>" }, { path: "app.js", content: "console.log('native')" }],
      functions: [], config: { entry: "index.html", framework: "preact-htm" },
    });

    const { project, version } = await mkProject(ws, "mnb-app");
    const fix = await mkFixture(ws, project, version, payloadUrl, "sha256:mnb-source");

    // Direct MobileBuild creation at BUILDING — the Mobile Build Executor entity trigger fires on
    // QUEUED creation, so this avoids racing the internal `.mobpkg` worker. The boundary does not
    // care that the build is BUILDING rather than QUEUED; it only rejects terminal builds.
    const mkBuild = async ({ platform = "ios", version_name = null, version_code = null, minimum_os_version = null, release_notes = null } = {}) => {
      const build = await svc.entities.MobileBuild.create({
        workspace_id: ws.id, project_id: project.id, deployment_id: fix.deployment.id, artifact_id: fix.artifact.id,
        platform, status: "BUILDING", checksum: fix.artifact.checksum, version_number: fix.deployment.version_number ?? null,
        version_name, version_code, minimum_os_version, release_notes,
        failure_code: null, recovery_count: 0, created_by: caller.id, heartbeat_at: new Date().toISOString(),
      });
      track.builds.push(build.id);
      return build;
    };

    // ---------------- the native boundary round-trip ----------------
    const build = await mkBuild({ version_name: "1.0.0", version_code: 1, minimum_os_version: "13.0" });

    // enqueue is idempotent: a second enqueue while inflight returns the same job.
    const enq1 = await enqueueNativeBuildJob(base44, { build_id: build.id });
    const enq2 = await enqueueNativeBuildJob(base44, { build_id: build.id });
    check("enqueue creates a builds-queue native job", enq1.job.job_type === NATIVE_BUILD_JOB_TYPE && enq1.job.queue === "builds", enq1.job.job_type);
    check("enqueue is idempotent per build", enq2.duplicate === true && enq2.job.id === enq1.job.id, `duplicate=${enq2.duplicate}`);
    check("the idempotency key is derived from the build id", enq1.job.idempotency_key === nativeBuildJobIdempotencyKey(build.id), enq1.job.idempotency_key);

    // claim returns the native job + a metadata-only projection.
    const claimed = await claimNativeBuildJob(base44, { worker_id: "mnb-worker" });
    check("claim returns the enqueued native job", claimed.job?.id === enq1.job.id, claimed.job?.id || null);
    check("the projection carries the platform and source checksum", claimed.input?.platform === "ios" && claimed.input.source.checksum === build.checksum, claimed.input?.source.checksum || null);
    check("the projection carries the pinned release metadata", claimed.input?.release.version_name === "1.0.0" && claimed.input.release.version_code === 1, "release metadata present");
    check("the projection names only the signing secret identity (no value)", claimed.input?.signing.secret_name === "MOBILE_SIGNING_APPLE" && !JSON.stringify(claimed.input).includes("PRIVATE KEY"), claimed.input?.signing.secret_name);
    check("the projection carries the build id", claimed.input?.build_id === build.id, claimed.input?.build_id);

    // heartbeat extends the lease.
    const hb = await heartbeatNativeBuildJob(base44, claimed.job.id, claimed.job.lease_token);
    check("heartbeat extends the lease", !!hb.lease_expires_at && new Date(hb.lease_expires_at).getTime() > Date.now(), "extended");

    // Produce a deterministic private-storage "artifact" and compute its real checksum, so the
    // boundary's best-effort checksum verification succeeds against what storage actually serves.
    const artifactBytes = new TextEncoder().encode("native-builder-fake-ipa-bytes-" + build.id);
    const artifact_uri = await packBinaryPackage(svc, `mnb-artifact-${build.id}.ipa`, artifactBytes);
    const package_checksum = await sha256Hex(artifactBytes);
    const signed_at = "2026-10-01T17:00:00.000Z";

    const submitted = await submitNativeBuildResult(base44, claimed.job.id, claimed.job.lease_token, {
      artifact_uri, package_checksum, platform: "ios", signed_at, package_size_bytes: artifactBytes.length,
    });
    check("submit succeeds and stamps the build READY", submitted.outcome === "succeeded", submitted.outcome);
    const after = await svc.entities.MobileBuild.get(build.id);
    check("the build row is READY", after.status === "READY", after.status);
    check("the artifact_uri round-trips", after.artifact_uri === artifact_uri, after.artifact_uri);
    check("the package_checksum round-trips", after.package_checksum === package_checksum, after.package_checksum);
    check("the platform round-trips (row)", after.platform === "ios", after.platform);
    check("the signed_at round-trips", after.signed_at === signed_at, after.signed_at);
    check("the signing secret NAME is stamped (identity only)", after.signing_secret_name === "MOBILE_SIGNING_APPLE", after.signing_secret_name);
    const jobAfter = await svc.entities.BackgroundJob.get(claimed.job.id);
    check("the native job is completed (succeeded)", jobAfter.status === "succeeded" && jobAfter.result?.artifact_uri === artifact_uri, jobAfter.status);

    // ---------------- a builder that lies about its checksum is refused ----------------
    const build2 = await mkBuild({ version_name: "1.0.1", version_code: 2 });
    await enqueueNativeBuildJob(base44, { build_id: build2.id });
    const claimed2 = await claimNativeBuildJob(base44, { worker_id: "mnb-worker" });
    const lyingBytes = new TextEncoder().encode("different-bytes");
    const lyingUri = await packBinaryPackage(svc, `mnb-liar-${build2.id}.ipa`, lyingBytes);
    const lieResult = await submitNativeBuildResult(base44, claimed2.job.id, claimed2.job.lease_token, {
      artifact_uri: lyingUri, package_checksum: "0".repeat(64), platform: "ios",
    });
    check("a checksum mismatch is refused (CHECKSUM_MISMATCH)", lieResult.outcome === "failed" && lieResult.code === "CHECKSUM_MISMATCH", lieResult.code);
    const build2After = await svc.entities.MobileBuild.get(build2.id);
    check("the checksum-mismatch build is terminalized to FAILED", build2After.status === "FAILED" && build2After.failure_code === "CHECKSUM_MISMATCH", build2After.status);
    const job2 = await svc.entities.BackgroundJob.get(claimed2.job.id);
    check("the checksum-mismatch job is dead-lettered (non-retryable)", job2.status === "dead_letter" && job2.error_code === "CHECKSUM_MISMATCH", job2.status);

    // ---------------- lease ownership is enforced ----------------
    const build3 = await mkBuild({ version_name: "1.0.2", version_code: 3 });
    await enqueueNativeBuildJob(base44, { build_id: build3.id });
    const claimed3 = await claimNativeBuildJob(base44, { worker_id: "mnb-worker" });
    await expectThrow("a submit with the wrong lease_token is refused",
      () => submitNativeBuildResult(base44, claimed3.job.id, "not-the-lease", { artifact_uri: "x", package_checksum: "0".repeat(64), platform: "ios" }), "LEASE_LOST");

    // ---------------- a platform mismatch is refused and terminalizes the build ----------------
    const badPlatform = await submitNativeBuildResult(base44, claimed3.job.id, claimed3.job.lease_token, { artifact_uri: lyingUri, package_checksum: "0".repeat(64), platform: "android" });
    check("a platform mismatch is refused (PLATFORM_MISMATCH)", badPlatform.outcome === "failed" && badPlatform.code === "PLATFORM_MISMATCH", badPlatform.code);
    const build3After = await svc.entities.MobileBuild.get(build3.id);
    check("the platform-mismatch build is terminalized to FAILED", build3After.status === "FAILED" && build3After.failure_code === "PLATFORM_MISMATCH", build3After.status);

    // ---------------- a terminal build is never overwritten ----------------
    // Claim a fresh build, then stamp it READY externally (simulating the internal worker winning
    // the race), then submit — the compare-and-set must skip the terminal build.
    const termBuild = await mkBuild({ version_name: "1.0.3", version_code: 4 });
    await enqueueNativeBuildJob(base44, { build_id: termBuild.id });
    const claimedTerm = await claimNativeBuildJob(base44, { worker_id: "mnb-worker" });
    await svc.entities.MobileBuild.update(termBuild.id, {
      status: "READY", artifact_uri: "mp://already-ready.mobpkg", package_checksum: "a".repeat(64),
      completed_at: new Date().toISOString(), lease_token: null, lease_expires_at: null,
    });
    const reSubmit = await submitNativeBuildResult(base44, claimedTerm.job.id, claimedTerm.job.lease_token, {
      artifact_uri: "mp://native.ipa", package_checksum: "b".repeat(64), platform: "ios",
    });
    check("a terminal build is never overwritten", reSubmit.outcome === "skipped" && reSubmit.code === "BUILD_ALREADY_TERMINAL", reSubmit.code);
    const stillTerm = await svc.entities.MobileBuild.get(termBuild.id);
    check("the terminal build's artifact_uri is unchanged", stillTerm.artifact_uri === "mp://already-ready.mobpkg", stillTerm.artifact_uri);

    // ---------------- the existing .mobpkg path is untouched (fallback) ----------------
    // A QUEUED build created through the real requestMobileBuild is driven by the internal worker
    // (and/or the Mobile Build Executor workflow) — the native boundary is not involved. It must
    // still reach READY with a `.mobpkg` artifact.
    const { project: pB, version: vB } = await mkProject(ws, "mnb-fallback");
    const fixB = await mkFixture(ws, pB, vB, payloadUrl, "sha256:mnb-fallback");
    const fallback = await requestMobileBuild(base44, caller, { project_id: pB.id, deployment_id: fixB.deployment.id, platform: "ios", version_name: "2.0.0", version_code: 1 });
    const driven = await drive(fallback.build.id);
    check("the existing .mobpkg path still drives a build to READY with no native job", driven.build.status === "READY" && driven.build.artifact_uri?.endsWith(".mobpkg"), driven.build.status);
    check("the fallback build produced a package_checksum", !!driven.build.package_checksum, driven.build.package_checksum || null);

    // ---------------- validateNativeBuildResult shape checks ----------------
    try { validateNativeBuildResult({ platform: "ios" }); check("a missing artifact_uri is rejected", false, "should have thrown"); } catch (e) { check("a missing artifact_uri is rejected", e.code === "INVALID_RESULT", e.code); }
    try { validateNativeBuildResult({ artifact_uri: "x", package_checksum: "short", platform: "ios" }); check("a short checksum is rejected", false, "should have thrown"); } catch (e) { check("a short checksum is rejected", e.code === "INVALID_RESULT", e.code); }
    const errShape = validateNativeBuildResult({ error: { code: "SIGN_FAILED", message: "no key" } });
    check("an error result validates as a failure", errShape.ok === false && errShape.code === "SIGN_FAILED", errShape.code);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    await cleanupWorkspace(svc, ws?.id, CLEANUP);
  }
}