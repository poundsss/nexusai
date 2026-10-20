// Authoritative credit ledger.
//
// The LEDGER is the balance. Workspace.credits_balance is only a cached projection of it,
// recomputed from the entries after every movement — so a lost update, a duplicated worker or
// a racing request can never leave a balance that disagrees with its history.
//
// Every movement is an immutable event with an idempotency key:
//   * a replayed request/webhook/retry with the same key returns the EXISTING entry,
//   * two concurrent writers that both slip through the pre-check are reconciled after the
//     fact — the earliest entry wins and the loser is voided out of the derivation,
//   * entries are never edited (beyond their derived balance stamps) and never deleted.

const PAGE = 500;

export const SPEND_TYPES = ["ai_charge", "expiration"];
export const CREDIT_TYPES = ["purchase", "promotional", "refund", "adjustment", "admin_adjustment"];

export const VALID_CREDIT_TYPES = ["message", "integration"] as const;
export type CreditType = typeof VALID_CREDIT_TYPES[number];

export function creditTypeOf(value: unknown): CreditType {
  return value === "integration" ? "integration" : "message";
}

export class InsufficientCredits extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.code = "INSUFFICIENT_CREDITS";
    this.status = 402;
    this.detail = detail;
  }
}

async function allEntries(base44, workspace_id) {
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = await base44.entities.CreditLedgerEntry.filter({ workspace_id }, "created_date", PAGE, skip);
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const live = (entries) => entries.filter((e) => !e.voided);

const entryOrder = (a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id));

// P-8.1: a positive entry either carries metadata.expires_at — a CYCLE-BOUND grant whose
// UNUSED remainder stops counting once its billing cycle ends — or it is PERMANENT (a
// purchase, adjustment or refund). A spend always consumes the soonest-expiring credits
// first, and never credits that had already expired when the spend happened, so only the
// unused remainder of a grant ever expires and permanent credits are spent last. Expired
// remainders drop out of this derivation alone: entries are never rewritten, and no balance
// is ever adjusted by a direct write.
const expiryOf = (e) => {
  const t = e?.metadata?.expires_at ? Date.parse(e.metadata.expires_at) : NaN;
  return Number.isFinite(t) ? t : null;
};

function poolTotals(ordered, now) {
  let permanent = 0;
  let reserved = 0;
  const grants = []; // { rem, exp } — expiring grant buckets, consumed soonest-expiry first
  for (const e of ordered) {
    const amount = Number(e.amount) || 0;
    reserved += Number(e.reserved_delta) || 0;
    if (amount === 0) continue;
    if (amount > 0) {
      const exp = expiryOf(e);
      if (exp === null) permanent += amount;
      else grants.push({ rem: amount, exp });
      continue;
    }
    // A spend can only consume credits that were still alive when it happened.
    const spentAt = Date.parse(e.created_date) || 0;
    for (let i = grants.length - 1; i >= 0; i--) if (grants[i].exp <= spentAt) grants.splice(i, 1);
    let need = -amount;
    grants.sort((a, b) => a.exp - b.exp);
    for (let i = 0; i < grants.length && need > 0; ) {
      const take = Math.min(grants[i].rem, need);
      grants[i].rem -= take; need -= take;
      if (grants[i].rem <= 1e-9) grants.splice(i, 1); else i++;
    }
    permanent -= need;
  }
  const unexpired = grants.filter((g) => g.exp > now).reduce((n, g) => n + g.rem, 0);
  return { balance: permanent + unexpired, reserved, unexpired };
}

function sum(entries, creditType?: CreditType, now = Date.now()) {
  const ordered = live(entries).slice().sort(entryOrder);
  const pool = (type) => poolTotals(ordered.filter((e) => creditTypeOf(e.credit_type) === type), now);
  const message = pool("message");
  const integration = pool("integration");
  // Spendable credits exclude what in-flight operations are holding.
  const totals = ({ balance, reserved }) => {
    const bal = Math.round(balance * 1e6) / 1e6;
    const res = Math.max(0, Math.round(reserved * 1e6) / 1e6);
    return { balance: bal, reserved: res, available: Math.round((bal - res) * 1e6) / 1e6 };
  };
  const picked = creditType
    ? pool(creditType)
    : { balance: message.balance + integration.balance, reserved: message.reserved + integration.reserved };
  return {
    ...totals(picked),
    by_type: { message: totals(message), integration: totals(integration) },
  };
}

