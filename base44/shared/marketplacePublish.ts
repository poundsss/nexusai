// Marketplace publishing (#34): turning a real PROJECT into an immutable marketplace artifact,
// and turning an artifact back into a new project through the #33 template path.
//
// This is the bridge between two systems that already exist — the project/version store and the
// marketplace listing/version store. It adds no second listing model, no second payment path and
// no second install path.
//
// What an artifact IS: the project's source files, its entity SCHEMAS, and the NAMES of the
// secrets it needs. Nothing else. Four guarantees are enforced here rather than assumed:
//
//   1. NO CREDENTIALS. Secret values live in ProjectSecret and are never read into an artifact;
//      only names/description/required travel. On top of that the source is scanned with the SAME
//      scanner production deployments use, so a credential pasted INTO the code refuses the
//      publish instead of shipping to every installer.
//   2. NO PRIVATE PROJECT DATA. The artifact is built from an immutable ProjectVersion snapshot,
//      filtered to project SOURCE only. The generated app's records, deployments, domains, GitHub
//      links and run history are not part of a snapshot and cannot leak through it.
//   3. IMMUTABLE + VERIFIABLE. The artifact is serialized CANONICALLY (sorted paths, sorted
//      entities, sorted secret names) and its sha256 becomes the published checksum, so the same
//      project state always produces the same checksum, and a swapped artifact is detected at
//      install time by #33's verifier.
//   4. SERVER-SIDE OWNERSHIP. Publishing requires marketplace.publish on the project's OWN
//      workspace, and the listing must belong to that same workspace — a client cannot publish
//      someone else's project, or into someone else's listing.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { unpackSnapshot } from "./blobStore.ts";
import { isProjectSource } from "./gitSync.ts";
import { scanForSecrets } from "./deploy.ts";
import { recordMetric } from "./observability.ts";
import { getListing, getListingBySlug, getVersion, publishVersion, publishListing, MarketplaceError } from "./marketplace.ts";
import { createProjectFromTemplate } from "./projectClone.ts";

export const TEMPLATE_ARTIFACT_SCHEMA = 1;

const byPath = (a, b) => String(a.path).localeCompare(String(b.path));
const byName = (a, b) => String(a.name).localeCompare(String(b.name));

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? "")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds the canonical artifact for one immutable project version.
 *
 * Refuses to produce an artifact at all when the source carries a credential, so "published
 * artifacts contain no secrets" is a property of the publish path, not a hope about authors.
 */
export async function buildTemplateArtifact(svc, { project, version }) {
  const snapshot = await unpackSnapshot(version);
  const files = (snapshot.files || [])
    .filter((f) => f && f.path && isProjectSource(f.path))
    .map((f) => ({ path: String(f.path), content: String(f.content ?? "") }))
    .sort(byPath);
  if (!files.length) throw new MarketplaceError("This version contains no publishable source files", "EMPTY_ARTIFACT", 422);

  const entities = (snapshot.entities || [])
    .filter((e) => e && e.name)
    .map((e) => ({ name: String(e.name), fields: e.fields || {} }))
    .sort(byName);

  // Secret REFERENCES only — the shape has no field a value could travel in.
  const secrets = (snapshot.secrets || [])
    .filter((s) => s && s.name)
    .map((s) => ({ name: String(s.name), description: String(s.description || ""), required: s.required !== false }))
    .sort(byName);

  // The same scanner production deployments use, fed the project's REAL secret values, so a
  // credential hard-coded into the source is caught before it can be published.
  const secretRows = await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 200).catch(() => []);
  const findings = scanForSecrets(files, secretRows.map((s) => s.value));
  if (findings.length) {
    throw new MarketplaceError(
      `Blocked: ${findings.length} credential finding(s) in the source. Move the value into a project secret and publish again.`,
      "SECRET_IN_ARTIFACT", 422, { findings: findings.slice(0, 20) },
    );
  }

  const artifact = { schema_version: TEMPLATE_ARTIFACT_SCHEMA, files, entities, secrets };
  // Canonical serialization: key order fixed here, arrays already sorted, so the checksum is a
  // function of the project state alone.
  const text = JSON.stringify(artifact);
  return {
    artifact, text,
    checksum: await sha256Hex(text),
    stats: { file_count: files.length, entity_count: entities.length, secret_names: secrets.map((s) => s.name), bytes: text.length },
  };
}

// Uploads the EXACT canonical bytes the checksum was taken over. Anything that re-serializes the
// artifact would break verification, so the text is uploaded verbatim.
async function uploadArtifact(svc, project, text) {
  const file = new File([text], `template_${project.id}.json`, { type: "application/json" });
  const { file_url } = await svc.integrations.Core.UploadPublicFile({ file });
  return file_url;
}

/**
 * Publishes a project version into an existing listing as a new immutable marketplace version.
 * Optionally flips the listing's visibility in the same call, so "publish my project" is one
 * authorized operation rather than three client-driven steps.
 */
