// Immutable routing policy versions (#41).
//
// A routing policy is the DATA the deterministic scorer reads: weights, hard thresholds, and the
// per-model evidence priors derived from #38/#39. It is never edited. Improving routing means
// creating a NEW version from freshly gathered persisted evidence and activating it; at most one
// version is ACTIVE per scope, the previous one becomes SUPERSEDED, and a rollback re-activates an
// existing immutable version rather than rewriting anything.
//
// Self-improvement boundary: `proposePolicyFromEvidence` is the ONLY path that writes priors, and it
// takes them from `gatherRoutingEvidence`, which admits benchmark and candidate-evaluation records
// only. Raw production telemetry has no route into a policy.
import { scrub, scrubText } from "./tracing.ts";
import { loadAuthorizedProject, audit } from "./authz.ts";
import { requirePlatformAdmin } from "./platformAdmin.ts";
import { gatherRoutingEvidence, assertEvidenceSources } from "./routingEvidence.ts";

/** Version of the scoring contract. A change here means new policies, never reinterpreted old ones. */
export const ROUTING_CONTRACT_VERSION = "1.0.0";

/** Deterministic default weights. Sum is normalized at scoring time, so a partial set is safe. */
export const DEFAULT_ROUTING_WEIGHTS = {
  quality: 0.3, reliability: 0.2, tool_call_success: 0.12,
  latency: 0.13, cost: 0.15, capability_match: 0.07, health: 0.03,
};

export const DEFAULT_ROUTING_THRESHOLDS = {
  // Below this many samples a dimension is treated as UNMEASURED rather than trusted.
  min_evidence_samples: 1,
  // A model whose measured reliability is below this is excluded from automatic selection.
  min_reliability: 0.5,
  // Normalization reference for latency scoring, and the default cap for a run.
  latency_reference_ms: 90000,
  // Priors used ONLY when a dimension has no measured evidence. Marked as priors in every decision,
  // so a prior can never be read as a measurement.
  tier_quality_prior: { fast: 0.5, standard: 0.7, advanced: 0.85 },
  latency_class_prior_ms: { fast: 15000, standard: 35000, slow: 70000 },
  // A first-party model must have real evaluation evidence before it can win automatic routing.
  require_evidence_for_first_party: true,
};

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

/** Stable stringify + dependency-free content hash. Same inputs ⇒ same value, always. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
export function hash(prefix, value) {
  const text = stableStringify(value);
  let h = 5381, h2 = 52711;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  for (let i = text.length - 1; i >= 0; i--) h2 = ((h2 << 5) + h2 + text.charCodeAt(i)) | 0;
  return `${prefix}_${(h >>> 0).toString(36)}${(h2 >>> 0).toString(36)}_${text.length.toString(36)}`;
}

export const publicPolicy = (p) => ({
  policy_version: p.policy_version, contract_version: p.contract_version, version: p.version,
  scope: p.scope, project_id: p.project_id || null, workspace_id: p.workspace_id || null, status: p.status,
  weights: p.weights || {}, thresholds: p.thresholds || {}, model_priors: p.model_priors || {},
  skill_profiles: p.skill_profiles || {}, evidence_sources: p.evidence_sources || [],
  evidence_snapshot: p.evidence_snapshot || {}, evidence_checksum: p.evidence_checksum || null,
  checksum: p.checksum || null, parent_policy_version: p.parent_policy_version || null,
  superseded_by: p.superseded_by || null, rollback_of: p.rollback_of || null, notes: p.notes || null,
  created_by: p.created_by || null, created_at: p.created_at || p.created_date,
  activated_at: p.activated_at || null, superseded_at: p.superseded_at || null, id: p.id,
});

// --- authorization -------------------------------------------------------------

/** Platform scope requires a platform admin; project scope goes through the EXISTING project path. */
async function authorizeScope(base44, user, { scope, project_id }, capability = "project.write") {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to manage routing policies");
  if (!["platform", "project"].includes(scope)) fail(400, "INVALID_SCOPE", "scope must be 'platform' or 'project'");
  if (scope === "platform") {
    await requirePlatformAdmin(base44, user);
    return { project: null, workspace: null };
  }
  return loadAuthorizedProject(base44, user, project_id, capability);
}

