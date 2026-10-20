// Atomic AI charging.
//
// The commercial flow every AI call takes:
//   authorization → budget check → reservation → provider execution → REAL usage →
//   cost → credit policy → ledger charge → reservation release → result
//
// Guarantees:
//   * an operation is charged EXACTLY ONCE — `finalized_at` is the gate and the ledger
//     idempotency key is the backstop, so retries, duplicated workers and reconnects settle
//     the same operation instead of charging again;
//   * a provider failure never produces a valid charge (the reservation is released instead);
//   * a client disconnect never makes a successful provider call free — usage accumulates on
//     the persisted operation and is finalized from the server side;
//   * streaming charges once at the end, never per chunk.

import { normalizeUsage, priceOperation, priceUsageByModel, loadCreditPolicy, estimateMaxCharge, DEFAULT_CREDIT_POLICY } from "./economics.ts";
import { recordEvent, reserve, releaseReservation, liveReservation, findByKey, InsufficientCredits, creditTypeOf, type CreditType } from "./ledger.ts";
import { stampUsageEvent } from "./usageEventStamp.ts";
import { checkBudget, assertBudget, spendableCredits, enforcePlanUsageAfterCreate } from "./budget.ts";
import { loadCatalog, getModel } from "./modelCatalog.ts";
import { worstCaseCallCredits, WORST_CASE_IMAGE_INPUT_TOKENS } from "./modelGateway.ts";
import { resolveModelAccess } from "./subscriptions.ts";

const nowIso = () => new Date().toISOString();

// Per-model token breakdown: { [model_id]: { input_tokens, cached_input_tokens, output_tokens, reasoning_tokens } }.
// Attribution only — pricing still uses the operation's totals under its model_id.
const ZERO_MODEL_USAGE = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };

export function mergeUsageByModel(...maps) {
  const out = {};
  for (const map of maps) {
    for (const [id, u] of Object.entries(map || {})) {
      const cur = out[id] || { ...ZERO_MODEL_USAGE };
      out[id] = {
        input_tokens: cur.input_tokens + (Number(u?.input_tokens) || 0),
        cached_input_tokens: cur.cached_input_tokens + (Number(u?.cached_input_tokens) || 0),
        output_tokens: cur.output_tokens + (Number(u?.output_tokens) || 0),
        reasoning_tokens: cur.reasoning_tokens + (Number(u?.reasoning_tokens) || 0),
      };
    }
  }
  return out;
}

// Tokens in the operation totals that no model in the breakdown accounts for (e.g. usage carried
// in from before breakdowns existed) are attributed to the operation's own model, so pricing by
// model never drops tokens the totals already contain.
function reconcileUsageByModel(byModel, totals, modelId) {
  const rest = {};
  for (const f of Object.keys(ZERO_MODEL_USAGE)) {
    const attributed = Object.values(byModel).reduce((n, u) => n + (Number(u?.[f]) || 0), 0);
    rest[f] = Math.max(0, (Number(totals?.[f]) || 0) - attributed);
  }
  return Object.values(rest).some((v) => v > 0) ? mergeUsageByModel(byModel, { [modelId || "unknown"]: rest }) : byModel;
}

/** Adds one gateway result's usage to `byModel` (mutated) under the model that actually served it. */
export function addModelUsage(byModel, modelId, res) {
  const merged = mergeUsageByModel(byModel, {
    [modelId || "unknown"]: {
      input_tokens: res?.inputTokens, output_tokens: res?.outputTokens,
      cached_input_tokens: res?.usage?.cached_input_tokens, reasoning_tokens: res?.usage?.reasoning_tokens,
    },
  });
  Object.assign(byModel, merged);
  return byModel;
}

export async function findOperation(base44, { operation_id = null, workspace_id = null, idempotency_key = null }) {
  if (operation_id) return base44.entities.AIOperation.get(operation_id).catch(() => null);
  if (!workspace_id || !idempotency_key) return null;
  const hits = await base44.entities.AIOperation.filter({ workspace_id, idempotency_key }, "created_date", 5);
  return hits[0] || null;
}

// Duplicate-row race reconciliation — the SAME semantics ledger recordEvent applies to entries:
// after the insert, re-query the key; the EARLIEST row (created_date, then id) is canonical and
// every other row is stamped terminal, so one logical operation key never has two active records.
// The loser returns the canonical row to its caller, which proceeds on it exactly as if it had
// created it — the ledger keys are shared and idempotent, so nothing is double-held or double-charged.
async function reconcileDuplicateOperation(base44, created) {
  const hits = await base44.entities.AIOperation.filter(
    { workspace_id: created.workspace_id, idempotency_key: created.idempotency_key }, "created_date", 20
  );
  const ordered = [...hits].sort((a, b) =>
    String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)));
  const canonical = ordered[0];
  if (!canonical || canonical.id === created.id) return created;
  await base44.entities.AIOperation.updateMany({
    id: created.id,
    $or: [{ finalized_at: { $exists: false } }, { finalized_at: null }],
  }, { $set: {
    status: "failed", credits_charged: 0, credits_reserved: 0, finalized_at: nowIso(),
    error: `Duplicate operation row for idempotency key '${created.idempotency_key}'; canonical operation ${canonical.id} retained`,
  } });
  return canonical;
}

/**
 * Opens (or re-attaches to) a billable operation.
 * Re-calling with the same idempotency_key NEVER creates a second operation — that is what
 * makes retries and stream reconnects safe.
 */
