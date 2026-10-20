// Certification for E14 / E15 — Base44 resource PUSH / PULL and the error / exit contract.
//
// Runs against the REAL modules and the REAL data layer: the real layout contract, the real
// validators, the real virtual filesystem, the real journalled persistence and versioning, the real
// workflow resource sync and the real authorization. Nothing is stubbed, and no second persistence
// model, validator or error vocabulary exists anywhere in this suite.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { entitySchemaContent, entityFilePath, configContent, CONFIG_FILE } from "../../shared/base44Layout.ts";
import { canonicalFunctionPath, functionPath } from "../../shared/functionPaths.ts";
import { workflowDocumentContent, workflowFilePath } from "../../shared/workflowResource.ts";
import { WORKFLOW_CONTRACT_VERSION } from "../../shared/workflowContract.ts";
import { pullResources, pushResources, resourceStatus, validateResource, resourceKindOf, resourceIdentity } from "../../shared/resourceSync.ts";
import { withFailingOp, captureError } from "../../shared/failingClient.ts";
import { commandFailure, commandStatus, RESOURCE_ERROR_STATUS } from "../../shared/resourceErrors.ts";

const TASK_FIELDS = { title: { type: "string", required: true }, done: { type: "boolean", required: false } };
const NOTE_FIELDS = { body: { type: "text", required: true } };
const FN_SRC = `export const config = { method: "POST", secrets: [] };
export default async function handler(ctx) { return { body: { ok: true } }; }
`;

