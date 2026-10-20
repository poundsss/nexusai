// Authorized read/write surface for the trajectory (learning data) layer.
//
// Deliberately minimal: retrieve one episode, list a project's episodes, page an episode's event
// history, and record the human outcome that is only knowable after the run. Trajectories are
// STARTED, APPENDED TO and FINALIZED by the AI run pipeline itself — never by a client — so no
// endpoint here can forge an episode or rewrite recorded history.
//
// Every action authorizes the caller against the project through the platform's existing path
// (read for retrieval, write for labelling an outcome) and then filters by that project id, so one
// workspace can never reach another's trajectories. Responses are built from a field allowlist and
// carry no secret fields.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { getTrajectory, listTrajectories, listTrajectoryEvents, recordUserOutcome } from "../../shared/trajectory.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "get";

    if (action === "get") return Response.json(await getTrajectory(base44, user, body));
    if (action === "list") return Response.json(await listTrajectories(base44, user, body));
    if (action === "events") return Response.json(await listTrajectoryEvents(base44, user, body));
    if (action === "set_user_outcome") return Response.json(await recordUserOutcome(base44, user, body));
    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}