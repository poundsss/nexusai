// Targeted certification for the deployed-runtime `signal` gap (ephemeral collaboration presence).
//
//   deployed artifact → actor definition → session-derived identity → signal → connection entry
//
// Runs the REAL public runtime (appRuntime over its real HTTP surface) → the real realtime adapter
// (shared/realtimeRuntime.ts) → the REAL certified signalActor primitive the builder control plane
// (actorInvoke op "signal") already serves. Nothing is stubbed and no second harness is introduced.
// Signal semantics are the certified contract, unchanged: cursor/selection overwrite the
// participant's EXISTING room connection entry — no event, no sequence bump, nothing persisted
// beyond the connection — and stale signal fields on other connections are pruned on the same write.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { actorFilePath } from "../../shared/actorResource.ts";
import { currentLiveDeployment, loadArtifactPayload } from "../../shared/deploy.ts";
import { appRuntimeCaller, createDeployedApp } from "../../shared/deployFixtures.ts";
import { REALTIME_OPS } from "../../shared/realtimeRuntime.ts";
import { ACTOR_ROOMS_ENTITY, ACTOR_EVENTS_ENTITY, sessionKey } from "../../shared/actorRuntime.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const APP = `import { html } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">Signal</h1></div>\`; }
`;
const STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";

const BOARD = `export const config = { access: "write", persist: true, events: true, description: "Cursor board" };
export default async function (ctx) {
  const state = ctx.state || {};
  const messages = state.messages || [];
  if (ctx.message && ctx.message.type === "say") {
    const next = messages.concat([{ text: ctx.message.data.text, by: ctx.room.session_id }]);
    return { state: { messages: next, count: next.length }, reply: { ok: true, count: next.length } };
  }
  return { reply: { count: messages.length } };
}
`;

