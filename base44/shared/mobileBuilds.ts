// P-10.3 Phase 1 — native mobile build infrastructure.
//
// A mobile build packages an ALREADY-BUILT app: its source is the EXISTING immutable
// DeploymentArtifact the named deployment serves — never the project's mutable working files —
// so what was verified on the web is byte-exact what gets packaged. The build row pins
// artifact_id + checksum at request time; a later edit to the project cannot change an
// in-flight or finished build, and the worker re-loads the artifact payload from its immutable
// payload_url on every attempt.
//
// The worker lifecycle mirrors the deployment pipeline exactly (lease + heartbeat +
// ownership-checked writes + bounded recovery), so a lost worker resumes from its persisted
// checkpoint instead of leaving a build half-done, and a terminal state is never overwritten.
// The package step itself is a deterministic Phase-1 PLACEHOLDER: App Store / Play signing,
// publishing and native runtime auth are later phases and deliberately absent.
//
// The plan's daily mobile-build ceiling (limits.mobile_builds_per_day) is enforced exactly like
// deployments_per_day: resolved server-side from the workspace's plan, fail-closed before any
// state is written, and concurrency-safe (createMobileBuildWithinLimit re-derives today's count
// after the row exists).
import { loadAuthorizedProject, audit } from "./authz.ts";
import { enforceLimit, identityFor } from "./apiLimits.ts";
import { assertMobileBuildQuota, createMobileBuildWithinLimit, assertMobileStoreFilesEntitlement } from "./planLimits.ts";
import { loadArtifactPayload } from "./deploy.ts";
import { readSigningCredential, signingSecretName } from "./mobileSigning.ts";
import { buildMobilePackageInput, packageBytes, sha256Hex, packBinaryPackage, verifyStoredPackage, createPackageDownloadUrl } from "./mobileArtifacts.ts";

export const MOBILE_BUILD_TERMINAL = ["READY", "FAILED", "CANCELLED"];
export const MOBILE_BUILD_ACTIVE = ["QUEUED", "BUILDING", "SIGNING"];
export const MOBILE_PLATFORMS = ["ios", "android"];
const LEASE_MS = 150000;
const ITERATION_BUDGET_MS = 60000;
export const MAX_MOBILE_BUILD_RECOVERIES = 3;

const trunc = (v, n = 500) => String(v ?? "").slice(0, n);

/**
 * Release metadata (P-10.3 phase 3): the optional publishable identity of the release this
 * build feeds. Validated and pinned at request time exactly like the artifact — a later edit
 * cannot change a finished build's release identity.
 */
export function normalizeReleaseMetadata({ version_name, version_code, release_notes, minimum_os_version } = {}) {
  const name = version_name == null ? null : String(version_name).trim();
  if (name !== null && !/^[\w.\-+ ]{1,100}$/.test(name)) {
    throw mobileFail(400, "INVALID_RELEASE_METADATA", "version_name must be 1-100 word/dot/dash characters");
  }
  const code = version_code == null ? null : Number(version_code);
  if (code !== null && (!Number.isInteger(code) || code < 1 || code > 2147483647)) {
    throw mobileFail(400, "INVALID_RELEASE_METADATA", "version_code must be a positive integer");
  }
  return {
    version_name: name,
    version_code: code,
    release_notes: release_notes == null ? null : trunc(String(release_notes), 4000),
    minimum_os_version: minimum_os_version == null ? null : trunc(String(minimum_os_version), 20),
  };
}
const mobileFail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const orderKey = (b) => `${b.created_date || ""}|${b.id}`;

/**
 * THE authorized "package this deployment for a native platform" request — the one place a
 * mobile build is created. Applies the same authorization (deploy.manage), the same per-caller
 * rate limit, the same fail-closed lifecycle check and the same plan ceiling as a web deploy,
 * then pins the build to the deployment's immutable artifact.
 */
