// Targeted certification for Backend Connector Automations (Base44 parity gap closure).
//
// Verifies that the SAME verified, already-deduplicated connector delivery that drives Workflow
// dispatch ALSO invokes opted-in generated backend functions (config.automations) through the
// ONE post-verification choke point (ingestConnectorDelivery) — with the documented envelope,
// condition operators, 200,000-byte projection, replay idempotency, project isolation and the
// existing queue retry/dead-letter mechanics.
//
// Exercises the REAL dispatch (ingestConnectorDelivery → dispatchConnectorAutomations → enqueue),
// the REAL handler/executor (deliverConnectorAutomation → executeProjectFunction), and the REAL
// queue primitives (enqueue → claim → fail/dead_letter via runJobs on a cert-only queue).
// NO real connectors, NO provider state, NO emails. Fixture functions are stored as ProjectFile
// rows; their sources respect the generated-code language subset.
//
// Cost discipline: every MATCHED automation enqueues one durable job, so the end-to-end dispatch
// is exercised only for the representative cases below while ALL 16 documented operators are
// certified through the exact condition evaluator the dispatcher calls (automationConditionsMatch)
// against the SAME delivery data. Non-matching automations are also exercised end-to-end (they
// must enqueue nothing). Coverage (13 checks):
//   1.  one matching event + the documented envelope through the REAL executor;
//   2.  one `and` condition end-to-end; the same delivery also proves `or` end-to-end;
//   3.  ALL 16 documented operators match the delivery data through the real evaluator, with
//       logic "or" matching, "and" non-matching, malformed conditions failing closed;
//   4.  one dot-path condition end-to-end;
//   5.  inactive (is_active: false), non-matching-event and condition-less Slack automations skip;
//   6.  a payload over 200,000 serialized characters projects data:null + payload_too_large:true,
//       and a sub-threshold control keeps data intact (threshold is exactly 200000);
//   7.  replay produces no second execution (no new jobs);
//   8.  Workflow dispatch still executes normally alongside automations;
//   9.  Gmail has_new_messages enrichment reaches automations (documented condition field);
//  10.  a Gmail mailbox change without new messages dispatches neither the automation nor the
//       documented-condition workflow;
//  11.  cross-project isolation (another project's matching function never runs);
//  12.  failure retry behavior through the real queue (backoff, attempt_log);
//  13.  dead-letter after the attempt budget is spent; handler is registered for the worker.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { ingestConnectorDelivery } from "../../shared/managedConnectorIngest.ts";
import {
  deliverConnectorAutomation, automationConditionsMatch, AUTOMATION_JOB_TYPE, PAYLOAD_TOO_LARGE_BYTES,
} from "../../shared/connectorAutomations.ts";
import { enqueue, runJobs } from "../../shared/jobQueue.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";
import { WORKFLOW_CONTRACT_VERSION, validateWorkflow, workflowChecksum } from "../../shared/workflowContract.ts";

// The 16 documented operators on DISTINCT fields, so ONE crafted delivery (D1) satisfies all of
// them simultaneously — certified through the real evaluator.
const OP_CASES = [
  ["op_equals", "eq", "equals", "match"],
  ["op_not_equals", "neq", "not_equals", "other"],
  ["op_contains", "cont", "contains", "Needle"],
  ["op_not_contains", "text", "not_contains", "zz"],
  ["op_starts_with", "starts", "starts_with", "prefix"],
  ["op_ends_with", "ends", "ends_with", "Suffix"],
  ["op_gt", "num", "gt", 5],
  ["op_gte", "num", "gte", 10],
  ["op_lt", "lownum", "lt", 5],
  ["op_lte", "lownum", "lte", 3],
  ["op_in_list", "member", "in_list", ["target", "z"]],
  ["op_not_in_list", "member", "not_in_list", ["onlyOther"]],
  ["op_exists", "present", "exists"],
  ["op_not_exists", "absent", "not_exists"],
  ["op_is_empty", "blank", "is_empty"],
  ["op_is_not_empty", "text", "is_not_empty"],
];

// One crafted delivery data object that satisfies ALL 16 operator conditions at once.
const D1 = {
  eq: "match", neq: "diff", cont: "hasNeedleInside", starts: "prefixRest", ends: "bodySuffix",
  num: 10, lownum: 3, member: "target", present: 1, blank: "", text: "hi",
};

