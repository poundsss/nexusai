// Legal / compliance / abuse control plane.
//
// Dispatches legal document management, acceptance tracking, data subject requests, abuse
// reports, retention policies, and data breach response. Every write resolves the caller's
// workspace role server-side.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { audit } from "../../shared/authz.ts";
import { resolveRole, requireCapability, requireActiveWorkspace } from "../../shared/rbac.ts";
import { enforceLimit, identityFor } from "../../shared/apiLimits.ts";
import {
  ComplianceError,
  getActiveDocument, getDocument, listDocuments, publishDocument, retireDocument,
  acceptDocument, hasAccepted, listAcceptances, pendingAcceptances,
  recordEvent, listEvents,
  fileDsr, verifyDsr, completeDsr, rejectDsr, listDsrs, getDsr, isDsrOverdue,
  fileAbuseReport, assignAbuseReport, resolveAbuseReport, listAbuseReports, getAbuseReport, isReportOverdue,
  getRetentionPolicy, createRetentionPolicy, listRetentionPolicies, deleteRetentionPolicy, findExpiredRecords,
  reportBreach, containBreach, resolveBreach, notifyRegulator, notifyUsers, listBreaches, getBreach, isBreachOverdue,
} from "../../shared/compliance.ts";
import { assertAuditExportEntitlement } from "../../shared/planLimits.ts";

