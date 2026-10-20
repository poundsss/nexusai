import React, { useEffect, useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Search, LayoutGrid, List, LayoutTemplate } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { workspaceRead } from "@/lib/workspaceRead";
import { useWorkspace } from "@/hooks/useWorkspace";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import AppTile from "@/components/projects/AppTile";
import NewProjectDialog from "@/components/projects/NewProjectDialog";
import { createProjectWithScaffold } from "@/lib/createProject";

const SORTS = [
  { id: "-updated_date", label: "Last edited" },
  { id: "-created_date", label: "Newest" },
  { id: "name", label: "Name" },
];

// An application gallery. Page chrome comes from the SHARED AccountPage container, so the
// toolbar height, page width and padding are identical to every other product surface.
export default function Projects() {
  const { user, workspace, loading } = useWorkspace();
  const [projects, setProjects] = useState(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState("grid");
  const [sort, setSort] = useState("-updated_date");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort, limit: 100 }).then((d) => setProjects(d.projects || []));
  }, [workspace, sort]);

  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setOpen(true);
      searchParams.delete("new");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const createProject = async ({ name, description }) => {
    const project = await createProjectWithScaffold({ workspace, user, name, description });
    navigate(`/projects/${project.id}${description ? `?prompt=${encodeURIComponent(description)}` : ""}`);
  };

  const filtered = useMemo(() => {
    if (!projects || !query.trim()) return projects;
    const q = query.toLowerCase();
    return projects.filter((p) => p.name?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q));
  }, [projects, query]);

  const live = (projects || []).filter((p) => p.production_deployment_id).length;

  const handleRenamed = (res) => {
    if (!res?.project_id || !projects) return;
    setProjects((prev) => (prev || []).map((p) => (p.id === res.project_id ? { ...p, name: res.name } : p)));
  };

  // Clone returns the new project row. Refresh the gallery so the copy appears, then drop the
  // user into the cloned project via the existing project route.
  const handleCloned = async (data) => {
    const newId = data?.project?.id;
    if (workspace) {
      try {
        const fresh = (await workspaceRead("projects", { workspace_id: workspace.id, sort, limit: 100 })).projects || [];
        setProjects(fresh);
      } catch { /* keep the existing list if the refresh fails; the clone still succeeded */ }
    }
    if (newId) navigate(`/projects/${newId}`);
  };

  const handleDeleted = (id) => setProjects((prev) => (prev || []).filter((p) => p.id !== id));

  const actions = (
    <div className="flex items-center gap-2">
      <div className="relative hidden sm:block w-[200px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 pl-8 text-[12.5px]" />
      </div>
      <select
        value={sort}
        onChange={(e) => setSort(e.target.value)}
        className="hidden md:block h-8 rounded-lg border border-border bg-background px-2 text-[12.5px] cursor-pointer"
      >
        {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <div className="hidden md:flex items-center gap-0.5 rounded-lg bg-muted p-0.5 shrink-0">
        <button onClick={() => setView("grid")} aria-label="Grid view" className={`rounded-md p-1.5 transition-colors ${view === "grid" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
          <LayoutGrid className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => setView("list")} aria-label="List view" className={`rounded-md p-1.5 transition-colors ${view === "list" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
          <List className="h-3.5 w-3.5" />
        </button>
      </div>
      <Button size="sm" onClick={() => setOpen(true)} disabled={!workspace} className="shrink-0">
        <Plus className="h-3.5 w-3.5" /><span className="hidden sm:inline">New app</span>
      </Button>
    </div>
  );

  return (
    <>
      <AccountPage
        title="My applications"
        subtitle={projects ? `${projects.length} total · ${live} live` : undefined}
        actions={actions}
      >
        {loading || !projects ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-56 rounded-xl border border-border bg-muted/30 animate-pulse" />)}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={LayoutTemplate}
            title="Build your first application"
            description="Describe what you want and NexusAI builds it — pages, data model, and a live preview."
            action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New app</Button>}
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} title="No applications found" description={`Nothing matches “${query}”.`} />
        ) : view === "grid" ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((p) => <AppTile key={p.id} project={p} onRenamed={handleRenamed} onCloned={handleCloned} onDeleted={handleDeleted} />)}
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            {filtered.map((p) => <AppTile key={p.id} project={p} layout="list" onRenamed={handleRenamed} onCloned={handleCloned} onDeleted={handleDeleted} />)}
          </div>
        )}
      </AccountPage>

      <NewProjectDialog open={open} onOpenChange={setOpen} onCreate={createProject} />
    </>
  );
}