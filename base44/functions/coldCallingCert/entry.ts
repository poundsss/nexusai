// Targeted certification for Grow Cold Calling (shared/coldCalling.ts + the jobHandlers entry).
// ZERO real network (the script generator is injected; the telephony adapter is the production
// fail-closed one), REAL persistence through ColdCall + BackgroundJob, full cleanup in `finally`.
//   1. status: the blocker-as-data answer (machine-checkable code);
//   2. script generation: injected generator, bounded, deterministic per request_key (same key →
//      same script, no second call); an unknown lead refuses 404;
//   3. scheduling: one scheduled row + ONE idempotent dial job; a lead with a call in flight
//      dedupes (the queue cannot double-dial);
//   4. the dial executor: the fail-closed adapter refuses → terminal `failed` with
//      PHONE_TRANSPORT_UNAVAILABLE, summary stays null, NO fabricated success anywhere;
//   5. a terminal call is skipped by a repeat execution; a missing call is INVALID_PAYLOAD;
//   6. isolation: the second project sees NONE of the first project's calls;
//   7. authorization: a non-member cannot read the project's calls (403).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import {
  coldCallStatus, generateCallScript, scheduleCall, listCalls,
  executeColdCallJob, COLD_CALL_JOB_TYPE, PHONE_TRANSPORT_UNAVAILABLE_CODE,
} from "../../shared/coldCalling.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";
import { grantTestPool } from "../../shared/creditPoolTestHelpers.ts";

