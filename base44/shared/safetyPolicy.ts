// THE safety / approval POLICY (#42) — pure, deterministic, and the only place a risk level or a
// safety decision is decided.
//
// What this is NOT. It is not a permission system, an execution engine, an audit system or a second
// project-state store:
//   • authorization vocabulary ... shared/rbac.ts capability strings (consumed, never redefined)
//   • the operation catalogue .... shared/toolRouter.ts contracts (consumed, never extended)
//   • execution .................. the existing tool boundary, unchanged
//   • audit ..................... shared/authz.ts audit + shared/tracing.ts spans
//
// Everything here is PURE and synchronous: no I/O, no secrets, no model judgment. The same operation
// always classifies to the same risk and resolves to the same decision, which is what makes a safety
// verdict checkable rather than trusted. Risk is read off the REQUESTED operation and the resources
// it names — never off a model's opinion about it.
export const SAFETY_CONTRACT_VERSION = "1.0.0";

/** The classes an operation can fall into. A proposal may carry several. */
export const OPERATION_CLASSES = [
  "read", "create", "edit", "delete", "deploy", "rollback",
  "credential_access", "external_action", "destructive", "security_sensitive",
];
export const RISK_LEVELS = ["low", "medium", "high", "critical"];
export const DECISIONS = ["allow", "require_approval", "deny"];

/** How long a granted approval may be spent for. A stale approval is refused, never honoured. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

const RANK = new Map(RISK_LEVELS.map((l, i) => [l, i]));
const raise = (current, candidate) => ((RANK.get(candidate) ?? -1) > (RANK.get(current) ?? -1) ? candidate : current);

// Which class each EXISTING tool belongs to. Explicit on purpose: a new tool has no class until it
// is stated here, and an unclassified operation is DENIED rather than assumed safe.
const TOOL_CLASS = {
  read_file: "read", list_files: "read", search_project: "read", get_project_state: "read",
  list_functions: "read", list_secrets: "read", list_integrations: "read", get_integration: "read",
  list_operations: "read", get_operation: "read", list_mcp_connections: "read",
  github_status: "read", deployment_status: "read", run_build: "read",
  mcp_call: "external_action",
  declare_secret: "credential_access",
  create_integration: "external_action", update_integration: "external_action", import_openapi: "external_action",
  delete_integration: "delete",
  write_file: "edit", patch_file: "edit", apply_patches: "edit", insert_at: "edit",
  replace_range: "edit", replace_symbol: "edit", rename_symbol: "edit", move_file: "edit",
  copy_file: "create", create_entity: "create", create_snapshot: "create",
  update_entity: "edit",
  delete_file: "delete", delete_files: "delete",
  restore_snapshot: "rollback",
};

const BASE_RISK = {
  read: "low", create: "low", edit: "low",
  external_action: "medium",
  credential_access: "high", delete: "high", rollback: "high",
  deploy: "critical",
};

// Resources whose change alters who may reach what: entity declarations and their row-level rules,
// connector/agent declarations, integration definitions and the project manifest.
const SECURITY_SENSITIVE_PREFIXES = [
  "base44/entities/", "base44/connectors/", "base44/agents/", "base44/agent-skills/", "integrations/",
];
const SECURITY_SENSITIVE_FILES = ["base44/config.jsonc"];

// Input field names that would carry a credential VALUE. A proposal carrying one is refused before
// anything runs, so a secret can never reach a tool argument, an approval record or an audit row.
const CREDENTIAL_FIELDS = ["value", "secret_value", "api_key", "apikey", "token", "password", "client_secret", "private_key"];

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const targetsOf = (input) => {
  const i = input || {};
  const list = [
    ...(Array.isArray(i.paths) ? i.paths : []),
    i.path, i.from, i.to, i.file,
  ].map(str).filter(Boolean);
  return [...new Set(list)];
};

const isSecuritySensitivePath = (p) =>
  SECURITY_SENSITIVE_FILES.includes(p) || SECURITY_SENSITIVE_PREFIXES.some((prefix) => p.startsWith(prefix));

/** Bounded, scrubbed identifiers of what an operation targets. Never content, never a credential. */
export function summarizeInput(input) {
  const i = input || {};
  const out = {};
  const paths = targetsOf(i);
  if (paths.length) out.paths = paths.slice(0, 10).map((p) => p.slice(0, 200));
  for (const key of ["name", "integration", "operation", "symbol", "version_id", "tool", "connection", "query"]) {
    if (i[key] != null) out[key] = str(i[key]).slice(0, 120);
  }
  if (i.rls != null) out.rls = true;
  if (i.force != null) out.force = !!i.force;
  if (Array.isArray(i.patches)) out.patch_count = i.patches.length;
  return out;
}

/**
 * Classifies ONE proposed operation.
 *
 * `contract` is the EXISTING tool contract (shared/toolRouter.ts) — absent means the operation does
 * not exist and is forbidden. `architecture_risk` is the risk level the EXISTING architecture impact
 * analysis already computed for the affected nodes, and `capability_risk` the posture the AI App
 * Primitives layer reported: either can RAISE the risk level, never lower it, so an integration can
 * make the engine more careful but never less.
 */
