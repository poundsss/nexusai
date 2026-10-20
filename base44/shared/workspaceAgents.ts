// Workspace-level "All Agents" projection (Superagent parity gap #3).
//
// A READ-ONLY list over the EXISTING project-file agent model: the agents are the
// `base44/agents/<name>.jsonc` documents each project already declares, parsed by the
// CERTIFIED agentResource contract (collectAgents) — no second agent model, no schema
// change, no executor change. Malformed documents are REPORTED, never skipped and never
// silently dropped, exactly as collectAgents behaves for the Builder and the runtimes.
//
// Authorization stays with the callers: the HTTP surface resolves the workspace role
// through the EXISTING rbac.resolveRole and refuses a non-member before listing (fail
// closed); this module only projects what the parsed documents already contain.
import { collectAgents } from "./agentResource.ts";
import { isAgentFilePath } from "./base44Layout.ts";
import { unpackFileRecords } from "./blobStore.ts";
import { audit } from "./authz.ts";

const PROJECT_LIMIT = 100; // bounded: the workspace's most recently updated projects
const FILE_FETCH_LIMIT = 500; // same bound loadProjectState uses

/** The UI projection of ONE parsed agent — only fields the document already carries. */
const projectAgent = (a, project) => ({
  name: a.name,
  display_name: a.display_name || a.name,
  description: a.description || "",
  path: a.path,
  tools: a.tools || [],
  tool_configs: a.tool_configs || [],
  skills: a.skills || [],
  selected_skill_names: a.selected_skill_names || [],
  connectors: a.connectors || [],
  context_files: a.context_files || [],
  memory_enabled: a.memory_config ? a.memory_config.enabled !== false : true,
  memory_scope: a.memory_config?.scope || "both",
  allow_anonymous_access: a.allow_anonymous_access === true,
  model: a.model || null,
  model_tier: a.model_tier || null,
  automations_model: a.automations_model || null,
  max_steps: a.max_steps ?? null,
  instructions: a.instructions || "",
  memory_instructions: a.memory_config?.instructions || "",
  project_id: project.id,
  project_name: project.name || null,
});

/**
 * Lists every declared agent across the authorized workspace's projects.
 * `workspace` and the user's membership are verified by the caller.
 */
export async function listWorkspaceAgents(svc, workspace, _user) {
  const projects = (await svc.entities.Project.filter({ workspace_id: workspace.id }, "-updated_date", PROJECT_LIMIT).catch(() => []))
    .filter((p) => p.status !== "archived");
  const agents = [];
  const validation_errors = [];
  let projects_with_agents = 0;

  for (const project of projects) {
    const files = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", FILE_FETCH_LIMIT).catch(() => []);
    const agentFiles = (files || []).filter((f) => isAgentFilePath(f.path));
    if (!agentFiles.length) continue;
    projects_with_agents += 1;
    // Oversized content lives in storage — hydrate before parsing, exactly like loadProjectState.
    const hydrated = await unpackFileRecords(agentFiles);
    const { agents: parsed, errors } = collectAgents(hydrated);
    for (const e of errors) {
      validation_errors.push({ project_id: project.id, project_name: project.name || null, path: e.path, error: String(e.error || "").slice(0, 300) });
    }
    for (const a of parsed) {
      agents.push({ ...projectAgent(a, project), updated_at: agentFiles.find((f) => f.path === a.path)?.updated_date || null });
    }
  }

  agents.sort((x, y) =>
    (x.project_name || "").localeCompare(y.project_name || "") || x.name.localeCompare(y.name));

  await audit(svc, {
    workspace_id: workspace.id, project_id: null, user_id: null,
    action: "agents.workspace_listed", resource: "Workspace", resource_id: workspace.id,
    metadata: { agents: agents.length, projects_with_agents, projects: projects.length },
  }).catch(() => {});

  return {
    workspace_id: workspace.id,
    count: agents.length,
    projects_scanned: projects.length,
    projects_with_agents,
    agents,
    validation_errors,
  };
}