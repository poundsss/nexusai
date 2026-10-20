// P-10.3 phase 3 — mobile release lifecycle.
//
// A release is the publishable identity of a FINISHED mobile build: the READY build's immutable
// binary package plus the release metadata pinned on the build row at request time. The
// lifecycle is deliberately small and server-driven:
//   DRAFT    — created from a READY build; artifact_uri + checksum are copied once and are
//              never rewritten by any later transition (the released artifact is immutable)
//   READY    — the stored package passed checksum verification against what storage serves
//   RELEASED — the ONE live release for (project, platform); releasing supersedes the previous
//              live release by stamping it ROLLED_BACK — never deleting or rewriting it
//   ROLLED_BACK — no longer live; its artifact identity is kept untouched so a rollback can
//              restore the exact bytes
//
// Rollback never rebuilds: it re-verifies the target release's stored package checksum and
// re-activates exactly the bytes that were live before — and only a release that passed READY
// finalization can be a rollback target. Authorization is the EXISTING RBAC deploy.manage
// capability, resolved server-side against the release's project on every transition.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { verifyStoredPackage } from "./mobileArtifacts.ts";

export const MOBILE_RELEASE_STATUSES = ["DRAFT", "READY", "RELEASED", "ROLLED_BACK"];

const nowIso = () => new Date().toISOString();
const trunc = (v, n) => String(v ?? "").slice(0, n);
const releaseFail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const svcOf = (base44) => base44.asServiceRole || base44;

async function releaseRow(svc, release_id) {
  const row = release_id ? await svc.entities.MobileRelease.get(String(release_id)).catch(() => null) : null;
  if (!row) throw releaseFail(404, "RELEASE_NOT_FOUND", "Mobile release not found");
  return row;
}

async function authorizeFor(base44, user, row) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, row.project_id, "deploy.manage");
  if (row.workspace_id !== workspace.id) throw releaseFail(403, "FORBIDDEN", "This release does not belong to your workspace");
  return { project, workspace };
}

/**
 * Creates a DRAFT release pinned to a READY build's immutable package. The build stays the
 * record of what was packaged; the release is its publishable identity — the artifact
 * reference and checksum are copied once and no transition ever rewrites them.
 */