export async function beginOperation(base44, {
  workspace_id, user_id = null, project_id = null, run_id = null,
  operation_type = "ai_run", model_id, gateway_provider = null, streaming = false,
  idempotency_key, estimate = {}, routing = null, policy = null, catalog = null,
  creditType, candidate_model_ids = null,
}: { creditType?: CreditType; candidate_model_ids?: string[] | null; [key: string]: any }) {
  if (!idempotency_key) throw new Error("beginOperation: idempotency_key is required");
  const credit_type = creditTypeOf(creditType);
  const existing = await findOperation(base44, { workspace_id, idempotency_key });
  if (existing) {
    // Never trust a stale credits_reserved. A running operation whose begin was interrupted
    // before its hold was placed (no reservation entry under its key) gets that hold placed now;
    // otherwise credits_reserved is re-synchronized to what the ledger actually holds.
    if (existing.finalized_at) return { operation: existing, reattached: true };
    if (existing.status === "running" && !(await findByKey(base44, workspace_id, `reserve:${idempotency_key}`))) {
      const cat = catalog || (await loadCatalog(base44));
      const pol = policy || (await loadCreditPolicy(base44, workspace_id));
      const reservation = await computeReservation(base44, { workspace_id, user_id, project_id, run_id, operation_type, model_id: existing.model_id || model_id, estimate, candidate_model_ids, pol, cat, credit_type });
      return { operation: await holdForOperation(base44, existing, reservation, credit_type), reattached: true };
    }
    return { operation: await syncReservedCredits(base44, existing), reattached: true };
  }

  const cat = catalog || (await loadCatalog(base44));
  const model = getModel(model_id, cat);
  // P-8.4: plan-based model access, enforced server-side BEFORE the operation (and its hold) opens.
  // Fail-closed on a suspended/inactive workspace, a lapsed subscription, an unresolvable plan and
  // a model the plan does not include. Candidates the plan excludes never raise the reservation.
  const access = await resolveModelAccess(base44, { workspace_id });
  access.check(model);
  const planCandidates = Array.isArray(candidate_model_ids)
    ? candidate_model_ids.filter((id) => { if (!id || id === model_id) return true; try { return access.allows(getModel(id, cat)); } catch { return false; } })
    : candidate_model_ids;
  const pol = policy || (await loadCreditPolicy(base44, workspace_id));
  const reservation = await computeReservation(base44, { workspace_id, user_id, project_id, run_id, operation_type, model_id, estimate, candidate_model_ids: planCandidates, pol, cat, credit_type });
  const check = await checkBudget(base44, { workspace_id, user_id, project_id, run_id, credits: reservation }, credit_type);
  assertBudget(check, { credits: reservation });

  // The row claims NO hold until the ledger actually holds one: credits_reserved starts at 0 and
  // is only ever set from the ledger after a successful reservation.
  const created = await reconcileDuplicateOperation(base44, await base44.entities.AIOperation.create({
    workspace_id, project_id, run_id, user_id, operation_type, credit_type,
    provider: model.provider, gateway_provider: gateway_provider || model.gateway_provider, model_id,
    streaming, status: "running", usage_source: "estimated",
    pricing_version: null, currency: "USD", credit_policy_version: pol.policy_version,
    credits_reserved: 0, idempotency_key, routing: routing || {}, started_at: nowIso(),
  }));
  const operation = await holdForOperation(base44, created, reservation, credit_type);

  // Plan usage limits re-checked now that this operation (and its real hold) is visible to
  // concurrent openers. A refused operation hands its hold straight back.
  try {
    await enforcePlanUsageAfterCreate(base44, operation);
  } catch (e) {
    await releaseLiveReservation(base44, operation, "Reservation released: refused by plan limit");
    throw e;
  }
  return { operation, reattached: false, reservation, policy: pol, catalog: cat };
}

// Re-projects the ledger's live hold for `op` onto op.credits_reserved (writes only on drift).
async function syncReservedCredits(base44, op) {
  const held = await liveReservation(base44, op.workspace_id, op.id);
  if ((Number(op.credits_reserved) || 0) === held) return op;
  return base44.entities.AIOperation.update(op.id, { credits_reserved: held });
}

// Releases exactly what the ledger still holds for `op` (reservations − releases), once, under
// the operation's single release key. Returns the released amount.
async function releaseLiveReservation(base44, op, reason = "Reservation released at settlement") {
  const held = await liveReservation(base44, op.workspace_id, op.id);
  if (held > 0) {
    await releaseReservation(base44, {
      workspace_id: op.workspace_id, project_id: op.project_id, operation_id: op.id,
      credits: held, idempotency_key: `release:${op.idempotency_key}`, reason,
    }, creditTypeOf(op.credit_type));
  }
  return held;
}

// The ONE release key for a late extension hold, derived from that extension's own ledger key.
// Shared by extendReservation and the finalizer's late pass, so they collide instead of both releasing.
const lateReleaseKey = (extensionKey) => `release:late:${extensionKey}`;

// Post-finalization cleanup. Settlement releases (and the legacy shared late key) cover the op's
// reservations in creation order; whatever they do not cover is late. Each late EXTENSION is released
// under its own lateReleaseKey; any late non-extension remainder under the shared `release:late:<opKey>`.
// With `onlyExtensionKey`, only that extension is released (extendReservation's own path).
// Amounts come from the ledger entries, never a racing live-hold read, so every path agrees.
async function releaseLateReservation(base44, op, onlyExtensionKey = null) {
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const extPrefix = `extend:${op.idempotency_key}:`;
  const rows = (await base44.entities.CreditLedgerEntry.filter({ workspace_id: op.workspace_id, operation_id: op.id }, "created_date", 500))
    .filter((e) => !e.voided && (e.event_type === "reservation" || e.event_type === "reservation_release"));
  const reservations = rows.filter((e) => e.event_type === "reservation")
    .sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)));
  const extReleaseKeys = new Set(reservations.filter((e) => String(e.idempotency_key || "").startsWith(extPrefix)).map((e) => lateReleaseKey(e.idempotency_key)));
  let covering = rows.filter((e) => e.event_type === "reservation_release" && !extReleaseKeys.has(e.idempotency_key))
    .reduce((n, e) => n + Math.abs(Number(e.reserved_delta) || 0), 0);
  const release = (credits, idempotency_key) => releaseReservation(base44, {
    workspace_id: op.workspace_id, project_id: op.project_id, operation_id: op.id,
    credits, idempotency_key, reason: "Late extension released after settlement",
  }, creditTypeOf(op.credit_type));

  let released = 0, remainder = 0;
  for (const e of reservations) {
    const amt = Number(e.reserved_delta) || 0;
    if (covering + 1e-6 >= amt) { covering = r6(covering - amt); continue; }
    const late = r6(amt - covering);
    covering = 0;
    if (!String(e.idempotency_key || "").startsWith(extPrefix)) { remainder += late; continue; }
    if (onlyExtensionKey && e.idempotency_key !== onlyExtensionKey) continue;
    await release(late, lateReleaseKey(e.idempotency_key));   // replay of the same key moves nothing
    released += late;
  }
  if (!onlyExtensionKey && r6(remainder) > 0) {
    await release(r6(remainder), `release:late:${op.idempotency_key}`);
    released += remainder;
  }
  return r6(released);
}

// Places `reservation` on the ledger for `op`, then records exactly what the ledger holds. A
// failed reserve hands back anything it did leave held and ends the operation failed with
// credits_reserved 0 — so no operation can claim, or strand, a hold that does not match the ledger.
async function holdForOperation(base44, op, reservation, credit_type) {
  if (reservation > 0) {
    try {
      await reserve(base44, {
        workspace_id: op.workspace_id, user_id: op.user_id, project_id: op.project_id, operation_id: op.id, credits: reservation,
        idempotency_key: `reserve:${op.idempotency_key}`, reason: `Reserved for ${op.operation_type} on ${op.model_id}`,
      }, credit_type);
    } catch (e) {
      await releaseLiveReservation(base44, op, "Reservation released: reserve failed").catch(() => {});
      await base44.entities.AIOperation.update(op.id, {
        status: "failed", credits_reserved: 0, finalized_at: nowIso(), error: `Reservation failed: ${String(e?.message || e).slice(0, 400)}`,
      }).catch(() => {});
      throw e;
    }
  }
  return syncReservedCredits(base44, op);
}

