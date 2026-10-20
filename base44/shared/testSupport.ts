// Shared helpers for certification suites.
//
// Test-only utilities that more than one suite needs. Kept here so the suites stay focused on
// assertions instead of carrying private copies of the same scaffolding.
import { sha256Hex } from "./hash.ts";

export { sha256Hex };

/** Runs `fn` and returns the error it threw, or null when it succeeded. */
export async function caught(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

// Every project-scoped record a suite can create. Deleting by project id keeps cleanup scoped: a
// suite can never reach a project it did not create.
const PROJECT_SCOPED = [
  "ProjectVersion", "ProjectFile", "AppEntity", "ProjectSecret", "AppRecord",
  "MarketplaceInstall", "AuditLog", "Build", "AIRun", "GitSyncRun", "GitCommitMap", "GitHubLink", "QaRun",
];

/** Deletes one scratch project and every record scoped to it. */
export async function discardProject(svc, projectId, extraEntities = []) {
  if (!projectId) return;
  for (const entity of [...PROJECT_SCOPED, ...extraEntities]) {
    if (!svc.entities[entity]) continue;
    const rows = await svc.entities[entity].filter({ project_id: projectId }, "-created_date", 500).catch(() => []);
    for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
  }
  await svc.entities.Project.delete(projectId).catch(() => {});
}

/** Deletes every project in a scratch workspace, then the workspace itself. */
export async function discardWorkspaceProjects(svc, workspaceId) {
  if (!workspaceId) return;
  const projects = await svc.entities.Project.filter({ workspace_id: workspaceId }, "-created_date", 200).catch(() => []);
  for (const p of projects) await discardProject(svc, p.id);
}

/** Deletes a marketplace listing and every record hanging off it. */
export async function discardListing(svc, listingId) {
  if (!listingId) return;
  for (const entity of ["MarketplaceVersion", "MarketplaceInstall", "MarketplaceReview", "MarketplaceReport"]) {
    const rows = await svc.entities[entity].filter({ listing_id: listingId }, "-created_date", 200).catch(() => []);
    for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
  }
  await svc.entities.MarketplaceListing.delete(listingId).catch(() => {});
}