export async function createMobileRelease(base44, user, { build_id, version_name, version_code, release_notes, minimum_os_version } = {}) {
  const svc = svcOf(base44);
  const build = build_id ? await svc.entities.MobileBuild.get(String(build_id)).catch(() => null) : null;
  if (!build) throw releaseFail(404, "BUILD_NOT_FOUND", "Mobile build not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, build.project_id, "deploy.manage");
  if (build.workspace_id !== workspace.id) throw releaseFail(403, "FORBIDDEN", "This build does not belong to your workspace");
  if (build.status !== "READY" || !build.artifact_uri || !build.package_checksum) {
    throw releaseFail(409, "BUILD_NOT_READY", "Only a finished (READY) build can be released");
  }
  const release = await svc.entities.MobileRelease.create({
    workspace_id: workspace.id, project_id: project.id, mobile_build_id: build.id,
    platform: build.platform, status: "DRAFT",
    artifact_uri: build.artifact_uri, checksum: build.package_checksum,
    // Release metadata: pinned from the BUILD at request time; caller overrides are bounded.
    version_name: version_name != null ? trunc(version_name, 100) : (build.version_name ?? null),
    version_code: version_code != null ? Number(version_code) : (build.version_code ?? null),
    release_notes: release_notes != null ? trunc(release_notes, 4000) : (build.release_notes ?? null),
    minimum_os_version: minimum_os_version != null ? trunc(minimum_os_version, 20) : (build.minimum_os_version ?? null),
    created_by: user.id, released_at: null, rolled_back_at: null, superseded_by_release_id: null,
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "mobile_release.created", resource: "MobileRelease", resource_id: release.id,
    metadata: { platform: build.platform, mobile_build_id: build.id, checksum: build.package_checksum, version_name: release.version_name ?? null },
  });
  return { release, build, project };
}

/** DRAFT → READY: the stored package must pass checksum verification against what storage serves. */
export async function readyMobileRelease(base44, user, { release_id } = {}) {
  const svc = svcOf(base44);
  const row = await releaseRow(svc, release_id);
  await authorizeFor(base44, user, row);
  if (row.status !== "DRAFT") throw releaseFail(409, "INVALID_STATE", `Only a draft can be finalized (current status: ${row.status})`);
  const verified = await verifyStoredPackage(svc, row.artifact_uri, row.checksum).catch(() => false);
  if (!verified) throw releaseFail(409, "RELEASE_CHECKSUM_MISMATCH", "The stored package failed checksum verification; the release stays a draft");
  const claim = await svc.entities.MobileRelease.updateMany({ id: row.id, status: "DRAFT" }, { $set: { status: "READY" } });
  if (!Number(claim?.updated || 0)) throw releaseFail(409, "INVALID_STATE", "The release changed state while it was being finalized");
  await audit(svc, {
    workspace_id: row.workspace_id, project_id: row.project_id, user_id: user.id,
    action: "mobile_release.readied", resource: "MobileRelease", resource_id: row.id,
    metadata: { checksum: row.checksum },
  });
  return { release: await svc.entities.MobileRelease.get(row.id) };
}

/** READY → RELEASED: the release becomes the platform's one live release, superseding the previous one. */
export async function releaseMobileRelease(base44, user, { release_id } = {}) {
  const svc = svcOf(base44);
  const row = await releaseRow(svc, release_id);
  await authorizeFor(base44, user, row);
  if (row.status !== "READY") throw releaseFail(409, "INVALID_STATE", `Only a finalized (READY) release can go live (current status: ${row.status})`);
  const claim = await svc.entities.MobileRelease.updateMany(
    { id: row.id, status: "READY" },
    { $set: { status: "RELEASED", released_at: nowIso(), rolled_back_at: null } },
  );
  if (!Number(claim?.updated || 0)) throw releaseFail(409, "INVALID_STATE", "The release changed state while it was being released");
  // Supersede: the previous live release for this platform is stamped ROLLED_BACK — its
  // artifact identity stays untouched, so a rollback can restore the exact bytes.
  const previous = (await svc.entities.MobileRelease.filter({ project_id: row.project_id, platform: row.platform }, "-created_date", 100))
    .find((r) => r.status === "RELEASED" && r.id !== row.id);
  let superseded_release_id = null;
  if (previous) {
    const stamp = await svc.entities.MobileRelease.updateMany(
      { id: previous.id, status: "RELEASED" },
      { $set: { status: "ROLLED_BACK", rolled_back_at: nowIso(), superseded_by_release_id: row.id } },
    );
    if (Number(stamp?.updated || 0)) superseded_release_id = previous.id;
  }
  await audit(svc, {
    workspace_id: row.workspace_id, project_id: row.project_id, user_id: user.id,
    action: "mobile_release.released", resource: "MobileRelease", resource_id: row.id,
    metadata: { platform: row.platform, checksum: row.checksum, superseded_release_id },
  });
  return { release: await svc.entities.MobileRelease.get(row.id), superseded_release_id };
}

/**
 * RELEASED → ROLLED_BACK, restoring the previous finalized release byte-for-byte. No rebuild
 * happens: the target's stored package is re-verified and re-activated exactly as-is, and the
 * target must be a release that passed READY finalization (the most recent other READY or
 * previously-live ROLLED_BACK release of the same platform).
 */
export async function rollbackMobileRelease(base44, user, { release_id } = {}) {
  const svc = svcOf(base44);
  const row = await releaseRow(svc, release_id);
  await authorizeFor(base44, user, row);
  if (row.status !== "RELEASED") throw releaseFail(409, "INVALID_STATE", `Only a live release can be rolled back (current status: ${row.status})`);
  const target = (await svc.entities.MobileRelease.filter({ project_id: row.project_id, platform: row.platform }, "-created_date", 100))
    .find((r) => r.id !== row.id && ["READY", "ROLLED_BACK"].includes(r.status)) || null;
  // The request is audited whether it is accepted or refused.
  await audit(svc, {
    workspace_id: row.workspace_id, project_id: row.project_id, user_id: user.id,
    action: "mobile_release.rollback_requested", resource: "MobileRelease", resource_id: row.id,
    metadata: {
      platform: row.platform, target_release_id: target?.id || null,
      requested_status: target ? "accepted" : "refused",
      refusal_reason: target ? null : "NO_ROLLBACK_TARGET",
    },
  });
  if (!target) throw releaseFail(409, "NO_ROLLBACK_TARGET", "There is no previous release to roll back to");
  // No rebuild: the target's stored package is re-verified, then re-activated EXACTLY as-is.
  const verified = await verifyStoredPackage(svc, target.artifact_uri, target.checksum).catch(() => false);
  if (!verified) throw releaseFail(409, "RELEASE_CHECKSUM_MISMATCH", "The previous release's package failed checksum verification; nothing was changed");
  const claim = await svc.entities.MobileRelease.updateMany(
    { id: row.id, status: "RELEASED" },
    { $set: { status: "ROLLED_BACK", rolled_back_at: nowIso() } },
  );
  if (!Number(claim?.updated || 0)) throw releaseFail(409, "INVALID_STATE", "The release changed state while it was being rolled back");
  await svc.entities.MobileRelease.updateMany(
    { id: target.id },
    { $set: { status: "RELEASED", rolled_back_at: null, superseded_by_release_id: null } },
  );
  return { rolled_back_release_id: row.id, restored_release_id: target.id, restored_checksum: target.checksum };
}

/** Client-safe listing for the owning workspace. Values never leave the server; only release identity does. */
export async function listMobileReleases(base44, user, { project_id, platform } = {}) {
  const svc = svcOf(base44);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "deploy.manage");
  const rows = await svc.entities.MobileRelease.filter(
    { project_id: project.id, ...(platform ? { platform } : {}) }, "-created_date", 200,
  );
  return {
    releases: rows.map((r) => ({
      id: r.id, mobile_build_id: r.mobile_build_id, platform: r.platform, status: r.status,
      version_name: r.version_name ?? null, version_code: r.version_code ?? null,
      checksum: r.checksum, artifact_uri: r.artifact_uri,
      released_at: r.released_at ?? null, rolled_back_at: r.rolled_back_at ?? null,
      created_date: r.created_date,
    })),
  };
}