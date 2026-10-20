import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Clock, ChevronRight, FileCode } from "lucide-react";

// Recents: a collapsible section over the workspace's REAL projects (newest updated first) plus a
// "View all" action. With no projects the section keeps its structure and states the empty case.
export default function RecentsSection({ recents, collapsed, onNavigate }) {
  const [open, setOpen] = useState(false);

  if (collapsed) {
    return (
      <Link to="/projects?sort=recent" title="Recents" onClick={onNavigate} className="flex justify-center rounded-md px-2.5 py-[7px] text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground transition-colors">
        <Clock className="h-[15px] w-[15px]" />
      </Link>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground transition-colors"
      >
        <Clock className="h-[15px] w-[15px] shrink-0 text-sidebar-foreground/50" />
        <span className="flex-1 text-left truncate">Recents</span>
        <ChevronRight className={`h-3 w-3 shrink-0 text-sidebar-foreground/40 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {recents.length === 0 ? (
            <p className="px-2.5 py-1 text-[11px] text-sidebar-foreground/40">No apps yet.</p>
          ) : (
            recents.slice(0, 5).map((p) => (
              <Link
                key={p.id}
                to={`/projects/${p.id}`}
                onClick={onNavigate}
                title={p.name}
                className="flex items-center gap-2 rounded-md pl-[26px] pr-2.5 py-[6px] text-[12.5px] text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground transition-colors"
              >
                <FileCode className="h-[13px] w-[13px] shrink-0 text-sidebar-foreground/40" />
                <span className="truncate">{p.name}</span>
              </Link>
            ))
          )}
          <Link
            to="/projects?sort=recent"
            onClick={onNavigate}
            className="block rounded-md pl-[26px] pr-2.5 py-[6px] text-[12px] text-sidebar-foreground/45 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent/60 transition-colors"
          >
            View all
          </Link>
        </div>
      )}
    </div>
  );
}