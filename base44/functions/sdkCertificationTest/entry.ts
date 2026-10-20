// Certification for THE unified generated-app SDK.
//
//   generated app → NexusAI SDK (thin surface) → existing platform contracts
//
// Runs against the REAL modules and the REAL data layer: the real runtime export contract
// (shared/runtimeExports.ts), the real build engine and artifact builder (shared/deploy.ts), the real
// deployment worker, the real public runtime (appRuntime, over its actual HTTP surface), the real
// generated-app auth (shared/appAuth.ts), the real actor runtime, the real agent resource + tool gate,
// the real skill catalog, the real connector resource, the real function executor and the real project
// type-emission path. Nothing is stubbed, and this suite introduces no second runtime, auth system,
// realtime engine, agent engine, connector runtime, authorization system or type generator of its own —
// every assertion reads an outcome back out of the platform's own contracts.
//
// The SDK's browser half is a pure ALIAS layer over the runtime module's exports, so the authoritative
// thing to certify server-side is the runtime export contract (which both halves are kept in sync with)
// plus the server contract each namespace binds to. A namespace with no capability in that contract is
// reported as missing rather than assumed to work.
//
// HARNESS RULE: every check's condition and detail are evaluated lazily. A response that never arrived
// (404, transport failure) makes the check FAIL with the thrown message as its diagnostic — it never
// aborts the suite and it is never counted as a pass.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, writeFile, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { createVersion } from "../../shared/persistence.ts";
import { RUNTIME_EXPORTS, ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { runDeploymentStep, ensureProjectSlug, currentLiveDeployment, loadArtifactPayload, deploymentPath } from "../../shared/deploy.ts";
import { sessionKey } from "../../shared/realtimeRuntime.ts";
import { ACTOR_ROOMS_ENTITY } from "../../shared/actorRuntime.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { actorFilePath } from "../../shared/actorResource.ts";
import { agentDocumentContent, resolveAgent, validateAgentReferences, agentPermissionGate, parseAgentDocument, GRANTABLE_TOOLS } from "../../shared/agentResource.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";
import { agentSkillFilePath, agentSkillDocumentContent } from "../../shared/agentSkillResource.ts";
import { connectorFilePath, connectorDocumentContent, connectorRuntimePath, connectorRuntimeContent, resolveConnector } from "../../shared/connectorResource.ts";
import { normalizeIntegration } from "../../shared/integrations.ts";
import { selectSkills, skillContract, skillTools } from "../../shared/skills.ts";
// THE project type-emission path — the same call the run pipeline and the CLI make.
import { emitProjectTypes } from "../../shared/typeEmit.ts";
import { functionPath } from "../../shared/functionPaths.ts";
// The EXISTING secret mechanism: values are sealed at rest to project id + name, exactly as the
// projectSecrets endpoint stores them. The fixture value below is an ephemeral placeholder.
import { encryptSecretValue } from "../../shared/secretCrypto.ts";

// ---------------------------------------------------------------- fixtures (generated app source)
const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
// The legacy (pre-SDK) import shape AND the unified sdk import, side by side: both must keep working.
const APP = `import { html, sdk, db, auth, server, files, analytics, navigate, Link, useState } from 'runtime';
export default function App() {
  const [n, setN] = useState(0);
  return html\`<div class="page"><h1 class="card-title">SDK \${n}</h1></div>\`;
}
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

// A backend function reachable as sdk.functions.ping(payload). It reports the EXECUTION identity the
// server resolved, so the frontend and backend halves of the SDK can be compared.
const PING = `export const config = { method: "POST", secrets: [] };
export default async function handler(ctx) {
  const identity = {
    authenticated: ctx.auth.isAuthenticated(),
    user: ctx.user,
    session: ctx.auth.session,
    roles: ctx.auth.roles(),
    permissions: await ctx.auth.permissions(),
    execution: ctx.auth.identity
  };
  return { body: { ok: true, echo: (ctx.request.body || {}).echo || null, user_id: ctx.user ? ctx.user.id : null, identity: identity } };
}
`;

// Connector consumption: allowed ONLY from a backend function, and only through the declared
// operations. Never from the browser, and never with a readable credential.
const USE_CONNECTOR = `export const config = { method: "POST", secrets: [] };
export default async function handler(ctx) {
  const api = ctx.integrations.weather;
  const ops = api ? Object.keys(api) : [];
  let unknown = null, secret = null;
  try { await api.missingOperation({}); } catch (e) { unknown = e.code || e.message; }
  try { ctx.secrets.get("WEATHER_KEY"); } catch (e) { secret = e.message; }
  return { body: { ops, callable: !!api && typeof api.current === "function", unknown, secret } };
}
`;
const USE_UNDECLARED = `export const config = { method: "POST", secrets: [] };
export default async function handler(ctx) {
  return { body: { result: await ctx.integrations.weather.current({}) } };
}
`;

const LEGACY_FN = `export const config = { method: "POST", secrets: [] };
export default async function handler(ctx) { return { body: { legacy: true } }; }
`;

const ACTOR_PATH = actorFilePath("ChatRoom");
const AGENT_PATH = agentFilePath("helper");
const SKILL_PATH = agentSkillFilePath("triage");
const CONNECTOR_PATH = connectorFilePath("weather");
const PASSWORD = "Sup3r-Secret-Sdk-1";
const NOTE_ENTITY = { name: "Note", fields: { body: { type: "text", required: true } } };
// The connector's credential NAME and the ephemeral placeholder the fixture project configures for it.
// The placeholder exists only in this project's encrypted ProjectSecret row for the duration of the run.
const FIXTURE_SECRET_NAME = "WEATHER_KEY";
const FIXTURE_SECRET_VALUE = "test-key";

const WEATHER = normalizeIntegration({
  name: "weather", description: "Weather API",
  base_url: "https://api.weather.test",
  auth: { type: "api_key", secret: FIXTURE_SECRET_NAME, in: "header", name: "X-Api-Key" },
  operations: [{ name: "current", method: "GET", path: "/current" }],
});

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 700) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

async function drive(svc, deploymentId, max = 8) {
  let out = null;
  for (let i = 0; i < max; i++) {
    out = await runDeploymentStep(svc, deploymentId);
    if (out.done) break;
  }
  let deployment = await svc.entities.Deployment.get(deploymentId);
  for (let i = 0; i < 5 && out?.status && deployment.status !== out.status; i++) {
    await new Promise((r) => setTimeout(r, 250));
    deployment = await svc.entities.Deployment.get(deploymentId);
  }
  return { ...out, deployment };
}

export default async function (req) {
  const h = createHarness();
  // Lazy check: the condition and the detail are thunks. A thunk that throws (typically a chain
  // through a response body that never arrived) records a FAILED check carrying the error, so the
  // suite reports every declared check instead of aborting on the first missing response.
  const check = (name, cond, detail = "") => {
    let ok;
    try { ok = typeof cond === "function" ? cond() : cond; } catch (e) { return h.check(name, false, `evaluation threw ${e.name}: ${e.message} (response missing or malformed)`); }
    let det;
    try { det = typeof detail === "function" ? detail() : detail; } catch (e) { det = `detail unavailable: ${e.message}`; }
    return h.check(name, ok, det);
  };
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  // The PRODUCTION SDK transport: exactly the calls the browser bridge makes.
  const runtime = (body) =>
    svc.functions.invoke("appRuntime", body)
      .then((r) => ({ status: r.status ?? 200, data: r.data ?? r }))
      .catch((e) => ({ status: e.status || e.response?.status || 0, data: e.response?.data || { error: e.message } }));
  const act = (slug, action, body = {}, token = null) =>
    runtime({ action, slug, ...body, ...(token ? { session_token: token } : {}) });
  const ns = (slug, scope, op, args = {}, token = null) => act(slug, scope, { op, args }, token);
  const builder = (fn, payload) =>
    base44.functions.invoke(fn, payload)
      .then((r) => ({ status: r.status ?? 200, data: r.data ?? r }))
      .catch((e) => ({ status: e.status || e.response?.status || 0, data: e.response?.data || { error: e.message } }));

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const stamp = Date.now();

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `sdkcert-${stamp}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);

    const makeProject = async (name, files, { rls = true, entities = [NOTE_ENTITY], secrets = [] } = {}) => {
      const p = await svc.entities.Project.create({
        workspace_id: ws.id, name, framework: "preact-htm", status: "draft", version_count: 0, rls_enabled: rls,
      });
      created.projects.push(p.id);
      const fs = createFs([]);
      for (const [path, content] of Object.entries(files)) writeFile(fs, path, content);
      for (const f of activeFiles(fs)) await svc.entities.ProjectFile.create({ project_id: p.id, path: f.path, content: f.content });
      for (const e of entities) await svc.entities.AppEntity.create({ project_id: p.id, name: e.name, fields: e.fields });
      // Fixture credentials go through the EXISTING secret mechanism: encrypted at rest, sealed to
      // this project id + name, backend_only. The row is purged with the project in cleanup.
      for (const s of secrets) {
        await svc.entities.ProjectSecret.create({
          project_id: p.id, name: s, value: await encryptSecretValue(p.id, s, FIXTURE_SECRET_VALUE),
          description: "certification fixture credential", required: true, access: "backend_only",
        });
      }
      const secretRefs = secrets.map((s) => ({ name: s, description: "certification fixture credential", required: true }));
      const version = await createVersion(svc, { project: p, fs, entities, secrets: secretRefs, message: `${name} v1`, changedFiles: [] });
      return { project: await svc.entities.Project.get(p.id), version, fs, entities, secretRefs };
    };

    const deploy = async (project, version) => {
      const slug = await ensureProjectSlug(svc, project);
      const now = new Date().toISOString();
      const d = await svc.entities.Deployment.create({
        project_id: project.id, workspace_id: project.workspace_id, version_id: version.id, version_number: version.number,
        environment: "production", status: "QUEUED", trigger: "user", deployment_url: deploymentPath(slug, "production"),
        deployed_by: user.id, cancel_requested: false, recovery_count: 0, started_at: now, heartbeat_at: now,
      });
      return drive(svc, d.id);
    };

    const FULL = {
      [ENTRY_FILE]: MAIN, "src/App.js": APP, "styles.css": STYLES,
      [ACTOR_PATH]: CHAT_ROOM,
      [AGENT_PATH]: agentDocumentContent({ name: "helper", instructions: "Help with this project.", tools: ["read_file"], skills: ["triage"] }),
      [SKILL_PATH]: agentSkillDocumentContent({ name: "triage", description: "Triage guidance", body: "Triage incoming notes by urgency." }),
      [CONNECTOR_PATH]: connectorDocumentContent(WEATHER),
      [connectorRuntimePath("weather")]: connectorRuntimeContent(WEATHER),
      "base44/functions/ping/entry.ts": PING,
    };

    const a = await makeProject(`SDK A ${stamp}`, FULL, { secrets: [FIXTURE_SECRET_NAME] });
    const b = await makeProject(`SDK B ${stamp}`, { [ENTRY_FILE]: MAIN, "src/App.js": APP, "styles.css": STYLES });
    // A legacy, pre-Base44-layout project: flat function path, no canonical resources at all.
    const legacy = await makeProject(`SDK Legacy ${stamp}`, {
      [ENTRY_FILE]: MAIN, "src/App.js": APP, "styles.css": STYLES, [functionPath("legacyFn")]: LEGACY_FN,
    }, { rls: false });

    const buildA = runBuild(createFs(activeFiles(a.fs)), a.entities, a.secretRefs);
    const runA = await deploy(a.project, a.version);
    const runB = await deploy(b.project, b.version);
    const runLegacy = await deploy(legacy.project, legacy.version);
    const projectA = await svc.entities.Project.get(a.project.id);
    const projectB = await svc.entities.Project.get(b.project.id);
    const projectLegacy = await svc.entities.Project.get(legacy.project.id);
    const slugA = projectA.slug, slugB = projectB.slug, slugLegacy = projectLegacy.slug;

    const liveA = await currentLiveDeployment(svc, projectA, "production");
    const artifactA = liveA ? await svc.entities.DeploymentArtifact.get(liveA.artifact_id) : null;
    const payloadA = artifactA ? await loadArtifactPayload(artifactA) : { client_files: [], functions: [], entities: [], integrations: [] };
    const liveLegacy = await currentLiveDeployment(svc, projectLegacy, "production");
    const payloadLegacy = liveLegacy ? await loadArtifactPayload(await svc.entities.DeploymentArtifact.get(liveLegacy.artifact_id)) : {};

    // Real generated-app end-users through the REAL auth path.
    const u1 = await signUpWithSession(svc, projectA.id, { email: `u1-${stamp}@sdk.test`, password: PASSWORD, full_name: "User One" }, {});
    const u2 = await signUpWithSession(svc, projectA.id, { email: `u2-${stamp}@sdk.test`, password: PASSWORD, full_name: "User Two" }, {});
    const ub = await signUpWithSession(svc, projectB.id, { email: `ub-${stamp}@sdk.test`, password: PASSWORD, full_name: "User B" }, {});

    // ================================================================ PHASE 1 — UNIFIED SDK
    const artifact = await act(slugA, "artifact");
    check("1 the unified `sdk` object exists in the generated-app runtime contract", () =>
      RUNTIME_EXPORTS.includes("sdk") && buildA.status === "success" && runA.status === "LIVE" &&
      artifact.status === 200 && artifact.data.entry === ENTRY_FILE,
      () => `runtime exports: ${RUNTIME_EXPORTS.length} · build ${buildA.status} · deployment ${runA.status}${runA.deployment?.failure_code ? ` (${runA.deployment.failure_code}: ${runA.deployment.failure_summary} · ${(runA.deployment.build_diagnostics || []).join(" | ")})` : ""}`);

    const note1 = await ns(slugA, "db", "create", { entity: "Note", data: { body: "from sdk.entities" } }, u1.token);
    const noteList = await ns(slugA, "db", "filter", { entity: "Note", query: {} }, u1.token);
    check("2 sdk.entities is the existing project-scoped data contract (db), not a second data layer", () =>
      RUNTIME_EXPORTS.includes("db") &&
      note1.status === 200 && note1.data.result.body === "from sdk.entities" &&
      noteList.status === 200 && noteList.data.result.length === 1 &&
      payloadA.entities.some((e) => e.name === "Note"),
      () => `create ${note1.status} · list ${noteList.data.result?.length}`);

    const ping = await act(slugA, "fn", { function_name: "ping", payload: { echo: "hi" } }, u1.token);
    check("3 sdk.functions is the existing sandboxed backend-function executor (server)", () =>
      RUNTIME_EXPORTS.includes("server") &&
      ping.status === 200 && ping.data.status === 200 && ping.data.body.ok === true &&
      ping.data.body.echo === "hi" && ping.data.body.user_id === u1.user.id &&
      payloadA.functions.some((f) => f.name === "ping"),
      () => `ping → ${ping.data.body?.echo} as ${ping.data.body?.user_id}`);

    const me = await ns(slugA, "auth", "me", {}, u1.token);
    const anonMe = await ns(slugA, "auth", "me", {});
    check("4 sdk.auth is the existing generated-app end-user identity contract", () =>
      RUNTIME_EXPORTS.includes("auth") &&
      me.status === 200 && me.data.authenticated === true && me.data.user.id === u1.user.id &&
      Array.isArray(me.data.roles) && Array.isArray(me.data.permissions) &&
      !JSON.stringify(me.data).includes(u1.token) &&
      anonMe.data.authenticated === false && anonMe.data.user === null,
      () => `me ${me.data.user?.id} · anon authenticated=${anonMe.data?.authenticated}`);

    const session = await ns(slugA, "analytics", "session_start", { session_key: `as-sdk-${stamp}`, page: "/" }, u1.token);
    const track = await ns(slugA, "analytics", "track", { session_key: `as-sdk-${stamp}`, event: { event_name: "sdk_certified", properties: { k: "v" } } }, u1.token);
    check("5 sdk.analytics is the existing server-side analytics ingestion contract", () =>
      RUNTIME_EXPORTS.includes("analytics") &&
      session.status === 200 && !!session.data.result &&
      track.status === 200 && !!track.data.result,
      () => `session ${session.status} · track ${track.status}`);

    const upload = await ns(slugA, "files", "upload", { filename: "note.txt", content_type: "text/plain", content_base64: btoa("hello sdk") }, u1.token);
    const fileList = await ns(slugA, "files", "list", {}, u1.token);
    const access = upload.data.result?.id ? await ns(slugA, "files", "access", { id: upload.data.result.id }, u1.token) : { data: {} };
    check("6 sdk.files is the existing private file-storage contract (no storage handle reaches the app)", () =>
      RUNTIME_EXPORTS.includes("files") &&
      upload.status === 200 && !!upload.data.result.id &&
      !JSON.stringify(upload.data.result).includes("file_uri") &&
      fileList.status === 200 && fileList.data.result.length === 1 &&
      !!access.data.result?.url,
      () => `upload ${upload.data.result?.id} · list ${fileList.data.result?.length}`);

    // sdk.types: the generated declarations the app develops against, produced by THE project
    // type-emission path (the one the run pipeline commits and the CLI writes) from the fixture's own
    // files and entities. Certified: the SDK exposes `types`, the emitted declarations carry the
    // entity and function registries as before AND the actor, agent and connector registries, and the
    // emission is deterministic for identical project state.
    const emitted = emitProjectTypes(a.fs, a.entities);
    const emittedAgain = emitProjectTypes(createFs(activeFiles(a.fs)), a.entities);
    check("7 sdk.types exposes generated declarations covering every SDK resource kind", () =>
      RUNTIME_EXPORTS.includes("types") &&
      typeof emitted === "string" && emitted.length > 0 &&
      emitted.includes("Note") && emitted.includes("ping") &&
      emitted.includes("ActorNameRegistry") && emitted.includes("ChatRoom") &&
      emitted.includes("AgentNameRegistry") && emitted.includes("helper") &&
      emitted.includes("ConnectorTypeRegistry") && emitted.includes("weather") &&
      emitted === emittedAgain,
      () => `types exported=${RUNTIME_EXPORTS.includes("types")} · entity=${emitted.includes("Note")} function=${emitted.includes("ping")} actors=${emitted.includes("ActorNameRegistry")} agents=${emitted.includes("AgentNameRegistry")} connectors=${emitted.includes("ConnectorTypeRegistry")} · deterministic=${emitted === emittedAgain} · ${emitted.length} chars`);

    const LEGACY_NAMES = ["html", "render", "h", "useState", "useEffect", "useMemo", "useRef", "useCallback", "useReducer", "db", "auth", "files", "server", "analytics", "navigate", "useRoute", "Link"];
    check("8 existing generated-app imports remain compatible alongside the sdk object", () =>
      LEGACY_NAMES.every((n) => RUNTIME_EXPORTS.includes(n)) &&
      // The deployed app imports BOTH shapes in one module and still builds, ships and serves.
      buildA.status === "success" &&
      payloadA.client_files.some((f) => f.path === "src/App.js" && f.content.includes("sdk, db, auth, server")) &&
      artifact.data.files.some((f) => f.path === ENTRY_FILE),
      () => `${LEGACY_NAMES.length} legacy exports intact · mixed-import app deployed=${artifact.status === 200}`);

    // ================================================================ PHASE 2 — ACTORS
    const actors = await ns(slugA, "realtime", "list", {}, u1.token);
    check("9 sdk.actors is the existing actor runtime, exposed through the deployed artifact", () =>
      actors.status === 200 && actors.data.result.count === 1 && actors.data.result.actors[0].name === "ChatRoom" &&
      (payloadA.actors || []).length === 1 && payloadA.actors[0].source === CHAT_ROOM &&
      !payloadA.client_files.some((f) => f.path === ACTOR_PATH),
      () => `${actors.data.result?.count} actor(s) · server source kept out of the client bundle`);

    const send1 = await ns(slugA, "realtime", "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "one" } } }, u1.token);
    check("10 sdk.actors invocation runs the deployed actor's own handler", () =>
      send1.status === 200 && send1.data.result.ok === true &&
      send1.data.result.reply.count === 1 && send1.data.result.reply.user === u1.user.id,
      () => `reply count ${send1.data.result?.reply?.count}`);

    const expectedSession = sessionKey("ChatRoom", "lobby", `user:${u1.user.id}`);
    const connect = await ns(slugA, "realtime", "connect", { actor: "ChatRoom", room: "lobby", participant: "attacker" }, u1.token);
    check("11 actor room/session identity is derived from the session and is deterministic", () =>
      connect.status === 200 && connect.data.result.session_id === expectedSession &&
      send1.data.result.session_id === expectedSession &&
      !JSON.stringify(connect.data.result).includes("attacker"),
      () => `session ${connect.data.result?.session_id} (claimed label ignored)`);

    const send2 = await ns(slugA, "realtime", "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "two" } } }, u1.token);
    const state = await ns(slugA, "realtime", "state", { actor: "ChatRoom", room: "lobby" }, u1.token);
    check("12 actor state persists in the existing store across separate SDK calls", () =>
      send2.data.result.reply.count === 2 &&
      state.status === 200 && state.data.result.exists === true &&
      state.data.result.state.count === 2 && state.data.result.state.messages.length === 2 &&
      state.data.result.invocations === 2,
      () => `state ${state.data.result?.state?.count} · ${state.data.result?.invocations} invocation(s)`);

    const events = await ns(slugA, "realtime", "events", { actor: "ChatRoom", room: "lobby", since: 0 }, u1.token);
    const stream = events.data.result?.events || [];
    check("13 actor events are the existing monotonic room stream an SDK caller tails", () =>
      events.status === 200 && stream.length >= 3 &&
      stream.every((e, i) => i === 0 || Number(stream[i - 1].seq) < Number(e.seq)) &&
      stream.some((e) => e.type === "said" && e.data.text === "one" && e.by === `user:${u1.user.id}`) &&
      stream.some((e) => e.type === "actor.join" && e.by === `user:${u1.user.id}`),
      () => `${stream.length} event(s): ${stream.map((e) => e.type).join(",")}`);

    const anonSend = await ns(slugA, "realtime", "send", { actor: "ChatRoom", room: "lobby", message: { type: "say", data: { text: "intruder" } } });
    const foreignRoom = await ns(slugB, "realtime", "state", { actor: "ChatRoom", room: "lobby" }, ub.token);
    const bRooms = await svc.entities.AppRecord.filter({ project_id: projectB.id, entity_name: ACTOR_ROOMS_ENTITY }, "-created_date", 20);
    const stillTwo = await ns(slugA, "realtime", "state", { actor: "ChatRoom", room: "lobby" }, u1.token);
    check("14 actor authorization and project isolation are the platform's, applied before any room is touched", () =>
      anonSend.status === 401 && anonSend.data.code === "REALTIME_AUTH_REQUIRED" &&
      foreignRoom.status === 404 && foreignRoom.data.code === "ACTOR_NOT_FOUND" &&
      bRooms.length === 0 && stillTwo.data.result.state.count === 2,
      () => `anon → ${anonSend.status} ${anonSend.data.code} · project B → ${foreignRoom.data.code}`);

    // ================================================================ PHASE 2 — AGENTS
    const agents = await ns(slugA, "agents", "list", {}, u1.token);
    const agentDescribe = await ns(slugA, "agents", "describe", { name: "helper" }, u1.token);
    check("15 sdk.agents exposes the project's declared agents from the immutable artifact", () =>
      agents.status === 200 && agents.data.result.count === 1 &&
      agents.data.result.agents[0].name === "helper" &&
      agentDescribe.status === 200 && agentDescribe.data.result.tools.join(",") === "read_file" &&
      // An agent's instructions are server-side context and must never reach a browser.
      !JSON.stringify(agents.data.result).includes("Help with this project"),
      () => `${agents.data.result?.count} agent(s) · status ${agents.status} · instructions withheld from the app`);

    const stateFiles = (await svc.entities.ProjectFile.filter({ project_id: projectA.id }, "path", 100)).map((f) => ({ path: f.path, content: f.content }));
    const resolved = resolveAgent(stateFiles, "helper");
    check("16 agent resolution is the existing agent resource contract, resolved from the project's own files", () =>
      !!resolved && resolved.name === "helper" && resolved.tools.join(",") === "read_file" &&
      resolved.skills.join(",") === "triage" && resolved.instructions.startsWith("Help with") &&
      resolveAgent(stateFiles, "ghost") === null,
      () => `resolved ${resolved?.name} · tools ${resolved?.tools?.join(",")}`);

    const startAgent = await builder("agentRun", { project_id: projectA.id, goal: "Add a note list", agent_name: "helper" });
    check("17 an authorized agent invocation goes through the existing run pipeline", () =>
      (startAgent.status === 202 || startAgent.status === 200) && startAgent.data.status === "QUEUED" && !!startAgent.data.agent_run_id,
      () => `agent run ${startAgent.data?.agent_run_id} → ${startAgent.data?.status} (${startAgent.status}${startAgent.data?.error ? `: ${startAgent.data.error}` : ""})`);

    const foreignWs = await svc.entities.Workspace.create({ name: `sdkforeign-${stamp}`, owner_id: `not-${user.id}`, status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "not-mine", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(foreignProject.id);
    const deniedAgent = await builder("agentRun", { project_id: foreignProject.id, goal: "take over" });
    const unknownAgent = await builder("agentRun", { project_id: projectB.id, goal: "x", agent_name: "helper" });
    const unknownDescribe = await ns(slugA, "agents", "describe", { name: "ghost" }, u1.token);
    check("18 a denied agent invocation fails through the existing authorization path, deterministically", () =>
      (deniedAgent.status === 403 || deniedAgent.status === 404) &&
      unknownAgent.status === 404 && unknownAgent.data.code === "AGENT_NOT_FOUND" &&
      unknownDescribe.status === 404,
      () => `foreign → ${deniedAgent.status} · undeclared agent → ${unknownAgent.status} ${unknownAgent.data?.code} · ghost describe → ${unknownDescribe.status}`);

    const refs = validateAgentReferences(stateFiles);
    const missingSkill = validateAgentReferences(stateFiles.filter((f) => f.path !== SKILL_PATH));
    const catalog = skillContract();
    const strategy = selectSkills({ mode: "default", prompt: "add a backend webhook endpoint", paths: ["functions/notify.js"] });
    check("19 skill resolution is the existing skill contract; a missing skill reference fails closed", () =>
      refs.ok === true && refs.agents[0].skills.join(",") === "triage" &&
      missingSkill.ok === false && missingSkill.missing[0].skill === "triage" &&
      catalog.skills.length > 0 && strategy.source === "skill_catalog" &&
      strategy.skills.some((s) => s.skill_id === "backend-functions") &&
      skillTools(strategy, "default").length > 0,
      () => `refs ok=${refs.ok} · ${catalog.skills.length} catalog skill(s) · strategy ${String(strategy.strategy_id).slice(0, 10)}`);

    const gate = agentPermissionGate(resolved);
    const grantedSystem = parseAgentDocument(AGENT_PATH, agentDocumentContent({ name: "helper", instructions: "x", tools: ["run_build"] }));
    const grantedUnknown = parseAgentDocument(AGENT_PATH, agentDocumentContent({ name: "helper", instructions: "x", tools: ["teleport"] }));
    check("20 agent tool permission enforcement is the existing gate, and can only narrow", () =>
      gate("read_file").allowed === true &&
      gate("write_file").allowed === false && gate("write_file").code === "AGENT_TOOL_NOT_GRANTED" &&
      grantedSystem.ok === false && grantedUnknown.ok === false &&
      !GRANTABLE_TOOLS.includes("run_build"),
      () => `read_file allowed · write_file → ${gate("write_file").code} · system/unknown grants refused`);

    // ================================================================ PHASE 2 — CONNECTORS
    const connectors = await ns(slugA, "connectors", "list", {}, u1.token);
    const connectorDescribe = await ns(slugA, "connectors", "describe", { name: "weather" }, u1.token);
    check("21 sdk.connectors exposes the project's declared connectors from the immutable artifact", () =>
      connectors.status === 200 && connectors.data.result.count === 1 &&
      connectors.data.result.connectors[0].name === "weather" &&
      connectorDescribe.status === 200 &&
      connectorDescribe.data.result.operations.some((o) => o.name === "current" && o.method === "GET"),
      () => `${connectors.data.result?.count} connector(s) · status ${connectors.status} · operations ${connectorDescribe.data.result?.operations?.map((o) => o.name).join(",")}`);

    const resolvedConnector = resolveConnector(stateFiles, "weather");
    check("22 connector resolution is the existing connector resource + integration validator", () =>
      !!resolvedConnector && resolvedConnector.name === "weather" &&
      resolvedConnector.operations.some((o) => o.name === "current") &&
      resolveConnector(stateFiles, "ghost") === null &&
      (payloadA.integrations || []).some((i) => i.name === "weather"),
      () => `resolved ${resolvedConnector?.name} · artifact carries it=${(payloadA.integrations || []).some((i) => i.name === "weather")}`);

    const useConnector = await executeProjectFunction(svc, {
      project: projectA, entities: payloadA.entities, integrations: payloadA.integrations || [],
      name: "useConnector", source: USE_CONNECTOR, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: {} }, user: u1.user,
    });
    check("23 authorized connector use happens only inside the existing backend-function runtime", () =>
      useConnector.status === 200 && useConnector.body.callable === true &&
      useConnector.body.ops.includes("current") && !!useConnector.body.unknown,
      () => `status ${useConnector.status} · callable=${useConnector.body?.callable} · ops ${useConnector.body?.ops?.join(",")} · unknown operation → ${String(useConnector.body?.unknown).slice(0, 40)}`);

    const deniedFrontend = await act(slugA, "connectors", { op: "call", args: { name: "weather", operation: "current" } }, u1.token);
    const deniedUndeclared = await executeProjectFunction(svc, {
      project: projectB, entities: [], integrations: [],
      name: "useUndeclared", source: USE_UNDECLARED, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: {} }, user: null,
    });
    check("24 a denied connector use fails deterministically — the browser can never execute one", () =>
      deniedFrontend.status === 400 && String(deniedFrontend.data.error || "").includes("Unsupported") &&
      deniedUndeclared.status >= 400 && deniedUndeclared.status !== 200,
      () => `frontend execute → ${deniedFrontend.status} · undeclared connector → ${deniedUndeclared.status}`);

    check("25 connector credentials stay server-side: no secret name or value reaches the app", () =>
      // The discovery projection carries no auth block and no credential reference at all.
      !JSON.stringify(connectorDescribe.data.result).includes(FIXTURE_SECRET_NAME) &&
      !("auth" in (connectorDescribe.data.result || {})) &&
      !JSON.stringify(connectors.data.result).includes(FIXTURE_SECRET_NAME) &&
      // The client bundle carries neither the credential name, nor its configured value, nor the
      // connector document.
      !artifact.data.files.some((f) => String(f.content).includes(FIXTURE_SECRET_NAME)) &&
      !artifact.data.files.some((f) => String(f.content).includes(FIXTURE_SECRET_VALUE)) &&
      !JSON.stringify(artifact.data).includes(FIXTURE_SECRET_VALUE) &&
      !artifact.data.files.some((f) => f.path === CONNECTOR_PATH || f.path === connectorRuntimePath("weather")) &&
      // A function that did not declare the credential cannot read it, even while using the connector,
      // and the value never appears in what the function returns.
      String(useConnector.body.secret || "").includes("not declared") &&
      !JSON.stringify(useConnector.body).includes(FIXTURE_SECRET_VALUE) &&
      // The artifact's server half still references the credential by NAME only, never by value.
      (payloadA.integrations || []).some((i) => i.auth?.secret === FIXTURE_SECRET_NAME && !("value" in (i.auth || {}))) &&
      !JSON.stringify(payloadA).includes(FIXTURE_SECRET_VALUE),
      () => `discovery + client bundle credential-free · value absent from artifact=${!JSON.stringify(payloadA).includes(FIXTURE_SECRET_VALUE)} · secrets.get refused: ${String(useConnector.body?.secret || "").slice(0, 46)}`);

    const connectorsB = await ns(slugB, "connectors", "list", {}, ub.token);
    const agentsB = await ns(slugB, "agents", "list", {}, ub.token);
    check("26 connectors are project-isolated: another project's deployment declares none", () =>
      connectorsB.status === 200 && connectorsB.data.result.count === 0 &&
      agentsB.status === 200 && agentsB.data.result.count === 0 &&
      runB.status === "LIVE",
      () => `project B: ${connectorsB.data.result?.count} connector(s) (${connectorsB.status}), ${agentsB.data.result?.count} agent(s) (${agentsB.status})`);

    // ================================================================ CROSS-SURFACE
    const fnIdentity = ping.data.body?.identity;
    check("27 one generated-app session resolves to the SAME identity across every SDK namespace", () =>
      me.data.user.id === u1.user.id &&
      ping.data.body.user_id === u1.user.id &&
      send1.data.result.reply.user === u1.user.id &&
      connect.data.result.session_id === sessionKey("ChatRoom", "lobby", `user:${u1.user.id}`) &&
      // The file the authenticated user uploaded is exactly what that user's own read path returns.
      fileList.data.result.length === 1 && fileList.data.result[0].id === upload.data.result.id,
      () => `auth=${me.data.user?.id} functions=${ping.data.body?.user_id} actors=${send1.data.result?.reply?.user}`);

    check("28 frontend and backend halves of the SDK describe the same identity semantics", () =>
      fnIdentity?.authenticated === true && fnIdentity.user.id === u1.user.id &&
      // The frontend envelope and the backend identity surface agree field-for-field on identity.
      ["authenticated", "user", "session", "roles", "permissions"].every((k) => k in me.data && k in fnIdentity) &&
      fnIdentity.user.email === me.data.user.email &&
      // Neither half ever carries the session token.
      !JSON.stringify(fnIdentity).includes(u1.token),
      () => `backend identity user ${fnIdentity?.user?.id} · same envelope shape as the frontend`);

    const anonDb = await ns(slugA, "db", "create", { entity: "Note", data: { body: "anon" } });
    const anonFiles = await ns(slugA, "files", "list", {});
    const badNamespaceOp = await ns(slugA, "agents", "mutate", {}, u1.token);
    const unknownFn = await act(slugA, "fn", { function_name: "nope", payload: {} }, u1.token);
    check("29 unauthorized or unsupported SDK access fails deterministically, never silently", () =>
      anonDb.status >= 400 && anonFiles.status >= 400 &&
      badNamespaceOp.status === 400 && unknownFn.status === 404 &&
      anonSend.status === 401 && anonMe.data.authenticated === false,
      () => `anon db ${anonDb.status} · anon files ${anonFiles.status} · bad op ${badNamespaceOp.status} · unknown fn ${unknownFn.status}`);

    const previewAuthMe = await builder("previewAuth", { project_id: projectA.id, op: "me", args: {} });
    const previewEnvelope = previewAuthMe.data?.result || previewAuthMe.data || {};
    const previewActorState = await builder("actorInvoke", { op: "state", project_id: projectA.id, actor: "ChatRoom", room: "lobby" });
    const previewData = await builder("previewData", { project_id: projectA.id, op: "filter", args: { entity: "Note", query: {} } });
    check("30 preview and production speak the SAME SDK contract over the same stores", () =>
      previewAuthMe.status === 200 &&
      ["authenticated", "user", "session", "roles", "permissions"].every((k) => k in previewEnvelope) &&
      previewActorState.status === 200 && previewActorState.data.state.count === state.data.result.state.count &&
      ["exists", "state", "seq", "invocations", "connections"].every((k) => k in previewActorState.data) &&
      ["exists", "state", "seq", "invocations", "connections"].every((k) => k in state.data.result) &&
      previewData.status === 200 && Array.isArray(previewData.data.result),
      () => `preview auth ${previewAuthMe.status} · preview room state ${previewActorState.data?.state?.count} = production ${state.data.result?.state?.count} · preview data ${previewData.status}`);

    const otherUserNotes = await ns(slugA, "db", "filter", { entity: "Note", query: {} }, u2.token);
    const otherUserGet = await ns(slugA, "db", "get", { entity: "Note", id: note1.data.result.id }, u2.token);
    check("31 the SDK respects the existing RLS/authz posture — it never widens access", () =>
      projectA.rls_enabled === true &&
      otherUserNotes.status === 200 && otherUserNotes.data.result.length === 0 &&
      otherUserGet.status >= 400 &&
      noteList.data.result.length === 1,
      () => `owner sees ${noteList.data.result?.length}, other user sees ${otherUserNotes.data.result?.length}, foreign get → ${otherUserGet.status}`);

    const bNotes = await ns(slugB, "db", "filter", { entity: "Note", query: {} }, ub.token);
    const crossToken = await ns(slugB, "auth", "me", {}, u1.token);
    const aRecords = await svc.entities.AppRecord.filter({ project_id: projectA.id, entity_name: "Note" }, "-created_date", 20);
    const bRecords = await svc.entities.AppRecord.filter({ project_id: projectB.id, entity_name: "Note" }, "-created_date", 20);
    check("32 the SDK preserves project isolation across every namespace", () =>
      bNotes.status === 200 && bNotes.data.result.length === 0 &&
      crossToken.data.authenticated === false &&
      aRecords.length === 1 && bRecords.length === 0,
      () => `A ${aRecords.length} record(s) · B ${bRecords.length} · A token in B authenticated=${crossToken.data?.authenticated}`);

    // Full lifecycle on ONE fresh session: auth → entities → functions → files → analytics → actors
    // → discovery → logout, all through the deployed SDK surface.
    const lc = {};
    lc.signup = await ns(slugA, "auth", "signup", { email: `lc-${stamp}@sdk.test`, password: PASSWORD, full_name: "Lifecycle" }, null);
    // G-2: register mints no session. The OTP code is undeliverable in this harness (no real
    // email transport), so complete the verification directly and establish the lifecycle
    // session through the documented post-verification login op.
    await svc.entities.AppUser.update(lc.signup.data?.user?.id, { email_verified: true });
    lc.login = await ns(slugA, "auth", "login", { email: `lc-${stamp}@sdk.test`, password: PASSWORD }, null);
    const lcToken = lc.login.data?.session_token || null;
    lc.me = await ns(slugA, "auth", "me", {}, lcToken);
    lc.create = await ns(slugA, "db", "create", { entity: "Note", data: { body: "lifecycle" } }, lcToken);
    lc.list = await ns(slugA, "db", "filter", { entity: "Note", query: {} }, lcToken);
    lc.fn = await act(slugA, "fn", { function_name: "ping", payload: { echo: "lifecycle" } }, lcToken);
    lc.upload = await ns(slugA, "files", "upload", { filename: "lc.txt", content_type: "text/plain", content_base64: btoa("lifecycle") }, lcToken);
    lc.analytics = await ns(slugA, "analytics", "session_start", { session_key: `as-lc-${stamp}`, page: "/" }, lcToken);
    lc.actor = await ns(slugA, "realtime", "send", { actor: "ChatRoom", room: "lifecycle", message: { type: "say", data: { text: "lc" } } }, lcToken);
    lc.agents = await ns(slugA, "agents", "list", {}, lcToken);
    lc.connectors = await ns(slugA, "connectors", "list", {}, lcToken);
    lc.logout = await ns(slugA, "auth", "logout", {}, lcToken);
    const afterLogout = await ns(slugA, "db", "filter", { entity: "Note", query: {} }, lcToken);
    check("33 the complete generated-app SDK lifecycle succeeds end to end on one session", () =>
      Object.values(lc).every((r) => r.status === 200) &&
      lc.me.data.user.email === `lc-${stamp}@sdk.test` &&
      lc.create.data.result.body === "lifecycle" && lc.list.data.result.length === 1 &&
      lc.fn.data.body.echo === "lifecycle" && !!lc.upload.data.result.id &&
      lc.actor.data.result.reply.count === 1 &&
      lc.agents.data.result.count === 1 && lc.connectors.data.result.count === 1 &&
      afterLogout.status >= 400,
      () => `${Object.keys(lc).length} steps: ${Object.entries(lc).map(([k, r]) => `${k}=${r.status}`).join(" ")} · post-logout access → ${afterLogout.status}`);

    const legacyArtifact = await act(slugLegacy, "artifact");
    const legacyFn = await act(slugLegacy, "fn", { function_name: "legacyFn", payload: {} });
    const legacyDb = await ns(slugLegacy, "db", "create", { entity: "Note", data: { body: "legacy" } });
    const legacyActors = await ns(slugLegacy, "realtime", "list", {});
    check("34 a legacy generated app keeps working unchanged under the unified SDK", () =>
      runLegacy.status === "LIVE" && legacyArtifact.status === 200 &&
      legacyFn.status === 200 && legacyFn.data.body.legacy === true &&
      // Anonymous (pre-RLS) data behaviour is untouched.
      legacyDb.status === 200 && legacyDb.data.result.body === "legacy" &&
      // A project declaring no canonical resources ships none, and its artifact keeps its old shape.
      !payloadLegacy.actors && !payloadLegacy.agents &&
      legacyActors.status === 200 && legacyActors.data.result.count === 0,
      () => `legacy deployment ${runLegacy.status} · flat function ${legacyFn.status} · ${legacyActors.data.result?.count} actor(s)`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      // ProjectSecret is purged here too: the fixture credential lives exactly as long as the run.
      for (const entity of ["AgentStep", "AgentRun", "FunctionInvocation", "IntegrationInvocation", "AppAnalyticsEvent", "AppAnalyticsSession", "Deployment", "DeploymentArtifact", "AppSession", "AppAuthToken", "AppUser", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["AuditLog", "TraceEvent", "RateLimitBucket", "CreditLedgerEntry", "WorkspaceMember", "Project"]);
    }
  }
}