import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, X, Asterisk } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import useSelectedAgent from "@/hooks/useSelectedAgent";
import { useShellData } from "@/hooks/useShellData";
import GeneralSection from "@/components/agentsettings/GeneralSection";
import CreditUsageSection from "@/components/agentsettings/CreditUsageSection";
import PersonalizationSection from "@/components/agentsettings/PersonalizationSection";
import ChannelsSection from "@/components/agentsettings/ChannelsSection";
import SecuritySection from "@/components/agentsettings/SecuritySection";
import DeveloperSection from "@/components/agentsettings/DeveloperSection";

// AGENT SETTINGS — 1:1 Base44 Superagent settings: a two-pane surface with the agent nav on the
// left and one section open on the right. Same certified contracts as before, new presentation:
// editing → agentEditor save (project agents only), channels → projectSecrets state, credits →
// commerce billing_overview, memory → the certified memory backend.
const NAV = [
  { key: "general", label: "General" },
  { key: "credits", label: "Credit usage" },
  { key: "personalization", label: "Personalization" },
  { key: "channels", label: "Channels", badge: "New" },
  { key: "security", label: "Security" },
  { key: "developer", label: "Developer" },
];

export default function AgentSettings() {
  const { agentName, agent, error } = useSelectedAgent();
  const { workspace } = useWorkspace();
  const { credits } = useShellData();
  const navigate = useNavigate();
  const isRoot = !agent?.project_id;
  const [section, setSection] = useState("general");
  const [minH, setMinH] = useState(0);
  const contentRef = React.useRef(null);
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState(null);
  const [workspaceApps, setWorkspaceApps] = useState([]);
  const [saving, setSaving] = useState(false);

  // Keep the window at the General tab's height: measured once, then applied as a min-height
  // so switching tabs never resizes the window.
  React.useEffect(() => {
    if (section === "general" && contentRef.current && minH === 0) {
      const id = requestAnimationFrame(() => setMinH(contentRef.current?.scrollHeight || 0));
      return () => cancelAnimationFrame(id);
    }
  }, [section, agent, minH]);

  // Project agents need the project row (slug for channels) and its files for the editor gate —
  // the same reads the Builder's Agents pane does.
  useEffect(() => {
    setProject(null); setFiles(null);
    if (!agent?.project_id) return;
    let alive = true;
    (async () => {
      const read = await base44.functions.invoke("builderProjectRead", { project_id: agent.project_id }).then((r) => r.data).catch(() => null);
      const p = read?.project || null;
      const fs = read?.files || [];
      if (!alive) return;
      setProject(p);
      setFiles((fs || []).filter((f) => f.content != null).map((f) => ({ path: f.path, content: f.content })));
    })();
    return () => { alive = false; };
  }, [agent?.project_id]);

  // Other apps of this workspace — the cross-app data access select's grant targets.
  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "name", limit: 200 })
      .then((d) => setWorkspaceApps((d.projects || []).filter((p) => p.id !== agent?.project_id)))
      .catch(() => setWorkspaceApps([]));
  }, [workspace, agent?.project_id]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive">{error}</div>
      </div>
    );
  }
  if (!agent) {
    return <div className="h-full grid place-items-center text-muted-foreground/60"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  const canEdit = !isRoot && files !== null && (files.some((f) => f.path === agent.path));
  const displayName = agent.display_name || agent.name;

  // Certified agentEditor save — only EDITOR_MANAGED_KEYS pass through the patch.
  const saveAgent = async (patch) => {
    if (!canEdit) return;
    setSaving(true);
    try {
      await base44.functions.invoke("agentEditor", { action: "save", project_id: agent.project_id, agent: patch });
      toast({ title: "Settings saved" });
      window.location.reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not save", description: e?.response?.data?.error || e?.message });
    } finally { setSaving(false); }
  };

  const title = NAV.find((n) => n.key === section)?.label || "General";

  // Base44-style: settings open as a compact centered window over a dimmed page.
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 backdrop-blur-[2px]"
      onClick={() => navigate("/agent")}
    >
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex max-h-[85vh] w-[760px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
    >
      {/* Left: the Superagent settings nav */}
      <div className="flex h-full w-[250px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-brand-foreground">
            <Asterisk className="h-5 w-5" />
          </span>
          <span className="text-[12.5px] font-semibold">{displayName}</span>
        </div>
        <nav className="flex flex-col gap-0.5 px-3">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-[12.5px] transition-colors ${
                section === item.key ? "bg-muted font-medium" : "hover:bg-muted/60"
              }`}
            >
              <span>{item.label}</span>
              {item.badge && <span className="rounded bg-brand px-1.5 py-0.5 text-[12.5px] font-semibold text-brand-foreground">{item.badge}</span>}
            </button>
          ))}
        </nav>
      </div>

      {/* Right: the open section */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-6 py-3.5">
          <h1 className="text-[12.5px] font-semibold tracking-tight">{title}</h1>
          <button onClick={() => navigate("/agent")} className="text-muted-foreground hover:text-foreground" aria-label="Close settings">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div ref={contentRef} className="flex-1 overflow-y-auto px-8 py-5" style={minH ? { minHeight: `${minH}px` } : undefined}>
          {section === "general" && (
            <GeneralSection agent={agent} isRoot={isRoot} canEdit={canEdit} saving={saving} onSave={saveAgent} workspaceApps={workspaceApps} />
          )}
          {section === "credits" && <CreditUsageSection />}
          {section === "personalization" && (
            <PersonalizationSection agent={agent} isRoot={isRoot} canEdit={canEdit} saving={saving} onSave={saveAgent} />
          )}
          {section === "channels" && <ChannelsSection agent={agent} project={project} />}
          {section === "security" && (
            <SecuritySection agent={agent} isRoot={isRoot} canEdit={canEdit} saving={saving} onSave={saveAgent} />
          )}
          {section === "developer" && <DeveloperSection agent={agent} />}
        </div>
      </div>
    </div>
    </div>
  );
}