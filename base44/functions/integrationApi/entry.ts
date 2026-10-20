// #31E — Authorized Integration API.
//
// One authorized backend function exposing the existing integration system through six
// operations: list, get, create, update, disable, test_call. Every operation authorizes the
// caller against the project's workspace SERVER-side (loadAuthorizedProject — the same pattern
// the breaker/rate-limit/quota read surfaces use), so a client can never state a project it
// cannot see. Integration definitions are validated by the EXISTING normalizer, secret
// references are declared (never returned), and `test_call` executes through the EXISTING
// externalTools path (executeProjectFunction → createIntegrationsApi → executeExternalTool),
// so retry, rate-limit, circuit breaker, quota, IntegrationInvocation, tracing and scrubbing
// are all preserved exactly as a generated function experiences them.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import {
  normalizeIntegration, parseIntegrationFile, serializeIntegration,
  integrationPath, isIntegrationPath, integrationNameFromPath, secretRefs, INTEGRATION_NAME_RE, OPERATION_NAME_RE,
} from "../../shared/integrations.ts";
import { packFileContent, unpackFileContent } from "../../shared/blobStore.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";

const svcOf = (b) => b.asServiceRole || b;

// Builder-safe projection of a normalized integration document. The document carries secret
// NAME references only (auth.secret, auth.client_secret) — never values — so this never leaks
// a credential. The raw secret value lives in ProjectSecret and has no route through this API.
function projectIntegration(doc, file) {
  return {
    id: file?.id || null,
    path: file?.path || integrationPath(doc.name),
    name: doc.name,
    type: doc.type,
    description: doc.description || "",
    ...(doc.base_url ? { base_url: doc.base_url } : {}),
    ...(doc.server_url ? { server_url: doc.server_url } : {}),
    auth: doc.auth,
    headers: doc.headers,
    timeout_ms: doc.timeout_ms,
    status: doc.status,
    retry: doc.retry,
    ...(doc.quota ? { quota: doc.quota } : {}),
    operations: doc.operations,
    secret_refs: secretRefs(doc),
    operation_count: doc.operations.length,
    ...(doc.source ? { source: doc.source } : {}),
  };
}

async function loadIntegrationFiles(svc, projectId) {
  const rows = await svc.entities.ProjectFile.filter({ project_id: projectId }, "path", 500);
  return rows.filter((r) => isIntegrationPath(r.path));
}

async function loadIntegration(svc, projectId, name) {
  const rows = await loadIntegrationFiles(svc, projectId);
  const row = rows.find((r) => integrationNameFromPath(r.path) === name);
  if (!row) return null;
  const doc = parseIntegrationFile(row.path, await unpackFileContent(row));
  return { row, doc };
}

// Declares (does not populate) the secret NAME references an integration needs, so the builder
// surfaces them in the Secrets panel. A value the user already set is never touched.
async function declareSecretRefs(svc, projectId, doc) {
  const refs = secretRefs(doc);
  if (!refs.length) return [];
  const existing = await svc.entities.ProjectSecret.filter({ project_id: projectId }, "name", 100);
  const have = new Set(existing.map((s) => s.name));
  const declared = [];
  for (const name of refs) {
    if (!have.has(name)) {
      await svc.entities.ProjectSecret.create({ project_id: projectId, name, value: "", description: `Referenced by integration "${doc.name}"`, required: true, access: "backend_only" });
      declared.push(name);
    }
  }
  return declared;
}

