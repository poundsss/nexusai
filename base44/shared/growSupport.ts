// Runable Grow — Phase 7: Customer Support, OUTBOUND ONLY.
//
// A proactive support/check-in message to an EXISTING contact of the project, sent through the
// app's own SendEmail integration the same way the certified outreach step is: ONE idempotent
// BackgroundJob per message in the EXISTING queue (delays, bounded retries, dead-letters, lease
// recovery and duplicate protection are the queue's machinery — no second scheduler, no timers).
//
// Fail-closed refusals BEFORE anything is scheduled: no target address (EMAIL_REQUIRED), the
// operator's own address (SELF_SEND), missing subject/body (CONTENT_REQUIRED), a contact outside
// the project (CUSTOMER_NOT_FOUND). The same deterministic message to the same contact is
// deduplicated by content key — a re-schedule returns the same job, never a second send.
//
// The executor is idempotent (a message whose job already SUCCEEDED is skipped, never resent),
// lands in the CRM timeline (Activity, type "Support") and deliberately does NOT advance the
// pipeline stage — support is not sales progression.
//
// OUTBOUND ONLY (the roadmap's stated scope): inbound reply handling, ticketing, threading and
// reply detection remain UNIMPLEMENTED and are never invented here. Delivery is never promised —
// the executor records exactly what happened; the platform's recipient-hygiene and anti-abuse
// limits apply upstream.

import { err } from "./virality.ts";
import { enqueue } from "./jobQueue.ts";

export const SUPPORT_JOB_TYPE = "grow.support_email";
export const SUBJECT_CHARS = 200;
export const BODY_CHARS = 10000;

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hashKey = (s) => {
  let h = 5381;
  for (const ch of String(s)) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
  return h.toString(16);
};

// A contact is fetched BY ID (get), never by a filter on the id field — an unknown id must be a
// clean miss, never a loose match.
const getCustomer = async (svc, id) => { try { return await svc.entities.Customer.get(String(id)); } catch { return null; } };

export async function scheduleSupportMessage(svc, project, workspace, input) {
  const customer_id = clean(input.customer_id, 100);
  if (!customer_id) throw err("customer_id is required", 400, "CUSTOMER_REQUIRED");
  const customer = await getCustomer(svc, customer_id);
  if (!customer || (customer.project_id || "") !== project.id) {
    throw err("The contact is not in this project's pipeline", 404, "CUSTOMER_NOT_FOUND");
  }
  const to = clean(customer.email, 320);
  if (!to) throw err("The contact has no email address — a support message refuses without a target address", 400, "EMAIL_REQUIRED");
  if (!EMAIL_RE.test(to)) throw err("The contact's email address is not a valid address", 400, "EMAIL_INVALID");
  if (clean(input.operator_email, 320) && to.toLowerCase() === clean(input.operator_email, 320).toLowerCase()) {
    throw err("The recipient is the operator's own address — self-send is refused", 400, "SELF_SEND");
  }
  const subject = clean(input.subject, SUBJECT_CHARS);
  const body = String(input.body ?? "").slice(0, BODY_CHARS);
  if (!subject || !body.trim()) throw err("subject and body are required", 400, "CONTENT_REQUIRED");
  const res = await enqueue(svc, {
    queue: "default", job_type: SUPPORT_JOB_TYPE,
    payload: { project_id: project.id, customer_id, subject, body },
    delay_ms: 0, max_attempts: 3,
    idempotency_key: `support:${project.id}:${customer_id}:${hashKey(`${subject}\n${body}`)}`,
    workspace_id: workspace.id, project_id: project.id,
  });
  return { customer_id, to, job_id: res.job?.id || null, duplicate: Boolean(res.duplicate), available_at: res.job?.available_at || null };
}

/** ONE outbound support message: send, land it in the CRM timeline. Idempotent; the send seam is
 *  injectable for certification (production never passes one). Never advances the pipeline. */
export async function executeSupportMessage(svc, { project_id, customer_id, subject, body }, { send = null } = {}) {
  const key = `support:${project_id}:${customer_id}:${hashKey(`${clean(subject, SUBJECT_CHARS)}\n${String(body ?? "")}`)}`;
  const prior = (await svc.entities.BackgroundJob.filter({ idempotency_key: key, status: "succeeded" }, "-created_date", 1).catch(() => []))[0] || null;
  if (prior) return { customer_id, status: "skipped", skipped: "already_sent" };

  const customer = await getCustomer(svc, customer_id);
  if (!customer || (customer.project_id || "") !== project_id) {
    throw Object.assign(new Error("the contact is not in this project's pipeline"), { retryable: false, code: "INVALID_PAYLOAD" });
  }
  const to = clean(customer.email, 320);
  if (!to) throw Object.assign(new Error("the contact has no email address"), { retryable: false, code: "NON_RETRYABLE" });
  const outSubject = clean(subject, SUBJECT_CHARS);
  const outBody = String(body ?? "").slice(0, BODY_CHARS);
  if (!outSubject || !outBody.trim()) {
    throw Object.assign(new Error("the message carries no subject or body"), { retryable: false, code: "INVALID_PAYLOAD" });
  }
  const doSend = send || (async (args) => { await svc.integrations.Core.SendEmail(args); });
  await doSend({ to, subject: outSubject, body: outBody });
  const activity = await svc.entities.Activity.create({
    customerId: customer.id, type: "Support", notes: `Support message: ${outSubject}`, date: nowIso(),
  });
  return { customer_id, status: "sent", to, activity_id: activity?.id || null };
}

/** The project-scoped history: the queue's support jobs (jobs carry the project id). */
export async function listSupportHistory(svc, project, { limit = 50 } = {}) {
  const jobs = await svc.entities.BackgroundJob.filter({ project_id: project.id, job_type: SUPPORT_JOB_TYPE }, "-created_date", Math.min(Math.max(1, Number(limit) || 50), 200)).catch(() => []);
  return { messages: jobs.map((j) => ({ job_id: j.id, customer_id: j.payload?.customer_id || null, subject: j.payload?.subject || null, status: j.status, attempts: j.attempts ?? null, created_at: j.created_date })) };
}