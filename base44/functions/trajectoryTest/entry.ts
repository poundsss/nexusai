// Executable certification for the Trajectory / Learning Data Layer (#18).
//
// Every check runs against the REAL trajectory module and the REAL project authorization path, so
// what is certified here is the contract the run pipeline emits into: canonical record, run/trace
// correlation, workspace+project scoping, model/tool/phase metadata, build/runtime/repair outcomes,
// final run outcome, secret scrubbing, authorization + isolation, idempotency and immutable
// provenance.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  startTrajectory, trajectoryForRun, recordModelSelection, recordPlan, recordPhase, recordToolCalls,
  recordRetry, recordFallbacks, recordBuildResult, recordRuntimeResult, recordRepairAttempt,
  recordMutations, finalizeTrajectory, recordCorrection, getTrajectory, listTrajectories,
  listTrajectoryEvents, recordUserOutcome, emit, TRAJECTORY_SCHEMA_VERSION,
} from "../../shared/trajectory.ts";

const SECRET = "sk_live_trajectory_must_never_leak_71b2";
const TOKEN = "ghp_trajectorycertdummytoken000000000000";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  let workspace = null, other = null, proj = null, otherProj = null;

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated user" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: "Trajectory Cert", owner_id: caller.id, credits_balance: 200 });
    other = await svc.entities.Workspace.create({ name: "Trajectory Cert (other)", owner_id: "traj_other_owner", credits_balance: 5 });
    proj = await svc.entities.Project.create({ workspace_id: workspace.id, name: "traj-project", status: "ready", version_count: 1 });
    otherProj = await svc.entities.Project.create({ workspace_id: other.id, name: "foreign-project", status: "ready", version_count: 1 });

    const trace_id = "t_traj_cert_1";
    const run = await svc.entities.AIRun.create({
      project_id: proj.id, status: "PLANNING", mode: "default", phase: "plan", trace_id,
      prompt: `Add a notes page. My key is ${SECRET} and token ${TOKEN}`, base_version_number: 1,
    });

    // ---------------- canonical record + idempotent creation ----------------

    const first = await startTrajectory(base44, {
      run, project: proj, workspace, trace_id,
      tools: ["write_file", "create_entity", "patch_file"],
      context: { base_version_number: 1, file_count: 12, entity_count: 2, retrieved: 5, api_key: SECRET },
    });
    const traj = first.trajectory;
    h.check("1 canonical trajectory record created",
      first.created && traj.schema_version === TRAJECTORY_SCHEMA_VERSION && traj.status === "ACTIVE" && traj.sealed === false && traj.revision === 1,
      `schema_version=${traj.schema_version} status=${traj.status}`);
    h.check("2 run_id / trace_id / workspace_id / project_id recorded",
      traj.run_id === run.id && traj.trace_id === trace_id && traj.workspace_id === workspace.id && traj.project_id === proj.id,
      `run=${traj.run_id} trace=${traj.trace_id}`);

    const again = await startTrajectory(base44, { run, project: proj, workspace, trace_id, tools: ["write_file"], context: { file_count: 12 } });
    const allForRun = await svc.entities.Trajectory.filter({ run_id: run.id }, "created_date", 5);
    h.check("3 at most one trajectory per run (idempotent start)",
      again.created === false && again.trajectory.id === traj.id && allForRun.length === 1,
      `${allForRun.length} trajectory row(s) for the run`);
    h.check("4 context is hashed and bounded, not copied",
      !!traj.context_hash && traj.context_hash === again.trajectory.context_hash && traj.context.file_count === 12 && traj.context.tool_availability.length === 3,
      traj.context_hash);

    // ---------------- model / plan / tool / phase metadata ----------------

    await recordModelSelection(base44, traj, {
      model_id: "gpt_5_mini", provider: "core", reason: "cheapest compatible",
      routing_decision: { strategy: "cost", budget_credits: 40, candidates: [{ id: "gpt_5_mini" }, { id: "claude_sonnet_4_6" }], client_secret: SECRET },
    });
    await recordPlan(base44, traj, {
      plan: ["read context", "write page", "declare entity"],
      files: [{ path: "src/pages/Notes.js", action: "create" }, { path: "src/App.js", action: "patch" }],
      entities: [{ name: "Note" }], integrations: [], secrets: [{ name: "NOTES_KEY" }], assumptions: ["single user"],
    });
    await recordToolCalls(base44, traj, { phase: "plan", calls: [{ tool: "read_file", ok: true, summary: "src/App.js" }, { tool: "search_project", ok: true, summary: "3 hits" }] });
    await recordPhase(base44, traj, { phase: "plan", status: "ok", attempt: 1, duration_ms: 1200, next_phase: "generate" });
    await recordToolCalls(base44, traj, { phase: "generate", calls: [{ tool: "write_file", ok: true, summary: "src/pages/Notes.js" }, { tool: "create_entity", ok: false, summary: `failed with key ${SECRET}` }] });
    await recordPhase(base44, traj, { phase: "generate", status: "ok", attempt: 1, duration_ms: 8400, next_phase: "build" });

    let mid = await svc.entities.Trajectory.get(traj.id);
    h.check("5 model + routing metadata recorded",
      mid.model_id === "gpt_5_mini" && mid.model_provider === "core" && mid.routing_decision?.strategy === "cost" && mid.routing_decision?.budget_credits === 40,
      JSON.stringify(mid.routing_decision));
    h.check("6 plan metadata is structured summary only",
      mid.plan_summary?.steps === 3 && mid.plan_summary.file_actions.length === 2 && mid.plan_summary.entities[0] === "Note" && mid.plan_summary.assumptions === 1 &&
      !JSON.stringify(mid.plan_summary).includes("read context is chain of thought"),
      JSON.stringify(mid.plan_summary));
    h.check("7 tool metadata recorded per phase",
      mid.tool_calls.length === 4 && mid.tool_calls.filter((c) => c.phase === "generate").length === 2 && mid.tool_calls.some((c) => c.ok === false),
      `${mid.tool_calls.length} tool call(s)`);
    h.check("8 phase metadata recorded in order",
      mid.phases.length === 2 && mid.phases[0].phase === "plan" && mid.phases[1].phase === "generate" && mid.phases[1].duration_ms === 8400,
      JSON.stringify(mid.phases.map((p) => p.phase)));

    // ---------------- build / runtime / repair outcomes ----------------

    await recordBuildResult(base44, traj, { status: "failed", errors: 2, file_count: 13, duration_ms: 300, attempt: 1 });
    await recordRuntimeResult(base44, traj, { ok: false, category: "RUNTIME_ERROR", checks: [{ name: "mount", ok: false }], diagnostics: 2, attempt: 1 });
    await recordRepairAttempt(base44, traj, { attempt: 1, resolved: true, error_codes: ["error: undefined Note"] });
    await recordBuildResult(base44, traj, { status: "success", errors: 0, file_count: 13, duration_ms: 280, design: { ok: true, violations: 0 }, attempt: 2 });
    await recordRuntimeResult(base44, traj, { ok: true, category: null, checks: [{ name: "mount", ok: true }, { name: "route /notes", ok: true }], diagnostics: 0, attempt: 2 });
    await recordRetry(base44, traj, { phase: "build", attempt: 2, error_code: "TRANSIENT" });
    await recordFallbacks(base44, traj, [{ from: "gpt_5_mini", to: "gemini_3_flash" }]);
    await recordPhase(base44, traj, { phase: "build", status: "ok", attempt: 2, duration_ms: 5000, next_phase: "commit" });

    mid = await svc.entities.Trajectory.get(traj.id);
    h.check("9 build + runtime outcomes recorded",
      mid.outcomes.build_status === "success" && mid.outcomes.build_errors === 0 && mid.outcomes.runtime_ok === true && mid.outcomes.runtime_checks === 2,
      JSON.stringify(mid.outcomes));
    h.check("10 repair attempts, retries and fallbacks recorded",
      mid.outcomes.repair_attempts === 1 && mid.retries === 1 && mid.fallbacks.length === 1 && mid.fallbacks[0].to === "gemini_3_flash",
      `repairs=${mid.outcomes.repair_attempts} retries=${mid.retries}`);

    const attemptEvents = await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id, event_type: "build_result" }, "sequence", 10);
    h.check("11 every attempt is visible as its own event",
      attemptEvents.length === 2 && attemptEvents[0].attempt === 1 && attemptEvents[0].status === "error" && attemptEvents[1].attempt === 2 && attemptEvents[1].status === "ok",
      attemptEvents.map((e) => `${e.attempt}:${e.status}`).join(" "));

    // ---------------- mutations as references ----------------

    const version = await svc.entities.ProjectVersion.create({
      project_id: proj.id, number: 2, message: "add notes page",
      snapshot: { files: [{ path: "src/pages/Notes.js", content: "export default () => null;\n" }], entities: [{ name: "Note", fields: {} }] },
      changed_files: [{ path: "src/pages/Notes.js", change: "added" }],
    });
    await recordMutations(base44, traj, {
      changed_files: [{ path: "src/pages/Notes.js", change: "added" }, { path: "src/App.js", change: "modified" }],
      entities_changed: ["Note"], version_id: version.id, version_number: 2,
    });
    mid = await svc.entities.Trajectory.get(traj.id);
    h.check("12 mutations recorded as references, not contents",
      mid.mutations.version_id === version.id && mid.mutations.version_number === 2 && mid.mutations.files_changed_count === 2 &&
      !JSON.stringify(mid.mutations).includes("export default"),
      JSON.stringify(mid.mutations.changed_files));

    // ---------------- idempotent event recording ----------------

    const beforeCount = (await svc.entities.Trajectory.get(traj.id)).event_count;
    await recordPlan(base44, traj, { plan: ["read context", "write page", "declare entity"], files: [], entities: [], assumptions: [] });
    await recordPhase(base44, traj, { phase: "plan", status: "ok", attempt: 1, duration_ms: 1200, next_phase: "generate" });
    await recordBuildResult(base44, traj, { status: "success", errors: 0, file_count: 13, duration_ms: 280, attempt: 2 });
    await recordMutations(base44, traj, { changed_files: [], entities_changed: [], version_id: version.id, version_number: 2 });
    const afterCount = (await svc.entities.Trajectory.get(traj.id)).event_count;
    const planEvents = await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id, event_type: "plan_recorded" }, "sequence", 5);
    h.check("13 replayed emissions are exactly-once",
      afterCount === beforeCount && planEvents.length === 1,
      `event_count ${beforeCount} -> ${afterCount}, ${planEvents.length} plan event(s)`);

    // ---------------- final run outcome + sealing ----------------

    const sealed = await finalizeTrajectory(base44, {
      run_id: run.id, status: "COMPLETED", duration_ms: 15000,
      version_id: version.id, version_number: 2, build_id: "b_cert", credits_charged: 12, repair_attempts: 1,
    });
    h.check("14 final run outcome recorded and episode sealed",
      sealed.status === "COMPLETED" && sealed.sealed === true && !!sealed.finalized_at && sealed.duration_ms === 15000 &&
      sealed.outcomes.final_run_status === "COMPLETED" && sealed.outcomes.credits_charged === 12,
      JSON.stringify(sealed.outcomes));

    const sealedSnapshot = JSON.stringify(await svc.entities.Trajectory.get(traj.id));
    const reFinal = await finalizeTrajectory(base44, { run_id: run.id, status: "FAILED", error: "should not overwrite" });
    const finalEvents = await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id, event_type: "finalized" }, "sequence", 5);
    h.check("15 finalization is idempotent and cannot rewrite the outcome",
      reFinal.status === "COMPLETED" && finalEvents.length === 1 && JSON.stringify(await svc.entities.Trajectory.get(traj.id)) === sealedSnapshot,
      `${finalEvents.length} finalized event(s)`);

    // ---------------- immutable provenance ----------------

    const revBefore = (await svc.entities.Trajectory.get(traj.id)).revision;
    const firstEventBefore = JSON.stringify((await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id }, "sequence", 1))[0]);
    await recordToolCalls(base44, traj, { phase: "post_seal", calls: [{ tool: "late_tool", ok: true, summary: "arrived after sealing" }] });
    await recordCorrection(base44, { trajectory: await svc.entities.Trajectory.get(traj.id), reason: "late diagnostic attached", metadata: { source: "cert" } });
    const afterSeal = await svc.entities.Trajectory.get(traj.id);
    const correctionEvents = await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id, is_correction: true }, "sequence", 10);
    const firstEventAfter = JSON.stringify((await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id }, "sequence", 1))[0]);
    h.check("16 post-seal information extends history, never rewrites it",
      afterSeal.revision > revBefore && correctionEvents.length >= 2 && correctionEvents.every((e) => e.is_correction) &&
      !afterSeal.tool_calls.some((c) => c.phase === "post_seal") && firstEventBefore === firstEventAfter,
      `revision ${revBefore} -> ${afterSeal.revision}, ${correctionEvents.length} correction(s)`);

    const withOutcome = await recordUserOutcome(base44, caller, { project_id: proj.id, run_id: run.id, outcome: "deployed", detail: "shipped to production" });
    h.check("17 user outcome is appended after sealing",
      withOutcome.trajectory.user_outcome === "deployed" && !!withOutcome.trajectory.user_outcome_at && withOutcome.trajectory.revision > afterSeal.revision,
      `outcome=${withOutcome.trajectory.user_outcome} revision=${withOutcome.trajectory.revision}`);
    await h.expectThrow("17b invalid user outcome rejected",
      () => recordUserOutcome(base44, caller, { project_id: proj.id, run_id: run.id, outcome: "loved_it" }), "INVALID_OUTCOME");

    // ---------------- secret scrubbing ----------------

    const events = await svc.entities.TrajectoryEvent.filter({ trajectory_id: traj.id }, "sequence", 200);
    const serialized = JSON.stringify([await svc.entities.Trajectory.get(traj.id), events]);
    h.check("18 no credential value can enter the trajectory layer",
      !serialized.includes(SECRET) && !serialized.includes(TOKEN) && serialized.includes("[REDACTED]"),
      "prompt, context, routing decision and tool summaries are all scrubbed");

    // ---------------- authorization + isolation ----------------

    const read = await getTrajectory(base44, caller, { project_id: proj.id, run_id: run.id });
    h.check("19 authorized read returns the canonical episode with its events",
      read.trajectory.id === traj.id && read.events.length === events.length && read.events[0].sequence === 1 && !("value" in read.trajectory),
      `${read.events.length} event(s)`);
    const page = await listTrajectoryEvents(base44, caller, { project_id: proj.id, trajectory_id: traj.id, limit: 3, offset: 1 });
    const list = await listTrajectories(base44, caller, { project_id: proj.id });
    h.check("19b listing and event pagination are bounded",
      page.events.length === 3 && page.offset === 1 && page.total === events.length && list.trajectories.some((t) => t.id === traj.id),
      `page=${page.events.length}/${page.total}, ${list.count} episode(s)`);

    await h.expectThrow("20 non-member cannot read trajectories",
      () => getTrajectory(base44, { id: "traj_stranger", email: "stranger@example.com" }, { project_id: proj.id, run_id: run.id }), "NOT_A_MEMBER");
    await h.expectThrow("21 cross-project trajectory id resolves to nothing",
      () => getTrajectory(base44, caller, { project_id: otherProj.id, trajectory_id: traj.id }), "NOT_A_MEMBER");
    const foreignRun = await svc.entities.AIRun.create({ project_id: otherProj.id, status: "QUEUED", mode: "default", prompt: "foreign" });
    const foreignTraj = await startTrajectory(svc, { run: foreignRun, project: otherProj, workspace: other, trace_id: "t_foreign", context: {} });
    const ownList = await listTrajectories(base44, caller, { project_id: proj.id });
    h.check("22 project isolation holds on list paths",
      !ownList.trajectories.some((t) => t.id === foreignTraj.trajectory.id) && ownList.trajectories.every((t) => t.project_id === proj.id),
      `${ownList.count} episode(s), all scoped to the authorized project`);

    // ---------------- cancellation path + best-effort emission ----------------

    const cancelledRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "RUNNING", mode: "default", phase: "generate", trace_id: "t_traj_cert_2", prompt: "cancel me" });
    const cancelTraj = (await startTrajectory(base44, { run: cancelledRun, project: proj, workspace, trace_id: "t_traj_cert_2", context: {} })).trajectory;
    const cancelled = await finalizeTrajectory(base44, { run_id: cancelledRun.id, status: "CANCELLED", error: "cancelled by user", duration_ms: 900 });
    h.check("23 a cancelled run seals as a valid incomplete episode",
      cancelled.status === "CANCELLED" && cancelled.sealed === true && cancelled.outcomes.cancelled === true && cancelled.id === cancelTraj.id,
      JSON.stringify(cancelled.outcomes));
    const resolved = await trajectoryForRun(base44, cancelledRun.id);
    h.check("23b an episode is always resolvable from its run", resolved?.id === cancelTraj.id, resolved?.id || "none");

    const swallowed = await emit(() => { throw new Error("storage unavailable"); }, "cert");
    h.check("24 emission failure can never fail the observed run", swallowed === null, "emit swallowed and logged the failure");

    // ---------------- existing behavior untouched ----------------

    const runNow = await svc.entities.AIRun.get(run.id);
    const versionNow = await svc.entities.ProjectVersion.get(version.id);
    h.check("25 authoritative records remain untouched by the learning layer",
      runNow.status === "PLANNING" && runNow.trace_id === trace_id && versionNow.number === 2 && versionNow.snapshot.files.length === 1,
      "AIRun and ProjectVersion unchanged; trajectory only references them");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const p of [proj, otherProj]) {
      if (!p) continue;
      for (const name of ["TrajectoryEvent", "Trajectory", "ProjectVersion", "AIRun", "AuditLog", "TraceEvent"]) {
        await purgeBy(svc, name, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const w of [workspace, other]) if (w) await cleanupWorkspace(svc, w.id, ["AuditLog"]);
  }
}