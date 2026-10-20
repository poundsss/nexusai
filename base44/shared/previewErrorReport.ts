// G1 step 1: persists a Builder Preview `runtime:error` report into RuntimeError through the
// existing persistRuntimeError. The project is authorized with the existing project.read path;
// run and version associations are accepted ONLY after server-side verification against that
// project, and the trace id is taken from the verified run, never from the client.
import { loadAuthorizedProject } from "./authz.ts";
import { persistRuntimeError } from "./tracing.ts";

const bad = (message, code) => Object.assign(new Error(message), { status: 400, code });

export async function reportPreviewError(base44, user, body = {}) {
  const svc = base44.asServiceRole || base44;
  const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) throw bad("message is required", "INVALID_INPUT");

  let run = null;
  if (body.run_id != null) {
    run = await svc.entities.AIRun.get(String(body.run_id)).catch(() => null);
    if (!run || run.project_id !== project.id) throw bad("run does not belong to this project", "INVALID_ASSOCIATION");
  }
  let version_number = project.version_count ?? null;
  if (body.version_number != null) {
    const n = Number(body.version_number);
    const rows = Number.isInteger(n) ? await svc.entities.ProjectVersion.filter({ project_id: project.id, number: n }, "-created_date", 1).catch(() => []) : [];
    if (!rows.length) throw bad("version does not belong to this project", "INVALID_ASSOCIATION");
    version_number = n;
  }

  // Environment and source are fixed server-side: this endpoint only accepts Builder Preview reports.
  const out = await persistRuntimeError(svc, {
    project, workspace_id: workspace.id, trace_id: run?.trace_id || null, run_id: run?.id || null,
    report: { message, kind: "error", environment: "preview", source: "preview_runtime", version_number, route: typeof body.route === "string" ? body.route : null, user_agent: typeof body.user_agent === "string" ? body.user_agent : null },
  });
  return { id: out.runtime_error.id, folded: out.folded };
}