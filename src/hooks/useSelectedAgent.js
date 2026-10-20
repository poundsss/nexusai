import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useAgentChatState } from "@/lib/agentChatStore";
import { useWorkspace } from "@/hooks/useWorkspace";

// The app's own root agents (base44/agents/<name>.jsonc) are NOT in the workspace projection
// (which lists project-declared agents), so their certified configs are mirrored here — the
// same tool_configs/context_files the documents carry. Editing a root agent's config is done in
// its file; this mirror is read-only UI state for the Files/Memory/Data surfaces.
export const ROOT_AGENT_CONFIGS = {
  NexusAgent: {
    name: "NexusAgent",
    display_name: "NexusAgent",
    project_name: null,
    project_id: null,
    tool_configs: [
      { entity_name: "Project", allowed_operations: ["read"] },
      { entity_name: "Activity", allowed_operations: ["read"] },
    ],
    context_files: [],
  },
  GrowthAgent: {
    name: "GrowthAgent",
    display_name: "GrowthAgent",
    project_name: null,
    project_id: null,
    tool_configs: [
      { entity_name: "Customer", allowed_operations: ["read"] },
      { entity_name: "Activity", allowed_operations: ["read"] },
      { entity_name: "ListenTerm", allowed_operations: ["read"] },
      { entity_name: "ListenObservation", allowed_operations: ["read"] },
      { entity_name: "AeoProbe", allowed_operations: ["read"] },
      { entity_name: "AeoResult", allowed_operations: ["read"] },
    ],
    context_files: [],
  },
};

// Resolves the agent currently selected in the agent switcher: root agents come from the
// mirrored configs, project-declared agents from the certified workspaceAgents projection.
export default function useSelectedAgent() {
  const { agentName } = useAgentChatState();
  const { workspace } = useWorkspace();
  const [agent, setAgent] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setAgent(null); setError(null);
    if (ROOT_AGENT_CONFIGS[agentName]) {
      const base = ROOT_AGENT_CONFIGS[agentName];
      // Identity (name/description) is editable for root agents via the AgentProfile override.
      base44.entities.AgentProfile.filter({ agent_name: agentName }, { limit: 1 })
        .then((page) => {
          const prof = (page?.items || [])[0];
          setAgent(prof ? { ...base, display_name: prof.display_name || base.display_name, description: prof.description ?? base.description } : base);
        })
        .catch(() => setAgent(base));
      return;
    }
    if (!workspace) return;
    let alive = true;
    base44.functions.invoke("workspaceAgents", { workspace_id: workspace.id })
      .then((res) => {
        if (!alive) return;
        const found = ((res?.data || res)?.agents || []).find((a) => a.name === agentName) || null;
        if (found) setAgent(found);
        else setError(`Agent "${agentName}" is not declared in this workspace yet`);
      })
      .catch((e) => { if (alive) setError(e?.response?.data?.error || e?.message || "Could not load the agent"); });
    return () => { alive = false; };
  }, [agentName, workspace]);

  return { agentName, agent, error };
}