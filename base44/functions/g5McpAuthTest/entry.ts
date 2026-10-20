// G-5 — MCP authorization parity and lifecycle. Regression harness against real rows.
//
// Verifies, through the REAL MCP code paths:
//   1. connection MANAGEMENT follows the capability matrix (integration.manage =
//      owner/admin/editor): owner, admin and editor may manage; viewer, a non-member and a
//      removed member are refused. The workspace is addressed EXPLICITLY — no implicit
//      selection — an unknown or missing workspace fails closed, cross-workspace access is
//      impossible, and a suspended workspace still refuses management mutations.
//   2. invokeMcpTool enforces the workspace lifecycle for MUTATING external tools only:
//      a suspended workspace refuses them (WORKSPACE_INACTIVE, audited), while read-only
//      tools, discuss mode and an active workspace behave exactly as before.
//   3. delegated agent MCP grants are unchanged: a Builder child without an mcp_call grant
//      is refused; with the grant, and for human-initiated runs, access is unchanged.
//   4. the Tool Router boundary is unchanged: run/agent sessions resolve the CURRENT role,
//      enforce mode permissions and per-tool capabilities exactly as before.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { invokeMcpTool, authorizedManageWorkspace } from "../../shared/mcp.ts";
import { createRunToolSession, createAgentToolSession } from "../../shared/toolRouter.ts";
import { executeTool } from "../../shared/tools.ts";
import { requireActiveWorkspace } from "../../shared/rbac.ts";
import { makeChecks } from "../../shared/testChecklist.ts";

const rid = (p) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

