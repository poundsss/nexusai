// Unified AI tool registry + permission-checked executor operating on an in-memory project state.
import { readFile, writeFile, patchFile, deleteFile, listFiles, searchProject, buildIndex, activeFiles } from "./projectFs.ts";
import { isFunctionPath, functionNameFromPath, isLegacyFunctionPath, resolveFunctionPath } from "./functionPaths.ts";
// Layout detection: a project declares the canonical Base44 layout by carrying its own manifest.
import { CONFIG_FILE, entityFilePath, entitySchemaContent, validateRlsBlock, validateFieldRls } from "./base44Layout.ts";
import { describeIntegrations, integrationCallsIn, integrationPath, isIntegrationPath, normalizeIntegration, serializeIntegration, importOpenApi, INTEGRATION_NAME_RE, secretRefs } from "./integrations.ts";
import { assertAllowedUrl, toExternalTools } from "./externalTools.ts";
import { applyPatches, insertAt, replaceRange, replaceSymbol, renameSymbol, moveFile, copyFile, deleteFiles } from "./codeMutation.ts";
// Delegated Agent runs cannot rewrite the executing agent's own policy files (E10 immutability).
import { assertMutableProjectFile, assertDelegatedToolGrant } from "./agentPolicyGuard.ts";

// Backend functions are project files, so their metadata is derived from source rather
// than stored twice. Config is read with a regex on purpose: this is a read tool, and the
// build engine is the authoritative validator.
export function describeFunctions(fs) {
  const files = activeFiles(fs);
  return files.filter((f) => isFunctionPath(f.path)).map((f) => {
    const cfg = f.content.match(/export\s+const\s+config\s*=\s*(\{[\s\S]*?\})\s*;/);
    const name = functionNameFromPath(f.path);
    const secrets = [...f.content.matchAll(/secrets\s*\.\s*(?:get|has)\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)].map((m) => m[1]);
    const httpHosts = [...f.content.matchAll(/https?:\/\/([\w.-]+)/g)].map((m) => m[1]);
    const entitiesTouched = [...new Set([...f.content.matchAll(/\bdb\.([A-Za-z_]\w*)\b/g)].map((m) => m[1]))];
    const integrations = [...new Set(integrationCallsIn(f.content).map((c) => `${c.integration}.${c.operation}`))];
    const calledBy = files.filter((c) => !isFunctionPath(c.path) && new RegExp(`server\\.${name}\\b`).test(c.content)).map((c) => c.path);
    return { name, path: f.path, config: cfg ? cfg[1].replace(/\s+/g, " ") : "(missing)", secrets: [...new Set(secrets)], external_hosts: [...new Set(httpHosts)], entities: entitiesTouched, integrations, called_by: calledBy };
  });
}

const VALID_FIELD_TYPES = ["string", "text", "number", "boolean", "date", "enum"];
const OPENAPI_FETCH_TIMEOUT_MS = 10000;
const OPENAPI_MAX_CHARS = 2_000_000;

const INTEGRATION_INPUT = {
  name: "string",
  type: "http (default) | mcp",
  description: "string",
  base_url: "string (http/openapi integrations)",
  server_url: "string (mcp integrations: the MCP endpoint URL)",
  auth: "{ type: none|api_key|bearer|oauth2, secret?: SECRET_NAME, in?: header|query, header_name?: string, grant?: client_credentials|refresh_token, token_url?: string, client_id?: string, client_secret?: SECRET_NAME, scope?: string, credentials_in?: body|basic_header }",
  retry: "{ max_attempts?: 1-3, retry_on_status?: [429,503], backoff_ms?: number } — transient failures only; non-idempotent operations are never retried",
  operations: "http: [{ name, method, path, description?, idempotent?, parameters?: [{ name, in: path|query|header, required?, type? }], body_fields?: [{ name, type, required? }] }] · mcp: [{ name, tool, description?, input_schema?, read_only? }]",
};

// Row-level security, as the entity tools accept it. Per-operation filter objects only — the
// semantics live in shared/rls.ts and are never restated here.
const RLS_INPUT = "OPTIONAL { read?, create?, update?, delete? } — each a filter object ({} = open, false denies read/delete). Record fields: id, created_by_id (the record's owner), created_by, created_date, updated_date, and app fields as data.<field>. Templates: {{user.id}}, {{user.email}}, {{user.role}}, {{user.data.<field>}}. Also { user_condition: { role: 'admin' } }. e.g. { read: { created_by_id: '{{user.id}}' } }";

