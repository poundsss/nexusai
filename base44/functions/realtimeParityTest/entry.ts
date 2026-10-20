// Certification for REALTIME / COLLABORATION PARITY.
//
//   actor resource → build → immutable artifact (actor projection) → LIVE deployment
//   → public runtime → session-derived participant identity → room/session
//   → state → events/messages → presence → authorization → cross-project isolation
//
// Runs against the REAL modules and the REAL data layer, end to end: the real build engine and
// artifact builder (shared/deploy.ts), the real deployment worker, the real public runtime function
// (appRuntime, invoked over its actual HTTP surface), the real realtime adapter
// (shared/realtimeRuntime.ts), the real actor runtime store, the real generated-app auth
// (shared/appAuth.ts) and the real builder control plane (actorInvoke, shared/collaboration.ts).
// Nothing is stubbed and no second realtime harness is introduced — the existing test harness,
// deployment driver pattern and actor fixtures are reused.
//
// Note on "subscription": the platform's realtime delivery is the existing pull-based room stream
// (an append-only, monotonically sequenced log a participant tails with `since`). A subscription is
// therefore a connected participant tailing that stream, and an unsubscribe is leaving it. This
// suite certifies THAT contract rather than asserting a socket transport the platform does not have.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { actorFilePath } from "../../shared/actorResource.ts";
import { currentLiveDeployment, loadArtifactPayload } from "../../shared/deploy.ts";
import { appRuntimeCaller, createDeployedApp } from "../../shared/deployFixtures.ts";
import { realtimeParticipant, realtimeIdentityRequired, REALTIME_OPS, roomKey, sessionKey } from "../../shared/realtimeRuntime.ts";
import { ACTOR_ROOMS_ENTITY, ACTOR_EVENTS_ENTITY } from "../../shared/actorRuntime.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { commitMemberEdit, projectCollaborators } from "../../shared/collaboration.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const APP = `import { html } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">Realtime</h1></div>\`; }
`;
const STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";

const CHAT_ROOM = `export const config = { access: "write", persist: true, events: true, description: "Chat room" };
export default async function (ctx) {
  const state = ctx.state || {};
  const messages = state.messages || [];
  if (ctx.message && ctx.message.type === "say") {
    const next = messages.concat([{ text: ctx.message.data.text, by: ctx.room.session_id }]);
    return {
      state: { messages: next, count: next.length, room: ctx.room.id },
      reply: { ok: true, count: next.length, session_id: ctx.room.session_id, user: ctx.user ? ctx.user.id : null },
      broadcast: { type: "said", data: { text: ctx.message.data.text } }
    };
  }
  return { reply: { count: messages.length, session_id: ctx.room.session_id } };
}
`;

const ACTOR_PATH = actorFilePath("ChatRoom");
const PASSWORD = "Sup3r-Secret-Realtime-1";

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 700) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};



