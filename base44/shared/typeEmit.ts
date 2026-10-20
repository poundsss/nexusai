// THE single emit path for a project's generated declarations.
//
// It owns no generator and no resource contract: it only COLLECTS what the platform already
// validated — entities, backend functions, actors, agents and connectors — and hands them to the
// ONE generator (shared/typeGen.ts). Both callers (the run pipeline's commit and the CLI's `types`
// command) go through here, so a pipeline-emitted and a CLI-emitted declaration file for the same
// project are byte-identical, and a resource kind can never be silently dropped from the output.
import { activeFiles } from "./projectFs.ts";
import { generateTypes } from "./typeGen.ts";
import { describeFunctions } from "./tools.ts";
import { collectActors } from "./actorResource.ts";
import { collectAgents } from "./agentResource.ts";
import { collectConnectors } from "./connectorResource.ts";

/**
 * The complete generated declaration text for one project state. `fs` is the project's virtual
 * filesystem and `entities` its runtime entity records. Malformed resource documents contribute
 * nothing (the build already refuses them), so the declarations can only describe resources that
 * actually exist.
 */
export function emitProjectTypes(fs, entities) {
  const files = activeFiles(fs);
  return generateTypes({
    entities: (entities || []).map((e) => ({ name: e.name, fields: e.fields })),
    functions: describeFunctions(fs),
    actors: collectActors(files).actors,
    agents: collectAgents(files).agents,
    // A NexusAI connector's identity IS its declared name, so that is the registry key the
    // generator emits (it keys the connector registry by `type`).
    connectors: collectConnectors(files).connectors.map((c) => ({ ...c, type: c.name })),
  });
}