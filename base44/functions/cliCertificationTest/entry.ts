// Certification for the NexusAI CLI.
//
//   nexusai init → link → pull → edit → push → types → sandbox → build → deploy → open
//
// Runs the REAL CLI dispatcher (shared/cli.ts) over the REAL platform contracts it sits on: real
// authorization, real project creation, real E14/E15 resource sync, real sandbox, real build engine,
// real deployment worker, real deployment metadata. Nothing is stubbed and no CLI result is faked:
// every assertion reads the outcome back from the platform's own records.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { runCli, runCliArgv, parseArgv, exitCodeForStatus, EXIT_CODES, CLI_COMMANDS, LINK_FILE, linkDocument, SANDBOX_ALIASES } from "../../shared/cli.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { CONFIG_FILE, entityFilePath, entitySchemaContent, actorFilePath, agentFilePath, typesFilePath, assetFilePath } from "../../shared/base44Layout.ts";
import { canonicalFunctionPath, functionPath } from "../../shared/functionPaths.ts";
import { workflowDocumentContent, workflowFilePath } from "../../shared/workflowResource.ts";
import { WORKFLOW_CONTRACT_VERSION } from "../../shared/workflowContract.ts";
import { agentDocumentContent } from "../../shared/agentResource.ts";
import { agentSkillDocumentContent, agentSkillFilePath } from "../../shared/agentSkillResource.ts";
import { connectorDocumentContent, connectorFilePath, connectorRuntimePath } from "../../shared/connectorResource.ts";
import { scaffoldFiles } from "../../shared/scaffold.ts";
import { generateTypes } from "../../shared/typeGen.ts";
import { deploymentPath } from "../../shared/environments.ts";
import { SANDBOX_OPS } from "../../shared/sandbox.ts";

const SCAFFOLD = scaffoldFiles("cli", "cli certification");
const APP_SRC = SCAFFOLD.find((f) => f.path === ENTRY_FILE).content;
const FN_SRC = `export const config = { method: "POST", secrets: [] };
export default async function handler(ctx) { return { body: { ok: true } }; }
`;
const ACTOR_SRC = `export const config = { access: "write", persist: true, events: true };
export default async function (ctx) { return { reply: { ok: true } }; }
`;
const WF_DEF = {
  name: "CLI flow", contract_version: WORKFLOW_CONTRACT_VERSION,
  trigger: { type: "manual" }, entry_step: "done",
  steps: [{ id: "done", type: "complete", output: { ok: true } }],
};
const BROKEN = "export const broken = (;\n";

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 700) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