const ACTOR_PATH = actorFilePath("CursorBoard");
const PASSWORD = "Sup3r-Secret-Signal-1";

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
  const runtime = appRuntimeCaller(svc);
  const rt = (slug, op, args = {}, token = null) =>
    runtime({ action: "realtime", slug, op, args, ...(token ? { session_token: token } : {}) });

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const stamp = Date.now();

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `rtsignal-${stamp}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const mk = (name, slug) => createDeployedApp(svc, {
      rls_enabled: true, workspace_id: ws.id, name, slug, deployed_by: user.id,
      files: [[ENTRY_FILE, MAIN], ["src/App.js", APP], ["styles.css", STYLES], [ACTOR_PATH, BOARD]],
      on_project_created: (p) => created.projects.push(p.id),
    });
    const a = await mk(`Signal A ${stamp}`, `rt-sig-a-${stamp}`);
    const b = await mk(`Signal B ${stamp}`, `rt-sig-b-${stamp}`);
    const projectA = await svc.entities.Project.get(a.project.id);
    const slugA = projectA.slug;
    const slugB = (await svc.entities.Project.get(b.project.id)).slug;
    const userA = await signUpWithSession(svc, projectA.id, { email: `a-${stamp}@signal.test`, password: PASSWORD, full_name: "User A" }, {});
    const otherA = await signUpWithSession(svc, projectA.id, { email: `a2-${stamp}@signal.test`, password: PASSWORD, full_name: "Other A" }, {});
    const userB = await signUpWithSession(svc, b.project.id, { email: `b-${stamp}@signal.test`, password: PASSWORD, full_name: "User B" }, {});
    const liveA = await currentLiveDeployment(svc, projectA, "production");
    const artifactA = await svc.entities.DeploymentArtifact.get(liveA.artifact_id);
    const payloadA = await loadArtifactPayload(artifactA);

    const connA = async () => {
      const r = await rt(slugA, "state", { actor: "CursorBoard", room: "lobby" }, otherA.token);
      return (r.data.result.connections || []).find((c) => c.session_id === sessionKey("CursorBoard", "lobby", `user:${userA.user.id}`)) || null;
    };

    // ------------------------------------------------ 1. op registration + dispatch
    const badOp = await rt(slugA, "subscribe", { actor: "CursorBoard", room: "lobby" }, userA.token);
    h.check("1 the deployed realtime adapter accepts the signal op and still refuses unknown ops",
      REALTIME_OPS.includes("signal") &&
      !REALTIME_OPS.includes("subscribe") && badOp.status === 400 && badOp.data.code === "REALTIME_BAD_OPERATION",
      `ops: ${REALTIME_OPS.join(",")} · subscribe → ${badOp.data.code}`);

    // ------------------------------------------------ 2. authorized actor can send a signal
    const joined = await rt(slugA, "connect", { actor: "CursorBoard", room: "lobby" }, userA.token);
    const sig1 = await rt(slugA, "signal", { actor: "CursorBoard", room: "lobby", cursor: { x: 42, y: 7, viewport: "desktop" } }, userA.token);
    const entry = await connA();
    h.check("2 an authorized, connected actor can send a signal and its connection carries the cursor",
      sig1.status === 200 && sig1.data.result.ok === true &&
      sig1.data.result.session_id === sessionKey("CursorBoard", "lobby", `user:${userA.user.id}`) &&
      !!entry && entry.cursor && entry.cursor.x === 42 && entry.cursor.y === 7 && entry.cursor.viewport === "desktop",
      `signal → ${sig1.status} · cursor ${JSON.stringify(entry?.cursor || null)}`);

    // ------------------------------------------------ 3. reaches the subscribed room, no event
    const otherConnect = await rt(slugA, "connect", { actor: "CursorBoard", room: "lobby" }, otherA.token);
    const eventsBefore = (await rt(slugA, "events", { actor: "CursorBoard", room: "lobby", since: 0 }, userA.token)).data.result;
    const sigSel = await rt(slugA, "signal", { actor: "CursorBoard", room: "lobby", selection: { route: "/", elementId: "box-1" } }, userA.token);
    const seenByOther = (await rt(slugA, "state", { actor: "CursorBoard", room: "lobby" }, otherA.token)).data.result;
    const eventsAfter = (await rt(slugA, "events", { actor: "CursorBoard", room: "lobby", since: 0 }, userA.token)).data.result;
    const myEntry = (seenByOther.connections || []).find((c) => c.session_id === sessionKey("CursorBoard", "lobby", `user:${userA.user.id}`));
    const seqOf = (evs) => (evs && evs.events && evs.events.length ? Number(evs.events[evs.events.length - 1].seq) : 0);
    h.check("3 the signal is visible to the subscribed participant and never touches the event stream",
      otherConnect.data.result.connections === 2 &&
      !!myEntry && myEntry.selection && myEntry.selection.elementId === "box-1" &&
      !!myEntry.cursor && myEntry.cursor.x === 42 &&
      // the signal is presence, not an event: the stream is unchanged across the signal
      Number(seenByOther.seq) === seqOf(eventsAfter) && seqOf(eventsAfter) === seqOf(eventsBefore) &&
      (eventsAfter.events || []).length === (eventsBefore.events || []).length &&
      // no persistence beyond the connection: the signal created no room and no event rows
      (await svc.entities.AppRecord.filter({ project_id: projectA.id, entity_name: ACTOR_ROOMS_ENTITY }, "-created_date", 50)).length === 1 &&
      (await svc.entities.AppRecord.filter({ project_id: projectA.id, entity_name: ACTOR_EVENTS_ENTITY }, "-created_date", 200)).length === (eventsBefore.events || []).length,
      `seq ${seqOf(eventsBefore)}→${seenByOther.seq} · events ${(eventsBefore.events || []).length}→${(eventsAfter.events || []).length}`);

    // ------------------------------------------------ 4. unauthorized / cross-project rejection
    const anonSig = await rt(slugA, "signal", { actor: "CursorBoard", room: "lobby", cursor: { x: 1, y: 1 } });
    const foreignSig = await rt(slugB, "signal", { actor: "CursorBoard", room: "lobby", cursor: { x: 1, y: 1 } }, userA.token);
    const unknownActor = await rt(slugA, "signal", { actor: "Missing", room: "lobby", cursor: { x: 1, y: 1 } }, userA.token);
    const badCursor = await rt(slugA, "signal", { actor: "CursorBoard", room: "lobby", cursor: { x: -5, y: 1 } }, userA.token);
    const badRoom = await rt(slugA, "signal", { actor: "CursorBoard", room: "bad room!", cursor: { x: 1, y: 1 } }, userA.token);
    const bState = await rt(slugB, "state", { actor: "CursorBoard", room: "lobby" }, userB.token);
    h.check("4 unauthorized, cross-project and malformed signals are refused and change nothing",
      anonSig.status === 401 && anonSig.data.code === "REALTIME_AUTH_REQUIRED" &&
      foreignSig.status === 401 && foreignSig.data.code === "REALTIME_AUTH_REQUIRED" &&
      unknownActor.status === 404 && unknownActor.data.code === "ACTOR_NOT_FOUND" &&
      badCursor.status === 400 && badCursor.data.code === "ACTOR_SIGNAL_INVALID" &&
      badRoom.status === 400 && badRoom.data.code === "ACTOR_ROOM_INVALID" &&
      bState.status === 200 && bState.data.result.exists === false,
      `anon → ${anonSig.status} · foreign → ${foreignSig.status} · cursor → ${badCursor.data.code} · room → ${badRoom.data.code}`);

    // ------------------------------------------------ 5. existing connect/send/events unchanged
    const say = await rt(slugA, "send", { actor: "CursorBoard", room: "lobby", message: { type: "say", data: { text: "hello" } } }, userA.token);
    const afterSend = (await rt(slugA, "state", { actor: "CursorBoard", room: "lobby" }, userA.token)).data.result;
    const tail = (await rt(slugA, "events", { actor: "CursorBoard", room: "lobby", since: 0 }, userA.token)).data.result;
    h.check("5 connect/send/events behavior is unchanged by the signal addition",
      say.status === 200 && say.data.result.ok && say.data.result.reply.count === 1 &&
      afterSend.state.count === 1 && afterSend.state.messages[0].text === "hello" &&
      afterSend.connections.length === 2 &&
      (tail.events || []).some((e) => e.type === "say"),
      `send ${say.status}/${say.data.code || "ok"} reply ${say.data.result?.reply?.count} · state ${afterSend.state?.count} · connections ${afterSend.connections?.length} · tail types ${(tail.events || []).map((e) => e.type).join(",")}`);

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