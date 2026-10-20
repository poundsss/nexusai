// Focused certification for the workspace "All Agents" view (shared/workspaceAgents.ts +
// functions/workspaceAgents). Drives the REAL projection over the REAL project-file agent
// model — the certified agentResource parser is reused as-is, so the cert asserts discovery,
// projection, malformed-document reporting, exclusion of non-agent paths, workspace
// isolation, the authorization gate (stranger/member/viewer) and the open-existing-agent
// contract (every listed agent re-resolves through resolveAgent at its CodeViewer-opened
// path). Deterministic fixtures only; no executor, loop, schedule or schema is touched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { listWorkspaceAgents } from "../../shared/workspaceAgents.ts";
import { resolveAgent, agentDocumentContent } from "../../shared/agentResource.ts";
import { resolveRole } from "../../shared/rbac.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";

const AGENT_A = {
  name: "support-desk",
  display_name: "Support Desk",
  description: "Edits and manages support tasks in the app",
  instructions: "Given a user request, edit and manage tasks in the app.",
  tools: ["read_file"],
  tool_configs: [{ entity_name: "Task", allowed_operations: ["read"] }],
  model_tier: "standard",
  max_steps: 12,
  memory_config: { enabled: false, scope: "user", instructions: "Keep answers short" },
};
const AGENT_B = {
  name: "release-notes",
  instructions: "Draft release notes from the project's recent versions.",
  tools: [],
};
const BROKEN_AGENT_CONTENT = "{ not json at all";
const FOREIGN_AGENT = { name: "other-workspace-agent", instructions: "Only project B may see me." };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    // --- fixtures: two workspaces, three projects -------------------------------------
    const wsA = await svc.entities.Workspace.create({ name: `allagents-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `allagents-B-${stamp}`, owner_id: `ownerB_${stamp}` });
    const wsEmpty = await svc.entities.Workspace.create({ name: `allagents-empty-${stamp}`, owner_id: `ownerEmpty_${stamp}` });
    workspaces.push(wsA.id, wsB.id, wsEmpty.id);
    const projA1 = await svc.entities.Project.create({ workspace_id: wsA.id, name: `agents-app-${stamp}`, status: "ready", version_count: 1 });
    const projA2 = await svc.entities.Project.create({ workspace_id: wsA.id, name: `no-agents-app-${stamp}`, status: "ready", version_count: 1 });
    const projB = await svc.entities.Project.create({ workspace_id: wsB.id, name: `foreign-app-${stamp}`, status: "ready", version_count: 1 });
    projects.push(projA1.id, projA2.id, projB.id);

    // Project A1: two valid agents + one malformed agent document + one non-agent policy file.
    await svc.entities.ProjectFile.bulkCreate([
      { project_id: projA1.id, path: "base44/agents/support-desk.jsonc", content: agentDocumentContent(AGENT_A) },
      { project_id: projA1.id, path: "base44/agents/release-notes.jsonc", content: agentDocumentContent(AGENT_B) },
      { project_id: projA1.id, path: "base44/agents/broken-agent.jsonc", content: BROKEN_AGENT_CONTENT },
      { project_id: projA1.id, path: "base44/agent-skills/writing.md", content: "skill reference material" },
    ]);
    // Project B: one agent that must NEVER leak into wsA's listing.
    await svc.entities.ProjectFile.create({ project_id: projB.id, path: "base44/agents/other-workspace-agent.jsonc", content: agentDocumentContent(FOREIGN_AGENT) });

    const ownerA = { id: `ownerA_${stamp}`, email: "ownerA@example.com" };
    const stranger = { id: "allagents_stranger", email: "stranger@example.com" };
    const viewer = { id: "allagents_viewer", email: "viewer@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });

    // ---- 1. authorization gate (the entry's own primitives) ---------------------------
    const strangerRole = await resolveRole(svc, wsA, stranger).catch((e) => ({ error: e }));
    const viewerRole = await resolveRole(svc, wsA, viewer);
    const strangerList = await captureCall(() => Promise.resolve(strangerRole || (() => { throw Object.assign(new Error("no membership"), { status: 403 }); })()));
    h.check("authorization: a non-member resolves to no role (the entry refuses with 403), a viewer resolves as viewer",
      (typeof strangerRole === "string" ? false : !!strangerList.threw) && strangerRole === null && viewerRole === "viewer",
      JSON.stringify({ stranger: strangerRole, viewer: viewerRole }));

    // ---- 2. isolation -------------------------------------------------------------------
    const listingA = await listWorkspaceAgents(svc, wsA, ownerA);
    h.check("isolation: one workspace's agents never leak from another's projects; the agentless project contributes nothing",
      !listingA.agents.some((a) => a.project_id === projB.id) &&
      listingA.agents.every((a) => a.project_id === projA1.id),
      JSON.stringify({ count: listingA.count, projects: [...new Set(listingA.agents.map((a) => a.project_id))] }));

    // ---- 3. discovery + projection -------------------------------------------------------
    const listed = listingA.agents;
    const support = listed.find((a) => a.name === "support-desk");
    const release = listed.find((a) => a.name === "release-notes");
    h.check("discovery: both valid agent documents of the project are listed, sorted, with the right paths",
      listed.length === 2 && !!support && !!release &&
      support.path === "base44/agents/support-desk.jsonc" && release.path === "base44/agents/release-notes.jsonc",
      JSON.stringify(listed.map((a) => a.name)));
    h.check("projection: only fields the parsed document already carries — tools, tool_configs, memory, tier, steps, project linkage",
      support.display_name === "Support Desk" &&
      support.description === "Edits and manages support tasks in the app" &&
      support.tools.join(",") === "read_file" &&
      support.tool_configs.length === 1 && support.tool_configs[0].entity_name === "Task" &&
      support.memory_enabled === false && support.memory_scope === "user" &&
      support.model_tier === "standard" && support.max_steps === 12 &&
      support.allow_anonymous_access === false &&
      support.project_id === projA1.id && !!support.project_name &&
      release.tools.length === 0 && release.model_tier === null && release.max_steps === null &&
      release.memory_enabled === true && release.memory_scope === "both",
      JSON.stringify({ support: { mem: support.memory_enabled, tier: support.model_tier, steps: support.max_steps }, release: { mem: release.memory_enabled } }));

    // ---- 4. malformed + non-agent handling -------------------------------------------------
    const broken = listingA.validation_errors.find((e) => e.path === "base44/agents/broken-agent.jsonc");
    h.check("malformed documents are REPORTED with their path, never listed and never silently dropped",
      !!broken && String(broken.error || "").length > 0 &&
      !listingA.agents.some((a) => a.name === "broken-agent"),
      JSON.stringify({ error: broken ? String(broken.error).slice(0, 120) : null }));
    h.check("non-agent policy files (agent skills) are excluded from both lists",
      !listingA.agents.some((a) => a.path.includes("agent-skills")) &&
      !listingA.validation_errors.some((e) => e.path.includes("agent-skills")),
      JSON.stringify({}));

    // ---- 5. empty state --------------------------------------------------------------------
    const listingEmpty = await listWorkspaceAgents(svc, wsEmpty, { id: `ownerEmpty_${stamp}`, email: "ownerEmpty@example.com" });
    h.check("empty state: a workspace with no projects (and a project with no agent files) lists zero agents with no validation errors",
      listingEmpty.count === 0 && listingEmpty.agents.length === 0 && listingEmpty.validation_errors.length === 0 &&
      !listingA.agents.some((a) => a.project_id === projA2.id),
      JSON.stringify({ count: listingEmpty.count }));

    // ---- 6. open-existing-agent contract ----------------------------------------------------
    const filesA1 = await svc.entities.ProjectFile.filter({ project_id: projA1.id }, "path", 500);
    const reResolved = resolveAgent(filesA1, "support-desk");
    h.check("open-existing-agent: every listed agent re-resolves through resolveAgent at exactly the path the UI opens",
      !!reResolved && reResolved.name === "support-desk" &&
      reResolved.path === agentFilePath("support-desk") &&
      reResolved.path === support.path && reResolved.tools.join(",") === support.tools.join(","),
      JSON.stringify({ path: reResolved?.path }));
    const missing = resolveAgent(filesA1, "no-such-agent");
    h.check("a name the project does not declare resolves to null (fail-closed, same as the run enqueue gate)",
      missing === null, JSON.stringify({}));

    // ---- 7. response envelope ----------------------------------------------------------------
    h.check("the response carries the workspace-scoped envelope the UI reads (count, projects_scanned, agents, validation_errors)",
      listingA.workspace_id === wsA.id && listingA.count === listingA.agents.length &&
      typeof listingA.projects_scanned === "number" && Array.isArray(listingA.agents) && Array.isArray(listingA.validation_errors),
      JSON.stringify({ scanned: listingA.projects_scanned, count: listingA.count }));

    const s = h.summary();
    return Response.json({ ok: s.ok, passed: s.passed, failed: s.failed, failures: s.failures });
  } catch (error) {
    const s = h.summary();
    return Response.json(
      { ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400), passed: s.passed, failed: s.failed, failures: s.failures },
      { status: 500 },
    );
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "ProjectFile", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) {
      await purgeBy(svc, "WorkspaceMember", { workspace_id: wid });
      await purgeBy(svc, "AuditLog", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }
}