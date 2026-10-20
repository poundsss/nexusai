// Architecture Intelligence — canonical RESOURCE primitives as graph nodes.
//
// Pure companion to shared/architectureGraph.ts. Each block below turns ONE already-parsed resource
// declaration (config, app surface, plugins, assets, agents, skills, connectors, actors, workflow
// resources, auth posture, analytics usage) into verified nodes and edges. Nothing here re-parses a
// document — the resource contracts own parsing — and nothing here reads a secret VALUE, an agent's
// instructions body or a skill body: only names, references and bounded metadata are represented.
import { nodeKey, GRAPH_LIMITS } from "./architectureGraph.ts";

export function hostOf(url) {
  try { return new URL(String(url)).host || null; } catch { return null; }
}

const names = (rows, pick = (r) => r.name) => (rows || []).map(pick).filter(Boolean).slice(0, GRAPH_LIMITS.per_file_refs);

/**
 * Adds the canonical resource nodes to a graph builder. `fileKey(path)` resolves a project file to
 * its existing node key so cross-links (analytics use, workflow function steps) attach to the same
 * nodes the file pass created, never to duplicates.
 */
export function deriveResourceNodes(b, {
  config = null, app = null, plugins = [], assets = [], agents = [], skills = [],
  connectors = [], actors = [], workflow_resources = [], auth = null, analytics = null,
} = {}, { sources, fileKey, domainOf }) {
  const verified = (source, ref, detail) => ({ state: "verified", source, provenance_reference: ref, detail });

  // --- config: the project manifest and the app surface. Metadata is bounded to what the
  //     manifests declare about STRUCTURE (names, visibility, resource directories), never content.
  let projectConfig = null;
  if (config) {
    sources.config++;
    projectConfig = b.addNode("config", "project", {
      name: "base44/config.jsonc", reference: { file_path: "base44/config.jsonc" },
      metadata: { keys: Object.keys(config).sort().slice(0, GRAPH_LIMITS.per_file_refs), visibility: config.visibility || null, resource_dirs: names(config.resource_dirs, (d) => d) },
      ...verified("config", "base44/config.jsonc", "Read from the project's manifest"),
    });
  }
  let appConfig = null;
  if (app) {
    sources.config++;
    appConfig = b.addNode("config", "app", {
      name: ".app.jsonc", reference: { file_path: ".app.jsonc" },
      metadata: { app_name: app.name || null, visibility: app.visibility || null, icon: app.icon || null, plugin_count: (app.plugins || []).length },
      ...verified("config", ".app.jsonc", "Read from the project's app surface declaration"),
    });
    if (projectConfig) b.addEdge(projectConfig, "configures", appConfig, verified("config", "base44/config.jsonc", "The manifest governs the app surface"));
  }

  // --- plugins: declared by name at one of two declaration sites; the site is the provenance.
  for (const p of plugins || []) {
    if (!p?.name) continue;
    sources.plugins++;
    const nk = b.addNode("plugin", p.name, {
      name: p.name, reference: { plugin: p.name, declared_in: p.source || null }, metadata: { declared_in: p.source || null },
      ...verified("plugin", p.source || null, `Plugin declared in ${p.source || "the project configuration"}`),
    });
    const site = p.source === ".app.jsonc" ? appConfig : projectConfig;
    if (site) b.addEdge(site, "configures", nk, verified("plugin", p.source || null, `${p.source} enables the ${p.name} plugin`));
  }

  // --- assets: content, never behaviour. Size and path only.
  for (const a of assets || []) {
    if (!a?.path) continue;
    sources.assets++;
    const nk = b.addNode("asset", a.path, {
      name: a.name || a.path, reference: { file_path: a.path }, metadata: { size: Number(a.size) || 0 },
      ...verified("asset", a.path, "Canonical asset file"),
    });
    if (appConfig && app?.icon && a.path.endsWith(app.icon)) b.addEdge(appConfig, "depends_on", nk, verified("asset", ".app.jsonc", "Declared as the app icon"));
  }

  // --- skills: guidance documents an agent may reference. The body stays out of the graph.
  for (const s of skills || []) {
    if (!s?.name) continue;
    sources.skills++;
    b.addNode("skill", s.name, {
      name: s.name, reference: { skill_name: s.name, file_path: s.path || null },
      metadata: { description: s.description || "" },
      ...verified("agent_skill", s.path || s.name, "Read from the project's agent-skill declaration"),
    });
  }

  // --- agents: declared grants and skill references are the facts; instructions are withheld.
  for (const a of agents || []) {
    if (!a?.name) continue;
    sources.agents++;
    const nk = b.addNode("agent", a.name, {
      name: a.display_name || a.name, reference: { agent_name: a.name, file_path: a.path || null },
      metadata: { description: a.description || "", tools: names(a.tools, (t) => t), skills: names(a.skills, (s) => s), model_tier: a.model_tier || null, max_steps: a.max_steps ?? null },
      ...verified("agent", a.path || a.name, "Read from the project's agent declaration"),
    });
    for (const t of a.tools || []) {
      const tk = b.addNode("tool", t, { name: t, reference: { tool: t }, metadata: { kind: "agent_tool" }, ...verified("agent", a.path || a.name, `Tool granted by the '${a.name}' agent declaration`) });
      b.addEdge(nk, "grants", tk, verified("agent", a.path || a.name, `Agent '${a.name}' is granted '${t}'`));
    }
    for (const s of a.skills || []) b.addEdge(nk, "depends_on", nodeKey("skill", s), verified("agent", a.path || a.name, `Agent '${a.name}' references the '${s}' skill`));
  }

  // --- connectors: the service the project declares. Secret NAME only, host only.
  for (const c of connectors || []) {
    if (!c?.name) continue;
    sources.connectors++;
    const ref = c.path || `base44/connectors/${c.name}.jsonc`;
    const host = hostOf(c.base_url);
    const nk = b.addNode("connector", c.name, {
      name: c.name, domain: domainOf(c.name) || null, reference: { connector_name: c.name, file_path: ref },
      metadata: { base_url_host: host, auth_type: c.auth?.type || "none", secret_name: c.auth?.secret || null, type: c.type || "http", operations: names(c.operations) },
      ...verified("connector", ref, "Read from the project's connector declaration"),
    });
    if (host) {
      const dep = b.addNode("external_dependency", host, { name: host, reference: { host }, metadata: { kind: "http_service" }, ...verified("connector", ref, "External service named by the connector declaration") });
      b.addEdge(nk, "consumes", dep, { ...verified("connector", ref, "Connector calls this external service"), external: true });
    }
    if (c.auth?.secret) {
      const sec = b.addNode("storage", `secret:${c.auth.secret}`, { name: c.auth.secret, reference: { secret_name: c.auth.secret }, metadata: { resource_kind: "secret_reference", value_stored: false }, ...verified("connector", ref, "Secret reference (name only) used by the connector") });
      b.addEdge(nk, "depends_on", sec, verified("connector", ref, "Connector authenticates with this secret reference"));
    }
  }

  // --- actors: each declared actor publishes one realtime surface (its rooms) to the deployed app.
  for (const a of actors || []) {
    if (!a?.name) continue;
    sources.actors++;
    const nk = b.addNode("actor", a.name, {
      name: a.name, reference: { actor_name: a.name, file_path: a.path || null },
      metadata: { access: a.access || "write", capability: a.capability || null, persist: a.persist !== false, events: a.events !== false, description: a.description || "" },
      ...verified("actor", a.path || a.name, "Read from the project's actor declaration"),
    });
    const surface = b.addNode("realtime_surface", a.name, {
      name: `${a.name} rooms`, reference: { actor_name: a.name }, metadata: { kind: "actor_rooms", events: a.events !== false },
      ...verified("actor", a.path || a.name, "Realtime rooms served for this actor"),
    });
    b.addEdge(nk, "publishes", surface, verified("actor", a.path || a.name, `Actor '${a.name}' serves its rooms to the app`));
  }

  // --- workflow resources: versioned documents; a function step names a real project function.
  for (const w of workflow_resources || []) {
    const def = w?.definition;
    if (!def?.name) continue;
    sources.workflow_resources++;
    const steps = Array.isArray(def.steps) ? def.steps : [];
    const nk = b.addNode("workflow", def.name, {
      name: def.name, domain: domainOf(def.name) || null,
      reference: { workflow_name: def.name, workflow_key: w.workflow_key || null, file_path: w.path || null },
      metadata: { trigger: def.trigger?.type || "manual", step_count: steps.length, entry_step: def.entry_step || null },
      ...verified("workflow", w.path || def.name, "Read from the project's workflow resource document"),
    });
    for (const s of steps) {
      const fn = s?.function || s?.function_name || (s?.type === "function" ? s?.target : null);
      if (fn) b.addEdge(nk, "triggers", nodeKey("function", String(fn)), verified("workflow", w.path || def.name, `Step '${s.id || s.name || fn}' invokes the ${fn} function`));
    }
  }

  // --- auth posture: the project's own row-level isolation setting plus per-entity RLS
  //     declarations. Represented once; the rls evaluator stays the only thing that enforces it.
  if (auth) {
    sources.auth++;
    const nk = b.addNode("auth", "app", {
      name: "App auth", reference: { setting: "Project.rls_enabled" },
      metadata: { rls_enabled: !!auth.rls_enabled, entities_with_rls: names(auth.entities_with_rls, (e) => e) },
      ...verified("auth", "Project.rls_enabled", "Generated-app authentication and row-level isolation posture"),
    });
    for (const e of auth.entities_with_rls || []) b.addEdge(nk, "authorizes", nodeKey("entity", e), verified("auth", e, `Entity '${e}' declares its own row-level security`));
  }

  // --- analytics: which project files publish events to the app's analytics surface.
  if (analytics) {
    sources.analytics++;
    const nk = b.addNode("analytics", "app", {
      name: "App analytics", reference: { surface: "analytics" }, metadata: { publisher_count: (analytics.files || []).length },
      ...verified("analytics", "analytics", "Server-side analytics ingestion surface of the deployed app"),
    });
    for (const path of analytics.files || []) {
      const from = fileKey(path);
      if (from) b.addEdge(from, "publishes", nk, verified("analytics", path, `Tracks analytics events in ${path}`));
    }
  }
}