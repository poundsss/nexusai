// Targeted certification for Phase 5 — AEO / AI visibility (shared/growAeo.ts + the
// jobHandlers registry entry). The model call is INJECTED (zero real credits), persistence is
// real (AeoProbe + AeoResult + BackgroundJob), full cleanup in `finally`.
//   1. validation: a too-short question refused, the per-project probe cap enforced, re-add dedup;
//   2. deterministic extraction: mention rank, no-mention, no-name;
//   3. persistence: measurements land project-scoped with the run_key;
//   4. idempotency: a re-run of the SAME run_key is served from storage with NO generator call;
//   5. credits fail closed: a generator failure releases the hold and stores nothing;
//   6. report: windowed, computed only from stored rows; per-project isolation;
//   7. scheduling: one bucket-keyed grow.aeo job, deduped re-schedule, executor self-reschedules
//     while probes remain and stops the chain when none remain; a missing project fails closed;
//   8. authorization: a non-member cannot read the project (403).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { grantTestPool, poolBalance } from "../../shared/creditPoolTestHelpers.ts";
import {
  addProbe, removeProbe, listProbes, runProbes, buildAeoReport, scheduleAeo, executeAeoJob,
  extractMention, AEO_JOB_TYPE, MAX_PROBES, QUESTION_MIN, AEO_CREDITS_PER_PROBE,
} from "../../shared/growAeo.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const APP = `AeoApp${stamp}`;
  let answerCalls = 0;
  const generators = {
    answer: async (_svc, { question }) => {
      answerCalls++;
      if (question.includes("FAIL")) throw new Error("model unavailable");
      if (question.includes("NOHIT")) return { recommendations: [{ name: "OtherOne", reason: "other" }] };
      return {
        recommendations: [
          { name: "FirstOne", reason: "first" },
          { name: `The ${APP} Platform`, reason: "matches the app" },
          { name: "ThirdOne", reason: "third" },
        ],
      };
    },
  };

  try {
    const ws = await svc.entities.Workspace.create({ name: `aeo-${stamp}`, owner_id: `ownerA_${stamp}` });
    workspaces.push(ws.id);
    await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: "starter_monthly", status: "active", provider: "manual", current_period_start: new Date(stamp).toISOString(), current_period_end: new Date(stamp + 30 * 86400000).toISOString() });
    await grantTestPool(svc, { workspace_id: ws.id, pool: "integration", amount: 100, key: `aeo-cert-${stamp}`, reason: "cert pool" });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: APP, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: APP, status: "ready", version_count: 1 });
    projects.push(proj2.id);
    const proj3 = await svc.entities.Project.create({ workspace_id: ws.id, name: `aeo3-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj3.id);

    // ---- 1. validation ---------------------------------------------------------------------
    const short = await captureCall(() => addProbe(svc, proj, ws, { question: "too short" }));
    h.check(`a question under ${QUESTION_MIN} chars is refused 400 (QUESTION_TOO_SHORT)`, short.threw && short.code === "QUESTION_TOO_SHORT", short.code || "no-throw");
    for (let i = 0; i < MAX_PROBES; i++) await addProbe(svc, proj, ws, { question: `what tools do teams use, probe ${i}?` });
    const overCap = await captureCall(() => addProbe(svc, proj, ws, { question: "another question over the probe cap?" }));
    h.check("the per-project probe cap is enforced 422 (TOO_MANY_PROBES)", overCap.threw && overCap.code === "TOO_MANY_PROBES", overCap.code || "no-throw");

    const first = await addProbe(svc, proj2, ws, { question: "which platforms help teams ship apps fast?" });
    const again = await addProbe(svc, proj2, ws, { question: "which platforms help teams ship apps fast?" });
    h.check("re-adding the SAME question is a dedup: the same row id", again.deduped === true && again.probe.id === first.probe.id, JSON.stringify(again));

    // ---- 2. extraction ----------------------------------------------------------------------
    const hit = extractMention(proj, [{ name: "FirstOne", reason: "first" }, { name: `The ${APP} Platform`, reason: "matches" }]);
    const miss = extractMention(proj, [{ name: "OtherOne", reason: "other" }]);
    const noName = extractMention(proj, null);
    h.check("extraction: a mention reports the 1-based rank, a miss reports not-mentioned, no name is safe",
      hit.mentioned && hit.rank === 2 && !miss.mentioned && miss.rank === null && noName.mentioned === false,
      JSON.stringify({ hit, miss, noName: noName.mentioned }));

    // ---- 3. persistence ---------------------------------------------------------------------
    const run1 = await runProbes(svc, proj2, ws, { run_key: "aeo-rk-1" }, { generators });
    h.check("the run measures every active probe and persists project-scoped rows with the run_key",
      run1.counts.measured === 1 && run1.counts.mentioned === 1 && run1.probes[0].mentioned && run1.probes[0].rank === 2,
      JSON.stringify(run1));
    const stored = await svc.entities.AeoResult.filter({ project_id: proj2.id }, "created_date", 10);
    h.check("stored rows carry probe scoping, the run key and a bounded excerpt",
      stored.length === 1 && stored[0].probe_id === first.probe.id && stored[0].run_key === "aeo-rk-1" && String(stored[0].excerpt || "").length <= 300,
      JSON.stringify(stored.map((r) => ({ k: r.run_key, m: r.mentioned }))));

    // ---- 4. idempotency ----------------------------------------------------------------------
    answerCalls = 0;
    const run2 = await runProbes(svc, proj2, ws, { run_key: "aeo-rk-1" }, { generators });
    h.check("a re-run of the SAME run_key is served from storage with ZERO generator calls",
      run2.deduped === true && run2.counts.measured === 1 && answerCalls === 0, JSON.stringify(run2));

    // ---- 5. credits fail closed ------------------------------------------------------------------
    const before = await poolBalance(svc, ws.id, "integration");
    const failing = await captureCall(() => runProbes(svc, proj2, ws, { run_key: "aeo-rk-fail" }, { generators: { answer: async () => { throw new Error("model unavailable"); } } }));
    const after = await poolBalance(svc, ws.id, "integration");
    const failRows = await svc.entities.AeoResult.filter({ project_id: proj2.id, run_key: "aeo-rk-fail" }, "created_date", 10);
    h.check("a generator failure throws, charges NOTHING and stores nothing for that run",
      failing.threw && failRows.length === 0 && before.balance === after.balance && after.reserved === 0,
      JSON.stringify({ before, after }));

    // ---- 6. report + isolation ---------------------------------------------------------------------
    const report = await buildAeoReport(svc, proj2, { since_days: 7 });
    h.check("the report is windowed, probe-grouped, computed only from stored rows",
      report.total_measurements === 1 && report.overall_visibility === 1 && report.probes.length === 1 &&
      report.probes[0].question === first.probe.question && report.probes[0].visibility === 1,
      JSON.stringify(report.probes));
    const report3 = await buildAeoReport(svc, proj3, { since_days: 7 });
    h.check("isolation: another project's report is empty", report3.total_measurements === 0, JSON.stringify(report3));

    // ---- 7. scheduling + executor chain ----------------------------------------------------------------
    const sch = await scheduleAeo(svc, proj2, ws, { interval_minutes: 120 });
    h.check("AEO monitoring is scheduled as ONE bucket-keyed grow.aeo job", sch.job_id && sch.interval_minutes === 120, JSON.stringify(sch));
    const sch2 = await scheduleAeo(svc, proj2, ws, { interval_minutes: 120 });
    h.check("re-scheduling the same bucket is a dedup: the same job id", sch2.duplicate === true && sch2.job_id === sch.job_id, JSON.stringify(sch2));
    const clamped = await scheduleAeo(svc, proj2, ws, { interval_minutes: 1 });
    h.check("an undersized interval is clamped into the supported bound", clamped.interval_minutes === 60, String(clamped.interval_minutes));
    await purgeBy(svc, "BackgroundJob", { project_id: proj2.id, job_type: AEO_JOB_TYPE });
    const exec1 = await executeAeoJob(svc, { project_id: proj2.id, interval_minutes: 120 }, { generators });
    h.check("the executor measures and self-reschedules the NEXT bucket while probes remain",
      exec1.counts.measured >= 1 && exec1.next_scheduled && exec1.next_scheduled.job_id,
      JSON.stringify(exec1.next_scheduled));
    const registryRun = await MAINTENANCE_HANDLERS[AEO_JOB_TYPE]({ id: "job-a1b", payload: { project_id: proj3.id, interval_minutes: 120 } }, { base44: svc, heartbeat: async () => {} });
    h.check("the registry handler wires grow.aeo (a probeless project is an empty stop)",
      registryRun.counts.measured === 0 && registryRun.next_scheduled === null, JSON.stringify(registryRun));
    const nextJobs = (await svc.entities.BackgroundJob.filter({ queue: "default", job_type: AEO_JOB_TYPE }, "created_date", 10))
      .filter((j) => j.project_id === proj2.id && String(j.idempotency_key).startsWith(`aeo:${proj2.id}`));
    h.check("the chain's next job exists with a distinct bucket key",
      nextJobs.length >= 1 && new Set(nextJobs.map((j) => j.idempotency_key)).size === nextJobs.length,
      JSON.stringify(nextJobs.map((j) => j.idempotency_key)));
    await removeProbe(svc, proj2, first.probe.id);
    const exec2 = await MAINTENANCE_HANDLERS[AEO_JOB_TYPE]({ id: "job-a2", payload: { project_id: proj2.id, interval_minutes: 120 } }, { base44: svc, heartbeat: async () => {} });
    h.check("with NO active probes the executor does NOT reschedule — the chain stops",
      exec2.next_scheduled === null && exec2.counts.measured === 0, JSON.stringify(exec2.next_scheduled));
    const missingProject = await captureCall(() => MAINTENANCE_HANDLERS[AEO_JOB_TYPE]({ id: "job-a3", payload: { project_id: "no-such-project" } }, { base44: svc, heartbeat: async () => {} }));
    h.check("a missing project is INVALID_PAYLOAD and non-retryable", missingProject.threw && missingProject.code === "INVALID_PAYLOAD", missingProject.code || "no-throw");

    // ---- 8. authorization ------------------------------------------------------------------------------
    const stranger = { id: `a_stranger_${stamp}`, email: "as@example.com" };
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, stranger, proj2.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's AEO (403)", strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "AeoProbe", { project_id: pid });
      await purgeBy(svc, "AeoResult", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) {
      await purgeBy(svc, "Subscription", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  return harnessResponse(h);
}