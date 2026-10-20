import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";

// Live collaborator cursors/selections over the EXISTING actor realtime control plane — an
// extension of the presence mechanism, not a second collaboration system. It reuses the SAME
// certified `builder` room and the SAME (room,participant) session identity useActorPresence
// uses (connect is idempotent per participant, so the two hooks share one session, never two).
//
// Transport: one new lightweight `signal` op that overwrites the caller's latest cursor/selection
// on their connection entry. Reads reuse the existing `state` op. No second engine, no sockets.
//
// Poll cadence: ~1s while other participants are present (live cursor/selection refresh), and a
// slower ~3s discovery poll when alone — so a solo editor does not pay the full rate. Disconnect on
// unmount is preserved exactly like presence.
const ROOM = "builder";
const CURSOR_THROTTLE_MS = 50; // ~20fps
const POLL_FAST_MS = 1000;
const POLL_SLOW_MS = 3000;

export function useCollaborators(projectId) {
  const [collaborators, setCollaborators] = useState([]);
  const [participants, setParticipants] = useState([]);

  const actorRef = useRef(null);
  const myIdRef = useRef(null);
  const memberMapRef = useRef({});
  const lastSentRef = useRef(0);
  const pendingRef = useRef(null);
  const trailingRef = useRef(null);
  const hasOthersRef = useRef(false);
  const timerRef = useRef(null);
  const connectedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    cancelledRef.current = false;
    const safe = async (fn) => { try { return await fn(); } catch { return null; } };

    (async () => {
      const me = await safe(() => base44.auth.me());
      if (!me || cancelledRef.current) return;
      myIdRef.current = me.id;

      const proj = await safe(() => workspaceRead("project", { project_id: projectId }).then((d) => d.project));
      if (!proj || cancelledRef.current) return;
      if (proj.workspace_id) {
        const mres = await safe(() => base44.functions.invoke("workspaceMembers", { action: "list", workspace_id: proj.workspace_id }));
        const list = (mres && (mres.data?.members || mres.members)) || [];
        const map = {};
        for (const m of list) if (m.user_id) map[m.user_id] = m.email || null;
        const owner = mres && (mres.data?.owner || mres.owner);
        if (owner?.user_id) map[owner.user_id] = map[owner.user_id] || null;
        memberMapRef.current = map;
      }

      const lres = await safe(() => base44.functions.invoke("actorInvoke", { op: "list", project_id: projectId }));
      const actors = (lres && (lres.data?.actors || lres.actors)) || [];
      if (!actors.length || cancelledRef.current) return;
      actorRef.current = actors[0].name;

      await safe(() => base44.functions.invoke("actorInvoke", { op: "connect", project_id: projectId, actor: actorRef.current, room: ROOM, participant: myIdRef.current }));
      connectedRef.current = true;

      const tick = async () => {
        const sres = await safe(() => base44.functions.invoke("actorInvoke", { op: "state", project_id: projectId, actor: actorRef.current, room: ROOM }));
        if (cancelledRef.current) return;
        const conns = (sres && (sres.data?.connections || sres.connections)) || [];
        const others = conns.filter((c) => c.participant && c.participant !== myIdRef.current);
        hasOthersRef.current = others.length > 0;
        const map = memberMapRef.current;
        setParticipants(others.map((c) => ({ id: c.participant, name: map[c.participant] || null, joinedAt: c.joined_at || null })));
        setCollaborators(others.map((c) => ({ id: c.participant, name: map[c.participant] || null, cursor: c.cursor || null, selection: c.selection || null })));
      };

      const schedule = () => {
        if (cancelledRef.current) return;
        timerRef.current = setTimeout(async () => { await tick(); schedule(); }, hasOthersRef.current ? POLL_FAST_MS : POLL_SLOW_MS);
      };
      await tick();
      schedule();
    })();

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (trailingRef.current) { clearTimeout(trailingRef.current); trailingRef.current = null; }
      if (connectedRef.current && actorRef.current) {
        safe(() => base44.functions.invoke("actorInvoke", { op: "disconnect", project_id: projectId, actor: actorRef.current, room: ROOM, participant: myIdRef.current }));
      }
    };
  }, [projectId]);

  // Coalesce + throttle cursor sends to ~20fps. No queue: only the latest pending value is sent on
  // the trailing edge. Failures are silent — a dropped cursor frame is corrected by the next move.
  const sendCursor = useCallback((cursor) => {
    const actor = actorRef.current;
    if (!actor) return;
    const now = Date.now();
    pendingRef.current = cursor;
    const fire = (c) => { lastSentRef.current = Date.now(); base44.functions.invoke("actorInvoke", { op: "signal", project_id: projectId, actor, room: ROOM, participant: myIdRef.current, cursor: c }).catch(() => {}); };
    if (now - lastSentRef.current >= CURSOR_THROTTLE_MS) { fire(cursor); return; }
    if (trailingRef.current) return;
    trailingRef.current = setTimeout(() => {
      trailingRef.current = null;
      const c = pendingRef.current;
      if (c) fire(c);
    }, CURSOR_THROTTLE_MS - (now - lastSentRef.current));
  }, [projectId]);

  // Selection is infrequent (a pick); send immediately, no throttle.
  const sendSelection = useCallback((selection) => {
    const actor = actorRef.current;
    if (!actor) return;
    base44.functions.invoke("actorInvoke", { op: "signal", project_id: projectId, actor, room: ROOM, participant: myIdRef.current, selection }).catch(() => {});
  }, [projectId]);

  return { collaborators, participants, sendCursor, sendSelection };
}