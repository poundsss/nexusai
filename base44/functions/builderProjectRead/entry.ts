// Builder read path: { project, files } for one authorized project (project.read).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { builderProjectRead } from "../../shared/builderProjectRead.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    return Response.json(await builderProjectRead(base44, user, body.project_id, body.path_prefix));
  } catch (e) {
    const status = Number(e?.status) || 500;
    return Response.json({ error: status === 500 ? "Failed to load project" : e.message, code: e.code }, { status });
  }
}