/** Parses a --json stdout document; returns null when it is NOT one parseable JSON value. */
const parseOut = (o) => { try { const v = JSON.parse(o.stdout); return o.stdout.trim().split("\n").length === 1 ? v : null; } catch { return null; } };

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };
  const outputs = [];
  // Every CLI call goes through the real dispatcher in --json mode; every output is kept for check 21.
  const cli = async (command, args = {}, who = undefined) => {
    const out = await runCli(base44, who === undefined ? user : who, { command, args, json: true });
    outputs.push(out);
    return { ...out, body: parseOut(out) };
  };
  let user = null;

  try {
    user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const stamp = Date.now();

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `cli-${stamp}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `cli-foreign-${stamp}`, owner_id: `not-${user.id}`, status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreign = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "foreign", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(foreign.id);

    // ---------------------------------------------------------------- 1. init
    const init = await cli("init", { name: `CLI Project ${stamp}`, workspace_id: ws.id });
    const P = init.body?.project_id;
    if (P) created.projects.push(P);
    const initRows = P ? await svc.entities.ProjectFile.filter({ project_id: P }, "path", 50) : [];
    const initVersions = P ? await svc.entities.ProjectVersion.filter({ project_id: P }, "-number", 5) : [];
    const noName = await cli("init", { workspace_id: ws.id });
    const foreignInit = await cli("init", { name: "x", workspace_id: foreignWs.id });
    h.check("1 init creates the canonical project through the existing scaffold + creation path",
      init.exit_code === 0 && init.body.ok && init.body.layout === "canonical" &&
      init.body.files.join(",") === SCAFFOLD.map((f) => f.path).sort().join(",") &&
      initRows.length === SCAFFOLD.length && initRows.some((f) => f.path === CONFIG_FILE) &&
      initVersions.length === 1 && initVersions[0].number === 1 && init.body.version === 1 &&
      init.body.link_file === LINK_FILE && init.body.link === linkDocument(await svc.entities.Project.get(P)) &&
      noName.exit_code === EXIT_CODES.USAGE && foreignInit.exit_code === EXIT_CODES.FORBIDDEN,
      `${initRows.length} files · v${init.body?.version} · no name → ${noName.exit_code} · foreign ws → ${foreignInit.exit_code}`);

    // ---------------------------------------------------------------- 2/3/4. link, selection, unauthorized
    const link = await cli("link", { project_id: P });
    const link2 = await cli("link", { project_id: P });
    const linkForeign = await cli("link", { project_id: foreign.id });
    const linkMissing = await cli("link", { project_id: "no-such-project" });
    const linkNone = await cli("link", {});
    h.check("2 link resolves the project deterministically and persists one stable link document",
      link.exit_code === 0 && link.body.project.id === P && link.body.project.layout === "canonical" &&
      link.body.link === link2.body.link && link.body.link === init.body.link &&
      JSON.parse(link.body.link).project_id === P && JSON.parse(link.body.link).workspace_id === ws.id &&
      linkNone.exit_code === EXIT_CODES.USAGE,
      `link ${link.body?.project?.id} · role ${link.body?.project?.role}`);
    h.check("3 an authenticated caller selects exactly the project their platform account is authorized for",
      link.body.project.role === "owner" && link.body.project.workspace_id === ws.id && link.body.project.version === 1,
      `owner of ws ${ws.id}`);
    h.check("4 an unauthorized project is rejected through the existing authorization path",
      linkForeign.exit_code === EXIT_CODES.FORBIDDEN && linkForeign.body?.ok === false && linkForeign.status === 403 &&
      linkMissing.exit_code === EXIT_CODES.NOT_FOUND && linkMissing.status === 404,
      `foreign → exit ${linkForeign.exit_code} · missing → exit ${linkMissing.exit_code}`);

    // ---------------------------------------------------------------- 5. pull
    const pull = await cli("pull", { project_id: P });
    h.check("5 pull returns the project's current canonical resources through resourceSync",
      pull.exit_code === 0 && pull.body.version === 1 &&
      pull.body.resources.some((r) => r.kind === "config" && r.path === CONFIG_FILE) &&
      pull.body.resources.find((r) => r.kind === "config").content === initRows.find((f) => f.path === CONFIG_FILE).content &&
      Array.isArray(pull.body.kinds) && pull.body.kinds.includes("entities"),
      `${pull.body?.count} resource(s) at v${pull.body?.version}`);

    // ---------------------------------------------------------------- 6. edit
    const edit = await cli("edit", { project_id: P, path: ENTRY_FILE, find: "getElementById('app')", replace: "getElementById('app') /* cli */" });
    const afterEdit = await cli("sandbox", { project_id: P, op: "read", path: ENTRY_FILE });
    const editNoArgs = await cli("edit", { project_id: P, path: ENTRY_FILE });
    const editMissing = await cli("edit", { project_id: P, path: "src/ghost.js", find: "a", replace: "b" });
    h.check("6 edit goes through the existing sandbox edit path and persists",
      edit.exit_code === 0 && edit.body.edited && edit.body.via === "filesystem" &&
      afterEdit.body.content.includes("/* cli */") &&
      editNoArgs.exit_code === EXIT_CODES.USAGE && editMissing.exit_code === EXIT_CODES.NOT_FOUND,
      `edited ${edit.body?.path} · no args → ${editNoArgs.exit_code} · missing → ${editMissing.exit_code}`);

    // ---------------------------------------------------------------- 7/8/9. push, idempotent push, conflict
    const ENTITY_PATH = entityFilePath("Task");
    const FN_PATH = canonicalFunctionPath("notify");
    const pushRes = [
      { path: ENTITY_PATH, content: entitySchemaContent("Task", { title: { type: "string", required: true } }) },
      { path: FN_PATH, content: FN_SRC },
    ];
    const push = await cli("push", { project_id: P, resources: pushRes, mode: "merge", message: "cli push" });
    const stateAfterPush = await svc.entities.AppEntity.filter({ project_id: P }, "name", 10);
    const push2 = await cli("push", { project_id: P, resources: pushRes, mode: "merge" });
    const versionAfter2 = Number((await svc.entities.Project.get(P)).version_count);
    const conflict = await cli("push", { project_id: P, resources: pushRes, mode: "merge", expected_version: 999 });
    const badMode = await cli("push", { project_id: P, resources: pushRes, mode: "sideways" });
    const noResources = await cli("push", { project_id: P });
    h.check("7 push validates and applies resources through E14/E15 and produces the next version",
      push.exit_code === 0 && push.body.created === 2 && push.body.version_created && push.body.version === 2 &&
      stateAfterPush.some((e) => e.name === "Task") && push.body.resources.map((r) => r.kind).sort().join(",") === "entities,functions",
      `created ${push.body?.created} · v${push.body?.version}`);
    h.check("8 an identical push is idempotent: nothing written, no version created",
      push2.exit_code === 0 && push2.body.unchanged === 2 && push2.body.created === 0 && push2.body.updated === 0 &&
      !push2.body.version_created && push2.body.version === 2 && versionAfter2 === 2,
      `unchanged ${push2.body?.unchanged} · still v${versionAfter2}`);
    h.check("9 a stale push is refused as a conflict; bad arguments are usage errors",
      conflict.exit_code === EXIT_CODES.CONFLICT && conflict.status === 409 && conflict.body.code === "RESOURCE_CONFLICT" &&
      conflict.body.details.actual_version === 2 &&
      badMode.exit_code === EXIT_CODES.USAGE && noResources.exit_code === EXIT_CODES.USAGE &&
      Number((await svc.entities.Project.get(P)).version_count) === 2,
      `conflict → exit ${conflict.exit_code} (${conflict.body?.code})`);

    // ---------------------------------------------------------------- 10. types
    const types1 = await cli("types", { project_id: P });
    const types2 = await cli("types", { project_id: P });
    const expectedTypes = generateTypes({ entities: [{ name: "Task", fields: { title: { type: "string", required: true } } }], functions: [{ name: "notify" }] });
    const typesWrite = await cli("types", { project_id: P, write: true });
    const typesWrite2 = await cli("types", { project_id: P, write: true });
    const typesRow = await svc.entities.ProjectFile.filter({ project_id: P, path: typesFilePath() }, "path", 1);
    const typesMissing = await cli("types", { project_id: "no-such-project" });
    h.check("10 types is the existing generator: deterministic, resource-aware, persisted through resourceSync",
      types1.exit_code === 0 && types1.body.content === types2.body.content && types1.body.content === expectedTypes &&
      types1.body.content.includes("export interface Task") && types1.body.content.includes('"notify": true;') &&
      types1.body.changed === true && typesWrite.body.written && typesWrite.body.version_created &&
      typesRow.length === 1 && typesRow[0].content === expectedTypes &&
      typesWrite2.body.changed === false && !typesWrite2.body.version_created &&
      typesMissing.exit_code === EXIT_CODES.NOT_FOUND,
      `${types1.body?.content?.length} chars · written v${typesWrite.body?.version} · re-write created ${typesWrite2.body?.version_created}`);

    // ---------------------------------------------------------------- 11/12/13/14. sandbox
    const sRead = await cli("sandbox", { project_id: P, op: "read", path: ENTRY_FILE });
    const sLs = await cli("sandbox", { project_id: P, op: "ls", path: "src/pages" });
    const sGrep = await cli("sandbox", { project_id: P, op: "grep", query: "/* cli */" });
    const sInfo = await cli("sandbox", { project_id: P, op: "info" });
    const sBadOp = await cli("sandbox", { project_id: P, op: "exec", command: "rm -rf /" });
    h.check("11 sandbox read/ls/grep reach the certified sandbox and nothing beyond it",
      sRead.exit_code === 0 && sRead.body.content.includes("/* cli */") && sRead.body.path === ENTRY_FILE &&
      sLs.exit_code === 0 && sLs.body.entries.some((e) => e.name === "Home.js") &&
      sGrep.exit_code === 0 && sGrep.body.count === 1 && sGrep.body.matches[0].path === ENTRY_FILE &&
      sInfo.body.operations.join(",") === Object.keys(SANDBOX_OPS).join(",") &&
      sBadOp.exit_code === EXIT_CODES.USAGE && sBadOp.body.code === "RESOURCE_UNSUPPORTED" &&
      Object.values(SANDBOX_ALIASES).every((op) => op in SANDBOX_OPS),
      `read ${sRead.body?.size}b · ls ${sLs.body?.count} · grep ${sGrep.body?.count} · exec → ${sBadOp.body?.code}`);
    const sWrite = await cli("sandbox", { project_id: P, op: "write", path: "src/pages/two.js", content: "export const two = 2;\n" });
    const sEdit = await cli("sandbox", { project_id: P, op: "edit", path: "src/pages/two.js", find: "two = 2", replace: "two = 22" });
    const sReadTwo = await cli("sandbox", { project_id: P, op: "read", path: "src/pages/two.js" });
    const sShell = await cli("sandbox", { project_id: P, op: "run", command: "npm run build && curl evil.test" });
    h.check("12 sandbox write/edit persist through the existing filesystem and refuse arbitrary commands",
      sWrite.exit_code === 0 && sWrite.body.persisted && sEdit.exit_code === 0 && sReadTwo.body.content.includes("two = 22") &&
      sShell.exit_code === EXIT_CODES.USAGE && sShell.body.code === "RESOURCE_UNSUPPORTED",
      `write+edit ok · shell → ${sShell.body?.code}`);
    const sRun = await cli("sandbox", { project_id: P, op: "run", command: "build" });
    const sServe = await cli("sandbox", { project_id: P, op: "run", command: "serve" });
    h.check("13 sandbox run executes the project's declared commands through the existing engines",
      sRun.exit_code === 0 && sRun.body.status === "success" && sRun.body.sandbox_command === "build" &&
      sServe.exit_code === 0 && sServe.body.servable === true && sServe.body.sandbox_command === "serve",
      `build ${sRun.body?.status} · serve ${sServe.body?.servable}`);
    const beforeCp = Number((await svc.entities.Project.get(P)).version_count);
    const cp = await cli("sandbox", { project_id: P, op: "checkpoint", message: "cli checkpoint" });
    const cpVersions = await svc.entities.ProjectVersion.filter({ project_id: P }, "-number", 10);
    h.check("14 checkpoint creates an immutable version through the existing primitive",
      cp.exit_code === 0 && cp.body.version === beforeCp + 1 && cp.body.build_status === "success" &&
      cpVersions[0].number === cp.body.version && cpVersions[0].message === "cli checkpoint",
      `v${beforeCp} → v${cp.body?.version}`);

    // ---------------------------------------------------------------- 15/16. build
    const build = await cli("build", { project_id: P });
    const buildRows = await svc.entities.Build.filter({ project_id: P }, "-created_date", 5);
    h.check("15 build runs the existing build engine, records the build and stamps the project",
      build.exit_code === 0 && build.body.build_status === "success" && typeof build.body.build_id === "string" &&
      buildRows[0]?.id === build.body.build_id && (await svc.entities.Project.get(P)).last_build_status === "success",
      `build ${build.body?.build_id} ${build.body?.build_status}`);
    const breakIt = await cli("edit", { project_id: P, path: "src/pages/two.js", content: BROKEN });
    const buildFail = await cli("build", { project_id: P });
    const buildFail2 = await cli("build", { project_id: P });
    const runFail = await cli("sandbox", { project_id: P, op: "run", command: "build" });
    h.check("16 a failing build is a deterministic non-zero exit, never a false success",
      breakIt.exit_code === 0 && buildFail.exit_code === EXIT_CODES.BUILD_FAILED && buildFail.status === 400 &&
      buildFail.body.ok === false && buildFail.body.build_status === "failed" && buildFail.body.errors > 0 &&
      buildFail2.exit_code === buildFail.exit_code && buildFail2.body.errors === buildFail.body.errors &&
      runFail.exit_code === EXIT_CODES.BUILD_FAILED && buildFail.stderr.length > 0 &&
      (await svc.entities.Project.get(P)).last_build_status === "failed",
      `broken build → exit ${buildFail.exit_code} (${buildFail.body?.errors} error(s)), twice identical`);
    const repair = await cli("edit", { project_id: P, path: "src/pages/two.js", content: "export const two = 2;\n" });
    const cpGood = await cli("sandbox", { project_id: P, op: "checkpoint", message: "deployable" });

    // ---------------------------------------------------------------- 17/18. deploy
    const deploy = await cli("deploy", { project_id: P });
    const deployRow = deploy.body?.deployment_id ? await svc.entities.Deployment.get(deploy.body.deployment_id) : null;
    const projectAfterDeploy = await svc.entities.Project.get(P);
    h.check("17 deploy requests and drives the existing deployment to LIVE with intact artifact/version identity",
      repair.exit_code === 0 && cpGood.exit_code === 0 &&
      deploy.exit_code === 0 && deploy.body.status === "LIVE" && deploy.body.version_number === cpGood.body.version &&
      deployRow?.status === "LIVE" && deployRow.artifact_id === deploy.body.artifact_id && !!deploy.body.artifact_checksum &&
      projectAfterDeploy.production_deployment_id === deploy.body.deployment_id &&
      projectAfterDeploy.production_version_number === cpGood.body.version &&
      deploy.body.url === deploymentPath(projectAfterDeploy.slug, "production"),
      `deployment ${deploy.body?.deployment_id} ${deploy.body?.status} v${deploy.body?.version_number} · ${deploy.body?.url}`);
    await cli("edit", { project_id: P, path: "src/pages/two.js", content: BROKEN });
    const cpBroken = await cli("sandbox", { project_id: P, op: "checkpoint", require_build: false, message: "knowingly broken" });
    const deployFail = await cli("deploy", { project_id: P });
    const failRow = deployFail.body?.deployment_id ? await svc.entities.Deployment.get(deployFail.body.deployment_id) : null;
    const projectAfterFail = await svc.entities.Project.get(P);
    const deployForeign = await cli("deploy", { project_id: foreign.id });
    h.check("18 a failing deploy is a deterministic non-zero exit and production keeps the previous LIVE deployment",
      cpBroken.exit_code === 0 && cpBroken.body.build_status === "failed" &&
      deployFail.exit_code === EXIT_CODES.DEPLOY_FAILED && deployFail.status === 400 && deployFail.body.ok === false &&
      deployFail.body.status === "FAILED" && deployFail.body.failure_code === "BUILD_FAILED" && deployFail.body.diagnostics.length > 0 &&
      failRow?.status === "FAILED" &&
      projectAfterFail.production_deployment_id === deploy.body.deployment_id &&
      projectAfterFail.production_version_number === cpGood.body.version &&
      deployForeign.exit_code === EXIT_CODES.FORBIDDEN,
      `failed deploy → exit ${deployFail.exit_code} (${deployFail.body?.failure_code}) · production still ${projectAfterFail.production_deployment_id === deploy.body?.deployment_id}`);

    // ---------------------------------------------------------------- 19. open
    const open = await cli("open", { project_id: P });
    const openPreview = await cli("open", { project_id: P, target: "preview" });
    const openStaging = await cli("open", { project_id: P, target: "staging" });
    const openForeign = await cli("open", { project_id: foreign.id });
    h.check("19 open resolves the LIVE deployment target from the existing deployment metadata",
      open.exit_code === 0 && open.body.deployment_id === deploy.body.deployment_id && open.body.url === deploy.body.url &&
      open.body.url === deploymentPath(projectAfterFail.slug, "production") && open.body.version_number === cpGood.body.version &&
      open.body.pointer_matches === true && open.body.artifact_checksum === deploy.body.artifact_checksum &&
      openPreview.exit_code === 0 && openPreview.body.url === `/projects/${P}` &&
      openStaging.exit_code === EXIT_CODES.NOT_FOUND && openStaging.body.code === "DEPLOYMENT_NOT_FOUND" &&
      openForeign.exit_code === EXIT_CODES.FORBIDDEN,
      `${open.body?.url} · staging → exit ${openStaging.exit_code}`);

    // ---------------------------------------------------------------- 20. exit-code contract
    const unknownCmd = await cli("teleport", { project_id: P });
    const noProject = await cli("pull", {});
    const unauth = await cli("pull", { project_id: P }, null);
    const argv = parseArgv(["push", "--project", P, "--mode=merge", "--json", "--expected-version", "2"]);
    const viaArgv = await runCliArgv(base44, user, ["sandbox", P, "--op", "read", "--path", ENTRY_FILE, "--json"]);
    outputs.push(viaArgv);
    h.check("20 the exit-code contract is centralized and derived from the E15 status",
      [200, 202, 400, 401, 403, 404, 409, 500, 503].map(exitCodeForStatus).join(",") === "0,0,2,3,4,5,6,1,1" &&
      unknownCmd.exit_code === EXIT_CODES.USAGE && unknownCmd.body.code === "RESOURCE_UNSUPPORTED" && unknownCmd.body.details.commands.join(",") === CLI_COMMANDS.join(",") &&
      noProject.exit_code === EXIT_CODES.USAGE && unauth.exit_code === EXIT_CODES.UNAUTHENTICATED && unauth.status === 401 &&
      linkForeign.exit_code === EXIT_CODES.FORBIDDEN && linkMissing.exit_code === EXIT_CODES.NOT_FOUND &&
      conflict.exit_code === EXIT_CODES.CONFLICT && buildFail.exit_code === EXIT_CODES.BUILD_FAILED && deployFail.exit_code === EXIT_CODES.DEPLOY_FAILED &&
      argv.command === "push" && argv.args.project_id === P && argv.args.mode === "merge" && argv.args.expected_version === "2" && argv.json === true &&
      viaArgv.exit_code === 0 && JSON.parse(viaArgv.stdout).content.includes("/* cli */"),
      `usage ${unknownCmd.exit_code} · unauth ${unauth.exit_code} · forbidden ${linkForeign.exit_code} · not found ${linkMissing.exit_code} · conflict ${conflict.exit_code} · build ${buildFail.exit_code} · deploy ${deployFail.exit_code}`);

    // ---------------------------------------------------------------- 21. JSON stdout validity
    const successes = outputs.filter((o) => o.exit_code === 0);
    const failures = outputs.filter((o) => o.exit_code !== 0);
    const human = await runCli(base44, user, { command: "link", args: { project_id: P }, json: false });
    h.check("21 --json stdout is always exactly one parseable JSON document; diagnostics stay on stderr",
      outputs.length > 30 && outputs.every((o) => parseOut(o) !== null) &&
      outputs.every((o) => parseOut(o).ok === (o.exit_code === 0) && parseOut(o).exit_code === o.exit_code && parseOut(o).command === o.command) &&
      successes.every((o) => o.stderr === "") && failures.every((o) => o.stderr.length > 0 && !o.stdout.includes(o.stderr.trim())) &&
      // A failure body is either an E15 failure (code + error) or an engine outcome that reports its
      // own status (a failed build, a failed deployment) — never a body that says nothing at all.
      failures.every((o) => { const b = parseOut(o); return (typeof b.error === "string" && typeof b.code === "string") || typeof b.build_status === "string" || typeof b.status === "string"; }) &&
      human.stdout.startsWith("nexusai link: ok") && (() => { try { JSON.parse(human.stdout); return false; } catch { return true; } })(),
      `${outputs.length} outputs · ${successes.length} ok · ${failures.length} failed, all parseable`);

    // ---------------------------------------------------------------- 22. project isolation
    const other = await svc.entities.Project.create({ workspace_id: ws.id, name: "cli-other", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(other.id);
    for (const f of SCAFFOLD) await svc.entities.ProjectFile.create({ project_id: other.id, path: f.path, content: f.content });
    const otherPull = await cli("pull", { project_id: other.id });
    const otherRead = await cli("sandbox", { project_id: other.id, op: "read", path: "src/pages/two.js" });
    const otherGrep = await cli("sandbox", { project_id: other.id, op: "grep", query: "/* cli */" });
    const otherOpen = await cli("open", { project_id: other.id });
    const otherTypes = await cli("types", { project_id: other.id });
    h.check("22 every command is scoped to its own project — nothing leaks between sibling projects",
      otherPull.exit_code === 0 && !otherPull.body.resources.some((r) => r.kind === "entities" || r.kind === "functions") &&
      otherRead.exit_code === EXIT_CODES.NOT_FOUND && otherGrep.body.count === 0 &&
      otherOpen.exit_code === EXIT_CODES.NOT_FOUND && !otherTypes.body.content.includes("Task"),
      `sibling: ${otherPull.body?.count} resource(s), no Task/notify, nothing live`);

    // ---------------------------------------------------------------- 23. malformed / invalid resources
    const versionBefore = Number((await svc.entities.Project.get(P)).version_count);
    const badEntity = await cli("push", { project_id: P, resources: [{ path: ENTITY_PATH, content: "{ not json" }], mode: "merge" });
    const wrongName = await cli("push", { project_id: P, resources: [{ path: ENTITY_PATH, content: entitySchemaContent("Other", { a: { type: "string" } }) }], mode: "merge" });
    const badKind = await cli("pull", { project_id: P, kinds: "entities" });
    const unsupportedKind = await cli("push", { project_id: P, resources: [{ path: "elsewhere/x.jsonc", content: "{}" }], mode: "merge" });
    const mixed = await cli("push", { project_id: P, resources: [{ path: FN_PATH, content: FN_SRC.replace("ok: true", "ok: 1") }, { path: ENTITY_PATH, content: "{ nope" }], mode: "merge" });
    const fnRow = await svc.entities.ProjectFile.filter({ project_id: P, path: FN_PATH }, "path", 1);
    h.check("23 a malformed or invalid resource is refused deterministically and nothing is applied",
      badEntity.exit_code === EXIT_CODES.USAGE && badEntity.body.code === "RESOURCE_MALFORMED" &&
      wrongName.exit_code === EXIT_CODES.USAGE && wrongName.body.code === "RESOURCE_INVALID_NAME" &&
      badKind.exit_code === 0 && badKind.body.kinds.join(",") === "entities" &&
      unsupportedKind.exit_code === EXIT_CODES.USAGE &&
      mixed.exit_code === EXIT_CODES.USAGE && fnRow[0].content === FN_SRC &&
      Number((await svc.entities.Project.get(P)).version_count) === versionBefore,
      `malformed → ${badEntity.body?.code} · wrong name → ${wrongName.body?.code} · mixed set applied nothing`);

    // ---------------------------------------------------------------- 24. full lifecycle (fresh workspace)
    const ws2 = await svc.entities.Workspace.create({ name: `cli-lifecycle-${stamp}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws2.id);
    const lc = {};
    lc.init = await cli("init", { name: `Lifecycle ${stamp}`, workspace_id: ws2.id });
    const L = lc.init.body?.project_id;
    if (L) created.projects.push(L);
    lc.link = await cli("link", { project_id: L });
    lc.pull = await cli("pull", { project_id: L });
    lc.edit = await cli("edit", { project_id: L, path: ENTRY_FILE, find: "getElementById('app')", replace: "getElementById('app') /* lifecycle */" });
    // Representative coverage of the completed resource model, pushed in ONE set.
    lc.push = await cli("push", {
      project_id: L, mode: "merge", message: "lifecycle push",
      resources: [
        { path: entityFilePath("Note"), content: entitySchemaContent("Note", { body: { type: "text", required: true } }, null, { read: { created_by: "{{user.id}}" } }) },
        { path: canonicalFunctionPath("ping"), content: FN_SRC },
        { path: workflowFilePath(WF_DEF.name), content: workflowDocumentContent(WF_DEF) },
        { path: agentSkillFilePath("triage"), content: agentSkillDocumentContent({ name: "triage", description: "Triage guidance", body: "Triage incoming notes by urgency." }) },
        { path: agentFilePath("helper"), content: agentDocumentContent({ name: "helper", instructions: "Help with the project.", tools: ["read_file"], skills: ["triage"] }) },
        { path: connectorFilePath("weather"), content: connectorDocumentContent({ name: "weather", base_url: "https://api.weather.test", operations: [{ name: "current", method: "GET", path: "/current" }] }) },
        { path: actorFilePath("ChatRoom"), content: ACTOR_SRC },
        { path: assetFilePath("logo.svg"), content: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
      ],
    });
    lc.pull2 = await cli("pull", { project_id: L });
    lc.types = await cli("types", { project_id: L, write: true });
    // The generated declarations only exist AFTER `types --write`, so the pull that must see them
    // is the one taken after that step; pull2 above is the pre-types state.
    lc.pull3 = await cli("pull", { project_id: L });
    lc.read = await cli("sandbox", { project_id: L, op: "read", path: ENTRY_FILE });
    lc.run = await cli("sandbox", { project_id: L, op: "run", command: "build" });
    lc.checkpoint = await cli("sandbox", { project_id: L, op: "checkpoint", message: "lifecycle" });
    lc.build = await cli("build", { project_id: L });
    lc.deploy = await cli("deploy", { project_id: L });
    lc.open = await cli("open", { project_id: L });
    const lcEntity = L ? await svc.entities.AppEntity.filter({ project_id: L, name: "Note" }, "name", 1) : [];
    const lcWf = L ? await svc.entities.WorkflowDefinition.filter({ project_id: L }, "-version", 5) : [];
    const lcPaths = lc.pull2.body?.resources?.map((r) => r.path) || [];
    const pulledKinds = [...new Set(lc.pull2.body?.resources?.map((r) => r.kind) || [])].sort().join(",");
    const pulledKindsAfterTypes = [...new Set(lc.pull3.body?.resources?.map((r) => r.kind) || [])].sort().join(",");
    h.check("24 the complete init → link → pull → edit → push → types → sandbox → build → deploy → open lifecycle succeeds",
      Object.values(lc).every((o) => o.exit_code === 0) &&
      lc.push.body.created === 8 && lc.push.body.version_created &&
      pulledKinds === "actors,agent-skills,agents,assets,config,connectors,entities,functions,workflows" &&
      pulledKindsAfterTypes === "actors,agent-skills,agents,assets,config,connectors,entities,functions,types,workflows" &&
      lcPaths.includes(connectorFilePath("weather")) && lcEntity[0]?.rls?.read?.created_by === "{{user.id}}" &&
      lcWf.some((d) => d.status === "FINALIZED" && d.workflow_key === "cli-flow") &&
      (await svc.entities.ProjectFile.filter({ project_id: L, path: connectorRuntimePath("weather") }, "path", 1)).length === 1 &&
      lc.types.body.content.includes("export interface Note") && lc.types.body.content.includes('"ping": true;') &&
      lc.read.body.content.includes("/* lifecycle */") && lc.run.body.logs.some((l) => l.startsWith("[actors]")) &&
      lc.deploy.body.status === "LIVE" && lc.open.body.deployment_id === lc.deploy.body.deployment_id &&
      lc.open.body.url === lc.deploy.body.url && lc.deploy.body.version_number === lc.checkpoint.body.version,
      `${Object.keys(lc).length} steps · kinds ${pulledKinds} → ${pulledKindsAfterTypes} · ${lc.open.body?.url} (${lc.deploy.body?.status})`);

    // ---------------------------------------------------------------- 25. legacy compatibility
    const legacy = await svc.entities.Project.create({ workspace_id: ws.id, name: "cli-legacy", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(legacy.id);
    for (const f of SCAFFOLD) if (f.path !== CONFIG_FILE) await svc.entities.ProjectFile.create({ project_id: legacy.id, path: f.path, content: f.content });
    await svc.entities.ProjectFile.create({ project_id: legacy.id, path: functionPath("legacyFn"), content: FN_SRC });
    const lgLink = await cli("link", { project_id: legacy.id });
    const lgPull = await cli("pull", { project_id: legacy.id });
    const lgPush = await cli("push", { project_id: legacy.id, mode: "merge", resources: [{ path: canonicalFunctionPath("legacyFn"), content: FN_SRC.replace("ok: true", "ok: 1 === 1") }] });
    const lgFiles = await svc.entities.ProjectFile.filter({ project_id: legacy.id }, "path", 50);
    const lgBuild = await cli("build", { project_id: legacy.id });
    const lgTypes = await cli("types", { project_id: legacy.id });
    const lgTypesWrite = await cli("types", { project_id: legacy.id, write: true });
    const lgCp = await cli("sandbox", { project_id: legacy.id, op: "checkpoint", message: "legacy" });
    const lgDeploy = await cli("deploy", { project_id: legacy.id });
    const lgOpen = await cli("open", { project_id: legacy.id });
    h.check("25 a legacy flat-layout project links, pulls, pushes, builds, deploys and opens unchanged",
      lgLink.exit_code === 0 && lgLink.body.project.layout === "legacy" &&
      lgPull.exit_code === 0 && lgPull.body.resources.some((r) => r.kind === "functions" && r.path === functionPath("legacyFn")) &&
      lgPush.exit_code === 0 && lgPush.body.updated === 1 && lgPush.body.resources[0].path === functionPath("legacyFn") &&
      lgFiles.filter((f) => f.path === functionPath("legacyFn")).length === 1 && !lgFiles.some((f) => f.path === canonicalFunctionPath("legacyFn")) &&
      !lgFiles.some((f) => f.path === CONFIG_FILE) &&
      lgBuild.exit_code === 0 && lgTypes.exit_code === 0 && lgTypes.body.layout === "legacy" &&
      lgTypesWrite.exit_code === EXIT_CODES.USAGE && lgTypesWrite.body.code === "RESOURCE_UNSUPPORTED" &&
      lgCp.exit_code === 0 && lgDeploy.exit_code === 0 && lgDeploy.body.status === "LIVE" &&
      lgOpen.exit_code === 0 && lgOpen.body.deployment_id === lgDeploy.body.deployment_id,
      `layout ${lgLink.body?.project?.layout} · fn kept at ${functionPath("legacyFn")} · deploy ${lgDeploy.body?.status}`);

    return compact(h);
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["WorkflowStepRun", "WorkflowRun", "WorkflowDefinition", "ScheduledTrigger", "AuditLog", "TraceEvent", "AppRecord", "AppEntity", "ProjectSecret", "Deployment", "DeploymentArtifact", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["WorkflowDefinition", "AuditLog", "TraceEvent", "RateLimitBucket", "CreditLedgerEntry", "WorkspaceMember", "Project"]);
    }
  }
}