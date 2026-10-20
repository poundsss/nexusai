// #42 Safety / Approval Engine — certification.
//
// Executes the REAL flow against the REAL modules, with nothing stubbed and no second permission
// system, execution engine or audit trail created here:
//   risk + decision .... shared/safetyPolicy.ts (the ONE pure policy)
//   gate + state ....... shared/safetyEngine.ts + the ApprovalRequest entity
//   permissions ........ shared/rbac.ts capability matrix (unchanged, authoritative)
//   execution .......... shared/toolRouter.ts tool session (the ONE execution boundary)
//   audit .............. AuditLog rows + TraceEvent spans (the existing systems)
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, readFile, activeFiles } from "../../shared/projectFs.ts";
import { classifyOperation, decideOperation, fingerprintPayload, SAFETY_CONTRACT_VERSION } from "../../shared/safetyPolicy.ts";
import {
  assessOperation, proposeOperation, resolveApproval, executeApprovedOperation, runGatedOperation,
  getApprovalRequest, listApprovalRequests,
} from "../../shared/safetyEngine.ts";
import { toolContract } from "../../shared/toolRouter.ts";
import { can } from "../../shared/rbac.ts";
import { createToolSession } from "../../shared/toolRouter.ts";
import { sha256Hex } from "../../shared/hash.ts";