export async function publishProjectVersion(base44, user, { project_id, listing_id, version_number = null, version_label = null, changelog = "", visibility = null } = {}) {
  const svc = base44.asServiceRole || base44;
  // marketplace.publish is resolved against the PROJECT's own workspace.
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "marketplace.publish");

  const listing = await getListing(svc, String(listing_id || ""));
  if (!listing) throw new MarketplaceError("Listing not found", "NOT_FOUND", 404);
  if (listing.workspace_id !== workspace.id) throw new MarketplaceError("This listing belongs to another workspace", "FORBIDDEN", 403);
  if (listing.kind !== "template") throw new MarketplaceError(`Only template listings can publish a project (this listing is a ${listing.kind})`, "NOT_A_TEMPLATE", 409);

  const versions = version_number
    ? await svc.entities.ProjectVersion.filter({ project_id: project.id, number: Number(version_number) }, "-number", 1)
    : await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1);
  const version = versions[0] || null;
  if (!version) throw new MarketplaceError(version_number ? `Version ${version_number} does not exist` : "This project has no versions to publish", "VERSION_NOT_FOUND", 404);

  const built = await buildTemplateArtifact(svc, { project, version });
  const artifact_uri = await uploadArtifact(svc, project, built.text);

  const res = await publishVersion(svc, {
    workspace_id: workspace.id, listing_id: listing.id,
    version_label: version_label || `v${version.number}`,
    manifest: {
      source_project_version: version.number,
      file_count: built.stats.file_count,
      entity_count: built.stats.entity_count,
      // NAMES only: what an installer must configure before the copy will run.
      required_secrets: built.stats.secret_names,
    },
    changelog: String(changelog || "").slice(0, 4000),
    compatibility: { frameworks: [project.framework] },
    artifact_uri, artifact_checksum: built.checksum,
    capabilities: Array.isArray(listing.capabilities) ? listing.capabilities : [],
    user_id: user.id,
  });

  let listingRow = await getListing(svc, listing.id);
  if (visibility && listingRow.status !== "removed") {
    const flipped = await publishListing(svc, { workspace_id: workspace.id, listing_id: listing.id, visibility, user_id: user.id });
    listingRow = flipped.listing;
  }

  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "marketplace.project.published", resource: "MarketplaceVersion", resource_id: res.version.id,
    metadata: {
      listing_id: listing.id, listing_slug: listing.slug, marketplace_version: res.version.version_number,
      source_project_version: version.number, checksum: built.checksum, duplicate: res.duplicate,
      // Recorded as names so an audit reader can see WHAT the artifact needs without a value existing anywhere.
      required_secrets: built.stats.secret_names,
    },
  });
  await recordMetric(svc, { metric: "marketplace.publish", labels: { kind: listing.kind, duplicate: String(!!res.duplicate) }, scope: "workspace", scope_id: workspace.id });

  return { listing: listingRow, version: res.version, duplicate: res.duplicate, artifact: built.stats, checksum: built.checksum, source_version_number: version.number };
}

/**
 * Installs a marketplace template AS A NEW PROJECT. Delegates entirely to #33, which verifies the
 * checksum, materializes an isolated project and runs the marketplace install (trust gate,
 * compatibility, capability consent, idempotent paid charge) against it.
 */
export async function installTemplateAsProject(base44, user, { listing_id = null, listing_slug = null, version_id = null, target_workspace_id, name = null, consented_capabilities = [] } = {}) {
  const svc = base44.asServiceRole || base44;
  const out = await createProjectFromTemplate(base44, user, {
    listing_id, listing_slug, version_id, target_workspace_id, name, consented_capabilities,
  });
  await recordMetric(svc, { metric: "marketplace.install", labels: { as_project: "true", paid: String((out.charged || 0) > 0) }, scope: "workspace", scope_id: target_workspace_id });
  return out;
}

/** Records a listing view for creator metrics. Best-effort: a view never fails a page load. */
export async function recordListingView(svc, listing) {
  if (!listing?.id) return;
  await recordMetric(svc, { metric: "marketplace.listing.view", labels: { kind: listing.kind || "unknown" }, scope: "listing", scope_id: listing.id });
}

/** Creator-facing metrics for one workspace's listings, derived from existing records. */
export async function creatorMetrics(svc, workspace_id) {
  const listings = await svc.entities.MarketplaceListing.filter({ workspace_id }, "-install_count", 200);
  const ids = new Set(listings.map((l) => l.id));
  const views = (await svc.entities.SystemMetric.filter({ metric: "marketplace.listing.view", scope: "listing" }, "-window_key", 500).catch(() => []))
    .filter((m) => ids.has(m.scope_id));
  const viewsByListing = {};
  for (const m of views) viewsByListing[m.scope_id] = (viewsByListing[m.scope_id] || 0) + (m.count || 0);
  const totalViews = Object.values(viewsByListing).reduce((a, b) => a + b, 0);
  const totalInstalls = listings.reduce((a, l) => a + (l.install_count || 0), 0);
  return {
    listing_count: listings.length,
    total_views: totalViews,
    total_installs: totalInstalls,
    // Conversion is only meaningful once views exist; it is null rather than 0 when unknown.
    conversion: totalViews ? Math.round((totalInstalls / totalViews) * 1000) / 10 : null,
    listings: listings.map((l) => ({
      id: l.id, slug: l.slug, name: l.name, status: l.status, visibility: l.visibility,
      install_count: l.install_count || 0, views: viewsByListing[l.id] || 0,
      rating_avg: l.rating_avg || 0, rating_count: l.rating_count || 0, trust_score: l.trust_score ?? 100,
    })),
  };
}

export { getListingBySlug, getVersion };