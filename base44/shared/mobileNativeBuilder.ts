// External native mobile builder boundary (NexusAI-native).
//
// The smallest surface a future real macOS/Linux builder needs to produce real IPA/AAB artifacts
// through the EXISTING certified mobile pipeline. It reuses, UNCHANGED:
//   * workerAuth      — WORKER_SECRET / x-workflow-run authentication (requireWorkerAuth)
//   * builds queue    — BackgroundJob claim/lease/heartbeat/complete/fail/dead-letter semantics
//   * MobileBuild     — the certified build row pinned to an immutable DeploymentArtifact
//   * mobileSigning  — signing secret NAME (identity only; the VALUE is never projected)
//   * WorkspaceSecret — encrypted-at-rest credential storage (read only by the trusted signer)
//
// The boundary adds ONE job type on the builds queue, a type-filtered claim, a metadata-only
// input projection, and a fail-closed result callback. The existing `.mobpkg` packaging path
// (runMobileBuildStep) is untouched and remains the fallback when no native builder is attached.
//
// No fake IPA/AAB is produced here, no HMAC-as-signing, no Apple/Google API calls, and no
// hosting/provider-specific code — the boundary is a contract surface only.
import { enqueue, complete, fail, heartbeat, queueConfig } from "./jobQueue.ts";
import { audit } from "./authz.ts";
import { signingSecretName } from "./mobileSigning.ts";
import { verifyStoredPackage } from "./mobileArtifacts.ts";