const scopeQuery = ({ scope, project_id }) => (scope === "platform" ? { scope: "platform" } : { scope: "project", project_id });

// --- reads ---------------------------------------------------------------------

/** The ACTIVE policy of a scope, or null. A scope with no policy routes on the built-in defaults. */
export async function getActivePolicy(svc, { scope = "platform", project_id = null } = {}) {
  const rows = await svcOf(svc).entities.RoutingPolicy.filter({ ...scopeQuery({ scope, project_id }), status: "ACTIVE" }, "-version", 5).catch(() => []);
  return rows[0] || null;
}

/**
 * The policy routing should use, resolved with a deterministic precedence: the project's own ACTIVE
 * policy, else the platform's ACTIVE policy, else the built-in defaults (which are themselves a
 * named, versioned contract rather than an unlabelled fallback).
 */
export async function resolveEffectivePolicy(svc, { project_id = null } = {}) {
  const own = project_id ? await getActivePolicy(svc, { scope: "project", project_id }) : null;
  if (own) return { policy: own, resolved_from: "project" };
  const platform = await getActivePolicy(svc, { scope: "platform" });
  if (platform) return { policy: platform, resolved_from: "platform" };
  return { policy: defaultPolicy(), resolved_from: "default" };
}

/** The built-in default policy object (not persisted, but versioned and named like any other). */
export function defaultPolicy() {
  const body = { weights: DEFAULT_ROUTING_WEIGHTS, thresholds: DEFAULT_ROUTING_THRESHOLDS, model_priors: {}, skill_profiles: {} };
  return {
    policy_version: hash("rpol", { contract: ROUTING_CONTRACT_VERSION, ...body }),
    contract_version: ROUTING_CONTRACT_VERSION, version: 0, scope: "platform", status: "ACTIVE",
    evidence_sources: [], evidence_snapshot: { built_in_default: true }, ...body,
  };
}

export async function listPolicies(base44, user, { scope = "platform", project_id = null, limit = 20 } = {}) {
  await authorizeScope(base44, user, { scope, project_id }, "project.read");
  const rows = await svcOf(base44).entities.RoutingPolicy.filter(scopeQuery({ scope, project_id }), "-version", Math.min(limit, 100));
  return { scope, project_id: project_id || null, count: rows.length, policies: rows.map(publicPolicy), active: rows.filter((r) => r.status === "ACTIVE").map(publicPolicy)[0] || null };
}

// --- creation from persisted evidence only -------------------------------------

/**
 * Fingerprints only the SUBSTANTIVE evidence. When the evidence read happened is not part of what
 * the evidence says, so the read timestamp is excluded: re-proposing from unchanged records must
 * resolve the same policy version instead of appending a duplicate every time the clock moves.
 */
export function evidenceChecksum(snapshot, priors) {
  const { gathered_at, ...substantive } = snapshot || {};
  return hash("rev", { snapshot: substantive, priors: priors || {} });
}

const priorsFrom = (evidence) => {
  const out = {};
  for (const [model_id, m] of Object.entries(evidence.models)) out[model_id] = scrub(m);
  return out;
};

/**
 * Creates a new IMMUTABLE policy version from freshly gathered persisted evidence.
 *
 * `weights`/`thresholds` may be tuned by an authorized operator, but the PRIORS always come from
 * `gatherRoutingEvidence` — the caller cannot inject a model score. An identical policy (same
 * contract, weights, thresholds and evidence) resolves the existing version instead of appending a
 * duplicate, so repeated proposals are idempotent.
 */
