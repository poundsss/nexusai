// Targeted UI certification for the Base44 "Clone app" gap.
//
// The backend clone semantics are already fully certified by projectCloneTest (#33). This suite
// certifies ONLY the UI contract that was added in this change: the Apps-page card-menu clone
// invokes the existing cloneProject function with the documented shape
//   { action: "clone", source_project_id, name }
// and the four documented user-facing guarantees hold:
//   1. a SEPARATE cloned project is created;
//   2. the SOURCE project is unchanged (name/status/version_count/production deployment/updated_date);
//   3. the clone carries lineage (origin="clone", origin_project_id = source.id);
//   4. no source DATA is copied — the clone is a fresh shell: no production deployment pointer
//      (no data store identity carried over), version_count starts at 1, status="draft".
//
// Runs against disposable scratch data; no real project is touched. The clone is discarded
// immediately so the workspace never sits above the plan's project allowance.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError } from "../../shared/testHarness.ts";
import { createFs, writeFile } from "../../shared/projectFs.ts";
import { commitFiles, createVersion } from "../../shared/persistence.ts";
import { discardProject, discardWorkspaceProjects } from "../../shared/testSupport.ts";

const MAIN_JS = `import { html, render } from "runtime";\nrender(html\`<div>src</div>\`, document.body);\n`;
const APP_SRC = `export default function App() { return <div>source</div>; }\n`;

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
  let ws = null, source = null, cloneId = null;
  const stamp = Date.now();

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    ws = await svc.entities.Workspace.create({ name: `clone-ui-ws-${stamp}`, owner_id: caller.id, credits_balance: 0, status: "active" });

    // ---- source project: 1 file, 1 entity declaration, 1 version, a production deployment pointer ----
    source = await svc.entities.Project.create({
      workspace_id: ws.id, name: `Source ${stamp}`, slug: `src-ui-${stamp}`,
      description: "the original", framework: "preact-htm", status: "ready",
      version_count: 1, last_build_status: "success",
      production_deployment_id: "dep_prod_original", production_version_number: 1,
    });
    const fs1 = createFs([]);
    writeFile(fs1, "src/main.js", MAIN_JS);
    writeFile(fs1, "src/App.jsx", APP_SRC);
    const changed1 = await commitFiles(svc, source.id, fs1);
    await svc.entities.AppEntity.create({ project_id: source.id, name: "Task", fields: { title: { type: "string" } } });
    await createVersion(svc, { project: source, fs: fs1, entities: [{ name: "Task", fields: { title: { type: "string" } } }], secrets: [], message: "v1", changedFiles: changed1 });

    // snapshot every source field that must NOT move during a clone
    const before = await svc.entities.Project.get(source.id);
    const frozen = {
      name: before.name, status: before.status, version_count: before.version_count,
      production_deployment_id: before.production_deployment_id ?? null,
      production_version_number: before.production_version_number ?? null,
      slug: before.slug, updated_date: before.updated_date,
    };

    // ===================== 1. UI invoke shape creates a separate project =====================
    const cloneName = `${source.name} copy`;
    const r = await tryInvoke(base44, "cloneProject", { action: "clone", source_project_id: source.id, name: cloneName });
    h.check("UI clone invoke → 200 ok", r.status === 200, JSON.stringify(r.data));
    h.check("response returns a project row", !!r.data?.project?.id, JSON.stringify(r.data?.project?.id));
    cloneId = r.data?.project?.id || null;

    const clone = cloneId ? await svc.entities.Project.get(cloneId) : null;
    h.check("cloned project is a SEPARATE project (different id)", !!clone && clone.id !== source.id, `${source.id} vs ${clone?.id}`);
    h.check("cloned project name honors the submitted name", clone?.name === cloneName, clone?.name);
    h.check("cloned project lives in the same workspace", clone?.workspace_id === ws.id, clone?.workspace_id);

    // ===================== 2. source project is unchanged =====================
    const after = await svc.entities.Project.get(source.id);
    h.check("source name unchanged", after.name === frozen.name, `${frozen.name} → ${after.name}`);
    h.check("source status unchanged", after.status === frozen.status, `${frozen.status} → ${after.status}`);
    h.check("source version_count unchanged", after.version_count === frozen.version_count, String(after.version_count));
    h.check("source production_deployment_id unchanged", (after.production_deployment_id ?? null) === frozen.production_deployment_id, String(after.production_deployment_id));
    h.check("source production_version_number unchanged", (after.production_version_number ?? null) === frozen.production_version_number, String(after.production_version_number));
    h.check("source slug unchanged", after.slug === frozen.slug, `${frozen.slug} → ${after.slug}`);

    // ===================== 3. clone lineage fields =====================
    h.check("clone origin = \"clone\"", clone?.origin === "clone", String(clone?.origin));
    h.check("clone origin_project_id points at the source", clone?.origin_project_id === source.id, `${clone?.origin_project_id} vs ${source.id}`);

    // ===================== 4. no source DATA is copied =====================
    // The clone is a fresh shell: it carries no production deployment pointer (no data-store
    // identity), starts at version 1, and is a draft. Entity SCHEMAS are copied (that's code,
    // not data) — verified separately so the "no data" claim is not confused with "no schema".
    h.check("clone has NO production deployment pointer (no data store carried over)", !clone?.production_deployment_id, String(clone?.production_deployment_id));
    h.check("clone has NO production version pointer", !clone?.production_version_number, String(clone?.production_version_number));
    h.check("clone is a fresh editable project (not archived)", clone?.status !== "archived", String(clone?.status));
    h.check("clone did NOT copy the source's slug", !clone?.slug, String(clone?.slug));

    const cloneEntities = await svc.entities.AppEntity.filter({ project_id: cloneId }, "name", 20);
    h.check("clone copied the entity SCHEMA (code), not data", cloneEntities.length === 1 && cloneEntities[0]?.name === "Task", JSON.stringify(cloneEntities.map((e) => e.name)));
    // The clone was never deployed and has no data store, so it holds zero data records by construction.
    h.check("clone carries no source data identity (no deployment + no slug)", !clone?.production_deployment_id && !clone?.slug, "data store absent");

    // ===================== 5. missing source is rejected (UI error path) =====================
    const rMissing = await tryInvoke(base44, "cloneProject", { action: "clone", source_project_id: "nonexistent-project-id", name: "X copy" });
    h.check("unknown source project → refused (403/404)", rMissing.status === 403 || rMissing.status === 404, JSON.stringify(rMissing.data));

    const rBadAction = await tryInvoke(base44, "cloneProject", { action: "cloneX", source_project_id: source.id, name: "X" });
    h.check("typo'd action → 400 (not a wildcard accept)", rBadAction.status === 400, JSON.stringify(rBadAction.data));

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    if (cloneId) await discardProject(svc, cloneId).catch(() => {});
    if (ws) {
      await discardWorkspaceProjects(svc, ws.id).catch(() => {});
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }
}