// The BRIDGE between the Base44 workflow resource file and the EXISTING NexusAI workflow system.
//
// This module owns no workflow behaviour of its own. It reads the project's own workflow resource
// documents through the pure resource contract (workflowResource.ts) and then goes through the
// EXISTING authorized API (workflowApi.ts) to create and finalize definitions — which is what keeps
// every guarantee those paths already carry:
//   • authorization is re-resolved server-side per call (createWorkflow / finalizeWorkflow)
//   • a finalized version stays IMMUTABLE: a changed file lands as the NEXT version, never a rewrite
//   • validation runs in finalizeWorkflow against authoritative project state, so an invalid
//     document can never become runnable
//   • a scheduled workflow registers through the EXISTING ScheduleTask primitive
//   • triggering, execution, state, retries, logs and tracing remain entirely the existing engine's
//
// Nothing here starts, advances or observes a run: once a document is finalized it IS an ordinary
// definition, and the existing trigger/dispatch/engine paths pick it up unchanged.
import { audit } from "./authz.ts";
import { scrub } from "./tracing.ts";
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";
import { createWorkflow, finalizeWorkflow, publicDefinition } from "./workflowApi.ts";
import {
  collectWorkflowFiles, parseWorkflowDocument, validateWorkflowFiles, resourceChecksum,
  workflowDocumentContent, workflowFilePath, workflowKeyFromPath, isWorkflowFilePath,
} from "./workflowResource.ts";

const svcOf = (b) => b.asServiceRole || b;

/** The project's own files, used when the caller has no in-memory file set (the load path). */
async function projectFiles(svc, project_id) {
  const rows = await svc.entities.ProjectFile.filter({ project_id }, "path", 500).catch(() => []);
  const out = [];
  for (const r of rows) {
    if (!isWorkflowFilePath(r.path) && !isFunctionPath(r.path)) continue;
    out.push({ path: r.path, content: r.content || "", id: r.id });
  }
  return out;
}

/**
 * Reads and validates the project's workflow resources WITHOUT writing anything: the load/restore
 * path. Function steps are verified against the project's real functions, so a report from here
 * means the same thing finalization would decide.
 */
export async function loadWorkflowResources(base44, { project_id, files = null } = {}) {
  const svc = svcOf(base44);
  const all = files || await projectFiles(svc, String(project_id));
  const functionNames = all.filter((f) => isFunctionPath(f.path)).map((f) => functionNameFromPath(f.path));
  const report = validateWorkflowFiles(all, { functionNames });
  return { project_id: String(project_id), ...report };
}

/**
 * Materializes the project's workflow resource files into finalized definitions.
 *
 * Idempotent by CHECKSUM: a document whose fingerprint already matches a finalized version of the
 * same lineage is left completely alone, so re-syncing an unchanged project creates no version and
 * touches no run. A changed document produces the next version through the existing API; the prior
 * finalized version is superseded by that API and its in-flight runs keep executing it.
 *
 * A document that cannot parse or cannot validate is REPORTED and skipped — never partially applied,
 * and never finalized. Deleting a file removes no definition: existing definitions and their run
 * history stay readable, so legacy and API-authored workflows are unaffected by this path.
 */
export async function syncWorkflowResources(base44, user, { project_id, files = null } = {}) {
  const svc = svcOf(base44);
  // One read of the project's files for the whole sync, so a sync is a bounded amount of work
  // regardless of how many workflows the project declares.
  const all = files || await projectFiles(svc, String(project_id));
  const loaded = await loadWorkflowResources(base44, { project_id, files: all });
  const byPath = new Map(collectWorkflowFiles(all).map((f) => [f.path, f.content]));
  // The audit entry belongs to the project's OWNING workspace, resolved server-side from the project
  // row (never from a caller), so a resource sync is recorded in the same workspace-scoped audit
  // trail as every other workflow action.
  const workspace_id = (await svc.entities.Project.get(String(project_id)).catch(() => null))?.workspace_id || null;
  const results = [];

  for (const wf of loaded.workflows) {
    if (!wf.ok) { results.push({ path: wf.path, ok: false, action: "rejected", errors: wf.errors }); continue; }
    const parsed = parseWorkflowDocument(wf.path, byPath.get(wf.path) ?? "");
    if (!parsed.ok) { results.push({ path: wf.path, ok: false, action: "rejected", errors: [`${wf.path} ${parsed.error}`] }); continue; }

    const siblings = await svc.entities.WorkflowDefinition.filter({ project_id: String(project_id), workflow_key: parsed.workflow_key }, "-version", 50).catch(() => []);
    // Compared on the NORMALIZED fingerprint (a stored definition carries every optional step field
    // as null), so only a real configuration change is treated as a change.
    const finalizedMatch = siblings.find((d) => d.status === "FINALIZED" && resourceChecksum(publicDefinition(d)) === parsed.definition_checksum);
    if (finalizedMatch) {
      results.push({ path: wf.path, ok: true, action: "unchanged", workflow_key: parsed.workflow_key, version: finalizedMatch.version, workflow_definition_id: finalizedMatch.id, definition_checksum: finalizedMatch.definition_checksum });
      continue;
    }

    // The EXISTING create + finalize path: authorization, versioning, validation, supersession and
    // schedule registration are all that path's, not this one's.
    try {
      const draft = await createWorkflow(base44, user, { project_id: String(project_id), workflow_key: parsed.workflow_key, ...parsed.definition });
      const finalized = await finalizeWorkflow(base44, user, { workflow_definition_id: draft.workflow_definition_id });
      results.push({
        path: wf.path, ok: true, action: siblings.length ? "versioned" : "created",
        workflow_key: finalized.workflow_key, version: finalized.version,
        workflow_definition_id: finalized.workflow_definition_id,
        definition_checksum: finalized.definition_checksum,
        scheduled_trigger_id: finalized.scheduled_trigger_id || null,
      });
      await audit(svc, {
        workspace_id, project_id: String(project_id), user_id: user?.id || null,
        action: "workflow.resource_synced", resource: "WorkflowDefinition", resource_id: finalized.workflow_definition_id,
        metadata: scrub({ path: wf.path, workflow_key: finalized.workflow_key, version: finalized.version, checksum: finalized.definition_checksum }),
      }).catch(() => {});
    } catch (e) {
      results.push({ path: wf.path, ok: false, action: "failed", errors: [`${wf.path} could not be finalized: ${e.code || e.message}`], code: e.code || null });
    }
  }

  return {
    project_id: String(project_id),
    ok: results.every((r) => r.ok),
    created: results.filter((r) => r.action === "created").length,
    versioned: results.filter((r) => r.action === "versioned").length,
    unchanged: results.filter((r) => r.action === "unchanged").length,
    failed: results.filter((r) => !r.ok).length,
    workflows: results,
  };
}

/**
 * The other direction: an EXISTING definition (however it was authored) emitted as its resource
 * file, so a workflow that lives only in the database can be adopted into the project's files and
 * then travels with the project's versions like any other resource.
 */
export function exportWorkflowResource(definition) {
  const d = definition.steps ? definition : publicDefinition(definition);
  const name = String(d.name || d.workflow_key || "Workflow").replace(/[^A-Za-z0-9 _-]/g, "").trim() || "Workflow";
  return { path: workflowFilePath(name), content: workflowDocumentContent(d), workflow_key: workflowKeyFromPath(workflowFilePath(name)) };
}

export { collectWorkflowFiles, isWorkflowFilePath, workflowFilePath };