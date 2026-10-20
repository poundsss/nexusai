// GitHub sync control plane: enqueue export/import, cancel, read history.
//
// This function NEVER performs the GitHub work: it authorizes, rejects conflicts, parks the
// job's short-lived credential, and returns immediately. A background worker driven by the
// Git Sync Executor workflow does the rest, so no HTTP request is held open across GitHub
// API calls, repository fetches or commit creation.
//
// It also cannot deploy. Creating an internal version from a commit makes that version
// ELIGIBLE for deployment; going live still requires an explicitly authorized deployment
// through deployProject.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { resolveGitHubToken, requireLinkOwner, requireLinkIdentity } from "../../shared/githubAuth.ts";
import { getRepo, getBranchHead, getCommit, getViewer, GitHubError } from "../../shared/github.ts";
import { GIT_ACTIVE, GIT_TERMINAL, stashJobToken } from "../../shared/gitSync.ts";
import { requireGitHubEntitlement } from "../../shared/githubEntitlement.ts";

const publicRun = (r) =>
  r && {
    id: r.id, direction: r.direction, status: r.status, current_phase: r.current_phase || null,
    repo_full_name: r.repo_full_name, branch: r.branch, subdirectory: r.subdirectory || "",
    commit_sha: r.commit_sha || null, base_commit_sha: r.base_commit_sha || null, commit_message: r.commit_message || null,
    version_id: r.version_id || null, version_number: r.version_number || null,
    changed_files: r.changed_files || [], file_count: r.file_count || 0,
    build_status: r.build_status || "unknown", build_error_count: r.build_error_count || 0,
    build_diagnostics: r.build_diagnostics || [], security_scan: r.security_scan || "unknown",
    security_findings: r.security_findings || [], failure_code: r.failure_code || null,
    failure_summary: r.failure_summary || null, created_date: r.created_date,
    completed_at: r.completed_at || null, duration_ms: r.duration_ms || 0,
    auto: String(r.idempotency_key || "").startsWith("autopush:"),
  };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const action = String(body.action || "history");
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "github.manage");
    const svc = base44.asServiceRole;

    if (action === "history") {
      const [runs, mappings] = await Promise.all([
        svc.entities.GitSyncRun.filter({ project_id: project.id }, "-created_date", 20),
        svc.entities.GitCommitMap.filter({ project_id: project.id }, "-created_date", 30),
      ]);
      return Response.json({
        runs: runs.map(publicRun),
        commit_map: mappings.map((m) => ({
          commit_sha: m.commit_sha, repo_full_name: m.repo_full_name, branch: m.branch,
          version_id: m.version_id, version_number: m.version_number, direction: m.direction,
          build_status: m.build_status, file_count: m.file_count, created_date: m.created_date,
        })),
      });
    }

    if (action === "cancel") {
      const run = await svc.entities.GitSyncRun.get(String(body.sync_run_id || "")).catch(() => null);
      // Cross-project isolation: another project's run is simply not found here.
      if (!run || run.project_id !== project.id) return Response.json({ error: "Sync run not found" }, { status: 404 });
      if (GIT_TERMINAL.includes(run.status)) return Response.json({ error: `This operation already finished as ${run.status}`, status: run.status }, { status: 409 });
      await svc.entities.GitSyncRun.update(run.id, { cancel_requested: true });
      return Response.json({ ok: true, sync_run_id: run.id });
    }

    if (action !== "export" && action !== "import") {
      return Response.json({ error: `Unsupported action ${action}` }, { status: 400 });
    }
    // R-8: export/import need the plan entitlement (history and cancel stay open on every plan).
    await requireGitHubEntitlement(svc, workspace?.id || project.workspace_id);

    const link = (await svc.entities.GitHubLink.filter({ project_id: project.id }, "-created_date", 1))[0];
    if (!link || link.status === "disconnected") {
      return Response.json({ error: "This project is not linked to a GitHub repository.", code: "NOT_LINKED" }, { status: 428 });
    }

    // CONCURRENCY: one source-control operation per project at a time, enforced server-side.
    // Two exports of the same version, or an import while another import is mutating the
    // project, get an explicit conflict rather than racing.
    for (const status of GIT_ACTIVE) {
      const active = await svc.entities.GitSyncRun.filter({ project_id: project.id, status }, "-created_date", 5);
      if (active.length) {
        return Response.json({
          error: `A GitHub ${active[0].direction} is already in progress for this project.`,
          code: "SYNC_IN_PROGRESS", sync_run_id: active[0].id, status: active[0].status,
        }, { status: 409 });
      }
    }

    // CREDENTIAL OWNERSHIP: the operation runs under the CALLING user's own GitHub
    // authorization, and only if that user is the one who linked this repository with that
    // same GitHub identity. One user's credential can never drive another user's link.
    requireLinkOwner(link, user);
    const { accessToken } = await resolveGitHubToken(base44);
    requireLinkIdentity(link, await getViewer(accessToken));
    const repo = await getRepo(accessToken, link.repo_full_name);
    const branch = String(body.branch || link.branch);

    let sourceVersion = null;
    let commitSha = null;
    let idempotency_key = "";

    if (action === "export") {
      if (!repo.can_push) return Response.json({ error: `The connected GitHub account cannot push to ${repo.full_name}.`, code: "GITHUB_PERMISSION_DENIED" }, { status: 403 });
      sourceVersion = body.version_id
        ? await svc.entities.ProjectVersion.get(String(body.version_id)).catch(() => null)
        : (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1))[0];
      if (!sourceVersion || sourceVersion.project_id !== project.id) {
        return Response.json({ error: "Version not found in this project" }, { status: 404 });
      }
      await getBranchHead(accessToken, repo.full_name, branch);
      idempotency_key = `export:${project.id}:${sourceVersion.id}:${repo.full_name}:${branch}`;
    } else {
      commitSha = body.commit_sha ? String(body.commit_sha) : await getBranchHead(accessToken, repo.full_name, branch);
      const commit = await getCommit(accessToken, repo.full_name, commitSha);
      commitSha = commit.sha;
      idempotency_key = `import:${project.id}:${repo.full_name}:${commitSha}`;
    }

    // IDEMPOTENCY: the same logical operation is never performed twice. A duplicate request
    // is answered with the run that already did the work.
    const prior = await svc.entities.GitSyncRun.filter({ project_id: project.id, idempotency_key, status: "COMPLETED" }, "-created_date", 1);
    if (prior.length) {
      return Response.json({ duplicate: true, sync_run_id: prior[0].id, ...publicRun(prior[0]) }, { status: 200 });
    }

    const credentialName = `GITHUB_JOB_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await stashJobToken(svc, { workspace_id: workspace.id, name: credentialName, token: accessToken });

    const run = await svc.entities.GitSyncRun.create({
      project_id: project.id, workspace_id: workspace.id, user_id: user.id, link_id: link.id,
      direction: action, status: "QUEUED", current_phase: "queued",
      repo_full_name: repo.full_name, branch, subdirectory: link.subdirectory || "",
      ...(sourceVersion ? { source_version_id: sourceVersion.id, version_number: sourceVersion.number } : {}),
      ...(commitSha ? { commit_sha: commitSha } : {}),
      ...(body.commit_message ? { commit_message: String(body.commit_message).slice(0, 300) } : {}),
      idempotency_key, credential_ref: credentialName,
      heartbeat_at: new Date().toISOString(),
    });

    await audit(base44, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `github.${action}.started`, resource: "GitSyncRun", resource_id: run.id,
      metadata: {
        repo: repo.full_name, branch, subdirectory: link.subdirectory || "",
        version_id: sourceVersion?.id || null, version_number: sourceVersion?.number || null,
        commit_sha: commitSha || null,
      },
    });

    return Response.json({ sync_run_id: run.id, status: "QUEUED", direction: action, repo_full_name: repo.full_name, branch, commit_sha: commitSha, version_number: sourceVersion?.number || null }, { status: 202 });
  } catch (error) {
    const status = error instanceof GitHubError ? (error.status && error.status < 500 ? error.status : 502) : error.status || 500;
    return Response.json({ error: error.message, code: error.code || null }, { status });
  }
}