// PA-12: automatic push of each saved version to the linked GitHub repository.
//
// DOCUMENTED (Base44): "Base44 pushes each saved version by itself, whether or not automatic
// sync is on." Everything below about HOW is NEXUSAI-derived:
//   • fail-safe ...... never throws into the save that created the version; every outcome is
//                       a durable GitSyncRun row (queued, deferred, skipped or blocked);
//   • no loop ........ a version created by a GitHub IMPORT is never pushed back;
//   • R-8 ............ the existing plan entitlement decides; a denied plan records a skip;
//   • credential ..... a project-scoped encrypted WorkspaceSecret saved when the repository is
//                       linked; copied into the existing per-run job token, never returned;
//   • serialization .. one GitHub operation per project: a push that finds another one running
//                       is deferred, and drainAutoPush() pushes the LATEST version when that
//                       operation finishes, so no saved version is lost to concurrency;
//   • no force ....... auto-push runs use the default fast_forward strategy; a diverged branch
//                       fails with the existing DIVERGED outcome, never an overwrite.
import { githubEntitlement, githubPlanMessage } from "./githubEntitlement.ts";
import { writeWorkspaceSecret, readWorkspaceSecret, deleteWorkspaceSecret } from "./workspaceSecrets.ts";

export const AUTO_PUSH_PREFIX = "autopush:";
export const AUTO_PUSH_DEFERRED = "AUTO_PUSH_DEFERRED";
const ACTIVE = ["QUEUED", "RUNNING", "FETCHING", "VALIDATING", "COMMITTING"];
const tokenName = (projectId) => `GITHUB_AUTOPUSH_TOKEN_${projectId}`;

export const storeAutoPushToken = (svc, workspaceId, projectId, token) =>
  writeWorkspaceSecret(svc, workspaceId, tokenName(projectId), token, { description: "GitHub token for automatic pushes of saved versions. Refreshed on relink." });
export const deleteAutoPushToken = (svc, workspaceId, projectId) =>
  deleteWorkspaceSecret(svc, workspaceId, tokenName(projectId)).catch(() => {});

export const isAutoPushRun = (run) => String(run?.idempotency_key || "").startsWith(AUTO_PUSH_PREFIX);

async function plan(s, projectId, version, opts) {
  if (!version?.id) return { outcome: "no_version" };
  if (version.run_id) {
    const src = await s.entities.GitSyncRun.get(version.run_id).catch(() => null);
    if (src && src.project_id === projectId && src.direction === "import") return { outcome: "skipped_import" };
  }
  const link = (await s.entities.GitHubLink.filter({ project_id: projectId }, "-created_date", 1))[0];
  if (!link || link.status === "disconnected") return { outcome: "not_linked" };
  const workspaceId = link.workspace_id;
  const key = `${AUTO_PUSH_PREFIX}${projectId}:${version.id}:${link.repo_full_name}:${link.branch}`;
  const prior = await s.entities.GitSyncRun.filter({ project_id: projectId, idempotency_key: key }, "-created_date", 5);
  if (prior.some((r) => r.failure_code !== AUTO_PUSH_DEFERRED)) return { outcome: "duplicate" };
  const manual = await s.entities.GitSyncRun.filter({ project_id: projectId, idempotency_key: `export:${projectId}:${version.id}:${link.repo_full_name}:${link.branch}`, status: "COMPLETED" }, "-created_date", 1);
  if (manual.length) return { outcome: "duplicate" };

  const now = new Date().toISOString();
  const base = {
    project_id: projectId, workspace_id: workspaceId, user_id: link.connected_by || undefined, link_id: link.id,
    direction: "export", repo_full_name: link.repo_full_name, branch: link.branch, subdirectory: link.subdirectory || "",
    source_version_id: version.id, version_number: version.number, idempotency_key: key, heartbeat_at: now,
  };
  const record = async (status, code, summary, outcome) => {
    const run = await s.entities.GitSyncRun.create({ ...base, status, current_phase: code.toLowerCase(), failure_code: code, failure_summary: summary, completed_at: now });
    return { outcome, run_id: run.id };
  };

  let ent;
  try { ent = await githubEntitlement(s, workspaceId, opts.resolvePlan ? { resolvePlan: opts.resolvePlan } : {}); }
  catch { return record("FAILED", "AUTO_PUSH_PLAN_UNAVAILABLE", "The plan could not be read, so this version was not pushed automatically.", "blocked_plan_unavailable"); }
  if (!ent.allowed) return record("CANCELLED", "AUTO_PUSH_SKIPPED_PLAN", githubPlanMessage(ent), "skipped_plan");

  const token = await readWorkspaceSecret(s, workspaceId, tokenName(projectId)).catch(() => null);
  if (!token) return record("FAILED", "AUTO_PUSH_NO_CREDENTIAL", "No stored GitHub authorization for automatic pushes. Relink the repository to enable them.", "blocked_no_credential");

  const { stashJobToken } = await import("./gitSync.ts");
  const ref = `GITHUB_JOB_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await stashJobToken(s, { workspace_id: workspaceId, name: ref, token });
  const run = await s.entities.GitSyncRun.create({ ...base, status: "QUEUED", current_phase: "queued", credential_ref: ref, commit_message: `NexusAI: auto-push version ${version.number}` });

  // One operation per project: the EARLIEST active run wins; a later one defers to drain.
  const active = (await Promise.all(ACTIVE.map((st) => s.entities.GitSyncRun.filter({ project_id: projectId, status: st }, "created_date", 10))))
    .flat().filter((r) => !r.cancel_requested)
    .sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)));
  if (active[0] && active[0].id !== run.id) {
    await s.entities.GitSyncRun.update(run.id, { cancel_requested: true, current_phase: "deferred" });
    return { outcome: "deferred", run_id: run.id };
  }
  return { outcome: "queued", run_id: run.id };
}

/** Called after a version is created. Never throws. */
export async function enqueueAutoPush(svc, projectId, version, opts = {}) {
  const s = svc?.asServiceRole || svc;
  try { return await plan(s, projectId, version, opts); }
  catch (e) { console.warn(`[autoPush] ${projectId}: ${e?.message}`); return { outcome: "error" }; }
}

/** Called when any GitHub operation finishes: pushes the latest version if it was never pushed. */
export async function drainAutoPush(svc, projectId, opts = {}) {
  const s = svc?.asServiceRole || svc;
  try {
    const latest = (await s.entities.ProjectVersion.filter({ project_id: projectId }, "-number", 1))[0];
    if (!latest) return { outcome: "no_version" };
    const link = (await s.entities.GitHubLink.filter({ project_id: projectId }, "-created_date", 1))[0];
    if (!link || link.status === "disconnected") return { outcome: "not_linked" };
    if ((link.last_export_version_number || 0) >= latest.number) return { outcome: "up_to_date" };
    // Another operation still running drains again when IT finishes — never stack deferrals.
    for (const st of ACTIVE) {
      if ((await s.entities.GitSyncRun.filter({ project_id: projectId, status: st }, "created_date", 1)).length) return { outcome: "busy" };
    }
    return await plan(s, projectId, latest, opts);
  } catch (e) { console.warn(`[autoPush] drain ${projectId}: ${e?.message}`); return { outcome: "error" }; }
}