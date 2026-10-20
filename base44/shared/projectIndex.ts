// Semantic project index + hybrid retrieval.
//
// The builder used to send a keyword-ranked slice of the whole repository to the model. This
// module turns a project into INDEXED OBJECTS (files, pages, components, routes, entities,
// backend functions, integrations, config) with content hashes and embeddings, then answers a
// prompt with a bounded, deduplicated, dependency-expanded context.
//
// Guarantees:
//   • Project isolation: every read and write is filtered by project_id. Nothing here can
//     surface another project's or workspace's objects.
//   • Incremental: entries are keyed by (type, key) and skipped when the content hash matches,
//     so unchanged content is never re-embedded. Stale entries are deleted.
//   • Non-destructive: indexing runs after a successful commit and its failure is reported,
//     never allowed to corrupt project state (see safeSyncProjectIndex).
//   • Bounded: retrieval, dependency expansion and context assembly all have hard ceilings —
//     the whole repository is never loaded into a prompt.
import { activeFiles, indexFile, normalizePath, readFile } from "./projectFs.ts";
import { createEmbedder, cosine, hashString, tokenize } from "./embeddings.ts";

const MAX_TEXT = 1200;
const MAX_ENTRIES = 500;
const ROUTE_RE = /['"](\/[a-zA-Z0-9\-_/:]*)['"]/g;
const CONFIG_RE = /export\s+const\s+config\s*=\s*(\{[\s\S]*?\})/;

const clip = (t, n = MAX_TEXT) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function fileType(path) {
  if (path.startsWith("src/pages/")) return "page";
  if (path.startsWith("src/components/")) return "component";
  if (path.startsWith("functions/")) return "function";
  if (path.startsWith("integrations/")) return "integration";
  if (path === "styles.css") return "config";
  return "file";
}

function routesOf(content) {
  const out = new Set();
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(content))) {
    const p = m[1];
    if (p.length > 1 && !p.includes("//") && !/\.(js|css|json|png|svg)$/.test(p)) out.add(p);
  }
  return [...out].slice(0, 40);
}

