// Certification for #37 — MCP Server completion.
//
// Runs the REAL MCP server paths. Two execution modes, both production:
//   • through the tool WRAPPER (shared/platformApi.mcpTool) with a synthesized request that carries
//     the caller's own credentials — this certifies authentication, the audit write and the
//     structured error envelope exactly as an MCP client experiences them;
//   • through the shared SERVICE functions with a second identity (a real WorkspaceMember row) —
//     this certifies read/write separation and isolation, because the refusal comes from the
//     production capability matrix rather than from a test assertion.
//
// Nothing is mocked. Integration calls really execute through the #31 authorized path (against an
// unroutable host), so quota, breaker and rate-limit state are the ones that layer produced.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { memStore } from "../../shared/memStoreCert.ts";
import { mcpCreateProjectHandler } from "../../shared/mcpCreateProject.ts";
import { discardWorkspaceProjects, caught } from "../../shared/testSupport.ts";
import { mcpTool, listProjects, getProject, getProjectContext, listProjectFiles, readProjectFile, getProjectVersions, getBuildStatus } from "../../shared/platformApi.ts";
import {
  writeProjectFile, listEntitySchemas, getEntitySchema, queryEntityRecords, mutateEntityRecord,
  startProjectBuild, getBuildResult, inspectProjectVersion,
  listIntegrations, getIntegration, testIntegrationCall,
  mcpListWorkflows, mcpGetWorkflow, mcpGetWorkflowRun,
} from "../../shared/mcpServerTools.ts";
import { restoreProjectVersion } from "../../shared/versionRestore.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { createFs, writeFile } from "../../shared/projectFs.ts";
import { commitFiles, createVersion } from "../../shared/persistence.ts";
import { scaffoldFiles } from "../../shared/scaffold.ts";
import { makeInlineIntegrationApi } from "../../shared/integrationApiHelpers.ts";
import { createWorkflow } from "../../shared/workflowApi.ts";

