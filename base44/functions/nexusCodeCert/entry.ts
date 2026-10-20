// Certification harness for the Nexus Code first slice.
//   • "static" ...... pure-function assertions against shared/nexusCode.ts (no network).
//   • "create_repo" . creates a DISPOSABLE private repository under the connected account.
//   • "seed" ........ puts two small text files on its default branch.
//   • "cleanup" ..... deletes the disposable repository (best-effort).
// The full connect/branch/read/edit/commit/push/diff/PR/delete flow is driven through the
// nexusCode surface itself by the test runner. Nothing here touches production repositories
// or existing GitSync state.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { resolveGitHubToken } from "../../shared/githubAuth.ts";
import { can, ROLES } from "../../shared/rbac.ts";
import {
  validBranchName, isBrowseablePath, isEditablePath,
  validateCommitFiles, parseEditResult, buildEditPrompt, NEXUS_CODE_LIMITS,
  buildPrDraftPrompt, parsePrDraft, buildConflictMergePrompt, parseConflictMerge,
} from "../../shared/nexusCode.ts";

const api = async (token, path, method = "GET", body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "NexusAI-SourceControl",
      "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  let raw = null;
  try {
    raw = await res.text();
    try { json = JSON.parse(raw); } catch { raw = raw.slice(0, 200); }
  } catch { /* empty body */ }
  return { status: res.status, json, raw };
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "static");

  if (action === "static") {
    const results = [];
    const assert = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || "" });
    let threw = null;

    assert("branch names accepted", validBranchName("feature/nexus-code") && validBranchName("nexus/cert-1") && validBranchName("main"));
    assert("branch names rejected", !validBranchName("") && !validBranchName("a b") && !validBranchName("a..b") && !validBranchName("-x") && !validBranchName("x.lock") && !validBranchName("x/") && !validBranchName("@{x") && !validBranchName("x^"));

    assert("editable paths accepted", isEditablePath("src/App.jsx") && isEditablePath("index.html") && isEditablePath("styles/main.css"));
    assert("browse allows non-project files", isBrowseablePath("README.md") && isBrowseablePath("docs/notes.txt"));
    assert("traversal rejected", !isEditablePath("../x") && !isEditablePath("a/../b") && !isEditablePath("/abs") && !isEditablePath("a//b") && !isEditablePath("") && !isEditablePath("./a"));
    assert("git internals rejected", !isBrowseablePath(".git/config") && !isBrowseablePath("x/.git/config"));
    assert("internal namespace rejected", !isEditablePath("base44/entities/T.jsonc") && isBrowseablePath("base44/entities/T.jsonc"));

    threw = null;
    try { validateCommitFiles([{ path: "a.txt", content: "hi" }, { path: "src/b.css", content: "body{}" }]); } catch (e) { threw = e; }
    assert("commit files accept small set", !threw, threw?.message || "");
    threw = null;
    try { validateCommitFiles([]); } catch (e) { threw = e; }
    assert("empty commit rejected", !!threw && threw.code === "NEXUS_CODE_EMPTY_COMMIT");
    threw = null;
    try { validateCommitFiles([{ path: "big.bin", content: "x".repeat(NEXUS_CODE_LIMITS.MAX_FILE_BYTES + 1) }]); } catch (e) { threw = e; }
    assert("oversized file rejected", !!threw);
    threw = null;
    try { validateCommitFiles([{ path: "ok.txt", content: "x" }, { path: "../escape.txt", content: "x" }]); } catch (e) { threw = e; }
    assert("commit rejects traversal path", !!threw && threw.code === "NEXUS_CODE_BAD_FILE");

    const ok = parseEditResult(JSON.stringify({ reply: "did it", files: [{ path: "a.txt", content: "new" }] }));
    assert("parseEditResult parses JSON string", ok.reply === "did it" && ok.files.length === 1 && ok.files[0].path === "a.txt");
    const empty = parseEditResult({ reply: "nothing to change", files: [] });
    assert("parseEditResult allows empty change", empty.files.length === 0 && empty.reply === "nothing to change");
    threw = null;
    try { parseEditResult({ reply: "x", files: [{ path: "../escape.txt", content: "x" }] }); } catch (e) { threw = e; }
    assert("parseEditResult rejects traversal", !!threw);
    threw = null;
    try { parseEditResult("not json at all"); } catch (e) { threw = e; }
    assert("parseEditResult rejects bad json", !!threw && threw.code === "NEXUS_CODE_BAD_LLM");

    const prompt = buildEditPrompt({
      repoFull: "o/r", baseBranch: "main", workingBranch: "nexus/x",
      treePaths: ["index.html"], fileContents: [{ path: "index.html", content: "<p>hi</p>" }], prompt: "make it blue",
    });
    assert("edit prompt carries context", prompt.includes("o/r") && prompt.includes("nexus/x") && prompt.includes("make it blue") && prompt.includes("<p>hi</p>"));

    return Response.json({ results, passed: results.every((r) => r.pass) });
  }

  // Parity slice: workspace role authorization, PR drafting, conflict-resolution guards.
  if (action === "parity") {
    const results = [];
    const assert = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || "" });

    // Role authorization: the EXISTING rbac capability matrix — owners/admins/editors may
    // mutate; viewers fail closed. No roles are invented.
    assert("role matrix: editor may mutate", can("editor", "project.write") === true);
    assert("role matrix: owner/admin may mutate", can("owner", "project.write") === true && can("admin", "project.write") === true);
    assert("role matrix: viewer fails closed", can("viewer", "project.write") === false);
    assert("no invented roles", JSON.stringify(ROLES) === JSON.stringify(["owner", "admin", "editor", "viewer"]));

    // PR continuation: drafting from the chat conversation.
    const prPrompt = buildPrDraftPrompt({ repoFull: "o/r", workingBranch: "nexus/x", baseBranch: "main", chat: [{ role: "user", text: "add a footer" }] });
    assert("PR draft prompt carries the conversation", prPrompt.includes("o/r") && prPrompt.includes("nexus/x") && prPrompt.includes("add a footer"));
    const prDraft = parsePrDraft(JSON.stringify({ title: "x".repeat(500), body: "b" }), "fallback");
    assert("PR draft parse truncates to the title limit", prDraft.title.length === NEXUS_CODE_LIMITS.PR_TITLE_MAX && prDraft.body === "b");
    const prFallback = parsePrDraft("not json", "fallback title");
    assert("PR draft parse falls back deterministically", prFallback.title === "fallback title" && prFallback.body === "");

    // Conflict resolution: guards on the merge model's output.
    const cmPrompt = buildConflictMergePrompt({ repoFull: "o/r", baseBranch: "main", workingBranch: "nexus/x", files: [{ path: "a.txt", working_content: "WORKING", base_content: "BASE" }] });
    assert("conflict prompt carries both sides", cmPrompt.includes("a.txt") && cmPrompt.includes("WORKING") && cmPrompt.includes("BASE"));
    const merged = parseConflictMerge(JSON.stringify({ files: [{ path: "a.txt", content: "both" }] }), ["a.txt"]);
    assert("conflict merge parse accepts the full set", merged.length === 1 && merged[0].content === "both");
    let cmThrew = null;
    try { parseConflictMerge(JSON.stringify({ files: [{ path: "a.txt", content: "x" }] }), ["a.txt", "b.txt"]); } catch (e) { cmThrew = e; }
    assert("conflict merge parse requires every conflicted file", !!cmThrew);
    cmThrew = null;
    try { parseConflictMerge(JSON.stringify({ files: [{ path: "a.txt", content: "x" }, { path: "zzz.txt", content: "y" }] }), ["a.txt"]); } catch (e) { cmThrew = e; }
    assert("conflict merge parse rejects unexpected paths", !!cmThrew);
    cmThrew = null;
    try { parseConflictMerge(JSON.stringify({ files: [{ path: "a.txt", content: "y".repeat(NEXUS_CODE_LIMITS.CONFLICT_FILE_BYTES + 1) }] }), ["a.txt"]); } catch (e) { cmThrew = e; }
    assert("conflict merge parse enforces the size bound", !!cmThrew);
    assert("conflict bounds exist", NEXUS_CODE_LIMITS.CONFLICT_MAX_FILES > 0 && NEXUS_CODE_LIMITS.CONFLICT_FILE_BYTES > 0);

    return Response.json({ results, passed: results.every((r) => r.pass) });
  }

  if (action === "create_repo") {
    const { accessToken } = await resolveGitHubToken(base44);
    const name = `nexus-code-cert-${Date.now().toString(36)}`;
    const { status, json } = await api(accessToken, "/user/repos", "POST", {
      name, private: true, auto_init: true, default_branch: "main",
      description: "Disposable Nexus Code certification repository — safe to delete.",
    });
    return Response.json({ status, repo_full_name: json?.full_name || null, default_branch: json?.default_branch || null, error: json?.message || null });
  }

  if (action === "seed") {
    const { accessToken } = await resolveGitHubToken(base44);
    const repo = String(body.repo_full_name || "");
    const files = [
      { path: "index.html", content: "<!doctype html>\n<html>\n  <head>\n    <title>Cert</title>\n  </head>\n  <body>\n    <h1>Cert page</h1>\n    <p>seed</p>\n  </body>\n</html>\n" },
      { path: "styles.css", content: "body { font-family: sans-serif; }\n" },
      // Renderable by the per-branch development preview (bundlePreview entry point).
      { path: "src/main.js", content: "import { html, render } from \"runtime\";\nrender(document.getElementById(\"app\") || document.body, html`<div id=\"cert-preview\">Nexus Code preview cert</div>`);\n" },
    ];
    const seeded = [];
    for (const f of files) {
      // The contents API needs the existing blob sha to overwrite a file.
      const existing = await api(accessToken, `/repos/${repo}/contents/${f.path}`);
      const sha = existing.json?.sha || null;
      const { status, json, raw } = await api(accessToken, `/repos/${repo}/contents/${f.path}`, "PUT", {
        message: "Nexus Code certification seed", content: btoa(f.content), ...(sha ? { sha } : {}),
      });
      seeded.push({ path: f.path, status, sha: json?.content?.sha || null, error: status >= 400 ? (json?.message || raw || null) : null });
    }
    return Response.json({ seeded });
  }

  if (action === "move_branch") {
    // Cert-only: commits DIRECTLY to a branch through the contents API — a change made
    // outside Nexus Code, to prove the preview/edit guard fails closed (BRANCH_MOVED).
    const { accessToken } = await resolveGitHubToken(base44);
    const repo = String(body.repo_full_name || "");
    const path = String(body.path || "out_of_band.txt");
    const content = String(body.content || `out of band ${Date.now()}\n`);
    const existing = await api(accessToken, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(String(body.branch || "main"))}`);
    const sha = existing.json?.sha || null;
    const { status, json, raw } = await api(accessToken, `/repos/${repo}/contents/${path}`, "PUT", {
      message: "Out-of-band certification commit", content: btoa(content),
      branch: String(body.branch || "main"), ...(sha ? { sha } : {}),
    });
    return Response.json({ status, sha: json?.commit?.sha || null, error: status >= 400 ? (json?.message || raw || null) : null });
  }

  if (action === "branch_exists") {
    // Cert-only: proves a deleted Nexus Code session left the GitHub branch in place.
    const { accessToken } = await resolveGitHubToken(base44);
    const repo = String(body.repo_full_name || "");
    const branch = String(body.branch || "main");
    const { status, json } = await api(accessToken, `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
    return Response.json({ status, exists: status === 200, branch: json?.name || null, error: status >= 400 ? (json?.message || null) : null });
  }

  if (action === "cleanup") {
    const { accessToken } = await resolveGitHubToken(base44);
    const repo = String(body.repo_full_name || "");
    const { status, json } = await api(accessToken, `/repos/${repo}`, "DELETE");
    return Response.json({ status, deleted: status === 204, detail: json?.message || null });
  }

  return Response.json({ error: `Unsupported action ${action}` }, { status: 400 });
}