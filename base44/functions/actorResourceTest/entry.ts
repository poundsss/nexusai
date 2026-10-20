// Certification for E8 — the Base44 ACTOR primitive as a native NexusAI resource.
//
// Runs against the REAL modules and the REAL data layer: the real actor path contract, the real
// actor document parser, the real project filesystem write guard, the real journalled persistence,
// the real push/pull resource sync (E14/E15), the real build engine, the real authorization path and
// the real stateful runtime. Nothing is stubbed and no second engine is introduced.
//
// Lifecycle under test:
//   define → persist → load → push/pull → build → deploy-compatible → resolve → invoke → room state
//   → event stream → presence → authorization
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, writeFile, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { configContent, CONFIG_FILE } from "../../shared/base44Layout.ts";
import { loadProjectState, loadAuthorizedProject } from "../../shared/authz.ts";
import { pullResources, pushResources, resourceStatus, resourceKindOf, resourceIdentity, validateResource, SUPPORTED_KINDS, RESERVED_KINDS } from "../../shared/resourceSync.ts";
import {
  isActorFilePath, actorFilePath, actorNameFromPath, parseActorDocument, collectActors, resolveActor, ACTOR_CAPABILITY,
} from "../../shared/actorResource.ts";
import {
  loadProjectActor, invokeActor, connectActor, disconnectActor, roomEvents, roomSnapshot,
  roomKey, sessionKey, ACTOR_ROOMS_ENTITY, ACTOR_EVENTS_ENTITY,
} from "../../shared/actorRuntime.ts";