const DETERMINISTIC_SCRIPT = "Opening: Hi there, two-sentence pitch, two discovery questions, objection note, next step.";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `coldcall-${stamp}`, owner_id: caller.id, credits_balance: 1000000, status: "active" });
    workspaces.push(ws.id);
    // The LEDGER is the balance (Workspace.credits_balance is only a cached projection), so the
    // scratch pool is granted through the REAL ledger — the same grant path every other cert uses.
    await grantTestPool(svc, { workspace_id: ws.id, pool: "integration", amount: 100, key: `coldcall-cert-${stamp}`, reason: "cert pool" });
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `coldcall-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `coldcall2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);
    const lead = await svc.entities.Customer.create({ project_id: proj.id, workspace_id: ws.id, name: `Lead ${stamp}`, company: "Acme", status: "Lead", tags: "grow:leadgen" });
    const lead2 = await svc.entities.Customer.create({ project_id: proj2.id, workspace_id: ws.id, name: `Lead2 ${stamp}`, company: "Beta", status: "Lead", tags: "grow:leadgen" });

    // ---- 1. status: blocker as data -------------------------------------------------------
    const status = coldCallStatus();
    h.check("status answers with the certified blocker as data (machine-checkable code)",
      status.available === false && status.code === PHONE_TRANSPORT_UNAVAILABLE_CODE && !!status.blocker,
      JSON.stringify({ available: status.available, code: status.code }));

    // ---- 2. script generation: injected generator + determinism ---------------------------
    const generators = { script: async () => ({ script: DETERMINISTIC_SCRIPT }) };
    const scriptInput = { customer_id: lead.id, request_key: `s${stamp}` };
    const s1 = await generateCallScript(svc, proj, ws, { id: caller.id }, scriptInput, { generators });
    const s2 = await generateCallScript(svc, proj, ws, { id: caller.id }, scriptInput, { generators });
    h.check("script generation returns a bounded script and the same request_key is a dedup (same script, no second call)",
      s1.deduped === false && typeof s1.script === "string" && s1.script.length > 0 && s1.script.length <= 8000
        && s2.deduped === true && s2.script === s1.script,
      JSON.stringify({ first: s1.deduped, second: s2.deduped, len: (s1.script || "").length }));

    const missingLead = await captureCall(() => generateCallScript(svc, proj, ws, { id: caller.id }, { customer_id: "no-such-lead" }, { generators }));
    h.check("scripting an unknown lead is refused 404 (CUSTOMER_NOT_FOUND)",
      missingLead.threw && missingLead.code === "CUSTOMER_NOT_FOUND", missingLead.code || "no-throw");

    // ---- 3. scheduling: one row + one idempotent dial job; in-flight dedupe ---------------
    const call = await scheduleCall(svc, proj, ws, { id: caller.id }, { customer_id: lead.id, request_key: `s${stamp}` }, { generators });
    h.check("scheduling creates ONE scheduled call with the script attached and a dial job queued",
      call.deduped === false && call.call?.status === "scheduled" && call.call?.script === DETERMINISTIC_SCRIPT && !!call.call?.call_job_id,
      JSON.stringify({ status: call.call?.status, job: !!call.call?.call_job_id }));
    const again = await scheduleCall(svc, proj, ws, { id: caller.id }, { customer_id: lead.id }, { generators });
    h.check("scheduling a second call for a lead already in flight DEDUPES (no double-dial)",
      again.deduped === true && again.call.id === call.call.id, JSON.stringify({ id: again.call?.id }));
    const jobs = await svc.entities.BackgroundJob.filter({ project_id: proj.id, job_type: COLD_CALL_JOB_TYPE }, "created_date", 10);
    h.check("exactly ONE dial BackgroundJob exists per scheduled call", jobs.length === 1, String(jobs.length));

    // ---- 4. the dial executor: fail-closed refusal, terminal failed, no summary -----------
    const exec = await MAINTENANCE_HANDLERS[COLD_CALL_JOB_TYPE]({ id: "job-cc1", payload: { project_id: proj.id, call_id: call.call.id } }, { base44: svc, heartbeat: async () => {} });
    const row = await svc.entities.ColdCall.get(call.call.id);
    h.check("the dial refuses at the transport: terminal failed with the certified blocker code, summary stays null, NEVER a success",
      exec.status === "failed" && row.status === "failed" && row.blocker_code === PHONE_TRANSPORT_UNAVAILABLE_CODE
        && row.summary === null && !!row.dialed_at && row.status !== "completed",
      JSON.stringify({ status: row.status, blocker: row.blocker_code, summary: row.summary }));

    // ---- 5. a terminal call is skipped on repeat -------------------------------------------
    const exec2 = await MAINTENANCE_HANDLERS[COLD_CALL_JOB_TYPE]({ id: "job-cc2", payload: { project_id: proj.id, call_id: call.call.id } }, { base44: svc, heartbeat: async () => {} });
    h.check("a terminal call is skipped by a repeat execution (never re-dialed)",
      exec2.skipped === true && exec2.status === "failed", JSON.stringify(exec2));
    const missing = await captureCall(() => MAINTENANCE_HANDLERS[COLD_CALL_JOB_TYPE]({ id: "job-cc3", payload: { project_id: proj.id, call_id: "no-such-call" } }, { base44: svc, heartbeat: async () => {} }));
    h.check("a missing call is INVALID_PAYLOAD and non-retryable",
      missing.threw && missing.code === "INVALID_PAYLOAD", missing.code || "no-throw");

    // ---- 6. isolation: project 2 sees NONE of project 1's calls ----------------------------
    await scheduleCall(svc, proj2, ws, { id: caller.id }, { customer_id: lead2.id, script: "Second project script" });
    const other = await listCalls(svc, proj2, {});
    h.check("isolation: the second project's call list sees ONLY its own call",
      other.length === 1 && other[0].customer_id === lead2.id, String(other.length));

    // ---- 7. authorization -------------------------------------------------------------------
    const ghost = { id: `cc-ghost-${stamp}`, email: "cc-ghost@example.invalid" };
    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, ghost, proj.id, "project.read"));
    h.check("authorization: a non-member cannot read the project's calls (403)",
      strangerRead.threw && Number(strangerRead.status) === 403, String(strangerRead.status || "no-throw"));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "ColdCall", { project_id: pid });
      await purgeBy(svc, "Customer", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}