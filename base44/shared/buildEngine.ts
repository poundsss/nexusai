// Build engine: parses every module with a real JS parser, resolves the import graph,
// links named imports to exports, rejects cycles and external imports, and checks
// that every `db.<Entity>` reference maps to a declared entity.
import * as acorn from "npm:acorn@8.12.1";
import { activeFiles } from "./projectFs.ts";
import { RUNTIME_EXPORTS, ENTRY_FILE } from "./runtimeExports.ts";
import { isFunctionPath, functionNameFromPath, FUNCTION_NAME_RE } from "./functionPaths.ts";
// Workflow resource documents are validated through the EXISTING workflow validator.
import { isWorkflowFilePath, validateWorkflowFiles } from "./workflowResource.ts";
// Agent + agent-skill resources are validated through the SAME parsers the agent runtime uses.
import { isAgentFilePath, isAgentSkillFilePath, isConfigPath, isAssetPath, validateConfigDocument, ASSETS_DIR } from "./base44Layout.ts";
// `.app.jsonc`, plugin declarations and assets are validated by the ONE app-surface contract.
import { readAppConfig, resolvePlugins, collectAssets, APP_CONFIG_FILE } from "./appResource.ts";
import { validateAgentReferences } from "./agentResource.ts";
import { collectAgentSkills, MAX_SKILLS_PER_APP } from "./agentSkillResource.ts";
import { isConnectorFilePath, collectConnectors, connectorRuntimePath } from "./connectorResource.ts";
// Actor resources (E8) are validated by the actor contract, which uses this same parser and the
// same sandbox-syntax rules a backend function is held to.
import { isActorFilePath, parseActorDocument } from "./actorResource.ts";
import { findUnsupported } from "./jsInterp.ts";
import { isIntegrationPath, parseIntegrationFile, integrationCallsIn, INTEGRATION_CALL_RE, secretRefs } from "./integrations.ts";
// Installed packages come from the project's OWN lockfile, so the build links exactly the resolved
// dependency state the runtimes will load — never an arbitrary remote module.
import { installedPackages, validateDependencyFiles, MANIFEST_FILE, LOCKFILE_FILE } from "./packageLock.ts";

// Integration-definition build pass: every integrations/<name>.json must be a valid
// definition, and every integrations.<name>.<op>() call in a backend function must resolve.
export function buildIntegrations(integrationFiles, functionFiles, frontendFiles, secrets, err, logs) {
  const declaredSecrets = new Set((secrets || []).map((s) => s.name));
  const valid = [];
  for (const f of integrationFiles) {
    try {
      const doc = parseIntegrationFile(f.path, f.content);
      for (const ref of secretRefs(doc)) if (!declaredSecrets.has(ref)) logs.push(`warning: ${f.path} authenticates with secret ${ref}, which is not configured for this project yet`);
      if (doc.type === "mcp") logs.push(`[integrations] ${f.path}: MCP server ${doc.server_url} · ${doc.operations.length} tool binding(s)`);
      if (doc.auth?.type === "oauth2") logs.push(`[integrations] ${f.path}: OAuth2 ${doc.auth.grant} against ${doc.auth.token_url}`);
      valid.push(doc);
    } catch (e) {
      err(e.message.startsWith(f.path) ? e.message : `${f.path}: ${e.message}`);
    }
  }
  const byName = new Map(valid.map((i) => [i.name, i]));
  for (const f of functionFiles) {
    const seen = new Set();
    for (const c of integrationCallsIn(f.content)) {
      const key = `${c.integration}.${c.operation}`;
      if (seen.has(key)) continue; seen.add(key);
      const integ = byName.get(c.integration);
      if (!integ) { err(`${f.path}: calls integrations.${c.integration}.${c.operation}() but no integration named '${c.integration}' exists (integrations: ${[...byName.keys()].join(", ") || "none"}). Create it with create_integration or import_openapi.`); continue; }
      if (!integ.operations.some((o) => o.name === c.operation)) err(`${f.path}: integration '${c.integration}' has no operation '${c.operation}' (operations: ${integ.operations.map((o) => o.name).join(", ") || "none"})`);
    }
  }
  for (const f of frontendFiles) {
    if (!f.path.endsWith(".js")) continue;
    INTEGRATION_CALL_RE.lastIndex = 0;
    if (INTEGRATION_CALL_RE.test(f.content)) err(`${f.path}: frontend code cannot call integrations.<name>.<operation>() — external APIs are only reachable from backend functions (functions/<name>.js); call the function with server.<name>() instead.`);
  }
  return valid;
}

