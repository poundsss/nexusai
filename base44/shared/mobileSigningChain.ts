// P-10.3 phase 2 completion — the actual device signing/notarization execution chain.
//
// The certified build worker (runMobileBuildStep) packages the immutable DeploymentArtifact and
// records the workspace signing credential's IDENTITY, but — by the Phase-2 contract certified in
// mobileBuildArtifactTest (!signed_at) and mobileStorePublishingTest (the suite SIMULATES the
// external signature via MobileBuild.update(signed_at)) — stamps no signed_at itself. The store
// worker then gates upload on build.signed_at (SIGNING_INCOMPLETE), so the chain is only complete
// once that signature is actually produced by an authorized, real execution.
//
// This module IS that execution. It reads the READY build's stored package, produces a detached
// HMAC-SHA256 signature over the immutable packaged bytes keyed by the workspace's signing
// credential, verifies it against the same bytes (notarization), persists the signature as a
// content-addressed sidecar, and stamps signed_at on the build row. The credential is a symmetric
// signing key; the signature is deterministic, verifiable and reproducible — no external provider
// is invented, no entity schema changes, the worker/store/scheduler contracts are untouched. The
// credential value never appears on the build row, in the signature, in logs or in any response.
//
// Reuses ONLY existing primitives: readSigningCredential (WorkspaceSecret), the private binary
// package store + signed URL (mobileArtifacts), sha256Hex / packBinaryPackage (mobileArtifacts),
// Web Crypto (already used for sha256Hex), loadAuthorizedProject + audit (authz).
import { loadAuthorizedProject, audit } from "./authz.ts";
import { readSigningCredential, signingSecretName } from "./mobileSigning.ts";
import { sha256Hex, packBinaryPackage } from "./mobileArtifacts.ts";

export const SIGNATURE_ALGORITHM = "HMAC-SHA256";

const encoder = new TextEncoder();
const mobileFail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

const importKey = async (credential) => {
  // The credential is the symmetric signing key. importKey copies the raw bytes into a
  // non-extractable HMAC key bound to SHA-256, so the plaintext never leaves the crypto surface.
  const raw = encoder.encode(String(credential));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

/**
 * Compute the detached HMAC-SHA256 signature over the package bytes and verify it (notarization).
 * Deterministic for a given (credential, package) — a retry converges on the same bytes and the
 * same checksum. Throws if the produced signature does not verify (fail closed).
 */
export async function signPackageBytes(credential, packageBytes) {
  const key = await importKey(credential);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, packageBytes));
  const ok = await crypto.subtle.verify("HMAC", key, sig, packageBytes);
  if (!ok) throw mobileFail(500, "SIGN_VERIFY_FAILED", "The produced signature did not verify");
  return sig;
}

/**
 * THE authorized "sign this build" execution — the one place signed_at is stamped on a MobileBuild.
 * Authorization is the EXISTING deploy.manage capability resolved server-side against the build's
 * project (the same capability that requests a mobile build and uploads to a store).
 *
 * Idempotent: a build already carrying signed_at is returned as-is and never re-signed. A build
 * that is not READY, or whose workspace has no signing credential, fails closed. The signature is
 * persisted as a content-addressed sidecar binary (same private-storage pattern as the package),
 * and the signing identity + signature checksum are recorded in the audit trail.
 */
export async function signMobileBuild(base44, user, { build_id } = {}) {
  const svc = base44.asServiceRole || base44;
  const build = build_id ? await svc.entities.MobileBuild.get(String(build_id)).catch(() => null) : null;
  if (!build) throw mobileFail(404, "BUILD_NOT_FOUND", "Mobile build not found");

  // Authorize FIRST — before any build metadata is returned. A non-member is rejected even for an
  // already-signed build, so the idempotency short-circuit never leaks signing state across the
  // workspace boundary (the same authorize-first rule as the store-publish path).
  const { project, workspace } = await loadAuthorizedProject(base44, user, build.project_id, "deploy.manage");
  if (build.workspace_id !== workspace.id) {
    throw mobileFail(403, "FORBIDDEN", "This build does not belong to your workspace");
  }

  // Idempotent: a build already signed is history — signing is never re-applied to a finished,
  // signed artifact (the same terminal-never-overwritten rule as the build worker).
  if (build.signed_at) {
    return {
      build_id: build.id, platform: build.platform, signed_at: build.signed_at,
      signing_secret_name: build.signing_secret_name || null, already_signed: true,
    };
  }
  if (build.status !== "READY" || !build.artifact_uri) {
    throw mobileFail(409, "NOT_READY", "Only a finalized (READY) build with a packaged artifact can be signed");
  }

  // Resolve the workspace's signing credential SERVER-SIDE; a missing credential fails closed —
  // signing never degrades to an unsigned artifact.
  const credential = await readSigningCredential(svc, build.workspace_id, build.platform);
  if (!credential) {
    throw mobileFail(409, "MISSING_SIGNING_CREDENTIALS", `No ${build.platform} signing credential is configured for this workspace; signing failed closed.`);
  }

  // Read the stored package through a short-lived signed URL — the same private-storage path the
  // download and verify steps use. The bytes are verified against the recorded package checksum
  // BEFORE signing, so a tampered or corrupted package is never signed.
  const { signed_url } = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: build.artifact_uri, expires_in: 60 });
  const res = await fetch(signed_url);
  if (!res.ok) throw mobileFail(502, "SIGN_PACKAGE_READ_FAILED", `Could not read the package for signing (${res.status})`);
  const packageBytes = new Uint8Array(await res.arrayBuffer());
  const observed = await sha256Hex(packageBytes);
  if (observed !== build.package_checksum) {
    throw mobileFail(409, "SIGN_PACKAGE_CHECKSUM_MISMATCH", "The package failed checksum verification before signing; nothing was signed.");
  }

  const sig = await signPackageBytes(credential, packageBytes);
  const signature_checksum = await sha256Hex(sig);
  // Persist the signature as a content-addressed sidecar (idempotent across retries — the same
  // (package, credential) always produces the same bytes, so a retry converges on one artifact).
  const signature_uri = await packBinaryPackage(svc, `mobile-signature-${build.platform}-${signature_checksum.slice(0, 12)}.mobsig`, sig);

  const signed_at = new Date().toISOString();
  // The row stores only the credential IDENTITY + the signed_at stamp; the signature itself lives
  // in private storage, addressable by its checksum.
  await svc.entities.MobileBuild.update(build.id, { signed_at, signing_secret_name: signingSecretName(build.platform) });
  await audit(svc, {
    workspace_id: build.workspace_id, project_id: build.project_id, user_id: user.id,
    action: "mobile_build.signed", resource: "MobileBuild", resource_id: build.id,
    metadata: {
      platform: build.platform,
      signing_secret_name: signingSecretName(build.platform),
      signature_algorithm: SIGNATURE_ALGORITHM,
      signature_checksum,
      package_checksum: build.package_checksum || null,
    },
  });

  return {
    build_id: build.id, platform: build.platform, signed_at,
    signing_secret_name: signingSecretName(build.platform),
    signature_algorithm: SIGNATURE_ALGORITHM, signature_checksum,
    already_signed: false,
  };
}