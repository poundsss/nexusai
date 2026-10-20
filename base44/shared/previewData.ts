// Server-authoritative data access for the Builder's preview runtime.
//
// The preview iframe's database calls used to be executed by the browser directly against
// AppRecord: the project id, the entity definitions and the record ownership check all came from
// the page, so the trust boundary sat in the client. Here every one of them is server-side:
//   • the acting user comes from the authenticated session;
//   • the project id in the payload is resolved to a real Project and authorized through
//     workspace membership (loadAuthorizedProject), with reads needing project.read and writes
//     project.write — a project in another account simply fails authorization;
//   • the entity definitions are loaded from the project's own AppEntity rows, never taken from
//     the browser, so a caller cannot invent a schema to smuggle fields past validation;
//   • CRUD runs through the SAME createServerDb accessor generated backend functions use, which
//     binds every record to this project id — so cross-project reads and writes are impossible
//     rather than merely checked.
// Behaviour and error messages match the previous client bridge, so the preview UI is unchanged.
import { loadAuthorizedProject } from "./authz.ts";
import { createServerDb, readEntityEvents } from "./appData.ts";
import { importEntitiesIntoDb } from "./appImport.ts";
import { resolveSession } from "./appAuth.ts";

const READ_OPS = ["filter", "list", "get", "count", "events", "page", "aggregate"];
const WRITE_OPS = ["create", "update", "delete", "bulkCreate", "bulkUpdate", "bulkDelete", "updateWhere", "deleteWhere", "updateMany", "deleteMany", "upsert", "importEntities"];

export async function handlePreviewData(base44, user, { project_id, op, args = {}, session_token = null } = {}) {
  if (!user || !user.id) throw Object.assign(new Error("Sign in required"), { status: 401, code: "AUTH_REQUIRED" });
  const operation = String(op || "");
  const isRead = READ_OPS.includes(operation);
  if (!isRead && !WRITE_OPS.includes(operation)) throw Object.assign(new Error(`Unknown db operation ${operation}`), { status: 400, code: "UNKNOWN_OPERATION" });

  // Authorization from server-side facts only. A forged project/workspace identifier cannot
  // satisfy it, because the workspace is read off the resolved project, not off the payload.
  const { project } = await loadAuthorizedProject(base44, user, project_id, isRead ? "project.read" : "project.write");

  const svc = base44.asServiceRole || base44;
  const rows = await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 200);
  const entities = rows.map((e) => ({ name: e.name, fields: e.fields || {}, ...(e.rls ? { rls: e.rls } : {}) }));
  // Signed in AS an app user inside the preview: the SAME access rules the published runtime
  // applies (legacy owner isolation, entity RLS, field rules). Without an app session the
  // builder keeps its open preview view, unchanged.
  const appUser = typeof session_token === "string" && session_token
    ? await resolveSession(svc, project.id, session_token).catch(() => null) : null;
  const access = appUser ? { rls: !!project.rls_enabled, user: appUser, fieldRules: true } : {};
  const db = createServerDb(svc, project.id, entities, access);
  const entity = String(args.entity || "");
  const api = db[entity];

  switch (operation) {
    case "filter": return api.filter(args.query || {}, args.sort || "-created_date", args.limit, args.skip, args.fields);
    case "list": return api.list(args.sort || "-created_date", args.limit, args.skip, args.fields);
    // Phase B1: the records-mode v2/list page form — list(options) / filter(query, options).
    // The query travels VERBATIM: an omitted query must stay omitted (not {}), because the
    // page layer recovers a cursor-only continuation's query from the verified cursor state.
    case "page": return api.page(args.query, args.options || {});
    // Phase B3: aggregate(spec) — DOCUMENTED (Base44 SDK 0.8.51): the spec arrives verbatim and the
    // result is { rows, truncated }. Undocumented server semantics are bounded inside appData.ts
    // and marked NEXUSAI-derived there.
    case "aggregate": return api.aggregate(args.spec || {});
    // Upsert (SDK 0.8.51 surface): records + key travel VERBATIM — a missing key or a
    // non-array records value is refused server-side (fail-closed), never normalized here.
    case "upsert": return api.upsert(args.records, { key: args.key });
    case "get": return api.get(args.id);
    case "count": return api.count(args.query || {});
    // B-stage (entities.subscribe): the events read the preview's bounded subscribe poll rides.
    // The builder preview's data surface is open (no end-user RLS here), matching its reads.
    case "events": return readEntityEvents(svc, project.id, entities, access, { entity: args.entity, after: args.after, limit: args.limit });
    case "create": return api.create(args.data || {});
    case "update": return api.update(args.id, args.data || {});
    case "delete": return api.delete(args.id);
    case "bulkCreate": return api.bulkCreate(args.items);
    case "bulkUpdate": return api.bulkUpdate(args.updates);
    case "bulkDelete": return api.bulkDelete(args.ids);
    case "updateWhere": return api.updateWhere(args.query || {}, args.data || {});
    case "deleteWhere": return api.deleteWhere(args.query || {}, args.options || {});
    // DOCUMENTED SDK names (Base44 entities reference) routed onto the same set-based machine.
    case "updateMany": return api.updateMany(args.query || {}, args.data || {});
    case "deleteMany": return api.deleteMany(args.query || {});
    // DOCUMENTED (Base44 SDK reference): entities.<Entity>.importEntities(file) — browser-only
    // CSV import. Parsing is the ONLY new logic (shared/appImport.ts); insertion, validation,
    // RLS and events are the existing bulkCreate machine's. Undocumented semantics are
    // NexusAI-derived and marked as such in appImport.ts.
    case "importEntities": return importEntitiesIntoDb(db, entity, args);
  }
}