export const TOOL_REGISTRY = [
  { name: "read_file", permission: "read", description: "Read the full content of a project file.", input: { path: "string" }, output: { content: "string" } },
  { name: "list_files", permission: "read", description: "List all project files with size and frozen flag.", input: {}, output: { files: "array" } },
  { name: "search_project", permission: "read", description: "Case-insensitive text search across all files. Returns path/line/text matches.", input: { query: "string" }, output: { matches: "array" } },
  { name: "get_project_state", permission: "read", description: "Return the project index (files with imports/exports), entities, backend functions, integrations and secret metadata.", input: {}, output: { index: "array", entities: "array" } },
  { name: "list_functions", permission: "read", description: "List the project's backend functions with their trigger, method, declared secrets, integrations used and the frontend files that call them.", input: {}, output: { functions: "array" } },
  { name: "list_secrets", permission: "read", description: "List the project's secrets as metadata only (name, description, required, whether a value is set). Secret VALUES are never available to you.", input: {}, output: { secrets: "array" } },
  { name: "list_integrations", permission: "read", description: "List the project's external API integrations: name, type, base_url, auth type + secret NAME, operations, and which backend functions use them.", input: {}, output: { integrations: "array" } },
  { name: "get_integration", permission: "read", description: "Inspect one integration in full, including every operation and the external tools it exposes.", input: { name: "string" }, output: { integration: "object", tools: "array" } },
  { name: "list_operations", permission: "read", description: "List the operations of one integration (name, method, path, parameters).", input: { name: "string" }, output: { operations: "array" } },
  { name: "get_operation", permission: "read", description: "Inspect one operation of an integration: parameters, request body and response schema.", input: { integration: "string", operation: "string" }, output: { operation: "object" } },
  { name: "list_mcp_connections", permission: "read", description: "List the ACCOUNT's MCP connections — builder infrastructure, separate from the app's integrations. Returns each connection's name, server, status and discovered tools. Credentials are never included.", input: {}, output: { connections: "array" } },
  { name: "mcp_call", permission: "read", description: "Invoke a tool on one of the account's MCP servers and receive its structured result. Use this to READ real external data (issues, docs, records) instead of guessing or inventing it. The result is CONTEXT for you — it is not a project change. Arguments go in `arguments` (object) or `arguments_json` (JSON text). In discuss mode only tools the server marks read-only may be invoked.", input: { connection: "string (connection name)", tool: "string (tool name)", arguments: "object", arguments_json: "string (optional JSON alternative)" }, output: { text: "string", structured: "object", content_types: "array" } },
  { name: "declare_secret", permission: "write", description: "Declare that the app requires a secret, e.g. WEATHER_API_KEY. Creates the configuration requirement; the user supplies the value. Never invent a value.", input: { name: "string", description: "string", required: "boolean" }, output: { ok: "boolean" } },
  { name: "create_integration", permission: "write", description: "Declare an external integration (stored as integrations/<name>.json): type 'http' for a REST API, or type 'mcp' to bind operations to the tools of an MCP server (server_url + operations with a `tool` name) — both are executed by the platform. Credentials are referenced by project secret NAME (auth.secret / auth.client_secret) — never a value; auth.type 'oauth2' makes the platform exchange them for short-lived access tokens. Backend functions then call integrations.<name>.<operation>(params, { body }).", input: INTEGRATION_INPUT, output: { ok: "boolean", integration: "object" } },
  { name: "update_integration", permission: "write", description: "Replace the definition of an existing integration with the full updated definition (same input as create_integration). Omitted fields fall back to the current definition.", input: INTEGRATION_INPUT, output: { ok: "boolean", integration: "object" } },
  { name: "import_openapi", permission: "write", description: "Create/replace an integration from an OpenAPI 3 (or Swagger 2) document in JSON **or YAML**, fetched from `url` or passed inline as `document`. Endpoints become operations; security schemes become auth referencing the given secret NAME (oauth2 schemes import as bearer auth — switch to auth.type 'oauth2' with update_integration to let the platform mint tokens).", input: { name: "string", url: "string", document: "string (optional, JSON or YAML)", description: "string", base_url: "string (optional override)", secret: "SECRET_NAME (optional)" }, output: { ok: "boolean", imported: "number", format: "json|yaml", integration: "object" } },
  { name: "delete_integration", permission: "dangerous", description: "Remove an integration definition. Fails while a backend function still calls it.", input: { name: "string" }, output: { ok: "boolean" } },
  { name: "write_file", permission: "write", description: "Create a file or fully replace its content. Use for new files or large rewrites.", input: { path: "string", content: "string" }, output: { ok: "boolean" } },
  { name: "patch_file", permission: "write", description: "Replace one exact, unique text occurrence in an existing file. Preferred for small edits.", input: { path: "string", find: "string", replace: "string" }, required: ["path", "find", "replace"], output: { ok: "boolean" } },
  { name: "delete_file", permission: "dangerous", description: "Delete a project file. Max 3 per run.", input: { path: "string" }, output: { ok: "boolean" } },
  { name: "apply_patches", permission: "write", description: "Apply SEVERAL find/replace edits to one file atomically. Each 'find' must be exact and unique; if any patch does not resolve, NOTHING is changed. Preferred over repeated patch_file calls on the same file.", input: { path: "string", patches: "[{ find, replace }]" }, output: { patches_applied: "number" } },
  { name: "insert_at", permission: "write", description: "Insert code at a precise location without rewriting the file: position 'before'/'after' an exact unique anchor text, or 'start'/'end' of the file.", input: { path: "string", anchor: "string (required for before/after)", position: "before|after|start|end", content: "string" }, output: { ok: "boolean" } },
  { name: "replace_range", permission: "write", description: "Replace an inclusive 1-based line range with new content. Use when you know the exact lines (e.g. from a build diagnostic).", input: { path: "string", start_line: "number", end_line: "number", content: "string" }, output: { lines_replaced: "number" } },
  { name: "replace_symbol", permission: "write", description: "Replace ONE whole top-level declaration (function, const/let/var, class) by name, leaving the rest of the file untouched. The safest way to rewrite a component or handler.", input: { path: "string", symbol: "string", content: "string" }, output: { replaced_chars: "number" } },
  { name: "rename_symbol", permission: "write", description: "Rename an identifier across the whole project (declaration and every reference), matching whole words only.", input: { from: "string", to: "string" }, output: { files_changed: "number", occurrences: "number" } },
  { name: "move_file", permission: "write", description: "Move or rename a file and keep the project wired: relative imports pointing at it are rewritten, its own relative imports are re-based, and server.<name> call sites follow a renamed backend function.", input: { from: "string", to: "string" }, output: { imports_rewritten: "array" } },
  { name: "copy_file", permission: "write", description: "Copy a file to a new path, re-basing its own relative imports. Use to fork a page/component intentionally — never to create near-duplicates.", input: { from: "string", to: "string" }, output: { ok: "boolean" } },
  { name: "delete_files", permission: "dangerous", description: "Delete several files at once. Refused when another file still imports one of them (or still calls a deleted backend function) unless force is true. Max 10.", input: { paths: "array of string", force: "boolean" }, output: { deleted: "array" } },
  { name: "create_entity", permission: "write", description: "Declare a database entity. fields is a LIST: [{ name, type, required?, enum?, description? }]. Types: string, text, number, boolean, date, enum. Optionally declare row-level security with `rls`.", input: { name: "string", fields: "array", rls: RLS_INPUT }, output: { ok: "boolean" } },
  { name: "update_entity", permission: "write", description: "Replace the field definition of an existing entity (existing records keep their data). fields is the same LIST form as create_entity. Omit `rls` to keep the entity's current rules, pass a block to replace them, or null to clear them.", input: { name: "string", fields: "array", rls: RLS_INPUT }, output: { ok: "boolean" } },
  // Superagent parity: cross-app reads. The registry entry is static; EXECUTION is gated on the
  // loop-supplied hook (shared/agentCrossApp.ts), which only exists for an agent that declares
  // cross_app_access grants — an agent without grants can never read another app, and every
  // read is re-checked against the live projects at call time.
  { name: "read_app_data", permission: "read", description: "Read a bounded page of records from an entity in ANOTHER app of this agent's workspace, when the agent's cross_app_access grants include that app. 'app' is the other project's id; 'query' is optional JSON of equality filters. This project's own data is read through its own tools.", input: { app: "string (project id)", entity: "string", query: "string (optional JSON of equality filters)", limit: "string (optional, 1-50)" }, required: ["app", "entity"], output: { entity: "string", count: "number", records: "array" } },
  { name: "run_build", permission: "system", description: "Build the project (executed automatically by the orchestrator).", input: {}, output: { status: "string", logs: "array" } },
  { name: "create_snapshot", permission: "system", description: "Create a version snapshot (executed automatically after a successful build).", input: { message: "string" }, output: { version: "number" } },
  { name: "restore_snapshot", permission: "system", description: "Restore a version (user-triggered from the Versions panel).", input: { version_id: "string" }, output: { version: "number" } },
  // Scheduled Superagent automations (Phase 16C-4D): the platform-level lifecycle of the
  // project's AgentSchedule records, executed by the AGENT loop under the run's owner identity
  // (shared/agentSchedules.ts). These are control-plane, not project files — the registry
  // executor cannot run them (they have no executeTool case), so they are only ever invoked
  // through the agent loop's schedule actions, under the E10 grant gate.
  { name: "agent_schedule_create", permission: "write", description: "Create a Scheduled Superagent automation: a fixed goal this project's agent will run on a schedule. 'schedule' is JSON: { \"cron\": \"...\" } or { \"interval_seconds\": n } or { \"one_time_at\": ISO datetime }, optionally with \"timezone\" (IANA) and ends_type/ends_on_date/ends_after_count. Exactly one timing mode. The one-time instant must be in the future.", input: { goal: "string", schedule: "string (JSON)", agent_name: "string (optional)" }, required: ["goal", "schedule"], output: { schedule_id: "string", next_run_at: "string" } },
  { name: "agent_schedule_update", permission: "write", description: "Update one of this project's Scheduled Superagent automations: 'schedule' is JSON of the fields to change (cron / interval_seconds / one_time_at / timezone / ends_type / ends_on_date / ends_after_count); any timing change revalidates the whole schedule fail-closed. Use schedule_goal to change the fixed instruction and agent_name to change or clear the declared agent.", input: { schedule_id: "string", schedule: "string (JSON, optional)", schedule_goal: "string (optional)", agent_name: "string (optional)" }, required: ["schedule_id"], output: { schedule_id: "string", changed: "array", next_run_at: "string" } },
  { name: "agent_schedule_pause", permission: "write", description: "Pause one of this project's Scheduled Superagent automations: it fires nothing until resumed. The due occurrence's slot is preserved.", input: { schedule_id: "string" }, required: ["schedule_id"], output: { schedule_id: "string", enabled: "boolean", paused_reason: "string" } },
  { name: "agent_schedule_resume", permission: "write", description: "Resume a paused Scheduled Superagent automation: recomputes the next occurrence from now and clears the failure streak. An already-fired one-time schedule has ended and cannot resume.", input: { schedule_id: "string" }, required: ["schedule_id"], output: { schedule_id: "string", enabled: "boolean", next_run_at: "string" } },
  { name: "agent_schedule_archive", permission: "dangerous", description: "Archive one of this project's Scheduled Superagent automations (the evidenced tombstone — there is no hard delete): it stops permanently until explicitly restored.", input: { schedule_id: "string" }, required: ["schedule_id"], output: { schedule_id: "string", archived: "boolean" } },
  { name: "agent_schedule_restore", permission: "write", description: "Restore an archived Scheduled Superagent automation: recomputes the next occurrence from now. An already-fired one-time schedule has ended and cannot be restored.", input: { schedule_id: "string" }, required: ["schedule_id"], output: { schedule_id: "string", enabled: "boolean", next_run_at: "string" } },
];