const PAGE = (label) => `import { html } from 'runtime';\n\nexport default function Extra() {\n  return html\`<main>${label}</main>\`;\n}\n`;
const SENTINEL = "sk_live_MCP_SENTINEL_do_not_leak";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  // Every payload an MCP client would ever receive, scanned once at the end for credentials.
  const seen = [];
  const record = (label, value) => { seen.push({ label, value }); return value; };

  let workspace = null, otherWs = null, project = null, foreignProject = null;
  const stamp = Date.now();
  const viewer = { id: `u_mcp_viewer_${stamp}`, email: `mcp.viewer.${stamp}@example.com` };
  const outsider = { id: `u_mcp_out_${stamp}`, email: `mcp.outsider.${stamp}@example.com` };
  const cleanupMembers = [];

  // The tool wrapper, invoked exactly as the MCP transport invokes it: a POST carrying this
  // request's own credentials. `authed: false` drops them, which is the unauthenticated case.
  const callTool = async (tool, handler, payload, { authed = true } = {}) => {
    // The request is a copy of THIS one: same URL and same platform routing headers, so the tool
    // resolves the same app context an MCP client's request would. Only the CALLER's credentials
    // are dropped for the unauthenticated case — that is the single variable under test.
    const headers = new Headers();
    for (const [k, v] of req.headers.entries()) {
      if (/^content-length$/i.test(k)) continue;
      if (!authed && /^(authorization|cookie|x-base44-token|base44-token)$/i.test(k)) continue;
      headers.set(k, v);
    }
    headers.set("content-type", "application/json");
    const synthetic = new Request(req.url, { method: "POST", headers, body: JSON.stringify(payload || {}) });
    const res = await mcpTool(synthetic, tool, handler);
    return { status: res.status, body: await res.json() };
  };

  try {
    const owner = await base44.auth.me().catch(() => null);
    if (!owner) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `MCP ${stamp}`, owner_id: owner.id, credits_balance: 0, status: "active" });
    otherWs = await svc.entities.Workspace.create({ name: `MCP Foreign ${stamp}`, owner_id: `owner_other_${stamp}`, credits_balance: 0, status: "active" });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `MCP Project ${stamp}`, framework: "preact-htm" });
    foreignProject = await svc.entities.Project.create({ workspace_id: otherWs.id, name: `MCP Foreign Project ${stamp}` });

    const fs0 = createFs([]);
    for (const f of scaffoldFiles("McpProject")) writeFile(fs0, f.path, f.content);
    const seeded = await commitFiles(svc, project.id, fs0);
    await createVersion(svc, { project, fs: fs0, entities: [], secrets: [], message: "seed", changedFiles: seeded });
    project = await svc.entities.Project.get(project.id);
    const v1 = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 1))[0];

    // A viewer and a complete outsider — both are ordinary stored rows, so every refusal below is
    // the production authorization layer's, resolved server-side from those rows.
    for (const [u, role] of [[viewer, "viewer"]]) {
      const row = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: u.email, user_id: u.id, role, status: "active", accepted_at: new Date().toISOString() });
      cleanupMembers.push(row.id);
    }
    const currentVersion = async () => (await svc.entities.Project.get(project.id)).version_count;

    // ================= 1. Authentication =================
    const authed = await callTool("list_projects", ({ base44: b, user }) => listProjects(b, user), {});
    h.check("1a. a valid MCP credential reaches the tool", authed.status === 200 && Array.isArray(authed.body.projects), `${authed.status}`);
    const anon = await callTool("list_projects", ({ base44: b, user }) => listProjects(b, user), {}, { authed: false });
    h.check("1b. a request without credentials is refused with 401 UNAUTHENTICATED", anon.status === 401 && anon.body.error?.code === "UNAUTHENTICATED", `${anon.status} ${anon.body.error?.code}`);
    h.check("1c. an unauthenticated refusal carries no project data", !JSON.stringify(anon.body).includes("project_id"), JSON.stringify(anon.body).slice(0, 120));

    // ================= 2. Project tools + isolation =================
    const got = record("get_project", await callTool("get_project", ({ base44: b, user, body }) => getProject(b, user, body.project_id), { project_id: project.id }));
    h.check("2a. get_project returns the project through the wrapper", got.body.project?.project_id === project.id, JSON.stringify(got.body.project));
    const ctx = record("context", await getProjectContext(base44, owner, project.id));
    h.check("2b. context reports files, entities and secret metadata", Array.isArray(ctx.files) && ctx.files.length > 0 && Array.isArray(ctx.secrets), `${ctx.files.length} file(s)`);
    const listed = record("list_projects", await listProjects(base44, owner));
    h.check("2c. list_projects includes this workspace's project", listed.projects.some((p) => p.project_id === project.id), `${listed.projects.length} project(s)`);
    h.check("2d. list_projects never includes another account's workspace", !listed.projects.some((p) => p.project_id === foreignProject.id), "foreign absent");
    const foreignGet = await callTool("get_project", ({ base44: b, user, body }) => getProject(b, user, body.project_id), { project_id: foreignProject.id });
    h.check("2e. another account's project is refused, not returned", foreignGet.status === 403 && ["FORBIDDEN", "NOT_A_MEMBER"].includes(foreignGet.body.error?.code), `${foreignGet.status} ${foreignGet.body.error?.code}`);
    const outsiderRead = await caught(() => getProject(base44, outsider, project.id));
    h.check("2f. a non-member cannot read this project", outsiderRead?.code === "NOT_A_MEMBER", `${outsiderRead?.code}`);

    // ================= 3. Files: list / read / write =================
    const files = record("list_files", await listProjectFiles(base44, owner, project.id, {}));
    h.check("3a. files are listed with paths only by default", files.content_included === false && files.files.length > 0, `${files.files.length} file(s)`);
    const read = record("read_file", await readProjectFile(base44, owner, project.id, "src/App.js"));
    h.check("3b. one file's content is readable by exact path", typeof read.content === "string" && read.content.length > 0, `${read.size} chars`);
    const missing = await caught(() => readProjectFile(base44, owner, project.id, "does/not/exist.js"));
    h.check("3c. a missing file is a structured FILE_NOT_FOUND", missing?.code === "FILE_NOT_FOUND" && missing?.status === 404, `${missing?.code}`);

    const beforeWrite = await currentVersion();
    const written = record("write_file", await callTool("write_project_file", ({ base44: b, user, body }) => writeProjectFile(b, user, body), { project_id: project.id, path: "src/pages/Extra.js", content: PAGE("mcp write"), expected_version: beforeWrite }));
    h.check("3d. an authorized write commits exactly one new version", written.status === 200 && written.body.version === beforeWrite + 1, JSON.stringify(written.body));
    h.check("3e. the written content is really persisted", (await readProjectFile(base44, owner, project.id, "src/pages/Extra.js")).content.includes("mcp write"), "persisted");
    const stale = await callTool("write_project_file", ({ base44: b, user, body }) => writeProjectFile(b, user, body), { project_id: project.id, path: "src/pages/Extra.js", content: PAGE("stale"), expected_version: beforeWrite });
    h.check("3f. a write against a superseded version is refused with VERSION_CONFLICT", stale.status === 409 && stale.body.error?.code === "VERSION_CONFLICT", `${stale.status} ${stale.body.error?.code}`);
    h.check("3g. the refused stale write changed nothing", (await readProjectFile(base44, owner, project.id, "src/pages/Extra.js")).content.includes("mcp write"), "unchanged");
    const viewerWrite = await caught(() => writeProjectFile(base44, viewer, { project_id: project.id, path: "src/pages/Extra.js", content: PAGE("viewer") }));
    h.check("3h. a viewer cannot write a file", viewerWrite?.code === "INSUFFICIENT_ROLE" && viewerWrite?.status === 403, `${viewerWrite?.code}`);
    const outsiderWrite = await caught(() => writeProjectFile(base44, outsider, { project_id: project.id, path: "src/pages/Extra.js", content: PAGE("outsider") }));
    h.check("3i. a non-member cannot write a file", outsiderWrite?.code === "NOT_A_MEMBER", `${outsiderWrite?.code}`);
    const broken = await caught(() => writeProjectFile(base44, owner, { project_id: project.id, path: "src/pages/Extra.js", content: "export default function( {\n" }));
    h.check("3j. a write that does not build is refused and changes nothing", broken?.code === "BUILD_FAILED" && (await currentVersion()) === beforeWrite + 1, `${broken?.code}`);

    // ================= 4. Entities: schema + records =================
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Task", fields: { title: { type: "string", required: true }, done: { type: "boolean" } } });
    const schemas = record("list_schemas", await listEntitySchemas(base44, owner, { project_id: project.id }));
    h.check("4a. entity schemas are listed", schemas.entities.some((e) => e.entity === "Task"), JSON.stringify(schemas.entities.map((e) => e.entity)));
    const schema = record("get_schema", await getEntitySchema(base44, owner, { project_id: project.id, entity: "Task" }));
    h.check("4b. one entity's fields are returned", !!schema.fields.title && schema.fields.title.required === true, JSON.stringify(schema.fields));
    const unknownSchema = await caught(() => getEntitySchema(base44, owner, { project_id: project.id, entity: "Nope" }));
    h.check("4c. an undeclared entity is a structured ENTITY_NOT_FOUND", unknownSchema?.code === "ENTITY_NOT_FOUND", `${unknownSchema?.code}`);

    const created = record("create_record", await callTool("mutate_entity_record", ({ base44: b, user, body }) => mutateEntityRecord(b, user, body), { project_id: project.id, entity: "Task", operation: "create", data: { title: "first task", done: false } }));
    h.check("4d. a record can be created", created.status === 200 && !!created.body.record_id, JSON.stringify(created.body.record));
    const queried = record("query_records", await queryEntityRecords(base44, owner, { project_id: project.id, entity: "Task" }));
    h.check("4e. records are readable and bounded", queried.count === 1 && queried.limit <= 100, JSON.stringify({ count: queried.count, limit: queried.limit }));
    const filtered = await queryEntityRecords(base44, owner, { project_id: project.id, entity: "Task", filter: { title: "first task" } });
    h.check("4f. a field filter is applied server-side", filtered.count === 1, `${filtered.count} match(es)`);
    const updated = await mutateEntityRecord(base44, owner, { project_id: project.id, entity: "Task", operation: "update", record_id: created.body.record_id, data: { done: true } });
    h.check("4g. a record can be updated", updated.record?.done === true, JSON.stringify(updated.record));
    const invalid = await caught(() => mutateEntityRecord(base44, owner, { project_id: project.id, entity: "Task", operation: "create", data: { nope: 1 } }));
    h.check("4h. a record that violates the schema is refused", invalid?.code === "DATABASE_VALIDATION_FAILED", `${invalid?.code}`);
    const idemKey = `idem_${crypto.randomUUID()}`;
    const once1 = await mutateEntityRecord(base44, owner, { project_id: project.id, entity: "Task", operation: "create", data: { title: "idempotent" }, idempotency_key: idemKey });
    const once2 = await mutateEntityRecord(base44, owner, { project_id: project.id, entity: "Task", operation: "create", data: { title: "idempotent" }, idempotency_key: idemKey });
    const afterIdem = await queryEntityRecords(base44, owner, { project_id: project.id, entity: "Task", filter: { title: "idempotent" } });
    h.check("4i. a retried mutation replays instead of writing twice", once2.record_id === once1.record_id && afterIdem.count === 1, JSON.stringify({ first: once1.record_id, retry: once2.record_id, rows: afterIdem.count }));
    const viewerMutate = await caught(() => mutateEntityRecord(base44, viewer, { project_id: project.id, entity: "Task", operation: "create", data: { title: "viewer" } }));
    h.check("4j. a viewer cannot mutate records", viewerMutate?.code === "INSUFFICIENT_ROLE", `${viewerMutate?.code}`);
    const crossEntity = await caught(() => queryEntityRecords(base44, owner, { project_id: foreignProject.id, entity: "Task" }));
    h.check("4k. records cannot be read through another account's project", ["NOT_A_MEMBER", "FORBIDDEN"].includes(crossEntity?.code), `${crossEntity?.code}`);
    const deleted = await mutateEntityRecord(base44, owner, { project_id: project.id, entity: "Task", operation: "delete", record_id: created.body.record_id });
    h.check("4l. a record can be deleted", deleted.deleted === true && (await queryEntityRecords(base44, owner, { project_id: project.id, entity: "Task" })).count === 1, JSON.stringify(deleted));

    // ================= 5. Build =================
    const build = record("start_build", await callTool("start_project_build", ({ base44: b, user, body }) => startProjectBuild(b, user, body), { project_id: project.id }));
    h.check("5a. a build can be started and reports a verdict", build.status === 200 && build.body.status === "success", JSON.stringify({ status: build.body.status, errors: build.body.error_count }));
    const buildStatus = record("build_status", await getBuildStatus(base44, owner, project.id));
    h.check("5b. the latest build status is readable", buildStatus.build?.build_id === build.body.build_id, `${buildStatus.build?.status}`);
    const buildResult = record("build_result", await getBuildResult(base44, owner, { build_id: build.body.build_id }));
    h.check("5c. one build's structured result is readable by id", buildResult.build.build_id === build.body.build_id && Array.isArray(buildResult.logs), `${buildResult.build.file_count} file(s)`);
    const foreignBuild = await svc.entities.Build.create({ project_id: foreignProject.id, status: "success", error_count: 0, file_count: 1 });
    const crossBuild = await caught(() => getBuildResult(base44, owner, { build_id: foreignBuild.id }));
    h.check("5d. another account's build is refused", ["NOT_A_MEMBER", "FORBIDDEN"].includes(crossBuild?.code), `${crossBuild?.code}`);
    const viewerBuild = await caught(() => startProjectBuild(base44, viewer, { project_id: project.id }));
    h.check("5e. a viewer cannot start a build", viewerBuild?.code === "INSUFFICIENT_ROLE", `${viewerBuild?.code}`);

    // ================= 6. Versions =================
    const versions = record("versions", await getProjectVersions(base44, owner, project.id));
    h.check("6a. version history is listed newest first", versions.versions.length >= 2 && versions.versions[0].number > versions.versions[1].number, `${versions.versions.length} version(s)`);
    const inspected = record("version_inspect", await inspectProjectVersion(base44, owner, { project_id: project.id, version_id: v1.id }));
    h.check("6b. one version's contents are inspectable", inspected.version.number === v1.number && inspected.files.length > 0, `${inspected.files.length} file(s)`);
    h.check("6c. version inspection omits file CONTENT", !JSON.stringify(inspected.files).includes("html`"), "paths and sizes only");
    const foreignVersion = await caught(() => inspectProjectVersion(base44, owner, { project_id: project.id, version_id: "does_not_exist" }));
    h.check("6d. an unknown version is a structured VERSION_NOT_FOUND", foreignVersion?.code === "VERSION_NOT_FOUND", `${foreignVersion?.code}`);

    const beforeRestore = await currentVersion();
    const staleRestore = await callTool("restore_project_version", async ({ base44: b, user, body }) => {
      const { project: p, workspace: w } = await loadAuthorizedProject(b, user, body.project_id, "version.restore");
      const out = await restoreProjectVersion(b, { project: p, workspace: w, user, versionId: body.version_id, baseVersionNumber: body.expected_version });
      return { project_id: p.id, new_version: out.version };
    }, { project_id: project.id, version_id: v1.id, expected_version: beforeRestore - 1 });
    h.check("6e. a restore from a stale expected_version is refused", staleRestore.status === 409 && staleRestore.body.error?.code === "VERSION_CONFLICT", `${staleRestore.status} ${staleRestore.body.error?.code}`);
    h.check("6f. the refused restore left the project untouched", (await currentVersion()) === beforeRestore, `still v${beforeRestore}`);
    const viewerRestore = await caught(() => loadAuthorizedProject(base44, viewer, project.id, "version.restore"));
    h.check("6g. a viewer cannot restore a version", viewerRestore?.code === "INSUFFICIENT_ROLE", `${viewerRestore?.code}`);
    const authRestore = await loadAuthorizedProject(base44, owner, project.id, "version.restore");
    const restored = record("restore", await restoreProjectVersion(base44, { project: authRestore.project, workspace: authRestore.workspace, user: owner, versionId: v1.id, baseVersionNumber: beforeRestore }));
    h.check("6h. a matching expected_version restores and creates a NEW version", restored.version === beforeRestore + 1 && restored.restored_from_version === v1.number, JSON.stringify({ v: restored.version, from: restored.restored_from_version }));
    h.check("6i. the restore really reverted the file state", (await caught(() => readProjectFile(base44, owner, project.id, "src/pages/Extra.js")))?.code === "FILE_NOT_FOUND", "file removed by rollback");

    // ================= 7. Integrations =================
    const api = makeInlineIntegrationApi(base44, svc);
    const definition = {
      // A publicly-shaped host that can never resolve, so the call is a REAL network failure.
      // A private/loopback address would be refused by the egress policy as `invalid_url` before
      // the upstream is contacted, and such a refusal is deliberately NOT a breaker failure.
      name: "probe", type: "http", description: "unroutable probe", base_url: "https://probe.unresolvable.invalid",
      auth: { type: "api_key", secret: "PROBE_API_KEY", in: "header", header_name: "X-API-Key" },
      operations: [{ name: "ping", method: "GET", path: "/ping" }],
      quota: { limit: 1, window_ms: 60000 }, retry: { max_attempts: 1 }, timeout_ms: 1000,
    };
    const madeIntegration = await api(owner, { action: "create", project_id: project.id, definition });
    h.check("7a. the probe integration is declared for this project", madeIntegration.status === 200, JSON.stringify(madeIntegration.body).slice(0, 200));
    // A real credential value, so redaction is tested against something that exists.
    const secretRow = (await svc.entities.ProjectSecret.filter({ project_id: project.id, name: "PROBE_API_KEY" }, "name", 1))[0];
    if (secretRow) await svc.entities.ProjectSecret.update(secretRow.id, { value: SENTINEL });

    const integrations = record("integrations", await listIntegrations(base44, owner, { project_id: project.id }));
    h.check("7b. integrations are listed with metadata", integrations.integrations.some((i) => i.name === "probe"), `${integrations.count} integration(s)`);
    const integration = record("integration", await getIntegration(base44, owner, { project_id: project.id, name: "probe" }));
    h.check("7c. an integration reports its operations and secret NAMES", integration.integration.secret_refs.includes("PROBE_API_KEY") && integration.integration.operations.length === 1, JSON.stringify(integration.integration.secret_refs));
    h.check("7d. integration metadata carries no credential value", !JSON.stringify(integration).includes(SENTINEL), "no value");
    const missingIntegration = await caught(() => getIntegration(base44, owner, { project_id: project.id, name: "nosuch" }));
    h.check("7e. an unknown integration is refused", !!missingIntegration, `${missingIntegration?.code || missingIntegration?.message}`);

    const call1 = record("test_call_1", await testIntegrationCall(base44, owner, { project_id: project.id, name: "probe", operation: "ping" }));
    h.check("7f. an authorized test call really executes through the integration path", call1.result?.ok === false && !!call1.result?.code, JSON.stringify(call1.result).slice(0, 200));
    h.check("7g. the executed call is correlated by the platform's own trace id", !!call1.trace_id, `${call1.trace_id}`);
    const call2 = record("test_call_2", await testIntegrationCall(base44, owner, { project_id: project.id, name: "probe", operation: "ping" }));
    const quotaRefused = call2.result?.code === "QUOTA_EXCEEDED" || call2.result?.kind === "quota_exceeded" || (call2.result?.quota && call2.result.quota.remaining === 0);
    h.check("7h. the project's integration quota refuses the call beyond its allowance", quotaRefused, JSON.stringify(call2.result).slice(0, 200));
    const quotaRow = (await svc.entities.IntegrationQuota.filter({ project_id: project.id }, "-updated_at", 5).catch(() => []))[0];
    h.check("7i. quota state is recorded per project and integration", !!quotaRow && quotaRow.integration_name === "probe", JSON.stringify({ used: quotaRow?.used, allowed: quotaRow?.allowed, status: quotaRow?.status }));
    const invocations = await svc.entities.IntegrationInvocation.filter({ project_id: project.id }, "-created_date", 10).catch(() => []);
    h.check("7j. every integration call is recorded as one logical invocation", invocations.length >= 1 && invocations.every((i) => i.integration_name === "probe"), `${invocations.length} invocation(s)`);
    h.check("7k. no invocation record carries a credential value", !JSON.stringify(invocations).includes(SENTINEL), "clean");

    // Repeated upstream failures on an unquotaed integration: the breaker and rate-limit layers are
    // the SAME ones #31 certified — this asserts the MCP path really goes through them.
    await api(owner, { action: "create", project_id: project.id, definition: { ...definition, name: "probe2", quota: { enabled: false } } });
    const breakerCalls = [];
    for (let i = 0; i < 6; i++) breakerCalls.push((await testIntegrationCall(base44, owner, { project_id: project.id, name: "probe2", operation: "ping" })).result);
    const breakerRow = (await svc.entities.IntegrationBreaker.filter({ project_id: project.id }, "-updated_at", 5).catch(() => []))[0];
    const breakerEngaged = !!breakerRow || breakerCalls.some((r) => r?.breaker || /breaker|unavailable/i.test(String(r?.code || "") + String(r?.kind || "")));
    h.check("7l. repeated upstream failures engage the circuit breaker", breakerEngaged, JSON.stringify({ breaker: breakerRow ? { state: breakerRow.state, failures: breakerRow.failure_count } : null, last: breakerCalls.at(-1) }).slice(0, 240));
    const limitRows = await svc.entities.IntegrationRateLimit.filter({ project_id: project.id }, "-updated_at", 5).catch(() => []);
    h.check("7m. rate-limit accounting is delegated to the same integration layer", limitRows.every((r) => r.project_id === project.id) && !JSON.stringify(limitRows).includes(SENTINEL), `${limitRows.length} bucket(s)`);
    h.check("7n. no failure message leaks the credential", !JSON.stringify(breakerCalls).includes(SENTINEL), "clean");

    // ================= 8. Workflows (read-only) =================
    const wf = await createWorkflow(base44, owner, {
      project_id: project.id, name: `Mcp Flow ${stamp}`, description: "read-only surface test",
      trigger: { type: "manual" }, entry_step: "noop",
      steps: [{ name: "noop", type: "primitive", primitive: "Noop" }],
    });
    const wfList = record("workflows", await mcpListWorkflows(base44, owner, { project_id: project.id, include_runs: true }));
    h.check("8a. workflow definitions are listed with their trigger and steps", wfList.workflows.some((w) => w.workflow_definition_id === wf.workflow_definition_id) && Array.isArray(wfList.runs), `${wfList.count} workflow(s)`);
    const wfGot = record("workflow", await mcpGetWorkflow(base44, owner, { workflow_definition_id: wf.workflow_definition_id }));
    h.check("8b. one workflow's definition is readable", wfGot.workflow_definition_id === wf.workflow_definition_id && Array.isArray(wfGot.runs), `${wfGot.status}`);
    const wfRowBefore = await svc.entities.WorkflowDefinition.get(wf.workflow_definition_id);
    await mcpListWorkflows(base44, owner, { project_id: project.id });
    await mcpGetWorkflow(base44, owner, { workflow_definition_id: wf.workflow_definition_id });
    const wfRowAfter = await svc.entities.WorkflowDefinition.get(wf.workflow_definition_id);
    h.check("8c. reading a workflow never changes it", wfRowAfter.status === wfRowBefore.status && wfRowAfter.updated_at === wfRowBefore.updated_at && wfRowAfter.finalized === wfRowBefore.finalized, `${wfRowAfter.status}`);
    const runMissing = await caught(() => mcpGetWorkflowRun(base44, owner, { workflow_run_id: "no_such_run" }));
    h.check("8d. an unknown workflow run is a structured refusal", runMissing?.code === "WORKFLOW_RUN_NOT_FOUND" && runMissing?.status === 404, `${runMissing?.code}`);
    const wfOutsider = await caught(() => mcpGetWorkflow(base44, outsider, { workflow_definition_id: wf.workflow_definition_id }));
    h.check("8e. a non-member cannot read this project's workflows", wfOutsider?.code === "NOT_A_MEMBER", `${wfOutsider?.code}`);
    const wfCross = await caught(() => mcpListWorkflows(base44, owner, { project_id: foreignProject.id }));
    h.check("8f. workflows cannot be listed through another account's project", ["NOT_A_MEMBER", "FORBIDDEN"].includes(wfCross?.code), `${wfCross?.code}`);
    const viewerWorkflowRead = await mcpListWorkflows(base44, viewer, { project_id: project.id });
    h.check("8g. a viewer may READ workflows (the MCP surface exposes no mutating workflow tool)", viewerWorkflowRead.count >= 1, `${viewerWorkflowRead.count} workflow(s)`);

    // ================= 9. Security posture =================
    const everything = JSON.stringify(seen);
    h.check("9a. no MCP response carries a credential value", !everything.includes(SENTINEL), "sentinel absent");
    h.check("9b. no MCP response carries an OAuth token or provider credential field", !/"(access_token|refresh_token|client_secret|encrypted_access_token|authorization)"\s*:/i.test(everything), "no token fields");
    h.check("9c. secrets are exposed as names plus is_set only", ctx.secrets.every((s) => typeof s.name === "string" && !("value" in s)), JSON.stringify(ctx.secrets.slice(0, 3)));
    const audits = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 200).catch(() => []);
    const mcpAudits = audits.filter((a) => String(a.action).startsWith("mcp."));
    h.check("9d. every MCP tool call is audited against the acting user", mcpAudits.length >= 4 && mcpAudits.every((a) => !!a.user_id), `${mcpAudits.length} audit row(s)`);
    h.check("9e. a refused MCP call is audited with its failure code", mcpAudits.some((a) => a.metadata?.ok === false && !!a.metadata?.code), JSON.stringify(mcpAudits.find((a) => a.metadata?.ok === false)?.metadata));
    h.check("9f. audit metadata records the MCP origin", mcpAudits.every((a) => a.metadata?.via === "mcp_server"), "via mcp_server");
    h.check("9g. no audit row carries a credential value", !JSON.stringify(audits).includes(SENTINEL), "clean");
    h.check("9h. every refusal is a structured code, never a raw stack trace", [stale, foreignGet, anon].every((r) => !!r.body.error?.code && !/ at .*\.ts:/.test(String(r.body.error?.message))), "structured");

    // --- 10. create_project handler, synthetic in-memory inputs (no real records) ---
    // The allowed cases stop at the existing-name branch, so they prove authorization passed
    // without exercising scaffold/version/AI-run creation (that path stays UNTESTED here).
    const WRITE_TABLES = ["Project", "ProjectFile", "ProjectVersion", "Conversation", "Message", "AIRun"];
    const runCreate = async ({ ws, user, members = [] }) => {
      const mem = memStore({ Project: [{ id: "p_seed", workspace_id: ws.id, name: "N", status: "draft", version_count: 1 }], WorkspaceMember: members });
      const before = WRITE_TABLES.map((t) => mem.t(t).length).join(",");
      const out = await mcpCreateProjectHandler({ base44: mem.svc, user, workspace: ws, body: { name: "N", prompt: "build" } }).catch((e) => e);
      return { out, unchanged: WRITE_TABLES.map((t) => mem.t(t).length).join(",") === before };
    };
    const activeWs = { id: "w_mem", owner_id: "u_owner", status: "active" };
    const member = (role) => [{ id: "m1", workspace_id: "w_mem", user_id: "u_mem", email: "m@x.test", role, status: "active" }];
    const memUser = { id: "u_mem", email: "m@x.test" };
    const c1 = await runCreate({ ws: activeWs, user: { id: "u_owner", email: "o@x.test" } });
    h.check("10a. create_project: owner allowed, no writes", c1.out?.reused_existing === true && c1.unchanged, JSON.stringify(c1.out?.code || c1.out?.project_id));
    const c2 = await runCreate({ ws: activeWs, user: memUser, members: member("editor") });
    h.check("10b. create_project: editor allowed, no writes", c2.out?.reused_existing === true && c2.unchanged, JSON.stringify(c2.out?.code || c2.out?.project_id));
    const c3 = await runCreate({ ws: activeWs, user: memUser, members: member("viewer") });
    h.check("10c. create_project: viewer denied 403, no writes", c3.out instanceof Error && c3.out.status === 403 && c3.out.code === "INSUFFICIENT_ROLE" && c3.unchanged, `${c3.out?.status}:${c3.out?.code}`);
    const c4 = await runCreate({ ws: { ...activeWs, status: "suspended" }, user: { id: "u_owner", email: "o@x.test" } });
    h.check("10d. create_project: suspended workspace denied 403, no writes", c4.out instanceof Error && c4.out.status === 403 && c4.out.code === "WORKSPACE_INACTIVE" && c4.unchanged, `${c4.out?.status}:${c4.out?.code}`);

  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}\n${String(e.stack || "").slice(0, 600)}`);
  } finally {
    for (const id of cleanupMembers) await svc.entities.WorkspaceMember.delete(id).catch(() => {});
    for (const ws of [workspace, otherWs]) {
      if (!ws) continue;
      for (const entity of ["WorkspaceMember", "AuditLog", "CommitJournal", "WorkflowDefinition", "WorkflowRun", "IntegrationQuota", "IntegrationInvocation", "IntegrationBreaker", "IntegrationRateLimit"]) {
        const rows = await svc.entities[entity].filter({ workspace_id: ws.id }, "-created_date", 500).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
      await discardWorkspaceProjects(svc, ws.id);
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
    for (const entity of ["IntegrationQuota", "IntegrationInvocation", "IntegrationBreaker", "IntegrationRateLimit"]) {
      for (const pid of [project?.id, foreignProject?.id].filter(Boolean)) {
        const rows = await svc.entities[entity].filter({ project_id: pid }, "-created_date", 200).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
    }
  }

  return harnessResponse(h);
}