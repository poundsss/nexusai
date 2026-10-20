import React, { useState } from "react";
import { FolderOpen, Plus, ChevronDown, Check } from "lucide-react";
import NewProjectDialog from "@/components/projects/NewProjectDialog";

// The `Choose project` strip, attached to the TOP of the chat composer card (one card, like the
// reference): a tinted header band holding the project select plus the `+` create action.
// Clicking the chevron extends a project list UPWARD above the composer; with no projects
// there is nothing to extend, so the list never opens.
export default function GrowProjectBar({ projects, projectId, onChange, onCreate }) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const selected = projects.find((p) => p.id === projectId) || null;
  const canOpen = projects.length > 0;

  return (
    <div className="grow-project-tab relative w-full md:w-1/2 rounded-t-3xl bg-card">
      <div className="flex h-9 items-center gap-2 rounded-t-[inherit] px-3">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={() => canOpen && setOpen((v) => !v)}
          aria-label="Choose project"
          aria-expanded={open}
          className="min-w-0 flex-1 flex items-center justify-between gap-2 text-left outline-none"
        >
          <span className={`min-w-0 truncate text-[12.5px] font-medium ${selected ? "text-foreground" : "text-muted-foreground"}`}>
            {selected ? selected.name : canOpen ? "Select a project to continue" : "Choose project…"}
          </span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""} ${canOpen ? "" : "opacity-40"}`} />
        </button>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          title="Create project"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Project list — extends upward over the chat; only when at least one project exists. */}
      {open && canOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="relative z-20 max-h-48 overflow-y-auto scrollbar-thin">
            <p className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Projects</p>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { onChange(p.id); setOpen(false); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-border/40 ${p.id === projectId ? "text-foreground" : "text-muted-foreground"}`}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                {p.id === projectId && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
              </button>
            ))}
          </div>
        </>
      )}

      <NewProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (data) => { await onCreate(data); setCreateOpen(false); }}
      />
    </div>
  );
}