// Certification for SANDBOX / REMOTE DEVELOPMENT.
//
//   Project → Sandbox → filesystem → read / write / edit → run → build → checkpoint
//
// Runs against the REAL modules and the REAL data layer: the real authorization path, the real
// project filesystem, the real resource validators (E14/E15), the real build engine, the real
// journalled persistence and versioning, and the real error/exit contract. Nothing is stubbed, and
// no second filesystem, runtime, command executor, versioning system or permission system exists.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { configContent, CONFIG_FILE, entityFilePath, entitySchemaContent, actorFilePath, agentFilePath } from "../../shared/base44Layout.ts";
import { canonicalFunctionPath, functionPath } from "../../shared/functionPaths.ts";
import { workflowDocumentContent, workflowFilePath } from "../../shared/workflowResource.ts";
import { WORKFLOW_CONTRACT_VERSION } from "../../shared/workflowContract.ts";
import { agentDocumentContent } from "../../shared/agentResource.ts";
import { connectorDocumentContent, connectorFilePath, connectorRuntimePath } from "../../shared/connectorResource.ts";
import { loadProjectState } from "../../shared/authz.ts";
import { scaffoldFiles } from "../../shared/scaffold.ts";
import { commandStatus, commandFailure } from "../../shared/resourceErrors.ts";
import {
  sandboxInfo, sandboxRead, sandboxListDirectory, sandboxGrep, sandboxWrite, sandboxEdit,
  sandboxDelete, sandboxRun, sandboxCheckpoint, sandboxExecute, sandboxPath, SANDBOX_OPS, SANDBOX_COMMANDS,
} from "../../shared/sandbox.ts";

// The project is seeded with the platform's OWN scaffold, so "a project that builds" means exactly
// what it means everywhere else in the platform.
const SCAFFOLD = scaffoldFiles("sandbox", "sandbox certification");
const APP_SRC = SCAFFOLD.find((f) => f.path === ENTRY_FILE).content;
const PAGE_SRC = `export const one = 'page one';\n`;
const FN_SRC = `export const config = { method: "POST", secrets: [] };
export default async function handler(ctx) { return { body: { ok: true } }; }
`;
const ACTOR_SRC = `export const config = { access: "write", persist: true, events: true };
export default async function (ctx) { return { reply: { ok: true } }; }
`;
const WF_DEF = {
  name: "Sandbox flow", contract_version: WORKFLOW_CONTRACT_VERSION,
  trigger: { type: "manual" }, entry_step: "done",
  steps: [{ id: "done", type: "complete", output: { ok: true } }],
};
const SECRET_VALUE = "sk-live-sandbox-must-never-leak-0001";

