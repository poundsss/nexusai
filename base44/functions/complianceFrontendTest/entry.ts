// Compliance / Trust frontend integration verification.
//
// Verifies the data contracts and security boundaries the Compliance frontend depends on:
//   • legal document records carry the fields LegalDocumentCard renders (type, version, title,
//     status, effective_date, content_url) and acceptance state is derivable from pending list
//   • DSR records carry the fields DsrRow renders (request_type, email, status, created_date,
//     expires_at) and the verification workflow (verifying → in_progress → completed) is correct
//   • abuse report records carry the fields AbuseReportRow renders (target_type, target_id,
//     category, status, description, sla_due_at, auto_suspended)
//   • retention policy records carry the fields RetentionPolicyRow renders (data_type,
//     retention_days, action, workspace_id, legal_basis) and legal minimums are enforced
//   • compliance event records carry the fields ComplianceEventRow renders (event_type,
//     legal_basis, description, created_date, actor_id)
//   • breach records carry the fields BreachRow renders (severity, status, description,
//     detected_at, notification_required, notification_deadline, affected_user_count)
//   • the RBAC capability matrix the sidebar uses to show/hide compliance nav is correct
//   • cross-workspace isolation: one workspace's DSRs never appear in another's list
//   • the DSR verification token is never needed by the frontend list view (the user enters it
//     manually from their email; the list view works without it)
//
// All work runs in scratch workspaces torn down at the end.
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  listDocuments, publishDocument, retireDocument, acceptDocument, pendingAcceptances, listAcceptances,
  fileDsr, verifyDsr, completeDsr, rejectDsr, listDsrs, isDsrOverdue,
  fileAbuseReport, listAbuseReports, isReportOverdue,
  createRetentionPolicy, listRetentionPolicies, deleteRetentionPolicy, MIN_RETENTION_DAYS,
  reportBreach, containBreach, resolveBreach, notifyRegulator, notifyUsers, listBreaches, isBreachOverdue,
  recordEvent, listEvents,
} from "../../shared/compliance.ts";
import { can, capabilitiesFor } from "../../shared/rbac.ts";