// Derived directly from the immutable entries — this is the authoritative read. `now` is the
// derivation instant: cycle-bound grants whose cycle has already ended at that instant do not count.
export async function deriveBalance(base44, workspace_id, creditType?: CreditType, now = Date.now()) {
  return sum(await allEntries(base44, workspace_id), creditType, now);
}

export async function syncWorkspaceBalance(base44, workspace_id) {
  const totals = await deriveBalance(base44, workspace_id);
  await base44.entities.Workspace.update(workspace_id, {
    credits_balance: totals.balance,
    reserved_credits: totals.reserved,
    balance_synced_at: new Date().toISOString(),
  });
  return totals;
}

const byKey = (base44, workspace_id, idempotency_key) =>
  base44.entities.CreditLedgerEntry.filter({ workspace_id, idempotency_key }, "created_date", 10);

export async function findByKey(base44, workspace_id, idempotency_key) {
  const hits = await byKey(base44, workspace_id, idempotency_key);
  return hits.find((h) => !h.voided) || null;
}

/**
 * Records one credit movement.
 *
 * @param allowNegative pass true ONLY when the value was already delivered (a provider call
 *   that succeeded must never become free because the balance ran short). Every other spend
 *   fails closed with InsufficientCredits rather than driving the balance below zero.
 */
export async function recordEvent(base44, event, { allowNegative = false } = {}) {
  const { workspace_id, idempotency_key, event_type } = event;
  if (!workspace_id) throw new Error("ledger: workspace_id is required");
  if (!idempotency_key) throw new Error("ledger: idempotency_key is required");
  if (!event_type) throw new Error("ledger: event_type is required");
  const credit_type = creditTypeOf(event.credit_type);

  const existing = await findByKey(base44, workspace_id, idempotency_key);
  if (existing) return { entry: existing, duplicate: true, ...sum(await allEntries(base44, workspace_id)) };

  const entries = await allEntries(base44, workspace_id);
  const before = sum(entries);
  // Sufficiency is judged against this event's own pool only; message and integration never cover each other.
  const pool = sum(entries, credit_type);
  const amount = Math.round((Number(event.amount) || 0) * 1e6) / 1e6;
  const reserved_delta = Math.round((Number(event.reserved_delta) || 0) * 1e6) / 1e6;

  if (!allowNegative) {
    if (amount < 0 && pool.available + amount < 0) {
      throw new InsufficientCredits(`Insufficient credits: ${pool.available} available, ${Math.abs(amount)} required`, { available: pool.available, required: Math.abs(amount) });
    }
    if (reserved_delta > 0 && pool.available - reserved_delta < 0) {
      throw new InsufficientCredits(`Insufficient credits to reserve ${reserved_delta}: ${pool.available} available`, { available: pool.available, required: reserved_delta });
    }
  }

  const created = await base44.entities.CreditLedgerEntry.create({
    workspace_id,
    user_id: event.user_id || null,
    project_id: event.project_id || null,
    operation_id: event.operation_id || null,
    billing_event_id: event.billing_event_id || null,
    event_type,
    credit_type,
    amount,
    reserved_delta,
    balance_before: before.balance,
    balance_after: Math.round((before.balance + amount) * 1e6) / 1e6,
    unit: "credit",
    idempotency_key,
    reason: event.reason || "",
    metadata: event.metadata || {},
  });

  // Duplicate-key race resolution: if a concurrent writer inserted the same logical movement,
  // keep the earliest entry and void the rest so the derived balance counts it exactly once.
  const sameKey = await byKey(base44, workspace_id, idempotency_key);
  if (sameKey.length > 1) {
    const ordered = [...sameKey].sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)));
    const winner = ordered[0];
    for (const loser of ordered.slice(1)) {
      if (!loser.voided) await base44.entities.CreditLedgerEntry.update(loser.id, { voided: true, reason: `${loser.reason || ""} (voided: duplicate of ${winner.id})`.trim() });
    }
    const totals = await syncWorkspaceBalance(base44, workspace_id);
    return { entry: winner.id === created.id ? created : winner, duplicate: winner.id !== created.id, ...totals };
  }

  // Concurrent-overspend backstop. Two writers can both pass the pre-check, so after inserting
  // we re-derive and, if the account is now overdrawn, the NEWEST contending spend backs itself
  // out. The ordering is derived from the entries themselves, so every racing writer reaches the
  // same verdict: exactly one backs off and the balance never settles below zero.
  if (!allowNegative && (amount < 0 || reserved_delta > 0)) {
    const settled = await allEntries(base44, workspace_id);
    if (sum(settled, credit_type).available < 0) {
      const contenders = live(settled)
        .filter((e) => creditTypeOf(e.credit_type) === credit_type)
        .filter((e) => (Number(e.amount) || 0) < 0 || (Number(e.reserved_delta) || 0) > 0)
        .sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)));
      const newest = contenders[contenders.length - 1];
      if (newest && newest.id === created.id) {
        await base44.entities.CreditLedgerEntry.update(created.id, { voided: true, reason: `${created.reason || ""} (voided: insufficient credits under concurrency)`.trim() });
        const totals = await syncWorkspaceBalance(base44, workspace_id);
        const poolAvailable = totals.by_type[credit_type].available;
        throw new InsufficientCredits(`Insufficient credits: ${poolAvailable} available after concurrent spending, ${Math.abs(amount) || reserved_delta} required`, { available: poolAvailable });
      }
    }
  }

  const totals = await syncWorkspaceBalance(base44, workspace_id);
  return { entry: created, duplicate: false, ...totals };
}