// Worst-case hold for an operation. Pricing is unchanged; this is the existing sizing, extracted
// so an interrupted begin can be completed with the same amount rules.
async function computeReservation(base44, { workspace_id, user_id, project_id, run_id, operation_type, model_id, estimate = {}, candidate_model_ids = null, pol, cat, credit_type }) {
  const model = getModel(model_id, cat);
  // Worst-case charge, so concurrent operations cannot all pass a check that only one of them
  // could actually afford.
  const max = estimateMaxCharge({
    model_id,
    max_input_tokens: estimate.max_input_tokens || 0,
    max_output_tokens: estimate.max_output_tokens || model.max_output_tokens || 0,
    // F-3 (P-3 / G-R5): a reasoning model's hold includes a reasoning allowance, so the up-front
    // reservation covers the reasoning tokens the per-call guard prices for every call — the same
    // 12k allowance the run pipeline's GUARD_ESTIMATE uses.
    max_reasoning_tokens: model.supports_reasoning ? (estimate.max_reasoning_tokens ?? 12000) : 0,
    operation_type, policy: pol, catalog: cat,
  });
  let reservation = Math.max(0, max.credits);
  // Optional: every model this operation may actually execute (primary + fallbacks + switches).
  // The hold is the largest worst case among them; the operation's model_id is unchanged.
  if (Array.isArray(candidate_model_ids)) {
    for (const id of candidate_model_ids) {
      if (!id || id === model_id) continue;
      let cm;
      try { cm = getModel(id, cat); } catch { continue; }   // unknown/unpriced ids never execute
      const c = estimateMaxCharge({
        model_id: id,
        max_input_tokens: estimate.max_input_tokens || 0,
        max_output_tokens: estimate.max_output_tokens || cm.max_output_tokens || 0,
        max_reasoning_tokens: cm.supports_reasoning ? (estimate.max_reasoning_tokens ?? 12000) : 0,
        operation_type, policy: pol, catalog: cat,
      });
      reservation = Math.max(reservation, c.credits);
    }
    // Admission: the candidate-raised hold is capped at what this scope may still spend (balance,
    // budgets, plan per-run/monthly allowance) — but never below the primary model's own worst
    // case, so an operation that cannot afford even its primary call is still refused as before.
    if (reservation > max.credits) {
      const spendable = await spendableCredits(base44, { workspace_id, user_id, project_id, run_id }, credit_type).catch(() => null);
      if (spendable != null) reservation = Math.max(Math.max(0, max.credits), Math.min(reservation, spendable));
    }
  }
  return reservation;
}

/**
 * Read-only runtime budget guard for multi-call operations. Prices the usage accumulated so far
 * (existing per-model pricing) plus the next call's worst case on `next_model_id`, and compares it
 * with what this operation can still cover: its own open hold + what the scope may still spend.
 * Writes nothing — no ledger entry, no reservation. Fails open when there is no open operation or
 * the spendable amount cannot be derived.
 */
// Guard-only allowance per attached image (the same estimate the budget-aware chain filter uses).
// Never used by reservation or settlement pricing.
export const GUARD_IMAGE_INPUT_TOKENS = WORST_CASE_IMAGE_INPUT_TOKENS;

// Guard-only worst case of ONE call on one model — the SAME estimator the chain filter uses, so a
// chain the filter admitted is judged identically here. Unknown/unpriced ids never execute.
const guardCallCredits = (model_id, estimate, operation_type, pol, cat) =>
  worstCaseCallCredits(model_id, estimate, { operation_type, policy: pol, catalog: cat }) ?? 0;

export async function checkRunBudget(base44, {
  workspace_id, user_id = null, project_id = null, run_id = null, idempotency_key,
  operation_type = "ai_run", usage_by_model = null, usage_totals = {}, next_model_id = null, estimate = {}, creditType = "message",
  // The ordered execution chain the gateway may run for the next call (executionChainIds()); the
  // next call is priced at the most expensive of them. `next_model_id` alone is a one-model chain.
  next_model_ids = null,
  // Worst case of calls already admitted and still running (parallel file generation), so
  // concurrent calls cannot each pass against the same headroom.
  in_flight_credits = 0,
  // Optional: the catalog the caller's chain filter used, so the next-call estimate is priced from
  // the SAME source. Consumed-usage pricing is unchanged.
  catalog = null,
}) {
  const op = await findOperation(base44, { workspace_id, idempotency_key });
  if (!op || op.finalized_at) return { ok: true, consumed: 0, next: 0, capacity: null };
  const spendable = await spendableCredits(base44, { workspace_id, user_id, project_id, run_id }, creditTypeOf(creditType)).catch(() => null);
  if (spendable == null) return { ok: true, consumed: 0, next: 0, capacity: null };
  const cat = await loadCatalog(base44);
  const pol = await loadCreditPolicy(base44, workspace_id);
  // Consumed usage comes from the PERSISTED operation (every recorded call, from every worker and
  // attempt); the caller's in-memory usage only fills what the operation has not recorded.
  const persisted = reconciledUsage(op, usage_totals, usage_by_model);
  const consumed = priceUsageByModel({ usage_by_model: reconcileUsageByModel(persisted.usage_by_model || {}, persisted.totals, op.model_id), operation_type, policy: pol, catalog: cat }).credits;
  const chain = (Array.isArray(next_model_ids) && next_model_ids.length ? next_model_ids : [next_model_id]).filter(Boolean);
  const next = chain.reduce((mx, id) => Math.max(mx, guardCallCredits(id, estimate, operation_type, pol, catalog || cat)), 0);
  const inFlight = Math.max(0, Number(in_flight_credits) || 0);
  const reserved = Number(op.credits_reserved) || 0;
  const capacity = reserved + spendable;
  return { ok: consumed + inFlight + next <= capacity, consumed, in_flight: inFlight, next, capacity, reserved, operation_id: op.id };
}

/**
 * Extends an open operation's hold by `credits` under a deterministic `reservation_key`, through
 * the existing ledger.reserve(). Idempotent: a replay of the same key finds the existing entry and
 * moves nothing. Refuses finalized operations. credits_reserved is then re-projected from the
 * ledger's live hold, never incremented locally.
 */
