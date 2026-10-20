import React from "react";
import { Link } from "react-router-dom";
import { ChevronsUpDown } from "lucide-react";
import { SparklePlus } from "@/components/builder/ModelMarks";

// NexusAI logo + workspace branding — the same mark used in the Builder's logo bar:
// a black rounded-square with the white four-pointed star+plus icon, then "NexusAI"
// with the workspace name below and a chevron. Used in the Home / Agent page headers.
export default function NexusLogo({ workspace, to = "/" }) {
  const wsName = workspace?.name || "Workspace";
  return (
    <Link to={to} className="flex items-center gap-2.5 group" title={wsName}>
      <span className="h-9 w-9 rounded-xl bg-black grid place-items-center shrink-0 ring-1 ring-black/10 group-hover:ring-black/20 transition-shadow">
        <SparklePlus className="h-5 w-5 text-white" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-[15px] font-semibold tracking-tight text-foreground">NexusAI</span>
        <span className="text-[11.5px] text-muted-foreground truncate max-w-[12rem]">{wsName}</span>
      </span>
      <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
    </Link>
  );
}