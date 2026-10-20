// Platform health and operations endpoint.
//
// Authenticated only, and it returns AGGREGATES: queue depth, dead-letter counts, lease health,
// metric roll-ups and the caller's own rate-limit budget. No payloads, no identities, no
// customer data — a health endpoint must be safe to poll without becoming a data leak.
//
// Operator actions (replay a dead-lettered job, cancel a job, purge caches) require workspace
// ownership, because they change what the platform will execute.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { healthSnapshot, metricsSince } from "../../shared/observability.ts";
import { queueStats, replayDeadLetter, cancel, enqueue } from "../../shared/jobQueue.ts";
import { limitStatus, identityFor, enforceLimit } from "../../shared/apiLimits.ts";
import { purgeExpired, invalidateNamespace } from "../../shared/cache.ts";
import { resolveRole } from "../../shared/rbac.ts";
import { listDeadLetters } from "../../shared/maintenance.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "health");
  const identity = identityFor({ user });

  if (action === "health") {
    const [health, stats, limits] = await Promise.all([
      healthSnapshot(base44), queueStats(base44), limitStatus(base44, { identity }),
    ]);
    return Response.json({ ...health, queues: stats, limits });
  }

  if (action === "metrics") {
    return Response.json(await metricsSince(base44, { minutes: Math.min(120, Number(body.minutes) || 15) }));
  }

  if (action === "dead_letters") {
    return Response.json({ jobs: await listDeadLetters(base44, { queue: body.queue ? String(body.queue) : null }) });
  }

  // --- operator actions: workspace owner only ------------------------------
  const workspace_id = String(body.workspace_id || "");
  const workspace = workspace_id ? await svc.entities.Workspace.get(workspace_id).catch(() => null) : null;
  const role = workspace ? await resolveRole(svc, workspace, user) : null;
  if (role !== "owner") return Response.json({ error: "Only a workspace owner may perform infrastructure actions" }, { status: 403 });
  await enforceLimit(base44, { identity, action: "default", workspace_id });

  if (action === "replay_job") return Response.json({ job: await replayDeadLetter(base44, String(body.job_id)) });
  if (action === "cancel_job") return Response.json(await cancel(base44, String(body.job_id), { reason: body.reason || null }));
  if (action === "purge_cache") {
    return Response.json(body.namespace ? await invalidateNamespace(base44, String(body.namespace)) : await purgeExpired(base44));
  }
  if (action === "enqueue_maintenance") {
    const { job, duplicate } = await enqueue(base44, { queue: "maintenance", job_type: String(body.job_type), payload: body.payload || {}, idempotency_key: body.idempotency_key || null, workspace_id });
    return Response.json({ job_id: job.id, duplicate });
  }

  return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
}