export function allowedTools(mode) {
  const perms = mode === "discuss" ? ["read"] : ["read", "write", "dangerous"];
  return TOOL_REGISTRY.filter((t) => perms.includes(t.permission));
}

export function describeTools(tools) {
  return tools.map((t) => `- ${t.name}(${Object.entries(t.input).map(([k, v]) => `${k}: ${v}`).join(", ")}) — ${t.description}`).join("\n");
}

// Accepts either a map { fieldName: {type,...} } or a list [{ name, type, ... }].
// The list form is what models can actually emit: a free-form map has no declared
// properties, and structured-output enforcement returns it empty.
function normalizeFieldInput(fields) {
  if (Array.isArray(fields)) {
    const map = {};
    for (const f of fields) {
      if (!f || !f.name) throw new Error("each field needs a 'name'");
      const { name, ...rest } = f;
      map[name] = rest;
    }
    return map;
  }
  return fields;
}

// One field definition, whichever grammar it arrived in, expressed in the internal vocabulary.
// The planner/model grammar ({ type: "date" | "enum" | ... }) is unchanged; the JSON Schema forms a
// canonical entity FILE carries ({ type: "string", format: "date" } / { type: "string", enum: [...] })
// are additionally accepted, so the file layer needs no second normalizer.
function normalizeFieldDef(def) {
  const d = typeof def === "string" ? { type: def } : (def || {});
  if (d.type === "integer") return { ...d, type: "number" };
  if (d.type === "string") {
    if (Array.isArray(d.enum) && d.enum.length) return { ...d, type: "enum" };
    if (d.format === "date" || d.format === "date-time") { const { format, ...rest } = d; return { ...rest, type: "date" }; }
  }
  return d;
}

