// Skills (#42): versioned, code-defined specialist modules that sit BETWEEN the Router and the Tool
// boundary — exactly the slot #41 reserved as `skill_strategy` / `skill_profiles`.
//
// A skill is guidance + tool preferences + routing hints for one domain (backend functions,
// integrations, data modelling, design, MCP context, repair). It is:
//   * code-defined and checksummed, like the Model Catalog — deterministic and reviewable;
//   * ADDITIVE to the mode's rules: it never replaces the planner/generator contracts;
//   * NEVER a permission: a skill may only PREFER tools the mode already allows. The contract check
//     fails closed on a skill naming an unknown tool or one its modes cannot use, so a skill can
//     never widen the Tool Router's authorization;
//   * selected deterministically from the request (mode, prompt, project paths, signals), and the
//     resulting strategy is recorded on the routing decision the run already persists.
import { TOOL_REGISTRY, allowedTools } from "./tools.ts";
import { hash } from "./routingPolicy.ts";

export const SKILL_CONTRACT_VERSION = "1.0.0";
export const SKILL_PHASES = ["planner", "generator", "repair"];

const fail = (status, code, message, detail = {}) => { throw Object.assign(new Error(message), { status, code, detail }); };

// --- catalog ---------------------------------------------------------------------

export const SKILL_CATALOG = [
  {
    skill_id: "backend-functions", version: "1.0.0", title: "Backend functions",
    description: "Server-side handlers: secrets, http, integrations, webhooks and the enforced language subset.",
    modes: ["default"],
    triggers: { prompt: [/\b(backend|server[- ]?side|api|endpoint|webhook|secret|credential|api[ _-]?key|cron|external service)\b/i], paths: [/^functions\//] },
    tools: ["list_functions", "list_secrets", "declare_secret", "write_file", "patch_file", "replace_symbol"],
    routing: { needs_structured_output: true },
    guidance: {
      planner: "Anything touching a credential, an external API or a webhook is a backend function at functions/<name>.js — never frontend code. Declare every needed secret by NAME under 'secrets'. One function per file; the frontend calls it as server.<name>(payload).",
      generator: "Export `config` ({ method, webhook, secrets, description }) and a default async handler(ctx). Read credentials only with secrets.get(NAME) from config.secrets. Return { status, body } and a SAFE subset of any upstream response. Respect the backend language subset: no imports, classes, generators or labelled loops. A webhook handler verifies the request BEFORE touching db.",
      repair: "For a failing backend function: confirm `export const config` exists, every secrets.get(NAME) is listed in config.secrets, no import statements or classes are present, and every code path returns { status, body }.",
    },
  },
  {
    skill_id: "integrations", version: "1.0.0", title: "External integrations",
    description: "Declaring and consuming http/openapi/mcp integrations through the integration tools.",
    modes: ["default"],
    triggers: { prompt: [/\b(integrat\w*|openapi|swagger|rest api|third[- ]party|stripe|slack|github|hubspot|salesforce|sendgrid|twilio|weather api)\b/i], paths: [/^integrations\//] },
    tools: ["list_integrations", "get_integration", "list_operations", "get_operation", "create_integration", "update_integration", "import_openapi"],
    routing: { needs_structured_output: true },
    guidance: {
      planner: "Declare every external API under 'integrations' (name, base_url or server_url, auth by secret NAME, operations) and reuse an existing one when it already covers the API; when changing one return its FULL definition. Never hand-write integrations/*.json and never list it in the manifest.",
      generator: "Call an integration only from a backend function as integrations.<name>.<operation>(params, { body }) with exactly the declared operation names. Do not add auth headers yourself and do not put the integration's secret in config.secrets. Catch IntegrationError when a custom response is needed.",
      repair: "An unknown integration or operation error means the call site and the declared definition disagree: fix the operation name or update the integration definition, never bypass it with a raw http() call carrying a credential.",
    },
  },
  {
    skill_id: "data-modeling", version: "1.0.0", title: "Data modelling",
    description: "Entity design and db access patterns for the generated app.",
    modes: ["default"],
    triggers: { prompt: [/\b(entit(y|ies)|table|record|field|database|schema|store|save|track|list of|crud)\b/i], signals: ["entities_present"] },
    tools: ["create_entity", "update_entity", "get_project_state"],
    routing: { needs_structured_output: true },
    guidance: {
      planner: "Every db.X used anywhere must appear in 'entities' with a NON-EMPTY fields list ([{ name, type, required }]); enum fields carry their values. Prefer extending an existing entity over creating a near-duplicate. Names are PascalCase.",
      generator: "Use only entities and field names from ENTITIES, exactly. Use bulk operations for sets of records, filter operators ($contains, $in, $gt…) instead of client-side filtering, and handle the empty state of every list.",
      repair: "A field-not-found or unknown-entity error is fixed by aligning the code with ENTITIES (or declaring the entity with create_entity/update_entity) — never by guessing a field name.",
    },
  },
  {
    skill_id: "design-system", version: "1.0.0", title: "Design system",
    description: "Token-driven visual changes and accessibility rules.",
    modes: ["default"],
    triggers: { prompt: [/\b(design|theme|colou?r|dark mode|font|typograph\w*|style|look and feel|layout|spacing|responsive|modern|premium|brand)\b/i], paths: [/^styles\.css$/] },
    tools: ["write_file", "patch_file", "apply_patches"],
    routing: {},
    guidance: {
      planner: "Express visual requests as a 'design' token patch — only the tokens that change. Never list styles.css in the manifest and never plan one-off CSS. Reuse EXISTING REUSABLE COMPONENTS before adding a new one.",
      generator: "Style with the DESIGN SYSTEM component classes and CSS variables; Tailwind utilities only for layout/spacing. No hardcoded colours, no arbitrary values, no inline visual styles, no font-family. Mobile-first stacking, labelled inputs, alt text, real <button> elements.",
      repair: "A design/accessibility violation is fixed by replacing the hardcoded value with the token or component class, or by adding the missing label/alt/button semantics — never by disabling the check.",
    },
  },
  {
    skill_id: "mcp-context", version: "1.0.0", title: "MCP context",
    description: "Fetching real external data through the account's MCP connections before planning or answering.",
    modes: ["default", "discuss"],
    triggers: { prompt: [/\b(issue|ticket|pull request|pr|docs?|notion|jira|linear|confluence|repo\w*|board|from (our|the) (crm|tracker|wiki))\b/i], signals: ["mcp_tools_available"] },
    tools: ["list_mcp_connections", "mcp_call"],
    routing: { needs_tools: true },
    guidance: {
      planner: "When the request depends on data that lives on a connected MCP server, fetch it with read_action { tool: 'mcp_call', input: { connection, tool, arguments_json } } and request_more_context=true BEFORE planning. Never invent external data, and never turn an MCP connection into a project integration or generated code.",
      generator: "MCP results are builder context only. Generated app code never calls an MCP server; if the deployed app needs the data at runtime, it goes through a declared integration and a backend function.",
      repair: "MCP tools are not available during repair; fix the build from the project state alone.",
    },
  },
  {
    skill_id: "build-repair", version: "1.0.0", title: "Build repair",
    description: "Bounded, precise repair of a failing build using structural edit tools.",
    modes: ["default"],
    triggers: { phases: ["repair"] },
    tools: ["patch_file", "apply_patches", "replace_symbol", "replace_range", "insert_at", "write_file"],
    routing: { needs_structured_output: true },
    guidance: {
      planner: "",
      generator: "",
      repair: "Fix ONLY what the build log reports. Prefer apply_patches/replace_symbol/replace_range with anchors copied verbatim from the current content; use write_file only when most of a file must change. Every patch_file call needs both 'find' and 'replace'. Do not touch unrelated files.",
    },
  },
];

// --- contract (fails closed) ---------------------------------------------------------

const TOOL_NAMES = new Set(TOOL_REGISTRY.map((t) => t.name));

/** Content identity of one skill: id + version + everything the model actually receives. */
export const skillChecksum = (s) => hash("skill", {
  contract: SKILL_CONTRACT_VERSION, skill_id: s.skill_id, version: s.version, modes: s.modes, tools: s.tools,
  routing: s.routing || {}, guidance: s.guidance, triggers: { prompt: (s.triggers?.prompt || []).map(String), paths: (s.triggers?.paths || []).map(String), signals: s.triggers?.signals || [], phases: s.triggers?.phases || [] },
});

/**
 * Validates the catalog and returns its public contract. A skill that names a tool the registry
 * does not have, or one that a mode it serves may not use, is REFUSED here — so the catalog cannot
 * ship a skill that would widen the Tool Router's authorization.
 */
export function skillContracts(catalog = SKILL_CATALOG) {
  const seen = new Set();
  return catalog.map((s) => {
    if (!/^[a-z][a-z0-9-]*$/.test(s.skill_id || "")) fail(500, "SKILL_ID_INVALID", `Skill id '${s.skill_id}' must be kebab-case`);
    if (!/^\d+\.\d+\.\d+$/.test(s.version || "")) fail(500, "SKILL_VERSION_INVALID", `Skill '${s.skill_id}' needs a semver version`);
    const key = `${s.skill_id}@${s.version}`;
    if (seen.has(key)) fail(500, "SKILL_DUPLICATE", `Skill ${key} is declared twice`);
    seen.add(key);
    if (!Array.isArray(s.modes) || !s.modes.length || s.modes.some((m) => !["default", "discuss"].includes(m))) fail(500, "SKILL_MODE_INVALID", `Skill '${s.skill_id}' must serve 'default' and/or 'discuss'`);
    for (const t of s.tools || []) {
      if (!TOOL_NAMES.has(t)) fail(500, "SKILL_TOOL_UNKNOWN", `Skill '${s.skill_id}' references unknown tool '${t}'`, { skill_id: s.skill_id, tool: t });
      for (const mode of s.modes) {
        if (!allowedTools(mode).some((x) => x.name === t)) fail(500, "SKILL_TOOL_NOT_IN_MODE", `Skill '${s.skill_id}' prefers tool '${t}', which ${mode} mode may not use`, { skill_id: s.skill_id, tool: t, mode });
      }
    }
    if (!s.guidance || !SKILL_PHASES.every((p) => typeof s.guidance[p] === "string")) fail(500, "SKILL_GUIDANCE_INVALID", `Skill '${s.skill_id}' must declare guidance for ${SKILL_PHASES.join(", ")}`);
    if (!SKILL_PHASES.some((p) => s.guidance[p].trim())) fail(500, "SKILL_GUIDANCE_EMPTY", `Skill '${s.skill_id}' carries no guidance`);
    return {
      skill_id: s.skill_id, version: s.version, title: s.title, description: s.description, modes: s.modes,
      tools: s.tools || [], routing: s.routing || {}, checksum: skillChecksum(s),
      triggers: { prompt: (s.triggers?.prompt || []).map(String), paths: (s.triggers?.paths || []).map(String), signals: s.triggers?.signals || [], phases: s.triggers?.phases || [] },
    };
  });
}

export const skillContract = () => ({ contract_version: SKILL_CONTRACT_VERSION, phases: SKILL_PHASES, skills: skillContracts() });

// --- deterministic selection -----------------------------------------------------------

/** The empty strategy — byte-identical to the slot #41 reserved, so nothing changes when no skill applies. */
export const NO_SKILL_STRATEGY = { strategy_id: null, version: null, source: "none", skills: [] };

/**
 * Selects the skills for one request. Deterministic: catalog order, fixed trigger evaluation, no
 * randomness — the same request always yields the same strategy id. The prompt itself is never
 * stored on the strategy; only which skill matched and by what kind of trigger.
 */
export function selectSkills({ mode = "default", prompt = "", paths = [], phase = "plan", signals = {}, catalog = SKILL_CATALOG } = {}) {
  const text = String(prompt || "");
  const pathList = (Array.isArray(paths) ? paths : []).map(String);
  const picked = [];
  for (const s of catalog) {
    if (!s.modes.includes(mode)) continue;
    const t = s.triggers || {};
    const matched_by = [];
    if ((t.phases || []).includes(phase)) matched_by.push("phase");
    if ((t.prompt || []).some((re) => re.test(text))) matched_by.push("prompt");
    if ((t.paths || []).some((re) => pathList.some((p) => re.test(p)))) matched_by.push("path");
    // A signal-gated skill needs its signal AND a prompt/path/phase match: the mere presence of
    // entities or MCP tools does not load a skill the request did not ask for.
    if ((t.signals || []).length) {
      if (!t.signals.every((sig) => !!signals[sig])) continue;
      if (!matched_by.length) continue;
      matched_by.push("signal");
    }
    if (!matched_by.length) continue;
    picked.push({ skill_id: s.skill_id, version: s.version, checksum: skillChecksum(s), matched_by });
  }
  if (!picked.length) return { ...NO_SKILL_STRATEGY, contract_version: SKILL_CONTRACT_VERSION };
  const ids = picked.map((p) => ({ skill_id: p.skill_id, version: p.version }));
  return {
    strategy_id: hash("skst", { contract: SKILL_CONTRACT_VERSION, mode, skills: ids }),
    version: SKILL_CONTRACT_VERSION, contract_version: SKILL_CONTRACT_VERSION,
    source: "skill_catalog", mode, skills: picked,
  };
}

/** Resolves a persisted strategy back to catalog entries. An unknown id/version is skipped, never guessed. */
export function materializeSkills(strategy, catalog = SKILL_CATALOG) {
  return (strategy?.skills || [])
    .map((ref) => catalog.find((s) => s.skill_id === ref.skill_id && s.version === ref.version) || null)
    .filter(Boolean);
}

/** Tools the strategy PREFERS, intersected with what the mode already allows. Can only narrow, never widen. */
export function skillTools(strategy, mode = "default", catalog = SKILL_CATALOG) {
  const permitted = new Set(allowedTools(mode).map((t) => t.name));
  const names = new Set();
  for (const s of materializeSkills(strategy, catalog)) for (const t of s.tools || []) if (permitted.has(t)) names.add(t);
  return [...names].sort();
}

/**
 * Routing hints a strategy contributes to the router's inputs. Hints only ever TIGHTEN a
 * requirement (a flag becomes true, a minimum rises); a skill cannot relax what the request needs.
 */
export function skillRoutingHints(strategy, inputs = {}, catalog = SKILL_CATALOG) {
  const out = { ...inputs };
  for (const s of materializeSkills(strategy, catalog)) {
    for (const [k, v] of Object.entries(s.routing || {})) {
      if (typeof v === "boolean") out[k] = !!out[k] || v;
      else if (typeof v === "number") out[k] = Math.max(Number(out[k]) || 0, v);
    }
  }
  return out;
}

/** The prompt block for one phase. Empty string when no skill carries guidance for it. */
export function skillGuidanceBlock(strategy, phase = "planner", { mode = "default", catalog = SKILL_CATALOG } = {}) {
  const skills = materializeSkills(strategy, catalog).filter((s) => (s.guidance?.[phase] || "").trim());
  if (!skills.length) return "";
  const tools = skillTools(strategy, mode, catalog);
  return `SKILLS (specialist guidance loaded for this request — additive to the rules above, never a replacement):\n${skills.map((s) => `## ${s.title} (${s.skill_id}@${s.version})\n${s.guidance[phase].trim()}`).join("\n\n")}${tools.length ? `\nPreferred tools for these skills: ${tools.join(", ")}` : ""}`;
}

/** The compact record stored on the routing decision / trajectory: identity only, no prompt text. */
export const skillStrategyRecord = (strategy) => (strategy?.source === "skill_catalog"
  ? { strategy_id: strategy.strategy_id, version: strategy.contract_version, source: "skill_catalog", skills: strategy.skills.map((s) => ({ skill_id: s.skill_id, version: s.version, checksum: s.checksum, matched_by: s.matched_by })) }
  : { ...NO_SKILL_STRATEGY });

// --- Workspace Skills (Phase 16A) --------------------------------------------------------------
//
// DOCUMENTED (Base44): workspace skills are static instruction sets configured per workspace
// (Workspace Settings → Plugins → Skills) that shape how the AI chat builds apps in every app
// of that workspace; a skill can be toggled off without deletion, and a workspace holds at
// most 100 of them; adding one requires a Builder plan or higher. They influence the editor
// chat only — they are never permissions, never live data, and never platform-enforced rules.
//
// This section stores and serves them. Injection is ADDITIVE: enabled skills are appended to
// the code-defined catalog guidance above (never replacing it), validated and bounded before
// they reach a prompt — a malformed or oversized skill is skipped (fail closed) and a failed
// load injects nothing. Discuss-mode and Agent behavior are untouched by design.
import { audit } from "./authz.ts";

export const WORKSPACE_SKILLS_LIMIT = 100;           // DOCUMENTED (Base44)
export const WORKSPACE_SKILL_NAME_CHARS = 80;        // NexusAI-derived label ceiling
export const WORKSPACE_SKILL_DESC_CHARS = 500;       // NexusAI-derived description ceiling
export const WORKSPACE_SKILL_TEXT_CHARS = 20000;     // the same document ceiling agent skills observe
export const WORKSPACE_SKILL_CHARS = 5000;           // NexusAI-derived per-skill excerpt ceiling
export const WORKSPACE_SKILLS_BLOCK_CHARS = 20000;   // the same block ceiling the skills path already observes
// DOCUMENTED (Base44): skills need a Builder plan or higher — the same tier boundary as app connectors.
export const WORKSPACE_SKILLS_MIN_TIER_RANK = 6;
export const planAllowsWorkspaceSkills = (plan) => (plan?.tier_rank || 0) >= WORKSPACE_SKILLS_MIN_TIER_RANK;

export function validWorkspaceSkillRecord(r) {
  return !!(r && typeof r === "object"
    && typeof r.name === "string" && r.name.trim()
    && typeof r.description === "string" && r.description.trim()
    && typeof r.instructions === "string" && r.instructions.trim());
}

/** The credential-free list view (everything on a skill is already static text). */
export const workspaceSkillView = (r) => ({
  id: r.id, workspace_id: r.workspace_id, name: r.name, description: r.description,
  instructions: r.instructions, enabled: r.enabled !== false, created_by: r.created_by || null, created_at: r.created_at || null,
});

/**
 * Loads the workspace's ENABLED skills, oldest first, bounded by the documented limit.
 * Fail closed: any load failure injects nothing (empty list), never a run failure.
 */
export async function loadEnabledWorkspaceSkills(base44, workspace_id) {
  try {
    const rows = await base44.entities.WorkspaceSkill.filter({ workspace_id: String(workspace_id || ""), enabled: true }, "created_date", WORKSPACE_SKILLS_LIMIT);
    return rows.filter(validWorkspaceSkillRecord);
  } catch { return []; }
}

/** The prompt block for the workspace's enabled skills. Empty string when nothing applies. */
export function workspaceSkillsBlock(records) {
  const parts = [];
  let total = 0;
  for (const r of records || []) {
    if (!validWorkspaceSkillRecord(r)) continue; // malformed is never injected
    const part = `## ${r.name.trim()}\n${r.description.trim()}\n${r.instructions.trim().slice(0, WORKSPACE_SKILL_CHARS)}`;
    if (total + part.length > WORKSPACE_SKILLS_BLOCK_CHARS) break; // bounded like every skills block
    parts.push(part); total += part.length;
  }
  if (!parts.length) return "";
  return `WORKSPACE SKILLS (static instructions saved for this workspace — additive to the rules above, never a replacement; they grant no tools and hold no data):\n${parts.join("\n\n")}`;
}

// --- CRUD (workspace-isolated, limit-enforced, audited) -----------------------------------------

const failSkill = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

const skillText = (v, max, label) => {
  const s = String(v ?? "").trim();
  if (!s) failSkill(400, "SKILL_INVALID", `${label} is required`);
  if (s.length > max) failSkill(400, "SKILL_INVALID", `${label} exceeds ${max} characters`);
  return s;
};

export const validatedSkillFields = (body, partial = false) => {
  const out = {};
  if (!partial || body.name !== undefined) out.name = skillText(body.name, WORKSPACE_SKILL_NAME_CHARS, "name");
  if (!partial || body.description !== undefined) out.description = skillText(body.description, WORKSPACE_SKILL_DESC_CHARS, "description");
  if (!partial || body.instructions !== undefined) out.instructions = skillText(body.instructions, WORKSPACE_SKILL_TEXT_CHARS, "instructions");
  return out;
};

const auditWorkspaceSkill = (svc, { workspace_id, user_id, action, resource_id, metadata }) =>
  audit(svc, { workspace_id, user_id, action, resource: "WorkspaceSkill", resource_id, metadata: metadata || {} }).catch(() => {});

export async function listWorkspaceSkills(svc, { workspace_id }) {
  const rows = await svc.entities.WorkspaceSkill.filter({ workspace_id: String(workspace_id || "") }, "-created_date", WORKSPACE_SKILLS_LIMIT);
  return rows.map(workspaceSkillView);
}

export async function createWorkspaceSkill(svc, { workspace_id, name, description, instructions, enabled = true, created_by }) {
  const fields = validatedSkillFields({ name, description, instructions });
  const existing = await svc.entities.WorkspaceSkill.filter({ workspace_id: String(workspace_id || "") }, "created_date", WORKSPACE_SKILLS_LIMIT);
  if (existing.length >= WORKSPACE_SKILLS_LIMIT) failSkill(403, "WORKSPACE_SKILLS_LIMIT", `A workspace can hold at most ${WORKSPACE_SKILLS_LIMIT} skills`);
  const record = await svc.entities.WorkspaceSkill.create({ workspace_id: String(workspace_id), ...fields, enabled: enabled !== false, created_by: created_by || null, created_at: new Date().toISOString() });
  await auditWorkspaceSkill(svc, { workspace_id, user_id: created_by, action: "workspace_skill.created", resource_id: record.id, metadata: { name: record.name, enabled: record.enabled } });
  return record;
}

async function workspaceSkillFor(svc, { workspace_id, skill_id }) {
  const row = await svc.entities.WorkspaceSkill.get(String(skill_id || "")).catch(() => null);
  if (!row || row.workspace_id !== String(workspace_id)) failSkill(404, "WORKSPACE_SKILL_NOT_FOUND", "Skill not found in this workspace");
  return row;
}

export async function updateWorkspaceSkill(svc, { workspace_id, skill_id, patch = {}, updated_by }) {
  const row = await workspaceSkillFor(svc, { workspace_id, skill_id });
  const update = validatedSkillFields(patch, true);
  if (patch.enabled !== undefined) update.enabled = patch.enabled === true;
  const record = await svc.entities.WorkspaceSkill.update(row.id, update);
  await auditWorkspaceSkill(svc, { workspace_id, user_id: updated_by, action: "workspace_skill.updated", resource_id: record.id, metadata: { name: record.name, enabled: record.enabled !== false, fields: Object.keys(update) } });
  return record;
}

export async function deleteWorkspaceSkill(svc, { workspace_id, skill_id, deleted_by }) {
  const row = await workspaceSkillFor(svc, { workspace_id, skill_id });
  await svc.entities.WorkspaceSkill.delete(row.id);
  await auditWorkspaceSkill(svc, { workspace_id, user_id: deleted_by, action: "workspace_skill.deleted", resource_id: row.id, metadata: { name: row.name } });
  return { deleted: true };
}