// Reads an object literal statically (no execution) — used to validate a backend
// function's exported config at build time.
function staticObject(node) {
  if (!node || node.type !== "ObjectExpression") return null;
  const out = {};
  for (const p of node.properties) {
    if (p.type !== "Property" || p.computed) return null;
    const key = p.key.name ?? p.key.value;
    const v = p.value;
    if (v.type === "Literal") out[key] = v.value;
    else if (v.type === "ArrayExpression" && v.elements.every((e) => e && e.type === "Literal")) out[key] = v.elements.map((e) => e.value);
    else if (v.type === "ObjectExpression") out[key] = staticObject(v);
    else return null;
  }
  return out;
}

const VALID_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"];

// Backend-function build pass: same error channel as the frontend build, so the existing
// AI repair loop diagnoses and patches backend code with no extra machinery.
export function buildFunctions(functionFiles, entities, secrets, err, logs) {
  const declaredSecrets = new Set((secrets || []).map((s) => s.name));
  const built = [];
  for (const f of functionFiles) {
    const name = functionNameFromPath(f.path);
    if (!FUNCTION_NAME_RE.test(name)) { err(`${f.path}: invalid backend function name '${name}'`); continue; }
    let ast;
    try {
      ast = acorn.parse(f.content, { ecmaVersion: 2022, sourceType: "module", locations: true });
    } catch (e) {
      const loc = e.loc ? `${e.loc.line}:${e.loc.column}` : "?";
      err(`${f.path}:${loc} ${e.message.replace(/\s*\(\d+:\d+\)$/, "")}`);
      continue;
    }
    // The server sandbox interprets the AST directly, so unsupported syntax is a build error.
    const unsupported = findUnsupported(ast);
    if (unsupported.length) {
      const kinds = [...new Set(unsupported.map((u) => `${u.type}${u.line ? ` (line ${u.line})` : ""}`))].slice(0, 4);
      err(`${f.path}: backend functions do not support ${kinds.join(", ")} — use plain functions, const/let, if/for/of, try/catch, template literals, objects and arrays.`);
    }
    checkEntityLiterals(ast, f.path, entities, err);
    if (ast.body.some((n) => n.type === "ImportDeclaration")) {
      err(`${f.path}: backend functions cannot import anything. Everything is provided in the handler context: { request, db, secrets, http, integrations, log }.`);
    }
    const def = ast.body.find((n) => n.type === "ExportDefaultDeclaration");
    if (!def) err(`${f.path}: missing 'export default async function handler(ctx) { ... }'`);
    else if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(def.declaration.type)) {
      err(`${f.path}: the default export must be a function`);
    }
    let configNode = null;
    for (const n of ast.body) {
      if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
        for (const d of n.declaration.declarations) if (d.id.name === "config") configNode = d.init;
      }
    }
    let config = null;
    if (!configNode) err(`${f.path}: missing 'export const config = { method, webhook, secrets: [...] }'`);
    else {
      config = staticObject(configNode);
      if (!config) err(`${f.path}: config must be a plain object literal of literal values`);
    }
    if (config) {
      if (config.method && !VALID_METHODS.includes(String(config.method).toUpperCase())) {
        err(`${f.path}: config.method '${config.method}' is invalid (use ${VALID_METHODS.join(", ")})`);
      }
      if (config.secrets && !Array.isArray(config.secrets)) err(`${f.path}: config.secrets must be an array of secret names`);
      const declared = Array.isArray(config.secrets) ? config.secrets.map(String) : [];
      // Any secret the code reads must be declared; the sandbox refuses undeclared reads at runtime.
      for (const m of f.content.matchAll(/secrets\s*\.\s*(?:get|has)\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)) {
        if (!declared.includes(m[1])) err(`${f.path}: reads secret '${m[1]}' but does not declare it in config.secrets`);
      }
      for (const s of declared) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(s)) err(`${f.path}: secret name '${s}' must be UPPER_SNAKE_CASE`);
        else if (!declaredSecrets.has(s)) logs.push(`warning: ${f.path} requires secret ${s}, which is not configured for this project yet`);
      }
      built.push({ name, path: f.path, method: (config.method || "ANY").toUpperCase(), webhook: !!config.webhook, secrets: declared, description: config.description || "" });
    }
  }
  return built;
}