function validateFields(fields) {
  const input = normalizeFieldInput(fields);
  if (!input || typeof input !== "object") throw new Error("fields must be a list of { name, type } or an object map");
  const clean = {};
  const entries = Object.entries(input);
  if (!entries.length) throw new Error("fields cannot be empty — declare at least one field");
  for (const [name, def] of entries) {
    if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new Error(`invalid field name '${name}'`);
    const d = normalizeFieldDef(def);
    if (!VALID_FIELD_TYPES.includes(d.type)) throw new Error(`field '${name}' has invalid type '${d.type}'. Use: ${VALID_FIELD_TYPES.join(", ")}`);
    const values = Array.isArray(d.enum) ? d.enum.filter(Boolean) : null;
    if (d.type === "enum" && !values?.length) throw new Error(`enum field '${name}' needs a non-empty 'enum' array`);
    const frls = validateFieldRls("", name, d.rls);
    clean[name] = { type: d.type, required: !!d.required, ...(values?.length ? { enum: values } : {}), ...(d.description ? { description: d.description } : {}), ...(frls ? { rls: frls } : {}) };
  }
  return clean;
}

// Metadata only, by construction: the run state never carries secret values.
export function secretsView(ctx) {
  return (ctx.secrets || []).map((s) => ({ name: s.name, description: s.description || "", required: s.required !== false, is_set: !!s.is_set }));
}