export async function requestMobileBuild(base44, user, { project_id, deployment_id, platform, version_name, version_code, release_notes, minimum_os_version } = {}) {
  if (!MOBILE_PLATFORMS.includes(platform)) {
    throw mobileFail(400, "INVALID_PLATFORM", `platform must be one of: ${MOBILE_PLATFORMS.join(", ")}`);
  }
  const releaseMeta = normalizeReleaseMetadata({ version_name, version_code, release_notes, minimum_os_version });
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "deploy.manage");
  const svc = base44.asServiceRole || base44;
  // Plan entitlement (DOCUMENTED Base44: downloading files for app-store submission requires
  // Builder or higher). Resolved server-side from the workspace's effective plan before any
  // request state is read or written; the existing daily-quota gate still runs below.
  await assertMobileStoreFilesEntitlement(base44, workspace);
  await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspace.id }), action: "deploy", workspace_id: workspace.id });
  // Fail-closed lifecycle check, before any request state is read or written.
  if (workspace.status && workspace.status !== "active") {
    throw mobileFail(402, "WORKSPACE_NOT_ENTITLED", `Workspace is ${workspace.status}; mobile builds are suspended`);
  }
  // Plan entitlement: the daily ceiling comes only from the server-side plan.
  await assertMobileBuildQuota(base44, workspace);

  // The deployment must belong to this project — a deployment id from another project is
  // simply not found, so a build can never cross projects.
  const deployment = deployment_id ? await svc.entities.Deployment.get(deployment_id).catch(() => null) : null;
  if (!deployment || deployment.project_id !== project.id) {
    throw mobileFail(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found in this project");
  }
  // Pin the build to the immutable artifact that deployment serves. No artifact means there is
  // nothing verified to package — the request fails before any row is created.
  const artifact_id = deployment.artifact_id;
  if (!artifact_id) {
    throw mobileFail(400, "NO_ARTIFACT", "That deployment has no built artifact to package");
  }
  const artifact = await svc.entities.DeploymentArtifact.get(artifact_id).catch(() => null);
  if (!artifact || artifact.project_id !== project.id) {
    throw mobileFail(404, "ARTIFACT_NOT_FOUND", "The pinned artifact no longer exists in this project");
  }

  // One active build per (project, platform): two builds can never half-replace each other.
  const recent = await svc.entities.MobileBuild.filter({ project_id: project.id }, "-created_date", 40);
  const active = recent.find((b) => MOBILE_BUILD_ACTIVE.includes(b.status) && b.platform === platform);
  if (active) {
    throw mobileFail(409, "MOBILE_BUILD_IN_PROGRESS", `An ${platform} build is already in progress for this project`, { build_id: active.id });
  }

  const now = new Date().toISOString();
  // createMobileBuildWithinLimit re-derives today's count after the row exists, so racing
  // requests that both passed the early quota check cannot land past the ceiling.
  const build = await createMobileBuildWithinLimit(base44, workspace, {
    project_id: project.id, deployment_id: deployment.id, artifact_id,
    platform, status: "QUEUED", checksum: artifact.checksum, version_number: deployment.version_number ?? null,
    ...releaseMeta,
    failure_code: null, recovery_count: 0, created_by: user.id,
    heartbeat_at: now, started_at: null,
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "mobile_build.requested", resource: "MobileBuild", resource_id: build.id,
    metadata: {
      platform, deployment_id: deployment.id, artifact_id,
      artifact_checksum: artifact.checksum, version_number: deployment.version_number ?? null,
    },
  });
  // Converge the check-then-create race: if an earlier build of this platform is already
  // active, this request loses deterministically — its row is cancelled and the caller sees the
  // same in-progress error the guard above already produces.
  const converged = await convergeMobileBuildRequest(svc, { project_id: project.id, platform, build });
  if (converged.cancelled) {
    throw mobileFail(409, "MOBILE_BUILD_IN_PROGRESS", `An ${platform} build is already in progress for this project`, { build_id: converged.winner.id });
  }
  return { build: converged.build, project, workspace, deployment, artifact };
}

/**
 * Convergence for the check-then-create race — the same deterministic first-request-wins rule
 * as deployments: an active build created EARLIER keeps the platform, and a request that finds
 * one cancels its OWN row (compare-and-set on status QUEUED, so a twin a worker already started
 * is left to the worker's ownership rules).
 */
