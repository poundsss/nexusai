// NexusAI dependency / package API.
//
// Minimal, authorized, traceable. Every action authenticates the caller and re-authorizes them
// against the project through the platform's existing path; the workspace is always resolved
// server-side, so a client can never assert ownership of a project's dependency state.
//
// Mutations go through the ONE dependency mutation path, which resolves → validates → builds →
// commits a project version. Reads never mutate anything except the queryable projection of the
// project's own lockfile.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  listDependencies, inspectDependencyTree, validateDependencies, dependencyCatalog,
  addDependency, removeDependency, updateDependency, applyDependencyChange,
  supplyCapabilities, inspectRegistryPackage, packagePrepareStatus,
  DEPENDENCY_OPERATIONS, DEPENDENCY_FAILURE_CLASSES, MANIFEST_FILE, LOCKFILE_FILE, LOCKFILE_VERSION,
} from "../../shared/dependencies.ts";
import { previewPackageModules } from "../../shared/packageModules.ts";
import { REGISTRY_VERSION, REGISTRY_SOURCE, RUNTIME_TARGET, PACKAGE_LIMITS } from "../../shared/packageRegistry.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const url = new URL(req.url);
    const action = body.action || url.searchParams.get("action") || "capabilities";

    // Public metadata: the contract itself, never any project's dependency state.
    if (action === "capabilities") {
      return Response.json({
        registry_version: REGISTRY_VERSION, registry_source: REGISTRY_SOURCE, runtime_target: RUNTIME_TARGET,
        manifest_file: MANIFEST_FILE, lockfile_file: LOCKFILE_FILE, lockfile_version: LOCKFILE_VERSION,
        operations: DEPENDENCY_OPERATIONS, failure_classes: DEPENDENCY_FAILURE_CLASSES, limits: PACKAGE_LIMITS,
        supply_chain: supplyCapabilities(),
        guarantees: [
          "resolution is deterministic against a pinned registry metadata snapshot",
          "artifact content is accepted only when its digest matches the published integrity",
          "no package install script is ever executed",
          "package artifacts are cached content-addressed by name, version and integrity",
          "the manifest and lockfile are the project's authoritative dependency state",
          "every package change produces a project version and is rollback-safe",
          "a failed resolution, validation or build leaves no partial dependency state",
          "vulnerability data is reported as unknown when unavailable — never as safe",
        ],
      });
    }

    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });

    switch (action) {
      case "catalog": return Response.json(dependencyCatalog());
      // Supply-chain reads: registry metadata for one package, and the project's own verified
      // preparation history. Neither mutates project state.
      case "inspectRegistryPackage": return Response.json(await inspectRegistryPackage(base44, user, body));
      case "packagePrepareStatus": return Response.json(await packagePrepareStatus(base44, user, body));
      // B5: browser modules for the project's pinned packages (builder preview input).
      case "packageModules": return Response.json(await previewPackageModules(base44, user, body));
      case "listDependencies": return Response.json(await listDependencies(base44, user, body));
      case "inspectDependencyTree": return Response.json(await inspectDependencyTree(base44, user, body));
      case "validateDependencies": return Response.json(await validateDependencies(base44, user, body));
      // A pre-mutation impact summary: the same structured result, nothing written.
      case "previewDependencyChange": return Response.json(await applyDependencyChange(base44, user, { ...body, dry_run: true }));
      case "addDependency": return Response.json(await addDependency(base44, user, body));
      case "removeDependency": return Response.json(await removeDependency(base44, user, body));
      case "updateDependency": return Response.json(await updateDependency(base44, user, body));
      default: return Response.json({ error: `Unknown action: ${action}`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
  } catch (error) {
    return Response.json(
      { error: error.message, code: error.code || "DEPENDENCY_ERROR", details: error.details || null },
      { status: error.status || 500 },
    );
  }
}