// Marketplace verification — REAL production code paths.
//
// Exercises the full lifecycle against the actual marketplace module: listing creation, the
// immutable publish flow, compatibility gating, capability consent and re-consent, idempotent
// paid installs through the credit ledger, reviews, abuse reports, trust-driven auto-suspend,
// cross-workspace isolation and RBAC. No mocked installs, no fake charges. Scratch workspaces
// are created and every record they produce is deleted again.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createListing, getListing, getListingBySlug, listListings, updateListing, removeListing,
  publishVersion, yankVersion, listVersions, getVersion, publishListing,
  install, uninstall, listInstalls,
  postReview, listReviews, recomputeRating,
  fileReport, resolveReport, listReports, recomputeTrust, suspendListing, reinstateListing,
  checkCompatibility, newCapabilities, MarketplaceError, TRUST_SUSPEND_THRESHOLD,
} from "../../shared/marketplace.ts";
import { recordEvent, deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { can } from "../../shared/rbac.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";

const artifact = (n) => ({ uri: `marketplace://artifacts/listing-${n}.tar`, checksum: `sha256:${n}` });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let ownerWs = null, buyerWs = null, thirdWs = null;
  const track = { listings: [], versions: [], installs: [], reviews: [], reports: [] };

  try {
    const me = await base44.auth.me().catch(() => null);
    // Two scratch workspaces: the publisher and the installer.
    ownerWs = await svc.entities.Workspace.create({ name: `mkt-owner-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
    buyerWs = await svc.entities.Workspace.create({ name: `mkt-buyer-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
    thirdWs = await svc.entities.Workspace.create({ name: `mkt-third-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
    const O = ownerWs.id, B = buyerWs.id, T = thirdWs.id;

    // ----------------------------------------------------------- listing creation
    await expectThrow("an unknown kind is refused", () => createListing(svc, { workspace_id: O, owner_id: "u", slug: "bad", name: "Bad", kind: "virus" }), "UNKNOWN_KIND");
    await expectThrow("an invalid slug is refused", () => createListing(svc, { workspace_id: O, owner_id: "u", slug: "!!!", name: "Bad", kind: "template" }), "INVALID_SLUG");
    const dupSlug = await createListing(svc, { workspace_id: O, owner_id: "u", slug: "react-starter", name: "React Starter", kind: "template" });
    track.listings.push(dupSlug.id);
    await expectThrow("a duplicate slug is refused", () => createListing(svc, { workspace_id: B, owner_id: "u", slug: "react-starter", name: "Other", kind: "template" }), "SLUG_TAKEN");
    await expectThrow("a paid listing with no price is refused", () => createListing(svc, { workspace_id: O, owner_id: "u", slug: "paid-bad", name: "Paid", kind: "plugin", pricing_model: "one_time", price_cents: 0 }), "INVALID_PRICE");

    const tmpl = await createListing(svc, { workspace_id: O, owner_id: "u", slug: "preact-htm-starter", name: "Preact HTM Starter", kind: "template", summary: "A starter", category: "starter", tags: ["preact", "starter"], capabilities: ["entity:read"], compatibility: { frameworks: ["preact-htm"] }, pricing_model: "free" });
    track.listings.push(tmpl.id);
    check("a draft listing starts private and unpublished", tmpl.status === "draft" && tmpl.visibility === "private", tmpl.status);
    check("the slug is normalized to kebab-case", tmpl.slug === "preact-htm-starter", tmpl.slug);
    check("a new listing has a clean trust score", tmpl.trust_score === 100, `${tmpl.trust_score}`);

    // ----------------------------------------------------------- publishing & immutability
    await expectThrow("publishing a listing with no version is refused", () => publishListing(svc, { workspace_id: O, listing_id: tmpl.id }), "NO_PUBLISHED_VERSION");
    const v1 = await publishVersion(svc, { workspace_id: O, listing_id: tmpl.id, version_label: "1.0.0", manifest: { entry: "index.html" }, changelog: "first", compatibility: {}, artifact_uri: artifact(1).uri, artifact_checksum: artifact(1).checksum, capabilities: ["entity:read"], user_id: "u" });
    track.versions.push(v1.version.id);
    check("a version is published with a monotonic number", v1.version.version_number === 1 && v1.version.status === "published", `${v1.version.version_number}`);
    check("the version freezes its artifact checksum", v1.version.artifact_checksum === artifact(1).checksum, v1.version.artifact_checksum);

    // Re-publishing the SAME checksum is idempotent (returns the existing version).
    const v1dup = await publishVersion(svc, { workspace_id: O, listing_id: tmpl.id, version_label: "1.0.0", artifact_uri: artifact(1).uri, artifact_checksum: artifact(1).checksum });
    check("re-publishing the same artifact is idempotent", v1dup.duplicate && v1dup.version.id === v1.version.id, v1dup.duplicate);

    // Changed content → new version, never a silent overwrite.
    const v2 = await publishVersion(svc, { workspace_id: O, listing_id: tmpl.id, version_label: "1.1.0", manifest: { entry: "index.html", extra: true }, changelog: "more", artifact_uri: artifact(2).uri, artifact_checksum: artifact(2).checksum, capabilities: ["entity:read", "entity:write"], user_id: "u" });
    track.versions.push(v2.version.id);
    check("changed content produces a new immutable version", v2.version.version_number === 2 && v2.version.id !== v1.version.id, `${v2.version.version_number}`);
    check("the new version becomes current", (await getListing(svc, tmpl.id)).current_version_id === v2.version.id, "current=v2");
    check("the old version is untouched (immutable)", (await getVersion(svc, v1.version.id)).version_label === "1.0.0", "v1 immutable");

    // Publishing the listing makes it public and installable.
    const published = await publishListing(svc, { workspace_id: O, listing_id: tmpl.id, visibility: "public" });
    check("publishing flips the listing to published/public", published.listing.status === "published" && published.listing.visibility === "public", published.listing.status);

    // ----------------------------------------------------------- cross-workspace authorization
    await expectThrow("another workspace cannot edit this listing", () => updateListing(svc, { workspace_id: B, listing_id: tmpl.id, patch: { summary: "hacked" } }), "FORBIDDEN");
    await expectThrow("another workspace cannot publish a version", () => publishVersion(svc, { workspace_id: B, listing_id: tmpl.id, version_label: "x", artifact_uri: "u", artifact_checksum: "c" }), "FORBIDDEN");
    await expectThrow("another workspace cannot yank a version", () => yankVersion(svc, { workspace_id: B, listing_id: tmpl.id, version_id: v1.version.id }), "FORBIDDEN");

    // ----------------------------------------------------------- compatibility
    const compatOk = await checkCompatibility(svc, { listing: tmpl, version: v2.version, project: { framework: "preact-htm" }, plan: { tier_rank: 1 } });
    check("a compatible project+plan passes", compatOk.ok, JSON.stringify(compatOk.violations));
    const compatBad = await checkCompatibility(svc, { listing: tmpl, version: v2.version, project: { framework: "react" }, plan: { tier_rank: 1 } });
    check("a framework mismatch is reported", !compatBad.ok && compatBad.violations.some((v) => v.code === "FRAMEWORK_MISMATCH"), JSON.stringify(compatBad.violations));

    // ----------------------------------------------------------- installs & consent
    await expectThrow("installing without consenting to capabilities is refused", () => install(svc, { workspace_id: B, listing_id: tmpl.id, consented_capabilities: [], user_id: "u", project: { framework: "preact-htm" } }), "CONSENT_REQUIRED");
    const ins1 = await install(svc, { workspace_id: B, listing_id: tmpl.id, consented_capabilities: ["entity:read", "entity:write"], user_id: "u", project: { framework: "preact-htm" } });
    track.installs.push(ins1.install.id);
    check("a compatible, consented install succeeds", ins1.install.status === "active" && ins1.charged === 0, ins1.install.status);
    check("the install pins the current version", ins1.install.version_id === v2.version.id, ins1.install.version_id);
    check("the install records the granted capabilities", ins1.install.capabilities_granted.includes("entity:read") && ins1.install.capabilities_granted.includes("entity:write"), JSON.stringify(ins1.install.capabilities_granted));

    // Re-installing the same version is a no-op duplicate.
    const ins1dup = await install(svc, { workspace_id: B, listing_id: tmpl.id, consented_capabilities: ["entity:read", "entity:write"], user_id: "u", project: { framework: "preact-htm" } });
    check("re-installing the same version is a duplicate", ins1dup.duplicate && ins1dup.install.id === ins1.install.id, ins1dup.duplicate);
    check("a duplicate install charges nothing", ins1dup.charged === 0, `${ins1dup.charged}`);

    // An incompatible install is refused.
    await expectThrow("an incompatible install is refused", () => install(svc, { workspace_id: B, listing_id: tmpl.id, consented_capabilities: ["entity:read", "entity:write"], user_id: "u", project: { framework: "react" } }), "INCOMPATIBLE");

    // Downgrading to v1 (fewer capabilities) does not require re-consent.
    const insDown = await install(svc, { workspace_id: B, listing_id: tmpl.id, version_id: v1.version.id, consented_capabilities: ["entity:read", "entity:write"], user_id: "u", project: { framework: "preact-htm" } });
    check("downgrading to a version with fewer capabilities succeeds", insDown.install.version_id === v1.version.id, "downgraded");

    // Publishing v3 with a NEW capability, then upgrading requires re-consent.
    const v3 = await publishVersion(svc, { workspace_id: O, listing_id: tmpl.id, version_label: "2.0.0", manifest: { entry: "index.html" }, artifact_uri: artifact(3).uri, artifact_checksum: artifact(3).checksum, capabilities: ["entity:read", "entity:write", "network"], user_id: "u" });
    track.versions.push(v3.version.id);
    await expectThrow("an upgrade requesting new capabilities without re-consent is refused", () => install(svc, { workspace_id: B, listing_id: tmpl.id, version_id: v3.version.id, consented_capabilities: ["entity:read", "entity:write"], user_id: "u", project: { framework: "preact-htm" } }), "RECONSENT_REQUIRED");
    const insUp = await install(svc, { workspace_id: B, listing_id: tmpl.id, version_id: v3.version.id, consented_capabilities: ["entity:read", "entity:write", "network"], user_id: "u", project: { framework: "preact-htm" } });
    check("upgrading with full re-consent succeeds", insUp.install.version_id === v3.version.id, "upgraded");

    // Uninstall.
    const un = await uninstall(svc, { workspace_id: B, install_id: insUp.install.id });
    check("uninstalling marks the install removed", un.install.status === "uninstalled", un.install.status);
    const unDup = await uninstall(svc, { workspace_id: B, install_id: insUp.install.id });
    check("uninstalling twice is a duplicate", unDup.duplicate, `${unDup.duplicate}`);
    await expectThrow("another workspace cannot uninstall", () => uninstall(svc, { workspace_id: T, install_id: ins1.install.id }), "FORBIDDEN");

    // ----------------------------------------------------------- yanking
    const yanked = await yankVersion(svc, { workspace_id: O, listing_id: tmpl.id, version_id: v3.version.id, reason: "security" });
    check("yanking marks a version yanked", yanked.version.status === "yanked", yanked.version.status);
    const afterYank = await getListing(svc, tmpl.id);
    check("yanking the current version rolls back to the newest published", afterYank.current_version_id === v2.version.id, afterYank.current_version_id === v2.version.id ? "rolled back" : afterYank.current_version_id);
    await expectThrow("a yanked version cannot be installed", () => install(svc, { workspace_id: B, listing_id: tmpl.id, version_id: v3.version.id, consented_capabilities: ["entity:read", "entity:write", "network"], user_id: "u", project: { framework: "preact-htm" } }), "VERSION_NOT_INSTALLABLE");

    // ----------------------------------------------------------- paid installs
    // Priced INSIDE the buyer's real free-plan entitlement: 50 credits per operation, 200 per
    // month, overage blocked. $0.25 = 25 credits clears every dimension, so this section tests the
    // paid-install CHARGE rather than the plan ceiling (which planLimitsTest already certifies).
    // A dearer listing is refused with PLAN_RUN_CREDITS_EXCEEDED however funded the ledger is —
    // funding cannot lift a plan ceiling, and that refusal is correct production behaviour.
    const paid = await createListing(svc, { workspace_id: O, owner_id: "u",
      slug: "pro-plugin", name: "Pro Plugin", kind: "plugin", pricing_model: "one_time", price_cents: 25, capabilities: ["function:invoke"], compatibility: { frameworks: ["preact-htm"] } });
    track.listings.push(paid.id);
    const paidV = await publishVersion(svc, { workspace_id: O, listing_id: paid.id, version_label: "1.0.0", manifest: {}, artifact_uri: artifact(10).uri, artifact_checksum: artifact(10).checksum, capabilities: ["function:invoke"], user_id: "u" });
    track.versions.push(paidV.version.id);
    await publishListing(svc, { workspace_id: O, listing_id: paid.id, visibility: "public" });

    // Buyer with no credits cannot afford a paid install → fails closed.
    await expectThrow("an unaffordable paid install is refused", () => install(svc, { workspace_id: B, listing_id: paid.id, consented_capabilities: ["function:invoke"], user_id: "u", project: { framework: "preact-htm" } }), "INSUFFICIENT_CREDITS");
    check("a refused paid install charged nothing", (await deriveBalance(svc, B)).balance === 0, `${(await deriveBalance(svc, B)).balance}`);

    // Fund the buyer and retry — the charge is idempotent.
    await recordEvent(svc, { workspace_id: B, event_type: "promotional", amount: 100000, idempotency_key: `mkt-test:fund:${B}`, reason: "test funds" });
    const balBefore = (await deriveBalance(svc, B)).balance;
    const paidIns = await install(svc, { workspace_id: B, listing_id: paid.id, consented_capabilities: ["function:invoke"], user_id: "u", project: { framework: "preact-htm" } });
    track.installs.push(paidIns.install.id);
    check("a paid install charges the ledger", paidIns.charged > 0 && (await deriveBalance(svc, B)).balance === balBefore - paidIns.charged, `${paidIns.charged} credits`);
    const balAfterPaid = (await deriveBalance(svc, B)).balance;
    // A retried install with the same version is a duplicate and charges nothing.
    const paidDup = await install(svc, { workspace_id: B, listing_id: paid.id, consented_capabilities: ["function:invoke"], user_id: "u", project: { framework: "preact-htm" } });
    check("a duplicate paid install charges nothing", paidDup.duplicate && (await deriveBalance(svc, B)).balance === balAfterPaid, `${(await deriveBalance(svc, B)).balance}`);
    check("the ledger stayed authoritative through the purchase", (await verifyBalanceIntegrity(svc, B)).ok, "ledger ok");

    // ----------------------------------------------------------- reviews
    // Re-install the current version so the review is verified (the earlier install was uninstalled
    // and the install model updates in place, so there is no active install right now).
    const revInstall = await install(svc, { workspace_id: B, listing_id: tmpl.id, consented_capabilities: ["entity:read", "entity:write"], user_id: "u", project: { framework: "preact-htm" } });
    track.installs.push(revInstall.install.id);
    await expectThrow("the owner cannot review their own listing", () => postReview(svc, { listing_id: tmpl.id, workspace_id: O, user_id: "u", rating: 5 }), "SELF_REVIEW");
    await expectThrow("an out-of-range rating is refused", () => postReview(svc, { listing_id: tmpl.id, workspace_id: B, user_id: "u", rating: 9 }), "INVALID_RATING");
    const rev = await postReview(svc, { listing_id: tmpl.id, workspace_id: B, user_id: "u", rating: 4, title: "Good", body: "Works well" });
    track.reviews.push(rev.review.id);
    check("a review is recorded with the workspace identity", rev.review.rating === 4, `${rev.review.rating}`);
    check("an active install marks the review verified", rev.verified === true, `${rev.verified}`);
    // One review per workspace: posting again updates, not duplicates.
    const revUpd = await postReview(svc, { listing_id: tmpl.id, workspace_id: B, user_id: "u", rating: 5, title: "Great", body: "Updated" });
    check("a second review from the same workspace updates", revUpd.review.id === rev.review.id && revUpd.review.rating === 5, "updated");
    const ratings = await recomputeRating(svc, tmpl.id);
    check("the rating aggregate reflects the latest review", ratings.count === 1 && ratings.avg === 5, JSON.stringify(ratings));
    const thirdRev = await postReview(svc, { listing_id: tmpl.id, workspace_id: T, user_id: "u", rating: 2, title: "Meh", body: "Buggy" });
    track.reviews.push(thirdRev.review.id);
    check("a non-installer review is unverified", thirdRev.verified === false, `${thirdRev.verified}`);
    const ratings2 = await recomputeRating(svc, tmpl.id);
    check("the aggregate averages across workspaces", ratings2.count === 2 && ratings2.avg === 3.5, JSON.stringify(ratings2));

    // ----------------------------------------------------------- reports & trust
    await expectThrow("the owner cannot report their own listing", () => fileReport(svc, { listing_id: tmpl.id, reporter_workspace_id: O, reporter_user_id: "u", reason: "spam" }), "SELF_REPORT");
    await expectThrow("an invalid report reason is refused", () => fileReport(svc, { listing_id: tmpl.id, reporter_workspace_id: B, reporter_user_id: "u", reason: "revenge" }), "INVALID_REASON");
    const rep = await fileReport(svc, { listing_id: tmpl.id, reporter_workspace_id: B, reporter_user_id: "u", reason: "spam", detail: "spammy" });
    track.reports.push(rep.report.id);
    check("a report is filed as open", rep.report.status === "open" && rep.report.reason === "spam", rep.report.status);
    const repDup = await fileReport(svc, { listing_id: tmpl.id, reporter_workspace_id: B, reporter_user_id: "u", reason: "abuse", detail: "still bad" });
    check("a second open report from the same workspace is a duplicate", repDup.duplicate && repDup.report.id === rep.report.id, repDup.duplicate);
    // A different workspace can file a distinct report.
    const rep2 = await fileReport(svc, { listing_id: tmpl.id, reporter_workspace_id: T, reporter_user_id: "u", reason: "malware", detail: "bad" });
    track.reports.push(rep2.report.id);
    const trust = await recomputeTrust(svc, tmpl.id);
    check("open reports lower the trust score", trust.trust_score < 100, `${trust.trust_score}`);
    check("the listing's report_count reflects open reports", (await getListing(svc, tmpl.id)).report_count === 2, `${(await getListing(svc, tmpl.id)).report_count}`);

    // Resolve a report as 'suspend' → listing suspended.
    const resolved = await resolveReport(svc, { report_id: rep.report.id, action: "suspend", resolved_by: "admin", note: "spam confirmed" });
    check("resolving a report as suspend suspends the listing", resolved.report.action === "suspend" && (await getListing(svc, tmpl.id)).status === "suspended", (await getListing(svc, tmpl.id)).status);
    await expectThrow("a suspended listing cannot be installed", () => install(svc, { workspace_id: B, listing_id: tmpl.id, consented_capabilities: ["entity:read", "entity:write"], user_id: "u", project: { framework: "preact-htm" } }), "NOT_PUBLISHED");

    // Reinstate.
    const reinstated = await reinstateListing(svc, { listing_id: tmpl.id });
    check("reinstating returns the listing to published", reinstated.listing.status === "published" && !reinstated.duplicate, reinstated.listing.status);

    // Auto-suspend via trust threshold: flood reports from many workspaces to drive trust down.
    // File enough reports from additional scratch workspaces to cross the threshold.
    let floodWs = null;
    for (let i = 0; i < 10; i++) {
      floodWs = await svc.entities.Workspace.create({ name: `mkt-flood-${i}-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
      await fileReport(svc, { listing_id: tmpl.id, reporter_workspace_id: floodWs.id, reporter_user_id: "u", reason: "spam", detail: `flood ${i}` });
      track.reports.push((await listReports(svc, { listing_id: tmpl.id, limit: 200 })).slice(-1)[0]?.id);
      await svc.entities.Workspace.delete(floodWs.id);
    }
    const lowTrust = await recomputeTrust(svc, tmpl.id);
    check("enough reports drive trust below the threshold", lowTrust.trust_score < TRUST_SUSPEND_THRESHOLD, `${lowTrust.trust_score}`);
    const afterFlood = await getListing(svc, tmpl.id);
    check("a listing below the trust threshold is auto-suspended", afterFlood.status === "suspended", afterFlood.status);
    await expectThrow("a trust-suspended listing cannot be installed", () => install(svc, { workspace_id: B, listing_id: tmpl.id, consented_capabilities: ["entity:read", "entity:write"], user_id: "u", project: { framework: "preact-htm" } }), "TRUST_HOLD");

    // Browse hides low-trust listings.
    const browse = await listListings(svc, { kind: "template", status: "published", visibility: "public" });
    check("browse hides low-trust listings", !browse.some((l) => l.id === tmpl.id), "hidden from browse");

    // Reinstate the flooded listing for cleanup.
    await reinstateListing(svc, { listing_id: tmpl.id });

    // ----------------------------------------------------------- removal & isolation
    await removeListing(svc, { workspace_id: O, listing_id: tmpl.id });
    check("a removed listing is not published", (await getListing(svc, tmpl.id)).status === "removed", "removed");
    await expectThrow("a removed listing cannot be edited", () => updateListing(svc, { workspace_id: O, listing_id: tmpl.id, patch: { summary: "x" } }), "LISTING_REMOVED");

    // Cross-workspace install isolation: buyer's installs are invisible to the third workspace.
    const buyerInstalls = await listInstalls(svc, { workspace_id: B });
    const thirdInstalls = await listInstalls(svc, { workspace_id: T });
    check("installs are isolated per workspace", buyerInstalls.length > 0 && thirdInstalls.length === 0, `${buyerInstalls.length} vs ${thirdInstalls.length}`);

    // ----------------------------------------------------------- RBAC
    check("every member may browse and install", can("viewer", "marketplace.read") && can("viewer", "marketplace.install") && can("editor", "marketplace.install"), "member-wide");
    check("publishing requires editor+", can("editor", "marketplace.publish") && can("admin", "marketplace.publish") && !can("viewer", "marketplace.publish"), "editor+");
    check("moderation is admin-only", can("admin", "marketplace.moderate") && !can("editor", "marketplace.moderate") && !can("viewer", "marketplace.moderate"), "admin only");

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    // Scratch cleanup: every record this suite created is removed.
    for (const id of track.reports) await svc.entities.MarketplaceReport.delete(id).catch(() => {});
    for (const id of track.reviews) await svc.entities.MarketplaceReview.delete(id).catch(() => {});
    for (const id of track.installs) await svc.entities.MarketplaceInstall.delete(id).catch(() => {});
    for (const id of track.versions) await svc.entities.MarketplaceVersion.delete(id).catch(() => {});
    for (const id of track.listings) await svc.entities.MarketplaceListing.delete(id).catch(() => {});
    // P-10.2: paid installs now allocate publisher revenue rows; purge this suite's allocations
    // (keyed by publisher and buyer, not by a single workspace_id) alongside its ledger entries.
    await purgeBy(svc, "MarketplaceRevenue", { publisher_workspace_id: ownerWs?.id });
    await purgeBy(svc, "MarketplaceRevenue", { buyer_workspace_id: buyerWs?.id });
    await cleanupWorkspace(svc, ownerWs?.id, ["CreditLedgerEntry"]);
    await cleanupWorkspace(svc, buyerWs?.id, ["CreditLedgerEntry"]);
    await cleanupWorkspace(svc, thirdWs?.id, ["CreditLedgerEntry"]);
    if (ownerWs) await svc.entities.Workspace.delete(ownerWs.id).catch(() => {});
    if (buyerWs) await svc.entities.Workspace.delete(buyerWs.id).catch(() => {});
    if (thirdWs) await svc.entities.Workspace.delete(thirdWs.id).catch(() => {});
  }
}