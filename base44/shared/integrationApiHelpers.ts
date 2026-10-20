// Shared inline executor for the authorized Integration API (#31E).
//
// Function-to-function imports are not permitted from this runtime, so certification suites that
// need to exercise the endpoint's exact path execute it INLINE: the SAME loadAuthorizedProject
// gate, the SAME validation/normalization (normalizeIntegration), the SAME file persistence
// (packFileContent + ProjectFile), the SAME test_call execution (executeProjectFunction → the
// externalTools path) and the SAME audit writes the endpoint performs, in the same order.
//
// This module is that inline path, factored once so #31E and #31F share a single implementation
// rather than two copies. It is a plain module — no Deno.serve — and never holds a credential.
import { loadAuthorizedProject, audit } from "./authz.ts";
import {
  normalizeIntegration, parseIntegrationFile, serializeIntegration,
  integrationPath, isIntegrationPath, integrationNameFromPath, secretRefs, INTEGRATION_NAME_RE, OPERATION_NAME_RE,
} from "./integrations.ts";
import { packFileContent, unpackFileContent } from "./blobStore.ts";
import { executeProjectFunction } from "./functionRuntime.ts";

export const svcOf = (b) => b.asServiceRole || b;

export const mockJson = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// Builder-safe projection of a normalized integration document. Secret NAME refs only — never
// values. This is exactly what the endpoint returns and what the Builder pane renders.
export function projectIntegration(doc, file) {
  return {
    id: file?.id || null, path: file?.path || integrationPath(doc.name), name: doc.name, type: doc.type,
    description: doc.description || "",
    ...(doc.base_url ? { base_url: doc.base_url } : {}),
    ...(doc.server_url ? { server_url: doc.server_url } : {}),
    auth: doc.auth, headers: doc.headers, timeout_ms: doc.timeout_ms, status: doc.status, retry: doc.retry,
    ...(doc.quota ? { quota: doc.quota } : {}),
    operations: doc.operations, secret_refs: secretRefs(doc), operation_count: doc.operations.length,
    ...(doc.source ? { source: doc.source } : {}),
  };
}

export async function loadIntegrationFiles(svc, projectId) {
  const rows = await svc.entities.ProjectFile.filter({ project_id: projectId }, "path", 500);
  return rows.filter((r) => isIntegrationPath(r.path));
}

export async function loadIntegration(svc, projectId, name) {
  const rows = await loadIntegrationFiles(svc, projectId);
  const row = rows.find((r) => integrationNameFromPath(r.path) === name);
  if (!row) return null;
  return { row, doc: parseIntegrationFile(row.path, await unpackFileContent(row)) };
}

// Declares (does not populate) the secret NAME references an integration needs.
export async function declareSecretRefs(svc, projectId, doc) {
  for (const name of secretRefs(doc)) {
    const existing = await svc.entities.ProjectSecret.filter({ project_id: projectId, name }, "name", 1);
    if (!existing[0]) await svc.entities.ProjectSecret.create({ project_id: projectId, name, value: "", description: `Referenced by integration "${doc.name}"`, required: true, access: "backend_only" });
  }
}

