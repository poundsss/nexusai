// Marketplace publisher revenue accounting (P-10.2) — revenue share / publisher payout parity.
//
// Parity layer over the EXISTING marketplace purchase flow. The buyer's charge stays exactly
// where it already is — an immutable CreditLedgerEntry written by install() — and every
// successful paid purchase additionally allocates the publisher's share as one MarketplaceRevenue
// row. The buyer ledger is never modified: a refund is a NEW ledger entry, never an edit of the
// purchase, and a refunded allocation is reversed (never deleted), so both sides stay auditable.
//
// The split is SERVER CONFIGURATION ONLY (PLATFORM_FEE_BPS below): no install, refund or read
// path accepts a fee or share from a client, and the split is not stored on the listing — each
// row freezes the fee_bps it was computed under, so a later configuration change never rewrites
// already-allocated history.
//
// Idempotency mirrors the ledger's own model: the revenue row's key is derived from the purchase
// key, so a replayed purchase converges on the existing row instead of allocating twice, and two
// concurrent writers that both slip past the pre-check are reconciled — the earliest row wins and
// the loser is voided out of every derivation, exactly like a duplicate ledger entry.
//
// No external payment provider is involved: the publisher's balance is derived from these rows
// (active minus reversed), and materializing an actual payout is deliberately out of scope.
import { recordEvent } from "./ledger.ts";
import { audit } from "./authz.ts";

// The platform's revenue-share configuration — the single server-side source of the split.
const PLATFORM_FEE_BPS = 3000; // 30% platform / 70% publisher

export const round6 = (v) => Math.round((Number(v) || 0) * 1e6) / 1e6;

export class RevenueError extends Error {
  constructor(message, code = "REVENUE_ERROR", status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

/** The split for one gross amount. Derived from server configuration only — never from a client. */
export function revenueSplit(gross) {
  const g = round6(gross);
  const platform_fee_credits = round6((g * PLATFORM_FEE_BPS) / 10000);
  return { platform_fee_credits, publisher_credits: round6(g - platform_fee_credits), fee_bps: PLATFORM_FEE_BPS };
}

export const purchaseKeyFor = ({ buyer_workspace_id, listing_id, version_id }) =>
  `marketplace:install:${buyer_workspace_id}:${listing_id}:${version_id}`;
export const revenueKeyFor = (purchase_key) => `marketplace:revenue:${purchase_key}`;
export const refundKeyFor = (purchase_key) => `marketplace:refund:${purchase_key}`;

async function revenueByKey(svc, idempotency_key) {
  const rows = await svc.entities.MarketplaceRevenue.filter({ idempotency_key }, "created_date", 10).catch(() => []);
  return { rows, live: rows.find((r) => !r.voided) || null };
}

const safeRevenueRow = (r) => ({
  id: r.id, listing_id: r.listing_id, listing_slug: r.listing_slug || null, version_id: r.version_id, version_number: r.version_number ?? null,
  publisher_workspace_id: r.publisher_workspace_id, buyer_workspace_id: r.buyer_workspace_id,
  price_cents: r.price_cents || 0, currency: r.currency || "USD",
  gross_credits: r.gross_credits || 0, platform_fee_credits: r.platform_fee_credits || 0, publisher_credits: r.publisher_credits || 0,
  fee_bps: r.fee_bps || 0, status: r.status,
  purchase_idempotency_key: r.purchase_idempotency_key || null, purchase_ledger_entry_id: r.purchase_ledger_entry_id || null,
  refund_ledger_entry_id: r.refund_ledger_entry_id || null, reversed_at: r.reversed_at || null, reversal_reason: r.reversal_reason || null,
  created_date: r.created_date,
});

/**
 * Allocates publisher revenue for one COMPLETED purchase. Idempotent on the purchase key: a
 * replay converges on the existing allocation, and a duplicate-key race leaves exactly one live
 * row. Called only from the shared install path, after the buyer charge succeeded — a failed
 * purchase never reaches this function, so a failed purchase allocates nothing.
 */
export async function recordPublisherRevenue(svc, { listing, version, buyer_workspace_id, buyer_user_id, gross_credits, purchase_key, purchase_ledger_entry_id }) {
  if (!(Number(gross_credits) > 0)) return null;
  const idempotency_key = revenueKeyFor(purchase_key);
  const { live } = await revenueByKey(svc, idempotency_key);
  if (live) return { revenue: live, duplicate: true };
  const split = revenueSplit(gross_credits);
  const created = await svc.entities.MarketplaceRevenue.create({
    listing_id: listing.id, listing_slug: listing.slug || null, version_id: version.id, version_number: version.version_number ?? null,
    publisher_workspace_id: listing.workspace_id, buyer_workspace_id,
    price_cents: Number(listing.price_cents) || 0, currency: listing.currency || "USD",
    gross_credits: round6(gross_credits), platform_fee_credits: split.platform_fee_credits, publisher_credits: split.publisher_credits,
    fee_bps: split.fee_bps, status: "active", voided: false,
    purchase_idempotency_key: purchase_key, purchase_ledger_entry_id: purchase_ledger_entry_id || null,
    idempotency_key, created_by_user_id: buyer_user_id || null,
  });
  // Duplicate-key race convergence, same contract as the credit ledger: the earliest row wins,
  // losers are voided out of every derivation, and every racing writer adopts the same row.
  const { rows } = await revenueByKey(svc, idempotency_key);
  if (rows.length > 1) {
    const ordered = [...rows].sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)));
    for (const loser of ordered.slice(1)) if (!loser.voided) await svc.entities.MarketplaceRevenue.update(loser.id, { voided: true });
    if (ordered[0].id !== created.id) return { revenue: ordered[0], duplicate: true };
  }
  await audit(svc, {
    workspace_id: buyer_workspace_id, user_id: buyer_user_id || "platform",
    action: "marketplace.revenue.created", resource: "MarketplaceRevenue", resource_id: created.id,
    metadata: {
      publisher_workspace_id: listing.workspace_id, listing_id: listing.id, listing_slug: listing.slug || null,
      buyer_workspace_id, gross_credits: created.gross_credits, platform_fee_credits: split.platform_fee_credits,
      publisher_credits: split.publisher_credits, fee_bps: split.fee_bps, purchase_key,
    },
  }).catch(() => {});
  return { revenue: created, duplicate: false };
}

