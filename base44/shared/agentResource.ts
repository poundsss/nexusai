// THE agent resource contract (E9) and the agent tool-permission model (E10).
//
// One declared agent per file: `base44/agents/<name>.jsonc`, the FILE NAME being the agent's
// identity. This module owns the DOCUMENT and the GATE, nothing else:
//   • the document is parsed with the EXISTING JSONC reader (base44Layout.parseJsonc);
//   • a tool grant is checked against the EXISTING tool registry (shared/tools.ts) — no second
//     catalogue exists, so an agent can never be granted a tool the platform does not have, and
//     `system` tools (the platform issues those) can never be granted at all;
//   • the gate is a pure function the callers apply BEFORE execution (shared/agentLoop.ts).
// It runs no agent, executes no tool and holds no state.
//
// FAIL CLOSED: an agent that declares no `tools` is granted NOTHING. An agent is a RESTRICTION of
// the platform's permission model, never an expansion: the gate is applied AFTER the caller's
// role and mode checks, so a grant can only narrow what the human behind the run may do.
import { parseJsonc, isAgentFilePath, agentNameFromPath, agentFilePath, RESOURCE_NAME_RE, isContextFilePath, CONNECTOR_NAME_RE, connectorFilePath } from "./base44Layout.ts";
import { TOOL_REGISTRY } from "./tools.ts";
import { agentSkillFilePath } from "./agentSkillResource.ts";
// P-9.11A: a tool_configs function grant is cross-checked against the project's own function
// files — the same cross-resource pattern skills use. Entity declarations are rows, not files,
// so an entity grant's existence is checked against the caller-supplied entity names at build
// time and fail-closed against the deployment payload at run time.
import { isFunctionPath, functionNameFromPath, FUNCTION_NAME_RE } from "./functionPaths.ts";

/** Tool permission classes an agent MAY be granted. `system` is platform-issued and never granted. */
export const GRANTABLE_PERMISSIONS = ["read", "write", "dangerous"];
export const GRANTABLE_TOOLS = TOOL_REGISTRY.filter((t) => GRANTABLE_PERMISSIONS.includes(t.permission)).map((t) => t.name);
const PERMISSION_OF = new Map(TOOL_REGISTRY.map((t) => [t.name, t.permission]));

