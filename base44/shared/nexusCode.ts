// Nexus Code — pure validation, bounds and prompt helpers for the /nexus-code surface.
// No network, no entity access. Both the nexusCode function and its certification import
// from here, so the guards cannot drift between the product and its certification.

export const NEXUS_CODE_LIMITS = {
  MAX_TREE_NODES: 400,
  MAX_FILE_BYTES: 200_000,
  MAX_TOTAL_BYTES: 400_000,
  MAX_FILES_PER_COMMIT: 20,
  EDIT_CONTEXT_FILES: 40,
  EDIT_CONTEXT_FILE_BYTES: 16_000,
  EDIT_TOTAL_BYTES: 200_000,
  CHAT_LIMIT: 40,
  PROMPT_MAX: 4000,
  COMMIT_MESSAGE_MAX: 500,
  // Per-branch DEVELOPMENT preview: the working branch's browsable text files are read once,
  // bounded, and bundled CLIENT-SIDE into a sandboxed document (shared/runtimeSource.js). The
  // preview is development-only — it never creates a deployment and never serves production;
  // release remains exclusively through the existing deployment flow.
  MAX_PREVIEW_FILES: 150,
  // Base44-parity slice bounds: PR drafting, conflict resolution.
  PR_TITLE_MAX: 200,
  PR_BODY_MAX: 2000,
  CONFLICT_MAX_FILES: 10,
  CONFLICT_FILE_BYTES: 16_000,
};

const fail = (message, code) => Object.assign(new Error(message), { code, status: 400 });

// Browsable = safe to READ from a repository tree (blocks git internals and traversal).
export function isBrowseablePath(rawPath) {
  const p = String(rawPath || "");
  if (!p || p.length > 256 || p.includes("\u0000")) return false;
  if (p.startsWith("/") || p.includes("\\")) return false;
  const parts = p.split("/");
  if (parts.some((seg) => seg === "" || seg === "." || seg === ".." || seg === ".git")) return false;
  return true;
}

// Editable = safe to WRITE through Nexus Code: the browse rules plus the internal config
// namespace a generated project must never be rewritten from chat edits.
export function isEditablePath(rawPath) {
  if (!isBrowseablePath(rawPath)) return false;
  const parts = String(rawPath).split("/");
  if (parts[0] === "base44") return false;
  return true;
}

const BRANCH_FORBIDDEN = /[\s~^:?*\[\\]/;
export function validBranchName(rawName) {
  const b = String(rawName || "");
  if (!b || b.length > 200 || BRANCH_FORBIDDEN.test(b)) return false;
  if (b.startsWith("-") || b.startsWith("/") || b.startsWith(".") || b.endsWith("/") || b.endsWith(".")) return false;
  if (b.endsWith(".lock") || b.includes("..") || b.includes("//") || b.includes("@{") || b === "@") return false;
  return true;
}

export function validateCommitFiles(rawFiles, { allowEmpty = false } = {}) {
  const list = Array.isArray(rawFiles) ? rawFiles : [];
  const out = [];
  let total = 0;
  for (const f of list) {
    const path = String(f?.path || "");
    const content = typeof f?.content === "string" ? f.content : null;
    if (!isEditablePath(path) || content === null) {
      throw fail(`Rejected "${String(path).slice(0, 80)}": the path is not editable or the content is not text.`, "NEXUS_CODE_BAD_FILE");
    }
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > NEXUS_CODE_LIMITS.MAX_FILE_BYTES) {
      throw fail(`"${path}" is ${bytes} bytes, above the ${NEXUS_CODE_LIMITS.MAX_FILE_BYTES}-byte limit.`, "NEXUS_CODE_FILE_TOO_LARGE");
    }
    total += bytes;
    if (total > NEXUS_CODE_LIMITS.MAX_TOTAL_BYTES) {
      throw fail(`The change exceeds the ${NEXUS_CODE_LIMITS.MAX_TOTAL_BYTES}-byte total limit.`, "NEXUS_CODE_TOTAL_TOO_LARGE");
    }
    out.push({ path, content });
  }
  if (out.length > NEXUS_CODE_LIMITS.MAX_FILES_PER_COMMIT) {
    throw fail(`A commit may change at most ${NEXUS_CODE_LIMITS.MAX_FILES_PER_COMMIT} files.`, "NEXUS_CODE_TOO_MANY_FILES");
  }
  if (!out.length && !allowEmpty) throw fail("No files to commit.", "NEXUS_CODE_EMPTY_COMMIT");
  return out;
}

export function pushChat(chat, entries) {
  return [...(chat || []), ...entries].slice(-NEXUS_CODE_LIMITS.CHAT_LIMIT);
}

const trunc = (v, n) => String(v ?? "").slice(0, n);

