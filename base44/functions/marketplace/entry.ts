// Marketplace control plane: listings, versions, installs, reviews, reports, moderation.
//
// SECURITY MODEL:
//   • the caller's workspace role is resolved SERVER-SIDE on every request; the client never
//     states its own role, a listing's owner, or an install's granted capabilities;
//   • publishing and yanking require marketplace.publish (editor+); moderation requires
//     marketplace.moderate (admin+); browsing, installing and reviewing are member-wide;
//   • cross-workspace writes are impossible: every write is scoped to the caller's workspace and
//     the server re-checks ownership before touching a listing or version.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { audit } from "../../shared/authz.ts";
import { resolveRole, requireCapability, capabilitiesFor, requireActiveWorkspace } from "../../shared/rbac.ts";
import { enforceLimit, identityFor } from "../../shared/apiLimits.ts";
import {
  MarketplaceError, KINDS, getListing, getListingBySlug, listListings, createListing, updateListing, removeListing,
  publishVersion, yankVersion, listVersions, getVersion, publishListing,
  install, uninstall, listInstalls, getInstall,
  postReview, listReviews,
  fileReport, resolveReport, listReports, recomputeTrust, suspendListing, reinstateListing,
} from "../../shared/marketplace.ts";
import { publishProjectVersion, installTemplateAsProject, recordListingView, creatorMetrics } from "../../shared/marketplacePublish.ts";
// P-10.2 publisher revenue: the publisher read view and the refund reversal.
import { listPublisherRevenue, refundInstall } from "../../shared/marketplaceRevenue.ts";

const WRITES = ["create", "update", "remove", "publish_version", "publish_project", "publish_listing", "yank", "install", "install_as_project", "uninstall", "refund_install", "review", "report", "resolve_report", "suspend", "reinstate"];
const num = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);

const safeListing = (l, { admin = false } = {}) => ({
  id: l.id, workspace_id: l.workspace_id, slug: l.slug, name: l.name, summary: l.summary, description: l.description,
  kind: l.kind, visibility: l.visibility, status: l.status, category: l.category, tags: l.tags || [],
  capabilities: l.capabilities || [], compatibility: l.compatibility || {},
  pricing_model: l.pricing_model, price_cents: l.price_cents, currency: l.currency,
  current_version_id: l.current_version_id || null, current_version_number: l.current_version_number || 0,
  install_count: l.install_count || 0, rating_avg: l.rating_avg || 0, rating_count: l.rating_count || 0,
  review_count: l.review_count || 0, report_count: l.report_count || 0, trust_score: l.trust_score ?? 100,
  listed_at: l.listed_at || null, suspended_reason: admin ? l.suspended_reason || null : undefined,
  created_date: l.created_date, updated_date: l.updated_date,
});

