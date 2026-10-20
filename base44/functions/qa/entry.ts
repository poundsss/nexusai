// Autonomous QA API (#35) + Testing Agent (non-browser parity). One authorized entry point for
// generating a test plan, executing it, (optionally) letting the platform repair what it found,
// producing AI test suggestions, and deleting QA results.
//
// Authorization is resolved SERVER-side against the project's workspace on every action, and the
// heavy lifting is delegated to shared/qa.ts — which itself only composes existing infrastructure
// (build engine, runtime verifier, execution contract, version store, AI run pipeline, InvokeLLM).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, loadProjectState, audit } from "../../shared/authz.ts";
import { createFs } from "../../shared/projectFs.ts";
import { enqueueRun } from "../../shared/runEnqueue.ts";
import { newTraceId } from "../../shared/tracing.ts";
import { generateTestPlan, executeQa, aiRunFixer, listQaRuns, suggestTests, deleteQaRun, MAX_QA_REPAIR_ATTEMPTS, QA_CATEGORIES } from "../../shared/qa.ts";

const publicQaRun = (r) => ({
  id: r.id, project_id: r.project_id, status: r.status, terminated_by: r.terminated_by,
  base_version_number: r.base_version_number ?? null,
  known_good_version_number: r.known_good_version_number ?? null,
  final_version_number: r.final_version_number ?? null,
  test_count: r.test_count || 0, passed: r.passed || 0, failed: r.failed || 0, skipped: r.skipped || 0,
  categories_failed: r.categories_failed || [], repair_attempts: r.repair_attempts || 0,
  max_repair_attempts: r.max_repair_attempts ?? MAX_QA_REPAIR_ATTEMPTS,
  repair_log: r.repair_log || [], plan: r.plan || [], results: r.results || [],
  trace_id: r.trace_id || null, duration_ms: r.duration_ms || 0, completed_at: r.completed_at || null,
  created_date: r.created_date,
});

const READ_ACTIONS = new Set(["list", "get", "plan", "suggest", "categories"]);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "run");
    const projectId = String(body.project_id || "");

    // Reading history, previewing the plan or generating AI suggestions is a project READ;
    // executing tests runs real generated code and deleting results mutates state, so both are
    // project WRITE.
    const capability = READ_ACTIONS.has(action) ? "project.read" : "project.write";
    const { project, workspace } = await loadAuthorizedProject(base44, user, projectId, capability);

    if (action === "categories") return Response.json({ categories: QA_CATEGORIES, max_repair_attempts: MAX_QA_REPAIR_ATTEMPTS });

    if (action === "list") {
      const rows = await listQaRuns(svc, project.id, Number(body.limit) || 20);
      return Response.json({ qa_runs: rows.map(publicQaRun) });
    }

    if (action === "get") {
      const row = await svc.entities.QaRun.get(String(body.qa_run_id || "")).catch(() => null);
      // Project-scoped read: a QA run belonging to another project is simply not found here.
      if (!row || row.project_id !== project.id) return Response.json({ error: "QA run not found" }, { status: 404 });
      return Response.json({ qa_run: publicQaRun(row) });
    }

    const state = await loadProjectState(base44, project.id);
    const fs = createFs(state.files);

    if (action === "plan") {
      const plan = generateTestPlan({ fs, entities: state.entities, secrets: state.secrets });
      return Response.json({ plan: plan.tests, counts: plan.counts });
    }

    if (action === "suggest") {
      const prompt = String(body.prompt || "").slice(0, 500);
      if (!prompt.trim()) return Response.json({ error: "prompt is required" }, { status: 400, code: "PROMPT_REQUIRED" });
      const suggestions = await suggestTests(svc, { fs, entities: state.entities, secrets: state.secrets, prompt });
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: "qa.suggest", resource: "Project", resource_id: project.id,
        metadata: { count: suggestions.length },
      });
      return Response.json({ suggestions });
    }

    if (action === "delete") {
      const qa_run_id = String(body.qa_run_id || "");
      if (!qa_run_id) return Response.json({ error: "qa_run_id is required" }, { status: 400, code: "QA_RUN_ID_REQUIRED" });
      const out = await deleteQaRun(svc, { project_id: project.id, qa_run_id });
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: "qa.delete", resource: "QaRun", resource_id: qa_run_id, metadata: {},
      });
      return Response.json(out);
    }

    if (action === "run") {
      const repair = body.repair === true;
      const test_ids = Array.isArray(body.test_ids) && body.test_ids.length ? body.test_ids.map(String) : null;
      const out = await executeQa(base44, {
        project, workspace, user, fs, entities: state.entities, secrets: state.secrets,
        repair,
        max_repair_attempts: body.max_repair_attempts ?? MAX_QA_REPAIR_ATTEMPTS,
        test_ids,
        // Repair is delegated to the EXISTING AI run pipeline, which owns its own build/verify/
        // commit gates. QA never writes a patch of its own.
        fixer: repair ? aiRunFixer(base44, { project, enqueue: enqueueRun }) : null,
        trace_id: newTraceId(),
      });
      return Response.json({ qa_run: publicQaRun(out.qa_run), status: out.status, terminated_by: out.terminated_by });
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}