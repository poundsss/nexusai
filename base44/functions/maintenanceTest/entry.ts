// E2E certification of scheduled maintenance: retention, staging blobs, orphan verification
// namespaces, log pruning, dead-letter expiry, scheduling, singleton guard, retry and idempotency —
// through the REAL sweeps and the REAL job queue. Time is injected into the sweeps (never through
// a job payload); every fixture is scoped to scratch workspaces/projects and removed afterwards.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { enforceRetention, cleanupStagingBlobs, cleanupOrphanVerification, pruneLogs, cleanupDeadLetters, listDeadLetters, assertSingleton, MAINTENANCE_DEFAULTS } from "../../shared/maintenance.ts";
import { MAINTENANCE_HANDLERS, MAINTENANCE_SCHEDULE } from "../../shared/jobHandlers.ts";
import { enqueue, claim, complete, runJobs } from "../../shared/jobQueue.ts";

const DAY = 86400000;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check, expectThrow } = h;
  const stamp = Date.now();
  const past = (ms) => new Date(Date.now() - ms).toISOString();
  const Q = `mtest_${stamp}`;
  const created = { workspaces: [], projects: [], policies: [], jobs: [], audits: [], events: [] };
  const exists = async (entity, id) => !!(await svc.entities[entity].get(id).catch(() => null));

  try {
    const W1 = await svc.entities.Workspace.create({ name: `mt-w1 ${stamp}`, owner_id: `mt_owner_1_${stamp}`, status: "active" });
    const W2 = await svc.entities.Workspace.create({ name: `mt-w2 ${stamp}`, owner_id: `mt_owner_2_${stamp}`, status: "active" });
    created.workspaces.push(W1.id, W2.id);
    const P1 = await svc.entities.Project.create({ workspace_id: W1.id, name: "MT P1", framework: "preact-htm", status: "ready", version_count: 1 });
    const P2 = await svc.entities.Project.create({ workspace_id: W1.id, name: "MT P2", framework: "preact-htm", status: "ready", version_count: 1 });
    created.projects.push(P1.id, P2.id);

    // ---------------------------------------------------------------- 1 + 2 retention
    for (const [data_type, retention_days] of [["usage_events", 90], ["audit_logs", 365], ["ai_operations", 180], ["deployments", 90]]) {
      created.policies.push((await svc.entities.RetentionPolicy.create({ workspace_id: W1.id, data_type, retention_days, action: "delete", legal_basis: "contract", active: true })).id);
    }
    const use1 = await svc.entities.UsageEvent.create({ workspace_id: W1.id, project_id: P1.id, input_tokens: 1, output_tokens: 1 });
    const use2 = await svc.entities.UsageEvent.create({ workspace_id: W2.id, project_id: P2.id, input_tokens: 1, output_tokens: 1 });
    const auditPlain = await svc.entities.AuditLog.create({ workspace_id: W1.id, project_id: P1.id, action: "project.renamed", resource: "Project", resource_id: P1.id });
    const auditRequired = await svc.entities.AuditLog.create({ workspace_id: W1.id, action: "billing.charge", resource: "AIOperation" });
    const auditHeld = await svc.entities.AuditLog.create({ workspace_id: W1.id, action: "project.deleted", metadata: { legal_hold: true } });
    created.audits.push(auditRequired.id, auditHeld.id);
    const opDone = await svc.entities.AIOperation.create({ workspace_id: W1.id, operation_type: "ai_run", status: "completed", idempotency_key: `mt:done:${stamp}`, finalized_at: past(0) });
    const opLive = await svc.entities.AIOperation.create({ workspace_id: W1.id, operation_type: "ai_run", status: "running", idempotency_key: `mt:live:${stamp}` });
    const version = await svc.entities.ProjectVersion.create({ project_id: P1.id, number: 1, message: "Initial", snapshot: { files: [], entities: [] } });
    const artLive = await svc.entities.DeploymentArtifact.create({ project_id: P1.id, version_id: version.id, checksum: `live${stamp}` });
    const artDead = await svc.entities.DeploymentArtifact.create({ project_id: P1.id, version_id: version.id, checksum: `dead${stamp}` });
    const depLive = await svc.entities.Deployment.create({ project_id: P1.id, workspace_id: W1.id, version_id: version.id, artifact_id: artLive.id, status: "LIVE", environment: "production" });
    const depFailed = await svc.entities.Deployment.create({ project_id: P1.id, workspace_id: W1.id, version_id: version.id, artifact_id: artDead.id, status: "FAILED", environment: "production" });
    const depOther = await svc.entities.Deployment.create({ project_id: P2.id, workspace_id: W2.id, version_id: version.id, status: "FAILED", environment: "production" });
    await svc.entities.Project.update(P1.id, { production_deployment_id: depLive.id });

    const far = Date.now() + 400 * DAY;
    const ret = await enforceRetention(svc, { now: far, workspace_ids: [W1.id, W2.id] });
    check("1. retention deletes only eligible records: expired usage event, plain audit entry, finalized operation and failed deployment removed",
      !(await exists("UsageEvent", use1.id)) && !(await exists("AuditLog", auditPlain.id)) && !(await exists("AIOperation", opDone.id)) && !(await exists("Deployment", depFailed.id)) && !(await exists("DeploymentArtifact", artDead.id)),
      JSON.stringify(ret.by_type));
    check("2. immutable/live data is preserved: version, live deployment + artifact, running operation, required and legal-hold audit entries all remain",
      (await exists("ProjectVersion", version.id)) && (await exists("Deployment", depLive.id)) && (await exists("DeploymentArtifact", artLive.id)) && (await exists("AIOperation", opLive.id)) && (await exists("AuditLog", auditRequired.id)) && (await exists("AuditLog", auditHeld.id)),
      `protected ${ret.skipped_protected}`);
    check("15. cross-workspace data cannot be deleted: W2 has no policy, its records untouched by W1's policies",
      (await exists("UsageEvent", use2.id)) && (await exists("Deployment", depOther.id)));
    const retAgain = await enforceRetention(svc, { now: far, workspace_ids: [W1.id, W2.id] });
    check("14a. retention is idempotent: a second pass deletes nothing", retAgain.deleted === 0 && retAgain.artifacts_deleted === 0, JSON.stringify(retAgain.by_type));

    // ---------------------------------------------------------------- 3 + 4 staging blobs
    const runOld = await svc.entities.AIRun.create({ project_id: P1.id, status: "COMPLETED", mode: "default", phase: "done", staging_url: "https://example.invalid/old.json", completed_at: past(2 * DAY) });
    const runFresh = await svc.entities.AIRun.create({ project_id: P1.id, status: "FAILED", mode: "default", phase: "done", staging_url: "https://example.invalid/fresh.json", completed_at: past(60000) });
    const runActive = await svc.entities.AIRun.create({ project_id: P1.id, status: "EXECUTING", mode: "default", phase: "build", staging_url: "https://example.invalid/active.json", heartbeat_at: past(0) });
    const blobs = await cleanupStagingBlobs(svc, { project_ids: [P1.id] });
    check("3. staging blob cleanup removes only safe blobs: terminal run past TTL released, recent terminal run kept",
      blobs.released === 1 && !(await svc.entities.AIRun.get(runOld.id)).staging_url && !!(await svc.entities.AIRun.get(runFresh.id)).staging_url, JSON.stringify(blobs));
    check("4. active blob is preserved: executing run keeps its staging reference", !!(await svc.entities.AIRun.get(runActive.id)).staging_url);

    // ---------------------------------------------------------------- 5 + 6 verification namespaces
    const nsActive = `verify_${P1.id}_aaaa1111`;   // P1 has an EXECUTING run → in use
    const nsOrphan = `verify_${P2.id}_bbbb2222`;   // P2 has nothing verifying → orphan once past grace
    await svc.entities.AppRecord.create({ project_id: nsActive, entity_name: "Thing", data: { n: 1 } });
    const orphanRec = await svc.entities.AppRecord.create({ project_id: nsOrphan, entity_name: "Thing", data: { n: 2 } });
    const realRec = await svc.entities.AppRecord.create({ project_id: P2.id, entity_name: "Thing", data: { real: true } });
    const fresh = await cleanupOrphanVerification(svc, { project_ids: [P1.id, P2.id] });
    check("6a. a verification namespace inside the grace period is preserved", fresh.namespaces_deleted === 0 && fresh.preserved_active === 2, JSON.stringify(fresh));
    const verif = await cleanupOrphanVerification(svc, { now: Date.now() + 2 * 3600000, project_ids: [P1.id, P2.id] });
    check("5. orphan verification cleanup works: aged namespace with no verifying run removed", verif.namespaces_deleted === 1 && !(await exists("AppRecord", orphanRec.id)), JSON.stringify(verif));
    check("6. active verification namespace is preserved (project has a verifying run); real project data never touched",
      (await svc.entities.AppRecord.filter({ project_id: nsActive }, "-created_date", 5)).length === 1 && (await exists("AppRecord", realRec.id)));
    check("14b. verification cleanup is idempotent", (await cleanupOrphanVerification(svc, { now: Date.now() + 2 * 3600000, project_ids: [P1.id, P2.id] })).namespaces_deleted === 0);

    // ---------------------------------------------------------------- 7 + 8 log pruning
    const invOk = await svc.entities.FunctionInvocation.create({ project_id: P1.id, function_name: "hello", trigger: "frontend", status: 200, ok: true });
    const invAuth = await svc.entities.FunctionInvocation.create({ project_id: P1.id, function_name: "hello", trigger: "webhook", status: 401, ok: false, error_class: "AuthError" });
    const auditsBefore = (await svc.entities.AuditLog.filter({ workspace_id: W1.id }, "-created_date", 50)).length;
    const notYet = await pruneLogs(svc, { project_ids: [P1.id] });
    const pruned = await pruneLogs(svc, { now: Date.now() + (MAINTENANCE_DEFAULTS.log_retention_days + 1) * DAY, project_ids: [P1.id] });
    check("7. log pruning respects retention: nothing pruned inside the window, expired invocation pruned past it",
      notYet.invocations_deleted === 0 && pruned.invocations_deleted === 1 && !(await exists("FunctionInvocation", invOk.id)), JSON.stringify(pruned));
    check("8. required audit/security records are preserved: 401 invocation kept, audit log untouched by log pruning",
      (await exists("FunctionInvocation", invAuth.id)) && pruned.security_preserved === 1 && (await svc.entities.AuditLog.filter({ workspace_id: W1.id }, "-created_date", 50)).length === auditsBefore);

    // ---------------------------------------------------------------- 9 + 10 dead letters
    const mk = async (data) => { const j = await svc.entities.BackgroundJob.create({ queue: Q, job_type: "platform.ping", ...data }); created.jobs.push(j.id); return j; };
    const deadOld = await mk({ status: "dead_letter", error_code: "ATTEMPTS_EXHAUSTED", last_error: "still broken", attempts: 3, attempt_log: [{ attempt: 1, error: "x" }], completed_at: past(40 * DAY), workspace_id: W1.id });
    const deadNew = await mk({ status: "dead_letter", error_code: "HANDLER_ERROR", last_error: "recent", attempts: 3, completed_at: past(DAY), workspace_id: W1.id });
    const pendingJob = await mk({ status: "pending", available_at: past(0), attempts: 1, last_error: "retrying" });
    const listed = await listDeadLetters(svc, { queue: Q });
    check("9. dead-letter records remain visible with their diagnostics and expiry", listed.length === 2 && listed.every((j) => j.error_code && j.expires_at) && listed.some((j) => j.id === deadOld.id), `${listed.length} listed`);
    const dl = await cleanupDeadLetters(svc, { queues: [Q] });
    const diag = await svc.entities.AuditLog.filter({ action: "job.dead_letter.expired", resource_id: deadOld.id }, "-created_date", 5);
    for (const d of diag) created.audits.push(d.id);
    check("10. expired dead-letter records are cleaned, with a diagnostic audit entry written first; recent one and retriable job untouched",
      dl.dead_letters_expired === 1 && !(await exists("BackgroundJob", deadOld.id)) && diag.length === 1 && diag[0].metadata?.error_code === "ATTEMPTS_EXHAUSTED" && (await exists("BackgroundJob", deadNew.id)) && (await exists("BackgroundJob", pendingJob.id)),
      JSON.stringify(dl));
    const dlAgain = await cleanupDeadLetters(svc, { queues: [Q] });
    check("14c. dead-letter cleanup is idempotent and never duplicates the diagnostic entry",
      dlAgain.dead_letters_expired === 0 && (await svc.entities.AuditLog.filter({ action: "job.dead_letter.expired", resource_id: deadOld.id }, "-created_date", 5)).length === 1);

    // ---------------------------------------------------------------- 11 scheduled execution
    const NEW_TYPES = ["retention.enforce", "storage.cleanup_staging", "verification.cleanup_orphans", "logs.prune", "queue.cleanup_dead_letters"];
    check("11a. every sweep is on the recurring maintenance schedule with a registered handler",
      NEW_TYPES.every((t) => MAINTENANCE_SCHEDULE.some((s) => s.job_type === t && s.queue === "maintenance") && typeof MAINTENANCE_HANDLERS[t] === "function"));
    const runOld2 = await svc.entities.AIRun.create({ project_id: P2.id, status: "COMPLETED", mode: "default", phase: "done", staging_url: "https://example.invalid/old2.json", completed_at: past(3 * DAY) });
    const { job: sched } = await enqueue(svc, { queue: Q, job_type: "storage.cleanup_staging", payload: { project_ids: [P2.id] }, idempotency_key: `mt:sched:${stamp}` });
    created.jobs.push(sched.id);
    const summary = await runJobs(svc, { queue: Q, handlers: MAINTENANCE_HANDLERS, worker_id: "mt-worker", max_jobs: 3, budget_ms: 30000 });
    const schedDone = await svc.entities.BackgroundJob.get(sched.id);
    check("11. scheduled execution actually runs: the queued sweep executed through the worker and released the blob",
      schedDone.status === "succeeded" && schedDone.result?.released === 1 && !(await svc.entities.AIRun.get(runOld2.id)).staging_url, `${summary.succeeded} succeeded`);
    check("11b. a payload cannot move the sweep's clock: `now` in a payload is ignored",
      (await MAINTENANCE_HANDLERS["storage.cleanup_staging"]({ id: "x", job_type: "storage.cleanup_staging", payload: { now: Date.now() + 10 * DAY, project_ids: [P1.id] } }, { base44: svc })).released === 0 && !!(await svc.entities.AIRun.get(runFresh.id)).staging_url);

    // ---------------------------------------------------------------- 12 duplicate workers
    const { job: jobA } = await enqueue(svc, { queue: Q, job_type: "logs.prune", payload: { project_ids: [P1.id] } });
    const { job: jobB } = await enqueue(svc, { queue: `${Q}_b`, job_type: "logs.prune", payload: { project_ids: [P1.id] } });
    created.jobs.push(jobA.id, jobB.id);
    const [leasedA] = await claim(svc, { queue: Q, worker_id: "mt-worker-a", limit: 1 });
    const [leasedB] = await claim(svc, { queue: `${Q}_b`, worker_id: "mt-worker-b", limit: 1 });
    await expectThrow("12. duplicate workers cannot perform unsafe duplicate cleanup: second leaseholder of the same sweep is refused (retryable)", () => assertSingleton(svc, leasedB), "CONCURRENT_MAINTENANCE");
    await complete(svc, leasedA.id, leasedA.lease_token, {});
    let ok = true; try { await assertSingleton(svc, leasedB); } catch { ok = false; }
    check("12b. once the first worker finishes, the sweep may run again", ok);
    await complete(svc, leasedB.id, leasedB.lease_token, {});

    // ---------------------------------------------------------------- 13 failed cleanup retryable
    const runOld3 = await svc.entities.AIRun.create({ project_id: P2.id, status: "CANCELLED", mode: "default", phase: "done", staging_url: "https://example.invalid/old3.json", completed_at: past(3 * DAY) });
    const { job: flaky } = await enqueue(svc, { queue: `${Q}_r`, job_type: "storage.cleanup_staging", payload: { project_ids: [P2.id] }, max_attempts: 3 });
    created.jobs.push(flaky.id);
    let attempts = 0;
    const flakyHandlers = { "storage.cleanup_staging": async (job, ctx) => { attempts++; if (attempts === 1) throw new Error("transient storage error"); return MAINTENANCE_HANDLERS["storage.cleanup_staging"](job, ctx); } };
    await runJobs(svc, { queue: `${Q}_r`, handlers: flakyHandlers, worker_id: "mt-flaky", max_jobs: 1, budget_ms: 20000 });
    const afterFail = await svc.entities.BackgroundJob.get(flaky.id);
    const stillThere = !!(await svc.entities.AIRun.get(runOld3.id)).staging_url;
    await svc.entities.BackgroundJob.update(flaky.id, { available_at: past(0) });
    await runJobs(svc, { queue: `${Q}_r`, handlers: flakyHandlers, worker_id: "mt-flaky-2", max_jobs: 1, budget_ms: 20000 });
    const afterRetry = await svc.entities.BackgroundJob.get(flaky.id);
    check("13. failed cleanup is retryable: first attempt fails and is rescheduled with state intact, retry succeeds and completes the sweep exactly once",
      afterFail.status === "pending" && afterFail.attempts === 1 && stillThere && afterRetry.status === "succeeded" && afterRetry.result?.released === 1 && !(await svc.entities.AIRun.get(runOld3.id)).staging_url, `${afterFail.status} → ${afterRetry.status}`);

    // ---------------------------------------------------------------- 14 idempotency (whole set)
    const rerun = [await cleanupStagingBlobs(svc, { project_ids: [P1.id, P2.id] }), await pruneLogs(svc, { now: Date.now() + 31 * DAY, project_ids: [P1.id] })];
    check("14. cleanup is idempotent across every sweep: repeated passes over the same state change nothing", rerun[0].released === 0 && rerun[1].invocations_deleted === 0, JSON.stringify(rerun));

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const q of [Q, `${Q}_b`, `${Q}_r`]) await purgeBy(svc, "BackgroundJob", { queue: q });
    for (const id of created.jobs) await svc.entities.BackgroundJob.delete(id).catch(() => {});
    for (const id of created.policies) await svc.entities.RetentionPolicy.delete(id).catch(() => {});
    for (const id of created.audits) await svc.entities.AuditLog.delete(id).catch(() => {});
    for (const pid of created.projects) {
      for (const name of ["AIRun", "FunctionInvocation", "ProjectVersion", "DeploymentArtifact", "Deployment", "AppRecord"]) await purgeBy(svc, name, { project_id: pid });
      for (const ns of await svc.entities.AppRecord.filter({}, "-created_date", 200).catch(() => [])) if (String(ns.project_id).startsWith(`verify_${pid}_`)) await svc.entities.AppRecord.delete(ns.id).catch(() => {});
    }
    for (const wid of created.workspaces) await cleanupWorkspace(svc, wid, ["Project", "UsageEvent", "AuditLog", "AIOperation", "Deployment", "ComplianceEvent"]);
  }
}