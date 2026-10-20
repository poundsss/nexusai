// THE actor RESOURCE contract (E8) — the stateful realtime primitive, as a first-class project
// resource.
//
// One actor per directory: `base44/actors/<Name>/entry.ts`, the DIRECTORY NAME being the actor's
// identity — exactly the shape a backend function already uses, so the actor inherits the project's
// existing filesystem, build, commit, version, rollback and resource-sync machinery unchanged.
//
// This module is a RESOURCE layer only. It owns the canonical document, its parse and its
// validation; it deliberately owns NO runtime, NO state store and NO permission system:
//
//   module validation → the SAME acorn parse + sandbox-syntax check the function build uses
//   execution         → shared/actorRuntime.ts, over the EXISTING jsInterp sandbox
//   state/rooms       → the EXISTING project data primitive (AppRecord), like every other
//                       project-scoped runtime surface
//   permissions       → the EXISTING authorization model (authz + the rbac capability matrix);
//                       an actor declares WHICH capability its invocation needs, never its own rule
//
// A project with no actors is unaffected by everything here.
import * as acorn from "npm:acorn@8.12.1";
import { findUnsupported } from "./jsInterp.ts";
import { ACTORS_DIR } from "./base44Layout.ts";

export { ACTORS_DIR };
export const ACTOR_ENTRY = "entry.ts";
/** Actor identity grammar: a PascalCase name, the room class the runtime resolves by. */
export const ACTOR_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
const ACTOR_PATH_RE = /^base44\/actors\/([A-Z][A-Za-z0-9]*)\/entry\.ts$/;

/**
 * The capability an actor's invocation requires, stated by the actor and enforced by the EXISTING
 * rbac matrix. `write` (the default) is what a state-changing message needs; `read` is for an actor
 * that only projects existing state. No third vocabulary and no per-actor rule engine exists.
 */
export const ACTOR_ACCESS = ["read", "write"];
export const ACTOR_CAPABILITY = { read: "project.read", write: "project.write" };

export const isActorFilePath = (path) => ACTOR_PATH_RE.test(String(path || ""));
export const actorNameFromPath = (path) => (ACTOR_PATH_RE.exec(String(path || "")) || [null, String(path || "")])[1];
export const actorFilePath = (name) => `${ACTORS_DIR}${name}/${ACTOR_ENTRY}`;

const fail = (error, details = {}) => ({ ok: false, error, details });

/** Reads a literal-only object expression statically. `null` when it is not statically knowable. */
function staticObject(node) {
  if (!node || node.type !== "ObjectExpression") return null;
  const out = {};
  for (const p of node.properties) {
    if (p.type !== "Property" || p.computed) return null;
    const key = p.key.name ?? p.key.value;
    const v = p.value;
    if (v.type === "Literal") out[key] = v.value;
    else if (v.type === "ArrayExpression" && v.elements.every((e) => e && e.type === "Literal")) out[key] = v.elements.map((e) => e.value);
    else if (v.type === "ObjectExpression") { const nested = staticObject(v); if (nested === null) return null; out[key] = nested; }
    else return null;
  }
  return out;
}

/**
 * Parses and validates ONE actor document. The PATH decides the actor's identity, and the module is
 * checked with the SAME parser and sandbox-syntax rules the function build uses — so an actor that
 * validates is an actor the runtime can actually execute.
 */
export function parseActorDocument(path, source) {
  const p = String(path || "");
  if (!isActorFilePath(p)) return fail(`is not a canonical actor path (expected ${ACTORS_DIR}<Name>/${ACTOR_ENTRY})`, { path: p });
  const name = actorNameFromPath(p);
  if (!ACTOR_NAME_RE.test(name)) return fail(`has an invalid actor name '${name}' (PascalCase, e.g. ChatRoom)`, { path: p });

  let ast;
  try {
    ast = acorn.parse(String(source ?? ""), { ecmaVersion: 2022, sourceType: "module", locations: true });
  } catch (e) {
    return fail(`is not valid JavaScript: ${e.message.replace(/\s*\(\d+:\d+\)$/, "")}`, { path: p });
  }
  const unsupported = findUnsupported(ast);
  if (unsupported.length) {
    const kinds = [...new Set(unsupported.map((u) => `${u.type}${u.line ? ` (line ${u.line})` : ""}`))].slice(0, 4);
    return fail(`uses syntax the actor sandbox does not support: ${kinds.join(", ")}`, { path: p });
  }
  if (ast.body.some((n) => n.type === "ImportDeclaration")) {
    return fail("cannot import anything — everything an actor needs is provided on its handler context", { path: p });
  }

  const def = ast.body.find((n) => n.type === "ExportDefaultDeclaration");
  if (!def) return fail("must 'export default async function (ctx) { ... }' — the message handler", { path: p });
  if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(def.declaration.type)) {
    return fail("default export must be a function", { path: p });
  }

  let configNode = null;
  for (const n of ast.body) {
    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations) if (d.id.name === "config") configNode = d.init;
    }
  }
  if (!configNode) return fail("must 'export const config = { access, persist }'", { path: p });
  const config = staticObject(configNode);
  if (!config) return fail("config must be a plain object literal of literal values", { path: p });

  const access = config.access === undefined ? "write" : String(config.access);
  if (!ACTOR_ACCESS.includes(access)) {
    return fail(`declares access '${config.access}' which is not an actor permission (${ACTOR_ACCESS.join(", ")})`, { path: p, access: config.access });
  }
  if (config.persist !== undefined && typeof config.persist !== "boolean") return fail("config.persist must be a boolean", { path: p });
  if (config.events !== undefined && typeof config.events !== "boolean") return fail("config.events must be a boolean", { path: p });
  if (config.description !== undefined && typeof config.description !== "string") return fail("config.description must be a string", { path: p });

  return {
    ok: true, ast,
    actor: {
      name, path: p,
      access,
      capability: ACTOR_CAPABILITY[access],
      persist: config.persist !== false,
      events: config.events !== false,
      description: String(config.description || ""),
    },
  };
}

/** Every actor a project declares. Malformed documents are reported, never skipped. */
export function collectActors(files) {
  const actors = [];
  const errors = [];
  for (const f of files || []) {
    if (!isActorFilePath(f.path)) continue;
    const parsed = parseActorDocument(f.path, f.content || "");
    if (parsed.ok) actors.push(parsed.actor);
    else errors.push({ path: f.path, error: `${f.path} ${parsed.error}`, details: parsed.details || {} });
  }
  actors.sort((a, b) => a.name.localeCompare(b.name));
  return { actors, errors, count: actors.length };
}

/** Resolves ONE actor from a project's files. `null` when the project does not declare it. */
export function resolveActor(files, name) {
  const file = (files || []).find((f) => f.path === actorFilePath(String(name || "")));
  if (!file) return null;
  const parsed = parseActorDocument(file.path, file.content || "");
  return parsed.ok ? parsed.actor : null;
}