const WF_DEF = {
  name: "Order flow", contract_version: WORKFLOW_CONTRACT_VERSION,
  trigger: { type: "manual" }, entry_step: "done",
  steps: [{ id: "done", type: "complete", output: { pushed: true } }],
};

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

    const ws = await svc.entities.Workspace.create({ name: `ressync-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "resource-sync", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(project.id);
    // A workspace owned by SOMEONE ELSE: used to certify the permission branch of the exit contract.
    const foreignWs = await svc.entities.Workspace.create({ name: `ressync-foreign-${Date.now()}`, owner_id: `not-${user.id}`, status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "foreign", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(foreignProject.id);

    const TASK_PATH = entityFilePath("Task");
    const NOTE_PATH = entityFilePath("Note");
    const FN_PATH = canonicalFunctionPath("orderNotify");
    const WF_PATH = workflowFilePath("Order flow");
    const source = [
      { path: CONFIG_FILE, content: configContent("resource-sync", "push/pull certification") },
      { path: TASK_PATH, content: entitySchemaContent("Task", TASK_FIELDS) },
      { path: NOTE_PATH, content: entitySchemaContent("Note", NOTE_FIELDS) },
      { path: FN_PATH, content: FN_SRC },
      { path: WF_PATH, content: workflowDocumentContent(WF_DEF) },
    ];

    // ------------------------------------------------ 1. canonical mapping
    h.check("1 resources map deterministically to kind + identity",
      resourceKindOf(CONFIG_FILE) === "config" && resourceKindOf(TASK_PATH) === "entities" &&
      resourceKindOf(FN_PATH) === "functions" && resourceKindOf(functionPath("legacyFn")) === "functions" &&
      resourceKindOf(WF_PATH) === "workflows" && resourceKindOf("base44/.types/types.d.ts") === "types" &&
      resourceKindOf("src/pages/home.js") === null && resourceKindOf("base44/agents/bot.jsonc") === "agents" &&
      resourceIdentity(TASK_PATH) === "Task" && resourceIdentity(FN_PATH) === "orderNotify" &&
      resourceIdentity(functionPath("orderNotify")) === "orderNotify" && resourceIdentity(WF_PATH) === "order-flow",
      "one identity per resource, and a function keeps ONE identity in both layouts");

    // ------------------------------------------------ 2. push
    const push1 = await pushResources(base44, user, { project_id: project.id, resources: source, message: "initial push" });
    const rowsAfter = await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 50);
    const wfDefs = await svc.entities.WorkflowDefinition.filter({ project_id: project.id }, "-version", 20);
    h.check("2 push applies every resource kind through the existing persistence path",
      push1.ok && push1.created === 5 && push1.version_created && push1.version === 1 &&
      rowsAfter.map((r) => r.name).sort().join(",") === "Note,Task" &&
      wfDefs.length === 1 && wfDefs[0].status === "FINALIZED" && wfDefs[0].workflow_key === "order-flow" &&
      push1.workflows.created === 1,
      `v${push1.version} · ${push1.created} created · entities ${rowsAfter.length} · workflow ${wfDefs[0]?.status}`);

    // ------------------------------------------------ 3. pull
    const pull1 = await pullResources(base44, user, { project_id: project.id });
    const pulledPaths = pull1.resources.map((r) => r.path).sort();
    h.check("3 pull reconstructs the canonical resource state",
      pull1.ok && pull1.version === 1 && pull1.count === 5 &&
      pulledPaths.join("|") === [CONFIG_FILE, TASK_PATH, NOTE_PATH, FN_PATH, WF_PATH].sort().join("|") &&
      pull1.resources.find((r) => r.path === TASK_PATH).content === entitySchemaContent("Task", TASK_FIELDS) &&
      pull1.resources.find((r) => r.path === WF_PATH).content === workflowDocumentContent(WF_DEF) &&
      Array.isArray(pull1.unsupported),
      `${pull1.count} resources pulled at v${pull1.version}`);

    // ------------------------------------------------ 4. round-trip + idempotency
    const push2 = await pushResources(base44, user, { project_id: project.id, resources: pull1.resources });
    const push3 = await pushResources(base44, user, { project_id: project.id, resources: source });
    const versions = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 20);
    h.check("4 a push/pull round-trip is idempotent and creates no version",
      push2.ok && push2.unchanged === 5 && push2.created === 0 && push2.updated === 0 && !push2.version_created &&
      push3.unchanged === 5 && !push3.version_created && versions.length === 1 &&
      push2.workflows.unchanged === 1 && push2.workflows.created === 0,
      `unchanged ${push2.unchanged}/5 · versions ${versions.length} · workflow unchanged ${push2.workflows.unchanged}`);

    // ------------------------------------------------ 5. status / conflict states
    const edited = source.map((r) => (r.path === TASK_PATH ? { ...r, content: entitySchemaContent("Task", { ...TASK_FIELDS, priority: { type: "number", required: false } }) } : r));
    const status = await resourceStatus(base44, user, { project_id: project.id, resources: edited.filter((r) => r.path !== NOTE_PATH).concat([{ path: entityFilePath("Extra"), content: entitySchemaContent("Extra", NOTE_FIELDS) }]) });
    const byId = Object.fromEntries(status.resources.map((r) => [r.identity, r.state]));
    h.check("5 every conflict state is reported deterministically",
      byId.Task === "changed" && byId.Extra === "local_only" && byId.Note === "remote_only" &&
      byId.orderNotify === "identical" && byId.config === "identical" && byId["order-flow"] === "identical",
      JSON.stringify(byId));

    // ------------------------------------------------ 6. optimistic-concurrency conflict
    await h.expectThrow("6 a stale expected_version is refused, nothing applied",
      () => pushResources(base44, user, { project_id: project.id, resources: edited, expected_version: 0 }), "RESOURCE_CONFLICT");
    const untouched = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 20);
    h.check("6b the refused push wrote nothing", untouched.length === 1, `still ${untouched.length} version(s)`);

    // ------------------------------------------------ 7. full-sync deletion vs merge
    const withoutNote = edited.filter((r) => r.path !== NOTE_PATH);
    const mergePush = await pushResources(base44, user, { project_id: project.id, resources: withoutNote, mode: "merge" });
    const afterMerge = await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 50);
    const fullPush = await pushResources(base44, user, { project_id: project.id, resources: withoutNote, mode: "full" });
    const afterFull = await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 50);
    const filesAfterFull = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    h.check("7 full-sync removes what the source omits; merge preserves it",
      mergePush.removed === 0 && afterMerge.some((e) => e.name === "Note") &&
      fullPush.removed === 1 && fullPush.removed_resources[0].identity === "Note" &&
      !afterFull.some((e) => e.name === "Note") && !filesAfterFull.some((f) => f.path === NOTE_PATH) &&
      filesAfterFull.some((f) => f.path === TASK_PATH) && filesAfterFull.some((f) => f.path === FN_PATH),
      `merge kept Note · full removed ${fullPush.removed_resources.map((r) => r.identity).join(",")}`);

    // ------------------------------------------------ 7c-7f. PA-18 (provisional R-9/R-10): failed removal
    const withNote = [...withoutNote, { path: NOTE_PATH, content: entitySchemaContent("Note", NOTE_FIELDS) }];
    await pushResources(base44, user, { project_id: project.id, resources: withNote, mode: "full" });
    const versionsBefore = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 50)).length;
    const removalErr = await captureError(() => pushResources(withFailingOp(base44, "AppEntity", "delete"), user, { project_id: project.id, resources: withoutNote, mode: "full" }));
    const noteRowAfterFail = (await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 50)).some((e) => e.name === "Note");
    const noteFileAfterFail = (await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100)).some((f) => f.path === NOTE_PATH);
    const versionsAfterFail = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 50)).length;
    h.check("7c a failed entity removal fails the sync and is not reported as removed",
      removalErr?.code === "RESOURCE_PERSISTENCE_FAILED" && removalErr?.details?.identity === "Note" && !("removed" in (removalErr || {})),
      `${removalErr?.code}: ${String(removalErr?.message || "").slice(0, 120)}`);
    h.check("7d the failed sync persisted nothing (entity, file and version history untouched)",
      noteRowAfterFail && noteFileAfterFail && versionsAfterFail === versionsBefore, JSON.stringify({ noteRowAfterFail, noteFileAfterFail, versionsBefore, versionsAfterFail }));
    const retry = await pushResources(base44, user, { project_id: project.id, resources: withoutNote, mode: "full" });
    const afterRetry = await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 50);
    h.check("7e retrying the sync after the failure completes the removal exactly once",
      retry.removed === 1 && retry.removed_resources[0].identity === "Note" && !afterRetry.some((e) => e.name === "Note") && afterRetry.filter((e) => e.name === "Task").length === 1,
      `removed ${retry.removed}`);
    const retry2 = await pushResources(base44, user, { project_id: project.id, resources: withoutNote, mode: "full" });
    h.check("7f a further retry is a no-op (idempotent)", retry2.removed === 0 && !retry2.version_created, `removed ${retry2.removed}`);

    // ------------------------------------------------ 8. scope containment
    const scoped = await pushResources(base44, user, { project_id: project.id, resources: [{ path: WF_PATH, content: workflowDocumentContent(WF_DEF) }], kinds: ["workflows"], mode: "full" });
    const stillThere = await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 50);
    h.check("8 pruning never leaves the synchronized scope",
      scoped.removed === 0 && stillThere.some((e) => e.name === "Task") &&
      (await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100)).some((f) => f.path === TASK_PATH),
      "a workflows-only full sync left entities, config and functions untouched");

    // ------------------------------------------------ 9. malformed / naming / duplicate / kind
    await h.expectThrow("9 a malformed entity document is refused", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: TASK_PATH, content: "{ not json" }] }), "RESOURCE_MALFORMED");
    await h.expectThrow("9b a malformed workflow document is refused", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: WF_PATH, content: '{ "name": "x", "nonsense": true }' }] }), "RESOURCE_MALFORMED");
    await h.expectThrow("9c a non-resource path is refused", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: "src/pages/home.js", content: "x" }] }), "RESOURCE_INVALID_PATH");
    await h.expectThrow("9d an entity naming a different entity is refused", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: TASK_PATH, content: entitySchemaContent("Other", TASK_FIELDS) }] }), "RESOURCE_INVALID_NAME");
    await h.expectThrow("9e a duplicate resource identity is refused", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: FN_PATH, content: FN_SRC }, { path: functionPath("orderNotify"), content: FN_SRC }] }), "RESOURCE_DUPLICATE");
    await h.expectThrow("9f a declared kind that contradicts the path is refused", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: FN_PATH, kind: "entities", content: FN_SRC }] }), "RESOURCE_KIND_MISMATCH");
    // agents/ is now a SUPPORTED resource kind, so this fixture is validated as an agent document
    // rather than refused as reserved — it intentionally omits the required 'instructions'.
    await h.expectThrow("9g a malformed agent resource is refused, not discarded", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: "base44/agents/bot.jsonc", content: "{}" }] }), "RESOURCE_MALFORMED");
    await h.expectThrow("9h a non-array source is refused", () => pushResources(base44, user, { project_id: project.id, resources: "nope" }), "RESOURCE_INVALID_SOURCE");
    const afterRejections = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    h.check("9i every rejection applied nothing",
      afterRejections.filter((f) => f.path === TASK_PATH).length === 1 &&
      !afterRejections.some((f) => f.path === "base44/agents/bot.jsonc") &&
      !afterRejections.some((f) => f.path === functionPath("orderNotify")),
      "the project's files are exactly what the last accepted push left");

    // ------------------------------------------------ 10. deterministic error shape
    const shape = (() => { try { validateResource({ path: "src/x.js", content: "" }); return null; } catch (e) { return e; } })();
    const body = commandFailure(shape);
    const parsed = JSON.parse(JSON.stringify(body));
    h.check("10 the error shape is deterministic and machine-readable",
      shape.name === "ResourceError" && shape.code === "RESOURCE_INVALID_PATH" && shape.status === 400 &&
      typeof shape.message === "string" && shape.details.path === "src/x.js" &&
      parsed.ok === false && parsed.code === "RESOURCE_INVALID_PATH" && parsed.status === 400 && typeof parsed.error === "string",
      `${parsed.code} → ${parsed.status}: ${parsed.error}`);

    // ------------------------------------------------ 11. exit contract
    const forbidden = await pushResources(base44, user, { project_id: foreignProject.id, resources: [] }).then(() => null).catch((e) => e);
    const missing = await pullResources(base44, user, { project_id: "does-not-exist" }).then(() => null).catch((e) => e);
    const conflict = await pushResources(base44, user, { project_id: project.id, resources: source, expected_version: 99 }).then(() => null).catch((e) => e);
    h.check("11 each failure class maps to its own deterministic non-zero status",
      commandStatus(forbidden) === 403 && commandStatus(missing) === 404 &&
      commandStatus(conflict) === 409 && commandStatus(shape) === 400 &&
      commandStatus({ code: "RESOURCE_PERSISTENCE_FAILED" }) === 500 &&
      RESOURCE_ERROR_STATUS.RESOURCE_UNAUTHENTICATED === 401 &&
      commandStatus({}) === 500 && commandFailure(conflict).code === "RESOURCE_CONFLICT",
      `forbidden ${commandStatus(forbidden)} · missing ${commandStatus(missing)} · conflict ${commandStatus(conflict)} · validation ${commandStatus(shape)}`);

    // ------------------------------------------------ 12. legacy layout compatibility
    const legacyProject = await svc.entities.Project.create({ workspace_id: ws.id, name: "legacy-layout", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(legacyProject.id);
    await svc.entities.ProjectFile.create({ project_id: legacyProject.id, path: functionPath("legacyFn"), content: "export default async function handler() { return { body: {} }; }\n" });
    const legacyPush = await pushResources(base44, user, { project_id: legacyProject.id, resources: [{ path: canonicalFunctionPath("legacyFn"), content: FN_SRC }] });
    const legacyFiles = await svc.entities.ProjectFile.filter({ project_id: legacyProject.id }, "path", 50);
    const legacyPull = await pullResources(base44, user, { project_id: legacyProject.id });
    h.check("12 a legacy-layout project keeps its layout and gains no second copy",
      legacyPush.updated === 1 && legacyPush.resources[0].path === functionPath("legacyFn") &&
      legacyFiles.length === 1 && legacyFiles[0].path === functionPath("legacyFn") && legacyFiles[0].content === FN_SRC &&
      legacyPull.resources.length === 1 && legacyPull.resources[0].identity === "legacyFn" && legacyPull.resources[0].path === functionPath("legacyFn"),
      `pushed to ${legacyPush.resources[0].path}; ${legacyFiles.length} function file(s)`);

    // ------------------------------------------------ 13. lifecycle identity
    const finalPull = await pullResources(base44, user, { project_id: project.id });
    const finalPush = await pushResources(base44, user, { project_id: project.id, resources: finalPull.resources });
    const finalDefs = await svc.entities.WorkflowDefinition.filter({ project_id: project.id, workflow_key: "order-flow" }, "-version", 20);
    h.check("13 no resource changes identity across create → persist → pull → push → version",
      finalPush.unchanged === finalPull.count && !finalPush.version_created &&
      finalPull.resources.every((r) => r.identity === resourceIdentity(r.path, r.kind)) &&
      finalDefs.filter((d) => d.status === "FINALIZED").length === 1,
      `${finalPull.count} resources survived the full cycle with one finalized workflow lineage`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["WorkflowStepRun", "WorkflowRun", "WorkflowDefinition", "ScheduledTrigger", "AuditLog", "TraceEvent", "AppRecord", "AppEntity", "ProjectSecret", "ProjectVersion", "Build", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["WorkflowDefinition", "AuditLog", "TraceEvent", "WorkspaceMember", "Project"]);
    }
  }
}