// --- reservations -------------------------------------------------------------
// A reservation holds credits without spending them. Concurrent operations therefore compete
// for the same pool up front instead of discovering the shortfall after both already ran.

export const reserve = async (base44, { workspace_id, user_id, project_id, operation_id, credits, idempotency_key, reason }, creditType?: CreditType) => {
  // Pool-scoped pre-check. A replayed key skips it so recordEvent returns the existing entry.
  if (workspace_id && idempotency_key && !(await findByKey(base44, workspace_id, idempotency_key))) {
    const reserved_delta = Math.round((Number(Math.abs(credits)) || 0) * 1e6) / 1e6;
    const pool = await deriveBalance(base44, workspace_id, creditType);
    if (reserved_delta > 0 && pool.available - reserved_delta < 0) {
      throw new InsufficientCredits(`Insufficient credits to reserve ${reserved_delta}: ${pool.available} available`, { available: pool.available, required: reserved_delta });
    }
  }
  return recordEvent(base44, { workspace_id, user_id, project_id, operation_id, event_type: "reservation", amount: 0, reserved_delta: Math.abs(credits), idempotency_key, reason: reason || "Budget reservation", credit_type: creditTypeOf(creditType) });
};

export const releaseReservation = (base44, { workspace_id, project_id, operation_id, credits, idempotency_key, reason }, creditType?: CreditType) =>
  recordEvent(base44, { workspace_id, project_id, operation_id, event_type: "reservation_release", amount: 0, reserved_delta: -Math.abs(credits), idempotency_key, reason: reason || "Reservation released", credit_type: creditTypeOf(creditType) }, { allowNegative: true });

/**
 * The credits the ledger ACTUALLY holds for one operation right now: its live (non-voided)
 * reservation entries minus its live release entries. This is the authoritative hold — the
 * operation's own credits_reserved is only a projection of it.
 */
export async function liveReservation(base44, workspace_id, operation_id) {
  if (!workspace_id || !operation_id) return 0;
  const rows = await base44.entities.CreditLedgerEntry.filter({ workspace_id, operation_id }, "created_date", PAGE);
  const held = live(rows)
    .filter((e) => e.event_type === "reservation" || e.event_type === "reservation_release")
    .reduce((n, e) => n + (Number(e.reserved_delta) || 0), 0);
  return Math.max(0, Math.round(held * 1e6) / 1e6);
}

// --- statements ---------------------------------------------------------------

export async function getStatement(base44, workspace_id, { limit = 50 } = {}) {
  const entries = await base44.entities.CreditLedgerEntry.filter({ workspace_id }, "-created_date", limit);
  const totals = await deriveBalance(base44, workspace_id);
  return {
    ...totals,
    entries: entries.filter((e) => !e.voided).map((e) => ({
      id: e.id, event_type: e.event_type, credit_type: creditTypeOf(e.credit_type), amount: e.amount, reserved_delta: e.reserved_delta || 0, balance_after: e.balance_after,
      reason: e.reason, project_id: e.project_id, operation_id: e.operation_id, created_date: e.created_date,
    })),
  };
}

// Consistency check: the cached projection must equal the derived ledger total.
export async function verifyBalanceIntegrity(base44, workspace_id) {
  const derived = await deriveBalance(base44, workspace_id);
  const ws = await base44.entities.Workspace.get(workspace_id);
  return {
    ok: (ws.credits_balance || 0) === derived.balance && (ws.reserved_credits || 0) === derived.reserved,
    derived,
    cached: { balance: ws.credits_balance || 0, reserved: ws.reserved_credits || 0 },
  };
}