export async function proposePolicyFromEvidence(base44, user, {
  scope = "platform", project_id = null, weights = null, thresholds = null,
  evidence_sources = null, notes = null, skill_profiles = null,
} = {}) {
  const { project, workspace } = await authorizeScope(base44, user, { scope, project_id }, "project.write");
  const sources = assertEvidenceSources(evidence_sources);
  const svc = svcOf(base44);
  const evidence = await gatherRoutingEvidence(svc, { scope, project_id: project?.id || project_id, workspace_id: workspace?.id || null, sources });

  const mergedWeights = { ...DEFAULT_ROUTING_WEIGHTS, ...(weights || {}) };
  for (const [k, v] of Object.entries(mergedWeights)) {
    if (!(k in DEFAULT_ROUTING_WEIGHTS)) fail(400, "UNKNOWN_WEIGHT", `Unknown scoring dimension: ${k}`);
    if (!Number.isFinite(Number(v)) || Number(v) < 0) fail(400, "INVALID_WEIGHT", `Weight for ${k} must be a non-negative number`);
  }
  const mergedThresholds = { ...DEFAULT_ROUTING_THRESHOLDS, ...(thresholds || {}) };
  const model_priors = priorsFrom(evidence);
  const evidence_snapshot = evidence.snapshot;
  const evidence_checksum = evidenceChecksum(evidence_snapshot, model_priors);
  const body = { weights: mergedWeights, thresholds: mergedThresholds, model_priors, skill_profiles: scrub(skill_profiles || {}) };
  const policy_version = hash("rpol", { contract: ROUTING_CONTRACT_VERSION, scope, project_id: project?.id || null, ...body, evidence_checksum });

  const [existing] = await svc.entities.RoutingPolicy.filter({ policy_version }, "-version", 1).catch(() => []);
  if (existing) return { policy: publicPolicy(existing), created: false, reason: "identical_policy_version_exists", evidence: evidence_snapshot };

  const siblings = await svc.entities.RoutingPolicy.filter(scopeQuery({ scope, project_id: project?.id || project_id }), "-version", 50).catch(() => []);
  const version = Math.max(0, ...siblings.map((s) => s.version || 0)) + 1;
  const active = siblings.find((s) => s.status === "ACTIVE") || null;

  const row = await svc.entities.RoutingPolicy.create({
    policy_version, contract_version: ROUTING_CONTRACT_VERSION, version, scope,
    project_id: project?.id || undefined, workspace_id: workspace?.id || undefined,
    status: "DRAFT", ...body, evidence_sources: sources, evidence_snapshot, evidence_checksum,
    checksum: hash("rchk", { policy_version, ...body }),
    parent_policy_version: active?.policy_version || undefined,
    notes: notes ? scrubText(notes, 500) : undefined,
    created_by: user.id, created_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: workspace?.id || null, project_id: project?.id || null, user_id: user.id,
    action: "routing.policy.proposed", resource: "RoutingPolicy", resource_id: row.id,
    metadata: { policy_version, version, scope, sources, models_with_evidence: evidence_snapshot.models_with_quality_evidence.length },
  });
  return { policy: publicPolicy(row), created: true, evidence: evidence_snapshot };
}

// --- activation, rollback ------------------------------------------------------

