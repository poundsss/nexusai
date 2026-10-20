// GitHub source-control worker.
//
// GitHub is an EXTERNAL source layer. This module moves source code across that boundary
// and nothing more — it is not a second build system, version system or deployment path:
//   • export ... immutable ProjectVersion snapshot → real GitHub commit
//   • import ... GitHub commit → validated → NEW immutable internal version
//   • build/security ... the existing buildEngine pass + the existing artifact secret scan
//   • durability ... the same lease + heartbeat + bounded-recovery contract as deployments
//   • audit ... authz.audit
//
// Two invariants govern everything here:
//   1. An import NEVER writes to the canonical project until build AND security validation
//      have passed in memory. A failed import leaves the project exactly as it was.
//   2. Nothing in this module touches Deployment, production pointers or artifacts. An
//      imported version is merely ELIGIBLE for deployment; going live still requires an
//      explicitly authorized deployment through the existing flow.
import { createFs, activeFiles, writeFile, deleteFile, computeChanges, normalizePath } from "./projectFs.ts";
import { runBuild } from "./buildEngine.ts";
import { unpackSnapshot } from "./blobStore.ts";
import { loadProjectState } from "./authz.ts";
import { recordBuild } from "./persistence.ts";
// The SAME journalled, optimistic-concurrency-protected commit path the AI builder uses.
import { prepareCommit, finalizeCommit, rollbackCommit, abandonCommit } from "./commitJournal.ts";
import { isFunctionPath } from "./functionPaths.ts";
import { isIntegrationPath } from "./integrations.ts";
import { scanForSecrets } from "./deploy.ts";
import { audit } from "./authz.ts";
import { GitHubError, createCommit, createMergeCommit, diffAgainstBranch, readCommitFiles, readCommitFileMap, readCommitTree, readBlobsBatch, detectDivergence, validateToken, getRepo, getBranchHead, getCommit } from "./github.ts";
import { writeWorkspaceSecret, readWorkspaceSecret, deleteWorkspaceSecret } from "./workspaceSecrets.ts";
import { packJson, unpackJson } from "./blobStore.ts";
// Agent policy immutability, defensive parity with the other mutation channels: today
// isProjectSource() excludes base44/ entirely, so an import can never reach an agent
// document — this guard keeps that boundary true even if the source filter ever widens.
import { assertNoActiveAgentPolicyWrite } from "./agentPolicyGuard.ts";
import { githubEntitlement, githubPlanMessage, GITHUB_PLAN_NOT_ENTITLED } from "./githubEntitlement.ts";
import { reconcileArchitectureAfterMutation } from "./architectureReconcile.ts";
import { resolveRole, requireCapability, requireActiveWorkspace } from "./rbac.ts";
import { drainAutoPush, isAutoPushRun, AUTO_PUSH_DEFERRED } from "./githubAutoPush.ts";

export const GIT_TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];
export const GIT_ACTIVE = ["QUEUED", "RUNNING", "FETCHING", "VALIDATING", "COMMITTING"];
export const MAX_GIT_RECOVERIES = 3;
const LEASE_MS = 150000;
const ITERATION_BUDGET_MS = 55000;
const MANIFEST = "nexusai/project.json";
const MAX_FILES = 400;

const trunc = (v, n = 400) => String(v ?? "").slice(0, n);
const prefixed = (sub, path) => (sub ? `${String(sub).replace(/^\/+|\/+$/g, "")}/${path}` : path);

// A path is project source only if the virtual filesystem would accept it. Anything else in
// the repository (README, licence, CI config) is left alone rather than guessed at.
export function isProjectSource(path) {
  const p = normalizePath(path);
  return p === "styles.css" || p.startsWith("src/") || p.startsWith("functions/") || p.startsWith("integrations/");
}

// --- short-lived credential handling ----------------------------------------
// The OAuth token belongs to the app user and is only obtainable inside their request, but
// the work runs in a background worker. So the enqueue path parks it in a backend-only
// secret row and stores only its NAME on the run.
//
// The value is ENCRYPTED at rest (AES-256-GCM, bound to the owning workspace + the ref name),
// read back only here — the deepest server-side point, immediately before a GitHub API call —
// and destroyed the moment the run reaches a terminal state. Every lookup is scoped to the
// run's own workspace, so a ref name is never sufficient on its own to open a token.
export async function stashJobToken(svc, { workspace_id, name, token }) {
  await writeWorkspaceSecret(svc, workspace_id, name, token, {
    description: "Short-lived GitHub token for one source-control job. Deleted when the job finishes.",
  });
  return name;
}

export async function readJobToken(svc, workspaceId, ref) {
  const token = ref && workspaceId ? await readWorkspaceSecret(svc, workspaceId, ref).catch(() => null) : null;
  if (!token) {
    throw new GitHubError("GITHUB_AUTH_INVALID", "The GitHub authorization for this job is no longer available. Reconnect GitHub and try again.");
  }
  return token;
}

