// #31 Connector Layer — LIFECYCLE certification.
//
// E12 already certifies resource → validate → persist → sync → build. This suite certifies the
// REMAINING half of the lifecycle against the REAL modules, with nothing stubbed and no second
// runtime, validator, credential store, permission system or sync created here:
//
//   artifact projection .. shared/deploy.ts buildArtifact (the ONE artifact builder)
//   deployment ........... shared/deploy.ts verifyDeployment (the ONE verification pass)
//   runtime resolution ... shared/functionRuntime.ts executeProjectFunction (the ONE sandbox)
//   credentials .......... ProjectSecret + shared/secretCrypto.ts (the ONE credential store)
//   SDK surface .......... shared/sdkDiscovery.ts (read-only projection of the artifact)
//   authorization ........ shared/authz.ts through shared/resourceSync.ts (the ONE authz path)
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs } from "../../shared/projectFs.ts";
import { createVersion } from "../../shared/persistence.ts";
import { buildArtifact, verifyDeployment, loadArtifactPayload, ensureProjectSlug } from "../../shared/deploy.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { handleConnectorsRuntime } from "../../shared/sdkDiscovery.ts";
import { encryptSecretValue } from "../../shared/secretCrypto.ts";
import { loadProjectState, secretMetadata } from "../../shared/authz.ts";
import { pushResources } from "../../shared/resourceSync.ts";
import {
  connectorFilePath, connectorRuntimePath, connectorDocumentContent, parseConnectorDocument, resolveConnector,
} from "../../shared/connectorResource.ts";
import { parseIntegrationFile, serializeIntegration, normalizeIntegration, integrationPath } from "../../shared/integrations.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const APP = `import { html } from 'runtime';
export default function App() {
  return html\`<div class="page"><h1 class="card-title">Connector layer</h1></div>\`;
}
`;
const STYLES = ".page { display: block; }\n.card-title { font-weight: 600; }\n";

const WEATHER = {
  type: "http",
  description: "Forecast lookup",
  base_url: "https://api.weather.example",
  auth: { type: "api_key", secret: "WEATHER_API_KEY", in: "header", header_name: "X-API-Key" },
  operations: [{ name: "getForecast", method: "GET", path: "/forecast/{city}", description: "Forecast by city" }],
};
const LEGACY = {
  name: "legacyBilling", type: "http", base_url: "https://api.billing.example",
  auth: { type: "bearer", secret: "LEGACY_BILLING_TOKEN" },
  operations: [{ name: "listInvoices", method: "GET", path: "/invoices" }],
};

// The SHIPPED function: resolves the deployed connector and proves the sandbox cannot read its
// credential. It makes no outbound request and no invalid call, so the build accepts it.
const RUNTIME_FN = `export const config = { method: "ANY", secrets: [] };
export default async function (ctx) {
  const out = {
    connectors: Object.keys(ctx.integrations).sort(),
    operations: Object.keys(ctx.integrations.weather || {}).sort(),
    auth_in_surface: Object.keys(ctx.integrations.weather || {}).includes("auth"),
  };
  try { ctx.secrets.get(["WEATHER", "API_KEY"].join("_")); out.secret_readable = true; }
  catch (e) { out.secret_readable = false; out.secret_refusal = e.message; }
  return { body: out };
}
`;
// A probe executed directly in the runtime (never shipped): the build engine refuses these calls
// statically, so the runtime refusal is certified without weakening the build's own gate.
const PROBE_FN = `export const config = { method: "ANY", secrets: [] };
export default async function (ctx) {
  const out = {};
  try { await ctx.integrations.weather.nope({}); out.bad_operation = null; }
  catch (e) { out.bad_operation = e.code || e.message; }
  try { await ctx.integrations.ghost.doThing({}); out.unknown_connector = null; }
  catch (e) { out.unknown_connector = e.code || e.message; }
  return { body: out };
}
`;

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  const CONN_PATH = connectorFilePath("weather");
  const RUNTIME_PATH = connectorRuntimePath("weather");
  const docText = connectorDocumentContent({ ...WEATHER, name: "weather" });
  const canonical = serializeIntegration(normalizeIntegration({ ...WEATHER, name: "weather" }));

  const verify = (project, artifact) => verifyDeployment(svc, {
    project, artifact, deployment: { environment: "production", version_id: artifact.version_id },
  });

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `connlayer-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);

    const mkProject = async (name, files) => {
      const project = await svc.entities.Project.create({ workspace_id: ws.id, name, framework: "preact-htm", status: "draft", version_count: 0 });
      created.projects.push(project.id);
      await ensureProjectSlug(svc, project);
      const fs = createFs([]);
      for (const [path, content] of Object.entries(files)) fs.files.set(path, { id: null, path, content, original: null });
      const version = await createVersion(svc, { project, fs, entities: [], secrets: [], message: name, changedFiles: [] });
      return { project: await svc.entities.Project.get(project.id), version };
    };

    const base = { "src/main.js": MAIN, "src/App.js": APP, "styles.css": STYLES, "functions/weatherLookup.js": RUNTIME_FN };

    // ------------------------------------------------ 1. declaration + identity validation
    const good = parseConnectorDocument(CONN_PATH, docText);
    const badIdentity = parseConnectorDocument("base44/connectors/Weather.jsonc", docText);
    const badDeclared = parseConnectorDocument(CONN_PATH, JSON.stringify({ ...WEATHER, name: "other" }));
    const badJson = parseConnectorDocument(CONN_PATH, "{ not json");
    const withValue = parseConnectorDocument(CONN_PATH, JSON.stringify({ ...WEATHER, auth: { type: "api_key", value: "sk-live-abc" } }));
    h.check("1 a valid connector is accepted and every invalid identity or shape is refused",
      good.ok && good.connector.name === "weather" && good.secret_refs.join(",") === "WEATHER_API_KEY" &&
      !badIdentity.ok && /canonical connector path/.test(badIdentity.error) &&
      !badDeclared.ok && /file name/.test(badDeclared.error) &&
      !badJson.ok && /valid JSONC/.test(badJson.error) &&
      !withValue.ok && /credential value/.test(withValue.error),
      `${badIdentity.error} | ${badDeclared.error} | ${withValue.error}`);

    // ------------------------------------------------ 2. persistence + sync round-trip
    const { project, version } = await mkProject("connector-lifecycle", { ...base, [CONN_PATH]: docText, [RUNTIME_PATH]: canonical });
    const push = await pushResources(base44, user, { project_id: project.id, resources: [{ path: CONN_PATH, content: docText }] });
    const state = await loadProjectState(base44, project.id);
    const stored = state.files.find((f) => f.path === RUNTIME_PATH);
    h.check("2 a connector persists, loads and materializes its runtime definition",
      push.ok && resolveConnector(state.files, "weather")?.base_url === WEATHER.base_url &&
      !!stored && stored.content === canonical && parseIntegrationFile(RUNTIME_PATH, stored.content).name === "weather" &&
      push.created + push.unchanged + push.updated === 1,
      `push ok=${push.ok} created=${push.created} unchanged=${push.unchanged}`);

    // The credential lives in the ONE credential store, sealed to this project + name.
    await svc.entities.ProjectSecret.create({
      project_id: project.id, name: "WEATHER_API_KEY", value: await encryptSecretValue(project.id, "WEATHER_API_KEY", "sk-live-connector-secret"),
      description: "", required: true, access: "backend_only",
    });

    // ------------------------------------------------ 3. artifact projection
    const built = await buildArtifact(svc, { project, version, userId: user.id });
    h.check("3 a project declaring a connector builds an artifact",
      built.ok === true, built.ok ? built.artifact.checksum : JSON.stringify(built.diagnostics || built.code));
    const payload = built.ok ? await loadArtifactPayload(built.artifact) : { connectors: [], integrations: [], client_files: [] };
    const shippedConnector = (payload.connectors || [])[0];
    const shippedIntegration = (payload.integrations || []).find((i) => i.name === "weather");
    h.check("4 the artifact ships the declaration and its runtime definition, and the client bundle ships neither",
      (payload.connectors || []).length === 1 && shippedConnector.name === "weather" &&
      !!shippedIntegration && serializeIntegration(normalizeIntegration(shippedIntegration)) === canonical &&
      built.artifact.integration_names.includes("weather") && built.artifact.secret_names.includes("WEATHER_API_KEY") &&
      !payload.client_files.some((f) => f.path === CONN_PATH || f.path === RUNTIME_PATH) &&
      !payload.client_files.some((f) => f.content.includes("api.weather.example")),
      `${(payload.connectors || []).length} connector(s) · ${payload.client_files.length} client file(s)`);
    h.check("5 no credential VALUE travels in the artifact, only its name",
      !JSON.stringify(payload).includes("sk-live-connector-secret") &&
      shippedIntegration.auth.secret === "WEATHER_API_KEY" && !("value" in shippedIntegration.auth) &&
      secretMetadata(await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 10)).every((s) => !("value" in s) && s.is_set === true),
      "the artifact and every secret read path carry names and set-state only");

    // ------------------------------------------------ 4. deployment integration
    const verified = built.ok ? await verify(project, built.artifact) : { ok: false, checks: [] };
    h.check("6 a connector deployment verifies green",
      verified.ok === true && verified.checks.find((c) => c.name === "secrets_available")?.ok === true,
      verified.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(" | ") || "all deployment checks pass");

    // ------------------------------------------------ 5. preview / production parity
    const previewIntegration = parseIntegrationFile(RUNTIME_PATH, stored.content);
    h.check("7 preview and production resolve byte-identical connector definitions",
      serializeIntegration(normalizeIntegration(previewIntegration)) === serializeIntegration(normalizeIntegration(shippedIntegration)) &&
      connectorDocumentContent(shippedConnector) === docText,
      "the project's own definition, the shipped definition and the re-emitted document all agree");

    // ------------------------------------------------ 6. runtime resolution + credential isolation
    const exec = await executeProjectFunction(svc, {
      project, entities: [], name: "weatherLookup", source: RUNTIME_FN,
      request: { method: "POST", query: {}, body: {}, headers: {} },
      trigger: "test", requestId: `conn-${Date.now()}`, integrations: [shippedIntegration], user: null,
      messagingTransport: "test",
    });
    const probe = await executeProjectFunction(svc, {
      project, entities: [], name: "connectorProbe", source: PROBE_FN,
      request: { method: "POST", query: {}, body: {}, headers: {} },
      trigger: "test", requestId: `conn-probe-${Date.now()}`, integrations: [shippedIntegration], user: null,
      messagingTransport: "test",
    });
    const body = { ...(exec.body || {}), ...(probe.body || {}) };
    h.check("8 the deployed connector resolves in the backend runtime",
      exec.status === 200 && body.connectors.includes("weather") && body.operations.includes("getForecast"),
      `status ${exec.status} · ${JSON.stringify(body).slice(0, 180)}`);
    h.check("9 unauthorized connector use is refused deterministically",
      !!body.bad_operation && /nope|operation/i.test(String(body.bad_operation)) &&
      !!body.unknown_connector && /ghost|integration|undefined/i.test(String(body.unknown_connector)),
      `bad operation: ${body.bad_operation} · unknown connector: ${body.unknown_connector}`);
    h.check("10 the sandbox can never read the connector's credential",
      body.secret_readable === false && /not declared/.test(String(body.secret_refusal)) &&
      body.auth_in_surface === false && body.operations.join(",") === "getForecast" &&
      !JSON.stringify(exec).includes("sk-live-connector-secret"),
      `${body.secret_refusal} · nothing in the response or logs carries the value`);

    // ------------------------------------------------ 7. SDK surface
    const list = await handleConnectorsRuntime(svc, { project, payload, op: "list" });
    const described = await handleConnectorsRuntime(svc, { project, payload, op: "describe", args: { name: "weather" } });
    const rlsProject = { ...project, rls_enabled: true };
    h.check("11 the SDK connector surface exposes operations only, never credentials",
      list.count === 1 && list.connectors[0].name === "weather" && !("auth" in list.connectors[0]) &&
      described.operations[0].name === "getForecast" && !("auth" in described) && !("base_url" in described) &&
      !JSON.stringify([list, described]).includes("WEATHER_API_KEY"),
      JSON.stringify(described));
    const sdkErrors = [];
    for (const call of [
      () => handleConnectorsRuntime(svc, { project, payload, op: "invoke" }),
      () => handleConnectorsRuntime(svc, { project, payload, op: "describe", args: { name: "ghost" } }),
      () => handleConnectorsRuntime(svc, { project: rlsProject, payload, op: "describe", args: { name: "weather" }, user: null }),
    ]) { try { await call(); sdkErrors.push("no error"); } catch (e) { sdkErrors.push(`${e.code}/${e.status}`); } }
    h.check("12 the SDK refuses execution, unknown connectors and unidentified callers",
      sdkErrors[0] === "CONNECTORS_BAD_OPERATION/400" && sdkErrors[1] === "CONNECTOR_NOT_FOUND/404" &&
      sdkErrors[2] === "CONNECTOR_AUTH_REQUIRED/401", sdkErrors.join(" · "));

    // ------------------------------------------------ 8. authorization + project isolation
    const foreignWs = await svc.entities.Workspace.create({ name: `connlayer-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(foreignWs.id);
    const foreign = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "foreign-connectors", framework: "preact-htm", status: "draft" });
    created.projects.push(foreign.id);
    await h.expectThrow("13 pushing a connector into another workspace's project is refused",
      () => pushResources(base44, user, { project_id: foreign.id, resources: [{ path: CONN_PATH, content: docText }] }), "NOT_A_MEMBER");

    const legacy = await mkProject("legacy-connectors", { ...base, "functions/weatherLookup.js": RUNTIME_FN.replace("weather", "weather"), [integrationPath("legacyBilling")]: serializeIntegration(normalizeIntegration(LEGACY)) });
    const legacyBuilt = await buildArtifact(svc, { project: legacy.project, version: legacy.version, userId: user.id });
    const legacyPayload = legacyBuilt.ok ? await loadArtifactPayload(legacyBuilt.artifact) : {};
    h.check("14 a connector stays bound to its own project and version",
      payload.config.project_id === project.id && built.artifact.version_id === version.id &&
      !(legacyPayload.connectors || []).some((c) => c.name === "weather") &&
      !(legacyPayload.integrations || []).some((i) => i.name === "weather") &&
      resolveConnector((await loadProjectState(base44, legacy.project.id)).files, "weather") === null &&
      (await handleConnectorsRuntime(svc, { project: legacy.project, payload: legacyPayload, op: "list" })).connectors.every((c) => c.name !== "weather") &&
      (await verify(legacy.project, built.artifact)).checks.find((c) => c.name === "routing_correct")?.ok === false,
      "another project neither declares, ships, resolves nor may verify this connector");

    // ------------------------------------------------ 9. legacy compatibility
    h.check("15 a legacy integration with no connector document still builds, ships and runs",
      legacyBuilt.ok === true &&
      (legacyPayload.integrations || []).some((i) => i.name === "legacyBilling") &&
      !("connectors" in legacyPayload) &&
      (await handleConnectorsRuntime(svc, { project: legacy.project, payload: legacyPayload, op: "list" })).count === 0,
      legacyBuilt.ok ? `${(legacyPayload.integrations || []).length} integration(s), 0 declared connectors` : JSON.stringify(legacyBuilt.diagnostics || legacyBuilt.code));

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["IntegrationInvocation", "FunctionInvocation", "TraceEvent", "AuditLog", "Deployment", "DeploymentArtifact", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["AuditLog", "TraceEvent", "WorkspaceMember", "Project"]);
    }
  }
}