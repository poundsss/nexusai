// Architecture Intelligence — canonical resource declarations, read for the graph.
//
// Pure and synchronous. It asks each EXISTING resource contract to parse the project's own files
// and hands the parsed declarations to the graph. Nothing here owns a format: a malformed document
// is the build's business and simply contributes no node, so the graph can only describe resources
// that actually exist. Secret VALUES, agent instructions and skill bodies never leave this function.
import { validateConfigDocument, isConfigPath } from "./base44Layout.ts";
import { readAppConfig, collectAssets, resolvePlugins } from "./appResource.ts";
import { collectAgents } from "./agentResource.ts";
import { collectAgentSkills } from "./agentSkillResource.ts";
import { collectConnectors } from "./connectorResource.ts";
import { collectActors } from "./actorResource.ts";
import { collectWorkflowFiles, parseWorkflowDocument } from "./workflowResource.ts";

const RESOURCE_DIR_KEYS = ["entities", "functions", "actors", "agents", "agent_skills", "connectors", "workflows", "assets", "types"];
const ANALYTICS_RE = /\banalytics\.(track|identify|page|session_start|session_end)\b/;

/** The canonical resource declarations of one project state, shaped for deriveArchitecture. */
export function collectResourceDeclarations(files, entities, project) {
  const list = files || [];

  const configFile = list.find((f) => isConfigPath(f.path));
  const parsedConfig = configFile ? validateConfigDocument(configFile.content || "") : null;
  const config = parsedConfig?.ok
    ? { ...parsedConfig.config, resource_dirs: RESOURCE_DIR_KEYS.filter((k) => parsedConfig.config[k] != null) }
    : null;
  const appRead = readAppConfig(list);
  const app = appRead.app || null;

  const workflow_resources = collectWorkflowFiles(list)
    .map((f) => parseWorkflowDocument(f.path, f.content || ""))
    .filter((w) => w.ok);

  const entitiesWithRls = (entities || []).filter((e) => e.rls && typeof e.rls === "object" && Object.keys(e.rls).length).map((e) => e.name);
  const auth = project?.rls_enabled || entitiesWithRls.length ? { rls_enabled: !!project?.rls_enabled, entities_with_rls: entitiesWithRls } : null;

  const analyticsFiles = list.filter((f) => ANALYTICS_RE.test(String(f.content || ""))).map((f) => f.path).sort();
  const analytics = analyticsFiles.length ? { files: analyticsFiles } : null;

  return {
    config, app,
    plugins: resolvePlugins({ appConfig: app, projectConfig: parsedConfig?.ok ? parsedConfig.config : null }).plugins,
    assets: collectAssets(list),
    agents: collectAgents(list).agents.map(({ instructions: _i, ...a }) => a),
    skills: collectAgentSkills(list).skills.map(({ body: _b, ...s }) => s),
    connectors: collectConnectors(list).connectors,
    actors: collectActors(list).actors,
    workflow_resources, auth, analytics,
  };
}