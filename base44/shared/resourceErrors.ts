// THE Base44-facing error / exit contract for project RESOURCE operations (E15).
//
// This module invents no new error transport. Every other authorized surface in this platform
// already answers with the SAME shape — `{ error, code, details }` plus an HTTP status (see
// functions/projectEdit, shared/authz, shared/appData's dbError) — and that status IS the command
// boundary's exit status. All this module does is make the resource layer's failures deterministic:
// one machine-readable code per failure kind, one human-readable message, and one stable status.
//
// Nothing here catches or rewrites another layer's errors: an error raised by authorization, by the
// workflow API or by persistence keeps its own code and status, and only a resource-layer failure
// gets a resource code. That is what keeps existing error handling untouched.

/**
 * The resource error vocabulary, each mapped to its deterministic status.
 *
 * 4xx is a caller/user error (the request can be corrected), 401/403 authentication and permission,
 * 404 a resource that does not exist, 409 a conflict, 5xx an internal failure. A command surface
 * therefore reports success as 200 and every failure class as a distinct, deterministic non-zero
 * status without a second exit-code system existing.
 */
export const RESOURCE_ERROR_STATUS = {
  RESOURCE_INVALID_SOURCE: 400,
  RESOURCE_INVALID_PATH: 400,
  RESOURCE_INVALID_NAME: 400,
  RESOURCE_MALFORMED: 400,
  RESOURCE_DUPLICATE: 400,
  RESOURCE_KIND_MISMATCH: 400,
  RESOURCE_UNSUPPORTED: 400,
  RESOURCE_VALIDATION_FAILED: 400,
  RESOURCE_UNAUTHENTICATED: 401,
  RESOURCE_FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404,
  RESOURCE_CONFLICT: 409,
  RESOURCE_PERSISTENCE_FAILED: 500,
  RESOURCE_SYNC_FAILED: 500,
};

export const RESOURCE_ERROR_CODES = Object.keys(RESOURCE_ERROR_STATUS);

/**
 * Raises ONE resource failure with a deterministic identity.
 *
 * `code` is the machine-readable identity, `message` is the human-readable sentence (it always
 * states the resource it is about), and `details` carries the structured facts a caller — or the
 * AI repair loop — needs to correct the request. A failure is always thrown: this layer has no
 * path that reports a problem and then reports success.
 */
export function resourceError(code, message, details = {}) {
  const known = RESOURCE_ERROR_STATUS[code];
  return Object.assign(new Error(String(message)), {
    name: "ResourceError",
    code: known ? code : "RESOURCE_VALIDATION_FAILED",
    status: known || 400,
    details: details || {},
  });
}

/** True for an error this module minted, so foreign errors are never relabelled as resource errors. */
export const isResourceError = (e) => !!e && e.name === "ResourceError";

/**
 * THE exit status of a resource command. An error that already carries a status keeps it (so
 * authorization, the workflow API and the database keep their established contract), a resource
 * error resolves from the vocabulary above, and anything unrecognised is an internal failure.
 */
export const commandStatus = (error) => Number(error?.status) || RESOURCE_ERROR_STATUS[error?.code] || 500;

/** The failure body of a resource command: machine-readable, stable, and always parseable JSON. */
export function commandFailure(error) {
  return {
    ok: false,
    error: String(error?.message || "Resource operation failed"),
    code: error?.code || "RESOURCE_SYNC_FAILED",
    details: error?.details || null,
    status: commandStatus(error),
  };
}