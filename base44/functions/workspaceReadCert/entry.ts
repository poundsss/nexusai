// Certification for the authorized workspace read/mutation surface (shared/workspaceRead.ts):
// contract shape and authorization boundary, synthetic in-memory store only (no real records
// are created or changed). This is the surface the browser uses now that direct SDK access
// to Workspace / WorkspaceMember / Project / Deployment / AppRecord is RLS-locked.
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { memStore } from "../../shared/memStoreCert.ts";
import {
  ownWorkspacesRead, workspaceProjectsRead, workspaceProjectRead, workspaceMembersRead,
  workspaceDeploymentsRead, workspaceRecordsRead, workspaceRecordsClear, workspaceRename,
} from "../../shared/workspaceRead.ts";

export default async function () {
  const h = createHarness();
  const raw = memStore({
    Workspace: [
      { id: "w1", owner_id: "u_owner", name: "Main", status: "active" },
      { id: "w2", owner_id: "u_other", name: "Other", status: "active" },
      { id: "w3", owner_id: "u_owner", name: "Suspended", status: "suspended" },
    ],
    Project: [
      { id: "p1", workspace_id: "w1", name: "A", slug: "a" },
      { id: "p2", workspace_id: "w2", name: "Foreign", slug: "b" },
      { id: "p3", workspace_id: "w3", name: "OnSuspended", slug: "c" },
    ],
    WorkspaceMember: [
      { id: "m1", workspace_id: "w1", user_id: "u_view", email: "v@x.test", role: "viewer", status: "active" },
      { id: "m2", workspace_id: "w1", user_id: "u_editor", email: "e@x.test", role: "editor", status: "active" },
      { id: "m3", workspace_id: "w1", user_id: "u_admin", email: "a@x.test", role: "admin", status: "active" },
      { id: "m4", workspace_id: "w1", user_id: "u_gone", email: "g@x.test", role: "editor", status: "removed" },
      { id: "m5", workspace_id: "w1", user_id: "u_pend", email: "p@x.test", role: "viewer", status: "invited" },
    ],
    Deployment: [
      { id: "d1", project_id: "p1", workspace_id: "w1", status: "LIVE" },
      { id: "d2", project_id: "p2", workspace_id: "w2", status: "LIVE" },
    ],
    AppRecord: [
      { id: "r1", project_id: "p1", entity_name: "Task", data: { title: "one" } },
      { id: "r2", project_id: "p1", entity_name: "Note", data: { title: "other" } },
      { id: "r3", project_id: "p1", entity_name: "TRASH:Task", data: { title: "trashed" } },
      { id: "r4", project_id: "p2", entity_name: "Task", data: { title: "foreign" } },
    ],
  });
  // workspaceRead resolves the service role itself; hand it a plain {entities} client and
  // keep the raw store so the cert can read tables after mutations.
  const svc = { ...raw.svc, asServiceRole: raw.svc };
  const seed = () => svc;
  const owner = { id: "u_owner", email: "o@x.test" };
  const run = (user, fn, args) => fn(seed(), user, args).then((r) => r).catch((e) => e);

  // 1. Workspace listing + project scoping
  const own = await run(owner, ownWorkspacesRead);
  h.check("1a. own_workspaces returns only the caller's workspaces", own.workspaces?.length === 2 && !JSON.stringify(own).includes("u_other"), `${own.workspaces?.length}`);
  const list = await run(owner, workspaceProjectsRead, { workspace_id: "w1" });
  h.check("1b. the project list is scoped to one workspace", list.projects?.length === 1 && list.projects[0].id === "p1" && !JSON.stringify(list).includes("Foreign"), `${list.projects?.length}`);
  const listFields = await run(owner, workspaceProjectsRead, { workspace_id: "w1", fields: ["name"] });
  h.check("1c. the fields projection keeps only the named fields (+id)", listFields.projects?.[0]?.name === "A" && listFields.projects?.[0]?.slug === undefined, JSON.stringify(listFields.projects?.[0]));
  const badFields = await run(owner, workspaceProjectsRead, { workspace_id: "w1", fields: [42] });
  h.check("1d. an invalid fields list is a 400", badFields instanceof Error && badFields.status === 400, `${badFields.status}`);
  const badLimit = await run(owner, workspaceProjectsRead, { workspace_id: "w1", limit: "abc" });
  h.check("1e. a non-numeric limit falls back to the default (no 500)", Array.isArray(badLimit.projects), `${badLimit.projects?.length}`);

  // 2. Single project read + authorization
  const pOwner = await run(owner, workspaceProjectRead, "p1");
  h.check("2a. the owner reads the full authorized project record", pOwner.project?.id === "p1" && pOwner.project.slug === "a", `${pOwner.project?.id}`);
  const pViewer = await run({ id: "u_view", email: "v@x.test" }, workspaceProjectRead, "p1");
  h.check("2b. a viewer may read (project.read)", pViewer.project?.id === "p1", `${pViewer.code || "ok"}`);
  const pOut = await run({ id: "u_out", email: "z@x.test" }, workspaceProjectRead, "p1");
  h.check("2c. a non-member is refused 403 NOT_A_MEMBER", pOut instanceof Error && pOut.status === 403 && pOut.code === "NOT_A_MEMBER", `${pOut.status}:${pOut.code}`);
  const pRemoved = await run({ id: "u_gone", email: "g@x.test" }, workspaceProjectRead, "p1");
  h.check("2d. a removed member is refused", pRemoved instanceof Error && pRemoved.status === 403, `${pRemoved.status}`);
  const pInvited = await run({ id: "u_pend", email: "p@x.test" }, workspaceProjectRead, "p1");
  h.check("2e. a merely invited member is refused (status invited authorizes nothing)", pInvited instanceof Error && pInvited.status === 403, `${pInvited.status}`);
  const pMissing = await run(owner, workspaceProjectRead, "");
  h.check("2f. a missing project_id is a 400", pMissing instanceof Error && pMissing.status === 400, `${pMissing.status}`);

  // 3. Members listing
  const mem = await run(owner, workspaceMembersRead, "w1");
  h.check("3a. members listing excludes removed members and never emits invite_token",
    mem.members?.length === 4 && !JSON.stringify(mem).includes("invite_token") && !JSON.stringify(mem).includes("u_gone"), `${mem.members?.length}`);
  const memOut = await run({ id: "u_out", email: "z@x.test" }, workspaceMembersRead, "w1");
  h.check("3b. a non-member cannot list members", memOut instanceof Error && memOut.status === 403, `${memOut.status}`);

  // 4. Deployments
  const dep = await run(owner, workspaceDeploymentsRead, { project_id: "p1" });
  h.check("4a. deployments are scoped to the authorized project", dep.deployments?.length === 1 && dep.deployments[0].id === "d1" && !JSON.stringify(dep).includes("d2"), `${dep.deployments?.length}`);
  const depOut = await run({ id: "u_out", email: "z@x.test" }, workspaceDeploymentsRead, { project_id: "p1" });
  h.check("4b. a non-member cannot list deployments", depOut instanceof Error && depOut.status === 403, `${depOut.status}`);

  // 5. App data records: read + clear
  const recView = await run({ id: "u_view", email: "v@x.test" }, workspaceRecordsRead, { project_id: "p1", entity_name: "Task" });
  h.check("5a. a viewer reads one entity's records, scoped to the project", recView.records?.length === 1 && recView.records[0].id === "r1", `${recView.records?.length}`);
  const recOut = await run({ id: "u_out", email: "z@x.test" }, workspaceRecordsRead, { project_id: "p1", entity_name: "Task" });
  h.check("5b. a non-member cannot read records", recOut instanceof Error && recOut.status === 403, `${recOut.status}`);
  const clearView = await run({ id: "u_view", email: "v@x.test" }, workspaceRecordsClear, { project_id: "p1", entity_name: "Task" });
  h.check("5c. a viewer cannot clear records (project.write required)", clearView instanceof Error && clearView.status === 403, `${clearView.status}`);
  const clearEditor = await run({ id: "u_editor", email: "e@x.test" }, workspaceRecordsClear, { project_id: "p1", entity_name: "Task" });
  h.check("5d. an editor clears the entity's live rows only (trash rows untouched)", clearEditor.deleted === 1 && raw.t("AppRecord").find((r) => r.id === "r3"), `${clearEditor.deleted}`);
  const clearMissing = await run({ id: "u_editor", email: "e@x.test" }, workspaceRecordsClear, { project_id: "p1" });
  h.check("5e. a clear without entity_name is a 400", clearMissing instanceof Error && clearMissing.status === 400, `${clearMissing.status}`);

  // 6. Workspace rename
  const renView = await run({ id: "u_view", email: "v@x.test" }, workspaceRename, { workspace_id: "w1", name: "X" });
  h.check("6a. a viewer cannot rename (workspace.rename = owner/admin)", renView instanceof Error && renView.status === 403, `${renView.status}`);
  const renAdmin = await run({ id: "u_admin", email: "a@x.test" }, workspaceRename, { workspace_id: "w1", name: "Renamed by admin" });
  h.check("6b. an admin renames and the row keeps identity", renAdmin.workspace?.id === "w1" && renAdmin.workspace?.name === "Renamed by admin" && raw.t("Workspace")[0].name === "Renamed by admin", `${renAdmin.workspace?.name}`);
  const renBad = await run(owner, workspaceRename, { workspace_id: "w1", name: "  " });
  h.check("6c. a blank name is a 400", renBad instanceof Error && renBad.status === 400, `${renBad.status}`);
  const renLong = await run(owner, workspaceRename, { workspace_id: "w1", name: "x".repeat(121) });
  h.check("6d. a name over 120 characters is a 400", renLong instanceof Error && renLong.status === 400, `${renLong.status}`);
  const renSusp = await run(owner, workspaceRename, { workspace_id: "w3", name: "S" });
  h.check("6e. rename on a suspended workspace is blocked (lifecycle)", renSusp instanceof Error && renSusp.status === 403, `${renSusp.status}`);
  const renForeign = await run({ id: "u_other", email: "o2@x.test" }, workspaceRename, { workspace_id: "w1", name: "Nope" });
  h.check("6f. another workspace's owner cannot rename this one", renForeign instanceof Error && renForeign.status === 403, `${renForeign.status}`);
  const readsSusp = await run(owner, workspaceProjectRead, "p3");
  h.check("6g. lifecycle reads stay available on a suspended workspace", readsSusp.project?.id === "p3", `${readsSusp.code || "ok"}`);

  return harnessResponse(h);
}