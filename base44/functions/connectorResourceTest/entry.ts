// Certification for E12 — the Base44 connector RESOURCE layer.
//
// Runs against the REAL modules and the REAL data layer: the real connector path contract, the real
// integration normalizer (the ONE validator), the real project filesystem write guard, the real
// journalled persistence, the real push/pull resource sync and the real build engine. Nothing is
// stubbed, and this suite creates no second sync, runtime, validator or credential path of its own.
//
// The lifecycle under test is exactly the one E12 asks for:
//   create → persist → load → push → runtime projection → build → pull
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs, writeFile, activeFiles } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { configContent, CONFIG_FILE } from "../../shared/base44Layout.ts";
import {
  isConnectorFilePath, connectorFilePath, connectorNameFromPath,
  parseConnectorDocument, connectorDocumentContent, connectorRuntimePath, connectorRuntimeContent,
  collectConnectors, resolveConnector, adoptableConnectors,
} from "../../shared/connectorResource.ts";
import { integrationPath, parseIntegrationFile, serializeIntegration, normalizeIntegration } from "../../shared/integrations.ts";
import { loadProjectState } from "../../shared/authz.ts";
import { pullResources, pushResources, resourceStatus, resourceKindOf, resourceIdentity, validateResource } from "../../shared/resourceSync.ts";

