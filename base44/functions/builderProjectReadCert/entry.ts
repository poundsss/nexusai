// Certification for builderProjectRead: contract shape + authorization boundary, synthetic
// in-memory store only (no real records are created or changed).
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { memStore } from "../../shared/memStoreCert.ts";
import { builderProjectRead } from "../../shared/builderProjectRead.ts";

export default async function () {
  const h = createHarness();
  const seed = () => memStore({
    Workspace: [{ id: "w1", owner_id: "u_owner", status: "active" }, { id: "w2", owner_id: "u_other", status: "active" }, { id: "w3", owner_id: "u_owner", status: "suspended" }],
    Project: [
      { id: "p1", workspace_id: "w1", name: "A", slug: "a", version_count: 3 },
      { id: "p2", workspace_id: "w2", name: "B", slug: "b", version_count: 1 },
      { id: "p3", workspace_id: "w3", name: "C", slug: "c", version_count: 1 },
    ],
    ProjectFile: [
      { id: "f2", project_id: "p1", path: "src/b.js", content: "b", frozen: true },
      { id: "f1", project_id: "p1", path: "src/a.js", content: "", content_url: "store://a" },
      { id: "fx", project_id: "p2", path: "src/x.js", content: "foreign" },
    ],
    ProjectSecret: [{ id: "s1", project_id: "p1", name: "K", value: "sk_live_SENTINEL" }],
    WorkspaceMember: [
      { id: "m1", workspace_id: "w1", user_id: "u_view", email: "v@x.test", role: "viewer", status: "active" },
      { id: "m2", workspace_id: "w1", user_id: "u_gone", email: "g@x.test", role: "editor", status: "removed" },
    ],
  }).svc;
  const run = (user, pid) => builderProjectRead(seed(), user, pid).catch((e) => e);
  const owner = { id: "u_owner", email: "o@x.test" };

  const ok = await run(owner, "p1");
  h.check("1a. owner gets the full Project record", ok.project?.id === "p1" && ok.project.slug === "a" && ok.project.version_count === 3 && ok.project.workspace_id === "w1", JSON.stringify(ok.project));
  h.check("1b. files are full records sorted by path", ok.files?.map((f) => f.id).join() === "f1,f2", JSON.stringify(ok.files?.map((f) => f.id)));
  h.check("1c. id, frozen, content and content_url are preserved", ok.files?.[0].content_url === "store://a" && ok.files?.[1].frozen === true && ok.files?.[1].content === "b", "fields kept");
  h.check("1d. no foreign files or secrets in the response", !JSON.stringify(ok).includes("foreign") && !JSON.stringify(ok).includes("SENTINEL"), "clean");
  const viewer = await run({ id: "u_view", email: "v@x.test" }, "p1");
  h.check("2a. a viewer may read (project.read)", viewer.project?.id === "p1", `${viewer.code || "ok"}`);
  const outsider = await run({ id: "u_out", email: "z@x.test" }, "p1");
  h.check("2b. a non-member is refused 403 NOT_A_MEMBER", outsider instanceof Error && outsider.status === 403 && outsider.code === "NOT_A_MEMBER", `${outsider.status}:${outsider.code}`);
  const removed = await run({ id: "u_gone", email: "g@x.test" }, "p1");
  h.check("2c. a removed member is refused", removed instanceof Error && removed.status === 403, `${removed.status}:${removed.code}`);
  const foreign = await run(owner, "p2");
  h.check("2d. another workspace's project is refused", foreign instanceof Error && foreign.status === 403, `${foreign.status}:${foreign.code}`);
  const suspended = await run(owner, "p3");
  h.check("2e. reads stay available on a suspended workspace", suspended.project?.id === "p3", `${suspended.code || "ok"}`);
  const missing = await run(owner, "");
  h.check("2f. missing project_id is a 400", missing instanceof Error && missing.status === 400, `${missing.status}`);
  const pre = await builderProjectRead(seed(), owner, "p1", "src/b").catch((e) => e);
  h.check("3a. path_prefix returns only matching files", pre.files?.map((f) => f.id).join() === "f2", JSON.stringify(pre.files?.map((f) => f.id)));
  const none = await builderProjectRead(seed(), owner, "p1", "base44/connectors/").catch((e) => e);
  h.check("3b. unmatched prefix returns an empty list", Array.isArray(none.files) && none.files.length === 0, `${none.files?.length}`);
  const bad = await Promise.all(["../x", "/abs", "", 5].map((p) => builderProjectRead(seed(), owner, "p1", p).catch((e) => e)));
  h.check("3c. invalid prefixes are a 400", bad.every((e) => e instanceof Error && e.status === 400), bad.map((e) => e?.status).join());
  const pOut = await builderProjectRead(seed(), { id: "u_out", email: "z@x.test" }, "p1", "src/").catch((e) => e);
  h.check("3d. prefix does not bypass authorization", pOut instanceof Error && pOut.status === 403, `${pOut.status}`);
  return harnessResponse(h);
}