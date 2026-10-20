// GitHub REST layer.
//
// The ONLY place that talks to api.github.com. Every failure mode the caller must react to
// differently is classified into a stable code here, so the worker never has to interpret
// raw GitHub responses. A token is passed in per call and is never logged, returned,
// embedded in an error message, or written to any record.
const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || null;
  }
}

// Tokens can appear in nothing that leaves this module: GitHub echoes no credential, but a
// URL or message could carry one, so every outgoing message is scrubbed of token-shaped text.
const scrub = (text) => String(text || "").replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);

async function ghFetch(token, path, { method = "GET", body, accept = "application/vnd.github+json" } = {}) {
  let res;
  try {
    res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "NexusAI-SourceControl",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new GitHubError("GITHUB_NETWORK_ERROR", `Could not reach GitHub: ${scrub(e.message)}`);
  }

  if (res.ok) return res.status === 204 ? null : res.json();

  let detail = "";
  try { detail = scrub((await res.json())?.message || ""); } catch { detail = ""; }

  if (res.status === 401) throw new GitHubError("GITHUB_AUTH_INVALID", "GitHub rejected the authorization. Reconnect the GitHub account.", 401);
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0" || /rate limit|secondary/i.test(detail)) {
      throw new GitHubError("GITHUB_RATE_LIMITED", "GitHub rate limit reached. Try again shortly.", res.status);
    }
    throw new GitHubError("GITHUB_PERMISSION_DENIED", `GitHub denied permission: ${detail || "insufficient repository access"}`, res.status);
  }
  if (res.status === 404) throw new GitHubError("NOT_FOUND", detail || "Not found on GitHub", 404);
  if (res.status === 409) throw new GitHubError("MALFORMED_REPOSITORY", detail || "Repository is empty or in a conflicting state", 409);
  if (res.status === 422) throw new GitHubError("GITHUB_API_ERROR", `GitHub rejected the request: ${detail}`, 422);
  throw new GitHubError("GITHUB_API_ERROR", `GitHub API error ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
}

// --- base64 (UTF-8 safe, both directions) ------------------------------------
export function toBase64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(String(b64 || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// --- account + repository ----------------------------------------------------
export async function getViewer(token) {
  const me = await ghFetch(token, "/user");
  return { login: me.login, id: me.id };
}

export async function listRepos(token) {
  const rows = await ghFetch(token, "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");
  return (rows || []).map((r) => ({ full_name: r.full_name, private: !!r.private, default_branch: r.default_branch, permissions: { push: !!r.permissions?.push } }));
}

export async function getRepo(token, fullName) {
  try {
    const r = await ghFetch(token, `/repos/${fullName}`);
    return { full_name: r.full_name, default_branch: r.default_branch, private: !!r.private, can_push: !!r.permissions?.push };
  } catch (e) {
    if (e.code === "NOT_FOUND") throw new GitHubError("REPO_NOT_FOUND", `Repository "${fullName}" was not found, or the connected account cannot see it.`, 404);
    throw e;
  }
}

export async function listBranches(token, fullName) {
  const rows = await ghFetch(token, `/repos/${fullName}/branches?per_page=100`);
  return (rows || []).map((b) => ({ name: b.name, sha: b.commit?.sha }));
}

export async function getBranchHead(token, fullName, branch) {
  try {
    const ref = await ghFetch(token, `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`);
    return ref.object.sha;
  } catch (e) {
    if (e.code === "NOT_FOUND") throw new GitHubError("BRANCH_NOT_FOUND", `Branch "${branch}" does not exist in ${fullName}.`, 404);
    throw e;
  }
}

export async function getCommit(token, fullName, sha) {
  try {
    const c = await ghFetch(token, `/repos/${fullName}/commits/${sha}`);
    return { sha: c.sha, message: c.commit?.message || "", tree_sha: c.commit?.tree?.sha, author: c.commit?.author?.name || "", date: c.commit?.author?.date || null };
  } catch (e) {
    if (e.code === "NOT_FOUND") throw new GitHubError("NOT_FOUND", `Commit ${String(sha).slice(0, 12)} was not found in ${fullName}.`, 404);
    throw e;
  }
}

// --- reading source ----------------------------------------------------------
const MAX_FILES = 400;
const MAX_FILE_BYTES = 400_000;

// Reads the text files of a commit, optionally restricted to a subdirectory. Anything the
// platform cannot treat as project source (binary, oversized, too many files) is rejected
// as a malformed repository rather than silently dropped.
export async function readCommitFiles(token, fullName, commitSha, subdirectory) {
  const commit = await getCommit(token, fullName, commitSha);
  const tree = await ghFetch(token, `/repos/${fullName}/git/trees/${commit.tree_sha}?recursive=1`);
  if (tree.truncated) throw new GitHubError("MALFORMED_REPOSITORY", "The repository tree is too large to import.");
  const prefix = subdirectory ? `${String(subdirectory).replace(/^\/+|\/+$/g, "")}/` : "";
  const blobs = (tree.tree || []).filter((n) => n.type === "blob" && (!prefix || n.path.startsWith(prefix)));
  if (!blobs.length) throw new GitHubError("MALFORMED_REPOSITORY", `No files found${prefix ? ` under "${prefix}"` : ""} in commit ${commitSha.slice(0, 7)}.`);
  if (blobs.length > MAX_FILES) throw new GitHubError("MALFORMED_REPOSITORY", `Commit contains ${blobs.length} files, above the ${MAX_FILES}-file import limit.`);

  const files = [];
  for (const node of blobs) {
    if ((node.size || 0) > MAX_FILE_BYTES) throw new GitHubError("MALFORMED_REPOSITORY", `${node.path} is ${node.size} bytes, above the per-file import limit.`);
    const blob = await ghFetch(token, `/repos/${fullName}/git/blobs/${node.sha}`);
    const content = fromBase64(blob.content || "");
    if (content.includes("\u0000")) throw new GitHubError("MALFORMED_REPOSITORY", `${node.path} is not a text source file.`);
    files.push({ path: node.path.slice(prefix.length), content });
  }
  return { commit, files };
}

// --- writing a commit --------------------------------------------------------
// One real commit through the git data API: blobs → tree (on top of the branch's existing
// tree, so files outside the project subdirectory are preserved) → commit → ref update.
// The ref update is a non-forced fast-forward, so a branch that moved underneath us fails
// loudly instead of overwriting someone else's work.
export async function createCommit(token, fullName, { branch, files, message, baseSha }) {
  const parent = baseSha || (await getBranchHead(token, fullName, branch));
  const parentCommit = await ghFetch(token, `/repos/${fullName}/git/commits/${parent}`);

  const tree = [];
  for (const f of files) {
    const blob = await ghFetch(token, `/repos/${fullName}/git/blobs`, { method: "POST", body: { content: toBase64(f.content), encoding: "base64" } });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await ghFetch(token, `/repos/${fullName}/git/trees`, { method: "POST", body: { base_tree: parentCommit.tree.sha, tree } });
  const commit = await ghFetch(token, `/repos/${fullName}/git/commits`, { method: "POST", body: { message, tree: newTree.sha, parents: [parent] } });
  await ghFetch(token, `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
  return { sha: commit.sha, parent_sha: parent, tree_sha: newTree.sha };
}

