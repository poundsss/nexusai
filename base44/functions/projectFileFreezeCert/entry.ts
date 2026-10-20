// Certification for projectFileFreeze — synthetic in-memory store only, no real records.
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { memStore } from "../../shared/memStoreCert.ts";
import { projectFileFreeze } from "../../shared/projectFileFreeze.ts";

export default async function () {
  const h = createHarness();
  const seed = () => memStore({
    Workspace: [{ id: "w1", owner_id: "u_owner", status: "active" }, { id: "w2", owner_id: "u_other", status: "active" }, { id: "w3", owner_id: "u_owner", status: "suspended" }],
    Project: [{ id: "p1", workspace_id: "w1", name: "A" }, { id: "p2", workspace_id: "w2", name: "B" }, { id: "p3", workspace_id: "w3", name: "C" }],
    ProjectFile: [
      { id: "f1", project_id: "p1", path: "src/a.js", content: "A", frozen: false },
      { id: "f2", project_id: "p1", path: "src/b.js", content: "B", frozen: true },
      { id: "fx", project_id: "p2", path: "src/x.js", content: "X", frozen: false },
      { id: "f3", project_id: "p3", path: "src/c.js", content: "C", frozen: false },
    ],
    WorkspaceMember: [
      { id: "m1", workspace_id: "w1", user_id: "u_edit", email: "e@x.test", role: "editor", status: "active" },
      { id: "m2", workspace_id: "w1", user_id: "u_view", email: "v@x.test", role: "viewer", status: "active" },
    ],
  });
  const owner = { id: "u_owner", email: "o@x.test" };
  const call = async (user, pid, updates) => { const s = seed(); const r = await projectFileFreeze(s.svc, user, pid, updates).catch((e) => e); return { r, f: s.t("ProjectFile") }; };
  const get = (f, id) => f.find((x) => x.id === id);

  const o = await call(owner, "p1", [{ file_id: "f1", frozen: true }, { file_id: "f2", frozen: false }]);
  h.check("1a. owner may freeze/unfreeze", o.r.updated === 2 && get(o.f, "f1").frozen === true && get(o.f, "f2").frozen === false, JSON.stringify(o.r));
  h.check("1b. unrelated fields unchanged", get(o.f, "f1").content === "A" && get(o.f, "f1").path === "src/a.js" && get(o.f, "f1").project_id === "p1" && Object.keys(get(o.f, "f1")).length === 5, JSON.stringify(get(o.f, "f1")));
  const e = await call({ id: "u_edit", email: "e@x.test" }, "p1", [{ file_id: "f1", frozen: true }]);
  h.check("1c. editor may freeze", e.r.updated === 1 && get(e.f, "f1").frozen === true, `${e.r.code || "ok"}`);
  const v = await call({ id: "u_view", email: "v@x.test" }, "p1", [{ file_id: "f1", frozen: true }]);
  h.check("2a. viewer refused 403, no write", v.r instanceof Error && v.r.status === 403 && get(v.f, "f1").frozen === false, `${v.r.status}:${v.r.code}`);
  const n = await call({ id: "u_out", email: "z@x.test" }, "p1", [{ file_id: "f1", frozen: true }]);
  h.check("2b. non-member refused 403, no write", n.r instanceof Error && n.r.status === 403 && get(n.f, "f1").frozen === false, `${n.r.status}:${n.r.code}`);
  const s = await call(owner, "p3", [{ file_id: "f3", frozen: true }]);
  h.check("2c. suspended workspace refused 403, no write", s.r instanceof Error && s.r.status === 403 && s.r.code === "WORKSPACE_INACTIVE" && get(s.f, "f3").frozen === false, `${s.r.status}:${s.r.code}`);
  const fo = await call(owner, "p1", [{ file_id: "f1", frozen: true }, { file_id: "fx", frozen: true }]);
  h.check("3a. foreign file rejects whole request before any write", fo.r instanceof Error && fo.r.status === 404 && get(fo.f, "f1").frozen === false && get(fo.f, "fx").frozen === false, `${fo.r.status}:${fo.r.code}`);
  const bad = await call(owner, "p1", [{ file_id: "f1", frozen: "yes", content: "PWN" }]);
  h.check("3b. non-boolean frozen rejected, no write", bad.r instanceof Error && bad.r.status === 400 && get(bad.f, "f1").content === "A" && get(bad.f, "f1").frozen === false, `${bad.r.status}`);
  const extra = await call(owner, "p1", [{ file_id: "f1", frozen: true, content: "PWN", path: "evil" }]);
  h.check("3c. extra fields in an update are ignored", get(extra.f, "f1").content === "A" && get(extra.f, "f1").path === "src/a.js" && get(extra.f, "f1").frozen === true, JSON.stringify(get(extra.f, "f1")));
  const empty = await call(owner, "p1", []);
  h.check("3d. empty updates rejected 400", empty.r instanceof Error && empty.r.status === 400, `${empty.r.status}`);
  return harnessResponse(h);
}