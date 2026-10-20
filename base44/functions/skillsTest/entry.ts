// #44 Skills certification.
//
// Focused on the Skills layer itself and its two integration points: the router's reserved
// (model + skill strategy) slot and the routing-policy read surface. Nothing here executes a
// provider call, writes a record or touches #38–#41 evidence: model selection runs with an
// explicit policy and persist=false, so the suite is side-effect free.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError } from "../../shared/testHarness.ts";
import {
  SKILL_CATALOG, SKILL_CONTRACT_VERSION, SKILL_PHASES, NO_SKILL_STRATEGY,
  skillContract, skillContracts, skillChecksum, selectSkills, materializeSkills,
  skillTools, skillRoutingHints, skillGuidanceBlock, skillStrategyRecord,
} from "../../shared/skills.ts";
import { allowedTools } from "../../shared/tools.ts";
import { selectModel, routerContract } from "../../shared/selfImprovingRouter.ts";
import { defaultPolicy, routingPolicyContract } from "../../shared/routingPolicy.ts";

// A prompt carrying secret-shaped material: nothing from it may reach a persisted strategy.
const SECRET_PROMPT = "add a backend webhook using API key sk_live_51NotARealKey and integration token ghp_ZZZZ for our design theme";
const clone = (c) => JSON.parse(JSON.stringify(c.map((s) => ({ ...s, triggers: { ...(s.triggers || {}), prompt: [], paths: [] } }))));

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const h = createHarness();
  try {
    // ---- 1. catalog validation fails closed
    h.check("catalog.valid: the shipped catalog validates", skillContracts().length === SKILL_CATALOG.length, `${SKILL_CATALOG.length} skills`);
    const one = () => clone(SKILL_CATALOG).slice(0, 1);
    await h.expectThrow("catalog.unknown_tool refused", () => {
      const bad = one(); bad[0].tools = ["definitely_not_a_tool"]; return skillContracts(bad);
    }, "SKILL_TOOL_UNKNOWN");
    await h.expectThrow("catalog.tool_not_in_mode refused", () => {
      // A real registry tool that discuss mode may not use, on a skill that serves discuss.
      const bad = one(); bad[0].modes = ["discuss"]; bad[0].tools = ["write_file"]; return skillContracts(bad);
    }, "SKILL_TOOL_NOT_IN_MODE");
    await h.expectThrow("catalog.invalid_semver refused", () => {
      const bad = one(); bad[0].version = "1.0"; return skillContracts(bad);
    }, "SKILL_VERSION_INVALID");
    await h.expectThrow("catalog.duplicate refused", () => {
      const bad = one(); return skillContracts([bad[0], { ...bad[0] }]);
    }, "SKILL_DUPLICATE");
    await h.expectThrow("catalog.invalid_guidance refused (missing phase)", () => {
      const bad = one(); delete bad[0].guidance.repair; return skillContracts(bad);
    }, "SKILL_GUIDANCE_INVALID");
    await h.expectThrow("catalog.empty_guidance refused", () => {
      const bad = one(); for (const p of SKILL_PHASES) bad[0].guidance[p] = "   "; return skillContracts(bad);
    }, "SKILL_GUIDANCE_EMPTY");
    await h.expectThrow("catalog.invalid_mode refused", () => {
      const bad = one(); bad[0].modes = ["admin"]; return skillContracts(bad);
    }, "SKILL_MODE_INVALID");
    await h.expectThrow("catalog.invalid_id refused", () => {
      const bad = one(); bad[0].skill_id = "Backend_Functions"; return skillContracts(bad);
    }, "SKILL_ID_INVALID");

    // ---- 2. deterministic selection + stable strategy_id
    const req1 = { mode: "default", prompt: "add a backend function that calls the weather API", paths: ["functions/weather.js"], phase: "plan", signals: {} };
    const a = selectSkills(req1);
    const b = selectSkills({ ...req1 });
    h.check("select.deterministic: identical requests yield identical strategy", JSON.stringify(a) === JSON.stringify(b), a.strategy_id || "none");
    h.check("select.stable_id: strategy_id is a stable content hash", !!a.strategy_id && a.strategy_id === selectSkills(req1).strategy_id, a.strategy_id);
    h.check("select.matched: backend skill selected for a backend request", a.skills.some((s) => s.skill_id === "backend-functions"), a.skills.map((s) => s.skill_id).join(","));
    const different = selectSkills({ ...req1, prompt: "change the theme colours and typography", paths: ["styles.css"] });
    h.check("select.id_differs: a different skill set yields a different id", different.strategy_id !== a.strategy_id, `${different.skills.map((s) => s.skill_id).join(",")}`);
    h.check("select.checksums: every picked skill carries its catalog checksum", a.skills.every((s) => s.checksum === skillChecksum(SKILL_CATALOG.find((x) => x.skill_id === s.skill_id))), "ok");
    h.check("select.mode_filtered: discuss mode never loads a default-only skill", selectSkills({ mode: "discuss", prompt: req1.prompt, paths: req1.paths }).skills.every((s) => SKILL_CATALOG.find((x) => x.skill_id === s.skill_id).modes.includes("discuss")), "ok");

    // ---- 3. signal-gated skills
    const dataPrompt = "track a list of records in a table";
    const noSignal = selectSkills({ mode: "default", prompt: dataPrompt, signals: {} });
    const withSignal = selectSkills({ mode: "default", prompt: dataPrompt, signals: { entities_present: true } });
    h.check("signal.gated_off: data-modeling absent without entities_present", !noSignal.skills.some((s) => s.skill_id === "data-modeling"), noSignal.skills.map((s) => s.skill_id).join(",") || "none");
    h.check("signal.gated_on: data-modeling present with the signal AND a prompt match", withSignal.skills.some((s) => s.skill_id === "data-modeling"), withSignal.skills.map((s) => s.skill_id).join(","));
    h.check("signal.records_source: the match records the 'signal' trigger", (withSignal.skills.find((s) => s.skill_id === "data-modeling")?.matched_by || []).includes("signal"), JSON.stringify(withSignal.skills.find((s) => s.skill_id === "data-modeling")?.matched_by));
    const signalOnly = selectSkills({ mode: "default", prompt: "make the button bigger", signals: { entities_present: true, mcp_tools_available: true } });
    h.check("signal.not_sufficient: a signal alone loads nothing", !signalOnly.skills.some((s) => ["data-modeling", "mcp-context"].includes(s.skill_id)), signalOnly.skills.map((s) => s.skill_id).join(",") || "none");
    const mcpOff = selectSkills({ mode: "default", prompt: "summarise the open issues from our tracker", signals: {} });
    const mcpOn = selectSkills({ mode: "default", prompt: "summarise the open issues from our tracker", signals: { mcp_tools_available: true } });
    h.check("signal.mcp_gated: mcp-context requires mcp_tools_available", !mcpOff.skills.some((s) => s.skill_id === "mcp-context") && mcpOn.skills.some((s) => s.skill_id === "mcp-context"), "ok");
    const phaseOnly = selectSkills({ mode: "default", prompt: "unrelated text", phase: "repair" });
    h.check("phase.gated: build-repair selected by phase only", phaseOnly.skills.some((s) => s.skill_id === "build-repair"), phaseOnly.skills.map((s) => s.skill_id).join(","));
    h.check("phase.absent_in_plan: build-repair not selected during planning", !selectSkills({ mode: "default", prompt: "unrelated text", phase: "plan" }).skills.some((s) => s.skill_id === "build-repair"), "ok");

    // ---- 4. skillTools can never widen allowedTools(mode)
    for (const mode of ["default", "discuss"]) {
      const permitted = new Set(allowedTools(mode).map((t) => t.name));
      const everySkill = { source: "skill_catalog", skills: SKILL_CATALOG.map((s) => ({ skill_id: s.skill_id, version: s.version })) };
      const tools = skillTools(everySkill, mode);
      h.check(`tools.subset(${mode}): preferred tools are a subset of the mode's tools`, tools.every((t) => permitted.has(t)), tools.join(",") || "none");
      h.check(`tools.no_widening(${mode}): count never exceeds the mode's allowance`, tools.length <= permitted.size, `${tools.length} <= ${permitted.size}`);
    }
    h.check("tools.unknown_ref_ignored: an unknown skill reference contributes no tools", skillTools({ source: "skill_catalog", skills: [{ skill_id: "not-a-skill", version: "9.9.9" }] }, "default").length === 0, "ok");
    h.check("tools.empty_strategy: no strategy means no preferred tools", skillTools(NO_SKILL_STRATEGY, "default").length === 0, "ok");
    h.check("materialize.skips_unknown: unknown id/version is never guessed", materializeSkills({ skills: [{ skill_id: "backend-functions", version: "0.0.1" }] }).length === 0, "ok");

    // ---- 5. routing hints are tighten-only
    const loose = { needs_tools: false, needs_structured_output: false, min_context: 120000, fileCount: 3, mode: "default" };
    const tightened = skillRoutingHints({ source: "skill_catalog", skills: SKILL_CATALOG.map((s) => ({ skill_id: s.skill_id, version: s.version })) }, loose);
    let relaxed = null;
    for (const [k, v] of Object.entries(loose)) {
      if (typeof v === "boolean" && v === true && tightened[k] !== true) relaxed = k;
      if (typeof v === "number" && Number(tightened[k]) < v) relaxed = k;
    }
    h.check("hints.tighten_only: no requirement was relaxed", relaxed === null, relaxed ? `relaxed ${relaxed}` : "none relaxed");
    h.check("hints.tightened: needs_tools raised by the MCP skill", tightened.needs_tools === true && tightened.needs_structured_output === true, JSON.stringify({ needs_tools: tightened.needs_tools, needs_structured_output: tightened.needs_structured_output }));
    h.check("hints.preserves_unrelated: untouched inputs pass through", tightened.min_context === 120000 && tightened.fileCount === 3, JSON.stringify({ min_context: tightened.min_context, fileCount: tightened.fileCount }));
    const noStrategyHints = skillRoutingHints(NO_SKILL_STRATEGY, loose);
    h.check("hints.empty_noop: an empty strategy changes nothing", JSON.stringify(noStrategyHints) === JSON.stringify(loose), "identical");

    // ---- 6. per-phase guidance
    const repairOnly = { source: "skill_catalog", skills: [{ skill_id: "build-repair", version: "1.0.0" }] };
    h.check("guidance.repair_only.planner_empty: a repair-only skill emits no planner block", skillGuidanceBlock(repairOnly, "planner") === "", "empty");
    h.check("guidance.repair_only.generator_empty: and no generator block", skillGuidanceBlock(repairOnly, "generator") === "", "empty");
    const repairBlock = skillGuidanceBlock(repairOnly, "repair");
    h.check("guidance.repair_only.repair_present: the repair block is emitted", repairBlock.includes("build-repair@1.0.0") && repairBlock.includes("SKILLS ("), `${repairBlock.length} chars`);
    const backend = { source: "skill_catalog", skills: [{ skill_id: "backend-functions", version: "1.0.0" }] };
    const planner = skillGuidanceBlock(backend, "planner");
    const generator = skillGuidanceBlock(backend, "generator");
    const repair = skillGuidanceBlock(backend, "repair");
    h.check("guidance.phase_specific: planner/generator/repair blocks differ", planner !== generator && generator !== repair && planner !== repair, "distinct");
    h.check("guidance.planner_content: planner carries the planner text", planner.includes("functions/<name>.js"), "ok");
    h.check("guidance.generator_content: generator carries the generator text", generator.includes("export `config`") || generator.includes("secrets.get(NAME)"), "ok");
    h.check("guidance.additive: every block states it is additive, not a replacement", [planner, generator, repair].every((b) => b.includes("never a replacement")), "ok");
    h.check("guidance.tools_listed: the block lists only mode-permitted tools", (() => {
      const permitted = new Set(allowedTools("default").map((t) => t.name));
      const line = planner.split("Preferred tools for these skills: ")[1] || "";
      return line.split(", ").filter(Boolean).every((t) => permitted.has(t.trim()));
    })(), "ok");
    h.check("guidance.empty_strategy: no strategy emits no block", SKILL_PHASES.every((p) => skillGuidanceBlock(NO_SKILL_STRATEGY, p) === ""), "ok");

    // ---- 7. empty strategy preserves the reserved routing slot
    const emptyRecord = skillStrategyRecord(selectSkills({ mode: "default", prompt: "hello there" }));
    h.check("empty.reserved_slot: record equals NO_SKILL_STRATEGY", JSON.stringify(emptyRecord) === JSON.stringify(NO_SKILL_STRATEGY), JSON.stringify(emptyRecord));
    h.check("empty.reserved_keys: strategy_id/version null and source 'none'", emptyRecord.strategy_id === null && emptyRecord.version === null && emptyRecord.source === "none", "ok");
    h.check("empty.null_strategy: a null strategy also yields the reserved slot", JSON.stringify(skillStrategyRecord(null)) === JSON.stringify(NO_SKILL_STRATEGY), "ok");

    // ---- 8. router decision carries the strategy (explicit policy, persist=false)
    const policy = defaultPolicy();
    const strategy = selectSkills({ mode: "default", prompt: SECRET_PROMPT, paths: ["functions/hook.js", "styles.css"], signals: { entities_present: true } });
    const inputs = { mode: "build", prompt: SECRET_PROMPT, fileCount: 6, needs_tools: false };
    const withSkills = await selectModel(base44, { policy, persist: false, inputs, skill_strategy: strategy, estimate: { max_input_tokens: 20000, max_output_tokens: 4000 } });
    const withoutSkills = await selectModel(base44, { policy, persist: false, inputs, estimate: { max_input_tokens: 20000, max_output_tokens: 4000 } });
    h.check("router.carries_strategy: decision.skill_strategy names the strategy", withSkills.decision.skill_strategy.strategy_id === strategy.strategy_id && withSkills.decision.skill_strategy.source === "skill_catalog", withSkills.decision.skill_strategy.strategy_id);
    h.check("router.carries_versions: each skill is recorded with id + version + checksum", withSkills.decision.skill_strategy.skills.every((s) => s.skill_id && s.version && s.checksum), withSkills.decision.skill_strategy.skills.map((s) => `${s.skill_id}@${s.version}`).join(","));
    h.check("router.reserved_slot_without_skills: no strategy leaves the reserved slot", JSON.stringify(withoutSkills.decision.skill_strategy) === JSON.stringify(NO_SKILL_STRATEGY), JSON.stringify(withoutSkills.decision.skill_strategy));
    h.check("router.hints_reached_requirements: the skill's needs_structured_output is recorded", withSkills.decision.requirements.needs_structured_output === true, String(withSkills.decision.requirements.needs_structured_output));
    h.check("router.still_selects: a model is still chosen under a strategy", !!withSkills.decision.selected_model_id && withSkills.decision.mode === "automatic", withSkills.decision.selected_model_id);
    h.check("router.explainability_intact: components, candidates and rejections still present", !!withSkills.decision.score_components && Array.isArray(withSkills.decision.candidates) && Array.isArray(withSkills.decision.rejected) && !!withSkills.decision.deterministic_key, `${withSkills.decision.candidates.length} candidates`);
    h.check("router.deterministic: the same inputs + strategy reproduce the ranking", (await selectModel(base44, { policy, persist: false, inputs, skill_strategy: strategy, estimate: { max_input_tokens: 20000, max_output_tokens: 4000 } })).decision.deterministic_key === withSkills.decision.deterministic_key, withSkills.decision.deterministic_key);

    // ---- 9. routingPolicy contract / skills read surface
    const contract = skillContract();
    h.check("surface.contract_version", contract.contract_version === SKILL_CONTRACT_VERSION, contract.contract_version);
    h.check("surface.phases", JSON.stringify(contract.phases) === JSON.stringify(SKILL_PHASES), contract.phases.join(","));
    h.check("surface.skills_listed: every catalog skill is exposed with a checksum", contract.skills.length === SKILL_CATALOG.length && contract.skills.every((s) => s.checksum && s.title && Array.isArray(s.tools)), `${contract.skills.length} skills`);
    const surface = { policy: routingPolicyContract(), router: routerContract(), skills: contract };
    h.check("surface.payload_serializable: the routingPolicy contract payload serializes", JSON.stringify(surface).length > 0 && !!surface.policy.contract_version && !!surface.router.contract_version, `${JSON.stringify(surface).length} bytes`);
    h.check("surface.no_guidance_text: the contract exposes identity, not prompt guidance", !JSON.stringify(contract).includes("secrets.get(NAME)"), "ok");

    // ---- 10. persisted strategy records carry no prompt text or secrets
    const record = skillStrategyRecord(strategy);
    const text = JSON.stringify(record);
    for (const leak of ["sk_live_51NotARealKey", "ghp_ZZZZ", "webhook using API key", "our design theme"]) {
      h.check(`privacy.no_leak: record excludes "${leak.slice(0, 22)}"`, !text.includes(leak), "clean");
    }
    h.check("privacy.keys_only: record holds identity fields only", record.skills.every((s) => Object.keys(s).sort().join(",") === "checksum,matched_by,skill_id,version"), Object.keys(record).sort().join(","));
    h.check("privacy.no_prompt_in_decision: the decision's strategy slot carries no prompt text", !JSON.stringify(withSkills.decision.skill_strategy).includes("sk_live_51NotARealKey"), "clean");
    h.check("privacy.no_guidance_in_record: guidance text is never persisted", !text.includes("functions/<name>.js"), "clean");

    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  }
}