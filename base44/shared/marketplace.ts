// Marketplace / ecosystem: listings, immutable versioning, installs, compatibility,
// reviews, abuse reports and trust scoring.
//
// SECURITY MODEL:
//   • every write resolves the caller's workspace role SERVER-SIDE; a client never states its own
//     role, a listing's owner, or an install's capabilities;
//   • a published version is IMMUTABLE — a re-publish is a new version, never a silent overwrite,
//     so an install always resolves to exactly the artifact that was reviewed;
//   • capabilities are granted only at install time after explicit consent; a later version that
//     requests MORE capabilities requires re-consent, never silent escalation;
//   • paid installs charge the buyer's ledger idempotently and fail closed if the buyer cannot
//     afford the price — an install is never free because the charge failed;
//   • trust is DERIVED from reports, reviews and install growth, never written by a client; a
//     listing below the trust threshold is hidden from browse and blocked from new installs.
import { recordEvent, deriveBalance } from "./ledger.ts";
import { checkBudget } from "./budget.ts";
import { entitlementsFor, getPlan } from "./billing.ts";
import { loadCreditPolicy } from "./economics.ts";
// P-10.2 publisher revenue accounting: allocation, refund reversal and the publisher read view.
import { recordPublisherRevenue } from "./marketplaceRevenue.ts";

export class MarketplaceError extends Error {
  constructor(message, code = "MARKETPLACE_ERROR", status = 400, detail = null) {
    super(message); this.code = code; this.status = status; this.detail = detail;
  }
}

const KINDS = ["template", "integration", "agent", "component", "plugin", "workflow"];
const TRUST_SUSPEND_THRESHOLD = 30;
const REPORT_WEIGHT = 12;      // each open report lowers trust by this
const RATING_WEIGHT = 4;       // each star below 5 lowers trust by this
const VERIFIED_REVIEW_WEIGHT = 2;

const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const num = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);

// --------------------------------------------------------------- listings

export const validateSlug = (slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length >= 2 && slug.length <= 60;

export async function getListing(svc, id) {
  return svc.entities.MarketplaceListing.get(id).catch(() => null);
}

export async function getListingBySlug(svc, slug) {
  const rows = await svc.entities.MarketplaceListing.filter({ slug }, "-updated_date", 5);
  return rows[0] || null;
}

export async function listListings(svc, { kind = null, category = null, status = "published", visibility = "public", q = null, sort = "-install_count", limit = 50, owner_workspace_id = null, tags = null } = {}) {
  const query = {};
  if (status) query.status = status;
  if (visibility) query.visibility = visibility;
  if (kind) query.kind = kind;
  if (category) query.category = category;
  if (owner_workspace_id) query.workspace_id = owner_workspace_id;
  let rows = await svc.entities.MarketplaceListing.filter(query, sort, Math.min(Math.max(limit, 1), 200));
  // Trust gate: anything below the threshold is hidden from public browse, even if published.
  if (status === "published" && visibility === "public") {
    rows = rows.filter((r) => (r.trust_score ?? 100) >= TRUST_SUSPEND_THRESHOLD);
  }
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => (r.name || "").toLowerCase().includes(needle) || (r.summary || "").toLowerCase().includes(needle) || (r.tags || []).some((t) => String(t).toLowerCase().includes(needle)));
  }
  // Tag filter is conjunctive: every requested tag must be present, so narrowing a search really
  // narrows it instead of widening to any match.
  const wanted = (Array.isArray(tags) ? tags : tags ? [tags] : []).map((t) => String(t).toLowerCase()).filter(Boolean);
  if (wanted.length) {
    rows = rows.filter((r) => {
      const have = new Set((r.tags || []).map((t) => String(t).toLowerCase()));
      return wanted.every((t) => have.has(t));
    });
  }
  return rows;
}

