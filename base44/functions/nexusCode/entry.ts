// Nexus Code — the first Base Code implementation slice: a global, per-user GitHub working
// surface at /nexus-code. It reuses the certified primitives exclusively:
//   • credential ... githubAuth.resolveGitHubToken (per-user, request-scoped, never stored)
//   • REST ........ shared/github.ts (getViewer/listRepos/getRepo/listBranches/getBranchHead/
//                   readCommitTree/readBlobsBatch/createCommit/createRef/deleteRef/
//                   createPullRequest/detectDivergence)
//   • audit ....... authz.audit (best-effort, attributed to the caller's workspace)
// It deliberately does NOT touch GitSync (the export/import version pipeline), Source Control
// semantics, deployment environments or the project filesystem. Sessions are owned by the
// connecting user and every read/mutation is filtered by user_id server-side.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { resolveGitHubToken, GITHUB_CONNECTOR_ID } from "../../shared/githubAuth.ts";
import {
  getViewer, listRepos, getRepo, listBranches, getBranchHead, readCommitTree, readBlobsBatch,
  createCommit, createRef, createPullRequest, detectDivergence, GitHubError, BLOB_BATCH,
  getPullRequest, findOpenPullRequest, listPullRequestComments, compareCommits, mergeBranches, commitMergeTree,
} from "../../shared/github.ts";
import { audit } from "../../shared/authz.ts";
import { requireGitHubEntitlement } from "../../shared/githubEntitlement.ts";
import { resolveRole, can } from "../../shared/rbac.ts";
import {
  NEXUS_CODE_LIMITS, isBrowseablePath, isEditablePath, validBranchName,
  validateCommitFiles, buildEditPrompt, parseEditResult, pushChat,
  buildPrDraftPrompt, parsePrDraft, buildConflictMergePrompt, parseConflictMerge,
} from "../../shared/nexusCode.ts";

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);
const slug = (text) =>
  String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

const publicSession = (s) =>
  s && {
    id: s.id, repo_full_name: s.repo_full_name, repo_default_branch: s.repo_default_branch || null,
    base_branch: s.base_branch, working_branch: s.working_branch || null, subdirectory: s.subdirectory || "",
    base_head_sha: s.base_head_sha || null, head_sha: s.head_sha || null,
    created_by_branch: !!s.created_by_branch,
    last_pr_url: s.last_pr_url || null, last_pr_number: s.last_pr_number ?? null,
    chat: (s.chat || []).slice(-NEXUS_CODE_LIMITS.CHAT_LIMIT),
    updated_date: s.updated_date || null,
  };

async function resolveWorkspace(svc, user) {
  const memberships = await svc.entities.WorkspaceMember.filter({ user_id: user.id }, "-created_date", 5).catch(() => []);
  for (const m of memberships) {
    const ws = await svc.entities.Workspace.get(m.workspace_id).catch(() => null);
    if (ws) return ws;
  }
  return null;
}

async function auditSafe(svc, workspaceId, userId, action, metadata) {
  if (!workspaceId) return;
  await audit(svc, {
    workspace_id: workspaceId, project_id: null, user_id: userId,
    action, resource: "NexusCodeSession", resource_id: metadata?.session_id || null, metadata,
  }).catch(() => {});
}

async function loadSession(svc, sessionId, userId) {
  const s = sessionId ? await svc.entities.NexusCodeSession.get(sessionId).catch(() => null) : null;
  if (!s || s.status !== "connected" || s.user_id !== userId) {
    throw Object.assign(new Error("Nexus Code session not found, deleted, or not yours."), { status: 404, code: "SESSION_NOT_FOUND" });
  }
  return s;
}

const branchMoved = (branch) =>
  Object.assign(new Error(`The working branch "${branch}" moved outside Nexus Code. Review it on GitHub, then re-select it.`), { status: 409, code: "BRANCH_MOVED" });