export async function convergeMobileBuildRequest(svc, { project_id, platform, build }) {
  const rows = await svc.entities.MobileBuild.filter({ project_id }, "-created_date", 40);
  const mine = rows.find((b) => b.id === build.id) || build;
  const twin = rows.find((b) =>
    b.id !== build.id && MOBILE_BUILD_ACTIVE.includes(b.status) &&
    b.platform === platform && orderKey(b) < orderKey(mine));
  if (!twin) return { cancelled: false, build: mine };
  const claim = await svc.entities.MobileBuild.updateMany(
    { id: build.id, status: "QUEUED" },
    { $set: {
      status: "CANCELLED", failure_code: "SUPERSEDED_BY_CONCURRENT_REQUEST",
      failure_summary: "Another build of this platform was already in progress; this duplicate request was dropped.",
      completed_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    } },
  ).catch(() => null);
  if (!Number(claim?.updated || 0)) return { cancelled: false, build: mine, contested: true };
  return { cancelled: true, build: mine, winner: twin };
}

// --- lease (same contract as the deployment and agent workers) ----------------
async function claimLease(svc, build) {
  const now = Date.now();
  const held = Date.parse(build.lease_expires_at || "");
  if (Number.isFinite(held) && held > now) return { token: null, reclaiming: false };
  // An expired lease that was previously HELD means a worker died mid-flight: this claim is a
  // bounded recovery, not a first start.
  const reclaiming = Number.isFinite(held) && held <= now && !!build.lease_token;
  const token = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  await svc.entities.MobileBuild.update(build.id, { lease_token: token, lease_expires_at: new Date(now + LEASE_MS).toISOString() });
  const check = await svc.entities.MobileBuild.get(build.id);
  return { token: check.lease_token === token ? token : null, reclaiming };
}

const MOBILE_OWNERSHIP_LOST = "MOBILE_OWNERSHIP_LOST";
const ownershipLost = () => Object.assign(new Error("mobile build lease ownership was lost"), { code: MOBILE_OWNERSHIP_LOST });

const releaseLease = (svc, id, token) => (token
  ? svc.entities.MobileBuild.updateMany({ id, lease_token: token }, { $set: { lease_token: null, lease_expires_at: null } }).catch(() => {})
  : Promise.resolve());

/**
 * Advances one mobile build as far as it can inside a single request, persisting every phase
 * transition. A killed worker resumes exactly where it stopped; terminal states are never
 * overwritten; ownership-checked writes mean a zombie whose lease was reclaimed can never write
 * an outcome behind the new owner's back.
 */
