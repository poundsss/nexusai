// THE safety / approval GATE (#42).
//
//   AI proposal → risk analysis → permission check → approval (if required) → EXISTING execution → audit
//
// Every AI-proposed operation that could matter passes through ONE function here (runGatedOperation).
// This module owns the gate and the approval STATE; it owns nothing else and duplicates nothing:
//   • risk + decision ....... shared/safetyPolicy.ts (the ONE pure policy)
//   • permissions ........... shared/rbac.ts capability matrix through shared/authz.ts (unchanged)
//   • execution ............. shared/toolRouter.ts tool session (the ONE execution boundary)
//   • audit ................. shared/authz.ts audit rows + shared/tracing.ts spans (no second log)
//   • project state ......... the existing project/version records (no second store)
//
// SAFETY INVARIANTS, all enforced server-side from facts the caller cannot influence:
//   1. the project and workspace are resolved from the authorized project, never from the payload;
//   2. the permission check happens BEFORE any approval exists, so an approval is never a route to
//      a capability the actor lacks;
//   3. an approval is bound to ONE actor, ONE project and ONE operation fingerprint;
//   4. the actor's role and the policy decision are RE-EVALUATED at execution time;
//   5. an approval may be spent exactly once, and only inside its window;
//   6. a denied, expired or already-spent approval never reaches the execution boundary.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { can } from "./rbac.ts";
import { createToolSession, toolContract, routableTools } from "./toolRouter.ts";
import { recordSpan, scrubText } from "./tracing.ts";
import { sha256Hex } from "./hash.ts";
import { captureSafetyDecision } from "./productionLearning.ts";
import { emit as emitLearning } from "./trajectory.ts";
import {
  SAFETY_CONTRACT_VERSION, APPROVAL_TTL_MS, classifyOperation, decideOperation, fingerprintPayload,
} from "./safetyPolicy.ts";

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

export const APPROVAL_LIMITS = { list: 100, reason: 400 };

export const publicApproval = (a) => ({
  approval_id: a.id, project_id: a.project_id, workspace_id: a.workspace_id,
  actor_user_id: a.actor_user_id, actor_role: a.actor_role || null, run_id: a.run_id || null,
  tool: a.tool, operation_classes: a.operation_classes || [],
  risk_level: a.risk_level, risk_factors: a.risk_factors || [],
  required_capability: a.required_capability || null,
  operation_fingerprint: a.operation_fingerprint || null, input_summary: a.input_summary || {},
  decision: a.decision, decision_code: a.decision_code || null, status: a.status,
  expires_at: a.expires_at || null,
  approver_user_id: a.approver_user_id || null, approver_role: a.approver_role || null,
  approver_decision: a.approver_decision || null, approver_reason: a.approver_reason || null,
  execution_ok: a.execution_ok ?? null, execution_summary: a.execution_summary || null,
  trace_id: a.trace_id || null,
  created_at: a.created_at || a.created_date, resolved_at: a.resolved_at || null, executed_at: a.executed_at || null,
});

/** Audit + span for one safety event. Both existing systems; this layer adds no logging of its own. */
async function recordSafety(base44, { workspace, project, user, action, approval, risk, decision, extra = {}, trace_id = null, run_id = null, ok = true }) {
  const svc = svcOf(base44);
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user?.id || null,
    action, resource: "ApprovalRequest", resource_id: approval?.id || null,
    metadata: {
      tool: risk?.tool || approval?.tool || null,
      risk_level: risk?.risk_level || approval?.risk_level || null,
      operation_classes: risk?.operation_classes || approval?.operation_classes || [],
      decision: decision?.decision || approval?.decision || null,
      decision_code: decision?.code || approval?.decision_code || null,
      required_capability: risk?.required_capability || approval?.required_capability || null,
      contract_version: SAFETY_CONTRACT_VERSION, ok, ...extra,
    },
  }).catch(() => {});
  // Production learning (#43): the decision joins the run's own episode, so an unsafe or refused
  // operation is visible to the promotion policy. Best-effort — never fails the safety path.
  if (run_id) {
    await emitLearning(() => captureSafetyDecision(svc, {
      run_id, action, tool: risk?.tool || approval?.tool || null, risk_level: risk?.risk_level || approval?.risk_level || null,
      decision: decision?.decision || approval?.decision || null, decision_code: decision?.code || approval?.decision_code || null, approval_id: approval?.id || null,
    }), "safety.capture");
  }
  if (trace_id) {
    await recordSpan(svc, {
      trace_id, run_id, workspace_id: workspace.id, project_id: project.id,
      event_type: "diagnostic_query", name: action, status: ok ? "ok" : "error",
      error_code: ok ? null : (decision?.code || null),
      metadata: { tool: risk?.tool || approval?.tool || null, risk_level: risk?.risk_level || approval?.risk_level || null, decision: decision?.decision || approval?.decision || null },
    }).catch(() => {});
  }
}

