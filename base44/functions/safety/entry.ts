// NexusAI Safety / Approval API.
//
// Thin authenticated boundary over the ONE safety gate (shared/safetyEngine.ts). Every action
// authorizes the caller against the owning project through the platform's EXISTING authorization
// path and resolves the workspace server-side; client-supplied ownership fields are never trusted.
//
// Deliberately NOT exposed here: spending an approval. Executing an approved operation needs the
// caller's live project state (the run's virtual filesystem), so it runs where that state already
// exists — the existing execution pipeline — through executeApprovedOperation. This endpoint only
// assesses, proposes, reads and decides.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  assessOperation, proposeOperation, resolveApproval, getApprovalRequest, listApprovalRequests, APPROVAL_LIMITS,
} from "../../shared/safetyEngine.ts";
import { SAFETY_CONTRACT_VERSION, OPERATION_CLASSES, RISK_LEVELS, DECISIONS, APPROVAL_TTL_MS } from "../../shared/safetyPolicy.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = body.action || "contract";

  // Public contract metadata: vocabulary and limits only, no project data and no credentials.
  if (action === "contract") {
    return Response.json({
      contract_version: SAFETY_CONTRACT_VERSION,
      operation_classes: OPERATION_CLASSES, risk_levels: RISK_LEVELS, decisions: DECISIONS,
      approval_ttl_ms: APPROVAL_TTL_MS, limits: APPROVAL_LIMITS,
      flow: ["proposal", "risk", "permission", "approval", "execution", "audit"],
    });
  }

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });

    switch (action) {
      // Risk + permission for a proposed operation, with nothing persisted and nothing executed.
      case "assess": {
        const { risk, decision, fingerprint, role } = await assessOperation(base44, user, body);
        return Response.json({
          contract_version: SAFETY_CONTRACT_VERSION, role, risk,
          decision: decision.decision, decision_code: decision.code, reason: decision.reason,
          approval_required: decision.approval_required, operation_fingerprint: fingerprint,
        });
      }
      case "propose": return Response.json(await proposeOperation(base44, user, body));
      case "approve": return Response.json(await resolveApproval(base44, user, { ...body, decision: "approved" }));
      case "deny": return Response.json(await resolveApproval(base44, user, { ...body, decision: "denied" }));
      case "get": return Response.json(await getApprovalRequest(base44, user, body));
      case "list": return Response.json(await listApprovalRequests(base44, user, body));
      default: return Response.json({ error: `Unknown action: ${action}`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || "ERROR" }, { status: e.status || 500 });
  }
}