export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  // The PRODUCTION path, over the public runtime's real HTTP surface (shared caller).
  const runtime = appRuntimeCaller(svc);
  const rt = (slug, op, args = {}, token = null) =>
    runtime({ action: "realtime", slug, op, args, ...(token ? { session_token: token } : {}) });

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const stamp = Date.now();

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `rtparity-${stamp}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);

    const mk = (name, slug) => createDeployedApp(svc, {
      // The app enforces end-user identity, so realtime must refuse an anonymous caller.
      rls_enabled: true,
      workspace_id: ws.id, name, slug, deployed_by: user.id,
      files: [[ENTRY_FILE, MAIN], ["src/App.js", APP], ["styles.css", STYLES], [ACTOR_PATH, CHAT_ROOM]],
      on_project_created: (p) => created.projects.push(p.id),
    });
    const a = await mk(`Realtime A ${stamp}`, `rt-a-${stamp}`);
    const b = await mk(`Realtime B ${stamp}`, `rt-b-${stamp}`);
    const buildA = runBuild(createFs(activeFiles(a.fs)), [], []);
    const runA = a.run;
    const runB = b.run;
    const projectA = await svc.entities.Project.get(a.project.id);
    const projectB = await svc.entities.Project.get(b.project.id);
    const slugA = projectA.slug;
    const slugB = projectB.slug;

    // Real generated-app end-users, through the REAL #29 auth path.
    const userA = await signUpWithSession(svc, projectA.id, { email: `a-${stamp}@realtime.test`, password: PASSWORD, full_name: "User A" }, {});
    const otherA = await signUpWithSession(svc, projectA.id, { email: `a2-${stamp}@realtime.test`, password: PASSWORD, full_name: "Other A" }, {});
    const userB = await signUpWithSession(svc, projectB.id, { email: `b-${stamp}@realtime.test`, password: PASSWORD, full_name: "User B" }, {});

    // ------------------------------------------------ 1. actor in the deployed artifact
    const liveA = await currentLiveDeployment(svc, projectA, "production");
    const artifactA = await svc.entities.DeploymentArtifact.get(liveA.artifact_id);
    const payloadA = await loadArtifactPayload(artifactA);
    const projected = (payloadA.actors || []).find((x) => x.name === "ChatRoom");
    h.check("1 the actor is projected into the immutable deployment artifact",
      buildA.status === "success" && runA.status === "LIVE" &&
      (payloadA.actors || []).length === 1 && !!projected &&
      projected.access === "write" && projected.persist === true && projected.events === true &&
      projected.source === CHAT_ROOM &&
      // Actor modules are SERVER code and must never ship in the client bundle.
      !payloadA.client_files.some((f) => f.path === ACTOR_PATH),
      `artifact ${artifactA.checksum.slice(0, 12)} · ${(payloadA.actors || []).length} actor(s) · deployment ${runA.status}`);

    // ------------------------------------------------ 2. deployment exposes the realtime runtime
    const list = await rt(slugA, "list");
    const badOp = await rt(slugA, "subscribe", { actor: "ChatRoom" }, userA.token);
    h.check("2 the live deployment exposes the realtime runtime through the public runtime",
      list.status === 200 && list.data.result.count === 1 &&
      list.data.result.actors[0].name === "ChatRoom" && list.data.result.actors[0].persist === true &&
      badOp.status === 400 && badOp.data.code === "REALTIME_BAD_OPERATION" &&
      REALTIME_OPS.join(",") === "list,connect,disconnect,send,events,state,signal",
      `list ${list.data.result?.count} actor(s) · unknown op → ${badOp.data.code}`);

    // ------------------------------------------------ 3/4. connect + identity gate
    const connect = await rt(slugA, "connect", { actor: "ChatRoom", room: "lobby" }, userA.token);
    const anon = await rt(slugA, "connect", { actor: "ChatRoom", room: "lobby" });
    const anonState = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" });
    h.check("3 an authenticated generated-app session can connect to a room",
      connect.status === 200 && connect.data.result.joined === true &&
      connect.data.result.actor === "ChatRoom" && connect.data.result.connections === 1,
      `session ${connect.data.result?.session_id}`);
    h.check("4 an unauthenticated realtime caller is rejected before any room is touched",
      anon.status === 401 && anon.data.code === "REALTIME_AUTH_REQUIRED" &&
      anonState.status === 401 &&
      realtimeIdentityRequired(projectA, payloadA.entities) === true,
      `connect → ${anon.status} ${anon.data.code} · state → ${anonState.status}`);

    // ------------------------------------------------ 5. identity derived from the session
    const spoof = await rt(slugA, "connect", { actor: "ChatRoom", room: "lobby", participant: "attacker" }, userA.token);
    const expectedSession = sessionKey("ChatRoom", "lobby", `user:${userA.user.id}`);
    h.check("5 the participant identity is derived from the session, never from the request",
      spoof.status === 200 && spoof.data.result.session_id === expectedSession &&
      !JSON.stringify(spoof.data.result).includes("attacker") &&
      realtimeParticipant(userA.user, "attacker") === `user:${userA.user.id}` &&
      realtimeParticipant(null, "guest1") === "guest:guest1",
      `claimed 'attacker' → ${spoof.data.result?.session_id}`);

    // ------------------------------------------------ 6. deterministic identity
    const reconnect = await rt(slugA, "connect", { actor: "ChatRoom", room: "lobby" }, userA.token);
    h.check("6 actor/room/session identity is deterministic and a reconnect rejoins the same session",
      roomKey("ChatRoom", "lobby") === "ChatRoom:lobby" &&
      sessionKey("ChatRoom", "lobby", `user:${userA.user.id}`) === expectedSession &&
      reconnect.data.result.session_id === connect.data.result.session_id &&
      reconnect.data.result.joined === false && reconnect.data.result.connections === 1,
      `${expectedSession} · rejoin joined=${reconnect.data.result?.joined}`);

    // ------------------------------------------------ 7/8. state creation + persistence
    const send1 = await rt(slugA, "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "hello" } } }, userA.token);
    const state1 = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    const send2 = await rt(slugA, "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "again" } } }, userA.token);
    const state2 = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    h.check("7 a room and its state are created by the deployed actor's own handler",
      send1.status === 200 && send1.data.result.ok && send1.data.result.reply.count === 1 &&
      send1.data.result.reply.user === userA.user.id &&
      state1.data.result.exists === true && state1.data.result.state.count === 1 &&
      state1.data.result.state.room === "lobby",
      `reply ${send1.data.result?.reply?.count} · state ${state1.data.result?.state?.count}`);
    h.check("8 room state persists across separate runtime calls",
      send2.data.result.reply.count === 2 &&
      state2.data.result.state.count === 2 && state2.data.result.state.messages.length === 2 &&
      state2.data.result.state.messages[1].text === "again" && state2.data.result.invocations === 2,
      `persisted ${state2.data.result?.state?.count} message(s) · ${state2.data.result?.invocations} invocation(s)`);

    // ------------------------------------------------ 9. state isolation between rooms
    const green = await rt(slugA, "send", { actor: "ChatRoom", room: "green", message: { type: "say", data: { text: "elsewhere" } } }, userA.token);
    const lobbyStill = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    const greenState = await rt(slugA, "state", { actor: "ChatRoom", room: "green" }, userA.token);
    h.check("9 one room's state is invisible to another room of the same actor",
      green.data.result.reply.count === 1 &&
      greenState.data.result.state.count === 1 && greenState.data.result.state.room === "green" &&
      lobbyStill.data.result.state.count === 2 &&
      greenState.data.result.connections.length === 0 && lobbyStill.data.result.connections.length === 1,
      `lobby=${lobbyStill.data.result?.state?.count} green=${greenState.data.result?.state?.count}`);

    // ------------------------------------------------ 10. cross-project isolation
    const foreignToken = await rt(slugB, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    const bState = await rt(slugB, "state", { actor: "ChatRoom", room: "lobby" }, userB.token);
    const unknownActor = await rt(slugB, "state", { actor: "Missing", room: "lobby" }, userB.token);
    const aRooms = await svc.entities.AppRecord.filter({ project_id: projectA.id, entity_name: ACTOR_ROOMS_ENTITY }, "-created_date", 50);
    const bRooms = await svc.entities.AppRecord.filter({ project_id: projectB.id, entity_name: ACTOR_ROOMS_ENTITY }, "-created_date", 50);
    h.check("10 a room can never be reached from another project's deployment",
      runB.status === "LIVE" &&
      // Project A's session resolves to no user inside project B, so its identity gate refuses it.
      foreignToken.status === 401 && foreignToken.data.code === "REALTIME_AUTH_REQUIRED" &&
      // The same actor name + same room id in project B is a DIFFERENT room, with no state.
      bState.status === 200 && bState.data.result.exists === false && bState.data.result.seq === 0 &&
      unknownActor.status === 404 && unknownActor.data.code === "ACTOR_NOT_FOUND" &&
      aRooms.length === 2 && bRooms.length === 0,
      `A token in B → ${foreignToken.status} · B lobby exists=${bState.data.result?.exists} · rooms A=${aRooms.length} B=${bRooms.length}`);

    // ------------------------------------------------ 11. event / message send and receive
    const events = await rt(slugA, "events", { actor: "ChatRoom", room: "lobby", since: 0 }, userA.token);
    const stream = events.data.result.events;
    h.check("11 messages are delivered as monotonic room events a participant receives",
      events.status === 200 && stream.length >= 3 &&
      stream.every((e, i) => i === 0 || Number(stream[i - 1].seq) < Number(e.seq)) &&
      stream.some((e) => e.type === "actor.join" && e.by === `user:${userA.user.id}`) &&
      stream.some((e) => e.type === "said" && e.data.text === "hello" && e.by === `user:${userA.user.id}`) &&
      stream.some((e) => e.type === "said" && e.data.text === "again"),
      `${stream.length} event(s): ${stream.map((e) => e.type).join(",")}`);

    // ------------------------------------------------ 12/13. unauthorized + malformed events
    const anonSend = await rt(slugA, "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "intruder" } } });
    const badMessage = await rt(slugA, "send", { actor: "ChatRoom", room: "lobby", message: "not-an-object" }, userA.token);
    const badRoom = await rt(slugA, "send", { actor: "ChatRoom", room: "bad room!", message: { type: "say", data: { text: "x" } } }, userA.token);
    const afterBad = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    h.check("12 an unauthenticated message is refused and changes nothing",
      anonSend.status === 401 && anonSend.data.code === "REALTIME_AUTH_REQUIRED" &&
      afterBad.data.result.state.count === 2 && afterBad.data.result.invocations === 2,
      `send → ${anonSend.status} ${anonSend.data.code} · state still ${afterBad.data.result?.state?.count}`);
    h.check("13 a malformed message or room id is refused deterministically before the handler runs",
      badMessage.status === 400 && badMessage.data.code === "REALTIME_MESSAGE_INVALID" &&
      badRoom.status === 400 && badRoom.data.code === "ACTOR_ROOM_INVALID" &&
      afterBad.data.result.state.messages.length === 2,
      `message → ${badMessage.data.code} · room → ${badRoom.data.code}`);

    // ------------------------------------------------ 14/15/16. subscription contract
    const cursor = Number(afterBad.data.result.seq);
    const otherJoin = await rt(slugA, "connect", { actor: "ChatRoom", room: "lobby" }, otherA.token);
    const otherSay = await rt(slugA, "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "from other" } } }, otherA.token);
    const tail = await rt(slugA, "events", { actor: "ChatRoom", room: "lobby", since: cursor }, userA.token);
    const anonTail = await rt(slugA, "events", { actor: "ChatRoom", room: "lobby", since: 0 });
    h.check("14 a subscribed participant tails only what happened after its cursor",
      tail.status === 200 && tail.data.result.since === cursor &&
      tail.data.result.events.length === 2 &&
      tail.data.result.events.every((e) => Number(e.seq) > cursor) &&
      tail.data.result.events.some((e) => e.type === "actor.join" && e.by === `user:${otherA.user.id}`) &&
      tail.data.result.events.some((e) => e.type === "said" && e.data.text === "from other"),
      `since ${cursor} → ${tail.data.result?.events?.length} event(s)`);
    h.check("15 an unauthenticated subscription is refused",
      anonTail.status === 401 && anonTail.data.code === "REALTIME_AUTH_REQUIRED" &&
      otherJoin.data.result.connections === 2 && otherSay.data.result.reply.count === 3,
      `events → ${anonTail.status} ${anonTail.data.code}`);
    const unsubscribe = await rt(slugA, "disconnect", { actor: "ChatRoom", room: "lobby" }, otherA.token);
    const afterUnsub = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    h.check("16 unsubscribing removes only that participant and leaves the stream intact",
      unsubscribe.data.result.left === true &&
      afterUnsub.data.result.connections.length === 1 &&
      afterUnsub.data.result.connections[0].session_id === expectedSession &&
      afterUnsub.data.result.state.count === 3,
      `${afterUnsub.data.result?.connections?.length} connection(s) left`);

    // ------------------------------------------------ 17/18/19. presence
    const presence = afterUnsub.data.result.connections;
    const leaveEvents = (await rt(slugA, "events", { actor: "ChatRoom", room: "lobby", since: unsubscribe.data.result.seq - 1 }, userA.token)).data.result.events;
    h.check("17 presence records a joined participant under its session identity",
      presence.length === 1 && presence[0].participant === `user:${userA.user.id}` &&
      !!presence[0].joined_at && !!presence[0].last_seen_at,
      `present: ${presence.map((p) => p.participant).join(",")}`);
    h.check("18 leaving emits a leave event and clears that participant's presence",
      leaveEvents.some((e) => e.type === "actor.leave" && e.by === `user:${otherA.user.id}`) &&
      !presence.some((p) => p.participant === `user:${otherA.user.id}`),
      `leave event present · ${presence.length} remaining`);
    const leaveAgain = await rt(slugA, "disconnect", { actor: "ChatRoom", room: "lobby" }, otherA.token);
    const lastLeave = await rt(slugA, "disconnect", { actor: "ChatRoom", room: "lobby" }, userA.token);
    const emptied = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    h.check("19 disconnect cleanup is idempotent and never destroys room state",
      leaveAgain.data.result.left === false && lastLeave.data.result.left === true &&
      emptied.data.result.connections.length === 0 &&
      emptied.data.result.exists === true && emptied.data.result.state.count === 3,
      `repeat leave=${leaveAgain.data.result?.left} · state kept ${emptied.data.result?.state?.count}`);

    // ------------------------------------------------ 20/21/22. preview vs production parity
    const preview = await base44.functions.invoke("actorInvoke", { op: "invoke", project_id: projectA.id, actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "from builder" } } });
    const previewState = await base44.functions.invoke("actorInvoke", { op: "state", project_id: projectA.id, actor: "ChatRoom", room: "lobby" });
    const productionAfterPreview = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    h.check("20 the preview/builder surface drives the same actor through the same contract",
      preview.data.ok && preview.data.reply.count === 4 &&
      previewState.data.state.count === 4 && previewState.data.actor === "ChatRoom" &&
      // ONE room, ONE state store: the production read sees exactly what the preview wrote.
      productionAfterPreview.data.result.state.count === 4,
      `preview count ${preview.data.reply?.count} · production sees ${productionAfterPreview.data.result?.state?.count}`);
    const productionSend = await rt(slugA, "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "from production" } } }, userA.token);
    h.check("21 the production environment drives the deployed artifact's actor through the same contract",
      productionSend.status === 200 && productionSend.data.result.ok &&
      productionSend.data.result.reply.count === 5 &&
      productionSend.data.result.actor === "ChatRoom" &&
      productionSend.data.result.session_id === expectedSession &&
      liveA.status === "LIVE" && liveA.artifact_id === artifactA.id,
      `production reply ${productionSend.data.result?.reply?.count} from artifact ${artifactA.checksum.slice(0, 12)}`);
    h.check("22 preview and production identities stay separate and never impersonate each other",
      // Builder identity is the PLATFORM user; production identity is the generated-app end-user,
      // namespaced, so the two can never resolve to the same participant or session.
      preview.data.session_id === sessionKey("ChatRoom", "lobby", user.id) &&
      productionSend.data.result.session_id === sessionKey("ChatRoom", "lobby", `user:${userA.user.id}`) &&
      preview.data.session_id !== productionSend.data.result.session_id &&
      preview.data.reply.user === user.id && productionSend.data.result.reply.user === userA.user.id &&
      userA.user.id !== user.id,
      `builder ${preview.data.session_id} ≠ production ${productionSend.data.result?.session_id}`);

    // ------------------------------------------------ 23. authorization path
    const foreignWs = await svc.entities.Workspace.create({ name: `rtforeign-${stamp}`, owner_id: `not-${user.id}`, status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "not-mine", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(foreignProject.id);
    const deniedControl = await base44.functions.invoke("actorInvoke", { op: "list", project_id: foreignProject.id }).catch((e) => e.response || { status: e.status || 0, data: {} });
    const controlList = await base44.functions.invoke("actorInvoke", { op: "list", project_id: projectA.id });
    h.check("23 actor authorization uses the existing authz/RBAC path, and the deployed app holds no builder identity",
      (deniedControl.status === 403 || deniedControl.status === 404) &&
      controlList.data.ok && controlList.data.actors[0].capability === "project.write" &&
      // The public runtime authorizes by the app's own session only — a builder token is neither
      // required nor accepted as an end-user identity.
      list.status === 200 && anon.status === 401,
      `foreign control plane → ${deniedControl.status} · ChatRoom needs ${controlList.data.actors?.[0]?.capability}`);

    // ------------------------------------------------ 24. collaboration compatibility
    const collaborators = await projectCollaborators(base44, user, projectA.id);
    const edit = await commitMemberEdit(base44, user, {
      project_id: projectA.id,
      edits: [{ path: "src/App.js", content: APP.replace("Realtime", "Realtime edited") }],
      message: "collaboration after realtime",
    });
    const afterEdit = await rt(slugA, "state", { actor: "ChatRoom", room: "lobby" }, userA.token);
    const stillLive = await currentLiveDeployment(svc, projectA, "production");
    h.check("24 builder collaboration still works and realtime rooms are unaffected by it",
      collaborators.members.some((m) => m.user_id === user.id) && collaborators.my_role === "owner" &&
      edit.unchanged === false && edit.build_status === "success" && edit.version.number > a.version.number &&
      afterEdit.data.result.state.count === 5 &&
      // An edit is a new version; production keeps serving the verified artifact until redeployed.
      stillLive.id === liveA.id && stillLive.version_number === a.version.number,
      `edit → v${edit.version?.number} · room state ${afterEdit.data.result?.state?.count} · production still v${stillLive.version_number}`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["Deployment", "DeploymentArtifact", "AppSession", "AppAuthToken", "AppUser", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["AuditLog", "TraceEvent", "WorkspaceMember", "Project"]);
    }
  }
}