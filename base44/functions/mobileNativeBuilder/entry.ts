// External native mobile builder boundary — worker-facing HTTP surface.
//
// Authenticated by the EXISTING workerAuth mechanism (WORKER_SECRET or an x-workflow-run header).
// The four actions are the full contract a future real macOS/Linux builder needs:
//   enqueue  — attach a native build job to an existing QUEUED MobileBuild (idempotent per build)
//   claim    — claim the next native build job and receive the metadata-only input projection
//   heartbeat — extend the lease so a long native build is not reaped mid-flight
//   submit   — report the signed artifact back through the fail-closed result callback
//
// No Apple/Google API is called, no secret value is returned, and the existing mobile lifecycle
// is unchanged. The `.mobpkg` path continues to run for builds no native builder has claimed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";
import {
  enqueueNativeBuildJob, claimNativeBuildJob, heartbeatNativeBuildJob, submitNativeBuildResult,
} from "../../shared/mobileNativeBuilder.ts";

export default async function (req) {
  // The worker boundary is authenticated before anything is touched (G-3).
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "claim");

    if (action === "enqueue") {
      const out = await enqueueNativeBuildJob(base44, { build_id: body.build_id, trace_id: body.trace_id || null });
      return Response.json(out);
    }
    if (action === "claim") {
      const out = await claimNativeBuildJob(base44, { worker_id: body.worker_id || null });
      return Response.json(out);
    }
    if (action === "heartbeat") {
      if (!body.job_id || !body.lease_token) return Response.json({ error: "job_id and lease_token are required" }, { status: 400 });
      const out = await heartbeatNativeBuildJob(base44, body.job_id, body.lease_token);
      return Response.json(out);
    }
    if (action === "submit") {
      if (!body.job_id || !body.lease_token) return Response.json({ error: "job_id and lease_token are required" }, { status: 400 });
      const out = await submitNativeBuildResult(base44, body.job_id, body.lease_token, body.result || {});
      return Response.json(out);
    }
    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
  }
}