// Phase 13A — Personal Access Tokens + public app-data REST read API: targeted verification.
//
// Read-only certification: real shared code (shared/pat.ts, shared/mcpServerTools.ts) against
// real scratch rows. Proves the documented contract — Bearer auth, fail-closed refusals, scope
// semantics (all-apps vs one-app, full vs read-only), cross-project isolation, delegation to the
// CERTIFIED entity read path, audit, and hash-only storage.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { makeChecks } from "../../shared/testChecklist.ts";
import { capabilitiesFor } from "../../shared/rbac.ts";
import {
  issuePersonalAccessToken, revokePersonalAccessToken, listPersonalAccessTokens,
  authenticatePersonalAccessToken, handlePublicAppDataGet, newPatToken, PatError,
} from "../../shared/pat.ts";
import { queryEntityRecords } from "../../shared/mcpServerTools.ts";

const attempt = async (fn, ...args) => {
  try { return { ok: true, value: await fn(...args) }; }
  catch (e) { return { ok: false, code: e.code, status: e.status, message: e.message }; }
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const { checks, ok, bad, expect, denied, allowed } = makeChecks();
  const cleanup = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    // --- fixtures ---------------------------------------------------------------
    const ws = await svc.entities.Workspace.create({ name: `PAT ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    cleanup.push(() => svc.entities.Workspace.delete(ws.id));
    const projA = await svc.entities.Project.create({ workspace_id: ws.id, name: `PAT A ${Date.now()}`, slug: `pat-a-${Date.now()}` });
    const projB = await svc.entities.Project.create({ workspace_id: ws.id, name: `PAT B ${Date.now()}`, slug: `pat-b-${Date.now()}` });
    cleanup.push(() => svc.entities.Project.delete(projA.id));
    cleanup.push(() => svc.entities.Project.delete(projB.id));
    const otherWs = await svc.entities.Workspace.create({ name: `PAT Other ${Date.now()}`, owner_id: `pat-stranger-${Date.now()}`, credits_balance: 0 });
    const projC = await svc.entities.Project.create({ workspace_id: otherWs.id, name: `PAT C ${Date.now()}`, slug: `pat-c-${Date.now()}` });
    cleanup.push(() => svc.entities.Project.delete(projC.id));
    cleanup.push(() => svc.entities.Workspace.delete(otherWs.id));

    await svc.entities.AppEntity.create({ project_id: projA.id, name: "Task", fields: { title: { type: "string" } } });
    await svc.entities.AppRecord.create({ project_id: projA.id, entity_name: "Task", data: { title: "first task" } });
    await svc.entities.AppRecord.create({ project_id: projA.id, entity_name: "Task", data: { title: "second task" } });
    await svc.entities.AppEntity.create({ project_id: projB.id, name: "Note", fields: { text: { type: "string" } } });

    // --- 1. issuance: raw returned once, hash-only storage -----------------------
    const patAll = await issuePersonalAccessToken(svc, { workspace_id: ws.id, name: "all-apps", app_scope: "all", full_access: true, created_by: caller.id });
    expect("1a. issue returns a raw token once", typeof patAll.token === "string" && patAll.token.startsWith("nxpat_"), patAll.token?.slice(0, 12));
    const rawAll = patAll.token;
    const rowAll = (await svc.entities.PersonalAccessToken.filter({ workspace_id: ws.id }, "-created_date", 5))[0];
    expect("1b. only the hash is stored — plaintext never persisted", !!rowAll.token_hash && rowAll.token_hash !== rawAll && !JSON.stringify(rowAll).includes(rawAll), JSON.stringify(rowAll).slice(0, 120));

    const patProj = await issuePersonalAccessToken(svc, { workspace_id: ws.id, name: "one-app", app_scope: "project", project_id: projA.id, created_by: caller.id });
    const rawProj = patProj.token;

    // --- 2. metadata list exposes no credential material -------------------------
    const listed = await listPersonalAccessTokens(svc, { workspace_id: ws.id });
    expect("2a. list returns metadata for both tokens", listed.length === 2 && listed.every((t) => t.token_prefix), JSON.stringify(listed.map((t) => t.name)));
    expect("2b. list never includes the raw token or its hash", !JSON.stringify(listed).includes(rawAll) && !JSON.stringify(listed).includes(rowAll.token_hash), "clean");

    // --- 3. fail-closed authentication -------------------------------------------
    expect("3a. missing header refused", (await attempt(authenticatePersonalAccessToken, svc, "")).code === "PAT_MISSING", "");
    expect("3b. non-Bearer scheme refused", (await attempt(authenticatePersonalAccessToken, svc, "Basic abc")).code === "PAT_MISSING", "");
    expect("3c. malformed token refused", (await attempt(authenticatePersonalAccessToken, svc, "Bearer garbage")).code === "PAT_MALFORMED", "");
    expect("3d. unknown (well-formed) token refused", (await attempt(authenticatePersonalAccessToken, svc, `Bearer ${newPatToken()}`)).code === "PAT_INVALID", "");

    // --- 4. valid bearer read through the CERTIFIED path --------------------------
    const read = await handlePublicAppDataGet(base44, { method: "GET", authorization: `Bearer ${rawAll}`, app_id: projA.id, entity_name: "Task" });
    expect("4a. valid bearer GET returns the records", read.count === 2 && read.entity === "Task", JSON.stringify(read.records?.[0]));
    const certified = await queryEntityRecords(base44, { id: caller.id }, { project_id: projA.id, entity: "Task" });
    expect("4b. the REST read equals the certified read path byte-for-byte", JSON.stringify(read.records) === JSON.stringify(certified.records), "delegated, not forked");
    const filtered = await handlePublicAppDataGet(base44, { method: "GET", authorization: `Bearer ${rawAll}`, app_id: projA.id, entity_name: "Task", filter: { title: "first task" } });
    expect("4c. the existing filter behavior is preserved", filtered.count === 1, String(filtered.count));
    expect("4d. an unknown entity is refused by the certified path", (await attempt(handlePublicAppDataGet, base44, { method: "GET", authorization: `Bearer ${rawAll}`, app_id: projA.id, entity_name: "Nope" })).code === "ENTITY_NOT_FOUND", "");

    // --- 5. scope semantics -------------------------------------------------------
    expect("5a. one-app token reads its own app", (await attempt(handlePublicAppDataGet, base44, { method: "GET", authorization: `Bearer ${rawProj}`, app_id: projA.id, entity_name: "Task" })).ok === true, "");
    expect("5b. one-app token refused on another app", (await attempt(handlePublicAppDataGet, base44, { method: "GET", authorization: `Bearer ${rawProj}`, app_id: projB.id, entity_name: "Note" })).code === "PAT_SCOPE_MISMATCH", "");
    expect("5c. all-apps token reads another app of the same account", (await attempt(handlePublicAppDataGet, base44, { method: "GET", authorization: `Bearer ${rawAll}`, app_id: projB.id, entity_name: "Note" })).ok === true, "");
    expect("5d. all-apps token cannot cross the account boundary", (await attempt(handlePublicAppDataGet, base44, { method: "GET", authorization: `Bearer ${rawAll}`, app_id: projC.id, entity_name: "Note" })).status === 403, "");

    // --- 6. read-only vs full access (GET-only surface) ---------------------------
    expect("6a. a read-only token reads on the GET surface", (await attempt(handlePublicAppDataGet, base44, { method: "GET", authorization: `Bearer ${rawProj}`, app_id: projA.id, entity_name: "Task" })).ok === true, "");
    expect("6b. POST is refused regardless of scope or full_access", (await attempt(handlePublicAppDataGet, base44, { method: "POST", authorization: `Bearer ${rawAll}`, app_id: projA.id, entity_name: "Task" })).code === "METHOD_NOT_ALLOWED", "");

    // --- 7. revocation + expiry ---------------------------------------------------
    await revokePersonalAccessToken(svc, { workspace_id: ws.id, token_id: patProj.record.id, revoked_by: caller.id });
    expect("7a. a revoked token is refused", (await attempt(authenticatePersonalAccessToken, svc, `Bearer ${rawProj}`)).code === "PAT_REVOKED", "");
    const again = await revokePersonalAccessToken(svc, { workspace_id: ws.id, token_id: patProj.record.id, revoked_by: caller.id });
    expect("7b. revocation is idempotent", again.already_revoked === true, "");
    const patExp = await svc.entities.PersonalAccessToken.create({ workspace_id: ws.id, name: "expired", token_hash: await (await import("../../shared/secretCrypto.ts")).sha256Hex(rawProj), token_prefix: rawProj.slice(0, 12), app_scope: "all", full_access: false, status: "active", expires_at: new Date(Date.now() - 1000).toISOString(), created_by: caller.id, created_at: new Date().toISOString() });
    cleanup.push(() => svc.entities.PersonalAccessToken.delete(patExp.id));
    expect("7c. an expired token is refused", (await attempt(authenticatePersonalAccessToken, svc, `Bearer ${rawProj}`)).code === "PAT_EXPIRED", "");

    // --- 8. management authorization (secret.manage = owner/admin only) -----------
    expect("8a. owner holds secret.manage", capabilitiesFor("owner").includes("secret.manage"), "");
    expect("8b. admin holds secret.manage", capabilitiesFor("admin").includes("secret.manage"), "");
    expect("8c. editor does not hold secret.manage", !capabilitiesFor("editor").includes("secret.manage"), "");
    await denied("8d. a revoked lifecycle workspace refuses issuance", async () => {
      await svc.entities.Workspace.update(ws.id, { status: "suspended" });
      try { await issuePersonalAccessToken(svc, { workspace_id: ws.id, name: "x", app_scope: "all", created_by: caller.id }); }
      finally { await svc.entities.Workspace.update(ws.id, { status: "active" }); }
    }, "WORKSPACE_INACTIVE");

    // --- 9. audit -----------------------------------------------------------------
    const audits = await svc.entities.AuditLog.filter({ workspace_id: ws.id }, "-created_date", 20);
    const actions = audits.map((a) => a.action);
    expect("9a. issuance is audited", actions.includes("pat.issued"), actions.join(","));
    expect("9b. revocation is audited", actions.includes("pat.revoked"), "");
    expect("9c. a scope-mismatch read is audited", actions.includes("pat.access_denied"), "");
    expect("9d. no audit row carries the raw token", !JSON.stringify(audits).includes(rawAll) && !JSON.stringify(audits).includes(rawProj), "clean");

    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } catch (e) {
    bad("harness", `${e.name}: ${e.message}`);
    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }
}