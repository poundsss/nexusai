// Builder freeze toggle: { project_id, updates: [{ file_id, frozen }] } → { updated }.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { projectFileFreeze } from "../../shared/projectFileFreeze.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    return Response.json(await projectFileFreeze(base44, user, body.project_id, body.updates));
  } catch (e) {
    const status = Number(e?.status) || 500;
    return Response.json({ error: status === 500 ? "Failed to update files" : e.message, code: e.code }, { status });
  }
}