export async function extendReservation(base44, { operation_id, credits, reservation_key }) {
  if (!operation_id || !reservation_key) throw new Error("extendReservation: operation_id and reservation_key are required");
  const op = await base44.entities.AIOperation.get(operation_id);
  if (!op) throw new Error("extendReservation: operation not found");
  const finalizedError = () => Object.assign(new Error(`Operation ${op.id} is finalized; its reservation cannot be extended`), { code: "OPERATION_FINALIZED" });
  if (op.finalized_at || op.status !== "running") throw finalizedError();
  const amount = Math.round((Number(credits) || 0) * 1e6) / 1e6;
  const key = `extend:${op.idempotency_key}:${reservation_key}`;
  // Checked before reserve(), whose availability pre-check would otherwise refuse a pure replay.
  if (amount > 0 && !(await findByKey(base44, op.workspace_id, key))) {
    await reserve(base44, {
      workspace_id: op.workspace_id, user_id: op.user_id, project_id: op.project_id, operation_id: op.id,
      credits: amount, idempotency_key: key, reason: `Reservation extended for ${op.operation_type} (${reservation_key})`,
    }, creditTypeOf(op.credit_type));
    // Settlement raced this extension. Finalized → hand THIS extension's late hold back under its own
    // late key (the same key the finalizer's late pass uses for it). Frozen but not yet finalized →
    // the finalizer's post-finalization pass releases it, so this worker neither releases nor reports success.
    const after = await base44.entities.AIOperation.get(op.id);
    if (after?.finalized_at) {
      await releaseLateReservation(base44, op, key);
      throw finalizedError();
    }
    if (!after || after.status !== "running") throw finalizedError();
  }
  return syncReservedCredits(base44, op);
}

/**
 * checkRunBudget, plus a reservation extension when the call fits the operation's capacity but not
 * its current hold: the shortfall is moved onto the hold (key `${reservation_key}:to:${target}`,
 * so a replay is a no-op) and the guard is re-checked. Continues only if the re-check passes.
 */
export async function ensureRunBudget(base44, params, reservation_key) {
  const g = await checkRunBudget(base44, params);
  if (!g.ok || g.capacity == null || !g.operation_id) return g;
  const needed = g.consumed + (g.in_flight || 0) + g.next;
  if (needed <= g.reserved) return g;
  const target = Math.ceil(needed * 100) / 100;
  try {
    await extendReservation(base44, { operation_id: g.operation_id, credits: target - g.reserved, reservation_key: `${reservation_key}:to:${target}` });
  } catch (e) {
    if (e instanceof InsufficientCredits || e?.code === "OPERATION_FINALIZED") return { ...g, ok: false, extension_error: e.message };
    throw e;
  }
  return checkRunBudget(base44, params);
}

// Per-call durable usage. Every successful model call of a multi-call operation (Builder run) is
// added to the operation row as soon as the model returns, so an attempt that later fails, retries,
// loses its lease or crashes can never lose the usage it already incurred.
//
// ATOMIC across workers: ONE server-side $inc update — no read-modify-write — so concurrent calls
// from any number of workers all land. The per-model breakdown is incremented in place under the
// model's key, which is exactly mergeUsageByModel's additive semantics. The filter only matches a
// still-running operation, so a finalized operation is never modified. Never charges.
const num = (v) => Number(v) || 0;
const USAGE_FIELDS = Object.keys(ZERO_MODEL_USAGE);
// Field-path-safe model key ('.' and a leading '$' cannot appear in an update path); decoded on read.
const encodeModelKey = (id) => String(id || "unknown").replace(/\./g, "\uFF0E").replace(/^\$/, "\uFF04");
const decodeModelKey = (k) => String(k).replace(/\uFF0E/g, ".").replace(/^\uFF04/, "$");

/** The operation's persisted per-model breakdown, with model keys decoded (merged if two keys collide). */
export function persistedUsageByModel(op) {
  const out = {};
  for (const [k, u] of Object.entries(op?.usage_by_model || {})) Object.assign(out, mergeUsageByModel(out, { [decodeModelKey(k)]: u }));
  return out;
}

/**
 * Adds ONE model call's canonical usage ({ model_id, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens }) to the operation.
 * Returns { ok: true } when the increment landed, or { ok: false, code: "OPERATION_NOT_RUNNING" } (logged)
 * when no running operation matched — e.g. it is already settling or finalized — so a lost increment is never silent.
 */
export async function accumulateCallUsage(base44, operation_id, canonicalUsage) {
  const u = canonicalUsage || {};
  const key = encodeModelKey(u.model_id);
  const inc = { total_tokens: 0 };
  for (const f of USAGE_FIELDS) {
    const d = num(u[f]);
    inc[f] = d;
    inc[`usage_by_model.${key}.${f}`] = d;
    inc.total_tokens += d;
  }
  const res = await base44.entities.AIOperation.updateMany({ id: operation_id, status: "running" }, { $inc: inc });
  const updated = Number(res?.updated) || 0;
  if (updated < 1) {
    console.error(`accumulateCallUsage: no running operation ${operation_id} matched; usage for model ${u.model_id || "unknown"} was NOT persisted (${JSON.stringify(inc)})`);
    return { ok: false, code: "OPERATION_NOT_RUNNING", operation_id, updated };
  }
  return { ok: true, operation_id, updated };
}

// Settlement freeze. Moves a still-running operation out of "running" BEFORE settlement reads its
// usage, so accumulateCallUsage (which only matches status "running") can no longer add to it, then
// re-reads it. Everything settlement prices and writes therefore derives from the latest persisted
// usage, and no increment can land between that read and the final write. "reserved" marks an
// operation that is settling (hold still on the ledger, not yet finalized); the final write sets the
// terminal status. Idempotent: a non-running or finalized operation is only re-read.
async function freezeForSettlement(base44, op) {
  if (op.status === "running" && !op.finalized_at) {
    await base44.entities.AIOperation.updateMany({ id: op.id, status: "running" }, { $set: { status: "reserved" } });
  }
  return base44.entities.AIOperation.get(op.id);
}

// Reconciles an operation's PERSISTED usage (source of truth) with a caller's in-memory usage. The
// in-memory side only fills what the operation never recorded (operations opened before per-call
// tracking). Both are subsets of the calls that really ran, so the per-field / per-model maximum
// never double counts. `totals` is the reconciled total, `incoming` is the delta over the
// operation's own totals (what finalizeOperation adds), `usage_by_model` the reconciled breakdown.
function reconciledUsage(op, memTotals: any = {}, memByModel = null) {
  const opByModel = persistedUsageByModel(op);
  const ids = new Set([...Object.keys(opByModel), ...Object.keys(memByModel || {})]);
  const byModel = {};
  for (const id of ids) {
    byModel[id] = {};
    for (const f of USAGE_FIELDS) byModel[id][f] = Math.max(num(opByModel[id]?.[f]), num(memByModel?.[id]?.[f]));
  }
  const totals = {}, incoming = {};
  for (const f of USAGE_FIELDS) {
    const attributed = Object.values(byModel).reduce((n: number, m: any) => n + num(m[f]), 0) as number;
    totals[f] = Math.max(num(op?.[f]), num(memTotals?.[f]), attributed);
    incoming[f] = totals[f] - num(op?.[f]);
  }
  return { totals, incoming, usage_by_model: ids.size ? byModel : null };
}