// Derives every indexable object of a project from the virtual filesystem + declarations.
// Pure and synchronous: no database, no network, no embeddings.
export function deriveIndexObjects({ fs, entities = [], integrations = [] }) {
  const objects = [];
  const files = activeFiles(fs);

  for (const f of files) {
    const meta = indexFile(f.path, f.content);
    const type = fileType(f.path);
    const isFn = type === "function";
    const config = isFn ? (f.content.match(CONFIG_RE)?.[1] || "") : "";
    const entityRefs = [...new Set([...f.content.matchAll(/\bdb\.([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
    const integrationRefs = [...new Set([...f.content.matchAll(/\bintegrations\.([a-zA-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
    const secretRefs = [...new Set([...f.content.matchAll(/secrets\.(?:get|has)\(\s*['"]([A-Z0-9_]+)['"]/g)].map((m) => m[1]))];
    const serverRefs = [...new Set([...f.content.matchAll(/\bserver\.([a-zA-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
    objects.push({
      object_type: type,
      key: isFn ? f.path.replace(/^functions\/|\.js$/g, "") : f.path,
      source_path: f.path,
      title: f.path,
      // Searchable REPRESENTATION, not the file: signatures and references only.
      text: clip(`${f.path} ${type} exports: ${meta.exports.join(", ")} imports: ${meta.imports.join(", ")} ${config} entities: ${entityRefs.join(", ")} integrations: ${integrationRefs.join(", ")} calls: ${serverRefs.join(", ")} ${f.content.slice(0, 600)}`),
      metadata: {
        path: f.path, size: f.content.length, exports: meta.exports, imports: meta.imports,
        entities: entityRefs, integrations: integrationRefs, secrets: secretRefs, calls: serverRefs,
        ...(isFn ? { config } : {}),
      },
      hash: hashString(f.content),
    });
    if (f.path === "src/App.js" || f.path === "src/main.js") {
      for (const route of routesOf(f.content)) {
        objects.push({
          object_type: "route", key: route, source_path: f.path, title: `route ${route}`,
          text: clip(`route ${route} declared in ${f.path}`), metadata: { path: f.path, route },
          hash: hashString(`${route}:${f.path}`),
        });
      }
    }
  }

  for (const e of entities) {
    const fields = Array.isArray(e.fields) ? e.fields : [];
    objects.push({
      object_type: "entity", key: e.name, source_path: null, title: `entity ${e.name}`,
      text: clip(`entity ${e.name} fields: ${fields.map((f) => `${f.name}:${f.type}${f.required ? "!" : ""}`).join(", ")}`),
      metadata: { fields: fields.map((f) => f.name) }, hash: hashString(JSON.stringify(fields)),
    });
  }

  for (const i of integrations) {
    const ops = (i.operations || []).map((o) => `${o.name} ${o.method} ${o.path}`);
    objects.push({
      object_type: "integration", key: i.name, source_path: `integrations/${i.name}.json`,
      title: `integration ${i.name}`,
      text: clip(`integration ${i.name} ${i.base_url || ""} auth ${i.auth?.type || "none"} operations: ${ops.join(", ")}`),
      // Secret NAME only — an index entry never carries a credential value.
      metadata: { base_url: i.base_url, auth_type: i.auth?.type, secret: i.auth?.secret || null, operations: (i.operations || []).map((o) => o.name) },
      hash: hashString(JSON.stringify({ b: i.base_url, a: i.auth?.type, s: i.auth?.secret, o: ops })),
    });
  }

  return objects;
}

const entryKey = (o) => `${o.object_type}:${o.key}`;

export async function loadIndex(base44, projectId) {
  return base44.entities.ProjectIndexEntry.filter({ project_id: projectId }, "key", MAX_ENTRIES);
}

// Incremental sync. Only new/changed objects are embedded and written; unchanged entries are
// left untouched; entries whose object no longer exists (deleted, renamed, rolled back) are
// removed, so the index cannot serve a file the project does not have.
export async function syncProjectIndex(base44, { project, fs, entities = [], integrations = [], version_number = null, embedder = null, extraObjects = [] }) {
  const emb = embedder || createEmbedder();
  // extraObjects lets other intelligence layers (currently the design engine) contribute
  // indexed objects without this module knowing about them; they follow the same
  // (type, key) + hash identity, so they are incremental and self-invalidating too.
  const objects = [...deriveIndexObjects({ fs, entities, integrations }), ...extraObjects];
  const existing = await loadIndex(base44, project.id);
  const byKey = new Map(existing.map((row) => [entryKey(row), row]));
  const stats = { objects: objects.length, created: 0, updated: 0, unchanged: 0, deleted: 0, embedded: 0, embedding_failures: 0, provider: emb.provider, model: emb.model };

  const todo = [];
  for (const o of objects) {
    const row = byKey.get(entryKey(o));
    byKey.delete(entryKey(o));
    if (row && row.content_hash === o.hash && Array.isArray(row.embedding) && row.embedding.length) {
      stats.unchanged++;
      // Version stamp only — no re-embedding.
      if (version_number != null && row.version_number !== version_number) {
        await base44.entities.ProjectIndexEntry.update(row.id, { version_number });
      }
      continue;
    }
    todo.push({ o, row });
  }

  const vectors = await emb.embedMany(todo.map(({ o }) => `${o.title}\n${o.text}`));
  for (let i = 0; i < todo.length; i++) {
    const { o, row } = todo[i];
    const vec = vectors[i];
    if (vec) stats.embedded++; else stats.embedding_failures++;
    const data = {
      project_id: project.id, workspace_id: project.workspace_id, object_type: o.object_type, key: o.key,
      source_path: o.source_path || undefined, title: o.title, text: o.text, metadata: o.metadata,
      content_hash: o.hash, version_number: version_number ?? undefined,
      embedding: vec || undefined, embedding_dim: vec ? emb.dim : undefined, embedding_model: vec ? `${emb.provider}:${emb.model}` : undefined,
      indexed_at: new Date().toISOString(),
    };
    if (row) { await base44.entities.ProjectIndexEntry.update(row.id, data); stats.updated++; }
    else { await base44.entities.ProjectIndexEntry.create(data); stats.created++; }
  }

  for (const stale of byKey.values()) {
    await base44.entities.ProjectIndexEntry.delete(stale.id);
    stats.deleted++;
  }
  stats.embedding_usage = emb.usage;
  return stats;
}

// Indexing is intelligence, not correctness: a failure must never fail a committed run.
export async function safeSyncProjectIndex(base44, args) {
  try { return await syncProjectIndex(base44, args); }
  catch (e) { return { error: e.message, created: 0, updated: 0, deleted: 0, unchanged: 0 }; }
}

// --- retrieval ---------------------------------------------------------------

function lexicalScore(terms, row) {
  const hay = `${row.key} ${row.title} ${row.text}`.toLowerCase();
  const path = String(row.source_path || row.key).toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (path.includes(t)) score += 3;
    const hits = hay.split(t).length - 1;
    if (hits) score += Math.min(1 + Math.log(hits), 3);
  }
  return score;
}

// Hybrid ranking: semantic (embedding cosine) + lexical term overlap + exact key/path match
// + structured type filter + mild recency. Deterministic for a given index state.
export async function hybridSearch(base44, projectId, query, { limit = 12, types = null, embedder = null, rows = null } = {}) {
  const emb = embedder || createEmbedder();
  const all = rows || (await loadIndex(base44, projectId));
  const scoped = all.filter((r) => r.project_id === projectId && (!types || types.includes(r.object_type)));
  if (!scoped.length) return [];
  const terms = [...new Set(tokenize(query))];
  const qVec = await emb.embed(query);
  const now = Date.now();
  const scored = scoped.map((row) => {
    const semantic = qVec && Array.isArray(row.embedding) && row.embedding.length === qVec.length ? Math.max(0, cosine(qVec, row.embedding)) : 0;
    const lexical = lexicalScore(terms, row);
    const q = String(query || "").toLowerCase();
    const exact = q.includes(String(row.key).toLowerCase()) || (row.source_path && q.includes(row.source_path.toLowerCase())) ? 6 : 0;
    const ageDays = (now - Date.parse(row.indexed_at || row.updated_date || row.created_date || 0)) / 86400000;
    const recency = Number.isFinite(ageDays) ? Math.max(0, 0.3 - ageDays * 0.01) : 0;
    return {
      object_type: row.object_type, key: row.key, source_path: row.source_path || null, title: row.title,
      text: row.text, metadata: row.metadata || {},
      score: Number((semantic * 4 + lexical + exact + recency).toFixed(4)),
      scores: { semantic: Number(semantic.toFixed(4)), lexical: Number(lexical.toFixed(3)), exact, recency: Number(recency.toFixed(3)) },
    };
  });
  scored.sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key)));
  return scored.slice(0, limit);
}

// Project-local dependency expansion, bounded in both depth and count. Only relative project
// imports are followed — 'runtime' and anything non-relative is not a project file.
export function expandDependencies(fs, paths, { depth = 1, max = 12 } = {}) {
  const seen = new Set();
  const out = [];
  let frontier = [...new Set(paths.map(normalizePath).filter(Boolean))];
  for (let d = 0; d <= depth && frontier.length && out.length < max; d++) {
    const next = [];
    for (const p of frontier) {
      if (seen.has(p) || out.length >= max) continue;
      seen.add(p);
      let content;
      try { content = readFile(fs, p); } catch { continue; }
      if (d > 0) out.push(p);
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      for (const spec of indexFile(p, content).imports) {
        if (!spec.startsWith(".")) continue;
        const resolved = normalizePath(new URL(spec, `file:///${dir}/`).pathname.replace(/^\//, ""));
        if (!seen.has(resolved)) next.push(resolved);
      }
    }
    frontier = next;
  }
  return out;
}

// Assembles the final prompt context under a hard character budget: ranked file hits first,
// then their project-local dependencies, then pinned entry files. Deduplicated by path.
export function assembleContext(fs, hits, { budget = 45000, pinned = ["src/main.js", "src/App.js"], dependencyDepth = 1 } = {}) {
  const wanted = [];
  const push = (p, reason) => { const path = normalizePath(p); if (path && !wanted.some((w) => w.path === path)) wanted.push({ path, reason }); };
  for (const p of pinned) push(p, "entry");
  for (const h of hits) if (h.source_path) push(h.source_path, `retrieved:${h.object_type}`);
  for (const dep of expandDependencies(fs, wanted.map((w) => w.path), { depth: dependencyDepth })) push(dep, "dependency");

  const included = [];
  const omitted = [];
  let used = 0;
  for (const w of wanted) {
    let content;
    try { content = readFile(fs, w.path); } catch { continue; }
    if (used + content.length <= budget) { included.push({ path: w.path, content, reason: w.reason }); used += content.length; }
    else omitted.push(w.path);
  }
  for (const f of activeFiles(fs)) if (!included.some((i) => i.path === f.path) && !omitted.includes(f.path)) omitted.push(f.path);
  return { included, omitted, used, budget, retrieved: hits.map((h) => `${h.object_type}:${h.key}`) };
}