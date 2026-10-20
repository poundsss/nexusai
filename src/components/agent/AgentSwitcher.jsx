import React, { useEffect, useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";

// The app's own root agents (base44/agents/<name>.jsonc) — always selectable, since the chat
// runs directly on them. Project-declared agents are appended from the certified workspace
// projection, so the switcher never invents a second agent model.
const ROOT_AGENTS = [
  { name: "NexusAgent", display_name: "NexusAgent", project_name: null },
  { name: "GrowthAgent", display_name: "GrowthAgent", project_name: null },
];

// Agent switcher for the /agent chat: pick which workspace agent the conversation belongs to.
export default function AgentSwitcher({ value, onChange }) {
  const { workspace } = useWorkspace();
  const [agents, setAgents] = useState(ROOT_AGENTS);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    base44.functions.invoke("workspaceAgents", { workspace_id: workspace.id })
      .then((res) => {
        if (!alive) return;
        const list = (res?.data || res)?.agents || [];
        const extra = list
          .filter((a) => !ROOT_AGENTS.some((r) => r.name === a.name))
          .map((a) => ({ name: a.name, display_name: a.display_name || a.name, project_name: a.project_name || null }));
        setAgents([...ROOT_AGENTS, ...extra]);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [workspace]);

  const current = agents.find((a) => a.name === value) || agents[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white/90 hover:bg-white/10 outline-none">
        <Bot className="h-3.5 w-3.5 text-[#60a5fa]" />
        {current?.display_name || value}
        <ChevronDown className="h-3 w-3 text-white/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Agents</DropdownMenuLabel>
        {agents.map((a) => (
          <DropdownMenuItem
            key={a.name}
            onClick={() => onChange(a.name)}
            className={a.name === value ? "bg-accent" : ""}
          >
            <Bot className="h-4 w-4 mr-2 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">{a.display_name || a.name}</div>
              <div className="truncate text-[11px] text-muted-foreground font-normal">
                {a.project_name || "Workspace agent"}
              </div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}