export async function createListing(svc, { workspace_id, owner_id, slug, name, kind, summary = "", description = "", category = "", tags = [], capabilities = [], compatibility = {}, pricing_model = "free", price_cents = 0, currency = "USD" }) {
  if (!KINDS.includes(kind)) throw new MarketplaceError(`Unknown kind "${kind}"`, "UNKNOWN_KIND", 400);
  const cleanSlug = slugify(slug);
  if (!validateSlug(cleanSlug)) throw new MarketplaceError("Slug must be 2-60 lowercase kebab-case chars", "INVALID_SLUG", 400);
  const existing = await getListingBySlug(svc, cleanSlug);
  if (existing) throw new MarketplaceError(`Slug "${cleanSlug}" is already taken`, "SLUG_TAKEN", 409);
  if (pricing_model !== "free" && num(price_cents) <= 0) throw new MarketplaceError("Paid listings require a positive price", "INVALID_PRICE", 400);
  return svc.entities.MarketplaceListing.create({
    workspace_id, owner_id, slug: cleanSlug, name, kind, summary, description, category, tags, capabilities,
    compatibility, visibility: "private", status: "draft", current_version_number: 0,
    pricing_model, price_cents: num(price_cents), currency,
    install_count: 0, rating_avg: 0, rating_count: 0, review_count: 0, report_count: 0, trust_score: 100,
  });
}

export async function updateListing(svc, { workspace_id, listing_id, patch }) {
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.workspace_id !== workspace_id) throw new MarketplaceError("Only the owning workspace may edit this listing", "FORBIDDEN", 403);
  if (listing.status === "removed") throw new MarketplaceError("A removed listing cannot be edited", "LISTING_REMOVED", 409);
  // Immutable fields after publish: slug and kind are frozen once published.
  const frozen = listing.status === "published";
  const allowed = {};
  for (const k of ["name", "summary", "description", "category", "tags", "compatibility"]) if (k in patch) allowed[k] = patch[k];
  if (!frozen && "kind" in patch) allowed.kind = patch.kind;
  return svc.entities.MarketplaceListing.update(listing_id, allowed);
}

export async function removeListing(svc, { workspace_id, listing_id }) {
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.workspace_id !== workspace_id) throw new MarketplaceError("Only the owning workspace may remove this listing", "FORBIDDEN", 403);
  return svc.entities.MarketplaceListing.update(listing_id, { status: "removed" });
}

// --------------------------------------------------------------- versions

export async function listVersions(svc, { listing_id, include_yanked = true }) {
  const rows = await svc.entities.MarketplaceVersion.filter({ listing_id }, "-version_number", 100);
  return include_yanked ? rows : rows.filter((v) => v.status !== "yanked");
}

export async function getVersion(svc, id) {
  return svc.entities.MarketplaceVersion.get(id).catch(() => null);
}

/**
 * Publishes an immutable version. The artifact checksum makes a re-publish of changed content a
 * NEW version; the version becomes the listing's current version only when the listing itself is
 * published. A version is never edited after publish — it is yanked instead.
 */