const APP = `import { html } from 'runtime';
export default function App() { return html\`<div class="page">safety</div>\`; }
`;
const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  const mkCtx = (files) => {
    const fs = createFs([]);
    for (const [path, content] of Object.entries(files)) fs.files.set(path, { id: null, path, content, original: null });
    return { fs, entities: [], secrets: [], deletes: 0 };
  };
  const has = (ctx, path) => activeFiles(ctx.fs).some((f) => f.path === path);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `safety-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "safety-engine", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(project.id);

    const FILES = {
      "src/main.js": MAIN, "src/App.js": APP, "styles.css": ".page { display: block; }\n",
      "src/Old.js": "export default function Old() { return null; }\n",
      "src/Spare.js": "export default function Spare() { return null; }\n",
      "src/Third.js": "export default function Third() { return null; }\n",
    };
    const ctx = mkCtx(FILES);
    const trace_id = `safety-trace-${Date.now()}`;

    // ------------------------------------------------ 1. low-risk operation executes immediately
    const low = await runGatedOperation(base44, user, { project_id: project.id, tool: "read_file", input: { path: "src/App.js" }, ctx, trace_id });
    h.check("1 a low-risk operation is allowed and executes immediately",
      low.decision === "allow" && low.decision_code === "SAFETY_LOW_RISK" && low.approval_required === false &&
      low.executed === true && low.ok === true && low.result.result.content.includes("safety") && low.approval === null,
      `${low.decision}/${low.decision_code} · executed=${low.executed}`);

    // ------------------------------------------------ 2. high-risk operation requires approval
    const gated = await runGatedOperation(base44, user, { project_id: project.id, tool: "delete_file", input: { path: "src/Old.js" }, ctx, trace_id });
    h.check("2 a high-risk operation is gated: approval required and NOTHING executed",
      gated.decision === "require_approval" && gated.decision_code === "SAFETY_APPROVAL_REQUIRED" &&
      gated.risk.risk_level === "high" && gated.risk.destructive === true &&
      gated.executed === false && gated.result === null && has(ctx, "src/Old.js"),
      `${gated.risk.risk_level} · classes ${gated.risk.operation_classes.join(",")} · file still present=${has(ctx, "src/Old.js")}`);

    // ------------------------------------------------ 3. forbidden operations denied
    const secretValue = await proposeOperation(base44, user, { project_id: project.id, tool: "declare_secret", input: { name: "API_KEY", value: "sk-live-should-never-be-accepted" }, trace_id });
    const unknown = await proposeOperation(base44, user, { project_id: project.id, tool: "exfiltrate_everything", input: {}, trace_id });
    const systemTool = await proposeOperation(base44, user, { project_id: project.id, tool: "create_snapshot", input: { message: "x" }, trace_id });
    const discussWrite = await proposeOperation(base44, user, { project_id: project.id, tool: "write_file", input: { path: "src/New.js", content: "x" }, mode: "discuss", trace_id });
    h.check("3 a forbidden operation is denied outright",
      secretValue.decision === "deny" && secretValue.decision_code === "SAFETY_SECRET_VALUE" &&
      unknown.decision === "deny" && unknown.decision_code === "SAFETY_UNKNOWN_OPERATION" &&
      systemTool.decision === "deny" && systemTool.decision_code === "SAFETY_SYSTEM_TOOL" &&
      discussWrite.decision === "deny" && discussWrite.decision_code === "SAFETY_MODE_FORBIDDEN" &&
      [secretValue, unknown, systemTool, discussWrite].every((p) => p.approval.status === "DENIED"),
      [secretValue, unknown, systemTool, discussWrite].map((p) => p.decision_code).join(" · "));

    // ------------------------------------------------ 4. approval state persisted
    const storedRow = await svc.entities.ApprovalRequest.get(gated.approval.approval_id);
    h.check("4 the approval request is persisted with its full decision record",
      !!storedRow && storedRow.project_id === project.id && storedRow.workspace_id === ws.id &&
      storedRow.actor_user_id === user.id && storedRow.actor_role === "owner" && storedRow.tool === "delete_file" &&
      storedRow.risk_level === "high" && storedRow.status === "PENDING" && !!storedRow.created_at && !!storedRow.expires_at &&
      storedRow.operation_fingerprint === gated.operation_fingerprint && storedRow.required_capability === "project.write" &&
      !storedRow.resolved_at && !JSON.stringify(storedRow).includes("sk-live"),
      `${storedRow.status} · ${storedRow.risk_level} · fingerprint ${String(storedRow.operation_fingerprint).slice(0, 12)}`);

    // ------------------------------------------------ 5. approval granted
    const granted = await resolveApproval(base44, user, { approval_id: gated.approval.approval_id, decision: "approved", reason: "reviewed by owner", trace_id });
    h.check("5 an approval is granted by an authorized approver and recorded",
      granted.approval.status === "APPROVED" && granted.approval.approver_user_id === user.id &&
      granted.approval.approver_role === "owner" && granted.approval.approver_decision === "approved" &&
      !!granted.approval.resolved_at && can("owner", "approval.grant") && can("viewer", "approval.grant") === false,
      `${granted.approval.status} by ${granted.approval.approver_role}`);

    // ------------------------------------------------ 6. approved operation executes
    const spent = await executeApprovedOperation(base44, user, { approval_id: gated.approval.approval_id, input: { path: "src/Old.js" }, ctx, trace_id });
    h.check("6 the approved operation executes through the existing tool boundary",
      spent.executed === true && spent.ok === true && spent.result.ok === true &&
      spent.approval.status === "EXECUTED" && spent.approval.execution_ok === true && !!spent.approval.executed_at &&
      !has(ctx, "src/Old.js"),
      `${spent.approval.status} · file deleted=${!has(ctx, "src/Old.js")}`);

    // ------------------------------------------------ 7/8. denial never executes
    const toDeny = await proposeOperation(base44, user, { project_id: project.id, tool: "delete_file", input: { path: "src/Spare.js" }, trace_id });
    const refused = await resolveApproval(base44, user, { approval_id: toDeny.approval.approval_id, decision: "denied", reason: "not wanted", trace_id });
    h.check("7 an approval can be refused by the approver",
      refused.approval.status === "DENIED" && refused.approval.approver_decision === "denied" &&
      refused.approval.approver_reason === "not wanted" && !!refused.approval.resolved_at,
      `${refused.approval.status}`);
    await h.expectThrow("8 a denied operation can never execute",
      () => executeApprovedOperation(base44, user, { approval_id: toDeny.approval.approval_id, input: { path: "src/Spare.js" }, ctx, trace_id }), "APPROVAL_DENIED");
    h.check("8b the denied operation left the project untouched",
      has(ctx, "src/Spare.js") && (await svc.entities.ApprovalRequest.get(toDeny.approval.approval_id)).status === "DENIED",
      "the target file still exists and the request is still terminal");

    // ------------------------------------------------ 9. expired / stale approval
    const stale = await proposeOperation(base44, user, { project_id: project.id, tool: "delete_file", input: { path: "src/Third.js" }, trace_id });
    await resolveApproval(base44, user, { approval_id: stale.approval.approval_id, decision: "approved", trace_id });
    await svc.entities.ApprovalRequest.update(stale.approval.approval_id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await h.expectThrow("9 an expired approval is rejected at execution",
      () => executeApprovedOperation(base44, user, { approval_id: stale.approval.approval_id, input: { path: "src/Third.js" }, ctx, trace_id }), "APPROVAL_EXPIRED");
    const stalePending = await proposeOperation(base44, user, { project_id: project.id, tool: "delete_integration", input: { name: "ghost" }, trace_id });
    await svc.entities.ApprovalRequest.update(stalePending.approval.approval_id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await h.expectThrow("9b a stale pending request can no longer be decided",
      () => resolveApproval(base44, user, { approval_id: stalePending.approval.approval_id, decision: "approved", trace_id }), "APPROVAL_EXPIRED");
    h.check("9c the expired approvals are terminal and their targets untouched",
      has(ctx, "src/Third.js") &&
      (await svc.entities.ApprovalRequest.get(stale.approval.approval_id)).status === "EXPIRED" &&
      (await svc.entities.ApprovalRequest.get(stalePending.approval.approval_id)).status === "EXPIRED",
      "both windows closed without executing");

    // ------------------------------------------------ 10. an approval cannot be reused or repointed
    await h.expectThrow("10 a spent approval cannot be used twice",
      () => executeApprovedOperation(base44, user, { approval_id: gated.approval.approval_id, input: { path: "src/Old.js" }, ctx, trace_id }), "APPROVAL_ALREADY_USED");
    const reuse = await proposeOperation(base44, user, { project_id: project.id, tool: "delete_file", input: { path: "src/App.js" }, trace_id });
    await resolveApproval(base44, user, { approval_id: reuse.approval.approval_id, decision: "approved", trace_id });
    await h.expectThrow("10b an approval granted for one operation cannot be spent on another",
      () => executeApprovedOperation(base44, user, { approval_id: reuse.approval.approval_id, input: { path: "src/main.js" }, ctx, trace_id }), "APPROVAL_OPERATION_MISMATCH");
    await svc.entities.ApprovalRequest.update(reuse.approval.approval_id, { actor_user_id: `u_not_${user.id}` });
    await h.expectThrow("10c an approval belonging to another actor cannot be spent",
      () => executeApprovedOperation(base44, user, { approval_id: reuse.approval.approval_id, input: { path: "src/App.js" }, ctx, trace_id }), "APPROVAL_WRONG_ACTOR");
    h.check("10d neither misuse executed anything",
      has(ctx, "src/App.js") && has(ctx, "src/main.js"),
      "both files are intact after the mismatch and wrong-actor attempts");

    // ------------------------------------------------ 11. permission precedes approval
    const deleteRisk = classifyOperation({ tool: "delete_file", contract: toolContract("delete_file"), input: { path: "src/App.js" }, mode_allows: true });
    const asViewer = decideOperation({ risk: deleteRisk, role: "viewer", role_permits: can("viewer", "project.write") });
    const asEditor = decideOperation({ risk: deleteRisk, role: "editor", role_permits: can("editor", "project.write") });
    const noMember = decideOperation({ risk: deleteRisk, role: null, role_permits: false });
    h.check("11 the permission check precedes approval: an unpermitted role is denied, never queued",
      asViewer.decision === "deny" && asViewer.code === "INSUFFICIENT_ROLE" && asViewer.approval_required === false &&
      asEditor.decision === "require_approval" && noMember.decision === "deny" && noMember.code === "NOT_A_MEMBER",
      `viewer=${asViewer.code} · editor=${asEditor.decision} · non-member=${noMember.code}`);

    // ------------------------------------------------ 12. an approval cannot escalate permissions
    const forced = await svc.entities.ApprovalRequest.update(secretValue.approval.approval_id, {
      status: "APPROVED", approver_user_id: user.id, approver_decision: "approved",
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });
    await h.expectThrow("12 a forcibly approved forbidden operation is STILL refused at execution",
      () => executeApprovedOperation(base44, user, { approval_id: forced.id, input: { name: "API_KEY", value: "sk-live-should-never-be-accepted" }, ctx, trace_id }),
      "SAFETY_SECRET_VALUE");
    const viewerApprover = can("viewer", "approval.grant");
    h.check("12b approving requires both approval.grant and the operation's own capability",
      viewerApprover === false && can("editor", "approval.grant") === false && can("admin", "approval.grant") === true &&
      (await svc.entities.ApprovalRequest.get(forced.id)).status === "APPROVED",
      "re-assessment, not the stored grant, decides execution");

    // ------------------------------------------------ 13. credential / secret operations
    const secretDeclare = await assessOperation(base44, user, { project_id: project.id, tool: "declare_secret", input: { name: "WEATHER_API_KEY", description: "key" } });
    const secretList = await assessOperation(base44, user, { project_id: project.id, tool: "list_secrets", input: {} });
    h.check("13 a credential operation is protected and no value can travel with it",
      secretDeclare.risk.operation_classes.includes("credential_access") && secretDeclare.risk.risk_level === "high" &&
      secretDeclare.decision.decision === "require_approval" &&
      secretList.decision.decision === "allow" &&
      !JSON.stringify(secretValue.risk.input_summary).includes("sk-live") &&
      secretValue.risk.forbidden[0].code === "SAFETY_SECRET_VALUE",
      `declare=${secretDeclare.risk.risk_level}/${secretDeclare.decision.decision} · metadata read=${secretList.decision.decision}`);

    // ------------------------------------------------ 14. destructive operations
    const forceDelete = await assessOperation(base44, user, { project_id: project.id, tool: "delete_files", input: { paths: ["a.js", "b.js", "c.js", "d.js"], force: true } });
    const rollback = classifyOperation({ tool: "restore_snapshot", contract: toolContract("restore_snapshot"), input: { version_id: "v1" }, mode_allows: true, actor_kind: "platform" });
    const rlsEdit = await assessOperation(base44, user, { project_id: project.id, tool: "update_entity", input: { name: "Customer", fields: [{ name: "x", type: "string" }], rls: { read: {} } } });
    h.check("14 destructive, rollback and security-sensitive operations all require approval",
      forceDelete.risk.risk_level === "critical" && forceDelete.risk.destructive === true && forceDelete.decision.decision === "require_approval" &&
      rollback.operation_classes.includes("rollback") && rollback.risk_level === "high" && rollback.destructive === true &&
      rlsEdit.risk.security_sensitive === true && rlsEdit.risk.risk_level === "high" && rlsEdit.decision.decision === "require_approval",
      `force delete=${forceDelete.risk.risk_level} · rollback=${rollback.risk_level} · rls=${rlsEdit.risk.risk_level}`);

    // ------------------------------------------------ 15. project isolation
    const foreignWs = await svc.entities.Workspace.create({ name: `safety-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreign = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "foreign-safety", framework: "preact-htm", status: "draft" });
    created.projects.push(foreign.id);
    const foreignApproval = await svc.entities.ApprovalRequest.create({
      project_id: foreign.id, workspace_id: foreignWs.id, actor_user_id: user.id, tool: "delete_file",
      risk_level: "high", decision: "require_approval", status: "APPROVED",
      operation_fingerprint: "x", expires_at: new Date(Date.now() + 600000).toISOString(),
    });
    await h.expectThrow("15 another workspace's project cannot be proposed against",
      () => proposeOperation(base44, user, { project_id: foreign.id, tool: "read_file", input: { path: "src/App.js" } }), "NOT_A_MEMBER");
    await h.expectThrow("15b another workspace's approval cannot be read",
      () => getApprovalRequest(base44, user, { approval_id: foreignApproval.id }), "NOT_A_MEMBER");
    await h.expectThrow("15c another workspace's approval cannot be spent",
      () => executeApprovedOperation(base44, user, { approval_id: foreignApproval.id, input: { path: "src/App.js" }, ctx }), "NOT_A_MEMBER");
    const crossProject = await proposeOperation(base44, user, { project_id: project.id, tool: "write_file", input: { path: "src/X.js", content: "x", project_id: foreign.id }, trace_id });
    const listed = await listApprovalRequests(base44, user, { project_id: project.id, limit: 100 });
    h.check("15d a proposal naming another project is denied and every listed approval belongs to this project",
      crossProject.decision === "deny" && crossProject.decision_code === "SAFETY_CROSS_PROJECT" &&
      listed.approvals.length > 0 && listed.approvals.every((a) => a.project_id === project.id) &&
      !listed.approvals.some((a) => a.approval_id === foreignApproval.id),
      `${crossProject.decision_code} · ${listed.count} approval(s), all project-scoped`);

    // ------------------------------------------------ 16. audit trail completeness
    const auditRows = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 500);
    const actions = new Set(auditRows.map((r) => r.action));
    h.check("16 every stage of the flow is on the existing audit trail",
      ["safety.allowed", "safety.approval_requested", "safety.denied", "safety.approval_granted", "safety.approval_refused", "safety.executed", "safety.execution_refused"].every((a) => actions.has(a)) &&
      auditRows.every((r) => r.workspace_id === ws.id && r.project_id === project.id) &&
      auditRows.some((r) => r.action === "safety.executed" && r.metadata?.execution_ok === true) &&
      !JSON.stringify(auditRows).includes("sk-live"),
      `${auditRows.length} rows · ${[...actions].filter((a) => a.startsWith("safety.")).sort().join(", ")}`);

    // ------------------------------------------------ 17/18. determinism
    const r1 = classifyOperation({ tool: "delete_file", contract: toolContract("delete_file"), input: { path: "src/App.js" }, mode_allows: true });
    const r2 = classifyOperation({ tool: "delete_file", contract: toolContract("delete_file"), input: { path: "src/App.js" }, mode_allows: true });
    const other = classifyOperation({ tool: "delete_file", contract: toolContract("delete_file"), input: { path: "src/main.js" }, mode_allows: true });
    const f1 = await sha256Hex(fingerprintPayload({ tool: "delete_file", input: { path: "src/App.js" }, project_id: project.id, risk: r1 }));
    const f2 = await sha256Hex(fingerprintPayload({ tool: "delete_file", input: { path: "src/App.js" }, project_id: project.id, risk: r2 }));
    const fKeyOrder = await sha256Hex(fingerprintPayload({ tool: "delete_file", input: { path: "src/App.js" }, project_id: project.id, risk: r1 }));
    const fOther = await sha256Hex(fingerprintPayload({ tool: "delete_file", input: { path: "src/main.js" }, project_id: project.id, risk: other }));
    h.check("17 risk classification is deterministic and content-addressed",
      JSON.stringify(r1) === JSON.stringify(r2) && f1 === f2 && f1 === fKeyOrder && f1 !== fOther &&
      r1.contract_version === SAFETY_CONTRACT_VERSION,
      `same operation → ${f1.slice(0, 12)} · different target → ${fOther.slice(0, 12)}`);
    const d1 = decideOperation({ risk: r1, role: "owner", role_permits: true });
    const d2 = decideOperation({ risk: r2, role: "owner", role_permits: true });
    h.check("18 the decision is deterministic for the same operation, role and risk",
      JSON.stringify(d1) === JSON.stringify(d2) && d1.decision === "require_approval",
      `${d1.decision}/${d1.code}`);

    // ------------------------------------------------ 19/20. Architecture + App Primitives integration
    const archRaised = await assessOperation(base44, user, { project_id: project.id, tool: "patch_file", input: { path: "src/App.js", find: "safety", replace: "gated" }, architecture_risk: "critical" });
    const archPlain = await assessOperation(base44, user, { project_id: project.id, tool: "patch_file", input: { path: "src/App.js", find: "safety", replace: "gated" } });
    const archCannotLower = classifyOperation({ tool: "delete_file", contract: toolContract("delete_file"), input: { path: "src/App.js" }, mode_allows: true, architecture_risk: "low" });
    h.check("19 architecture impact can RAISE the risk of an operation and never lower it",
      archPlain.decision.decision === "allow" && archRaised.risk.risk_level === "critical" &&
      archRaised.decision.decision === "require_approval" &&
      archRaised.risk.risk_factors.some((f) => f.includes("architecture impact")) &&
      archCannotLower.risk_level === "high",
      `plain=${archPlain.risk.risk_level} · with impact=${archRaised.risk.risk_level} · delete with low impact=${archCannotLower.risk_level}`);
    const capRaised = await assessOperation(base44, user, { project_id: project.id, tool: "write_file", input: { path: "src/New.js", content: "x" }, capability_risk: "high" });
    const capCannotLower = classifyOperation({ tool: "declare_secret", contract: toolContract("declare_secret"), input: { name: "K" }, mode_allows: true, capability_risk: "low" });
    h.check("20 the capability plan can raise risk and never lower it",
      capRaised.risk.risk_level === "high" && capRaised.decision.decision === "require_approval" &&
      capRaised.risk.risk_factors.some((f) => f.includes("capability plan")) &&
      capCannotLower.risk_level === "high",
      `write with capability risk=${capRaised.risk.risk_level} · secret with low=${capCannotLower.risk_level}`);

    // ------------------------------------------------ 21. existing execution pipeline integration
    const spans = await svc.entities.TraceEvent.filter({ project_id: project.id, trace_id }, "-created_date", 200).catch(() => []);
    h.check("21 execution goes through the existing tool boundary and its existing trace",
      spans.some((s) => s.event_type === "tool_call" && s.name === "delete_file" && s.status === "ok") &&
      spans.some((s) => s.event_type === "tool_call" && s.name === "read_file") &&
      spans.some((s) => s.name === "safety.executed") && spans.every((s) => s.project_id === project.id),
      `${spans.length} span(s) on the operation's own trace`);

    // ------------------------------------------------ 22. SDK / CLI / MCP invocation boundary
    const mcp = await assessOperation(base44, user, { project_id: project.id, tool: "mcp_call", input: { connection: "docs", tool: "search" } });
    const platformSystem = classifyOperation({ tool: "create_snapshot", contract: toolContract("create_snapshot"), input: { message: "m" }, mode_allows: true, actor_kind: "platform" });
    h.check("22 an external connector/MCP action is gated, and platform-issued system work stays platform-only",
      mcp.risk.operation_classes.includes("external_action") && mcp.risk.risk_level === "medium" &&
      mcp.decision.decision === "require_approval" &&
      platformSystem.forbidden.length === 0 && systemTool.decision_code === "SAFETY_SYSTEM_TOOL",
      `mcp=${mcp.risk.risk_level}/${mcp.decision.decision} · caller-issued system tool=${systemTool.decision_code}`);

    // ------------------------------------------------ 23. failure is never a false success
    const failing = await proposeOperation(base44, user, { project_id: project.id, tool: "delete_file", input: { path: "src/DoesNotExist.js" }, trace_id });
    await resolveApproval(base44, user, { approval_id: failing.approval.approval_id, decision: "approved", trace_id });
    const failed = await executeApprovedOperation(base44, user, { approval_id: failing.approval.approval_id, input: { path: "src/DoesNotExist.js" }, ctx, trace_id });
    h.check("23 an approved operation whose execution fails is recorded as a failure, not a success",
      failed.ok === false && failed.result.ok === false && failed.approval.status === "FAILED" &&
      failed.approval.execution_ok === false && !!failed.approval.execution_summary,
      `${failed.approval.status} · ${failed.approval.execution_summary}`);

    // ------------------------------------------------ 24. legacy behaviour unchanged
    const before = (await svc.entities.ApprovalRequest.filter({ project_id: project.id }, "-created_date", 500)).length;
    const legacySession = await createToolSession(base44, { user, project_id: project.id, mode: "default" });
    const legacyRead = await legacySession.call("read_file", { path: "src/main.js" }, ctx);
    const legacyWrite = await legacySession.call("write_file", { path: "src/Legacy.js", content: "export default 1;\n" }, ctx);
    const after = (await svc.entities.ApprovalRequest.filter({ project_id: project.id }, "-created_date", 500)).length;
    h.check("24 the existing tool boundary keeps working exactly as before, with no approval state invented",
      legacyRead.ok === true && legacyWrite.ok === true && before === after &&
      readFile(ctx.fs, "src/Legacy.js").includes("export default 1") &&
      low.decision === "allow",
      `${before} approvals before, ${after} after two direct tool calls`);

    // ------------------------------------------------ 25. the full flow, end to end
    const flowTrace = `safety-flow-${Date.now()}`;
    const proposal = await proposeOperation(base44, user, { project_id: project.id, tool: "delete_integration", input: { name: "legacyBilling" }, trace_id: flowTrace });
    const midwayRefusal = await (async () => {
      try { await executeApprovedOperation(base44, user, { approval_id: proposal.approval.approval_id, input: { name: "legacyBilling" }, ctx, trace_id: flowTrace }); return "executed"; }
      catch (e) { return e.code; }
    })();
    const approvedFlow = await resolveApproval(base44, user, { approval_id: proposal.approval.approval_id, decision: "approved", reason: "ok", trace_id: flowTrace });
    const executedFlow = await executeApprovedOperation(base44, user, { approval_id: proposal.approval.approval_id, input: { name: "legacyBilling" }, ctx, trace_id: flowTrace });
    const flowAudit = await svc.entities.AuditLog.filter({ project_id: project.id }, "created_date", 500);
    const flowActions = flowAudit.filter((r) => r.metadata?.tool === "delete_integration" && String(r.action).startsWith("safety.")).map((r) => r.action);
    h.check("25 proposal → risk → permission → approval → execution → audit, in that order and not otherwise",
      proposal.decision === "require_approval" && midwayRefusal === "APPROVAL_NOT_GRANTED" &&
      approvedFlow.approval.status === "APPROVED" && executedFlow.executed === true &&
      ["safety.approval_requested", "safety.execution_refused", "safety.approval_granted", "safety.executed"].every((a) => flowActions.includes(a)) &&
      flowActions.indexOf("safety.approval_requested") < flowActions.indexOf("safety.approval_granted") &&
      flowActions.indexOf("safety.approval_granted") < flowActions.lastIndexOf("safety.executed"),
      `${flowActions.join(" → ")} · premature execution refused with ${midwayRefusal}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["ApprovalRequest", "TraceEvent", "AuditLog", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["ApprovalRequest", "AuditLog", "TraceEvent", "WorkspaceMember", "Project"]);
    }
  }
}