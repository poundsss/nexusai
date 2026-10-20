// Runable Grow — Phase 3: cold-email outreach.
//
// A schedule is ONE idempotent BackgroundJob per step in the EXISTING queue (the jobHandlers
// registry), so delays, bounded retries, dead-letters, lease recovery and duplicate protection
// are the queue's certified machinery — this module adds no second scheduler, no second worker
// and no timers of its own. The step executor is idempotent: a step whose job already SUCCEEDED
// is skipped (a fresh enqueue of the same logical step must never resend), a retried attempt
// converges, and each sent step lands in the CRM timeline (Activity) and advances the
// contact's pipeline stage Lead → Contacted (the existing documented pipeline).
//
// Fail-closed refusals BEFORE anything is scheduled or sent:
//   • no target address on the contact → EMAIL_REQUIRED (an outreach job without a recipient
//     can only dead-letter — never scheduled);
//   • the operator's own address as recipient → SELF_SEND (a campaign that can email its
//     operator is refused, not merely discouraged);
//   • more than MAX_FOLLOW_UPS steps → TOO_MANY_FOLLOW_UPS;
//   • a step without subject or body → CONTENT_REQUIRED.
//
// Send path: the app's own SendEmail integration through the service role. The platform's
// recipient-hygiene and anti-abuse limits apply to it upstream (registered app users always;
// other addresses only on a paid plan with a connected email domain) — a refused send surfaces
// as the step's last_error and follows the queue's retry/dead-letter policy. Delivery is never
// promised here; the executor records exactly what happened.
//
// UNKNOWN, never invented: open/reply tracking, deliverability warm-up, per-recipient variable
// merge (the text is sent exactly as written), and inbound support replies — Phase 7 of the
// roadmap stays OUTBOUND ONLY (inbound reply handling remains unimplemented, marked UNKNOWN).

import { err } from "./virality.ts";
import { enqueue } from "./jobQueue.ts";

export const OUTREACH_JOB_TYPE = "grow.outreach_email";
export const MAX_FOLLOW_UPS = 3;
export const DEFAULT_STEP_DELAY_MINUTES = 60; // NEXUSAI-DERIVED (UNKNOWN): the documented cadence is not published
export const SUBJECT_CHARS = 200;
export const BODY_CHARS = 10000;

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function scheduleOutreach(svc, project, workspace, input) {
  const customer_id = clean(input.customer_id, 100);
  if (!customer_id) throw err("customer_id is required", 400, "CUSTOMER_REQUIRED");
  // A malformed or nonexistent id must read as "not found", not as a raw query error —
  // the surface refuses fail-closed either way.
  const customer = (await svc.entities.Customer.filter({ id: customer_id }, "created_date", 1).catch(() => []))[0] || null;
  if (!customer || (customer.project_id || "") !== project.id) {
    throw err("The contact is not in this project's pipeline", 404, "CUSTOMER_NOT_FOUND");
  }
  const to = clean(customer.email, 320);
  if (!to) throw err("The contact has no email address — outreach refuses without a target address", 400, "EMAIL_REQUIRED");
  if (!EMAIL_RE.test(to)) throw err("The contact's email address is not a valid address", 400, "EMAIL_INVALID");
  if (clean(input.operator_email, 320) && to.toLowerCase() === clean(input.operator_email, 320).toLowerCase()) {
    throw err("The recipient is the operator's own address — self-send is refused", 400, "SELF_SEND");
  }
  const first = { subject: clean(input.subject, SUBJECT_CHARS), body: String(input.body ?? "").slice(0, BODY_CHARS) };
  if (!first.subject || !first.body.trim()) throw err("subject and body are required", 400, "CONTENT_REQUIRED");
  const followUps = Array.isArray(input.follow_ups) ? input.follow_ups : [];
  if (followUps.length > MAX_FOLLOW_UPS) throw err(`At most ${MAX_FOLLOW_UPS} follow-ups per sequence`, 422, "TOO_MANY_FOLLOW_UPS");
  const steps = [first, ...followUps.map((f) => ({ subject: clean(f?.subject, SUBJECT_CHARS), body: String(f?.body ?? "").slice(0, BODY_CHARS) }))];
  if (steps.some((s) => !s.subject || !s.body.trim())) throw err("every step needs a subject and a body", 400, "CONTENT_REQUIRED");

  const delay = Math.max(1, Number(input.step_delay_minutes) || DEFAULT_STEP_DELAY_MINUTES);
  const scheduled = [];
  for (let i = 0; i < steps.length; i++) {
    // The FIRST step is scheduled at the bound (delay 0); each follow-up lands one delay later.
    const res = await enqueue(svc, {
      queue: "default", job_type: OUTREACH_JOB_TYPE,
      payload: { project_id: project.id, customer_id, step_index: i, subject: steps[i].subject, body: steps[i].body },
      delay_ms: i === 0 ? 0 : delay * 60000 * i,
      max_attempts: 3,
      idempotency_key: `outreach:${project.id}:${customer_id}:${i}`,
      workspace_id: workspace.id, project_id: project.id,
    });
    scheduled.push({ step_index: i, job_id: res.job?.id || null, duplicate: Boolean(res.duplicate), available_at: res.job?.available_at || null });
  }
  return { customer_id, to, steps: scheduled };
}