const safeVersion = (v) => ({
  id: v.id, listing_id: v.listing_id, version_number: v.version_number, version_label: v.version_label,
  artifact_checksum: v.artifact_checksum, manifest: v.manifest, changelog: v.changelog, compatibility: v.compatibility || {},
  capabilities: v.capabilities || [], status: v.status, published_at: v.published_at, yanked_at: v.yanked_at || null,
  yanked_reason: v.yanked_reason || null, install_count: v.install_count || 0, created_date: v.created_date,
});

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "browse");
    const workspaceId = String(body.workspace_id || "");

    // Public read surfaces do not require a workspace, but every write does.
    const isRead = ["browse", "get", "get_by_slug", "versions", "reviews"].includes(action);
    let role = null;
    let workspace = null;
    if (workspaceId) {
      workspace = await svc.entities.Workspace.get(workspaceId).catch(() => null);
      if (!workspace && !isRead) return Response.json({ error: "Workspace not found" }, { status: 404 });
      if (workspace) role = await resolveRole(base44, workspace, user);
      if (workspace && !role) return Response.json({ error: "Forbidden", code: "NOT_A_MEMBER" }, { status: 403 });
    } else if (!isRead) {
      return Response.json({ error: "workspace_id is required" }, { status: 400 });
    }

    // G-2 lifecycle: a suspended/terminated workspace stays browsable and readable, but
    // publishing, installing and moderating fail closed.
    if (WRITES.includes(action)) requireActiveWorkspace(workspace);

    if (WRITES.includes(action)) {
      await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspaceId }), action: "billing_write", workspace_id: workspaceId });
    }

    // --------------------------------------------------------------- read
    if (action === "browse") {
      const rows = await listListings(svc, {
        kind: body.kind || null, category: body.category || null, status: "published", visibility: "public",
        q: body.q || null, sort: body.sort || "-install_count", limit: num(body.limit, 50),
        tags: Array.isArray(body.tags) ? body.tags : null,
        // Creator filter. Browse only ever serves PUBLISHED + PUBLIC rows, so filtering by creator
        // narrows public discovery — it can never surface another workspace's private listings.
        owner_workspace_id: body.creator_workspace_id || null,
      });
      return Response.json({ listings: rows.map((l) => safeListing(l)) });
    }

    // The caller's OWN listings, at any status/visibility — the manage surface. Scoped to the
    // caller's workspace, so it is never a way to enumerate someone else's drafts.
    if (action === "my_listings") {
      requireCapability(role, "marketplace.read");
      const rows = await listListings(svc, {
        status: body.status || null, visibility: null, kind: body.kind || null,
        q: body.q || null, sort: body.sort || "-updated_date", limit: num(body.limit, 100),
        owner_workspace_id: workspaceId,
      });
      return Response.json({ listings: rows.filter((l) => l.status !== "removed" || body.status === "removed").map((l) => safeListing(l, { admin: true })) });
    }

    if (action === "creator_metrics") {
      requireCapability(role, "marketplace.publish");
      return Response.json(await creatorMetrics(svc, workspaceId));
    }

    if (action === "get" || action === "get_by_slug") {
      const listing = action === "get" ? await getListing(svc, String(body.listing_id || "")) : await getListingBySlug(svc, String(body.slug || ""));
      if (!listing) return Response.json({ error: "Listing not found" }, { status: 404 });
      const isOwner = !!role && listing.workspace_id === workspaceId;
      // Visibility is a conjunction, not a disjunction: a listing is reachable by a non-owner ONLY
      // when it is published AND its visibility permits direct access. 'unlisted' is reachable by
      // direct id/slug but never appears in browse; 'private' is reachable by the owning workspace
      // alone, so a guessed slug reveals nothing.
      const directlyVisible = listing.status === "published" && ["public", "unlisted"].includes(listing.visibility);
      if (!directlyVisible && !isOwner) {
        return Response.json({ error: "Listing not found" }, { status: 404 });
      }
      // Creator analytics: a view of somebody else's listing is what a "view" means.
      if (!isOwner) await recordListingView(svc, listing);
      return Response.json({ listing: safeListing(listing, { admin: isOwner }) });
    }

    if (action === "versions") {
      const listing = await getListing(svc, String(body.listing_id || ""));
      if (!listing) return Response.json({ error: "Listing not found" }, { status: 404 });
      const isOwner = role && listing.workspace_id === workspaceId;
      const versions = await listVersions(svc, { listing_id: listing.id, include_yanked: isOwner || ["owner", "admin"].includes(role) });
      return Response.json({ versions: versions.map(safeVersion) });
    }

    if (action === "reviews") {
      const listing = await getListing(svc, String(body.listing_id || ""));
      if (!listing) return Response.json({ error: "Listing not found" }, { status: 404 });
      const reviews = await listReviews(svc, { listing_id: listing.id, include_hidden: ["owner", "admin"].includes(role) });
      return Response.json({ reviews: reviews.map((r) => ({ id: r.id, workspace_id: r.workspace_id, rating: r.rating, title: r.title, body: r.body, verified_install: r.verified_install, status: r.status, created_date: r.created_date })) });
    }

    if (action === "my_installs") {
      requireCapability(role, "marketplace.install");
      const installs = await listInstalls(svc, { workspace_id: workspaceId, project_id: body.project_id || null });
      return Response.json({ installs: installs.map((i) => ({ id: i.id, listing_id: i.listing_id, project_id: i.project_id, version_id: i.version_id, version_number: i.version_number, status: i.status, config: i.config, capabilities_granted: i.capabilities_granted || [], installed_at: i.installed_at })) });
    }

    // --------------------------------------------------------------- publisher revenue (P-10.2)
    // The publisher's OWN allocations. The scope is the caller's workspace, resolved server-side
    // (marketplace.publish is editor+), so a publisher can never read another publisher's revenue
    // and a buyer workspace never sees allocations at all. The request supplies no scope.
    if (action === "my_revenue") {
      requireCapability(role, "marketplace.publish");
      const out = await listPublisherRevenue(svc, {
        publisher_workspace_id: workspaceId,
        listing_id: body.listing_id || null,
        include_reversed: body.include_reversed !== false,
      });
      return Response.json(out);
    }

    // --------------------------------------------------------------- listing writes
    if (action === "create") {
      requireCapability(role, "marketplace.publish");
      const listing = await createListing(svc, {
        workspace_id: workspaceId, owner_id: user.id, slug: String(body.slug || ""), name: String(body.name || ""),
        kind: String(body.kind || ""), summary: body.summary || "", description: body.description || "",
        category: body.category || "", tags: Array.isArray(body.tags) ? body.tags : [], capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
        compatibility: body.compatibility || {}, pricing_model: String(body.pricing_model || "free"), price_cents: num(body.price_cents, 0), currency: String(body.currency || "USD"),
      });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.listing.created", resource: "MarketplaceListing", resource_id: listing.id, metadata: { slug: listing.slug, kind: listing.kind } });
      return Response.json({ listing: safeListing(listing) });
    }

    if (action === "update") {
      requireCapability(role, "marketplace.publish");
      const listing = await updateListing(svc, { workspace_id: workspaceId, listing_id: String(body.listing_id || ""), patch: body.patch || {} });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.listing.updated", resource: "MarketplaceListing", resource_id: listing.id, metadata: {} });
      return Response.json({ listing: safeListing(listing) });
    }

    if (action === "remove") {
      requireCapability(role, "marketplace.publish");
      const listing = await removeListing(svc, { workspace_id: workspaceId, listing_id: String(body.listing_id || "") });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.listing.removed", resource: "MarketplaceListing", resource_id: listing.id, metadata: {} });
      return Response.json({ ok: true });
    }

    if (action === "publish_version") {
      requireCapability(role, "marketplace.publish");
      const res = await publishVersion(svc, {
        workspace_id: workspaceId, listing_id: String(body.listing_id || ""), version_label: String(body.version_label || ""),
        manifest: body.manifest || {}, changelog: body.changelog || "", compatibility: body.compatibility || {},
        artifact_uri: String(body.artifact_uri || ""), artifact_checksum: String(body.artifact_checksum || ""),
        capabilities: Array.isArray(body.capabilities) ? body.capabilities : [], user_id: user.id,
      });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.version.published", resource: "MarketplaceVersion", resource_id: res.version.id, metadata: { version: res.version.version_number, duplicate: res.duplicate } });
      return Response.json({ version: safeVersion(res.version), duplicate: res.duplicate });
    }

    // Publish one of the caller's PROJECTS into one of their template listings. The artifact is
    // built, secret-scanned, canonically serialized and checksummed server-side (#34), so a client
    // never supplies an artifact URI or checksum for a project-backed listing.
    if (action === "publish_project") {
      const res = await publishProjectVersion(base44, user, {
        project_id: String(body.project_id || ""), listing_id: String(body.listing_id || ""),
        version_number: body.version_number || null, version_label: body.version_label || null,
        changelog: body.changelog || "", visibility: body.visibility || null,
      });
      return Response.json({
        listing: safeListing(res.listing, { admin: true }), version: safeVersion(res.version),
        duplicate: res.duplicate, checksum: res.checksum, artifact: res.artifact, source_version_number: res.source_version_number,
      });
    }

    if (action === "publish_listing") {
      requireCapability(role, "marketplace.publish");
      const res = await publishListing(svc, { workspace_id: workspaceId, listing_id: String(body.listing_id || ""), visibility: String(body.visibility || "public"), user_id: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.listing.published", resource: "MarketplaceListing", resource_id: res.listing.id, metadata: { visibility: res.listing.visibility } });
      return Response.json({ listing: safeListing(res.listing) });
    }

    if (action === "yank") {
      requireCapability(role, "marketplace.publish");
      const res = await yankVersion(svc, { workspace_id: workspaceId, listing_id: String(body.listing_id || ""), version_id: String(body.version_id || ""), reason: body.reason || null });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.version.yanked", resource: "MarketplaceVersion", resource_id: res.version.id, metadata: { reason: body.reason || null } });
      return Response.json({ version: safeVersion(res.version), duplicate: res.duplicate });
    }

    // --------------------------------------------------------------- installs
    if (action === "install") {
      requireCapability(role, "marketplace.install");
      let project = null;
      if (body.project_id) project = await svc.entities.Project.get(String(body.project_id)).catch(() => null);
      try {
        const res = await install(svc, {
          workspace_id: workspaceId, project_id: body.project_id || null, listing_id: String(body.listing_id || ""),
          version_id: body.version_id || null, config: body.config || {}, consented_capabilities: Array.isArray(body.consented_capabilities) ? body.consented_capabilities : [],
          user_id: user.id, project,
        });
        await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.installed", resource: "MarketplaceInstall", resource_id: res.install.id, metadata: { listing_id: body.listing_id, charged: res.charged } });
        return Response.json({ install: { id: res.install.id, listing_id: res.install.listing_id, version_id: res.install.version_id, version_number: res.install.version_number, status: res.install.status, capabilities_granted: res.install.capabilities_granted || [] }, duplicate: res.duplicate, charged: res.charged });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || "MARKETPLACE_ERROR", detail: e.detail || null }, { status: e.status || 400 });
      }
    }

    // Install a template AS A NEW PROJECT, through the #33 path: checksum verified, isolated
    // project materialized, marketplace install recorded against it, rolled back if refused.
    if (action === "install_as_project") {
      requireCapability(role, "marketplace.install");
      const res = await installTemplateAsProject(base44, user, {
        listing_id: body.listing_id || null, listing_slug: body.listing_slug || null,
        version_id: body.version_id || null, target_workspace_id: workspaceId,
        name: body.name || null, consented_capabilities: Array.isArray(body.consented_capabilities) ? body.consented_capabilities : [],
      });
      return Response.json({
        project: { id: res.project.id, name: res.project.name, workspace_id: res.project.workspace_id },
        version_number: res.version.number, files_created: res.files_created, entities_created: res.entities_created,
        secrets_declared: res.secrets_declared, install_id: res.install?.id || null, charged: res.charged || 0,
      });
    }

    if (action === "uninstall") {
      requireCapability(role, "marketplace.install");
      const res = await uninstall(svc, { workspace_id: workspaceId, install_id: String(body.install_id || "") });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.uninstalled", resource: "MarketplaceInstall", resource_id: res.install.id, metadata: {} });
      return Response.json({ ok: true, duplicate: res.duplicate });
    }

    // Refund a paid install (P-10.2). Only the PAYING workspace's own admin (marketplace.moderate)
    // may refund its purchase — the install must belong to the caller's workspace — and both the
    // refund amount and the allocation reversal are computed server-side; the client supplies
    // no amounts. A refund is a new buyer ledger entry plus a reversal of the publisher's
    // allocation, exactly once (idempotent on the purchase).
    if (action === "refund_install") {
      requireCapability(role, "marketplace.moderate");
      const installRow = await getInstall(svc, String(body.install_id || ""));
      // Cross-workspace protection: an install id from another workspace is simply not found.
      if (!installRow || installRow.workspace_id !== workspaceId) return Response.json({ error: "Install not found" }, { status: 404 });
      try {
        const res = await refundInstall(svc, { install_id: installRow.id, reason: body.reason || "", refunded_by: user.id });
        return Response.json({ ok: true, duplicate: res.duplicate, revenue: { id: res.revenue.id, status: res.revenue.status, refund_ledger_entry_id: res.revenue.refund_ledger_entry_id || null } });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || "REVENUE_ERROR" }, { status: e.status || 400 });
      }
    }

    // --------------------------------------------------------------- reviews
    if (action === "review") {
      requireCapability(role, "marketplace.read");
      const res = await postReview(svc, { listing_id: String(body.listing_id || ""), workspace_id: workspaceId, user_id: user.id, rating: num(body.rating, 0), title: body.title || "", body: body.body || "" });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.review.posted", resource: "MarketplaceReview", resource_id: res.review.id, metadata: { rating: res.review.rating, verified: res.verified } });
      return Response.json({ review: { id: res.review.id, rating: res.review.rating, verified_install: res.review.verified_install, status: res.review.status } });
    }

    // --------------------------------------------------------------- reports & moderation
    if (action === "report") {
      requireCapability(role, "marketplace.read");
      const res = await fileReport(svc, { listing_id: String(body.listing_id || ""), reporter_workspace_id: workspaceId, reporter_user_id: user.id, reason: String(body.reason || ""), detail: body.detail || "", version_id: body.version_id || null, review_id: body.review_id || null });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.report.filed", resource: "MarketplaceReport", resource_id: res.report.id, metadata: { reason: res.report.reason, duplicate: res.duplicate } });
      return Response.json({ report: { id: res.report.id, status: res.report.status, reason: res.report.reason }, duplicate: res.duplicate });
    }

    if (action === "list_reports") {
      requireCapability(role, "marketplace.moderate");
      const reports = await listReports(svc, { status: body.status || null, listing_id: body.listing_id || null, limit: num(body.limit, 100) });
      return Response.json({ reports });
    }

    if (action === "resolve_report") {
      requireCapability(role, "marketplace.moderate");
      const res = await resolveReport(svc, { report_id: String(body.report_id || ""), action: String(body.action || "none"), resolved_by: user.id, note: body.note || "" });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.report.resolved", resource: "MarketplaceReport", resource_id: res.report.id, metadata: { action: res.report.action } });
      return Response.json({ report: res.report });
    }

    if (action === "suspend") {
      requireCapability(role, "marketplace.moderate");
      const listing = await suspendListing(svc, { listing_id: String(body.listing_id || ""), reason: String(body.reason || "Suspended by moderation") });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.listing.suspended", resource: "MarketplaceListing", resource_id: listing.id, metadata: { reason: body.reason || null } });
      return Response.json({ listing: safeListing(listing, { admin: true }) });
    }

    if (action === "reinstate") {
      requireCapability(role, "marketplace.moderate");
      const res = await reinstateListing(svc, { listing_id: String(body.listing_id || "") });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "marketplace.listing.reinstated", resource: "MarketplaceListing", resource_id: res.listing.id, metadata: {} });
      return Response.json({ listing: safeListing(res.listing, { admin: true }), duplicate: res.duplicate });
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null, detail: error.detail || null }, { status: error.status || 500 });
  }
}