// Builds the inline `api(user, payload)` dispatcher — the endpoint's exact path. `base44` is the
// user client (for authorization); `svc` is the service role (for file/secret/audit writes).
export function makeInlineIntegrationApi(base44, svc) {
  return async function api(user, payload) {
    try {
      const action = String(payload.action || "list");
      const cap = ["list", "get", "test_call"].includes(action) ? "project.read" : "integration.manage";
      const { project: proj, workspace: ws } = await loadAuthorizedProject(base44, user, payload.project_id, cap);
      if (action === "list") {
        const rows = await loadIntegrationFiles(svc, proj.id);
        const integrations = [];
        for (const row of rows) {
          try { integrations.push(projectIntegration(parseIntegrationFile(row.path, await unpackFileContent(row)), row)); }
          catch (e) { integrations.push({ id: row.id, path: row.path, name: integrationNameFromPath(row.path), error: e.message }); }
        }
        return { status: 200, body: { integrations } };
      }
      if (action === "get") {
        if (!INTEGRATION_NAME_RE.test(String(payload.name || ""))) return { status: 400, body: { error: "Invalid integration name" } };
        const loaded = await loadIntegration(svc, proj.id, payload.name);
        if (!loaded) return { status: 404, body: { error: `Integration "${payload.name}" not found` } };
        return { status: 200, body: { integration: projectIntegration(loaded.doc, loaded.row) } };
      }
      if (action === "create" || action === "update") {
        let doc; try { doc = normalizeIntegration(payload.definition || {}); } catch (e) { return { status: 400, body: { error: e.message } }; }
        const path = integrationPath(doc.name);
        const rows = await svc.entities.ProjectFile.filter({ project_id: proj.id, path }, "path", 1);
        const existing = rows[0];
        if (action === "create" && existing) return { status: 409, body: { error: `Integration "${doc.name}" already exists` } };
        if (action === "update" && !existing) return { status: 404, body: { error: `Integration "${doc.name}" not found` } };
        const stored = await packFileContent(svc, path, serializeIntegration(doc));
        if (existing) await svc.entities.ProjectFile.update(existing.id, stored);
        else await svc.entities.ProjectFile.create({ project_id: proj.id, path, ...stored, frozen: false });
        await declareSecretRefs(svc, proj.id, doc);
        await audit(svc, { workspace_id: ws.id, project_id: proj.id, user_id: user.id, action: `integration.${action}`, resource: "ProjectFile", resource_id: existing?.id || null, metadata: { name: doc.name, path } });
        const fresh = await loadIntegration(svc, proj.id, doc.name);
        return { status: 200, body: { integration: projectIntegration(fresh.doc, fresh.row) } };
      }
      if (action === "disable") {
        if (!INTEGRATION_NAME_RE.test(String(payload.name || ""))) return { status: 400, body: { error: "Invalid integration name" } };
        const loaded = await loadIntegration(svc, proj.id, payload.name);
        if (!loaded) return { status: 404, body: { error: `Integration "${payload.name}" not found` } };
        const doc = { ...loaded.doc, status: "disabled" };
        await svc.entities.ProjectFile.update(loaded.row.id, await packFileContent(svc, loaded.row.path, serializeIntegration(doc)));
        await audit(svc, { workspace_id: ws.id, project_id: proj.id, user_id: user.id, action: "integration.disable", resource: "ProjectFile", resource_id: loaded.row.id, metadata: { name: payload.name } });
        return { status: 200, body: { integration: projectIntegration(doc, loaded.row) } };
      }
      if (action === "test_call") {
        const name = String(payload.name || ""); const op = String(payload.operation || "");
        if (!INTEGRATION_NAME_RE.test(name)) return { status: 400, body: { error: "Invalid integration name" } };
        if (!OPERATION_NAME_RE.test(op)) return { status: 400, body: { error: "Invalid operation name" } };
        const loaded = await loadIntegration(svc, proj.id, name);
        if (!loaded) return { status: 404, body: { error: `Integration "${name}" not found` } };
        if (loaded.doc.status === "disabled") return { status: 409, body: { error: `Integration "${name}" is disabled`, code: "INTEGRATION_DISABLED" } };
        if (!loaded.doc.operations.some((o) => o.name === op)) return { status: 404, body: { error: `Operation "${op}" not found` } };
        const args = payload.args && typeof payload.args === "object" ? payload.args : {};
        const argsJson = JSON.stringify(args).slice(0, 10000);
        const source = `export const config = { method: 'POST' };\nexport default async function handler(ctx) {\n  try {\n    const r = await ctx.integrations.${name}.${op}(${argsJson});\n    const preview = typeof r.body === "string" ? r.body.slice(0, 1000) : JSON.stringify(r.body ?? null).slice(0, 1000);\n    return { status: 200, body: { ok: true, status: r.status, attempts: r.attempts, preview } };\n  } catch (e) {\n    const d = e.details || {};\n    return { status: 200, body: { ok: false, code: e.code, kind: d.kind, status: d.status ?? 0, attempts: d.attempts ?? 0, message: e.message, quota: d.quota, breaker: d.breaker, rate_limit: d.rate_limit } };\n  }\n}\n`;
        const trace_id = `t_it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const result = await executeProjectFunction(svc, {
          project: proj, entities: [], integrations: [loaded.doc], name: "integrationTest", source, trigger: "test",
          requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: {} },
          messagingTransport: "test", trace_id, quotas: { timeoutMs: 20000 },
        });
        return { status: 200, body: { result: result.body, invocation_id: result.invocation_id, trace_id } };
      }
      return { status: 400, body: { error: `Unknown action '${action}'` } };
    } catch (e) {
      return { status: e.status || 500, body: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
    }
  };
}