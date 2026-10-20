// Background deployment worker: advances one deployment through its phases and reports
// whether more work remains. Invoked repeatedly by the "Deployment Executor" workflow, so a
// deployment's lifetime is not bounded by any HTTP request. Authorization happened when the
// deployment was created; this worker acts with the service role on persisted ids only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runDeploymentStep } from "../../shared/deploy.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

export default async function (req) {
  // G-3: the worker boundary is authenticated before anything is touched.
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  try {
    const { deployment_id } = await req.json();
    if (!deployment_id) return Response.json({ error: "deployment_id is required" }, { status: 400 });
    return Response.json(await runDeploymentStep(base44.asServiceRole, deployment_id));
  } catch (error) {
    return Response.json({ error: error.message, done: true }, { status: 500 });
  }
}