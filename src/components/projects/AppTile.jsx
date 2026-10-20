import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { Rocket, Hammer, ChevronRight, MoreVertical, Pencil, Copy, Trash2 } from "lucide-react";
import RenameDialog from "@/components/projects/RenameDialog";
import DeleteAppDialog from "@/components/projects/DeleteAppDialog";
import CloneDialog from "@/components/projects/CloneDialog";

// An application object, not a database row: a miniature app window sits above the
// metadata so the project itself reads as the primary thing on the page.
function MiniApp({ name }) {
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <div className="relative h-32 overflow-hidden rounded-t-xl border-b border-border bg-muted/40">
      <div className="absolute inset-x-0 top-0 h-5 flex items-center gap-1 px-2 bg-background/80 border-b border-border">
        <span className="h-1.5 w-1.5 rounded-full bg-border" />
        <span className="h-1.5 w-1.5 rounded-full bg-border" />
        <span className="h-1.5 w-1.5 rounded-full bg-border" />
      </div>
      <div className="absolute inset-x-0 top-5 bottom-0 flex">
        <div className="w-8 border-r border-border/60 bg-background/50 py-2 space-y-1.5 px-1.5">
          <div className="h-1 rounded bg-border" />
          <div className="h-1 rounded bg-border/70" />
          <div className="h-1 rounded bg-border/70" />
        </div>
        <div className="flex-1 p-2.5 space-y-2">
          <div className="flex items-center gap-1.5">
            <span className="grid place-items-center h-5 w-5 rounded bg-foreground text-background text-[9px] font-bold">{initial}</span>
            <div className="h-1.5 w-16 rounded bg-border" />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <div className="h-6 rounded bg-background border border-border/70" />
            <div className="h-6 rounded bg-background border border-border/70" />
            <div className="h-6 rounded bg-background border border-border/70" />
          </div>
          <div className="h-10 rounded bg-background border border-border/70" />
        </div>
      </div>
    </div>
  );
}

// More-actions menu (⋯) for an app tile. Rename opens the compact dialog; the menu itself
// stops propagation so it never triggers the tile's navigation link.
function MoreMenu({ project, onRenamed, onCloned, onDeleted }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        aria-label="More actions"
        title="More actions"
        className="grid place-items-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full mt-1.5 z-40 w-48 rounded-lg border border-border bg-popover p-1 shadow-md"
        >
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); setRenaming(true); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-muted transition-colors"
          >
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />Rename
          </button>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); setCloning(true); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-muted transition-colors"
          >
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />Clone app
          </button>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); setDeleting(true); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] text-destructive hover:bg-muted transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />Delete app
          </button>
        </div>
      )}
      <DeleteAppDialog open={deleting} onOpenChange={setDeleting} project={project} onDeleted={onDeleted} />
      <RenameDialog open={renaming} onOpenChange={setRenaming} project={project} onRenamed={onRenamed} />
      <CloneDialog open={cloning} onOpenChange={setCloning} project={project} onCloned={onCloned} />
    </div>
  );
}

export default function AppTile({ project, layout = "grid", onRenamed, onCloned, onDeleted }) {
  const build = project.last_build_status;
  const deployed = project.production_deployment_id != null;
  const edited = project.updated_date ? formatDistanceToNow(new Date(project.updated_date), { addSuffix: true }) : "—";

  if (layout === "list") {
    return (
      <div className="group flex items-center gap-3 border-b border-border last:border-b-0 px-4 py-3 hover:bg-muted/40 transition-colors">
        <Link to={`/projects/${project.id}`} className="flex items-center gap-3 flex-1 min-w-0">
          <span className="grid place-items-center h-8 w-8 rounded-lg bg-foreground text-background text-[12px] font-semibold shrink-0">
            {(project.name || "?").charAt(0).toUpperCase()}
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-[13.5px] truncate">{project.name}</div>
            <div className="text-[12px] text-muted-foreground truncate">{project.description || "No description"}</div>
          </div>
          <div className="hidden sm:flex items-center gap-4 text-[11px] text-muted-foreground">
            {deployed && <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Rocket className="h-3 w-3" />Live</span>}
            <span className={build === "failed" ? "text-destructive" : ""}>{build === "success" ? "Build passing" : build === "failed" ? "Build failing" : "Not built"}</span>
            <span className="font-mono">v{project.version_count || 0}</span>
            <span className="w-24 text-right">{edited}</span>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-foreground transition-colors shrink-0" />
        </Link>
        <MoreMenu project={project} onRenamed={onRenamed} onCloned={onCloned} onDeleted={onDeleted} />
      </div>
    );
  }

  return (
    <div className="group relative block rounded-xl border border-border bg-card shadow-sm overflow-hidden hover:border-foreground/25 hover:shadow-md transition-all">
      <Link to={`/projects/${project.id}`} className="block">
        <MiniApp name={project.name} />
        <div className="p-3.5">
          <div className="flex items-start gap-2">
            <h3 className="flex-1 min-w-0 font-semibold text-[14px] truncate">{project.name}</h3>
            {deployed && (
              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Live
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground line-clamp-1">{project.description || "No description"}</p>
          <div className="mt-3 flex items-center gap-2.5 text-[11px] text-muted-foreground">
            <span className={`flex items-center gap-1 ${build === "failed" ? "text-destructive" : build === "success" ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
              <Hammer className="h-3 w-3" />{build === "success" ? "Passing" : build === "failed" ? "Failing" : "Not built"}
            </span>
            <span className="text-border">·</span>
            <span className="font-mono">v{project.version_count || 0}</span>
            <span className="ml-auto truncate">{edited}</span>
          </div>
        </div>
      </Link>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <MoreMenu project={project} onRenamed={onRenamed} onCloned={onCloned} onDeleted={onDeleted} />
      </div>
    </div>
  );
}