// Runable Grow — Cold Calling, the fail-closed call lifecycle over the EXISTING lead list.
//
// The CONFIRMED product behavior (runable.com/marketing-grow, "Cold Calling"): "AI cold
// calling for your lead list: scripts, calls, follow-ups, and call summaries in your inbox."
//
// What this runtime supports LOCALLY, evidence-backed and end-to-end:
//   • SCRIPTS: a bounded model call drafts a cold-call script for an EXISTING project lead
//     (the leadGen determinism + fail-closed-credits pattern, reused verbatim).
//   • CALLS: one idempotent dial BackgroundJob per call (the duplicate-dial guard), with the
//     full persisted lifecycle state — scheduled / dialing / failed / canceled.
//   • SUMMARIES: the summary field exists and stays null until a real call ends.
//
// What is UNAVAILABLE and therefore FAILS CLOSED, never fabricated:
//   • the DIAL itself. Base44 publishes no telephony transport (the certified P-9.13 finding,
//     shared/agentChannelGaps.ts) — so the executor's ONLY adapter is the fail-closed one: the
//     dial refuses with the exact machine-checkable blocker and the call's terminal state is
//     `failed` with that blocker_code. NO simulated ring, NO invented duration, NO fabricated
//     summary, NO invented billing. The adapter boundary is injectable exactly once, for
//     certification (production never passes one — the fail-closed adapter runs).
import { err } from "./virality.ts";
import { enqueue, cancel } from "./jobQueue.ts";
import { loadAuthorizedProject } from "./authz.ts";
import { createTelephonyBoundary } from "./telephonyBoundary.ts";
import { holdIntegrationCredits } from "./integrationCharges.ts";
import { PHONE_CHANNEL_BLOCKER, PHONE_TRANSPORT_UNAVAILABLE_CODE } from "./agentChannelGaps.ts";
import { scopedKey, get as cacheGet, set as cacheSet } from "./cache.ts";

export { PHONE_TRANSPORT_UNAVAILABLE_CODE };

export const COLD_CALL_JOB_TYPE = "grow.coldcall";
export const COLD_CALLING_CREDITS = 3; // NEXUSAI-native estimate: one bounded model call per script
const MAX_SCRIPT_CHARS = 8000;

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const nowIso = () => new Date().toISOString();

/** The fail-closed telephony adapter: the dial ALWAYS refuses with the certified blocker. */
function failClosedTelephony() { return createTelephonyBoundary(); }

/** `status` answers with the blocker as data — the UI's and the agent's single source of truth. */
export function coldCallStatus() {
  return { channel: "cold_calling", available: false, blocker: PHONE_CHANNEL_BLOCKER, code: PHONE_TRANSPORT_UNAVAILABLE_CODE };
}

export const projectCall = (c) => ({
  id: c.id,
  customer_id: c.customer_id || null,
  status: c.status || "scheduled",
  script: c.script || null,
  blocker_code: c.blocker_code || null,
  summary: c.summary || null,
  call_job_id: c.call_job_id || null,
  scheduled_at: c.scheduled_at || null,
  dialed_at: c.dialed_at || null,
  attempts: c.attempts || 0, retryable: c.retryable === true, attempt_log: c.attempt_log || [],
  completed_at: c.completed_at || null,
});

const SCRIPT_SCHEMA = {
  type: "object",
  properties: { script: { type: "string" } },
  required: ["script"],
};