export async function runMobileBuildStep(svc, buildId) {
  let build = await svc.entities.MobileBuild.get(buildId);
  if (!build) throw new Error(`Mobile build not found: ${buildId}`);
  if (MOBILE_BUILD_TERMINAL.includes(build.status)) return { build_id: buildId, done: true, status: build.status };

  const { token, reclaiming } = await claimLease(svc, build);
  if (!token) return { build_id: buildId, done: false, busy: true, status: build.status };
  const started = Date.now();

  const patch = async (data) => {
    const payload = { ...data, heartbeat_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString() };
    // Ownership-checked write: only THIS worker's lease may advance the build.
    const claim = await svc.entities.MobileBuild.updateMany({ id: build.id, lease_token: token }, { $set: payload });
    if (!Number(claim?.updated || 0)) throw ownershipLost();
    Object.assign(build, payload);
    return build;
  };

  const finish = async (status, extra = {}) => {
    const startedMs = Date.parse(build.started_at || build.created_date);
    // Ownership-checked TERMINAL write: a worker that lost its lease updates zero rows and
    // reports the loss instead of writing an outcome behind the new owner's back.
    const claim = await svc.entities.MobileBuild.updateMany(
      { id: build.id, lease_token: token },
      { $set: {
        status, completed_at: new Date().toISOString(),
        duration_ms: Number.isFinite(startedMs) ? Date.now() - startedMs : 0,
        heartbeat_at: new Date().toISOString(), lease_token: null, lease_expires_at: null, ...extra,
      } },
    );
    if (!Number(claim?.updated || 0)) return { build_id: buildId, done: false, busy: true, ownership_lost: true, status: "skipped" };
    await audit(svc, {
      workspace_id: build.workspace_id, project_id: build.project_id, user_id: build.created_by || "platform",
      action: status === "READY" ? "mobile_build.completed" : "mobile_build.failed",
      resource: "MobileBuild", resource_id: build.id,
      metadata: {
        platform: build.platform, artifact_id: build.artifact_id, artifact_checksum: build.checksum || null,
        failure_code: extra?.failure_code || null, ...(extra?.artifact_uri ? { artifact_uri: extra.artifact_uri } : {}),
      },
    }).catch(() => {});
    return { build_id: buildId, done: true, status };
  };

  try {
    // Bounded recovery: a worker re-claiming an expired lease it did not hold counts as one
    // recovery; past the ceiling the build fails terminally instead of retrying forever.
    if (reclaiming) {
      const recoveries = (Number(build.recovery_count) || 0) + 1;
      if (recoveries > MAX_MOBILE_BUILD_RECOVERIES) {
        return await finish("FAILED", { failure_code: "WORKER_LOST", failure_summary: "The build worker was recovered too many times; the build failed terminally." });
      }
      const claimPatch = await svc.entities.MobileBuild.updateMany(
        { id: build.id, lease_token: token },
        { $set: { recovery_count: recoveries, heartbeat_at: new Date().toISOString() } },
      );
      if (!Number(claimPatch?.updated || 0)) return { build_id: buildId, done: false, busy: true, ownership_lost: true, status: "skipped" };
      build.recovery_count = recoveries;
    }

    while (Date.now() - started < ITERATION_BUDGET_MS) {
      build = await svc.entities.MobileBuild.get(buildId);
      if (MOBILE_BUILD_TERMINAL.includes(build.status)) return { build_id: buildId, done: true, status: build.status };
      if (build.lease_token !== token) return { build_id: buildId, done: false, busy: true, status: build.status };

      if (build.status === "QUEUED") {
        await patch({ status: "BUILDING", started_at: build.started_at || new Date().toISOString() });
        continue;
      }

      if (build.status === "BUILDING") {
        // The package is derived ONLY from the immutable pinned artifact — the worker never
        // reads the project's mutable working files. A corrupt or missing payload is terminal
        // for THIS build only; nothing else is touched.
        let payload;
        try {
          const artifact = await svc.entities.DeploymentArtifact.get(build.artifact_id).catch(() => null);
          payload = await loadArtifactPayload(artifact || { payload_url: null });
        } catch (e) {
          return await finish("FAILED", { failure_code: "ARTIFACT_ERROR", failure_summary: "The pinned artifact could not be loaded. Nothing was built." });
        }
        if (!payload || !Array.isArray(payload.client_files) || !payload.client_files.length) {
          return await finish("FAILED", { failure_code: "ARTIFACT_ERROR", failure_summary: "The pinned artifact has no client files to package." });
        }
        // Deterministic mobile bundle input, derived ONLY from the immutable artifact payload
        // and its identity — canonical bytes, so the same artifact always packages to the same
        // checksum.
        const pkgInput = buildMobilePackageInput({
          platform: build.platform, artifactId: build.artifact_id, artifactChecksum: build.checksum,
          versionNumber: build.version_number ?? null, payload,
        });
        const bytes = packageBytes(pkgInput);
        const package_checksum = await sha256Hex(bytes);
        const pkgFields = {
          status: "SIGNING", package_checksum, package_size_bytes: bytes.length,
          version_number: build.version_number ?? null,
        };
        if (!build.artifact_uri) {
          // Private BINARY storage, separate from the JSON/file-content store: content-addressed
          // name, immutable reference once stored, signed expiring URLs only.
          const file_uri = await packBinaryPackage(svc, `mobile-package-${build.platform}-${package_checksum.slice(0, 12)}.mobpkg`, bytes);
          // Checksum verification against what storage actually serves, before the phase is
          // committed.
          const verified = await verifyStoredPackage(svc, file_uri, package_checksum).catch(() => false);
          if (!verified) {
            return await finish("FAILED", { failure_code: "ARTIFACT_ERROR", failure_summary: "The packaged artifact failed checksum verification in storage. Nothing was built." });
          }
          await patch({ ...pkgFields, artifact_uri: file_uri });
        } else {
          await patch(pkgFields);
        }
        continue;
      }

      if (build.status === "SIGNING") {
        // Resolve the workspace's signing credentials SERVER-SIDE; a missing credential fails
        // closed — the build never degrades to an unsigned artifact.
        const credential = await readSigningCredential(svc, build.workspace_id, build.platform);
        if (!credential) {
          return await finish("FAILED", {
            failure_code: "MISSING_SIGNING_CREDENTIALS",
            failure_summary: `No ${build.platform} signing credential is configured for this workspace; the build failed closed.`,
          });
        }
        // The package is NOT cryptographically signed here: Base44 configures the signing key and
        // Bundle ID inside the generated IPA/AAB opaquely, so no signed_at is stamped by this
        // worker. The row records only the credential IDENTITY (signing_secret_name) — the
        // credential value never appears on the row — and stays READY. A downstream store upload
        // that requires a completed signature therefore fails closed through the existing
        // SIGNING_INCOMPLETE check (signed_at absent) until an external/Base44-managed signature
        // is recorded on the build.
        return await finish("READY", {
          artifact_uri: build.artifact_uri, checksum: build.checksum,
          package_checksum: build.package_checksum || null, package_size_bytes: build.package_size_bytes ?? null,
          version_number: build.version_number ?? null,
          signing_secret_name: signingSecretName(build.platform),
          failure_code: null, failure_summary: null,
        });
      }

      return { build_id: buildId, done: false, status: build.status };
    }
    return { build_id: buildId, done: false, status: build.status };
  } catch (e) {
    if (e?.code === MOBILE_OWNERSHIP_LOST) {
      return { build_id: buildId, done: false, busy: true, ownership_lost: true, status: "skipped" };
    }
    return await finish("FAILED", { failure_code: "BUILD_ERROR", failure_summary: trunc(e.message, 400) });
  } finally {
    await releaseLease(svc, buildId, token);
  }
}

