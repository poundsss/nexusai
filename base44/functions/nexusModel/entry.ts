// Nexus model API (#40): status, registration and evaluation interfaces for the platform's
// first-party model behind the existing Model Gateway.
//
//   status    — health, catalog/cost profile, real evidence and the activation checklist (any
//               authenticated user; the response is read-only and carries no secrets).
//   register  — platform admin: mirrors the catalog (incl. Nexus) into ModelCatalogEntry through the
//               EXISTING append-only sync. Nothing else can flip Nexus active — that is a reviewed
//               code change gated by the checklist.
//   evaluate  — creates a #39 candidate evaluation for nexus-1 on a finalized evaluation dataset.
//               It reads real records only; with no Nexus executions it reports no_evidence, never
//               a score.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { nexusStatus, NEXUS_MODEL_ID } from "../../shared/nexusProvider.ts";
import { syncCatalog } from "../../shared/modelCatalog.ts";
import { requirePlatformAdmin } from "../../shared/platformAdmin.ts";
import { audit } from "../../shared/authz.ts";
import { createCandidateEvaluation } from "../../shared/candidateEvaluation.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action || "status";
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const svc = base44.asServiceRole;

    switch (action) {
      case "status":
        return Response.json(await nexusStatus(svc));
      case "register": {
        await requirePlatformAdmin(base44, user);
        const sync = await syncCatalog(svc);
        await audit(svc, { workspace_id: null, project_id: null, user_id: user.id, action: "nexus.catalog.registered", resource: "ModelCatalogEntry", resource_id: NEXUS_MODEL_ID, metadata: sync });
        return Response.json({ registered: true, model_id: NEXUS_MODEL_ID, sync, status: await nexusStatus(svc) });
      }
      case "evaluate":
        return Response.json(await createCandidateEvaluation(base44, user, {
          dataset_id: body.dataset_id, name: body.name || `nexus-1 candidate`,
          candidate: { model_id: NEXUS_MODEL_ID, model_version: body.model_version || null, routing_policy_version: body.routing_policy_version || null },
        }));
      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}