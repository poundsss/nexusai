// Targeted certification for Phase 3 — cold-email outreach (shared/outreach.ts + the jobHandlers
// registry entry). ZERO real sends (the send seam is injected), real queue persistence through
// BackgroundJob, full cleanup in `finally`.
//   1. scheduling: one idempotent BackgroundJob per step, staggered by the delay, with
//      per-step idempotency keys — and a re-schedule is a dedup, not a second job;
//   2. fail-closed refusals BEFORE anything is scheduled: missing email, invalid email,
//      self-send, too many follow-ups, empty content — ZERO jobs in every case;
//   3. the executor: send called exactly once with the contact's address, the CRM timeline row
//      created, the pipeline stage advanced Lead → Contacted (and left alone when already past);
//   4. idempotency beyond the enqueue gate: a SUCCEEDED prior step is skipped, not resent;
//   5. the registry: the job type is a handler, an empty payload is INVALID_PAYLOAD
//      (non-retryable) with no send, and a cross-project contact refuses;
//   6. isolation: the executor refuses a contact from another project.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { scheduleOutreach, executeOutreachEmailStep, OUTREACH_JOB_TYPE, MAX_FOLLOW_UPS } from "../../shared/outreach.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [], customers = [];

  try {
    const ws = await svc.entities.Workspace.create({ name: `outreach-${stamp}`, owner_id: `ownerO_${stamp}` });
    workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `outreach-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `outreach2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);
    const mkCustomer = async (projectId, over = {}) => svc.entities.Customer.create({
      project_id: projectId, workspace_id: ws.id, name: `Contact ${stamp}`, status: "Lead",
      email: "dana@brightline.example", ...over,
    });
    const custA = await mkCustomer(proj.id, { email: "dana@brightline.example" });
    const custNoEmail = await mkCustomer(proj.id, { email: "" });
    const custBadEmail = await mkCustomer(proj.id, { email: "not-an-email" });
    const custSelf = await mkCustomer(proj.id, { email: "o@example.com" });
    const custContacted = await mkCustomer(proj.id, { status: "Contacted" });
    const custOther = await mkCustomer(proj2.id);
    for (const c of [custA, custNoEmail, custBadEmail, custSelf, custContacted, custOther]) customers.push(c.id);

    // ---- 1. scheduling -------------------------------------------------------------------------
    const sch = await scheduleOutreach(svc, proj, ws, {
      customer_id: custA.id, subject: "Quick one, Dana", body: "Loved your ops teardown...",
      follow_ups: [{ subject: "Following up", body: "Bumping this once." }, { subject: "Last note", body: "Closing the loop." }],
      step_delay_minutes: 60, operator_email: "owner@elsewhere.example",
    });
    const jobs = await svc.entities.BackgroundJob.filter({ queue: "default", job_type: OUTREACH_JOB_TYPE }, "created_date", 10);
    const mine = jobs.filter((j) => String(j.idempotency_key || "").includes(custA.id));
    h.check("the schedule created ONE job per step with staggered delays and per-step keys",
      mine.length === 3 && mine.every((j) => j.payload.customer_id === custA.id) &&
      mine[0].payload.step_index === 0 && mine[1].payload.step_index === 1 && mine[2].payload.step_index === 2 &&
      Math.abs((new Date(mine[1].available_at) - new Date(mine[0].available_at)) - 3600000) < 5000 &&
      Math.abs((new Date(mine[2].available_at) - new Date(mine[0].available_at)) - 7200000) < 5000,
      JSON.stringify(mine.map((j) => j.available_at)));
    const sch2 = await scheduleOutreach(svc, proj, ws, {
      customer_id: custA.id, subject: "Quick one, Dana", body: "Loved your ops teardown...",
      operator_email: "owner@elsewhere.example",
    });
    h.check("re-scheduling is a dedup: the same first-step job id, no second row",
      sch2.steps[0].duplicate === true && sch2.steps[0].job_id === sch.steps[0].job_id,
      JSON.stringify(sch2.steps));

    // ---- 2. fail-closed refusals ------------------------------------------------------------------
    const refusalCases = [
      ["a contact without an email", { customer_id: custNoEmail.id, subject: "s", body: "b" }, "EMAIL_REQUIRED"],
      ["an invalid address", { customer_id: custBadEmail.id, subject: "s", body: "b" }, "EMAIL_INVALID"],
      ["the operator's own address", { customer_id: custSelf.id, subject: "s", body: "b", operator_email: "O@Example.com" }, "SELF_SEND"],
      ["too many follow-ups", { customer_id: custA.id, subject: "s", body: "b", follow_ups: Array(MAX_FOLLOW_UPS + 1).fill({ subject: "x", body: "y" }) }, "TOO_MANY_FOLLOW_UPS"],
      ["empty content", { customer_id: custA.id, subject: "", body: "  " }, "CONTENT_REQUIRED"],
      ["a contact from another project", { customer_id: custOther.id, subject: "s", body: "b" }, "CUSTOMER_NOT_FOUND"],
    ];
    for (const [label, args, code] of refusalCases) {
      const r = await captureCall(() => scheduleOutreach(svc, proj, ws, args));
      h.check(`refused before scheduling: ${label} (${code})`, r.threw && r.code === code, r.code || "no-throw");
    }
    const afterRefusals = (await svc.entities.BackgroundJob.filter({ queue: "default", job_type: OUTREACH_JOB_TYPE }, "created_date", 20))
      .filter((j) => [custNoEmail.id, custBadEmail.id, custSelf.id, custOther.id].includes(j.payload?.customer_id));
    h.check("every refusal left ZERO scheduled jobs", afterRefusals.length === 0, String(afterRefusals.length));

    // ---- 3. the executor (injected send) -----------------------------------------------------------
    const sent = [];
    const step0 = await executeOutreachEmailStep(svc, { project_id: proj.id, customer_id: custA.id, step_index: 0, subject: "Quick one, Dana", body: "Loved your ops teardown..." }, {
      send: async (args) => sent.push(args),
    });
    h.check("the executor sent ONCE to the contact's address with the step content",
      step0.status === "sent" && sent.length === 1 && sent[0].to === "dana@brightline.example" &&
      sent[0].subject === "Quick one, Dana", JSON.stringify(sent));
    const afterA = await svc.entities.Customer.get(custA.id);
    h.check("the pipeline stage advanced Lead → Contacted", afterA.status === "Contacted", afterA.status);
    const acts = await svc.entities.Activity.filter({ customerId: custA.id }, "created_date", 10);
    h.check("the send landed in the CRM timeline as an Email activity",
      acts.length === 1 && acts[0].type === "Email" && acts[0].notes.includes("Outreach step 0"),
      JSON.stringify(acts.map((a) => a.notes)));
    const step1 = await executeOutreachEmailStep(svc, { project_id: proj.id, customer_id: custContacted.id, step_index: 1, subject: "s", body: "b" }, {
      send: async (args) => sent.push(args),
    });
    const afterC = await svc.entities.Customer.get(custContacted.id);
    h.check("a contact already past Lead keeps its stage", step1.status === "sent" && afterC.status === "Contacted", afterC.status);

    // ---- 4. idempotency beyond the enqueue gate ------------------------------------------------------
    const sentBefore = sent.length;
    await svc.entities.BackgroundJob.create({ queue: "default", job_type: OUTREACH_JOB_TYPE, status: "succeeded", idempotency_key: `outreach:${proj.id}:${custA.id}:0`, payload: {} });
    const replay = await executeOutreachEmailStep(svc, { project_id: proj.id, customer_id: custA.id, step_index: 0, subject: "s", body: "b" }, { send: async (args) => sent.push(args) });
    h.check("a SUCCEEDED prior step is skipped, not resent", replay.status === "skipped" && replay.skipped === "already_sent" && sent.length === sentBefore, JSON.stringify(replay));

    // ---- 5. the registry entry ------------------------------------------------------------------------
    h.check("the registry maps the job type to a handler", typeof MAINTENANCE_HANDLERS[OUTREACH_JOB_TYPE] === "function", String(typeof MAINTENANCE_HANDLERS[OUTREACH_JOB_TYPE]));
    const emptyPayload = await captureCall(() => MAINTENANCE_HANDLERS[OUTREACH_JOB_TYPE]({ id: "j1", payload: {} }, { base44: svc, heartbeat: async () => {} }));
    h.check("an empty payload is refused INVALID_PAYLOAD with no send",
      emptyPayload.threw && emptyPayload.code === "INVALID_PAYLOAD" && sent.length === sentBefore, emptyPayload.code || "no-throw");
    const cross = await captureCall(() => executeOutreachEmailStep(svc, { project_id: proj.id, customer_id: custOther.id, step_index: 0, subject: "s", body: "b" }, { send: async (a) => sent.push(a) }));
    h.check("isolation: the executor refuses a contact of another project (no send)",
      cross.threw && cross.code === "INVALID_PAYLOAD" && sent.length === sentBefore, cross.code || "no-throw");
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const cid of customers) await svc.entities.Activity.deleteMany({ customerId: cid }).catch(() => {});
    await purgeBy(svc, "Customer", { project_id: projects[0] }).catch(() => {});
    await purgeBy(svc, "Customer", { project_id: projects[1] }).catch(() => {});
    for (const pid of projects) {
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}