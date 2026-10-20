// Benchmark measurement dimensions that are NOT derivable from the Judge's evaluation alone:
// reliability, tool-call success, real provider cost, normalized cost, context handling and
// structured-output quality.
//
// Every value here is READ from a record the platform already wrote:
//   • provider cost / credits / tokens → AIOperation (the authoritative charge row of the run).
//     Nothing is priced here and nothing is estimated here — a run whose operation reported no
//     usage yields `null`, never a fabricated number.
//   • tool-call success → the sealed episode's own tool_calls projection (#18).
//   • context handling → the operation's real input tokens against the model's catalog context
//     window. Marked with its usage_source, so an estimated count can never be presented as a
//     measured one.
//   • structured-output quality → the episode's own planner evidence (a recorded plan means the
//     model's structured output satisfied the planner contract; planning retries mean it did not
//     on the first attempt). No signal ⇒ null, never a zero.
//
// This module measures only. It prices nothing, charges nothing and mutates nothing.
import { MODEL_REGISTRY } from "./modelGateway.ts";

const round = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);
const rate = (hits, total) => (total ? round(hits / total) : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Failure classes that are the PROVIDER's doing rather than the model's quality. */
export const PROVIDER_FAILURE_CLASSES = ["model_provider_failure", "timeout"];

/**
 * Real usage and cost for ONE benchmark attempt, read from the run's authoritative AIOperation
 * rows. Only finalized, completed operations carry a valid charge, so a failed provider call can
 * never contribute cost. Returns null when the execution produced no such row — the absence of
 * cost data is reported as absence.
 */
export async function providerAccounting(svc, { run_id, workspace_id = null }) {
  if (!run_id) return null;
  const rows = await svc.entities.AIOperation.filter({ run_id: String(run_id) }, "created_date", 50).catch(() => []);
  const scoped = workspace_id ? rows.filter((o) => !o.workspace_id || o.workspace_id === workspace_id) : rows;
  if (!scoped.length) return null;
  const charged = scoped.filter((o) => o.status === "completed" && o.finalized_at);
  const source = charged.length ? charged : scoped;
  const sum = (f) => source.reduce((a, o) => a + num(o[f]), 0);
  const measured = source.filter((o) => o.usage_source === "provider").length;
  return {
    operations: source.length,
    operation_ids: source.map((o) => o.id),
    charged_operations: charged.length,
    input_tokens: sum("input_tokens"), cached_input_tokens: sum("cached_input_tokens"),
    output_tokens: sum("output_tokens"), reasoning_tokens: sum("reasoning_tokens"),
    total_tokens: sum("total_tokens"),
    // Real upstream cost, exactly as the charging path recorded it under its frozen pricing version.
    provider_cost: charged.length ? round(sum("provider_cost")) : null,
    currency: source[0]?.currency || "USD",
    pricing_versions: [...new Set(source.map((o) => o.pricing_version).filter(Boolean))],
    credits_charged: charged.length ? round(sum("credits_charged") - sum("credits_refunded")) : null,
    credit_policy_versions: [...new Set(source.map((o) => o.credit_policy_version).filter(Boolean))],
    // 'provider' only when EVERY contributing operation reported a real usage block.
    usage_source: measured === source.length && source.length ? "provider" : measured ? "mixed" : "estimated",
    models_used: [...new Set(source.map((o) => o.model_id).filter(Boolean))],
    providers_used: [...new Set(source.map((o) => o.provider).filter(Boolean))],
    duration_ms: sum("duration_ms") || null,
  };
}

/** Tool-call reliability of one attempt, from the sealed episode's own tool_calls projection. */
export function toolCallMetrics(trajectory) {
  const calls = Array.isArray(trajectory?.tool_calls) ? trajectory.tool_calls : [];
  if (!calls.length) return { tool_calls: 0, tool_calls_ok: 0, tool_calls_failed: 0, tool_call_success: null, failed_tools: [] };
  const ok = calls.filter((c) => c.ok === true).length;
  const failed = calls.filter((c) => c.ok === false);
  return {
    tool_calls: calls.length, tool_calls_ok: ok, tool_calls_failed: failed.length,
    tool_call_success: rate(ok, calls.length),
    failed_tools: [...new Set(failed.map((c) => String(c.tool || "unknown")))].slice(0, 10),
  };
}

/**
 * Context handling: how much of the model's real catalog context window the attempt's input
 * actually consumed. Null when the window or the token count is unknown; the usage source travels
 * with the number so an estimated count is never read as a measurement.
 */
export function contextMetrics({ model_id, accounting }) {
  const entry = MODEL_REGISTRY.find((m) => m.model_id === model_id || m.id === model_id) || null;
  const window = entry?.contextWindow ?? null;
  const input = accounting ? accounting.input_tokens + accounting.cached_input_tokens : null;
  const output = accounting ? accounting.output_tokens : null;
  return {
    context_window: window,
    context_input_tokens: input,
    context_utilization: window && input != null && input > 0 ? round(input / window) : null,
    context_overflow: window && input != null ? (input > window ? 1 : 0) : null,
    max_output_tokens: entry?.maxOutputTokens ?? null,
    output_truncated: entry?.maxOutputTokens && output != null ? (output >= entry.maxOutputTokens ? 1 : 0) : null,
    context_usage_source: accounting?.usage_source || null,
  };
}

/**
 * Structured-output quality, from the episode's own recorded evidence. A recorded plan means the
 * model's structured output satisfied the planner contract; a planning retry means it did not on
 * the first attempt. An episode with no planning evidence at all (a discuss-mode answer, an
 * attempt that never reached planning) reports null rather than a failure.
 */
export async function structuredOutputMetrics(svc, { trajectory }) {
  if (!trajectory?.id) return { structured_output_valid: null, structured_output_retries: null, plan_recorded: null };
  const events = await svc.entities.TrajectoryEvent
    .filter({ trajectory_id: trajectory.id }, "sequence", 400).catch(() => []);
  const planning = events.filter((e) => e.event_type === "plan_recorded");
  const planRetries = events.filter((e) => e.event_type === "retry" && /plan/i.test(String(e.phase || e.name || "")));
  const planErrors = events.filter((e) => e.event_type === "plan_recorded" && e.status === "error");
  if (!planning.length && !planRetries.length) {
    return { structured_output_valid: null, structured_output_retries: null, plan_recorded: 0 };
  }
  return {
    // Valid on the first attempt: a plan was recorded, it did not error, and planning was not retried.
    structured_output_valid: planning.length && !planErrors.length && !planRetries.length ? 1 : 0,
    structured_output_retries: planRetries.length,
    plan_recorded: planning.length ? 1 : 0,
  };
}

/**
 * Everything this module contributes for ONE attempt, in one call. Returns the extra metric block
 * and the real accounting block; the caller merges them into the result it is already writing.
 */
export async function extendedMeasurements(svc, { run, trajectory, workspace_id = null, model_id = null }) {
  const accounting = await providerAccounting(svc, { run_id: run?.id, workspace_id });
  const tools = toolCallMetrics(trajectory);
  const context = contextMetrics({ model_id: model_id || run?.model || null, accounting });
  const structured = await structuredOutputMetrics(svc, { trajectory });
  return { accounting, metrics: { ...tools, ...context, ...structured } };
}

// --- aggregation ---------------------------------------------------------------

/**
 * Aggregates the extended dimensions across SCORED results, plus the reliability view that keeps
 * provider failures separate from model quality. Costs are summed only from results that really
 * reported them, and `cost_coverage` states how many did — so a partial cost picture is visible
 * as partial instead of looking like a cheap run.
 */
export function extendedBucket(results) {
  const scored = results.filter((r) => r.scored !== false && ["COMPLETED", "FAILED"].includes(r.status));
  // The extended dimensions live under one nested key on the result's metrics object.
  const ext = (r) => (r.metrics || {}).extended || {};
  const val = (f) => scored.map((r) => ext(r)[f]).filter((v) => v != null);
  const ones = (f) => val(f).filter((v) => v === 1).length;
  const avg = (values) => { const v = values.filter((x) => x != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const withCost = scored.filter((r) => (r.usage || {}).provider_cost != null);
  const withCredits = scored.filter((r) => (r.usage || {}).credits_charged != null);
  const providerFailures = results.filter((r) => PROVIDER_FAILURE_CLASSES.includes(r.failure_class || "none"));
  const successes = scored.filter((r) => (r.metrics || {}).task_success === 1);
  const totalCost = round(withCost.reduce((a, r) => a + num(r.usage.provider_cost), 0));
  const totalCredits = round(withCredits.reduce((a, r) => a + num(r.usage.credits_charged), 0));
  return {
    // Reliability: did the attempt reach a measurable outcome at all, and how often did the
    // PROVIDER (not the model's judgement) fail. Counted over every execution, scored or not.
    reliability: {
      executions: results.length,
      measurable: scored.length,
      measurable_rate: rate(scored.length, results.length),
      provider_failures: providerFailures.length,
      provider_failure_rate: rate(providerFailures.length, results.length),
      timeouts: results.filter((r) => r.failure_class === "timeout").length,
      fallbacks_used: scored.filter((r) => (r.usage || {}).fallback_used === true).length,
      retried: scored.filter((r) => ((r.retries || {}).retry_count || 0) > 0).length,
    },
    tool_calls: {
      total: scored.reduce((a, r) => a + (ext(r).tool_calls || 0), 0),
      failed: scored.reduce((a, r) => a + (ext(r).tool_calls_failed || 0), 0),
      success_rate: avg(val("tool_call_success")),
      attempts_with_tools: scored.filter((r) => (ext(r).tool_calls || 0) > 0).length,
    },
    context: {
      avg_utilization: avg(val("context_utilization")),
      max_utilization: val("context_utilization").length ? Math.max(...val("context_utilization")) : null,
      overflows: ones("context_overflow"),
      truncated_outputs: ones("output_truncated"),
      measured_from_provider_usage: scored.filter((r) => ext(r).context_usage_source === "provider").length,
    },
    structured_output: {
      valid_rate: rate(ones("structured_output_valid"), val("structured_output_valid").length),
      measured_for: val("structured_output_valid").length,
      total_retries: scored.reduce((a, r) => a + (ext(r).structured_output_retries || 0), 0),
    },
    cost: {
      // Real upstream cost, kept strictly separate from the user-facing credit charge.
      provider_cost: withCost.length ? totalCost : null,
      currency: withCost[0]?.usage?.currency || "USD",
      credits_charged: withCredits.length ? totalCredits : null,
      cost_coverage: rate(withCost.length, scored.length),
      // Normalized: what one successful task actually cost. Null when nothing succeeded or no cost
      // was reported, rather than dividing by zero into a fake efficiency number.
      provider_cost_per_success: withCost.length && successes.length ? round(totalCost / successes.length) : null,
      credits_per_success: withCredits.length && successes.length ? round(totalCredits / successes.length) : null,
      avg_provider_cost: withCost.length ? round(totalCost / withCost.length) : null,
      pricing_versions: [...new Set(scored.flatMap((r) => (r.usage || {}).pricing_versions || []))],
      usage_sources: [...new Set(scored.map((r) => (r.usage || {}).usage_source).filter(Boolean))],
    },
  };
}