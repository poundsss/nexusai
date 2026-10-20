// End-to-end verification that account-level credentials (GitHub job tokens and MCP server
// credentials) are encrypted at rest, readable only by their own workspace, and never exposed
// through any tool, run or metadata surface. Runs against real rows and cleans up.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { stashJobToken, readJobToken, destroyJobToken } from "../../shared/gitSync.ts";
import { writeWorkspaceSecret, readWorkspaceSecret, workspaceSecretAad } from "../../shared/workspaceSecrets.ts";
import { resolveWorkspaceSecret, connectionMetadata, prepareRunConnections, mcpToolsView, authHeaders, invokeMcpTool } from "../../shared/mcp.ts";
import { decryptWithAad, isEncrypted } from "../../shared/secretCrypto.ts";

const GH_TOKEN = "gho_e2e_github_token_2f4b8c1d9e";
const MCP_TOKEN = "mcp_e2e_bearer_secret_77aa31bb";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail: String(detail ?? "") });
  const bad = (name, detail) => checks.push({ name, ok: false, detail: String(detail ?? "") });
  const expect = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));
  const cleanup = [];

  try {
    const ws = await svc.entities.Workspace.create({ name: "Secret Test Workspace", owner_id: `sec-owner-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    cleanup.push(() => svc.entities.Workspace.delete(ws.id));
    const other = await svc.entities.Workspace.create({ name: "Secret Other Workspace", owner_id: `sec-other-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    cleanup.push(() => svc.entities.Workspace.delete(other.id));

    const rawRow = async (workspaceId, name) => (await svc.entities.WorkspaceSecret.filter({ workspace_id: workspaceId, name }, "name", 1))[0] || null;

    // --- 1. authorized workspace can use GitHub credentials -------------------
    const ref = `GITHUB_JOB_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await stashJobToken(svc, { workspace_id: ws.id, name: ref, token: GH_TOKEN });
    cleanup.push(() => destroyJobToken(svc, ws.id, ref));
    expect("github_token_usable", (await readJobToken(svc, ws.id, ref)) === GH_TOKEN, "the owning workspace reads back the exact token");

    // --- 2. authorized workspace can use MCP credentials ---------------------
    const secretName = "E2E_MCP_TOKEN";
    await writeWorkspaceSecret(svc, ws.id, secretName, MCP_TOKEN, { description: "e2e" });
    cleanup.push(() => svc.entities.WorkspaceSecret.filter({ workspace_id: ws.id, name: secretName }, "name", 1).then((r) => r[0] && svc.entities.WorkspaceSecret.delete(r[0].id)));
    const resolved = await resolveWorkspaceSecret(svc, ws.id, secretName);
    expect("mcp_secret_usable", resolved === MCP_TOKEN, "the connection's own account resolves the credential");
    expect("mcp_auth_header_built", authHeaders({ auth_type: "bearer" }, resolved).Authorization === `Bearer ${MCP_TOKEN}`, "the credential still authenticates the MCP client");
    // Re-saving through the same path keeps it usable and still encrypted.
    await writeWorkspaceSecret(svc, ws.id, secretName, MCP_TOKEN + "2");
    expect("mcp_secret_rotatable", (await readWorkspaceSecret(svc, ws.id, secretName)) === MCP_TOKEN + "2", "rotation preserved");
    await writeWorkspaceSecret(svc, ws.id, secretName, MCP_TOKEN);

    // --- 3. another workspace cannot read or use them -------------------------
    let ghDenied = null;
    try { await readJobToken(svc, other.id, ref); } catch (e) { ghDenied = e.code || e.message; }
    expect("github_token_scoped", ghDenied === "GITHUB_AUTH_INVALID", `foreign workspace refused (${ghDenied})`);
    expect("mcp_secret_scoped", (await resolveWorkspaceSecret(svc, other.id, secretName)) === null, "a name alone resolves nothing outside its account");
    // Cryptographic binding: even a ciphertext physically copied into another workspace under
    // the same name cannot be opened.
    const sealed = (await rawRow(ws.id, secretName)).value;
    const planted = await svc.entities.WorkspaceSecret.create({ workspace_id: other.id, name: secretName, value: sealed, access: "backend_only" });
    cleanup.push(() => svc.entities.WorkspaceSecret.delete(planted.id));
    let relocation = null;
    try { await readWorkspaceSecret(svc, other.id, secretName); } catch (e) { relocation = e.code; }
    expect("ciphertext_not_relocatable", relocation === "SECRET_DECRYPT_FAILED", `stolen ciphertext fails authentication (${relocation})`);
    expect("aad_binds_workspace_and_name", (await decryptWithAad(workspaceSecretAad(ws.id, secretName), sealed)) === MCP_TOKEN && workspaceSecretAad(ws.id, secretName) !== workspaceSecretAad(other.id, secretName), "AAD = workspace + name");

    // --- 4. the database holds no plaintext ----------------------------------
    const ghRow = await rawRow(ws.id, ref);
    const mcpRow = await rawRow(ws.id, secretName);
    expect("stored_encrypted", isEncrypted(ghRow.value) && isEncrypted(mcpRow.value), "both rows carry the enc:v1 envelope");
    expect("no_plaintext_in_db", !ghRow.value.includes(GH_TOKEN) && !mcpRow.value.includes(MCP_TOKEN), "no stored value contains its plaintext");
    const allRows = await svc.entities.WorkspaceSecret.filter({ workspace_id: ws.id }, "name", 50);
    expect("no_plaintext_anywhere", !JSON.stringify(allRows).includes(GH_TOKEN) && !JSON.stringify(allRows).includes(MCP_TOKEN), `${allRows.length} row(s) scanned`);

    // --- 5. tool/run responses never expose the credential -------------------
    // A connection whose server cannot be reached: discovery fails, and the error that lands
    // in the run, the stored row and the audit trail must be credential-free.
    const conn = await svc.entities.MCPConnection.create({
      workspace_id: ws.id, name: "e2e-unreachable", server_url: "https://nonexistent-mcp-host.example.com/mcp",
      transport: "http", auth_type: "bearer", secret_name: secretName, enabled: true, status: "never_connected", tools: [], tool_count: 0,
    });
    cleanup.push(() => svc.entities.MCPConnection.delete(conn.id));
    expect("metadata_has_no_value", !("value" in connectionMetadata(conn)) && !JSON.stringify(connectionMetadata(conn)).includes(MCP_TOKEN), "connection metadata carries only the secret NAME");

    // These two take the root client (they reach for asServiceRole themselves).
    const client = { asServiceRole: svc, entities: svc.entities };
    const prepared = await prepareRunConnections(client, ws.id);
    const preparedJson = JSON.stringify(prepared);
    expect("run_context_clean", !preparedJson.includes(MCP_TOKEN), `${prepared.connections.length} connection(s), ${prepared.failures.length} failure(s)`);
    expect("tools_view_clean", !JSON.stringify(mcpToolsView(prepared.connections)).includes(MCP_TOKEN), "the AI-facing tool registry carries no credential");
    const afterRow = await svc.entities.MCPConnection.get(conn.id);
    expect("stored_error_clean", !JSON.stringify(afterRow).includes(MCP_TOKEN), `status=${afterRow.status}`);

    // The invocation path itself: an attempt is audited, and neither the thrown error nor the
    // MCPInvocation row may carry the credential.
    let invokeError = null;
    try {
      await invokeMcpTool(client, { workspace_id: ws.id, trigger: "manual_test", mode: "manual" }, { connection_name: conn.name, tool_name: "anything", args: {} });
    } catch (e) { invokeError = e; }
    expect("invocation_error_clean", !!invokeError && !String(invokeError.message).includes(MCP_TOKEN) && !JSON.stringify(invokeError.details || {}).includes(MCP_TOKEN), `${invokeError?.code}`);
    const invs = await svc.entities.MCPInvocation.filter({ workspace_id: ws.id }, "-created_date", 10);
    for (const i of invs) cleanup.push(() => svc.entities.MCPInvocation.delete(i.id));
    expect("audit_rows_clean", invs.length > 0 && !JSON.stringify(invs).includes(MCP_TOKEN), `${invs.length} invocation row(s) recorded, none carrying the credential`);

    // --- 6. destruction still works -----------------------------------------
    await destroyJobToken(svc, ws.id, ref);
    expect("job_token_destroyed", (await rawRow(ws.id, ref)) === null, "the job credential dies with the job");
  } catch (e) {
    bad("suite_execution", e.message);
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed, checks });
}