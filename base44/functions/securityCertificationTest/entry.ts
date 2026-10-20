// #44 — SECURITY CERTIFICATION over the CURRENT platform. (certification run)
//
// Every check below runs against the REAL production contract for that surface — the real
// authorization layer, the real RLS evaluator, the real tool boundary, the real safety engine, the
// real sandbox, the real secret crypto, the real webhook gate, the real deploy control plane, and
// the real MCP / SDK / CLI entry layers — over REAL persisted project state. Nothing is stubbed and
// no assertion is softened: an attacker path that succeeds is a failed check, not a note.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy, captureCall as capture, wasRefused, nowIso } from "../../shared/testHarness.ts";
// authorization + the secret projection
import { loadAuthorizedProject, loadProjectState, secretMetadata } from "../../shared/authz.ts";
import { can } from "../../shared/rbac.ts";
// the one RLS evaluator, through the one server-side data path
import { gateFor, recordView } from "../../shared/rls.ts";
import { createServerDb } from "../../shared/appData.ts";
// the one tool execution boundary + the safety / approval gate and its pure policy
import { createToolSession, toolContract } from "../../shared/toolRouter.ts";
import { classifyOperation } from "../../shared/safetyPolicy.ts";
import { proposeOperation, resolveApproval, executeApprovedOperation, runGatedOperation, listApprovalRequests } from "../../shared/safetyEngine.ts";
// sandbox, agent permission gate, outbound guard
import { sandboxPath, sandboxRead, sandboxInfo, sandboxRun, sandboxWrite } from "../../shared/sandbox.ts";
import { parseAgentDocument, agentPermissionGate } from "../../shared/agentResource.ts";
import { assertAllowedUrl } from "../../shared/externalTools.ts";
// secrets at rest, webhook authenticity, deployment control plane
import { encryptSecretValue, decryptSecretValue, encryptWithAad } from "../../shared/secretCrypto.ts";
import { verifyWebhookRequest, computeSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER, SIGNING_SECRET_NAME } from "../../shared/webhookSecurity.ts";
import { requestDeployment, currentLiveDeployment, scanForSecrets } from "../../shared/deploy.ts";
import { pointerFields } from "../../shared/environments.ts";
// developer surfaces: MCP server tools, the SDK/platform service layer, the CLI
import { listEntitySchemas, queryEntityRecords, mutateEntityRecord, inspectProjectVersion, getBuildResult } from "../../shared/mcpServerTools.ts";
import { getProject, getProjectContext, accessibleWorkspaces } from "../../shared/platformApi.ts";
import { runCli } from "../../shared/cli.ts";
import { createFs } from "../../shared/projectFs.ts";

// The SAME in-memory tool context the Builder's own tool tests use, so a gated low-risk read
// executes through the real tool boundary instead of failing for want of a filesystem.
const mkToolCtx = (files) => {
  const fs = createFs([]);
  for (const [path, content] of Object.entries(files)) fs.files.set(path, { id: null, path, content, original: null });
  return { fs, entities: [], secrets: [], deletes: 0 };
};
import { createDelegatedCredentialResolver } from "../../shared/delegatedOAuth.ts";

const SECRET_VALUE = "sk_live_sec_cert_must_never_escape_4b7d";
const TOKEN_VALUE = "ghp_seccertdummytoken000000000000000000";


