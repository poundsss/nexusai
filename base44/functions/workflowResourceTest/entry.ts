// Certification for E4 — the Base44-compatible WORKFLOW RESOURCE layer.
//
// Runs against the REAL modules and the REAL data layer: the real resource contract, the real
// project filesystem write guard, the real build engine, the real authorized workflow API, the real
// durable engine, the real function runtime and the real audit/trace systems. Nothing is stubbed and
// no second workflow engine, validator, trigger system or scheduler exists.
//
// The lifecycle under test is exactly the one E4 asks for:
//   resource file → persist → load → validate → trigger → execute → state → error/retry → log → build
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, writeFile, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { recordEvent } from "../../shared/ledger.ts";
import {
  isWorkflowFilePath, workflowFilePath, workflowNameFromPath, workflowKeyFromPath,
  parseWorkflowDocument, workflowDocumentContent, validateWorkflowFiles, collectWorkflowFiles,
} from "../../shared/workflowResource.ts";
import { loadWorkflowResources, syncWorkflowResources, exportWorkflowResource } from "../../shared/workflowSync.ts";
import {
  createWorkflow, finalizeWorkflow, getWorkflow, listWorkflows,
  triggerWorkflow, getWorkflowRun,
} from "../../shared/workflowApi.ts";
import { workflowChecksum, WORKFLOW_CONTRACT_VERSION } from "../../shared/workflowContract.ts";
// The resource layer's own normalized fingerprint: the ONLY thing that compares a sparse resource
// FILE against a DB-materialized stored definition. The engine's own `definition_checksum` keeps its
// existing meaning and is asserted separately below.
import { resourceChecksum } from "../../shared/workflowResource.ts";

const FN_NOTIFY = `export const config = { method: "POST" };
export default async function (ctx) { return { body: { ok: true, total: (ctx.request.body || {}).total || 0 } }; }
`;

const DOC_ORDER = JSON.stringify({
  name: "Order resource flow",
  description: "authored as a project resource file",
  contract_version: WORKFLOW_CONTRACT_VERSION,
  trigger: { type: "app_event", event: "order.resource" },
  entry_step: "gate",
  steps: [
    { id: "gate", type: "condition", condition: { left: "$.trigger.total", op: ">", right: 100 }, if_true: "notify", if_false: "small" },
    { id: "notify", type: "function", function_name: "orderNotify", input: { total: "$.trigger.total" }, next: "done" },
    { id: "done", type: "complete", output: { path: "large", notified: "$.steps.notify.body.ok" } },
    { id: "small", type: "complete", output: { path: "small" } },
  ],
}, null, 2);

// The same workflow with one changed value — must land as the NEXT version, not a rewrite.
const DOC_ORDER_V2 = DOC_ORDER.replace('"right": 100', '"right": 200');

