// THE actor control-plane surface (E8).
//
// One authorized command boundary for the stateful actor primitive: resolve → authorize → act.
// It creates NO permission model of its own. Authorization is the platform's EXISTING path
// (shared/authz → the rbac capability matrix): the caller must be authorized on the project for
// `project.read` to resolve or observe an actor at all, and an invocation additionally requires the
// capability the ACTOR RESOURCE declares. A read-scoped caller therefore cannot invoke a
// write-scoped actor, and nothing here can widen a caller's role.
//
// Execution, room identity, state and events belong to shared/actorRuntime.ts — this file only
// routes and reports. Failures keep their own code and status, so errors stay deterministic.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, loadProjectState } from "../../shared/authz.ts";
import { collectActors } from "../../shared/actorResource.ts";
import {
  loadProjectActor, invokeActor, connectActor, disconnectActor, roomEvents, roomSnapshot, signalActor,
} from "../../shared/actorRuntime.ts";

const OPS = ["list", "describe", "invoke", "connect", "disconnect", "events", "state", "signal"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "ACTOR_UNAUTHENTICATED" }, { status: 401 });

    const payload = req.method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => ({}));
    const op = String(payload.op || "invoke");
    if (!OPS.includes(op)) return Response.json({ error: `Unknown operation '${op}' (${OPS.join(", ")})`, code: "ACTOR_BAD_OPERATION" }, { status: 400 });
    const project_id = String(payload.project_id || "");

    // Reading the project's actors is a project READ. This is the only place a project is resolved,
    // so an unauthorized caller is refused before any actor, room or state is touched.
    const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
    const svc = base44.asServiceRole || base44;

    if (op === "list") {
      const state = await loadProjectState(base44, project.id);
      const declared = collectActors(state.files);
      return Response.json({
        ok: declared.errors.length === 0, project_id: project.id, count: declared.count,
        actors: declared.actors.map((a) => ({ name: a.name, path: a.path, access: a.access, capability: a.capability, persist: a.persist, events: a.events, description: a.description })),
        invalid: declared.errors.map((e) => ({ path: e.path, error: e.error })),
      });
    }

    const actorName = String(payload.actor || "");
    const { actor, source } = await loadProjectActor(svc, project.id, actorName);

    if (op === "describe") {
      return Response.json({ ok: true, project_id: project.id, actor });
    }

    const room = String(payload.room || "");
    if (op === "events") return Response.json({ ok: true, project_id: project.id, ...(await roomEvents(svc, project.id, actor.name, room, { since: Number(payload.since) || 0, limit: Number(payload.limit) || 50 })) });
    if (op === "state") return Response.json({ ok: true, project_id: project.id, ...(await roomSnapshot(svc, project.id, actor.name, room)) });

    // Ephemeral collaboration signal (cursor/selection) — presence, not a room mutation. Gated at
    // project.read (already resolved above), exactly like presence observe; the actor capability
    // re-check below applies only to connect/disconnect/invoke.
    if (op === "signal") {
      const sigParticipant = payload.participant ? String(payload.participant) : user.id;
      return Response.json({ ok: true, project_id: project.id, ...(await signalActor(svc, project.id, actor.name, room, { participant: sigParticipant, cursor: payload.cursor ?? null, selection: payload.selection ?? null })) });
    }

    // Joining, leaving and invoking CHANGE a room, so they are held to the capability the actor
    // resource declares — re-resolved through the same authorization path, never assumed.
    await loadAuthorizedProject(base44, user, project.id, actor.capability);
    const participant = payload.participant ? String(payload.participant) : user.id;

    if (op === "connect") return Response.json({ ok: true, project_id: project.id, ...(await connectActor(svc, project.id, actor.name, room, { participant, events: actor.events })) });
    if (op === "disconnect") return Response.json({ ok: true, project_id: project.id, ...(await disconnectActor(svc, project.id, actor.name, room, { participant, events: actor.events })) });

    const state = await loadProjectState(base44, project.id);
    const result = await invokeActor(svc, {
      project, entities: state.entities, actor, source, room,
      message: payload.message ?? null, user, participant,
    });
    return Response.json({ project_id: project.id, ...result });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return Response.json({ ok: false, error: error.message, code: error.code || "ACTOR_ERROR", details: error.details || null }, { status });
  }
}