// Background worker for one GitHub source-control operation.
//
// Invoked by the Git Sync Executor workflow, never by the browser. It advances the run as
// far as one request window allows and persists every phase transition, so a killed worker
// resumes exactly where it stopped instead of redoing GitHub work.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runGitSyncStep } from "../../shared/gitSync.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

export default async function (req) {
  // G-3: the worker boundary is authenticated before anything is touched.
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const base44 = createClientFromRequest(req);
    const { sync_run_id } = await req.json();
    if (!sync_run_id) return Response.json({ error: "sync_run_id is required" }, { status: 400 });
    const result = await runGitSyncStep(base44.asServiceRole, sync_run_id);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, done: true }, { status: 500 });
  }
}