// Project creation endpoint. The whole record set (Project, scaffold files, version 1 and the
// audit entry) is written server-side by shared/projectCreate.ts, which derives the acting user
// from the session and authorizes the workspace by membership.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createProjectForUser } from "../../shared/projectCreate.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Sign in to create a project", code: "AUTH_REQUIRED" }, { status: 401 });

    const body = await req.json();
    const out = await createProjectForUser(base44, user, {
      workspace_id: body.workspace_id, name: body.name, description: body.description,
    });
    return Response.json({ project: out.project, version_number: out.version.number, files_created: out.files_created });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}