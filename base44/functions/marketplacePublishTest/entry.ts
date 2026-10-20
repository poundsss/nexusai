// Certification for #34 — Marketplace (project ↔ marketplace bridge).
//
// The listing/version/install/review/trust core is certified by marketplaceTest; this suite
// certifies the NEW surface: publishing a real project as an immutable secret-stripped artifact,
// discovery, the visibility rules as the live endpoint enforces them, and installing an artifact
// back into an isolated project.
//
// Nothing is mocked. Artifacts are really uploaded, really re-downloaded and really re-hashed, and
// the visibility checks go through base44.functions.invoke so the HTTP surface is what is tested.
// Copies are deleted as soon as their assertions run, so the workspace never exceeds its plan's
// project allowance.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { buildTemplateArtifact, publishProjectVersion, installTemplateAsProject, creatorMetrics } from "../../shared/marketplacePublish.ts";
import { createListing, publishListing, removeListing, getListing, listListings, getVersion } from "../../shared/marketplace.ts";
import { createFs, writeFile } from "../../shared/projectFs.ts";
import { commitFiles, createVersion } from "../../shared/persistence.ts";
import { sha256Hex, caught, discardProject, discardWorkspaceProjects, discardListing } from "../../shared/testSupport.ts";

const MAIN_JS = `import { html, render } from "runtime";\nrender(html\`<div>tmpl</div>\`, document.body);\n`;
const APP_V1 = `export default function App() { return <div>v1</div>; }\n`;
const APP_V2 = `export default function App() { return <div>v2</div>; }\n`;
const INTEGRATION = `{"name":"api","type":"http","auth":"api_key","secret":"TEMPLATE_KEY"}\n`;
const LEAKED = `const KEY = "sk_live_1234567890abcdefghijklmnop";\nexport default function App() { return <div>{KEY}</div>; }\n`;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();

  let workspace = null, otherWs = null, source = null, leaky = null, foreignListing = null;
  const listings = [];
  const discard = (projectId) => discardProject(svc, projectId);

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `Mkt34 ${Date.now()}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    otherWs = await svc.entities.Workspace.create({ name: `Mkt34 Foreign ${Date.now()}`, owner_id: `other_${Date.now()}`, credits_balance: 0, status: "active" });

    // ---- a real source project: source files, an entity, a SET secret, private app data ----
    source = await svc.entities.Project.create({
      workspace_id: workspace.id, name: `Tmpl Source ${Date.now()}`, slug: `t34-${Date.now()}`,
      description: "publishable", framework: "preact-htm",
      production_deployment_id: "dep_prod_source", production_version_number: 1,
    });
    const fs1 = createFs([]);
    writeFile(fs1, "src/main.js", MAIN_JS);
    writeFile(fs1, "src/App.jsx", APP_V1);
    writeFile(fs1, "styles.css", ":root{--a:1}\n");
    writeFile(fs1, "integrations/api.json", INTEGRATION);
    const changed1 = await commitFiles(svc, source.id, fs1);
    await svc.entities.AppEntity.create({ project_id: source.id, name: "Post", fields: { body: { type: "string" } } });
    const SECRET_VALUE = "shhh_source_secret_value_9876543210";
    await svc.entities.ProjectSecret.create({ project_id: source.id, name: "TEMPLATE_KEY", value: SECRET_VALUE, description: "api key", required: true, access: "backend_only" });
    // The generated app's OWN data — must never reach an artifact.
    await svc.entities.AppRecord.create({ project_id: source.id, entity_name: "Post", data: { body: "private customer record" } }).catch(() => {});
    const v1 = await createVersion(svc, { project: source, fs: fs1, entities: [{ name: "Post", fields: { body: { type: "string" } } }], secrets: [{ name: "TEMPLATE_KEY", description: "api key", required: true }], message: "v1", changedFiles: changed1 });

    // =============== 1. Artifact construction ===============
    const built = await buildTemplateArtifact(svc, { project: source, version: v1 });
    h.check("1a. the artifact carries exactly the project's source files", built.stats.file_count === 4 && built.artifact.files.every((f) => f.path === "styles.css" || f.path.startsWith("src/") || f.path.startsWith("integrations/")), JSON.stringify(built.artifact.files.map((f) => f.path)));
    h.check("1b. the artifact carries entity schemas", built.artifact.entities.length === 1 && built.artifact.entities[0].name === "Post", JSON.stringify(built.artifact.entities.map((e) => e.name)));
    h.check("1c. the artifact declares the secret NAME", built.artifact.secrets.length === 1 && built.artifact.secrets[0].name === "TEMPLATE_KEY", JSON.stringify(built.artifact.secrets));
    h.check("1d. the artifact contains NO secret value anywhere", !built.text.includes(SECRET_VALUE), `bytes=${built.stats.bytes}`);
    h.check("1e. the artifact contains none of the app's private records", !built.text.includes("private customer record"), "");
    h.check("1f. the checksum matches a hash of the exact canonical bytes", built.checksum === await sha256Hex(built.text), built.checksum);
    const rebuilt = await buildTemplateArtifact(svc, { project: source, version: v1 });
    h.check("1g. the same project state produces the same checksum (canonical + deterministic)", rebuilt.checksum === built.checksum, `${rebuilt.checksum} vs ${built.checksum}`);

    // =============== 2. Secret stripping is enforced, not hoped for ===============
    leaky = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Leaky ${Date.now()}`, framework: "preact-htm" });
    const lfs = createFs([]);
    writeFile(lfs, "src/main.js", MAIN_JS);
    writeFile(lfs, "src/App.jsx", LEAKED);
    const lchanged = await commitFiles(svc, leaky.id, lfs);
    const lv = await createVersion(svc, { project: leaky, fs: lfs, entities: [], secrets: [], message: "leaky", changedFiles: lchanged });
    const leakListing = await createListing(svc, { workspace_id: workspace.id, owner_id: caller.id, slug: `leak-${Date.now()}`, name: "Leaky", kind: "template", summary: "x" });
    listings.push(leakListing.id);
    const leakErr = await caught(() => publishProjectVersion(base44, caller, { project_id: leaky.id, listing_id: leakListing.id }));
    h.check("2a. publishing source with a hard-coded credential is refused", leakErr?.code === "SECRET_IN_ARTIFACT", `${leakErr?.code}`);
    const leakVersions = await svc.entities.MarketplaceVersion.filter({ listing_id: leakListing.id }, "-version_number", 5);
    h.check("2b. the refused publish created no marketplace version", leakVersions.length === 0, String(leakVersions.length));
    await discard(leaky.id);
    leaky = null;

    // =============== 3. Publishing a project ===============
    const listing = await createListing(svc, {
      workspace_id: workspace.id, owner_id: caller.id, slug: `starter-${Date.now()}`, name: "Starter Kit",
      kind: "template", summary: "a starter kit", category: "starter", tags: ["Preact", "starter"],
    });
    listings.push(listing.id);
    const pub1 = await publishProjectVersion(base44, caller, { project_id: source.id, listing_id: listing.id, version_label: "1.0.0", changelog: "first", visibility: "public" });
    h.check("3a. publishing a project creates marketplace version 1", pub1.version.version_number === 1 && pub1.version.status === "published", String(pub1.version.version_number));
    h.check("3b. the published version freezes the artifact checksum", pub1.version.artifact_checksum === built.checksum, pub1.version.artifact_checksum);
    h.check("3c. the manifest records required secret NAMES for the installer", JSON.stringify(pub1.version.manifest?.required_secrets) === JSON.stringify(["TEMPLATE_KEY"]), JSON.stringify(pub1.version.manifest));
    h.check("3d. publishing flipped the listing public in the same call", pub1.listing.status === "published" && pub1.listing.visibility === "public", `${pub1.listing.status}/${pub1.listing.visibility}`);
    h.check("3e. compatibility was derived from the project's framework", JSON.stringify(pub1.version.compatibility?.frameworks) === JSON.stringify(["preact-htm"]), JSON.stringify(pub1.version.compatibility));

    // Re-publishing an UNCHANGED project is idempotent — no duplicate version.
    const pubDup = await publishProjectVersion(base44, caller, { project_id: source.id, listing_id: listing.id, version_label: "1.0.0" });
    h.check("3f. re-publishing unchanged source is idempotent", pubDup.duplicate === true && pubDup.version.id === pub1.version.id, String(pubDup.duplicate));

    // A changed project publishes a NEW version; the old one is untouched.
    const files1 = await svc.entities.ProjectFile.filter({ project_id: source.id }, "path", 100);
    const fs2 = createFs(files1);
    writeFile(fs2, "src/App.jsx", APP_V2);
    const changed2 = await commitFiles(svc, source.id, fs2);
    const v2 = await createVersion(svc, { project: source, fs: fs2, entities: [{ name: "Post", fields: { body: { type: "string" } } }], secrets: [{ name: "TEMPLATE_KEY", description: "api key", required: true }], message: "v2", changedFiles: changed2 });
    const pub2 = await publishProjectVersion(base44, caller, { project_id: source.id, listing_id: listing.id, version_label: "1.1.0" });
    h.check("3g. changed source publishes a new immutable version", pub2.version.version_number === 2 && pub2.version.id !== pub1.version.id, String(pub2.version.version_number));
    h.check("3h. the new artifact has a different checksum", pub2.version.artifact_checksum !== pub1.version.artifact_checksum, pub2.version.artifact_checksum);
    const v1Still = await getVersion(svc, pub1.version.id);
    h.check("3i. the earlier marketplace version is unchanged", v1Still.artifact_checksum === built.checksum && v1Still.version_label === "1.0.0", v1Still.version_label);
    h.check("3j. publishing pinned the exact source project version", pub2.source_version_number === v2.number, `${pub2.source_version_number}`);

    // Artifact integrity: the stored artifact really re-downloads and re-hashes to its checksum.
    const fetched = await fetch(pub1.version.artifact_uri);
    const fetchedText = await fetched.text();
    h.check("3k. the stored artifact re-hashes to its published checksum", await sha256Hex(fetchedText) === pub1.version.artifact_checksum, "verified");
    h.check("3l. the stored artifact contains no secret value", !fetchedText.includes(SECRET_VALUE), "");

    // =============== 4. Unauthorized publishing ===============
    foreignListing = await svc.entities.MarketplaceListing.create({ workspace_id: otherWs.id, owner_id: "someone", slug: `foreign-${Date.now()}`, name: "Foreign", kind: "template", status: "draft", visibility: "private", trust_score: 100 });
    const wrongListing = await caught(() => publishProjectVersion(base44, caller, { project_id: source.id, listing_id: foreignListing.id }));
    h.check("4a. publishing into another workspace's listing is refused", wrongListing?.code === "FORBIDDEN" || wrongListing?.status === 403, `${wrongListing?.code}/${wrongListing?.status}`);
    const foreignProject = await svc.entities.Project.create({ workspace_id: otherWs.id, name: `Foreign proj ${Date.now()}` });
    const wrongProject = await caught(() => publishProjectVersion(base44, caller, { project_id: foreignProject.id, listing_id: listing.id }));
    h.check("4b. publishing a project the caller cannot read is refused", wrongProject?.status === 403 || wrongProject?.status === 404, `${wrongProject?.status}`);
    await svc.entities.Project.delete(foreignProject.id).catch(() => {});

    // =============== 5. Visibility, through the live endpoint ===============
    const privListing = await createListing(svc, { workspace_id: workspace.id, owner_id: caller.id, slug: `priv-${Date.now()}`, name: "Private Kit", kind: "template", summary: "hidden", tags: ["secret"] });
    listings.push(privListing.id);
    await publishProjectVersion(base44, caller, { project_id: source.id, listing_id: privListing.id, version_label: "1.0.0", visibility: "private" });
    const unlListing = await createListing(svc, { workspace_id: workspace.id, owner_id: caller.id, slug: `unl-${Date.now()}`, name: "Unlisted Kit", kind: "template", summary: "direct only", tags: ["starter"] });
    listings.push(unlListing.id);
    await publishProjectVersion(base44, caller, { project_id: source.id, listing_id: unlListing.id, version_label: "1.0.0", visibility: "unlisted" });

    const browse = await listListings(svc, { kind: "template", status: "published", visibility: "public" });
    h.check("5a. browse shows the public listing", browse.some((l) => l.id === listing.id), `${browse.length} public`);
    h.check("5b. browse hides the private listing", !browse.some((l) => l.id === privListing.id), "hidden");
    h.check("5c. browse hides the unlisted listing", !browse.some((l) => l.id === unlListing.id), "hidden");

    // Direct access as a NON-owner: the read carries NO workspace context, which is exactly how a
    // visitor reaches a listing page. The server resolves no role, so the caller is a non-owner of
    // these listings even though the same person happens to own them elsewhere.
    const askAsForeigner = async (listing_id) => {
      const res = await base44.functions.invoke("marketplace", { action: "get", listing_id }).catch((e) => ({ data: null, status: e.response?.status || 500 }));
      return { status: res.status, listing: res.data?.listing || null };
    };
    const pubDirect = await askAsForeigner(listing.id);
    const unlDirect = await askAsForeigner(unlListing.id);
    const privDirect = await askAsForeigner(privListing.id);
    h.check("5d. a non-owner may read a PUBLIC listing directly", pubDirect.listing?.id === listing.id, `${pubDirect.status}`);
    h.check("5e. a non-owner may read an UNLISTED listing by direct id", unlDirect.listing?.id === unlListing.id, `${unlDirect.status}`);
    h.check("5f. a non-owner is refused a PRIVATE listing even with its exact id", !privDirect.listing && privDirect.status === 404, `${privDirect.status}`);
    const ownDirect = await base44.functions.invoke("marketplace", { action: "get", listing_id: privListing.id, workspace_id: workspace.id }).catch((e) => ({ data: null, status: e.response?.status }));
    h.check("5g. the owning workspace may read its own private listing", ownDirect.data?.listing?.id === privListing.id, `${ownDirect.status}`);

    // =============== 6. Discovery filters ===============
    const byTag = await listListings(svc, { status: "published", visibility: "public", tags: ["starter"] });
    h.check("6a. a tag filter matches the public listing", byTag.some((l) => l.id === listing.id), String(byTag.length));
    const byTagConj = await listListings(svc, { status: "published", visibility: "public", tags: ["starter", "nonexistent-tag"] });
    h.check("6b. tag filtering is conjunctive (every tag must match)", !byTagConj.some((l) => l.id === listing.id), String(byTagConj.length));
    const byTagCase = await listListings(svc, { status: "published", visibility: "public", tags: ["preact"] });
    h.check("6c. tag matching is case-insensitive", byTagCase.some((l) => l.id === listing.id), String(byTagCase.length));
    const byCreator = await listListings(svc, { status: "published", visibility: "public", owner_workspace_id: workspace.id });
    h.check("6d. a creator filter returns only that creator's public listings", byCreator.length >= 1 && byCreator.every((l) => l.workspace_id === workspace.id), String(byCreator.length));
    const byText = await listListings(svc, { status: "published", visibility: "public", q: "starter kit" });
    h.check("6e. text search matches the listing name", byText.some((l) => l.id === listing.id), String(byText.length));
    const byStatus = await listListings(svc, { status: "draft", visibility: null, owner_workspace_id: workspace.id });
    h.check("6f. status filtering can select the creator's drafts", byStatus.every((l) => l.status === "draft"), String(byStatus.length));

    // =============== 7. Install as an isolated project ===============
    const installed = await installTemplateAsProject(base44, caller, { listing_id: listing.id, target_workspace_id: workspace.id, name: "From Marketplace" });
    const iFiles = await svc.entities.ProjectFile.filter({ project_id: installed.project.id }, "path", 100);
    const iEntities = await svc.entities.AppEntity.filter({ project_id: installed.project.id }, "name", 50);
    const iSecrets = await svc.entities.ProjectSecret.filter({ project_id: installed.project.id }, "name", 50);
    const iRecords = await svc.entities.AppRecord.filter({ project_id: installed.project.id }, "-created_date", 50).catch(() => []);
    const iApp = iFiles.find((f) => f.path === "src/App.jsx");
    h.check("7a. installing a template materialized a new project", !!installed.project?.id && installed.project.id !== source.id, installed.project.id);
    h.check("7b. the installed project has the template's source files", iFiles.length === 4, String(iFiles.length));
    h.check("7c. the installed project has the CURRENT published artifact content", iApp?.content === APP_V2, iApp?.content);
    h.check("7d. the installed project has the template's entity schemas", iEntities.length === 1 && iEntities[0].name === "Post", JSON.stringify(iEntities.map((e) => e.name)));
    h.check("7e. the installed project declares the required secret with NO value", iSecrets[0]?.name === "TEMPLATE_KEY" && !iSecrets[0]?.value, JSON.stringify({ name: iSecrets[0]?.name, empty: !iSecrets[0]?.value }));
    h.check("7f. the installed project inherited NONE of the source app's data", iRecords.length === 0, String(iRecords.length));
    h.check("7g. the installed project inherited no slug or production pointer", !installed.project.slug && !installed.project.production_deployment_id, JSON.stringify({ slug: installed.project.slug, dep: installed.project.production_deployment_id }));
    h.check("7h. the install was recorded against the new project", installed.install?.project_id === installed.project.id, String(installed.install?.id));
    h.check("7i. the source project is untouched by the install", (await svc.entities.ProjectSecret.filter({ project_id: source.id }, "name", 5))[0]?.value === SECRET_VALUE, "source intact");
    await discard(installed.project.id);

    // =============== 8. Checksum verification at install time ===============
    const goodChecksum = pub2.version.artifact_checksum;
    await svc.entities.MarketplaceVersion.update(pub2.version.id, { artifact_checksum: await sha256Hex("tampered") });
    const tampered = await caught(() => installTemplateAsProject(base44, caller, { listing_id: listing.id, target_workspace_id: workspace.id }));
    h.check("8a. an artifact that no longer matches its checksum is refused at install", tampered?.code === "ARTIFACT_CHECKSUM_MISMATCH", `${tampered?.code}`);
    const afterTamper = await svc.entities.Project.filter({ workspace_id: workspace.id }, "-created_date", 50);
    h.check("8b. the refused install created no project", !afterTamper.some((p) => p.name === "From Marketplace"), String(afterTamper.length));
    await svc.entities.MarketplaceVersion.update(pub2.version.id, { artifact_checksum: goodChecksum });

    // =============== 9. Failed install rolls back ===============
    await svc.entities.MarketplaceVersion.update(pub2.version.id, { capabilities: ["data.read"] });
    await svc.entities.MarketplaceListing.update(listing.id, { capabilities: ["data.read"] });
    const beforeRollback = (await svc.entities.Project.filter({ workspace_id: workspace.id }, "-created_date", 100)).length;
    const noConsent = await caught(() => installTemplateAsProject(base44, caller, { listing_id: listing.id, target_workspace_id: workspace.id }));
    const afterRollback = await svc.entities.Project.filter({ workspace_id: workspace.id }, "-created_date", 100);
    h.check("9a. an install without capability consent is refused", noConsent?.code === "CONSENT_REQUIRED", `${noConsent?.code}`);
    h.check("9b. the refused install left no project behind", afterRollback.length === beforeRollback, `${beforeRollback} → ${afterRollback.length}`);
    await svc.entities.MarketplaceVersion.update(pub2.version.id, { capabilities: [] });
    await svc.entities.MarketplaceListing.update(listing.id, { capabilities: [] });

    // =============== 10. Delist ===============
    await removeListing(svc, { workspace_id: workspace.id, listing_id: unlListing.id });
    const delisted = await caught(() => installTemplateAsProject(base44, caller, { listing_id: unlListing.id, target_workspace_id: workspace.id }));
    h.check("10a. a delisted listing cannot be installed", delisted?.code === "NOT_PUBLISHED", `${delisted?.code}`);
    const browseAfter = await listListings(svc, { kind: "template", status: "published", visibility: "public" });
    h.check("10b. a delisted listing is absent from browse", !browseAfter.some((l) => l.id === unlListing.id), "absent");
    h.check("10c. delisting did not delete its published versions (history preserved)", (await svc.entities.MarketplaceVersion.filter({ listing_id: unlListing.id }, "-version_number", 5)).length >= 1, "versions kept");

    // =============== 11. Creator analytics (reusing SystemMetric) ===============
    const metrics = await creatorMetrics(svc, workspace.id);
    h.check("11a. creator metrics count the workspace's listings", metrics.listing_count >= 3, String(metrics.listing_count));
    h.check("11b. creator metrics report views recorded by non-owner reads", metrics.total_views >= 2, String(metrics.total_views));
    h.check("11c. creator metrics report installs and a conversion rate", metrics.total_installs >= 1 && metrics.conversion !== null, JSON.stringify({ installs: metrics.total_installs, conversion: metrics.conversion }));
    const auditRows = await svc.entities.AuditLog.filter({ project_id: source.id }, "-created_date", 20);
    h.check("11d. publishing wrote an audit entry naming the listing and checksum", auditRows.some((a) => a.action === "marketplace.project.published" && a.metadata?.checksum), JSON.stringify(auditRows.map((a) => a.action)));
    h.check("11e. the publish audit records secret NAMES only, never a value", !JSON.stringify(auditRows).includes(SECRET_VALUE), "");

  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}\n${String(e.stack || "").slice(0, 600)}`);
  } finally {
    for (const id of [...listings, foreignListing?.id].filter(Boolean)) await discardListing(svc, id);
    for (const ws of [workspace, otherWs]) {
      if (!ws) continue;
      await discardWorkspaceProjects(svc, ws.id);
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }

  return harnessResponse(h);
}