const DOC_MALFORMED = '{ "name": "Broken", "steps": [ }';
const DOC_UNKNOWN_KEY = JSON.stringify({ name: "Odd", steps: [{ id: "fin", type: "complete" }], entry_step: "fin", nonsense: true });
const DOC_INVALID = JSON.stringify({
  name: "Unrunnable", trigger: { type: "webhook" }, entry_step: "missing",
  steps: [{ id: "a", type: "function", function_name: "doesNotExist", next: "nowhere" }],
});

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

    const ws = await svc.entities.Workspace.create({ name: `wfres-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "workflow-resources", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(project.id);
    await recordEvent(svc, { workspace_id: ws.id, event_type: "promotional", amount: 200, idempotency_key: `wfres-grant-${ws.id}`, reason: "certification grant" });

    const ORDER_PATH = workflowFilePath("Order resource flow");
    const testOpts = { messagingTransport: "test" };

    // ------------------------------------------------ 1. canonical resource path
    h.check("1 canonical workflow resource path",
      ORDER_PATH === "base44/workflows/Order resource flow.jsonc" && isWorkflowFilePath(ORDER_PATH) &&
      workflowNameFromPath(ORDER_PATH) === "Order resource flow" && workflowKeyFromPath(ORDER_PATH) === "order-resource-flow" &&
      !isWorkflowFilePath("base44/workflows/nested/deep.jsonc") && !isWorkflowFilePath("base44/entities/Note.jsonc") &&
      !isWorkflowFilePath("functions/orderNotify.js") && !isWorkflowFilePath("src/pages/home.js"),
      `${ORDER_PATH} → key ${workflowKeyFromPath(ORDER_PATH)}; no other resource kind matches`);

    // ------------------------------------------------ 2. the filesystem accepts it
    const fs = createFs([]);
    writeFile(fs, ENTRY_FILE, "export default function App() { return null; }");
    writeFile(fs, "functions/orderNotify.js", FN_NOTIFY);
    writeFile(fs, ORDER_PATH, DOC_ORDER);
    const rejectedWrite = (() => { try { writeFile(fs, "base44/workflows/bad.json", "{}"); return null; } catch (e) { return e; } })();
    const rejectedNested = (() => { try { writeFile(fs, "base44/workflows/deep/flow.jsonc", "{}"); return null; } catch (e) { return e; } })();
    h.check("2 the project filesystem accepts only canonical workflow resources",
      activeFiles(fs).some((f) => f.path === ORDER_PATH) && !!rejectedWrite && !!rejectedNested &&
      /base44\/workflows\/<Name>\.jsonc/.test(rejectedWrite.message),
      "the canonical document is writable; a wrong extension and a nested path are refused with a stated reason");

    // ------------------------------------------------ 3. parse + deterministic emit
    const parsed = parseWorkflowDocument(ORDER_PATH, DOC_ORDER);
    const emitted = workflowDocumentContent(parsed.definition);
    const reparsed = parseWorkflowDocument(ORDER_PATH, emitted);
    h.check("3 a document parses into the existing definition shape and round-trips",
      parsed.ok && parsed.definition.steps.length === 4 && parsed.definition.entry_step === "gate" &&
      parsed.definition.trigger.type === "app_event" && parsed.workflow_key === "order-resource-flow" &&
      parsed.definition_checksum === workflowChecksum(parsed.definition) &&
      reparsed.ok && reparsed.definition_checksum === parsed.definition_checksum &&
      workflowDocumentContent(reparsed.definition) === emitted,
      `checksum ${parsed.definition_checksum} is stable across an emit/parse round-trip`);

    // ------------------------------------------------ 4. malformed documents are refused
    const malformed = parseWorkflowDocument(workflowFilePath("Broken"), DOC_MALFORMED);
    const unknownKey = parseWorkflowDocument(workflowFilePath("Odd"), DOC_UNKNOWN_KEY);
    const badContract = parseWorkflowDocument(workflowFilePath("Old"), JSON.stringify({ name: "Old", contract_version: "nope", steps: [] }));
    const dup = validateWorkflowFiles([
      { path: workflowFilePath("Same name"), content: DOC_ORDER },
      { path: workflowFilePath("same-name"), content: DOC_ORDER },
    ], { functionNames: ["orderNotify"] });
    h.check("4 malformed workflow documents are rejected with a stated reason",
      !malformed.ok && /valid JSONC/.test(malformed.error) &&
      !unknownKey.ok && /unrecognised key/.test(unknownKey.error) &&
      !badContract.ok && /contract/.test(badContract.error) &&
      dup.ok === false && dup.errors.some((e) => /resolves to the same workflow/.test(e)),
      `${malformed.error} | ${unknownKey.error} | duplicate lineage refused`);

    // ------------------------------------------------ 5. validation uses the EXISTING validator
    const invalidReport = validateWorkflowFiles([{ path: workflowFilePath("Unrunnable"), content: DOC_INVALID }], { functionNames: ["orderNotify"] });
    const validReport = validateWorkflowFiles([{ path: ORDER_PATH, content: DOC_ORDER }], { functionNames: ["orderNotify"] });
    h.check("5 workflow documents validate through the existing validator",
      validReport.ok && validReport.count === 1 && validReport.workflows[0].report.contract_version === WORKFLOW_CONTRACT_VERSION &&
      invalidReport.ok === false &&
      ["function_references", "step_references", "entry_step", "trigger"].every((c) => invalidReport.workflows[0].report.failed_checks.includes(c)),
      `invalid document failed: ${invalidReport.workflows[0].report.failed_checks.join(", ")}`);

    // ------------------------------------------------ 6. build integration
    const goodBuild = runBuild(fs, [], []);
    const badFs = createFs([]);
    writeFile(badFs, ENTRY_FILE, "export default function App() { return null; }");
    writeFile(badFs, workflowFilePath("Unrunnable"), DOC_INVALID);
    const badBuild = runBuild(badFs, [], []);
    const noWorkflowFs = createFs([]);
    writeFile(noWorkflowFs, ENTRY_FILE, "export default function App() { return null; }");
    const plainBuild = runBuild(noWorkflowFs, [], []);
    h.check("6 the build validates workflow resources and is unchanged without them",
      goodBuild.status === "success" && goodBuild.logs.some((l) => l.startsWith("[workflows] 1/1")) &&
      badBuild.status === "failed" && badBuild.logs.some((l) => l.includes("Unrunnable")) &&
      plainBuild.status === "success" && !plainBuild.logs.some((l) => l.startsWith("[workflows]")),
      `valid → ${goodBuild.status}; invalid → ${badBuild.status} with ${badBuild.errors} error(s); no workflow files → ${plainBuild.status}`);

    // ------------------------------------------------ 7. persist + load
    for (const f of activeFiles(fs)) await svc.entities.ProjectFile.create({ project_id: project.id, path: f.path, content: f.content });
    const loaded = await loadWorkflowResources(base44, { project_id: project.id });
    h.check("7 resources persist as project files and load back",
      loaded.ok && loaded.count === 1 && loaded.workflows[0].path === ORDER_PATH &&
      loaded.workflows[0].definition_checksum === parsed.definition_checksum &&
      collectWorkflowFiles(await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).length === 1,
      "the stored document loads, validates against the project's real functions and keeps its checksum");

    // ------------------------------------------------ 8. sync → finalized definition
    const sync1 = await syncWorkflowResources(base44, user, { project_id: project.id });
    const definition = await getWorkflow(base44, user, { workflow_definition_id: sync1.workflows[0].workflow_definition_id });
    h.check("8 a resource file becomes a finalized definition",
      sync1.ok && sync1.created === 1 && sync1.workflows[0].action === "created" &&
      definition.status === "FINALIZED" && definition.version === 1 && definition.workflow_key === "order-resource-flow" &&
      definition.steps.length === 4 && definition.trigger_type === "app_event" && definition.trigger_event === "order.resource" &&
      // file ↔ stored definition compares on the normalized resource fingerprint, while the stored
      // definition still carries the EXISTING engine checksum, unchanged.
      resourceChecksum(definition) === parsed.definition_checksum &&
      definition.definition_checksum === workflowChecksum(definition) && definition.validation?.ok === true,
      `${definition.workflow_key} v${definition.version} (${definition.status}) from ${ORDER_PATH}; stored checksum ${definition.definition_checksum} is still the engine's own`);

    // ------------------------------------------------ 9. idempotent re-sync
    const sync2 = await syncWorkflowResources(base44, user, { project_id: project.id });
    const afterResync = await svc.entities.WorkflowDefinition.filter({ project_id: project.id, workflow_key: "order-resource-flow" }, "-version", 20);
    h.check("9 re-syncing an unchanged resource creates no version",
      sync2.ok && sync2.unchanged === 1 && sync2.created === 0 && sync2.versioned === 0 &&
      afterResync.length === 1 && afterResync[0].id === definition.workflow_definition_id,
      "the checksum matched the finalized version, so nothing was written");

    // ------------------------------------------------ 10/11. trigger + execute through the engine
    const run = await triggerWorkflow(base44, user, {
      workflow_definition_id: definition.workflow_definition_id, payload: { total: 500 },
      idempotency_key: "resource-run-1", inline: true, options: testOpts,
    });
    const runRow = await getWorkflowRun(base44, user, { workflow_run_id: run.workflow_run_id });
    const notifyStep = runRow.steps.find((s) => s.step_id === "notify");
    h.check("10 a file-authored workflow executes on the existing engine",
      runRow.status === "COMPLETED" && runRow.output?.path === "large" && runRow.output.notified === true &&
      runRow.workflow_version === 1 && runRow.definition_checksum === definition.definition_checksum &&
      notifyStep?.status === "succeeded" && !!notifyStep.function_invocation_id &&
      (await svc.entities.FunctionInvocation.get(notifyStep.function_invocation_id)).function_name === "orderNotify",
      `run ${runRow.workflow_run_id} → ${runRow.status} via the existing durable executor`);
    const smallRun = await triggerWorkflow(base44, user, {
      workflow_definition_id: definition.workflow_definition_id, payload: { total: 40 },
      idempotency_key: "resource-run-2", inline: true, options: testOpts,
    });
    const spans = await svc.entities.TraceEvent.filter({ project_id: project.id }, "-created_date", 100);
    const auditRows = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 100);
    h.check("11 state, branching and logging are the existing engine's",
      smallRun.status === "COMPLETED" && smallRun.output?.path === "small" && !smallRun.context?.steps?.notify &&
      runRow.context?.steps?.gate?.result === true &&
      spans.some((s) => String(s.name).startsWith("workflow.")) &&
      ["workflow.created", "workflow.finalized", "workflow.triggered", "workflow.run_completed", "workflow.resource_synced"]
        .every((a) => auditRows.some((r) => r.action === a)),
      `small=${smallRun.status}/${smallRun.output?.path} notifySkipped=${!smallRun.context?.steps?.notify} gate=${JSON.stringify(runRow.context?.steps?.gate)} spans=${spans.filter((s) => String(s.name).startsWith("workflow.")).length} audits=${[...new Set(auditRows.map((r) => r.action))].join(",")}`);

    // ------------------------------------------------ 12. a changed file is a NEW version
    const [wfRow] = await svc.entities.ProjectFile.filter({ project_id: project.id, path: ORDER_PATH }, "path", 1);
    await svc.entities.ProjectFile.update(wfRow.id, { content: DOC_ORDER_V2 });
    const sync3 = await syncWorkflowResources(base44, user, { project_id: project.id });
    const versions = await svc.entities.WorkflowDefinition.filter({ project_id: project.id, workflow_key: "order-resource-flow" }, "-version", 20);
    const v1 = versions.find((d) => d.version === 1);
    const v2 = versions.find((d) => d.version === 2);
    const pinnedRun = await getWorkflowRun(base44, user, { workflow_run_id: run.workflow_run_id });
    h.check("12 an edited resource lands as the next version and never rewrites v1",
      sync3.ok && sync3.versioned === 1 && v2?.status === "FINALIZED" && v1?.status === "SUPERSEDED" &&
      resourceChecksum(v1) === parsed.definition_checksum && v2.definition_checksum !== v1.definition_checksum &&
      v1.steps.find((s) => s.id === "gate").condition.right === 100 &&
      v2.steps.find((s) => s.id === "gate").condition.right === 200 &&
      pinnedRun.workflow_version === 1 && pinnedRun.definition_checksum === v1.definition_checksum,
      `v1 ${v1?.status} / v2 ${v2?.status}; the completed run still names the version it executed`);

    // ------------------------------------------------ 13. an invalid file finalizes nothing
    await svc.entities.ProjectFile.create({ project_id: project.id, path: workflowFilePath("Unrunnable"), content: DOC_INVALID });
    await svc.entities.ProjectFile.create({ project_id: project.id, path: workflowFilePath("Malformed"), content: DOC_MALFORMED });
    const sync4 = await syncWorkflowResources(base44, user, { project_id: project.id });
    const unrunnable = await svc.entities.WorkflowDefinition.filter({ project_id: project.id, workflow_key: "unrunnable" }, "-version", 5);
    h.check("13 an invalid or malformed resource is reported and finalizes nothing",
      sync4.ok === false && sync4.failed === 2 && sync4.unchanged === 1 &&
      sync4.workflows.filter((w) => !w.ok).every((w) => w.action === "rejected" && w.errors.length > 0) &&
      unrunnable.every((d) => d.status !== "FINALIZED"),
      `${sync4.failed} document(s) refused while the valid workflow stayed untouched`);

    // ------------------------------------------------ 14. legacy / API-authored compatibility
    const legacyDraft = await createWorkflow(base44, user, {
      project_id: project.id, name: "Legacy automation", trigger: { type: "manual" }, entry_step: "fin",
      steps: [{ id: "fin", type: "complete", output: { legacy: true } }],
    });
    const legacy = await finalizeWorkflow(base44, user, { workflow_definition_id: legacyDraft.workflow_definition_id });
    const legacyRun = await triggerWorkflow(base44, user, { workflow_definition_id: legacy.workflow_definition_id, payload: {}, inline: true, options: testOpts });
    const sync5 = await syncWorkflowResources(base44, user, { project_id: project.id });
    const legacyAfter = await getWorkflow(base44, user, { workflow_definition_id: legacy.workflow_definition_id });
    h.check("14 legacy API-authored automations keep working and are untouched by sync",
      legacy.status === "FINALIZED" && legacyRun.status === "COMPLETED" && legacyRun.output?.legacy === true &&
      legacyAfter.status === "FINALIZED" && legacyAfter.version === 1 &&
      !sync5.workflows.some((w) => w.workflow_key === "legacy-automation") &&
      (await listWorkflows(base44, user, { project_id: project.id })).count >= 2,
      "a workflow with no resource file still runs, keeps its version and is never rewritten or removed by a sync");

    // ------------------------------------------------ 15. export direction
    const exported = exportWorkflowResource(legacyAfter);
    const exportedParse = parseWorkflowDocument(exported.path, exported.content);
    h.check("15 an existing definition can be adopted as a resource file",
      exported.path === workflowFilePath("Legacy automation") && exportedParse.ok &&
      exportedParse.definition_checksum === resourceChecksum(legacyAfter) &&
      isWorkflowFilePath(exported.path),
      `${exported.path} reproduces checksum ${exportedParse.definition_checksum}`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["WorkflowStepRun", "WorkflowRun", "WorkflowDefinition", "PrimitiveInvocation", "AIOperation", "BackgroundJob", "ScheduledTrigger", "FunctionInvocation", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["WorkflowStepRun", "WorkflowRun", "WorkflowDefinition", "CreditLedgerEntry", "WorkspaceMember", "AuditLog", "TraceEvent", "Project"]);
    }
  }
}