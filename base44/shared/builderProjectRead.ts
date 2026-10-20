// Builder read path (C-3.1 step 2): the Project record and its ProjectFile rows exactly as the
// builder's useProjectData previously read them directly (full records, sort "path", limit 500).
// Authorization is server-side via loadAuthorizedProject(project.read); rows are read with the
// service role and scoped to the authorized project id only. File content_url stays as-is —
// the client resolves out-of-band content exactly as before. No secrets, no other records.
// Optional path_prefix narrows the returned files; omitted, the response is unchanged.
import { loadAuthorizedProject } from "./authz.ts";

const badPrefix = () => Object.assign(new Error("Invalid path_prefix"), { status: 400, code: "INVALID_INPUT" });

export async function builderProjectRead(base44, user, projectId, pathPrefix) {
  if (pathPrefix !== undefined && pathPrefix !== null) {
    if (typeof pathPrefix !== "string" || !pathPrefix || pathPrefix.length > 200 || pathPrefix.startsWith("/") || pathPrefix.includes("..")) throw badPrefix();
  }
  const { project } = await loadAuthorizedProject(base44, user, projectId, "project.read");
  const svc = base44.asServiceRole || base44;
  const rows = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 500);
  const files = pathPrefix ? rows.filter((f) => f.path.startsWith(pathPrefix)) : rows;
  return { project, files };
}