export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  const created = { workspaces: [], projects: [], cacheKeys: [] };
  let caller = null;

  // Every refusal is captured the same way, so a check can assert the CODE and the STATUS the
  // platform really produced rather than merely that something went wrong.
  const capture = async (fn) => {
    try { const value = await fn(); return { threw: false, value }; }
    catch (e) { return { threw: true, code: e.code || null, status: e.status || null, message: String(e.message || "") }; }
  };
  const refused = (r, statuses = [401, 403, 404]) => r.threw && statuses.includes(Number(r.status) || 0);

  try {
    caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const stranger = { id: "sec_stranger_user", email: "sec-stranger@example.com" };
    const viewer = { id: "sec_viewer_user", email: "sec-viewer@example.com" };
    const endUserA = { id: "sec_app_user_a", email: "a@example.com" };
    const endUserB = { id: "sec_app_user_b", email: "b@example.com" };

    // --- real project state -------------------------------------------------------------
    const ws = await svc.entities.Workspace.create({ name: `sec-cert-${Date.now()}`, owner_id: caller.id, credits_balance: 50 });
    created.workspaces.push(ws.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `sec-foreign-${Date.now()}`, owner_id: "sec_other_owner", credits_balance: 0 });
    created.workspaces.push(foreignWs.id);
    await svc.entities.WorkspaceMember.create({ workspace_id: ws.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: nowIso() });

    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: "sec-project", status: "ready", version_count: 1, slug: `sec-cert-${Date.now().toString(36)}` });
    const other = await svc.entities.Project.create({ workspace_id: ws.id, name: "sec-sibling", status: "ready", version_count: 1 });
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "sec-foreign", status: "ready", version_count: 1 });
    created.projects.push(proj.id, other.id, foreignProj.id);

    const files = [
      { path: "src/main.js", content: "export function main() { return 'ok'; }\n" },
      { path: "src/pages/Target.js", content: "export default function Target() { return 'target'; }\n" },
      { path: "base44/config.jsonc", content: `{\n  "site": { "buildCommand": "build" }\n}\n` },
    ];
    for (const f of files) await svc.entities.ProjectFile.create({ project_id: proj.id, ...f });
    const version = await svc.entities.ProjectVersion.create({ project_id: proj.id, number: 1, message: "initial" });
    const foreignVersion = await svc.entities.ProjectVersion.create({ project_id: other.id, number: 1, message: "sibling" });
    const foreignBuild = await svc.entities.Build.create({ project_id: foreignProj.id, status: "success", error_count: 0, file_count: 1 });

    // Entities: one with per-owner row-level rules, one with none (legacy posture).
    const ownedEntity = {
      name: "Note", fields: { title: { type: "string", required: true } },
      rls: { read: { created_by_id: "{{user.id}}" }, update: { created_by_id: "{{user.id}}" }, delete: false },
    };
    const openEntity = { name: "Public", fields: { label: { type: "string" } } };
    await svc.entities.AppEntity.create({ project_id: proj.id, name: ownedEntity.name, fields: ownedEntity.fields, rls: ownedEntity.rls });
    await svc.entities.AppEntity.create({ project_id: proj.id, name: openEntity.name, fields: openEntity.fields });
    const recA = await svc.entities.AppRecord.create({ project_id: proj.id, entity_name: "Note", owner_id: endUserA.id, data: { title: "A's note" } });
    const recB = await svc.entities.AppRecord.create({ project_id: proj.id, entity_name: "Note", owner_id: endUserB.id, data: { title: "B's note" } });
    await svc.entities.AppRecord.create({ project_id: proj.id, entity_name: "Public", owner_id: endUserA.id, data: { label: "shared" } });
    const foreignRecord = await svc.entities.AppRecord.create({ project_id: foreignProj.id, entity_name: "Note", owner_id: endUserA.id, data: { title: "foreign" } });

    // Real secrets, encrypted at rest through the platform's own crypto.
    await svc.entities.ProjectSecret.create({ project_id: proj.id, name: "API_KEY", value: await encryptSecretValue(proj.id, "API_KEY", SECRET_VALUE), description: "", required: true, access: "backend_only" });
    const hookSecret = "whsec_sec_cert_signing_secret_9911";
    await svc.entities.ProjectSecret.create({ project_id: proj.id, name: SIGNING_SECRET_NAME, value: await encryptSecretValue(proj.id, SIGNING_SECRET_NAME, hookSecret), description: "", required: true, access: "backend_only" });
    await svc.entities.ProjectSecret.create({ project_id: proj.id, name: "LEGACY_KEY", value: "legacy-plaintext-value", description: "", required: false, access: "backend_only" });

    // ============== 1 · unauthenticated access ==============
    const unauth = {
      cli: await runCli(base44, null, { command: "link", args: { project_id: proj.id } }),
      tool: await capture(() => createToolSession(base44, { user: null, project_id: proj.id })),
      safety: await capture(() => proposeOperation(base44, null, { project_id: proj.id, tool: "read_file", input: { path: "src/main.js" } })),
      approvals: await capture(() => listApprovalRequests(base44, null, { project_id: proj.id })),
      sandbox: await capture(() => sandboxRead(base44, null, { project_id: proj.id, path: "src/main.js" })),
      sdk: await capture(() => getProject(base44, null, proj.id)),
    };
    h.check("1 unauthenticated access is refused on every surface",
      unauth.cli.ok === false && unauth.cli.exit_code === 3 && unauth.cli.status === 401 &&
      unauth.tool.code === "AUTH_REQUIRED" && unauth.safety.code === "AUTH_REQUIRED" && unauth.approvals.code === "AUTH_REQUIRED" &&
      unauth.sandbox.threw && unauth.sdk.threw,
      `cli exit ${unauth.cli.exit_code}, tool ${unauth.tool.code}, safety ${unauth.safety.code}, sandbox ${unauth.sandbox.code}, sdk ${unauth.sdk.code}`);

    // ============== 2 · unauthorized (authenticated non-member) ==============
    const outsider = {
      authz: await capture(() => loadAuthorizedProject(base44, stranger, proj.id, "project.read")),
      sandbox: await capture(() => sandboxRead(base44, stranger, { project_id: proj.id, path: "src/main.js" })),
      mcp: await capture(() => listEntitySchemas(base44, stranger, { project_id: proj.id })),
      sdk: await capture(() => getProjectContext(base44, stranger, proj.id)),
      safety: await capture(() => proposeOperation(base44, stranger, { project_id: proj.id, tool: "read_file", input: { path: "src/main.js" } })),
    };
    h.check("2 an authenticated non-member reaches nothing",
      outsider.authz.code === "NOT_A_MEMBER" && refused(outsider.sandbox) && refused(outsider.mcp) && refused(outsider.sdk) && refused(outsider.safety),
      `authz ${outsider.authz.code} · sandbox ${outsider.sandbox.status} · mcp ${outsider.mcp.status} · sdk ${outsider.sdk.status} · safety ${outsider.safety.status}`);

    // ============== 3 · role enforcement ==============
    const viewerSession = await createToolSession(base44, { user: viewer, project_id: proj.id });
    const viewerWrite = await capture(() => viewerSession.authorize("write_file"));
    const viewerDelete = await capture(() => viewerSession.authorize("delete_file"));
    const viewerRestore = await capture(() => viewerSession.authorize("restore_snapshot"));
    const viewerDeploy = await capture(() => requestDeployment(base44, viewer, { project_id: proj.id }));
    const viewerMcpWrite = await capture(() => mutateEntityRecord(base44, viewer, { project_id: proj.id, entity: "Public", operation: "create", data: { label: "x" } }));
    h.check("3 a viewer may read but never mutate, restore or deploy",
      viewerSession.role === "viewer" && !!viewerSession.authorize("read_file") &&
      viewerWrite.code === "INSUFFICIENT_ROLE" && viewerDelete.code === "INSUFFICIENT_ROLE" && viewerRestore.code === "INSUFFICIENT_ROLE" &&
      refused(viewerDeploy) && refused(viewerMcpWrite) &&
      can("viewer", "project.read") === true && can("viewer", "project.write") === false && can("viewer", "deploy.manage") === false,
      `write/delete/restore ${viewerWrite.code} · deploy ${viewerDeploy.status} · mcp write ${viewerMcpWrite.status}`);

    // ============== 4 · tenant isolation ==============
    const foreignReach = await capture(() => loadAuthorizedProject(base44, caller, foreignProj.id, "project.read"));
    const foreignBuildRead = await capture(() => getBuildResult(base44, caller, { build_id: foreignBuild.id }));
    const reachable = await accessibleWorkspaces(base44, caller);
    h.check("4 tenant isolation holds across workspaces",
      foreignReach.code === "NOT_A_MEMBER" && refused(foreignBuildRead) &&
      !reachable.some((w) => w.id === foreignWs.id) && reachable.some((w) => w.id === ws.id),
      `foreign workspace ${foreignReach.code}; foreign build ${foreignBuildRead.status}; ${reachable.length} reachable workspace(s)`);

    // ============== 5 · project isolation (same tenant) ==============
    const foreignRun = await svc.entities.AIRun.create({ project_id: other.id, status: "COMPLETED", mode: "default", prompt: "sibling run" });
    const crossRun = await capture(() => createToolSession(base44, { user: caller, project_id: proj.id, run_id: foreignRun.id }));
    const crossVersion = await capture(() => inspectProjectVersion(base44, caller, { project_id: proj.id, version_id: foreignVersion.id }));
    const crossSafety = await capture(() => proposeOperation(base44, caller, { project_id: proj.id, tool: "read_file", input: { path: "src/main.js", project_id: other.id } }));
    h.check("5 project isolation holds inside one tenant",
      crossRun.code === "RUN_PROJECT_MISMATCH" && crossVersion.code === "VERSION_NOT_FOUND" &&
      crossSafety.value?.decision === "deny" && crossSafety.value?.decision_code === "SAFETY_CROSS_PROJECT",
      `run ${crossRun.code} · version ${crossVersion.code} · cross-project proposal ${crossSafety.value?.decision_code}`);

    // ============== 6 · RLS enforcement ==============
    const defs = [ownedEntity, openEntity];
    const dbA = createServerDb(svc, proj.id, defs, { user: endUserA });
    const dbB = createServerDb(svc, proj.id, defs, { user: endUserB });
    const aSees = await dbA.Note.filter({});
    const bSees = await dbB.Note.filter({});
    const aGetsB = await capture(() => dbA.Note.get(recB.id));
    const aUpdatesB = await capture(() => dbA.Note.update(recB.id, { title: "hijacked" }));
    const aDeletesOwn = await capture(() => dbA.Note.delete(recA.id));
    const aCount = await dbA.Note.count({});
    const bRecordAfter = await svc.entities.AppRecord.get(recB.id);
    h.check("6 RLS is enforced server-side on read, write and delete",
      aSees.length === 1 && aSees[0].id === recA.id && bSees.length === 1 && bSees[0].id === recB.id && aCount === 1 &&
      aGetsB.code === "DATABASE_RECORD_NOT_FOUND" && aUpdatesB.code === "DATABASE_RLS_DENIED" && aDeletesOwn.code === "DATABASE_RLS_DENIED" &&
      bRecordAfter.data.title === "B's note" &&
      gateFor(ownedEntity, "delete", endUserA).deny === true && gateFor(ownedEntity, "read", endUserA).allows(recordView(recA)) === true,
      `A sees ${aSees.length}, B sees ${bSees.length}; cross-read ${aGetsB.code}; cross-write ${aUpdatesB.code}; delete ${aDeletesOwn.code}`);

    // ============== 7 · secret isolation ==============
    const secretRows = await svc.entities.ProjectSecret.filter({ project_id: proj.id }, "name", 20);
    const metadata = secretMetadata(secretRows);
    const state = await loadProjectState(base44, proj.id);
    const info = await sandboxInfo(base44, caller, { project_id: proj.id });
    const storedCipher = secretRows.find((s) => s.name === "API_KEY").value;
    const wrongProject = await capture(() => decryptSecretValue(other.id, "API_KEY", storedCipher));
    const wrongName = await capture(() => decryptSecretValue(proj.id, "OTHER_NAME", storedCipher));
    const rightWay = await decryptSecretValue(proj.id, "API_KEY", storedCipher);
    h.check("7 secret values never leave the server, and are sealed to project + name",
      metadata.every((m) => m.value === undefined) && metadata.find((m) => m.name === "API_KEY").is_set === true &&
      state.secrets.every((s) => s.value === undefined) && info.secrets.every((s) => s.value === undefined) &&
      !JSON.stringify([metadata, state.secrets, info]).includes(SECRET_VALUE) &&
      storedCipher.startsWith("enc:v1:") && rightWay === SECRET_VALUE &&
      wrongProject.code === "SECRET_DECRYPT_FAILED" && wrongName.code === "SECRET_DECRYPT_FAILED",
      `metadata is_set only; ciphertext refuses project ${wrongProject.code} and name ${wrongName.code}`);

    // ============== 8 · connector credential isolation ==============
    const credId = "dc_sec_cert_a";
    await svc.entities.DelegatedCredential.create({
      credential_id: credId, project_id: proj.id, workspace_id: ws.id, app_user_id: endUserA.id,
      provider_id: "seccert", external_subject: "subject-a", status: "active",
      encrypted_access_token: await encryptWithAad(`delegated-credential:${proj.id}:${credId}`, TOKEN_VALUE),
      expires_at: new Date(Date.now() + 3600000).toISOString(), token_endpoint: "https://provider.example.com/token",
      client_id_secret: "API_KEY", pkce: false, created_at: nowIso(),
    });
    const resolveAsA = createDelegatedCredentialResolver(svc, { project: proj, user: endUserA, resolveSecret: async () => "cid", http: async () => ({ ok: true, body: {} }) });
    const resolveAsB = createDelegatedCredentialResolver(svc, { project: proj, user: endUserB, resolveSecret: async () => "cid", http: async () => ({ ok: true, body: {} }) });
    const resolveAnon = createDelegatedCredentialResolver(svc, { project: proj, user: null, resolveSecret: async () => "cid", http: async () => ({ ok: true, body: {} }) });
    const resolveOtherProject = createDelegatedCredentialResolver(svc, { project: other, user: endUserA, resolveSecret: async () => "cid", http: async () => ({ ok: true, body: {} }) });
    const ownToken = await resolveAsA({ kind: "delegated", credential_id: credId });
    const asB = await capture(() => resolveAsB({ kind: "delegated", credential_id: credId }));
    const anon = await capture(() => resolveAnon({ kind: "delegated", credential_id: credId }));
    const crossProj = await capture(() => resolveOtherProject({ kind: "delegated", credential_id: credId }));
    h.check("8 a delegated connector credential serves only its own user and project",
      ownToken === TOKEN_VALUE &&
      asB.message.includes("another user") && anon.code === "AUTH_FAILURE" && crossProj.message.includes("was not found"),
      `own user resolves; other user refused, anonymous ${anon.code}, cross-project refused`);

    // ============== 9 · agent / tool permission enforcement ==============
    const agentDoc = parseAgentDocument("base44/agents/reader.jsonc", JSON.stringify({ name: "reader", instructions: "Read only.", tools: ["read_file", "list_files"] }));
    const gate = agentPermissionGate(agentDoc.agent);
    const systemGrant = parseAgentDocument("base44/agents/bad.jsonc", JSON.stringify({ name: "bad", instructions: "x", tools: ["run_build"] }));
    const unknownGrant = parseAgentDocument("base44/agents/bad2.jsonc", JSON.stringify({ name: "bad2", instructions: "x", tools: ["rm_rf"] }));
    const emptyGate = agentPermissionGate(parseAgentDocument("base44/agents/none.jsonc", JSON.stringify({ name: "none", instructions: "x" })).agent);
    h.check("9 an agent may use only the tools it was granted, and cannot be granted more",
      gate("read_file").allowed === true && gate("write_file").allowed === false && gate("write_file").code === "AGENT_TOOL_NOT_GRANTED" &&
      gate("delete_file").allowed === false && gate.canWrite === false &&
      systemGrant.ok === false && /platform issues itself/.test(systemGrant.error) &&
      unknownGrant.ok === false && emptyGate("read_file").allowed === false,
      `granted ${gate.granted.join(", ")}; system grant refused; an agent with no grants gets nothing`);

    // ============== 10 · sandbox isolation ==============
    const traversal = await capture(() => sandboxPath("src/../../etc/passwd"));
    const absolute = await capture(() => sandboxPath("/etc/passwd"));
    const scheme = await capture(() => sandboxPath("https://evil.example.com/x"));
    const nul = await capture(() => sandboxPath("src/a\0b.js"));
    const shell = await capture(() => sandboxRun(base44, caller, { project_id: proj.id, command: "rm -rf / && curl evil.example.com" }));
    const missing = await capture(() => sandboxRead(base44, caller, { project_id: proj.id, path: "src/does-not-exist.js" }));
    h.check("10 the sandbox cannot escape the project or execute a shell",
      traversal.code === "RESOURCE_INVALID_PATH" && absolute.code === "RESOURCE_INVALID_PATH" &&
      scheme.code === "RESOURCE_INVALID_PATH" && nul.code === "RESOURCE_INVALID_PATH" &&
      shell.code === "RESOURCE_UNSUPPORTED" && missing.code === "RESOURCE_NOT_FOUND" &&
      (await sandboxRead(base44, caller, { project_id: proj.id, path: "src/main.js" })).content.includes("main"),
      `traversal/absolute/URL/NUL all refused; arbitrary command ${shell.code}`);

    // ============== 11 · function execution boundary ==============
    const dbProject = createServerDb(svc, proj.id, defs, { user: endUserA });
    const foreignRead = await capture(() => dbProject.Note.get(foreignRecord.id));
    const unknownEntity = await capture(() => dbProject.Secrets.filter({}));
    const wipe = await capture(() => dbProject.Public.deleteWhere({}));
    h.check("11 a function's data accessor is bound to its own project and declared entities",
      foreignRead.code === "DATABASE_RECORD_NOT_FOUND" && unknownEntity.code === "DATABASE_ENTITY_NOT_FOUND" &&
      wipe.code === "DATABASE_UNSAFE_BULK" &&
      (await svc.entities.AppRecord.get(foreignRecord.id)).project_id === foreignProj.id,
      `foreign record ${foreignRead.code}; unknown entity ${unknownEntity.code}; blind wipe ${wipe.code}`);

    // ============== 12 · destructive-operation protection ==============
    const deleteRisk = classifyOperation({ tool: "delete_files", contract: toolContract("delete_files"), input: { paths: ["a.js", "b.js", "c.js", "d.js"], force: true }, project_id: proj.id });
    const rlsRisk = classifyOperation({ tool: "write_file", contract: toolContract("write_file"), input: { path: "base44/entities/Note.jsonc", rls: { read: false } }, project_id: proj.id });
    const proposal = await proposeOperation(base44, caller, { project_id: proj.id, tool: "delete_file", input: { path: "src/pages/Target.js" } });
    const targetStillThere = (await svc.entities.ProjectFile.filter({ project_id: proj.id, path: "src/pages/Target.js" }, "path", 1)).length === 1;
    h.check("12 destructive and security-sensitive operations are gated, not executed",
      deleteRisk.risk_level === "critical" && deleteRisk.destructive === true && deleteRisk.operation_classes.includes("delete") &&
      rlsRisk.security_sensitive === true && rlsRisk.risk_level === "high" &&
      proposal.decision === "require_approval" && proposal.executed === false && proposal.approval.status === "PENDING" && targetStillThere,
      `forced multi-delete ${deleteRisk.risk_level}; RLS edit ${rlsRisk.risk_level}; proposal ${proposal.decision}, target file intact`);

    // ============== 13 · approval bypass rejection ==============
    const pendingId = proposal.approval.approval_id;
    const spendPending = await capture(() => executeApprovedOperation(base44, caller, { approval_id: pendingId, input: { path: "src/pages/Target.js" } }));
    const strangerGrant = await capture(() => resolveApproval(base44, stranger, { approval_id: pendingId, decision: "approved" }));
    const viewerGrant = await capture(() => resolveApproval(base44, viewer, { approval_id: pendingId, decision: "approved" }));
    await resolveApproval(base44, caller, { approval_id: pendingId, decision: "approved", reason: "certification" });
    const wrongActor = await capture(() => executeApprovedOperation(base44, stranger, { approval_id: pendingId, input: { path: "src/pages/Target.js" } }));
    // A borrowed approval is refused wherever the platform's authorization stops the caller first —
    // as a non-member of the project, or as the wrong actor for this grant. Either way it must not
    // execute, and the approval must still be unspent for its own actor.
    const borrowRefused = wrongActor.threw && ["APPROVAL_WRONG_ACTOR", "NOT_A_MEMBER", "INSUFFICIENT_ROLE"].includes(wrongActor.code);
    const approvalAfterBorrow = await svc.entities.ApprovalRequest.get(pendingId);
    const mismatch = await capture(() => executeApprovedOperation(base44, caller, { approval_id: pendingId, input: { path: "src/main.js" } }));
    const deniedProposal = await proposeOperation(base44, caller, { project_id: proj.id, tool: "declare_secret", input: { name: "X", value: SECRET_VALUE } });
    const spendDenied = await capture(() => executeApprovedOperation(base44, caller, { approval_id: deniedProposal.approval.approval_id, input: { name: "X", value: SECRET_VALUE } }));
    const stillThere = (await svc.entities.ProjectFile.filter({ project_id: proj.id, path: "src/pages/Target.js" }, "path", 1)).length === 1;
    h.check("13 an approval can never be bypassed, borrowed or repurposed",
      spendPending.code === "APPROVAL_NOT_GRANTED" && refused(strangerGrant) && viewerGrant.code === "INSUFFICIENT_ROLE" &&
      borrowRefused && approvalAfterBorrow.status === "APPROVED" && approvalAfterBorrow.execution_ok !== true &&
      mismatch.code === "APPROVAL_OPERATION_MISMATCH" &&
      deniedProposal.decision === "deny" && deniedProposal.decision_code === "SAFETY_SECRET_VALUE" &&
      spendDenied.code === "APPROVAL_DENIED" && stillThere,
      `pending ${spendPending.code} · borrowed approval refused (${wrongActor.code}) and still unspent · changed input ${mismatch.code} · denied ${spendDenied.code}`);

    // ============== 14 · MCP authorization ==============
    const mcpStranger = await capture(() => queryEntityRecords(base44, stranger, { project_id: proj.id, entity: "Note" }));
    const mcpViewer = await capture(() => mutateEntityRecord(base44, viewer, { project_id: proj.id, entity: "Public", operation: "delete", record_id: recA.id }));
    const mcpOwner = await mutateEntityRecord(base44, caller, { project_id: proj.id, entity: "Public", operation: "create", data: { label: "mcp" } });
    const mcpForeignVersion = await capture(() => inspectProjectVersion(base44, caller, { project_id: proj.id, version_id: foreignVersion.id }));
    const mcpRecords = await queryEntityRecords(base44, caller, { project_id: proj.id, entity: "Note" });
    h.check("14 MCP tools enforce the platform's own authorization and project scope",
      refused(mcpStranger) && refused(mcpViewer) && mcpOwner.record_id &&
      mcpForeignVersion.code === "VERSION_NOT_FOUND" && mcpRecords.records.every((r) => !!r.id) && mcpRecords.project_id === proj.id,
      `stranger ${mcpStranger.status} · viewer write ${mcpViewer.status} · owner write ok · foreign version ${mcpForeignVersion.code}`);

    // ============== 15 · SDK authorization ==============
    const sdkStranger = await capture(() => getProject(base44, stranger, proj.id));
    const sdkContext = await getProjectContext(base44, caller, proj.id);
    h.check("15 the SDK/service layer authorizes every read and exposes no credential",
      refused(sdkStranger) && sdkContext.project.project_id === proj.id &&
      sdkContext.secrets.every((s) => s.value === undefined && typeof s.is_set === "boolean") &&
      !JSON.stringify(sdkContext).includes(SECRET_VALUE),
      `stranger ${sdkStranger.status}; ${sdkContext.secrets.length} secret(s) as name + is_set only`);

    // ============== 16 · CLI authorization ==============
    const cliStranger = await runCli(base44, stranger, { command: "link", args: { project_id: proj.id } });
    const cliViewerDeploy = await runCli(base44, viewer, { command: "deploy", args: { project_id: proj.id, wait: false } });
    const cliViewerEdit = await runCli(base44, viewer, { command: "edit", args: { project_id: proj.id, path: "src/main.js", content: "hacked" } });
    const cliOwnerLink = await runCli(base44, caller, { command: "link", args: { project_id: proj.id } });
    const cliUnknown = await runCli(base44, caller, { command: "sudo", args: {} });
    h.check("16 the CLI is a thin surface over the same authorization",
      cliStranger.ok === false && cliStranger.exit_code === 4 &&
      cliViewerDeploy.ok === false && cliViewerDeploy.exit_code === 4 &&
      cliViewerEdit.ok === false && cliViewerEdit.exit_code === 4 &&
      cliOwnerLink.ok === true && cliUnknown.ok === false && cliUnknown.exit_code === 2 &&
      (await svc.entities.ProjectFile.filter({ project_id: proj.id, path: "src/main.js" }, "path", 1))[0].content.includes("export function main"),
      `stranger/viewer exit 4, owner ok, unknown command exit ${cliUnknown.exit_code}; file unchanged`);

    // ============== 17 · webhook security ==============
    const body = JSON.stringify({ event: "ping" });
    const ts = String(Date.now());
    const goodSig = await computeSignature(hookSecret, ts, body);
    created.cacheKeys.push(`webhook_replay:${proj.id}:hook:${goodSig}`);
    const hook = (headers, rawBody = body) => verifyWebhookRequest(svc, { project: proj, headers, rawBody, name: "hook" });
    const noSig = await capture(() => hook({}));
    const badSig = await capture(() => hook({ [SIGNATURE_HEADER]: "deadbeef", [TIMESTAMP_HEADER]: ts }));
    const stale = await capture(() => hook({ [SIGNATURE_HEADER]: goodSig, [TIMESTAMP_HEADER]: String(Date.now() - 3600000) }));
    const tampered = await capture(() => hook({ [SIGNATURE_HEADER]: goodSig, [TIMESTAMP_HEADER]: ts }, JSON.stringify({ event: "admin" })));
    const accepted = await hook({ [SIGNATURE_HEADER]: goodSig, [TIMESTAMP_HEADER]: ts });
    const replay = await capture(() => hook({ [SIGNATURE_HEADER]: goodSig, [TIMESTAMP_HEADER]: ts }));
    const foreignSig = await computeSignature("some-other-secret", ts, body);
    const foreignSigned = await capture(() => hook({ [SIGNATURE_HEADER]: foreignSig, [TIMESTAMP_HEADER]: ts }));
    h.check("17 an unsigned, forged, stale, tampered or replayed webhook is refused",
      noSig.code === "MISSING_SIGNATURE" && badSig.code === "INVALID_SIGNATURE" && stale.code === "EXPIRED_TIMESTAMP" &&
      tampered.code === "INVALID_SIGNATURE" && foreignSigned.code === "INVALID_SIGNATURE" &&
      accepted.delivery_id === goodSig && replay.code === "REPLAYED_REQUEST",
      `missing/forged/stale/tampered/foreign-secret refused; a valid delivery is accepted once, then ${replay.code}`);

    // ============== 18 · SSRF / outbound restriction ==============
    const blockedHosts = ["http://169.254.169.254/latest/meta-data/", "http://localhost:8080/admin", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.5/", "http://172.16.9.9/", "https://db.internal/", "https://api.local/", "http://0.0.0.0/"];
    const blockedResults = [];
    for (const u of blockedHosts) blockedResults.push(await capture(() => assertAllowedUrl(u)));
    const badScheme = await capture(() => assertAllowedUrl("file:///etc/passwd"));
    const gopher = await capture(() => assertAllowedUrl("gopher://evil/x"));
    const allowed = assertAllowedUrl("https://api.example.com/v1/items");
    h.check("18 outbound requests cannot reach loopback, private or metadata targets",
      blockedResults.every((r) => r.threw) && badScheme.threw && gopher.threw && allowed.hostname === "api.example.com",
      `${blockedResults.length} internal target(s) blocked; non-HTTP schemes blocked; public host allowed`);

    // ============== 19 · deployment isolation ==============
    const stagingLive = await svc.entities.Deployment.create({
      project_id: proj.id, workspace_id: ws.id, version_id: version.id, version_number: 1,
      environment: "staging", status: "LIVE", deployed_by: caller.id, deployment_url: `/app/${proj.slug}--staging`,
    });
    const liveStaging = await currentLiveDeployment(svc, proj, "staging");
    const liveProd = await currentLiveDeployment(svc, proj, "production");
    const crossProjectVersion = await capture(() => requestDeployment(base44, caller, { project_id: proj.id, version_id: foreignVersion.id }));
    const strangerDeploy = await capture(() => requestDeployment(base44, stranger, { project_id: proj.id }));
    h.check("19 environments and artifacts are isolated, and a foreign version cannot be deployed",
      liveStaging?.id === stagingLive.id && liveProd === null &&
      pointerFields("staging").deployment !== pointerFields("production").deployment &&
      crossProjectVersion.code === "VERSION_NOT_FOUND" && refused(strangerDeploy),
      `staging live, production untouched; foreign version ${crossProjectVersion.code}; stranger ${strangerDeploy.status}`);

    // ============== 20 · rollback / restore authorization ==============
    const restoreContract = toolContract("restore_snapshot");
    const restoreRisk = classifyOperation({ tool: "restore_snapshot", contract: restoreContract, input: { version_id: version.id }, project_id: proj.id, actor_kind: "user" });
    const userProposedRestore = await proposeOperation(base44, caller, { project_id: proj.id, tool: "restore_snapshot", input: { version_id: version.id } });
    const viewerRestoreCall = await viewerSession.call("restore_snapshot", { version_id: version.id });
    h.check("20 restore/rollback needs its own capability and is never self-authorized",
      restoreContract.capability === "version.restore" && restoreContract.system === true &&
      restoreRisk.operation_classes.includes("rollback") && restoreRisk.destructive === true &&
      restoreRisk.forbidden.some((f) => f.code === "SAFETY_SYSTEM_TOOL") &&
      userProposedRestore.decision === "deny" && userProposedRestore.decision_code === "SAFETY_SYSTEM_TOOL" &&
      viewerRestoreCall.ok === false && viewerRestoreCall.denied === true && viewerRestoreCall.code === "INSUFFICIENT_ROLE" &&
      can("viewer", "version.restore") === false && can("owner", "version.restore") === true,
      `capability ${restoreContract.capability}; caller-proposed restore ${userProposedRestore.decision_code}; viewer ${viewerRestoreCall.code}`);

    // ============== 21 · audit completeness ==============
    // One AUTHORIZED deployment, so the audit trail always carries a deployment.requested row for
    // this project. The unauthorized deployment attempts above are untouched.
    const authorizedDeploy = await capture(() => requestDeployment(base44, caller, { project_id: proj.id, environment: "staging" }));
    const deployRequested = !authorizedDeploy.threw && authorizedDeploy.value?.deployment?.id;
    // The deployment audit row is written by the existing deploy control plane as
    // `deployment.requested`; it is read back by its own resource id so the assertion never depends
    // on the read happening to observe the write in the same instant.
    let deployAudit = [];
    for (let i = 0; i < 5 && !deployAudit.length && deployRequested; i++) {
      deployAudit = await svc.entities.AuditLog.filter({ project_id: proj.id, resource_id: authorizedDeploy.value.deployment.id }, "-created_date", 5).catch(() => []);
      if (!deployAudit.length) await new Promise((r) => setTimeout(r, 400));
    }
    const auditRows = [...(await svc.entities.AuditLog.filter({ project_id: proj.id }, "-created_date", 200)), ...deployAudit]
      .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
    const actions = new Set(auditRows.map((r) => r.action));
    h.check("21 security-sensitive actions land in the existing audit trail, without secrets",
      deployRequested && authorizedDeploy.value.environment === "staging" &&
      actions.has("safety.approval_requested") && actions.has("safety.denied") && actions.has("safety.approval_granted") &&
      actions.has("mcp.record.create") && actions.has("deployment.requested") &&
      auditRows.every((r) => r.project_id === proj.id && r.workspace_id === ws.id) &&
      !JSON.stringify(auditRows).includes(SECRET_VALUE) && !JSON.stringify(auditRows).includes(hookSecret),
      `${auditRows.length} audit row(s): ${[...actions].slice(0, 6).join(", ")}`);

    // ============== 22 · concurrency / conflict handling ==============
    const raceTs = String(Date.now());
    const raceSig = await computeSignature(hookSecret, raceTs, body);
    created.cacheKeys.push(`webhook_replay:${proj.id}:hook:${raceSig}`);
    const raceHeaders = { [SIGNATURE_HEADER]: raceSig, [TIMESTAMP_HEADER]: raceTs };
    const raced = await Promise.allSettled([hook(raceHeaders), hook(raceHeaders), hook(raceHeaders)]);
    const wonWebhook = raced.filter((r) => r.status === "fulfilled").length;
    const conflicting = await Promise.allSettled([
      sandboxWrite(base44, caller, { project_id: proj.id, path: "src/pages/Race.js", content: "export default 1;\n", expected_version: 1 }),
      sandboxWrite(base44, caller, { project_id: proj.id, path: "src/pages/Race.js", content: "export default 2;\n", expected_version: 99 }),
    ]);
    const staleRejected = conflicting.filter((r) => r.status === "rejected" && r.reason?.code === "RESOURCE_CONFLICT").length;
    h.check("22 concurrent and conflicting operations cannot both win",
      wonWebhook === 1 && raced.filter((r) => r.status === "rejected").every((r) => r.reason?.code === "REPLAYED_REQUEST") &&
      conflicting[0].status === "fulfilled" && staleRejected === 1,
      `1 of 3 concurrent identical deliveries accepted; ${staleRejected} stale-version write refused`);

    // ============== 23 · client bundle secret scan ==============
    const clientFiles = [
      { path: "src/clean.js", content: "export const api = '/api';\n" },
      { path: "src/leak.js", content: `export const key = '${SECRET_VALUE}';\n` },
      { path: "src/token.js", content: `export const gh = '${TOKEN_VALUE}';\n` },
      { path: "src/bearer.js", content: "fetch(u, { headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123' } });\n" },
    ];
    const findings = scanForSecrets(clientFiles, [SECRET_VALUE]);
    const cleanFindings = scanForSecrets([clientFiles[0]], [SECRET_VALUE]);
    h.check("23 a credential in client-shipped code is detected and blocks the bundle",
      findings.some((f) => f.startsWith("src/leak.js")) && findings.some((f) => f.startsWith("src/token.js")) &&
      findings.some((f) => f.startsWith("src/bearer.js")) && !findings.some((f) => f.startsWith("src/clean.js")) &&
      cleanFindings.length === 0,
      `${findings.length} finding(s): configured secret value, GitHub token and hardcoded bearer`);

    // ============== 24 · runtime secret exposure ==============
    const toolSession = await createToolSession(base44, { user: caller, project_id: proj.id });
    const listSecrets = await toolSession.call("list_secrets", {}, { fs: null, entities: state.entities, secrets: state.secrets });
    const legacyRow = secretRows.find((s) => s.name === "LEGACY_KEY");
    const surfaces = JSON.stringify([info, state, sdkContext, listSecrets, mcpRecords, proposal, auditRows.slice(0, 20)]);
    h.check("24 no runtime surface exposes a secret value",
      !surfaces.includes(SECRET_VALUE) && !surfaces.includes(hookSecret) && !surfaces.includes(legacyRow.value) &&
      (listSecrets.ok === false || !JSON.stringify(listSecrets).includes(SECRET_VALUE)),
      "sandbox info, project state, SDK context, tool output, MCP reads, proposals and audit rows are all value-free");

    // ============== 25 · cross-surface authorization consistency ==============
    const surfaceRefusals = {
      authz: await capture(() => loadAuthorizedProject(base44, stranger, proj.id, "project.read")),
      sandbox: await capture(() => sandboxRead(base44, stranger, { project_id: proj.id, path: "src/main.js" })),
      mcp: await capture(() => queryEntityRecords(base44, stranger, { project_id: proj.id, entity: "Note" })),
      sdk: await capture(() => getProjectContext(base44, stranger, proj.id)),
      safety: await capture(() => runGatedOperation(base44, stranger, { project_id: proj.id, tool: "read_file", input: { path: "src/main.js" } })),
      deploy: await capture(() => requestDeployment(base44, stranger, { project_id: proj.id })),
      approvals: await capture(() => listApprovalRequests(base44, stranger, { project_id: proj.id })),
    };
    const cli = await runCli(base44, stranger, { command: "pull", args: { project_id: proj.id } });
    h.check("25 every developer surface refuses the same caller for the same reason",
      Object.values(surfaceRefusals).every((r) => refused(r)) &&
      Object.values(surfaceRefusals).every((r) => r.status === 403) && cli.exit_code === 4,
      `7 surfaces refused with 403 and the CLI with exit ${cli.exit_code}`);

    // ============== 26 · legacy compatibility ==============
    const openA = await dbA.Public.filter({});
    const openB = await dbB.Public.filter({});
    const legacyPlaintext = await decryptSecretValue(proj.id, "LEGACY_KEY", legacyRow.value);
    const legacyCtx = mkToolCtx({ "src/main.js": "export function main() { return 'ok'; }\n" });
    const legacyLowRisk = await runGatedOperation(base44, caller, { project_id: proj.id, tool: "read_file", input: { path: "src/main.js" }, ctx: legacyCtx });
    h.check("26 pre-existing behaviour is unchanged where no rule was declared",
      openA.length === openB.length && openA.length >= 2 && gateFor(openEntity, "read", endUserA).open === true &&
      legacyPlaintext === "legacy-plaintext-value" &&
      legacyLowRisk.decision === "allow" && legacyLowRisk.decision_code === "SAFETY_LOW_RISK" && legacyLowRisk.executed === true && legacyLowRisk.ok === true,
      `entity without rules stays open (${openA.length} rows shared); legacy plaintext secret still readable; low-risk read still runs straight through`);

    // ============== 27 · end-to-end attack boundary ==============
    const attack = {
      read: await capture(() => sandboxRead(base44, stranger, { project_id: proj.id, path: "base44/config.jsonc" })),
      write: await capture(() => sandboxWrite(base44, stranger, { project_id: proj.id, path: "src/main.js", content: "stolen" })),
      propose: await capture(() => proposeOperation(base44, stranger, { project_id: proj.id, tool: "delete_files", input: { paths: ["src/main.js"] } })),
      grantOwn: await capture(() => resolveApproval(base44, stranger, { approval_id: pendingId, decision: "approved" })),
      spend: await capture(() => executeApprovedOperation(base44, stranger, { approval_id: pendingId, input: { path: "src/pages/Target.js" } })),
      secrets: await capture(() => queryEntityRecords(base44, stranger, { project_id: proj.id, entity: "Note" })),
      deploy: await capture(() => requestDeployment(base44, stranger, { project_id: proj.id })),
      exfiltrate: await capture(() => assertAllowedUrl("http://169.254.169.254/latest/meta-data/")),
    };
    const filesAfter = await svc.entities.ProjectFile.filter({ project_id: proj.id }, "path", 50);
    const strangerApprovals = (await svc.entities.ApprovalRequest.filter({ project_id: proj.id }, "-created_date", 50)).filter((a) => a.actor_user_id === stranger.id);
    const strangerDeployments = (await svc.entities.Deployment.filter({ project_id: proj.id }, "-created_date", 50)).filter((d) => d.deployed_by === stranger.id);
    h.check("27 a full attack chain changes nothing and leaves no state behind",
      Object.values(attack).every((r) => r.threw) &&
      filesAfter.find((f) => f.path === "src/main.js").content.includes("export function main") &&
      filesAfter.some((f) => f.path === "base44/config.jsonc") &&
      strangerApprovals.length === 0 && strangerDeployments.length === 0 &&
      (await svc.entities.ProjectFile.filter({ project_id: proj.id, path: "src/pages/Target.js" }, "path", 1)).length === 1,
      "read, write, propose, self-approve, spend, exfiltrate and deploy all refused; project state and approval/deployment history untouched");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const key of created.cacheKeys) await purgeBy(svc, "CacheEntry", { cache_key: key });
    for (const pid of created.projects) {
      for (const name of ["ApprovalRequest", "Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "ProjectSecret", "AppEntity", "AppRecord", "AppRelation", "DelegatedCredential", "Build", "AIRun", "TraceEvent", "Trajectory", "TrajectoryEvent", "AuditLog"]) {
        await purgeBy(svc, name, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) await cleanupWorkspace(svc, wid, ["WorkspaceMember", "RateLimitBucket", "AuditLog", "Deployment"]);
  }
}