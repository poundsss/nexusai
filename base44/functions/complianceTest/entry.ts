// Legal / compliance / abuse — production verification suite.
//
// Exercises the full compliance lifecycle against live storage: legal document versioning and
// acceptance, GDPR data subject requests with email verification, abuse reports with
// auto-suspension and SLA tracking, retention policies with legal-minimum enforcement, and
// data breach response with the 72-hour notification clock. All work runs in a scratch
// workspace that is torn down at the end.
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  getActiveDocument, getDocument, listDocuments, publishDocument, retireDocument,
  acceptDocument, hasAccepted, listAcceptances, pendingAcceptances,
  recordEvent, listEvents,
  fileDsr, verifyDsr, completeDsr, rejectDsr, listDsrs, isDsrOverdue,
  fileAbuseReport, assignAbuseReport, resolveAbuseReport, listAbuseReports, isReportOverdue,
  getRetentionPolicy, createRetentionPolicy, listRetentionPolicies, deleteRetentionPolicy, findExpiredRecords,
  reportBreach, containBreach, resolveBreach, notifyRegulator, notifyUsers, listBreaches, isBreachOverdue,
  SLA_MS, DSR_DEADLINE_DAYS, MIN_RETENTION_DAYS,
} from "../../shared/compliance.ts";
import { can } from "../../shared/rbac.ts";