const READ_ACTIONS = new Set(["list", "get", "test_call"]);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    // list/get/test_call are project reads; create/update/disable mutate the integration
    // definition and require integration.manage.
    const capability = READ_ACTIONS.has(action) ? "project.read" : "integration.manage";
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, capability);
    const svc = svcOf(base44);

    if (action === "list") {
      const rows = await loadIntegrationFiles(svc, project.id);
      const integrations = [];
      for (const row of rows) {
        try { integrations.push(projectIntegration(parseIntegrationFile(row.path, await unpackFileContent(row)), row)); }
        catch (e) { integrations.push({ id: row.id, path: row.path, name: integrationNameFromPath(row.path), error: e.message }); }
      }
      return Response.json({ integrations });
    }

    if (action === "get") {
      const name = String(body.name || "");
      if (!INTEGRATION_NAME_RE.test(name)) return Response.json({ error: "Invalid integration name" }, { status: 400 });
      const loaded = await loadIntegration(svc, project.id, name);
      if (!loaded) return Response.json({ error: `Integration "${name}" not found` }, { status: 404 });
      return Response.json({ integration: projectIntegration(loaded.doc, loaded.row) });
    }

    if (action === "create" || action === "update") {
      let doc;
      try { doc = normalizeIntegration(body.definition || {}); }
      catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
      const path = integrationPath(doc.name);
      const rows = await svc.entities.ProjectFile.filter({ project_id: project.id, path }, "path", 1);
      const existing = rows[0];
      if (action === "create" && existing) return Response.json({ error: `Integration "${doc.name}" already exists` }, { status: 409 });
      if (action === "update" && !existing) return Response.json({ error: `Integration "${doc.name}" not found` }, { status: 404 });
      const stored = await packFileContent(svc, path, serializeIntegration(doc));
      if (existing) await svc.entities.ProjectFile.update(existing.id, stored);
      else await svc.entities.ProjectFile.create({ project_id: project.id, path, ...stored, frozen: false });
      const declared = await declareSecretRefs(svc, project.id, doc);
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: `integration.${action}`, resource: "ProjectFile", resource_id: existing?.id || null, metadata: { name: doc.name, path, declared_secrets: declared } });
      const fresh = await loadIntegration(svc, project.id, doc.name);
      return Response.json({ integration: projectIntegration(fresh.doc, fresh.row) });
    }

    if (action === "disable") {
      const name = String(body.name || "");
      if (!INTEGRATION_NAME_RE.test(name)) return Response.json({ error: "Invalid integration name" }, { status: 400 });
      const loaded = await loadIntegration(svc, project.id, name);
      if (!loaded) return Response.json({ error: `Integration "${name}" not found` }, { status: 404 });
      const doc = { ...loaded.doc, status: "disabled" };
      const stored = await packFileContent(svc, loaded.row.path, serializeIntegration(doc));
      await svc.entities.ProjectFile.update(loaded.row.id, stored);
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "integration.disable", resource: "ProjectFile", resource_id: loaded.row.id, metadata: { name } });
      return Response.json({ integration: projectIntegration(doc, loaded.row) });
    }

    if (action === "test_call") {
      const name = String(body.name || "");
      if (!INTEGRATION_NAME_RE.test(name)) return Response.json({ error: "Invalid integration name" }, { status: 400 });
      const op = String(body.operation || "");
      if (!OPERATION_NAME_RE.test(op)) return Response.json({ error: "Invalid operation name" }, { status: 400 });
      const loaded = await loadIntegration(svc, project.id, name);
      if (!loaded) return Response.json({ error: `Integration "${name}" not found` }, { status: 404 });
      if (loaded.doc.status === "disabled") return Response.json({ error: `Integration "${name}" is disabled`, code: "INTEGRATION_DISABLED" }, { status: 409 });
      if (!loaded.doc.operations.some((o) => o.name === op)) return Response.json({ error: `Operation "${op}" not found on integration "${name}"` }, { status: 404 });
      const args = body.args && typeof body.args === "object" ? body.args : {};
      const argsJson = JSON.stringify(args).slice(0, 10000);
      // A generated function that calls the integration through the REAL ctx.integrations path.
      // This is the same path a backend function takes, so breaker/quota/rate-limit/observer/tracing
      // all apply. The function name is metadata only (no file is created); trigger "test" skips
      // the method check and marks the FunctionInvocation as a test.
      const source = `export const config = { method: 'POST' };\n` +
        `export default async function handler(ctx) {\n` +
        `  try {\n` +
        `    const r = await ctx.integrations.${name}.${op}(${argsJson});\n` +
        `    const preview = typeof r.body === "string" ? r.body.slice(0, 1000) : JSON.stringify(r.body ?? null).slice(0, 1000);\n` +
        `    return { status: 200, body: { ok: true, status: r.status, attempts: r.attempts, preview } };\n` +
        `  } catch (e) {\n` +
        `    const d = e.details || {};\n` +
        `    return { status: 200, body: { ok: false, code: e.code, kind: d.kind, status: d.status ?? 0, attempts: d.attempts ?? 0, message: e.message, quota: d.quota, breaker: d.breaker, rate_limit: d.rate_limit } };\n` +
        `  }\n}\n`;
      const trace_id = `t_it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const result = await executeProjectFunction(svc, {
        project, entities: [], integrations: [loaded.doc], name: "integrationTest", source, trigger: "test",
        requestId: crypto.randomUUID(),
        request: { method: "POST", query: {}, headers: {}, body: {} },
        messagingTransport: "test", trace_id, quotas: { timeoutMs: 20000 },
      });
      return Response.json({ result: result.body, invocation_id: result.invocation_id, trace_id });
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status || 500 });
  }
}