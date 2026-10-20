// Dataset Builder API.
//
// Server-side only, and authorization is never taken from the client: a project-scoped dataset is
// authorized through the platform's existing project path, a platform-scoped dataset requires a
// platform admin plus explicitly approved projects. Reads return the dataset contract only —
// never a secret, never private memory, and never an unfinalized dataset as an export.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createDataset, buildDataset, validateDataset, finalizeDataset,
  getDataset, listDatasets, exportDataset, getLineage, datasetPolicies,
} from "../../shared/dataset.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action || "get";
    if (action === "policies") return Response.json(datasetPolicies());

    const user = await base44.auth.me();
    switch (action) {
      case "create": return Response.json(await createDataset(base44, user, body));
      case "build": return Response.json(await buildDataset(base44, user, body));
      case "validate": return Response.json(await validateDataset(base44, user, body));
      case "finalize": return Response.json(await finalizeDataset(base44, user, body));
      case "get": return Response.json(await getDataset(base44, user, body));
      case "list": return Response.json(await listDatasets(base44, user, body));
      case "export": return Response.json(await exportDataset(base44, user, body));
      case "lineage": return Response.json(await getLineage(base44, user, body));
      default: return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}