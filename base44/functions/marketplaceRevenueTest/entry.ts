// P-10.2 regression suite — marketplace REVENUE SHARE / publisher payout parity.
//
// Certifies that a completed marketplace purchase allocates publisher revenue WITHOUT changing
// the existing purchase flow: the buyer's charge is still one immutable ledger entry, the split is
// derived from server configuration only, a replayed purchase allocates exactly once, a refund
// reverses the allocation exactly once (as a NEW ledger entry, never an edit of the purchase),
// failed purchases allocate nothing, and one publisher can never read another's revenue. No
// mocked installs: scratch workspaces are created and every record they produce is deleted again.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createListing, publishVersion, publishListing, install } from "../../shared/marketplace.ts";
import {
  recordPublisherRevenue, refundInstall, listPublisherRevenue, revenueSplit, purchaseKeyFor, RevenueError,
} from "../../shared/marketplaceRevenue.ts";
import { recordEvent, deriveBalance } from "../../shared/ledger.ts";
import { can } from "../../shared/rbac.ts";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";

const artifact = (n) => ({ uri: `marketplace://artifacts/rev-${n}.tar`, checksum: `sha256:rev-${n}` });
const CAPS = ["entity:read"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  const wsIds = [];

  const liveRevenue = async (query) =>
    (await svc.entities.MarketplaceRevenue.filter(query, "-created_date", 50)).filter((r) => !r.voided);

  try {
    const me = await base44.auth.me().catch(() => null);
    const mk = async (n) => {
      const w = await svc.entities.Workspace.create({ name: `rev-${n}-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
      wsIds.push(w.id);
      return w;
    };
    const pubA = await mk("pub-a"), pubC = await mk("pub-c"), buyer = await mk("buyer"), broke = await mk("broke");
    const A = pubA.id, C = pubC.id, B = buyer.id, D = broke.id;

    // Fund the buyer (scratch ledger grant; the same mechanism the other marketplace suites use).
    await recordEvent(svc, { workspace_id: B, event_type: "promotional", amount: 100000, idempotency_key: `mktrev-test:fund:${B}`, reason: "test funds" });

    // --------------------------------------------------- the split is server configuration only
    const split = revenueSplit(25);
    check("the split is fixed server configuration (30% platform / 70% publisher)",
      split.platform_fee_credits === 7.5 && split.publisher_credits === 17.5 && split.fee_bps === 3000,
      `${split.platform_fee_credits}/${split.publisher_credits}`);
    check("revenue reads require editor+ and refunds require admin+",
      !can("viewer", "marketplace.publish") && can("editor", "marketplace.publish") && can("admin", "marketplace.moderate") && !can("editor", "marketplace.moderate"),
      "rbac");

    // --------------------------------------------------- publisher A's paid listing, two versions
    const listing = await createListing(svc, { workspace_id: A, owner_id: "u", slug: `rev-paid-${Date.now()}`, name: "Paid Widget", kind: "plugin", capabilities: CAPS, pricing_model: "one_time", price_cents: 25 });
    const v1 = await publishVersion(svc, { workspace_id: A, listing_id: listing.id, version_label: "1.0.0", manifest: {}, changelog: "", compatibility: {}, artifact_uri: artifact(1).uri, artifact_checksum: artifact(1).checksum, capabilities: CAPS, user_id: "u" });
    const v2 = await publishVersion(svc, { workspace_id: A, listing_id: listing.id, version_label: "2.0.0", manifest: {}, changelog: "", compatibility: {}, artifact_uri: artifact(2).uri, artifact_checksum: artifact(2).checksum, capabilities: CAPS, user_id: "u" });
    await publishListing(svc, { workspace_id: A, listing_id: listing.id, visibility: "public" });

    // --------------------------------------------------- purchase v1: buyer charge + revenue allocation
    const ins1 = await install(svc, { workspace_id: B, listing_id: listing.id, version_id: v1.version.id, consented_capabilities: CAPS, user_id: "u" });
    check("the paid install charged the buyer 25 credits", ins1.charged === 25, `${ins1.charged}`);
    check("the buyer charge is on the ledger", (await deriveBalance(svc, B)).balance === 100000 - 25, `${(await deriveBalance(svc, B)).balance}`);

    const aRows1 = await liveRevenue({ publisher_workspace_id: A });
    check("the purchase allocated exactly one revenue row", aRows1.length === 1, `${aRows1.length}`);
    const rev1 = aRows1[0];
    const pk1 = purchaseKeyFor({ buyer_workspace_id: B, listing_id: listing.id, version_id: v1.version.id });
    check("the allocation tracks item, publisher, buyer, amounts and the source purchase",
      rev1.listing_id === listing.id && rev1.publisher_workspace_id === A && rev1.buyer_workspace_id === B &&
      rev1.gross_credits === 25 && rev1.platform_fee_credits === 7.5 && rev1.publisher_credits === 17.5 &&
      rev1.purchase_idempotency_key === pk1 && !!rev1.purchase_ledger_entry_id,
      "allocation fields");
    check("the allocation is active and unreversed", rev1.status === "active" && !rev1.refund_ledger_entry_id, rev1.status);

    // --------------------------------------------------- replay: no duplicate allocation
    const replay = await install(svc, { workspace_id: B, listing_id: listing.id, version_id: v1.version.id, consented_capabilities: CAPS, user_id: "u" });
    check("a duplicate install charges nothing", replay.duplicate && replay.charged === 0, `${replay.charged}`);
    const replayProbe = await recordPublisherRevenue(svc, {
      listing, version: v1.version, buyer_workspace_id: B, buyer_user_id: "u",
      gross_credits: 25, purchase_key: pk1, purchase_ledger_entry_id: rev1.purchase_ledger_entry_id,
    });
    check("a replayed purchase creates no duplicate revenue", replayProbe.duplicate && (await liveRevenue({ publisher_workspace_id: A })).length === 1, "idempotent");

    // --------------------------------------------------- failed purchase allocates nothing
    await expectThrow("an unfunded workspace cannot buy the listing",
      () => install(svc, { workspace_id: D, listing_id: listing.id, version_id: v1.version.id, consented_capabilities: CAPS, user_id: "u" }), "INSUFFICIENT_CREDITS");
    check("a failed purchase created no revenue and moved no credits",
      (await svc.entities.MarketplaceRevenue.filter({ buyer_workspace_id: D }, "-created_date", 10)).length === 0 && (await deriveBalance(svc, D)).balance === 0, "no allocation");

    // --------------------------------------------------- free install allocates nothing
    const free = await createListing(svc, { workspace_id: A, owner_id: "u", slug: `rev-free-${Date.now()}`, name: "Free Widget", kind: "plugin", capabilities: [], pricing_model: "free" });
    const fv = await publishVersion(svc, { workspace_id: A, listing_id: free.id, version_label: "1.0.0", manifest: {}, changelog: "", compatibility: {}, artifact_uri: artifact(3).uri, artifact_checksum: artifact(3).checksum, capabilities: [], user_id: "u" });
    await publishListing(svc, { workspace_id: A, listing_id: free.id, visibility: "public" });
    const freeIns = await install(svc, { workspace_id: B, listing_id: free.id, consented_capabilities: [], user_id: "u" });
    check("a free install allocates no revenue", (await liveRevenue({ publisher_workspace_id: A })).length === 1, "still 1");

    // --------------------------------------------------- upgrade to v2: a second, distinct allocation
    const up = await install(svc, { workspace_id: B, listing_id: listing.id, version_id: v2.version.id, consented_capabilities: CAPS, user_id: "u" });
    check("the upgrade charged the buyer again", !up.duplicate && up.charged === 25, `${up.charged}`);
    check("the upgrade allocated a second revenue row", (await liveRevenue({ publisher_workspace_id: A })).length === 2, "2 rows");

    // --------------------------------------------------- publisher C: cross-publisher isolation
    const cListing = await createListing(svc, { workspace_id: C, owner_id: "u", slug: `rev-cpaid-${Date.now()}`, name: "Other Widget", kind: "plugin", capabilities: [], pricing_model: "one_time", price_cents: 10 });
    const cv = await publishVersion(svc, { workspace_id: C, listing_id: cListing.id, version_label: "1.0.0", manifest: {}, changelog: "", compatibility: {}, artifact_uri: artifact(4).uri, artifact_checksum: artifact(4).checksum, capabilities: [], user_id: "u" });
    await publishListing(svc, { workspace_id: C, listing_id: cListing.id, visibility: "public" });
    await install(svc, { workspace_id: B, listing_id: cListing.id, consented_capabilities: [], user_id: "u" });

    const aView = await listPublisherRevenue(svc, { publisher_workspace_id: A });
    const cView = await listPublisherRevenue(svc, { publisher_workspace_id: C });
    check("publisher A sees only its own allocations", aView.revenue.length === 2 && aView.revenue.every((r) => r.publisher_workspace_id === A), `${aView.revenue.length}`);
    check("publisher A cannot read publisher C's revenue",
      aView.revenue.every((r) => r.listing_id !== cListing.id) && cView.revenue.length === 1 && cView.revenue.every((r) => r.listing_id === cListing.id),
      "isolated");
    check("the publisher summary nets only active allocations", aView.summary.active === 2 && aView.summary.publisher_credits === 35, JSON.stringify(aView.summary));

    // --------------------------------------------------- refund: exactly-once reversal
    const preRefund = (await deriveBalance(svc, B)).balance;
    const refundRes = await refundInstall(svc, { install_id: up.install.id, reason: "test refund", refunded_by: "u" });
    check("the refund returned the gross to the buyer", (await deriveBalance(svc, B)).balance === preRefund + 25, `${(await deriveBalance(svc, B)).balance}`);
    check("the allocation is reversed, not deleted", refundRes.revenue.status === "reversed" && !!refundRes.revenue.refund_ledger_entry_id, refundRes.revenue.status);
    const purchases = (await svc.entities.CreditLedgerEntry.filter({ workspace_id: B, event_type: "purchase" }, "-created_date", 20)).filter((e) => !e.voided);
    const refunds = (await svc.entities.CreditLedgerEntry.filter({ workspace_id: B, event_type: "refund" }, "-created_date", 20)).filter((e) => !e.voided);
    check("the purchase entries are immutable and the refund is a new entry",
      purchases.length === 3 && refunds.length === 1 && Number(refunds[0].amount) === 25,
      `${purchases.length}/${refunds.length}`);
    const aView2 = await listPublisherRevenue(svc, { publisher_workspace_id: A });
    check("the reversal nets out of the publisher summary", aView2.summary.active === 1 && aView2.summary.publisher_credits === 17.5, JSON.stringify(aView2.summary));

    // Replay the same refund: idempotent — nothing moves twice.
    const replayRefund = await refundInstall(svc, { install_id: up.install.id, reason: "replay", refunded_by: "u" });
    const refunds2 = (await svc.entities.CreditLedgerEntry.filter({ workspace_id: B, event_type: "refund" }, "-created_date", 20)).filter((e) => !e.voided);
    check("a replayed refund moves nothing", replayRefund.duplicate && refunds2.length === 1 && (await deriveBalance(svc, B)).balance === preRefund + 25, `${refunds2.length}`);

    // An install with no paid purchase cannot be refunded.
    check("an unpaid install cannot be refunded", await (async () => {
      try { await refundInstall(svc, { install_id: freeIns.install.id, reason: "x" }); return false; }
      catch (e) { return e instanceof RevenueError && e.code === "NO_REVENUE"; }
    })(), "NO_REVENUE");

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    // Scratch cleanup: revenue rows are keyed by publisher AND buyer, so purge them per workspace
    // alongside every other record this suite created, then the workspaces themselves.
    for (const id of wsIds) {
      await purgeBy(svc, "MarketplaceRevenue", { publisher_workspace_id: id });
      await purgeBy(svc, "MarketplaceRevenue", { buyer_workspace_id: id });
      await cleanupWorkspace(svc, id, ["CreditLedgerEntry", "AuditLog", "MarketplaceInstall", "MarketplaceVersion", "MarketplaceListing"]);
    }
  }
}