// --- static entity-literal validation ---------------------------------------
// Walks every module's AST looking for `db.<Entity>.create({...})` / `.update(id, {...})`
// with an object literal argument, and checks the literal properties against the entity
// schema. This catches an invalid enum value (or unknown field / wrong literal type) at
// BUILD time instead of at database write time. Only statically known literals are judged;
// computed or variable values are left to the runtime validator.
function walkNodes(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) walkNodes(n, visit); return; }
  if (typeof node.type === "string") visit(node);
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
    walkNodes(node[k], visit);
  }
}

const LITERAL_TYPE_OK = {
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  string: (v) => typeof v === "string",
  text: (v) => typeof v === "string",
  date: (v) => typeof v === "string",
};

export function checkEntityLiterals(ast, path, entities, err) {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const source = isFunctionPath(path) ? `backend function '${functionNameFromPath(path)}' (${path})` : path;
  walkNodes(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (!callee || callee.type !== "MemberExpression" || callee.computed) return;
    const op = callee.property?.name;
    if (op !== "create" && op !== "update") return;
    const target = callee.object;
    if (!target || target.type !== "MemberExpression" || target.computed) return;
    if (target.object?.type !== "Identifier" || !/^(db|database)$/.test(target.object.name)) return;
    const entityName = target.property?.name;
    const def = byName.get(entityName);
    if (!def) return; // unknown entity is already reported by the db.<Entity> check
    const arg = node.arguments[op === "create" ? 0 : 1];
    if (!arg || arg.type !== "ObjectExpression") return;
    const fields = def.fields || {};
    for (const p of arg.properties) {
      if (p.type !== "Property" || p.computed) continue;
      const field = p.key.name ?? p.key.value;
      const f = fields[field];
      if (!f) {
        err(`${path}: db.${entityName}.${op}() sets unknown field '${field}' — entity ${entityName} has no such field (fields: ${Object.keys(fields).join(", ") || "none"}). Source: ${source}`);
        continue;
      }
      if (p.value.type !== "Literal" || p.value.value === null) continue;
      const v = p.value.value;
      if (f.type === "enum") {
        const allowed = f.enum || [];
        if (!allowed.includes(v)) {
          const near = allowed.find((a) => String(a).toLowerCase() === String(v).toLowerCase());
          err(`${path}: invalid enum value for ${entityName}.${field} — value ${JSON.stringify(v)} is not allowed; allowed values: ${allowed.map((a) => JSON.stringify(a)).join(", ")}${near ? ` (did you mean ${JSON.stringify(near)}?)` : ""}. Source: ${source}`);
        }
      } else {
        const ok = LITERAL_TYPE_OK[f.type];
        if (ok && !ok(v)) err(`${path}: ${entityName}.${field} expects type ${f.type} but is set to the literal ${JSON.stringify(v)}. Source: ${source}`);
      }
    }
  });
}

