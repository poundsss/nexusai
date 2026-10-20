import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";

// Builder presence over the EXISTING actor realtime control plane (actorInvoke). It reuses the
// certified actor room's `connections` presence (participant + joined_at) — no cursor/selection
// state is invented (the actor contract carries none). A workspace member is mapped to a name via
// the existing workspaceMembers list. If the project declares no actors, presence is a graceful
// no-op (no room is created). Any failure stays silent so the preview never breaks.
const ROOM = "builder";

export function useActorPresence(projectId) {
  const [participants, setParticipants] = useState([]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let timer = null;
    let actorName = null;
    let myId = null;
    let connected = false;
    let memberMap = {};

    const safe = async (fn) => { try { return await fn(); } catch { return null; } };

    (async () => {
      const me = await safe(() => base44.auth.me());
      if (!me || cancelled) return;
      myId = me.id;

      const proj = await safe(() => workspaceRead("project", { project_id: projectId }).then((d) => d.project));
      if (!proj || cancelled) return;
      if (proj.workspace_id) {
        const mres = await safe(() => base44.functions.invoke("workspaceMembers", { action: "list", workspace_id: proj.workspace_id }));
        const list = (mres && (mres.data?.members || mres.members)) || [];
        const map = {};
        for (const m of list) if (m.user_id) map[m.user_id] = m.email || null;
        const owner = mres && (mres.data?.owner || mres.owner);
        if (owner?.user_id) map[owner.user_id] = map[owner.user_id] || null;
        memberMap = map;
      }

      const lres = await safe(() => base44.functions.invoke("actorInvoke", { op: "list", project_id: projectId }));
      const actors = (lres && (lres.data?.actors || lres.actors)) || [];
      if (!actors.length || cancelled) return;
      actorName = actors[0].name;

      await safe(() => base44.functions.invoke("actorInvoke", { op: "connect", project_id: projectId, actor: actorName, room: ROOM, participant: myId }));
      connected = true;

      const tick = async () => {
        const sres = await safe(() => base44.functions.invoke("actorInvoke", { op: "state", project_id: projectId, actor: actorName, room: ROOM }));
        if (cancelled) return;
        const conns = (sres && (sres.data?.connections || sres.connections)) || [];
        setParticipants(conns
          .filter((c) => c.participant && c.participant !== myId)
          .map((c) => ({ id: c.participant, name: memberMap[c.participant] || null, joinedAt: c.joined_at || null })));
      };
      await tick();
      timer = setInterval(tick, 5000);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (connected && actorName) {
        safe(() => base44.functions.invoke("actorInvoke", { op: "disconnect", project_id: projectId, actor: actorName, room: ROOM, participant: myId }));
      }
    };
  }, [projectId]);

  return participants;
}