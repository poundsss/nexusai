// Virtual project filesystem: in-memory, transactional view over ProjectFile records.
// Nothing here touches the database; the caller persists `computeChanges()` at commit time.

// Canonical Base44 resource paths are recognised through the shared layout + function-path
// contracts, so the filesystem, the build and the runtimes never disagree about what a path is.
import { CONFIG_FILE, APP_CONFIG_FILE, isAppConfigPath, isAssetPath, ASSETS_DIR, isEntityFilePath, isTypesPath, isUnsupportedResourcePath, isBase44Path, isAgentFilePath, isAgentSkillFilePath, isConnectorFilePath, isActorFilePath, AGENTS_DIR, AGENT_SKILLS_DIR, CONNECTORS_DIR, ACTORS_DIR, ACTOR_ENTRY_FILE, isContextFilePath } from "./base44Layout.ts";
import { isCanonicalFunctionPath, CANONICAL_FUNCTIONS_DIR, FUNCTION_ENTRY } from "./functionPaths.ts";
// Workflow resource files are recognised through the workflow resource contract, so the
// filesystem, the build and the workflow layer never disagree about what a workflow path is.
import { isWorkflowFilePath, WORKFLOWS_DIR } from "./workflowResource.ts";

export function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

export function createFs(records) {
  const files = new Map();
  for (const r of records) {
    files.set(normalizePath(r.path), {
      id: r.id,
      content: r.content || "",
      original: r.content || "",
      frozen: !!r.frozen,
      deleted: false,
    });
  }
  return { files };
}

function live(fs, path) {
  const f = fs.files.get(normalizePath(path));
  return f && !f.deleted ? f : null;
}

export function readFile(fs, path) {
  const f = live(fs, path);
  if (!f) throw new Error(`File not found: ${path}`);
  return f.content;
}

export function writeFile(fs, path, content) {
  const p = normalizePath(path);
  if (!p) throw new Error("write_file: path is required");
  // package.json / package.lock.json are the project's dependency state. They are ordinary project
  // files on purpose: a package change is then a normal versioned mutation, and rollback restores it.
  // base44/ is the project's reserved resource directory. Only the shapes this foundation supports
  // are writable; the remaining reserved directories are refused with a stated reason rather than
  // being accepted and then ignored by everything downstream.
  if (isBase44Path(p)) {
    if (isUnsupportedResourcePath(p)) {
      throw new Error(`write_file: ${p} is a reserved Base44 resource directory that this project cannot define yet (auth is not supported).`);
    }
    // An asset path that is INSIDE base44/assets/ but does not satisfy the narrow asset grammar is
    // refused with that stated reason, rather than falling through to the generic message.
    if (p.startsWith(ASSETS_DIR) && !isAssetPath(p)) {
      throw new Error(`write_file: ${p} is not a valid asset path — assets are plain files under ${ASSETS_DIR}, at most five levels deep, each segment alphanumeric (dots, dashes and underscores allowed) and the file name carrying an extension.`);
    }
    if (!(p === CONFIG_FILE || isAppConfigPath(p) || isAssetPath(p) || isEntityFilePath(p) || isCanonicalFunctionPath(p) || isWorkflowFilePath(p) || isAgentFilePath(p) || isAgentSkillFilePath(p) || isConnectorFilePath(p) || isActorFilePath(p) || isTypesPath(p) || isContextFilePath(p))) {
      throw new Error(`write_file: under base44/ only ${CONFIG_FILE}, ${APP_CONFIG_FILE}, ${ASSETS_DIR}<path>, base44/context/<path>, base44/entities/<Name>.jsonc, ${CANONICAL_FUNCTIONS_DIR}<name>/${FUNCTION_ENTRY}, ${WORKFLOWS_DIR}<Name>.jsonc, ${AGENTS_DIR}<name>.jsonc, ${AGENT_SKILLS_DIR}<name>.md, ${CONNECTORS_DIR}<name>.jsonc, ${ACTORS_DIR}<Name>/${ACTOR_ENTRY_FILE} and base44/.types/ files may be written. Got: ${p}`);
    }
  } else if (!(p === "styles.css" || p === "package.json" || p === "package.lock.json" || p.startsWith("src/") || p.startsWith("functions/") || p.startsWith("integrations/"))) {
    throw new Error(`write_file: files must live under src/ (frontend), functions/ (backend), integrations/ (integration definitions), base44/ (project resources), or be styles.css, package.json or package.lock.json. Got: ${p}`);
  }
  if (p.startsWith("functions/") && !/^functions\/[a-zA-Z][a-zA-Z0-9_]*\.js$/.test(p)) {
    throw new Error(`write_file: backend functions must be named functions/<name>.js with an alphanumeric name. Got: ${p}`);
  }
  if (p.startsWith("integrations/") && !/^integrations\/[a-z][a-zA-Z0-9_]*\.json$/.test(p)) {
    throw new Error(`write_file: integration definitions must be named integrations/<name>.json — prefer the create_integration / import_openapi tools. Got: ${p}`);
  }
  const f = fs.files.get(p);
  if (f && f.frozen) throw new Error(`File is frozen and cannot be modified: ${p}`);
  if (f) {
    f.content = String(content ?? "");
    f.deleted = false;
  } else {
    fs.files.set(p, { id: null, content: String(content ?? ""), original: null, frozen: false, deleted: false });
  }
}

