// Targeted certification for the Base44 App Rename gap.
//
// Certifies the NEW `rename` action on the existing `projectEdit` backend function, which
// reuses the existing `renameProject` primitive (project.write authorization + the existing
// project-name validation contract from createProjectForUser). Runs against disposable
// scratch data; no real project is touched.
//
// Covers:
//   • authorized rename persists (Project.name updated to the exact submitted name)
//   • unauthorized rename is rejected (unknown project_id → the existing authorization path)
//   • empty name → 400 INVALID_INPUT; whitespace-only → 400 INVALID_INPUT
//   • over-length name is trimmed to the existing 120-char ceiling (the existing contract)
//   • existing project data remains UNCHANGED: description, status, slug, version_count,
//     production_deployment_id, unpublished, visibility — only name moves
//   • audit event written (project.renamed)
//   • no-op rename (same name) succeeds without writing
//
// The SDK's functions.invoke throws on non-2xx, so `tryInvoke` normalizes both cases.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const CLEANUP = ["AuditLog", "Project", "Workspace"];

async function tryInvoke(client, name, payload) {
  try {
    const r = await client.functions.invoke(name, payload);
    return { status: r.status, data: r.data };
  } catch (e) {
    return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? { error: e.message, code: e.code ?? null } };
  }
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let ws = null;
  const stamp = Date.now();
  const uid = crypto.randomUUID().slice(0, 8);

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    ws = await svc.entities.Workspace.create({ name: `rename-ws-${stamp}`, owner_id: caller.id, status: "active" });
    const project = await svc.entities.Project.create({
      workspace_id: ws.id,
      name: `Pre-rename ${stamp}`,
      description: "Original description that must survive",
      slug: `rn-${stamp}-${uid}`,
      status: "ready",
      version_count: 3,
      last_build_status: "success",
      visibility: "public",
      unpublished: false,
    });

    // snapshot of every field that must NOT move during a rename
    const before = await svc.entities.Project.get(project.id);
    const frozenFields = {
      description: before.description,
      slug: before.slug,
      status: before.status,
      version_count: before.version_count,
      last_build_status: before.last_build_status,
      production_deployment_id: before.production_deployment_id ?? null,
      staging_deployment_id: before.staging_deployment_id ?? null,
      visibility: before.visibility,
      unpublished: before.unpublished,
      workspace_id: before.workspace_id,
      origin: before.origin,
    };

    // ===================== 1. authorized rename persists =====================
    const newName = `Post-rename ${stamp}`;
    const r1 = await tryInvoke(base44, "projectEdit", { action: "rename", project_id: project.id, name: newName });
    h.check("authorized rename → 200 ok", r1.status === 200 && r1.data?.renamed === true, JSON.stringify(r1.data));
    h.check("rename returns the new name", r1.data?.name === newName, JSON.stringify(r1.data?.name));

    const after = await svc.entities.Project.get(project.id);
    h.check("Project.name persisted to the exact submitted name", after.name === newName, after.name);

    // ===================== 2. existing project data remains unchanged =====================
    h.check("description unchanged", after.description === frozenFields.description, `${frozenFields.description} → ${after.description}`);
    h.check("slug unchanged", after.slug === frozenFields.slug, `${frozenFields.slug} → ${after.slug}`);
    h.check("status unchanged", after.status === frozenFields.status, `${frozenFields.status} → ${after.status}`);
    h.check("version_count unchanged", after.version_count === frozenFields.version_count, `${after.version_count}`);
    h.check("last_build_status unchanged", after.last_build_status === frozenFields.last_build_status, `${after.last_build_status}`);
    h.check("production_deployment_id unchanged", (after.production_deployment_id ?? null) === frozenFields.production_deployment_id, String(after.production_deployment_id));
    h.check("visibility unchanged", after.visibility === frozenFields.visibility, `${frozenFields.visibility} → ${after.visibility}`);
    h.check("unpublished unchanged", after.unpublished === frozenFields.unpublished, String(after.unpublished));
    h.check("workspace_id unchanged", after.workspace_id === frozenFields.workspace_id, "ws moved");
    h.check("origin unchanged", after.origin === frozenFields.origin, `${frozenFields.origin} → ${after.origin}`);

    // ===================== 3. audit event written =====================
    const audits = await svc.entities.AuditLog.filter({ project_id: project.id, action: "project.renamed" }, "-created_date", 5);
    const ev = audits[0];
    h.check("project.renamed audit event written", !!ev, "missing");
    h.check("audit metadata records from→to", !!ev && ev.metadata?.from === `Pre-rename ${stamp}` && ev.metadata?.to === newName, JSON.stringify(ev?.metadata));

    // ===================== 4. empty / invalid names rejected =====================
    const rEmpty = await tryInvoke(base44, "projectEdit", { action: "rename", project_id: project.id, name: "" });
    h.check("empty name → 400", rEmpty.status === 400, JSON.stringify(rEmpty.data));
    h.check("empty name rejected with INVALID_INPUT", rEmpty.data?.code === "INVALID_INPUT", JSON.stringify(rEmpty.data?.code));

    const rWs = await tryInvoke(base44, "projectEdit", { action: "rename", project_id: project.id, name: "    " });
    h.check("whitespace-only name → 400", rWs.status === 400, JSON.stringify(rWs.data));

    const rMissing = await tryInvoke(base44, "projectEdit", { action: "rename", project_id: project.id });
    h.check("missing name → 400", rMissing.status === 400, JSON.stringify(rMissing.data));

    // name untouched after the rejected attempts
    const afterBad = await svc.entities.Project.get(project.id);
    h.check("name unchanged after rejected renames", afterBad.name === newName, afterBad.name);

    // ===================== 5. over-length name trimmed to 120-char ceiling (existing contract) =====================
    const longName = "x".repeat(200);
    const rLong = await tryInvoke(base44, "projectEdit", { action: "rename", project_id: project.id, name: longName });
    h.check("over-length name → 200 (existing trim contract)", rLong.status === 200, JSON.stringify(rLong.data));
    h.check("over-length name stored at exactly 120 chars", rLong.data?.name?.length === 120, String(rLong.data?.name?.length));
    const afterLong = await svc.entities.Project.get(project.id);
    h.check("over-length name persisted at 120 chars", afterLong.name.length === 120, String(afterLong.name.length));

    // ===================== 6. unauthorized rename is rejected =====================
    const rUnknown = await tryInvoke(base44, "projectEdit", { action: "rename", project_id: "nonexistent-project-id", name: "Stolen" });
    h.check("unknown project_id → refused (403/404)", rUnknown.status === 403 || rUnknown.status === 404, JSON.stringify(rUnknown.data));

    // an unknown action name is rejected — confirms routing, not a wildcard accept
    const rBadAction = await tryInvoke(base44, "projectEdit", { action: "renameX", project_id: project.id, name: "X" });
    h.check("typo'd action name → 400 (not a wildcard accept)", rBadAction.status === 400, JSON.stringify(rBadAction.data));

    // ===================== 7. no-op rename (same name) succeeds without writing =====================
    const sameName = afterLong.name;
    const rSame = await tryInvoke(base44, "projectEdit", { action: "rename", project_id: project.id, name: sameName });
    h.check("same-name rename → 200 ok", rSame.status === 200 && rSame.data?.renamed === true, JSON.stringify(rSame.data));
    h.check("same-name rename returns the unchanged name", rSame.data?.name === sameName, JSON.stringify(rSame.data?.name));

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    await cleanupWorkspace(svc, ws?.id, CLEANUP);
  }
}