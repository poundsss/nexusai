import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import ScheduledWorkflows from "@/components/builder/ScheduledWorkflows";
import WorkflowTemplateGallery from "@/components/workflows/WorkflowTemplateGallery";

// Workflows page — the workspace-level view over the TWO EXISTING certified workflow surfaces.
// Scheduled → the certified AgentSchedule UI (ScheduledWorkflows, untouched); Triggered → the
// certified WorkflowDefinition surface (workflows endpoint + WorkflowCard). Both are
// project-scoped, so the page is scoped to one selected project; no new backend surface exists.
export default function Workflows() {
  const { workspace, loading: wsLoading } = useWorkspace();
  const [projects, setProjects] = useState(null);
  const [projectId, setProjectId] = useState("");
  const [agentFiles, setAgentFiles] = useState([]);
  // Per-tab emptiness, reported by the tab's own surface after it loads. An empty surface
  // shows the template gallery instead of the bare "no workflows" message.
  const [empty, setEmpty] = useState({ scheduled: false });
  const markEmpty = (key) => (v) => setEmpty((e) => (e[key] === v ? e : { ...e, [key]: v }));

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 100 })
      .then((d) => { if (!cancelled) setProjects(d.projects || []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [workspace]);

  // Default to the first project; the selector stays user-controlled after that.
  useEffect(() => {
    if (!projectId && projects && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Agent policy files of the selected project — the same records the Builder pane passes to
  // ScheduledWorkflows for its declared-agent dropdown.
  useEffect(() => {
    if (!projectId) { setAgentFiles([]); return; }
    let cancelled = false;
    base44.functions.invoke("builderProjectRead", { project_id: projectId })
      .then((r) => r.data?.files || [])
      .then((files) => { if (!cancelled) setAgentFiles(files.filter((f) => f.path.startsWith("agents/") || f.path.startsWith("base44/agents/"))); })
      .catch(() => { if (!cancelled) setAgentFiles([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  return (
    <div className="min-h-full">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {wsLoading || !projects ? (
          <div className="rounded-md border border-border p-4 text-muted-foreground/60"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
            Workflows live on your apps. <Link to="/" className="underline underline-offset-2 text-foreground">Build one first</Link>.
          </div>
        ) : !projectId ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted-foreground/60">Select a project to see its workflows.</div>
        ) : (
          empty.scheduled ? <WorkflowTemplateGallery /> : <ScheduledWorkflows projectId={projectId} agentFiles={agentFiles} onEmpty={markEmpty("scheduled")} />
        )}
      </div>
    </div>
  );
}