export const NATIVE_BUILD_JOB_TYPE = "mobile_native_build";
export const NATIVE_BUILD_QUEUE = "builds";
// Native builds are long; the queue's concurrency ceiling still bounds how many run at once.
export const NATIVE_BUILD_LEASE_MS = 600000;

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const leaseToken = () => `lease_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const failFn = (status, code, message) => Object.assign(new Error(message), { status, code });
const HEX64 = /^[0-9a-f]{64}$/;
const isIso = (v) => typeof v === "string" && v.length > 0 && Number.isFinite(Date.parse(v));
const MOBILE_TERMINAL = ["READY", "FAILED", "CANCELLED"];

export function nativeBuildJobIdempotencyKey(build_id) {
  return `mobile_native_build:${build_id}`;
}

/**
 * Enqueue a native build job onto the EXISTING builds queue. Idempotent per build: while one
 * native job is inflight, re-enqueue returns the existing job. The payload carries only the
 * build_id — the certified metadata projection is resolved at claim time from the immutable
 * pinned artifact, so a stale projection is never handed to a builder.
 */
export async function enqueueNativeBuildJob(base44, { build_id, trace_id = null } = {}) {
  if (!build_id) throw failFn(400, "BUILD_ID_REQUIRED", "build_id is required");
  const svc = svcOf(base44);
  const build = await svc.entities.MobileBuild.get(build_id).catch(() => null);
  if (!build) throw failFn(404, "BUILD_NOT_FOUND", "Mobile build not found");
  return enqueue(base44, {
    queue: NATIVE_BUILD_QUEUE,
    job_type: NATIVE_BUILD_JOB_TYPE,
    payload: { build_id },
    idempotency_key: nativeBuildJobIdempotencyKey(build_id),
    workspace_id: build.workspace_id, project_id: build.project_id,
    trace_id: trace_id || null,
    lease_ms: NATIVE_BUILD_LEASE_MS,
  });
}

/**
 * Claim the next native build job for an external worker. Type-filtered so the external builder
 * never claims another builds-queue job type. Reuses the queue's ownership semantics: a lease
 * token is written and re-read (two workers cannot both proceed); an expired lease is
 * reclaimable as a bounded recovery; a job whose retry budget is spent dead-letters.
 */
export async function claimNativeBuildJob(base44, { worker_id = "native-builder", now = Date.now() } = {}) {
  const svc = svcOf(base44);
  const cfg = queueConfig(NATIVE_BUILD_QUEUE);
  const leased = await svc.entities.BackgroundJob.filter({ queue: NATIVE_BUILD_QUEUE, status: "leased" }, "-created_date", 200);
  const active = leased.filter((j) => j.lease_expires_at && new Date(j.lease_expires_at).getTime() > now);
  const capacity = Math.max(0, cfg.concurrency - active.length);
  if (!capacity) return { job: null, input: null };

  const pending = await svc.entities.BackgroundJob.filter({ queue: NATIVE_BUILD_QUEUE, status: "pending" }, "created_date", 200);
  const reclaimable = leased.filter((j) => !j.lease_expires_at || new Date(j.lease_expires_at).getTime() <= now);
  const candidate = [...pending.filter((j) => !j.available_at || new Date(j.available_at).getTime() <= now), ...reclaimable]
    .filter((j) => j.job_type === NATIVE_BUILD_JOB_TYPE && !j.cancel_requested)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.created_date).localeCompare(String(b.created_date)))
    .slice(0, capacity)[0];
  if (!candidate) return { job: null, input: null };

  const mine = leaseToken();
  const wasLost = candidate.status === "leased";
  await svc.entities.BackgroundJob.update(candidate.id, {
    status: "leased", lease_token: mine, worker_id,
    lease_expires_at: new Date(now + NATIVE_BUILD_LEASE_MS).toISOString(),
    heartbeat_at: nowIso(), started_at: candidate.started_at || nowIso(),
    ...(wasLost ? {
      attempts: (candidate.attempts || 0) + 1, error_code: "WORKER_LOST",
      last_error: "Previous worker stopped reporting; lease reclaimed",
      attempt_log: [...(candidate.attempt_log || []), { attempt: (candidate.attempts || 0) + 1, error: "worker lost", code: "WORKER_LOST", worker_id: candidate.worker_id, at: nowIso() }],
    } : {}),
  });
  const fresh = await svc.entities.BackgroundJob.get(candidate.id);
  // Lost the race to another worker — do not proceed.
  if (fresh.lease_token !== mine) return { job: null, input: null };
  // Retry budget spent by worker loss — dead-letter rather than running again.
  if ((fresh.attempts || 0) >= (fresh.max_attempts || 5)) {
    await fail(base44, fresh.id, mine, "Worker lost; retry budget exhausted", { retryable: false, code: "WORKER_LOST" });
    return { job: null, input: null };
  }
  const input = await projectNativeBuildInput(base44, fresh).catch(async (e) => {
    await fail(base44, fresh.id, mine, e, { retryable: false, code: e.code || "PROJECTION_ERROR" });
    return null;
  });
  if (!input) return { job: null, input: null };
  return { job: fresh, input };
}

/**
 * The metadata-only projection a native builder receives. Contains ONLY certified build/artifact
 * metadata: platform, the immutable source artifact's identity + a short-lived signed download URL
 * + its checksum, the pinned release metadata, and the signing credential NAME (identity). No
 * WorkspaceSecret VALUE ever appears here — the builder obtains signing material through its own
 * trusted infrastructure, out of scope for this boundary.
 */
export async function projectNativeBuildInput(base44, job) {
  const svc = svcOf(base44);
  const build_id = job?.payload?.build_id;
  if (!build_id) throw failFn(409, "NO_BUILD_ID", "The job payload carries no build_id");
  const build = await svc.entities.MobileBuild.get(build_id).catch(() => null);
  if (!build) throw failFn(404, "BUILD_NOT_FOUND", "The build no longer exists");
  if (MOBILE_TERMINAL.includes(build.status)) {
    throw failFn(409, "BUILD_ALREADY_TERMINAL", `The build is already ${build.status}`);
  }
  const artifact = build.artifact_id ? await svc.entities.DeploymentArtifact.get(build.artifact_id).catch(() => null) : null;
  if (!artifact) throw failFn(404, "ARTIFACT_NOT_FOUND", "The pinned artifact no longer exists");
  // Best-effort short-lived signed URL for the immutable source payload. If the payload_url is
  // not a private file_uri, signing fails and the builder falls back to the raw payload_url.
  let signed_url = null;
  try {
    const r = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: artifact.payload_url, expires_in: 600 });
    signed_url = r.signed_url || null;
  } catch { signed_url = null; }
  return {
    job_id: job.id,
    build_id: build.id,
    platform: build.platform,
    source: {
      artifact_id: build.artifact_id,
      checksum: build.checksum || artifact.checksum || null,
      payload_url: artifact.payload_url || null,
      signed_url,
    },
    release: {
      version_number: build.version_number ?? null,
      version_name: build.version_name ?? null,
      version_code: build.version_code ?? null,
      minimum_os_version: build.minimum_os_version ?? null,
      release_notes: build.release_notes ?? null,
    },
    signing: {
      secret_name: signingSecretName(build.platform),
      platform: build.platform,
    },
  };
}

export function heartbeatNativeBuildJob(base44, job_id, lease_token) {
  return heartbeat(base44, job_id, lease_token);
}

/**
 * Validate the result callback shape. A result is either a failure ({ error: { code, message } })
 * or a success carrying the artifact URI, its SHA-256 checksum, the platform, and optionally the
 * signed_at instant and package size.
 */
export function validateNativeBuildResult(result) {
  if (!result || typeof result !== "object") throw failFn(400, "INVALID_RESULT", "result must be an object");
  if (result.error) {
    return {
      ok: false,
      code: String(result.error.code || "BUILDER_ERROR").slice(0, 64) || "BUILDER_ERROR",
      message: String(result.error.message || "builder error").slice(0, 500),
    };
  }
  const artifact_uri = String(result.artifact_uri || "").trim();
  const package_checksum = String(result.package_checksum || "").trim();
  const platform = String(result.platform || "").trim();
  if (!artifact_uri) throw failFn(400, "INVALID_RESULT", "artifact_uri is required for a successful result");
  if (!package_checksum || !HEX64.test(package_checksum)) throw failFn(400, "INVALID_RESULT", "package_checksum must be a 64-hex SHA-256");
  if (!platform) throw failFn(400, "INVALID_RESULT", "platform is required");
  let signed_at = null;
  if (result.signed_at != null) {
    if (!isIso(result.signed_at)) throw failFn(400, "INVALID_RESULT", "signed_at must be an ISO-8601 string");
    signed_at = new Date(result.signed_at).toISOString();
  }
  const package_size_bytes = result.package_size_bytes == null ? null : Number(result.package_size_bytes);
  if (package_size_bytes != null && (!Number.isFinite(package_size_bytes) || package_size_bytes < 0)) {
    throw failFn(400, "INVALID_RESULT", "package_size_bytes must be a non-negative number");
  }
  return { ok: true, artifact_uri, package_checksum, platform, signed_at, package_size_bytes };
}

const NON_RETRYABLE = new Set(["INVALID_RESULT", "BUILD_ALREADY_TERMINAL", "PLATFORM_MISMATCH", "CHECKSUM_MISMATCH", "BUILD_NOT_FOUND"]);

// Terminalize the build on a hard native failure (checksum/platform mismatch) so it does not
// dangle as active and block the next request. Compare-and-set on the current non-terminal status
// so a terminal build is never overwritten. Returns whether the stamp landed.
async function stampBuildFailed(svc, build, code, summary) {
  if (MOBILE_TERMINAL.includes(build.status)) return false;
  const claim = await svc.entities.MobileBuild.updateMany(
    { id: build.id, status: build.status },
    { $set: { status: "FAILED", failure_code: code, failure_summary: summary, completed_at: nowIso(), heartbeat_at: nowIso(), lease_token: null, lease_expires_at: null } },
  ).catch(() => null);
  return Number(claim?.updated || 0) > 0;
}

/**
 * The fail-closed result callback. Ownership is asserted by the queue's complete()/fail() through
 * the lease_token; the MobileBuild is advanced to READY/FAILED only through a compare-and-set on
 * its current non-terminal status, so a terminal build is never overwritten and a concurrently
 * advanced build is never clobbered. The MobileBuild lease_token is cleared on completion so a
 * zombie internal `.mobpkg` worker holding the old lease cannot overwrite the native result.
 */
export async function submitNativeBuildResult(base44, job_id, lease_token, result = {}) {
  const svc = svcOf(base44);
  const validated = validateNativeBuildResult(result);

  // Fail-closed ownership: the job must exist, be ours, and be a native build job.
  const job = await svc.entities.BackgroundJob.get(job_id).catch(() => null);
  if (!job || job.job_type !== NATIVE_BUILD_JOB_TYPE) throw failFn(404, "JOB_NOT_FOUND", "Native build job not found");
  if (!lease_token || job.lease_token !== lease_token) throw failFn(409, "LEASE_LOST", "Lease ownership mismatch");

  const build_id = job.payload?.build_id;
  const build = build_id ? await svc.entities.MobileBuild.get(build_id).catch(() => null) : null;
  if (!build) {
    await fail(base44, job_id, lease_token, "Build not found", { retryable: false, code: "BUILD_NOT_FOUND" });
    return { job_id, outcome: "failed", code: "BUILD_NOT_FOUND" };
  }

  // ---- failure path ----
  if (!validated.ok) {
    if (MOBILE_TERMINAL.includes(build.status)) {
      await fail(base44, job_id, lease_token, `The build is already ${build.status}`, { retryable: false, code: "BUILD_ALREADY_TERMINAL" });
      return { job_id, outcome: "skipped", code: "BUILD_ALREADY_TERMINAL" };
    }
    const claim = await svc.entities.MobileBuild.updateMany(
      { id: build.id, status: build.status },
      { $set: { status: "FAILED", failure_code: validated.code, failure_summary: validated.message, completed_at: nowIso(), heartbeat_at: nowIso(), lease_token: null, lease_expires_at: null } },
    ).catch(() => null);
    await audit(svc, { workspace_id: build.workspace_id, project_id: build.project_id, user_id: "native-builder", action: "mobile_build.native_failed", resource: "MobileBuild", resource_id: build.id, metadata: { platform: build.platform, failure_code: validated.code } }).catch(() => {});
    const retryable = !NON_RETRYABLE.has(validated.code);
    await fail(base44, job_id, lease_token, validated.message, { retryable, code: validated.code });
    return { job_id, outcome: "failed", code: validated.code, stamped: Number(claim?.updated || 0) > 0 };
  }

  // ---- success path ----
  if (validated.platform !== build.platform) {
    await stampBuildFailed(svc, build, "PLATFORM_MISMATCH", `Native builder reported platform ${validated.platform} for an ${build.platform} build`);
    await audit(svc, { workspace_id: build.workspace_id, project_id: build.project_id, user_id: "native-builder", action: "mobile_build.native_platform_mismatch", resource: "MobileBuild", resource_id: build.id, metadata: { platform: build.platform, reported_platform: validated.platform } }).catch(() => {});
    await fail(base44, job_id, lease_token, `platform mismatch: result ${validated.platform} vs build ${build.platform}`, { retryable: false, code: "PLATFORM_MISMATCH" });
    return { job_id, outcome: "failed", code: "PLATFORM_MISMATCH" };
  }
  if (MOBILE_TERMINAL.includes(build.status)) {
    await fail(base44, job_id, lease_token, `The build is already ${build.status}`, { retryable: false, code: "BUILD_ALREADY_TERMINAL" });
    return { job_id, outcome: "skipped", code: "BUILD_ALREADY_TERMINAL" };
  }
  // Best-effort checksum verification against what storage actually serves. If the artifact_uri
  // is a private file_uri we can sign, a mismatch is a non-retryable failure (the builder reported
  // a checksum that does not match its own output). If we cannot verify, the reported checksum is
  // recorded unchanged — verification is a guardrail, not a gate, for non-private URIs.
  let verified = null;
  try { verified = await verifyStoredPackage(svc, validated.artifact_uri, validated.package_checksum); } catch { verified = null; }
  if (verified === false) {
    await stampBuildFailed(svc, build, "CHECKSUM_MISMATCH", "The reported package_checksum did not match the stored artifact bytes");
    await audit(svc, { workspace_id: build.workspace_id, project_id: build.project_id, user_id: "native-builder", action: "mobile_build.native_checksum_mismatch", resource: "MobileBuild", resource_id: build.id, metadata: { platform: build.platform } }).catch(() => {});
    await fail(base44, job_id, lease_token, "The reported package_checksum did not match the stored artifact bytes", { retryable: false, code: "CHECKSUM_MISMATCH" });
    return { job_id, outcome: "failed", code: "CHECKSUM_MISMATCH" };
  }
  // Compare-and-set on the current non-terminal status: a terminal build is never overwritten and
  // a concurrently-advanced build is never clobbered. Clearing lease_token fences any zombie
  // internal worker whose ownership-checked write would then match no row.
  const claim = await svc.entities.MobileBuild.updateMany(
    { id: build.id, status: build.status },
    { $set: {
      status: "READY", artifact_uri: validated.artifact_uri, package_checksum: validated.package_checksum,
      package_size_bytes: validated.package_size_bytes ?? null,
      signed_at: validated.signed_at || nowIso(),
      signing_secret_name: signingSecretName(build.platform),
      completed_at: nowIso(), heartbeat_at: nowIso(), lease_token: null, lease_expires_at: null,
      failure_code: null, failure_summary: null,
    } },
  ).catch(() => null);
  if (!Number(claim?.updated || 0)) {
    await fail(base44, job_id, lease_token, "The build was already terminal or concurrently advanced", { retryable: false, code: "BUILD_ALREADY_TERMINAL" });
    return { job_id, outcome: "skipped", code: "BUILD_ALREADY_TERMINAL" };
  }
  await audit(svc, {
    workspace_id: build.workspace_id, project_id: build.project_id, user_id: "native-builder",
    action: "mobile_build.native_completed", resource: "MobileBuild", resource_id: build.id,
    metadata: { platform: build.platform, artifact_id: build.artifact_id, artifact_checksum: build.checksum || null, package_checksum: validated.package_checksum, signed_at: validated.signed_at || null, verified },
  }).catch(() => {});
  await complete(base44, job_id, lease_token, { artifact_uri: validated.artifact_uri, package_checksum: validated.package_checksum, platform: validated.platform, signed_at: validated.signed_at || null });
  return { job_id, outcome: "succeeded", build_id: build.id, platform: build.platform, package_checksum: validated.package_checksum, verified };
}