// End-to-end probe: `and` (op_equals) and `or` (op_or) MATCH the d1 delivery; the dot-path
// (op_nested) and logic-"and"-false (op_and_false) automations do NOT (they must enqueue nothing).
const PROBE_AUTOMATIONS = [
  { type: "connector", name: "op_equals", integration_type: "slack", events: ["message"], trigger_conditions: { logic: "and", conditions: [{ field: "eq", operator: "equals", value: "match" }] } },
  { type: "connector", name: "op_or", integration_type: "slack", events: ["message"], trigger_conditions: { logic: "or", conditions: [{ field: "eq", operator: "equals", value: "NOPE" }, { field: "text", operator: "equals", value: "hi" }] } },
  { type: "connector", name: "op_nested", integration_type: "slack", events: ["message"], trigger_conditions: { logic: "and", conditions: [{ field: "sender.email", operator: "equals", value: "a@b.c" }] } },
  { type: "connector", name: "op_and_false", integration_type: "slack", events: ["message"], trigger_conditions: { logic: "and", conditions: [{ field: "eq", operator: "equals", value: "NOPE" }, { field: "text", operator: "equals", value: "hi" }] } },
];

const PROBE_SOURCE = "export const config = { method: \"POST\", description: \"operator probe\", automations: "
  + JSON.stringify(PROBE_AUTOMATIONS) + " };\n"
  + "export default async function (ctx) { return { status: 200, body: { saw: ctx.request.body } }; }\n";

const SKIP_SOURCE = "export const config = { method: \"POST\", description: \"skip probe\", automations: "
  + JSON.stringify([
    { type: "connector", name: "inactive_gmail", integration_type: "gmail", events: ["mailbox"], is_active: false },
    { type: "connector", name: "wrong_event", integration_type: "slack", events: ["reaction_added"] },
    { type: "connector", name: "slack_nocond", integration_type: "slack", events: ["message"] },
  ]) + " };\n"
  + "export default async function (ctx) { return { status: 200, body: { saw: ctx.request.body } }; }\n";

const BIG_SOURCE = "export const config = { method: \"POST\", description: \"big echo\", automations: "
  + JSON.stringify([{ type: "connector", name: "big_echo", integration_type: "googlecalendar", events: ["events"] }]) + " };\n"
  + "export default async function (ctx) { return { status: 200, body: { saw: ctx.request.body } }; }\n";

const FAIL_SOURCE = "export const config = { method: \"POST\", description: \"always fails\", automations: "
  + JSON.stringify([{ type: "connector", name: "failing", integration_type: "googlecalendar", events: ["events"] }]) + " };\n"
  + "export default async function (ctx) { throw new Error(\"cert failure\"); }\n";

const GMAIL_SOURCE = "export const config = { method: \"POST\", description: \"gmail probe\", automations: "
  + JSON.stringify([{
    type: "connector", name: "gmail_new_messages", integration_type: "gmail", events: ["mailbox"],
    trigger_conditions: { logic: "and", conditions: [{ field: "has_new_messages", operator: "equals", value: true }] },
  }]) + " };\n"
  + "export default async function (ctx) { return { status: 200, body: { saw: ctx.request.body } }; }\n";

function finalizeGmailWf(svc, { project, workspace }) {
  const def = {
    name: "Gmail Mailbox",
    trigger: { type: "connector", connector: "gmail", event: "mailbox", condition: ".trigger.data.has_new_messages == true" },
    steps: [{ id: "fetch", type: "complete", message: "ok" }],
    entry_step: "fetch",
  };
  const v = validateWorkflow(def, { functionNames: [] });
  if (!v.ok) throw new Error(`fixture invalid: ${v.errors.join("; ")}`);
  return svc.entities.WorkflowDefinition.create({
    workflow_key: "gmail-mailbox", name: def.name, version: 1, status: "FINALIZED", finalized: true,
    project_id: project.id, workspace_id: workspace.id,
    trigger: def.trigger, trigger_type: "connector", trigger_event: "mailbox",
    steps: def.steps, entry_step: "fetch", definition_checksum: workflowChecksum(def),
    contract_version: WORKFLOW_CONTRACT_VERSION, created_at: new Date().toISOString(),
  });
}