export default async function (req) {
  const h = createHarness();
  const svc = (await import("npm:@base44/sdk@0.8.53")).createClientFromRequest(req).asServiceRole;
  const track = { workspaces: [], documents: [], acceptances: [], dsrs: [], reports: [], policies: [], breaches: [], events: [] };

  try {
    const ws = await svc.entities.Workspace.create({ name: "Compliance Test", owner_id: "u_comp" });
    track.workspaces.push(ws.id);
    const wsB = await svc.entities.Workspace.create({ name: "Compliance Test B", owner_id: "u_comp_b" });
    track.workspaces.push(wsB.id);
    // A target workspace for abuse reports.
    const targetWs = await svc.entities.Workspace.create({ name: "Abuse Target", owner_id: "u_bad" });
    track.workspaces.push(targetWs.id);

    // =========================================================== RBAC
    h.check("compliance.manage is admin+ only", can("owner", "compliance.manage") && can("admin", "compliance.manage") && !can("editor", "compliance.manage"));
    h.check("compliance.read is admin+ only", can("owner", "compliance.read") && can("admin", "compliance.read") && !can("editor", "compliance.read"));
    h.check("abuse.report is member-wide", can("viewer", "abuse.report") && can("editor", "abuse.report"));
    h.check("abuse.moderate is admin+ only", can("admin", "abuse.moderate") && !can("editor", "abuse.moderate"));
    h.check("dsr.manage is admin+ only", can("admin", "dsr.manage") && !can("editor", "dsr.manage"));
    h.check("breach.manage is admin+ only", can("admin", "breach.manage") && !can("editor", "breach.manage"));
    h.check("retention.manage is admin+ only", can("admin", "retention.manage") && !can("editor", "retention.manage"));

    // =========================================================== legal documents
    h.check("a document requires a type", await h.expectThrow("no type", () => publishDocument(svc, { version: "v1", title: "T", content_url: "https://tos.example.com/v1" }), "COMPLIANCE_NO_TYPE") !== false);
    h.check("a document requires a version", await h.expectThrow("no version", () => publishDocument(svc, { type: "tos", title: "T", content_url: "u" }), "COMPLIANCE_NO_VERSION") !== false);

    const tos1 = await publishDocument(svc, { workspace_id: ws.id, type: "tos", version: "2026-01-15", title: "Terms of Service", content_url: "https://legal.example.com/tos/2026-01-15", content_checksum: "sha256:abc", required_for: "all", published_by: "u_comp" });
    track.documents.push(tos1.doc.id);
    h.check("a document is published active", tos1.doc.status === "active" && tos1.doc.type === "tos");
    h.check("the active document is retrievable by type", (await getActiveDocument(svc, "tos")).id === tos1.doc.id);

    // Version uniqueness.
    h.check("a duplicate version is refused", await h.expectThrow("dup version", () => publishDocument(svc, { type: "tos", version: "2026-01-15", title: "T", content_url: "u" }), "COMPLIANCE_VERSION_EXISTS") !== false);

    // Publishing a new version retires the previous.
    const tos2 = await publishDocument(svc, { workspace_id: ws.id, type: "tos", version: "2026-06-01", title: "Terms of Service v2", content_url: "https://legal.example.com/tos/2026-06-01", content_checksum: "sha256:def", required_for: "all", published_by: "u_comp" });
    track.documents.push(tos2.doc.id);
    h.check("the new version is active", tos2.doc.status === "active");
    h.check("the previous version is retired", (await getDocument(svc, tos1.doc.id)).status === "retired");
    h.check("the active document is now the new version", (await getActiveDocument(svc, "tos")).id === tos2.doc.id);
    h.check("the retired version was returned by publish", tos2.retired?.id === tos1.doc.id);

    // A retired document cannot be accepted.
    h.check("a retired document cannot be accepted", await h.expectThrow("retired accept", () => acceptDocument(svc, { user_id: "u_user1", document_id: tos1.doc.id }), "COMPLIANCE_NOT_ACTIVE") !== false);

    // =========================================================== legal acceptance
    const acc1 = await acceptDocument(svc, { user_id: "u_user1", workspace_id: ws.id, document_id: tos2.doc.id, ip: "1.2.3.4", user_agent: "Mozilla/5.0" });
    track.acceptances.push(acc1.acceptance.id);
    h.check("an acceptance is recorded", acc1.acceptance.document_id === tos2.doc.id);
    h.check("the ip is hashed not stored raw", acc1.acceptance.ip_hash && !acc1.acceptance.ip_hash.includes("1.2.3.4"));
    h.check("the user agent is hashed", acc1.acceptance.user_agent_hash && !acc1.acceptance.user_agent_hash.includes("Mozilla"));

    // Idempotent acceptance.
    const acc1b = await acceptDocument(svc, { user_id: "u_user1", document_id: tos2.doc.id });
    h.check("re-accepting is idempotent", acc1b.duplicate && acc1b.acceptance.id === acc1.acceptance.id);

    // Acceptance check.
    const check = await hasAccepted(svc, { user_id: "u_user1", type: "tos" });
    h.check("hasAccepted returns true for an accepted document", check.accepted === true);
    const check2 = await hasAccepted(svc, { user_id: "u_user2", type: "tos" });
    h.check("hasAccepted returns false for a non-accepting user", check2.accepted === false);

    // Pending acceptances.
    const pending = await pendingAcceptances(svc, { user_id: "u_user2", required_for: "all" });
    h.check("a new user has pending acceptances", pending.length > 0 && pending.some((d) => d.type === "tos"));
    const pendingAfter = await pendingAcceptances(svc, { user_id: "u_user1", required_for: "all" });
    h.check("an accepting user has no pending tos", !pendingAfter.some((d) => d.type === "tos"));

    // =========================================================== data subject requests
    h.check("a dsr with an invalid type is refused", await h.expectThrow("bad dsr type", () => fileDsr(svc, { workspace_id: ws.id, email: "a@b.com", request_type: "delete_everything" }), "COMPLIANCE_BAD_DSR_TYPE") !== false);
    h.check("a dsr with an invalid email is refused", await h.expectThrow("bad email", () => fileDsr(svc, { workspace_id: ws.id, email: "not-an-email", request_type: "access" }), "COMPLIANCE_BAD_EMAIL") !== false);

    const dsr = await fileDsr(svc, { workspace_id: ws.id, email: "subject@example.com", request_type: "access", requester_user_id: "u_comp" });
    track.dsrs.push(dsr.dsr.id);
    h.check("a dsr is filed in verifying status", dsr.dsr.status === "verifying");
    h.check("a dsr has a verification token", typeof dsr.token === "string" && dsr.token.length > 0);
    h.check("a dsr has a 30-day deadline", dsr.dsr.expires_at && Date.parse(dsr.dsr.expires_at) > Date.now() + 29 * 86400000);
    h.check("a dsr has a legal basis", dsr.dsr.legal_basis === "gdpr_art_15");

    // Wrong token.
    h.check("a wrong verification token is refused", await h.expectThrow("bad token", () => verifyDsr(svc, { dsr_id: dsr.dsr.id, token: "wrong" }), "COMPLIANCE_BAD_TOKEN") !== false);

    // Correct token.
    const verified = await verifyDsr(svc, { dsr_id: dsr.dsr.id, token: dsr.token });
    h.check("a correct token moves the dsr to in_progress", verified.dsr.status === "in_progress" && verified.dsr.verified_at);

    // Complete.
    const completed = await completeDsr(svc, { dsr_id: dsr.dsr.id, response_data_uri: "private://dsr-exports/access-1.json", assigned_to: "u_comp" });
    h.check("a completed dsr has a completion timestamp", completed.dsr.status === "completed" && completed.dsr.completed_at);
    h.check("completing twice is idempotent", (await completeDsr(svc, { dsr_id: dsr.dsr.id })).duplicate === true);

    // Rejection.
    const dsr2 = await fileDsr(svc, { workspace_id: ws.id, email: "subject2@example.com", request_type: "deletion" });
    track.dsrs.push(dsr2.dsr.id);
    await verifyDsr(svc, { dsr_id: dsr2.dsr.id, token: dsr2.token });
    const rejected = await rejectDsr(svc, { dsr_id: dsr2.dsr.id, reason: "Legal obligation to retain financial records", assigned_to: "u_comp" });
    h.check("a rejected dsr has a reason", rejected.dsr.status === "rejected" && rejected.dsr.rejection_reason.includes("Legal obligation"));

    // Overdue check: file a dsr with a past deadline (manually update).
    const dsr3 = await fileDsr(svc, { workspace_id: ws.id, email: "subject3@example.com", request_type: "portability" });
    track.dsrs.push(dsr3.dsr.id);
    await svc.entities.DataSubjectRequest.update(dsr3.dsr.id, { expires_at: new Date(Date.now() - 86400000).toISOString() });
    const refreshedDsr3 = await svc.entities.DataSubjectRequest.get(dsr3.dsr.id);
    h.check("an uncompleted dsr past its deadline is overdue", isDsrOverdue(refreshedDsr3));
    h.check("a completed dsr is not overdue", !isDsrOverdue(completed.dsr));

    // =========================================================== abuse reports
    h.check("an abuse report with an invalid category is refused", await h.expectThrow("bad category", () => fileAbuseReport(svc, { target_type: "workspace", target_id: targetWs.id, category: "revenge" }), "COMPLIANCE_BAD_CATEGORY") !== false);
    h.check("an abuse report with no target is refused", await h.expectThrow("no target", () => fileAbuseReport(svc, { target_type: "workspace", target_id: "", category: "spam" }), "COMPLIANCE_NO_TARGET") !== false);

    // Low-severity report: no auto-suspend.
    const rep1 = await fileAbuseReport(svc, { reporter_workspace_id: ws.id, reporter_user_id: "u_comp", target_type: "workspace", target_id: targetWs.id, category: "spam", severity: "low", description: "spammy workspace" });
    track.reports.push(rep1.report.id);
    h.check("a low-severity report is open", rep1.report.status === "open");
    h.check("a low-severity report does not auto-suspend", rep1.auto_suspended === false);
    h.check("a low-severity report has a 168h SLA", Date.parse(rep1.report.sla_due_at) > Date.now() + 167 * 3600000);

    // Critical report: auto-suspend.
    const rep2 = await fileAbuseReport(svc, { reporter_workspace_id: ws.id, reporter_user_id: "u_comp", target_type: "workspace", target_id: targetWs.id, category: "malware", severity: "critical", description: "distributing malware" });
    track.reports.push(rep2.report.id);
    h.check("a critical report auto-suspends the target", rep2.auto_suspended === true);
    h.check("the target workspace is suspended", (await svc.entities.Workspace.get(targetWs.id)).status === "suspended");
    h.check("a critical report has a 4h SLA", Date.parse(rep2.report.sla_due_at) < Date.now() + 5 * 3600000);

    // CSAM: always critical, highest priority.
    const rep3 = await fileAbuseReport(svc, { reporter_workspace_id: ws.id, reporter_user_id: "u_comp", target_type: "content", target_id: "content-123", category: "csam", severity: "low", description: "csam content" });
    track.reports.push(rep3.report.id);
    h.check("csam is always critical severity", rep3.report.severity === "critical");
    h.check("csam has the highest priority", rep3.report.priority >= 14);
    h.check("csam auto-suspends", rep3.auto_suspended === true);

    // Resolve a report with suspension.
    const resolved = await resolveAbuseReport(svc, { report_id: rep1.report.id, resolution: "suspension", note: "confirmed spam", resolved_by: "u_comp" });
    h.check("resolving with suspension actioned the report", resolved.report.status === "actioned" && resolved.report.resolution === "suspension");
    h.check("resolving twice is idempotent", (await resolveAbuseReport(svc, { report_id: rep1.report.id, resolution: "suspension" })).duplicate === true);

    // Resolve with no_action → dismissed.
    const dismissed = await resolveAbuseReport(svc, { report_id: rep3.report.id, resolution: "no_action", note: "false report", resolved_by: "u_comp" });
    h.check("no_action dismisses the report", dismissed.report.status === "dismissed");

    // Overdue check: a report past its SLA.
    const rep4 = await fileAbuseReport(svc, { reporter_workspace_id: ws.id, target_type: "workspace", target_id: targetWs.id, category: "harassment", severity: "high" });
    track.reports.push(rep4.report.id);
    await svc.entities.AbuseReport.update(rep4.report.id, { sla_due_at: new Date(Date.now() - 3600000).toISOString() });
    const refreshedRep4 = await svc.entities.AbuseReport.get(rep4.report.id);
    h.check("a report past its SLA is overdue", isReportOverdue(refreshedRep4));
    h.check("an actioned report is not overdue", !isReportOverdue(resolved.report));

    // List by priority: CSAM should be first (highest priority).
    const allReports = await listAbuseReports(svc, {});
    h.check("reports are sorted by priority descending", allReports[0].priority >= allReports[allReports.length - 1].priority);

    // =========================================================== retention policies
    h.check("a retention policy below the legal minimum is refused", await h.expectThrow("too low", () => createRetentionPolicy(svc, { workspace_id: ws.id, data_type: "audit_logs", retention_days: 30, legal_basis: "test" }), "COMPLIANCE_RETENTION_TOO_LOW") !== false);
    h.check("an invalid data type is refused", await h.expectThrow("bad type", () => createRetentionPolicy(svc, { workspace_id: ws.id, data_type: "everything", retention_days: 365 }), "COMPLIANCE_BAD_DATA_TYPE") !== false);

    const policy = await createRetentionPolicy(svc, { workspace_id: ws.id, data_type: "audit_logs", retention_days: 400, action: "delete", legal_basis: "internal_policy", created_by: "u_comp" });
    track.policies.push(policy.id);
    h.check("a valid retention policy is created", policy.active === true && policy.retention_days === 400);
    h.check("a duplicate policy for the same scope+type is refused", await h.expectThrow("dup policy", () => createRetentionPolicy(svc, { workspace_id: ws.id, data_type: "audit_logs", retention_days: 500 }), "COMPLIANCE_POLICY_EXISTS") !== false);

    // Workspace-specific policy overrides the platform default.
    const wsPolicy = await getRetentionPolicy(svc, { workspace_id: ws.id, data_type: "audit_logs" });
    h.check("the workspace policy is retrieved", wsPolicy?.id === policy.id);

    // Platform-wide policy (workspace_id = null).
    const platformPolicy = await createRetentionPolicy(svc, { workspace_id: null, data_type: "usage_events", retention_days: 90, action: "anonymize", legal_basis: "gdpr_minimization", created_by: "u_comp" });
    track.policies.push(platformPolicy.id);
    h.check("a platform-wide policy is retrievable", (await getRetentionPolicy(svc, { workspace_id: "other-ws", data_type: "usage_events" }))?.id === platformPolicy.id);

    // 0 retention_days = retain indefinitely (legal hold).
    const holdPolicy = await createRetentionPolicy(svc, { workspace_id: ws.id, data_type: "billing_events", retention_days: 0, action: "archive", legal_basis: "legal_hold" });
    track.policies.push(holdPolicy.id);
    h.check("a 0-day retention policy is a legal hold", holdPolicy.retention_days === 0);

    // Find expired records.
    const expired = await findExpiredRecords(svc, { workspace_id: ws.id, data_type: "audit_logs" });
    h.check("findExpiredRecords returns the policy", expired.policy?.id === policy.id);

    // Delete a policy.
    await deleteRetentionPolicy(svc, { policy_id: policy.id });
    h.check("a deleted policy is inactive", (await svc.entities.RetentionPolicy.get(policy.id)).active === false);

    // =========================================================== data breaches
    h.check("a breach with invalid severity is refused", await h.expectThrow("bad sev", () => reportBreach(svc, { workspace_id: ws.id, severity: "catastrophic", description: "bad" }), "COMPLIANCE_BAD_SEVERITY") !== false);
    h.check("a breach with no description is refused", await h.expectThrow("no desc", () => reportBreach(svc, { workspace_id: ws.id, severity: "high" }), "COMPLIANCE_NO_DESCRIPTION") !== false);

    // Low-severity breach: no notification required.
    const lowBreach = await reportBreach(svc, { workspace_id: ws.id, severity: "low", description: "minor incident", affected_data_categories: ["technical"], reported_by: "u_comp" });
    track.breaches.push(lowBreach.breach.id);
    h.check("a low breach does not require notification", lowBreach.breach.notification_required === false);
    h.check("a low breach has no notification deadline", lowBreach.breach.notification_deadline === null);

    // High-severity breach: 72h notification clock.
    const highBreach = await reportBreach(svc, { workspace_id: ws.id, severity: "high", description: "credentials exposed", affected_data_categories: ["identity", "credentials"], affected_user_count: 500, reported_by: "u_comp" });
    track.breaches.push(highBreach.breach.id);
    h.check("a high breach requires notification", highBreach.breach.notification_required === true);
    h.check("a high breach has a 72h deadline", highBreach.breach.notification_deadline && Math.abs(Date.parse(highBreach.breach.notification_deadline) - Date.now() - 72 * 3600000) < 60000);
    h.check("a high breach starts in detected status", highBreach.breach.status === "detected");

    // Cannot notify regulator for a non-notifiable breach.
    h.check("notifying regulator for a non-notifiable breach is refused", await h.expectThrow("no notif", () => notifyRegulator(svc, { breach_id: lowBreach.breach.id, notified_by: "u_comp" }), "COMPLIANCE_NO_NOTIFICATION_REQUIRED") !== false);

    // Contain the high breach.
    const contained = await containBreach(svc, { breach_id: highBreach.breach.id, root_cause: "misconfigured S3 bucket", assigned_to: "u_comp" });
    h.check("containing moves to contained status", contained.breach.status === "contained" && contained.breach.contained_at);

    // Notify regulator.
    const notified = await notifyRegulator(svc, { breach_id: highBreach.breach.id, notified_by: "u_comp" });
    h.check("regulator notification is recorded", notified.breach.regulator_notified_at !== null);
    h.check("notifying twice is idempotent", (await notifyRegulator(svc, { breach_id: highBreach.breach.id })).duplicate === true);

    // Notify users.
    const usersNotified = await notifyUsers(svc, { breach_id: highBreach.breach.id, notified_by: "u_comp" });
    h.check("user notification is recorded", usersNotified.breach.users_notified_at !== null);

    // Resolve.
    const resolvedBreach = await resolveBreach(svc, { breach_id: highBreach.breach.id, remediation: "rotated all credentials, closed bucket", resolved_by: "u_comp" });
    h.check("resolving moves to resolved status", resolvedBreach.breach.status === "resolved" && resolvedBreach.breach.resolved_at);

    // Overdue breach: past 72h without notification.
    const overdueBreach = await reportBreach(svc, { workspace_id: ws.id, severity: "critical", description: "critical exposure", reported_by: "u_comp" });
    track.breaches.push(overdueBreach.breach.id);
    await svc.entities.DataBreach.update(overdueBreach.breach.id, { notification_deadline: new Date(Date.now() - 3600000).toISOString() });
    const refreshedOverdue = await svc.entities.DataBreach.get(overdueBreach.breach.id);
    h.check("a breach past its deadline without notification is overdue", isBreachOverdue(refreshedOverdue));
    h.check("a notified breach is not overdue", !isBreachOverdue(notified.breach));

    // =========================================================== compliance events
    const events = await listEvents(svc, { workspace_id: ws.id });
    h.check("compliance events were recorded for each action", events.length >= 10, `${events.length} events`);
    h.check("a terms_accepted event exists", events.some((e) => e.event_type === "terms_accepted"));
    h.check("a dsr_filed event exists", events.some((e) => e.event_type === "dsr_filed"));
    h.check("a dsr_completed event exists", events.some((e) => e.event_type === "dsr_completed"));
    h.check("a breach_detected event exists", events.some((e) => e.event_type === "breach_detected"));
    h.check("a retention_policy_changed event exists", events.some((e) => e.event_type === "retention_policy_changed"));

    // =========================================================== cross-workspace isolation
    const wsBEvents = await listEvents(svc, { workspace_id: wsB.id });
    h.check("events are isolated per workspace", wsBEvents.length === 0);
    const wsBDsrs = await listDsrs(svc, { workspace_id: wsB.id });
    h.check("dsrs are isolated per workspace", wsBDsrs.length === 0);

    // =========================================================== cleanup
    for (const id of track.breaches) await svc.entities.DataBreach.delete(id).catch(() => {});
    for (const id of track.policies) await svc.entities.RetentionPolicy.delete(id).catch(() => {});
    for (const id of track.reports) await svc.entities.AbuseReport.delete(id).catch(() => {});
    for (const id of track.dsrs) await svc.entities.DataSubjectRequest.delete(id).catch(() => {});
    for (const id of track.acceptances) await svc.entities.LegalAcceptance.delete(id).catch(() => {});
    for (const id of track.documents) await svc.entities.LegalDocument.delete(id).catch(() => {});
    const eventRows = await svc.entities.ComplianceEvent.filter({ workspace_id: ws.id }, "-created_date", 500).catch(() => []);
    for (const r of eventRows) await svc.entities.ComplianceEvent.delete(r.id).catch(() => {});
    const auditRows = await svc.entities.AuditLog.filter({ workspace_id: ws.id }, "-created_date", 500).catch(() => []);
    for (const r of auditRows) await svc.entities.AuditLog.delete(r.id).catch(() => {});
    for (const id of track.workspaces) await svc.entities.Workspace.delete(id).catch(() => {});

    return harnessResponse(h);
  } catch (error) {
    for (const id of track.breaches) await svc.entities.DataBreach.delete(id).catch(() => {});
    for (const id of track.policies) await svc.entities.RetentionPolicy.delete(id).catch(() => {});
    for (const id of track.reports) await svc.entities.AbuseReport.delete(id).catch(() => {});
    for (const id of track.dsrs) await svc.entities.DataSubjectRequest.delete(id).catch(() => {});
    for (const id of track.acceptances) await svc.entities.LegalAcceptance.delete(id).catch(() => {});
    for (const id of track.documents) await svc.entities.LegalDocument.delete(id).catch(() => {});
    for (const id of track.workspaces) await svc.entities.Workspace.delete(id).catch(() => {});
    return harnessError(h, error);
  }
}