const CHAT_ROOM = `export const config = { access: "write", persist: true, events: true, description: "Chat room" };
export default async function (ctx) {
  const state = ctx.state || {};
  const messages = state.messages || [];
  if (ctx.message && ctx.message.type === "say") {
    const next = messages.concat([{ text: ctx.message.data.text, by: ctx.room.session_id }]);
    return {
      state: { messages: next, count: next.length, room: ctx.room.id },
      reply: { ok: true, count: next.length },
      broadcast: { type: "said", data: { text: ctx.message.data.text } }
    };
  }
  return { reply: { count: messages.length } };
}
`;
// A read-scoped, stateless actor: it declares the weaker capability and keeps no room state.
const BOARD_VIEW = `export const config = { access: "read", persist: false, events: false };
export default async function (ctx) { return { reply: { viewers: ctx.room.connections.length } }; }
`;
const BAD_ACCESS = `export const config = { access: "admin" };
export default async function (ctx) { return { reply: null }; }
`;
const NO_HANDLER = `export const config = { access: "write" };
export const other = 1;
`;

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 600) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `actorres-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "actor-resources", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(project.id);

    const CHAT_PATH = actorFilePath("ChatRoom");
    const VIEW_PATH = actorFilePath("BoardView");

    // -------------------------------------------------- 1. canonical resource path
    h.check("1 canonical actor resource path",
      CHAT_PATH === "base44/actors/ChatRoom/entry.ts" && isActorFilePath(CHAT_PATH) &&
      actorNameFromPath(CHAT_PATH) === "ChatRoom" &&
      resourceKindOf(CHAT_PATH) === "actors" && resourceIdentity(CHAT_PATH) === "ChatRoom" &&
      SUPPORTED_KINDS.includes("actors") && !RESERVED_KINDS.includes("actors") &&
      !isActorFilePath("base44/actors/chatRoom/entry.ts") &&
      !isActorFilePath("base44/actors/ChatRoom/index.ts"),
      `${CHAT_PATH} → ChatRoom · supported kind`);

    // -------------------------------------------------- 2. create / write
    const fs = createFs([]);
    writeFile(fs, ENTRY_FILE, "export default function App() { return null; }");
    writeFile(fs, CHAT_PATH, CHAT_ROOM);
    writeFile(fs, VIEW_PATH, BOARD_VIEW);
    const badExt = (() => { try { writeFile(fs, "base44/actors/ChatRoom/entry.js", CHAT_ROOM); return null; } catch (e) { return e; } })();
    const badName = (() => { try { writeFile(fs, "base44/actors/chatRoom/entry.ts", CHAT_ROOM); return null; } catch (e) { return e; } })();
    h.check("2 the project filesystem accepts only canonical actor resources",
      activeFiles(fs).some((f) => f.path === CHAT_PATH) && !!badExt && !!badName,
      "canonical entry is writable; a wrong file name and a lowercase actor are refused");

    // -------------------------------------------------- 3. parse / validate
    const chat = parseActorDocument(CHAT_PATH, CHAT_ROOM);
    const badAccess = parseActorDocument(CHAT_PATH, BAD_ACCESS);
    const noHandler = parseActorDocument(CHAT_PATH, NO_HANDLER);
    const badSyntax = parseActorDocument(CHAT_PATH, "export const config = {");
    const imported = parseActorDocument(CHAT_PATH, `import x from "y";\nexport const config = {};\nexport default async function () {}`);
    h.check("3 an actor document is validated, and a bad one states why",
      chat.ok && chat.actor.name === "ChatRoom" && chat.actor.access === "write" &&
      chat.actor.capability === ACTOR_CAPABILITY.write && chat.actor.persist && chat.actor.events &&
      !badAccess.ok && /not an actor permission/.test(badAccess.error) &&
      !noHandler.ok && /export default/.test(noHandler.error) &&
      !badSyntax.ok && !imported.ok,
      `${badAccess.error} | ${noHandler.error}`);

    // -------------------------------------------------- 4. persistence / load
    for (const f of activeFiles(fs)) await svc.entities.ProjectFile.create({ project_id: project.id, path: f.path, content: f.content });
    const state1 = await loadProjectState(base44, project.id);
    const declared = collectActors(state1.files);
    h.check("4 persisted actors load back through the existing project state",
      declared.count === 2 && declared.errors.length === 0 &&
      declared.actors.map((a) => a.name).join(",") === "BoardView,ChatRoom" &&
      resolveActor(state1.files, "ChatRoom")?.access === "write" &&
      resolveActor(state1.files, "Missing") === null,
      `${declared.count} actor(s) declared`);

    // -------------------------------------------------- 5. build participation
    const goodBuild = runBuild(createFs(state1.files), [], []);
    h.check("5 a valid actor resource builds and is reported",
      goodBuild.status === "success" && goodBuild.logs.some((l) => l === "[actors] 2/2 validated"),
      `${goodBuild.status} · ${goodBuild.logs.find((l) => l.startsWith("[actors]")) || "no actor log"}`);

    // -------------------------------------------------- 6. deterministic build failure
    const badFs = createFs(state1.files);
    writeFile(badFs, CHAT_PATH, BAD_ACCESS);
    const badBuild = runBuild(badFs, [], []);
    h.check("6 a malformed actor resource fails the build deterministically",
      badBuild.status === "failed" && badBuild.logs.some((l) => l.startsWith("error:") && l.includes(CHAT_PATH)),
      badBuild.logs.find((l) => l.startsWith("error:")) || "no error reported");

    // -------------------------------------------------- 7. push
    const push1 = await pushResources(base44, user, {
      project_id: project.id,
      resources: [
        { path: CONFIG_FILE, content: configContent("actor-resources") },
        { path: CHAT_PATH, content: CHAT_ROOM },
        { path: VIEW_PATH, content: BOARD_VIEW },
      ],
      message: "actor push",
    });
    const pushedRows = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    h.check("7 push applies actor resources through the existing sync layer",
      push1.ok && push1.kinds.includes("actors") &&
      pushedRows.find((f) => f.path === CHAT_PATH)?.content === CHAT_ROOM &&
      pushedRows.some((f) => f.path === VIEW_PATH),
      `created ${push1.created} · updated ${push1.updated} · version ${push1.version}`);

    // -------------------------------------------------- 8. pull
    const pull1 = await pullResources(base44, user, { project_id: project.id });
    const pulledActors = pull1.resources.filter((r) => r.kind === "actors");
    h.check("8 pull returns each actor as a canonical resource exactly once",
      pulledActors.length === 2 &&
      pulledActors.every((r) => parseActorDocument(r.path, r.content).ok) &&
      pulledActors.some((r) => r.identity === "ChatRoom" && r.path === CHAT_PATH) &&
      !pull1.unsupported.some((u) => u.kind === "actors"),
      `${pulledActors.length} actor resource(s) · unsupported=${JSON.stringify(pull1.unsupported.map((u) => u.kind))}`);

    // -------------------------------------------------- 9. idempotent sync
    const versionsBefore = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 20)).length;
    const push2 = await pushResources(base44, user, { project_id: project.id, resources: pull1.resources });
    const status = await resourceStatus(base44, user, { project_id: project.id, resources: pull1.resources });
    const versionsAfter = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 20)).length;
    h.check("9 re-pushing unchanged actors writes nothing and creates no version",
      push2.created === 0 && push2.updated === 0 && !push2.version_created &&
      versionsAfter === versionsBefore &&
      status.resources.filter((r) => r.kind === "actors").every((r) => r.state === "identical"),
      `unchanged ${push2.unchanged} · versions ${versionsBefore}→${versionsAfter}`);

    // -------------------------------------------------- 10. conflict + malformed refusal
    await h.expectThrow("10 a stale push is refused with a conflict",
      () => pushResources(base44, user, { project_id: project.id, resources: pull1.resources, expected_version: 0 }), "RESOURCE_CONFLICT");
    await h.expectThrow("10b a malformed actor push is refused",
      () => pushResources(base44, user, { project_id: project.id, resources: [{ path: CHAT_PATH, content: BAD_ACCESS }] }), "RESOURCE_MALFORMED");
    const mismatch = (() => { try { validateResource({ path: CHAT_PATH, kind: "functions", content: CHAT_ROOM }); return null; } catch (e) { return e.code; } })();
    h.check("10c an actor declared as another kind is refused", mismatch === "RESOURCE_KIND_MISMATCH", `code ${mismatch}`);

    // -------------------------------------------------- 11. runtime resolution
    const resolved = await loadProjectActor(svc, project.id, "ChatRoom");
    let missingCode = null;
    try { await loadProjectActor(svc, project.id, "Nope"); } catch (e) { missingCode = e.code; }
    h.check("11 the runtime resolves an actor by exact canonical path",
      resolved.actor.name === "ChatRoom" && resolved.source === CHAT_ROOM && missingCode === "ACTOR_NOT_FOUND",
      `resolved ChatRoom · unknown → ${missingCode}`);

    // -------------------------------------------------- 12. invocation + state persistence
    const inv1 = await invokeActor(svc, { project, entities: state1.entities, actor: resolved.actor, source: resolved.source, room: "lobby", message: { type: "say", data: { text: "hello" } }, user });
    const inv2 = await invokeActor(svc, { project, entities: state1.entities, actor: resolved.actor, source: resolved.source, room: "lobby", message: { type: "say", data: { text: "again" } }, user });
    const snap = await roomSnapshot(svc, project.id, "ChatRoom", "lobby");
    h.check("12 invocation runs the handler and room state persists across calls",
      inv1.ok && inv1.reply.count === 1 && inv2.reply.count === 2 &&
      snap.exists && snap.state.count === 2 && snap.state.messages.length === 2 &&
      snap.state.messages[1].text === "again" && snap.invocations === 2,
      `replies ${inv1.reply.count}/${inv2.reply.count} · persisted ${snap.state.count}`);

    // -------------------------------------------------- 13. room / session identity
    const otherRoom = await invokeActor(svc, { project, entities: state1.entities, actor: resolved.actor, source: resolved.source, room: "green", message: { type: "say", data: { text: "elsewhere" } }, user });
    const lobby = await roomSnapshot(svc, project.id, "ChatRoom", "lobby");
    let badRoom = null;
    try { await invokeActor(svc, { project, entities: state1.entities, actor: resolved.actor, source: resolved.source, room: "bad room!", message: null, user }); } catch (e) { badRoom = e.code; }
    h.check("13 room and session identity are deterministic and isolated",
      roomKey("ChatRoom", "lobby") === "ChatRoom:lobby" &&
      sessionKey("ChatRoom", "lobby", user.id) === `ChatRoom:lobby#${user.id}` &&
      inv1.session_id === inv2.session_id &&
      otherRoom.state.count === 1 && lobby.state.count === 2 &&
      badRoom === "ACTOR_ROOM_INVALID",
      `lobby=${lobby.state.count} green=${otherRoom.state.count} · invalid room → ${badRoom}`);

    // -------------------------------------------------- 14. event / message stream
    const all = await roomEvents(svc, project.id, "ChatRoom", "lobby", { since: 0 });
    const tail = await roomEvents(svc, project.id, "ChatRoom", "lobby", { since: inv1.seq });
    h.check("14 each invocation appends one monotonic event a client can tail",
      all.count === 2 && all.events[0].seq < all.events[1].seq &&
      all.events[0].type === "said" && all.events[0].data.text === "hello" &&
      tail.count === 1 && tail.events[0].data.text === "again",
      `stream=${all.count} · since ${inv1.seq} → ${tail.count}`);

    // -------------------------------------------------- 15. presence
    const join = await connectActor(svc, project.id, "ChatRoom", "lobby", { participant: user.id });
    const rejoin = await connectActor(svc, project.id, "ChatRoom", "lobby", { participant: user.id });
    const joined = await roomSnapshot(svc, project.id, "ChatRoom", "lobby");
    const left = await disconnectActor(svc, project.id, "ChatRoom", "lobby", { participant: user.id });
    const after = await roomSnapshot(svc, project.id, "ChatRoom", "lobby");
    h.check("15 presence joins once per participant and leaves cleanly",
      join.joined && !rejoin.joined && joined.connections.length === 1 &&
      joined.connections[0].session_id === sessionKey("ChatRoom", "lobby", user.id) &&
      left.left && after.connections.length === 0 &&
      after.state.count === 2,
      `join=${join.joined} rejoin=${rejoin.joined} · after leave ${after.connections.length} connection(s)`);

    // -------------------------------------------------- 16. authorization / denial
    const foreignWs = await svc.entities.Workspace.create({ name: `actorforeign-${Date.now()}`, owner_id: "someone-else", status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "not-mine", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(foreignProject.id);
    let foreignErr = null;
    try { await loadAuthorizedProject(base44, user, foreignProject.id, "project.read"); } catch (e) { foreignErr = e; }
    const readActor = resolveActor(state1.files, "BoardView");
    const ownRead = await loadAuthorizedProject(base44, user, project.id, readActor.capability);
    h.check("16 the control plane authorizes through the existing authz/RBAC path",
      !!foreignErr && (foreignErr.status === 403 || foreignErr.status === 404) &&
      readActor.capability === ACTOR_CAPABILITY.read && resolved.actor.capability === ACTOR_CAPABILITY.write &&
      ownRead.project.id === project.id,
      `foreign project → ${foreignErr?.status} ${foreignErr?.code || ""} · BoardView needs ${readActor.capability}`);

    // -------------------------------------------------- 17. control-plane surface
    const surface = await base44.functions.invoke("actorInvoke", { op: "list", project_id: project.id });
    const denied = await base44.functions.invoke("actorInvoke", { op: "list", project_id: foreignProject.id }).catch((e) => e.response || { status: e.status || 0, data: {} });
    h.check("17 actors are reachable through the control plane and denied elsewhere",
      surface.data.ok && surface.data.count === 2 &&
      surface.data.actors.some((a) => a.name === "ChatRoom" && a.capability === "project.write") &&
      (denied.status === 403 || denied.status === 404),
      `list=${surface.data.count} · foreign status ${denied.status}`);

    // -------------------------------------------------- 18. invocation through the surface
    const invoked = await base44.functions.invoke("actorInvoke", { op: "invoke", project_id: project.id, actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "via surface" } } });
    const readOnly = await base44.functions.invoke("actorInvoke", { op: "invoke", project_id: project.id, actor: "BoardView", room: "lobby", message: null });
    h.check("18 the surface invokes an actor and keeps each actor's own scope",
      invoked.data.ok && invoked.data.reply.count === 3 &&
      readOnly.data.ok && readOnly.data.reply.viewers === 0 &&
      (await roomSnapshot(svc, project.id, "BoardView", "lobby")).state.count === undefined,
      `chat count ${invoked.data.reply?.count} · stateless actor persisted nothing`);

    // -------------------------------------------------- 19. deploy + legacy compatibility
    const state2 = await loadProjectState(base44, project.id);
    const deployBuild = runBuild(createFs(state2.files), state2.entities, []);
    const scoped = await pushResources(base44, user, { project_id: project.id, resources: [{ path: CHAT_PATH, content: CHAT_ROOM }, { path: VIEW_PATH, content: BOARD_VIEW }], kinds: ["actors"], mode: "full" });
    const afterScoped = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    h.check("19 actors ship with the project and prune nothing outside their scope",
      deployBuild.status === "success" &&
      scoped.removed === 0 &&
      afterScoped.some((f) => f.path === ENTRY_FILE) && afterScoped.some((f) => f.path === CONFIG_FILE),
      `build ${deployBuild.status} · removed ${scoped.removed}`);

    // -------------------------------------------------- 20. full-sync removal
    const removal = await pushResources(base44, user, { project_id: project.id, resources: [], kinds: ["actors"], mode: "full" });
    const afterRemoval = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    const finalBuild = runBuild(createFs((await loadProjectState(base44, project.id)).files), [], []);
    let goneCode = null;
    try { await loadProjectActor(svc, project.id, "ChatRoom"); } catch (e) { goneCode = e.code; }
    h.check("20 full sync removes actors and leaves the project buildable",
      removal.removed === 2 && !afterRemoval.some((f) => f.path === CHAT_PATH) && !afterRemoval.some((f) => f.path === VIEW_PATH) &&
      afterRemoval.some((f) => f.path === ENTRY_FILE) &&
      finalBuild.status === "success" && goneCode === "ACTOR_NOT_FOUND",
      `removed ${removal.removed} · build ${finalBuild.status} · resolve → ${goneCode}`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["AuditLog", "TraceEvent", "WorkspaceMember", "Project"]);
    }
  }
}