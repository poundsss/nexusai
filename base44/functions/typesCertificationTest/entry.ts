// #3 TYPES — generated declarations, end-to-end certification.
//
// Certifies the REAL emit path with nothing stubbed and no second generator, emitter or writer
// created here:
//
//   emit ........... shared/typeEmit.ts emitProjectTypes (the ONE emit path — used by BOTH the run
//                    pipeline's commit phase and the CLI's `types` command)
//   persistence .... shared/cli.ts `types --write` → shared/resourceSync.ts pushResources (kind
//                    "types") → projectFs + commitFiles + createVersion
//   reload ......... shared/authz.ts loadProjectState (the project's own records)
//   build/deploy ... shared/deploy.ts buildArtifact + verifyDeployment
//
// generateTypes() is deliberately NOT called directly: every declaration asserted below is what the
// real pipeline emits.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, writeFile, activeFiles } from "../../shared/projectFs.ts";
import { commitFiles, createVersion } from "../../shared/persistence.ts";
import { emitProjectTypes } from "../../shared/typeEmit.ts";
import { configContent, typesFilePath } from "../../shared/base44Layout.ts";
import { loadProjectState } from "../../shared/authz.ts";
import { runCli } from "../../shared/cli.ts";
import { buildArtifact, verifyDeployment, loadArtifactPayload, ensureProjectSlug } from "../../shared/deploy.ts";
import { encryptSecretValue } from "../../shared/secretCrypto.ts";
import { connectorFilePath, connectorDocumentContent, connectorRuntimePath, connectorRuntimeContent } from "../../shared/connectorResource.ts";
import { actorFilePath } from "../../shared/actorResource.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const APP = `import { html } from 'runtime';
export default function App() {
  return html\`<div class="page"><h1 class="card-title">Types</h1></div>\`;
}
`;
const STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";
const FN = `export const config = { method: "ANY", secrets: [] };
export default async function (ctx) { return { body: { ok: true } }; }
`;
const ACTOR = `export const config = { access: "read", persist: true };
export default async function (ctx) { return { ok: true }; }
`;
const AGENT = `${JSON.stringify({ name: "support-bot", description: "Answers questions", instructions: "Answer using the project's own data only.", tools: [] }, null, 2)}\n`;
const CONNECTOR = connectorDocumentContent({
  name: "weather", type: "http", description: "Forecast lookup", base_url: "https://api.weather.example",
  auth: { type: "api_key", secret: "WEATHER_API_KEY", in: "header", header_name: "X-API-Key" },
  operations: [{ name: "getForecast", method: "GET", path: "/forecast/{city}" }],
});

const ENTITIES = [
  { name: "task_item", fields: { title: { type: "string", required: true }, status: { type: "enum", enum: ["open", "done"], required: false, description: "Lifecycle" }, count: { type: "number", required: false } } },
  { name: "Customer", fields: { email: { type: "string", required: true }, active: { type: "boolean", required: false } } },
];

const TYPES_PATH = typesFilePath();
const CONN_PATH = connectorFilePath("weather");
const ACTOR_PATH = actorFilePath("ChatRoom");
const AGENT_PATH = agentFilePath("support-bot");

const registryBlock = (text, name) => {
  const start = text.indexOf(`interface ${name} {`);
  if (start === -1) return null;
  return text.slice(start, text.indexOf("}", start) + 1);
};
const order = (text, names) => names.map((n) => text.indexOf(`interface ${n} {`));
const ascending = (nums) => nums.every((n, i) => n > 0 && (i === 0 || n > nums[i - 1]));

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `types-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);

    const mkProject = async (name, files, entities = []) => {
      const project = await svc.entities.Project.create({ workspace_id: ws.id, name, framework: "preact-htm", status: "draft", version_count: 0 });
      created.projects.push(project.id);
      await ensureProjectSlug(svc, project);
      const fs = createFs([]);
      for (const [path, content] of Object.entries(files)) writeFile(fs, path, content);
      await commitFiles(svc, project.id, fs);
      const rows = [];
      for (const e of entities) rows.push(await svc.entities.AppEntity.create({ project_id: project.id, name: e.name, fields: e.fields }));
      const version = await createVersion(svc, { project, fs, entities: rows.map((r) => ({ name: r.name, fields: r.fields })), secrets: [], message: name, changedFiles: [] });
      return { project: await svc.entities.Project.get(project.id), fs, version };
    };

    const canonicalFiles = {
      "base44/config.jsonc": configContent("types-canonical", "Declaration certification"),
      "src/main.js": MAIN, "src/App.js": APP, "styles.css": STYLES,
      "functions/profileSync.js": FN,
      [ACTOR_PATH]: ACTOR, [AGENT_PATH]: AGENT,
      [CONN_PATH]: CONNECTOR, [connectorRuntimePath("weather")]: connectorRuntimeContent({ name: "weather", type: "http", description: "Forecast lookup", base_url: "https://api.weather.example", auth: { type: "api_key", secret: "WEATHER_API_KEY", in: "header", header_name: "X-API-Key" }, operations: [{ name: "getForecast", method: "GET", path: "/forecast/{city}" }] }),
    };

    const { project, fs } = await mkProject("types-canonical", canonicalFiles, ENTITIES);
    await svc.entities.ProjectSecret.create({
      project_id: project.id, name: "WEATHER_API_KEY",
      value: await encryptSecretValue(project.id, "WEATHER_API_KEY", "sk-live-types-secret"),
      description: "", required: true, access: "backend_only",
    });

    // ------------------------------------------------ 1. the real emit produces declarations
    const emitted = emitProjectTypes(fs, ENTITIES);
    h.check("1 the real emit path produces a generated declaration file",
      emitted.startsWith("// Auto-generated by Base44 CLI - DO NOT EDIT") &&
      emitted.includes("import '@base44/sdk';") && emitted.includes("declare module '@base44/sdk' {") &&
      emitted.endsWith("}\n"),
      emitted.split("\n").slice(0, 2).join(" · "));

    // ------------------------------------------------ 2. EntityTypeRegistry
    const entReg = registryBlock(emitted, "EntityTypeRegistry");
    h.check("2 EntityTypeRegistry carries every entity, keyed by its raw name and typed by its interface",
      !!entReg && entReg.includes(`"Customer": Customer;`) && entReg.includes(`"task_item": TaskItem;`) &&
      emitted.includes("export interface TaskItem {") && emitted.includes("export interface Customer {") &&
      emitted.includes(`  title: string;`) && emitted.includes(`  status?: "open" | "done";`) &&
      emitted.includes(`  count?: number;`) && emitted.includes(`  active?: boolean;`) &&
      emitted.includes("/** Lifecycle */") && !emitted.includes("created_by_id"),
      entReg || "missing");

    // ------------------------------------------------ 3-6. the four presence registries
    const fnReg = registryBlock(emitted, "FunctionNameRegistry");
    h.check("3 FunctionNameRegistry carries the project's backend function",
      !!fnReg && fnReg.includes(`"profileSync": true;`), fnReg || "missing");
    const actReg = registryBlock(emitted, "ActorNameRegistry");
    h.check("4 ActorNameRegistry carries the declared actor",
      !!actReg && actReg.includes(`"ChatRoom": true;`), actReg || "missing");
    const agtReg = registryBlock(emitted, "AgentNameRegistry");
    h.check("5 AgentNameRegistry carries the declared agent",
      !!agtReg && agtReg.includes(`"support-bot": true;`), agtReg || "missing");
    const connReg = registryBlock(emitted, "ConnectorTypeRegistry");
    h.check("6 ConnectorTypeRegistry carries the declared connector, keyed by its type",
      !!connReg && connReg.includes(`"weather": true;`), connReg || "missing");
    h.check("7 the five registries are emitted in the contract's order",
      ascending(order(emitted, ["EntityTypeRegistry", "FunctionNameRegistry", "ActorNameRegistry", "AgentNameRegistry", "ConnectorTypeRegistry"])),
      order(emitted, ["EntityTypeRegistry", "FunctionNameRegistry", "ActorNameRegistry", "AgentNameRegistry", "ConnectorTypeRegistry"]).join(","));

    // ------------------------------------------------ 8. empty-registry omission
    const entityOnly = emitProjectTypes(createFs([{ id: "1", path: "src/main.js", content: MAIN }]), ENTITIES);
    const nothing = emitProjectTypes(createFs([{ id: "1", path: "src/main.js", content: MAIN }]), []);
    h.check("8 a resource kind with no entries is omitted entirely, and a project with none emits the empty template",
      entityOnly.includes("EntityTypeRegistry") &&
      !/FunctionNameRegistry|ActorNameRegistry|AgentNameRegistry|ConnectorTypeRegistry/.test(entityOnly) &&
      nothing.includes("No entities, functions, actors, agents, or connectors found in project.") &&
      !/Registry/.test(nothing) && nothing.includes("// No types to augment - add resources and regenerate"),
      `entity-only ${entityOnly.length} chars · empty ${nothing.length} chars`);

    // ------------------------------------------------ 9. determinism
    const again = emitProjectTypes(fs, ENTITIES);
    const shuffled = emitProjectTypes(
      createFs(Object.entries(canonicalFiles).reverse().map(([path, content], i) => ({ id: String(i), path, content }))),
      [...ENTITIES].reverse(),
    );
    h.check("9 the output depends only on content, never on collection order",
      again === emitted && shuffled === emitted, `identical=${again === emitted} order-insensitive=${shuffled === emitted}`);

    // ------------------------------------------------ 10. persistence through the real writer
    const dry = await runCli(base44, user, { command: "types", args: { project_id: project.id } });
    const write = await runCli(base44, user, { command: "types", args: { project_id: project.id, write: true } });
    const reloaded = await loadProjectState(base44, project.id);
    const storedRow = reloaded.files.find((f) => f.path === TYPES_PATH);
    h.check("10 the declarations persist to base44/.types/types.d.ts as the project's next version",
      dry.ok && dry.result.changed === true && dry.result.written === false && dry.result.layout === "canonical" &&
      write.ok && write.result.written === true && write.result.path === TYPES_PATH && write.result.version_created === true &&
      !!storedRow && storedRow.content === emitted,
      `dry changed=${dry.result.changed} · written version ${write.result.version} · stored ${storedRow ? storedRow.content.length : 0} chars`);

    // ------------------------------------------------ 11. reload + CLI/pipeline equivalence
    const reloadedFs = createFs(reloaded.files);
    const reEmitted = emitProjectTypes(reloadedFs, reloaded.entities);
    const second = await runCli(base44, user, { command: "types", args: { project_id: project.id, write: true } });
    h.check("11 a reload re-emits byte-identical declarations, and CLI and pipeline agree",
      reEmitted === emitted && write.result.content === emitted &&
      second.ok && second.result.changed === false && second.result.version_created === false,
      `reload identical=${reEmitted === emitted} · re-push created a version=${second.result.version_created}`);

    // ------------------------------------------------ 12. build / deploy compatibility
    const latest = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1))[0];
    const built = await buildArtifact(svc, { project: await svc.entities.Project.get(project.id), version: latest, userId: user.id });
    const payload = built.ok ? await loadArtifactPayload(built.artifact) : { client_files: [] };
    const verified = built.ok
      ? await verifyDeployment(svc, { project: await svc.entities.Project.get(project.id), artifact: built.artifact, deployment: { environment: "production", version_id: built.artifact.version_id } })
      : { ok: false, checks: [] };
    h.check("12 a project carrying generated declarations still builds, ships and verifies",
      built.ok === true && payload.client_files.some((f) => f.path === TYPES_PATH) && verified.ok === true,
      built.ok ? verified.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(" | ") || "all deployment checks pass" : JSON.stringify(built.diagnostics || built.code));

    // ------------------------------------------------ 13. stale resource removal
    const agentRow = reloaded.files.find((f) => f.path === AGENT_PATH);
    await svc.entities.ProjectFile.delete(agentRow.id);
    const afterRemoval = await runCli(base44, user, { command: "types", args: { project_id: project.id, write: true } });
    const afterState = await loadProjectState(base44, project.id);
    const afterStored = afterState.files.find((f) => f.path === TYPES_PATH);
    h.check("13 removing a resource removes it from the declarations and from the persisted file",
      afterRemoval.ok && afterRemoval.result.changed === true &&
      !afterRemoval.result.content.includes("support-bot") && !afterRemoval.result.content.includes("AgentNameRegistry") &&
      afterRemoval.result.content.includes("ActorNameRegistry") && afterRemoval.result.content.includes("ConnectorTypeRegistry") &&
      !!afterStored && afterStored.content === afterRemoval.result.content &&
      afterStored.content === emitProjectTypes(createFs(afterState.files), afterState.entities),
      `${afterStored ? afterStored.content.length : 0} chars persisted after removal`);

    // ------------------------------------------------ 14. legacy flat-layout compatibility
    const legacy = await mkProject("types-legacy", { "src/main.js": MAIN, "src/App.js": APP, "styles.css": STYLES, "functions/legacyPing.js": FN }, [ENTITIES[1]]);
    const legacyDry = await runCli(base44, user, { command: "types", args: { project_id: legacy.project.id } });
    const legacyWrite = await runCli(base44, user, { command: "types", args: { project_id: legacy.project.id, write: true } });
    const legacyState = await loadProjectState(base44, legacy.project.id);
    h.check("14 a legacy flat-layout project is reported as legacy, persists nothing and is never rewritten",
      legacyDry.ok && legacyDry.result.layout === "legacy" && legacyDry.result.written === false &&
      legacyDry.result.content.includes(`"legacyPing": true;`) &&
      legacyWrite.ok === false && legacyWrite.result.code === "RESOURCE_UNSUPPORTED" &&
      !legacyState.files.some((f) => f.path.startsWith("base44/")) &&
      Number(legacyState.files.length) === 4,
      `${legacyWrite.result.code} · ${legacyState.files.length} file(s), none under base44/`);

    // ------------------------------------------------ 15. authorization
    const foreignWs = await svc.entities.Workspace.create({ name: `types-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreign = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "types-foreign", framework: "preact-htm", status: "draft" });
    created.projects.push(foreign.id);
    const denied = await runCli(base44, user, { command: "types", args: { project_id: foreign.id, write: true } });
    h.check("15 declarations cannot be emitted or written for another workspace's project",
      denied.ok === false && denied.status >= 400 && !denied.result.content,
      `${denied.result.code}/${denied.status}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["FunctionInvocation", "TraceEvent", "AuditLog", "Deployment", "DeploymentArtifact", "ProjectSecret", "AppEntity", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["AuditLog", "TraceEvent", "WorkspaceMember", "Project"]);
    }
  }
}