import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, ChevronRight, FileCode2, Loader2, AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";

// All Agents — the WORKSPACE-level view over the projects' declared agents
// (base44/agents/<name>.jsonc), served by the existing agent-file model. Read-only:
// every row opens the agent's own file in that project's Builder code view, and
// malformed documents surface as report rows instead of disappearing.
const CHIP = "rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground";

export default function AllAgentsPanel() {
  const { workspace } = useWorkspace();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    setError(null);
    base44.functions.invoke("workspaceAgents", { workspace_id: workspace.id })
      .then((res) => { if (!cancelled) setData(res?.data || res); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e?.message || "Could not load the workspace's agents"); });
    return () => { cancelled = true; };
  }, [workspace]);

  const agents = data?.agents || [];
  const problems = data?.validation_errors || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[15px] font-semibold tracking-tight">All agents</h2>
        {data && <span className="text-[12px] text-muted-foreground">{data.count} across {data.projects_with_agents} app{data.projects_with_agents === 1 ? "" : "s"}</span>}
      </div>
      <p className="text-[12.5px] text-muted-foreground mb-4">
        Agents declared by your apps (base44/agents/&lt;name&gt;.jsonc). Open one to view or edit its configuration in that app's code.
      </p>

      {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive">{error}</div>}
      {!error && !data && (
        <div className="rounded-md border border-border divide-y divide-border">
          <div className="p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
        </div>
      )}

      {data && agents.length === 0 && problems.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-[12.5px] text-muted-foreground">
          No agents declared yet — add <span className="font-mono">base44/agents/&lt;name&gt;.jsonc</span> inside an app (Builder → Agents → Configuration).
        </div>
      )}

      {data && (agents.length > 0 || problems.length > 0) && (
        <div className="rounded-md border border-border divide-y divide-border">
          {agents.map((a) => (
            <div key={`${a.project_id}:${a.path}`} className="px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <Bot className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[12.5px] font-medium truncate">{a.display_name}</span>
                    <span className="text-[11px] text-muted-foreground/60 truncate">{a.project_name}</span>
                  </div>
                  {a.description && <p className="text-[11.5px] text-muted-foreground truncate">{a.description}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground/70">
                    <span className={CHIP}>{a.path}</span>
                    {a.tools.length > 0 && <span className={CHIP}>{a.tools.length} tool{a.tools.length === 1 ? "" : "s"}</span>}
                    {a.tool_configs.length > 0 && <span className={CHIP}>{a.tool_configs.length} tool grant{a.tool_configs.length === 1 ? "" : "s"}</span>}
                    {a.skills.length + a.selected_skill_names.length > 0 && <span className={CHIP}>{a.skills.length + a.selected_skill_names.length} skill{a.skills.length + a.selected_skill_names.length === 1 ? "" : "s"}</span>}
                    {a.connectors.length > 0 && <span className={CHIP}>{a.connectors.length} connector{a.connectors.length === 1 ? "" : "s"}</span>}
                    {a.model && <span className={CHIP}>{a.model}</span>}
                    {!a.model && a.model_tier && <span className={CHIP}>tier: {a.model_tier}</span>}
                    {a.max_steps != null && <span className={CHIP}>max {a.max_steps} steps</span>}
                    {!a.memory_enabled && <span className={CHIP}>memory off</span>}
                    {a.allow_anonymous_access && <span className={CHIP}>anonymous</span>}
                  </div>
                </div>
                <Link
                  to={`/projects/${a.project_id}?file=${encodeURIComponent(a.path)}`}
                  className="flex items-center gap-1 shrink-0 rounded-lg border border-border px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                >
                  <FileCode2 className="h-3.5 w-3.5" />Open<ChevronRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          ))}
          {problems.map((p) => (
            <div key={`${p.project_id}:${p.path}`} className="px-3 py-2.5 flex items-start gap-2.5 text-[12px]">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
              <div className="min-w-0">
                <p className="truncate font-mono text-[11px]">{p.path} <span className="text-muted-foreground/60">({p.project_name})</span></p>
                <p className="text-amber-600 dark:text-amber-400">{p.error}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}