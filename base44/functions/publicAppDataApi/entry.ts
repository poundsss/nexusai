// Public app-data REST read endpoint (Phase 13A).
//
// DOCUMENTED (Base44): `GET /api/apps/{app_id}/entities/{entity_name}` with
// `Authorization: Bearer <PAT>`. This app's host maps the surface to its function path; the
// handler accepts BOTH the canonical path form (/api/apps/:app_id/entities/:entity_name) and
// query-parameter addressing (?app_id=…&entity_name=…), so the route shape is preserved.
//
// Fail closed: missing/wrong-scheme/malformed/unknown/revoked/expired/wrong-scope tokens are
// refused; GET only; no token material is ever logged or echoed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handlePublicAppDataGet, PatError } from "../../shared/pat.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const url = new URL(req.url);
    const pathApp = url.pathname.match(/\/api\/apps\/([^/]+)\/entities\/([^/?]+)/);
    const app_id = pathApp ? pathApp[1] : url.searchParams.get("app_id");
    const entity_name = pathApp ? pathApp[2] : url.searchParams.get("entity_name");
    let filter = null;
    const filterParam = url.searchParams.get("filter");
    if (filterParam) {
      try { filter = JSON.parse(filterParam); } catch {
        return Response.json({ error: "The filter parameter is not valid JSON", code: "PAT_BAD_FILTER" }, { status: 400 });
      }
    }
    const result = await handlePublicAppDataGet(base44, {
      method: req.method,
      authorization: req.headers.get("authorization"),
      app_id, entity_name, filter,
      sort: url.searchParams.get("sort"),
      limit: url.searchParams.get("limit"),
      skip: Number(url.searchParams.get("skip")) || 0,
    });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof PatError ? error.status : (error.status || 500);
    const code = error instanceof PatError ? error.code : (error.code || null);
    return Response.json({ error: error.message, code }, { status });
  }
}