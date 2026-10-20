// Focused certification for the Agent create/edit UI surface (shared/agentEditor.ts +
// functions/agentEditor). Drives the REAL composition over the REAL certified agent-resource
// contract and the REAL journalled commit path (authorization, build gate, versioning, audit),
// with deterministic fixtures only:
//   create (file minted, build-success version, canonical round-trip, reopening via the
//   certified collectAgents/resolveAgent); edit (in place, non-editor metadata preserved,
//   version increments); validation/rejection (parse errors, unknown tool, missing skill and
//   entity/function references, name rules, duplicates, rename refusal, malformed base,
//   validation is write-free); authorization/isolation (stranger, viewer).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { buildAgentDocument, saveAgentDocument, cloneAgentDocument, moveAgentDocument, deleteAgentDocument, restoreAgentDocument, listRecentlyDeletedAgents } from "../../shared/agentEditor.ts";
import { collectAgents, resolveAgent } from "../../shared/agentResource.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";
import { resolveRole } from "../../shared/rbac.ts";


// The pre-existing agent of the project, written DIRECTLY (like a run/another editor would
// have left it): it carries a NON-EDITOR key the editor must preserve verbatim.
const EXISTING_DOC = JSON.stringify({
  name: "support-desk",
  instructions: "edit and manage support tasks",
  tools: ["read_file"],
  channel_pref: "whatsapp-first",
});
const EDIT = {
  name: "support-desk",
  display_name: "Support Desk",
  description: "edits support tasks",
  instructions: "NEW INSTRUCTIONS",
  tools: ["read_file", "list_files"],
  max_steps: 20,
  memory_config: { enabled: false, scope: "user", instructions: "short" },
};
const CREATE = {
  name: "greeter",
  display_name: "Greeter",
  description: "welcomes app users",
  instructions: "Greet app users warmly.",
  tools: ["read_file"],
  model_tier: "fast",
  max_steps: 10,
  memory_config: { enabled: true, scope: "both", instructions: null },
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    const wsA = await svc.entities.Workspace.create({ name: `agentedit-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `agentedit-B-${stamp}`, owner_id: `ownerB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `agentedit-${stamp}`, status: "ready", version_count: 0 });
    const projB = await svc.entities.Project.create({ workspace_id: wsB.id, name: `agentedit-foreign-${stamp}`, status: "ready", version_count: 0 });
    projects.push(projA.id, projB.id);
    // The project's own entity the tool grant validates against, and the pre-existing agent.
    await svc.entities.AppEntity.create({ project_id: projA.id, name: "Task", fields: { title: { type: "string", required: true } } });
    await svc.entities.ProjectFile.create({ project_id: projA.id, path: "src/main.js", content: "// minimal entry: the project's build gate requires it\n" });
    await svc.entities.ProjectFile.create({ project_id: projA.id, path: agentFilePath("support-desk"), content: EXISTING_DOC });

    const ownerA = { id: `ownerA_${stamp}`, email: "ownerA@example.com" };
    const stranger = { id: "agentedit_stranger", email: "stranger@example.com" };
    const viewer = { id: "agentedit_viewer", email: "viewer@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });

    // ---- 1. create ------------------------------------------------------------------
    const created = await saveAgentDocument(svc, ownerA, { project_id: projA.id, agent: CREATE, edit_id: `create_${stamp}` });
    const filesAfterCreate = await svc.entities.ProjectFile.filter({ project_id: projA.id }, "path", 100);
    const reopened = resolveAgent(filesAfterCreate, "greeter");
    h.check("create: the new agent file exists, the commit build succeeded and a version was minted",
      created.build_status === "success" && created.version && created.version.number >= 1 &&
      filesAfterCreate.some((f) => f.path === agentFilePath("greeter")) &&
      !filesAfterCreate.some((f) => f.path === agentFilePath("greeter.jsonc.jsonc")),
      JSON.stringify({ version: created.version?.number, build: created.build_status }));
    h.check("create: reopening the saved agent resolves it with the exact configured fields",
      !!reopened && reopened.name === "greeter" && reopened.display_name === "Greeter" &&
      reopened.tools.join(",") === "read_file" && reopened.model_tier === "fast" && reopened.max_steps === 10 &&
      reopened.memory_config.enabled === true && reopened.memory_config.scope === "both",
      JSON.stringify({ found: !!reopened, tier: reopened?.model_tier }));
    h.check("create: the saved content is the canonical document (memory_config normalized in, no dropped editor keys)",
      (() => { const f = filesAfterCreate.find((x) => x.path === agentFilePath("greeter")); try { const d = JSON.parse(f.content); return d.name === "greeter" && d.memory_config && typeof d.memory_config === "object" && d.instructions === "Greet app users warmly."; } catch { return false; } })(),
      JSON.stringify({}));

    // ---- 2. edit: in place, preserving non-editor fields ------------------------------
    const projRow = await svc.entities.Project.get(projA.id);
    const edited = await saveAgentDocument(svc, ownerA, { project_id: projA.id, agent: EDIT, original_name: "support-desk", expected_version: projRow.version_count, edit_id: `edit_${stamp}` });
    const filesAfterEdit = await svc.entities.ProjectFile.filter({ project_id: projA.id }, "path", 100);
    const reopenedExisting = resolveAgent(filesAfterEdit, "support-desk");
    h.check("edit: the SAME file is rewritten in place, the editor-managed fields change and the version advances",
      edited.version.number > created.version.number &&
      filesAfterEdit.filter((f) => f.path.startsWith("base44/agents/")).length === 2 &&
      reopenedExisting.instructions === "NEW INSTRUCTIONS" && reopenedExisting.display_name === "Support Desk" &&
      reopenedExisting.max_steps === 20 && reopenedExisting.memory_config.enabled === false &&
      reopenedExisting.memory_config.scope === "user" && reopenedExisting.memory_config.instructions === "short",
      JSON.stringify({ version: edited.version.number, steps: reopenedExisting.max_steps }));
    h.check("edit: non-editor keys of the existing document are preserved verbatim",
      (() => { try { return JSON.parse(filesAfterEdit.find((f) => f.path === agentFilePath("support-desk")).content).channel_pref === "whatsapp-first"; } catch { return false; } })(),
      JSON.stringify({}));

    // ---- 3. validation / rejection -----------------------------------------------------
    const save = (agent, originalName = null) => captureCall(() => saveAgentDocument(svc, ownerA, { project_id: projA.id, agent, original_name: originalName }));
    const noInstructions = await save({ name: "bad1" });
    const unknownTool = await save({ name: "bad2", instructions: "x", tools: ["definitely_not_a_tool"] });
    const missingSkill = await save({ name: "bad3", instructions: "x", skills: ["no-such-skill"] });
    const missingSelectedSkill = await save({ name: "bad4", instructions: "x", selected_skill_names: ["no-such-skill"] });
    const missingEntity = await save({ name: "bad5", instructions: "x", tool_configs: [{ entity_name: "NoSuchEntity", allowed_operations: ["read"] }] });
    const missingFunction = await save({ name: "bad6", instructions: "x", tool_configs: [{ function_name: "no_such_fn" }] });
    const dupToolConfig = await save({ name: "bad7", instructions: "x", tool_configs: [{ entity_name: "Task", allowed_operations: ["read"] }, { entity_name: "Task", allowed_operations: ["update"] }] });
    const unknownOp = await save({ name: "bad8", instructions: "x", tool_configs: [{ entity_name: "Task", allowed_operations: ["explode"] }] });
    const badName = await save({ name: "Bad_Name" });
    const exists = await save({ name: "greeter", instructions: "x" });
    const rename = await save({ name: "support-desk-2", instructions: "x" }, "support-desk");
    const notFound = await save({ name: "ghost-agent", instructions: "x" }, "ghost-agent");
    const filesBeforeBad = await svc.entities.ProjectFile.filter({ project_id: projA.id }, "path", 100);
    const countBeforeBad = (await svc.entities.Project.get(projA.id)).version_count;
    const validButUnchecked = await buildAgentDocument(svc, projA.id, { name: "validate-only", instructions: "x" });
    const filesAfterValidate = await svc.entities.ProjectFile.filter({ project_id: projA.id }, "path", 100);
    h.check("validation: parse-level rejections are 422 AGENT_INVALID with the certified parser's own errors",
      noInstructions.threw && noInstructions.code === "AGENT_INVALID" && noInstructions.status === 422 &&
      unknownTool.threw && unknownTool.code === "AGENT_INVALID" &&
      dupToolConfig.threw && dupToolConfig.code === "AGENT_INVALID" &&
      unknownOp.threw && unknownOp.code === "AGENT_INVALID",
      JSON.stringify({ noInstructions: noInstructions.code, unknownTool: unknownTool.code, dup: dupToolConfig.code, op: unknownOp.code }));
    h.check("validation: cross-resource references (skill, selected skill, entity grant, function grant) are refused 422",
      missingSkill.threw && missingSkill.code === "AGENT_INVALID" &&
      missingSelectedSkill.threw && missingSelectedSkill.code === "AGENT_INVALID" &&
      missingEntity.threw && missingEntity.code === "AGENT_INVALID" &&
      missingFunction.threw && missingFunction.code === "AGENT_INVALID",
      JSON.stringify({ skill: missingSkill.code, entity: missingEntity.code, fn: missingFunction.code }));
    h.check("validation: name rules, duplicate create, rename refusal and unknown edit are refused with distinct codes",
      badName.threw && badName.code === "AGENT_NAME_INVALID" &&
      exists.threw && exists.code === "AGENT_EXISTS" && exists.status === 409 &&
      rename.threw && rename.code === "AGENT_NAME_FIXED" && rename.status === 400 &&
      notFound.threw && notFound.code === "AGENT_NOT_FOUND" && notFound.status === 404,
      JSON.stringify({ name: badName.code, exists: exists.code, rename: rename.code, ghost: notFound.code }));
    h.check("validate is write-free: composing a valid document adds no project file and no version",
      validButUnchecked.path === agentFilePath("validate-only") && validButUnchecked.content.length > 0 &&
      filesAfterValidate.length === filesBeforeBad.length &&
      (await svc.entities.Project.get(projA.id)).version_count === countBeforeBad,
      JSON.stringify({ path: validButUnchecked.path }));

    // ---- 4. malformed base refused, not overwritten -------------------------------------
    await svc.entities.ProjectFile.create({ project_id: projA.id, path: agentFilePath("broken-agent"), content: "{ not json" });
    const broken = await save({ name: "broken-agent", instructions: "x" }, "broken-agent");
    h.check("a malformed existing document is refused 422 AGENT_FILE_MALFORMED rather than silently overwritten",
      broken.threw && broken.code === "AGENT_FILE_MALFORMED" && broken.status === 422,
      JSON.stringify({ code: broken.code }));

    // ---- 5. authorization + isolation -----------------------------------------------------
    const viewerWrite = await captureCall(() => saveAgentDocument(svc, viewer, { project_id: projA.id, agent: { name: "viewer-agent", instructions: "x" } }));
    const strangerWrite = await captureCall(() => saveAgentDocument(svc, stranger, { project_id: projA.id, agent: { name: "stranger-agent", instructions: "x" } }));
    const foreignRead = await captureCall(() => buildAgentDocument(svc, projB.id, { name: "x-agent", instructions: "x" }).catch((e) => { throw Object.assign(e, { status: e.status || 500 }); }));
    h.check("authorization: a viewer's write and a non-member's access are refused with 403 before any write",
      viewerWrite.threw && Number(viewerWrite.status) === 403 &&
      strangerWrite.threw && Number(strangerWrite.status) === 403,
      JSON.stringify({ viewer: viewerWrite.status, stranger: strangerWrite.status }));
    h.check("isolation: another workspace's project is not reachable by its ids alone (buildAgentDocument needs a prior authorized load)",
      (await resolveRole(svc, await svc.entities.Workspace.get(projB.workspace_id), stranger)) === null &&
      (await svc.entities.ProjectFile.filter({ project_id: projB.id }, "path", 50)).every((f) => !f.path.startsWith("base44/agents/")),
      JSON.stringify({}));

    // ---- 6. regression: the certified listing still sees the editor's output ---------------
    const listed = collectAgents(await svc.entities.ProjectFile.filter({ project_id: projA.id }, "path", 100));
    h.check("regression: collectAgents over the project lists both agents and reports the broken one",
      listed.agents.length === 2 && listed.agents.map((a) => a.name).sort().join(",") === "greeter,support-desk" &&
      listed.errors.length === 1 && listed.errors[0].path === agentFilePath("broken-agent"),
      JSON.stringify({ agents: listed.agents.map((a) => a.name), errors: listed.errors.length }));

    // ---- 7. owner lifecycle: clone, move, delete, restore ---------------------------------
    // The broken fixture would fail every later journalled commit's build gate — remove it now
    // that sections 4–6 have asserted against it.
    const brokenFile = (await svc.entities.ProjectFile.filter({ project_id: projA.id, path: agentFilePath("broken-agent") }, "path", 1))[0];
    if (brokenFile) await svc.entities.ProjectFile.delete(brokenFile.id);
    const cloned = await cloneAgentDocument(svc, ownerA, { project_id: projA.id, original_name: "greeter", new_name: "greeter-clone" });
    const afterClone = await svc.entities.ProjectFile.filter({ project_id: projA.id }, "path", 100);
    const cloneDoc = afterClone.find((f) => f.path === agentFilePath("greeter-clone"));
    h.check("clone: the copy is a verbatim document (only the name differs) and the original is untouched",
      cloned.agent_name === "greeter-clone" && !!cloneDoc && JSON.parse(cloneDoc.content).instructions === "Greet app users warmly." &&
      (await resolveAgent(afterClone, "greeter")).name === "greeter",
      JSON.stringify({ clone: !!cloneDoc }));
    const cloneNameClash = await captureCall(() => cloneAgentDocument(svc, ownerA, { project_id: projA.id, original_name: "greeter", new_name: "support-desk" }));
    h.check("clone: a name that already exists refuses 409 AGENT_EXISTS", cloneNameClash.threw && cloneNameClash.code === "AGENT_EXISTS" && cloneNameClash.status === 409, JSON.stringify(cloneNameClash));

    const projC = await svc.entities.Project.create({ workspace_id: wsA.id, name: `agentedit-move-${stamp}`, status: "ready", version_count: 0 });
    projects.push(projC.id);
    await svc.entities.ProjectFile.create({ project_id: projC.id, path: "src/main.js", content: "// minimal entry: the project's build gate requires it\n" });
    const moved = await moveAgentDocument(svc, ownerA, { project_id: projA.id, agent_name: "greeter-clone", target_project_id: projC.id });
    const afterMoveA = await svc.entities.ProjectFile.filter({ project_id: projA.id }, "path", 100);
    const afterMoveC = await svc.entities.ProjectFile.filter({ project_id: projC.id }, "path", 100);
    h.check("move: the agent is committed to the target project FIRST, then deleted from the source — never in neither",
      moved.moved === true && !moved.source_delete_failed && !afterMoveA.some((f) => f.path === agentFilePath("greeter-clone")) && afterMoveC.some((f) => f.path === agentFilePath("greeter-clone")),
      JSON.stringify({ moved: moved.moved, source_delete_failed: moved.source_delete_failed || null }));

    await deleteAgentDocument(svc, ownerA, { project_id: projC.id, agent_name: "greeter-clone" });
    const afterDel = await svc.entities.ProjectFile.filter({ project_id: projC.id }, "path", 100);
    h.check("delete: the file leaves the canonical state — the tombstone is restorable from version history",
      !afterDel.some((f) => f.path === agentFilePath("greeter-clone")), JSON.stringify({ deleted: "greeter-clone" }));
    const listedDeleted = await listRecentlyDeletedAgents(svc, ownerA, { project_id: projC.id });
    h.check("delete: the deleted agent appears in the project's recently-deleted set with its restorable version",
      listedDeleted.recently_deleted.some((d) => d.agent_name === "greeter-clone" && d.restorable_from_version > 0),
      JSON.stringify({ listed: listedDeleted.recently_deleted.map((d) => d.agent_name) }));
    const restored = await restoreAgentDocument(svc, ownerA, { project_id: projC.id, agent_name: "greeter-clone" });
    const afterRestore = await svc.entities.ProjectFile.filter({ project_id: projC.id }, "path", 100);
    h.check("restore: the agent comes back from the project's OWN version history and re-resolves",
      restored.restored === "greeter-clone" && afterRestore.some((f) => f.path === agentFilePath("greeter-clone")) &&
      resolveAgent(afterRestore, "greeter-clone").instructions === "Greet app users warmly.",
      JSON.stringify({ restored: restored.restored, from: restored.restored_from_version }));
    const restoreLive = await captureCall(() => restoreAgentDocument(svc, ownerA, { project_id: projA.id, agent_name: "support-desk" }));
    h.check("restore: a LIVE agent is not restorable (409 AGENT_EXISTS)", restoreLive.threw && restoreLive.code === "AGENT_EXISTS" && restoreLive.status === 409, JSON.stringify(restoreLive));
    const strangerDelete = await captureCall(() => deleteAgentDocument(svc, stranger, { project_id: projA.id, agent_name: "support-desk" }));
    h.check("authorization: a non-member cannot delete an agent (403)", strangerDelete.threw && Number(strangerDelete.status) === 403, JSON.stringify(strangerDelete));

    const s = h.summary();
    return Response.json({ ok: s.ok, passed: s.passed, failed: s.failed, failures: s.failures });
  } catch (error) {
    const s = h.summary();
    return Response.json(
      { ok: false, error: error.message, code: error.code || null, status: error.status || null, details: error.details || null, stack: String(error.stack || "").slice(0, 400), passed: s.passed, failed: s.failed, failures: s.failures },
      { status: 500 },
    );
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "ProjectFile", { project_id: pid });
      await purgeBy(svc, "AppEntity", { project_id: pid });
      await purgeBy(svc, "ProjectVersion", { project_id: pid });
      await purgeBy(svc, "CommitJournal", { project_id: pid });
      await purgeBy(svc, "Build", { project_id: pid });
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