export function buildEditPrompt({ repoFull, baseBranch, workingBranch, treePaths, fileContents, prompt }) {
  return [
    `You are the Nexus Code editor. You apply ONE requested change to the files of the GitHub repository ${repoFull}.`,
    `Working branch: ${workingBranch} (branched from ${baseBranch}). Only this branch is affected.`,
    ``,
    `Repository file paths:`,
    ...(treePaths || []).map((p) => `- ${p}`),
    ``,
    `Current contents of the small files (large files you were not given may exist):`,
    ...(fileContents || []).map((f) => `--- ${f.path} ---\n${f.content}`),
    ``,
    `The user asks: ${trunc(prompt, NEXUS_CODE_LIMITS.PROMPT_MAX)}`,
    ``,
    `Return JSON: {"reply": "<one short user-facing sentence>", "files": [{"path": "...", "content": "<FULL new file content>"}]}.`,
    `Rules: include ONLY files you created or changed; each included file must be COMPLETE (never a patch); keep unrelated files untouched; never touch .git or base44/ paths; return plain text file content.`,
  ].join("\n");
}

// Accepts the edit model's structured response (object or JSON string) and returns a
// bounded { reply, files }. An EMPTY file list is VALID — a question is not a change.
export function parseEditResult(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { throw fail("The edit model did not return valid JSON.", "NEXUS_CODE_BAD_LLM"); }
  }
  if (!parsed || typeof parsed !== "object") throw fail("The edit model returned an unusable result.", "NEXUS_CODE_BAD_LLM");
  const reply = trunc(parsed.reply, 2000);
  const files = validateCommitFiles(parsed.files, { allowEmpty: true });
  return { reply, files };
}

// --- Base44 parity: PR drafting ("The AI chat writes the title and description from your
// conversation and committed changes") ----------------------------------------

export function buildPrDraftPrompt({ repoFull, workingBranch, baseBranch, chat }) {
  return [
    `You draft the title and description of a GitHub pull request for the repository ${repoFull}.`,
    `Working branch: ${workingBranch} (the pull request targets ${baseBranch}).`,
    ``,
    `The branch's Nexus Code conversation (oldest first; user requests, assistant replies, system notes):`,
    ...(chat || []).map((m) => `- ${m.role}: ${String(m.text || "").slice(0, 400)}`),
    ``,
    `Return JSON: {"title": "<concise PR title, imperative mood>", "body": "<2-5 sentence plain-text description of the change>"}.`,
    `Write both from the conversation only. No markdown headings, no invented commits or files.`,
  ].join("\n");
}

// Returns { title, body } within the PR limits, with a deterministic fallback when the model
// is unusable, so opening a PR never hard-fails on drafting alone.
export function parsePrDraft(raw, fallbackTitle) {
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  const title = trunc(parsed?.title, NEXUS_CODE_LIMITS.PR_TITLE_MAX).trim()
    || trunc(fallbackTitle, NEXUS_CODE_LIMITS.PR_TITLE_MAX)
    || "Nexus Code changes";
  const body = trunc(parsed?.body, NEXUS_CODE_LIMITS.PR_BODY_MAX);
  return { title, body };
}

// --- Base44 parity: conflict resolution ("Resolving conflicts merges the pull request's
// base branch into your working branch", then you review and test the result) -----

export function buildConflictMergePrompt({ repoFull, baseBranch, workingBranch, files }) {
  return [
    `You resolve the content conflicts of merging the base branch ${baseBranch} into the working branch ${workingBranch} of the GitHub repository ${repoFull}.`,
    `For each file below, BOTH sides changed it since the branches diverged. Produce the merged file that keeps the intent of BOTH changes.`,
    ``,
    ...(files || []).map((f) => `--- ${f.path} (working branch) ---\n${f.working_content}\n--- ${f.path} (base branch) ---\n${f.base_content}`),
    ``,
    `Return JSON: {"files": [{"path": "...", "content": "<FULL merged file content>"}]} — exactly one entry per input file, paths exactly as given, full content (never a patch).`,
  ].join("\n");
}

// Validates the merge model's output against the EXACT set of conflicted paths: no missing
// file (a partial merge would corrupt the tree) and no unexpected path.
export function parseConflictMerge(raw, expectedPaths) {
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { throw fail("The merge model did not return valid JSON.", "NEXUS_CODE_BAD_LLM"); }
  }
  const files = validateCommitFiles(parsed?.files, { allowEmpty: false });
  const expected = new Set(expectedPaths || []);
  if (files.length > NEXUS_CODE_LIMITS.CONFLICT_MAX_FILES) {
    throw fail(`The merge returned ${files.length} files, above the ${NEXUS_CODE_LIMITS.CONFLICT_MAX_FILES}-file conflict limit.`, "NEXUS_CODE_BAD_LLM");
  }
  for (const f of files) {
    if (!expected.has(f.path)) throw fail(`The merge model returned an unexpected path "${f.path}".`, "NEXUS_CODE_BAD_LLM");
    if (new TextEncoder().encode(f.content).length > NEXUS_CODE_LIMITS.CONFLICT_FILE_BYTES) {
      throw fail(`"${f.path}" merged content is above the conflict-merge size limit.`, "NEXUS_CODE_CONFLICT_TOO_LARGE");
    }
  }
  if (files.length !== expected.size) throw fail("The merge model did not return every conflicted file.", "NEXUS_CODE_BAD_LLM");
  return files;
}