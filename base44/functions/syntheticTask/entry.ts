// Synthetic Task Generator API (#24) — server-side only.
//
// Every action is authorized against the owner project through the platform's existing
// authorization path, so workspace/project isolation is enforced on the server and never in the UI.
// Generation and validation only: nothing here executes a task against a model — execution belongs
// to the #23 Benchmark Harness, and `export_to_benchmark` hands tasks to its existing contract.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createTemplate, finalizeTemplate, listTemplateVersions, generateTask, validateTask, finalizeTask,
  getTask, listTaskVersions, createTaskSet, updateTaskSetMembership, finalizeTaskSet, getTaskSet,
  listTaskSets, exportTasksToBenchmark,
} from "../../shared/syntheticTasks.ts";
import {
  GENERATOR_VERSION, FIXTURE_VERSION, TASK_CATEGORIES, DIFFICULTIES, DIFFICULTY_KNOBS,
  CHECK_TYPES, INVARIANT_TYPES, OUTCOME_TYPES,
} from "../../shared/syntheticTemplates.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // Generator metadata is public: versions, categories and taxonomies — no task data.
    if (action === "capabilities") {
      return Response.json({
        generator_version: GENERATOR_VERSION, fixture_version: FIXTURE_VERSION,
        categories: TASK_CATEGORIES, difficulties: DIFFICULTIES, difficulty_knobs: DIFFICULTY_KNOBS,
        check_types: CHECK_TYPES, invariant_types: INVARIANT_TYPES, outcome_types: OUTCOME_TYPES,
      });
    }

    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });

    switch (action) {
      case "create_template": return Response.json(await createTemplate(base44, user, body));
      case "finalize_template": return Response.json(await finalizeTemplate(base44, user, body));
      case "template_versions": return Response.json(await listTemplateVersions(base44, user, body));
      case "generate": return Response.json(await generateTask(base44, user, body));
      case "validate": return Response.json(await validateTask(base44, user, body));
      case "finalize_task": return Response.json(await finalizeTask(base44, user, body));
      case "get_task": return Response.json(await getTask(base44, user, body));
      case "task_versions": return Response.json(await listTaskVersions(base44, user, body));
      case "create_task_set": return Response.json(await createTaskSet(base44, user, body));
      case "update_task_set": return Response.json(await updateTaskSetMembership(base44, user, body));
      case "finalize_task_set": return Response.json(await finalizeTaskSet(base44, user, body));
      case "get_task_set": return Response.json(await getTaskSet(base44, user, body));
      case "list_task_sets": return Response.json(await listTaskSets(base44, user, body));
      case "export_to_benchmark": return Response.json(await exportTasksToBenchmark(base44, user, body));
      default: return Response.json({ error: `Unknown action: ${action}`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "ERROR" }, { status: error.status || 500 });
  }
}