export default async function (req) {
  // The SAME client shape the G-3 workers hand the shared code: a wrapper that carries BOTH
  // the service-role entities and the service-role client itself, because the raw
  // `asServiceRole` client does not expose `.asServiceRole` of its own.
  const raw = createClientFromRequest(req);
  const svc = { entities: raw.asServiceRole.entities, asServiceRole: raw.asServiceRole };
  const { checks, expect, denied, allowed } = makeChecks();
  const cleanup = [];
  const tidy = (entityName, query) => cleanup.push(() => svc.entities[entityName].deleteMany(query).catch(() => {}));

  // Runs a promise-returning operation, classifying the outcome without throwing.
  const attempt = (fn) => fn().then(
    (v) => ({ ok: true, value: v }),
    (e) => ({ ok: false, status: e.status ?? null, code: e.code || "ERROR", detail: e.details?.workspace_status || null, message: e.message }),
  );

  try {
    // --- fixtures: one workspace with a full role matrix, one foreign workspace, and one
    // MCP connection advertising a read-only and a mutating tool -----------------------
    const ownerId = rid("g5-owner"), adminId = rid("g5-admin"), editorId = rid("g5-editor"), viewerId = rid("g5-viewer");
    const ws = await svc.entities.Workspace.create({ name: "G5 MCP Workspace", owner_id: ownerId, status: "active", credits_balance: 0 });
    const wsOther = await svc.entities.Workspace.create({ name: "G5 Other Workspace", owner_id: rid("g5-other-owner"), status: "active", credits_balance: 0 });
    tidy("Workspace", { id: ws.id }); tidy("Workspace", { id: wsOther.id });
    const mkMember = (userId, role) => svc.entities.WorkspaceMember.create({
      workspace_id: ws.id, user_id: userId, email: `${userId}@g5.test`, role, status: "active", accepted_at: new Date().toISOString(),
    });
    const memberAdmin = await mkMember(adminId, "admin");
    const memberEditor = await mkMember(editorId, "editor");
    const memberViewer = await mkMember(viewerId, "viewer");
    tidy("WorkspaceMember", { id: memberAdmin.id }); tidy("WorkspaceMember", { id: memberEditor.id }); tidy("WorkspaceMember", { id: memberViewer.id });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: "G5 Router Project" });
    tidy("Project", { id: proj.id });
    await svc.entities.MCPConnection.create({
      workspace_id: ws.id, name: "g5-conn", server_url: "https://mcp-g5.invalid.test/mcp", transport: "http",
      auth_type: "none", secret_name: "", enabled: true, status: "connected", tool_count: 2,
      tools: [
        { name: "lookup", description: "read-only lookup", input_schema: "{}", read_only: true },
        { name: "write_thing", description: "mutating write", input_schema: "{}", read_only: false },
      ],
    });
    tidy("MCPConnection", { workspace_id: ws.id });
    tidy("MCPInvocation", { workspace_id: ws.id });

    // --- 1. management capability matrix (integration.manage) ------------------------
    const manage = (userId, workspaceId) => authorizedManageWorkspace(svc, { id: userId, email: null }, workspaceId);
    expect("manage_owner_allowed", (await attempt(() => manage(ownerId, ws.id))).ok, "owner manages");
    expect("manage_admin_allowed", (await attempt(() => manage(adminId, ws.id))).ok, "admin manages");
    expect("manage_editor_allowed", (await attempt(() => manage(editorId, ws.id))).ok, "editor manages (capability matrix parity)");
    await denied("manage_viewer_denied", () => manage(viewerId, ws.id), "INSUFFICIENT_ROLE");
    await denied("manage_non_member_denied", () => manage(rid("g5-stranger"), ws.id), "NOT_A_MEMBER");
    await svc.entities.WorkspaceMember.update(memberEditor.id, { status: "removed" });
    await denied("manage_removed_member_denied", () => manage(editorId, ws.id), "NOT_A_MEMBER");
    await svc.entities.WorkspaceMember.update(memberEditor.id, { status: "active" });
    await denied("manage_cross_workspace_denied", () => manage(adminId, wsOther.id), "NOT_A_MEMBER");
    const missing = await attempt(() => manage(adminId, ""));
    expect("manage_requires_explicit_workspace", !missing.ok && missing.code === "WORKSPACE_REQUIRED", `${missing.code} (no implicit rows[0] selection)`);
    const unknown = await attempt(() => manage(adminId, rid("g5-no-such-ws")));
    expect("manage_unknown_workspace_fails_closed", !unknown.ok && unknown.code === "WORKSPACE_NOT_FOUND", `${unknown.code}`);
    await svc.entities.Workspace.update(ws.id, { status: "suspended" });
    await denied("manage_suspended_mutation_denied", async () => requireActiveWorkspace(await manage(adminId, ws.id)));
    await svc.entities.Workspace.update(ws.id, { status: "active" });

    // --- 2. invokeMcpTool lifecycle: mutating external tools only ---------------------
    const mcp = (mode, tool_name) => attempt(() => invokeMcpTool(svc, { workspace_id: ws.id, project_id: null, user_id: editorId, mode, trigger: "g5_test" }, { connection_name: "g5-conn", tool_name, args: {} }));
    // Active workspace, mutating tool: the lifecycle gate passes and the call proceeds —
    // the failure is the network attempt against the unreachable fixture server, never a
    // lifecycle or mode refusal.
    expect("invoke_active_mutating_passes_lifecycle", (await mcp("default", "write_thing")).code === "MCP_CONNECTION_FAILURE", "gate passed, call reached the server");
    await svc.entities.Workspace.update(ws.id, { status: "suspended" });
    const suspMut = await mcp("default", "write_thing");
    expect("invoke_suspended_mutating_denied", !suspMut.ok && suspMut.code === "WORKSPACE_INACTIVE" && suspMut.detail === "suspended", `${suspMut.code} ${suspMut.detail}`);
    expect("invoke_suspended_read_only_unchanged", (await mcp("default", "lookup")).code === "MCP_CONNECTION_FAILURE", "read-only tools stay available");
    expect("invoke_discuss_mutating_denied_unchanged", (await mcp("discuss", "write_thing")).code === "MCP_NOT_ALLOWED", "discuss mode restriction unchanged");
    expect("invoke_suspended_discuss_read_only_unchanged", (await mcp("discuss", "lookup")).code === "MCP_CONNECTION_FAILURE", "discuss read-only unchanged");
    await svc.entities.Workspace.update(ws.id, { status: "active" });
    const audited = await svc.entities.MCPInvocation.filter({ workspace_id: ws.id, error_code: "WORKSPACE_INACTIVE" }, "-created_date", 5);
    expect("lifecycle_denial_audited", audited.length >= 1, "the refusal is recorded as an MCPInvocation row");

    // --- 3. delegated agent MCP grants unchanged --------------------------------------
    const stubCtx = (grants) => ({
      fs: null, entities: [], secrets: [], deletes: 0,
      ...(grants ? { agent_policy_grants: grants } : {}),
      mcp: { connections: [], call: async () => ({ ok: true, stub: true }) },
    });
    const noGrant = await executeTool(stubCtx(["write_file"]), "mcp_call", { connection: "c", tool: "t" }, "default");
    // The registry executor surfaces refusals by message (the structured code stays on the
    // thrown error), so the fail-closed grant gate is asserted through its own wording.
    expect("delegated_without_mcp_grant_refused", noGrant.ok === false && String(noGrant.error).includes("holds no 'mcp_call' grant"), noGrant.error);
    const withGrant = await executeTool(stubCtx(["mcp_call"]), "mcp_call", { connection: "c", tool: "t" }, "default");
    expect("delegated_with_mcp_grant_allowed", withGrant.ok === true, withGrant.error);
    const human = await executeTool(stubCtx(null), "mcp_call", { connection: "c", tool: "t" }, "default");
    expect("human_run_mcp_unchanged", human.ok === true, human.error);

    // --- 4. Tool Router regression ------------------------------------------------------
    const authz = async (userId, tool, { mode = "default", agent = false } = {}) => {
      const workspace = await svc.entities.Workspace.get(ws.id);
      let session;
      try {
        session = agent
          ? await createAgentToolSession(svc, { agentRun: { id: rid("g5-agent"), project_id: proj.id, workspace_id: ws.id, user_id: userId, trace_id: null }, project: proj, workspace })
          : await createRunToolSession(svc, { run: { id: rid("g5-run"), project_id: proj.id, created_by_id: userId }, project: proj, workspace, mode });
      } catch (e) { return { allowed: false, code: e.code, role: null }; }
      try { session.authorize(tool); return { allowed: true, code: null, role: session.role }; }
      catch (e) { return { allowed: false, code: e.code, role: session.role }; }
    };
    const editorMcp = await authz(editorId, "mcp_call");
    expect("router_editor_mcp_call_allowed", editorMcp.allowed && editorMcp.role === "editor", `${editorMcp.role} ${editorMcp.code}`);
    const editorIntegration = await authz(editorId, "create_integration");
    expect("router_editor_integration_manage_allowed", editorIntegration.allowed, editorIntegration.code);
    const viewerMcp = await authz(viewerId, "mcp_call");
    expect("router_viewer_mcp_call_unchanged", viewerMcp.allowed && viewerMcp.role === "viewer", `${viewerMcp.role} ${viewerMcp.code}`);
    const viewerIntegration = await authz(viewerId, "create_integration");
    expect("router_viewer_integration_denied", !viewerIntegration.allowed && viewerIntegration.code === "INSUFFICIENT_ROLE", viewerIntegration.code);
    await svc.entities.WorkspaceMember.update(memberEditor.id, { status: "removed" });
    const removedSession = await authz(editorId, "mcp_call");
    expect("router_removed_member_no_session", !removedSession.allowed && removedSession.code === "NOT_A_MEMBER", removedSession.code);
    await svc.entities.WorkspaceMember.update(memberEditor.id, { status: "active" });
    const agentRead = await authz(editorId, "mcp_call", { agent: true });
    expect("router_agent_mcp_call_allowed", agentRead.allowed, `${agentRead.code}`);
    const agentWrite = await authz(editorId, "write_file", { agent: true });
    expect("router_agent_session_stays_read_only", !agentWrite.allowed && agentWrite.code === "TOOL_NOT_IN_MODE", agentWrite.code);

    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }
}