import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import { AGENT_TERMINAL } from "@/hooks/useAgentRun";

// Workspace-level view of the EXISTING agent runtime. It introduces no agent system of its own:
// runs are the same AgentRun records the Builder's agent pane reads, started and cancelled through
// the same `agentRun` backend function, and driven by the same "Agent Executor" workflow. This hook
// only widens the scope from one project to the workspace's projects so the Agent workspace can
// list them in one place.
export function useAgentWorkspace() {
  const { user, workspace, loading: wsLoading } = useWorkspace();
  const [projects, setProjects] = useState([]);
  const [runs, setRuns] = useState(null);
  const [steps, setSteps] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const [ps, rs] = await Promise.all([
      workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50 }).then((d) => d.projects || []),
      base44.entities.AgentRun.filter({ workspace_id: workspace.id }, { sort: "-created_date", limit: 25 }).then((p) => p.items || []),
    ]);
    setProjects(ps);
    setRuns(rs);
    return rs;
  }, [workspace]);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll only while a run is live — the server owns the loop, this just mirrors its durable state.
  const hasActive = (runs || []).some((r) => !AGENT_TERMINAL.includes(r.status));
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [hasActive, refresh]);

  // Steps of the selected run, from the existing AgentStep records.
  useEffect(() => {
    if (!selectedId) { setSteps([]); return; }
    let cancelled = false;
    const load = () => base44.entities.AgentStep.filter({ agent_run_id: selectedId }, "step_number", 60)
      .then((s) => { if (!cancelled) setSteps(s); });
    load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [selectedId, runs]);

  const start = useCallback(async (projectId, goal, imageUrls = []) => {
    setBusy(true); setError(null);
    try {
      const res = await base44.functions.invoke("agentRun", { project_id: projectId, goal, image_urls: imageUrls });
      const rs = await refresh();
      const id = res?.data?.agent_run_id;
      if (id) setSelectedId(id);
      return rs;
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not start the agent");
    } finally { setBusy(false); }
  }, [refresh]);

  const cancel = useCallback(async (run) => {
    setBusy(true); setError(null);
    try {
      await base44.functions.invoke("agentRun", { project_id: run.project_id, action: "cancel", agent_run_id: run.id });
      await refresh();
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not cancel the agent");
    } finally { setBusy(false); }
  }, [refresh]);

  const selected = (runs || []).find((r) => r.id === selectedId) || null;

  return {
    user, workspace, loading: wsLoading || runs === null,
    projects, runs: runs || [], selected, steps, selectedId, setSelectedId,
    start, cancel, busy, error, refresh,
  };
}