export async function destroyJobToken(svc, workspaceId, ref) {
  if (!ref || !workspaceId) return;
  await deleteWorkspaceSecret(svc, workspaceId, ref);
}

// --- 3-way file merge (Stage 3) ---------------------------------------------
// Merges "ours" (the internal version being exported) with "theirs" (the diverged
// branch head) using "base" (the last export commit) as the common ancestor.
// Returns { merged, conflicts }. A conflict is a file both sides changed differently
// since the base — it is surfaced deterministically, never silently overwritten.
export function threeWayMerge(baseFiles, ourFiles, theirFiles) {
  const base = new Map((baseFiles || []).map((f) => [f.path, f.content]));
  const ours = new Map((ourFiles || []).map((f) => [f.path, f.content]));
  const theirs = new Map((theirFiles || []).map((f) => [f.path, f.content]));
  const allPaths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = [];
  const conflicts = [];

  for (const path of allPaths) {
    // The manifest (nexusai/project.json) is our internal export artifact, not
    // user-edited source. It always changes between exports (exported_at timestamp),
    // and a user's commit will never include it. Always take ours; never conflict.
    if (path === MANIFEST || path.endsWith("/" + MANIFEST)) {
      const o = ours.get(path) ?? null;
      if (o !== null) merged.push({ path, content: o });
      continue;
    }

    const b = base.get(path) ?? null;
    const o = ours.get(path) ?? null;
    const t = theirs.get(path) ?? null;

    if (o === t) {
      // Same content on both sides (including both null = deleted by both)
      if (o !== null) merged.push({ path, content: o });
    } else if (o === b) {
      // We didn't change this file, they did → take theirs
      if (t !== null) merged.push({ path, content: t });
    } else if (t === b) {
      // They didn't change this file, we did → take ours
      if (o !== null) merged.push({ path, content: o });
    } else {
      // Both changed differently → conflict
      conflicts.push({ path, change: "conflict" });
      // Default to ours so the merge can still proceed if the user chooses to accept
      if (o !== null) merged.push({ path, content: o });
    }
  }

  merged.sort((a, b) => a.path.localeCompare(b.path));
  conflicts.sort((a, b) => a.path.localeCompare(b.path));
  return { merged, conflicts };
}

// --- token validation (Stage 5) ----------------------------------------------
// Validates the GitHub token before long-running work. If the token is invalid, the
// run fails deterministically with GITHUB_AUTH_INVALID rather than discovering it
// mid-way through a multi-batch import. The validation timestamp is persisted so a
// resumed run can re-validate.
async function validateTokenBeforeSync(svc, run, token) {
  const result = await validateToken(token);
  if (!result.valid) {
    throw new GitHubError("GITHUB_AUTH_INVALID", "GitHub rejected the authorization. Reconnect GitHub and try again.");
  }
  await svc.entities.GitSyncRun.update(run.id, { token_validated_at: new Date().toISOString() }).catch(() => {});
  return result;
}

// --- lease (identical contract to the deployment worker) ---------------------
async function claimLease(svc, run) {
  const now = Date.now();
  const held = Date.parse(run.lease_expires_at || "");
  if (Number.isFinite(held) && held > now) return null;
  const token = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  await svc.entities.GitSyncRun.update(run.id, { lease_token: token, lease_expires_at: new Date(now + LEASE_MS).toISOString() });
  const check = await svc.entities.GitSyncRun.get(run.id);
  return check.lease_token === token ? token : null;
}

// --- the worker --------------------------------------------------------------
/**
 * G-4: commit-time authorization re-check for a Git import. The sync was authorized
 * ("github.manage" + active workspace) when it was enqueued, but the canonical commit may
 * execute in a later worker request, so the importer's CURRENT membership is resolved again
 * from the same server-side facts every other surface uses. Recovery of a partially applied
 * journal does NOT call this: it must resolve an already-authorized operation.
 */
export async function assertImporterAuthorization(svc, run) {
  const importer = run.user_id ? await svc.entities.User.get(run.user_id).catch(() => null) : null;
  const workspace = await svc.entities.Workspace.get(run.workspace_id).catch(() => null);
  requireCapability(await resolveRole(svc, workspace, importer), "github.manage");
  requireActiveWorkspace(workspace, "github.manage");
}