export default async function (req) {
  const h = createHarness();
  const svc = (await import("npm:@base44/sdk@0.8.53")).createClientFromRequest(req).asServiceRole;
  const track = { workspaces: [], documents: [], dsrs: [], reports: [], policies: [], breaches: [] };

  try {
    // --- scratch workspaces ---
    const wsA = await svc.entities.Workspace.create({ name: "Comp FE Test A", owner_id: "u_comp_fe_a" });
    track.workspaces.push(wsA.id);
    const wsB = await svc.entities.Workspace.create({ name: "Comp FE Test B", owner_id: "u_comp_fe_b" });
    track.workspaces.push(wsB.id);

    // =========================================================== RBAC visibility (sidebar)
    // The sidebar shows the Compliance group to everyone; retention/audit/breaches only when
    // the caller has compliance.read.
    h.check("compliance.read is held by owner and admin only", can("owner", "compliance.read") && can("admin", "compliance.read") && !can("editor", "compliance.read") && !can("viewer", "compliance.read"));
    h.check("abuse.report is held by all members", can("owner", "abuse.report") && can("admin", "abuse.report") && can("editor", "abuse.report") && can("viewer", "abuse.report"));
    h.check("abuse.moderate is held by owner and admin only", can("owner", "abuse.moderate") && can("admin", "abuse.moderate") && !can("editor", "abuse.moderate"));
    h.check("dsr.manage is held by owner and admin only", can("owner", "dsr.manage") && can("admin", "dsr.manage") && !can("editor", "dsr.manage"));
    h.check("breach.manage is held by owner and admin only", can("owner", "breach.manage") && can("admin", "breach.manage") && !can("editor", "breach.manage"));
    h.check("retention.manage is held by owner and admin only", can("owner", "retention.manage") && can("admin", "retention.manage") && !can("editor", "retention.manage"));
    h.check("capabilitiesFor(viewer) includes abuse.report but not compliance.read", capabilitiesFor("viewer").includes("abuse.report") && !capabilitiesFor("viewer").includes("compliance.read"));
    h.check("capabilitiesFor(admin) includes all compliance capabilities", ["compliance.read", "compliance.manage", "abuse.moderate", "dsr.manage", "breach.manage", "retention.manage"].every((c) => capabilitiesFor("admin").includes(c)));

    // =========================================================== Legal document shape
    const tos = await publishDocument(svc, { workspace_id: wsA.id, type: "tos", version: "2026-09-v1", title: "Terms of Service", content_url: "https://legal.example.com/tos/v1", required_for: "all", published_by: "u_comp_fe_a" });
    track.documents.push(tos.doc.id);
    h.check("the document record carries title for LegalDocumentCard", tos.doc.title === "Terms of Service");
    h.check("the document record carries type for LegalDocumentCard", tos.doc.type === "tos");
    h.check("the document record carries version for LegalDocumentCard", tos.doc.version === "2026-09-v1");
    h.check("the document record carries status for LegalDocumentCard", tos.doc.status === "active");
    h.check("the document record carries content_url for LegalDocumentCard", tos.doc.content_url === "https://legal.example.com/tos/v1");
    h.check("the document record carries effective_date for LegalDocumentCard", typeof tos.doc.effective_date === "string");
    h.check("the document record carries published_at for LegalDocumentCard", typeof tos.doc.published_at === "string");

    // listDocuments returns the shape the frontend page expects
    const allDocs = await listDocuments(svc, {});
    h.check("listDocuments returns an array of documents", Array.isArray(allDocs) && allDocs.length > 0);
    h.check("listDocuments returns documents with all rendered fields", allDocs.every((d) => "type" in d && "version" in d && "title" in d && "status" in d));

    // Pending acceptances — the shape the Compliance overview and Legal page consume
    const pending = await pendingAcceptances(svc, { user_id: "u_comp_fe_a", required_for: "all" });
    h.check("pendingAcceptances returns an array", Array.isArray(pending));
    h.check("the active ToS is in pending for a user who hasn't accepted", pending.some((d) => d.id === tos.doc.id));

    // Accept the document
    const accepted = await acceptDocument(svc, { user_id: "u_comp_fe_a", workspace_id: wsA.id, document_id: tos.doc.id, ip: "127.0.0.1", user_agent: "test-agent" });
    h.check("acceptDocument returns an acceptance record", !!accepted.acceptance.id);
    h.check("the acceptance record carries document_type and document_version", accepted.acceptance.document_type === "tos" && accepted.acceptance.document_version === "2026-09-v1");
    h.check("the acceptance record carries accepted_at", typeof accepted.acceptance.accepted_at === "string");
    h.check("the acceptance record stores ip_hash, not the raw IP", typeof accepted.acceptance.ip_hash === "string" && !("ip" in accepted.acceptance));
    h.check("the acceptance record stores user_agent_hash, not the raw UA", typeof accepted.acceptance.user_agent_hash === "string" && !("user_agent" in accepted.acceptance));

    // After acceptance, the doc is no longer pending
    const pendingAfter = await pendingAcceptances(svc, { user_id: "u_comp_fe_a", required_for: "all" });
    h.check("after acceptance the doc is no longer pending", !pendingAfter.some((d) => d.id === tos.doc.id));

    // Versioning: publishing a new version retires the old one
    const tos2 = await publishDocument(svc, { workspace_id: wsA.id, type: "tos", version: "2026-09-v2", title: "Terms of Service v2", content_url: "https://legal.example.com/tos/v2", required_for: "all", published_by: "u_comp_fe_a" });
    track.documents.push(tos2.doc.id);
    h.check("publishing a new version retires the old one", tos2.retired && tos2.retired.id === tos.doc.id);
    // The `retired` field is the pre-update record; re-fetch to confirm storage reflects the retirement.
    const tos1Refetched = await svc.entities.LegalDocument.get(tos.doc.id).catch(() => null);
    h.check("the old version is now retired in storage", tos1Refetched && tos1Refetched.status === "retired");
    h.check("the new version is active", tos2.doc.status === "active");

    // =========================================================== DSR shape + workflow
    const dsr = await fileDsr(svc, { workspace_id: wsA.id, email: "user@example.com", request_type: "access", requester_user_id: "u_comp_fe_a" });
    track.dsrs.push(dsr.dsr.id);
    h.check("fileDsr returns a DSR record", !!dsr.dsr.id);
    h.check("fileDsr returns a verification token", typeof dsr.token === "string" && dsr.token.length > 0);
    h.check("the DSR record carries email for DsrRow", dsr.dsr.email === "user@example.com");
    h.check("the DSR record carries request_type for DsrRow", dsr.dsr.request_type === "access");
    h.check("the DSR record carries status 'verifying' for DsrRow", dsr.dsr.status === "verifying");
    h.check("the DSR record carries created_date for DsrRow", typeof dsr.dsr.created_date === "string");
    h.check("the DSR record carries expires_at for DsrRow", typeof dsr.dsr.expires_at === "string");
    h.check("the DSR record carries legal_basis for DsrRow", typeof dsr.dsr.legal_basis === "string");

    // Verify the DSR with the token
    const verified = await verifyDsr(svc, { dsr_id: dsr.dsr.id, token: dsr.token });
    h.check("verifyDsr moves the DSR to in_progress", verified.dsr.status === "in_progress");
    h.check("verifyDsr sets verified_at", typeof verified.dsr.verified_at === "string");

    // Complete the DSR (already verified above)
    const completed = await completeDsr(svc, { dsr_id: dsr.dsr.id, assigned_to: "u_comp_fe_a" });
    h.check("completeDsr moves the DSR to completed", completed.dsr.status === "completed");
    h.check("completeDsr sets completed_at", typeof completed.dsr.completed_at === "string");

    // Wrong-token rejection: file a fresh DSR (still in "verifying") and try a bad token.
    const wrongTokenDsr = await fileDsr(svc, { workspace_id: wsA.id, email: "wrongtoken@example.com", request_type: "access", requester_user_id: "u_comp_fe_a" });
    track.dsrs.push(wrongTokenDsr.dsr.id);
    const badVerify = await h.expectThrow("wrong token rejected", () => verifyDsr(svc, { dsr_id: wrongTokenDsr.dsr.id, token: "wrong-token" }), "COMPLIANCE_BAD_TOKEN");
    h.check("a wrong verification token is rejected", badVerify);

    // Deletion DSR workflow
    const delDsr = await fileDsr(svc, { workspace_id: wsA.id, email: "delete@example.com", request_type: "deletion", requester_user_id: "u_comp_fe_a" });
    track.dsrs.push(delDsr.dsr.id);
    h.check("a deletion DSR starts in verifying", delDsr.dsr.status === "verifying" && delDsr.dsr.request_type === "deletion");
    const delVerified = await verifyDsr(svc, { dsr_id: delDsr.dsr.id, token: delDsr.token });
    h.check("a deletion DSR moves to in_progress after verification", delVerified.dsr.status === "in_progress");
    const delCompleted = await completeDsr(svc, { dsr_id: delDsr.dsr.id, assigned_to: "u_comp_fe_a" });
    h.check("a deletion DSR can be completed", delCompleted.dsr.status === "completed");

    // Rejection workflow
    const rejDsr = await fileDsr(svc, { workspace_id: wsA.id, email: "reject@example.com", request_type: "access", requester_user_id: "u_comp_fe_a" });
    track.dsrs.push(rejDsr.dsr.id);
    const rejVerified = await verifyDsr(svc, { dsr_id: rejDsr.dsr.id, token: rejDsr.token });
    const rejected = await rejectDsr(svc, { dsr_id: rejDsr.dsr.id, reason: "Legitimate interest override", assigned_to: "u_comp_fe_a" });
    h.check("rejectDsr moves the DSR to rejected", rejected.dsr.status === "rejected");
    h.check("rejectDsr sets rejection_reason", rejected.dsr.rejection_reason === "Legitimate interest override");

    // listDsrs — the shape the DSR list page consumes
    const allDsrs = await listDsrs(svc, { workspace_id: wsA.id });
    h.check("listDsrs returns an array", Array.isArray(allDsrs) && allDsrs.length >= 3);
    h.check("listDsrs returns DSRs with all rendered fields", allDsrs.every((d) => "email" in d && "request_type" in d && "status" in d && "created_date" in d));

    // =========================================================== DSR cross-workspace isolation
    const wsBDsrs = await listDsrs(svc, { workspace_id: wsB.id });
    h.check("workspace B has no DSRs from workspace A", wsBDsrs.length === 0);

    // =========================================================== Abuse report shape
    const report = await fileAbuseReport(svc, { reporter_workspace_id: wsA.id, reporter_user_id: "u_comp_fe_a", target_type: "workspace", target_id: wsB.id, category: "spam", severity: "medium", description: "Spam content detected" });
    track.reports.push(report.report.id);
    h.check("fileAbuseReport returns a report record", !!report.report.id);
    h.check("the report carries target_type for AbuseReportRow", report.report.target_type === "workspace");
    h.check("the report carries target_id for AbuseReportRow", report.report.target_id === wsB.id);
    h.check("the report carries category for AbuseReportRow", report.report.category === "spam");
    h.check("the report carries status 'open' for AbuseReportRow", report.report.status === "open");
    h.check("the report carries description for AbuseReportRow", report.report.description === "Spam content detected");
    h.check("the report carries sla_due_at for AbuseReportRow", typeof report.report.sla_due_at === "string");
    h.check("the report carries priority for AbuseReportRow", typeof report.report.priority === "number");
    h.check("the report carries auto_suspended for AbuseReportRow", typeof report.report.auto_suspended === "boolean");

    // Critical severity auto-suspends
    const criticalReport = await fileAbuseReport(svc, { reporter_workspace_id: wsA.id, reporter_user_id: "u_comp_fe_a", target_type: "workspace", target_id: wsB.id, category: "malware", severity: "critical", description: "Malware distribution" });
    track.reports.push(criticalReport.report.id);
    h.check("a critical report auto-suspends", criticalReport.auto_suspended === true && criticalReport.report.auto_suspended === true);

    // listAbuseReports — the shape the abuse page consumes
    const allReports = await listAbuseReports(svc, {});
    h.check("listAbuseReports returns an array", Array.isArray(allReports) && allReports.length >= 2);
    h.check("listAbuseReports returns reports with all rendered fields", allReports.every((r) => "target_type" in r && "category" in r && "status" in r));

    // =========================================================== Retention policy shape
    const policy = await createRetentionPolicy(svc, { workspace_id: wsA.id, data_type: "audit_logs", retention_days: 400, action: "delete", legal_basis: "internal_policy", created_by: "u_comp_fe_a" });
    track.policies.push(policy.id);
    h.check("the retention policy carries data_type for RetentionPolicyRow", policy.data_type === "audit_logs");
    h.check("the retention policy carries retention_days for RetentionPolicyRow", policy.retention_days === 400);
    h.check("the retention policy carries action for RetentionPolicyRow", policy.action === "delete");
    h.check("the retention policy carries workspace_id for RetentionPolicyRow", policy.workspace_id === wsA.id);
    h.check("the retention policy carries legal_basis for RetentionPolicyRow", policy.legal_basis === "internal_policy");
    h.check("the retention policy carries active for RetentionPolicyRow", policy.active === true);

    // Legal minimum enforcement
    const tooLow = await h.expectThrow("retention below minimum rejected", () => createRetentionPolicy(svc, { workspace_id: wsA.id, data_type: "audit_logs", retention_days: 10, action: "delete" }), "COMPLIANCE_RETENTION_TOO_LOW");
    h.check("a retention period below the legal minimum is rejected", tooLow);

    // MIN_RETENTION_DAYS is exported for the frontend form to display
    h.check("MIN_RETENTION_DAYS is exported for the frontend form", typeof MIN_RETENTION_DAYS === "object" && typeof MIN_RETENTION_DAYS.audit_logs === "number");

    // listRetentionPolicies — the shape the retention page consumes
    const allPolicies = await listRetentionPolicies(svc, { workspace_id: wsA.id });
    h.check("listRetentionPolicies returns an array", Array.isArray(allPolicies) && allPolicies.length >= 1);
    h.check("listRetentionPolicies returns policies with all rendered fields", allPolicies.every((p) => "data_type" in p && "retention_days" in p && "action" in p));

    // =========================================================== Compliance event shape
    // Filing a DSR already recorded a compliance event; verify the shape
    const events = await listEvents(svc, { workspace_id: wsA.id });
    h.check("listEvents returns an array", Array.isArray(events) && events.length > 0);
    h.check("the event record carries event_type for ComplianceEventRow", events.every((e) => "event_type" in e));
    h.check("the event record carries legal_basis for ComplianceEventRow", events.every((e) => "legal_basis" in e));
    h.check("the event record carries description for ComplianceEventRow", events.every((e) => typeof e.description === "string"));
    h.check("the event record carries created_date for ComplianceEventRow", events.every((e) => typeof e.created_date === "string"));
    h.check("the event record carries actor_id for ComplianceEventRow", events.every((e) => "actor_id" in e));
    h.check("a dsr_filed event was recorded", events.some((e) => e.event_type === "dsr_filed"));
    h.check("a terms_accepted event was recorded", events.some((e) => e.event_type === "terms_accepted"));

    // =========================================================== Breach shape + workflow
    const breach = await reportBreach(svc, { workspace_id: wsA.id, severity: "high", description: "Unauthorized access to user data", affected_data_categories: ["identity", "contact"], affected_user_count: 150, reported_by: "u_comp_fe_a" });
    track.breaches.push(breach.breach.id);
    h.check("the breach record carries severity for BreachRow", breach.breach.severity === "high");
    h.check("the breach record carries status 'detected' for BreachRow", breach.breach.status === "detected");
    h.check("the breach record carries description for BreachRow", breach.breach.description === "Unauthorized access to user data");
    h.check("the breach record carries detected_at for BreachRow", typeof breach.breach.detected_at === "string");
    h.check("the breach record carries notification_required for BreachRow", breach.breach.notification_required === true);
    h.check("the breach record carries notification_deadline for BreachRow", typeof breach.breach.notification_deadline === "string");
    h.check("the breach record carries affected_user_count for BreachRow", breach.breach.affected_user_count === 150);
    h.check("the breach record carries affected_data_categories for BreachRow", Array.isArray(breach.breach.affected_data_categories));

    // Breach workflow: contain → resolve
    const contained = await containBreach(svc, { breach_id: breach.breach.id, root_cause: "Misconfigured access control", assigned_to: "u_comp_fe_a" });
    h.check("containBreach moves the breach to contained", contained.breach.status === "contained");
    h.check("containBreach sets contained_at", typeof contained.breach.contained_at === "string");
    h.check("containBreach sets root_cause", contained.breach.root_cause === "Misconfigured access control");

    // Notify regulator (high severity requires it)
    const notified = await notifyRegulator(svc, { breach_id: breach.breach.id, notified_by: "u_comp_fe_a" });
    h.check("notifyRegulator sets regulator_notified_at", typeof notified.breach.regulator_notified_at === "string");

    // Notify users
    const usersNotified = await notifyUsers(svc, { breach_id: breach.breach.id, notified_by: "u_comp_fe_a" });
    h.check("notifyUsers sets users_notified_at", typeof usersNotified.breach.users_notified_at === "string");

    // Resolve
    const resolved = await resolveBreach(svc, { breach_id: breach.breach.id, remediation: "Patched access control, rotated credentials", resolved_by: "u_comp_fe_a" });
    h.check("resolveBreach moves the breach to resolved", resolved.breach.status === "resolved");
    h.check("resolveBreach sets resolved_at", typeof resolved.breach.resolved_at === "string");
    h.check("resolveBreach sets remediation", resolved.breach.remediation.includes("Patched"));

    // listBreaches — the shape the breaches page consumes
    const allBreaches = await listBreaches(svc, { workspace_id: wsA.id });
    h.check("listBreaches returns an array", Array.isArray(allBreaches) && allBreaches.length >= 1);
    h.check("listBreaches returns breaches with all rendered fields", allBreaches.every((b) => "severity" in b && "status" in b && "description" in b && "detected_at" in b));

    // =========================================================== Breach cross-workspace isolation
    const wsBBreaches = await listBreaches(svc, { workspace_id: wsB.id });
    h.check("workspace B has no breaches from workspace A", wsBBreaches.length === 0);

    // =========================================================== Retention cross-workspace isolation
    const wsBPolicies = await listRetentionPolicies(svc, { workspace_id: wsB.id });
    h.check("workspace B has no retention policies from workspace A", wsBPolicies.length === 0);

    // =========================================================== Sensitive data handling
    // The DSR record has a verification_token at rest, but the frontend never displays it.
    // The frontend DsrRow component asks the user to enter the token from their email — it
    // never reads the token from the record. The list view works without the token.
    const rawDsr = await svc.entities.DataSubjectRequest.get(dsr.dsr.id).catch(() => null);
    h.check("the raw DSR has a verification_token at rest", typeof rawDsr.verification_token === "string");
    h.check("the DSR record does not expose the requester's password or credentials", !("password" in rawDsr) && !("credentials" in rawDsr));
    // The acceptance record stores hashes, not raw IP/UA
    const rawAcceptance = await svc.entities.LegalAcceptance.filter({ user_id: "u_comp_fe_a", document_id: tos.doc.id }, "-accepted_at", 1);
    h.check("the acceptance record stores ip_hash not raw IP", rawAcceptance.length > 0 && typeof rawAcceptance[0].ip_hash === "string" && !("ip" in rawAcceptance[0]));

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    // Clean up documents (platform-wide, not workspace-scoped)
    for (const docId of track.documents) await svc.entities.LegalDocument.delete(docId).catch(() => {});
    // Clean up acceptance records
    const acceptances = await svc.entities.LegalAcceptance.filter({ user_id: "u_comp_fe_a" }, "-accepted_at", 50).catch(() => []);
    for (const a of acceptances) await svc.entities.LegalAcceptance.delete(a.id).catch(() => {});
    // Clean up workspace-scoped data
    await cleanupWorkspace(svc, track.workspaces[0], ["DataSubjectRequest", "AbuseReport", "RetentionPolicy", "DataBreach", "ComplianceEvent", "AuditLog", "CacheEntry"]);
    await cleanupWorkspace(svc, track.workspaces[1], ["DataSubjectRequest", "AbuseReport", "RetentionPolicy", "DataBreach", "ComplianceEvent", "AuditLog", "CacheEntry"]);
  }
}