export const AGENT_TIERS = ["fast", "standard", "advanced"];
export const MAX_AGENT_STEPS = 60;
// P-9.10A: the agent's Telegram greeting — an OWNED, validated key (not loose metadata). It
// is delivered on the channel's first contact with an app user, and never carries a credential.
export const TELEGRAM_GREETING_MAX_CHARS = 500;
// P-9.10C: the agent's WhatsApp greeting — the same owned, validated channel-key convention.
// Base44 documents the key but publishes no max length for it; the platform's own 500-char
// channel-greeting convention is mirrored here. It never carries a credential.
export const WHATSAPP_GREETING_MAX_CHARS = 500;
// P-9.11B: Base44's documented agent memory contract —
//   memory_config: { enabled (default true), scope: "global" | "user" | "both" (default "both"),
//                    include_other_conversation_context (default false), instructions (string | null) }
// The default is PARITY: an agent that declares no memory_config at all is normalized to memory
// ENABLED with the documented defaults — no stored record is rewritten, the default applies
// purely through parse/normalize (so already-deployed artifacts gain the behavior on read).
// Base44 publishes the SHAPE, not: its storage layout, its save mechanism or a memory tariff.
// Those stay UNKNOWN — never guessed: the entries keep the document's own field names, the
// cap below is this platform's own bound, and no rate lives here.
export const MEMORY_CONFIG_SCOPES = ["global", "user", "both"];
export const MEMORY_CONFIG_INSTRUCTIONS_MAX_CHARS = 500;
export const DEFAULT_MEMORY_CONFIG = { enabled: true, scope: "both", include_other_conversation_context: false, instructions: null };
// P-9.11A: Base44's documented agent tool contract —
//   tool_configs: [ { entity_name, allowed_operations: ["create","read","update","delete"] },
//                   { function_name, description } ]
// Base44 publishes the SHAPE, not: its auto-generated tool-name grammar, its tool-count cap or
// its function-call tariff. Those stay UNKNOWN — never guessed: the entries keep the document's
// own names, the cap below is this platform's own bound, and no rate lives here.
export const TOOL_CONFIG_OPERATIONS = ["create", "read", "update", "delete"];
export const MAX_TOOL_CONFIGS = 25;
export const TOOL_CONFIG_DESC_MAX_CHARS = 500;
const ENTITY_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// P-9.11D: Base44's documented agent context-file contract —
//   context_files: [ "<canonical base44/context/ file path>", ... ]
// VERIFIED (docs.base44.com, in-app agents · Guidelines, and the product changelog): up to
// 10 files of reference material the agent uses to answer questions, configured per agent
// under Guidelines ("Upload files" / "Choose from library"). Base44 publishes the COUNT, not:
// which file types are allowed, a per-file size cap, the injection mechanism, its storage
// layout, its "library" internals or a context-file tariff. Those stay UNKNOWN — never
// guessed: entries keep the project's own canonical path form, the per-file cap below is
// this platform's own bound, injection is a bounded block (appAgentRuntime) and no rate
// lives here.
export const MAX_CONTEXT_FILES = 10;
export const CONTEXT_FILE_MAX_CHARS = 50000;
// P-9.11J: Base44's documented in-app agent skill selection —
//   selected_skill_names: [ "<agent-skill name>", ... ]
// VERIFIED (docs.base44.com, in-app agents · Skills): an in-app agent may have up to 10 skills
// selected from the project's skill library. Base44 publishes the FIELD and the MAXIMUM, not:
// any builder-loop role for the selection, a fallback between this field and any other, or a
// skill tariff. Those stay UNKNOWN — never guessed: no other field's semantics change and no
// rate lives here. Disjoint from the platform's own `skills` field by design: `skills` remains
// the BUILDER agent-loop association exactly as certified (E11), while selected_skill_names is
// consumed only by the deployed in-app agent runtime (P-9.11J) — the two fields have disjoint
// consumers, so coexisting declarations contradict nothing.
export const MAX_SELECTED_SKILLS = 10;
// P-9.11C: Base44's per-agent anonymous-access toggle ("Allow anonymous access", the agent's
// Guidelines tab) — an OWNED, validated boolean key, OFF by default. Base44 publishes the
// toggle, the off-by-default state and the private-data restriction; the anonymous visitor's
// persistence semantics stay UNKNOWN and are never guessed here.
// P-9.11K: Base44's documented agent-scoped user connectors (the agent's Connectors tab toggle):
//   connectors: [ "<connector name>", ... ]
// VERIFIED (docs.base44.com, in-app agents · Connectors): a connector already registered in the
// workspace is toggled ON per agent, and the agent can then create OAuth connect links so each
// app user authorizes their OWN account in that service. Base44 publishes the BEHAVIOR, not:
// the agent-document field name, a per-agent cap, per-agent scope overrides or the link
// mechanism. Those stay UNKNOWN — never guessed: the entries keep the platform's own
// lowerCamelCase connector-name grammar, the cap below is this platform's own bound (mirroring
// the MAX_CONTEXT_FILES / MAX_SELECTED_SKILLS convention), and an entry is a NAME ONLY —
// scopes stay authoritative in the connector resource, so no scope override key exists here
// and none can be invented. Existence in the project's own connector registry is cross-checked
// at build time (validateAgentReferences) and fail-closed against the deployment payload at
// run time.
export const MAX_AGENT_CONNECTORS = 10;
// Superagent parity: the agent's AUTOMATIONS model — the model its SCHEDULED (background) runs
// are pinned to, overriding the General model for those runs only. Shape is validated here;
// catalog membership and plan inclusion are checked at editor-save time and re-checked
// fail-closed at run time.
export const AUTOMATIONS_MODEL_MAX_CHARS = 120;
// Superagent parity: Base44's documented cross-app access — a list of project ids of OTHER apps
// in the SAME workspace whose data the agent may READ through the read_app_data tool. A grant is
// a narrowing of the workspace scope, never an expansion: the tool only ever reads.
export const MAX_CROSS_APP_PROJECTS = 25;
const OWNED_KEYS = ["name", "display_name", "description", "instructions", "tools", "skills", "model_tier", "max_steps", "telegram_greeting", "whatsapp_greeting", "tool_configs", "context_files", "memory_config", "allow_anonymous_access", "selected_skill_names", "model", "connectors", "automations_model", "cross_app_access"];

const fail = (error, details = {}) => ({ ok: false, error, details });

