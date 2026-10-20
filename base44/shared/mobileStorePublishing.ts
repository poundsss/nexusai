// P-10.3 phase 4 — mobile store publishing control plane and worker.
//
// A submission publishes a READY MobileRelease's immutable package to the app store. The
// worker mirrors the mobile build worker exactly — lease + heartbeat + ownership-checked
// writes + bounded recovery — so a lost worker resumes from its persisted checkpoint and a
// terminal state is never overwritten. The store's external submission identity is persisted
// as soon as the adapter returns (BEFORE the terminal SUBMITTED write), so a retry that finds
// it set uploads nothing, and the adapter's content-scoped idempotency key replays to the
// same store identity anyway.
//
// Rollback protection: a terminal submission is history. Re-publishing a release whose
// submission reached a terminal state creates a NEW submission and never modifies the previous
// one; the checksum copied from the release at creation is never rewritten, so the previous
// submission's checksum is preserved exactly. The release itself stays immutable throughout
// (its artifact identity was frozen in phase 3).
//
// Store review automation, in-store pricing and store analytics are DELIBERATELY out of
// scope: the worker drives DRAFT → VALIDATING → UPLOADING → SUBMITTED and stops.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { verifyStoredPackage } from "./mobileArtifacts.ts";
import { readStoreConnection } from "./mobileStoreConnections.ts";
import { storeAdapterFor } from "./mobileStoreAdapters.ts";

export const MOBILE_STORE_TERMINAL = ["SUBMITTED", "RELEASED", "FAILED", "CANCELLED"];
export const MOBILE_STORE_ACTIVE = ["DRAFT", "VALIDATING", "UPLOADING"];
export const MAX_MOBILE_STORE_RECOVERIES = 3;
const LEASE_MS = 150000;
const ITERATION_BUDGET_MS = 60000;

const nowIso = () => new Date().toISOString();
const trunc = (v, n = 500) => String(v ?? "").slice(0, n);
const subFail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const svcOf = (base44) => base44.asServiceRole || base44;
const orderKey = (s) => `${s.created_date || ""}|${s.id}`;

export const storeOf = (platform) => (platform === "ios" ? "app_store" : "google_play");

const validVersionMetadata = (s) =>
  !!s.version_name && /^[\w.\-+ ]{1,100}$/.test(String(s.version_name)) &&
  Number.isInteger(Number(s.version_code)) && Number(s.version_code) >= 1;

async function releaseRow(svc, release_id) {
  const row = release_id ? await svc.entities.MobileRelease.get(String(release_id)).catch(() => null) : null;
  if (!row) throw subFail(404, "RELEASE_NOT_FOUND", "Mobile release not found");
  return row;
}

async function submissionRow(svc, submission_id) {
  const row = submission_id ? await svc.entities.MobileStoreSubmission.get(String(submission_id)).catch(() => null) : null;
  if (!row) throw subFail(404, "SUBMISSION_NOT_FOUND", "Store submission not found");
  return row;
}

async function authorizeFor(base44, user, row) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, row.project_id, "deploy.manage");
  if (row.workspace_id !== workspace.id) throw subFail(403, "FORBIDDEN", "This submission does not belong to your workspace");
  return { project, workspace };
}

// --- lease (same contract as the mobile build and deployment workers) ----------
async function claimLease(svc, submission) {
  const now = Date.now();
  const held = Date.parse(submission.lease_expires_at || "");
  if (Number.isFinite(held) && held > now) return { token: null, reclaiming: false };
  const reclaiming = Number.isFinite(held) && held <= now && !!submission.lease_token;
  const token = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  await svc.entities.MobileStoreSubmission.update(submission.id, { lease_token: token, lease_expires_at: new Date(now + LEASE_MS).toISOString() });
  const check = await svc.entities.MobileStoreSubmission.get(submission.id);
  return { token: check.lease_token === token ? token : null, reclaiming };
}

const MOBILE_STORE_OWNERSHIP_LOST = "MOBILE_STORE_OWNERSHIP_LOST";
const ownershipLost = () => Object.assign(new Error("store submission lease ownership was lost"), { code: MOBILE_STORE_OWNERSHIP_LOST });

const releaseLease = (svc, id, token) => (token
  ? svc.entities.MobileStoreSubmission.updateMany({ id, lease_token: token }, { $set: { lease_token: null, lease_expires_at: null } }).catch(() => {})
  : Promise.resolve());

// --- creation -------------------------------------------------------------------
/**
 * THE authorized "submit this release to the store" request: the ONE place a submission is
 * created. Authorization is the EXISTING deploy.manage capability resolved server-side
 * against the release's project. The submission pins the release's immutable identity
 * (checksum + version metadata) at creation and never re-reads the project's mutable state.
 * At most one ACTIVE submission per release: duplicates converge on the existing row, and a
 * re-create after a TERMINAL submission produces a NEW row — the previous one is never
 * modified (rollback protection).
 */
