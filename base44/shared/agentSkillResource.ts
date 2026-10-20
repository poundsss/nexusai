// THE agent-skill resource contract (E11).
//
// One flat document per skill: `base44/agent-skills/<name>.md`, a Markdown document with a
// YAML frontmatter header — the FILE NAME (without `.md`) being the skill's identity. A skill is
// versioned,
// reviewable GUIDANCE an agent may be associated with; it grants no tool, holds no state and
// executes nothing. Tool authority lives entirely in the agent's own grants (shared/agentResource
// .ts) and the platform's permission model, so associating a skill can never widen what a run
// may do. The frontmatter is read with the EXISTING YAML reader (shared/yaml.ts).
import { isAgentSkillFilePath, agentSkillNameFromPath, agentSkillFilePath, RESOURCE_NAME_RE } from "./base44Layout.ts";
import { parseYaml } from "./yaml.ts";

export { isAgentSkillFilePath, agentSkillNameFromPath, agentSkillFilePath };

// DOCUMENTED (Base44) per-app limit: an app may declare at most 100 Agent Skills. The
// platform's behavior above the limit is NOT published (fail-closed build vs refusal vs
// truncation — UNKNOWN), so this runtime fails closed at validation time and never
// silently drops skills. Counts VALID canonical skills; malformed documents are reported
// by their own errors and do not count toward the limit.
export const MAX_SKILLS_PER_APP = 100;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
// Documented (Base44) limits: the when-to-apply description and the guidance body.
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_BODY_CHARS = 15000;

const fail = (error, details = {}) => ({ ok: false, error, details });

/** Parses ONE skill document. The PATH decides the skill's identity. */
export function parseAgentSkillDocument(path, text) {
  const p = String(path || "");
  if (!isAgentSkillFilePath(p)) return fail("is not a canonical agent-skill path (expected base44/agent-skills/<name>.md)", { path: p });
  const identity = agentSkillNameFromPath(p);
  if (!RESOURCE_NAME_RE.test(identity)) return fail(`has an invalid agent-skill name '${identity}' (lower-case letters, numbers and dashes)`, { path: p });

  const raw = String(text ?? "");
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return fail("must begin with a YAML frontmatter block delimited by --- lines, followed by the skill guidance in Markdown", { path: p });

  let meta;
  try { meta = parseYaml(m[1]); } catch (e) { return fail(`has invalid YAML frontmatter: ${e.message}`, { path: p }); }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return fail("frontmatter must be a YAML mapping", { path: p });

  if (meta.name != null) {
    if (typeof meta.name !== "string") return fail("frontmatter 'name' must be a string", { path: p });
    if (meta.name !== identity) return fail(`declares skill '${meta.name}' but its file name says '${identity}'`, { path: p, declared_name: meta.name, expected_name: identity });
  }
  if (typeof meta.description !== "string" || !meta.description.trim()) {
    return fail("frontmatter must declare a non-empty 'description' — it is what tells an agent when the skill applies", { path: p });
  }
  if (meta.description.length > MAX_DESCRIPTION_CHARS) {
    return fail(`has a 'description' of ${meta.description.length} characters (limit ${MAX_DESCRIPTION_CHARS})`, { path: p });
  }
  if (meta.version != null && typeof meta.version !== "string" && typeof meta.version !== "number") return fail("frontmatter 'version' must be a string or number", { path: p });
  if (meta.tags != null && !Array.isArray(meta.tags)) return fail("frontmatter 'tags' must be a list", { path: p });

  const body = String(m[2] || "").trim();
  if (!body) return fail("has no guidance body below the frontmatter — a skill with no content teaches nothing", { path: p });
  if (body.length > MAX_BODY_CHARS) return fail(`has a guidance body of ${body.length} characters (limit ${MAX_BODY_CHARS})`, { path: p });

  return {
    ok: true,
    skill: {
      name: identity, path: p,
      title: typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : identity,
      description: meta.description.trim(),
      version: meta.version != null ? String(meta.version) : "1",
      tags: (meta.tags || []).map(String),
      body,
    },
  };
}

/** The canonical document text of one skill. */
export function agentSkillDocumentContent(skill) {
  const s = skill || {};
  return [
    "---",
    `name: ${s.name}`,
    ...(s.title && s.title !== s.name ? [`title: ${s.title}`] : []),
    `description: ${String(s.description || "").replace(/[\r\n]+/g, " ")}`,
    `version: "${s.version || "1"}"`,
    ...(s.tags?.length ? [`tags: [${s.tags.join(", ")}]`] : []),
    "---",
    "",
    String(s.body || "").trim(),
    "",
  ].join("\n");
}

/** Every skill a project declares. Malformed documents are reported, never skipped. */
export function collectAgentSkills(files) {
  const skills = [];
  const errors = [];
  for (const f of files || []) {
    if (!isAgentSkillFilePath(f.path)) continue;
    const parsed = parseAgentSkillDocument(f.path, f.content || "");
    if (parsed.ok) skills.push(parsed.skill);
    else errors.push({ path: f.path, error: `${f.path} ${parsed.error}`, details: parsed.details || {} });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors, count: skills.length };
}

/**
 * AGENT ↔ SKILL resolution: the skills ONE agent is associated with, in declared order, read
 * from the project's own files. A skill the project does not declare is simply absent — the
 * build and the resource sync refuse a dangling reference, so the runtime never invents guidance.
 */
export function resolveAgentSkills(files, agent) {
  const byName = new Map(collectAgentSkills(files).skills.map((s) => [s.name, s]));
  return (agent?.skills || []).map((n) => byName.get(n)).filter(Boolean);
}

/** The resolved skills as the run's own guidance context. */
export function agentSkillsBlock(skills) {
  if (!skills?.length) return "";
  return `SKILLS (versioned project guidance you must follow; they grant no additional tools):
${skills.map((s) => `### skill '${s.name}' v${s.version} — ${s.description}\n${s.body}`).join("\n\n")}`;
}