export async function publishVersion(svc, { workspace_id, listing_id, version_label, manifest, changelog = "", compatibility = {}, artifact_uri, artifact_checksum, capabilities = [], user_id = null }) {
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.workspace_id !== workspace_id) throw new MarketplaceError("Only the owning workspace may publish versions", "FORBIDDEN", 403);
  if (listing.status === "removed") throw new MarketplaceError("A removed listing cannot publish", "LISTING_REMOVED", 409);
  if (!artifact_uri || !artifact_checksum) throw new MarketplaceError("An immutable artifact reference and checksum are required", "MISSING_ARTIFACT", 400);

  const versions = await svc.entities.MarketplaceVersion.filter({ listing_id }, "-version_number", 1);
  const version_number = (versions[0]?.version_number || 0) + 1;

  // Idempotent publish: the same checksum re-published with the same label returns the existing
  // version instead of creating a duplicate.
  const existing = (await svc.entities.MarketplaceVersion.filter({ listing_id, artifact_checksum }, "-version_number", 5))
    .find((v) => v.status === "published");
  if (existing) return { version: existing, duplicate: true };

  const versionCaps = Array.isArray(capabilities) ? capabilities : [];
  const created = await svc.entities.MarketplaceVersion.create({
    listing_id, workspace_id, version_number, version_label: String(version_label || `v${version_number}`),
    manifest: manifest || {}, changelog, compatibility, artifact_uri, artifact_checksum,
    capabilities: versionCaps, status: "published",
    published_at: new Date().toISOString(), published_by: user_id || null, install_count: 0,
  });
  // The newest published version becomes current, and the listing's capability set tracks the
  // current version so install-time consent reflects what this version actually requests.
  await svc.entities.MarketplaceListing.update(listing_id, {
    current_version_id: created.id, current_version_number: version_number,
    capabilities: versionCaps, compatibility: { ...(listing.compatibility || {}), ...compatibility },
  });
  return { version: created, duplicate: false };
}

export async function yankVersion(svc, { workspace_id, listing_id, version_id, reason = null }) {
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.workspace_id !== workspace_id) throw new MarketplaceError("Only the owning workspace may yank versions", "FORBIDDEN", 403);
  const version = await getVersion(svc, version_id);
  if (!version || version.listing_id !== listing_id) throw new MarketplaceError("Version not found for this listing", "NOT_FOUND", 404);
  if (version.status === "yanked") return { version, duplicate: true };
  await svc.entities.MarketplaceVersion.update(version_id, { status: "yanked", yanked_at: new Date().toISOString(), yanked_reason: reason || "Yanked by owner" });
  // If the yanked version was current, roll current back to the newest remaining published version.
  if (listing.current_version_id === version_id) {
    const remaining = (await svc.entities.MarketplaceVersion.filter({ listing_id, status: "published" }, "-version_number", 1))[0];
    await svc.entities.MarketplaceListing.update(listing_id, {
      current_version_id: remaining?.id || null, current_version_number: remaining?.version_number || 0,
    });
  }
  return { version: await getVersion(svc, version_id), duplicate: false };
}

/**
 * Flips a listing to published and public. Requires at least one published version; a listing
 * with no installable version cannot be published.
 */
export async function publishListing(svc, { workspace_id, listing_id, visibility = "public", user_id = null }) {
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.workspace_id !== workspace_id) throw new MarketplaceError("Only the owning workspace may publish", "FORBIDDEN", 403);
  if (listing.status === "removed") throw new MarketplaceError("A removed listing cannot be published", "LISTING_REMOVED", 409);
  if (!["public", "unlisted", "private"].includes(visibility)) throw new MarketplaceError("Invalid visibility", "INVALID_VISIBILITY", 400);
  const current = listing.current_version_id ? await getVersion(svc, listing.current_version_id) : null;
  if (!current || current.status !== "published") throw new MarketplaceError("Publish at least one version first", "NO_PUBLISHED_VERSION", 409);
  const updated = await svc.entities.MarketplaceListing.update(listing_id, { status: "published", visibility, listed_at: new Date().toISOString() });
  return { listing: updated, version: current };
}

// --------------------------------------------------------------- compatibility

/**
 * Checks whether a listing/version is compatible with the installer's project and plan.
 * Returns every violation rather than the first, so the UI can explain the full refusal.
 */