// Workspace role gate (Base44 parity: owners/admins/editors create and work on projects;
// viewers/guests fail closed). Reuses the EXISTING rbac capability matrix — no invented
// roles, no second authorization system. Read-only actions (browsing, PR comment listing)
// and branch navigation (switch) stay open to members, matching Base44's read-only mode.
async function requireProjectWrite(svc, workspaceId, user) {
  const wsId = workspaceId || (await resolveWorkspace(svc, user))?.id || null;
  if (!wsId) throw Object.assign(new Error("Nexus Code changes require a workspace membership."), { status: 403, code: "FORBIDDEN" });
  const workspace = await svc.entities.Workspace.get(wsId).catch(() => null);
  const role = workspace ? await resolveRole(svc, workspace, user) : null;
  if (!role) throw Object.assign(new Error("You do not have access to this workspace."), { status: 403, code: "NOT_A_MEMBER" });
  if (!can(role, "project.write")) {
    throw Object.assign(new Error(`Your workspace role (${role}) cannot make Nexus Code changes. Ask an editor or admin for write access.`), { status: 403, code: "INSUFFICIENT_ROLE" });
  }
  return { workspace_id: wsId, role };
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");
    const sessionId = body.session_id ? String(body.session_id) : null;
    // R-8: every GitHub-touching action needs the plan entitlement; status and session delete
    // stay open. The workspace is the caller's own session's, else the caller's workspace.
    if (action !== "status" && action !== "delete") {
      const own = sessionId ? (await svc.entities.NexusCodeSession.filter({ id: sessionId, user_id: user.id }, "-created_date", 1))[0] : null;
      await requireGitHubEntitlement(svc, own?.workspace_id || (await resolveWorkspace(svc, user))?.id || null);
    }

    // ---- connection + pickers (per-user credential, resolved per request) ----
    if (action === "status") {
      // The UI's connection check is strictly the CALLING user's own app-user
      // connection — never the workspace-level platform authorization, which belongs
      // to the builder and must not make a new user appear connected.
      let account = null;
      let connected = false;
      try {
        const conn = await base44.asServiceRole.connectors.getCurrentAppUserConnection(GITHUB_CONNECTOR_ID);
        if (conn?.accessToken) {
          account = await getViewer(conn.accessToken);
          connected = true;
        }
      } catch { /* not connected for this user */ }
      // Fail closed: an existing session may only ever be RESTORED once the calling
      // user's own GitHub app-user connection is confirmed. Without a connection the
      // caller gets no sessions at all — the entry screen is the only surface.
      const sessions = connected
        ? (await svc.entities.NexusCodeSession.filter({ user_id: user.id, status: "connected" }, "-updated_date", 20)).map(publicSession)
        : [];
      return Response.json({ connected, account, sessions });
    }

    if (action === "repos") {
      const { accessToken } = await resolveGitHubToken(base44);
      return Response.json({ repos: await listRepos(accessToken) });
    }

    if (action === "branches") {
      const { accessToken } = await resolveGitHubToken(base44);
      const repo = await getRepo(accessToken, String(body.repo_full_name || ""));
      if (!repo.can_push) {
        return Response.json({ error: `The connected GitHub account cannot push to ${repo.full_name}.`, code: "GITHUB_PERMISSION_DENIED" }, { status: 403 });
      }
      return Response.json({ repo, branches: await listBranches(accessToken, repo.full_name) });
    }

    if (action === "connect") {
      const { accessToken } = await resolveGitHubToken(base44);
      const repo = await getRepo(accessToken, String(body.repo_full_name || ""));
      if (!repo.can_push) {
        return Response.json({ error: `The connected GitHub account cannot push to ${repo.full_name}.`, code: "GITHUB_PERMISSION_DENIED" }, { status: 403 });
      }
      const branch = String(body.base_branch || repo.default_branch);
      const branches = await listBranches(accessToken, repo.full_name);
      if (!branches.some((b) => b.name === branch)) {
        return Response.json({ error: `Branch "${branch}" does not exist in ${repo.full_name}.`, code: "BRANCH_NOT_FOUND" }, { status: 404 });
      }
      const baseHead = await getBranchHead(accessToken, repo.full_name, branch);
      const subdirectory = trunc(String(body.subdirectory || "").replace(/^\/+|\/+$/g, ""), 120);
      const workspace = await resolveWorkspace(svc, user);
      await requireProjectWrite(svc, workspace?.id, user);
      const data = {
        user_id: user.id, workspace_id: workspace?.id || null,
        repo_full_name: repo.full_name, repo_default_branch: repo.default_branch,
        base_branch: branch, base_head_sha: baseHead, subdirectory,
        working_branch: null, head_sha: baseHead, created_by_branch: false,
        status: "connected", chat: [], last_pr_url: null, last_pr_number: null,
      };
      const existing = (await svc.entities.NexusCodeSession.filter({ user_id: user.id, repo_full_name: repo.full_name, status: "connected" }, "-created_date", 1))[0] || null;
      const session = existing ? await svc.entities.NexusCodeSession.update(existing.id, data) : await svc.entities.NexusCodeSession.create(data);
      await auditSafe(svc, workspace?.id, user.id, existing ? "nexus_code.relinked" : "nexus_code.connected", {
        session_id: session.id, repo: repo.full_name, base_branch: branch, subdirectory,
      });
      return Response.json({ session: publicSession(session) });
    }

    // ---- bounded repository browsing ----
    if (action === "tree") {
      const session = await loadSession(svc, sessionId, user.id);
      const { accessToken } = await resolveGitHubToken(base44);
      const target = session.working_branch || session.base_branch;
      const head = await getBranchHead(accessToken, session.repo_full_name, target);
      const { commit, blobs } = await readCommitTree(accessToken, session.repo_full_name, head, session.subdirectory || undefined);
      return Response.json({
        head_sha: head, branch: target,
        commit: { sha: commit.sha, message: trunc(commit.message, 200), date: commit.date },
        files: blobs.slice(0, NEXUS_CODE_LIMITS.MAX_TREE_NODES),
      });
    }

    if (action === "file") {
      const session = await loadSession(svc, sessionId, user.id);
      const path = String(body.path || "");
      if (!isBrowseablePath(path)) {
        return Response.json({ error: "This path cannot be browsed.", code: "BAD_PATH" }, { status: 400 });
      }
      const { accessToken } = await resolveGitHubToken(base44);
      const target = session.working_branch || session.base_branch;
      const head = await getBranchHead(accessToken, session.repo_full_name, target);
      const tree = await readCommitTree(accessToken, session.repo_full_name, head, session.subdirectory || undefined);
      const node = tree.blobs.find((n) => n.path === path);
      if (!node) {
        return Response.json({ error: `File "${path}" was not found on ${target}.`, code: "NOT_FOUND" }, { status: 404 });
      }
      if ((node.size || 0) > NEXUS_CODE_LIMITS.MAX_FILE_BYTES) {
        return Response.json({ error: `"${path}" is above the ${NEXUS_CODE_LIMITS.MAX_FILE_BYTES}-byte browse limit.`, code: "FILE_TOO_LARGE" }, { status: 400 });
      }
      const { files } = await readBlobsBatch(accessToken, session.repo_full_name, [node], 0);
      return Response.json({ path, content: files[0].content, size: node.size || 0, branch: target, head_sha: head });
    }

    // ---- per-branch DEVELOPMENT preview source ----
    // Confirmed Base44 behavior: each active branch has its own development environment/
    // preview; the preview is development-only and production release stays with the
    // deployment flow. This action READS the active working branch's browsable text files,
    // bounded; the client bundles them into the existing sandboxed preview runtime. It
    // performs NO writes, touches NO deployment or project records, and keeps the same
    // fail-closed branch guard as every mutating action.
    if (action === "preview_files") {
      const session = await loadSession(svc, sessionId, user.id);
      const { accessToken } = await resolveGitHubToken(base44);
      const target = session.working_branch || session.base_branch;
      const head = await getBranchHead(accessToken, session.repo_full_name, target);
      if (session.working_branch && session.head_sha && head !== session.head_sha) throw branchMoved(target);
      const { blobs } = await readCommitTree(accessToken, session.repo_full_name, head, session.subdirectory || undefined);
      const nodes = [];
      let total = 0;
      for (const n of blobs) {
        if (!isBrowseablePath(n.path) || (n.size || 0) > NEXUS_CODE_LIMITS.MAX_FILE_BYTES) continue;
        if (nodes.length >= NEXUS_CODE_LIMITS.MAX_PREVIEW_FILES || total + (n.size || 0) > NEXUS_CODE_LIMITS.MAX_TOTAL_BYTES) break;
        nodes.push(n); total += n.size || 0;
      }
      const files = [];
      for (let i = 0; i < nodes.length; i += BLOB_BATCH) {
        const { files: batch } = await readBlobsBatch(accessToken, session.repo_full_name, nodes, i);
        files.push(...batch);
      }
      await auditSafe(svc, session.workspace_id, user.id, "nexus_code.preview.opened", {
        session_id: session.id, repo: session.repo_full_name, branch: target, head_sha: head, files: files.length,
      });
      return Response.json({ branch: target, head_sha: head, files });
    }

    // ---- branches ----
    if (action === "create_branch") {
      const session = await loadSession(svc, sessionId, user.id);
      if (session.working_branch) {
        return Response.json({ error: `Working branch "${session.working_branch}" is already active. Switch or delete it first.`, code: "BRANCH_ACTIVE" }, { status: 409 });
      }
      let name = trunc(String(body.name || "").trim(), 200);
      if (!name) name = `nexus/${Date.now().toString(36)}`;
      if (!validBranchName(name)) {
        return Response.json({ error: `Branch name "${name}" is not a valid Git branch name.`, code: "BAD_BRANCH_NAME" }, { status: 400 });
      }
      // Base44 parity ("Start from"): the branch may start from any EXISTING branch; the
      // default stays the session's base branch.
      const fromBranch = trunc(String(body.from_branch || "").trim(), 200) || session.base_branch;
      await requireProjectWrite(svc, session.workspace_id, user);
      const { accessToken } = await resolveGitHubToken(base44);
      const branches = await listBranches(accessToken, session.repo_full_name);
      if (branches.some((b) => b.name === name)) {
        return Response.json({ error: `Branch "${name}" already exists in ${session.repo_full_name}.`, code: "BRANCH_EXISTS" }, { status: 409 });
      }
      if (!branches.some((b) => b.name === fromBranch)) {
        return Response.json({ error: `Branch "${fromBranch}" does not exist in ${session.repo_full_name}.`, code: "BRANCH_NOT_FOUND" }, { status: 404 });
      }
      const fromHead = await getBranchHead(accessToken, session.repo_full_name, fromBranch);
      await createRef(accessToken, session.repo_full_name, name, fromHead);
      const saved = await svc.entities.NexusCodeSession.update(session.id, {
        working_branch: name, head_sha: fromHead, created_by_branch: true,
        chat: pushChat(session.chat, [{ role: "system", text: `Created working branch ${name} from ${fromBranch}` }]),
      });
      await auditSafe(svc, session.workspace_id, user.id, "nexus_code.branch.created", { session_id: session.id, repo: session.repo_full_name, branch: name, from_branch: fromBranch });
      return Response.json({ session: publicSession(saved) });
    }

    if (action === "switch_branch") {
      const session = await loadSession(svc, sessionId, user.id);
      const name = trunc(String(body.branch || "").trim(), 200);
      if (!validBranchName(name)) {
        return Response.json({ error: `Branch name "${name}" is not a valid Git branch name.`, code: "BAD_BRANCH_NAME" }, { status: 400 });
      }
      const { accessToken } = await resolveGitHubToken(base44);
      const branches = await listBranches(accessToken, session.repo_full_name);
      if (!branches.some((b) => b.name === name)) {
        return Response.json({ error: `Branch "${name}" does not exist in ${session.repo_full_name}.`, code: "BRANCH_NOT_FOUND" }, { status: 404 });
      }
      if (name === session.working_branch) return Response.json({ session: publicSession(session) });
      const head = await getBranchHead(accessToken, session.repo_full_name, name);
      const saved = await svc.entities.NexusCodeSession.update(session.id, {
        working_branch: name, head_sha: head, created_by_branch: false,
        chat: pushChat(session.chat, [{ role: "system", text: `Switched to branch ${name}` }]),
      });
      await auditSafe(svc, session.workspace_id, user.id, "nexus_code.branch.switched", { session_id: session.id, repo: session.repo_full_name, branch: name });
      return Response.json({ session: publicSession(saved) });
    }

    // ---- branch-scoped AI edit chat (edit → commit → push in one turn) ----
    if (action === "edit") {
      const session = await loadSession(svc, sessionId, user.id);
      await requireProjectWrite(svc, session.workspace_id, user);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return Response.json({ error: "Describe the change you want." }, { status: 400 });
      if (prompt.length > NEXUS_CODE_LIMITS.PROMPT_MAX) {
        return Response.json({ error: `The description is above the ${NEXUS_CODE_LIMITS.PROMPT_MAX}-character limit.` }, { status: 400 });
      }
      const { accessToken } = await resolveGitHubToken(base44);
      const repo = session.repo_full_name;

      // Reuse the active working branch, or create one from the base branch now — the
      // change description names it. The working branch is never a production pointer.
      let branch = session.working_branch;
      let createdBranch = false;
      if (!branch) {
        branch = `nexus/${slug(prompt) || Date.now().toString(36)}`;
        const branches = await listBranches(accessToken, repo);
        if (branches.some((b) => b.name === branch)) branch = `nexus/${slug(prompt) || "change"}-${Date.now().toString(36)}`;
        const baseHead = await getBranchHead(accessToken, repo, session.base_branch);
        await createRef(accessToken, repo, branch, baseHead);
        createdBranch = true;
      }
      const head = await getBranchHead(accessToken, repo, branch);
      if (session.working_branch && session.head_sha && head !== session.head_sha) throw branchMoved(branch);

      // Bounded context: the working tree's paths plus contents of small text files.
      const { blobs } = await readCommitTree(accessToken, repo, head, session.subdirectory || undefined);
      const context = [];
      let totalCtx = 0;
      for (const node of blobs) {
        if (!isBrowseablePath(node.path) || (node.size || 0) > NEXUS_CODE_LIMITS.EDIT_CONTEXT_FILE_BYTES) continue;
        if (context.length >= NEXUS_CODE_LIMITS.EDIT_CONTEXT_FILES || totalCtx + (node.size || 0) > NEXUS_CODE_LIMITS.EDIT_TOTAL_BYTES) continue;
        const { files } = await readBlobsBatch(accessToken, repo, [node], 0);
        context.push(files[0]);
        totalCtx += node.size || 0;
      }

      const llm = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: buildEditPrompt({
          repoFull: repo, baseBranch: session.base_branch, workingBranch: branch,
          treePaths: blobs.slice(0, 200).map((n) => n.path), fileContents: context, prompt,
        }),
        response_json_schema: {
          type: "object",
          properties: {
            reply: { type: "string" },
            files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
          },
          required: ["reply", "files"],
        },
      });
      const { reply, files } = parseEditResult(llm);

      let commitSha = null;
      if (files.length) {
        const result = await createCommit(accessToken, repo, {
          branch, files, message: `Nexus Code: ${trunc(prompt, 100)}`, baseSha: head,
        });
        commitSha = result.sha;
      }
      const saved = await svc.entities.NexusCodeSession.update(session.id, {
        working_branch: branch, head_sha: commitSha || head,
        created_by_branch: createdBranch || !!session.created_by_branch,
        chat: pushChat(session.chat, [
          { role: "user", text: trunc(prompt, 2000) },
          { role: "assistant", text: trunc(reply, 2000), ...(commitSha ? { sha: commitSha, files: files.map((f) => f.path) } : {}) },
        ]),
      });
      const ws = session.workspace_id ? { id: session.workspace_id } : await resolveWorkspace(svc, user);
      await auditSafe(svc, ws?.id, user.id, createdBranch ? "nexus_code.edit.created_branch" : "nexus_code.edit.committed", {
        session_id: session.id, repo, branch, commit_sha: commitSha, files: files.map((f) => f.path),
      });
      return Response.json({
        session: publicSession(saved), reply, commit_sha: commitSha,
        changed_files: files.map((f) => f.path), branch, created_branch: createdBranch,
      });
    }

    // ---- manual commit + push to the working branch ----
    if (action === "commit") {
      const session = await loadSession(svc, sessionId, user.id);
      await requireProjectWrite(svc, session.workspace_id, user);
      if (!session.working_branch) {
        return Response.json({ error: "Create or switch to a working branch before committing.", code: "NEEDS_BRANCH" }, { status: 409 });
      }
      const files = validateCommitFiles(body.files || []);
      const message = trunc(String(body.message || "Nexus Code commit"), NEXUS_CODE_LIMITS.COMMIT_MESSAGE_MAX) || "Nexus Code commit";
      const { accessToken } = await resolveGitHubToken(base44);
      const head = await getBranchHead(accessToken, session.repo_full_name, session.working_branch);
      if (session.head_sha && head !== session.head_sha) throw branchMoved(session.working_branch);
      const result = await createCommit(accessToken, session.repo_full_name, {
        branch: session.working_branch, files, message, baseSha: head,
      });
      const saved = await svc.entities.NexusCodeSession.update(session.id, {
        head_sha: result.sha,
        chat: pushChat(session.chat, [{ role: "user", text: `Committed ${files.length} file(s): ${trunc(message, 300)}`, sha: result.sha, files: files.map((f) => f.path) }]),
      });
      await auditSafe(svc, session.workspace_id, user.id, "nexus_code.commit.pushed", {
        session_id: session.id, repo: session.repo_full_name, branch: session.working_branch, commit_sha: result.sha, files: files.map((f) => f.path),
      });
      return Response.json({ session: publicSession(saved), commit_sha: result.sha, changed_files: files.map((f) => f.path) });
    }

    // ---- branch state + changed-file list ----
    if (action === "state") {
      const session = await loadSession(svc, sessionId, user.id);
      const { accessToken } = await resolveGitHubToken(base44);
      const target = session.working_branch || session.base_branch;
      const head = await getBranchHead(accessToken, session.repo_full_name, target);
      const div = await detectDivergence(accessToken, session.repo_full_name, target, session.head_sha || null);
      const compareBase = session.working_branch ? (session.base_head_sha || null) : null;
      let changed_files = [];
      if (compareBase && compareBase !== head) {
        const baseTree = await readCommitTree(accessToken, session.repo_full_name, compareBase, session.subdirectory || undefined);
        const headTree = await readCommitTree(accessToken, session.repo_full_name, head, session.subdirectory || undefined);
        const baseMap = new Map(baseTree.blobs.map((n) => [n.path, n.sha]));
        const headMap = new Map(headTree.blobs.map((n) => [n.path, n.sha]));
        for (const [p, sha] of headMap) {
          if (!baseMap.has(p)) changed_files.push({ path: p, change: "added" });
          else if (baseMap.get(p) !== sha) changed_files.push({ path: p, change: "modified" });
        }
        for (const p of baseMap.keys()) if (!headMap.has(p)) changed_files.push({ path: p, change: "removed" });
        changed_files = changed_files.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200);
      }
      return Response.json({
        branch: target, head_sha: head, diverged: div.diverged,
        base_branch: session.base_branch, working_branch: session.working_branch || null,
        changed_files, last_pr_url: session.last_pr_url || null,
      });
    }

    // ---- per-file before/after for the client-side line diff ----
    if (action === "diff_file") {
      const session = await loadSession(svc, sessionId, user.id);
      const path = String(body.path || "");
      if (!isBrowseablePath(path)) {
        return Response.json({ error: "This path cannot be diffed.", code: "BAD_PATH" }, { status: 400 });
      }
      const { accessToken } = await resolveGitHubToken(base44);
      const afterHead = await getBranchHead(accessToken, session.repo_full_name, session.working_branch || session.base_branch);
      const beforeSha = session.working_branch ? (session.base_head_sha || null) : null;
      const readAt = async (commitSha) => {
        if (!commitSha) return null;
        const tree = await readCommitTree(accessToken, session.repo_full_name, commitSha, session.subdirectory || undefined);
        const node = tree.blobs.find((n) => n.path === path);
        if (!node || (node.size || 0) > NEXUS_CODE_LIMITS.MAX_FILE_BYTES) return null;
        const { files } = await readBlobsBatch(accessToken, session.repo_full_name, [node], 0);
        return files[0].content;
      };
      const [before, after] = await Promise.all([readAt(beforeSha), readAt(afterHead)]);
      if (before === null && after === null) {
        return Response.json({ error: `File "${path}" is not present on either side of the diff.`, code: "NOT_FOUND" }, { status: 404 });
      }
      return Response.json({ path, before, after });
    }

    // ---- pull request (scope confirmed: the GitHub connector grants repo/PR write) ----
    if (action === "pr") {
      const session = await loadSession(svc, sessionId, user.id);
      await requireProjectWrite(svc, session.workspace_id, user);
      if (!session.working_branch || session.working_branch === session.base_branch) {
        return Response.json({ error: "Open a pull request from a working branch that differs from the base branch.", code: "NEEDS_BRANCH" }, { status: 409 });
      }
      if (!session.head_sha || session.head_sha === session.base_head_sha) {
        return Response.json({ error: "The working branch has no commits yet — make a change first.", code: "NO_COMMITS" }, { status: 409 });
      }
      const { accessToken } = await resolveGitHubToken(base44);
      const repo = session.repo_full_name;

      // Base44 parity: the pull request tracks the branch — an OPEN PR with the same
      // head→base keeps receiving the branch's further commits, so it is REUSED instead of
      // duplicated. A closed/missing pointer falls back to a live open-PR lookup.
      let pr = null;
      if (session.last_pr_number) {
        const existing = await getPullRequest(accessToken, repo, session.last_pr_number).catch(() => null);
        if (existing && existing.state === "open" && existing.head_ref === session.working_branch && existing.base_ref === session.base_branch) pr = existing;
      }
      if (!pr) pr = await findOpenPullRequest(accessToken, repo, { head: session.working_branch, base: session.base_branch });
      let created = false;
      if (!pr) {
        let title = trunc(String(body.title || "").trim(), NEXUS_CODE_LIMITS.PR_TITLE_MAX);
        let prBody = trunc(String(body.body || ""), NEXUS_CODE_LIMITS.PR_BODY_MAX);
        if (!title) {
          // Base44 parity: "The AI chat writes the title and description from your
          // conversation and committed changes."
          const draft = parsePrDraft(
            await base44.asServiceRole.integrations.Core.InvokeLLM({
              prompt: buildPrDraftPrompt({
                repoFull: repo, workingBranch: session.working_branch, baseBranch: session.base_branch,
                chat: (session.chat || []).slice(-20),
              }),
              response_json_schema: {
                type: "object",
                properties: { title: { type: "string" }, body: { type: "string" } },
                required: ["title", "body"],
              },
            }),
            `Nexus Code: ${trunc(session.working_branch, 120)}`,
          );
          title = draft.title;
          prBody = prBody || draft.body;
        }
        pr = await createPullRequest(accessToken, repo, { title, body: prBody, head: session.working_branch, base: session.base_branch });
        created = true;
      }
      const saved = await svc.entities.NexusCodeSession.update(session.id, {
        last_pr_url: pr.url, last_pr_number: pr.number,
        chat: pushChat(session.chat, [{ role: "system", text: created ? `Opened pull request #${pr.number}: ${pr.url}` : `Continuing on pull request #${pr.number}: ${pr.url}` }]),
      });
      await auditSafe(svc, session.workspace_id, user.id, created ? "nexus_code.pr.opened" : "nexus_code.pr.reused", {
        session_id: session.id, repo, head: session.working_branch, base: session.base_branch, pr_number: pr.number,
      });
      return Response.json({ session: publicSession(saved), pr, created });
    }

    // ---- branch resync (explicit recovery after out-of-band movement) ----
    // Base44 behavior: a returning environment continues from the LATEST commit on the
    // branch. Nexus Code keeps the fail-closed guard for writes; recovery is THIS explicit
    // action — the live head is adopted only after the user confirms, never silently.
    if (action === "resync") {
      const session = await loadSession(svc, sessionId, user.id);
      if (!session.working_branch) {
        return Response.json({ error: "No working branch to resync.", code: "NO_BRANCH" }, { status: 409 });
      }
      const { accessToken } = await resolveGitHubToken(base44);
      let liveHead;
      try {
        liveHead = await getBranchHead(accessToken, session.repo_full_name, session.working_branch);
      } catch (e) {
        if (e.status === 404 || e.code === "NOT_FOUND") {
          return Response.json({ error: `The working branch "${session.working_branch}" no longer exists on GitHub.`, code: "BRANCH_NOT_FOUND" }, { status: 404 });
        }
        throw e;
      }
      if (liveHead === session.head_sha) {
        return Response.json({ resynced: false, session: publicSession(session) });
      }
      const saved = await svc.entities.NexusCodeSession.update(session.id, {
        head_sha: liveHead,
        chat: pushChat(session.chat, [{ role: "system", text: `Resynced ${session.working_branch}: adopted new head ${String(liveHead).slice(0, 7)} (the branch moved outside Nexus Code)` }]),
      });
      await auditSafe(svc, session.workspace_id, user.id, "nexus_code.branch.resynced", {
        session_id: session.id, repo: session.repo_full_name, branch: session.working_branch, adopted_sha: liveHead,
      });
      return Response.json({ resynced: true, session: publicSession(saved) });
    }

    // ---- review comments (READ-ONLY; Base44 parity: listing PR feedback before addressing it) ----
    if (action === "pr_comments") {
      const session = await loadSession(svc, sessionId, user.id);
      if (!session.last_pr_number) {
        return Response.json({ error: "No pull request on this session yet.", code: "NO_PR" }, { status: 409 });
      }
      const { accessToken } = await resolveGitHubToken(base44);
      const pr = await getPullRequest(accessToken, session.repo_full_name, session.last_pr_number);
      if (pr.state !== "open") {
        return Response.json({ error: `Pull request #${session.last_pr_number} is not open.`, code: "PR_NOT_OPEN" }, { status: 409 });
      }
      const threads = await listPullRequestComments(accessToken, session.repo_full_name, session.last_pr_number);
      return Response.json({ pr, comments: threads.comments, reviews: threads.reviews });
    }

    // ---- conflict resolution (Base44 parity: merge the PR base branch INTO the working
    // branch; the PR itself is never merged here) ----
    if (action === "resolve_conflicts") {
      const session = await loadSession(svc, sessionId, user.id);
      await requireProjectWrite(svc, session.workspace_id, user);
      if (!session.working_branch || session.working_branch === session.base_branch) {
        return Response.json({ error: "Resolve conflicts from a working branch that differs from the base branch.", code: "NEEDS_BRANCH" }, { status: 409 });
      }
      if (!session.base_head_sha) {
        return Response.json({ error: "This session has no recorded base head — reconnect the repository first.", code: "NO_BASE_HEAD" }, { status: 409 });
      }
      const { accessToken } = await resolveGitHubToken(base44);
      const repo = session.repo_full_name;
      const workingHead = await getBranchHead(accessToken, repo, session.working_branch);
      if (session.head_sha && workingHead !== session.head_sha) throw branchMoved(session.working_branch);
      const baseHead = await getBranchHead(accessToken, repo, session.base_branch);
      if (baseHead === session.base_head_sha) {
        return Response.json({ error: "The base branch has not moved — there is nothing to resolve.", code: "NO_CONFLICTS" }, { status: 409 });
      }

      // Fast path: GitHub merges cleanly (a real content conflict is returned, not thrown).
      const merge = await mergeBranches(accessToken, repo, { into: session.working_branch, from: session.base_branch });
      let commitSha = null;
      let reply = "";
      let resolved_files = [];
      if (merge.up_to_date) {
        return Response.json({ error: "The working branch already contains the base branch.", code: "NO_CONFLICTS" }, { status: 409 });
      }
      if (merge.merged) {
        commitSha = merge.sha;
        reply = `Merged ${session.base_branch} into ${session.working_branch} cleanly (merge commit ${String(commitSha || "").slice(0, 7)}).`;
      } else {
        // Conflict path: merge commit built from the working tree + the base side's
        // non-conflicted changes + AI-merged content for files BOTH sides changed.
        const sub = session.subdirectory ? `${session.subdirectory.replace(/^\/+|\/+$/g, "")}/` : "";
        const inSub = (p) => !sub || p.startsWith(sub);
        const stripSub = (p) => (sub && p.startsWith(sub) ? p.slice(sub.length) : p);
        const baseSide = (await compareCommits(accessToken, repo, session.base_head_sha, baseHead))
          .filter((f) => inSub(f.filename) && isBrowseablePath(stripSub(f.filename)));
        const workSide = await compareCommits(accessToken, repo, session.base_head_sha, workingHead);
        const workStatus = new Map(workSide.map((f) => [f.filename, f.status]));
        const conflicts = baseSide.filter((f) => (f.status === "modified" || f.status === "added") && workStatus.has(f.filename));
        const taken = baseSide.filter((f) => (f.status === "modified" || f.status === "added") && !workStatus.has(f.filename));
        const removed = baseSide.filter((f) => f.status === "removed" && !workStatus.has(f.filename));
        if (conflicts.length > NEXUS_CODE_LIMITS.CONFLICT_MAX_FILES) {
          return Response.json({ error: `${conflicts.length} files conflict — above the ${NEXUS_CODE_LIMITS.CONFLICT_MAX_FILES}-file automatic limit. Resolve the rest on GitHub.`, code: "TOO_MANY_CONFLICTS" }, { status: 400 });
        }
        const workTree = await readCommitTree(accessToken, repo, workingHead, session.subdirectory || undefined);
        const baseTree = await readCommitTree(accessToken, repo, baseHead, session.subdirectory || undefined);
        const workMap = new Map(workTree.blobs.map((n) => [n.path, n]));
        const baseMap = new Map(baseTree.blobs.map((n) => [n.path, n]));
        const entries = [];
        for (const f of taken) {
          const node = baseMap.get(stripSub(f.filename));
          if (node) entries.push({ path: f.filename, sha: node.sha });
        }
        for (const f of removed) entries.push({ path: f.filename, delete: true });
        const inputs = [];
        for (const f of conflicts) {
          const rel = stripSub(f.filename);
          const wb = workMap.get(rel);
          const bb = baseMap.get(rel);
          if (!wb || !bb) continue; // deleted on the working side — the deletion stays
          if ((wb.size || 0) > NEXUS_CODE_LIMITS.CONFLICT_FILE_BYTES || (bb.size || 0) > NEXUS_CODE_LIMITS.CONFLICT_FILE_BYTES) {
            return Response.json({ error: `"${f.filename}" is too large for the automatic conflict merge. Resolve it on GitHub.`, code: "CONFLICT_TOO_LARGE" }, { status: 400 });
          }
          inputs.push({ path: rel, working: wb, base: bb, full_path: f.filename });
        }
        if (!inputs.length) {
          return Response.json({ error: "No automatically resolvable conflicts were found. Resolve the remaining conflicts on GitHub.", code: "MANUAL_CONFLICT" }, { status: 409 });
        }
        const withContent = [];
        for (const n of inputs) {
          const { files: wFiles } = await readBlobsBatch(accessToken, repo, [n.working], 0);
          const { files: bFiles } = await readBlobsBatch(accessToken, repo, [n.base], 0);
          withContent.push({ path: n.path, working_content: wFiles[0].content, base_content: bFiles[0].content, full_path: n.full_path });
        }
        const llm = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: buildConflictMergePrompt({
            repoFull: repo, baseBranch: session.base_branch, workingBranch: session.working_branch,
            files: withContent.map(({ path, working_content, base_content }) => ({ path, working_content, base_content })),
          }),
          response_json_schema: {
            type: "object",
            properties: { files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
            required: ["files"],
          },
        });
        const mergedFiles = parseConflictMerge(llm, withContent.map((c) => c.path));
        const byRel = new Map(withContent.map((c) => [c.path, c.full_path]));
        for (const f of mergedFiles) entries.push({ path: byRel.get(f.path) || f.path, content: f.content });
        const result = await commitMergeTree(accessToken, repo, {
          branch: session.working_branch, baseTreeSha: workTree.tree_sha, entries,
          message: `Nexus Code: resolve conflicts merging ${session.base_branch} into ${session.working_branch}`,
          parents: [workingHead, baseHead],
        });
        commitSha = result.sha;
        resolved_files = mergedFiles.map((f) => f.path);
        reply = `Resolved ${resolved_files.length} conflicted file(s) by merging ${session.base_branch} into ${session.working_branch}. Review the changes before continuing.`;
      }
      const saved = await svc.entities.NexusCodeSession.update(session.id, {
        head_sha: commitSha || workingHead,
        chat: pushChat(session.chat, [
          { role: "system", text: `Resolved conflicts: merged ${session.base_branch} into ${session.working_branch}` },
          { role: "assistant", text: trunc(reply, 2000), ...(commitSha ? { sha: commitSha, files: resolved_files } : {}) },
        ]),
      });
      await auditSafe(svc, session.workspace_id, user.id, "nexus_code.conflicts.resolved", {
        session_id: session.id, repo, branch: session.working_branch, merge_commit: commitSha, resolved_files,
      });
      return Response.json({ session: publicSession(saved), reply, commit_sha: commitSha, resolved_files, branch: session.working_branch });
    }

    // ---- delete session state (Base44 parity: the GitHub branch is NEVER deleted —
    // deleting removes it from Nexus Code only; it remains on GitHub) ----
    if (action === "delete") {
      const session = await loadSession(svc, sessionId, user.id);
      await requireProjectWrite(svc, session.workspace_id, user);
      await svc.entities.NexusCodeSession.update(session.id, { status: "deleted", working_branch: null, head_sha: null, chat: [] });
      await auditSafe(svc, session.workspace_id, user.id, "nexus_code.deleted_state", {
        session_id: session.id, repo: session.repo_full_name, branch_preserved: session.working_branch || null,
      });
      return Response.json({ ok: true, remote_deleted: false });
    }

    return Response.json({ error: `Unsupported action ${action}` }, { status: 400 });
  } catch (error) {
    const status = error instanceof GitHubError ? (error.status && error.status < 500 ? error.status : 502) : error.status || 500;
    return Response.json({ error: error.message, code: error.code || null }, { status });
  }
}