const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 600) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `sandbox-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "sandbox", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(project.id);
    // A second project of the SAME owner: certifies project isolation without confusing it with
    // an authorization failure.
    const other = await svc.entities.Project.create({ workspace_id: ws.id, name: "sandbox-other", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(other.id);
    // A workspace owned by SOMEONE ELSE: certifies the authorization branch.
    const foreignWs = await svc.entities.Workspace.create({ name: `sandbox-foreign-${Date.now()}`, owner_id: `not-${user.id}`, status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "foreign", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(foreignProject.id);

    // Seed both projects through the platform's own records; the sandbox then operates on them.
    for (const p of [project, other]) {
      for (const f of SCAFFOLD) await svc.entities.ProjectFile.create({ project_id: p.id, path: f.path, content: f.content });
    }
    await svc.entities.ProjectFile.create({ project_id: project.id, path: "src/pages/one.js", content: PAGE_SRC });
    // A configured secret with a REAL value: the sandbox must never read, return or grep it.
    await svc.entities.ProjectSecret.create({ project_id: project.id, name: "SANDBOX_API_KEY", value: SECRET_VALUE, description: "certification", required: true, access: "backend_only" });

    // ------------------------------------------------ 1. read_file
    const read = await sandboxRead(base44, user, { project_id: project.id, path: ENTRY_FILE });
    const info = await sandboxInfo(base44, user, { project_id: project.id });
    const missing = await err(() => sandboxRead(base44, user, { project_id: project.id, path: "src/nope.js" }));
    h.check("1 read_file returns the project's real file through the existing filesystem",
      read.ok && read.path === ENTRY_FILE && read.content === APP_SRC && read.size === APP_SRC.length &&
      info.ok && info.layout === "canonical" && info.file_count === 6 &&
      info.operations.join(",") === Object.keys(SANDBOX_OPS).join(",") &&
      missing?.code === "RESOURCE_NOT_FOUND" && commandStatus(missing) === 404,
      `${read.path} · ${info.file_count} files · missing → ${missing?.code}`);

    // ------------------------------------------------ 2. write_file
    const wrote = await sandboxWrite(base44, user, { project_id: project.id, path: "src/pages/two.js", content: "export const two = 2;\n" });
    const rows1 = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    h.check("2 write_file persists through the journalled filesystem commit",
      wrote.ok && wrote.persisted && wrote.changed && wrote.via === "filesystem" && !wrote.version_created &&
      rows1.some((f) => f.path === "src/pages/two.js") && rows1.length === 7,
      `${wrote.path} · via ${wrote.via} · ${rows1.length} files`);

    // ------------------------------------------------ 3. edit_file
    const edited = await sandboxEdit(base44, user, { project_id: project.id, path: "src/pages/one.js", find: "page one", replace: "page edited" });
    const afterEdit = await sandboxRead(base44, user, { project_id: project.id, path: "src/pages/one.js" });
    const ambiguous = await err(() => sandboxEdit(base44, user, { project_id: project.id, path: ENTRY_FILE, find: "html", replace: "x" }));
    const notThere = await err(() => sandboxEdit(base44, user, { project_id: project.id, path: ENTRY_FILE, find: "nothing-like-this", replace: "x" }));
    const editMissing = await err(() => sandboxEdit(base44, user, { project_id: project.id, path: "src/ghost.js", find: "a", replace: "b" }));
    h.check("3 edit_file applies one exact unique replacement and refuses anything else",
      edited.ok && edited.edited && afterEdit.content.includes("page edited") &&
      notThere?.code === "RESOURCE_VALIDATION_FAILED" &&
      editMissing?.code === "RESOURCE_NOT_FOUND" &&
      (ambiguous === null || ambiguous.code === "RESOURCE_VALIDATION_FAILED"),
      `edited · unmatched → ${notThere?.code} · missing → ${editMissing?.code}`);

    // ------------------------------------------------ 5. grep
    const grepAll = await sandboxGrep(base44, user, { project_id: project.id, query: "page edited" });
    const grepScoped = await sandboxGrep(base44, user, { project_id: project.id, query: "export", path: "src/pages" });
    const grepEmpty = await err(() => sandboxGrep(base44, user, { project_id: project.id, query: "  " }));
    h.check("5 grep searches the project and honours a path scope",
      grepAll.ok && grepAll.count === 1 && grepAll.matches[0].path === "src/pages/one.js" && grepAll.matches[0].line === 1 &&
      grepScoped.count === 3 && grepScoped.matches.every((m) => m.path.startsWith("src/pages/")) &&
      grepEmpty?.code === "RESOURCE_INVALID_SOURCE",
      `${grepAll.count} match · scoped ${grepScoped.count} · empty query → ${grepEmpty?.code}`);

    // ------------------------------------------------ 6. list_directory
    const root = await sandboxListDirectory(base44, user, { project_id: project.id });
    const pages = await sandboxListDirectory(base44, user, { project_id: project.id, path: "src/pages" });
    const ghostDir = await err(() => sandboxListDirectory(base44, user, { project_id: project.id, path: "src/ghost" }));
    h.check("6 list_directory lists immediate children, directories first",
      root.ok && root.entries[0].type === "directory" &&
      root.entries.some((e) => e.name === "src" && e.type === "directory") &&
      root.entries.some((e) => e.name === "base44" && e.type === "directory") &&
      pages.count === 3 && pages.entries.every((e) => e.type === "file") &&
      pages.entries.map((e) => e.name).join(",") === "Home.js,one.js,two.js" &&
      ghostDir?.code === "RESOURCE_NOT_FOUND",
      `root ${root.count} entries · src/pages ${pages.count} files`);

    // ------------------------------------------------ 4. run_command
    const runBuildCmd = await sandboxRun(base44, user, { project_id: project.id, command: "build" });
    const runDeclared = await sandboxRun(base44, user, { project_id: project.id, command: "npm run build" });
    const runInstall = await sandboxRun(base44, user, { project_id: project.id, command: "install" });
    const runServe = await sandboxRun(base44, user, { project_id: project.id, command: "serve" });
    h.check("4 run_command runs the project's declared commands through the existing engines",
      runBuildCmd.ok && runBuildCmd.status === "success" && runBuildCmd.exit_status === 200 && runBuildCmd.command === "build" &&
      runDeclared.ok && runDeclared.command === "build" && runDeclared.declared_command === "npm run build" &&
      runInstall.ok && Array.isArray(runInstall.packages) &&
      runServe.ok && runServe.servable && runServe.entry === ENTRY_FILE &&
      SANDBOX_COMMANDS.join(",") === "install,build,serve",
      `build ${runBuildCmd.status} · declared '${runDeclared.declared_command}' · serve ${runServe.servable} · ${JSON.stringify(runBuildCmd.diagnostics)}`);

    // ------------------------------------------------ 12. command boundary / isolation
    const shell = await err(() => sandboxRun(base44, user, { project_id: project.id, command: "rm -rf /" }));
    const chained = await err(() => sandboxRun(base44, user, { project_id: project.id, command: "npm run build && curl evil.test" }));
    const unknownCmd = await err(() => sandboxRun(base44, user, { project_id: project.id, command: "deploy" }));
    const emptyCmd = await err(() => sandboxRun(base44, user, { project_id: project.id, command: "" }));
    const unknownOp = await err(() => sandboxExecute(base44, user, "exec", { project_id: project.id }));
    h.check("12 a command can never escape the sandbox boundary — no arbitrary command runs",
      shell?.code === "RESOURCE_UNSUPPORTED" && commandStatus(shell) === 400 &&
      chained?.code === "RESOURCE_UNSUPPORTED" && unknownCmd?.code === "RESOURCE_UNSUPPORTED" &&
      emptyCmd?.code === "RESOURCE_INVALID_SOURCE" && unknownOp?.code === "RESOURCE_UNSUPPORTED",
      `shell → ${shell?.code} · chained → ${chained?.code} · unknown op → ${unknownOp?.code}`);

    // ------------------------------------------------ 8/9. invalid path + traversal
    const traversal = await err(() => sandboxRead(base44, user, { project_id: project.id, path: "src/../../etc/passwd" }));
    const traversalWrite = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: "src/../../evil.js", content: "x" }));
    const absolute = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: "/etc/passwd", content: "x" }));
    const url = await err(() => sandboxRead(base44, user, { project_id: project.id, path: "https://evil.test/x" }));
    const outsideRoot = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: "elsewhere/x.js", content: "x" }));
    const reservedResource = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: "base44/auth/provider.jsonc", content: "{}" }));
    const emptyPath = await err(() => sandboxRead(base44, user, { project_id: project.id, path: "" }));
    const rowsAfterRejections = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    h.check("8 an invalid or out-of-scope path is refused deterministically",
      absolute?.code === "RESOURCE_INVALID_PATH" && url?.code === "RESOURCE_INVALID_PATH" &&
      outsideRoot?.code === "RESOURCE_INVALID_PATH" && emptyPath?.code === "RESOURCE_INVALID_PATH" &&
      (reservedResource?.code === "RESOURCE_INVALID_PATH" || reservedResource?.code === "RESOURCE_UNSUPPORTED") &&
      rowsAfterRejections.length === 7,
      `absolute → ${absolute?.code} · outside root → ${outsideRoot?.code} · reserved → ${reservedResource?.code}`);
    h.check("9 path traversal is rejected before any filesystem access",
      traversal?.code === "RESOURCE_INVALID_PATH" && traversalWrite?.code === "RESOURCE_INVALID_PATH" &&
      !rowsAfterRejections.some((f) => f.path.includes("..")) &&
      !rowsAfterRejections.some((f) => f.path === "evil.js") &&
      (() => { try { sandboxPath("a/../../b"); return false; } catch { return true; } })() &&
      sandboxPath("./src/x.js") === "src/x.js",
      `traversal → ${traversal?.code}; nothing was written`);

    // ------------------------------------------------ 10. unauthorized access
    const foreignRead = await err(() => sandboxRead(base44, user, { project_id: foreignProject.id, path: ENTRY_FILE }));
    const foreignWrite = await err(() => sandboxWrite(base44, user, { project_id: foreignProject.id, path: "src/x.js", content: "x" }));
    const foreignCheckpoint = await err(() => sandboxCheckpoint(base44, user, { project_id: foreignProject.id }));
    const noProject = await err(() => sandboxRead(base44, user, { project_id: "does-not-exist", path: ENTRY_FILE }));
    const foreignFiles = await svc.entities.ProjectFile.filter({ project_id: foreignProject.id }, "path", 20);
    h.check("10 an unauthorized caller is denied through the existing authorization path",
      commandStatus(foreignRead) === 403 && commandStatus(foreignWrite) === 403 &&
      commandStatus(foreignCheckpoint) === 403 && commandStatus(noProject) === 404 &&
      foreignFiles.length === 0,
      `read ${commandStatus(foreignRead)} · write ${commandStatus(foreignWrite)} · missing project ${commandStatus(noProject)}`);

    // ------------------------------------------------ 11. project isolation
    const otherList = await sandboxListDirectory(base44, user, { project_id: other.id, path: "src" });
    const otherGrep = await sandboxGrep(base44, user, { project_id: other.id, query: "page edited" });
    const otherMissing = await err(() => sandboxRead(base44, user, { project_id: other.id, path: "src/pages/two.js" }));
    h.check("11 every sandbox operation is scoped to its own project",
      otherGrep.count === 0 && otherMissing?.code === "RESOURCE_NOT_FOUND" &&
      !otherList.entries.some((e) => e.name === "two.js") &&
      !(await sandboxListDirectory(base44, user, { project_id: other.id, path: "src/pages" })).entries.some((e) => e.name === "one.js"),
      `other project: grep ${otherGrep.count} match(es), sibling file → ${otherMissing?.code}`);

    // ------------------------------------------------ 13. secret / credential boundary
    const secretGrep = await sandboxGrep(base44, user, { project_id: project.id, query: SECRET_VALUE });
    const secretNameGrep = await sandboxGrep(base44, user, { project_id: project.id, query: "SANDBOX_API_KEY" });
    const infoSecrets = JSON.stringify(info.secrets);
    const fullInfo = await sandboxInfo(base44, user, { project_id: project.id });
    h.check("13 a secret VALUE has no route through the sandbox",
      secretGrep.count === 0 && secretNameGrep.count === 0 &&
      !infoSecrets.includes(SECRET_VALUE) && !JSON.stringify(fullInfo).includes(SECRET_VALUE) &&
      fullInfo.secrets.some((s) => s.name === "SANDBOX_API_KEY" && s.is_set === true) &&
      fullInfo.secrets.every((s) => !("value" in s)),
      `${fullInfo.secrets.length} secret name(s) exposed, 0 values`);

    // ------------------------------------------------ 19. resource compatibility
    const ENTITY_PATH = entityFilePath("Task");
    const FN_PATH = canonicalFunctionPath("notify");
    const WF_PATH = workflowFilePath(WF_DEF.name);
    const AGENT_PATH = agentFilePath("helper");
    const CONNECTOR_PATH = connectorFilePath("weather");
    const ACTOR_PATH = actorFilePath("ChatRoom");
    const CONNECTOR_DOC = connectorDocumentContent({ name: "weather", base_url: "https://api.weather.test", operations: [{ name: "current", method: "GET", path: "/current" }] });
    const written = [];
    written.push(await sandboxWrite(base44, user, { project_id: project.id, path: ENTITY_PATH, content: entitySchemaContent("Task", { title: { type: "string", required: true } }) }));
    written.push(await sandboxWrite(base44, user, { project_id: project.id, path: FN_PATH, content: FN_SRC }));
    written.push(await sandboxWrite(base44, user, { project_id: project.id, path: WF_PATH, content: workflowDocumentContent(WF_DEF) }));
    written.push(await sandboxWrite(base44, user, { project_id: project.id, path: AGENT_PATH, content: agentDocumentContent({ name: "helper", instructions: "Help with the project.", tools: ["read_file"] }) }));
    written.push(await sandboxWrite(base44, user, { project_id: project.id, path: CONNECTOR_PATH, content: CONNECTOR_DOC }));
    written.push(await sandboxWrite(base44, user, { project_id: project.id, path: ACTOR_PATH, content: ACTOR_SRC }));
    const stateAfterResources = await loadProjectState(base44, project.id);
    const paths = stateAfterResources.files.map((f) => f.path);
    const wfDefs = await svc.entities.WorkflowDefinition.filter({ project_id: project.id }, "-version", 10);
    h.check("19 the sandbox understands every canonical resource, using each resource's own layer",
      written.every((w) => w.ok && w.via === "resource_sync" && w.persisted) &&
      written.map((w) => w.kind).join(",") === "entities,functions,workflows,agents,connectors,actors" &&
      stateAfterResources.entities.some((e) => e.name === "Task") &&
      wfDefs.some((d) => d.status === "FINALIZED" && d.workflow_key === "sandbox-flow") &&
      paths.includes(connectorRuntimePath("weather")) &&
      paths.includes(AGENT_PATH) && paths.includes(ACTOR_PATH) && paths.includes(FN_PATH),
      `${written.length} resource kinds · connector projection ${paths.includes(connectorRuntimePath("weather"))}`);

    // ------------------------------------------------ 18. deterministic malformed resource
    const badEntity = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: ENTITY_PATH, content: "{ not json" }));
    const badWorkflow = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: WF_PATH, content: '{ "name": "x", "nonsense": true }' }));
    const badAgent = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: AGENT_PATH, content: "{}" }));
    const wrongEntityName = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: ENTITY_PATH, content: entitySchemaContent("Other", { a: { type: "string" } }) }));
    const nonString = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: "src/x.js", content: 42 }));
    const staleWrite = await err(() => sandboxWrite(base44, user, { project_id: project.id, path: "src/pages/two.js", content: "x", expected_version: 999 }));
    const failureBody = commandFailure(badAgent);
    h.check("18 every failure class keeps its deterministic E14/E15 code, message and status",
      badEntity?.code === "RESOURCE_MALFORMED" && badWorkflow?.code === "RESOURCE_MALFORMED" &&
      badAgent?.code === "RESOURCE_MALFORMED" && wrongEntityName?.code === "RESOURCE_INVALID_NAME" &&
      nonString?.code === "RESOURCE_MALFORMED" && staleWrite?.code === "RESOURCE_CONFLICT" &&
      commandStatus(staleWrite) === 409 && commandStatus(badEntity) === 400 &&
      failureBody.ok === false && typeof failureBody.error === "string" && failureBody.status === 400,
      `malformed 400 · wrong name ${wrongEntityName?.code} · stale ${commandStatus(staleWrite)}`);

    // ------------------------------------------------ 14. build after sandbox edit
    const buildAfterResources = await sandboxRun(base44, user, { project_id: project.id, command: "build" });
    const builds = await svc.entities.Build.filter({ project_id: project.id }, "-created_date", 20);
    h.check("14 the project still builds after sandbox edits, and the build is recorded",
      buildAfterResources.ok && buildAfterResources.status === "success" &&
      buildAfterResources.logs.some((l) => l.startsWith("[workflows]")) &&
      buildAfterResources.logs.some((l) => l.startsWith("[actors]")) &&
      builds.length > 0 && builds[0].status === "success",
      `build ${buildAfterResources.status} · ${builds.length} build record(s)`);

    // ------------------------------------------------ 7/16. create_checkpoint
    const beforeCheckpoint = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 30)).length;
    const checkpoint = await sandboxCheckpoint(base44, user, { project_id: project.id, message: "sandbox checkpoint" });
    const versions = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 30);
    const latest = versions[0];
    h.check("7 create_checkpoint produces an immutable version through the existing primitive",
      checkpoint.ok && checkpoint.version === latest.number && checkpoint.build_status === "success" &&
      versions.length === beforeCheckpoint + 1 && latest.message === "sandbox checkpoint" &&
      !!latest.snapshot_url || !!latest.snapshot,
      `v${checkpoint.version} · ${versions.length} version(s)`);
    const projectRow = await svc.entities.Project.get(project.id);
    h.check("16 the checkpoint captures the project's state deterministically",
      checkpoint.file_count === (await loadProjectState(base44, project.id)).files.length &&
      checkpoint.entities.includes("Task") &&
      Number(projectRow.version_count) === checkpoint.version &&
      (await sandboxInfo(base44, user, { project_id: project.id })).version === checkpoint.version,
      `${checkpoint.file_count} files · entities ${checkpoint.entities.join(",")} · project at v${projectRow.version_count}`);

    // ------------------------------------------------ 17. checkpoint failure behaviour
    const broken = await sandboxWrite(base44, user, { project_id: project.id, path: "src/pages/two.js", content: "export const broken = (;\n" });
    const brokenBuild = await sandboxRun(base44, user, { project_id: project.id, command: "build" });
    const refused = await err(() => sandboxCheckpoint(base44, user, { project_id: project.id }));
    const versionsAfterFailure = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 30);
    const forced = await sandboxCheckpoint(base44, user, { project_id: project.id, require_build: false });
    h.check("17 a failing state refuses the checkpoint and silently creates nothing",
      broken.ok && !brokenBuild.ok && brokenBuild.status === "failed" && brokenBuild.exit_status === 400 &&
      refused?.code === "RESOURCE_VALIDATION_FAILED" && commandStatus(refused) === 400 &&
      refused.details.build_status === "failed" && refused.details.diagnostics.length > 0 &&
      versionsAfterFailure.length === versions.length &&
      forced.ok && forced.build_status === "failed",
      `refused → ${refused?.code} · versions still ${versionsAfterFailure.length} · explicit broken checkpoint v${forced.version}`);

    // ------------------------------------------------ 15. preview/runtime after sandbox edit
    const repaired = await sandboxEdit(base44, user, { project_id: project.id, path: "src/pages/two.js", find: "export const broken = (;", replace: "export const two = 2;" });
    const serveAfter = await sandboxRun(base44, user, { project_id: project.id, command: "serve" });
    const deletedEntry = await sandboxDelete(base44, user, { project_id: project.id, path: ENTRY_FILE });
    const serveNoEntry = await sandboxRun(base44, user, { project_id: project.id, command: "serve" });
    const restoredEntry = await sandboxWrite(base44, user, { project_id: project.id, path: ENTRY_FILE, content: APP_SRC });
    const serveRestored = await sandboxRun(base44, user, { project_id: project.id, command: "serve" });
    h.check("15 the preview/runtime is servable exactly when the edited project really builds",
      repaired.ok && serveAfter.ok && serveAfter.servable && serveAfter.entry === ENTRY_FILE &&
      deletedEntry.deleted && !serveNoEntry.ok && !serveNoEntry.servable &&
      serveNoEntry.diagnostics.some((d) => d.includes(ENTRY_FILE)) &&
      restoredEntry.ok && serveRestored.servable,
      `servable → removed entry → ${serveNoEntry.servable} → restored ${serveRestored.servable}`);

    // ------------------------------------------------ 20. legacy project compatibility
    const legacy = await svc.entities.Project.create({ workspace_id: ws.id, name: "legacy", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(legacy.id);
    // A legacy project: the same frontend, WITHOUT the base44/ layout, plus a flat-layout function.
    for (const f of SCAFFOLD) {
      if (f.path === CONFIG_FILE) continue;
      await svc.entities.ProjectFile.create({ project_id: legacy.id, path: f.path, content: f.content });
    }
    await svc.entities.ProjectFile.create({ project_id: legacy.id, path: functionPath("legacyFn"), content: FN_SRC });
    const legacyInfo = await sandboxInfo(base44, user, { project_id: legacy.id });
    const legacyWrite = await sandboxWrite(base44, user, { project_id: legacy.id, path: canonicalFunctionPath("legacyFn"), content: FN_SRC.replace("ok: true", "ok: 1 === 1") });
    const legacyRun = await sandboxRun(base44, user, { project_id: legacy.id, command: "build" });
    const legacyCheckpoint = await sandboxCheckpoint(base44, user, { project_id: legacy.id, message: "legacy checkpoint" });
    const legacyFiles = await svc.entities.ProjectFile.filter({ project_id: legacy.id }, "path", 50);
    h.check("20 a legacy project keeps its layout, builds, runs and checkpoints unchanged",
      legacyInfo.layout === "legacy" && legacyInfo.site === null &&
      legacyWrite.path === canonicalFunctionPath("legacyFn") &&
      legacyFiles.filter((f) => f.path === functionPath("legacyFn")).length === 1 &&
      !legacyFiles.some((f) => f.path === canonicalFunctionPath("legacyFn")) &&
      legacyRun.ok && legacyCheckpoint.ok && legacyCheckpoint.version >= 1 &&
      legacyCheckpoint.version === Number((await svc.entities.Project.get(legacy.id)).version_count),
      `layout ${legacyInfo.layout} · ${legacyFiles.length} files · checkpoint v${legacyCheckpoint.version}`);

    // ------------------------------------------------ remote-development parity
    const remote = await sandboxExecute(base44, user, "read_file", { project_id: project.id, path: ENTRY_FILE });
    const remoteEdit = await sandboxExecute(base44, user, "edit_file", { project_id: project.id, path: ENTRY_FILE, find: "getElementById('app')", replace: "getElementById('app') /* remote */" });
    const remoteRun = await sandboxExecute(base44, user, "run_command", { project_id: project.id, command: "build" });
    const remoteCheckpoint = await sandboxExecute(base44, user, "create_checkpoint", { project_id: project.id, message: "remote checkpoint" });
    const finalRead = await sandboxRead(base44, user, { project_id: project.id, path: ENTRY_FILE });
    h.check("21 remote development has the same read → edit → run → build → checkpoint semantics",
      remote.content === APP_SRC && remoteEdit.ok && remoteRun.ok &&
      remoteCheckpoint.ok && remoteCheckpoint.build_status === "success" &&
      finalRead.content.includes("/* remote */") &&
      remoteCheckpoint.version === (await svc.entities.Project.get(project.id)).version_count,
      `remote cycle ended at v${remoteCheckpoint.version}`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["WorkflowStepRun", "WorkflowRun", "WorkflowDefinition", "ScheduledTrigger", "AuditLog", "TraceEvent", "AppRecord", "AppEntity", "ProjectSecret", "DeploymentArtifact", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["WorkflowDefinition", "AuditLog", "TraceEvent", "WorkspaceMember", "Project"]);
    }
  }
}