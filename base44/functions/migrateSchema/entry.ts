// P1 schema migration entry point.
//
// Invoked from the builder/admin context to migrate a project's existing AppRecord
// data blobs to match a target version's entity schemas. Project/version scoped,
// idempotent, and non-destructive by default (destructive changes abort unless
// `force` is set). See base44/shared/schemaMigrations.ts for the engine.
//
// AUTHORIZATION — a migration rewrites a project's stored data, so it is treated as a
// project write like every other mutating control-plane endpoint: the caller must be
// authenticated, the project is resolved server-side and the caller's role is derived
// from facts they cannot influence, the durable rate limit applies, and the request is
// audited. The guard chain lives in shared/schemaMigrationRequest.ts so the security
// test exercises this exact path.
//
// Body:
//   project_id      string  required
//   to_version_id   string  required  — version whose schema to migrate to
//   from_version_id string  optional  — version whose schema the data currently
//                                       conforms to (defaults to none → all adds)
//   entity_name     string  optional  — migrate only this entity
//   force           bool    optional  — apply destructive changes with coercion
//   dry_run         bool    optional  — report the plan + breaking changes, no writes
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestSchemaMigration } from "../../shared/schemaMigrationRequest.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    return Response.json(await requestSchemaMigration(base44, user, body));
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}