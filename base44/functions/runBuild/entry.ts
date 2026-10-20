// Manual build: validates the current project state and records a Build.
// The sequence itself lives in shared/buildCommand.ts, shared with the CLI `build` command.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { buildProjectForUser } from "../../shared/buildCommand.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const { project_id: _pid, ...build } = await buildProjectForUser(base44, user, { project_id: body.project_id });
    return Response.json(build);
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}