export function resolveRelative(from, spec) {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") dir.pop(); else dir.push(seg);
  }
  return dir.join("/");
}

function collectExports(ast) {
  const names = new Set();
  for (const node of ast.body) {
    if (node.type === "ExportDefaultDeclaration") names.add("default");
    else if (node.type === "ExportAllDeclaration") names.add("*");
    else if (node.type === "ExportNamedDeclaration") {
      const d = node.declaration;
      if (d) {
        if (d.type === "VariableDeclaration") {
          for (const decl of d.declarations) {
            if (decl.id.type === "Identifier") names.add(decl.id.name);
            else names.add("*");
          }
        } else if (d.id) names.add(d.id.name);
      }
      for (const s of node.specifiers || []) names.add(s.exported.name || s.exported.value);
    }
  }
  return names;
}

function findCycle(graph) {
  const state = new Map();
  const stack = [];
  let cycle = null;
  const visit = (n) => {
    if (cycle) return;
    const s = state.get(n);
    if (s === 1) { cycle = [...stack.slice(stack.indexOf(n)), n]; return; }
    if (s === 2) return;
    state.set(n, 1); stack.push(n);
    for (const d of graph.get(n) || []) visit(d);
    stack.pop(); state.set(n, 2);
  };
  for (const n of graph.keys()) visit(n);
  return cycle;
}