/**
 * Risk analysis + permission check for one proposed operation, with NOTHING executed and nothing
 * persisted. The tool's contract, the caller's role and the mode restrictions all come from the
 * existing systems; the verdict comes from the one pure policy.
 */
export async function assessOperation(base44, user, {
  project_id, tool, input = {}, mode = "default", actor_kind = "user",
  architecture_risk = null, capability_risk = null,
} = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to propose an operation");
  // project.read is the floor for proposing anything; the operation's OWN capability is checked
  // against the resolved role below.
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const contract = toolContract(String(tool || ""));
  const mode_allows = !!contract && routableTools(mode).some((t) => t.name === contract.name);
  const risk = classifyOperation({
    tool, contract, input, mode, mode_allows, project_id: project.id, actor_kind,
    architecture_risk, capability_risk,
  });
  const role_permits = !!contract && can(role, contract.capability);
  const decision = decideOperation({ risk, role, role_permits });
  // Auto approve (documented Base44 Builder setting, project-scoped): when enabled for this
  // project and the run is in Build (default) mode, the lowest approval-gated risk tier above
  // 'low' (medium) runs WITHOUT creating an ApprovalRequest. The pure decideOperation is
  // unchanged; this is an orchestration override scoped to the project setting + mode. Low-risk
  // behavior is unchanged; high, critical, deny and forbidden operations are untouched and stay
  // fail-closed (decideOperation returns 'deny' for forbidden/insufficient-role, so the override
  // never fires for them). The exact Base44 "still ask" partition is UNKNOWN, so only medium is
  // auto-approved.
  const effectiveDecision = (project.auto_approve && mode === "default" && decision.decision === "require_approval" && risk.risk_level === "medium")
    ? { decision: "allow", code: "SAFETY_AUTO_APPROVED", reason: "medium-risk operation auto-approved by the project Auto approve setting", approval_required: false, forbidden: [] }
    : decision;
  const fingerprint = await sha256Hex(fingerprintPayload({ tool, input, project_id: project.id, risk }));
  return { project, workspace, role, contract, risk, decision: effectiveDecision, fingerprint, mode };
}

/**
 * Proposal → risk → permission → (approval request | allow | deny), persisted and audited.
 *
 * An ALLOW is recorded as an auditable decision but creates no pending request. A REQUIRE_APPROVAL
 * creates a PENDING request bound to this actor, project and operation fingerprint. A DENY is
 * persisted terminally DENIED, so a refusal is as auditable as a grant and can never be executed.
 */
export async function proposeOperation(base44, user, {
  project_id, tool, input = {}, mode = "default", actor_kind = "user", run_id = null, trace_id = null,
  architecture_risk = null, capability_risk = null,
} = {}) {
  const assessed = await assessOperation(base44, user, { project_id, tool, input, mode, actor_kind, architecture_risk, capability_risk });
  const { project, workspace, role, risk, decision, fingerprint } = assessed;
  const svc = svcOf(base44);

  let approval = null;
  if (decision.decision !== "allow") {
    approval = await svc.entities.ApprovalRequest.create({
      project_id: project.id, workspace_id: workspace.id,
      actor_user_id: user.id, actor_role: role, run_id: run_id || undefined,
      tool: String(tool || ""), operation_classes: risk.operation_classes,
      risk_level: risk.risk_level, risk_factors: risk.risk_factors.map((f) => scrubText(f, 300)).slice(0, 20),
      required_capability: risk.required_capability || undefined,
      operation_fingerprint: fingerprint, input_summary: risk.input_summary,
      decision: decision.decision, decision_code: decision.code,
      status: decision.decision === "deny" ? "DENIED" : "PENDING",
      expires_at: decision.decision === "deny" ? undefined : new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      ...(decision.decision === "deny" ? { approver_reason: scrubText(decision.reason, APPROVAL_LIMITS.reason), resolved_at: nowIso() } : {}),
      trace_id: trace_id || undefined, created_at: nowIso(),
    });
  }

  await recordSafety(base44, {
    workspace, project, user, risk, decision, approval, trace_id, run_id,
    ok: decision.decision !== "deny",
    action: decision.code === "SAFETY_AUTO_APPROVED" ? "safety.auto_approved" : decision.decision === "allow" ? "safety.allowed" : decision.decision === "deny" ? "safety.denied" : "safety.approval_requested",
    extra: { reason: scrubText(decision.reason, 300), fingerprint, auto_approved: decision.code === "SAFETY_AUTO_APPROVED" },
  });

  return {
    contract_version: SAFETY_CONTRACT_VERSION,
    project_id: project.id, tool: String(tool || ""),
    risk: { ...risk, forbidden: risk.forbidden },
    decision: decision.decision, decision_code: decision.code, reason: decision.reason,
    approval_required: decision.approval_required,
    operation_fingerprint: fingerprint,
    approval: approval ? publicApproval(approval) : null,
    executed: false,
  };
}