const WEATHER = {
  type: "http",
  description: "Forecast lookup",
  base_url: "https://api.weather.example",
  auth: { type: "api_key", secret: "WEATHER_API_KEY", in: "header", header_name: "X-API-Key" },
  operations: [{ name: "getForecast", method: "GET", path: "/forecast/{city}", description: "Forecast by city" }],
};
// A pre-existing NexusAI integration with no connector document — must keep working untouched.
const LEGACY = {
  name: "legacyBilling", type: "http", base_url: "https://api.billing.example",
  auth: { type: "bearer", secret: "LEGACY_BILLING_TOKEN" },
  operations: [{ name: "listInvoices", method: "GET", path: "/invoices" }],
};
const FN_USES_WEATHER = `export const config = { method: "GET" };
export default async function (ctx) { return { body: await integrations.weather.getForecast({ city: "nyc" }) }; }
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

    const ws = await svc.entities.Workspace.create({ name: `connres-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "connector-resources", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(project.id);

    const CONN_PATH = connectorFilePath("weather");
    const RUNTIME_PATH = connectorRuntimePath("weather");
    const docText = connectorDocumentContent({ ...WEATHER, name: "weather" });

    // ------------------------------------------------ 1. canonical resource path
    h.check("1 canonical connector resource path",
      CONN_PATH === "base44/connectors/weather.jsonc" && isConnectorFilePath(CONN_PATH) &&
      connectorNameFromPath(CONN_PATH) === "weather" &&
      resourceKindOf(CONN_PATH) === "connectors" && resourceIdentity(CONN_PATH) === "weather" &&
      RUNTIME_PATH === integrationPath("weather") &&
      !isConnectorFilePath("base44/connectors/Weather.jsonc") &&
      !isConnectorFilePath("base44/connectors/nested/weather.jsonc") &&
      !isConnectorFilePath("integrations/weather.json"),
      `${CONN_PATH} → weather · runtime projection ${RUNTIME_PATH}`);

    // ------------------------------------------------ 2. valid create/write
    const fs = createFs([]);
    writeFile(fs, ENTRY_FILE, "export default function App() { return null; }");
    writeFile(fs, CONN_PATH, docText);
    const rejectedExt = (() => { try { writeFile(fs, "base44/connectors/weather.json", "{}"); return null; } catch (e) { return e; } })();
    const rejectedNested = (() => { try { writeFile(fs, "base44/connectors/deep/weather.jsonc", "{}"); return null; } catch (e) { return e; } })();
    h.check("2 the project filesystem accepts only canonical connector resources",
      activeFiles(fs).some((f) => f.path === CONN_PATH) && !!rejectedExt && !!rejectedNested,
      "the canonical document is writable; a wrong extension and a nested path are refused");

    // ------------------------------------------------ 3. malformed rejection
    const badJson = parseConnectorDocument(CONN_PATH, "{ not json");
    const badName = parseConnectorDocument(CONN_PATH, JSON.stringify({ ...WEATHER, name: "other" }));
    const badUrl = parseConnectorDocument(CONN_PATH, JSON.stringify({ ...WEATHER, base_url: "not-a-url" }));
    const badOp = parseConnectorDocument(CONN_PATH, JSON.stringify({ ...WEATHER, operations: [{ name: "Bad Name" }] }));
    h.check("3 malformed connector documents are refused with a stated reason",
      !badJson.ok && /valid JSONC/.test(badJson.error) &&
      !badName.ok && /file name/.test(badName.error) &&
      !badUrl.ok && /base_url/.test(badUrl.error) && !badOp.ok,
      `${badJson.error} | ${badName.error} | ${badUrl.error}`);

    // ------------------------------------------------ 4. parse → emit → re-parse determinism
    const parsed = parseConnectorDocument(CONN_PATH, docText);
    const emitted = connectorDocumentContent(parsed.connector);
    const reparsed = parseConnectorDocument(CONN_PATH, emitted);
    h.check("4 parse → emit → re-parse is deterministic",
      parsed.ok && parsed.connector.name === "weather" && parsed.connector.operations.length === 1 &&
      emitted === docText && reparsed.ok &&
      connectorDocumentContent(reparsed.connector) === emitted &&
      connectorRuntimeContent(parsed.connector) === serializeIntegration(normalizeIntegration({ ...WEATHER, name: "weather" })),
      "re-emitting the same connector is byte-identical, and so is its runtime projection");

    // ------------------------------------------------ 5. persistence / load round-trip
    for (const f of activeFiles(fs)) await svc.entities.ProjectFile.create({ project_id: project.id, path: f.path, content: f.content });
    const state1 = await loadProjectState(base44, project.id);
    const collected = collectConnectors(state1.files);
    h.check("5 a persisted connector loads back through the existing collectors",
      collected.count === 1 && collected.errors.length === 0 &&
      collected.connectors[0].name === "weather" &&
      resolveConnector(state1.files, "weather")?.base_url === WEATHER.base_url &&
      resolveConnector(state1.files, "missing") === null,
      "the stored document loads and resolves by name");

    // ------------------------------------------------ 6. push → runtime projection
    const push1 = await pushResources(base44, user, {
      project_id: project.id,
      resources: [{ path: CONFIG_FILE, content: configContent("connector-resources") }, { path: CONN_PATH, content: docText }],
      message: "connector push",
    });
    const filesAfterPush = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    const runtimeRow = filesAfterPush.find((f) => f.path === RUNTIME_PATH);
    h.check("6 push materializes integrations/<name>.json from the connector resource",
      push1.ok && !!runtimeRow &&
      runtimeRow.content === connectorRuntimeContent(parsed.connector) &&
      parseIntegrationFile(RUNTIME_PATH, runtimeRow.content).name === "weather" &&
      filesAfterPush.some((f) => f.path === CONN_PATH),
      `push ok=${push1.ok} · projection ${runtimeRow ? "present" : "missing"}`);

    // ------------------------------------------------ 7. pull → connector resource
    const pull1 = await pullResources(base44, user, { project_id: project.id });
    const pulled = pull1.resources.filter((r) => r.kind === "connectors");
    h.check("7 pull returns the connector as a canonical resource, exactly once",
      pulled.length === 1 && pulled[0].identity === "weather" && pulled[0].path === CONN_PATH &&
      parseConnectorDocument(pulled[0].path, pulled[0].content).ok &&
      !pull1.unsupported.some((u) => u.kind === "connectors"),
      `${pulled.length} connector resource(s) · unsupported=${JSON.stringify(pull1.unsupported.map((u) => u.kind))}`);

    // ------------------------------------------------ 8. idempotent unchanged sync
    const push2 = await pushResources(base44, user, { project_id: project.id, resources: pull1.resources });
    const status = await resourceStatus(base44, user, { project_id: project.id, resources: pull1.resources });
    const versions = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 20);
    h.check("8 re-pushing unchanged resources writes nothing and creates no version",
      push2.created === 0 && push2.updated === 0 && push2.unchanged === pull1.count && !push2.version_created &&
      status.resources.filter((r) => r.kind === "connectors").every((r) => r.state === "identical") &&
      versions.length <= 1,
      `unchanged ${push2.unchanged}/${pull1.count} · versions ${versions.length}`);

    // ------------------------------------------------ 9. build with a valid connector
    const state2 = await loadProjectState(base44, project.id);
    const buildFs = createFs(state2.files);
    writeFile(buildFs, "functions/weatherLookup.js", FN_USES_WEATHER);
    const goodBuild = runBuild(buildFs, [], [{ name: "WEATHER_API_KEY" }]);
    h.check("9 a connector with its runtime projection builds and is callable",
      goodBuild.status === "success" &&
      goodBuild.integrations.some((i) => i.name === "weather" && i.operations === 1),
      `${goodBuild.status} · ${goodBuild.logs.filter((l) => l.startsWith("error:")).slice(0, 2).join(" | ") || "no errors"}`);

    // ------------------------------------------------ 10. build without the runtime projection
    const orphanBuild = runBuild(createFs(state2.files.filter((f) => f.path !== RUNTIME_PATH)), [], []);
    h.check("10 a declared connector without its runtime definition fails the build",
      orphanBuild.status === "failed" && orphanBuild.logs.some((l) => l.includes(RUNTIME_PATH)),
      orphanBuild.logs.find((l) => l.startsWith("error:")) || "no error reported");

    // ------------------------------------------------ 11. duplicate / invalid identity rejection
    const kindMismatch = (() => { try { validateResource({ path: CONN_PATH, kind: "entities", content: docText }); return null; } catch (e) { return e.code; } })();
    await h.expectThrow("11 a malformed connector push is refused", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: CONN_PATH, content: "{ not json" }] }), "RESOURCE_MALFORMED");
    await h.expectThrow("11b an invalid connector path is refused", () => pushResources(base44, user, { project_id: project.id, resources: [{ path: "base44/connectors/Weather.jsonc", content: docText }] }), "RESOURCE_INVALID_PATH");
    h.check("11c a resource declaring the wrong kind is refused",
      kindMismatch === "RESOURCE_KIND_MISMATCH", `code ${kindMismatch}`);

    // ------------------------------------------------ 12. credential boundary
    const withValue = parseConnectorDocument(CONN_PATH, JSON.stringify({ ...WEATHER, auth: { type: "api_key", value: "sk-live-123" } }));
    const withHeaderCred = parseConnectorDocument(CONN_PATH, JSON.stringify({ ...WEATHER, headers: { Authorization: "Bearer abc" } }));
    h.check("12 a connector references credentials by NAME and can never carry a value",
      !withValue.ok && /credential value/.test(withValue.error) &&
      !withHeaderCred.ok &&
      parsed.secret_refs.join(",") === "WEATHER_API_KEY" &&
      !docText.includes("sk-live"),
      `${withValue.error} | ${withHeaderCred.error}`);

    // ------------------------------------------------ 13. rejections left the project untouched
    const afterRejects = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    h.check("13 every refusal applied nothing",
      afterRejects.find((f) => f.path === CONN_PATH)?.content === docText &&
      afterRejects.some((f) => f.path === RUNTIME_PATH),
      "the connector and its projection are exactly what the last accepted push left");

    // ------------------------------------------------ 14. legacy NexusAI integrations
    await svc.entities.ProjectFile.create({ project_id: project.id, path: integrationPath("legacyBilling"), content: serializeIntegration(normalizeIntegration(LEGACY)) });
    const state3 = await loadProjectState(base44, project.id);
    const adoptable = adoptableConnectors(createFs(state3.files));
    const legacyBuild = runBuild(createFs(state3.files), [], [{ name: "WEATHER_API_KEY" }, { name: "LEGACY_BILLING_TOKEN" }]);
    const push3 = await pushResources(base44, user, { project_id: project.id, resources: [{ path: CONN_PATH, content: docText }], kinds: ["connectors"], mode: "full" });
    const afterScoped = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    h.check("14 a legacy integration keeps working, is adoptable and is never pruned",
      adoptable.length === 1 && adoptable[0].name === "legacyBilling" &&
      parseConnectorDocument(adoptable[0].path, adoptable[0].content).ok &&
      legacyBuild.status === "success" && legacyBuild.integrations.some((i) => i.name === "legacyBilling") &&
      push3.removed === 0 && afterScoped.some((f) => f.path === integrationPath("legacyBilling")),
      `adoptable=${adoptable.map((a) => a.name).join(",")} · build ${legacyBuild.status} · removed ${push3.removed}`);

    // ------------------------------------------------ 15. full-sync removal takes the projection
    const removal = await pushResources(base44, user, { project_id: project.id, resources: [], kinds: ["connectors"], mode: "full" });
    const afterRemoval = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 100);
    const finalBuild = runBuild(createFs((await loadProjectState(base44, project.id)).files), [], [{ name: "LEGACY_BILLING_TOKEN" }]);
    h.check("15 removing a connector removes its runtime projection and leaves the project buildable",
      removal.removed === 1 && removal.removed_resources[0].identity === "weather" &&
      !afterRemoval.some((f) => f.path === CONN_PATH) &&
      !afterRemoval.some((f) => f.path === RUNTIME_PATH) &&
      afterRemoval.some((f) => f.path === integrationPath("legacyBilling")) &&
      finalBuild.status === "success",
      `removed ${removal.removed_resources.map((r) => r.identity).join(",") || "none"} · build ${finalBuild.status}`);

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