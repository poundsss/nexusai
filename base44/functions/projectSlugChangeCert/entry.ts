// Targeted certification for the Base44 Built-in URL change gap.
//
// Certifies the NEW `change_slug` action on the existing projectDomains backend function, which
// reuses the existing Project.slug, project.write authorization, the existing validateSlug
// contract, and the runtime's existing slug→project resolution (filter { slug }). Runs against
// disposable scratch data; no real project is touched.
//
// Covers:
//   • authorized change persists (Project.slug updated to the exact submitted slug)
//   • duplicate slug (another project) → 409 SLUG_TAKEN
//   • invalid slug (uppercase / too short / spaces) → 400 INVALID_SLUG
//   • unauthorized change (unknown project_id) → refused (403/404)
//   • same-slug change is a no-op success (unchanged: true, no write)
//   • existing deployment IDs unchanged (production/staging), plus name/description/status/
//     visibility/unpublished/workspace_id all unchanged
//   • new slug resolves to the SAME live deployment (filter { slug: new } → project with the
//     same production_deployment_id); old slug no longer resolves (filter { slug: old } → empty)
//   • custom-domain state unchanged (an attached CustomDomain survives the slug change verbatim)
//   • audit event written (project.slug_changed with from→to)
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

    ws = await svc.entities.Workspace.create({ name: `slug-ws-${stamp}`, owner_id: caller.id, status: "active" });
    const oldSlug = `pre-${stamp}-${uid}`;
    const liveDep = `dep-live-${uid}`;
    const stagingDep = `dep-stg-${uid}`;
    const project = await svc.entities.Project.create({
      workspace_id: ws.id,
      name: `Slug app ${stamp}`,
      description: "Original description that must survive",
      slug: oldSlug,
      status: "ready",
      version_count: 3,
      last_build_status: "success",
      visibility: "public",
      unpublished: false,
      production_deployment_id: liveDep,
      staging_deployment_id: stagingDep,
    });

    // A second project to claim a slug and test platform-wide uniqueness.
    const otherSlug = `taken-${stamp}-${uid}`;
    const other = await svc.entities.Project.create({
      workspace_id: ws.id, name: `Other ${stamp}`, slug: otherSlug, status: "ready", visibility: "public",
    });

    // A custom domain attached to the project — must survive the slug change verbatim.
    const domain = await svc.entities.CustomDomain.create({
      project_id: project.id, hostname: `app-${uid}.example.com`, environment: "production",
      status: "active", is_primary: true, verified_at: new Date().toISOString(),
    });

    const before = await svc.entities.Project.get(project.id);
    const frozen = {
      name: before.name, description: before.description, status: before.status,
      version_count: before.version_count, last_build_status: before.last_build_status,
      production_deployment_id: before.production_deployment_id ?? null,
      staging_deployment_id: before.staging_deployment_id ?? null,
      visibility: before.visibility, unpublished: before.unpublished,
      workspace_id: before.workspace_id, origin: before.origin,
    };

    // ===================== 1. authorized change persists =====================
    const newSlug = `post-${stamp}-${uid}`;
    const r1 = await tryInvoke(base44, "projectDomains", { action: "change_slug", project_id: project.id, slug: newSlug });
    h.check("authorized change → 200 ok", r1.status === 200 && r1.data?.changed === true, JSON.stringify(r1.data));
    h.check("change returns the new slug", r1.data?.slug === newSlug, JSON.stringify(r1.data?.slug));

    const after = await svc.entities.Project.get(project.id);
    h.check("Project.slug persisted to the exact submitted slug", after.slug === newSlug, after.slug);

    // ===================== 2. existing project data unchanged =====================
    h.check("name unchanged", after.name === frozen.name, `${frozen.name} → ${after.name}`);
    h.check("description unchanged", after.description === frozen.description, `${frozen.description} → ${after.description}`);
    h.check("status unchanged", after.status === frozen.status, `${frozen.status} → ${after.status}`);
    h.check("version_count unchanged", after.version_count === frozen.version_count, `${after.version_count}`);
    h.check("last_build_status unchanged", after.last_build_status === frozen.last_build_status, `${after.last_build_status}`);
    h.check("production_deployment_id unchanged (same LIVE deployment)", (after.production_deployment_id ?? null) === frozen.production_deployment_id, String(after.production_deployment_id));
    h.check("staging_deployment_id unchanged", (after.staging_deployment_id ?? null) === frozen.staging_deployment_id, String(after.staging_deployment_id));
    h.check("visibility unchanged", after.visibility === frozen.visibility, `${frozen.visibility} → ${after.visibility}`);
    h.check("unpublished unchanged", after.unpublished === frozen.unpublished, String(after.unpublished));
    h.check("workspace_id unchanged", after.workspace_id === frozen.workspace_id, "ws moved");
    h.check("origin unchanged", after.origin === frozen.origin, `${frozen.origin} → ${after.origin}`);

    // ===================== 3. new slug resolves to the same LIVE deployment; old slug no longer resolves =====================
    // The runtime resolves a slug via Project.filter({ slug }) (resolvePublicTarget); replicate it.
    const byNew = await svc.entities.Project.filter({ slug: newSlug }, "slug", 1);
    h.check("new slug resolves to the project", byNew[0]?.id === project.id, JSON.stringify(byNew[0]?.id));
    h.check("new slug resolves to the SAME live deployment", (byNew[0]?.production_deployment_id ?? null) === frozen.production_deployment_id, String(byNew[0]?.production_deployment_id));
    const byOld = await svc.entities.Project.filter({ slug: oldSlug }, "slug", 1);
    h.check("old slug no longer resolves (empty result)", byOld.length === 0, JSON.stringify(byOld.length));

    // ===================== 4. custom-domain state unchanged =====================
    const domainAfter = await svc.entities.CustomDomain.get(domain.id).catch(() => null);
    h.check("custom domain still attached to the project", !!domainAfter && domainAfter.project_id === project.id, "domain detached");
    h.check("custom domain hostname unchanged", domainAfter?.hostname === domain.hostname, `${domain.hostname} → ${domainAfter?.hostname}`);
    h.check("custom domain status unchanged", domainAfter?.status === domain.status, `${domain.status} → ${domainAfter?.status}`);

    // ===================== 5. duplicate slug rejected (platform-wide uniqueness) =====================
    const rDup = await tryInvoke(base44, "projectDomains", { action: "change_slug", project_id: project.id, slug: otherSlug });
    h.check("duplicate slug → 409", rDup.status === 409, JSON.stringify(rDup.data));
    h.check("duplicate slug rejected with SLUG_TAKEN", rDup.data?.code === "SLUG_TAKEN", JSON.stringify(rDup.data?.code));
    const afterDup = await svc.entities.Project.get(project.id);
    h.check("slug unchanged after rejected duplicate", afterDup.slug === newSlug, afterDup.slug);

    // ===================== 6. invalid slug rejected =====================
    const rUpper = await tryInvoke(base44, "projectDomains", { action: "change_slug", project_id: project.id, slug: "UPPERCASE" });
    h.check("uppercase slug → 400", rUpper.status === 400, JSON.stringify(rUpper.data));
    h.check("uppercase slug rejected with INVALID_SLUG", rUpper.data?.code === "INVALID_SLUG", JSON.stringify(rUpper.data?.code));

    const rShort = await tryInvoke(base44, "projectDomains", { action: "change_slug", project_id: project.id, slug: "a" });
    h.check("too-short slug → 400", rShort.status === 400, JSON.stringify(rShort.data));

    const rSpace = await tryInvoke(base44, "projectDomains", { action: "change_slug", project_id: project.id, slug: "has space" });
    h.check("slug with space → 400", rSpace.status === 400, JSON.stringify(rSpace.data));

    const rMissing = await tryInvoke(base44, "projectDomains", { action: "change_slug", project_id: project.id });
    h.check("missing slug → 400", rMissing.status === 400, JSON.stringify(rMissing.data));

    // ===================== 7. unauthorized change rejected =====================
    const rUnknown = await tryInvoke(base44, "projectDomains", { action: "change_slug", project_id: "nonexistent-project-id", slug: "stolen" });
    h.check("unknown project_id → refused (403/404)", rUnknown.status === 403 || rUnknown.status === 404, JSON.stringify(rUnknown.data));

    const rBadAction = await tryInvoke(base44, "projectDomains", { action: "change_slugX", project_id: project.id, slug: "x" });
    h.check("typo'd action name → 400 (not a wildcard accept)", rBadAction.status === 400, JSON.stringify(rBadAction.data));

    // ===================== 8. same-slug change is a no-op success =====================
    const rSame = await tryInvoke(base44, "projectDomains", { action: "change_slug", project_id: project.id, slug: newSlug });
    h.check("same-slug change → 200 ok", rSame.status === 200 && rSame.data?.changed === true, JSON.stringify(rSame.data));
    h.check("same-slug change reports unchanged: true", rSame.data?.unchanged === true, JSON.stringify(rSame.data?.unchanged));
    h.check("same-slug change returns the unchanged slug", rSame.data?.slug === newSlug, JSON.stringify(rSame.data?.slug));

    // ===================== 9. audit event written =====================
    const audits = await svc.entities.AuditLog.filter({ project_id: project.id, action: "project.slug_changed" }, "-created_date", 5);
    const ev = audits[0];
    h.check("project.slug_changed audit event written", !!ev, "missing");
    h.check("audit metadata records from→to", !!ev && ev.metadata?.from === oldSlug && ev.metadata?.to === newSlug, JSON.stringify(ev?.metadata));

    // cleanup custom domain (no workspace_id field, so cleanupWorkspace's filter misses it)
    await svc.entities.CustomDomain.delete(domain.id).catch(() => {});
    await svc.entities.Project.delete(other.id).catch(() => {});

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    await cleanupWorkspace(svc, ws?.id, CLEANUP);
  }
}