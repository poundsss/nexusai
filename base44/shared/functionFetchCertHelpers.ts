// Shared helpers for the functions.fetch certification suites: the project-scoped source loader
// and the buffered/streaming fetch runner, so no suite re-implements the resolution contract.
import { loadProjectFunction } from "./functionRuntime.ts";
import { runProjectFunctionFetch } from "./appFetch.ts";

/** The EXISTING project-scoped source loader, bound to one project. */
export function makeFetchLoader(db, projectId) {
  return (name) => loadProjectFunction(db, projectId, name);
}

/** Runs ONE functions.fetch request through the existing machinery; `extra` carries streaming/signal/quotas. */
export function runFetchOver(db, project, loadSource, args, extra = {}) {
  return runProjectFunctionFetch(db, { project, entities: [], integrations: [], args, loadSource, ...extra });
}