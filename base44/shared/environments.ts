// Deployment environments.
//
// A project has TWO independent environments served by the same public runtime and the same
// immutable artifacts:
//   staging     — an internal target for validating a version before customers see it
//   production  — what the project's real audience gets
//
// Each environment has its own live deployment, its own pointer on the project row and its
// own public address, so deploying to staging can never change production. Promotion moves
// the EXACT artifact that staging proved good into production without rebuilding it, which
// is what makes "what we tested is what shipped" true rather than aspirational.

export const ENVIRONMENTS = ["staging", "production"];
export const DEFAULT_ENVIRONMENT = "production";
const STAGING_SUFFIX = "--staging";

export function normalizeEnvironment(value, fallback = DEFAULT_ENVIRONMENT) {
  const env = String(value || fallback);
  if (!ENVIRONMENTS.includes(env)) throw Object.assign(new Error(`Unknown environment "${env}". Expected one of: ${ENVIRONMENTS.join(", ")}`), { status: 400 });
  return env;
}

// Pointer fields on the Project row. These are a CACHE of the derived live deployment per
// environment (see currentLiveDeployment), never the source of truth.
export function pointerFields(environment) {
  return environment === "staging"
    ? { deployment: "staging_deployment_id", version: "staging_version_number" }
    : { deployment: "production_deployment_id", version: "production_version_number" };
}

// Public address of an environment. One project slug addresses both environments; the
// staging suffix is part of the public identifier, so a staging URL can never be mistaken
// for (or silently resolve to) production.
export const environmentSlug = (slug, environment) => (environment === "staging" ? `${slug}${STAGING_SUFFIX}` : String(slug));
export const deploymentPath = (slug, environment = DEFAULT_ENVIRONMENT) => `/app/${environmentSlug(slug, environment)}`;

// Inverse of environmentSlug: what the public runtime receives is a single opaque slug, and
// the environment is derived from it server-side.
export function parseAppSlug(input) {
  const raw = String(input || "");
  if (raw.endsWith(STAGING_SUFFIX)) return { slug: raw.slice(0, -STAGING_SUFFIX.length), environment: "staging" };
  return { slug: raw, environment: "production" };
}