/**
 * Secure download of a finished mobile package. Only a member of the OWNING workspace with
 * deploy permission passes — authorization is resolved server-side from the build's project —
 * and the URL itself is signed and short-lived. The stored reference is immutable; expiry is
 * the only way a URL stops working.
 */
export async function createMobileArtifactDownloadUrl(base44, user, { build_id, expires_in } = {}) {
  const svc = base44.asServiceRole || base44;
  const build = build_id ? await svc.entities.MobileBuild.get(build_id).catch(() => null) : null;
  if (!build) throw mobileFail(404, "BUILD_NOT_FOUND", "Mobile build not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, build.project_id, "deploy.manage");
  // Plan entitlement (DOCUMENTED Base44: downloading files for app-store submission requires
  // Builder or higher). Resolved server-side; the existing membership/deploy.manage check above
  // still runs unchanged.
  await assertMobileStoreFilesEntitlement(base44, workspace);
  if (build.workspace_id !== project.workspace_id) {
    throw mobileFail(403, "FORBIDDEN", "This build does not belong to your workspace");
  }
  if (build.status !== "READY" || !build.artifact_uri) {
    throw mobileFail(409, "NOT_READY", "This build has no finished package yet");
  }
  const { signed_url, expires_in: ttl } = await createPackageDownloadUrl(svc, build.artifact_uri, expires_in);
  return {
    signed_url, expires_in: ttl,
    platform: build.platform,
    package_checksum: build.package_checksum || null,
    source_artifact_checksum: build.checksum || null,
    version_number: build.version_number ?? null,
    package_size_bytes: build.package_size_bytes ?? null,
  };
}