/** One authorized approval record, isolated to its own project. */
async function loadApproval(base44, user, approval_id, capability = "project.read") {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use the safety engine");
  const svc = svcOf(base44);
  const approval = approval_id ? await svc.entities.ApprovalRequest.get(String(approval_id)).catch(() => null) : null;
  if (!approval) fail(404, "APPROVAL_NOT_FOUND", "Approval request not found");
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, approval.project_id, capability);
  if (approval.workspace_id && approval.workspace_id !== workspace.id) fail(403, "NOT_A_MEMBER", "That approval belongs to another workspace");
  return { approval, project, workspace, role };
}

const expired = (a) => !!a.expires_at && Date.parse(a.expires_at) <= Date.now();

/**
 * A human decides. The approver is authenticated, must hold `approval.grant` AND the operation's own
 * capability — approving something you could not perform yourself is refused, which is what keeps an
 * approval from becoming an escalation path. A request that is not PENDING, or whose window has
 * closed, cannot be decided.
 */
export async function resolveApproval(base44, user, { approval_id, decision, reason = "", trace_id = null } = {}) {
  const verdict = String(decision || "");
  if (!["approved", "denied"].includes(verdict)) fail(400, "INVALID_DECISION", "decision must be 'approved' or 'denied'");
  const { approval, project, workspace, role } = await loadApproval(base44, user, approval_id, "project.read");
  const svc = svcOf(base44);

  if (!can(role, "approval.grant")) fail(403, "INSUFFICIENT_ROLE", `Your role (${role}) is not allowed to approval.grant`);
  if (approval.required_capability && !can(role, approval.required_capability)) {
    fail(403, "INSUFFICIENT_ROLE", `Your role (${role}) is not allowed to ${approval.required_capability}, so you cannot approve this operation`);
  }
  if (approval.status !== "PENDING") fail(409, "APPROVAL_NOT_PENDING", `That request is already ${approval.status} and cannot be decided again`);
  if (expired(approval)) {
    const stale = await svc.entities.ApprovalRequest.update(approval.id, { status: "EXPIRED", resolved_at: nowIso() });
    await recordSafety(base44, { workspace, project, user, approval: stale, trace_id, ok: false, action: "safety.approval_expired", decision: { decision: "deny", code: "APPROVAL_EXPIRED" } });
    fail(409, "APPROVAL_EXPIRED", "That approval window has closed; propose the operation again");
  }

  const updated = await svc.entities.ApprovalRequest.update(approval.id, {
    status: verdict === "approved" ? "APPROVED" : "DENIED",
    approver_user_id: user.id, approver_role: role, approver_decision: verdict,
    approver_reason: scrubText(String(reason || ""), APPROVAL_LIMITS.reason), resolved_at: nowIso(),
  });
  await recordSafety(base44, {
    workspace, project, user, approval: updated, trace_id, run_id: approval.run_id || null,
    ok: verdict === "approved", action: verdict === "approved" ? "safety.approval_granted" : "safety.approval_refused",
    extra: { approver_role: role, actor_user_id: approval.actor_user_id },
  });
  return { approval: publicApproval(updated) };
}

/**
 * Spends an APPROVED request through the EXISTING execution boundary.
 *
 * The input is re-supplied and re-fingerprinted, the actor's role is re-resolved, and the policy is
 * re-evaluated: a changed operation, a changed role or a changed verdict refuses execution instead of
 * riding on the old grant. The approval is marked spent BEFORE the tool runs, so a concurrent second
 * attempt finds it already consumed and cannot execute twice.
 */
