import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

export const AGENT_TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];

// The agent lives on the server. This hook only mirrors its durable state, so a refresh or
// a closed tab never affects the run.
export function useAgentRun(projectId, onFinished) {
  const [run, setRun] = useState(null);
  const [steps, setSteps] = useState([]);
  const [starting, setStarting] = useState(false);
  const finished = useRef(false);

  const refresh = useCallback(async () => {
    if (!projectId) return null;
    const page = await base44.entities.AgentRun.filter({ project_id: projectId }, { sort: "-created_date", limit: 1 });
    const latest = page.items?.[0] || null;
    setRun(latest);
    if (latest) setSteps((await base44.entities.AgentStep.filter({ agent_run_id: latest.id }, { sort: "step_number", limit: 60 })).items || []);
    return latest;
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!run || AGENT_TERMINAL.includes(run.status)) return;
    finished.current = false;
    const timer = setInterval(async () => {
      const latest = await refresh();
      if (latest && AGENT_TERMINAL.includes(latest.status) && !finished.current) { finished.current = true; onFinished?.(); }
    }, 2500);
    return () => clearInterval(timer);
  }, [run, refresh, onFinished]);

  const start = useCallback(async (goal, imageUrls = []) => {
    setStarting(true);
    try {
      await base44.functions.invoke("agentRun", { project_id: projectId, goal, image_urls: imageUrls });
      await refresh();
    } finally { setStarting(false); }
  }, [projectId, refresh]);

  const cancel = useCallback(async () => {
    if (!run) return;
    await base44.functions.invoke("agentRun", { project_id: projectId, action: "cancel", agent_run_id: run.id });
    await refresh();
  }, [projectId, run, refresh]);

  const active = !!run && !AGENT_TERMINAL.includes(run.status);
  return { run, steps, active, starting, start, cancel, refresh };
}