// --- repository webhook management ------------------------------------------
// Create / list / delete webhooks through the GitHub REST API, using the same per-call token
// path as every other operation in this module. The webhook secret is passed to GitHub at
// creation time and never stored by GitHub — it is used to sign deliveries and is never
// returned by any subsequent read.
export async function createWebhook(token, fullName, { url, secret, events = ["push"], active = true }) {
  const hook = await ghFetch(token, `/repos/${fullName}/hooks`, {
    method: "POST",
    body: {
      name: "web",
      active,
      events,
      config: { url, content_type: "json", secret },
    },
  });
  return { id: hook.id, url: hook.config?.url, events: hook.events, active: hook.active };
}

export async function listWebhooks(token, fullName) {
  const hooks = await ghFetch(token, `/repos/${fullName}/hooks?per_page=100`);
  return (hooks || []).map((h) => ({ id: h.id, url: h.config?.url, events: h.events, active: h.active }));
}

export async function deleteWebhook(token, fullName, hookId) {
  await ghFetch(token, `/repos/${fullName}/hooks/${hookId}`, { method: "DELETE" });
  return true;
}

// --- divergence detection & merge (Stage 3) ---------------------------------
// Detects whether the branch has moved past the last export base. Returns the head sha
// and whether divergence was found, so the worker can apply the configured conflict
// strategy instead of silently overwriting someone else's commits.
export async function detectDivergence(token, fullName, branch, expectedBaseSha) {
  const headSha = await getBranchHead(token, fullName, branch);
  if (!expectedBaseSha || expectedBaseSha === headSha) {
    return { diverged: false, head_sha: headSha, base_sha: expectedBaseSha || null };
  }
  return { diverged: true, head_sha: headSha, base_sha: expectedBaseSha };
}

