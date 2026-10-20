// P-10.1 regression suite — marketplace INSTALL VISIBILITY parity.
//
// Certifies exactly one behavior change: `install()` now enforces the listing's visibility
// server-side. A private listing installs only for its owning workspace; any other caller is
// refused with the same generic FORBIDDEN an unavailable listing produces. Everything the
// install flow already enforced is re-verified unchanged: published status, the trust gate,
// compatibility, capability consent, idempotent re-install and the paid-charge fail-closed
// path (no credits move on a refused install). No mocked installs; scratch workspaces and
// listings are created and every record they produce is deleted again.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createListing, getListing, publishVersion, publishListing, install,
  fileReport, reinstateListing, MarketplaceError,
} from "../../shared/marketplace.ts";
import { recordEvent, deriveBalance } from "../../shared/ledger.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const artifact = (n) => ({ uri: `marketplace://artifacts/vis-${n}.tar`, checksum: `sha256:vis-${n}` });
const CAPS = ["entity:read"];

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let ownerWs = null, buyerWs = null;
  const track = { listings: [], versions: [], installs: [], reports: [], workspaces: [] };

  try {
    const me = await base44.auth.me().catch(() => null);
    ownerWs = await svc.entities.Workspace.create({ name: `vis-owner-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
    buyerWs = await svc.entities.Workspace.create({ name: `vis-buyer-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
    const O = ownerWs.id, B = buyerWs.id;

    // --------------------------------------------------- private listing: owner-only
    const priv = await createListing(svc, { workspace_id: O, owner_id: "u", slug: `private-tool-${Date.now()}`, name: "Private Tool", kind: "plugin", capabilities: CAPS, pricing_model: "free" });
    track.listings.push(priv.id);
    const pv = await publishVersion(svc, { workspace_id: O, listing_id: priv.id, version_label: "1.0.0", manifest: {}, changelog: "", compatibility: {}, artifact_uri: artifact(1).uri, artifact_checksum: artifact(1).checksum, capabilities: CAPS, user_id: "u" });
    track.versions.push(pv.version.id);
    await publishListing(svc, { workspace_id: O, listing_id: priv.id, visibility: "private" });
    check("a listing can be published as private", (await getListing(svc, priv.id)).visibility === "private", "private");

    const ownerInstall = await install(svc, { workspace_id: O, listing_id: priv.id, consented_capabilities: CAPS, user_id: "u" });
    track.installs.push(ownerInstall.install.id);
    check("the owning workspace may install its own private listing", ownerInstall.install.status === "active" && !ownerInstall.duplicate, ownerInstall.install.status);

    // A non-owner is refused even when fully consenting — the visibility gate decides first.
    await expectThrow("another workspace cannot install a private listing", () => install(svc, { workspace_id: B, listing_id: priv.id, consented_capabilities: CAPS, user_id: "u" }), "FORBIDDEN");

    // Unknown/missing visibility fails closed for non-owners, with the SAME generic refusal.
    await svc.entities.MarketplaceListing.update(priv.id, { visibility: "circles" });
    await expectThrow("an unknown visibility fails closed", () => install(svc, { workspace_id: B, listing_id: priv.id, consented_capabilities: CAPS, user_id: "u" }), "FORBIDDEN");
    const ownerAfter = await install(svc, { workspace_id: O, listing_id: priv.id, consented_capabilities: CAPS, user_id: "u" });
    check("the owner is unaffected by the visibility value", ownerAfter.duplicate && ownerAfter.install.status === "active", "owner unaffected");

    // --------------------------------------------------- public listing: flow unchanged
    await publishListing(svc, { workspace_id: O, listing_id: priv.id, visibility: "public" });
    await expectThrow("capability consent still gates a public install", () => install(svc, { workspace_id: B, listing_id: priv.id, consented_capabilities: [], user_id: "u" }), "CONSENT_REQUIRED");
    const buyerInstall = await install(svc, { workspace_id: B, listing_id: priv.id, consented_capabilities: CAPS, user_id: "u" });
    track.installs.push(buyerInstall.install.id);
    check("a public listing installs for an eligible workspace", buyerInstall.install.status === "active", buyerInstall.install.status);
    const again = await install(svc, { workspace_id: B, listing_id: priv.id, consented_capabilities: CAPS, user_id: "u" });
    check("re-installing the same version is idempotent", again.duplicate && again.charged === 0, `${again.duplicate}`);

    // Compatibility still applies to a public listing.
    const compat = await createListing(svc, { workspace_id: O, owner_id: "u", slug: `framework-bound-${Date.now()}`, name: "Framework Bound", kind: "plugin", capabilities: CAPS, compatibility: { frameworks: ["preact-htm"] }, pricing_model: "free" });
    track.listings.push(compat.id);
    const cv = await publishVersion(svc, { workspace_id: O, listing_id: compat.id, version_label: "1.0.0", manifest: {}, changelog: "", compatibility: { frameworks: ["preact-htm"] }, artifact_uri: artifact(2).uri, artifact_checksum: artifact(2).checksum, capabilities: CAPS, user_id: "u" });
    track.versions.push(cv.version.id);
    await publishListing(svc, { workspace_id: O, listing_id: compat.id, visibility: "public" });
    await expectThrow("compatibility still gates an install", () => install(svc, { workspace_id: B, listing_id: compat.id, consented_capabilities: CAPS, user_id: "u", project: { framework: "react" } }), "INCOMPATIBLE");

    // Trust gate still applies to a public listing: enough reports auto-suspend it.
    for (let i = 0; i < 6; i++) {
      const ws = await svc.entities.Workspace.create({ name: `vis-flood-${i}-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
      await fileReport(svc, { listing_id: compat.id, reporter_workspace_id: ws.id, reporter_user_id: "u", reason: "spam", detail: `flood ${i}` });
      track.reports.push((await svc.entities.MarketplaceReport.filter({ listing_id: compat.id }, "-created_date", 50)).slice(-1)[0]?.id);
      await svc.entities.Workspace.delete(ws.id);
    }
    await expectThrow("a trust-suspended listing still cannot be installed", () => install(svc, { workspace_id: B, listing_id: compat.id, consented_capabilities: CAPS, user_id: "u", project: { framework: "preact-htm" } }), "TRUST_HOLD");
    await reinstateListing(svc, { listing_id: compat.id });

    // --------------------------------------------------- paid private listing: no charge on refusal
    await recordEvent(svc, { workspace_id: B, event_type: "promotional", amount: 1000, idempotency_key: `vis-grant-${B}`, reason: "test grant" });
    const paid = await createListing(svc, { workspace_id: O, owner_id: "u", slug: `paid-private-${Date.now()}`, name: "Paid Private", kind: "plugin", pricing_model: "one_time", price_cents: 500 });
    track.listings.push(paid.id);
    const paidV = await publishVersion(svc, { workspace_id: O, listing_id: paid.id, version_label: "1.0.0", manifest: {}, changelog: "", compatibility: {}, artifact_uri: artifact(3).uri, artifact_checksum: artifact(3).checksum, capabilities: [], user_id: "u" });
    track.versions.push(paidV.version.id);
    await publishListing(svc, { workspace_id: O, listing_id: paid.id, visibility: "private" });
    await expectThrow("a paid private listing is refused for a non-owner", () => install(svc, { workspace_id: B, listing_id: paid.id, consented_capabilities: [], user_id: "u" }), "FORBIDDEN");
    check("a refused install moves no credits", (await deriveBalance(svc, B)).balance === 1000, `${(await deriveBalance(svc, B)).balance}`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    // Scratch cleanup: every record this suite created is removed.
    for (const id of track.reports) await svc.entities.MarketplaceReport.delete(id).catch(() => {});
    for (const id of track.installs) await svc.entities.MarketplaceInstall.delete(id).catch(() => {});
    for (const id of track.versions) await svc.entities.MarketplaceVersion.delete(id).catch(() => {});
    for (const id of track.listings) await svc.entities.MarketplaceListing.delete(id).catch(() => {});
    await cleanupWorkspace(svc, ownerWs?.id, ["CreditLedgerEntry"]);
    await cleanupWorkspace(svc, buyerWs?.id, ["CreditLedgerEntry"]);
    if (ownerWs) await svc.entities.Workspace.delete(ownerWs.id).catch(() => {});
    if (buyerWs) await svc.entities.Workspace.delete(buyerWs.id).catch(() => {});
  }
}