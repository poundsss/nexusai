import React, { useEffect, useState } from "react";
import { Loader2, Plus, ChevronDown, Wrench } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import ConnectorsTab from "@/components/plugins/ConnectorsTab";
import BrowseAllDialog from "@/components/plugins/BrowseAllDialog";
import McpServersDialog from "@/components/plugins/McpServersDialog";
import SkillsTab from "@/components/plugins/SkillsTab";
import { useConnectorRegistry, beginConnectorConnect } from "@/components/plugins/ConnectorRegistry";
// ConnectorIcon intentionally not used here: the header dropdown has the two Base44 entries.

// Plugins — the Superagent surface's Plugins page. DOCUMENTED Base44: "Use Plugins to connect
// your Superagent to services and add skills it can run" — a Connectors tab and a Skills tab,
// an "+ Add Connector" dropdown in the header, a blue connector banner with a Most popular
// catalog (from the selected app's own connector registry) and the Apps connected section.
// Every action reuses an EXISTING certified contract — delegatedOAuth for connections,
// workspaceSkills for skills. No new backend surface.
export default function Plugins() {
  const { workspace } = useWorkspace();
  const [tab, setTab] = useState("connectors");
  const TABS = [
    { key: "connectors", label: "Connectors" },
    { key: "skills", label: "Skills" },
  ];

  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const registry = useConnectorRegistry(projectId);
  const [connecting, setConnecting] = useState(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50 })
      .then((d) => {
        const rows = d.projects || [];
        setProjects(rows);
        if (rows?.[0]?.id) setProjectId((v) => v || rows[0].id);
      })
      .catch(() => setProjects([]));
  }, [workspace]);

  // The real existing connection flow: delegatedOAuth begin → the provider's consent screen →
  // the existing /oauth/callback return; the certified contract persists the connection.
  const connect = async (name) => {
    if (!projectId || !name) return false;
    const res = await beginConnectorConnect(projectId, name);
    if (!res) toast({ variant: "destructive", title: "No authorization URL returned" });
    return res;
  };

  const connectFromMenu = async (name) => {
    if (!projectId) return;
    setConnecting(name);
    try {
      const ok = await connect(name);
      if (!ok) return;
    } catch (e) {
      toast({ variant: "destructive", title: "Connect failed", description: e.response?.data?.error || e.message });
    } finally { setConnecting(null); }
  };

  return (
    <div className="min-h-full">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center gap-2 mb-1">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-[15px] font-semibold tracking-tight">Plugins</h1>
          <div className="ml-auto">
            {/* "+ Add Connector" dropdown — Base44 parity: Add Connector (Browse all) or an MCP server. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={!projectId}
                  className="flex items-center gap-1.5 rounded-md bg-foreground text-background px-2.5 py-1.5 text-[11.5px] font-semibold hover:opacity-90 disabled:opacity-30 transition-opacity"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Connector
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setBrowseOpen(true)}>Add Connector</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setMcpOpen(true)}>Add an MCP server</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p className="text-[12px] text-muted-foreground mb-4">
          Use Plugins to connect your Superagent to services and add skills it can run.
        </p>
        <div className="flex items-center rounded-lg bg-muted p-0.5 w-fit mb-4">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${tab === t.key ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "connectors" ? (
          <ConnectorsTab
            projects={projects}
            projectId={projectId}
            onSelectProject={setProjectId}
            registry={registry}
            onConnect={connect}
            onBrowseAll={() => setBrowseOpen(true)}
          />
        ) : workspace ? (
          <SkillsTab workspace={workspace} />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>
      {projectId && (
        <BrowseAllDialog open={browseOpen} onOpenChange={setBrowseOpen} connectors={registry || []} connecting={connecting} onConnect={connectFromMenu} />
      )}
      {workspace && <McpServersDialog open={mcpOpen} onOpenChange={setMcpOpen} workspace={workspace} />}
    </div>
  );
}