// Reads the files of a commit into a Map<path, content>, for 3-way merge comparison.
export async function readCommitFileMap(token, fullName, commitSha, subdirectory) {
  const { files } = await readCommitFiles(token, fullName, commitSha, subdirectory);
  return new Map(files.map((f) => [f.path, f.content]));
}

// Creates a merge commit with two parents (or a regular commit with one parent) and
// optionally force-updates the ref. `baseTreeSha` preserves files outside the project
// subdirectory. `force` is only true for the explicit force strategy.
export async function createMergeCommit(token, fullName, { branch, files, message, parents, baseTreeSha, force }) {
  const tree = [];
  for (const f of files) {
    const blob = await ghFetch(token, `/repos/${fullName}/git/blobs`, { method: "POST", body: { content: toBase64(f.content), encoding: "base64" } });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await ghFetch(token, `/repos/${fullName}/git/trees`, { method: "POST", body: { base_tree: baseTreeSha, tree } });
  const commit = await ghFetch(token, `/repos/${fullName}/git/commits`, { method: "POST", body: { message, tree: newTree.sha, parents } });
  await ghFetch(token, `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: { sha: commit.sha, force: !!force } });
  return { sha: commit.sha, parent_sha: parents[0], tree_sha: newTree.sha };
}

// --- token validation (Stage 5) ---------------------------------------------
// Verifies the token is still accepted by GitHub before long-running work. Returns
// { valid, login, id } — never throws on auth failure, so the caller can classify
// deterministically without catching.
export async function validateToken(token) {
  try {
    const me = await ghFetch(token, "/user");
    return { valid: true, login: me.login, id: me.id };
  } catch (e) {
    if (e.code === "GITHUB_AUTH_INVALID") return { valid: false, login: null, id: null };
    throw e;
  }
}

// --- incremental / batched reads (Stage 4) ----------------------------------
// Reads the tree of a commit (without blob contents) and returns the filtered blob
// node list. The caller reads blobs in batches and persists a checkpoint, so a
// large-repository import can resume after a worker interruption.
export async function readCommitTree(token, fullName, commitSha, subdirectory) {
  const commit = await getCommit(token, fullName, commitSha);
  const tree = await ghFetch(token, `/repos/${fullName}/git/trees/${commit.tree_sha}?recursive=1`);
  if (tree.truncated) throw new GitHubError("MALFORMED_REPOSITORY", "The repository tree is too large to import.");
  const prefix = subdirectory ? `${String(subdirectory).replace(/^\/+|\/+$/g, "")}/` : "";
  const blobs = (tree.tree || []).filter((n) => n.type === "blob" && (!prefix || n.path.startsWith(prefix)));
  return {
    commit,
    tree_sha: commit.tree_sha,
    blobs: blobs.map((n) => ({ path: n.path.slice(prefix.length), sha: n.sha, size: n.size || 0 })),
  };
}

const BLOB_BATCH_SIZE = 20;

// Reads one batch of blobs (up to BLOB_BATCH_SIZE) starting at startIndex. Returns
// the file contents and the next index. Enforces per-file size and binary limits
// on every blob, so a rejection happens at the first offending file, not after
// the whole batch.
export async function readBlobsBatch(token, fullName, blobNodes, startIndex) {
  const batch = blobNodes.slice(startIndex, startIndex + BLOB_BATCH_SIZE);
  const files = await Promise.all(batch.map(async (node) => {
    if ((node.size || 0) > MAX_FILE_BYTES) throw new GitHubError("MALFORMED_REPOSITORY", `${node.path} is ${node.size} bytes, above the per-file import limit.`);
    const blob = await ghFetch(token, `/repos/${fullName}/git/blobs/${node.sha}`);
    const content = fromBase64(blob.content || "");
    if (content.includes("\u0000")) throw new GitHubError("MALFORMED_REPOSITORY", `${node.path} is not a text source file.`);
    return { path: node.path, content };
  }));
  return { files, nextIndex: startIndex + batch.length, done: startIndex + batch.length >= blobNodes.length };
}

export const BLOB_BATCH = BLOB_BATCH_SIZE;

// Compares what is about to be pushed against what the branch already has, so an export
// records a real file-level change summary instead of claiming everything changed.
export async function diffAgainstBranch(token, fullName, branch, files, subdirectory) {
  let existing = new Map();
  try {
    const head = await getBranchHead(token, fullName, branch);
    const { files: current } = await readCommitFiles(token, fullName, head, subdirectory);
    existing = new Map(current.map((f) => [f.path, f.content]));
  } catch (e) {
    if (!["BRANCH_NOT_FOUND", "MALFORMED_REPOSITORY"].includes(e.code)) throw e;
  }
  const changes = [];
  const incoming = new Set(files.map((f) => f.path));
  for (const f of files) {
    if (!existing.has(f.path)) changes.push({ path: f.path, change: "added" });
    else if (existing.get(f.path) !== f.content) changes.push({ path: f.path, change: "modified" });
  }
  for (const path of existing.keys()) if (!incoming.has(path)) changes.push({ path, change: "removed_upstream" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// --- Nexus Code: refs & pull requests (first slice) ---------------------------
// Thin ref/PR primitives for the /nexus-code surface, following the same rules as every
// other call in this module: per-call token, scrubbed failures, no state invented locally.
// createRef creates a NEW branch ref pointing at an existing commit; it never updates an
// existing ref (GitHub itself refuses a duplicate ref, which is the collision check).
export async function createRef(token, fullName, branchName, sha) {
  const name = String(branchName || "").replace(/^refs\/heads\//, "");
  const created = await ghFetch(token, `/repos/${fullName}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${name}`, sha },
  });
  return { ref: created?.ref || `refs/heads/${name}`, sha: created?.object?.sha || sha };
}

// Removes a branch ref. Only ever called for a branch Nexus Code itself created.
export async function deleteRef(token, fullName, branchName) {
  await ghFetch(token, `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branchName)}`, { method: "DELETE" });
  return true;
}

// Opens a pull request between two branches of the SAME repository. `head` must be an
// existing branch, `base` the target branch. Returns only public PR identity fields.
export async function createPullRequest(token, fullName, { title, body, head, base }) {
  const pr = await ghFetch(token, `/repos/${fullName}/pulls`, {
    method: "POST",
    body: { title, body: body || "", head, base },
  });
  return { number: pr.number, url: pr.html_url, state: pr.state, title: pr.title };
}

// --- Nexus Code parity slice: PR state, review comments, branch merges ---------------------
// Same rules as every call in this module: per-call token, classified failures, no invented
// state. PRs are looked up, never guessed; a merge conflict is an OUTCOME, not a throw.

export async function getPullRequest(token, fullName, number) {
  const pr = await ghFetch(token, `/repos/${fullName}/pulls/${number}`);
  return {
    number: pr.number, state: pr.state, title: pr.title, url: pr.html_url,
    head_ref: pr.head?.ref || null, base_ref: pr.base?.ref || null,
  };
}

// The single open PR between a head branch and a base branch, when one exists — the
// duplicate-PR guard for continuation.
export async function findOpenPullRequest(token, fullName, { head, base }) {
  const owner = String(fullName).split("/")[0];
  const headQualified = `${owner}:${head}`;
  const rows = await ghFetch(token, `/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(headQualified)}&base=${encodeURIComponent(base)}&per_page=10`);
  const pr = (rows || [])[0];
  if (!pr) return null;
  return { number: pr.number, state: pr.state, title: pr.title, url: pr.html_url, head_ref: pr.head?.ref || null, base_ref: pr.base?.ref || null };
}

// Review-comment threads + substantive review bodies of a pull request. REST cannot carry
// GitHub's "resolved" flag, so this lists every thread; callers present them read-only.
export async function listPullRequestComments(token, fullName, number) {
  const [comments, reviews] = await Promise.all([
    ghFetch(token, `/repos/${fullName}/pulls/${number}/comments?per_page=100`),
    ghFetch(token, `/repos/${fullName}/pulls/${number}/reviews?per_page=100`),
  ]);
  return {
    comments: (comments || []).slice(0, 50).map((c) => ({
      id: c.id, user: c.user?.login || null, path: c.path, line: c.line ?? c.original_line ?? null,
      body: String(c.body || "").slice(0, 500), in_reply_to_id: c.in_reply_to_id ?? null, created_at: c.created_at || null,
    })),
    reviews: (reviews || []).filter((r) => r.body).slice(0, 20).map((r) => ({
      id: r.id, user: r.user?.login || null, state: r.state, body: String(r.body || "").slice(0, 500), submitted_at: r.submitted_at || null,
    })),
  };
}

// Files changed between two commits, bounded. Statuses: added | modified | removed | ...
export async function compareCommits(token, fullName, fromSha, toSha) {
  const json = await ghFetch(token, `/repos/${fullName}/compare/${fromSha}...${toSha}`);
  return (json.files || []).slice(0, 100).map((f) => ({ filename: f.filename, status: f.status }));
}

// Merges `from` (e.g. the base branch) INTO `into` (the working branch) through GitHub's
// merge endpoint. Outcomes: { merged, sha } | { merged: false, up_to_date: true } |
// { merged: false, conflict: true } — a content conflict (409) is returned, never thrown.
export async function mergeBranches(token, fullName, { into, from }) {
  try {
    const json = await ghFetch(token, `/repos/${fullName}/merges`, { method: "POST", body: { base: into, head: from } });
    if (!json) return { merged: false, up_to_date: true }; // 204 — already up to date
    return { merged: true, sha: json.sha || null };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 409) return { merged: false, conflict: true };
    throw e;
  }
}

// Creates a REAL merge commit with two parents from the working branch's tree plus explicit
// entries: { path, sha } (take an existing blob), { path, content } (upload a new blob) or
// { path, delete: true }. base_tree is the working branch's tree, so files outside the change
// set — and outside the project subdirectory — survive untouched.
export async function commitMergeTree(token, fullName, { branch, baseTreeSha, entries, message, parents }) {
  const tree = [];
  for (const e of entries) {
    if (e.delete) { tree.push({ path: e.path, mode: "100644", type: "blob", sha: null }); continue; }
    if (e.sha) { tree.push({ path: e.path, mode: "100644", type: "blob", sha: e.sha }); continue; }
    const blob = await ghFetch(token, `/repos/${fullName}/git/blobs`, { method: "POST", body: { content: toBase64(e.content), encoding: "base64" } });
    tree.push({ path: e.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await ghFetch(token, `/repos/${fullName}/git/trees`, { method: "POST", body: { base_tree: baseTreeSha, tree } });
  const commit = await ghFetch(token, `/repos/${fullName}/git/commits`, { method: "POST", body: { message, tree: newTree.sha, parents } });
  await ghFetch(token, `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
  return { sha: commit.sha, tree_sha: newTree.sha };
}