// Streaming accumulation. Persists real usage as it arrives WITHOUT charging, so a client that
// disappears mid-stream leaves a server-side record that can still be finalized exactly once.
export async function accumulateUsage(base44, operation_id, rawUsage, provider = null) {
  const op = await base44.entities.AIOperation.get(operation_id);
  if (op.finalized_at) return { operation: op, ignored: true };
  const u = normalizeUsage(provider || op.provider, rawUsage);
  const patch = {
    input_tokens: (op.input_tokens || 0) + u.input_tokens,
    cached_input_tokens: (op.cached_input_tokens || 0) + u.cached_input_tokens,
    output_tokens: (op.output_tokens || 0) + u.output_tokens,
    reasoning_tokens: (op.reasoning_tokens || 0) + u.reasoning_tokens,
  };
  patch.total_tokens = patch.input_tokens + patch.cached_input_tokens + patch.output_tokens + patch.reasoning_tokens;
  if (u.usage_source === "provider") patch.usage_source = "provider";
  return { operation: await base44.entities.AIOperation.update(operation_id, patch), ignored: false };
}

/**
 * Settles an operation exactly once.
 *
 * success → real usage priced against the frozen pricing version, charged to the ledger, and
 *           the reservation released.
 * failure → reservation released, nothing charged.
 */