export const REAL_GENERATORS = {
  script: async (svc, { project, customer, angle }) => {
    const out = await svc.integrations.Core.InvokeLLM({
      prompt:
        `Write a cold-call opening script for a caller representing the business "${project?.name || "this business"}"` +
        (project?.description ? ` (${project.description})` : "") + `. The prospect:\n` +
        `Name: ${customer?.name || "unknown"}${customer?.company ? `\nCompany: ${customer.company}` : ""}` +
        `${customer?.title ? `\nTitle: ${customer.title}` : ""}` +
        (customer?.notes ? `\nKnown context: ${String(customer.notes).slice(0, 500)}` : "") +
        (angle ? `\nAngle to emphasize: ${angle}` : "") +
        `\n\nThe script is an OUTLINE the human caller follows, not a conversation record: an opening line, ` +
        `the value pitch (two sentences), two discovery questions, an objection-handling note, and a next step. ` +
        `At most 250 words. NEVER fabricate facts about the prospect beyond the stored record above.`,
      response_json_schema: SCRIPT_SCHEMA,
    });
    return out;
  },
};

// Determinism for STANDALONE drafts (a draft is NOT a call — it holds no ColdCall row, the
// leadGen pattern's row-keyed dedup does not apply): the same request_key resolves to the SAME
// script from a bounded cache entry, so a repeat is no second model call and no second hold.
const SCRIPT_CACHE_TTL_MS = 30 * 86400000;
const scriptCacheKey = (project_id, request_key) => scopedKey("coldcall:script", [project_id, request_key]);

async function cachedScript(svc, project_id, request_key) {
  const hit = await cacheGet(svc, scriptCacheKey(project_id, request_key)).catch(() => null);
  const script = hit?.value?.script;
  return (typeof script === "string" && script) ? script : null;
}

async function loadCustomer(svc, project, customer_id) {
  const row = await svc.entities.Customer.get(String(customer_id || "")).catch(() => null);
  if (!row || row.project_id !== project.id) {
    throw err("The call's lead was not found in this project", 404, "CUSTOMER_NOT_FOUND");
  }
  return row;
}

/** Draft a call script for an EXISTING project lead. Deterministic per request_key; credits fail closed. */
export async function generateCallScript(svc, project, workspace, user, input, { generators = {} } = {}) {
  const gen = { ...REAL_GENERATORS, ...(generators || {}) };
  const request_key = clean(input.request_key, 100) || `req_${crypto.randomUUID()}`;
  const customer = await loadCustomer(svc, project, input.customer_id);
  // Determinism: the same request_key returns the SAME script — no second model call.
  const prior = await svc.entities.ColdCall.filter({ project_id: project.id, customer_id: customer.id, script_request_key: request_key }, "created_date", 1).catch(() => []);
  if (prior.length) return { request_key, deduped: true, script: prior[0].script || null };
  const cached = await cachedScript(svc, project.id, request_key);
  if (cached) return { request_key, deduped: true, script: cached };

  const hold = await holdIntegrationCredits(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    credits: COLD_CALLING_CREDITS, key: `grow:coldcall:script:${project.id}:${request_key}`,
    reason: "NexusAI-native cold-call script generation (one bounded model call)",
  });
  try {
    const out = await gen.script(svc, { project, customer, angle: clean(input.script_angle, 1000) });
    const script = clean(out?.script, MAX_SCRIPT_CHARS);
    if (!script) throw err("Script generation returned no usable script", 502, "SCRIPT_EMPTY");
    // The generated script is persisted only inside its call row (scheduleCall attaches it) and
    // in the request_key determinism cache; a standalone draft is NOT a call — it holds no row.
    await cacheSet(svc, scriptCacheKey(project.id, request_key), { script }, { ttl_ms: SCRIPT_CACHE_TTL_MS });
    await hold.settle(COLD_CALLING_CREDITS, "NexusAI-native cold-call script generation");
    return { request_key, deduped: false, script };
  } catch (e) {
    await hold.fail().catch(() => {});
    throw e;
  }
}

/**
 * Schedule ONE call for an EXISTING project lead: the script (supplied, or generated through the
 * same credits path), the persisted row, and ONE idempotent dial job. A lead with a call still
 * in flight (scheduled/dialing) dedupes — the queue cannot double-dial.
 */
