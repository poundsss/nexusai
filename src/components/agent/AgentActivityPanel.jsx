import React, { useCallback, useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import { AGENT_TERMINAL } from "@/hooks/useAgentRun";
import AllAgentsPanel from "@/components/agent/AllAgentsPanel";
import AgentGoalForm from "@/components/agent/AgentGoalForm";
import AgentRunRow from "@/components/agent/AgentRunRow";

// Activity panel for the /agent chat: the workspace's declared agents (the certified All
// Agents view), the existing goal starter (AgentGoalForm → the certified agentRun contract),
// and the workspace's recent agent runs (AgentRunRow). Mounted beside the chat, full-screen
// overlay on small screens.
export default function AgentActivityPanel({ onClose }) {
  const { workspace } = useWorkspace();
  const [projects, setProjects] = useState([]);
  const [runs, setRuns] = useState([]);
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState(null);
  const [steps, setSteps] = useState([]);
  const [cancelling, setCancelling] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const ps = (await workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50 }).catch(() => ({ projects: [] }))).projects;
    setProjects(ps.filter((p) => p.status !== "archived"));
    const rs = (await base44.entities.AgentRun.filter({ workspace_id: workspace.id }, { sort: "-created_date", limit: 15 }).catch(() => ({ items: [] }))).items;
    setRuns(rs);
  }, [workspace]);

  useEffect(() => { refresh(); }, [refresh]);

  // Task/progress state of the selected run: the durable AgentStep rows, polled ONLY while the
  // run is still active. The same certified agentRun cancel contract useAgentRun composes.
  useEffect(() => {
    setSteps([]);
    if (!selected) return;
    let alive = true;
    let timer = null;
    const loadSteps = async () => {
      const s = (await base44.entities.AgentStep.filter({ agent_run_id: selected }, { sort: "step_number", limit: 60 }).catch(() => ({ items: [] }))).items;
      if (alive) setSteps(s || []);
    };
    loadSteps();
    const tick = async () => {
      const latest = await refresh();
      if (!latest || latest.id !== selected || AGENT_TERMINAL.includes(latest.status)) {
        if (timer) clearInterval(timer);
      }
      await loadSteps();
    };
    const current = (runs || []).find((r) => r.id === selected);
    if (!current || !AGENT_TERMINAL.includes(current.status)) timer = setInterval(tick, 2500);
    return () => { alive = false; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, refresh]);

  const cancelSelected = async () => {
    const run = (runs || []).find((r) => r.id === selected);
    if (!run) return;
    setCancelling(true);
    try {
      await base44.functions.invoke("agentRun", { project_id: run.project_id, action: "cancel", agent_run_id: run.id });
      await refresh();
    } finally { setCancelling(false); }
  };

  // Same certified enqueue contract useAgentRun.start composes (agentRun, image_urls).
  const start = async (projectId, goal, urls) => {
    setStarting(true);
    try {
      await base44.functions.invoke("agentRun", { project_id: projectId, goal, image_urls: urls });
      await refresh();
    } finally { setStarting(false); }
  };

  return (
    <aside className="absolute inset-0 z-50 flex flex-col overflow-y-auto scrollbar-thin border-l border-border bg-card p-4 md:static md:z-auto md:w-[380px] md:shrink-0 md:bg-muted/40">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-foreground">Activity</h2>
        <button onClick={onClose} aria-label="Close activity" className="rounded-md p-1 text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <AgentGoalForm projects={projects} busy={starting} onStart={start} />

      <div className="mt-5">
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Recent runs</h3>
        {runs.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No agent runs yet. Give the agent a goal above to start one.</p>
        ) : (
          <div className="space-y-2">
            {runs.map((r) => (
              <div key={r.id} className="[&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground [&_a]:!text-muted-foreground">
                <AgentRunRow
                  run={r}
                  projectName={projects.find((p) => p.id === r.project_id)?.name}
                  selected={selected === r.id}
                  onSelect={() => { setSelected(selected === r.id ? null : r.id); setSteps([]); }}
                  steps={selected === r.id ? steps : []}
                  onCancel={selected === r.id ? cancelSelected : undefined}
                  cancelling={cancelling}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <AllAgentsPanel />
      </div>
    </aside>
  );
}