// Integration metadata enriched with whether the referenced secret has a value (never the value).
export function integrationsView(ctx) {
  const set = new Set((ctx.secrets || []).filter((s) => s.is_set).map((s) => s.name));
  return describeIntegrations(ctx.fs).map((i) => ({ ...i, ...(i.secret_ref ? { secret_is_set: set.has(i.secret_ref) } : {}) }));
}

// MCP registry view for the model: source-tagged, metadata only, no credentials.
export function mcpConnectionsView(ctx) {
  return (ctx.mcp?.connections || []).map((c) => ({
    source: "mcp", connection_id: c.id, name: c.name, server_url: c.server_url, transport: c.transport,
    status: c.status, enabled: c.enabled, auth_type: c.auth_type, secret_name: c.secret_name,
    server_name: c.server_name, server_version: c.server_version, protocol_version: c.protocol_version,
    last_connected_at: c.last_connected_at, last_error: c.last_error, last_error_code: c.last_error_code,
    tool_count: c.tool_count,
    tools: c.tools.map((t) => ({ tool_name: t.name, description: t.description, read_only: t.read_only, input_schema: t.input_schema })),
  }));
}

function findIntegration(ctx, name) {
  const i = integrationsView(ctx).find((x) => x.name === name);
  if (!i) throw new Error(`integration '${name}' does not exist (integrations: ${integrationsView(ctx).map((x) => x.name).join(", ") || "none"})`);
  if (i.error) throw new Error(i.error);
  return i;
}

function saveIntegration(ctx, doc) {
  writeFile(ctx.fs, integrationPath(doc.name), serializeIntegration(doc));
  // The integration's credential(s) become declared project secrets automatically, so the
  // Secrets panel surfaces the requirement. References only — no value exists here.
  for (const ref of secretRefs(doc)) {
    if (!(ctx.secrets ||= []).some((s) => s.name === ref)) {
      ctx.secrets.push({ name: ref, description: `Credential for the ${doc.name} integration`, required: true, is_set: false, dirty: true });
    }
  }
  return doc;
}

// A project that carries its own base44/config.jsonc manifest also declares its entities as
// canonical files. The AppEntity runtime projection is unchanged and remains authoritative — the
// file is written from the SAME normalized fields, so the two can never disagree. A legacy project
// (no manifest) gets no entity file at all.
// `rls` is passed through UNTOUCHED to the layout layer, which owns the document shape. `undefined`
// leaves whatever the document already declares in place; an explicit block (or null, to clear it)
// replaces it. No rule is interpreted here — shared/rls.ts is the only evaluator.
function emitEntitySchema(ctx, name, fields, rls = undefined) {
  if (!activeFiles(ctx.fs).some((f) => f.path === CONFIG_FILE)) return;
  const path = entityFilePath(name);
  // The current document, when there is one: re-emitting must carry over any top-level metadata
  // this layer does not own rather than dropping it.
  let existing = null;
  try { existing = readFile(ctx.fs, path); } catch { /* first emission */ }
  writeFile(ctx.fs, path, entitySchemaContent(name, fields, existing, rls));
}

// One shared read of an `rls` argument, validated by the layout layer's own shape check. Returns
// `undefined` when the caller said nothing (leave as-is) and `null` when it explicitly cleared it.
function readRlsArg(args) {
  if (!("rls" in args) || args.rls === undefined) return undefined;
  if (args.rls === null) return null;
  const check = validateRlsBlock(args.rls);
  if (!check.ok) throw new Error(`rls ${check.error}`);
  return check.rls ?? null;
}

async function fetchOpenApi(url) {
  const target = assertAllowedUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAPI_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target.toString(), { signal: controller.signal, headers: { Accept: "application/json, application/yaml, text/yaml, text/plain" } });
    if (!res.ok) throw new Error(`fetching the OpenAPI document failed: ${target.hostname} responded ${res.status}`);
    const text = await res.text();
    if (text.length > OPENAPI_MAX_CHARS) throw new Error("OpenAPI document is too large (over 2MB)");
    return text;
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `fetching the OpenAPI document timed out (${target.hostname})` : e.message);
  } finally { clearTimeout(timer); }
}