export async function scheduleCall(svc, project, workspace, user, input, { generators = {}, telephony = null } = {}) {
  const customer = await loadCustomer(svc, project, input.customer_id);
  if (input.request_key) {
    const prior = await svc.entities.ColdCall.filter({ project_id: project.id, customer_id: customer.id, script_request_key: clean(input.request_key, 100) }, "created_date", 1);
    if (prior[0]) return { deduped: true, call: projectCall(prior[0]) };
  }
  const open = await svc.entities.ColdCall.filter({ project_id: project.id, customer_id: customer.id, status: { $in: ["scheduled", "dialing"] } }, "-created_date", 1);
  if (open.length) {
    if (!open[0].call_job_id && open[0].status === "scheduled") {
      const repaired = await enqueue(svc, { queue: "default", job_type: COLD_CALL_JOB_TYPE, payload: { project_id: project.id, call_id: open[0].id }, max_attempts: 3, idempotency_key: `coldcall:${project.id}:${open[0].id}`, workspace_id: workspace.id, project_id: project.id });
      open[0] = await svc.entities.ColdCall.update(open[0].id, { call_job_id: repaired.job.id });
    }
    return { deduped: true, call: projectCall(open[0]) };
  }

  let script = clean(input.script, MAX_SCRIPT_CHARS);
  if (!script) {
    const gen = { ...REAL_GENERATORS, ...(generators || {}) };
    const request_key = clean(input.request_key, 100) || `req_${crypto.randomUUID()}`;
    const cached = await cachedScript(svc, project.id, request_key);
    // A cached draft is the deterministic replay: same script, no second model call, no hold.
    if (!cached) {
      const hold = await holdIntegrationCredits(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        credits: COLD_CALLING_CREDITS, key: `grow:coldcall:script:${project.id}:${request_key}`,
        reason: "NexusAI-native cold-call script generation (one bounded model call)",
      });
      try {
        const out = await gen.script(svc, { project, customer, angle: clean(input.script_angle, 1000) });
        script = clean(out?.script, MAX_SCRIPT_CHARS);
        if (!script) throw err("Script generation returned no usable script", 502, "SCRIPT_EMPTY");
        await cacheSet(svc, scriptCacheKey(project.id, request_key), { script }, { ttl_ms: SCRIPT_CACHE_TTL_MS });
        await hold.settle(COLD_CALLING_CREDITS, "NexusAI-native cold-call script generation");
      } catch (e) {
        await hold.fail().catch(() => {});
        throw e;
      }
    } else {
      script = clean(cached, MAX_SCRIPT_CHARS);
    }
  }

  const row = await svc.entities.ColdCall.create({
    project_id: project.id, workspace_id: workspace.id, customer_id: customer.id,
    script, status: "scheduled", user_id: user.id, attempts: 0, retryable: false, attempt_log: [],
    blocker_code: null, summary: null, call_job_id: null,
    script_request_key: clean(input.request_key, 100) || null,
    scheduled_at: nowIso(), dialed_at: null,
  });
  const out = await enqueue(svc, {
    queue: "default", job_type: COLD_CALL_JOB_TYPE,
    payload: { project_id: project.id, call_id: row.id },
    max_attempts: 3, idempotency_key: `coldcall:${project.id}:${row.id}`,
    workspace_id: workspace.id, project_id: project.id,
  });
  const updated = await svc.entities.ColdCall.update(row.id, { call_job_id: out.job?.id || null });
  // The dial seam exists for certification only; production runs the fail-closed adapter.
  void telephony;
  return { deduped: false, call: projectCall(updated) };
}