export function patchFile(fs, path, find, replace) {
  const content = readFile(fs, path);
  if (!find) throw new Error("patch_file: 'find' is required");
  const idx = content.indexOf(find);
  if (idx === -1) throw new Error(`patch_file: the 'find' text was not found in ${path}. Re-read the file and try again.`);
  if (content.indexOf(find, idx + 1) !== -1) throw new Error(`patch_file: 'find' text matches more than one place in ${path}; include more context.`);
  writeFile(fs, path, content.slice(0, idx) + String(replace ?? "") + content.slice(idx + find.length));
}

export function deleteFile(fs, path) {
  const f = live(fs, path);
  if (!f) throw new Error(`File not found: ${path}`);
  if (f.frozen) throw new Error(`File is frozen and cannot be deleted: ${path}`);
  if (f.id) f.deleted = true; else fs.files.delete(normalizePath(path));
}

export function listFiles(fs) {
  return [...fs.files.entries()]
    .filter(([, f]) => !f.deleted)
    .map(([path, f]) => ({ path, size: f.content.length, frozen: f.frozen }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function activeFiles(fs) {
  return [...fs.files.entries()]
    .filter(([, f]) => !f.deleted)
    .map(([path, f]) => ({ path, content: f.content, frozen: f.frozen }));
}

export function searchProject(fs, query) {
  const q = String(query || "").toLowerCase();
  const out = [];
  if (!q) return out;
  for (const { path, content } of activeFiles(fs)) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && out.length < 60; i++) {
      if (lines[i].toLowerCase().includes(q)) out.push({ path, line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }
  return out;
}

const IMPORT_RE = /import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
const EXPORT_RE = /export\s+(default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;

export function indexFile(path, content) {
  const imports = [];
  const exportsList = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content))) imports.push(m[2]);
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(content))) exportsList.push(m[1] ? `default (${m[2]})` : m[2]);
  if (/export\s+default\s+(?!function|class|async)/.test(content)) exportsList.push("default");
  return { path, size: content.length, imports, exports: exportsList };
}

export function buildIndex(fs) {
  return activeFiles(fs).map((f) => indexFile(f.path, f.content));
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "add", "make", "change", "update", "create", "build", "app", "application", "page", "should", "from", "into", "also", "please", "want", "need", "new", "use", "using"]);

function keywords(prompt) {
  return [...new Set(String(prompt).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [])].filter((w) => !STOP.has(w));
}

// Context engine: rank files by relevance to the prompt and fill a character budget.
export function selectContext(fs, prompt, budget = 45000) {
  const words = keywords(prompt);
  const files = activeFiles(fs);
  const scored = files.map((f) => {
    const pathL = f.path.toLowerCase();
    const contentL = f.content.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (pathL.includes(w)) score += 8;
      const hits = contentL.split(w).length - 1;
      score += Math.min(hits, 10);
    }
    if (f.path === "src/main.js" || f.path === "src/App.js") score += 100;
    return { ...f, score };
  });
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const included = [];
  const omitted = [];
  let used = 0;
  for (const f of scored) {
    if (used + f.content.length <= budget) {
      included.push({ path: f.path, content: f.content, frozen: f.frozen });
      used += f.content.length;
    } else omitted.push(f.path);
  }
  return { included, omitted, keywords: words };
}

// The FS must survive between background phases (each runs in its own request), so it
// serializes losslessly — including `original`, which is what computeChanges() diffs against.
export function serializeFs(fs) {
  return [...fs.files.entries()].map(([path, f]) => ({ path, ...f }));
}

export function deserializeFs(records) {
  const files = new Map();
  for (const { path, ...f } of records || []) files.set(path, f);
  return { files };
}

export function computeChanges(fs) {
  const out = [];
  for (const [path, f] of fs.files.entries()) {
    if (f.deleted) out.push({ path, change: "deleted" });
    else if (f.id == null) out.push({ path, change: "added" });
    else if (f.content !== f.original) out.push({ path, change: "modified" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}