export async function finalizeOperation(base44, {
  operation_id = null, workspace_id = null, idempotency_key = null,
  usage: rawUsage = null, status = "completed", error = null, duration_ms = null, routing = null,
  policy = null, catalog = null, at = null, usage_source: usageSourceOverride = null,
  // true when `usage` is ALREADY canonical (settleUsage: counts accumulated from gateway results
  // that were normalized per call). Re-normalizing them under the upstream provider's wire shape
  // would silently drop cached/reasoning counts, so they are read by their canonical names only.
  canonical = false,
  // Optional per-model breakdown, STORED on the operation for attribution. Never read by pricing.
  usage_by_model = null,
  // true (settleUsage): `usage` / `usage_by_model` are the caller's in-memory TOTALS, reconciled here
  // against the operation's latest persisted usage (read after the settlement freeze) instead of
  // being added as a delta computed from an earlier read.
  reconcile_persisted = false,
  // P-16C1: caller-supplied FIXED credit charge (the documented Discuss rate). Overrides the
  // token-derived credits only — provider cost, usage and pricing metadata stay recorded, and
  // every idempotency / duplicate-settlement guard is untouched.
  fixed_credits = null,
}) {
  const found = await findOperation(base44, { operation_id, workspace_id, idempotency_key });
  if (!found) throw new Error("finalizeOperation: operation not found");
  // Finalize-exactly-once. A duplicate completion (double stream end, retried worker, replayed
  // request) returns the settled operation and moves no credits.
  if (found.finalized_at) return { operation: found, duplicate: true, credits_charged: found.credits_charged || 0 };
  // Freeze, then work only from the latest persisted operation.
  const op = await freezeForSettlement(base44, found);
  if (op.finalized_at) return { operation: op, duplicate: true, credits_charged: op.credits_charged || 0 };

  // Releases what the LEDGER holds for this operation (reservations − releases), never the
  // possibly-stale op.credits_reserved. Same single release key, so a replay moves nothing.
  const release = () => releaseLiveReservation(base44, op);

  if (status !== "completed") {
    await release();
    // Concurrent-settlement guard: a racing completed settler may have already landed the ledger
    // charge under `charge:<opKey>` (its own final write completes the operation, or the
    // abandoned-operation sweep does if that worker died). The ledger entry is the truth, so this
    // failure write must never zero a charge that exists — the losing path is a safe no-op.
    if (await findByKey(base44, op.workspace_id, `charge:${op.idempotency_key}`)) {
      const current = await base44.entities.AIOperation.get(op.id);
      return { operation: current, duplicate: true, credits_charged: current?.credits_charged || 0 };
    }
    // Conditional on the operation still being unfinalized: a concurrent finalizer that already
    // settled it (e.g. completed with a ledger charge) is never overwritten by this failure.
    const res = await base44.entities.AIOperation.updateMany({
      id: op.id,
      $or: [
        { finalized_at: { $exists: false } },
        { finalized_at: null },
      ],
    }, { $set: {
      status: status === "cancelled" ? "cancelled" : "failed",
      error: error ? String(error).slice(0, 500) : null,
      duration_ms: duration_ms ?? (Date.parse(op.started_at) ? Date.now() - Date.parse(op.started_at) : 0),
      credits_charged: 0, credits_reserved: 0, finalized_at: nowIso(), ...(routing ? { routing } : {}),
      // Merged with the latest persisted breakdown, so an older snapshot never replaces newer increments.
      ...(usage_by_model ? { usage_by_model: reconciledUsage(op, {}, usage_by_model).usage_by_model } : {}),
    } });
    const failed = await base44.entities.AIOperation.get(op.id);
    if ((Number(res?.updated) || 0) < 1) return { operation: failed, duplicate: true, credits_charged: failed?.credits_charged || 0 };
    await releaseLateReservation(base44, op);
    return { operation: failed, duplicate: false, credits_charged: 0 };
  }

  // Reconciled against the latest persisted usage (settleUsage), or — for every other caller —
  // the provider's delta for this call merged with anything already accumulated during streaming.
  // Character counts are never used here.
  const rec = reconcile_persisted ? reconciledUsage(op, rawUsage || {}, usage_by_model) : null;
  const byModel = rec ? rec.usage_by_model : usage_by_model;
  const incoming = !rec && rawUsage ? normalizeUsage(canonical ? "canonical" : op.provider, rawUsage) : null;
  const usage: any = rec ? { ...rec.totals } : incoming && incoming.usage_source === "provider"
    ? {
        input_tokens: (op.input_tokens || 0) + incoming.input_tokens,
        cached_input_tokens: (op.cached_input_tokens || 0) + incoming.cached_input_tokens,
        output_tokens: (op.output_tokens || 0) + incoming.output_tokens,
        reasoning_tokens: (op.reasoning_tokens || 0) + incoming.reasoning_tokens,
      }
    : {
        input_tokens: (op.input_tokens || 0) + (incoming?.input_tokens || 0),
        cached_input_tokens: (op.cached_input_tokens || 0) + (incoming?.cached_input_tokens || 0),
        output_tokens: (op.output_tokens || 0) + (incoming?.output_tokens || 0),
        reasoning_tokens: (op.reasoning_tokens || 0) + (incoming?.reasoning_tokens || 0),
      };
  usage.total_tokens = usage.input_tokens + usage.cached_input_tokens + usage.output_tokens + usage.reasoning_tokens;
  // An explicit override exists for gateways that report no usage: locally derived counts stay
  // labelled `estimated` even though they are numerically present.
  const usage_source = usageSourceOverride
    ? usageSourceOverride
    : incoming?.usage_source === "provider" || op.usage_source === "provider" ? "provider" : "estimated";

  const cat = catalog || (await loadCatalog(base44));
  const pol = policy || (await loadCreditPolicy(base44, op.workspace_id));
  // Fail CLOSED on charging, but never strand the hold: a pricing failure (the operation's model
  // is missing or no longer in the catalog, so no price can be derived) must not leave the
  // reservation active. No charge is guessed — the ledger stays the source of truth — and the
  // operation finalizes through the SAME terminal shape a failure settlement leaves: hold
  // released (live + late extensions), terminal status, the reason recorded. The sweep and every
  // settle caller can therefore rely on settlement always reaching a finalized state.
  let priced;
  try {
    // With a per-model breakdown, each model's tokens are priced at that model's rates; without one,
    // the whole operation is priced under its own model exactly as before.
    priced = byModel && Object.keys(byModel).length
      ? priceUsageByModel({ usage_by_model: reconcileUsageByModel(byModel, usage, op.model_id), operation_type: op.operation_type, policy: pol, at, catalog: cat })
      : priceOperation({ model_id: op.model_id, usage, operation_type: op.operation_type, policy: pol, at, catalog: cat });
  } catch (e) {
    const message = `Settlement pricing failed: ${String(e?.message || e).slice(0, 400)}`;
    await release();
    const wres = await base44.entities.AIOperation.updateMany({
      id: op.id,
      $or: [
        { finalized_at: { $exists: false } },
        { finalized_at: null },
      ],
    }, { $set: {
      status: "failed", error: message,
      duration_ms: duration_ms ?? (Date.parse(op.started_at) ? Date.now() - Date.parse(op.started_at) : 0),
      credits_charged: 0, credits_reserved: 0, finalized_at: nowIso(),
      ...(byModel && Object.keys(byModel).length ? { usage_by_model: reconciledUsage(op, {}, byModel).usage_by_model } : {}),
    } });
    await releaseLateReservation(base44, op);
    const failed = await base44.entities.AIOperation.get(op.id);
    // A racing finalizer settled this operation first — its terminal state stands; this path moved
    // nothing on the ledger (no charge, and the hold releases are idempotent under their keys).
    if ((Number(wres?.updated) || 0) < 1) return { operation: failed, duplicate: true, credits_charged: failed?.credits_charged || 0 };
    return { operation: failed, duplicate: false, credits_charged: 0, pricing_failed: true };
  }

  if (fixed_credits != null) priced = { ...priced, credits: Math.max(0, Number(fixed_credits)) };

  // The provider already did the work, so the charge lands even if it exceeds the remaining
  // balance (budget control is what prevents reaching that state). It can never be skipped.
  // The charge entry the LEDGER kept is the source of truth: a concurrent finalizer that lost the
  // charge:<opKey> race projects the winner's priced usage instead of its own local calculation.
  let charged = {
    credits: priced.credits, pricing_version: priced.pricing_version, provider_cost: priced.provider_cost,
    currency: priced.currency, credit_policy_version: priced.policy_version, usage, usage_source, usage_by_model: byModel || null,
  };
  if (priced.credits > 0) {
    const res = await recordEvent(base44, {
      workspace_id: op.workspace_id, user_id: op.user_id, project_id: op.project_id, operation_id: op.id,
      event_type: "ai_charge", amount: -priced.credits, credit_type: creditTypeOf(op.credit_type),
      idempotency_key: `charge:${op.idempotency_key}`,
      reason: `${op.operation_type} · ${op.model_id}`,
      metadata: {
        model_id: op.model_id, pricing_version: priced.pricing_version, total_tokens: usage.total_tokens,
        provider_cost: priced.provider_cost, currency: priced.currency, credit_policy_version: priced.policy_version,
        usage_source, usage: { ...usage }, usage_by_model: byModel || null,
      },
    }, { allowNegative: true });
    charged = chargeFromEntry(res.entry, charged);
  } else {
    // Concurrent-settlement guard: this settler prices 0 locally, but a racing settler may have
    // already charged under the shared key. The ledger entry is the truth — project it so this
    // final write never understates the ledger.
    const raced = await findByKey(base44, op.workspace_id, `charge:${op.idempotency_key}`);
    if (raced) charged = chargeFromEntry(raced, charged);
  }
  await release();

  // Not conditional on finalized_at: values come from the ledger's charge entry, so this write may
  // replace a racer's failed/0 result. It never overwrites a refunded operation.
  const res = await base44.entities.AIOperation.updateMany({ id: op.id, status: { $ne: "refunded" } }, { $set: {
    status: "completed", ...charged.usage, usage_source: charged.usage_source,
    pricing_version: charged.pricing_version, provider_cost: charged.provider_cost, currency: charged.currency,
    credit_policy_version: charged.credit_policy_version, credits_charged: charged.credits, credits_reserved: 0,
    duration_ms: duration_ms ?? (Date.parse(op.started_at) ? Date.now() - Date.parse(op.started_at) : 0),
    finalized_at: nowIso(), ...(routing ? { routing } : {}),
    ...(charged.usage_by_model ? { usage_by_model: charged.usage_by_model } : {}),
  } });
  const finalized = await base44.entities.AIOperation.get(op.id);
  if ((Number(res?.updated) || 0) < 1) return { operation: finalized, duplicate: true, credits_charged: finalized?.credits_charged || 0 };
  await releaseLateReservation(base44, op);
  return { operation: finalized, duplicate: false, credits_charged: charged.credits, provider_cost: charged.provider_cost };
}

// Projects the persisted charge entry onto the settlement values. The credits always come from the
// entry's own amount; a legacy entry without priced metadata keeps the local value for that field.
function chargeFromEntry(entry, local) {
  if (!entry) return local;
  const m = entry.metadata || {};
  const pick = (k) => (m[k] !== undefined && m[k] !== null ? m[k] : local[k]);
  return {
    credits: Math.round(Math.abs(Number(entry.amount) || 0) * 1e6) / 1e6,
    pricing_version: pick("pricing_version"), provider_cost: pick("provider_cost"), currency: pick("currency"),
    credit_policy_version: pick("credit_policy_version"), usage_source: pick("usage_source"),
    usage: m.usage && typeof m.usage === "object" ? m.usage : local.usage,
    usage_by_model: m.usage !== undefined ? (m.usage_by_model ?? null) : local.usage_by_model,
  };
}

