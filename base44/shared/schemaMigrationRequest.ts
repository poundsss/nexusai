// The authorized schema-migration request path.
//
// This is the ONE place the guard chain for a migration lives, so the endpoint and its
// security test exercise exactly the same code: authorize → rate limit → audit → engine.
// Ownership is never taken from the caller's payload: the project id is only a lookup key
// and the caller's role is derived from Workspace.owner_id / an active WorkspaceMember row.
// The engine (shared/schemaMigrations.ts) is untouched — dry-run, validation,
// safe/conditional classification and forced coercion behave exactly as before.
import { migrateProjectVersion } from "./schemaMigrations.ts";
import { loadAuthorizedProject, audit } from "./authz.ts";
import { enforceLimit, identityFor } from "./apiLimits.ts";

export async function requestSchemaMigration(base44, user, body = {}) {
  if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const toVersionId = String(body.to_version_id || "");
  if (!toVersionId) throw Object.assign(new Error("project_id and to_version_id are required"), { status: 400 });

  // A migration rewrites stored records, so it requires the project WRITE capability.
  const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.write");

  await enforceLimit(base44, {
    identity: identityFor({ user, workspace_id: workspace.id }),
    action: "schema_migrate",
    workspace_id: workspace.id,
  });

  const dryRun = !!body.dry_run;
  const force = !!body.force;
  // Recorded BEFORE the engine runs, so a forced (destructive) migration leaves a trace
  // even if it fails part-way through.
  await audit(base44, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: dryRun ? "schema.migration.previewed" : "schema.migration.requested",
    resource: "ProjectVersion", resource_id: toVersionId,
    metadata: { to_version_id: toVersionId, from_version_id: body.from_version_id || null, entity_name: body.entity_name || null, force, dry_run: dryRun },
  });

  return migrateProjectVersion(base44.asServiceRole || base44, {
    projectId: project.id,
    toVersionId,
    fromVersionId: body.from_version_id || null,
    entityName: body.entity_name || null,
    force,
    dryRun,
  });
}