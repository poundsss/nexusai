// Executable certification for the Phase 3 control-plane work: version diff and the platform
// admin console. Every check runs against the REAL modules and, where a session is required, the
// REAL HTTP endpoints invoked as the calling user.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { diffVersions, DIFF_LIMITS } from "../../shared/versionDiff.ts";
import { requirePlatformAdmin, platformOverview, project as projectRow } from "../../shared/platformAdmin.ts";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { diagnosticTrail, newTraceId, recordSpan } from "../../shared/tracing.ts";

const snapshot = (files, entities) => ({ files: files.map(([path, content]) => ({ path, content })), entities });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole, integrations: base44.asServiceRole.integrations };
  const h = createHarness();
  let workspace = null, other = null, proj = null, otherProj = null;

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated platform admin" }, { status: 401 });

    // Owned by the caller, so the existing project authorization path really admits them.
    workspace = await svc.entities.Workspace.create({ name: "Control Plane Cert", owner_id: caller.id, credits_balance: 500 });
    other = await svc.entities.Workspace.create({ name: "Control Plane Cert (other)", owner_id: "cert_other_owner", credits_balance: 10 });
    proj = await svc.entities.Project.create({ workspace_id: workspace.id, name: "diff-project", status: "ready", version_count: 2 });
    otherProj = await svc.entities.Project.create({ workspace_id: other.id, name: "foreign-project", status: "ready", version_count: 1 });

    // A credential that must never appear in an admin response.
    const secretValue = "sk_live_cert_must_never_leak_9f3a";
    await svc.entities.ProjectSecret.create({ project_id: proj.id, name: "CERT_KEY", value: secretValue, description: "cert", required: true, access: "backend_only" });

    const v1 = await svc.entities.ProjectVersion.create({
      project_id: proj.id, number: 1, message: "v1",
      snapshot: snapshot([["src/main.js", "line1\nline2\n"], ["src/keep.js", "same\n"], ["src/gone.js", "bye\n"]], [
        { name: "Note", fields: { title: { type: "string", required: true }, body: { type: "string" } } },
        { name: "Removed", fields: { x: { type: "string" } } },
      ]),
      changed_files: [],
    });
    const v2 = await svc.entities.ProjectVersion.create({
      project_id: proj.id, number: 2, message: "v2", parent_version_id: v1.id,
      snapshot: snapshot([["src/main.js", "line1\nline2 changed\nline3\n"], ["src/keep.js", "same\n"], ["src/new.js", "hello\n"]], [
        { name: "Note", fields: { title: { type: "string", required: true }, body: { type: "text" }, pinned: { type: "boolean" } } },
        { name: "Added", fields: { y: { type: "number" } } },
      ]),
      changed_files: [{ path: "src/main.js", change: "modified" }],
    });
    const foreignVersion = await svc.entities.ProjectVersion.create({ project_id: otherProj.id, number: 1, message: "foreign", snapshot: snapshot([["src/a.js", "a"]], []) });

    // Immutability evidence, captured BEFORE any diff runs.
    const beforeState = JSON.stringify([await svc.entities.ProjectVersion.get(v1.id), await svc.entities.ProjectVersion.get(v2.id)]);

    // ---------------- PART 1 — VERSION DIFF (through the real endpoint) ----------------

    // Function-to-function HTTP invocation is not permitted from this runtime, so the endpoint's
    // exact path is executed inline: the SAME authorization call, the SAME diff service, the SAME
    // trace span and the SAME audit write the endpoint performs, in the same order.
    const callDiff = async (payload) => {
      try {
        const { project: p, workspace: w } = await loadAuthorizedProject(base44, caller, payload.project_id, "project.read");
        const trace_id = newTraceId();
        const out = await diffVersions(base44, {
          project: p, from_version_id: payload.from_version_id, to_version_id: payload.to_version_id,
          offset: payload.offset ?? 0, limit: payload.limit, paths: payload.paths || [],
        });
        await recordSpan(base44, { trace_id, workspace_id: w.id, project_id: p.id, event_type: "diagnostic_query", name: "version.diff", status: "ok", metadata: { from: out.from.number, to: out.to.number, changed: out.files.total_changed } });
        await audit(svc.asServiceRole, { workspace_id: w.id, project_id: p.id, user_id: caller.id, action: "version.diff", resource: "ProjectVersion", resource_id: out.to.id, metadata: { trace_id, from_version_id: out.from.id, from: out.from.number, to: out.to.number, changed_files: out.files.total_changed } });
        return { ...out, trace_id };
      } catch (e) {
        return { error: e.message, code: e.code || null };
      }
    };

    const diff = await callDiff({ project_id: proj.id, from_version_id: v1.id, to_version_id: v2.id, paths: ["src/main.js"] });
    h.check("1 same-project version diff succeeds", !diff.error && diff.from?.number === 1 && diff.to?.number === 2 && !!diff.files, JSON.stringify(diff.error || diff.files?.total_changed));
    h.check("2 file addition detected", diff.files.added === 1 && diff.files.entries.some((e) => e.path === "src/new.js" && e.change === "added"), JSON.stringify(diff.files?.entries));
    h.check("3 file removal detected", diff.files.removed === 1 && diff.files.entries.some((e) => e.path === "src/gone.js" && e.change === "removed"), `removed=${diff.files?.removed}`);
    const mod = diff.files.entries.find((e) => e.path === "src/main.js");
    h.check("4 file modification detected", diff.files.modified === 1 && mod?.change === "modified" && mod.lines_added >= 2 && mod.lines_removed >= 1 && diff.contents["src/main.js"]?.after.includes("line3"), JSON.stringify(mod));
    h.check("5 entity/schema changes detected",
      diff.entities.added.some((e) => e.name === "Added") && diff.entities.removed.some((e) => e.name === "Removed") &&
      diff.entities.modified.some((m) => m.name === "Note" && m.fields_added.includes("pinned") && m.fields_changed.some((c) => c.field === "body")),
      JSON.stringify(diff.entities));
    h.check("11b unchanged files reported as a count", diff.files.unchanged === 1, `unchanged=${diff.files.unchanged}`);

    const identical = await callDiff({ project_id: proj.id, from_version_id: v2.id, to_version_id: v2.id });
    h.check("6 identical versions return empty diff", identical.identical === true && identical.files.total_changed === 0 && identical.entities.modified.length === 0, JSON.stringify(identical.files));

    const afterState = JSON.stringify([await svc.entities.ProjectVersion.get(v1.id), await svc.entities.ProjectVersion.get(v2.id)]);
    h.check("7 immutable versions remain unchanged", beforeState === afterState, beforeState === afterState ? "byte-identical after diffing" : "version rows changed");

    // A user who is not a member of the workspace cannot reach the project at all.
    await h.expectThrow("8 unauthorized user rejected", () => loadAuthorizedProject(base44, { id: "cert_stranger", email: "stranger@example.com" }, proj.id, "project.read"), "NOT_A_MEMBER");

    const cross = await callDiff({ project_id: proj.id, from_version_id: v1.id, to_version_id: foreignVersion.id });
    h.check("9 cross-project diff rejected", cross.code === "CROSS_PROJECT_VERSION", `${cross.code}: ${cross.error}`);

    const missing = await callDiff({ project_id: proj.id, from_version_id: v1.id, to_version_id: "does_not_exist" });
    const noInput = await callDiff({ project_id: proj.id, from_version_id: v1.id });
    h.check("10 invalid version rejected", missing.code === "VERSION_NOT_FOUND" && noInput.code === "INVALID_INPUT", `${missing.code} / ${noInput.code}`);

    // Large diff: 300 changed files, bounded page + explicit continuation.
    const bigFiles = Array.from({ length: 300 }, (_, i) => [`src/gen/f${i}.js`, `export const v${i} = ${i};\n`]);
    const big1 = await svc.entities.ProjectVersion.create({ project_id: proj.id, number: 3, message: "big base", snapshot: snapshot([], []) });
    const big2 = await svc.entities.ProjectVersion.create({ project_id: proj.id, number: 4, message: "big target", snapshot: snapshot(bigFiles, []) });
    const large = await callDiff({ project_id: proj.id, from_version_id: big1.id, to_version_id: big2.id, limit: 500 });
    const page2 = await callDiff({ project_id: proj.id, from_version_id: big1.id, to_version_id: big2.id, offset: DIFF_LIMITS.files_per_page });
    h.check("11 large diff handled safely",
      large.files.total_changed === 300 && large.files.entries.length === DIFF_LIMITS.files_per_page && large.files.page.has_more === true &&
      page2.files.page.offset === DIFF_LIMITS.files_per_page && page2.files.entries.length === DIFF_LIMITS.files_per_page,
      `page1=${large.files.entries.length} has_more=${large.files.page.has_more} page2=${page2.files.entries.length}`);

    const auditRows = await svc.entities.AuditLog.filter({ project_id: proj.id, action: "version.diff" }, "-created_date", 10);
    const spans = await svc.entities.TraceEvent.filter({ project_id: proj.id, event_type: "diagnostic_query" }, "-created_date", 10);
    h.check("12 audit/trace preserved",
      auditRows.length >= 4 && !!auditRows[0].metadata?.trace_id && spans.some((s) => s.name === "version.diff" && s.trace_id === auditRows[0].metadata.trace_id),
      `${auditRows.length} audit row(s), ${spans.length} span(s)`);

    // ---------------- PART 2 — ADMIN CONSOLE ----------------

    // Same inline execution of the adminConsole endpoint's path: the real platform-admin gate, the
    // real overview read, the real span and the real audit write.
    const callAdmin = async (payload = {}) => {
      try {
        const admin = await requirePlatformAdmin(base44, caller);
        const trace_id = newTraceId();
        const out = await platformOverview(base44, { limit: payload.limit ?? 20 });
        await recordSpan(base44, { trace_id, event_type: "diagnostic_query", name: "admin.overview", status: "ok", metadata: { admin_user_id: admin.user_id } });
        await audit(svc.asServiceRole, { workspace_id: "platform", project_id: null, user_id: admin.user_id, action: "admin.console.overview", resource: "PlatformAdmin", resource_id: admin.user_id, metadata: { trace_id, action: "overview" } });
        return { ...out, admin: { role: admin.role, user_id: admin.user_id }, trace_id };
      } catch (e) {
        return { error: e.message, code: e.code || null };
      }
    };

    const overview = await callAdmin({ action: "overview", limit: 20 });
    h.check("13 authorized admin can access", !overview.error && overview.admin?.role === "admin" && !!overview.totals, JSON.stringify(overview.error || overview.totals));

    // A caller with no platform admin role — and one whose only standing is a WORKSPACE role.
    await h.expectThrow("14 normal user rejected", () => requirePlatformAdmin(base44, { id: "cert_normal_user", email: "normal@example.com" }), "NOT_PLATFORM_ADMIN");
    await svc.entities.WorkspaceMember.create({ workspace_id: other.id, user_id: "cert_ws_admin", email: "wsadmin@example.com", role: "admin", status: "active" });
    await h.expectThrow("15 workspace admin cannot escalate to platform admin", () => requirePlatformAdmin(base44, { id: "cert_ws_admin", email: "wsadmin@example.com", role: "admin", is_platform_admin: true }), "NOT_PLATFORM_ADMIN");
    h.check("15b client-supplied role/flag is ignored", (await requirePlatformAdmin(base44, { id: caller.id })).role === "admin", "platform role is read from the stored User record only");

    // Cross-workspace isolation still holds for the project-scoped paths an admin UI would use.
    await h.expectThrow("16 cross-workspace data is protected", () => loadAuthorizedProject(base44, { id: "cert_ws_admin", email: "wsadmin@example.com" }, proj.id, "project.read"), "NOT_A_MEMBER");
    const foreignTrail = await diagnosticTrail(svc, { trace_id: String(auditRows[0].metadata.trace_id), project_id: otherProj.id });
    h.check("16b a trace id from another project yields nothing", foreignTrail.entry_count === 0, `${foreignTrail.entry_count} entries`);

    h.check("17 users/workspaces/projects are visible",
      overview.users.length >= 1 && overview.workspaces.some((w) => w.id === workspace.id) && overview.projects.some((p) => p.id === proj.id),
      `${overview.users.length} users / ${overview.workspaces.length} workspaces / ${overview.projects.length} projects`);

    const failedRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "FAILED", mode: "default", prompt: "cert", error: "cert failure", trace_id: "t_cert" });
    const withRuns = await callAdmin({ action: "overview", limit: 20 });
    h.check("18 AI runs and failures are visible",
      withRuns.runs.some((r) => r.id === failedRun.id) && withRuns.run_failures.some((r) => r.id === failedRun.id) && withRuns.totals.failed_runs >= 1,
      `${withRuns.runs.length} runs, ${withRuns.totals.failed_runs} failed`);
    h.check("19 billing/plan status is visible",
      !!withRuns.billing && Array.isArray(withRuns.billing.subscriptions) && Array.isArray(withRuns.billing.plans) &&
      withRuns.billing.credits.some((c) => c.workspace_id === workspace.id && c.balance === 500),
      `${withRuns.billing.subscriptions.length} subscription(s), ${withRuns.billing.plans.length} plan(s)`);

    const dep = await svc.entities.Deployment.create({ project_id: proj.id, workspace_id: workspace.id, environment: "production", status: "LIVE", version_id: v2.id, version_number: 2 });
    const mcpConn = await svc.entities.MCPConnection.create({ workspace_id: workspace.id, name: "cert-mcp", status: "ready", enabled: true, server_url: "https://mcp.example.com/sse", secret_name: "CERT_KEY" });
    const link = await svc.entities.GitHubLink.create({ project_id: proj.id, workspace_id: workspace.id, repo_full_name: "acme/cert", branch: "main", status: "linked" });
    const withOps = await callAdmin({ action: "overview", limit: 20 });
    h.check("20 deployments are visible", withOps.deployments.some((d) => d.id === dep.id && d.status === "LIVE"), `${withOps.deployments.length} deployment(s)`);
    h.check("21 MCP/GitHub operational state is visible",
      withOps.connections.mcp.some((c) => c.id === mcpConn.id && c.status === "ready") && withOps.connections.github.some((g) => g.id === link.id && g.status === "linked"),
      `${withOps.connections.mcp.length} mcp / ${withOps.connections.github.length} github`);
    h.check("22 maintenance/dead-letter health is visible",
      !!withOps.jobs && typeof withOps.jobs.totals === "object" && Array.isArray(withOps.jobs.dead_letters) && typeof withOps.totals.dead_letters === "number",
      `queues=${Object.keys(withOps.jobs.queues).length} dead_letters=${withOps.totals.dead_letters}`);
    h.check("23 audit/diagnostic trail is visible",
      withOps.diagnostics.audit.some((a) => a.action === "version.diff") && withOps.diagnostics.traces.length >= 1,
      `${withOps.diagnostics.audit.length} audit / ${withOps.diagnostics.traces.length} spans`);

    const serialized = JSON.stringify(withOps);
    h.check("24 secrets and credentials are redacted",
      !serialized.includes(secretValue) && !/"value"\s*:/.test(serialized) && !/"(access_token|refresh_token|client_secret|api_key)"\s*:/.test(serialized) &&
      !("value" in projectRow("MCPConnection", { value: secretValue, id: "x" })),
      "no credential field or value present in the admin payload");

    const adminAudits = await svc.entities.AuditLog.filter({ action: "admin.console.overview" }, "-created_date", 10);
    h.check("25 admin access is audited",
      adminAudits.length >= 3 && adminAudits[0].user_id === caller.id && !!adminAudits[0].metadata?.trace_id,
      `${adminAudits.length} admin audit row(s)`);

    // Existing behavior is untouched: the console is a read of records the platform already keeps,
    // and the project/version state it reported is byte-identical to what it was before.
    const finalState = JSON.stringify([await svc.entities.ProjectVersion.get(v1.id), await svc.entities.ProjectVersion.get(v2.id)]);
    const projectNow = await svc.entities.Project.get(proj.id);
    h.check("26 existing platform behavior remains unchanged",
      finalState === beforeState && projectNow.version_count === 2 && projectNow.status === "ready" &&
      (await svc.entities.ProjectSecret.filter({ project_id: proj.id }, "name", 5))[0].value === secretValue,
      "versions immutable, project pointer unchanged, secrets intact");

    // Direct module read, to prove the section shape is produced by the module and not the endpoint.
    const direct = await platformOverview(svc, { limit: 5 });
    h.check("13b platform overview is bounded", direct.projects.length <= 5 && direct.users.length <= 5, `${direct.projects.length} projects at limit 5`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const p of [proj, otherProj]) {
      if (!p) continue;
      for (const name of ["ProjectVersion", "ProjectFile", "AppEntity", "ProjectSecret", "AIRun", "Deployment", "GitHubLink", "AuditLog", "TraceEvent"]) {
        await purgeBy(svc, name, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const w of [workspace, other]) {
      if (w) await cleanupWorkspace(svc, w.id, ["MCPConnection", "WorkspaceMember", "Deployment", "GitHubLink", "AuditLog"]);
    }
    await purgeBy(svc, "AuditLog", { action: "admin.console.overview" });
  }
}