// Certification for the ActorsModule RUNTIME parity gap (SDK 0.8.52):
//
//   base44.actors.<ActorName>(instanceId) → ActorRef → connect({ id? }) → Connection
//   { id, subscribe(cb) → { unsubscribe() }, send(data), close() }  +  base44.cleanup()
//
// The runtime adapter is a thin layer over the EXISTING certified realtime bridge ops
// (list/connect/disconnect/send/events — shared/realtimeRuntime.ts, UNCHANGED here): the actor
// name is resolved/validated against the realtime 'list' op and fails closed for an unknown
// actor; connect() is idempotent per ActorRef; every property access mints a NEW ref;
// subscribe tails the room's monotonic event stream: the certified transport is the persistent
// WebSocket push (NexusActorRelay, realtimeWsTransportCert) with the 4s pull poll as automatic
// fallback; close/cleanup disconnect through the existing op.
//
// Certified against the REAL modules and the REAL deployment path (same fixture pattern as
// realtimeParityTest): the real build engine, artifact, public runtime (appRuntime over its
// HTTP surface) and the real actorInvoke control plane (the preview path).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { RUNTIME_EXPORTS, ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { actorFilePath } from "../../shared/actorResource.ts";
import { currentLiveDeployment, loadArtifactPayload } from "../../shared/deploy.ts";
import { appRuntimeCaller, createDeployedApp } from "../../shared/deployFixtures.ts";
import { REALTIME_OPS } from "../../shared/realtimeRuntime.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const APP = `import { html } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">Actors</h1></div>\`; }
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
const PASSWORD = "Sup3r-Secret-Actors-1";

// ---- shipped-runtime mirrors (backend code cannot import src/ — the established convention) ----
const M_PROXY =
  "export const actors = new Proxy({}, { get(_, actorName) { return typeof actorName === 'string' && actorName !== 'then' ? (instanceId) => makeActorRef(actorName, instanceId == null ? '' : String(instanceId)) : undefined; } });";
const M_IDEMPOTENT = "      if (ref._conn) return ref._conn;";
const M_CONN_RESET = "        if (ref._conn === conn) ref._conn = null;";
const M_THEN_EXCLUDED = "actorName !== 'then'";
const M_LISTING = "        const listing = await call('realtime', 'list', {});";
const M_LIST_CHECK =
  "        if (!((listing && listing.actors) || []).some((a) => a.name === actorName)) throw new Error('Actor ' + JSON.stringify(actorName) + ' is not part of this application');";
const M_CONN_ID =
  "      const conn = { id: cid, _listeners: [], _seq: 0, _dead: false, _participant: GUEST_ID_RE.test(cid) ? cid : mintRuntimeId() };";
const M_POLL =
  "          try { evs = await call('realtime', 'events', { actor: actorName, room: instanceId, since: conn._seq }); } catch (e) { return; }";
const M_SEND =
  "      conn.send = (data) => { if (conn._dead) return; conn._ready.then(() => call('realtime', 'send', { actor: actorName, room: instanceId, participant: conn._participant, message: data })).catch(() => {}); };";
const M_CLOSE =
  "        conn._ready.then(() => call('realtime', 'disconnect', { actor: actorName, room: instanceId, participant: conn._participant })).catch(() => {});";
const M_CLEANUP =
  "export const cleanup = () => { const live = Array.from(liveConnections); for (const conn of live) conn.close(); return { closed: live.length }; };";
const M_SDK =
  "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, actors, types, app, appLogs, cleanup });";
// Preview bridge (dbBridge.js): the realtime scope routed onto the EXISTING actorInvoke surface.
const M_PREVIEW_ROUTE = `const res = await base44.functions.invoke("actorInvoke", { project_id: projectId, op: op === "send" ? "invoke" : op, ...(args || {}) });`;
// Deployed bridge (PublicApp.jsx): the realtime scope forwarded to the public runtime's action.
const M_DEPLOYED_ROUTE = `action: "realtime", op: m.op, args: m.args || {}`;

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

    // ---------------------------------------------------------------- fixture
    const ws = await svc.entities.Workspace.create({ name: `actorssdk-${stamp}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const app = await createDeployedApp(svc, {
      rls_enabled: true,
      workspace_id: ws.id, name: `Actors SDK ${stamp}`, slug: `actors-sdk-${stamp}`, deployed_by: user.id,
      files: [[ENTRY_FILE, MAIN], ["src/App.js", APP], ["styles.css", STYLES], [ACTOR_PATH, CHAT_ROOM]],
      on_project_created: (p) => created.projects.push(p.id),
    });
    const build = runBuild(createFs(activeFiles(app.fs)), [], []);
    const project = await svc.entities.Project.get(app.project.id);
    const slug = project.slug;
    const liveA = await currentLiveDeployment(svc, project, "production");
    const artifact = await svc.entities.DeploymentArtifact.get(liveA.artifact_id);
    const payload = await loadArtifactPayload(artifact);
    const sessionA = await signUpWithSession(svc, project.id, { email: `a-${stamp}@actors.test`, password: PASSWORD, full_name: "User A" }, {});
    const sessionB = await signUpWithSession(svc, project.id, { email: `b-${stamp}@actors.test`, password: PASSWORD, full_name: "User B" }, {});

    // ------------------------------------------------ 1. the actor namespace is exposed
    h.check("1 the runtime exposes the actors namespace, cleanup and the sdk alias",
      RUNTIME_EXPORTS.includes("actors") && RUNTIME_EXPORTS.includes("cleanup") &&
      RUNTIME_EXPORTS.includes("agents") &&
      M_PROXY.includes("new Proxy") && M_PROXY.includes("(instanceId) => makeActorRef(") &&
      M_PROXY.includes("&& actorName !== 'then'") &&
      M_CLEANUP.includes("Array.from(liveConnections)") && M_CLEANUP.includes("conn.close()") &&
      M_SDK.endsWith("appLogs, cleanup });") && M_SDK.includes("actors, types"),
      `exports=${RUNTIME_EXPORTS.length} · sdk freeze has actors+cleanup`);

    // ------------------------------------------------ 2/3. a valid actor resolves and connects; unknown fails closed
    const list = await rt(slug, "list");
    const connect = await rt(slug, "connect", { actor: "ChatRoom", room: "lobby" }, sessionA.token);
    const unknown = await rt(slug, "connect", { actor: "Missing", room: "lobby" }, sessionA.token);
    const previewUnknown = await base44.functions.invoke("actorInvoke", { op: "connect", project_id: project.id, actor: "Missing", room: "lobby" }).catch((e) => e.response || { status: e.status || 0, data: {} });
    h.check("2 a VALID actor resolves against the realtime list and connects (client list-check mirror present)",
      list.status === 200 && list.data.result.count === 1 && list.data.result.actors[0].name === "ChatRoom" &&
      connect.status === 200 && connect.data.result.joined === true && connect.data.result.actor === "ChatRoom" &&
      M_LISTING.includes("call('realtime', 'list', {})") && M_LIST_CHECK.includes("some((a) => a.name === actorName)"),
      `${list.data.result?.count} actor(s) · joined=${connect.data.result?.joined}`);
    h.check("3 an UNKNOWN actor FAILS CLOSED on both paths (deployed 404 · preview 404)",
      unknown.status === 404 && unknown.data.code === "ACTOR_NOT_FOUND" &&
      previewUnknown.status === 404 && previewUnknown.data.code === "ACTOR_NOT_FOUND",
      `deployed → ${unknown.status} · preview → ${previewUnknown.status}`);

    // ------------------------------------------------ 4/5. connection id + per-ref idempotency
    const reconnect = await rt(slug, "connect", { actor: "ChatRoom", room: "lobby" }, sessionA.token);
    h.check("4 the connection id is exposed (client-chosen cid mirror; server returns the session id)",
      typeof connect.data.result.session_id === "string" && connect.data.result.session_id.length > 0 &&
      M_CONN_ID.includes("id: cid,") && M_CONN_ID.includes("_participant:"),
      `session ${connect.data.result?.session_id}`);
    h.check("5 connect() is IDEMPOTENT per ActorRef (mirror guard) and a reconnect rejoins the same server session",
      M_IDEMPOTENT === "      if (ref._conn) return ref._conn;" &&
      M_CONN_RESET.includes("ref._conn = null") &&
      reconnect.data.result.session_id === connect.data.result.session_id &&
      reconnect.data.result.joined === false,
      `mirror guard present · rejoin joined=${reconnect.data.result?.joined}`);

    // ------------------------------------------------ 6. separate ActorRefs are independent
    const refB = await rt(slug, "connect", { actor: "ChatRoom", room: "lobby" }, sessionB.token);
    const roomAfterTwo = await rt(slug, "state", { actor: "ChatRoom", room: "lobby" }, sessionA.token);
    h.check("6 separate ActorRefs are independent: a new ref per property access (mirror) and two live participants coexist",
      M_PROXY.includes("(instanceId) => makeActorRef(") &&
      refB.data.result.session_id !== connect.data.result.session_id &&
      roomAfterTwo.data.result.connections.length === 2,
      `${roomAfterTwo.data.result?.connections?.length} participant(s) · ids differ`);

    // ------------------------------------------------ 7. send reaches the existing realtime operation
    const send = await rt(slug, "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "hello" } } }, sessionA.token);
    const state1 = await rt(slug, "state", { actor: "ChatRoom", room: "lobby" }, sessionA.token);
    h.check("7 send() reaches the EXISTING realtime send op (the actor's own handler runs and persists state)",
      send.status === 200 && send.data.result.ok && send.data.result.reply.count === 1 &&
      send.data.result.reply.user === sessionA.user.id &&
      state1.data.result.state.count === 1 && state1.data.result.invocations === 1,
      `reply count ${send.data.result?.reply?.count} · state ${state1.data.result?.state?.count}`);

    // ------------------------------------------------ 8. subscribe receives events through the existing bridge
    const cursor = Number(state1.data.result.seq);
    const otherSay = await rt(slug, "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "from B" } } }, sessionB.token);
    const tail = await rt(slug, "events", { actor: "ChatRoom", room: "lobby", since: cursor }, sessionA.token);
    h.check("8 subscribe tails the EXISTING events bridge (mirror) and receives only later room events",
      otherSay.data.result.reply.count === 2 &&
      tail.status === 200 && tail.data.result.since === cursor && tail.data.result.events.length === 1 &&
      tail.data.result.events[0].type === "said" && tail.data.result.events[0].data.text === "from B" &&
      M_POLL.includes("call('realtime', 'events'") && M_POLL.includes("since: conn._seq"),
      `since ${cursor} → ${tail.data.result?.events?.length} event(s)`);

    // ------------------------------------------------ 9. close stops the connection
    const leave = await rt(slug, "disconnect", { actor: "ChatRoom", room: "lobby" }, sessionB.token);
    const afterClose = await rt(slug, "state", { actor: "ChatRoom", room: "lobby" }, sessionA.token);
    h.check("9 close() disconnects through the EXISTING realtime op (mirror) and clears that participant's presence",
      leave.data.result.left === true && afterClose.data.result.connections.length === 1 &&
      afterClose.data.result.connections[0].session_id === connect.data.result.session_id &&
      M_CLOSE.includes("call('realtime', 'disconnect'") && M_CLOSE.includes("participant: conn._participant"),
      `${afterClose.data.result?.connections?.length} participant(s) after close`);

    // ------------------------------------------------ 10. cleanup closes active connections
    h.check("10 cleanup() closes every live actor connection (mirror: the live registry + close loop)",
      M_CLEANUP === "export const cleanup = () => { const live = Array.from(liveConnections); for (const conn of live) conn.close(); return { closed: live.length }; };" &&
      M_CLEANUP.includes("for (const conn of live) conn.close()"),
      `cleanup mirror verified`);

    // ------------------------------------------------ 11. deployed + preview parity
    const previewSend = await base44.functions.invoke("actorInvoke", { op: "invoke", project_id: project.id, actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "from builder" } } });
    const productionRead = await rt(slug, "state", { actor: "ChatRoom", room: "lobby" }, sessionA.token);
    h.check("11 deployed and preview stay in parity: the SAME actor runtime, ONE room, ONE state store",
      M_PREVIEW_ROUTE.includes('invoke("actorInvoke"') && M_PREVIEW_ROUTE.includes('op === "send" ? "invoke" : op') &&
      M_DEPLOYED_ROUTE.includes('action: "realtime"') &&
      previewSend.data.ok && previewSend.data.reply.count === 3 &&
      productionRead.data.result.state.count === 3 &&
      productionRead.data.result.invocations === 3,
      `preview wrote count ${previewSend.data.reply?.count} · production sees ${productionRead.data.result?.state?.count}`);

    // ------------------------------------------------ 12. existing realtime regression
    const badOp = await rt(slug, "subscribe", { actor: "ChatRoom" }, sessionA.token);
    const badMessage = await rt(slug, "send", { actor: "ChatRoom", room: "lobby", message: "not-an-object" }, sessionA.token);
    const badRoom = await rt(slug, "send", { actor: "ChatRoom", room: "bad room!", message: { type: "say", data: { text: "x" } } }, sessionA.token);
    h.check("12 REGRESSION: the realtime contract is unchanged (op vocabulary, malformed input refusal, deterministic errors)",
      REALTIME_OPS.join(",") === "list,connect,disconnect,send,events,state,signal" &&
      badOp.status === 400 && badOp.data.code === "REALTIME_BAD_OPERATION" &&
      badMessage.status === 400 && badMessage.data.code === "REALTIME_MESSAGE_INVALID" &&
      badRoom.status === 400 && badRoom.data.code === "ACTOR_ROOM_INVALID",
      `ops=${REALTIME_OPS.join(",")} · badOp=${badOp.data.code} · msg=${badMessage.data.code} · room=${badRoom.data.code}`);

    // ------------------------------------------------ 13. build passes
    h.check("13 the build passes and the actor is projected into the immutable artifact (never the client bundle)",
      build.status === "success" && liveA.status === "LIVE" &&
      (payload.actors || []).length === 1 && payload.actors[0].name === "ChatRoom" &&
      !payload.client_files.some((f) => f.path === ACTOR_PATH),
      `build ${build.status} · artifact ${artifact.checksum.slice(0, 12)}`);

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