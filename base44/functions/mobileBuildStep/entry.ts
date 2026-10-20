// Background mobile build worker (P-10.3, phase 1): advances one build through its phases and
// reports whether more work remains. Invoked repeatedly by the "Mobile Build Executor"
// workflow, so a build's lifetime is not bounded by any HTTP request. Authorization happened
// when the build was requested; this worker acts with the service role on persisted ids only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runMobileBuildStep } from "../../shared/mobileBuilds.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

export default async function (req) {
  // G-3: the worker boundary is authenticated before anything is touched.
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  try {
    const { build_id } = await req.json();
    if (!build_id) return Response.json({ error: "build_id is required" }, { status: 400 });
    return Response.json(await runMobileBuildStep(base44.asServiceRole, build_id));
  } catch (error) {
    return Response.json({ error: error.message, done: true }, { status: 500 });
  }
}