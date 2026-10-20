// Executable certification for the NexusAI Memory Architecture (#21).
//
// Every check runs against the REAL memory module, the REAL project authorization path, the REAL
// tracing system, the REAL scheduled-retention sweep and the REAL agent-loop read path. Nothing is
// stubbed, and no Trajectory / Evaluation / Reward record is written by the memory layer.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  createMemory, retrieveMemory, supersedeMemory, archiveMemory, getMemoryHistory,
  retrieveMemoryForRun, memoryContextBlock, MEMORY_LIMITS, memoryLogicalKey,
} from "../../shared/memory.ts";
import { enforceRetention } from "../../shared/maintenance.ts";

const SECRET = "sk_live_memory_must_never_leak_44af";
const TOKEN = "ghp_memorycertdummytoken000000000000000";
const DAY = 86400000;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  let workspace = null, other = null, proj = null, otherProj = null, policy = null;
  const stranger = { id: "mem_stranger_user", email: "stranger@example.com" };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated platform admin" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: "Memory Cert", owner_id: caller.id, credits_balance: 100 });
    other = await svc.entities.Workspace.create({ name: "Memory Cert (other)", owner_id: "mem_other_owner", credits_balance: 5 });
    proj = await svc.entities.Project.create({ workspace_id: workspace.id, name: "memory-project", status: "ready", version_count: 3 });
    otherProj = await svc.entities.Project.create({ workspace_id: other.id, name: "foreign-project", status: "ready", version_count: 1 });

    // ---------- 1-7 · writes, types, provenance, trust ----------
    const userMem = await createMemory(base44, caller, {
      scope: "user", memory_type: "preference", statement: "Prefers concise commit messages and Tailwind utility classes over custom CSS.",
      source_type: "user_input", source_reference: { kind: "explicit_user_statement", note: "stated in chat" }, project_id: proj.id,
    });
    h.check("1 user memory creation",
      userMem.created && userMem.memory.scope === "user" && userMem.memory.user_id === caller.id &&
      userMem.memory.project_id === null && userMem.memory.status === "active" && !!userMem.memory.created_at,
      `user_id=${userMem.memory.user_id} type=${userMem.memory.memory_type}`);

    const projFact = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "fact",
      statement: "The Customer entity is the single store for CRM contact records in this project.",
      source_type: "project_state", source_reference: { kind: "entity_schema", entity_name: "Customer", version_number: 3 },
    });
    const projDecision = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "decision", subject_key: "db.primary_store",
      statement: "Customer data is stored in the Customer entity rather than a separate Contact entity.",
      reason: "Avoids duplicating identity fields across two stores and keeps CRM queries on one index.",
      source_type: "project_state", source_reference: { kind: "version", version_id: "v_cert", version_number: 3 },
    });
    const projConstraint = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "constraint",
      statement: "Weather lookups must be cached because the upstream provider enforces a shared daily quota.",
      source_type: "system_observation", source_reference: { kind: "runtime_observation", run_id: "r_cert" },
    });
    h.check("2 project memory creation",
      projFact.created && projFact.memory.project_id === proj.id && projFact.memory.workspace_id === workspace.id &&
      projDecision.created && projConstraint.created,
      `${[projFact, projDecision, projConstraint].filter((r) => r.created).length} project memories created`);

    const platform = await createMemory(base44, caller, {
      scope: "platform", memory_type: "pattern",
      statement: "Backend functions should validate input before calling an external API, and never return raw provider errors.",
      source_type: "platform_knowledge", source_reference: { kind: "approved_guideline", note: "platform pattern library" },
    });
    h.check("3 platform knowledge creation through controlled path",
      platform.created && platform.memory.scope === "platform" && platform.memory.project_id === null &&
      platform.memory.user_id === null && platform.memory.workspace_id === null && platform.memory.verification === "verified" &&
      platform.memory.source_reference.approved_by === caller.id,
      `approved_by=${platform.memory.source_reference.approved_by}`);
    await h.expectThrow("3b non-admin cannot write platform knowledge",
      () => createMemory(base44, stranger, { scope: "platform", memory_type: "pattern", statement: "Anyone can write platform knowledge.", source_type: "platform_knowledge", source_reference: { kind: "x" } }), "NOT_PLATFORM_ADMIN");

    h.check("4 memory type recorded correctly",
      projFact.memory.memory_type === "fact" && projDecision.memory.memory_type === "decision" &&
      projConstraint.memory.memory_type === "constraint" && userMem.memory.memory_type === "preference" &&
      platform.memory.memory_type === "pattern" &&
      projDecision.memory.reason.includes("duplicating identity fields"),
      "fact / decision (with reason) / constraint / preference / pattern all distinct");
    await h.expectThrow("4b a decision cannot collapse into a bare fact",
      () => createMemory(base44, caller, { scope: "project", project_id: proj.id, memory_type: "decision", statement: "We chose the simpler routing approach here.", source_type: "project_state", source_reference: { kind: "version" } }), "DECISION_REQUIRES_REASON");

    h.check("5 provenance recorded",
      projFact.memory.source_type === "project_state" && projFact.memory.source_reference.entity_name === "Customer" &&
      userMem.memory.source_type === "user_input" && projConstraint.memory.source_type === "system_observation",
      JSON.stringify(projFact.memory.source_reference));
    await h.expectThrow("5b provenance is mandatory",
      () => createMemory(base44, caller, { scope: "project", project_id: proj.id, memory_type: "fact", statement: "Some fact with no evidence behind it at all.", source_type: "project_state", source_reference: {} }), "PROVENANCE_REQUIRED");

    h.check("6 confidence recorded",
      projFact.memory.confidence === 1 && userMem.memory.confidence === 0.9 && projConstraint.memory.confidence === 0.6,
      `verified=${projFact.memory.confidence} user_stated=${userMem.memory.confidence} inferred=${projConstraint.memory.confidence}`);

    // An inferred/user-stated source cannot claim verification, and confidence is clamped to it.
    const overclaim = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "observation",
      statement: "The dashboard page appears to render slowly on first load for large datasets.",
      source_type: "system_observation", source_reference: { kind: "runtime_observation" }, verification: "verified", confidence: 0.99,
    });
    h.check("7 verified / user_stated / inferred remain distinct",
      projFact.memory.verification === "verified" && !!projFact.memory.verified_at &&
      userMem.memory.verification === "user_stated" && userMem.memory.verified_at === null &&
      overclaim.memory.verification === "inferred" && overclaim.memory.confidence <= 0.6 && overclaim.memory.verified_at === null,
      `overclaimed verified → ${overclaim.memory.verification} @ conf ${overclaim.memory.confidence}`);

    // ---------- 23 · secrets ----------
    await h.expectThrow("23 secrets fully scrubbed (credential statement refused)",
      () => createMemory(base44, caller, { scope: "project", project_id: proj.id, memory_type: "fact", statement: `api_key: ${SECRET}`, source_type: "project_state", source_reference: { kind: "secret" } }), "UNSTORABLE_STATEMENT");
    const scrubbed = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "fact",
      statement: `The weather integration authenticates with the WEATHER_API_KEY secret (currently ${SECRET}) and the deploy token ${TOKEN}.`,
      source_type: "project_state", source_reference: { kind: "integration", note: `token ${TOKEN}` },
    });
    h.check("23b credential values never persist",
      !scrubbed.memory.statement.includes(SECRET) && !scrubbed.memory.statement.includes(TOKEN) &&
      !JSON.stringify(scrubbed.memory).includes(SECRET) && !JSON.stringify(scrubbed.memory).includes(TOKEN) &&
      scrubbed.memory.statement.includes("WEATHER_API_KEY"),
      "values redacted, secret NAME preserved as a useful fact");

    // ---------- 20 · platform knowledge holds no private data ----------
    await h.expectThrow("20 platform knowledge contains no private project data",
      () => createMemory(base44, caller, { scope: "platform", memory_type: "fact", statement: `Project ${proj.id} stores its CRM data in src/pages/Customers.js.`, source_type: "platform_knowledge", source_reference: { kind: "approved_guideline" } }), "PRIVATE_DATA_IN_PLATFORM_KNOWLEDGE");
    await h.expectThrow("20b platform knowledge cannot be scoped to a project",
      () => createMemory(base44, caller, { scope: "platform", project_id: proj.id, memory_type: "fact", statement: "A generic reusable statement about building apps.", source_type: "platform_knowledge", source_reference: { kind: "approved_guideline" } }), "PRIVATE_DATA_IN_PLATFORM_KNOWLEDGE");
    const platformRows = await svc.entities.MemoryItem.filter({ scope: "platform" }, "-created_date", 50);
    h.check("20c stored platform knowledge carries no project/user identifiers",
      platformRows.every((r) => !r.project_id && !r.user_id && !r.workspace_id && !/\b[0-9a-f]{24}\b/i.test(r.statement)),
      `${platformRows.length} platform row(s) checked`);

    // ---------- 17 · duplicate prevention ----------
    const dup = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "fact",
      statement: "The Customer entity is the single store for CRM contact records in this project.",
      source_type: "project_state", source_reference: { kind: "entity_schema", entity_name: "Customer" },
    });
    const dupRows = await svc.entities.MemoryItem.filter({ logical_key: projFact.memory.logical_key }, "revision", 20);
    h.check("17 duplicate logical memory prevented",
      dup.created === false && dup.reason === "duplicate_logical_memory" && dup.memory.memory_id === projFact.memory.memory_id &&
      dupRows.length === 1 && dupRows[0].status === "active" &&
      projFact.memory.logical_key === memoryLogicalKey({ scope: "project", memory_type: "fact", project_id: proj.id, statement: projFact.memory.statement }),
      `${dupRows.length} row for the logical key`);

    // ---------- 14 · conflict, then 13/15/16/33 · supersession + history ----------
    const conflict = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "decision", subject_key: "db.primary_store",
      statement: "Customer data is stored in a dedicated Contact entity separate from Customer.",
      reason: "A later run appeared to split the stores.",
      source_type: "system_observation", source_reference: { kind: "runtime_observation" },
    });
    const conflictedOriginal = await svc.entities.MemoryItem.get(projDecision.memory.memory_id);
    h.check("14 conflict/supersession state preserved",
      conflict.conflict === true && conflict.memory.status === "conflicted" &&
      conflict.memory.conflicts_with_memory_id === projDecision.memory.memory_id &&
      conflictedOriginal.status === "conflicted" && conflictedOriginal.conflicts_with_memory_id === conflict.memory.memory_id &&
      !!conflictedOriginal.conflict_note && conflictedOriginal.statement === projDecision.memory.statement,
      "both sides retained and marked, neither overwritten");

    const corrected = await supersedeMemory(base44, caller, {
      memory_id: projDecision.memory.memory_id,
      statement: "Customer data stays in the Customer entity; the Contact split was never implemented.",
      reason: "Verified against the committed schema of version 3.",
      source_type: "project_state", source_reference: { kind: "version", version_number: 3 },
    });
    const supersededRow = await svc.entities.MemoryItem.get(projDecision.memory.memory_id);
    h.check("16 corrections preserve provenance",
      corrected.created && corrected.memory.revision > projDecision.memory.revision &&
      [projDecision.memory.memory_id, conflict.memory.memory_id].includes(corrected.memory.supersedes_memory_id) &&
      corrected.memory.source_reference.note.includes(projDecision.memory.memory_id) &&
      supersededRow.source_type === projDecision.memory.source_type && supersededRow.reason === projDecision.memory.reason,
      `revision ${projDecision.memory.revision} → ${corrected.memory.revision}, earlier provenance intact`);
    h.check("33 memory revisions preserve provenance",
      supersededRow.status === "superseded" && supersededRow.superseded_by_memory_id === corrected.memory.memory_id &&
      supersededRow.statement === projDecision.memory.statement && !!supersededRow.source_reference?.kind,
      "superseded row keeps its own statement, source and reason");

    const hist = await getMemoryHistory(base44, caller, { memory_id: corrected.memory.memory_id });
    h.check("15 memory history preserved",
      hist.count >= 3 && hist.history.filter((r) => r.status === "superseded").length >= 2 &&
      hist.history.filter((r) => r.status === "active").length === 1 &&
      hist.history.some((r) => (r.conflict_note || "").includes("Contradict")) &&
      hist.history[0].revision === 1 && hist.history.every((r) => !!r.statement && !!r.source_type),
      `${hist.count} revision(s): ${hist.history.map((r) => `${r.revision}:${r.status}`).join(" ")}`);

    // ---------- stale + archived ----------
    const stale = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "fact",
      statement: "A temporary migration flag is enabled for the reporting rollout window.",
      source_type: "project_state", source_reference: { kind: "version" }, expires_at: new Date(Date.now() - DAY).toISOString(),
    });
    const archivable = await createMemory(base44, caller, {
      scope: "project", project_id: proj.id, memory_type: "pattern",
      statement: "Legacy pages used a preact runtime shim that is no longer part of the project.",
      source_type: "project_state", source_reference: { kind: "file_path", file_path: "src/lib/runtime.jsx" },
    });
    const archived = await archiveMemory(base44, caller, { memory_id: archivable.memory.memory_id, note: "no longer true" });

    // ---------- 8-12, 24, 25, 26 · retrieval ----------
    const trace_id = `t_memory_cert_${Date.now().toString(36)}`;
    const retrieval = await retrieveMemory(base44, caller, { project_id: proj.id, query: "customer entity store and commit conventions", trace_id, run_id: "run_mem_cert" });
    const ids = retrieval.items.map((i) => i.memory_id);
    h.check("8 project-specific retrieval works",
      retrieval.items.some((i) => i.memory_id === projFact.memory.memory_id && i.scope === "project") &&
      retrieval.items.some((i) => i.memory_id === corrected.memory.memory_id),
      `${retrieval.items.filter((i) => i.scope === "project").length} project item(s)`);
    h.check("9 user-specific retrieval works",
      retrieval.items.some((i) => i.memory_id === userMem.memory.memory_id && i.scope === "user" && i.tier === 3),
      `user tier present: ${retrieval.items.filter((i) => i.scope === "user").length} item(s)`);
    h.check("10 platform knowledge retrieval works",
      retrieval.items.some((i) => i.memory_id === platform.memory.memory_id && i.scope === "platform" && i.tier === 4),
      `platform items: ${retrieval.items.filter((i) => i.scope === "platform").length}`);

    const tiers = retrieval.items.map((i) => i.tier);
    const narrow = await retrieveMemory(base44, caller, { project_id: proj.id, query: "backend function external api validation", limit: 2 });
    h.check("11 project-specific memory has correct precedence",
      tiers.every((t, i) => i === 0 || t >= tiers[i - 1]) && retrieval.items[0].tier === 1 &&
      narrow.items.every((i) => i.scope === "project") &&
      retrieval.items.findIndex((i) => i.scope === "platform") > retrieval.items.findIndex((i) => i.scope === "project"),
      `tier order ${tiers.join(",")}; a platform-shaped query still returns project memory first`);

    h.check("12 stale memory excluded", !ids.includes(stale.memory.memory_id) && !ids.includes(archived.memory.memory_id),
      "expired and archived items absent from active retrieval");
    h.check("13 superseded memory excluded",
      !ids.includes(projDecision.memory.memory_id) && !ids.includes(conflict.memory.memory_id) &&
      retrieval.items.every((i) => i.status === "active"),
      "superseded and conflicted rows absent, history still stored");

    h.check("24 evidence/provenance returned with retrieved memory",
      retrieval.items.every((i) => i.scope && i.memory_type && i.verification && i.confidence != null && i.source_type && i.source_reference && typeof i.source_reference === "object" && "verified_at" in i),
      "each item carries scope, type, verification, confidence, source and freshness");

    // Bounded: 30 further project memories cannot widen the result.
    for (let i = 0; i < 30; i++) {
      await createMemory(base44, caller, {
        scope: "project", project_id: proj.id, memory_type: "observation",
        statement: `Bulk observation number ${i}: the reporting page reads its rows through the shared data hook.`,
        source_type: "system_observation", source_reference: { kind: "runtime_observation", note: `bulk ${i}` },
      });
    }
    const bounded = await retrieveMemory(base44, caller, { project_id: proj.id, query: "reporting rows", limit: 500 });
    h.check("25 retrieval is bounded",
      bounded.count <= MEMORY_LIMITS.total && bounded.payload_chars <= MEMORY_LIMITS.payload_chars &&
      bounded.limits.per_tier === MEMORY_LIMITS.per_tier &&
      (await svc.entities.MemoryItem.filter({ project_id: proj.id }, "-created_date", 200)).length > bounded.count * 2,
      `${bounded.count} item(s) / ${bounded.payload_chars} chars out of ${(await svc.entities.MemoryItem.filter({ project_id: proj.id }, "-created_date", 200)).length} stored`);

    const spans = await svc.entities.TraceEvent.filter({ trace_id }, "-created_date", 10);
    h.check("26 trace_id/run_id propagated",
      spans.some((s) => s.name === "memory.retrieve" && s.project_id === proj.id && s.run_id === "run_mem_cert" && s.event_type === "diagnostic_query") &&
      retrieval.trace_id === trace_id && retrieval.run_id === "run_mem_cert",
      `${spans.length} span(s) on the existing trace`);

    // ---------- 18, 19, 21, 22 · isolation ----------
    const foreignUser = await svc.entities.MemoryItem.create({
      scope: "user", memory_type: "preference", statement: "Another user prefers dark mode and four-space indentation.",
      logical_key: "mk_foreign_user", user_id: "mem_other_user", source_type: "user_input", source_reference: { kind: "explicit_user_statement" },
      confidence: 0.9, verification: "user_stated", status: "active", created_at: new Date().toISOString(),
    });
    const foreignProject = await svc.entities.MemoryItem.create({
      scope: "project", memory_type: "fact", statement: "The foreign project stores invoices in an Invoice entity.",
      logical_key: "mk_foreign_project", project_id: otherProj.id, workspace_id: other.id,
      source_type: "project_state", source_reference: { kind: "entity_schema" }, confidence: 1, verification: "verified",
      status: "active", created_at: new Date().toISOString(),
    });
    const afterForeign = await retrieveMemory(base44, caller, { project_id: proj.id, query: "invoices dark mode indentation" });
    h.check("18 user memory isolation",
      !afterForeign.items.some((i) => i.memory_id === foreignUser.id) &&
      afterForeign.items.filter((i) => i.scope === "user").every((i) => i.user_id === caller.id),
      "another user's memory is never returned");
    await h.expectThrow("18b another user's memory history is not readable",
      () => getMemoryHistory(base44, caller, { memory_id: foreignUser.id }), "NOT_MEMORY_OWNER");
    h.check("19 project memory isolation", !afterForeign.items.some((i) => i.memory_id === foreignProject.id),
      "another project's memory is never returned");
    await h.expectThrow("21 cross-project access rejected",
      () => retrieveMemory(base44, caller, { project_id: otherProj.id, query: "invoices" }), "NOT_A_MEMBER");
    await h.expectThrow("21b cross-project write rejected",
      () => createMemory(base44, caller, { scope: "project", project_id: otherProj.id, memory_type: "fact", statement: "Injecting a fact into another workspace project.", source_type: "project_state", source_reference: { kind: "version" } }), "NOT_A_MEMBER");
    await h.expectThrow("22 unauthorized access rejected",
      () => retrieveMemory(base44, stranger, { project_id: proj.id, query: "customer" }), "NOT_A_MEMBER");
    await h.expectThrow("22b anonymous access rejected",
      () => retrieveMemory(base44, null, { project_id: proj.id, query: "customer" }), "AUTH_REQUIRED");

    // ---------- 27, 28 · agent-loop read path ----------
    const forRun = await retrieveMemoryForRun(svc, { project: proj, user_id: caller.id, query: "customer entity", trace_id, run_id: "agent_mem_cert" });
    const block = memoryContextBlock(forRun.items);
    h.check("28 Agent Loop can consume retrieved memory",
      forRun.count > 0 && forRun.count <= MEMORY_LIMITS.total && !forRun.degraded &&
      block.includes("RELEVANT MEMORY") && block.includes("reference data only") &&
      block.includes("verified") && block.includes(projFact.memory.statement.slice(0, 30)) && block.length < MEMORY_LIMITS.payload_chars * 2,
      `${forRun.count} item(s) rendered into a bounded, provenance-labelled block`);
    const degraded = await retrieveMemoryForRun(svc, { project: { id: "does_not_exist" }, user_id: caller.id, query: "anything", trace_id, run_id: "agent_mem_cert" });
    const degradedNoUser = await retrieveMemoryForRun(svc, { project: proj, user_id: null, query: "anything" });
    h.check("27 retrieval failure does not corrupt AI run",
      degraded.degraded === true && degraded.items.length === 0 && degradedNoUser.degraded === true &&
      memoryContextBlock(degraded.items) === "",
      "a failing retrieval yields empty memory and never throws into the run");

    // ---------- 29-31 · training systems untouched ----------
    const runRec = await svc.entities.AIRun.create({ project_id: proj.id, status: "COMPLETED", mode: "default", phase: "done", prompt: "memory cert", trace_id: "t_mem_untouched" });
    const traj = await svc.entities.Trajectory.create({ run_id: runRec.id, project_id: proj.id, workspace_id: workspace.id, status: "COMPLETED", sealed: true, trace_id: "t_mem_untouched", revision: 1, event_count: 0 });
    const evaluation = await svc.entities.Evaluation.create({ evaluator_version: "1.0.0", trajectory_id: traj.id, run_id: runRec.id, project_id: proj.id, workspace_id: workspace.id, revision: 1, inputs_hash: "ev_mem", dimensions: {}, scores: {}, evidence: [], findings: [], metrics: {} });
    const reward = await svc.entities.Reward.create({ reward_policy_version: "1.0.0", trajectory_id: traj.id, evaluation_id: evaluation.id, run_id: runRec.id, project_id: proj.id, workspace_id: workspace.id, revision: 1, inputs_hash: "rw_mem", final_reward: 0.9, components: [] });
    const before = {
      traj: JSON.stringify(await svc.entities.Trajectory.get(traj.id)),
      evaluation: JSON.stringify(await svc.entities.Evaluation.get(evaluation.id)),
      reward: JSON.stringify(await svc.entities.Reward.get(reward.id)),
      events: (await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id }, "sequence", 50)).length,
      legacy: JSON.stringify(await svc.entities.ProjectMemory.filter({ project_id: proj.id }, "-created_date", 20)),
      run: JSON.stringify(await svc.entities.AIRun.get(runRec.id)),
      project: JSON.stringify(await svc.entities.Project.get(proj.id)),
    };
    await retrieveMemory(base44, caller, { project_id: proj.id, query: "customer entity", trace_id, run_id: runRec.id });
    await retrieveMemoryForRun(svc, { project: proj, user_id: caller.id, query: "customer entity", trace_id, run_id: runRec.id });
    h.check("29 memory retrieval does not mutate Trajectory",
      JSON.stringify(await svc.entities.Trajectory.get(traj.id)) === before.traj &&
      (await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id }, "sequence", 50)).length === before.events,
      "trajectory row and event history byte-identical");
    h.check("30 memory retrieval does not mutate Evaluation", JSON.stringify(await svc.entities.Evaluation.get(evaluation.id)) === before.evaluation, "evaluation byte-identical");
    h.check("31 memory retrieval does not mutate Reward", JSON.stringify(await svc.entities.Reward.get(reward.id)) === before.reward, "reward byte-identical");
    h.check("34 existing AI Builder behavior remains unchanged",
      JSON.stringify(await svc.entities.AIRun.get(runRec.id)) === before.run &&
      JSON.stringify(await svc.entities.Project.get(proj.id)) === before.project &&
      JSON.stringify(await svc.entities.ProjectMemory.filter({ project_id: proj.id }, "-created_date", 20)) === before.legacy,
      "run, project pointer and the legacy run-derived project memory untouched");

    // ---------- 32 · retention integration ----------
    policy = await svc.entities.RetentionPolicy.create({ workspace_id: workspace.id, data_type: "memories", retention_days: 30, action: "delete", active: true, legal_basis: "gdpr_minimization" });
    const activeBefore = (await svc.entities.MemoryItem.filter({ project_id: proj.id, status: "active" }, "-created_date", 200)).length;
    const sweep = await enforceRetention(svc, { now: Date.now() + 40 * DAY, workspace_ids: [workspace.id] });
    const activeAfter = await svc.entities.MemoryItem.filter({ project_id: proj.id, status: "active" }, "-created_date", 200);
    const archivedGone = !(await svc.entities.MemoryItem.get(archived.memory.memory_id).catch(() => null));
    h.check("32 retention integration works",
      sweep.by_type.memories && sweep.by_type.memories.deleted >= 1 && archivedGone &&
      activeAfter.length === activeBefore && activeAfter.some((r) => r.id === projFact.memory.memory_id),
      `existing scheduled sweep deleted ${sweep.by_type.memories?.deleted} non-active memory row(s), kept all ${activeAfter.length} active`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    if (policy) await svc.entities.RetentionPolicy.delete(policy.id).catch(() => {});
    await purgeBy(svc, "MemoryItem", { scope: "platform" });
    await purgeBy(svc, "MemoryItem", { user_id: "mem_other_user" });
    if (base44) {
      const me = await base44.auth.me().catch(() => null);
      if (me) await purgeBy(svc, "MemoryItem", { scope: "user", user_id: me.id });
    }
    for (const p of [proj, otherProj]) {
      if (!p) continue;
      for (const name of ["MemoryItem", "ProjectMemory", "Reward", "Evaluation", "TrajectoryEvent", "Trajectory", "AIRun", "TraceEvent", "AuditLog"]) {
        await purgeBy(svc, name, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const w of [workspace, other]) if (w) await cleanupWorkspace(svc, w.id, ["AuditLog", "RetentionPolicy"]);
  }
}