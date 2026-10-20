// Branch service: named working lines over the project's files.
//
//   list   — the project's branches (creates the implicit "Main" row on first touch)
//   create — snapshots the current working files into a NEW branch and makes it active
//   switch — persists the working files into the branch being LEFT, then materializes the
//            target branch's snapshot into the working files
//
// Branches never create versions and never touch deployments: they are pre-commit working
// state. Snapshots live in storage (real file sets exceed the inline field ceiling), so a
// branch row holds only its URL plus a file count.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { packJson, unpackJson, packFileContent, unpackFileRecords } from "../../shared/blobStore.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    const capability = action === "list" ? "project.read" : "project.write";
    const { project, workspace } = await loadAuthorizedProject(base44, user, String(body.project_id || ""), capability);
    const svc = base44.asServiceRole || base44;

    const listBranches = () => svc.entities.ProjectBranch.filter({ project_id: project.id }, "created_date", 100);

    // The default "Main" row is created on first touch. Until the working files first leave
    // main, it carries no snapshot — the working files ARE main.
    const ensureRows = async () => {
      const rows = await listBranches();
      if (rows.length > 0) return rows;
      const main = await svc.entities.ProjectBranch.create({
        project_id: project.id, name: "Main", is_default: true, is_active: true, files_count: 0, created_by: user.id,
      });
      return [main];
    };

    const snapshotWorkingFiles = async () => {
      const files = await unpackFileRecords(await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 500));
      return {
        url: await packJson(svc, `branch_${project.id}_${Date.now()}.json`, {
          files: files.map((f) => ({ path: f.path, content: f.content, frozen: !!f.frozen })),
        }),
        count: files.length,
      };
    };

    if (action === "list") {
      const rows = await ensureRows();
      return Response.json({
        branches: rows.map((r) => ({
          id: r.id, name: r.name, is_default: !!r.is_default, is_active: !!r.is_active,
          files_count: r.files_count || 0, created_date: r.created_date,
        })),
      });
    }

    if (action === "create") {
      const rows = await ensureRows();
      const raw = String(body.name || "").trim().slice(0, 40);
      const name = raw || `Branch ${rows.length}`;
      const snap = await snapshotWorkingFiles();
      // The files being captured ARE main's state, so main gets its snapshot now — the first
      // switch back to main can then restore exactly what leaving it preserved.
      const main = rows.find((r) => r.is_default) || rows[0];
      if (!main.snapshot_url) {
        await svc.entities.ProjectBranch.update(main.id, { snapshot_url: snap.url, files_count: snap.count });
      }
      const row = await svc.entities.ProjectBranch.create({
        project_id: project.id, name, is_active: false, snapshot_url: snap.url, files_count: snap.count, created_by: user.id,
      });
      await svc.entities.ProjectBranch.updateMany({ project_id: project.id }, { $set: { is_active: false } });
      await svc.entities.ProjectBranch.update(row.id, { is_active: true });
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "branch.created",
        resource: "ProjectBranch", resource_id: row.id, metadata: { name, files_count: snap.count },
      });
      return Response.json({ branch: { id: row.id, name }, files: snap.count });
    }

    if (action === "switch") {
      const targetId = String(body.branch_id || "");
      const rows = await ensureRows();
      const target = rows.find((r) => r.id === targetId);
      if (!target) return Response.json({ error: "Branch not found" }, { status: 404 });
      const active = rows.find((r) => r.is_active) || rows[0];
      // Persist what the working files look like NOW into the branch being left.
      const snap = await snapshotWorkingFiles();
      await svc.entities.ProjectBranch.update(active.id, { snapshot_url: snap.url, files_count: snap.count });
      // Materialize the target's snapshot into the working files.
      let files = snap.count;
      if (target.snapshot_url) {
        const targetSnap = await unpackJson(target.snapshot_url);
        const current = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 500);
        const byPath = new Map(current.map((f) => [f.path, f]));
        const snapPaths = new Set(targetSnap.files.map((f) => f.path));
        for (const f of targetSnap.files) {
          const packed = await packFileContent(svc, f.path, f.content);
          const cur = byPath.get(f.path);
          if (cur) await svc.entities.ProjectFile.update(cur.id, { ...packed, frozen: !!f.frozen });
          else await svc.entities.ProjectFile.create({ project_id: project.id, path: f.path, ...packed, frozen: !!f.frozen });
        }
        for (const cur of current) if (!snapPaths.has(cur.path)) await svc.entities.ProjectFile.delete(cur.id);
        files = targetSnap.files.length;
      }
      await svc.entities.ProjectBranch.updateMany({ project_id: project.id }, { $set: { is_active: false } });
      await svc.entities.ProjectBranch.update(target.id, { is_active: true });
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "branch.switched",
        resource: "ProjectBranch", resource_id: target.id, metadata: { from: active.name, to: target.name, files },
      });
      return Response.json({ branch: { id: target.id, name: target.name }, files });
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}