/** Parses ONE agent document. `path` decides the agent's identity. */
export function parseAgentDocument(path, text) {
  const p = String(path || "");
  if (!isAgentFilePath(p)) return fail("is not a canonical agent path (expected base44/agents/<name>.jsonc)", { path: p });
  const identity = agentNameFromPath(p);
  let doc;
  try { doc = parseJsonc(text); } catch (e) { return fail(`is not valid JSONC: ${e.message}`, { path: p }); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail("must be a JSON object", { path: p });

  if (doc.name != null) {
    if (typeof doc.name !== "string") return fail("'name' must be a string", { path: p });
    if (doc.name !== identity) return fail(`declares agent '${doc.name}' but its file name says '${identity}'`, { path: p, declared_name: doc.name, expected_name: identity });
  }
  if (!RESOURCE_NAME_RE.test(identity)) return fail(`has an invalid agent name '${identity}' (lower-case letters, numbers and dashes)`, { path: p });
  if (typeof doc.instructions !== "string" || !doc.instructions.trim()) {
    return fail("must declare a non-empty string 'instructions' — an agent with no instructions has no behaviour", { path: p });
  }
  if (doc.description != null && typeof doc.description !== "string") return fail("'description' must be a string", { path: p });
  if (doc.display_name != null && typeof doc.display_name !== "string") return fail("'display_name' must be a string", { path: p });
  // P-9.10A: an owned channel key, validated like every other owned key. Channel-specific keys
  // the platform does not know keep flowing through metadata untouched.
  if (doc.telegram_greeting != null) {
    if (typeof doc.telegram_greeting !== "string") return fail("'telegram_greeting' must be a string", { path: p });
    if (doc.telegram_greeting.length > TELEGRAM_GREETING_MAX_CHARS) return fail(`'telegram_greeting' must be at most ${TELEGRAM_GREETING_MAX_CHARS} characters`, { path: p });
  }
  // P-9.10C: validated like every other owned channel key; unknown channel-specific keys keep
  // flowing through metadata untouched.
  if (doc.whatsapp_greeting != null) {
    if (typeof doc.whatsapp_greeting !== "string") return fail("'whatsapp_greeting' must be a string", { path: p });
    if (doc.whatsapp_greeting.length > WHATSAPP_GREETING_MAX_CHARS) return fail(`'whatsapp_greeting' must be at most ${WHATSAPP_GREETING_MAX_CHARS} characters`, { path: p });
  }

  // P-9.11C: an owned key validated like every other. Fail-closed on a non-boolean; a missing
  // key normalizes to the documented default (OFF), so existing agent documents — including
  // artifacts deployed before this capability — keep their exact fail-closed behavior.
  if (doc.allow_anonymous_access != null && typeof doc.allow_anonymous_access !== "boolean") {
    return fail("'allow_anonymous_access' must be a boolean", { path: p });
  }

  // P-9.11B: memory_config — Base44's documented agent memory key, an OWNED key validated like
  // every other. Fail-closed: a malformed value, an unknown scope or an oversized instructions
  // string refuses the whole document. A missing field takes the documented default, and an
  // ABSENT memory_config normalizes to the full documented default (memory enabled) — this is
  // read/normalize behavior only, never a migration of stored records.
  if (doc.memory_config != null && (typeof doc.memory_config !== "object" || Array.isArray(doc.memory_config))) {
    return fail("'memory_config' must be an object", { path: p });
  }
  const memoryConfig = { ...DEFAULT_MEMORY_CONFIG };
  if (doc.memory_config) {
    const mc = doc.memory_config;
    if (mc.enabled != null && typeof mc.enabled !== "boolean") return fail("'memory_config.enabled' must be a boolean", { path: p });
    if (mc.scope != null && !MEMORY_CONFIG_SCOPES.includes(mc.scope)) return fail(`'memory_config.scope' must be one of ${MEMORY_CONFIG_SCOPES.join(", ")}`, { path: p });
    if (mc.include_other_conversation_context != null && typeof mc.include_other_conversation_context !== "boolean") return fail("'memory_config.include_other_conversation_context' must be a boolean", { path: p });
    if (mc.instructions != null && typeof mc.instructions !== "string") return fail("'memory_config.instructions' must be a string or null", { path: p });
    if (typeof mc.instructions === "string" && mc.instructions.length > MEMORY_CONFIG_INSTRUCTIONS_MAX_CHARS) {
      return fail(`'memory_config.instructions' must be at most ${MEMORY_CONFIG_INSTRUCTIONS_MAX_CHARS} characters`, { path: p });
    }
    memoryConfig.enabled = mc.enabled != null ? mc.enabled : memoryConfig.enabled;
    memoryConfig.scope = mc.scope != null ? mc.scope : memoryConfig.scope;
    memoryConfig.include_other_conversation_context = mc.include_other_conversation_context != null ? mc.include_other_conversation_context : memoryConfig.include_other_conversation_context;
    memoryConfig.instructions = typeof mc.instructions === "string" && mc.instructions.trim() ? mc.instructions.trim() : null;
  }

  // P-9.11A: tool_configs — Base44's documented agent tool contract, an OWNED key validated
  // like every other owned key. An entry grants EITHER an entity tool (entity_name +
  // allowed_operations ⊆ create/read/update/delete) OR a backend-function tool (function_name +
  // optional description). Fail-closed: an unknown type, an unknown operation, an empty grant
  // or a duplicate declaration refuses the whole document.
  if (doc.tool_configs != null && !Array.isArray(doc.tool_configs)) return fail("'tool_configs' must be an array of tool configuration objects", { path: p });
  if (doc.tool_configs != null && doc.tool_configs.length > MAX_TOOL_CONFIGS) return fail(`'tool_configs' may declare at most ${MAX_TOOL_CONFIGS} tools`, { path: p });
  const toolConfigs = [];
  const seenEntityTool = new Set();
  const seenFunctionTool = new Set();
  for (const [i, tc] of (Array.isArray(doc.tool_configs) ? doc.tool_configs : []).entries()) {
    if (!tc || typeof tc !== "object" || Array.isArray(tc)) return fail(`tool_configs[${i}] must be an object`, { path: p });
    const hasEntity = tc.entity_name != null;
    const hasFunction = tc.function_name != null;
    if (hasEntity === hasFunction) return fail(`tool_configs[${i}] must declare exactly one of 'entity_name' or 'function_name'`, { path: p });
    if (hasEntity) {
      const name = String(tc.entity_name).trim();
      if (!ENTITY_NAME_RE.test(name)) return fail(`tool_configs[${i}]: invalid entity name '${tc.entity_name}'`, { path: p });
      if (seenEntityTool.has(name)) return fail(`'tool_configs' declares entity '${name}' more than once`, { path: p });
      if (!Array.isArray(tc.allowed_operations) || !tc.allowed_operations.length) {
        return fail(`tool_configs[${i}]: entity '${name}' must declare a non-empty 'allowed_operations' array`, { path: p });
      }
      for (const op of tc.allowed_operations) {
        if (!TOOL_CONFIG_OPERATIONS.includes(op)) {
          return fail(`tool_configs[${i}]: unknown operation '${op}' (available: ${TOOL_CONFIG_OPERATIONS.join(", ")})`, { path: p, tool: name, operation: String(op) });
        }
      }
      seenEntityTool.add(name);
      toolConfigs.push({ entity_name: name, allowed_operations: [...new Set(tc.allowed_operations)] });
    } else {
      const name = String(tc.function_name).trim();
      if (!FUNCTION_NAME_RE.test(name)) return fail(`tool_configs[${i}]: invalid function name '${tc.function_name}'`, { path: p });
      if (tc.description != null && typeof tc.description !== "string") return fail(`tool_configs[${i}]: 'description' must be a string`, { path: p });
      if (seenFunctionTool.has(name)) return fail(`'tool_configs' declares function '${name}' more than once`, { path: p });
      seenFunctionTool.add(name);
      toolConfigs.push({ function_name: name, ...(typeof tc.description === "string" && tc.description.trim() ? { description: tc.description.trim().slice(0, TOOL_CONFIG_DESC_MAX_CHARS) } : {}) });
    }
  }

  // P-9.11D: context_files — Base44's documented agent context files (Guidelines · "up to
  // 10 files" of reference material), an OWNED key validated like every other owned key.
  // Fail-closed: a non-array, an invalid path, a duplicate declaration or more than the
  // documented 10 files refuses the whole document.
  if (doc.context_files != null && !Array.isArray(doc.context_files)) return fail("'context_files' must be an array of context file paths", { path: p });
  if (doc.context_files != null && doc.context_files.length > MAX_CONTEXT_FILES) return fail(`'context_files' may declare at most ${MAX_CONTEXT_FILES} files`, { path: p });
  const contextFiles = [];
  for (const [i, cf] of (Array.isArray(doc.context_files) ? doc.context_files : []).entries()) {
    if (typeof cf !== "string" || !cf.trim()) return fail(`context_files[${i}] must be a non-empty context file path`, { path: p });
    const q = cf.trim();
    if (!isContextFilePath(q)) return fail(`context_files[${i}]: invalid context file path '${cf}' (plain files under base44/context/ only)`, { path: p });
    if (contextFiles.includes(q)) return fail(`'context_files' declares '${q}' more than once`, { path: p });
    contextFiles.push(q);
  }

  if (doc.tools != null && !Array.isArray(doc.tools)) return fail("'tools' must be an array of tool names", { path: p });
  const tools = [];
  for (const t of doc.tools || []) {
    if (typeof t !== "string" || !t.trim()) return fail("each entry of 'tools' must be a tool name", { path: p });
    const perm = PERMISSION_OF.get(t);
    if (!perm) return fail(`grants unknown tool '${t}' (available: ${GRANTABLE_TOOLS.join(", ")})`, { path: p, tool: t });
    if (!GRANTABLE_PERMISSIONS.includes(perm)) return fail(`grants '${t}', which is a ${perm} tool the platform issues itself and cannot be granted to an agent`, { path: p, tool: t, permission: perm });
    if (!tools.includes(t)) tools.push(t);
  }

  if (doc.skills != null && !Array.isArray(doc.skills)) return fail("'skills' must be an array of agent-skill names", { path: p });
  const skills = [];
  for (const s of doc.skills || []) {
    if (typeof s !== "string" || !RESOURCE_NAME_RE.test(s)) return fail(`references an invalid agent-skill name '${s}' (lower-case letters, numbers and dashes)`, { path: p, skill: String(s) });
    if (!skills.includes(s)) skills.push(s);
  }

  // P-9.11J: selected_skill_names — Base44's documented in-app skill selection, an OWNED key
  // validated like every other owned key. Fail-closed: a non-array, an invalid name, a
  // duplicate declaration or more than the documented 10 skills refuses the whole document.
  if (doc.selected_skill_names != null && !Array.isArray(doc.selected_skill_names)) return fail("'selected_skill_names' must be an array of agent-skill names", { path: p });
  if (doc.selected_skill_names != null && doc.selected_skill_names.length > MAX_SELECTED_SKILLS) return fail(`'selected_skill_names' may declare at most ${MAX_SELECTED_SKILLS} skills`, { path: p });
  const selectedSkillNames = [];
  for (const s of doc.selected_skill_names || []) {
    if (typeof s !== "string" || !RESOURCE_NAME_RE.test(s)) return fail(`references an invalid agent-skill name '${s}' (lower-case letters, numbers and dashes)`, { path: p, skill: String(s) });
    if (!selectedSkillNames.includes(s)) selectedSkillNames.push(s);
  }

  // P-9.11K: connectors — the agent's ENABLED user-connector allowlist, an OWNED key validated
  // like every other owned key. Fail-closed: a non-array, an invalid connector name, a duplicate
  // declaration or more than the cap refuses the whole document.
  if (doc.connectors != null && !Array.isArray(doc.connectors)) return fail("'connectors' must be an array of connector names", { path: p });
  if (doc.connectors != null && doc.connectors.length > MAX_AGENT_CONNECTORS) return fail(`'connectors' may declare at most ${MAX_AGENT_CONNECTORS} connectors`, { path: p });
  const agentConnectors = [];
  for (const c of doc.connectors || []) {
    if (typeof c !== "string" || !CONNECTOR_NAME_RE.test(c)) return fail(`references an invalid connector name '${c}' (lowerCamelCase, e.g. googleCalendar)`, { path: p, connector: String(c) });
    if (agentConnectors.includes(c)) return fail(`'connectors' declares '${c}' more than once`, { path: p, connector: String(c) });
    agentConnectors.push(c);
  }

  if (doc.model_tier != null && !AGENT_TIERS.includes(doc.model_tier)) return fail(`'model_tier' must be one of ${AGENT_TIERS.join(", ")}`, { path: p });

  // P-9.11N: Base44's documented in-app agent model pin — `model` names THE model the agent
  // runs on. An OWNED key, format-validated here; semantic validation (canonical catalog
  // membership + plan authorization) is fail-closed at RUN time per turn, because what a
  // workspace may run is a runtime truth (the existing getModel / resolveModelAccess
  // contracts). Base44 publishes no alias map, no alias resolution and no pin-fallback
  // semantics (UNKNOWN) — only the EXACT canonical catalog model id is ever accepted. An
  // absent `model` keeps the exact existing model_tier Automatic routing; when both are
  // declared the documented pin wins.
  if (doc.model != null && (typeof doc.model !== "string" || !doc.model.trim())) return fail("'model' must be a non-empty string (a canonical catalog model id)", { path: p });
  if (typeof doc.model === "string" && doc.model.trim().length > 120) return fail("'model' must be at most 120 characters", { path: p });
  const pinnedModel = typeof doc.model === "string" && doc.model.trim() ? doc.model.trim() : null;
  // Superagent parity: an owned key validated like every other. Absent reads as null — the
  // General model applies to scheduled runs too.
  if (doc.automations_model != null && (typeof doc.automations_model !== "string" || !doc.automations_model.trim())) return fail("'automations_model' must be a non-empty string (a canonical catalog model id) or null", { path: p });
  if (typeof doc.automations_model === "string" && doc.automations_model.trim().length > AUTOMATIONS_MODEL_MAX_CHARS) return fail(`'automations_model' must be at most ${AUTOMATIONS_MODEL_MAX_CHARS} characters`, { path: p });
  const automationsModel = typeof doc.automations_model === "string" && doc.automations_model.trim() ? doc.automations_model.trim() : null;
  // Superagent parity: an owned key validated like every other. A grant names the project id of
  // another app in the same workspace; duplicates collapse, garbage entries fail closed.
  if (doc.cross_app_access != null && !Array.isArray(doc.cross_app_access)) return fail("'cross_app_access' must be a list of project ids", { path: p });
  const crossAppAccess = Array.isArray(doc.cross_app_access)
    ? [...new Set(doc.cross_app_access.map((x) => String(x ?? "").trim()).filter(Boolean))]
    : [];
  if (crossAppAccess.length > MAX_CROSS_APP_PROJECTS) return fail(`'cross_app_access' must list at most ${MAX_CROSS_APP_PROJECTS} projects`, { path: p });
  if (crossAppAccess.some((id) => id.length > 100)) return fail("'cross_app_access' entries must each be at most 100 characters", { path: p });
  if (doc.max_steps != null) {
    const n = Number(doc.max_steps);
    if (!Number.isInteger(n) || n < 1 || n > MAX_AGENT_STEPS) return fail(`'max_steps' must be a whole number between 1 and ${MAX_AGENT_STEPS}`, { path: p });
  }

  const extra = Object.fromEntries(Object.entries(doc).filter(([k]) => !OWNED_KEYS.includes(k)));
  return {
    ok: true,
    agent: {
      name: identity, path: p,
      display_name: doc.display_name || identity,
      description: doc.description || "",
      instructions: doc.instructions.trim(),
      tools, skills, connectors: agentConnectors, selected_skill_names: selectedSkillNames,
      model: pinnedModel,
      automations_model: automationsModel,
      ...(crossAppAccess.length ? { cross_app_access: crossAppAccess } : {}),
      model_tier: doc.model_tier || null,
      max_steps: doc.max_steps != null ? Number(doc.max_steps) : null,
      telegram_greeting: doc.telegram_greeting != null ? doc.telegram_greeting.trim() : null,
      whatsapp_greeting: doc.whatsapp_greeting != null ? doc.whatsapp_greeting.trim() : null,
      ...(toolConfigs.length ? { tool_configs: toolConfigs } : {}),
      ...(contextFiles.length ? { context_files: contextFiles } : {}),
      memory_config: memoryConfig,
      allow_anonymous_access: doc.allow_anonymous_access === true,
      metadata: extra,
    },
  };
}

/** The canonical document text of one agent. */
export function agentDocumentContent(agent) {
  const a = agent || {};
  const doc = {
    name: String(a.name),
    ...(a.display_name && a.display_name !== a.name ? { display_name: a.display_name } : {}),
    ...(a.description ? { description: a.description } : {}),
    instructions: String(a.instructions || ""),
    tools: [...(a.tools || [])],
    ...(a.skills?.length ? { skills: [...a.skills] } : {}),
    // P-9.11J: emitted only when declared, so a default agent round-trips with no key and
    // artifacts for projects without skill selections stay byte-identical.
    ...(a.selected_skill_names?.length ? { selected_skill_names: [...a.selected_skill_names] } : {}),
    // P-9.11N: emitted only when declared, so a default agent round-trips with no key and
    // artifacts for projects without pinned models stay byte-identical.
    ...(a.model ? { model: a.model } : {}),
    // Superagent parity: emitted only when declared, so a default agent round-trips with no
    // key and artifacts for projects without an automations pin stay byte-identical.
    ...(a.automations_model ? { automations_model: a.automations_model } : {}),
    // Superagent parity: emitted only when declared, so agents without cross-app grants
    // round-trip byte-identically.
    ...(a.cross_app_access?.length ? { cross_app_access: [...a.cross_app_access] } : {}),
    // P-9.11K: emitted only when declared, so a default agent round-trips with no key and
    // artifacts for projects without connectors stay byte-identical.
    ...(a.connectors?.length ? { connectors: [...a.connectors] } : {}),
    ...(a.model_tier ? { model_tier: a.model_tier } : {}),
    ...(a.max_steps ? { max_steps: a.max_steps } : {}),
    ...(a.metadata || {}),
    ...(a.telegram_greeting ? { telegram_greeting: a.telegram_greeting } : {}),
    ...(a.whatsapp_greeting ? { whatsapp_greeting: a.whatsapp_greeting } : {}),
    ...(a.tool_configs?.length ? { tool_configs: a.tool_configs } : {}),
    // P-9.11D: emitted only when declared, so a default agent round-trips with no key and
    // artifacts for projects without context files stay byte-identical.
    ...(a.context_files?.length ? { context_files: [...a.context_files] } : {}),
    // P-9.11B: always emitted in the canonical form, so the normalized config round-trips and
    // the document states the memory behavior that actually applies.
    memory_config: { ...(a.memory_config || DEFAULT_MEMORY_CONFIG) },
    // P-9.11C: emitted only when ON — a default-off document round-trips with no key, and the
    // normalized false is the documented default either way.
    ...(a.allow_anonymous_access ? { allow_anonymous_access: true } : {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Every agent declared by a project's files. Malformed documents are reported, never skipped. */
export function collectAgents(files) {
  const agents = [];
  const errors = [];
  for (const f of files || []) {
    if (!isAgentFilePath(f.path)) continue;
    const parsed = parseAgentDocument(f.path, f.content || "");
    if (parsed.ok) agents.push(parsed.agent);
    else errors.push({ path: f.path, error: `${f.path} ${parsed.error}`, details: parsed.details || {} });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, errors, count: agents.length };
}

/** Resolves ONE agent from the project's own files. `null` when the project does not declare it. */
export function resolveAgent(files, name) {
  const file = (files || []).find((f) => f.path === agentFilePath(String(name || "")));
  if (!file) return null;
  const parsed = parseAgentDocument(file.path, file.content || "");
  return parsed.ok ? parsed.agent : null;
}

/**
 * Cross-resource check: an agent may only reference a skill the project actually declares.
 * Run against the file set that WILL exist (after a push, or at build time).
 */
export function validateAgentReferences(files, { entityNames = null } = {}) {
  const { agents, errors } = collectAgents(files);
  const present = new Set((files || []).map((f) => f.path));
  const missing = [];
  const missingFunctions = [];
  const missingEntities = [];
  const missingConnectors = [];
  const functionNames = new Set((files || []).filter((f) => isFunctionPath(f.path)).map((f) => functionNameFromPath(f.path)));
  for (const a of agents) {
    // P-9.11J: a selected_skill_names entry is cross-checked EXACTLY like a `skills` entry —
    // against the SAME agent-skill resource storage; there is no second skill subsystem.
    for (const s of [...(a.skills || []), ...(a.selected_skill_names || [])]) {
      const expected = agentSkillFilePath(s);
      if (!present.has(expected)) missing.push({ path: a.path, agent: a.name, skill: s, expected_path: expected });
    }
    // P-9.11A: a tool_configs grant must point at something the project really has. Function
    // declarations are files (the same cross-resource pattern skills use); entity declarations
    // are rows, so the caller supplies the project's entity names — at run time the deployment
    // payload is the fail-closed authority instead.
    for (const tc of a.tool_configs || []) {
      if (tc.function_name && !functionNames.has(tc.function_name)) {
        missingFunctions.push({ path: a.path, agent: a.name, fn: tc.function_name });
      }
      if (tc.entity_name && Array.isArray(entityNames) && !entityNames.includes(tc.entity_name)) {
        missingEntities.push({ path: a.path, agent: a.name, entity: tc.entity_name });
      }
    }
    // P-9.11K: a connectors entry must point at a connector declaration the project really
    // carries — the same cross-resource pattern context files use. A connector that exists only
    // in ANOTHER project's files is indistinguishable from a missing one here; the run-time
    // authority is the deployment payload's own registry, checked fail-closed there.
    for (const c of a.connectors || []) {
      if (!present.has(connectorFilePath(c))) missingConnectors.push({ path: a.path, agent: a.name, connector: c, expected_path: connectorFilePath(c) });
    }
  }
  // P-9.11D: a context-file declaration must point at a file the project really carries,
  // within this platform's own size bound. A path that exists only in ANOTHER project's
  // files is indistinguishable from a missing one here — cross-project references fail
  // closed by construction.
  const contextFileProblems = [];
  for (const a of agents) {
    for (const cf of a.context_files || []) {
      const f = (files || []).find((x) => x.path === cf);
      if (!f) contextFileProblems.push({ path: a.path, agent: a.name, file: cf, reason: "missing" });
      else if (String(f.content || "").length > CONTEXT_FILE_MAX_CHARS) contextFileProblems.push({ path: a.path, agent: a.name, file: cf, reason: "oversized" });
    }
  }
  const allErrors = [
    ...errors,
    ...missing.map((m) => ({ path: m.path, error: `${m.path}: references agent-skill '${m.skill}' but ${m.expected_path} does not exist`, details: m })),
    ...missingFunctions.map((m) => ({ path: m.path, error: `${m.path}: agent declares function tool '${m.fn}' but no backend function of that name exists`, details: m })),
    ...missingEntities.map((m) => ({ path: m.path, error: `${m.path}: agent declares entity tool '${m.entity}' but no entity of that name exists`, details: m })),
    ...missingConnectors.map((m) => ({ path: m.path, error: `${m.path}: agent enables connector '${m.connector}' but ${m.expected_path} does not exist`, details: m })),
    ...contextFileProblems.map((m) => ({ path: m.path, error: m.reason === "missing"
      ? `${m.path}: agent declares context file '${m.file}' but ${m.file} does not exist in this project`
      : `${m.path}: context file '${m.file}' exceeds ${CONTEXT_FILE_MAX_CHARS} characters`, details: m })),
  ];
  return { ok: allErrors.length === 0, agents, missing, missingFunctions, missingEntities, missingConnectors, contextFileProblems, errors: allErrors };
}

/**
 * THE agent tool-permission gate (E10), applied BEFORE a tool executes. A pure decision over
 * the agent's declared grants; `null` (no agent) means the platform's default posture.
 */
export function agentPermissionGate(agent) {
  if (!agent) return null;
  const granted = new Set(agent.tools || []);
  const gate = (toolName) => {
    const name = String(toolName || "");
    const permission = PERMISSION_OF.get(name) || null;
    // Platform-issued tools are outside the agent's grant model: the platform runs the build,
    // snapshot and restore itself, and an agent neither needs nor can be given them.
    if (permission && !GRANTABLE_PERMISSIONS.includes(permission)) return { allowed: true, tool: name, permission, platform: true };
    if (granted.has(name)) return { allowed: true, tool: name, permission };
    return {
      allowed: false, tool: name, permission,
      code: "AGENT_TOOL_NOT_GRANTED",
      reason: `agent '${agent.name}' is not granted the tool '${name}' (granted: ${[...granted].join(", ") || "none"})`,
    };
  };
  gate.agent_name = agent.name;
  gate.granted = [...granted];
  gate.canWrite = [...granted].some((t) => ["write", "dangerous"].includes(PERMISSION_OF.get(t)));
  return gate;
}

/** The agent's declaration as the run's own system context. */
export function agentContextBlock(agent, skillsBlock = "") {
  if (!agent) return "";
  return `YOU ARE THE PROJECT'S DECLARED AGENT '${agent.name}'${agent.display_name !== agent.name ? ` (${agent.display_name})` : ""}.
${agent.description ? `${agent.description}\n` : ""}
AGENT INSTRUCTIONS (authoritative for this run):
${agent.instructions}

TOOLS YOU ARE GRANTED (any other tool is refused before it runs, so do not attempt one):
${agent.tools.length ? agent.tools.map((t) => `- ${t}`).join("\n") : "- none"}${skillsBlock ? `\n\n${skillsBlock}` : ""}`;
}