export async function createMobileStoreSubmission(base44, user, { release_id } = {}) {
  const svc = svcOf(base44);
  const release = await releaseRow(svc, release_id);
  const { project, workspace } = await loadAuthorizedProject(base44, user, release.project_id, "deploy.manage");
  if (release.workspace_id !== workspace.id) throw subFail(403, "FORBIDDEN", "This release does not belong to your workspace");
  if (release.status !== "READY") throw subFail(409, "RELEASE_NOT_READY", "Only a finalized (READY) release can be submitted to a store");

  const existing = (await svc.entities.MobileStoreSubmission.filter({ mobile_release_id: release.id }, "-created_date", 50))
    .find((s) => MOBILE_STORE_ACTIVE.includes(s.status));
  if (existing) return { submission: existing, converged: true, release };

  const prior = await svc.entities.MobileStoreSubmission.filter({ mobile_release_id: release.id }, "-created_date", 500);
  // Content-scoped idempotency key: a re-created submission for the same release replays to the
  // SAME store identity instead of uploading a duplicate.
  const idempotency_key = `mobile_store:${release.id}:${release.checksum}`;
  const submission = await svc.entities.MobileStoreSubmission.create({
    workspace_id: workspace.id, project_id: project.id, mobile_release_id: release.id,
    platform: release.platform, status: "DRAFT", store: storeOf(release.platform),
    external_submission_id: null, checksum: release.checksum,
    version_name: release.version_name ?? null, version_code: release.version_code ?? null,
    failure_code: null, failure_message: null,
    idempotency_key, cancel_requested: false, recovery_count: 0, created_by: user.id,
    started_at: null, submitted_at: null, completed_at: null,
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "mobile_store.submission_created", resource: "MobileStoreSubmission", resource_id: submission.id,
    metadata: {
      platform: release.platform, store: storeOf(release.platform),
      mobile_release_id: release.id, checksum: release.checksum,
      version_name: release.version_name ?? null, idempotency_key,
    },
  });
  // Converge the check-then-create race: an earlier active submission keeps the release and
  // this duplicate deterministically cancels its OWN row.
  const converged = await convergeMobileStoreSubmission(svc, { release, submission });
  if (converged.cancelled) {
    return { submission: converged.winner, converged: true, release };
  }
  return { submission: converged.submission, converged: false, release };
}

async function convergeMobileStoreSubmission(svc, { release, submission }) {
  const rows = await svc.entities.MobileStoreSubmission.filter({ mobile_release_id: release.id }, "-created_date", 50);
  const mine = rows.find((s) => s.id === submission.id) || submission;
  const twin = rows.find((s) =>
    s.id !== submission.id && MOBILE_STORE_ACTIVE.includes(s.status) && orderKey(s) < orderKey(mine));
  if (!twin) return { cancelled: false, submission: mine };
  const claim = await svc.entities.MobileStoreSubmission.updateMany(
    { id: submission.id, status: "DRAFT" },
    { $set: {
      status: "CANCELLED", failure_code: "SUPERSEDED_BY_CONCURRENT_REQUEST",
      failure_message: "Another submission for this release was already in progress; this duplicate was dropped.",
      completed_at: nowIso(), heartbeat_at: nowIso(),
    } },
  ).catch(() => null);
  if (!Number(claim?.updated || 0)) return { cancelled: false, submission: mine, contested: true };
  return { cancelled: true, submission: mine, winner: twin };
}

/** Durable cancellation intent: honoured by the worker only before the store accepts the upload. */
export async function cancelMobileStoreSubmission(base44, user, { submission_id } = {}) {
  const svc = svcOf(base44);
  const row = await submissionRow(svc, submission_id);
  await authorizeFor(base44, user, row);
  if (MOBILE_STORE_TERMINAL.includes(row.status)) {
    throw subFail(409, "INVALID_STATE", `A terminal submission cannot be cancelled (current status: ${row.status})`);
  }
  const claim = await svc.entities.MobileStoreSubmission.updateMany(
    { id: row.id, cancel_requested: false },
    { $set: { cancel_requested: true } },
  );
  if (!Number(claim?.updated || 0)) throw subFail(409, "INVALID_STATE", "The submission was already cancelled");
  return { submission_id: row.id, cancel_requested: true };
}

