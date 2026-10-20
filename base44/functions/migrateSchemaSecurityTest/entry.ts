// End-to-end security verification of the schema-migration request path.
//
// Runs against REAL rows (two workspaces, projects, versions, memberships and AppRecord
// data) through the SAME guard chain the migrateSchema endpoint uses, then cleans up.
// Proves: an authorized owner can migrate, an unauthorized member cannot, an
// unauthenticated caller cannot, one workspace cannot reach another's project, a forced
// migration still works for an authorized caller, and every request is audited.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestSchemaMigration } from "../../shared/schemaMigrationRequest.ts";

const ENTITY = "Contact";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail: String(detail ?? "") });
  const bad = (name, detail) => checks.push({ name, ok: false, detail: String(detail ?? "") });
  const expect = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));
  const cleanup = [];

  // Calls the guard chain and normalizes the outcome, so a rejection is observable
  // exactly as the endpoint would report it.
  const call = async (user, body) => {
    try { return { allowed: true, result: await requestSchemaMigration(svc, user, body) }; }
    catch (e) { return { allowed: false, status: e.status, code: e.code, message: e.message }; }
  };

  try {
    const ownerId = `mig-owner-${crypto.randomUUID().slice(0, 8)}`;
    const owner = { id: ownerId, email: "owner@migtest.local" };
    const viewer = { id: `mig-viewer-${crypto.randomUUID().slice(0, 8)}`, email: "viewer@migtest.local" };
    const outsider = { id: `mig-out-${crypto.randomUUID().slice(0, 8)}`, email: "outsider@migtest.local" };

    const workspace = await svc.entities.Workspace.create({ name: "Migration Test Workspace", owner_id: ownerId, credits_balance: 0 });
    cleanup.push(() => svc.entities.Workspace.delete(workspace.id));
    const project = await svc.entities.Project.create({ workspace_id: workspace.id, name: "Migration Test Project", framework: "preact-htm", status: "draft", version_count: 2 });
    cleanup.push(() => svc.entities.Project.delete(project.id));
    const member = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active" });
    cleanup.push(() => svc.entities.WorkspaceMember.delete(member.id));

    // v1: name(string), score(string), tier enum[a,b]  →  v2 renames score→points as a
    // number and narrows the enum, so the plan has one safe change and two conditional ones.
    const v1 = await svc.entities.ProjectVersion.create({
      project_id: project.id, number: 1, message: "v1",
      snapshot: { files: [], entities: [{ name: ENTITY, fields: { name: { type: "string" }, score: { type: "string" }, tier: { type: "enum", enum: ["a", "b"] } } }] },
    });
    cleanup.push(() => svc.entities.ProjectVersion.delete(v1.id));
    const v2 = await svc.entities.ProjectVersion.create({
      project_id: project.id, number: 2, message: "v2",
      snapshot: { files: [], entities: [{ name: ENTITY, fields: { name: { type: "string" }, points: { type: "number", renamed_from: "score" }, tier: { type: "enum", enum: ["a"] } } }] },
    });
    cleanup.push(() => svc.entities.ProjectVersion.delete(v2.id));

    const seed = async () => {
      const rows = await svc.entities.AppRecord.filter({ project_id: project.id, entity_name: ENTITY }, "-created_date", 50);
      for (const r of rows) await svc.entities.AppRecord.delete(r.id).catch(() => {});
      const a = await svc.entities.AppRecord.create({ project_id: project.id, entity_name: ENTITY, data: { name: "Ada", score: "42", tier: "a" } });
      const b = await svc.entities.AppRecord.create({ project_id: project.id, entity_name: ENTITY, data: { name: "Bo", score: "seven", tier: "b" } });
      cleanup.push(() => svc.entities.AppRecord.delete(a.id));
      cleanup.push(() => svc.entities.AppRecord.delete(b.id));
    };
    await seed();

    const auditsFor = async () => (await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 20));
    const before = (await auditsFor()).length;

    // --- 1. authorized owner can run a migration ------------------------------
    const dry = await call(owner, { project_id: project.id, to_version_id: v2.id, from_version_id: v1.id, dry_run: true });
    const dryEntity = dry.result?.entities?.[0];
    expect("owner_can_migrate", dry.allowed && !!dryEntity && dryEntity.entity === ENTITY, dry.allowed ? `${dryEntity?.status} · plan of ${(dryEntity?.changes || []).length} change(s)` : `${dry.status} ${dry.message}`);
    // Engine behavior preserved: the plan is classified, and the unsafe change is reported
    // and refuses to apply without force (the pre-scan aborts before any write).
    expect("classification_preserved", dryEntity?.status === "failed" && (dryEntity?.breaking || []).some((b) => b.op === "enum") && (dryEntity?.changes || []).some((c) => c.op === "rename"), JSON.stringify(dryEntity?.breaking || []));
    expect("dry_run_wrote_nothing", (await svc.entities.AppRecord.filter({ project_id: project.id, entity_name: ENTITY }, "-created_date", 50)).every((r) => "score" in (r.data || {})), "records untouched by the preview");

    // A non-forced apply must still ABORT on the conditional changes.
    const applied = await call(owner, { project_id: project.id, to_version_id: v2.id, from_version_id: v1.id });
    expect("validation_preserved", applied.allowed && applied.result?.entities?.[0]?.status === "failed", applied.result?.entities?.[0]?.error || applied.message);

    // --- 2. unauthorized user is rejected -------------------------------------
    const viewerCall = await call(viewer, { project_id: project.id, to_version_id: v2.id, dry_run: true });
    expect("viewer_rejected", !viewerCall.allowed && viewerCall.status === 403 && viewerCall.code === "INSUFFICIENT_ROLE", `${viewerCall.status} ${viewerCall.code}`);
    const outsiderCall = await call(outsider, { project_id: project.id, to_version_id: v2.id, dry_run: true });
    expect("non_member_rejected", !outsiderCall.allowed && outsiderCall.status === 403 && outsiderCall.code === "NOT_A_MEMBER", `${outsiderCall.status} ${outsiderCall.code}`);

    // --- 3. unauthenticated request is rejected -------------------------------
    const anon = await call(null, { project_id: project.id, to_version_id: v2.id, force: true });
    expect("unauthenticated_rejected", !anon.allowed && anon.status === 401, `${anon.status} ${anon.message}`);

    // --- 4. cross-workspace isolation ----------------------------------------
    const other = await svc.entities.Workspace.create({ name: "Migration Other Workspace", owner_id: `mig-other-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    cleanup.push(() => svc.entities.Workspace.delete(other.id));
    const otherProject = await svc.entities.Project.create({ workspace_id: other.id, name: "Other Project", framework: "preact-htm", status: "draft", version_count: 1 });
    cleanup.push(() => svc.entities.Project.delete(otherProject.id));
    const otherVersion = await svc.entities.ProjectVersion.create({
      project_id: otherProject.id, number: 1, message: "other v1",
      snapshot: { files: [], entities: [{ name: ENTITY, fields: { name: { type: "string" } } }] },
    });
    cleanup.push(() => svc.entities.ProjectVersion.delete(otherVersion.id));
    const crossed = await call(owner, { project_id: otherProject.id, to_version_id: otherVersion.id, dry_run: true });
    expect("cross_workspace_rejected", !crossed.allowed && crossed.status === 403, `${crossed.status} ${crossed.code}`);
    // Ownership claimed in the body is ignored — the project's own workspace decides.
    const spoofed = await call(outsider, { project_id: otherProject.id, to_version_id: otherVersion.id, workspace_id: workspace.id, role: "owner", dry_run: true });
    expect("body_ownership_ignored", !spoofed.allowed && spoofed.status === 403, `${spoofed.status} ${spoofed.code}`);
    // The engine also refuses a version belonging to a different project.
    const foreignVersion = await call(owner, { project_id: project.id, to_version_id: otherVersion.id });
    expect("foreign_version_rejected", !foreignVersion.allowed && foreignVersion.status === 404, `${foreignVersion.status} ${foreignVersion.message}`);

    // --- 5. forced migration still works for an authorized caller ------------
    const forced = await call(owner, { project_id: project.id, to_version_id: v2.id, from_version_id: v1.id, force: true });
    const forcedEntity = forced.result?.entities?.[0];
    expect("forced_migration_applied", forced.allowed && forcedEntity?.status === "applied" && forcedEntity?.records_modified === 2, forced.allowed ? `${forcedEntity?.status}, ${forcedEntity?.records_modified} modified` : `${forced.status} ${forced.message}`);
    const after = await svc.entities.AppRecord.filter({ project_id: project.id, entity_name: ENTITY }, "-created_date", 50);
    const ada = after.find((r) => r.data?.name === "Ada")?.data || {};
    const bo = after.find((r) => r.data?.name === "Bo")?.data || {};
    // Engine semantics, unchanged: the rename carries each value to its new name, and the
    // out-of-set enum value is coerced into the new set under force.
    expect("forced_transform_correct", ada.points === "42" && !("score" in ada) && bo.points === "seven" && !("score" in bo) && bo.tier === "a" && ada.tier === "a", `Ada=${JSON.stringify(ada)} Bo=${JSON.stringify(bo)}`);
    expect("migration_recorded", (await svc.entities.SchemaMigration.filter({ project_id: project.id, to_version_id: v2.id, status: "applied" }, "-created_date", 5)).length >= 1, "SchemaMigration row written");
    for (const m of await svc.entities.SchemaMigration.filter({ project_id: project.id }, "-created_date", 20)) cleanup.push(() => svc.entities.SchemaMigration.delete(m.id));

    // --- 6. audit trail ------------------------------------------------------
    const audits = await auditsFor();
    const forcedAudit = audits.find((a) => a.action === "schema.migration.requested" && a.metadata?.force === true);
    const previewAudit = audits.find((a) => a.action === "schema.migration.previewed");
    expect("audit_created", audits.length > before && !!forcedAudit && !!previewAudit, `${audits.length - before} new audit row(s)`);
    expect("audit_attributed", forcedAudit?.user_id === owner.id && forcedAudit?.workspace_id === workspace.id && forcedAudit?.resource_id === v2.id, `${forcedAudit?.user_id} / ${forcedAudit?.workspace_id}`);
    expect("rejected_calls_not_audited", !audits.some((a) => a.user_id === viewer.id || a.user_id === outsider.id), "a refused request never reaches the audit or the engine");
    for (const a of audits) cleanup.push(() => svc.entities.AuditLog.delete(a.id));
    for (const b of await svc.entities.RateLimitBucket.filter({ workspace_id: workspace.id }, "-created_date", 20)) cleanup.push(() => svc.entities.RateLimitBucket.delete(b.id));
    expect("rate_limit_recorded", (await svc.entities.RateLimitBucket.filter({ workspace_id: workspace.id, action: "schema_migrate" }, "-created_date", 5)).length >= 1, "durable per-caller budget consumed");
  } catch (e) {
    bad("suite_execution", e.message);
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed, checks });
}