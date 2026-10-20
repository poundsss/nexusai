// Phase 16A — Workspace Skills: targeted verification.
//
// Read-only with respect to EXISTING clusters: exercises the new shared CRUD + injection path
// against real scratch rows, then re-checks the already-certified Builder skill catalog and
// Agent Skills contract for regressions. No other cluster is touched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { makeChecks } from "../../shared/testChecklist.ts";
import { requireCapability } from "../../shared/rbac.ts";
import { capabilitiesFor } from "../../shared/rbac.ts";
import { effectivePlan } from "../../shared/planLimits.ts";
import {
  listWorkspaceSkills, createWorkspaceSkill, updateWorkspaceSkill, deleteWorkspaceSkill,
  loadEnabledWorkspaceSkills, workspaceSkillsBlock, WORKSPACE_SKILLS_LIMIT,
  planAllowsWorkspaceSkills, selectSkills, skillContracts, skillGuidanceBlock,
} from "../../shared/skills.ts";
import { parseAgentSkillDocument } from "../../shared/agentSkillResource.ts";

const attempt = async (fn, ...args) => {
  try { return { ok: true, value: await fn(...args) }; }
  catch (e) { return { ok: false, code: e.code, status: e.status, message: e.message }; }
};

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

    // --- fixtures ---------------------------------------------------------------
    const ws = await svc.entities.Workspace.create({ name: `WSK ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    cleanup.push(() => wipeSkills(ws.id));
    cleanup.push(() => svc.entities.Workspace.delete(ws.id));
    const ws2 = await svc.entities.Workspace.create({ name: `WSK2 ${Date.now()}`, owner_id: `wsk-stranger-${Date.now()}`, credits_balance: 0 });
    cleanup.push(() => wipeSkills(ws2.id));
    cleanup.push(() => svc.entities.Workspace.delete(ws2.id));
    const member = await svc.entities.WorkspaceMember.create({ workspace_id: ws2.id, email: caller.email, user_id: caller.id, role: "editor", status: "active" });
    cleanup.push(() => svc.entities.WorkspaceMember.delete(member.id));

    // --- 1. plan gate -------------------------------------------------------------
    const free = await effectivePlan(svc, ws.id);
    expect("1a. a plan-less workspace resolves to the free plan (tier 0)", free.plan?.tier_rank === 0, String(free.plan?.tier_rank));
    expect("1b. the free plan does not allow workspace skills", planAllowsWorkspaceSkills(free.plan) === false, "");
    const sub = await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "builder_monthly", status: "active" });
    cleanup.push(() => svc.entities.Subscription.delete(sub.id));
    const builder = await effectivePlan(svc, ws.id);
    expect("1c. an active Builder subscription resolves to tier 6", builder.plan?.tier_rank === 6, String(builder.plan?.tier_rank));
    expect("1d. the Builder plan allows workspace skills", planAllowsWorkspaceSkills(builder.plan) === true, "");

    // --- 2. CRUD ------------------------------------------------------------------
    const created = await createWorkspaceSkill(svc, { workspace_id: ws.id, name: "brand-guidelines", description: "Applies to marketing pages.", instructions: "Use the approved palette.", created_by: caller.id });
    expect("2a. create returns an enabled record", created.enabled === true && created.name === "brand-guidelines", created.id);
    const listed = await listWorkspaceSkills(svc, { workspace_id: ws.id });
    expect("2b. list shows the created skill with its instructions", listed.length === 1 && listed[0].instructions === "Use the approved palette.", "");
    const updated = await updateWorkspaceSkill(svc, { workspace_id: ws.id, skill_id: created.id, patch: { enabled: false, name: "brand-guidelines-v2" }, updated_by: caller.id });
    expect("2c. update persists the enabled=false toggle", updated.enabled === false && updated.name === "brand-guidelines-v2", "");
    const afterDelete = await deleteWorkspaceSkill(svc, { workspace_id: ws.id, skill_id: created.id, deleted_by: caller.id });
    expect("2d. delete removes the record", afterDelete.deleted === true && (await listWorkspaceSkills(svc, { workspace_id: ws.id })).length === 0, "");

    // --- 3. validation (fail closed) ----------------------------------------------
    expect("3a. empty instructions are refused", (await attempt(createWorkspaceSkill, svc, { workspace_id: ws.id, name: "x", description: "d", instructions: "   " })).code === "SKILL_INVALID", "");
    expect("3b. oversized instructions are refused", (await attempt(createWorkspaceSkill, svc, { workspace_id: ws.id, name: "x", description: "d", instructions: "a".repeat(20001) })).code === "SKILL_INVALID", "");
    expect("3c. an unknown skill id resolves to 404", (await attempt(updateWorkspaceSkill, svc, { workspace_id: ws.id, skill_id: "nope", patch: { name: "y" } })).code === "WORKSPACE_SKILL_NOT_FOUND", "");

    // --- 4. workspace isolation ----------------------------------------------------
    expect("4a. another workspace lists nothing", (await listWorkspaceSkills(svc, { workspace_id: ws2.id })).length === 0, "");
    const iso = await createWorkspaceSkill(svc, { workspace_id: ws.id, name: "iso", description: "d", instructions: "i", created_by: caller.id });
    expect("4b. a skill addressed from another workspace is not found", (await attempt(updateWorkspaceSkill, svc, { workspace_id: ws2.id, skill_id: iso.id, patch: { name: "hijack" } })).code === "WORKSPACE_SKILL_NOT_FOUND", "");
    expect("4c. a delete from another workspace is not found", (await attempt(deleteWorkspaceSkill, svc, { workspace_id: ws2.id, skill_id: iso.id })).code === "WORKSPACE_SKILL_NOT_FOUND", "");

    // --- 5. RBAC mapping (entry-level capability) -----------------------------------
    expect("5a. an editor cannot manage skills (no secret.manage)", (await attempt(() => requireCapability("editor", "secret.manage"))).status === 403, "");
    expect("5b. owner and admin hold secret.manage", capabilitiesFor("owner").includes("secret.manage") && capabilitiesFor("admin").includes("secret.manage"), "");
    expect("5c. listing is available to every member (project.read)", capabilitiesFor("viewer").includes("project.read"), "");

    // --- 6. enabled/disabled + fail-closed loader ------------------------------------
    const rows = await svc.entities.WorkspaceSkill.bulkCreate([
      { workspace_id: ws.id, name: "on", description: "d", instructions: "ENABLED RULE", enabled: true, created_by: caller.id, created_at: new Date().toISOString() },
      { workspace_id: ws.id, name: "off", description: "d", instructions: "DISABLED RULE", enabled: false, created_by: caller.id, created_at: new Date().toISOString() },
      { workspace_id: ws.id, name: "bad", description: "d", instructions: "   ", enabled: true, created_by: caller.id, created_at: new Date().toISOString() },
    ]);
    expect("6a. the loader returns only ENABLED skills", (await loadEnabledWorkspaceSkills(svc, ws.id)).some((s) => s.name === "on"), "");
    expect("6b. a disabled skill is never loaded", !(await loadEnabledWorkspaceSkills(svc, ws.id)).some((s) => s.name === "off"), "");
    expect("6c. a malformed record is never injected (fail closed)", !(await loadEnabledWorkspaceSkills(svc, ws.id)).some((s) => s.name === "bad"), "");

    // --- 7. Builder context injection -------------------------------------------------
    const block = workspaceSkillsBlock(await loadEnabledWorkspaceSkills(svc, ws.id));
    expect("7a. the block carries the enabled skill's name and instructions", block.includes("## on") && block.includes("ENABLED RULE"), block.slice(0, 120));
    expect("7b. the block never carries a disabled skill's rules", !block.includes("DISABLED RULE"), "");
    expect("7c. an empty or failed load injects an empty string", workspaceSkillsBlock([]) === "" && workspaceSkillsBlock(null) === "", "");
    expect("7d. the block is bounded by the existing skills-block ceiling", block.length <= 20000, String(block.length));

    // --- 8. existing Builder catalog regression (untouched) ---------------------------
    const contracts = skillContracts();
    expect("8a. the code-defined catalog still validates", contracts.length === 6 && contracts.every((c) => c.checksum), String(contracts.length));
    const strategy = selectSkills({ mode: "default", prompt: "add a backend api endpoint with a secret", paths: [], phase: "plan" });
    expect("8b. deterministic catalog selection still matches backend work", strategy.skills.some((s) => s.skill_id === "backend-functions"), JSON.stringify((strategy.skills || []).map((s) => s.skill_id)));
    expect("8c. catalog guidance blocks still render", skillGuidanceBlock(strategy, "planner", { mode: "default" }).includes("SKILLS"), "");

    // --- 9. Agent Skills regression (untouched) ---------------------------------------
    const goodDoc = parseAgentSkillDocument("base44/agent-skills/test.md", "---\nname: test\ndescription: when to apply\n---\nBody rules.");
    expect("9a. agent skill parsing still accepts a valid document", goodDoc.ok === true && goodDoc.skill.name === "test", "");
    const badDoc = parseAgentSkillDocument("base44/agent-skills/test.md", "no frontmatter");
    expect("9b. agent skill parsing still refuses a malformed document", badDoc.ok === false, "");

    // --- 10. 100-skill limit -----------------------------------------------------------
    const before = (await svc.entities.WorkspaceSkill.filter({ workspace_id: ws.id }, "created_date", 500)).length;
    const bulk = await svc.entities.WorkspaceSkill.bulkCreate(
      Array.from({ length: WORKSPACE_SKILLS_LIMIT - 1 - before }, (_, i) => ({
        workspace_id: ws.id, name: `bulk-${i}`, description: "d", instructions: "rule", enabled: true, created_by: caller.id, created_at: new Date().toISOString(),
      })),
    );
    expect("10a. the workspace is one skill below the limit", before + (bulk || []).length === WORKSPACE_SKILLS_LIMIT - 1, String(before + (bulk || []).length));
    const res100 = await attempt(createWorkspaceSkill, svc, { workspace_id: ws.id, name: "hundredth", description: "d", instructions: "i", created_by: caller.id });
    expect("10b. the 100th skill is accepted", res100.ok === true, res100.message || "");
    expect("10c. the 101st skill is refused", (await attempt(createWorkspaceSkill, svc, { workspace_id: ws.id, name: "one-too-many", description: "d", instructions: "i", created_by: caller.id })).code === "WORKSPACE_SKILLS_LIMIT", "");

    // --- 11. audit ---------------------------------------------------------------------
    const audits = await svc.entities.AuditLog.filter({ workspace_id: ws.id }, "-created_date", 30);
    const actions = audits.map((a) => a.action);
    expect("11a. create, update and delete are audited", actions.includes("workspace_skill.created") && actions.includes("workspace_skill.updated") && actions.includes("workspace_skill.deleted"), actions.slice(0, 8).join(","));

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