async function loadPolicy(svc, policy_version) {
  // A failed read is retryable (503), never "not found"; a just-proposed version gets a short
  // read-after-write window before a genuine absence is reported.
  for (let attempt = 0; attempt < 3; attempt++) {
    let rows;
    try {
      rows = await svc.entities.RoutingPolicy.filter({ policy_version: String(policy_version || "") }, "-version", 1);
    } catch {
      fail(503, "POLICY_READ_UNAVAILABLE", "The routing policy could not be read; retry later.");
    }
    if (rows[0]) return rows[0];
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  fail(404, "POLICY_NOT_FOUND", "Routing policy version not found");
}

/**
 * Activates one immutable version. The previous ACTIVE version is SUPERSEDED (never edited beyond
 * its lifecycle stamps), so exactly one policy is ACTIVE per scope and the predecessor stays
 * available for rollback. The evidence checksum is re-verified first: priors altered after the
 * policy was proposed block activation instead of shipping silently.
 */
export async function activatePolicy(base44, user, { policy_version, rollback_of = null } = {}) {
  const svc = svcOf(base44);
  const row = await loadPolicy(svc, policy_version);
  await authorizeScope(base44, user, { scope: row.scope, project_id: row.project_id }, "project.write");
  if (row.status === "ACTIVE") return { policy: publicPolicy(row), already_active: true };
  const recomputed = evidenceChecksum(row.evidence_snapshot || {}, row.model_priors || {});
  if (row.evidence_checksum && row.evidence_checksum !== recomputed) fail(409, "EVIDENCE_CHECKSUM_MISMATCH", "The policy's evidence changed after it was proposed; activation refused");

  const previous = await getActivePolicy(svc, { scope: row.scope, project_id: row.project_id });
  if (previous && previous.id !== row.id) {
    await svc.entities.RoutingPolicy.update(previous.id, { status: "SUPERSEDED", superseded_by: row.policy_version, superseded_at: nowIso() });
  }
  const activated = await svc.entities.RoutingPolicy.update(row.id, {
    status: "ACTIVE", activated_at: nowIso(),
    superseded_by: null, ...(rollback_of ? { rollback_of } : {}),
  });
  await audit(svc, {
    workspace_id: row.workspace_id || null, project_id: row.project_id || null, user_id: user.id,
    action: rollback_of ? "routing.policy.rolled_back" : "routing.policy.activated",
    resource: "RoutingPolicy", resource_id: row.id,
    metadata: { policy_version: row.policy_version, version: row.version, previous: previous?.policy_version || null, rollback_of: rollback_of || null },
  });
  return { policy: publicPolicy(activated), previous: previous ? publicPolicy(previous) : null, rolled_back: !!rollback_of };
}

/**
 * Rolls a scope back to its previous version — the one the current ACTIVE policy superseded, or an
 * explicitly named earlier version. The current policy becomes ROLLED_BACK; nothing is rewritten,
 * so the rolled-back version remains inspectable and re-activatable.
 */
export async function rollbackPolicy(base44, user, { scope = "platform", project_id = null, to_policy_version = null } = {}) {
  const svc = svcOf(base44);
  await authorizeScope(base44, user, { scope, project_id }, "project.write");
  const current = await getActivePolicy(svc, { scope, project_id });
  if (!current) fail(409, "NO_ACTIVE_POLICY", "There is no active routing policy to roll back");
  const targetVersion = to_policy_version || current.parent_policy_version;
  if (!targetVersion) fail(409, "NO_PREVIOUS_POLICY", "This policy has no previous version to roll back to");
  const target = await loadPolicy(svc, targetVersion);
  if (target.scope !== current.scope || (target.project_id || null) !== (current.project_id || null)) fail(403, "POLICY_SCOPE_MISMATCH", "A policy can only be rolled back within its own scope");

  await svc.entities.RoutingPolicy.update(current.id, { status: "ROLLED_BACK", superseded_by: target.policy_version, superseded_at: nowIso() });
  const restored = await activatePolicy(base44, user, { policy_version: target.policy_version, rollback_of: current.policy_version });
  return { policy: restored.policy, rolled_back_from: publicPolicy(await svc.entities.RoutingPolicy.get(current.id)) };
}

export const routingPolicyContract = () => ({
  contract_version: ROUTING_CONTRACT_VERSION,
  default_weights: DEFAULT_ROUTING_WEIGHTS, default_thresholds: DEFAULT_ROUTING_THRESHOLDS,
  admissible_evidence_sources: assertEvidenceSources(null),
  default_policy_version: defaultPolicy().policy_version,
});