export async function getCall(svc, project, call_id) {
  const row = await svc.entities.ColdCall.get(String(call_id || "")).catch(() => null);
  if (!row || row.project_id !== project.id) throw err("Call not found", 404, "CALL_NOT_FOUND");
  return row;
}
export async function cancelCall(svc, project, call_id) {
  const row = await getCall(svc, project, call_id);
  if (row.status !== "scheduled") throw err("Only a scheduled call can be canceled safely", 409, "CALL_NOT_CANCELABLE");
  if (row.call_job_id) await cancel(svc, row.call_job_id, { reason: "Canceled by project member" });
  return { call: projectCall(await svc.entities.ColdCall.update(row.id, { status: "canceled", completed_at: nowIso() })) };
}
export async function retryCall(svc, project, call_id) {
  await getCall(svc, project, call_id);
  await createTelephonyBoundary().retry(); // No blind redial after an unknown outcome.
}
export async function callReport(svc, project) {
  const result = await svc.entities.ColdCall.aggregate({ query: { project_id: project.id }, groupBy: "status", sum: "attempts" });
  return { rows: result.rows, truncated: result.truncated, transport: coldCallStatus() };
}
export async function listCalls(svc, project, { limit = 50 } = {}) {
  const rows = await svc.entities.ColdCall.filter({ project_id: project.id }, "-created_date", Math.max(1, Math.min(Number(limit) || 50, 200)));
  return rows.map(projectCall);
}

/**
 * The dial executor: the call moves to `dialing`, the adapter refuses (fail-closed — the ONLY
 * production adapter), and the call converges to terminal `failed` with the machine-checkable
 * blocker. NEVER retried into a fake success; the summary stays null forever.
 */
export async function executeColdCallJob(svc, { call_id, project_id }, { telephony = null } = {}) {
  const call = await svc.entities.ColdCall.get(String(call_id || "")).catch(() => null);
  if (!call || String(project_id || "") !== call.project_id) {
    throw Object.assign(new Error("cold call requires the call's project_id and call_id"), { retryable: false, code: "INVALID_PAYLOAD" });
  }
  if (["failed", "canceled", "outcome_unknown"].includes(call.status)) return { call_id: call.id, skipped: true, status: call.status };
  if (call.status === "dialing") {
    if (Date.now() - Date.parse(call.dialed_at || call.updated_date) < 120000) return { call_id: call.id, skipped: true, status: "dialing" };
    await svc.entities.ColdCall.update(call.id, { status: "outcome_unknown", blocker_code: "DIAL_OUTCOME_UNKNOWN", retryable: false, completed_at: nowIso() });
    return { call_id: call.id, status: "outcome_unknown", refused: true };
  }
  if (call.user_id) {
    try { await loadAuthorizedProject(svc, { id: call.user_id }, call.project_id, "project.write"); }
    catch { await svc.entities.ColdCall.update(call.id, { status: "failed", blocker_code: "CALL_AUTHORIZATION_REVOKED", completed_at: nowIso() }); return { call_id: call.id, status: "failed", refused: true, blocker_code: "CALL_AUTHORIZATION_REVOKED" }; }
  }
  await svc.entities.ColdCall.update(call.id, { status: "dialing", dialed_at: nowIso(), attempts: (call.attempts || 0) + 1 });
  const adapter = telephony || failClosedTelephony();
  try {
    await adapter.dial({ call });
    // UNREACHABLE in production: the fail-closed adapter always refuses. If a future adapter
    // ever dials, THIS branch must never fabricate a summary — the real transport's result
    // would be recorded by its own executor. Today the refusal is the only path.
    throw err("The telephony adapter returned an unexpected success without a transport", 501, "TELEPHONY_INVALID_RESULT");
  } catch (e) {
    const blocker = e?.code || "TELEPHONY_UNAVAILABLE";
    const updated = await svc.entities.ColdCall.update(call.id, {
      status: "failed", blocker_code: blocker, dialed_at: nowIso(), completed_at: nowIso(), retryable: false,
      attempt_log: [...(call.attempt_log || []), { at: nowIso(), code: blocker, status: "refused", attempt: (call.attempts || 0) + 1 }].slice(-10),
    });
    return { call_id: call.id, status: updated.status, blocker_code: updated.blocker_code, refused: true };
  }
}