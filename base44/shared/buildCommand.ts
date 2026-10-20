// THE authorized "build this project" command, shared by the runBuild endpoint and the CLI.
//
// Not a build engine: authorization is shared/authz, the build itself is shared/buildEngine, and the
// record is shared/persistence. This module only sequences them once, so a manual build from the
// Builder and a `build` from the CLI record the same Build row and stamp the project identically.
import { createFs } from "./projectFs.ts";
import { runBuild } from "./buildEngine.ts";
import { loadAuthorizedProject, loadProjectState } from "./authz.ts";
import { recordBuild } from "./persistence.ts";

export async function buildProjectForUser(base44, user, { project_id } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const state = await loadProjectState(base44, project.id);
  const build = runBuild(createFs(state.files), state.entities, state.secrets);
  const rec = await recordBuild(base44, project.id, null, build);
  await (base44.asServiceRole || base44).entities.Project.update(project.id, { last_build_status: build.status, status: build.status === "success" ? "ready" : "error" });
  return { build_id: rec.id, project_id: project.id, ...build };
}