// Refund of a settled operation. Idempotent: a replayed refund returns the original movement.
export async function refundOperation(base44, { operation_id, reason = "Operation refunded", credits = null }) {
  let op = await base44.entities.AIOperation.get(operation_id);
  // Settlement owns an unfinalized operation (running/reserved): its final write must land first,
  // so nothing is refunded until finalized_at exists.
  if (!op.finalized_at) return { operation: op, refunded: 0, duplicate: false };
  // Refundable amount comes from the LEDGER (live charge − live refund), never the possibly-stale
  // op.credits_charged. No live charge → nothing is refundable.
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const chargeEntry = await findByKey(base44, op.workspace_id, `charge:${op.idempotency_key}`);
  const refundEntry = await findByKey(base44, op.workspace_id, `refund:${op.idempotency_key}`);
  const charged = chargeEntry ? r6(Math.abs(Number(chargeEntry.amount) || 0)) : 0;
  const already = refundEntry ? r6(Math.abs(Number(refundEntry.amount) || 0)) : 0;
  const refundable = r6(charged - already);
  // The ledger refund is the source of truth: repair a projection an earlier refund failed to write.
  if (refundEntry && already > 0 && r6(Number(op.credits_refunded) || 0) !== already) {
    op = await base44.entities.AIOperation.update(op.id, { credits_refunded: already, status: "refunded" });
  }
  const amount = credits == null ? refundable : Math.min(Math.abs(credits), refundable);
  if (amount <= 0) return { operation: op, refunded: 0, duplicate: already > 0 };
  const res = await recordEvent(base44, {
    workspace_id: op.workspace_id, user_id: op.user_id, project_id: op.project_id, operation_id: op.id,
    event_type: "refund", amount, credit_type: creditTypeOf(op.credit_type), idempotency_key: `refund:${op.idempotency_key}`, reason,
  });
  const operation = res.duplicate ? op : await base44.entities.AIOperation.update(op.id, { credits_refunded: already + amount, status: "refunded" });
  return { operation, refunded: res.duplicate ? 0 : amount, duplicate: res.duplicate };
}

// A "running" (executing) or "reserved" (mid-settlement) op is still owned while its run is live;
// only a dead owner's op is abandoned. Read-only. Ownership is confirmed by EITHER marker the run
// already keeps: a fresh heartbeat OR a still-valid phase lease (P-7 — the lease is the worker's
// own claim, renewed per phase; the reaper only reclaims a run after it lapses, so a stale
// heartbeat alone must not let the sweep settle an op a live worker still holds mid-phase). Both
// markers stale is exactly the abandonment rule the reaper itself applies.
async function settlementInFlight(base44, op, cutoff) {
  if (!op.run_id) return false;
  const entity = op.operation_type === "agent" ? base44.entities.AgentRun : op.operation_type === "ai_run" ? base44.entities.AIRun : null;
  const run = entity ? await entity.get(op.run_id).catch(() => null) : null;
  if (!run || ["COMPLETED", "FAILED", "CANCELLED", "STALE"].includes(run.status)) return false;
  const leaseUntil = Date.parse(run.phase_lease_expires_at || run.lease_expires_at || "");
  if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) return true;
  return Date.parse(run.heartbeat_at || "") > cutoff;
}

// Stale-run settlement stamping. After the sweep settles a Builder operation the reaper left
// behind, the owning AIRun gets the same state runPipeline.settle leaves it in: one usage-analytics
// event and the display fields (usage_event_id, operation_id, credits_charged) copied from the
// settlement. Guarded by the run's own usage_event_id, so a re-run of the sweep never creates a
// second event. Cancellation stays exactly as before — a CANCELLED run gets no event, matching
// the runCancel path. Ledger, pricing and reservation behaviour are untouched.
async function stampSettledRunUsage(base44, op, settled) {
  const run = await base44.entities.AIRun.get(op.run_id).catch(() => null);
  if (!run || run.usage_event_id || run.status === "CANCELLED") return null;
  const u = settled.operation || {};
  const startedMs = Date.parse(run.started_at || run.created_date);
  const duration = (Number(u.duration_ms) || 0) || (Number.isFinite(startedMs) ? Date.now() - startedMs : 0);
  // Same field semantics as runPipeline.settle: the event carries the token counts the schema
  // holds (cached/reasoning stay on the operation, linked via operation_id below).
  // Idempotent stamping: if a concurrent settle/finalize stamped this run first, the helper's
  // conditional claim loses, deletes this candidate and returns the winner's id.
  const stamped = await stampUsageEvent(base44, {
    run_entity: "AIRun", run_id: run.id,
    operation_id: op.id, credits_charged: settled.credits_charged || 0,
    event: {
      workspace_id: op.workspace_id, project_id: run.project_id, run_id: run.id,
      user_id: run.initiated_by_user_id ?? run.created_by_id,
      input_tokens: Number(u.input_tokens) || 0, output_tokens: Number(u.output_tokens) || 0,
      tokens_estimated: u.usage_source !== "provider", tool_calls: Number(run.tool_calls) || 0,
      duration_ms: duration, estimated_cost: settled.provider_cost || 0,
    },
  });
  return { run_id: run.id, usage_event_id: stamped.usage_event_id };
}

// Server-side sweep for operations whose client vanished: usage is already persisted, so they
// settle from the accumulated real usage instead of silently becoming free.
export async function reconcileAbandonedOperations(base44, { workspace_id, older_than_ms = 15 * 60 * 1000 } = {}) {
  // "reserved" = frozen for settlement but never finalized (the settling worker died), so it is swept too.
  const running = await base44.entities.AIOperation.filter({ workspace_id, status: { $in: ["running", "reserved"] } }, "created_date", 200).catch(() => []);
  const cutoff = Date.now() - older_than_ms;
  const out = [];
  for (const op of running) {
    if (op.finalized_at) continue;
    if (Date.parse(op.started_at || op.created_date) > cutoff) continue;
    if (await settlementInFlight(base44, op, cutoff)) continue;
    const hasUsage = (op.total_tokens || 0) > 0 || (op.input_tokens || 0) > 0;
    const res = await finalizeOperation(base44, {
      operation_id: op.id,
      status: hasUsage ? "completed" : "failed",
      error: hasUsage ? null : "Abandoned before any provider usage was recorded",
    });
    // Builder operations: bring the owning run's display fields and the usage-analytics event to
    // the state the normal settlement path leaves them in. Idempotent via the run's usage_event_id.
    let stamped = null;
    if (op.run_id && op.operation_type === "ai_run") {
      stamped = await stampSettledRunUsage(base44, op, res).catch((e) => {
        console.error(`stampSettledRunUsage failed for run ${op.run_id}: ${e?.message || e}`);
        return null;
      });
    }
    out.push({ operation_id: op.id, status: res.operation.status, credits_charged: res.credits_charged, ...(stamped ? { run_id: stamped.run_id, usage_event_id: stamped.usage_event_id } : {}) });
  }
  // Separate pass: holds still live on FINALIZED operations (a late extension/reserve whose worker died
  // before its own late release). Never touches running/reserved operations.
  out.push(...(await releaseFinalizedOrphanHolds(base44, workspace_id, cutoff).catch((e) => {
    console.error(`releaseFinalizedOrphanHolds failed for workspace ${workspace_id}: ${e?.message || e}`);
    return [];
  })));
  return out;
}