export async function runGitSyncStep(svc, runId, { resolvePlan } = {}) {
  let run = await svc.entities.GitSyncRun.get(runId);
  if (!run) throw new Error(`Sync run not found: ${runId}`);
  if (GIT_TERMINAL.includes(run.status)) return { sync_run_id: runId, done: true, status: run.status };

  const lease = await claimLease(svc, run);
  if (!lease) return { sync_run_id: runId, done: false, busy: true, status: run.status };
  const started = Date.now();

  const patch = async (data) => {
    const saved = await svc.entities.GitSyncRun.update(run.id, {
      ...data, heartbeat_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
    });
    Object.assign(run, saved || data);
    return run;
  };

  const project = await svc.entities.Project.get(run.project_id);
  const link = run.link_id ? await svc.entities.GitHubLink.get(run.link_id).catch(() => null) : null;

  const finish = async (status, extra) => {
    const startedMs = Date.parse(run.started_at || run.created_date);
    await svc.entities.GitSyncRun.update(run.id, {
      status, completed_at: new Date().toISOString(),
      duration_ms: Number.isFinite(startedMs) ? Date.now() - startedMs : 0,
      heartbeat_at: new Date().toISOString(), lease_token: null, lease_expires_at: null,
      current_phase: status.toLowerCase(), ...extra,
    });
    // The job's credential dies with the job.
    await destroyJobToken(svc, run.workspace_id, run.credential_ref);
    await svc.entities.GitSyncRun.update(run.id, { credential_ref: null }).catch(() => {});
    if (link) {
      await svc.entities.GitHubLink.update(link.id, {
        last_sync_at: new Date().toISOString(),
        status: status === "COMPLETED" ? "connected" : link.status,
        last_error: status === "COMPLETED" ? null : trunc(extra?.failure_summary || "", 300),
        last_error_code: status === "COMPLETED" ? null : extra?.failure_code || null,
        ...(status === "COMPLETED" && run.direction === "export"
          ? { last_export_commit_sha: extra?.commit_sha || run.commit_sha, last_export_version_number: run.version_number }
          : {}),
        ...(status === "COMPLETED" && run.direction === "import"
          ? { last_import_commit_sha: run.commit_sha, last_import_version_number: extra?.version_number || run.version_number }
          : {}),
      }).catch(() => {});
    }
    await audit(svc, {
      workspace_id: run.workspace_id, project_id: run.project_id, user_id: run.user_id,
      action: `github.${run.direction}.${status === "COMPLETED" ? "completed" : status.toLowerCase()}`,
      resource: "GitSyncRun", resource_id: run.id,
      metadata: {
        repo: run.repo_full_name, branch: run.branch,
        commit_sha: extra?.commit_sha || run.commit_sha || null,
        version_id: extra?.version_id || run.version_id || null,
        version_number: extra?.version_number || run.version_number || null,
        failure_code: extra?.failure_code || null,
      },
    });
    // PA-12: once this operation is done, push the latest saved version if it never was.
    await drainAutoPush(svc, run.project_id, resolvePlan ? { resolvePlan } : {});
    return { sync_run_id: runId, done: true, status, commit_sha: extra?.commit_sha || run.commit_sha || null, version_number: extra?.version_number || run.version_number || null };
  };

  const failFromGitHub = (e) => {
    const code = e instanceof GitHubError ? (e.code === "NOT_FOUND" ? "GITHUB_API_ERROR" : e.code) : "SYNC_ERROR";
    return finish("FAILED", { failure_code: code, failure_summary: trunc(e.message, 400) });
  };

  // R-8: queued work re-checks the plan when it executes. A downgraded/expired workspace stops
  // with a recorded reason; the link and history are kept. Cancellation still wins, and a
  // commit already in progress (COMMITTING) is allowed to finish so state is never left half-applied.
  if (!run.cancel_requested && run.status !== "COMMITTING") {
    const ent = await githubEntitlement(svc, run.workspace_id || project?.workspace_id, resolvePlan ? { resolvePlan } : {});
    if (!ent.allowed) return finish("FAILED", { failure_code: GITHUB_PLAN_NOT_ENTITLED, failure_summary: githubPlanMessage(ent) });
  }

  try {
    while (Date.now() - started < ITERATION_BUDGET_MS) {
      run = await svc.entities.GitSyncRun.get(runId);
      if (GIT_TERMINAL.includes(run.status)) return { sync_run_id: runId, done: true, status: run.status };
      if (run.lease_token !== lease) return { sync_run_id: runId, done: false, busy: true, status: run.status };
      if (run.cancel_requested) {
        if (isAutoPushRun(run) && run.current_phase === "deferred") {
          return finish("CANCELLED", { failure_code: AUTO_PUSH_DEFERRED, failure_summary: "Another GitHub operation was running; the latest version is pushed when it finishes." });
        }
        return finish("CANCELLED", { failure_code: "CANCELLED", failure_summary: "Cancelled before the operation completed. Nothing was changed." });
      }

      // ===================== EXPORT: internal version → GitHub =====================
      if (run.direction === "export") {
        if (run.status === "QUEUED") {
          await patch({ status: "RUNNING", current_phase: "reading the internal version", started_at: run.started_at || new Date().toISOString() });
          continue;
        }

        if (run.status === "RUNNING") {
          // The export reads an IMMUTABLE version snapshot, never the mutable working files,
          // and never writes back to it.
          const version = await svc.entities.ProjectVersion.get(run.source_version_id).catch(() => null);
          if (!version || version.project_id !== project.id) {
            return finish("FAILED", { failure_code: "SYNC_ERROR", failure_summary: "The version being exported does not belong to this project." });
          }
          const snapshot = await unpackSnapshot(version);
          const source = (snapshot.files || []).filter((f) => isProjectSource(f.path));
          if (!source.length) return finish("FAILED", { failure_code: "SYNC_ERROR", failure_summary: "The selected version contains no source files to export." });

          // Real source files plus a manifest carrying the parts of project state that are
          // not files (entity schemas, required secret NAMES). No secret values, ever.
          const manifest = {
            project: project.name, internal_version: version.number, exported_at: new Date().toISOString(),
            entities: (snapshot.entities || []).map((e) => ({ name: e.name, fields: e.fields || {} })),
            required_secrets: (snapshot.secrets || []).map((s) => ({ name: s.name, required: s.required !== false })),
          };
          const files = [
            ...source.map((f) => ({ path: prefixed(run.subdirectory, f.path), content: f.content })),
            { path: prefixed(run.subdirectory, MANIFEST), content: `${JSON.stringify(manifest, null, 2)}\n` },
          ];
          const token = await readJobToken(svc, run.workspace_id, run.credential_ref);

          // Stage 5: validate the token before any long-running GitHub work.
          await validateTokenBeforeSync(svc, run, token);

          // Stage 3: detect branch divergence from the last export base.
          const lastExportSha = link?.last_export_commit_sha || null;
          const div = await detectDivergence(token, run.repo_full_name, run.branch, lastExportSha);
          const strategy = run.conflict_strategy || "fast_forward";

          if (div.diverged) {
            if (strategy === "fast_forward") {
              await patch({ divergence_info: { diverged: true, base_sha: div.base_sha, head_sha: div.head_sha } });
              return finish("FAILED", {
                failure_code: "DIVERGENCE_DETECTED",
                failure_summary: `The branch "${run.branch}" has diverged. The last export was at ${String(div.base_sha || "").slice(0, 7)}, but the branch is now at ${div.head_sha.slice(0, 7)}. Choose a conflict strategy (merge, rebase, or force) and retry.`,
                divergence_info: { diverged: true, base_sha: div.base_sha, head_sha: div.head_sha },
              });
            }
            if (strategy === "force" && !run.force_confirm) {
              return finish("FAILED", {
                failure_code: "FORCE_NOT_CONFIRMED",
                failure_summary: "Force export requires explicit confirmation. Set force_confirm=true to overwrite the diverged branch commits.",
              });
            }
            const changes = await diffAgainstBranch(token, run.repo_full_name, run.branch, files, run.subdirectory);
            await patch({
              status: "COMMITTING",
              current_phase: strategy === "merge" ? "creating a merge commit" : strategy === "force" ? "force-updating the branch" : "rebasing onto the new head",
              version_id: version.id, version_number: version.number,
              file_count: files.length, changed_files: changes.slice(0, 200),
              divergence_info: { diverged: true, base_sha: div.base_sha, head_sha: div.head_sha, strategy },
            });
            continue;
          }

          // No divergence — fast-forward (the existing safe behavior).
          const changes = await diffAgainstBranch(token, run.repo_full_name, run.branch, files, run.subdirectory);
          await patch({
            status: "COMMITTING", current_phase: "creating the GitHub commit",
            version_id: version.id, version_number: version.number,
            file_count: files.length, changed_files: changes.slice(0, 200),
          });
          continue;
        }

        if (run.status === "COMMITTING") {
          // Idempotency: a worker that died after the commit but before recording it must
          // not create a second commit. The ref is checked first, and a commit whose parent
          // is our recorded base is adopted rather than repeated.
          if (run.commit_sha) return finish("COMPLETED", { commit_sha: run.commit_sha });
          const token = await readJobToken(svc, run.workspace_id, run.credential_ref);
          const version = await svc.entities.ProjectVersion.get(run.version_id);
          const snapshot = await unpackSnapshot(version);
          const source = (snapshot.files || []).filter((f) => isProjectSource(f.path));
          const manifest = {
            project: project.name, internal_version: version.number, exported_at: new Date().toISOString(),
            entities: (snapshot.entities || []).map((e) => ({ name: e.name, fields: e.fields || {} })),
            required_secrets: (snapshot.secrets || []).map((s) => ({ name: s.name, required: s.required !== false })),
          };
          const ourFiles = [
            ...source.map((f) => ({ path: prefixed(run.subdirectory, f.path), content: f.content })),
            { path: prefixed(run.subdirectory, MANIFEST), content: `${JSON.stringify(manifest, null, 2)}\n` },
          ];
          const message = run.commit_message || `NexusAI: export ${project.name} internal version ${version.number}`;
          const strategy = run.conflict_strategy || "fast_forward";
          const divInfo = run.divergence_info || {};
          let commitResult, commitFiles = ourFiles;

          if (divInfo.diverged && (strategy === "merge" || strategy === "rebase")) {
            // Stage 3: 3-way merge — read their files from the branch head, base files from
            // the last export, and merge deterministically. Conflicts are surfaced, never
            // silently overwritten.
            const headSha = await getBranchHead(token, run.repo_full_name, run.branch);
            const theirResult = await readCommitFiles(token, run.repo_full_name, headSha, run.subdirectory);
            const baseResult = divInfo.base_sha ? await readCommitFiles(token, run.repo_full_name, divInfo.base_sha, run.subdirectory) : { files: [] };
            const { merged, conflicts } = threeWayMerge(baseResult.files, ourFiles, theirResult.files);
            if (conflicts.length) {
              return finish("FAILED", {
                failure_code: "CONFLICT_DETECTED",
                failure_summary: `${conflicts.length} file(s) have conflicts between your version and the diverged branch. Files: ${conflicts.slice(0, 10).map((c) => c.path).join(", ")}${conflicts.length > 10 ? "..." : ""}`,
                divergence_info: { ...divInfo, conflicts },
              });
            }
            commitFiles = merged;
            const headCommit = await getCommit(token, run.repo_full_name, headSha);
            if (strategy === "merge") {
              commitResult = await createMergeCommit(token, run.repo_full_name, {
                branch: run.branch, files: merged,
                message: `${message}\n\nMerge ${String(divInfo.base_sha || "").slice(0, 7)} with ${headSha.slice(0, 7)}`,
                parents: [headSha, divInfo.base_sha].filter(Boolean),
                baseTreeSha: headCommit.tree_sha, force: false,
              });
            } else {
              commitResult = await createMergeCommit(token, run.repo_full_name, {
                branch: run.branch, files: merged, message,
                parents: [headSha], baseTreeSha: headCommit.tree_sha, force: false,
              });
            }
          } else if (divInfo.diverged && strategy === "force") {
            // Stage 3: force — create commit on top of our base, force-update the ref.
            // This overwrites diverged commits; only reached with explicit force_confirm.
            const baseSha = divInfo.base_sha || (await getBranchHead(token, run.repo_full_name, run.branch));
            const baseCommit = await getCommit(token, run.repo_full_name, baseSha);
            commitResult = await createMergeCommit(token, run.repo_full_name, {
              branch: run.branch, files: ourFiles, message,
              parents: [baseSha], baseTreeSha: baseCommit.tree_sha, force: true,
            });
          } else {
            // No divergence or fast_forward: existing safe behavior.
            const baseSha = await getBranchHead(token, run.repo_full_name, run.branch);
            commitResult = await createCommit(token, run.repo_full_name, { branch: run.branch, files: ourFiles, message, baseSha });
          }

          // Durable mapping: GitHub commit ↔ internal version. The two ids are independent.
          await svc.entities.GitCommitMap.create({
            project_id: project.id, workspace_id: run.workspace_id, repo_full_name: run.repo_full_name,
            branch: run.branch, commit_sha: commitResult.sha, version_id: version.id, version_number: version.number,
            direction: "export", sync_run_id: run.id, actor_user_id: run.user_id,
            build_status: "skipped", file_count: commitFiles.length,
          });
          return finish("COMPLETED", {
            commit_sha: commitResult.sha, base_commit_sha: commitResult.parent_sha, commit_message: message,
            build_status: "skipped", security_scan: "pass",
          });
        }
      }

      // ===================== IMPORT: GitHub → new internal version =================
      if (run.direction === "import") {
        if (run.status === "QUEUED") {
          await patch({ status: "FETCHING", current_phase: "fetching source from GitHub", started_at: run.started_at || new Date().toISOString() });
          continue;
        }

        if (run.status === "FETCHING") {
          const token = await readJobToken(svc, run.workspace_id, run.credential_ref);
          // Stage 5: validate the token before long-running blob reading.
          await validateTokenBeforeSync(svc, run, token);
          const sha = run.commit_sha || (await getBranchHead(token, run.repo_full_name, run.branch));

          // Stage 4: incremental blob reading with a persisted checkpoint. The tree is
          // fetched once; blobs are read in bounded batches, and after each batch the
          // checkpoint is persisted so a worker interruption resumes from the cursor
          // rather than re-reading the entire repository.
          let checkpoint = run.checkpoint_url ? await unpackJson(run.checkpoint_url).catch(() => null) : null;
          if (!checkpoint) {
            const { commit, tree_sha, blobs } = await readCommitTree(token, run.repo_full_name, sha, run.subdirectory);
            if (blobs.length > MAX_FILES) {
              return finish("FAILED", { failure_code: "MALFORMED_REPOSITORY", failure_summary: `Commit contains ${blobs.length} files, above the ${MAX_FILES}-file import limit.` });
            }
            if (!blobs.length) {
              return finish("FAILED", { failure_code: "MALFORMED_REPOSITORY", failure_summary: `No files found in commit ${sha.slice(0, 7)}.` });
            }
            checkpoint = { commit_sha: commit.sha, commit_message: trunc(commit.message, 300), tree_sha, blob_nodes: blobs, blobs_read: 0, files: [] };
          }

          // Read one batch per worker iteration. The checkpoint persists progress, so
          // a partially completed import never produces a partially committed version.
          const { files: batchFiles, done } = await readBlobsBatch(token, run.repo_full_name, checkpoint.blob_nodes, checkpoint.blobs_read);
          checkpoint.files.push(...batchFiles);
          checkpoint.blobs_read += batchFiles.length;

          if (!done) {
            const url = await packJson(svc, `git_checkpoint_${run.id}`, checkpoint);
            await patch({ checkpoint_url: url, current_phase: `reading source (${checkpoint.blobs_read}/${checkpoint.blob_nodes.length})` });
            return { sync_run_id: runId, done: false, status: run.status };
          }

          const url = await packJson(svc, `git_checkpoint_${run.id}`, checkpoint);
          await patch({
            status: "VALIDATING", current_phase: "validating imported source",
            commit_sha: checkpoint.commit_sha, commit_message: checkpoint.commit_message,
            file_count: checkpoint.files.length, checkpoint_url: url,
          });
          continue;
        }

        if (run.status === "VALIDATING") {
          // Load files from the persisted checkpoint (or fall back to all-at-once for
          // backward compatibility with runs created before the checkpoint path).
          let files, commitSha = run.commit_sha, commitMessage = run.commit_message || "";
          const checkpoint = run.checkpoint_url ? await unpackJson(run.checkpoint_url).catch(() => null) : null;
          if (checkpoint) {
            files = checkpoint.files;
            commitSha = checkpoint.commit_sha;
            commitMessage = checkpoint.commit_message || "";
          } else {
            const token = await readJobToken(svc, run.workspace_id, run.credential_ref);
            const result = await readCommitFiles(token, run.repo_full_name, run.commit_sha, run.subdirectory);
            files = result.files;
            commitSha = result.commit.sha;
            commitMessage = trunc(result.commit.message, 300);
          }

          // Everything below happens IN MEMORY. The canonical project is untouched until
          // validation passes, so a failed import cannot corrupt the working project.
          const state = await loadProjectState(svc, project.id);
          const fs = createFs(state.files);
          const incoming = files.filter((f) => isProjectSource(f.path));
          const ignored = files.filter((f) => !isProjectSource(f.path) && normalizePath(f.path) !== MANIFEST).map((f) => f.path);
          if (!incoming.length) {
            return finish("FAILED", { failure_code: "MALFORMED_REPOSITORY", failure_summary: `Commit ${String(commitSha || "").slice(0, 7)} contains no importable project source (expected src/, functions/, integrations/ or styles.css).` });
          }

          const rejected = [];
          for (const f of incoming) {
            try { writeFile(fs, f.path, f.content); } catch (e) { rejected.push(`${f.path}: ${trunc(e.message, 160)}`); }
          }
          if (rejected.length) {
            return finish("FAILED", { failure_code: "MALFORMED_REPOSITORY", failure_summary: `${rejected.length} file(s) in the commit are not valid project source. Nothing was imported.`, build_diagnostics: rejected.slice(0, 20) });
          }
          const present = new Set(incoming.map((f) => normalizePath(f.path)));
          for (const existing of activeFiles(fs)) {
            if (isProjectSource(existing.path) && !present.has(normalizePath(existing.path)) && !existing.frozen) {
              deleteFile(fs, existing.path);
            }
          }

          const manifestFile = files.find((f) => normalizePath(f.path) === MANIFEST);
          let entities = state.entities;
          if (manifestFile) {
            try {
              const parsed = JSON.parse(manifestFile.content);
              if (Array.isArray(parsed.entities) && parsed.entities.length) {
                const byName = new Map(state.entities.map((e) => [e.name, e]));
                entities = parsed.entities.map((e) => {
                  const current = byName.get(e.name);
                  const fields = e.fields || {};
                  return current
                    ? { ...current, fields, dirty: JSON.stringify(current.fields) !== JSON.stringify(fields) }
                    : { id: null, name: e.name, fields, dirty: true };
                });
              }
            } catch {
              return finish("FAILED", { failure_code: "MALFORMED_REPOSITORY", failure_summary: `${MANIFEST} in the commit is not valid JSON. Nothing was imported.` });
            }
          }

          // VALIDATION GATE 1 — the existing build engine.
          const build = runBuild(fs, entities, state.secrets);
          await recordBuild(svc, project.id, null, build).catch(() => {});
          if (build.status !== "success") {
            return finish("FAILED", {
              failure_code: "BUILD_FAILED",
              failure_summary: `The imported commit failed to build with ${build.errors} error(s). The project was left unchanged and no version was created.`,
              build_status: "failed", build_error_count: build.errors,
              build_diagnostics: build.logs.filter((l) => l.startsWith("error")).slice(0, 20),
              security_scan: "unknown",
            });
          }

          // VALIDATION GATE 2 — the same credential scan production deployments use.
          const secretRows = await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 200);
          const clientFiles = activeFiles(fs).filter((f) => !isFunctionPath(f.path) && !isIntegrationPath(f.path));
          const findings = scanForSecrets(clientFiles, secretRows.map((s) => s.value));
          if (findings.length) {
            return finish("FAILED", {
              failure_code: "SECURITY_FAILED",
              failure_summary: `Blocked: ${findings.length} credential finding(s) in the imported source. The project was left unchanged and no version was created.`,
              build_status: "success", security_scan: "fail", security_findings: findings.slice(0, 20),
            });
          }

          const changes = computeChanges(fs);
          if (!changes.length) {
            return finish("COMPLETED", {
              build_status: "success", security_scan: "pass", file_count: incoming.length, changed_files: [],
              failure_summary: null, current_phase: "already up to date",
              build_diagnostics: ignored.length ? [`ignored ${ignored.length} non-source file(s): ${ignored.slice(0, 5).join(", ")}`] : [],
            });
          }
          await patch({
            status: "COMMITTING", current_phase: "creating the internal version",
            build_status: "success", build_error_count: 0, security_scan: "pass", security_findings: [],
            file_count: incoming.length, changed_files: changes.slice(0, 200),
            build_diagnostics: ignored.length ? [`ignored ${ignored.length} non-source file(s): ${ignored.slice(0, 5).join(", ")}`] : [],
          });
          continue;
        }

        if (run.status === "COMMITTING") {
          if (run.version_id) return finish("COMPLETED", { version_id: run.version_id, version_number: run.version_number });
          // Re-validate from the checkpoint before writing: the only path that mutates the
          // canonical project re-derives its input rather than trusting stale state. The
          // checkpoint holds the verified files from the FETCHING phase, so a large repo
          // does not need to re-read every blob on the final commit. A run created before
          // the checkpoint path falls back to a single readCommitFiles call.
          let files;
          const checkpoint = run.checkpoint_url ? await unpackJson(run.checkpoint_url).catch(() => null) : null;
          if (checkpoint) {
            files = checkpoint.files;
          } else {
            const token = await readJobToken(svc, run.workspace_id, run.credential_ref);
            const result = await readCommitFiles(token, run.repo_full_name, run.commit_sha, run.subdirectory);
            files = result.files;
          }
          const state = await loadProjectState(svc, project.id);
          const fs = createFs(state.files);
          const incoming = files.filter((f) => isProjectSource(f.path));
          for (const f of incoming) writeFile(fs, f.path, f.content);
          const present = new Set(incoming.map((f) => normalizePath(f.path)));
          for (const existing of activeFiles(fs)) {
            if (isProjectSource(existing.path) && !present.has(normalizePath(existing.path)) && !existing.frozen) deleteFile(fs, existing.path);
          }
          let entities = state.entities;
          const manifestFile = files.find((f) => normalizePath(f.path) === MANIFEST);
          if (manifestFile) {
            const parsed = JSON.parse(manifestFile.content);
            if (Array.isArray(parsed.entities) && parsed.entities.length) {
              const byName = new Map(state.entities.map((e) => [e.name, e]));
              entities = parsed.entities.map((e) => {
                const current = byName.get(e.name);
                const fields = e.fields || {};
                return current ? { ...current, fields, dirty: JSON.stringify(current.fields) !== JSON.stringify(fields) } : { id: null, name: e.name, fields, dirty: true };
              });
            }
          }
          const build = runBuild(fs, entities, state.secrets);
          if (build.status !== "success") {
            return finish("FAILED", { failure_code: "BUILD_FAILED", failure_summary: `Re-validation before commit failed with ${build.errors} error(s). The project was left unchanged.`, build_status: "failed", build_error_count: build.errors, build_diagnostics: build.logs.filter((l) => l.startsWith("error")).slice(0, 20) });
          }

          // Agent policy immutability, before anything is persisted: a live agent's policy file
          // cannot be modified or removed by a repository import (AGENT_POLICY_IMMUTABLE, 409).
          // Defensive parity with commitMemberEdit/restoreProjectVersion/runPipeline — the
          // isProjectSource() filter already keeps base44/ out of the diff, so this never
          // fires today, but the diff (including deletions) is guarded regardless.
          const pendingChanges = computeChanges(fs);
          await assertNoActiveAgentPolicyWrite(svc, project.id, pendingChanges.map((c) => c.path));

          // Only now does the canonical project change — through the SAME journalled,
          // optimistic-concurrency-protected commit path the AI builder uses: the previous
          // and target states are durable BEFORE anything is mutated, the target version
          // number is fixed at prepare time, and the version-count re-check at finalize
          // refuses (and rolls back) an import that raced a concurrent AI commit instead of
          // silently overwriting it. It produces the same normal immutable version as
          // before, and a resumed or replayed COMMITTING phase re-attaches to the same
          // journal and the same single version.
          // G-4: the importer's CURRENT membership is verified before anything canonical is
          // touched. A removed importer or an inactive workspace fails closed here: nothing
          // is imported, no version is created and the run finishes FAILED.
          try {
            await assertImporterAuthorization(svc, run);
          } catch (e) {
            return finish("FAILED", {
              failure_code: "AUTHORIZATION_REVOKED",
              failure_summary: `The member who started this import no longer has access to this workspace, so nothing was imported and no version was created. (${trunc(e.message, 160)})`,
            });
          }

          const freshProject = await svc.entities.Project.get(project.id).catch(() => null);
          if (!freshProject) return finish("FAILED", { failure_code: "SYNC_ERROR", failure_summary: "The project no longer exists." });
          const journal = await prepareCommit(svc, {
            project: freshProject, workspace: { id: run.workspace_id },
            run: { id: run.id, base_version_number: freshProject.version_count || 0 },
            message: `Imported ${run.repo_full_name}@${run.branch} commit ${run.commit_sha.slice(0, 7)}`,
            changedFiles: pendingChanges,
            target: {
              files: activeFiles(fs),
              entities: entities.map((e) => ({ name: e.name, fields: e.fields, rls: e.rls ?? null })),
              secrets: (state.secrets || []).map((s) => ({ name: s.name, description: s.description || "", required: s.required !== false })),
            },
          });
          let version;
          try {
            version = (await finalizeCommit(svc, journal, { runId: run.id })).version;
          } catch (e) {
            if (e?.code === "VERSION_CONFLICT") {
              // The version-count check fires BEFORE anything canonical is mutated, so there
              // is nothing to restore. Resolving the journal WITHOUT a snapshot/pointer write
              // is what keeps the concurrent commit — the winner — intact.
              await abandonCommit(svc, journal, "version conflict: another commit advanced the project").catch(() => {});
              return finish("FAILED", {
                failure_code: "VERSION_CONFLICT",
                failure_summary: "Another change was committed while this import was running, so the import was discarded to avoid overwriting it. Nothing was imported — retry the import.",
              });
            }
            // Any other failure may have left a partially applied snapshot behind, so the
            // full rollback path — restore the previous state, remove this run's orphan
            // versions — is the correct resolution.
            await rollbackCommit(svc, journal, e.message).catch(() => {});
            throw e;
          }
          await svc.entities.GitCommitMap.create({
            project_id: project.id, workspace_id: run.workspace_id, repo_full_name: run.repo_full_name,
            branch: run.branch, commit_sha: run.commit_sha, version_id: version.id, version_number: version.number,
            direction: "import", sync_run_id: run.id, actor_user_id: run.user_id,
            build_status: "success", file_count: pendingChanges.length,
          });
          // Architecture reconciliation — AFTER the imported version lands, best-effort via the
          // shared wrapper. `run.user_id` is the authenticated user who set up the sync (re-checked
          // for project.write inside reconcileArchitecture); a failure never fails the import.
          if (run.user_id) {
            const importer = await svc.entities.User.get(run.user_id).catch(() => null);
            if (importer) await reconcileArchitectureAfterMutation(svc, importer, { project_id: project.id, run_id: run.id });
          }
          return finish("COMPLETED", { version_id: version.id, version_number: version.number, changed_files: pendingChanges.slice(0, 200), build_status: "success", security_scan: "pass" });
        }
      }

      return { sync_run_id: runId, done: false, status: run.status };
    }
    return { sync_run_id: runId, done: false, status: run.status };
  } catch (e) {
    return failFromGitHub(e);
  }
}