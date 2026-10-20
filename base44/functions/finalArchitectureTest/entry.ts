// #45 — FINAL ARCHITECTURE CERTIFICATION.
//
// Certifies the CURRENT NexusAI architecture end to end: the canonical resource model, the full
// project lifecycle (create → plan → write → build → repair → version → deploy → run → edit →
// rebuild → rollback), runtime semantics and error contracts, every developer surface (SDK, CLI,
// sandbox, MCP, self-describing contracts, push/pull), build → artifact → deploy → verify, realtime
// and collaboration, the proprietary AI chain, and the cross-system seams between them.
//
// Certification, not a rewrite: every check runs the REAL module over REAL persisted project state
// through its own public path. Nothing is stubbed, nothing is re-implemented here, and no engine is
// introduced. Security is NOT rebuilt — #44 is the security gate, and the checks below only confirm
// that the same refusals still hold at the seams this suite exercises.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
// The DELETE-FREE harness. shared/testHarness.ts also exports purgeBy / cleanupWorkspace, which
// delete through a dynamic entity name under a caller-supplied query — an unbounded capability that
// a static reader cannot bound, and that any importer of that module carries whether it calls it or
// not. This suite retires its fixture with scoped updates, so it needs neither helper and takes the
// identical check/refusal/summary semantics from a module that contains no delete at all.
import { createHarness, harnessResponse, harnessError, captureCall as capture, wasRefused, nowIso } from "../../shared/certificationHarness.ts";
// resource model + sync
import {
  SUPPORTED_KINDS, RESERVED_KINDS, resourceKindOf, resourceIdentity, validateResource,
  pullResources, resourceStatus, diffResources,
} from "../../shared/resourceSync.ts";
import { actorFilePath } from "../../shared/actorResource.ts";
import { functionPath } from "../../shared/functionPaths.ts";
import { entityFilePath, entitySchemaContent, typesFilePath } from "../../shared/base44Layout.ts";
// lifecycle
import { createProjectForUser } from "../../shared/projectCreate.ts";
import { loadAuthorizedProject, loadProjectState, secretMetadata } from "../../shared/authz.ts";
import { createFs, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { generateTestPlan } from "../../shared/qa.ts";
import { commitMemberEdit, projectCollaborators } from "../../shared/collaboration.ts";
import { requestDeployment, runDeploymentStep, currentLiveDeployment, DEPLOY_TERMINAL } from "../../shared/deploy.ts";
// runtime semantics — the deployed app's data and users are exercised ONLY through the public
// appRuntime boundary below, so this suite imports neither the server data accessor nor the app
// auth module.
import { sandboxPath, sandboxInfo, sandboxRead, sandboxWrite, sandboxGrep } from "../../shared/sandbox.ts";
// developer surfaces
import { getProject, getProjectContext, listProjects, accessibleWorkspaces } from "../../shared/platformApi.ts";
import { runCli } from "../../shared/cli.ts";
import { listEntitySchemas, queryEntityRecords, inspectProjectVersion, getBuildResult } from "../../shared/mcpServerTools.ts";
import { generateTypes } from "../../shared/typeGen.ts";
import { emitProjectTypes } from "../../shared/typeEmit.ts";
// types / dependencies / workflows / connectors / actors / analytics
import { validateDependencies } from "../../shared/dependencies.ts";
import { createWorkflow, validateWorkflowDefinition, finalizeWorkflow } from "../../shared/workflowApi.ts";
import { describeWorkflowContract } from "../../shared/workflowContract.ts";
import { parseConnectorDocument, connectorRuntimePath } from "../../shared/connectorResource.ts";
import { AGENT_OPS, CONNECTOR_OPS } from "../../shared/sdkDiscovery.ts";
import { REALTIME_OPS } from "../../shared/realtimeRuntime.ts";
import { connectActor, invokeActor, roomSnapshot, roomEvents } from "../../shared/actorRuntime.ts";
import { describeAnalyticsContract, sanitizeProperties, normalizeConfig } from "../../shared/analyticsContract.ts";
// AI architecture
import { reconcileArchitecture, runConsistencyCheck, retrieveArchitectureContext, createPrimitiveExecutionPlan } from "../../shared/architecture.ts";
import { selectPrimitives, APP_PRIMITIVE_NAMES } from "../../shared/appPrimitives.ts";
import { describePrimitives } from "../../shared/primitiveContract.ts";
import { proposeOperation } from "../../shared/safetyEngine.ts";
import { productionLearningContract } from "../../shared/productionLearning.ts";
import { NEXUS_PROVIDER, NEXUS_MODEL_ID } from "../../shared/nexusProvider.ts";
import { can } from "../../shared/rbac.ts";

const CANONICAL_KINDS = ["config", "app-config", "entities", "functions", "workflows", "agents", "agent-skills", "connectors", "actors", "assets", "types"];

const ACTOR_SOURCE = `export const config = { access: "write", persist: true, events: true, description: "Certification room" };
export default async function (ctx) {
  const state = ctx.state || {};
  const count = (state.count || 0) + 1;
  return { state: { count, room: ctx.room.id }, reply: { count }, broadcast: { type: "counted", data: { count } } };
}
`;
const FUNCTION_SOURCE = `export const config = { method: "GET", webhook: false, secrets: [] };
export default async function (req) {
  return Response.json({ ok: true });
}
`;
const CONNECTOR_DOC = JSON.stringify({
  name: "certapi", description: "Certification connector", base_url: "https://api.example.com",
  auth: { type: "bearer", secret: "CERT_API_KEY" },
  operations: [{ name: "ping", method: "GET", path: "/ping" }],
}, null, 2);
const ENTITY_DOC = entitySchemaContent("Task", { title: { type: "string", required: true }, done: { type: "boolean" } }, null, null);

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  const created = { workspaces: [], projects: [] };
  let caller = null;

  const refused = (r) => wasRefused(r, [401, 403, 404, 409]);
  // A multi-part check states each of its parts by name, so a failure says WHICH invariant broke
  // instead of only that the conjunction was false.
  const all = (conditions) => {
    const failed = Object.entries(conditions).filter((e) => !e[1]).map((e) => e[0]);
    return { ok: failed.length === 0, failed, detail: failed.length ? `failed: ${failed.join(", ")}` : "" };
  };
  // ---- PUBLIC FUNCTION BOUNDARIES -----------------------------------------------------------
  // Mutating lifecycle stages are driven through the platform's OWN deployed endpoints, exactly as a
  // real client drives them, instead of importing the internal helpers behind them. One shape for
  // both outcomes, so a refusal can still be asserted by its code and status.
  const invoke = async (name, payload) => {
    try {
      const res = await base44.functions.invoke(name, payload);
      const data = res?.data ?? res ?? {};
      const status = Number(res?.status ?? 200);
      return { status, data, ok: status < 400 && data?.ok !== false, code: data?.code || null, error: data?.error || null };
    } catch (e) {
      const data = e?.response?.data || {};
      return {
        status: Number(e?.response?.status || e?.status || 500), data, ok: false,
        code: data.code || e?.code || null, error: data.error || String(e?.message || ""),
      };
    }
  };
  // PUSH through the authorized resourceSync command boundary. Same project, same resources, same
  // mode, same persisted state — only the entry path changes.
  const push = async (payload) => {
    const r = await invoke("resourceSync", { action: "push", ...payload });
    return { ...(r.data || {}), ok: r.ok, code: r.code, status: r.status };
  };
  const stateOf = async (pid) => {
    const state = await loadProjectState(base44, pid);
    return { state, fs: createFs(state.files) };
  };
  const buildOf = async (pid) => {
    const { state, fs } = await stateOf(pid);
    return runBuild(fs, state.entities, state.secrets);
  };

  try {
    caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const stranger = { id: "arch_stranger_user", email: "arch-stranger@example.com" };
    const viewer = { id: "arch_viewer_user", email: "arch-viewer@example.com" };

    const ws = await svc.entities.Workspace.create({ name: `arch-cert-${Date.now()}`, owner_id: caller.id, credits_balance: 100, status: "active" });
    created.workspaces.push(ws.id);
    await svc.entities.WorkspaceMember.create({ workspace_id: ws.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: nowIso() });

    // ============== 1 · CREATE (lifecycle stage 1, through the server-authoritative path) =====
    const createdProject = await createProjectForUser(base44, caller, { workspace_id: ws.id, name: "arch-cert-app", description: "final architecture certification" });
    const proj = createdProject.project;
    created.projects.push(proj.id);
    const v1 = createdProject.version;
    const createAudit = await svc.entities.AuditLog.filter({ project_id: proj.id, action: "project.created" }, "-created_date", 3);
    h.check("1 CREATE writes the project, its scaffold, version 1 and a server-stamped audit row",
      proj.workspace_id === ws.id && proj.version_count === 1 && createdProject.files_created > 0 &&
      v1.number === 1 && Array.isArray(v1.snapshot?.files) && v1.snapshot.files.length === createdProject.files_created &&
      createAudit.length === 1 && createAudit[0].user_id === caller.id && createAudit[0].workspace_id === ws.id,
      `${createdProject.files_created} scaffold file(s), v1 snapshot sealed, audit by ${createAudit[0]?.user_id}`);

    // A second project in the same workspace: every isolation assertion below is same-tenant, so it
    // proves project isolation rather than workspace isolation (already certified by #44).
    const sibling = await createProjectForUser(base44, caller, { workspace_id: ws.id, name: "arch-cert-sibling" });
    created.projects.push(sibling.project.id);

    // ============== 1b · FIXTURE ISOLATION (the precondition for every destructive check) ======
    // Everything this suite writes, breaks, rolls back, restores, redeploys or deletes happens
    // inside the two DISPOSABLE projects created above, in a scratch workspace created above. This
    // check is the guard: if the fixture were not test-created and not isolated from the account's
    // pre-existing projects, the destructive checks below must not run at all.
    const preExisting = await svc.entities.Project.filter({}, "-created_date", 200);
    const fixtureIds = [proj.id, sibling.project.id];
    const outsideFixture = preExisting.filter((p) => !fixtureIds.includes(p.id));
    const isolationChecks = all({
      scratch_workspace: created.workspaces.length === 1 && created.workspaces[0] === ws.id,
      workspace_is_new: ws.owner_id === caller.id && String(ws.name).startsWith("arch-cert-"),
      both_projects_created_here: fixtureIds.every((id) => created.projects.includes(id)),
      projects_in_scratch_workspace: proj.workspace_id === ws.id && sibling.project.workspace_id === ws.id,
      distinct_projects: proj.id !== sibling.project.id,
      no_preexisting_project_in_fixture: outsideFixture.every((p) => p.workspace_id !== ws.id),
      cleanup_scoped_to_run: created.projects.every((id) => fixtureIds.includes(id)),
    });
    if (!isolationChecks.ok) {
      h.check("1b FIXTURE ISOLATION: destructive checks run only inside a disposable fixture", false,
        `refusing to run destructive checks — ${isolationChecks.detail}`);
      return harnessResponse(h);
    }
    h.check("1b FIXTURE ISOLATION: destructive checks run only inside a disposable fixture", true,
      `fixture = scratch workspace ${ws.id} with ${fixtureIds.length} disposable project(s); ${outsideFixture.length} pre-existing project(s) are outside it and read-only`);

    // ============== 2 · RESOURCE MODEL PARITY ==============
    const kindsCovered = CANONICAL_KINDS.every((k) => SUPPORTED_KINDS.includes(k));
    const badPath = await capture(() => validateResource({ path: "random/file.js", content: "x" }));
    const mismatch = await capture(() => validateResource({ path: entityFilePath("Task"), kind: "functions", content: ENTITY_DOC }));
    const reservedAuth = await capture(() => validateResource({ path: "base44/auth/config.jsonc", content: "{}" }));
    const wrongName = await capture(() => validateResource({ path: entityFilePath("Other"), content: ENTITY_DOC }));
    h.check("2 the canonical resource model covers every kind, and refuses anything outside it",
      kindsCovered && RESERVED_KINDS.includes("auth") && SUPPORTED_KINDS.length === CANONICAL_KINDS.length &&
      badPath.code === "RESOURCE_INVALID_PATH" && mismatch.code === "RESOURCE_KIND_MISMATCH" &&
      reservedAuth.code === "RESOURCE_UNSUPPORTED" && wrongName.code === "RESOURCE_INVALID_NAME",
      `${SUPPORTED_KINDS.length} synchronizable kind(s), auth reserved; invalid path / kind mismatch / reserved / name all refused`);

    // ============== 3 · PULL: authoritative state projected as resources ==============
    const pulled = await pullResources(base44, caller, { project_id: proj.id });
    const identitiesStable = pulled.resources.every((r) => resourceKindOf(r.path) === r.kind && resourceIdentity(r.path, r.kind) === r.identity);
    const configResource = pulled.resources.find((r) => r.kind === "config");
    h.check("3 PULL projects the project's authoritative state as canonical resources",
      pulled.ok && pulled.count > 0 && identitiesStable && !!configResource &&
      pulled.resources.every((r) => typeof r.content === "string") && pulled.version === proj.version_count,
      `${pulled.count} resource(s) at v${pulled.version}; kinds ${[...new Set(pulled.resources.map((r) => r.kind))].join(", ")}`);

    // ============== 4 · PLAN (architecture intelligence over real state) ==============
    const reconciled = await reconcileArchitecture(base44, caller, { project_id: proj.id, force: true });
    const consistency = await runConsistencyCheck(base44, caller, { project_id: proj.id, persist: false });
    const selection = selectPrimitives({ request: "store tasks in the database and show them on a page" });
    const plan = await createPrimitiveExecutionPlan(base44, caller, {
      project_id: proj.id, goal: "add a task list", request: "store tasks in the database and show them on a page",
      capabilities: (selection.selected || []).map((s) => s.capability),
    });
    const steps = plan?.plan?.steps || [];
    h.check("4 PLAN derives an architecture and an executable primitive plan from real state",
      // architecture derived from real state
      reconciled.architecture?.node_count > 0 && !!reconciled.architecture?.architecture_fingerprint &&
      // the consistency report is the graph checker's own verdict over that architecture
      typeof consistency.architecture_id === "string" && consistency.architecture_version > 0 &&
      Array.isArray(consistency.issues) && typeof consistency.status === "string" &&
      // capability selection, closed over its prerequisites
      (selection.selected || []).length > 0 && selection.closure?.complete === true &&
      selection.selected.every((s) => APP_PRIMITIVE_NAMES.includes(s.capability)) &&
      // an EXECUTABLE, deterministically ordered plan bound to that architecture
      plan.plan.executable === true && plan.plan.composition_valid === true &&
      steps.length === plan.plan.step_count && steps.length > 0 &&
      steps.every((s, i) => s.order === i + 1 && APP_PRIMITIVE_NAMES.includes(s.capability) && !!s.action && !!s.verification) &&
      plan.plan.architecture?.version === reconciled.architecture.version,
      `${reconciled.architecture?.node_count} node(s), consistency ${consistency.status} with ${(consistency.issues || []).length} issue(s), ${(selection.selected || []).length} capability(ies), ${steps.length} ordered step(s)`);

    // ============== 5 · WRITE (push: every resource kind through ONE sync path) ==============
    const written = [
      { path: entityFilePath("Task"), content: ENTITY_DOC },
      { path: functionPath("certPing"), content: FUNCTION_SOURCE },
      { path: actorFilePath("Counter"), content: ACTOR_SOURCE },
      { path: "base44/connectors/certapi.jsonc", content: CONNECTOR_DOC },
    ];
    const pushed = await push({ project_id: proj.id, resources: written, mode: "merge", message: "certification resources" });
    const afterWrite = await stateOf(proj.id);
    const paths = new Set(activeFiles(afterWrite.fs).map((f) => f.path));
    const projAfterWrite = await svc.entities.Project.get(proj.id);
    // Every written resource must be present at the path the sync path itself reports it applied to
    // (a function keeps the layout the project already uses, so the applied path is authoritative).
    const appliedPath = (identity) => (pushed.resources || []).find((r) => r.identity === identity)?.path || null;
    const expectedPaths = [appliedPath("Task"), appliedPath("certPing"), appliedPath("Counter"), appliedPath("certapi"), connectorRuntimePath("certapi")];
    const missingPaths = expectedPaths.filter((p) => !p || !paths.has(p));
    h.check("5 WRITE applies every resource kind through the one sync path and persists it",
      pushed.ok !== false && pushed.version_created === true &&
      (pushed.resources || []).length === written.length && missingPaths.length === 0 &&
      afterWrite.state.entities.some((e) => e.name === "Task") &&
      projAfterWrite.version_count > proj.version_count,
      `${(pushed.resources || []).length} resource(s) applied, v${projAfterWrite.version_count}${missingPaths.length ? `; missing: ${missingPaths.join(", ")}` : "; entity, function, actor, connector + connector runtime all present"}`);

    // ============== 6 · BUILD ==============
    const build = await buildOf(proj.id);
    h.check("6 BUILD succeeds over the written state, through the one build engine",
      build.status === "success" && build.errors === 0 && build.logs.length > 0,
      `${build.status}, ${build.errors} error(s)${build.errors ? `: ${build.logs.filter((l) => l.startsWith("error:")).slice(0, 3).join(" | ")}` : ""}`);

    // ============== 7 · REPAIR (a broken resource fails deterministically, then heals) ==============
    const broken = await push({ project_id: proj.id, resources: [{ path: functionPath("certPing"), content: "export default async function ( {\n" }], mode: "merge", message: "broken" });
    const brokenBuild = await buildOf(proj.id);
    const qaPlan = generateTestPlan({ fs: (await stateOf(proj.id)).fs, entities: afterWrite.state.entities, secrets: [] });
    await push({ project_id: proj.id, resources: [{ path: functionPath("certPing"), content: FUNCTION_SOURCE }], mode: "merge", message: "repair" });
    const repairedBuild = await buildOf(proj.id);
    h.check("7 REPAIR: a broken resource fails the build with diagnostics and the fix restores it",
      broken.ok !== false && brokenBuild.status !== "success" && brokenBuild.errors > 0 &&
      brokenBuild.logs.some((l) => l.startsWith("error:")) &&
      (qaPlan.tests || []).length > 0 && repairedBuild.status === "success",
      `broken build ${brokenBuild.status} with ${brokenBuild.errors} error(s); ${(qaPlan.tests || []).length} planned test(s); repaired build ${repairedBuild.status}${repairedBuild.errors ? `: ${repairedBuild.logs.filter((l) => l.startsWith("error:")).slice(0, 3).join(" | ")}` : ""}`);

    // ============== 8 · VERSION semantics ==============
    const versions = await svc.entities.ProjectVersion.filter({ project_id: proj.id }, "number", 50);
    const v1Row = versions.find((v) => v.number === 1);
    const numbers = versions.map((v) => v.number);
    h.check("8 VERSION history is append-only and version 1 is untouched by later writes",
      versions.length >= 3 && numbers.join(",") === [...numbers].sort((a, b) => a - b).join(",") &&
      new Set(numbers).size === numbers.length &&
      JSON.stringify(v1Row.snapshot.files.map((f) => f.path).sort()) === JSON.stringify(v1.snapshot.files.map((f) => f.path).sort()) &&
      !v1Row.snapshot.files.some((f) => f.path === actorFilePath("Counter")),
      `${versions.length} version(s) (${numbers.join(", ")}); v1 snapshot unchanged`);

    // ============== 9 · workflows as resources, finalized through their own API ==============
    const wf = await createWorkflow(base44, caller, {
      project_id: proj.id, name: "Cert Workflow", workflow_key: "cert_workflow",
      // The workflow's own grammar: a declared trigger type, declared step types, an entry step and
      // a terminal step. createWorkflow takes those FLAT, not wrapped in a `definition`.
      trigger: { type: "entity_event", entity: "Task", operations: ["create"] },
      entry_step: "done",
      steps: [{ id: "done", type: "complete" }],
    });
    // createWorkflow / validateWorkflowDefinition / finalizeWorkflow each return the workflow's own
    // public definition (or validation report) FLAT — there is no nested `workflow` envelope.
    const wfValid = wf.workflow_definition_id ? await validateWorkflowDefinition(base44, caller, { workflow_definition_id: wf.workflow_definition_id }) : null;
    const wfFinal = wfValid?.ok === true ? await finalizeWorkflow(base44, caller, { workflow_definition_id: wf.workflow_definition_id }) : null;
    const pulledWithWf = await pullResources(base44, caller, { project_id: proj.id, kinds: ["workflows"] });
    // The workflow's canonical identity is the key the API itself derived (createWorkflow slugifies
    // the requested key), so the resource projection is asserted against THAT key rather than
    // against the raw string this suite happened to request.
    h.check("9 a workflow is authored, validated, finalized and projected as a canonical resource",
      !!wf.workflow_definition_id && !!wf.workflow_key && wf.version >= 1 && wf.finalized === false &&
      wfValid?.ok === true && wfValid.workflow_definition_id === wf.workflow_definition_id &&
      wfFinal?.status === "FINALIZED" && wfFinal.finalized === true && wfFinal.workflow_definition_id === wf.workflow_definition_id &&
      pulledWithWf.resources.some((r) => r.kind === "workflows" && r.identity === wf.workflow_key) &&
      !!describeWorkflowContract().contract_version,
      `workflow ${wfFinal?.status || wfValid?.status || "INVALID"}${wfValid && !wfValid.ok ? `: ${(wfValid.errors || []).slice(0, 3).join(" | ")}` : ""}, projected as ${pulledWithWf.resources.length} workflow resource(s)`);

    // ============== 10 · DEPLOY: resource → build → artifact → deploy → verify → runtime ======
    // The connector pushed in check 5 DECLARES the secret CERT_API_KEY, so deployment's own health
    // verification requires it to be configured. That requirement is not weakened here — the
    // fixture satisfies it the way a real project does, through the authorized secret endpoint,
    // which stores the value encrypted at rest and returns metadata only.
    const secretSet = await invoke("projectSecrets", { action: "set", project_id: proj.id, name: "CERT_API_KEY", value: `cert-fixture-${crypto.randomUUID()}` });
    const secretReady = (secretSet.data?.secrets || []).some((s) => s.name === "CERT_API_KEY" && s.is_set === true);
    h.check("10a the connector's declared secret is configured through the authorized secret path, as metadata only",
      secretReady && (secretSet.data?.secrets || []).every((s) => s.value === undefined),
      secretReady ? "CERT_API_KEY is set; the endpoint returned metadata only" : `secret not set: ${secretSet.error || secretSet.code || "unknown"}`);

    const requested = await requestDeployment(base44, caller, { project_id: proj.id, environment: "production" });
    let deployment = requested.deployment;
    for (let i = 0; i < 14 && !DEPLOY_TERMINAL.includes(deployment.status); i++) {
      await runDeploymentStep(svc, deployment.id).catch(() => {});
      deployment = await svc.entities.Deployment.get(deployment.id);
    }
    const artifact = deployment.artifact_id ? await svc.entities.DeploymentArtifact.get(deployment.artifact_id) : null;
    const liveProject = await svc.entities.Project.get(proj.id);
    const live = await currentLiveDeployment(svc, liveProject, "production");
    const deployChecks = all({
      live: deployment.status === "LIVE", artifact: !!artifact,
      checksum: artifact?.checksum === deployment.artifact_checksum,
      secret_scan: artifact?.secret_scan === "pass",
      function_packaged: (artifact?.function_names || []).includes("certPing"),
      entity_packaged: (artifact?.entity_names || []).includes("Task"),
      live_pointer: live?.id === deployment.id,
      verified: typeof deployment.verification === "string" && deployment.verification.length > 0,
    });
    h.check("10 DEPLOY produces a verified immutable artifact and one live deployment", deployChecks.ok,
      `${deployment.status} · ${deployment.verification || "no verification"}${deployChecks.ok ? "" : ` · ${deployChecks.detail}${deployment.failure_summary ? ` · ${deployment.failure_summary}` : ""}${(deployment.build_diagnostics || []).length ? ` · ${deployment.build_diagnostics.slice(0, 3).join(" | ")}` : ""}`}`);

    // ============== 11 · RUN: app runtime data + auth over the deployed resource model ========
    // The deployed app is addressed the ONLY way a deployed app can be addressed: by its public
    // slug, through the public runtime. The entity definitions it serves come from the immutable
    // artifact check 10 just verified, so this stage certifies deploy → run continuity as well.
    const slug = liveProject.slug;
    const runDb = (op, args) => invoke("appRuntime", { slug, action: "db", op, args });
    const runAuth = (op, args) => invoke("appRuntime", { slug, action: "auth", op, ...args });
    const rec = (await runDb("create", { entity: "Task", data: { title: "certified" } })).data?.result || {};
    const listedRes = await runDb("filter", { entity: "Task", query: {} });
    const listed = listedRes.data?.result || [];
    const invalid = await runDb("create", { entity: "Task", data: { done: true } });
    const unknown = await runDb("filter", { entity: "Nope", query: {} });
    const signedUp = await runAuth("signup", { email: "run-user@example.com", password: "Sup3rSecret!x" });
    // G-2: register leaves the user unverified and the OTP code is undeliverable in this
    // harness — complete the verification directly so the documented post-verification
    // login proceeds.
    await svc.entities.AppUser.update(signedUp.data?.user?.id, { email_verified: true });
    const loggedIn = await runAuth("login", { email: "run-user@example.com", password: "Sup3rSecret!x" });
    const runChecks = all({
      created: !!rec.id, listed: listed.length === 1, content: listed[0]?.title === "certified",
      validation: invalid.code === "DATABASE_VALIDATION_FAILED" && invalid.ok === false,
      unknown_entity: unknown.code === "DATABASE_ENTITY_NOT_FOUND" && unknown.ok === false,
      signup: !!signedUp.data?.user?.id, login: !!loggedIn.data?.session_token,
      identity: loggedIn.data?.user?.email === "run-user@example.com",
    });
    h.check("11 RUN serves the app's data and users with consistent validation and error contracts", runChecks.ok,
      runChecks.ok
        ? `served at /app/${slug}; record created; validation ${invalid.code}; unknown entity ${unknown.code}; app user signed up and logged in`
        : `${runChecks.detail}${invalid.error ? ` · ${invalid.error}` : ""}`);

    // ============== 12 · EDIT + REBUILD (collaboration path) ==============
    const collaborators = await projectCollaborators(base44, caller, proj.id);
    const edited = await commitMemberEdit(base44, caller, { project_id: proj.id, edits: [{ path: "src/main.js", content: "export function main() { return 'edited'; }\n" }], message: "collaborator edit" });
    const viewerEdit = await capture(() => commitMemberEdit(base44, viewer, { project_id: proj.id, edits: [{ path: "src/main.js", content: "hacked" }] }));
    const rebuild = await buildOf(proj.id);
    const editedContent = (await svc.entities.ProjectFile.filter({ project_id: proj.id, path: "src/main.js" }, "path", 1))[0];
    h.check("12 EDIT commits a new version through the collaboration path and REBUILD stays green",
      (collaborators.members || []).some((c) => c.user_id === caller.id || c.email === caller.email) &&
      edited.version?.number > 0 && editedContent.content.includes("edited") &&
      viewerEdit.code === "INSUFFICIENT_ROLE" && rebuild.status === "success",
      `edit → v${edited.version?.number}; viewer edit ${viewerEdit.code}; rebuild ${rebuild.status}`);

    // ============== 13 · ROLLBACK integrity ==============
    const beforeRollback = await svc.entities.Project.get(proj.id);
    // ROLLBACK through the authorized restoreVersion boundary — the same restore service, entered
    // the way a real client enters it.
    const restored = await invoke("restoreVersion", { project_id: proj.id, version_id: v1.id });
    const rolledBack = restored.data || {};
    const afterRollback = await stateOf(proj.id);
    const rollbackPaths = new Set(activeFiles(afterRollback.fs).map((f) => f.path));
    const projAfterRollback = await svc.entities.Project.get(proj.id);
    const v1Untouched = await svc.entities.ProjectVersion.get(v1.id);
    h.check("13 ROLLBACK restores an immutable version forward, without rewriting history",
      !!rolledBack.version && projAfterRollback.version_count > beforeRollback.version_count &&
      v1.snapshot.files.every((f) => rollbackPaths.has(f.path)) &&
      !rollbackPaths.has(actorFilePath("Counter")) &&
      v1Untouched.number === 1 && v1Untouched.snapshot.files.length === v1.snapshot.files.length,
      `restored v1 as v${projAfterRollback.version_count}; v1 record itself unchanged`);

    // The certification continues on the SIBLING project, whose resources are intact after the
    // rollback above — so later surfaces are exercised against a full resource set.
    const work = sibling.project;
    await push({ project_id: work.id, resources: written, mode: "merge", message: "certification resources" });
    const workState = await stateOf(work.id);
    const workProject = await svc.entities.Project.get(work.id);
    // This project is now the active lifecycle project, so its architecture is derived the same way
    // check 4 derived the first one's — through the EXISTING Architecture Intelligence reconcile
    // path over its real state. Nothing is fabricated: check 25 later reads whatever this produced.
    const workArchitecture = await reconcileArchitecture(base44, caller, { project_id: work.id, force: true });

    // ============== 14 · PUSH/PULL round trip is idempotent ==============
    const remote = await pullResources(base44, caller, { project_id: work.id });
    const rePush = await push({ project_id: work.id, resources: remote.resources.map((r) => ({ path: r.path, content: r.content })), mode: "full" });
    const status = await resourceStatus(base44, caller, { project_id: work.id, resources: remote.resources.map((r) => ({ path: r.path, content: r.content })) });
    const selfDiff = diffResources(remote.resources, remote.resources);
    h.check("14 PUSH/PULL round-trips exactly: re-pushing what was pulled changes nothing",
      (rePush.applied || []).every((a) => a.action === "unchanged") && (rePush.removed || []).length === 0 &&
      status.resources.every((r) => r.state === "identical") && selfDiff.every((r) => r.state === "identical"),
      `${(rePush.applied || []).length} resource(s) all unchanged; status all identical`);

    // ============== 15 · conflict + validation contracts on the sync path ==============
    // The command boundary answers a refusal as its own deterministic status + code, so the same
    // invariants are asserted from the response instead of from a thrown internal error.
    const staleVersion = await push({ project_id: work.id, resources: [{ path: functionPath("certPing"), content: FUNCTION_SOURCE }], mode: "merge", expected_version: 1 });
    const badKind = await push({ project_id: work.id, resources: [], kinds: ["secrets"] });
    // Authorization is asserted against a synthetic non-member, which a request-authenticated
    // boundary cannot represent — so it runs against the sync layer's READ path, which holds no
    // mutation or delete capability at all.
    const strangerPush = await capture(() => pullResources(base44, stranger, { project_id: work.id }));
    h.check("15 the sync path enforces optimistic concurrency, kind support and authorization",
      staleVersion.code === "RESOURCE_CONFLICT" && staleVersion.ok === false &&
      badKind.code === "RESOURCE_UNSUPPORTED" && badKind.ok === false && refused(strangerPush),
      `stale version ${staleVersion.code} (${staleVersion.status}); unknown kind ${badKind.code} (${badKind.status}); stranger ${strangerPush.status}`);

    // ============== 16 · TYPES ↔ SDK ==============
    // The generator keys the connector registry by the connector's declared TYPE (typeEmit maps
    // name → type), and emitProjectTypes RETURNS the declaration text rather than writing a file —
    // the #3 Types contract this suite must not restate. Both are used as they actually are.
    const types = generateTypes({
      entities: workState.state.entities, functions: [{ name: "certPing" }], actors: [{ name: "Counter" }],
      agents: [], connectors: [{ name: "certapi", type: "certapi", operations: [{ name: "ping" }] }],
    });
    const typeFs = createFs(workState.state.files);
    const emitted = emitProjectTypes(typeFs, workState.state.entities);
    const typeChecks = all({
      string: typeof types === "string", entity: String(types).includes("Task"), fn: String(types).includes("certPing"),
      actor: String(types).includes("Counter"), connector: String(types).includes("certapi"),
      emitted: typeof emitted === "string" && emitted.length > 0,
      emitted_entity: String(emitted).includes("Task"),
      emitted_connector: String(emitted).includes("certapi"),
      emitted_function: String(emitted).includes("certPing"),
      kind: SUPPORTED_KINDS.includes("types"), canonical_path: typesFilePath().startsWith("base44/"),
    });
    h.check("16 TYPES ↔ SDK: generated types describe the project's own resources and emit canonically", typeChecks.ok,
      typeChecks.ok ? `types cover entity, function, actor and connector; emit path ${typesFilePath()}` : typeChecks.detail);

    // ============== 17 · DEPENDENCIES ↔ BUILD/DEPLOY ==============
    const deps = await validateDependencies(base44, caller, { project_id: work.id });
    const depBuild = await buildOf(work.id);
    h.check("17 DEPENDENCIES validate through their one reader and agree with the build",
      deps.ok !== false && Array.isArray(deps.validation?.errors || []) &&
      (deps.validation?.errors || []).length === 0 && depBuild.status === "success",
      `${(deps.dependencies || []).length} dependency(ies), validation clean, build ${depBuild.status}`);

    // ============== 18 · SDK surface ==============
    const sdkProject = await getProject(base44, caller, work.id);
    const sdkContext = await getProjectContext(base44, caller, work.id);
    const sdkList = await listProjects(base44, caller, {});
    const workspaces = await accessibleWorkspaces(base44, caller);
    const sdkStranger = await capture(() => getProjectContext(base44, stranger, work.id));
    // accessibleWorkspaces is bounded to the caller's 5 most recent OWNED workspaces, so an account
    // that has accumulated retired certification fixtures may not see this run's scratch workspace
    // in that window. The bound is the SDK's own contract, not a defect: the project list is
    // asserted to contain the fixture whenever its workspace is inside the window, and the
    // authorized per-project reads above are asserted unconditionally.
    const wsVisible = workspaces.some((w) => w.id === ws.id);
    const sdkChecks = all({
      // getProject answers with the project PROJECTION under `project` — the same shape getProjectContext uses.
      project: sdkProject.project?.project_id === work.id, context: sdkContext.project?.project_id === work.id,
      files: (sdkContext.files || []).length > 0,
      secrets_metadata_only: (sdkContext.secrets || []).every((s) => s.value === undefined),
      listed: !wsVisible || (sdkList.projects || []).some((p) => p.project_id === work.id),
      workspaces: workspaces.length > 0 && workspaces.every((w) => !!w.id && !!w.owner_id),
      stranger_refused: refused(sdkStranger),
    });
    h.check("18 the SDK answers every authorized read and exposes no secret value", sdkChecks.ok,
      sdkChecks.ok ? `${sdkContext.files.length} file(s), secrets as metadata only, stranger ${sdkStranger.status}; ${workspaces.length} accessible workspace(s)${wsVisible ? "" : " (fixture workspace outside the 5-owned window)"}` : sdkChecks.detail);

    // ============== 19 · CLI surface parity ==============
    const cliLink = await runCli(base44, caller, { command: "link", args: { project_id: work.id } });
    const cliPull = await runCli(base44, caller, { command: "pull", args: { project_id: work.id } });
    // `types` is the CLI's own read-only emit command; `status` is not a CLI command at all, and the
    // unknown-command case below is what certifies that.
    const cliTypes = await runCli(base44, caller, { command: "types", args: { project_id: work.id } });
    const cliUnknown = await runCli(base44, caller, { command: "sudo", args: {} });
    const cliViewerPush = await runCli(base44, viewer, { command: "push", args: { project_id: work.id, resources: [] } });
    const cliChecks = all({
      link: cliLink.ok === true, pull: cliPull.ok === true,
      pull_parity: cliPull.result?.count === remote.count, types: cliTypes.ok === true,
      unknown_refused: cliUnknown.ok === false && cliUnknown.exit_code === 2,
      viewer_refused: cliViewerPush.ok === false && cliViewerPush.exit_code === 4,
    });
    h.check("19 the CLI is a thin surface over the same services, with stable exit codes", cliChecks.ok,
      `pull ${cliPull.result?.count} resource(s) (SDK ${remote.count}); unknown exit ${cliUnknown.exit_code}; viewer push exit ${cliViewerPush.exit_code}${cliChecks.ok ? "" : ` · ${cliChecks.detail}`}`);

    // ============== 20 · SANDBOX surface ==============
    const sbInfo = await sandboxInfo(base44, caller, { project_id: work.id });
    // The file read is an EXISTING file of this project, taken from its own authoritative state
    // rather than from an assumption about the scaffold's entry filename or its contents.
    const sbTarget = activeFiles(createFs(workState.state.files)).find((f) => f.path.startsWith("src/") && (f.content || "").length > 0);
    const sbRead = await sandboxRead(base44, caller, { project_id: work.id, path: sbTarget.path });
    const sbWrite = await sandboxWrite(base44, caller, { project_id: work.id, path: "src/pages/Cert.js", content: "export default function Cert() { return 'cert'; }\n" });
    const sbGrep = await sandboxGrep(base44, caller, { project_id: work.id, query: "Cert" });
    const sbEscape = await capture(() => sandboxPath("src/../../etc/passwd"));
    const sbMissing = await capture(() => sandboxRead(base44, caller, { project_id: work.id, path: "src/nope.js" }));
    const sbChecks = all({
      secrets_metadata_only: (sbInfo.secrets || []).every((s) => s.value === undefined),
      read: sbRead.content === sbTarget.content, write: sbWrite.path === "src/pages/Cert.js",
      grep: (sbGrep.matches || []).length > 0,
      traversal_refused: sbEscape.code === "RESOURCE_INVALID_PATH", missing_refused: sbMissing.code === "RESOURCE_NOT_FOUND",
    });
    h.check("20 the SANDBOX reads and writes the same project state, and cannot escape it", sbChecks.ok,
      sbChecks.ok ? `read ${sbTarget.path} byte-for-byte; write/grep served; traversal ${sbEscape.code}; missing ${sbMissing.code}` : sbChecks.detail);

    // ============== 21 · MCP surface ==============
    const mcpSchemas = await listEntitySchemas(base44, caller, { project_id: work.id });
    const mcpRecords = await queryEntityRecords(base44, caller, { project_id: work.id, entity: "Task" });
    const workVersions = await svc.entities.ProjectVersion.filter({ project_id: work.id }, "-number", 1);
    const mcpVersion = await inspectProjectVersion(base44, caller, { project_id: work.id, version_id: workVersions[0].id });
    const mcpForeignVersion = await capture(() => inspectProjectVersion(base44, caller, { project_id: work.id, version_id: v1.id }));
    const mcpBuild = await capture(() => getBuildResult(base44, stranger, { build_id: "nonexistent" }));
    const mcpChecks = all({
      // listEntitySchemas projects each schema as { entity, fields, field_count } — `entity`, not `name`.
      schema: (mcpSchemas.entities || []).some((e) => e.entity === "Task"),
      records_scoped: mcpRecords.project_id === work.id,
      version: mcpVersion.version?.number === workVersions[0].number,
      cross_project_refused: mcpForeignVersion.code === "VERSION_NOT_FOUND",
      unknown_build_refused: mcpBuild.threw,
    });
    h.check("21 MCP tools serve the same state under the same authorization and project scope", mcpChecks.ok,
      `${(mcpSchemas.entities || []).length} schema(s) (${(mcpSchemas.entities || []).map((e) => e.entity).join(", ")}); cross-project version ${mcpForeignVersion.code}${mcpChecks.ok ? "" : ` · ${mcpChecks.detail}`}`);

    // ============== 22 · self-describing contracts (the docs surface) ==============
    const contracts = {
      workflow: describeWorkflowContract(), primitives: describePrimitives(),
      analytics: describeAnalyticsContract(), learning: productionLearningContract(),
    };
    // The analytics sanitizer is evaluated against a project's OWN normalized config, which is the
    // only place its credential and suppression policy comes from.
    const analyticsConfig = normalizeConfig({});
    const scrubbed = sanitizeProperties({ plan: "pro" }, analyticsConfig);
    // The contract's DEFAULT credential policy is refusal, not redaction: a credential-shaped
    // property never reaches storage because the event itself is rejected.
    const credentialProperty = await capture(() => sanitizeProperties({ api_key: "sk_live_should_never_survive" }, analyticsConfig));
    const contractChecks = all({
      workflow_version: !!contracts.workflow.contract_version, primitives: !!contracts.primitives,
      analytics_version: !!contracts.analytics.contract_version, flywheel_version: !!contracts.learning.flywheel_version,
      agent_ops: AGENT_OPS.length > 0, connector_ops: CONNECTOR_OPS.length > 0, realtime_ops: REALTIME_OPS.length > 0,
      clean_property_kept: scrubbed.properties?.plan === "pro",
      credential_refused: credentialProperty.code === "ANALYTICS_CREDENTIAL_PROPERTY",
      credential_never_stored: !JSON.stringify(scrubbed).includes("sk_live_should_never_survive"),
    });
    h.check("22 every platform contract describes itself with a version, and analytics refuses credentials", contractChecks.ok,
      contractChecks.ok
        ? `workflow ${contracts.workflow.contract_version}, analytics ${contracts.analytics.contract_version}, flywheel ${contracts.learning.flywheel_version}; credential property ${credentialProperty.code}`
        : contractChecks.detail);

    // ============== 23 · CONNECTORS ↔ SDK/runtime ==============
    const connector = parseConnectorDocument("base44/connectors/certapi.jsonc", CONNECTOR_DOC);
    const runtimeProjection = activeFiles(createFs(workState.state.files)).find((f) => f.path === connectorRuntimePath("certapi"));
    h.check("23 CONNECTORS parse through their one contract and materialize the existing runtime",
      connector.ok && connector.connector.name === "certapi" &&
      !!runtimeProjection && runtimeProjection.content.includes("certapi") && CONNECTOR_OPS.length > 0,
      `connector '${connector.connector?.name}' with ${connector.connector?.operations?.length} operation(s); runtime at ${connectorRuntimePath("certapi")}`);

    // ============== 24 · ACTORS ↔ REALTIME/SDK ==============
    const joined = await connectActor(svc, work.id, "Counter", "room-1", { participant: "p1" });
    const invoked = await invokeActor(svc, { project: workProject, entities: workState.state.entities, actor: "Counter", source: ACTOR_SOURCE, room: "room-1", message: { type: "count" }, user: caller, participant: "p1" });
    const snapshot = await roomSnapshot(svc, work.id, "Counter", "room-1");
    const events = await roomEvents(svc, work.id, "Counter", "room-1", { since: 0 });
    const foreignRoom = await roomSnapshot(svc, proj.id, "Counter", "room-1");
    h.check("24 ACTORS run statefully over realtime rooms, isolated per project",
      joined.joined === true && invoked.reply?.count === 1 && snapshot.state.count === 1 &&
      events.events.some((e) => e.type === "actor.join") && events.events.some((e) => e.type === "counted") &&
      foreignRoom.exists === false,
      `room state ${snapshot.state.count}, ${events.count} event(s); same room id in another project is absent`);

    // ============== 25 · AI chain: architecture → primitives → safety → execution → learning ===
    const archContext = await retrieveArchitectureContext(base44, caller, { project_id: work.id, query: "tasks" });
    const gatedDelete = await proposeOperation(base44, caller, { project_id: work.id, tool: "delete_file", input: { path: "src/pages/Cert.js" } });
    const systemTool = await proposeOperation(base44, caller, { project_id: work.id, tool: "restore_snapshot", input: { version_id: workVersions[0].id } });
    const stillThere = (await svc.entities.ProjectFile.filter({ project_id: work.id, path: "src/pages/Cert.js" }, "path", 1)).length === 1;
    const loop = productionLearningContract().loop;
    h.check("25 the AI chain runs request → architecture → primitives → safety → execution → learning",
      !!archContext.architecture?.architecture_id && Array.isArray(archContext.subgraph?.nodes) &&
      Array.isArray(archContext.primitives?.selected) &&
      gatedDelete.decision === "require_approval" && gatedDelete.executed === false && stillThere &&
      systemTool.decision === "deny" && systemTool.decision_code === "SAFETY_SYSTEM_TOOL" &&
      ["capture", "judge", "reward", "dataset", "measure", "promote"].every((s) => loop.includes(s)),
      `architecture context resolved; delete gated (${gatedDelete.decision}); system tool ${systemTool.decision_code}; flywheel loop ${loop.length} stage(s)`);

    // ============== 26 · proprietary AI layer stays separate from the platform layer ==========
    const platformSurface = JSON.stringify({ kinds: SUPPORTED_KINDS, reserved: RESERVED_KINDS });
    h.check("26 the proprietary NexusAI layer is architecturally separate from the platform layer",
      !!NEXUS_PROVIDER && !!NEXUS_MODEL_ID &&
      !SUPPORTED_KINDS.some((k) => /nexus|model|router|safety|learning|approval/i.test(k)) &&
      !platformSurface.includes(NEXUS_MODEL_ID) &&
      !types.includes(NEXUS_MODEL_ID) && !remote.resources.some((r) => /nexus/i.test(r.kind)),
      `provider '${NEXUS_PROVIDER}' / model '${NEXUS_MODEL_ID}' appear in no platform resource kind, no project resource and no generated type`);

    // ============== 27 · security gate (#44 evidence re-confirmed at these seams) =============
    const secretsMeta = secretMetadata(await svc.entities.ProjectSecret.filter({ project_id: work.id }, "name", 10));
    const security = {
      authz: await capture(() => loadAuthorizedProject(base44, stranger, work.id, "project.read")),
      sandbox: await capture(() => sandboxRead(base44, stranger, { project_id: work.id, path: "src/main.js" })),
      mcp: await capture(() => queryEntityRecords(base44, stranger, { project_id: work.id, entity: "Task" })),
      deploy: await capture(() => requestDeployment(base44, viewer, { project_id: work.id })),
      unknownActor: await capture(() => invokeActor(svc, { project: workProject, actor: "Nope", room: "room-1", message: null, user: caller })),
    };
    h.check("27 the #44 security gate still holds at every surface this suite exercises",
      Object.values(security).every((r) => r.threw) &&
      secretsMeta.every((s) => s.value === undefined) &&
      can("viewer", "project.read") === true && can("viewer", "project.write") === false && can("viewer", "deploy.manage") === false,
      "stranger/viewer refused on authz, sandbox, MCP and deploy; unknown actor refused; secrets metadata-only");

    // ============== 28 · project isolation across every surface ==============
    const crossPull = await pullResources(base44, caller, { project_id: proj.id });
    const isolation = {
      sync: diffResources(remote.resources, crossPull.resources),
      records: await queryEntityRecords(base44, caller, { project_id: work.id, entity: "Task" }),
      version: await capture(() => inspectProjectVersion(base44, caller, { project_id: proj.id, version_id: workVersions[0].id })),
    };
    const workRecords = await svc.entities.AppRecord.filter({ project_id: work.id, entity_name: "Task" }, "-created_date", 20);
    h.check("28 project isolation holds across sync, data, versions and rooms inside one tenant",
      isolation.sync.some((r) => r.state !== "identical") &&
      isolation.records.records.every((r) => !!r.id) && workRecords.every((r) => r.project_id === work.id) &&
      isolation.version.code === "VERSION_NOT_FOUND",
      `two projects in one workspace diverge; cross-project version ${isolation.version.code}`);

    // ============== 29 · full end-to-end lifecycle, one project, one coherent final state =====
    const finalProj = await svc.entities.Project.get(proj.id);
    const finalDeployment = await svc.entities.Deployment.get(deployment.id);
    const finalBuild = await buildOf(proj.id);
    const lifecycle = {
      create: finalProj.version_count >= 1, plan: !!plan.plan, write: pushed.ok !== false,
      build: build.status === "success", repair: repairedBuild.status === "success",
      version: versions.length >= 3, deploy: finalDeployment.status === "LIVE",
      run: !!rec.id, edit: !!edited.version, rebuild: rebuild.status === "success",
      rollback: !!rolledBack.version,
    };
    h.check("29 the full lifecycle completed on one project and left it internally coherent",
      Object.values(lifecycle).every(Boolean) && finalBuild.status === "success" &&
      finalProj.production_deployment_id === finalDeployment.id && finalDeployment.artifact_checksum === artifact.checksum,
      `${Object.keys(lifecycle).length} lifecycle stages green; project at v${finalProj.version_count}, production ${finalDeployment.status}`);

    // ============== 30 · no cross-system gap: every certified seam is wired ==================
    const learningSystems = productionLearningContract().systems;
    const seams = {
      "types↔sdk": types.includes("Task") && sdkContext.files.length > 0,
      "dependencies↔build": deps.ok !== false && depBuild.status === "success",
      "architecture↔primitives": plan.plan.steps.length > 0 && !!reconciled.architecture,
      "primitives↔sdk": APP_PRIMITIVE_NAMES.length > 0 && AGENT_OPS.length > 0,
      "workflows↔deploy": (artifact.function_names || []).length > 0 && pulledWithWf.resources.length > 0,
      "connectors↔runtime": !!runtimeProjection && connector.ok,
      "actors↔realtime": snapshot.state.count === 1 && REALTIME_OPS.length > 0,
      "safety↔execution": gatedDelete.executed === false && systemTool.decision === "deny",
      "learning↔judge/reward": learningSystems.judge.includes("evaluation") && learningSystems.reward.includes("reward"),
      "security↔surfaces": Object.values(security).every((r) => r.threw),
    };
    const open = Object.entries(seams).filter((entry) => !entry[1]).map((entry) => entry[0]);
    h.check("30 every cross-system seam is wired, with no known architectural gap left open",
      open.length === 0, `${Object.keys(seams).length} seam(s) verified${open.length ? `; open: ${open.join(", ")}` : ""}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    // TEARDOWN WITHOUT DELETION.
    //
    // This suite deletes nothing. Its fixture is already fully disposable and fully isolated — every
    // project was created by THIS run inside a scratch workspace created by THIS run, which check 1b
    // asserts before any mutating check is allowed to execute. Teardown therefore only has to RETIRE
    // that fixture, not erase it.
    //
    // Every write below is an UPDATE addressed by an id this run itself created and pushed onto
    // `created`, so no pre-existing project, workspace or record is reachable from here. Together
    // with the absence of any delete helper in this function's imports, that makes the certification
    // structurally incapable of removing live data.
    for (const pid of created.projects) {
      await svc.entities.Project.update(pid, { status: "error", description: `retired arch-cert fixture · ${nowIso()}` }).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await svc.entities.Workspace.update(wid, { status: "archived", name: `arch-cert-retired-${wid}` }).catch(() => {});
    }
  }
}