// Minimal operation shape for releaseLateReservation when the AIOperation row is gone (retention only
// deletes finalized rows). The op key comes from its own `reserve:<opKey>` or `release:<opKey>` entry;
// without one it cannot be derived exactly, so the operation is skipped rather than guessed.
function orphanOperation(workspace_id, id, entries) {
  const keys = entries.map((e) => String(e.idempotency_key || ""));
  const reserveKey = keys.find((k) => k.startsWith("reserve:"));
  const releaseKey = keys.find((k) => k.startsWith("release:") && !k.startsWith("release:late:"));
  const opKey = reserveKey ? reserveKey.slice("reserve:".length) : releaseKey ? releaseKey.slice("release:".length) : null;
  if (!opKey) return null;
  const first = entries.find((e) => e.event_type === "reservation") || entries[0];
  return { id, workspace_id, project_id: first?.project_id || null, credit_type: first?.credit_type || null, idempotency_key: opKey };
}

// Candidates come from the LEDGER: every live reservation/release entry is grouped by operation, and an
// operation whose net hold is still positive (and whose newest reservation is older than the cutoff) is
// handed to releaseLateReservation. Its deterministic keys make every re-run move nothing.
async function releaseFinalizedOrphanHolds(base44, workspace_id, cutoff) {
  const PAGE = 500;
  const byOp = new Map();
  for (let skip = 0; ; skip += PAGE) {
    const page = await base44.entities.CreditLedgerEntry.filter({ workspace_id, event_type: { $in: ["reservation", "reservation_release"] } }, "created_date", PAGE, skip);
    for (const e of page) {
      if (e.voided || !e.operation_id) continue;
      const g = byOp.get(e.operation_id) || { net: 0, newest: 0, entries: [] };
      g.net += Number(e.reserved_delta) || 0;
      if (e.event_type === "reservation") g.newest = Math.max(g.newest, Date.parse(e.created_date) || 0);
      g.entries.push(e);
      byOp.set(e.operation_id, g);
    }
    if (page.length < PAGE) break;
  }
  const out = [];
  for (const [operation_id, g] of byOp) {
    if (Math.round(g.net * 1e6) / 1e6 <= 0 || g.newest > cutoff) continue;
    try {
      // filter (not get): a missing row is [], a read error throws and skips — never mistaken for "gone".
      const [row] = await base44.entities.AIOperation.filter({ id: operation_id }, "created_date", 1);
      if (row && !row.finalized_at) continue;   // running/reserved: owned by the normal pass above
      const op = row || orphanOperation(workspace_id, operation_id, g.entries);
      if (!op) continue;
      const released = await releaseLateReservation(base44, op);
      if (released > 0) out.push({ operation_id, status: "late_hold_released", credits_released: released });
    } catch (e) {
      console.error(`Finalized orphan hold release failed for operation ${operation_id}: ${e?.message || e}`);
    }
  }
  return out;
}

/**
 * Settles work that has ALREADY been executed and whose usage was accumulated by the caller
 * (the run pipeline and agent loop both work this way: many provider calls across several
 * request windows, one billable operation).
 *
 * Reservation-free by design — the value is already delivered — but still exactly-once,
 * budget-visible and ledger-backed: the run id is the idempotency key, so a duplicated worker
 * or a re-driven phase settles the same operation instead of charging again.
 */
export async function settleUsage(base44, {
  workspace_id, user_id = null, project_id = null, run_id = null, operation_type = "ai_run",
  model = null, usage = {}, idempotency_key, routing = null, status = "completed",
  usage_source = "estimated", duration_ms = null, refundReason = null, policy = null, catalog = null,
  usage_by_model = null,
  fixed_credits = null,
}) {
  if (!idempotency_key) throw new Error("settleUsage: idempotency_key is required");
  const model_id = model?.model_id || model?.id || null;
  // A caller that reserved up front already has an open operation under this key. It is settled
  // even when the caller no longer holds the model (a failure path drops it), so a reservation
  // is never left holding credits.
  // Frozen before its usage is read, so the settlement decision below and the final charge both see
  // the latest persisted usage and no later increment can land.
  const found = await findOperation(base44, { workspace_id, idempotency_key });
  const existing = found ? await freezeForSettlement(base44, found) : null;
  // Nothing open and nothing to price (e.g. a run that failed before a model was chosen) —
  // no operation, no charge.
  if (!existing && !model_id) return { operation: null, credits_charged: 0, duplicate: false };

  const operation = existing || (await reconcileDuplicateOperation(base44, await base44.entities.AIOperation.create({
    workspace_id, project_id, run_id, user_id, operation_type, credit_type: "message",
    provider: model.upstream_provider || model.provider, gateway_provider: model.provider,
    model_id, streaming: false, status: "running", usage_source,
    credit_policy_version: null, credits_reserved: 0, idempotency_key,
    routing: routing || {}, started_at: new Date().toISOString(),
  })));

  // Usage already recorded per call on the operation is authoritative; the caller's totals only add
  // what the operation lacks, so nothing is counted twice and nothing recorded is dropped.
  // finalizeOperation re-does this reconciliation against its own post-freeze read (reconcile_persisted).
  const r = existing ? reconciledUsage(existing, usage, usage_by_model) : null;
  // Settlement policy: work the provider already did is billed whatever the run's outcome. A
  // failed/cancelled run with recorded usage settles that usage exactly like a completed one; only a
  // run with NO usage releases its hold uncharged. Completed runs are unchanged.
  const consumed = USAGE_FIELDS.reduce((n, f) => n + (r ? num(r.totals[f]) : num(usage?.[f])), 0) > 0;
  const effectiveStatus = status !== "completed" && consumed ? "completed" : status;
  const res = await finalizeOperation(base44, {
    operation_id: operation.id, usage, usage_source, status: effectiveStatus, duration_ms, routing, policy, catalog, canonical: true,
    usage_by_model: usage_by_model && Object.keys(usage_by_model).length ? usage_by_model : null,
    reconcile_persisted: true,
    fixed_credits,
  });
  // The charged operation keeps a record of the run's real outcome. A pricing failure keeps its
  // own recorded reason (nothing was charged), so it is not overwritten with this generic note.
  if (effectiveStatus !== status && !res.duplicate && !res.pricing_failed) {
    await base44.entities.AIOperation.update(res.operation.id, { error: `Run ${status}; consumed usage settled` }).catch(() => {});
  }

  // A run the platform itself threw away (lost a concurrency race) must not cost the user.
  if (refundReason && res.credits_charged > 0 && !res.duplicate) {
    await refundOperation(base44, { operation_id: operation.id, reason: refundReason });
  }
  return res;
}

export { InsufficientCredits, spendableCredits, DEFAULT_CREDIT_POLICY };