/**
 * Refunds one paid install. The buyer's CURRENT version purchase is refunded in full on the
 * buyer's ledger as a NEW refund entry — the purchase entry is never edited or deleted — and the
 * matching allocation is reversed (never deleted) through a compare-and-set on its status, so a
 * replayed or concurrent refund moves credits exactly once. Earlier purchases in an upgrade chain
 * stay allocated: they were paid and consumed. A payout provider is deliberately not involved.
 */
export async function refundInstall(svc, { install_id, reason = "", refunded_by = null }) {
  const install = await svc.entities.MarketplaceInstall.get(install_id).catch(() => null);
  if (!install) throw new RevenueError("Install not found", "NOT_FOUND", 404);
  const listing = await svc.entities.MarketplaceListing.get(install.listing_id).catch(() => null);
  if (!listing) throw new RevenueError("Listing not found", "NOT_FOUND", 404);
  const purchase_key = purchaseKeyFor({ buyer_workspace_id: install.workspace_id, listing_id: install.listing_id, version_id: install.version_id });
  const { live } = await revenueByKey(svc, revenueKeyFor(purchase_key));
  if (!live) throw new RevenueError("No paid purchase to refund for this install version", "NO_REVENUE", 409);
  if (live.status === "reversed") return { revenue: live, duplicate: true };
  // Buyer refund: a NEW immutable ledger entry, idempotent on the refund key.
  const refund = await recordEvent(svc, {
    workspace_id: live.buyer_workspace_id, user_id: refunded_by,
    event_type: "refund", amount: round6(live.gross_credits), idempotency_key: refundKeyFor(purchase_key),
    reason: `Marketplace refund: ${listing.name} v${install.version_number ?? ""}`.trim(),
    metadata: { listing_id: listing.id, install_id: install.id, revenue_id: live.id, purchase_key },
  });
  // Single-writer reversal: only the request that flips active → reversed writes the stamps; a
  // concurrent twin finds the row already reversed and reports a duplicate.
  const claim = await svc.entities.MarketplaceRevenue.updateMany(
    { id: live.id, status: "active" },
    { $set: {
      status: "reversed", reversed_at: new Date().toISOString(),
      reversal_reason: String(reason || "Refunded").slice(0, 500),
      refund_ledger_entry_id: refund.entry.id, refunded_by: refunded_by || null,
    } },
  );
  const updated = await svc.entities.MarketplaceRevenue.get(live.id);
  if (!Number(claim?.updated || 0)) return { revenue: updated, refund: refund.entry, duplicate: true };
  await audit(svc, {
    workspace_id: live.buyer_workspace_id, user_id: refunded_by || "platform",
    action: "marketplace.revenue.refunded", resource: "MarketplaceRevenue", resource_id: live.id,
    metadata: {
      publisher_workspace_id: live.publisher_workspace_id, listing_id: listing.id, install_id: install.id,
      gross_credits: live.gross_credits, platform_fee_credits: live.platform_fee_credits,
      publisher_credits: live.publisher_credits, refund_ledger_entry_id: refund.entry.id,
    },
  }).catch(() => {});
  return { revenue: updated, refund: refund.entry, duplicate: false };
}

/**
 * The publisher's OWN revenue view: allocations where this workspace is the publisher. This is
 * the only read surface — the entity itself is system-only (read: false), so a publisher can
 * never query another publisher's payouts, and a buyer workspace never sees allocations at all.
 * The summary nets only ACTIVE allocations; reversed ones are excluded from every total.
 */
export async function listPublisherRevenue(svc, { publisher_workspace_id, listing_id = null, include_reversed = true, limit = 200 }) {
  const query = { publisher_workspace_id };
  if (listing_id) query.listing_id = listing_id;
  const rows = (await svc.entities.MarketplaceRevenue.filter(query, "-created_date", Math.min(Math.max(limit, 1), 500)))
    .filter((r) => !r.voided);
  const active = rows.filter((r) => r.status === "active");
  const total = (key) => round6(active.reduce((n, r) => n + (Number(r[key]) || 0), 0));
  return {
    revenue: (include_reversed ? rows : active).map(safeRevenueRow),
    summary: {
      entries: rows.length, active: active.length, reversed: rows.length - active.length,
      gross_credits: total("gross_credits"), platform_fee_credits: total("platform_fee_credits"),
      publisher_credits: total("publisher_credits"),
    },
  };
}