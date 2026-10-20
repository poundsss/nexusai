// Certification for #33 — Clone / Fork / Templates.
//
// Runs the REAL production path (shared/projectClone.ts → rbac → planLimits → persistence →
// marketplace install) against throwaway workspaces. Nothing is mocked: the artifacts are real
// uploads, the checksum is really re-derived, and the secret non-inheritance claim is checked by
// reading the copy's ProjectSecret rows directly rather than trusting the API response.
//
// Copies are deleted immediately after their assertions so the workspace never sits above the
// free plan's project allowance while later sections run.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { cloneProject, forkProject, createProjectFromTemplate, readTemplateArtifact } from "../../shared/projectClone.ts";
import { createFs, writeFile } from "../../shared/projectFs.ts";
import { commitFiles, createVersion } from "../../shared/persistence.ts";
import { packJson } from "../../shared/blobStore.ts";
import { createListing, publishVersion, publishListing } from "../../shared/marketplace.ts";
import { sha256Hex, caught, discardProject, discardWorkspaceProjects, discardListing } from "../../shared/testSupport.ts";

const MAIN_JS = `import { html, render } from "runtime";\nrender(html\`<div>v1</div>\`, document.body);\n`;
const APP_V1 = `export default function App() { return <div>v1</div>; }\n`;
const APP_V2 = `export default function App() { return <div>v2</div>; }\n`;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();

  let workspace = null, otherWs = null, source = null, foreignProject = null;
  const listings = [];

  // Deletes a copy and everything it wrote, so the plan's project allowance is freed at once.
  const discard = (projectId) => discardProject(svc, projectId);

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `Clone ${Date.now()}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    // A workspace the caller is NOT a member of — the isolation counterparty.
    otherWs = await svc.entities.Workspace.create({ name: `Clone Foreign ${Date.now()}`, owner_id: `other_${Date.now()}`, credits_balance: 0, status: "active" });

    // ---- source project: 3 files, 1 entity, 1 secret WITH A REAL VALUE, 2 versions ----
    source = await svc.entities.Project.create({
      workspace_id: workspace.id, name: `Source ${Date.now()}`, slug: `src-${Date.now()}`,
      description: "the original", framework: "preact-htm",
      production_deployment_id: "dep_prod_original", production_version_number: 1,
    });
    const fs1 = createFs([]);
    writeFile(fs1, "src/main.js", MAIN_JS);
    writeFile(fs1, "src/App.jsx", APP_V1);
    writeFile(fs1, "styles.css", ":root { --x: 1; }\n");
    const changed1 = await commitFiles(svc, source.id, fs1);
    await svc.entities.AppEntity.create({ project_id: source.id, name: "Task", fields: { title: { type: "string" } } });
    const SECRET_VALUE = "sk_live_source_project_secret_value_1234567890";
    await svc.entities.ProjectSecret.create({ project_id: source.id, name: "SOURCE_API_KEY", value: SECRET_VALUE, description: "source key", required: true, access: "backend_only" });
    const v1 = await createVersion(svc, { project: source, fs: fs1, entities: [{ name: "Task", fields: { title: { type: "string" } } }], secrets: [{ name: "SOURCE_API_KEY", description: "source key", required: true }], message: "v1", changedFiles: changed1 });

    // Version 2 changes App.jsx, so a fork of v1 must NOT contain v2's content.
    const files1 = await svc.entities.ProjectFile.filter({ project_id: source.id }, "path", 100);
    const fs2 = createFs(files1);
    writeFile(fs2, "src/App.jsx", APP_V2);
    const changed2 = await commitFiles(svc, source.id, fs2);
    const v2 = await createVersion(svc, { project: source, fs: fs2, entities: [{ name: "Task", fields: { title: { type: "string" } } }], secrets: [{ name: "SOURCE_API_KEY", description: "source key", required: true }], message: "v2", changedFiles: changed2 });
    h.check("0a. source has two versions with different App.jsx", v1.number === 1 && v2.number === 2, `v1=${v1.number} v2=${v2.number}`);

    // ================= 1. Clone: current canonical state =================
    const clone = await cloneProject(base44, caller, { source_project_id: source.id });
    const cloneFiles = await svc.entities.ProjectFile.filter({ project_id: clone.project.id }, "path", 100);
    const cloneEntities = await svc.entities.AppEntity.filter({ project_id: clone.project.id }, "name", 50);
    const cloneSecrets = await svc.entities.ProjectSecret.filter({ project_id: clone.project.id }, "name", 50);
    const cloneVersions = await svc.entities.ProjectVersion.filter({ project_id: clone.project.id }, "-number", 10);
    const cloneApp = cloneFiles.find((f) => f.path === "src/App.jsx");

    h.check("1a. clone created a project in the same workspace", clone.project.workspace_id === workspace.id, clone.project.workspace_id);
    h.check("1b. clone copied every source file", cloneFiles.length === 3, String(cloneFiles.length));
    h.check("1c. clone copied the CURRENT content (v2), not v1", cloneApp?.content === APP_V2, cloneApp?.content);
    h.check("1d. clone copied entity declarations", cloneEntities.length === 1 && cloneEntities[0].name === "Task", JSON.stringify(cloneEntities.map((e) => e.name)));
    h.check("1e. clone starts at version 1 regardless of the source's version count", cloneVersions.length === 1 && cloneVersions[0].number === 1, JSON.stringify(cloneVersions.map((v) => v.number)));

    // The central security claim of #33.
    h.check("1f. clone declared the source's secret NAME", cloneSecrets.length === 1 && cloneSecrets[0].name === "SOURCE_API_KEY", JSON.stringify(cloneSecrets.map((s) => s.name)));
    h.check("1g. the clone's secret VALUE is empty — no credential was inherited", !cloneSecrets[0]?.value, `value_len=${String(cloneSecrets[0]?.value || "").length}`);
    h.check("1h. the source's secret value is untouched", (await svc.entities.ProjectSecret.filter({ project_id: source.id }, "name", 5))[0]?.value === SECRET_VALUE, "");
    h.check("1i. the API response reports secret names only", Array.isArray(clone.secrets_declared) && clone.secrets_declared.join() === "SOURCE_API_KEY" && !JSON.stringify(clone.secrets_declared).includes(SECRET_VALUE), JSON.stringify(clone.secrets_declared));

    // Runtime identity must not be copied.
    h.check("1j. clone did NOT copy the source's slug", !clone.project.slug, String(clone.project.slug));
    h.check("1k. clone did NOT copy production deployment pointers", !clone.project.production_deployment_id && !clone.project.production_version_number, JSON.stringify({ dep: clone.project.production_deployment_id, ver: clone.project.production_version_number }));

    h.check("1m. clone was named from the source", clone.project.name === `${source.name} copy`, clone.project.name);
    const cloneAudits = await svc.entities.AuditLog.filter({ project_id: clone.project.id }, "-created_date", 10);
    const cloneAudit = cloneAudits.find((a) => a.action === "project.cloned");
    h.check("1n. clone wrote a project.cloned audit entry with the acting user", !!cloneAudit && cloneAudit.user_id === caller.id, JSON.stringify(cloneAudits.map((a) => a.action)));
    // Lineage lives in the audit record: it names the origin and the exact source it was taken from.
    h.check("1l. the audit record carries clone lineage back to the source", cloneAudit?.metadata?.origin === "clone" && cloneAudit?.metadata?.source_project_id === source.id, JSON.stringify(cloneAudit?.metadata));
    await discard(clone.project.id);

    // ================= 2. Fork: an immutable version =================
    const fork = await forkProject(base44, caller, { source_project_id: source.id, version_number: 1 });
    const forkFiles = await svc.entities.ProjectFile.filter({ project_id: fork.project.id }, "path", 100);
    const forkApp = forkFiles.find((f) => f.path === "src/App.jsx");
    h.check("2a. fork of version 1 contains v1 content, not the source's current v2", forkApp?.content === APP_V1, forkApp?.content);
    const forkAudit = (await svc.entities.AuditLog.filter({ project_id: fork.project.id }, "-created_date", 10)).find((a) => a.action === "project.forked");
    h.check("2b. the audit record pins the fork to the exact source version", forkAudit?.metadata?.origin === "fork" && forkAudit?.metadata?.source_version_number === 1, JSON.stringify(forkAudit?.metadata));
    const forkSecrets = await svc.entities.ProjectSecret.filter({ project_id: fork.project.id }, "name", 50);
    h.check("2c. fork inherits the secret NAME with no value", forkSecrets[0]?.name === "SOURCE_API_KEY" && !forkSecrets[0]?.value, JSON.stringify({ name: forkSecrets[0]?.name, empty: !forkSecrets[0]?.value }));
    await discard(fork.project.id);

    const missingVersion = await caught(() => forkProject(base44, caller, { source_project_id: source.id, version_number: 99 }));
    h.check("2d. forking a version that does not exist is refused", missingVersion?.code === "VERSION_NOT_FOUND", `${missingVersion?.code}`);

    // ================= 3. Authorization / isolation =================
    const foreignTarget = await caught(() => cloneProject(base44, caller, { source_project_id: source.id, target_workspace_id: otherWs.id }));
    h.check("3a. cloning INTO a workspace the caller is not a member of is refused", foreignTarget?.code === "NOT_A_MEMBER" && foreignTarget?.status === 403, `${foreignTarget?.code}/${foreignTarget?.status}`);

    foreignProject = await svc.entities.Project.create({ workspace_id: otherWs.id, name: `Foreign ${Date.now()}` });
    const foreignSource = await caught(() => cloneProject(base44, caller, { source_project_id: foreignProject.id }));
    h.check("3b. cloning FROM another workspace's project is refused", foreignSource?.status === 403 || foreignSource?.status === 404, `${foreignSource?.code}/${foreignSource?.status}`);
    const leaked = await svc.entities.Project.filter({ workspace_id: workspace.id }, "-created_date", 50);
    h.check("3c. the refused cross-workspace copies created no project", leaked.filter((p) => p.id !== source.id).length === 0, `extra projects: ${leaked.length - 1}`);

    const unknownTarget = await caught(() => cloneProject(base44, caller, { source_project_id: source.id, target_workspace_id: "000000000000000000000000" }));
    h.check("3d. an unknown workspace id reports NOT_A_MEMBER, revealing nothing", unknownTarget?.code === "NOT_A_MEMBER", `${unknownTarget?.code}`);

    // ================= 4. Templates =================
    const artifact = {
      files: [{ path: "src/main.js", content: MAIN_JS }, { path: "src/App.jsx", content: `export default function App() { return <div>template</div>; }\n` }],
      entities: [{ name: "Post", fields: { body: { type: "string" } } }],
      secrets: [{ name: "TEMPLATE_KEY", description: "needed by the template", required: true }],
    };
    const artifactText = JSON.stringify(artifact);
    const artifactUrl = await packJson(svc, `clone_test_artifact_${Date.now()}`, artifact);
    const artifactChecksum = await sha256Hex(artifactText);

    const listing = await createListing(svc, { workspace_id: workspace.id, owner_id: caller.id, slug: `tmpl-${Date.now()}`, name: "Starter Template", kind: "template", summary: "a starter" });
    listings.push(listing.id);
    await publishVersion(svc, { workspace_id: workspace.id, listing_id: listing.id, version_label: "v1", manifest: {}, artifact_uri: artifactUrl, artifact_checksum: artifactChecksum, capabilities: [], user_id: caller.id });
    await publishListing(svc, { workspace_id: workspace.id, listing_id: listing.id, user_id: caller.id });

    const verified = await readTemplateArtifact((await svc.entities.MarketplaceVersion.filter({ listing_id: listing.id }, "-version_number", 1))[0]);
    h.check("4a. a published artifact verifies against its recorded checksum", verified.files.length === 2, String(verified.files.length));

    const fromTemplate = await createProjectFromTemplate(base44, caller, { listing_id: listing.id, target_workspace_id: workspace.id });
    const tFiles = await svc.entities.ProjectFile.filter({ project_id: fromTemplate.project.id }, "path", 100);
    const tSecrets = await svc.entities.ProjectSecret.filter({ project_id: fromTemplate.project.id }, "name", 50);
    h.check("4b. the template materialized real source files", tFiles.length === 2 && tFiles.some((f) => f.path === "src/App.jsx"), JSON.stringify(tFiles.map((f) => f.path)));
    const tplAudit = (await svc.entities.AuditLog.filter({ project_id: fromTemplate.project.id }, "-created_date", 10)).find((a) => a.action === "project.created_from_template");
    h.check("4c. the audit record pins the project to the listing version it came from", tplAudit?.metadata?.origin === "template" && tplAudit?.metadata?.listing_id === listing.id && !!tplAudit?.metadata?.listing_version_id, JSON.stringify(tplAudit?.metadata));
    h.check("4d. the template's required secret is declared but unset", tSecrets[0]?.name === "TEMPLATE_KEY" && !tSecrets[0]?.value, JSON.stringify({ name: tSecrets[0]?.name, empty: !tSecrets[0]?.value }));
    h.check("4e. the template recorded a marketplace install against the new project", !!fromTemplate.install?.id && fromTemplate.install.project_id === fromTemplate.project.id, String(fromTemplate.install?.id));
    h.check("4f. a free template charged nothing", (fromTemplate.charged || 0) === 0, String(fromTemplate.charged));
    await discard(fromTemplate.project.id);

    // 4g. Checksum enforcement: the recorded checksum no longer matches the artifact bytes.
    const badListing = await createListing(svc, { workspace_id: workspace.id, owner_id: caller.id, slug: `tmpl-bad-${Date.now()}`, name: "Tampered Template", kind: "template", summary: "bad" });
    listings.push(badListing.id);
    await publishVersion(svc, { workspace_id: workspace.id, listing_id: badListing.id, version_label: "v1", manifest: {}, artifact_uri: artifactUrl, artifact_checksum: await sha256Hex("not the artifact"), capabilities: [], user_id: caller.id });
    await publishListing(svc, { workspace_id: workspace.id, listing_id: badListing.id, user_id: caller.id });
    const tampered = await caught(() => createProjectFromTemplate(base44, caller, { listing_id: badListing.id, target_workspace_id: workspace.id }));
    h.check("4g. an artifact that does not match its published checksum is refused", tampered?.code === "ARTIFACT_CHECKSUM_MISMATCH", `${tampered?.code}`);

    // 4h. A non-template listing cannot be used as one.
    const intListing = await createListing(svc, { workspace_id: workspace.id, owner_id: caller.id, slug: `intg-${Date.now()}`, name: "An Integration", kind: "integration", summary: "not a template" });
    listings.push(intListing.id);
    await publishVersion(svc, { workspace_id: workspace.id, listing_id: intListing.id, version_label: "v1", manifest: {}, artifact_uri: artifactUrl, artifact_checksum: artifactChecksum, capabilities: [], user_id: caller.id });
    await publishListing(svc, { workspace_id: workspace.id, listing_id: intListing.id, user_id: caller.id });
    const notTemplate = await caught(() => createProjectFromTemplate(base44, caller, { listing_id: intListing.id, target_workspace_id: workspace.id }));
    h.check("4h. a non-template listing is refused as a template", notTemplate?.code === "NOT_A_TEMPLATE", `${notTemplate?.code}`);

    // ================= 5. A refused copy leaves nothing behind =================
    // A template requesting a capability the caller does not consent to fails INSIDE install(),
    // after the project was materialized — the exact path that must roll the project back.
    const capListing = await createListing(svc, { workspace_id: workspace.id, owner_id: caller.id, slug: `tmpl-cap-${Date.now()}`, name: "Capability Template", kind: "template", summary: "wants access" });
    listings.push(capListing.id);
    await publishVersion(svc, { workspace_id: workspace.id, listing_id: capListing.id, version_label: "v1", manifest: {}, artifact_uri: artifactUrl, artifact_checksum: artifactChecksum, capabilities: ["data.read"], user_id: caller.id });
    await publishListing(svc, { workspace_id: workspace.id, listing_id: capListing.id, user_id: caller.id });

    const beforeCount = (await svc.entities.Project.filter({ workspace_id: workspace.id }, "-created_date", 100)).length;
    const noConsent = await caught(() => createProjectFromTemplate(base44, caller, { listing_id: capListing.id, target_workspace_id: workspace.id, consented_capabilities: [] }));
    const afterProjects = await svc.entities.Project.filter({ workspace_id: workspace.id }, "-created_date", 100);
    h.check("5a. a template whose capabilities were not consented to is refused", noConsent?.code === "CONSENT_REQUIRED", `${noConsent?.code}`);
    h.check("5b. the refused template left NO project behind", afterProjects.length === beforeCount, `before=${beforeCount} after=${afterProjects.length}`);
    const orphanInstalls = await svc.entities.MarketplaceInstall.filter({ listing_id: capListing.id }, "-installed_at", 20);
    h.check("5c. the refused template left no install row", orphanInstalls.length === 0, String(orphanInstalls.length));

    // 5d. With consent the same template succeeds — proving 5a refused on consent, not on a defect.
    const consented = await createProjectFromTemplate(base44, caller, { listing_id: capListing.id, target_workspace_id: workspace.id, consented_capabilities: ["data.read"] });
    h.check("5d. the same template succeeds once its capability is consented to", !!consented.project?.id && consented.install?.capabilities_granted?.includes("data.read"), JSON.stringify(consented.install?.capabilities_granted));
    await discard(consented.project.id);

  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}\n${String(e.stack || "").slice(0, 600)}`);
  } finally {
    for (const id of listings) await discardListing(svc, id);
    for (const ws of [workspace, otherWs]) {
      if (!ws) continue;
      await discardWorkspaceProjects(svc, ws.id);
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }

  return harnessResponse(h);
}