/** Client-safe listing for the owning workspace, scoped to the authorized project. */
export async function listMobileStoreSubmissions(base44, user, { project_id, platform } = {}) {
  const svc = svcOf(base44);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "deploy.manage");
  const rows = await svc.entities.MobileStoreSubmission.filter(
    { project_id: project.id, ...(platform ? { platform } : {}) }, "-created_date", 200,
  );
  return {
    submissions: rows.map((s) => ({
      id: s.id, mobile_release_id: s.mobile_release_id, platform: s.platform, store: s.store, status: s.status,
      external_submission_id: s.external_submission_id ?? null,
      version_name: s.version_name ?? null, version_code: s.version_code ?? null,
      checksum: s.checksum, failure_code: s.failure_code ?? null, failure_message: s.failure_message ?? null,
      submitted_at: s.submitted_at ?? null, created_date: s.created_date,
    })),
  };
}

// --- the publishing worker -------------------------------------------------------
const AUDIT_BY_STATUS = {
  SUBMITTED: "mobile_store.submitted",
  FAILED: "mobile_store.failed",
  CANCELLED: "mobile_store.cancelled",
};

/**
 * Advances one submission as far as it can inside a single request, persisting every phase
 * transition. A killed worker resumes exactly where it stopped; terminal states are never
 * overwritten; ownership-checked writes mean a zombie whose lease was reclaimed can never write
 * an outcome behind the new owner's back.
 */