/**
 * ONE outreach step: send the email, land it in the CRM timeline, advance the pipeline stage.
 * Idempotent (see the module header) and side-effect bounded — the send seam is injectable for
 * certification (production never passes one).
 */
export async function executeOutreachEmailStep(svc, { project_id, customer_id, step_index, subject, body }, { send = null } = {}) {
  const step = Number(step_index);
  if (!Number.isInteger(step) || step < 0 || step > MAX_FOLLOW_UPS) {
    throw Object.assign(new Error(`step_index must be between 0 and ${MAX_FOLLOW_UPS}`), { retryable: false, code: "INVALID_PAYLOAD" });
  }
  // Idempotency beyond the enqueue gate: a SUCCEEDED job with this step's key means the email
  // already went out — the queue only dedupes pending/leased rows, so a re-enqueued step lands
  // here and must skip, not resend.
  const key = `outreach:${project_id}:${customer_id}:${step}`;
  const prior = (await svc.entities.BackgroundJob.filter({ idempotency_key: key, status: "succeeded" }, "-created_date", 1).catch(() => []))[0] || null;
  if (prior) return { customer_id, step_index: step, status: "skipped", skipped: "already_sent" };

  const customer = (await svc.entities.Customer.filter({ id: customer_id }, "created_date", 1).catch(() => []))[0] || null;
  if (!customer || (customer.project_id || "") !== project_id) {
    throw Object.assign(new Error("the contact is not in this project's pipeline"), { retryable: false, code: "INVALID_PAYLOAD" });
  }
  const to = clean(customer.email, 320);
  if (!to) throw Object.assign(new Error("the contact has no email address"), { retryable: false, code: "NON_RETRYABLE" });
  const outSubject = clean(subject, SUBJECT_CHARS);
  const outBody = String(body ?? "").slice(0, BODY_CHARS);
  if (!outSubject || !outBody.trim()) {
    throw Object.assign(new Error("the step carries no subject or body"), { retryable: false, code: "INVALID_PAYLOAD" });
  }
  const doSend = send || (async (args) => { await svc.integrations.Core.SendEmail(args); });
  await doSend({ to, subject: outSubject, body: outBody });
  if (customer.status === "Lead") await svc.entities.Customer.update(customer.id, { status: "Contacted" });
  const activity = await svc.entities.Activity.create({
    customerId: customer.id, type: "Email", notes: `Outreach step ${step}: ${outSubject}`, date: nowIso(),
  });
  return { customer_id, step_index: step, status: "sent", to, activity_id: activity?.id || null };
}