const WRITES = ["publish_document", "retire_document", "accept", "file_dsr", "verify_dsr", "complete_dsr", "reject_dsr", "file_abuse", "assign_abuse", "resolve_abuse", "create_retention", "delete_retention", "report_breach", "contain_breach", "resolve_breach", "notify_regulator", "notify_users"];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list_documents");
    const workspaceId = String(body.workspace_id || "");

    const isPublic = ["list_documents", "get_document", "accept", "has_accepted", "pending_acceptances", "file_abuse"].includes(action);

    let role = null, workspace = null;
    if (workspaceId) {
      workspace = await svc.entities.Workspace.get(workspaceId).catch(() => null);
      if (!workspace && !isPublic) return Response.json({ error: "Workspace not found" }, { status: 404 });
      if (workspace) role = await resolveRole(base44, workspace, user);
      if (workspace && !role && !isPublic) return Response.json({ error: "Forbidden", code: "NOT_A_MEMBER" }, { status: 403 });
    } else if (!isPublic) {
      return Response.json({ error: "workspace_id is required" }, { status: 400 });
    }

    // G-2 lifecycle: admin compliance actions (documents, DSR processing, retention, breach
    // response, moderation) fail closed on a suspended/terminated workspace. The PUBLIC legal
    // flows (accepting terms, filing a DSR or abuse report) stay available.
    if (WRITES.includes(action) && !isPublic) requireActiveWorkspace(workspace);

    if (WRITES.includes(action)) {
      await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspaceId }), action: "billing_write", workspace_id: workspaceId });
    }

    // --- legal documents ---
    if (action === "list_documents") {
      const docs = await listDocuments(svc, { type: body.type || null, status: body.status || null });
      return Response.json({ documents: docs });
    }
    if (action === "get_document") {
      const doc = await getDocument(svc, String(body.document_id || ""));
      if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });
      return Response.json({ document: doc });
    }
    if (action === "publish_document") {
      requireCapability(role, "compliance.manage");
      const res = await publishDocument(svc, { workspace_id: workspaceId || null, type: body.type, version: body.version, title: body.title, content_url: body.content_url, content_checksum: body.content_checksum, effective_date: body.effective_date, required_for: body.required_for || "all", published_by: user.id });
      return Response.json({ document: res.doc, retired: res.retired });
    }
    if (action === "retire_document") {
      requireCapability(role, "compliance.manage");
      const res = await retireDocument(svc, { workspace_id: workspaceId || null, document_id: body.document_id, retired_by: user.id });
      return Response.json({ document: res.doc, duplicate: res.duplicate });
    }

    // --- acceptance ---
    if (action === "accept") {
      const res = await acceptDocument(svc, { user_id: user.id, workspace_id: workspaceId || null, document_id: body.document_id, ip: body.ip || null, user_agent: body.user_agent || null });
      return Response.json({ acceptance: res.acceptance, duplicate: res.duplicate });
    }
    if (action === "has_accepted") {
      const res = await hasAccepted(svc, { user_id: user.id, type: body.type });
      return Response.json(res);
    }
    if (action === "pending_acceptances") {
      const res = await pendingAcceptances(svc, { user_id: user.id, required_for: body.required_for || "all" });
      return Response.json({ pending: res });
    }
    if (action === "list_acceptances") {
      requireCapability(role, "compliance.read");
      const res = await listAcceptances(svc, { user_id: body.user_id || user.id, workspace_id: workspaceId || null });
      return Response.json({ acceptances: res });
    }

    // --- DSR ---
    if (action === "file_dsr") {
      const res = await fileDsr(svc, { workspace_id: workspaceId, email: body.email, request_type: body.request_type, requester_user_id: user.id, legal_basis: body.legal_basis });
      return Response.json({ dsr: res.dsr, token: res.token });
    }
    if (action === "verify_dsr") {
      const res = await verifyDsr(svc, { dsr_id: body.dsr_id, token: body.token });
      // Identity verification consumes a single-use token, so the redemption is auditable.
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "compliance.dsr.verified", resource: "DataSubjectRequest", resource_id: body.dsr_id, metadata: { duplicate: res.duplicate === true } }).catch(() => {});
      return Response.json({ dsr: res.dsr, duplicate: res.duplicate });
    }
    if (action === "complete_dsr") {
      requireCapability(role, "dsr.manage");
      const res = await completeDsr(svc, { dsr_id: body.dsr_id, response_data_uri: body.response_data_uri, assigned_to: user.id });
      return Response.json({ dsr: res.dsr, duplicate: res.duplicate });
    }
    if (action === "reject_dsr") {
      requireCapability(role, "dsr.manage");
      const res = await rejectDsr(svc, { dsr_id: body.dsr_id, reason: body.reason, assigned_to: user.id });
      return Response.json({ dsr: res.dsr, duplicate: res.duplicate });
    }
    if (action === "list_dsrs") {
      requireCapability(role, "compliance.read");
      const dsrs = await listDsrs(svc, { workspace_id: workspaceId, status: body.status || null });
      const overdue = dsrs.filter((d) => isDsrOverdue(d)).map((d) => d.id);
      return Response.json({ dsrs, overdue });
    }

    // --- abuse ---
    if (action === "file_abuse") {
      const res = await fileAbuseReport(svc, { reporter_workspace_id: workspaceId || null, reporter_user_id: user.id, target_type: body.target_type, target_id: body.target_id, category: body.category, severity: body.severity || "medium", description: body.description || "", evidence_urls: body.evidence_urls || [] });
      return Response.json({ report: res.report, auto_suspended: res.auto_suspended });
    }
    if (action === "assign_abuse") {
      requireCapability(role, "abuse.moderate");
      const report = await assignAbuseReport(svc, { report_id: body.report_id, assigned_to: body.assigned_to || user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "compliance.abuse.assigned", resource: "AbuseReport", resource_id: body.report_id, metadata: { assigned_to: body.assigned_to || user.id } }).catch(() => {});
      return Response.json({ report });
    }
    if (action === "resolve_abuse") {
      requireCapability(role, "abuse.moderate");
      const res = await resolveAbuseReport(svc, { report_id: body.report_id, resolution: body.resolution, note: body.note || "", resolved_by: user.id });
      return Response.json({ report: res.report, duplicate: res.duplicate });
    }
    if (action === "list_abuse") {
      requireCapability(role, "abuse.moderate");
      const reports = await listAbuseReports(svc, { status: body.status || null, category: body.category || null, target_id: body.target_id || null });
      const overdue = reports.filter((r) => isReportOverdue(r)).map((r) => r.id);
      return Response.json({ reports, overdue });
    }

    // --- retention ---
    if (action === "create_retention") {
      requireCapability(role, "retention.manage");
      const policy = await createRetentionPolicy(svc, { workspace_id: workspaceId || null, data_type: body.data_type, retention_days: body.retention_days, action: body.action || "delete", legal_basis: body.legal_basis, created_by: user.id });
      return Response.json({ policy });
    }
    if (action === "list_retention") {
      requireCapability(role, "compliance.read");
      const policies = await listRetentionPolicies(svc, { workspace_id: workspaceId || null });
      return Response.json({ policies });
    }
    if (action === "delete_retention") {
      requireCapability(role, "retention.manage");
      const res = await deleteRetentionPolicy(svc, { policy_id: body.policy_id });
      return Response.json(res);
    }
    if (action === "find_expired") {
      requireCapability(role, "compliance.read");
      const res = await findExpiredRecords(svc, { workspace_id: workspaceId, data_type: body.data_type });
      return Response.json(res);
    }

    // --- breaches ---
    if (action === "report_breach") {
      requireCapability(role, "breach.manage");
      const res = await reportBreach(svc, { workspace_id: workspaceId || null, severity: body.severity, description: body.description, affected_data_categories: body.affected_data_categories || [], affected_user_count: body.affected_user_count || 0, detected_at: body.detected_at, reported_by: user.id });
      return Response.json({ breach: res.breach });
    }
    if (action === "contain_breach") {
      requireCapability(role, "breach.manage");
      const res = await containBreach(svc, { breach_id: body.breach_id, root_cause: body.root_cause, assigned_to: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "compliance.breach.contained", resource: "DataBreach", resource_id: body.breach_id, metadata: { duplicate: res.duplicate === true } }).catch(() => {});
      return Response.json({ breach: res.breach, duplicate: res.duplicate });
    }
    if (action === "resolve_breach") {
      requireCapability(role, "breach.manage");
      const res = await resolveBreach(svc, { breach_id: body.breach_id, remediation: body.remediation, resolved_by: user.id });
      return Response.json({ breach: res.breach, duplicate: res.duplicate });
    }
    if (action === "notify_regulator") {
      requireCapability(role, "breach.manage");
      const res = await notifyRegulator(svc, { breach_id: body.breach_id, notified_by: user.id });
      return Response.json({ breach: res.breach, duplicate: res.duplicate });
    }
    if (action === "notify_users") {
      requireCapability(role, "breach.manage");
      const res = await notifyUsers(svc, { breach_id: body.breach_id, notified_by: user.id });
      return Response.json({ breach: res.breach, duplicate: res.duplicate });
    }
    if (action === "list_breaches") {
      requireCapability(role, "compliance.read");
      const breaches = await listBreaches(svc, { workspace_id: workspaceId || null, status: body.status || null });
      const overdue = breaches.filter((b) => isBreachOverdue(b)).map((b) => b.id);
      return Response.json({ breaches, overdue });
    }

    // --- compliance events ---
    if (action === "list_events") {
      requireCapability(role, "compliance.read");
      // Workspace audit logs are an Enterprise entitlement (DOCUMENTED Base44). Applied to the
      // audit-log read action ONLY — DSR, abuse, breach, retention and general compliance stay
      // ungated. Resolved server-side; the existing compliance.read capability check still runs.
      await assertAuditExportEntitlement(base44, workspace);
      const events = await listEvents(svc, { workspace_id: workspaceId || null, event_type: body.event_type || null });
      return Response.json({ events });
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}