async function putFunction(svc, projectId, name, source) {
  return svc.entities.ProjectFile.create({
    project_id: projectId, path: `functions/${name}.js`, content: source,
  });
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  // Optional scope: { scope: "queue" } re-runs ONLY the retry/dead-letter checks (12-13) —
  // the main end-to-end block (checks 1-11) is skipped to keep a focused re-run fast.
  const body = await req.json().catch(() => ({}));
  const QUEUE_ONLY = body?.scope === "queue";
  const TAG = `autocert-${Date.now()}`;
  const h = createHarness();
  const scratch = { workspace: null, projects: [] };
  let project = null, project2 = null, workspace = null;

  try {
    workspace = await svc.entities.Workspace.create({ name: `${TAG}-ws`, owner_id: `${TAG}-owner`, credits_balance: 0 });
    scratch.workspace = workspace.id;
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-proj`, status: "ready", version_count: 0, slug: TAG.toLowerCase() });
    scratch.projects.push(project.id);
    project2 = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${TAG}-other`, status: "ready", version_count: 0, slug: `${TAG}-other`.toLowerCase() });
    scratch.projects.push(project2.id);

    await putFunction(svc, project.id, "operatorsProbe", PROBE_SOURCE);
    await putFunction(svc, project.id, "skipProbe", SKIP_SOURCE);
    await putFunction(svc, project.id, "bigEcho", BIG_SOURCE);
    await putFunction(svc, project.id, "failingProbe", FAIL_SOURCE);
    await putFunction(svc, project.id, "gmailProbe", GMAIL_SOURCE);
    // Cross-project isolation fixture: an identical probe on ANOTHER project.
    await putFunction(svc, project2.id, "operatorsProbe", PROBE_SOURCE);
    // The project's build gate requires an entry file.
    await svc.entities.ProjectFile.create({ project_id: project.id, path: "src/main.js", content: "// cert fixture\n" });
    await svc.entities.ProjectFile.create({ project_id: project2.id, path: "src/main.js", content: "// cert fixture\n" });

    if (!QUEUE_ONLY) await finalizeGmailWf(svc, { project, workspace });

    const jobsFor = (pid) => svc.entities.BackgroundJob.filter({ project_id: pid, job_type: AUTOMATION_JOB_TYPE }, "-created_date", 200).catch(() => []);
    const jobsByAutomation = async (pid, automationName, deliveryId) =>
      (await jobsFor(pid)).filter((j) => j.payload?.automation_name === automationName && (!deliveryId || j.payload?.delivery_id === deliveryId));
    const deliver = async (job) => deliverConnectorAutomation(svc, job.payload);

    if (!QUEUE_ONLY) {
    // --- 1 + 2. matching event + `and` and `or` conditions, documented envelope, REAL executor ---
    const r1 = await ingestConnectorDelivery(svc, {
      project, connector: "slack", event: "message", delivery_id: `${TAG}-d1`, payload: D1,
    });
    const eqJob = (await jobsByAutomation(project.id, "op_equals", `${TAG}-d1`))[0];
    const orJob = (await jobsByAutomation(project.id, "op_or", `${TAG}-d1`))[0];
    const eqRes = eqJob ? await deliver(eqJob) : null;
    const saw = eqRes?.body?.saw;
    const jobs1 = await jobsFor(project.id);
    h.check("1+2 matching event dispatches with and/or conditions and the documented envelope",
      r1.ok === true && r1.matched === 0 && r1.automations.matched === 2 && r1.automations.dispatched === 2
      && jobs1.length === 2 && !!orJob
      && eqRes?.status === 200 && saw?.payload?.event?.type === "message" && saw?.payload?.event?.integration_type === "slack"
      && saw?.payload?.data?.eq === "match" && saw?.payload?.payload_too_large === false
      && saw?.args !== undefined,
      `ok=${r1.ok} wfMatched=${r1.matched} autoMatched=${r1.automations?.matched} jobs=${jobs1.length} orJob=${!!orJob} status=${eqRes?.status} type=${saw?.payload?.event?.type} it=${saw?.payload?.event?.integration_type} eq=${saw?.payload?.data?.eq} ptl=${saw?.payload?.payload_too_large} args=${JSON.stringify(saw?.args)}`);

    // --- 3. ALL 16 operators through the real evaluator, plus logic and/or, fail-closed ---
    const opResults = OP_CASES.map(([name, field, operator, value]) => ({
      name, matched: automationConditionsMatch({ logic: "and", conditions: [{ field, operator, value }] }, D1),
    }));
    const andFalse = automationConditionsMatch(PROBE_AUTOMATIONS[3].trigger_conditions, D1);
    const orTrue = automationConditionsMatch(PROBE_AUTOMATIONS[1].trigger_conditions, D1);
    const malformed = automationConditionsMatch({ logic: "and", conditions: [{ field: "eq", operator: "bogus", value: 1 }] }, D1)
      && automationConditionsMatch({ logic: "and", conditions: [{ operator: "equals", value: 1 }] }, D1);
    const absent = automationConditionsMatch(null, D1) && automationConditionsMatch({ logic: "and", conditions: [] }, D1);
    h.check("3 all 16 documented operators match; or matches, and-false skips; malformed fails closed",
      opResults.every((r) => r.matched) && andFalse === false && orTrue === true && malformed === false && absent === true,
      `ops=${opResults.filter((r) => r.matched).length}/16 ${opResults.filter((r) => !r.matched).map((r) => r.name).join(",")} andFalse=${andFalse} orTrue=${orTrue} malformedNotMatched=${!malformed} absentMatches=${absent}`);

    // --- 4. dot-path condition end-to-end (a second delivery the nested condition matches) ---
    const r2 = await ingestConnectorDelivery(svc, {
      project, connector: "slack", event: "message", delivery_id: `${TAG}-d2`, payload: { sender: { email: "a@b.c" } },
    });
    const nestedJob = (await jobsByAutomation(project.id, "op_nested", `${TAG}-d2`))[0];
    const nestedRes = nestedJob ? await deliver(nestedJob) : null;
    h.check("4 dot-path conditions address fields under payload.data end-to-end",
      r2.ok === true && !!nestedJob && nestedRes?.body?.saw?.payload?.data?.sender?.email === "a@b.c",
      `matched=${r2.automations?.matched} nested=${!!nestedJob} email=${nestedRes?.body?.saw?.payload?.data?.sender?.email}`);

    // --- 5. inactive / non-matching-event / condition-less Slack automations skip ---------
    const skipNames = ["inactive_gmail", "wrong_event", "slack_nocond", "op_and_false"];
    const skipJobs = await Promise.all(skipNames.map((n) => jobsByAutomation(project.id, n, null)));
    h.check("5 inactive, non-matching-event and condition-less Slack automations skip",
      skipJobs.every((j) => j.length === 0),
      `inactive=${skipJobs[0].length} wrongEvent=${skipJobs[1].length} noCond=${skipJobs[2].length} andFalse=${skipJobs[3].length}`);

    // --- 6. oversized payload projection + sub-threshold control ------------------------
    const r3 = await ingestConnectorDelivery(svc, {
      project, connector: "googlecalendar", event: "events", delivery_id: `${TAG}-d3`,
      payload: { big: "x".repeat(200100) },
    });
    const bigJob = (await jobsByAutomation(project.id, "big_echo", `${TAG}-d3`))[0];
    const bigRes = bigJob ? await deliver(bigJob) : null;
    const r3b = await ingestConnectorDelivery(svc, {
      project, connector: "googlecalendar", event: "events", delivery_id: `${TAG}-d3b`,
      payload: { marker: "intact" },
    });
    const smallJob = (await jobsByAutomation(project.id, "big_echo", `${TAG}-d3b`))[0];
    const smallRes = smallJob ? await deliver(smallJob) : null;
    h.check("6 over-200000 payload projects data:null+payload_too_large, sub-threshold keeps data",
      PAYLOAD_TOO_LARGE_BYTES === 200000
      && bigJob?.payload?.data === null && bigJob?.payload?.payload_too_large === true
      && bigRes?.body?.saw?.payload?.data === null && bigRes?.body?.saw?.payload?.payload_too_large === true
      && smallJob?.payload?.data?.marker === "intact" && smallJob?.payload?.payload_too_large === false
      && smallRes?.body?.saw?.payload?.data?.marker === "intact"
      && r3.automations.matched >= 1 && r3b.automations.matched >= 1,
      `threshold=${PAYLOAD_TOO_LARGE_BYTES} bigData=${JSON.stringify(bigJob?.payload?.data)} bigPtl=${bigJob?.payload?.payload_too_large} bigSawPtl=${bigRes?.body?.saw?.payload?.payload_too_large} smallMarker=${smallJob?.payload?.data?.marker} smallPtl=${smallJob?.payload?.payload_too_large} matched=${r3.automations?.matched}/${r3b.automations?.matched}`);

    // --- 7. replay produces no second execution -----------------------------------------
    const jobsBeforeReplay = (await jobsFor(project.id)).length;
    const rReplay = await ingestConnectorDelivery(svc, {
      project, connector: "slack", event: "message", delivery_id: `${TAG}-d1`, payload: D1,
    });
    const jobsAfterReplay = (await jobsFor(project.id)).length;
    h.check("7 replay produces no second execution (no new jobs)",
      rReplay.duplicate === true && jobsAfterReplay === jobsBeforeReplay,
      `dup=${rReplay.duplicate} before=${jobsBeforeReplay} after=${jobsAfterReplay}`);

    // --- 8 + 9. Workflow dispatch unaffected; Gmail has_new_messages reaches automations ---
    const rG1 = await ingestConnectorDelivery(svc, {
      project, connector: "gmail", event: "mailbox", delivery_id: `${TAG}-g1`,
      payload: { trigger: { data: { has_new_non_draft_messages: true, new_message_ids: ["m9"] } } },
    });
    const g1Run = (await svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: "gmail-mailbox" }, "-created_date", 5))[0];
    const gmailJob = (await jobsByAutomation(project.id, "gmail_new_messages", `${TAG}-g1`))[0];
    const gmailRes = gmailJob ? await deliver(gmailJob) : null;
    h.check("8+9 Workflow dispatch unaffected; Gmail has_new_messages reaches automations",
      rG1.ok === true && rG1.matched === 1 && rG1.automations.matched >= 1
      && g1Run?.trigger_source === "connector" && !!gmailJob
      && gmailRes?.body?.saw?.payload?.data?.has_new_messages === true
      && gmailRes?.body?.saw?.payload?.event?.integration_type === "gmail",
      `wfMatched=${rG1.matched} autoMatched=${rG1.automations?.matched} run=${!!g1Run} hasNew=${gmailRes?.body?.saw?.payload?.data?.has_new_messages}`);

    // --- 10. no-new-message mailbox change dispatches neither target --------------------
    const gmailJobsBefore = (await jobsByAutomation(project.id, "gmail_new_messages", null)).length;
    const rG2 = await ingestConnectorDelivery(svc, {
      project, connector: "gmail", event: "mailbox", delivery_id: `${TAG}-g2`,
      payload: { trigger: { data: { has_new_non_draft_messages: false, new_message_ids: [] } } },
    });
    const gmailJobsAfter = (await jobsByAutomation(project.id, "gmail_new_messages", null)).length;
    h.check("10 no-new-message Gmail change dispatches neither workflow nor automation",
      rG2.matched === 0 && rG2.automations.matched === 0 && gmailJobsAfter === gmailJobsBefore,
      `wf=${rG2.matched} auto=${rG2.automations?.matched} jobsDelta=${gmailJobsAfter - gmailJobsBefore}`);

    // --- 11. cross-project isolation ----------------------------------------------------
    const project2Jobs = await jobsFor(project2.id);
    h.check("11 cross-project isolation (another project's matching function never runs)",
      project2Jobs.length === 0, `project2Jobs=${project2Jobs.length}`);

    } // end main end-to-end scope

    // --- 12. failure retry through the REAL queue (isolated cert queue) -----------------
    const mechQueue = `${TAG}-mech`;
    const failPayload = (await jobsByAutomation(project.id, "failing", `${TAG}-d3`))[0]?.payload || {
      project_id: project.id, function_name: "failingProbe", automation_name: "failing",
      connector: "googlecalendar", event: "events", data: null, payload_too_large: false,
    };
    const retryJob = await enqueue(svc, {
      queue: mechQueue, job_type: AUTOMATION_JOB_TYPE, payload: failPayload,
      idempotency_key: `${TAG}-retry`, workspace_id: workspace.id, project_id: project.id, max_attempts: 2,
    });
    const run1 = await runJobs(svc, { queue: mechQueue, handlers: MAINTENANCE_HANDLERS, worker_id: "cert", max_jobs: 5, budget_ms: 15000 });
    const retryRow = await svc.entities.BackgroundJob.get(retryJob.job.id);
    // Timing-tolerant: the same sweep may consume the backoff and dead-letter the job before it
    // returns (pending+attempts1, or dead_letter with the budget spent at attempts=max_attempts).
    h.check("12 failing automation retries through the real queue with attempt log",
      typeof MAINTENANCE_HANDLERS[AUTOMATION_JOB_TYPE] === "function"
      && ((retryRow.status === "pending" && (retryRow.attempts || 0) === 1 && (retryRow.attempt_log || []).length === 1)
        || (retryRow.status === "dead_letter" && (retryRow.attempts || 0) === 2 && (retryRow.attempt_log || []).length === 2
          && retryRow.error_code === "ATTEMPTS_EXHAUSTED"))
      && run1.failed === 1,
      `registered=${typeof MAINTENANCE_HANDLERS[AUTOMATION_JOB_TYPE]} status=${retryRow.status} attempts=${retryRow.attempts} log=${(retryRow.attempt_log || []).length} failed=${run1.failed}`);

    // --- 13. dead-letter after the attempt budget is spent ------------------------------
    const deadJob = await enqueue(svc, {
      queue: mechQueue, job_type: AUTOMATION_JOB_TYPE, payload: failPayload,
      idempotency_key: `${TAG}-dead`, workspace_id: workspace.id, project_id: project.id, max_attempts: 1,
    });
    // Bounded sweeps: claim order is oldest-available-first, so the still-due check-12 retry job
    // may be consumed first and a sweep's budget may end before the dead-letter job is reached —
    // sweep until the dead-letter row resolves (at most 3 sweeps), summing dead-lettered counts.
    let run2 = { dead_lettered: 0 };
    let deadRow = null;
    for (let sweep = 0; sweep < 3; sweep++) {
      const r = await runJobs(svc, { queue: mechQueue, handlers: MAINTENANCE_HANDLERS, worker_id: "cert", max_jobs: 5, budget_ms: 15000 });
      run2.dead_lettered += r.dead_lettered || 0;
      deadRow = await svc.entities.BackgroundJob.get(deadJob.job.id);
      if (deadRow.status === "dead_letter") break;
    }
    // The retried job from check 12 is also due again by now: its SECOND attempt must exhaust
    // its budget and dead-letter through the real backoff — budget spent → dead-letter.
    const retryAfter = await svc.entities.BackgroundJob.get(retryJob.job.id);
    h.check("13 dead-letter after the attempt budget is spent",
      deadRow.status === "dead_letter" && deadRow.error_code === "ATTEMPTS_EXHAUSTED" && run2.dead_lettered >= 1
      && retryAfter.status === "dead_letter" && (retryAfter.attempts || 0) === 2,
      `dead=${deadRow.status}/${deadRow.error_code} deadCount=${run2.dead_lettered} retryAfter=${retryAfter.status} attempts=${retryAfter.attempts}`);
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    // Zero leftovers: jobs, runs, definitions, invocations, files, projects, replay rows, workspace.
    for (const entity of ["BackgroundJob", "WorkflowRun", "WorkflowDefinition", "FunctionInvocation", "ProjectFile"]) {
      const q = scratch.projects.length ? { project_id: { $in: scratch.projects } } : {};
      await purgeBy(svc, entity, q);
    }
    const replayRows = await svc.entities.CacheEntry.filter({ namespace: "github_webhook_replay" }, "-created_date", 300).catch(() => []);
    for (const row of replayRows) {
      if (scratch.projects.some((pid) => String(row.cache_key || "").includes(pid))) {
        await svc.entities.CacheEntry.delete(row.id).catch(() => {});
      }
    }
    for (const pid of scratch.projects) await svc.entities.Project.delete(pid).catch(() => {});
    if (scratch.workspace) await cleanupWorkspace(svc, scratch.workspace, []);
  }

  return Response.json(h.summary());
}