export async function checkCompatibility(svc, { listing, version, project = null, plan = null }) {
  const violations = [];
  const compat = { ...(listing?.compatibility || {}), ...(version?.compatibility || {}) };
  const frameworks = compat.frameworks || [];
  if (project && frameworks.length && !frameworks.includes(project.framework)) {
    violations.push({ code: "FRAMEWORK_MISMATCH", required: frameworks, actual: project.framework, message: `This listing requires one of: ${frameworks.join(", ")}` });
  }
  const minTier = num(compat.min_plan_tier, 0);
  if (minTier > 0 && plan) {
    if (num(plan.tier_rank, 0) < minTier) {
      violations.push({ code: "PLAN_TOO_LOW", required: minTier, actual: plan.tier_rank, message: `This listing requires a plan tier >= ${minTier}` });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The set of capabilities a version requests that the installer has NOT already granted for this
 * listing. Non-empty means the upgrade requires explicit re-consent.
 */
export function newCapabilities(existing_granted, requested) {
  const have = new Set(existing_granted || []);
  return (requested || []).filter((c) => !have.has(c));
}

// --------------------------------------------------------------- installs

export async function listInstalls(svc, { workspace_id, project_id = null, listing_id = null }) {
  const query = { workspace_id };
  if (project_id) query.project_id = project_id;
  if (listing_id) query.listing_id = listing_id;
  return svc.entities.MarketplaceInstall.filter(query, "-installed_at", 200);
}

export async function getInstall(svc, id) {
  return svc.entities.MarketplaceInstall.get(id).catch(() => null);
}

/**
 * Installs a listing version. Enforces compatibility, capability consent and (for paid listings)
 * an idempotent ledger charge that fails closed if the buyer cannot afford the price.
 */
export async function install(svc, { workspace_id, project_id = null, listing_id, version_id = null, config = {}, consented_capabilities = [], user_id = null, project = null }) {
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  // Trust is checked BEFORE status so a trust-driven suspension reports TRUST_HOLD (the specific
  // reason new installs are blocked) rather than the generic NOT_PUBLISHED.
  if ((listing.trust_score ?? 100) < TRUST_SUSPEND_THRESHOLD) throw new MarketplaceError("This listing is under trust review and cannot be installed", "TRUST_HOLD", 423);
  if (listing.status !== "published") throw new MarketplaceError("This listing is not published", "NOT_PUBLISHED", 409);
  // Visibility parity (P-10.1). A listing is installable by ANOTHER workspace only when it is
  // public (unlisted keeps its install-by-link behavior, exactly as before). A PRIVATE listing
  // installs for its owning workspace alone; an unknown/missing visibility fails closed. The
  // refusal is one generic authorization failure, so a refused caller cannot distinguish a
  // private listing from an unavailable one.
  const visibility = String(listing.visibility || "");
  if (listing.workspace_id !== workspace_id && visibility !== "public" && visibility !== "unlisted") {
    throw new MarketplaceError("This listing is not available to your workspace", "FORBIDDEN", 403);
  }

  const version = version_id ? await getVersion(svc, version_id) : (listing.current_version_id ? await getVersion(svc, listing.current_version_id) : null);
  if (!version || version.listing_id !== listing_id) throw new MarketplaceError("Version not found for this listing", "NOT_FOUND", 404);
  if (version.status !== "published") throw new MarketplaceError("This version is not installable", "VERSION_NOT_INSTALLABLE", 409);

  // Compatibility is checked against the installer's project and plan, never trusted from client.
  const plan = await planForWorkspace(svc, workspace_id);
  const compat = await checkCompatibility(svc, { listing, version, project, plan });
  if (!compat.ok) throw new MarketplaceError("Incompatible with your project or plan", "INCOMPATIBLE", 409, { violations: compat.violations });

  // One active install per (workspace, project, listing). Re-installing the same version is a
  // no-op; installing a different version UPDATES the existing install in place (never a second
  // row), so an upgrade/downgrade is atomic and the install count stays correct.
  const existing = (await svc.entities.MarketplaceInstall.filter({ workspace_id, listing_id, project_id: project_id || null, status: "active" }, "-installed_at", 1))[0];
  if (existing) {
    if (existing.version_id === version.id) return { install: existing, duplicate: true, charged: 0 };
    // Upgrade: require re-consent for any NEW capabilities the new version requests.
    const newCaps = newCapabilities(existing.capabilities_granted, version.capabilities || listing.capabilities);
    if (newCaps.length && !newCaps.every((c) => consented_capabilities.includes(c))) {
      throw new MarketplaceError(`This version requests new capabilities: ${newCaps.join(", ")}. Re-consent required.`, "RECONSENT_REQUIRED", 409, { new_capabilities: newCaps });
    }
  }

  // Capability consent: every requested capability must be in the consented set.
  const requested = (version.capabilities?.length ? version.capabilities : (listing.capabilities || []));
  const missing = requested.filter((c) => !consented_capabilities.includes(c));
  if (missing.length) throw new MarketplaceError(`Consent required for: ${missing.join(", ")}`, "CONSENT_REQUIRED", 409, { requested, missing });

  // Paid install: idempotent ledger charge. The key is scoped to the install, so a retried install
  // never double-charges; an unaffordable install is refused before any record is created.
  let charged = 0;
  if (listing.pricing_model !== "free" && num(listing.price_cents) > 0) {
    const policy = await loadCreditPolicy(svc, workspace_id);
    const credits = Math.max(1, Math.round((num(listing.price_cents) / 100) * policy.credits_per_usd));
    const budget = await checkBudget(svc, { workspace_id, user_id, project_id, credits });
    if (!budget.ok) throw new MarketplaceError("Insufficient credits to install this listing", "INSUFFICIENT_CREDITS", 402, { violations: budget.violations });
    const purchase_key = `marketplace:install:${workspace_id}:${listing_id}:${version.id}`;
    const res = await recordEvent(svc, {
      workspace_id, user_id, project_id, event_type: "purchase", amount: -credits,
      idempotency_key: purchase_key,
      reason: `Marketplace install: ${listing.name} v${version.version_number}`, metadata: { listing_id, version_id: version.id, listing_slug: listing.slug },
    });
    charged = -res.entry.amount;
    // P-10.2: publisher revenue allocation, keyed to the purchase it derives from. The buyer's
    // entry is never touched; a replay converges on the existing allocation. A failure here fails
    // the install exactly like a charge failure does, and the retry re-converges — the charge
    // replays idempotently and the allocation is keyed to it.
    await recordPublisherRevenue(svc, {
      listing, version, buyer_workspace_id: workspace_id, buyer_user_id: user_id || null,
      gross_credits: charged, purchase_key, purchase_ledger_entry_id: res.entry.id,
    });
  }

  // An upgrade/downgrade updates the existing install in place; a first install creates the row.
  // Either way there is exactly one active install per (workspace, project, listing).
  let install_row;
  if (existing) {
    install_row = await svc.entities.MarketplaceInstall.update(existing.id, {
      version_id: version.id, version_number: version.version_number, config, capabilities_granted: consented_capabilities,
      status: "active", installed_at: new Date().toISOString(),
    });
  } else {
    install_row = await svc.entities.MarketplaceInstall.create({
      workspace_id, project_id: project_id || null, listing_id, version_id: version.id, version_number: version.version_number,
      status: "active", installed_by: user_id || null, config, capabilities_granted: consented_capabilities,
      installed_at: new Date().toISOString(),
    });
    await svc.entities.MarketplaceVersion.update(version.id, { install_count: (version.install_count || 0) + 1 });
  }
  await recomputeInstallCount(svc, listing_id);
  return { install: install_row, duplicate: false, charged };
}

export async function uninstall(svc, { workspace_id, install_id }) {
  const install = await getInstall(svc, install_id);
  if (!install) throw new MarketplaceError("Install not found", "NOT_FOUND", 404);
  if (install.workspace_id !== workspace_id) throw new MarketplaceError("Only the installing workspace may uninstall", "FORBIDDEN", 403);
  if (install.status === "uninstalled") return { install, duplicate: true };
  const updated = await svc.entities.MarketplaceInstall.update(install_id, { status: "uninstalled", uninstalled_at: new Date().toISOString() });
  await recomputeInstallCount(svc, install.listing_id);
  return { install: updated, duplicate: false };
}

export async function disableInstall(svc, { workspace_id, install_id, reason = null }) {
  const install = await getInstall(svc, install_id);
  if (!install) throw new MarketplaceError("Install not found", "NOT_FOUND", 404);
  if (install.workspace_id !== workspace_id) throw new MarketplaceError("Only the installing workspace may disable an install", "FORBIDDEN", 403);
  return svc.entities.MarketplaceInstall.update(install_id, { status: "disabled" });
}

// --------------------------------------------------------------- reviews

export async function listReviews(svc, { listing_id, include_hidden = false }) {
  const rows = await svc.entities.MarketplaceReview.filter({ listing_id }, "-created_date", 200);
  return include_hidden ? rows : rows.filter((r) => r.status === "visible");
}

/**
 * Posts or updates a review. One review per workspace per listing — a workspace is the review
 * identity, so a user cannot inflate ratings by posting many. A verified-install flag is set when
 * the reviewing workspace has an active install.
 */
export async function postReview(svc, { listing_id, workspace_id, user_id, rating, title = "", body = "" }) {
  const r = Math.round(num(rating, 0));
  if (r < 1 || r > 5) throw new MarketplaceError("Rating must be between 1 and 5", "INVALID_RATING", 400);
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.workspace_id === workspace_id) throw new MarketplaceError("You cannot review your own listing", "SELF_REVIEW", 409);
  const installs = await svc.entities.MarketplaceInstall.filter({ workspace_id, listing_id, status: "active" }, "-installed_at", 1);
  const verified = installs.length > 0;
  const existing = (await svc.entities.MarketplaceReview.filter({ listing_id, workspace_id }, "-created_date", 1))[0];
  const payload = { rating: r, title: String(title).slice(0, 120), body: String(body).slice(0, 4000), status: "visible", verified_install: verified, user_id };
  const review = existing
    ? await svc.entities.MarketplaceReview.update(existing.id, payload)
    : await svc.entities.MarketplaceReview.create({ listing_id, workspace_id, user_id, ...payload });
  await recomputeRating(svc, listing_id);
  return { review, verified };
}

export async function recomputeRating(svc, listing_id) {
  const reviews = await svc.entities.MarketplaceReview.filter({ listing_id, status: "visible" }, "-created_date", 5000);
  const count = reviews.length;
  const avg = count ? Math.round((reviews.reduce((s, r) => s + num(r.rating), 0) / count) * 10) / 10 : 0;
  await svc.entities.MarketplaceListing.update(listing_id, { rating_avg: avg, rating_count: count, review_count: count });
  return { avg, count };
}

// --------------------------------------------------------------- reports & trust

export async function fileReport(svc, { listing_id, reporter_workspace_id, reporter_user_id, reason, detail = "", version_id = null, review_id = null }) {
  const valid = ["spam", "abuse", "malware", "ip_infringement", "data_theft", "other"];
  if (!valid.includes(reason)) throw new MarketplaceError("Invalid report reason", "INVALID_REASON", 400);
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.workspace_id === reporter_workspace_id) throw new MarketplaceError("You cannot report your own listing", "SELF_REPORT", 409);
  // One open report per workspace per listing: a second report before resolution is a duplicate.
  const open = (await svc.entities.MarketplaceReport.filter({ listing_id, reporter_workspace_id, status: ["open", "reviewing"] }, "-created_date", 5))
    .find((r) => r.status === "open" || r.status === "reviewing");
  if (open) return { report: open, duplicate: true };
  const report = await svc.entities.MarketplaceReport.create({
    listing_id, version_id: version_id || null, review_id: review_id || null,
    reporter_workspace_id, reporter_user_id, reason, detail: String(detail).slice(0, 2000), status: "open", action: "none",
  });
  await recomputeTrust(svc, listing_id);
  return { report, duplicate: false };
}

export async function resolveReport(svc, { report_id, action, resolved_by, note = "" }) {
  const report = await svc.entities.MarketplaceReport.get(report_id).catch(() => null);
  if (!report) throw new MarketplaceError("Report not found", "NOT_FOUND", 404);
  if (!["none", "warning", "suspend", "remove"].includes(action)) throw new MarketplaceError("Invalid action", "INVALID_ACTION", 400);
  const updated = await svc.entities.MarketplaceReport.update(report_id, { status: "actioned", action, resolved_by, resolved_at: new Date().toISOString(), resolution_note: String(note).slice(0, 1000) });
  const listing = await getListing(svc, report.listing_id);
  if (listing) {
    if (action === "suspend") await suspendListing(svc, { listing_id: report.listing_id, reason: `Suspended by moderation: ${report.reason}` });
    if (action === "remove") await svc.entities.MarketplaceListing.update(report.listing_id, { status: "removed" });
    await recomputeTrust(svc, report.listing_id);
  }
  return { report: updated };
}

export async function listReports(svc, { status = null, listing_id = null, limit = 100 }) {
  const query = {};
  if (status) query.status = status;
  if (listing_id) query.listing_id = listing_id;
  return svc.entities.MarketplaceReport.filter(query, "-created_date", Math.min(limit, 200));
}

/**
 * Derives the trust score from open reports and rating, then auto-suspends a listing that falls
 * below the threshold. The score is never written by a client.
 */
export async function recomputeTrust(svc, listing_id) {
  const listing = await getListing(svc, listing_id);
  if (!listing) return { trust_score: 0 };
  const openReports = await svc.entities.MarketplaceReport.filter({ listing_id, status: "open" }, "-created_date", 500);
  const reviews = await svc.entities.MarketplaceReview.filter({ listing_id, status: "visible" }, "-created_date", 500);
  let score = 100;
  score -= openReports.length * REPORT_WEIGHT;
  for (const r of reviews) {
    const below = Math.max(0, 5 - num(r.rating));
    score -= below * RATING_WEIGHT * (r.verified_install ? VERIFIED_REVIEW_WEIGHT : 1);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  await svc.entities.MarketplaceListing.update(listing_id, { trust_score: score, report_count: openReports.length });
  // Auto-suspend: a listing below the threshold is pulled from browse and blocked from new installs.
  if (score < TRUST_SUSPEND_THRESHOLD && listing.status === "published") {
    await svc.entities.MarketplaceListing.update(listing_id, { status: "suspended", suspended_reason: "Automatically suspended: trust score below threshold" });
  }
  return { trust_score: score };
}

export async function suspendListing(svc, { listing_id, reason }) {
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  return svc.entities.MarketplaceListing.update(listing_id, { status: "suspended", suspended_reason: String(reason || "Suspended by moderation").slice(0, 500) });
}

export async function reinstateListing(svc, { listing_id }) {
  const listing = await getListing(svc, listing_id);
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.status !== "suspended") return { listing, duplicate: true };
  const updated = await svc.entities.MarketplaceListing.update(listing_id, { status: "published", suspended_reason: null, trust_score: 100 });
  return { listing: updated, duplicate: false };
}

// --------------------------------------------------------------- aggregates

export async function recomputeInstallCount(svc, listing_id) {
  const installs = await svc.entities.MarketplaceInstall.filter({ listing_id, status: "active" }, "-installed_at", 5000);
  await svc.entities.MarketplaceListing.update(listing_id, { install_count: installs.length });
  return installs.length;
}

async function planForWorkspace(svc, workspace_id) {
  const ent = await entitlementsFor(svc, workspace_id).catch(() => null);
  if (!ent?.plan_code) return null;
  return getPlan(svc, ent.plan_code).catch(() => null);
}

export { TRUST_SUSPEND_THRESHOLD, KINDS };