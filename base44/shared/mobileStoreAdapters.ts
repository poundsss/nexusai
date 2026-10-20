// P-10.3 phase 4 — store provider adapters (provider interface ONLY).
//
// These are the ONLY places that know how a store submission is pushed. No real production keys
// are required and no network calls are made: the interface is exercised against deterministic
// stubs, so the certification suites validate the CONTRACT (fail-closed credentials, idempotent
// upload identity, status reporting) without touching Apple's or Google's real APIs. Swapping
// a stub for a real client later changes nothing above this module.
//
// Fail-closed contract, identical for both providers:
//   missing connection → STORE_NOT_CONFIGURED
//   invalid connection → STORE_AUTH_FAILED
//
// Store review automation, in-store pricing and store analytics are DELIBERATELY out of scope:
// a submission stays SUBMITTED until the store's own review completes externally.
import { sha256, fail } from "./appAuth.ts";
import { validateStoreConnectionShape } from "./mobileStoreConnections.ts";

const digestHex = async (scope, idempotency_key) => (await sha256(`${scope}:${idempotency_key}`)).slice(0, 20);

// --- Apple App Store -----------------------------------------------------------

/** Fails closed on a missing or structurally invalid App Store connection. */
export function validateAppleCredentials(connection) {
  if (!connection) throw fail(409, "STORE_NOT_CONFIGURED", "No App Store connection is configured for this workspace");
  try {
    validateStoreConnectionShape("ios", connection);
  } catch {
    throw fail(401, "STORE_AUTH_FAILED", "The App Store connection is invalid; refusing to publish");
  }
  return { ok: true, store: "app_store", key_id: connection.key_id };
}

/**
 * Uploads one package to the App Store. Idempotent by construction: the external submission
 * identity is DERIVED from the caller's content-scoped idempotency key, so a retry — or a
 * re-created submission for the same release — replays to the SAME store identity instead of
 * uploading a duplicate.
 */
export async function uploadAppleBuild(connection, { idempotency_key, version_name, version_code, checksum } = {}) {
  validateAppleCredentials(connection);
  if (!idempotency_key || !version_name || !Number.isInteger(Number(version_code)) || Number(version_code) < 1 || !checksum) {
    throw fail(400, "INVALID_PACKAGE_METADATA", "The upload metadata is incomplete");
  }
  const external_submission_id = `apple-sub-${await digestHex("app_store", idempotency_key)}`;
  return { external_submission_id, store: "app_store", uploaded_checksum: checksum };
}

/** Reports the store's own state for a submission. Review automation is out of scope. */
export function checkAppleSubmissionStatus(connection, external_submission_id) {
  validateAppleCredentials(connection);
  if (!external_submission_id) throw fail(400, "INVALID_SUBMISSION", "An external submission id is required");
  return { external_submission_id, store: "app_store", state: "SUBMITTED" };
}

// --- Google Play ----------------------------------------------------------------

/** Fails closed on a missing or structurally invalid Play connection. */
export function validateGoogleCredentials(connection) {
  if (!connection) throw fail(409, "STORE_NOT_CONFIGURED", "No Google Play connection is configured for this workspace");
  try {
    validateStoreConnectionShape("android", connection);
  } catch {
    throw fail(401, "STORE_AUTH_FAILED", "The Google Play connection is invalid; refusing to publish");
  }
  return { ok: true, store: "google_play", package_name: connection.package_name };
}

/** Idempotent Play upload — same contract and replay semantics as the Apple adapter. */
export async function uploadGoogleBuild(connection, { idempotency_key, version_name, version_code, checksum } = {}) {
  validateGoogleCredentials(connection);
  if (!idempotency_key || !version_name || !Number.isInteger(Number(version_code)) || Number(version_code) < 1 || !checksum) {
    throw fail(400, "INVALID_PACKAGE_METADATA", "The upload metadata is incomplete");
  }
  const external_submission_id = `google-sub-${await digestHex("google_play", idempotency_key)}`;
  return { external_submission_id, store: "google_play", uploaded_checksum: checksum };
}

/** Reports the store's own state for a Play submission. Review automation is out of scope. */
export function checkGoogleSubmissionStatus(connection, external_submission_id) {
  validateGoogleCredentials(connection);
  if (!external_submission_id) throw fail(400, "INVALID_SUBMISSION", "An external submission id is required");
  return { external_submission_id, store: "google_play", state: "SUBMITTED" };
}

// The provider interface the publishing worker programs against — the platform decides the
// store from the submission's platform and nothing else needs to know which provider is which.
export function storeAdapterFor(platform) {
  if (platform === "ios") {
    return { validate: validateAppleCredentials, upload: uploadAppleBuild, checkStatus: checkAppleSubmissionStatus };
  }
  if (platform === "android") {
    return { validate: validateGoogleCredentials, upload: uploadGoogleBuild, checkStatus: checkGoogleSubmissionStatus };
  }
  throw fail(400, "INVALID_PLATFORM", "platform must be one of: ios, android");
}