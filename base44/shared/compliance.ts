// Legal, compliance, and abuse management.
//
// SECURITY MODEL:
//   • legal documents are versioned and immutable once published — an acceptance record always
//     refers to the exact text that was agreed to, so a retroactive change to the terms is a
//     new version, never a silent overwrite;
//   • data subject requests (DSR) are verified by email token before any data is released — a
//     request from an unverified email grants nothing, and a deletion request from a verified
//     email is irreversible;
//   • abuse reports may auto-suspend the target on critical severity or CSAM category, so a
//     dangerous target is contained before a moderator sees it;
//   • data breaches track the 72-hour GDPR notification clock — a breach past its deadline
//     without notification is flagged as a compliance violation;
//   • retention policies are enforced server-side — a client cannot set a retention period
//     below the legal minimum or disable a legal hold.
//
// The module is the control plane; it does not itself delete user data (that is a platform
// integration point). It records the compliance event and the legal basis, and the platform
// runtime carries out the deletion/anonymization.

import { sha256Hex } from "./secretCrypto.ts";
import { audit } from "./authz.ts";

export class ComplianceError extends Error {
  constructor(message, code = "COMPLIANCE_ERROR", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function randomToken(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const num = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);

// SLA by severity: critical=4h, high=24h, medium=72h, low=168h (in ms).
const SLA_MS = { critical: 4 * 3600000, high: 24 * 3600000, medium: 72 * 3600000, low: 168 * 3600000 };
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// GDPR DSR deadlines: 30 days, extendable to 90.
const DSR_DEADLINE_DAYS = 30;

// =========================================================== legal documents

export async function getActiveDocument(svc, type) {
  const rows = await svc.entities.LegalDocument.filter({ type, status: "active" }, "-effective_date", 5);
  return rows[0] || null;
}

export async function getDocument(svc, id) {
  return svc.entities.LegalDocument.get(id).catch(() => null);
}

export async function listDocuments(svc, { type = null, status = null } = {}) {
  const query = {};
  if (type) query.type = type;
  if (status) query.status = status;
  return svc.entities.LegalDocument.filter(query, "-effective_date", 100);
}

export async function publishDocument(svc, { type, version, title, content_url, content_checksum, effective_date, required_for = "all", published_by, workspace_id = null }) {
  if (!type) throw new ComplianceError("type is required", "COMPLIANCE_NO_TYPE");
  if (!version) throw new ComplianceError("version is required", "COMPLIANCE_NO_VERSION");
  if (!title) throw new ComplianceError("title is required", "COMPLIANCE_NO_TITLE");
  if (!content_url) throw new ComplianceError("content_url is required", "COMPLIANCE_NO_URL");
  // Version uniqueness per type.
  const existing = await svc.entities.LegalDocument.filter({ type, version }, "-created_date", 5);
  if (existing.length) throw new ComplianceError(`Version "${version}" already exists for ${type}`, "COMPLIANCE_VERSION_EXISTS", 409);
  // Retire any currently-active document of this type.
  const active = await getActiveDocument(svc, type);
  if (active) {
    await svc.entities.LegalDocument.update(active.id, { status: "retired", retired_at: new Date().toISOString() });
  }
  const doc = await svc.entities.LegalDocument.create({
    type, version: String(version), title: String(title), content_url, content_checksum: content_checksum || "",
    effective_date: effective_date || new Date().toISOString(), status: "active", required_for,
    published_by: published_by || null, published_at: new Date().toISOString(), retired_at: null,
  });
  await audit(svc, { workspace_id, action: "compliance.document.published", resource: "LegalDocument", resource_id: doc.id, metadata: { type, version } });
  return { doc, retired: active };
}

export async function retireDocument(svc, { document_id, retired_by, workspace_id = null }) {
  const doc = await getDocument(svc, document_id);
  if (!doc) throw new ComplianceError("Document not found", "COMPLIANCE_NO_DOC", 404);
  if (doc.status === "retired") return { doc, duplicate: true };
  const updated = await svc.entities.LegalDocument.update(document_id, { status: "retired", retired_at: new Date().toISOString() });
  await audit(svc, { workspace_id, action: "compliance.document.retired", resource: "LegalDocument", resource_id: document_id, metadata: { type: doc.type, version: doc.version } });
  return { doc: updated, duplicate: false };
}

// =========================================================== legal acceptance

export async function acceptDocument(svc, { user_id, workspace_id, document_id, ip, user_agent }) {
  const doc = await getDocument(svc, document_id);
  if (!doc) throw new ComplianceError("Document not found", "COMPLIANCE_NO_DOC", 404);
  if (doc.status !== "active") throw new ComplianceError("Only an active document can be accepted", "COMPLIANCE_NOT_ACTIVE", 409);
  // Idempotent: if this user already accepted this exact version, return the existing record.
  const existing = await svc.entities.LegalAcceptance.filter({ user_id, document_id }, "-accepted_at", 1);
  if (existing.length) return { acceptance: existing[0], duplicate: true };
  const acceptance = await svc.entities.LegalAcceptance.create({
    user_id, workspace_id: workspace_id || null, document_id, document_type: doc.type, document_version: doc.version,
    accepted_at: new Date().toISOString(),
    ip_hash: ip ? await sha256Hex(String(ip)) : null,
    user_agent_hash: user_agent ? await sha256Hex(String(user_agent).slice(0, 200)) : null,
  });
  await recordEvent(svc, { workspace_id, event_type: "terms_accepted", legal_basis: "gdpr_art_6_1_a_consent", data_categories: ["identity", "contact"], description: `Accepted ${doc.type} v${doc.version}`, actor_id: user_id, metadata: { document_id, document_type: doc.type, document_version: doc.version } });
  return { acceptance, duplicate: false };
}

export async function hasAccepted(svc, { user_id, type }) {
  const doc = await getActiveDocument(svc, type);
  if (!doc) return { accepted: true, document: null }; // no active document → nothing to accept
  const rows = await svc.entities.LegalAcceptance.filter({ user_id, document_id: doc.id }, "-accepted_at", 1);
  return { accepted: rows.length > 0, document: doc };
}

export async function listAcceptances(svc, { user_id, workspace_id = null }) {
  const query = { user_id };
  if (workspace_id) query.workspace_id = workspace_id;
  return svc.entities.LegalAcceptance.filter(query, "-accepted_at", 200);
}

// Which documents does a user still need to accept?
export async function pendingAcceptances(svc, { user_id, required_for = "all" }) {
  const docs = await svc.entities.LegalDocument.filter({ status: "active" }, "-effective_date", 50);
  const filtered = docs.filter((d) => d.required_for === "all" || d.required_for === required_for);
  const pending = [];
  for (const doc of filtered) {
    const rows = await svc.entities.LegalAcceptance.filter({ user_id, document_id: doc.id }, "-accepted_at", 1);
    if (!rows.length) pending.push(doc);
  }
  return pending;
}

// =========================================================== compliance events

export async function recordEvent(svc, { workspace_id, event_type, legal_basis, data_categories = [], description = "", evidence_uri = null, actor_id = null, metadata = {} }) {
  const payload = {
    event_type, legal_basis: legal_basis || "other",
    data_categories: Array.isArray(data_categories) ? data_categories : [], description: String(description).slice(0, 1000),
    evidence_uri, actor_id, metadata,
  };
  if (workspace_id) payload.workspace_id = workspace_id;
  return svc.entities.ComplianceEvent.create(payload);
}

export async function listEvents(svc, { workspace_id, event_type = null, limit = 200 }) {
  const query = {};
  if (workspace_id) query.workspace_id = workspace_id;
  if (event_type) query.event_type = event_type;
  return svc.entities.ComplianceEvent.filter(query, "-created_date", limit);
}

// =========================================================== data subject requests

export async function fileDsr(svc, { workspace_id, email, request_type, requester_user_id = null, legal_basis = null }) {
  const validTypes = ["access", "deletion", "portability", "rectification", "restriction", "objection", "opt_out_sale"];
  if (!validTypes.includes(request_type)) throw new ComplianceError("Invalid request type", "COMPLIANCE_BAD_DSR_TYPE");
  const normalizedEmail = String(email || "").toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) throw new ComplianceError("A valid email is required", "COMPLIANCE_BAD_EMAIL");
  const basisMap = { access: "gdpr_art_15", deletion: "gdpr_art_17", portability: "gdpr_art_20", rectification: "gdpr_art_16", restriction: "gdpr_art_18", objection: "gdpr_art_21", opt_out_sale: "ccpa" };
  const token = randomToken(20);
  const now = new Date();
  const dsr = await svc.entities.DataSubjectRequest.create({
    workspace_id, requester_user_id, email: normalizedEmail, request_type, status: "verifying",
    verification_token: token, verified_at: null, completed_at: null,
    expires_at: new Date(now.getTime() + DSR_DEADLINE_DAYS * 86400000).toISOString(),
    legal_basis: legal_basis || basisMap[request_type] || "other",
    assigned_to: null, metadata: {},
  });
  await recordEvent(svc, { workspace_id, event_type: "dsr_filed", legal_basis: dsr.legal_basis, data_categories: ["identity", "contact"], description: `DSR filed: ${request_type} for ${normalizedEmail}`, actor_id: requester_user_id, metadata: { dsr_id: dsr.id, request_type } });
  return { dsr, token };
}

export async function verifyDsr(svc, { dsr_id, token }) {
  const dsr = await svc.entities.DataSubjectRequest.get(dsr_id).catch(() => null);
  if (!dsr) throw new ComplianceError("DSR not found", "COMPLIANCE_NO_DSR", 404);
  if (dsr.status !== "verifying") return { dsr, duplicate: true };
  if (dsr.verification_token !== token) throw new ComplianceError("Invalid verification token", "COMPLIANCE_BAD_TOKEN", 403);
  const updated = await svc.entities.DataSubjectRequest.update(dsr_id, { status: "in_progress", verified_at: new Date().toISOString() });
  return { dsr: updated, duplicate: false };
}

export async function completeDsr(svc, { dsr_id, response_data_uri = null, assigned_to }) {
  const dsr = await svc.entities.DataSubjectRequest.get(dsr_id).catch(() => null);
  if (!dsr) throw new ComplianceError("DSR not found", "COMPLIANCE_NO_DSR", 404);
  if (dsr.status === "completed") return { dsr, duplicate: true };
  if (dsr.status !== "in_progress" && dsr.status !== "verifying") {
    throw new ComplianceError(`Cannot complete a DSR in status ${dsr.status}`, "COMPLIANCE_BAD_DSR_STATE", 409);
  }
  const updated = await svc.entities.DataSubjectRequest.update(dsr_id, { status: "completed", completed_at: new Date().toISOString(), response_data_uri: response_data_uri || dsr.response_data_uri || null });
  await recordEvent(svc, { workspace_id: dsr.workspace_id, event_type: "dsr_completed", legal_basis: dsr.legal_basis, data_categories: ["identity", "contact"], description: `DSR completed: ${dsr.request_type} for ${dsr.email}`, actor_id: assigned_to, metadata: { dsr_id } });
  return { dsr: updated, duplicate: false };
}

export async function rejectDsr(svc, { dsr_id, reason, assigned_to }) {
  const dsr = await svc.entities.DataSubjectRequest.get(dsr_id).catch(() => null);
  if (!dsr) throw new ComplianceError("DSR not found", "COMPLIANCE_NO_DSR", 404);
  if (dsr.status === "rejected") return { dsr, duplicate: true };
  const updated = await svc.entities.DataSubjectRequest.update(dsr_id, { status: "rejected", rejection_reason: String(reason).slice(0, 1000) });
  await recordEvent(svc, { workspace_id: dsr.workspace_id, event_type: "dsr_rejected", legal_basis: dsr.legal_basis, data_categories: ["identity"], description: `DSR rejected: ${dsr.request_type} — ${reason}`, actor_id: assigned_to, metadata: { dsr_id, reason } });
  return { dsr: updated, duplicate: false };
}

export async function listDsrs(svc, { workspace_id, status = null, limit = 200 }) {
  const query = { workspace_id };
  if (status) query.status = status;
  return svc.entities.DataSubjectRequest.filter(query, "-created_date", limit);
}

export async function getDsr(svc, dsr_id) {
  return svc.entities.DataSubjectRequest.get(dsr_id).catch(() => null);
}

// Is a DSR past its legal deadline without completion?
export function isDsrOverdue(dsr, now = Date.now()) {
  if (dsr.status === "completed" || dsr.status === "rejected" || dsr.status === "expired") return false;
  return dsr.expires_at && Date.parse(dsr.expires_at) < now;
}

// =========================================================== abuse reports

export async function fileAbuseReport(svc, { reporter_workspace_id, reporter_user_id, target_type, target_id, category, severity = "medium", description = "", evidence_urls = [], assigned_to = null }) {
  const validTargets = ["workspace", "user", "content", "app", "marketplace_listing", "deployment", "other"];
  const validCategories = ["spam", "harassment", "malware", "data_theft", "ip_infringement", "csam", "illegal_content", "tos_violation", "other"];
  if (!validTargets.includes(target_type)) throw new ComplianceError("Invalid target type", "COMPLIANCE_BAD_TARGET");
  if (!validCategories.includes(category)) throw new ComplianceError("Invalid category", "COMPLIANCE_BAD_CATEGORY");
  if (!target_id) throw new ComplianceError("target_id is required", "COMPLIANCE_NO_TARGET");

  const sev = ["low", "medium", "high", "critical"].includes(severity) ? severity : "medium";
  const now = new Date();
  const slaDue = new Date(now.getTime() + (SLA_MS[sev] || SLA_MS.medium)).toISOString();

  // CSAM is always critical and highest priority.
  const effectiveSeverity = category === "csam" ? "critical" : sev;
  const priority = SEVERITY_RANK[effectiveSeverity] + (category === "csam" ? 10 : 0);

  // Auto-suspend on critical severity or CSAM/illegal_content.
  const autoSuspend = effectiveSeverity === "critical" || ["csam", "illegal_content"].includes(category);

  const report = await svc.entities.AbuseReport.create({
    reporter_workspace_id: reporter_workspace_id || null, reporter_user_id: reporter_user_id || null,
    target_type, target_id, category, severity: effectiveSeverity, description: String(description).slice(0, 4000),
    evidence_urls: Array.isArray(evidence_urls) ? evidence_urls.slice(0, 20) : [],
    status: "open", priority, assigned_to: assigned_to || null, resolution: "none",
    sla_due_at: slaDue, auto_suspended: autoSuspend,
  });

  // Auto-suspend the target workspace if applicable.
  if (autoSuspend && target_type === "workspace") {
    await svc.entities.Workspace.update(target_id, { status: "suspended" }).catch(() => {});
    // G-6.3: the lifecycle lever itself is audited — who or what froze the workspace, and why.
    await audit(svc, { workspace_id: target_id, user_id: reporter_user_id || null, action: "workspace.status_changed", resource: "Workspace", resource_id: target_id, metadata: { to: "suspended", auto: true, reason: `abuse_report:${report.id}`, category, severity: effectiveSeverity } }).catch(() => {});
  }

  await audit(svc, { workspace_id: reporter_workspace_id, action: "compliance.abuse.filed", resource: "AbuseReport", resource_id: report.id, metadata: { target_type, category, severity: effectiveSeverity, auto_suspended: autoSuspend } });
  return { report, auto_suspended: autoSuspend };
}

export async function assignAbuseReport(svc, { report_id, assigned_to }) {
  const report = await svc.entities.AbuseReport.get(report_id).catch(() => null);
  if (!report) throw new ComplianceError("Report not found", "COMPLIANCE_NO_REPORT", 404);
  return svc.entities.AbuseReport.update(report_id, { assigned_to, status: report.status === "open" ? "investigating" : report.status });
}

export async function resolveAbuseReport(svc, { report_id, resolution, note = "", resolved_by }) {
  const validResolutions = ["none", "warning", "suspension", "termination", "legal_referral", "no_action"];
  if (!validResolutions.includes(resolution)) throw new ComplianceError("Invalid resolution", "COMPLIANCE_BAD_RESOLUTION");
  const report = await svc.entities.AbuseReport.get(report_id).catch(() => null);
  if (!report) throw new ComplianceError("Report not found", "COMPLIANCE_NO_REPORT", 404);
  if (report.status === "actioned" || report.status === "dismissed") return { report, duplicate: true };

  // Apply the resolution to the target.
  if (resolution === "suspension" && report.target_type === "workspace") {
    await svc.entities.Workspace.update(report.target_id, { status: "suspended" }).catch(() => {});
    await audit(svc, { workspace_id: report.target_id, user_id: resolved_by || null, action: "workspace.status_changed", resource: "Workspace", resource_id: report.target_id, metadata: { to: "suspended", auto: false, reason: `abuse_resolution:${report_id}`, resolution } }).catch(() => {});
  }
  if (resolution === "termination" && report.target_type === "workspace") {
    await svc.entities.Workspace.update(report.target_id, { status: "terminated" }).catch(() => {});
    await audit(svc, { workspace_id: report.target_id, user_id: resolved_by || null, action: "workspace.status_changed", resource: "Workspace", resource_id: report.target_id, metadata: { to: "terminated", auto: false, reason: `abuse_resolution:${report_id}`, resolution } }).catch(() => {});
  }

  const updated = await svc.entities.AbuseReport.update(report_id, {
    status: resolution === "no_action" ? "dismissed" : "actioned",
    resolution, resolution_note: String(note).slice(0, 2000), resolved_by, resolved_at: new Date().toISOString(),
  });
  await audit(svc, { workspace_id: report.reporter_workspace_id, action: "compliance.abuse.resolved", resource: "AbuseReport", resource_id: report_id, metadata: { resolution, target_type: report.target_type } });
  return { report: updated, duplicate: false };
}

export async function listAbuseReports(svc, { status = null, category = null, target_id = null, limit = 200 } = {}) {
  const query = {};
  if (status) query.status = status;
  if (category) query.category = category;
  if (target_id) query.target_id = target_id;
  return svc.entities.AbuseReport.filter(query, "-priority", limit);
}

export async function getAbuseReport(svc, report_id) {
  return svc.entities.AbuseReport.get(report_id).catch(() => null);
}

// Is a report past its SLA?
export function isReportOverdue(report, now = Date.now()) {
  if (report.status === "actioned" || report.status === "dismissed") return false;
  return report.sla_due_at && Date.parse(report.sla_due_at) < now;
}

// =========================================================== retention policies

const MIN_RETENTION_DAYS = {
  audit_logs: 365,      // legal minimum 1 year for audit trails
  billing_events: 2555, // 7 years tax law
  abuse_reports: 365,
  dsr_records: 1095,     // 3 years for DSR records
  usage_events: 90,
  ai_operations: 180,
  deployments: 90,
  user_activity: 365,
  support_tickets: 365,
};

export async function getRetentionPolicy(svc, { workspace_id, data_type }) {
  // Workspace-specific policy overrides the platform default.
  const wsPolicy = workspace_id ? (await svc.entities.RetentionPolicy.filter({ workspace_id, data_type, active: true }, "-created_date", 1))[0] : null;
  if (wsPolicy) return wsPolicy;
  return (await svc.entities.RetentionPolicy.filter({ workspace_id: null, data_type, active: true }, "-created_date", 1))[0] || null;
}

export async function createRetentionPolicy(svc, { workspace_id, data_type, retention_days, action = "delete", legal_basis, created_by }) {
  const validTypes = Object.keys(MIN_RETENTION_DAYS);
  if (!validTypes.includes(data_type)) throw new ComplianceError("Invalid data type", "COMPLIANCE_BAD_DATA_TYPE");
  if (!Number.isFinite(Number(retention_days)) || Number(retention_days) < 0) throw new ComplianceError("retention_days must be a non-negative number", "COMPLIANCE_BAD_RETENTION");
  // Enforce the legal minimum: a client cannot set a retention period below the floor.
  const minDays = MIN_RETENTION_DAYS[data_type];
  if (Number(retention_days) > 0 && Number(retention_days) < minDays) {
    throw new ComplianceError(`Retention period for ${data_type} must be at least ${minDays} days (legal minimum)`, "COMPLIANCE_RETENTION_TOO_LOW", 409);
  }
  // One active policy per data_type per scope.
  const scope = workspace_id || null;
  const existing = await svc.entities.RetentionPolicy.filter({ workspace_id: scope, data_type, active: true }, "-created_date", 5);
  if (existing.length) throw new ComplianceError(`An active retention policy for ${data_type} already exists in this scope`, "COMPLIANCE_POLICY_EXISTS", 409);
  const policy = await svc.entities.RetentionPolicy.create({
    workspace_id: scope, data_type, retention_days: Number(retention_days), action, legal_basis: legal_basis || "contract", active: true, created_by: created_by || null,
  });
  await recordEvent(svc, { workspace_id: scope, event_type: "retention_policy_changed", legal_basis: legal_basis || "contract", data_categories: [], description: `Retention policy set: ${data_type} → ${retention_days} days (${action})`, actor_id: created_by, metadata: { policy_id: policy.id, data_type, retention_days, action } });
  return policy;
}

export async function listRetentionPolicies(svc, { workspace_id = null } = {}) {
  const query = { active: true };
  if (workspace_id) query.workspace_id = workspace_id;
  return svc.entities.RetentionPolicy.filter(query, "-created_date", 100);
}

export async function deleteRetentionPolicy(svc, { policy_id }) {
  const policy = await svc.entities.RetentionPolicy.get(policy_id).catch(() => null);
  if (!policy) throw new ComplianceError("Policy not found", "COMPLIANCE_NO_POLICY", 404);
  await svc.entities.RetentionPolicy.update(policy_id, { active: false });
  return { ok: true };
}

// Find records of a data type that are past their retention period. Returns the count and a
// sample of IDs; the actual deletion is a platform integration point.
export async function findExpiredRecords(svc, { workspace_id, data_type, now = Date.now() }) {
  const policy = await getRetentionPolicy(svc, { workspace_id, data_type });
  if (!policy || policy.retention_days === 0) return { policy: null, expired: [] };
  const cutoff = new Date(now - policy.retention_days * 86400000).toISOString();
  // Map data_type to the entity and date field.
  const entityMap = {
    audit_logs: { entity: "AuditLog", date_field: "created_date" },
    usage_events: { entity: "UsageEvent", date_field: "created_date" },
    ai_operations: { entity: "AIOperation", date_field: "created_date" },
    deployments: { entity: "Deployment", date_field: "created_date" },
    billing_events: { entity: "BillingEvent", date_field: "created_date" },
    abuse_reports: { entity: "AbuseReport", date_field: "created_date" },
    dsr_records: { entity: "DataSubjectRequest", date_field: "created_date" },
  };
  const mapping = entityMap[data_type];
  if (!mapping) return { policy, expired: [] };
  // The storage layer does not support date-range filters directly; we fetch recent records and
  // filter in-memory. For production scale this would be a server-side query.
  const rows = await svc.entities[mapping.entity].filter({}, "-created_date", 500);
  const expired = rows.filter((r) => r[mapping.date_field] && r[mapping.date_field] < cutoff).map((r) => r.id);
  return { policy, expired };
}

// =========================================================== data breaches

export async function reportBreach(svc, { workspace_id, severity, description, affected_data_categories = [], affected_user_count = 0, detected_at = null, reported_by }) {
  const validSev = ["low", "medium", "high", "critical"].includes(severity);
  if (!validSev) throw new ComplianceError("Invalid severity", "COMPLIANCE_BAD_SEVERITY");
  if (!description) throw new ComplianceError("description is required", "COMPLIANCE_NO_DESCRIPTION");
  const now = new Date();
  const detected = detected_at ? new Date(detected_at).toISOString() : now.toISOString();
  // GDPR Art. 33: notify within 72 hours for high/critical severity.
  const notificationRequired = ["high", "critical"].includes(severity);
  const deadline = notificationRequired ? new Date(Date.parse(detected) + 72 * 3600000).toISOString() : null;
  const breach = await svc.entities.DataBreach.create({
    workspace_id: workspace_id || null, severity, status: "detected", detected_at: detected,
    contained_at: null, resolved_at: null, description: String(description).slice(0, 4000), root_cause: null,
    affected_data_categories: Array.isArray(affected_data_categories) ? affected_data_categories : [],
    affected_user_count: num(affected_user_count, 0), notification_required: notificationRequired,
    notification_deadline: deadline, regulator_notified_at: null, users_notified_at: null, remediation: null,
    reported_by: reported_by || null, assigned_to: null,
  });
  await recordEvent(svc, { workspace_id, event_type: "breach_detected", legal_basis: "gdpr_art_6_1_c_legal", data_categories: affected_data_categories, description: `Data breach detected: ${severity}`, actor_id: reported_by, metadata: { breach_id: breach.id, severity, notification_required: notificationRequired } });
  return { breach };
}

export async function containBreach(svc, { breach_id, root_cause, assigned_to }) {
  const breach = await svc.entities.DataBreach.get(breach_id).catch(() => null);
  if (!breach) throw new ComplianceError("Breach not found", "COMPLIANCE_NO_BREACH", 404);
  if (breach.status === "contained" || breach.status === "resolved") return { breach, duplicate: true };
  const updated = await svc.entities.DataBreach.update(breach_id, { status: "contained", contained_at: new Date().toISOString(), root_cause: root_cause || breach.root_cause, assigned_to: assigned_to || breach.assigned_to });
  return { breach: updated, duplicate: false };
}

export async function resolveBreach(svc, { breach_id, remediation, resolved_by }) {
  const breach = await svc.entities.DataBreach.get(breach_id).catch(() => null);
  if (!breach) throw new ComplianceError("Breach not found", "COMPLIANCE_NO_BREACH", 404);
  if (breach.status === "resolved") return { breach, duplicate: true };
  const updated = await svc.entities.DataBreach.update(breach_id, { status: "resolved", resolved_at: new Date().toISOString(), remediation: remediation || breach.remediation });
  await recordEvent(svc, { workspace_id: breach.workspace_id, event_type: "breach_notified", legal_basis: "gdpr_art_6_1_c_legal", data_categories: breach.affected_data_categories, description: `Breach resolved: ${breach.severity}`, actor_id: resolved_by, metadata: { breach_id } });
  return { breach: updated, duplicate: false };
}

export async function notifyRegulator(svc, { breach_id, notified_by }) {
  const breach = await svc.entities.DataBreach.get(breach_id).catch(() => null);
  if (!breach) throw new ComplianceError("Breach not found", "COMPLIANCE_NO_BREACH", 404);
  if (!breach.notification_required) throw new ComplianceError("This breach does not require regulator notification", "COMPLIANCE_NO_NOTIFICATION_REQUIRED", 409);
  if (breach.regulator_notified_at) return { breach, duplicate: true };
  const now = new Date().toISOString();
  const updated = await svc.entities.DataBreach.update(breach_id, { regulator_notified_at: now, status: breach.status === "resolved" ? "notified" : breach.status });
  await recordEvent(svc, { workspace_id: breach.workspace_id, event_type: "breach_notified", legal_basis: "gdpr_art_6_1_c_legal", data_categories: breach.affected_data_categories, description: "Regulator notified of data breach", actor_id: notified_by, metadata: { breach_id, notified_at: now } });
  return { breach: updated, duplicate: false };
}

export async function notifyUsers(svc, { breach_id, notified_by }) {
  const breach = await svc.entities.DataBreach.get(breach_id).catch(() => null);
  if (!breach) throw new ComplianceError("Breach not found", "COMPLIANCE_NO_BREACH", 404);
  if (breach.users_notified_at) return { breach, duplicate: true };
  const now = new Date().toISOString();
  const updated = await svc.entities.DataBreach.update(breach_id, { users_notified_at: now });
  await recordEvent(svc, { workspace_id: breach.workspace_id, event_type: "breach_notified", legal_basis: "gdpr_art_6_1_c_legal", data_categories: breach.affected_data_categories, description: "Affected users notified of data breach", actor_id: notified_by, metadata: { breach_id } });
  return { breach: updated, duplicate: false };
}

export async function listBreaches(svc, { workspace_id = null, status = null, limit = 100 } = {}) {
  const query = {};
  if (workspace_id) query.workspace_id = workspace_id;
  if (status) query.status = status;
  return svc.entities.DataBreach.filter(query, "-detected_at", limit);
}

export async function getBreach(svc, breach_id) {
  return svc.entities.DataBreach.get(breach_id).catch(() => null);
}

// Is a breach past its 72h notification deadline without regulator notification?
export function isBreachOverdue(breach, now = Date.now()) {
  if (!breach.notification_required || breach.regulator_notified_at) return false;
  return breach.notification_deadline && Date.parse(breach.notification_deadline) < now;
}

export { SLA_MS, SEVERITY_RANK, DSR_DEADLINE_DAYS, MIN_RETENTION_DAYS };