export async function runMobileStorePublishStep(svc, submissionId) {
  let submission = await svc.entities.MobileStoreSubmission.get(submissionId);
  if (!submission) throw new Error(`Store submission not found: ${submissionId}`);
  if (MOBILE_STORE_TERMINAL.includes(submission.status)) return { submission_id: submissionId, done: true, status: submission.status };

  const { token, reclaiming } = await claimLease(svc, submission);
  if (!token) return { submission_id: submissionId, done: false, busy: true, status: submission.status };
  const started = Date.now();

  const patch = async (data) => {
    const payload = { ...data, heartbeat_at: nowIso(), lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString() };
    // Ownership-checked write: only THIS worker's lease may advance the submission.
    const claim = await svc.entities.MobileStoreSubmission.updateMany({ id: submission.id, lease_token: token }, { $set: payload });
    if (!Number(claim?.updated || 0)) throw ownershipLost();
    Object.assign(submission, payload);
    return submission;
  };

  const finish = async (status, extra = {}) => {
    const startedMs = Date.parse(submission.started_at || submission.created_date);
    // Ownership-checked TERMINAL write: a worker that lost its lease updates zero rows.
    const claim = await svc.entities.MobileStoreSubmission.updateMany(
      { id: submission.id, lease_token: token },
      { $set: {
        status, completed_at: nowIso(),
        duration_ms: Number.isFinite(startedMs) ? Date.now() - startedMs : 0,
        heartbeat_at: nowIso(), lease_token: null, lease_expires_at: null, ...extra,
      } },
    );
    if (!Number(claim?.updated || 0)) return { submission_id: submissionId, done: false, busy: true, ownership_lost: true, status: "skipped" };
    await audit(svc, {
      workspace_id: submission.workspace_id, project_id: submission.project_id,
      user_id: submission.created_by || "platform",
      action: AUDIT_BY_STATUS[status] || "mobile_store.failed",
      resource: "MobileStoreSubmission", resource_id: submission.id,
      metadata: {
        store: submission.store, platform: submission.platform, mobile_release_id: submission.mobile_release_id,
        checksum: submission.checksum || null, failure_code: extra?.failure_code || null,
        ...(extra?.external_submission_id ? { external_submission_id: extra.external_submission_id } : {}),
      },
    }).catch(() => {});
    return { submission_id: submissionId, done: true, status };
  };

  try {
    // Bounded recovery: a worker re-claiming an expired lease it did not hold counts as one
    // recovery; past the ceiling the submission fails terminally instead of retrying forever.
    if (reclaiming) {
      const recoveries = (Number(submission.recovery_count) || 0) + 1;
      if (recoveries > MAX_MOBILE_STORE_RECOVERIES) {
        return await finish("FAILED", { failure_code: "WORKER_LOST", failure_message: "The publishing worker was recovered too many times; the submission failed terminally." });
      }
      const claimPatch = await svc.entities.MobileStoreSubmission.updateMany(
        { id: submission.id, lease_token: token },
        { $set: { recovery_count: recoveries, heartbeat_at: nowIso() } },
      );
      if (!Number(claimPatch?.updated || 0)) return { submission_id: submissionId, done: false, busy: true, ownership_lost: true, status: "skipped" };
      submission.recovery_count = recoveries;
    }

    while (Date.now() - started < ITERATION_BUDGET_MS) {
      submission = await svc.entities.MobileStoreSubmission.get(submissionId);
      if (MOBILE_STORE_TERMINAL.includes(submission.status)) return { submission_id: submissionId, done: true, status: submission.status };
      if (submission.lease_token !== token) return { submission_id: submissionId, done: false, busy: true, status: submission.status };

      // Cancellation is honoured only before the store accepts the upload: once a submission is
      // SUBMITTED it is history, and history is never rewritten.
      if (submission.cancel_requested) {
        return await finish("CANCELLED", { failure_code: "CANCELLED", failure_message: "Cancelled before the store accepted the upload." });
      }

      if (submission.status === "DRAFT") {
        await patch({ status: "VALIDATING", started_at: submission.started_at || nowIso() });
        continue;
      }

      if (submission.status === "VALIDATING") {
        // Every pre-upload check fails closed — a submission that cannot prove its package,
        // its signing, its metadata and its store connection NEVER reaches the store.
        const release = await svc.entities.MobileRelease.get(submission.mobile_release_id).catch(() => null);
        if (!release || release.workspace_id !== submission.workspace_id || release.project_id !== submission.project_id) {
          return await finish("FAILED", { failure_code: "RELEASE_NOT_FOUND", failure_message: "The release this submission publishes no longer resolves to this project." });
        }
        if (release.status !== "READY") {
          return await finish("FAILED", { failure_code: "RELEASE_NOT_READY", failure_message: `The release is ${release.status}; only a finalized release can be submitted.` });
        }
        if (!validVersionMetadata(submission)) {
          return await finish("FAILED", { failure_code: "INVALID_PACKAGE_METADATA", failure_message: "The package metadata (version name / version code) is missing or invalid." });
        }
        const verified = await verifyStoredPackage(svc, release.artifact_uri, release.checksum).catch(() => false);
        if (!verified) {
          return await finish("FAILED", { failure_code: "RELEASE_CHECKSUM_MISMATCH", failure_message: "The stored package failed checksum verification; nothing was uploaded." });
        }
        const build = await svc.entities.MobileBuild.get(release.mobile_build_id).catch(() => null);
        if (!build || build.status !== "READY" || !build.signed_at) {
          return await finish("FAILED", { failure_code: "SIGNING_INCOMPLETE", failure_message: "The release's build has no completed signing; nothing was uploaded." });
        }
        const connection = await readStoreConnection(svc, submission.workspace_id, submission.platform);
        if (!connection) {
          return await finish("FAILED", {
            failure_code: "STORE_NOT_CONFIGURED",
            failure_message: `No ${submission.platform === "ios" ? "App Store" : "Google Play"} connection is configured for this workspace; the submission failed closed.`,
          });
        }
        try {
          storeAdapterFor(submission.platform).validate(connection);
        } catch (e) {
          return await finish("FAILED", { failure_code: e.code || "STORE_AUTH_FAILED", failure_message: trunc(e.message, 400) });
        }
        await patch({ status: "UPLOADING" });
        continue;
      }

      if (submission.status === "UPLOADING") {
        // Idempotent upload: the external identity is persisted as soon as the adapter returns —
        // BEFORE the terminal write — so a worker that dies in between resumes by SKIPPING the
        // upload entirely. The adapter is keyed by the content-scoped idempotency key, so even a
        // retry that re-calls the adapter replays to the same store identity.
        if (!submission.external_submission_id) {
          const connection = await readStoreConnection(svc, submission.workspace_id, submission.platform);
          await audit(svc, {
            workspace_id: submission.workspace_id, project_id: submission.project_id,
            user_id: submission.created_by || "platform",
            action: "mobile_store.upload_started", resource: "MobileStoreSubmission", resource_id: submission.id,
            metadata: { store: submission.store, platform: submission.platform, idempotency_key: submission.idempotency_key },
          }).catch(() => {});
          const out = await storeAdapterFor(submission.platform).upload(connection, {
            idempotency_key: submission.idempotency_key,
            version_name: submission.version_name, version_code: submission.version_code,
            checksum: submission.checksum,
          });
          await patch({ external_submission_id: out.external_submission_id });
        }
        return await finish("SUBMITTED", {
          external_submission_id: submission.external_submission_id, submitted_at: nowIso(),
          failure_code: null, failure_message: null,
        });
      }

      return { submission_id: submissionId, done: false, status: submission.status };
    }
    return { submission_id: submissionId, done: false, status: submission.status };
  } catch (e) {
    if (e?.code === MOBILE_STORE_OWNERSHIP_LOST) {
      return { submission_id: submissionId, done: false, busy: true, ownership_lost: true, status: "skipped" };
    }
    return await finish("FAILED", { failure_code: e.code === "STORE_NOT_CONFIGURED" || e.code === "STORE_AUTH_FAILED" ? e.code : "UPLOAD_ERROR", failure_message: trunc(e.message, 400) });
  } finally {
    await releaseLease(svc, submissionId, token);
  }
}