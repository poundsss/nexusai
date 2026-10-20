import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MoreHorizontal, ExternalLink, Star, Share2, Pencil, Copy, Hash, Settings, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import RenameDialog from "@/components/projects/RenameDialog";
import CloneDialog from "@/components/projects/CloneDialog";
import DeleteAppDialog from "@/components/projects/DeleteAppDialog";

// Base44-style ⋯ menu for a project row in the sidebar.
export default function ProjectRowMenu({ project, favorite, onToggleFavorite, onChanged, onDeleted }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [dialog, setDialog] = useState(null);
  const liveUrl = project.slug && project.production_deployment_id ? `${window.location.origin}/app/${project.slug}` : null;
  const copy = async (text, title) => { await navigator.clipboard.writeText(text); toast({ title }); };
  const item = "gap-2.5 text-[13px]";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Project actions" onClick={(e) => e.stopPropagation()}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-sidebar-foreground/50 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuItem className={item} disabled={!liveUrl} onSelect={() => window.open(liveUrl, "_blank", "noopener")}><ExternalLink className="h-4 w-4" />View live app</DropdownMenuItem>
          <DropdownMenuItem className={item} onSelect={onToggleFavorite}><Star className={`h-4 w-4 ${favorite ? "fill-current" : ""}`} />{favorite ? "Remove from favorites" : "Add to favorites"}</DropdownMenuItem>
          <DropdownMenuItem className={item} disabled={!liveUrl} onSelect={() => copy(liveUrl, "Link copied")}><Share2 className="h-4 w-4" />Share</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={item} onSelect={() => setDialog("rename")}><Pencil className="h-4 w-4" />Rename</DropdownMenuItem>
          <DropdownMenuItem className={item} onSelect={() => setDialog("clone")}><Copy className="h-4 w-4" />Clone app</DropdownMenuItem>
          <DropdownMenuItem className={item} onSelect={() => copy(project.id, "App ID copied")}><Hash className="h-4 w-4" />Copy app ID</DropdownMenuItem>
          <DropdownMenuItem className={item} onSelect={() => navigate(`/projects/${project.id}?view=settings`)}><Settings className="h-4 w-4" />Go to App Settings</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={`${item} text-destructive focus:text-destructive`} onSelect={() => setDialog("delete")}><Trash2 className="h-4 w-4" />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog open={dialog === "rename"} onOpenChange={(o) => !o && setDialog(null)} project={project} onRenamed={onChanged} />
      <CloneDialog open={dialog === "clone"} onOpenChange={(o) => !o && setDialog(null)} project={project} onCloned={(d) => { onChanged?.(); if (d?.project?.id) navigate(`/projects/${d.project.id}`); }} />
      <DeleteAppDialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)} project={project} onDeleted={onDeleted} />
    </>
  );
}