export function runBuild(fs, entities, secrets = []) {
  const start = Date.now();
  const logs = [];
  let errors = 0;
  const err = (msg) => { errors++; logs.push(`error: ${msg}`); };
  const allFiles = activeFiles(fs);
  const functionFiles = allFiles.filter((f) => isFunctionPath(f.path));
  const integrationFiles = allFiles.filter((f) => isIntegrationPath(f.path));
  // Assets are static content, never modules: they ship with the app but are not parsed, linked or
  // required to be imported from the entry file.
  const assetFiles = allFiles.filter((f) => isAssetPath(f.path));
  const files = allFiles.filter((f) => !isFunctionPath(f.path) && !isIntegrationPath(f.path) && !isAssetPath(f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  // The resolved dependency state, read from the project's own lockfile. Only a package pinned here
  // may be imported, and only the exports the lockfile records for it.
  const packages = new Map(installedPackages(allFiles).map((p) => [p.name, p]));
  logs.push(`[build] ${files.length} frontend files, ${functionFiles.length} backend function(s), ${integrationFiles.length} integration(s), ${entities.length} entities`);
  if (packages.size) logs.push(`[dependencies] ${packages.size} resolved package(s): ${[...packages.values()].map((p) => `${p.name}@${p.version}`).join(", ")}`);

  // The dependency DOCUMENTS themselves, read from the project's own state through the ONE reader:
  // a malformed package.json or package.lock.json, or a manifest declaring a package the lockfile
  // does not pin, fails the build deterministically instead of letting an unresolved dependency
  // reach an artifact. A project carrying neither document has nothing to validate and behaves
  // exactly as before.
  const dependencyDocs = validateDependencyFiles(allFiles);
  for (const e of dependencyDocs.errors) err(e);

  if (!byPath.has(ENTRY_FILE)) err(`${ENTRY_FILE} (entry) not found`);

  const parsed = new Map();
  for (const f of files) {
    if (!f.path.endsWith(".js")) continue;
    if (f.path === MANIFEST_FILE || f.path === LOCKFILE_FILE) continue;
    try {
      parsed.set(f.path, acorn.parse(f.content, { ecmaVersion: 2022, sourceType: "module" }));
    } catch (e) {
      const loc = e.loc ? `${e.loc.line}:${e.loc.column}` : "?";
      err(`${f.path}:${loc} ${e.message.replace(/\s*\(\d+:\d+\)$/, "")}`);
    }
  }
  logs.push(`[parse] ${parsed.size} modules parsed`);

  const exportsOf = new Map();
  for (const [path, ast] of parsed) exportsOf.set(path, collectExports(ast));
  const runtimeExports = new Set(RUNTIME_EXPORTS);
  const graph = new Map();

  for (const [path, ast] of parsed) {
    const deps = [];
    for (const node of ast.body) {
      const hasSource = node.type === "ImportDeclaration" ||
        ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source);
      if (!hasSource) continue;
      const spec = node.source.value;
      const specifiers = node.specifiers || [];
      if (spec === "runtime") {
        for (const s of specifiers) {
          if (s.type === "ImportSpecifier" && !runtimeExports.has(s.imported.name)) {
            err(`${path}: 'runtime' has no export named '${s.imported.name}'. Available: ${RUNTIME_EXPORTS.join(", ")}`);
          }
          if (s.type === "ImportDefaultSpecifier") err(`${path}: 'runtime' has no default export; use named imports`);
        }
        continue;
      }
      if (!spec.startsWith(".")) {
        // An installed package resolves to the exact version the lockfile pinned; its exports are
        // linked the same way a project module's are, so a bad import fails at BUILD time.
        const pkg = packages.get(spec);
        if (!pkg) {
          err(`${path}: external import '${spec}' is not allowed. Only 'runtime', relative project files and installed packages may be imported${packages.size ? ` (installed: ${[...packages.keys()].join(", ")})` : ""}. Add the package to the project's dependencies first.`);
          continue;
        }
        for (const s of specifiers) {
          if (s.type === "ImportDefaultSpecifier") err(`${path}: package '${spec}' has no default export; use named imports (${pkg.exports.join(", ") || "none"})`);
          if (s.type === "ImportSpecifier" && !pkg.exports.includes(s.imported.name)) err(`${path}: package '${spec}@${pkg.version}' does not export '${s.imported.name}' (exports: ${pkg.exports.join(", ") || "none"})`);
        }
        continue;
      }
      const resolved = resolveRelative(path, spec);
      if (!byPath.has(resolved)) { err(`${path}: cannot resolve import '${spec}' (looked for ${resolved})`); continue; }
      if (!resolved.endsWith(".js")) { err(`${path}: import '${spec}' must point to a .js file`); continue; }
      deps.push(resolved);
      const ex = exportsOf.get(resolved);
      if (!ex || ex.has("*")) continue;
      for (const s of specifiers) {
        if (s.type === "ImportDefaultSpecifier" && !ex.has("default")) err(`${path}: '${resolved}' has no default export`);
        if (s.type === "ImportSpecifier" && !ex.has(s.imported.name)) err(`${path}: '${resolved}' does not export '${s.imported.name}' (exports: ${[...ex].join(", ") || "none"})`);
      }
    }
    graph.set(path, deps);
  }

  const cycle = findCycle(graph);
  if (cycle) err(`circular import: ${cycle.join(" -> ")}`);

  for (const [path, ast] of parsed) checkEntityLiterals(ast, path, entities, err);

  const entityNames = new Set(entities.map((e) => e.name));
  for (const f of allFiles) {
    if (!f.path.endsWith(".js")) continue;
    const seen = new Set();
    for (const m of f.content.matchAll(/\bdb\.([A-Za-z_]\w*)\b/g)) {
      if (!entityNames.has(m[1]) && !seen.has(m[1])) {
        seen.add(m[1]);
        err(`${f.path}: references db.${m[1]} but no entity named '${m[1]}' exists (entities: ${[...entityNames].join(", ") || "none"}). Create it with create_entity or fix the name.`);
      }
    }
  }

  const reachable = new Set();
  const walk = (p) => { if (reachable.has(p)) return; reachable.add(p); for (const d of graph.get(p) || []) walk(d); };
  if (parsed.has(ENTRY_FILE)) walk(ENTRY_FILE);
  for (const p of parsed.keys()) if (!reachable.has(p)) logs.push(`warning: ${p} is never imported from ${ENTRY_FILE}`);

  const functions = buildFunctions(functionFiles, entities, secrets, err, logs);
  if (functionFiles.length) logs.push(`[functions] ${functions.length}/${functionFiles.length} validated${functions.filter((f) => f.webhook).length ? ` · ${functions.filter((f) => f.webhook).length} webhook(s)` : ""}`);
  // Workflow resource documents are validated at BUILD time, through the EXISTING workflow
  // validator, so a malformed or unrunnable workflow file fails the build instead of shipping.
  // A project with no workflow files behaves exactly as before.
  const workflowFiles = allFiles.filter((f) => isWorkflowFilePath(f.path));
  if (workflowFiles.length) {
    const wf = validateWorkflowFiles(workflowFiles, { functionNames: functions.map((f) => f.name) });
    for (const e of wf.errors) err(e);
    logs.push(`[workflows] ${wf.workflows.filter((w) => w.ok).length}/${wf.count} validated`);
  }
  // Agent + agent-skill resources are validated at BUILD time through the SAME parsers the agent
  // runtime resolves them with, so a malformed agent, an unknown tool grant or a reference to a
  // missing skill fails the build instead of shipping. A project with no agent files is unaffected.
  const agentFiles = allFiles.filter((f) => isAgentFilePath(f.path) || isAgentSkillFilePath(f.path));
  if (agentFiles.length) {
    const skillCheck = collectAgentSkills(allFiles);
    for (const e of skillCheck.errors) err(e.error);
    // DOCUMENTED (Base44) per-app limit of 100 Agent Skills — fail closed above it. The
    // platform's own above-limit semantics are NOT published (UNKNOWN), so the build refuses
    // deterministically instead of guessing. Restore and deploy inherit this check: a restore
    // must pass runBuild before mutating, and a deploy refuses a non-success build.
    if (skillCheck.skills.length > MAX_SKILLS_PER_APP) {
      err(`the project declares ${skillCheck.skills.length} agent skills (base44/agent-skills/<name>.md) but an app may declare at most ${MAX_SKILLS_PER_APP}`);
    }
    const refs = validateAgentReferences(allFiles, { entityNames: entities.map((e) => e.name) });
    for (const e of refs.errors) err(e.error);
    for (const m of refs.missing) err(`${m.path}: references agent-skill '${m.skill}' but ${m.expected_path} does not exist`);
    logs.push(`[agents] ${refs.agents.length} agent(s), ${skillCheck.skills.length} skill(s) validated`);
  }
  // Connector resources (E12) are validated by the connector contract (which defers to the ONE
  // integration validator), and each declared connector must carry its runtime projection — the
  // `integrations/<name>.json` the EXISTING integration runtime loads. A declared connector without
  // it fails the build deterministically instead of shipping something the runtime cannot reach.
  const connectorFiles = allFiles.filter((f) => isConnectorFilePath(f.path));
  if (connectorFiles.length) {
    const declared = collectConnectors(connectorFiles);
    for (const e of declared.errors) err(e.error);
    const integrationPaths = new Set(integrationFiles.map((f) => f.path));
    for (const c of declared.connectors) {
      const runtimePath = connectorRuntimePath(c.name);
      if (!integrationPaths.has(runtimePath)) err(`${c.path}: declares connector '${c.name}' but its runtime projection ${runtimePath} does not exist — push the connector resource to materialize it.`);
    }
    logs.push(`[connectors] ${declared.count} connector resource(s) validated`);
  }
  // Actor resources (E8) are validated at BUILD time by the actor contract — the SAME parse the
  // stateful runtime resolves a room with, held to the same sandbox-syntax rules a backend function
  // is. A malformed actor, a missing handler or an undeclarable permission fails the build instead
  // of deploying an actor whose rooms could never run. A project with no actors is unaffected.
  const actorFiles = allFiles.filter((f) => isActorFilePath(f.path));
  if (actorFiles.length) {
    let validActors = 0;
    for (const f of actorFiles) {
      const parsed = parseActorDocument(f.path, f.content);
      if (!parsed.ok) { err(`${f.path} ${parsed.error}`); continue; }
      checkEntityLiterals(parsed.ast, f.path, entities, err);
      validActors++;
    }
    logs.push(`[actors] ${validActors}/${actorFiles.length} validated`);
  }
  // --- app surface: `.app.jsonc`, plugin declarations, assets -----------------
  // App metadata and the project manifest are SEPARATE documents with separate meanings, so each is
  // validated by its own contract and neither defaults the other. A project declaring neither builds
  // exactly as before.
  const appRead = readAppConfig(allFiles);
  if (appRead.error) err(appRead.error);
  let projectConfig = null;
  const configFile = allFiles.find((f) => isConfigPath(f.path));
  if (configFile) {
    const check = validateConfigDocument(configFile.content);
    if (check.ok) projectConfig = check.config;
  }
  // Plugins are DECLARATIONS resolved from both sites: a name, never code, a path or a command.
  const pluginSet = resolvePlugins({ appConfig: appRead.app, projectConfig });
  for (const e of pluginSet.errors) err(e.error);
  const assets = collectAssets(assetFiles);
  // An icon must name an asset the project actually ships, so a deployment can never reference a
  // file that is not in its artifact.
  if (appRead.app?.icon && !assets.some((a) => a.name === appRead.app.icon)) {
    err(`${APP_CONFIG_FILE}: 'icon' names '${appRead.app.icon}' but ${ASSETS_DIR}${appRead.app.icon} does not exist`);
  }
  if (appRead.declared) logs.push(`[app] ${APP_CONFIG_FILE}: ${appRead.app ? `${appRead.app.name}${appRead.app.icon ? ` · icon ${appRead.app.icon}` : ""}` : "invalid"}`);
  if (pluginSet.names.length) logs.push(`[plugins] ${pluginSet.names.length} declared: ${pluginSet.names.join(", ")}`);
  if (assets.length) logs.push(`[assets] ${assets.length} asset(s) · ${assets.reduce((n, a) => n + a.size, 0)} bytes`);

  const integrations = buildIntegrations(integrationFiles, functionFiles, files, secrets, err, logs);
  if (integrationFiles.length) logs.push(`[integrations] ${integrations.length}/${integrationFiles.length} validated · ${integrations.reduce((n, i) => n + i.operations.length, 0)} operation(s)`);

  // A frontend calling server.<name>() must have a matching backend function.
  const fnNames = new Set(functions.map((f) => f.name));
  for (const f of files) {
    if (!f.path.endsWith(".js")) continue;
    const seen = new Set();
    for (const m of f.content.matchAll(/\bserver\.([A-Za-z_]\w*)\b/g)) {
      if (!fnNames.has(m[1]) && !seen.has(m[1])) {
        seen.add(m[1]);
        err(`${f.path}: calls server.${m[1]}() but no backend function named '${m[1]}' exists (functions: ${[...fnNames].join(", ") || "none"}). Create functions/${m[1]}.js.`);
      }
    }
  }

  const duration_ms = Date.now() - start;
  const status = errors === 0 ? "success" : "failed";
  logs.push(status === "success" ? `[build] success in ${duration_ms}ms` : `[build] failed with ${errors} error(s)`);
  return { status, logs, errors, duration_ms, file_count: allFiles.length, functions,
    app: appRead.app, plugins: pluginSet.names, assets, integrations: integrations.map((i) => ({ name: i.name, type: i.type, base_url: i.base_url, ...(i.server_url ? { server_url: i.server_url } : {}), auth_type: i.auth?.type || "none", operations: i.operations.length })) };
}