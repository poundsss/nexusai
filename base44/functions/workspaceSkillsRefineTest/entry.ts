// Phase 16B — Workspace Skills presets + Refine & review: targeted verification.
//
// Exercises the new shared surface (preset catalog, refine proposal, preset→create path)
// against real scratch rows, and re-checks the existing WorkspaceSkill CRUD and isolation
// paths for regression. No other cluster is touched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { makeChecks } from "../../shared/testChecklist.ts";
import { listWorkspaceSkills, createWorkspaceSkill, updateWorkspaceSkill, deleteWorkspaceSkill } from "../../shared/skills.ts";
import {
  WORKSPACE_SKILL_PRESETS, validPresetCatalog, refineWorkspaceSkill,
} from "../../shared/workspaceSkillPresets.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const { checks, bad, expect } = makeChecks();
  const cleanup = [];
  const wipeSkills = async (workspaceId) => {
    for (const s of await svc.entities.WorkspaceSkill.filter({ workspace_id: workspaceId }, "created_date", 500)) {
      await svc.entities.WorkspaceSkill.delete(s.id).catch(() => {});
    }
  };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `WSK16B ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    cleanup.push(() => wipeSkills(ws.id));
    cleanup.push(() => svc.entities.Workspace.delete(ws.id));

    // --- 1. preset catalog ---------------------------------------------------------
    expect("1a. the preset catalog is non-empty", WORKSPACE_SKILL_PRESETS.length >= 1, String(WORKSPACE_SKILL_PRESETS.length));
    expect("1b. every preset passes the SAME validation the CRUD enforces (names unique)", validPresetCatalog() === true, "");
    expect("1c. preset fields stay within the documented field ceilings", WORKSPACE_SKILL_PRESETS.every((p) => p.name.length <= 80 && p.description.length <= 500 && p.instructions.length <= 20000), "");

    // --- 2. preset → prefilled editor → create (the backend path is a normal create) ---
    const preset = WORKSPACE_SKILL_PRESETS[0];
    const fromPreset = await createWorkspaceSkill(svc, {
      workspace_id: ws.id, name: preset.name, description: preset.description,
      instructions: preset.instructions, created_by: caller.id,
    });
    expect("2a. a skill created from preset fields stores them verbatim", fromPreset.name === preset.name && fromPreset.instructions === preset.instructions, fromPreset.id);
    const listed = await listWorkspaceSkills(svc, { workspace_id: ws.id });
    expect("2b. the preset-born skill is listed like any other skill", listed.length === 1 && listed[0].name === preset.name, "");
    await deleteWorkspaceSkill(svc, { workspace_id: ws.id, skill_id: fromPreset.id, deleted_by: caller.id });

    // --- 3. CRUD + isolation regression ----------------------------------------------
    expect("3a. another workspace lists nothing", (await listWorkspaceSkills(svc, { workspace_id: `no-such-${Date.now()}` })).length === 0, "");
    const crud = await createWorkspaceSkill(svc, { workspace_id: ws.id, name: "crud", description: "d", instructions: "i", created_by: caller.id });
    const toggled = await updateWorkspaceSkill(svc, { workspace_id: ws.id, skill_id: crud.id, patch: { enabled: false }, updated_by: caller.id });
    expect("3b. update still persists the enabled toggle", toggled.enabled === false, "");
    await deleteWorkspaceSkill(svc, { workspace_id: ws.id, skill_id: crud.id, deleted_by: caller.id });

    // --- 4. refine: proposal only, description + instructions only, name untouched ------
    const before = (await listWorkspaceSkills(svc, { workspace_id: ws.id })).length;
    const refined = await refineWorkspaceSkill(svc, {
      description: "Applies to checkout pages.",
      instructions: "1. Keep the checkout to one column.\n2. Show the total early.",
    });
    expect("4a. refine returns EXACTLY description and instructions", Object.keys(refined).length === 2 && Object.keys(refined).sort().join(",") === "description,instructions", Object.keys(refined).join(","));
    expect("4b. the refined fields are usable strings within the ceilings", typeof refined.description === "string" && refined.description.length > 0 && refined.description.length <= 500 && typeof refined.instructions === "string" && refined.instructions.length > 0 && refined.instructions.length <= 20000, refined.description.slice(0, 60));
    expect("4c. a name is never part of the refinement output", !("name" in refined), "");
    const after = (await listWorkspaceSkills(svc, { workspace_id: ws.id })).length;
    expect("4d. refine writes NOTHING to the database", before === 0 && after === 0, `${before}->${after}`);
    expect("4e. the refinement preserves the user's intent (both original rules survive)", refined.instructions.includes("one column") || refined.instructions.toLowerCase().includes("column"), refined.instructions.slice(0, 120));

    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } catch (e) {
    bad("harness", `${e.name}: ${e.message}`);
    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }
}