// ctx = { fs, entities: [{ id?, name, fields, dirty? }], secrets: [{ name, description, required, is_set }], deletes: number }
const REQUIRED_HINTS = {
  patch_file: { find: "the exact, unique text to find in the file (copy it from the current content)" },
};

export async function executeTool(ctx, name, input, mode) {
  const tool = allowedTools(mode).find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Tool '${name}' is not available in ${mode} mode` };
  const args = input || {};
  // Validate required fields before execution. This catches model errors (e.g. a patch_file
  // call with no 'find') with a clear, actionable message instead of a cryptic throw deep in
  // the tool implementation, so the repair loop feeds back something the model can correct.
  if (Array.isArray(tool.required)) {
    for (const field of tool.required) {
      const v = args[field];
      if (v == null || (typeof v === "string" && !String(v).trim())) {
        const hint = REQUIRED_HINTS[name]?.[field];
        return { ok: false, error: `${name}: '${field}' is required${hint ? ` — ${hint}` : ""}` };
      }
    }
  }
  try {
    switch (name) {
      case "read_file": return { ok: true, result: { path: args.path, content: readFile(ctx.fs, args.path) } };
      case "read_app_data": {
        if (!ctx.cross_app?.read) return { ok: false, error: "read_app_data: this agent has no cross-app access grants — add the target app to the agent's cross_app_access" };
        let query = null;
        if (args.query) {
          try { query = JSON.parse(String(args.query)); } catch { return { ok: false, error: "read_app_data: 'query' must be valid JSON" }; }
        }
        try {
          const result = await ctx.cross_app.read({ project_id: String(args.app || ""), entity: String(args.entity || ""), query, limit: Number(args.limit) || undefined });
          return { ok: true, result };
        } catch (e) {
          return { ok: false, error: `${e.code || "CROSS_APP_READ_FAILED"}: ${e.message}`, code: e.code || "CROSS_APP_READ_FAILED" };
        }
      }
      case "list_files": return { ok: true, result: { files: listFiles(ctx.fs) } };
      case "search_project": return { ok: true, result: { matches: searchProject(ctx.fs, args.query) } };
      case "get_project_state": return { ok: true, result: { index: buildIndex(ctx.fs), entities: ctx.entities.map((e) => ({ name: e.name, fields: e.fields })), functions: describeFunctions(ctx.fs), integrations: integrationsView(ctx), secrets: secretsView(ctx) } };
      case "list_functions": return { ok: true, result: { functions: describeFunctions(ctx.fs) } };
      case "list_secrets": return { ok: true, result: { secrets: secretsView(ctx) } };
      case "list_integrations": return { ok: true, result: { integrations: integrationsView(ctx) } };
      case "list_mcp_connections": return { ok: true, result: { connections: mcpConnectionsView(ctx) } };
      case "mcp_call": {
        // Delegated runs inherit the delegating agent's grants: without an mcp_call grant the
        // agent could not call MCP itself, so its Builder child cannot either. Normal Builder
        // runs carry no grants context and behave exactly as before.
        assertDelegatedToolGrant(ctx, "mcp_call");
        if (!ctx.mcp?.call) throw new Error("MCP tools are not available in this phase of the run");
        let callArgs = args.arguments;
        if (callArgs === undefined && args.arguments_json) {
          try { callArgs = JSON.parse(String(args.arguments_json)); } catch { throw new Error("arguments_json must be valid JSON"); }
        }
        try {
          const result = await ctx.mcp.call({ connection_name: String(args.connection || ""), tool_name: String(args.tool || ""), args: callArgs && typeof callArgs === "object" ? callArgs : {} });
          return { ok: true, result };
        } catch (e) {
          // Structured, safe failure: the model can tell apart a missing connection, a
          // disabled one, bad credentials, an unknown tool and a remote failure.
          return { ok: false, error: `${e.code || "MCP_TOOL_EXECUTION_FAILURE"}: ${e.message}`, code: e.code || "MCP_TOOL_EXECUTION_FAILURE", details: e.details || {} };
        }
      }
      case "get_integration": { const i = findIntegration(ctx, args.name); return { ok: true, result: { integration: i, tools: toExternalTools(i) } }; }
      case "list_operations": { const i = findIntegration(ctx, args.name); return { ok: true, result: { integration: i.name, type: i.type, operations: i.operations.map((o) => (o.tool ? { name: o.name, tool: o.tool, description: o.description, input_schema: o.input_schema, read_only: !!o.read_only } : { name: o.name, method: o.method, path: o.path, description: o.description, parameters: o.parameters })) } }; }
      case "get_operation": {
        const i = findIntegration(ctx, args.integration);
        const op = i.operations.find((o) => o.name === args.operation);
        if (!op) throw new Error(`integration '${i.name}' has no operation '${args.operation}' (operations: ${i.operations.map((o) => o.name).join(", ") || "none"})`);
        const usage = op.tool
          ? `await integrations.${i.name}.${op.name}({ ${Object.keys(op.input_schema?.properties || {}).join(", ")} }) → { text, structured }`
          : `await integrations.${i.name}.${op.name}({ ${op.parameters.map((p) => p.name).join(", ")} }${op.request_body ? ", { body: {...} }" : ""})`;
        return { ok: true, result: { integration: i.name, operation: op, usage } };
      }
      case "declare_secret": {
        const nm = String(args.name || "");
        if (!/^[A-Z][A-Z0-9_]*$/.test(nm)) throw new Error("secret name must be UPPER_SNAKE_CASE, e.g. WEATHER_API_KEY");
        if (args.value !== undefined) throw new Error("declare_secret must not carry a value — the user supplies it through the Secrets panel");
        const found = (ctx.secrets ||= []).find((s) => s.name === nm);
        if (found) { found.description = args.description || found.description; found.dirty = true; }
        else ctx.secrets.push({ name: nm, description: args.description || "", required: args.required !== false, is_set: false, dirty: true });
        return { ok: true, result: { ok: true } };
      }
      case "create_integration": {
        if (!INTEGRATION_NAME_RE.test(args.name || "")) throw new Error("integration name must be lowerCamelCase, e.g. weather");
        if (integrationsView(ctx).some((i) => i.name === args.name)) throw new Error(`integration '${args.name}' already exists; use update_integration`);
        const doc = saveIntegration(ctx, normalizeIntegration({ ...args, type: args.type || "http" }));
        return { ok: true, result: { ok: true, integration: doc, usage: doc.operations.map((o) => `integrations.${doc.name}.${o.name}(...)`) } };
      }
      case "update_integration": {
        const { id: _id, path: _p, used_by: _u, secret_ref: _s, secret_is_set: _set, operation_count: _c, ...current } = findIntegration(ctx, args.name);
        const doc = saveIntegration(ctx, normalizeIntegration({ ...current, ...args, name: current.name }));
        return { ok: true, result: { ok: true, integration: doc } };
      }
      case "import_openapi": {
        if (!INTEGRATION_NAME_RE.test(args.name || "")) throw new Error("integration name must be lowerCamelCase, e.g. petstore");
        let document = args.document;
        if (!document) {
          if (!args.url) throw new Error("import_openapi needs either 'url' or an inline 'document'");
          document = await fetchOpenApi(String(args.url));
        }
        const out = importOpenApi(document, { name: args.name, description: args.description, base_url: args.base_url, secret: args.secret, openapi_url: args.url ? String(args.url) : undefined });
        const doc = saveIntegration(ctx, out.integration);
        return { ok: true, result: { ok: true, imported: out.imported, skipped: out.skipped, spec_version: out.spec_version, format: out.format, integration: { ...doc, operations: doc.operations.map((o) => ({ name: o.name, method: o.method, path: o.path, description: o.description })) } } };
      }
      case "delete_integration": {
        const i = findIntegration(ctx, args.name);
        if (i.used_by?.length) throw new Error(`integration '${i.name}' is still used by backend function(s): ${i.used_by.join(", ")}. Remove those calls first.`);
        deleteFile(ctx.fs, integrationPath(i.name));
        return { ok: true, result: { ok: true } };
      }
      case "write_file": {
        assertMutableProjectFile(ctx, args.path);
        if (isIntegrationPath(args.path || "")) normalizeIntegration(JSON.parse(String(args.content || "")));
        // A backend function's target path is decided by the PROJECT's layout, not by the caller: a
        // project carrying base44/config.jsonc writes NEW functions to the canonical
        // base44/functions/<name>/entry.ts, while a legacy project keeps writing functions/<name>.js.
        // resolveFunctionPath owns the choice — it reuses an existing file of either shape, so no
        // function is ever duplicated and no existing function is migrated. Non-function writes and
        // paths already canonical pass through untouched.
        let target = String(args.path || "");
        if (isLegacyFunctionPath(target)) {
          const paths = activeFiles(ctx.fs).map((f) => f.path);
          if (paths.includes(CONFIG_FILE)) target = resolveFunctionPath(functionNameFromPath(target), paths);
        }
        writeFile(ctx.fs, target, args.content);
        return { ok: true, result: { ok: true, ...(target !== args.path ? { path: target } : {}) } };
      }
      case "patch_file": assertMutableProjectFile(ctx, args.path); patchFile(ctx.fs, args.path, args.find, args.replace); return { ok: true, result: { ok: true } };
      case "delete_file":
        assertMutableProjectFile(ctx, args.path);
        if ((ctx.deletes || 0) >= 3) throw new Error("Refused: deleting more than 3 files in one run requires user confirmation");
        deleteFile(ctx.fs, args.path); ctx.deletes = (ctx.deletes || 0) + 1;
        return { ok: true, result: { ok: true } };
      // Structural mutations. Each is atomic: a missing or ambiguous anchor throws before
      // anything is written, so the FS never ends up half-edited.
      case "apply_patches": assertMutableProjectFile(ctx, args.path); return { ok: true, result: applyPatches(ctx.fs, args.path, args.patches) };
      case "insert_at": assertMutableProjectFile(ctx, args.path); return { ok: true, result: insertAt(ctx.fs, args.path, { anchor: args.anchor, position: args.position || "after", content: args.content }) };
      case "replace_range": assertMutableProjectFile(ctx, args.path); return { ok: true, result: replaceRange(ctx.fs, args.path, { start_line: args.start_line, end_line: args.end_line, content: args.content }) };
      case "replace_symbol": assertMutableProjectFile(ctx, args.path); return { ok: true, result: replaceSymbol(ctx.fs, args.path, args.symbol, args.content) };
      case "rename_symbol": (Array.isArray(args.paths) ? args.paths : args.paths ? [args.paths] : []).forEach((p) => assertMutableProjectFile(ctx, p)); return { ok: true, result: renameSymbol(ctx.fs, { from: args.from, to: args.to, paths: args.paths || null }) };
      case "move_file": {
        if (isIntegrationPath(args.from || "") || isIntegrationPath(args.to || "")) throw new Error("move_file: integration definitions are managed with the integration tools");
        assertMutableProjectFile(ctx, args.from); assertMutableProjectFile(ctx, args.to);
        return { ok: true, result: moveFile(ctx.fs, args.from, args.to) };
      }
      case "copy_file": {
        if (isIntegrationPath(args.to || "")) throw new Error("copy_file: integration definitions are managed with the integration tools");
        assertMutableProjectFile(ctx, args.to);
        return { ok: true, result: copyFile(ctx.fs, args.from, args.to) };
      }
      case "delete_files": {
        const paths = Array.isArray(args.paths) ? args.paths : [args.paths].filter(Boolean);
        for (const p of paths) assertMutableProjectFile(ctx, p);
        if ((ctx.deletes || 0) + paths.length > 6) throw new Error("Refused: deleting more than 6 files in one run requires user confirmation");
        const out = deleteFiles(ctx.fs, paths, { force: !!args.force });
        ctx.deletes = (ctx.deletes || 0) + out.deleted.length;
        return { ok: true, result: out };
      }
      case "create_entity": {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(args.name || "")) throw new Error("entity name must be PascalCase, e.g. Customer");
        if (ctx.entities.some((e) => e.name === args.name)) throw new Error(`entity '${args.name}' already exists; use update_entity`);
        const fields = validateFields(args.fields);
        // Validated BEFORE anything is written, so a malformed rule creates no entity and no file.
        const rls = readRlsArg(args);
        ctx.entities.push({ id: null, name: args.name, fields, ...(rls ? { rls } : {}), dirty: true });
        emitEntitySchema(ctx, args.name, fields, rls);
        return { ok: true, result: { ok: true, ...(rls ? { rls } : {}) } };
      }
      case "update_entity": {
        const e = ctx.entities.find((x) => x.name === args.name);
        if (!e) throw new Error(`entity '${args.name}' does not exist; use create_entity`);
        const rls = readRlsArg(args);
        e.fields = validateFields(args.fields); e.dirty = true;
        // An omitted `rls` leaves the entity's rules exactly as they are; an explicit block
        // replaces them, and an explicit null clears them.
        if (rls !== undefined) { if (rls) e.rls = rls; else delete e.rls; }
        emitEntitySchema(ctx, e.name, e.fields, rls);
        return { ok: true, result: { ok: true, ...(e.rls ? { rls: e.rls } : {}) } };
      }
      default: return { ok: false, error: `Tool '${name}' cannot be invoked by the model` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function summarizeToolCall(name, input, res) {
  if (name === "mcp_call") return `MCP: ${input?.connection || "?"} → ${input?.tool || "?"}${res.ok ? "" : " — " + res.error}`;
  const target = input?.path || input?.name || input?.integration || input?.query || "";
  return `${name}${target ? " " + target : ""}${res.ok ? "" : " — " + res.error}`;
}