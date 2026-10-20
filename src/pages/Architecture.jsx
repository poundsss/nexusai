import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Network, Loader2, RefreshCw, ArrowDownToLine, ArrowUpFromLine, Zap, Layers, Ban, Info, Search } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import AccountPage from "@/components/shell/AccountPage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Builder Architecture panel — read-only inspect of the certified `architecture` intelligence layer.
// Surfaces: architecture summary (get/include_graph), node browsing (queryNodes-style filter over
// the returned graph), dependency traversal (queryDependencies in/out), and impact view (runImpactAnalysis).
// All data comes from existing ArchitectureNode / ArchitectureEdge rows via the existing backend. The
// only write is `reconcile` — an existing certified action that (re)derives the graph from authoritative
// project state; it is offered only when no finalized architecture exists. No graph semantics, node
// types, relationship types, or architecture events are invented.
const STATUS_TONE = { DRAFT: "bg-amber-500/10 text-amber-600", FINALIZED: "bg-emerald-500/10 text-emerald-600", SUPERSEDED: "bg-muted text-muted-foreground" };
const PROVENANCE_TONE = { verified: "text-emerald-600", user_decision: "text-blue-600", inferred: "text-amber-600" };

export default function Architecture() {
  const { loading, workspace } = useWorkspace();
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [arch, setArch] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [bounded, setBounded] = useState(null);
  const [error, setError] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const [filter, setFilter] = useState({ type: "", domain: "", key: "" });
  const [selected, setSelected] = useState(null);
  const [dir, setDir] = useState("out");
  const [traversal, setTraversal] = useState(null);
  const [impact, setImpact] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    (async () => {
      try {
        const d = await workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50 });
        const rows = d.projects || [];
        setProjects(rows);
        if (rows?.[0]?.id) setProjectId(rows[0].id);
      } catch (e) { setError(e.response?.data?.error || e.message); }
    })();
  }, [workspace]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setArch(null); setError(null); setSelected(null); setTraversal(null); setImpact(null);
    try {
      const res = await base44.functions.invoke("architecture", { action: "get", project_id: projectId, include_graph: true });
      setArch(res.data?.architecture || null);
      setNodes(res.data?.nodes || []);
      setEdges(res.data?.edges || []);
      setBounded(res.data?.bounded || null);
    } catch (e) {
      const code = e.response?.data?.code;
      setError(e.response?.data?.error || e.message);
      if (code !== "ARCHITECTURE_NOT_FOUND") setNodes([]);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const reconcile = async () => {
    setReconciling(true);
    try {
      await base44.functions.invoke("architecture", { action: "reconcile", project_id: projectId });
      toast({ title: "Architecture reconciled" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Reconcile failed", description: e.response?.data?.error || e.message });
    } finally { setReconciling(false); }
  };

  const filtered = useMemo(() => {
    const needle = filter.key.trim().toLowerCase();
    return nodes.filter((n) =>
      (!filter.type || n.node_type === filter.type) &&
      (!filter.domain || (n.domain || "") === filter.domain) &&
      (!needle || (n.node_key || "").toLowerCase().includes(needle) || (n.name || "").toLowerCase().includes(needle))
    );
  }, [nodes, filter]);

  const types = useMemo(() => [...new Set(nodes.map((n) => n.node_type))].sort(), [nodes]);
  const domains = useMemo(() => [...new Set(nodes.map((n) => n.domain).filter(Boolean))].sort(), [nodes]);

  const traverse = useCallback(async (node, direction) => {
    setSelected(node); setDir(direction); setImpact(null);
    setTraversal(null);
    setBusy(true);
    try {
      const res = await base44.functions.invoke("architecture", { action: "queryDependencies", project_id: projectId, node_key: node.node_key, direction, depth: 2 });
      setTraversal(res.data);
    } catch (e) {
      setTraversal({ error: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  }, [projectId]);

  const runImpact = useCallback(async (node) => {
    setBusy(true);
    setImpact(null);
    try {
      const res = await base44.functions.invoke("architecture", { action: "impact", project_id: projectId, targets: [node.node_key], change_type: "modify", depth: 2 });
      setImpact(res.data?.impact);
    } catch (e) {
      setImpact({ error: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  }, [projectId]);

  const incoming = edges.filter((e) => e.to_node_key === selected?.node_key);
  const outgoing = edges.filter((e) => e.from_node_key === selected?.node_key);
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.node_key, n])), [nodes]);

  return (
    <AccountPage loading={loading} title="Architecture" subtitle="Dependency graph and impact analysis derived from this app's authoritative state."
      actions={<Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>}>
      <div className="flex items-center gap-2 mb-4">
        <Network className="h-4 w-4 text-muted-foreground" />
        <label className="text-[12.5px] text-muted-foreground">App</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-[12.5px]">
          {projects.length === 0 ? <option value="">No projects</option> : projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 mb-4 flex items-start gap-2">
          {error.includes("no architecture") || error.toLowerCase().includes("architecture_not_found") ? (
            <>
              <Info className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-[12px] text-muted-foreground">No architecture has been reconciled for this app yet. Reconcile to derive the graph from the app's authoritative state (files, entities, workflows, integrations).</p>
                <Button size="sm" className="mt-2" onClick={reconcile} disabled={reconciling}>{reconciling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}Reconcile architecture</Button>
              </div>
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">{error}</p>
          )}
        </div>
      )}

      {arch && (
        <section className="rounded-lg border border-border p-4 mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">Architecture v{arch.version}</h3>
            <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${STATUS_TONE[arch.status] || "bg-muted text-muted-foreground"}`}>{arch.status}</span>
            <span className="text-[11.5px] text-muted-foreground">· {nodes.length} nodes · {edges.length} edges</span>
            {arch.source_project_version != null && <span className="text-[11.5px] text-muted-foreground">· from project v{arch.source_project_version}</span>}
            {bounded?.truncated && <span className="text-[11px] text-amber-600">· graph truncated to {bounded.node_limit}</span>}
          </div>
          {arch.architecture_fingerprint && <p className="mt-1 text-[11px] text-muted-foreground font-mono truncate">fingerprint {arch.architecture_fingerprint.slice(0, 24)}…</p>}
          <div className="mt-2 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={reconcile} disabled={reconciling}>{reconciling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}Reconcile</Button>
          </div>
        </section>
      )}

      {arch && (
        <div className="grid lg:grid-cols-2 gap-4">
          <section className="rounded-lg border border-border p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-2"><Search className="h-3.5 w-3.5 text-muted-foreground" />Browse nodes</div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-[12px]">
                <option value="">All types</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={filter.domain} onChange={(e) => setFilter({ ...filter, domain: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-[12px]">
                <option value="">All domains</option>
                {domains.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <Input value={filter.key} onChange={(e) => setFilter({ ...filter, key: e.target.value })} placeholder="Filter by key or name…" className="h-8 text-[12px] max-w-[180px]" />
            </div>
            <ul className="divide-y divide-border/40 rounded-md border border-border max-h-[420px] overflow-y-auto">
              {filtered.length === 0 ? <li className="px-2.5 py-3 text-center text-[12px] text-muted-foreground/60">No nodes match.</li> : filtered.slice(0, 200).map((n) => (
                <li key={n.node_id} onClick={() => traverse(n, "out")} className={`px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors ${selected?.node_id === n.node_id ? "bg-muted" : ""}`}>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="font-mono truncate">{n.node_key}</span>
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground shrink-0">{n.node_type}</span>
                    <span className={`text-[10px] ${PROVENANCE_TONE[n.provenance?.state] || "text-muted-foreground"}`}>{n.provenance?.state}</span>
                  </div>
                  {n.name && n.name !== n.node_key && <div className="text-[11px] text-muted-foreground truncate">{n.name}</div>}
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border border-border p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-2"><Network className="h-3.5 w-3.5 text-muted-foreground" />Selected node</div>
            {!selected ? (
              <p className="text-[12px] text-muted-foreground/60 py-6 text-center">Select a node to traverse its dependencies and run impact analysis.</p>
            ) : (
              <div>
                <div className="rounded-md bg-muted/30 px-2.5 py-1.5 mb-2">
                  <div className="font-mono text-[12.5px]">{selected.node_key}</div>
                  <div className="text-[11px] text-muted-foreground">{selected.node_type}{selected.domain ? ` · ${selected.domain}` : ""} · {selected.provenance?.state}</div>
                </div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Button size="sm" variant={dir === "out" ? "default" : "outline"} onClick={() => traverse(selected, "out")}><ArrowUpFromLine className="h-3 w-3" />Depends on</Button>
                  <Button size="sm" variant={dir === "in" ? "default" : "outline"} onClick={() => traverse(selected, "in")}><ArrowDownToLine className="h-3 w-3" />Dependents</Button>
                  <Button size="sm" variant="outline" onClick={() => runImpact(selected)} disabled={busy}><Zap className="h-3 w-3" />Impact</Button>
                </div>

                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}

                {traversal && !traversal.error && (
                  <div className="mb-3">
                    <div className="text-[11px] text-muted-foreground mb-1">Traversal ({traversal.direction}, depth {traversal.depth}) · {traversal.count} nodes{traversal.truncated ? " · truncated" : ""}</div>
                    {traversal.external_dependencies?.length > 0 && <p className="text-[11px] text-muted-foreground mb-1">External: {traversal.external_dependencies.join(", ")}</p>}
                    <ul className="divide-y divide-border/40 rounded-md border border-border max-h-48 overflow-y-auto">
                      {(traversal.dependencies || []).map((d, i) => (
                        <li key={i} className="px-2 py-1 text-[11.5px] flex items-center gap-2">
                          <span className="font-mono truncate flex-1">{d.node_key}</span>
                          <span className="text-muted-foreground">{d.relationship}</span>
                          <span className="text-muted-foreground/70">d{d.depth}</span>
                          {d.external && <span className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-600">ext</span>}
                        </li>
                      ))}
                      {(!traversal.dependencies || traversal.dependencies.length === 0) && <li className="px-2 py-2 text-center text-muted-foreground/60">No edges in this direction.</li>}
                    </ul>
                  </div>
                )}

                {impact && !impact.error && (
                  <div className="rounded-md border border-border p-2.5">
                    <div className="flex items-center gap-2 text-[12px] mb-1">
                      <span className="font-semibold">Impact</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${impact.risk_level === "high" ? "bg-destructive/10 text-destructive" : impact.risk_level === "medium" ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-600"}`}>{impact.risk_level} risk</span>
                      <span className="text-muted-foreground ml-auto">{impact.affected_count} affected</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mb-1">
                      {(impact.directly_affected || []).length} direct · {(impact.transitively_affected || []).length} transitive{impact.truncated ? " · truncated" : ""}
                    </div>
                    {(impact.paths || []).length > 0 ? (
                      <ul className="divide-y divide-border/40 rounded-md border border-border max-h-48 overflow-y-auto">
                        {impact.paths.slice(0, 12).map((p, i) => (
                          <li key={i} className="px-2 py-1 text-[11.5px] flex items-center gap-2">
                            <span className="font-mono truncate flex-1">{p.node_key}</span>
                            <span className="text-muted-foreground">{p.relationship}</span>
                            <span className="text-muted-foreground/70">d{p.depth}</span>
                            {p.external && <span className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-600">ext</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11px] text-muted-foreground/60">No affected nodes.</p>
                    )}
                  </div>
                )}

                {traversal?.error && <p className="text-[12px] text-destructive">{traversal.error}</p>}
                {impact?.error && <p className="text-[12px] text-destructive">{impact.error}</p>}
              </div>
            )}
          </section>
        </div>
      )}

      <div className="mt-3 flex items-start gap-2 text-[11.5px] text-muted-foreground/80">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <p>Graph data is derived server-side from authoritative project state (files, entities, workflows, integrations, resources). Node types, relationship types and provenance states are the backend's fixed vocabulary — none is invented here. The only write is <code className="font-mono">reconcile</code>, an existing certified action.</p>
      </div>
    </AccountPage>
  );
}