export async function executeApprovedOperation(base44, user, { approval_id, input = {}, ctx = null, mode = "default", trace_id = null } = {}) {
  const { approval, project, workspace } = await loadApproval(base44, user, approval_id, "project.read");
  const svc = svcOf(base44);
  const refuse = async (code, message, status = 409) => {
    await recordSafety(base44, {
      workspace, project, user, approval, trace_id, run_id: approval.run_id || null, ok: false,
      action: "safety.execution_refused", decision: { decision: "deny", code },
      extra: { reason: message },
    });
    fail(status, code, message);
  };

  if (approval.actor_user_id !== user.id) await refuse("APPROVAL_WRONG_ACTOR", "An approval may only be spent by the user who proposed the operation", 403);
  if (approval.status === "EXECUTED") await refuse("APPROVAL_ALREADY_USED", "That approval has already been spent");
  if (approval.status === "DENIED") await refuse("APPROVAL_DENIED", "That operation was denied and can never be executed", 403);
  if (approval.status === "EXPIRED") await refuse("APPROVAL_EXPIRED", "That approval window has closed; propose the operation again");
  if (approval.status !== "APPROVED") await refuse("APPROVAL_NOT_GRANTED", `That request is ${approval.status} and has not been approved`, 403);
  if (expired(approval)) {
    await svc.entities.ApprovalRequest.update(approval.id, { status: "EXPIRED", resolved_at: nowIso() });
    await refuse("APPROVAL_EXPIRED", "That approval window has closed; propose the operation again");
  }

  // Re-assessment: the operation must still be the SAME operation, and the actor must still hold the
  // capability. The approval carries no authority of its own.
  const assessed = await assessOperation(base44, user, { project_id: project.id, tool: approval.tool, input, mode });
  if (assessed.fingerprint !== approval.operation_fingerprint) {
    await refuse("APPROVAL_OPERATION_MISMATCH", "The operation being executed is not the operation that was approved", 403);
  }
  if (assessed.decision.decision === "deny") {
    await refuse(assessed.decision.code || "SAFETY_DENIED", `The operation is no longer permitted: ${assessed.decision.reason}`, 403);
  }

  // Spent first: an approval is single-use even under concurrency.
  await svc.entities.ApprovalRequest.update(approval.id, { status: "EXECUTED", executed_at: nowIso() });

  const session = await createToolSession(base44, {
    user, project_id: project.id, run_id: approval.run_id || null, mode,
    trace: { trace_id: trace_id || approval.trace_id || null },
  });
  const res = await session.call(approval.tool, input, ctx);
  const summary = scrubText(res.ok ? "executed" : String(res.error || "failed"), 300);
  const finalRow = await svc.entities.ApprovalRequest.update(approval.id, {
    status: res.ok ? "EXECUTED" : "FAILED", execution_ok: !!res.ok, execution_summary: summary,
  });
  await recordSafety(base44, {
    workspace, project, user, approval: finalRow, trace_id: trace_id || approval.trace_id || null,
    run_id: approval.run_id || null, ok: !!res.ok, action: "safety.executed",
    decision: { decision: "allow", code: res.ok ? "SAFETY_EXECUTED" : "SAFETY_EXECUTION_FAILED" },
    extra: { execution_ok: !!res.ok, summary },
  });
  return { approval: publicApproval(finalRow), executed: true, ok: !!res.ok, result: res };
}

/**
 * THE gate. Every AI-proposed operation goes through here:
 *   proposal → risk → permission → approval (if required) → EXISTING execution → audit
 * A gated proposal returns its pending approval and executes NOTHING; a denial executes nothing and
 * never becomes executable. Only a low-risk, permitted operation runs straight through — and it runs
 * through the same tool session the Builder already uses, not a second execution path.
 */
export async function runGatedOperation(base44, user, {
  project_id, tool, input = {}, ctx = null, mode = "default", actor_kind = "user",
  run_id = null, trace_id = null, architecture_risk = null, capability_risk = null,
} = {}) {
  const proposal = await proposeOperation(base44, user, {
    project_id, tool, input, mode, actor_kind, run_id, trace_id, architecture_risk, capability_risk,
  });
  if (proposal.decision !== "allow") return { ...proposal, executed: false, ok: false, result: null };

  const session = await createToolSession(base44, { user, project_id, run_id, mode, trace: { trace_id } });
  const res = await session.call(String(tool || ""), input, ctx);
  return { ...proposal, executed: true, ok: !!res.ok, result: res };
}

export async function getApprovalRequest(base44, user, { approval_id } = {}) {
  const { approval } = await loadApproval(base44, user, approval_id, "project.read");
  return { approval: publicApproval(approval) };
}

/** Bounded, project-isolated list. Cross-project reads resolve to nothing by construction. */
export async function listApprovalRequests(base44, user, { project_id, status = null, limit = 25 } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use the safety engine");
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.ApprovalRequest.filter(
    { project_id: project.id, ...(status ? { status: String(status) } : {}) },
    "-created_date", Math.max(1, Math.min(Number(limit) || 25, APPROVAL_LIMITS.list)),
  );
  return { project_id: project.id, count: rows.length, approvals: rows.map(publicApproval) };
}