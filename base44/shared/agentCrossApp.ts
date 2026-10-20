// Superagent parity: the cross-app READ capability.
//
// A declared agent may be granted `cross_app_access: [<project ids>]` — read access to OTHER
// apps of the SAME workspace. This module owns the read hook the agent loop exposes through the
// read_app_data tool (shared/tools.ts); the tool itself gates execution on this hook existing,
// so an agent without grants can never reach another app's data. It runs no tool itself and
// holds no state.
//
// Trust model: the grants are the agent document's own — a project-level configuration the
// project's writers chose, validated at editor-save time (same workspace, live projects) and
// RE-CHECKED here against the live projects on every call, so a grant written before a project
// was deleted or moved reads as a refusal, not silent access. Reads run under the loop's
// service-role identity and are attributed to the run — app-user RLS inside the target app is
// not applied, because the reader is the workspace member, not an end user of that app.
import { toItem } from "./appData.ts";

const MAX_ROWS = 50;

export function makeCrossAppReader(svc, { workspace_id, project_id }) {
  const svcRole = svc?.asServiceRole || svc;
  const refused = (code, message) => {
    throw Object.assign(new Error(message), { code });
  };

  return async function read({ project_id: targetProjectId, entity, query = null, limit = null } = {}) {
    const target = String(targetProjectId || "");
    if (!target || target === String(project_id)) refused("CROSS_APP_TARGET_INVALID", "read_app_data targets ANOTHER app — this project's own data is read through its own tools");
    const targetProject = await svcRole.entities.Project.get(target).catch(() => null);
    if (!targetProject || targetProject.status === "archived") refused("CROSS_APP_TARGET_INVALID", `the granted app '${target}' does not exist or is deleted`);
    if (targetProject.workspace_id !== workspace_id) refused("CROSS_APP_TARGET_INVALID", "the granted app belongs to a different workspace — grants never bridge workspaces");

    const entityName = String(entity || "").trim();
    if (!entityName) refused("CROSS_APP_ENTITY_UNKNOWN", "an entity name is required");
    const def = (await svcRole.entities.AppEntity.filter({ project_id: targetProject.id, name: entityName }, "-created_date", 1).catch(() => []))[0];
    if (!def) refused("CROSS_APP_ENTITY_UNKNOWN", `the target app declares no entity '${entityName}'`);

    // Bounded equality query: a handful of scalar filters, nothing computed, nothing nested.
    const filter = { project_id: targetProject.id, entity_name: entityName };
    if (query != null) {
      if (typeof query !== "object" || Array.isArray(query)) refused("CROSS_APP_QUERY_INVALID", "'query' must be a JSON object of equality filters");
      for (const [k, v] of Object.entries(query).slice(0, 5)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) refused("CROSS_APP_QUERY_INVALID", `query field '${k}' is not a valid field name`);
        if (v == null || typeof v === "object" || typeof v === "function") refused("CROSS_APP_QUERY_INVALID", `query field '${k}' must be a scalar value`);
        filter[k] = v;
      }
    }

    const rows = await svcRole.entities.AppRecord.filter(filter, "-created_date", Math.max(1, Math.min(Number(limit) || MAX_ROWS, MAX_ROWS))).catch(() => null);
    if (!rows) refused("CROSS_APP_READ_FAILED", `reading '${entityName}' records failed`);
    // Records live in AppRecord rows; the app's fields are the `data` blob. Trashed records are
    // already excluded (their entity_name is renamed to 'TRASH:<entity>' while trashed).
    const records = rows.map((r) => toItem(r)).slice(0, MAX_ROWS);
    return { app: targetProject.id, app_name: targetProject.name || null, entity: entityName, count: records.length, records };
  };
}