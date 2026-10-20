// NexusAI Architecture Intelligence API.
//
// Thin authenticated boundary: every action authorizes the caller against the owning project
// through the platform's existing authorization path, resolves the workspace server-side, and
// delegates to the governed architecture layer. Client-supplied ownership fields are never trusted.
//
// This API only reads and derives. It never mutates project files, entity declarations, builds,
// deployments, memory, trajectories, evaluations, rewards, datasets or benchmarks.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  reconcileArchitecture, getArchitecture, listArchitectureVersions, diffArchitectureVersions,
  queryNodes, queryDependencies, getSubgraph, runImpactAnalysis, runConsistencyCheck,
  createImplementationPlan, getImplementationPlan, listImplementationPlans, retrieveArchitectureContext,
  getPrimitiveCapabilities, validatePrimitiveComposition, createPrimitiveExecutionPlan,
  ARCH_LIMITS,
} from "../../shared/architecture.ts";
import { NODE_TYPES, RELATIONSHIP_TYPES, PROVENANCE_STATES, PROVENANCE_SOURCES, EXTRACTION_VERSION, ARCHITECTURE_SCHEMA_VERSION } from "../../shared/architectureGraph.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = body.action || "capabilities";

  // Public contract metadata only — no project data, so no authentication is required.
  if (action === "capabilities") {
    return Response.json({
      extraction_version: EXTRACTION_VERSION, schema_version: ARCHITECTURE_SCHEMA_VERSION,
      node_types: NODE_TYPES, relationship_types: RELATIONSHIP_TYPES,
      provenance_states: PROVENANCE_STATES, provenance_sources: PROVENANCE_SOURCES,
      limits: ARCH_LIMITS,
    });
  }

  // The AI App Primitives catalog (#27) is contract metadata exactly like the graph capabilities
  // above — no project data, no credentials — so it stays on the same public contract path.
  if (action === "primitive_capabilities") {
    try {
      return Response.json(getPrimitiveCapabilities(body));
    } catch (e) {
      return Response.json({ error: e.message, code: e.code || "ERROR" }, { status: e.status || 500 });
    }
  }

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });

    switch (action) {
      case "reconcile": return Response.json(await reconcileArchitecture(base44, user, body));
      case "get": return Response.json(await getArchitecture(base44, user, body));
      case "versions": return Response.json(await listArchitectureVersions(base44, user, body));
      case "diff": return Response.json(await diffArchitectureVersions(base44, user, body));
      case "query_nodes": return Response.json(await queryNodes(base44, user, body));
      case "query_dependencies": return Response.json(await queryDependencies(base44, user, body));
      case "subgraph": return Response.json(await getSubgraph(base44, user, body));
      case "impact": return Response.json(await runImpactAnalysis(base44, user, body));
      case "consistency": return Response.json(await runConsistencyCheck(base44, user, body));
      case "create_plan": return Response.json(await createImplementationPlan(base44, user, body));
      case "get_plan": return Response.json(await getImplementationPlan(base44, user, body));
      case "list_plans": return Response.json(await listImplementationPlans(base44, user, body));
      case "context": return Response.json(await retrieveArchitectureContext(base44, user, body));
      // Capability composition + primitive-aware planning. Both authorize through the SAME project
      // path as every other action and delegate to the existing capability layer — no new planner.
      case "validate_primitives": return Response.json(await validatePrimitiveComposition(base44, user, body));
      case "plan_primitives": return Response.json(await createPrimitiveExecutionPlan(base44, user, body));
      default: return Response.json({ error: `Unknown action: ${action}`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || "ERROR" }, { status: e.status || 500 });
  }
}