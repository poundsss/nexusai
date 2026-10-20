// Certification for the DOCUMENTED (Base44) per-app Agent Skill limit: an app may declare at
// most 100 Agent Skills (MAX_SKILLS_PER_APP, flat base44/agent-skills/<name>.md files).
// Base44's behavior above the limit is NOT published (UNKNOWN), so this runtime fails CLOSED:
//   • the BUILD (buildEngine) refuses with a deterministic error when the valid collected
//     skills exceed 100 — restore and deploy inherit this (a restore must build, a deploy
//     refuses a non-success build); no duplicate checks are added there;
//   • the DIRECT push path (resourceSync) refuses with RESOURCE_VALIDATION_FAILED (400)
//     against the RESULTING file set before anything is persisted.
// Probes: exactly 100 → PASS, 101 → FAIL, in both surfaces. No runtime injection, executor,
// deploy logic, UI, workspace skills or `selected_skill_names` limit is touched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createFs } from "../../shared/projectFs.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { agentSkillDocumentContent, MAX_SKILLS_PER_APP } from "../../shared/agentSkillResource.ts";
import { CONFIG_FILE, configContent } from "../../shared/base44Layout.ts";
import { unpackFileRecords } from "../../shared/blobStore.ts";
import { pushResources } from "../../shared/resourceSync.ts";

// Minimal shippable project: manifest + the entry module the build requires + skill documents.
const ENTRY_FILE = "src/main.js";
const ENTRY_SRC = `export default function App() { return null; }\n`;
const skillDoc = (i) => agentSkillDocumentContent({
  name: `skill-${String(i).padStart(3, "0")}`,
  description: `Certification skill number ${i}.`,
  body: `Guidance for skill number ${i}.`,
});
const skillFiles = (n) => Array.from({ length: n }, (_, i) => ({ path: `base44/agent-skills/skill-${String(i + 1).padStart(3, "0")}.md`, content: skillDoc(i + 1) }));
const baseFiles = [
  { path: CONFIG_FILE, content: configContent("skill-limit-cert", "agent skill limit certification") },
  { path: ENTRY_FILE, content: ENTRY_SRC },
];

const compact = (h, error = null) => {
  const s = h.summary();
  return Response.json({
    ok: s.ok && !error, error: error?.message || null, stack: error ? String(error.stack || "").slice(0, 600) : null,
    passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length,
  }, { status: error ? 500 : 200 });
};

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    // ---- 1. build surface (pure): exactly 100 → success -------------------------------
    const build100 = runBuild(createFs([...baseFiles, ...skillFiles(100)]), [], []);
    h.check(`build: exactly ${MAX_SKILLS_PER_APP} agent skills builds successfully`,
      build100.status === "success" &&
      build100.logs.some((l) => l.includes(`${MAX_SKILLS_PER_APP} skill(s) validated`)) &&
      !build100.logs.some((l) => l.startsWith("error:")),
      JSON.stringify({ status: build100.status, errors: build100.logs.filter((l) => l.startsWith("error:")).slice(0, 3) }));

    // ---- 2. build surface (pure): 101 → deterministic fail ----------------------------
    const build101 = runBuild(createFs([...baseFiles, ...skillFiles(101)]), [], []);
    const build101Error = build101.logs.find((l) => l.startsWith("error:") && l.includes("at most"));
    h.check(`build: ${MAX_SKILLS_PER_APP + 1} agent skills fails the build with the documented-limit error`,
      build101.status === "failed" && !!build101Error && build101Error.includes(String(MAX_SKILLS_PER_APP + 1)),
      build101Error || JSON.stringify(build101.logs.filter((l) => l.startsWith("error:")).slice(0, 3)));

    // ---- 3. push surface (real persistence): exactly 100 → push ok --------------------
    // The sync layer synchronizes RESOURCE kinds only (no src/ frontend files), so the push
    // source is the manifest + the skill documents; the entry module rides along on the build
    // probes only.
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const ws = await svc.entities.Workspace.create({ name: `skill-limit-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "skill-limit-cert", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(project.id);

    const pushSource100 = [{ path: CONFIG_FILE, content: configContent("skill-limit-cert", "agent skill limit certification") }, ...skillFiles(100)];
    const push100 = await pushResources(base44, user, { project_id: project.id, resources: pushSource100, message: "100 skills push" });
    const rowsAfter100 = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 200);
    h.check(`push: exactly ${MAX_SKILLS_PER_APP} agent skills persists through the existing journalled path`,
      push100.ok && push100.version_created && push100.version === 1 && push100.created === 101 &&
      rowsAfter100.filter((f) => f.path.startsWith("base44/agent-skills/")).length === 100,
      JSON.stringify({ ok: push100.ok, created: push100.created, version: push100.version, rows: rowsAfter100.length }));

    // ---- 4. push surface: a push that takes the project to 101 → refused, untouched ---
    const preVersions = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 10);
    let refused = null;
    try {
      await pushResources(base44, user, { project_id: project.id, resources: pushSource100.slice(0, 1).concat(skillFiles(101)), message: "101 skills push" });
    } catch (e) { refused = e; }
    const postFiles = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 200);
    const postVersions = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 10);
    h.check(`push: a push that would take the project to ${MAX_SKILLS_PER_APP + 1} skills is refused (400, RESOURCE_VALIDATION_FAILED) and leaves the project untouched`,
      !!refused && refused.code === "RESOURCE_VALIDATION_FAILED" && refused.status === 400 &&
      String(refused.message || "").includes("at most") && String(refused.message || "").includes(String(MAX_SKILLS_PER_APP)) &&
      postFiles.length === rowsAfter100.length && postVersions.length === preVersions.length &&
      postFiles.filter((f) => f.path.startsWith("base44/agent-skills/")).length === 100,
      JSON.stringify({ code: refused?.code, message: String(refused?.message || "").slice(0, 140), rows: postFiles.length, versions: postVersions.length }));

    // ---- 5. build-after-push parity: the persisted 100-skill project still builds -----
    const persistedRows = await unpackFileRecords(
      (await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 200)).filter((f) => f.path.startsWith("base44/agent-skills/")),
    );
    const persisted100 = runBuild(createFs([...baseFiles, ...persistedRows.map((f) => ({ path: f.path, content: f.content }))]), [], []);
    h.check("parity: the persisted exactly-100 project passes the same build validation (restore/deploy inherit the gate)",
      persisted100.status === "success" && persistedRows.length === 100,
      JSON.stringify({ status: persisted100.status, rows: persistedRows.length, errors: persisted100.logs.filter((l) => l.startsWith("error:")).slice(0, 3) }));

    const s = h.summary();
    return Response.json({ ok: s.ok, passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length });
  } catch (error) {
    return compact(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["AuditLog", "TraceEvent", "AppRecord", "AppEntity", "ProjectSecret", "ProjectVersion", "Build", "ProjectFile"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["AuditLog", "WorkspaceMember", "Project"]);
    }
  }
}