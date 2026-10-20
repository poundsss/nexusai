import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Star } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import ProjectRowMenu from "./ProjectRowMenu";

const FAV_KEY = "grow:favoriteProjects";
const readFavs = () => { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; } };

// Projects listed under the Grow "Dashboard" item while the dashboard is open.
export default function GrowDashboardProjects({ workspaceId, onNavigate }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const [projects, setProjects] = useState(null);
  const [favs, setFavs] = useState(readFavs);

  const load = useCallback(() => {
    if (!workspaceId) return;
    workspaceRead("projects", { workspace_id: workspaceId, sort: "-created_date", limit: 50 })
      .then((d) => setProjects((d.projects || []).filter((p) => p.status !== "archived")));
  }, [workspaceId]);
  useEffect(() => { load(); }, [load]);

  const toggleFav = (id) => setFavs((cur) => {
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    localStorage.setItem(FAV_KEY, JSON.stringify(next));
    return next;
  });

  if (!projects) return <p className="pl-8 py-1 text-[12px] text-sidebar-foreground/40">Loading…</p>;
  if (!projects.length) return <p className="pl-8 py-1 text-[12px] text-sidebar-foreground/40">No projects yet</p>;

  const current = params.get("project");
  const sorted = [...projects].sort((a, b) => favs.includes(b.id) - favs.includes(a.id));
  return (
    <div className="ml-4 border-l border-sidebar-border pl-2 space-y-0.5">
      {sorted.map((p) => (
        <div key={p.id} className={`group flex items-center rounded-md pr-1 ${p.id === current ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"}`}>
          <Link to={`/growth-agent?dashboard=1&project=${p.id}`} onClick={onNavigate}
            className={`flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-[12.5px] ${p.id === current ? "font-semibold text-sidebar-accent-foreground" : "text-sidebar-foreground/70"}`}>
            <span className="truncate">{p.name}</span>
            {favs.includes(p.id) && <Star className="h-3 w-3 shrink-0 fill-current text-sidebar-foreground/50" />}
          </Link>
          <ProjectRowMenu project={p} favorite={favs.includes(p.id)} onToggleFavorite={() => toggleFav(p.id)}
            onChanged={load} onDeleted={(id) => setProjects((cur) => cur.filter((x) => x.id !== id))} />
        </div>
      ))}
    </div>
  );
}