export function classifyOperation({
  tool, contract = null, input = {}, mode = "default", mode_allows = true,
  project_id = null, actor_kind = "user", architecture_risk = null, capability_risk = null,
} = {}) {
  const name = str(tool);
  const classes = new Set();
  const factors = [];
  const forbidden = [];

  if (!contract) {
    forbidden.push({ code: "SAFETY_UNKNOWN_OPERATION", reason: `'${name || "(none)"}' is not a platform operation` });
  }
  const declared = contract ? TOOL_CLASS[name] : null;
  if (contract && !declared) {
    forbidden.push({ code: "SAFETY_UNCLASSIFIED_OPERATION", reason: `'${name}' has no declared safety classification and cannot be executed` });
  }

  // The capability the operation needs decides two classes outright, so a deployment or a credential
  // operation is never mis-read as an ordinary edit.
  if (contract?.capability === "deploy.manage") { classes.add("deploy"); factors.push("operation requires deploy.manage"); }
  if (contract?.capability === "secret.manage") { classes.add("credential_access"); factors.push("operation requires secret.manage"); }
  if (declared) classes.add(declared);

  let level = [...classes].reduce((acc, c) => raise(acc, BASE_RISK[c] || "low"), "low");

  // --- forbidden conditions (checked on the real input, before anything can run) -------------
  if (!mode_allows) forbidden.push({ code: "SAFETY_MODE_FORBIDDEN", reason: `'${name}' is not available in ${mode} mode` });
  if (contract?.system && actor_kind !== "platform") {
    forbidden.push({ code: "SAFETY_SYSTEM_TOOL", reason: `'${name}' is issued by the platform and cannot be proposed by a caller` });
  }
  for (const field of CREDENTIAL_FIELDS) {
    const v = (input || {})[field];
    if (typeof v === "string" && v.trim()) {
      forbidden.push({ code: "SAFETY_SECRET_VALUE", reason: `the proposal carries a credential value in '${field}'; secrets are supplied by the user, never by an operation` });
      break;
    }
  }
  const claimed = str((input || {}).project_id);
  if (claimed && project_id && claimed !== str(project_id)) {
    forbidden.push({ code: "SAFETY_CROSS_PROJECT", reason: "the proposal references a different project than the authorized one" });
  }

  // --- escalators (raise only) ----------------------------------------------------------------
  const paths = targetsOf(input);
  const sensitive = paths.filter(isSecuritySensitivePath);
  if (sensitive.length) {
    classes.add("security_sensitive");
    level = raise(level, "high");
    factors.push(`touches security-sensitive resource(s): ${sensitive.slice(0, 3).join(", ")}`);
  }
  if ((input || {}).rls != null) {
    classes.add("security_sensitive");
    level = raise(level, "high");
    factors.push("changes row-level security rules");
  }
  if (classes.has("delete") || classes.has("rollback") || classes.has("deploy")) {
    classes.add("destructive");
    factors.push("removes or replaces existing state");
  }
  if ((input || {}).force === true && classes.has("delete")) {
    level = raise(level, "critical");
    factors.push("forced deletion ignores the platform's own dependency refusal");
  }
  if (paths.length > 3 && classes.has("delete")) {
    level = raise(level, "critical");
    factors.push(`deletes ${paths.length} files in one operation`);
  }
  if (architecture_risk && RISK_LEVELS.includes(str(architecture_risk))) {
    const raised = raise(level, str(architecture_risk));
    if (raised !== level) factors.push(`architecture impact analysis reports ${architecture_risk} risk`);
    level = raised;
  }
  if (capability_risk && RISK_LEVELS.includes(str(capability_risk))) {
    const raised = raise(level, str(capability_risk));
    if (raised !== level) factors.push(`platform capability plan reports ${capability_risk} risk`);
    level = raised;
  }

  return {
    contract_version: SAFETY_CONTRACT_VERSION,
    tool: name,
    operation_classes: [...classes].sort(),
    risk_level: forbidden.length ? raise(level, "high") : level,
    risk_factors: factors,
    destructive: classes.has("destructive"),
    security_sensitive: classes.has("security_sensitive"),
    required_capability: contract?.capability || null,
    forbidden,
    input_summary: summarizeInput(input),
  };
}

/**
 * THE centralized decision. Permission is evaluated BEFORE approval, so an operation the caller's
 * existing role may not perform is denied outright and never becomes an approvable request — an
 * approval can therefore never be a route to a capability the actor does not hold.
 */
export function decideOperation({ risk, role = null, role_permits = false } = {}) {
  const r = risk || {};
  if ((r.forbidden || []).length) {
    const first = r.forbidden[0];
    return { decision: "deny", code: first.code, reason: first.reason, approval_required: false, forbidden: r.forbidden };
  }
  if (!role) return { decision: "deny", code: "NOT_A_MEMBER", reason: "The caller has no role in this workspace", approval_required: false, forbidden: [] };
  if (!role_permits) {
    return {
      decision: "deny", code: "INSUFFICIENT_ROLE",
      reason: `Your role (${role}) is not allowed to ${r.required_capability}`,
      approval_required: false, forbidden: [],
    };
  }
  if (r.risk_level === "low") {
    return { decision: "allow", code: "SAFETY_LOW_RISK", reason: `${r.operation_classes.join(", ") || "read"} operation at low risk`, approval_required: false, forbidden: [] };
  }
  return {
    decision: "require_approval", code: "SAFETY_APPROVAL_REQUIRED",
    reason: `${r.risk_level} risk (${r.operation_classes.join(", ")}) requires explicit human approval`,
    approval_required: true, forbidden: [],
  };
}

/** The canonical text an operation's fingerprint is taken over. Key order is fixed, so it is stable. */
export function fingerprintPayload({ tool, input = {}, project_id = null, risk = null }) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
    }
    return v;
  };
  return JSON.stringify({
    contract_version: SAFETY_CONTRACT_VERSION,
    project_id: str(project_id),
    tool: str(tool),
    input: canonical(input || {}),
    classes: [...(risk?.operation_classes || [])],
    risk_level: risk?.risk_level || null,
  });
}