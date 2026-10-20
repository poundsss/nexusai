// MCP tool: create_project (WRITE) handler. Creates the project + initial scaffold version, and
// when a build prompt is given enqueues the EXISTING background AI run — it never builds
// synchronously and never runs its own AI pipeline. Invoked only through mcpTool, which binds
// identity, selects the workspace, audits and maps errors.
import { apiError, guardRunEnqueue } from "./platformApi.ts";
import { scaffoldFiles } from "./scaffold.ts";
import { createProjectWithinLimit } from "./planLimits.ts";
import { resolveRole, requireCapability, requireActiveWorkspace } from "./rbac.ts";

export async function mcpCreateProjectHandler({ base44, user, workspace, body }) {
    const name = String(body.name || "").trim();
    if (!name) throw apiError("INVALID_INPUT", "name is required");
    if (name.length > 80) throw apiError("INVALID_INPUT", "name must be 80 characters or fewer");
    const prompt = String(body.prompt || body.description || "").trim().slice(0, 8000);

    // C-3.1 step 2: the caller's role in the resolved workspace must grant project.create
    // (owner/admin/editor) and the workspace must be active, before any read or write below.
    const role = await resolveRole(base44, workspace, user);
    if (!role) throw apiError("FORBIDDEN", "Not a member of this workspace", 403);
    requireCapability(role, "project.create");
    requireActiveWorkspace(workspace, "project.create");

    // Idempotency: a retried create with the same name returns the existing project
    // instead of a duplicate.
    const existing = (await (base44.asServiceRole || base44).entities.Project.filter({ workspace_id: workspace.id, name }, "-created_date", 1))[0];
    if (existing) {
      return { project_id: existing.id, name: existing.name, status: existing.status, current_version: existing.version_count || 0, reused_existing: true, run_id: null };
    }

    // Same plan project limit as the builder's creation path, against the authorized workspace.
    const project = await createProjectWithinLimit(base44, workspace, { name, description: prompt, framework: "preact-htm", status: "draft", version_count: 1, last_build_status: "success" });
    const files = scaffoldFiles(name);
    await (base44.asServiceRole || base44).entities.ProjectFile.bulkCreate(files.map((f) => ({ project_id: project.id, ...f, frozen: false })));
    await base44.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "Initial scaffold", changed_files: files.map((f) => ({ path: f.path, change: "added" })), snapshot: { files, entities: [] } });

    let runId = null;
    if (prompt) {
      await guardRunEnqueue(base44, { ...project, id: project.id }, prompt);
      const conv = await base44.entities.Conversation.create({ project_id: project.id, title: prompt.slice(0, 80) });
      await base44.entities.Message.create({ project_id: project.id, conversation_id: conv.id, role: "user", content: prompt });
      const now = new Date().toISOString();
      const run = await base44.entities.AIRun.create({ project_id: project.id, conversation_id: conv.id, status: "QUEUED", phase: "plan", mode: "default", prompt, steps: [], started_at: now, heartbeat_at: now, base_version_number: 1 });
      runId = run.id;
    }
    return { project_id: project.id, name, status: project.status, current_version: 1, run_id: runId, reused_existing: false };
}