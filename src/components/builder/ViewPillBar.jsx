import React from "react";
import { Eye, LayoutDashboard, Code, MousePointerClick, LayoutGrid } from "lucide-react";

// bolt.new-style view switcher: the active item expands to icon + full label in a dark pill;
// the rest collapse to icon-only. The label animates (max-width + opacity + margin) so the
// pill grows/shrinks smoothly instead of snapping. Pages stays a standalone icon.
export default function ViewPillBar({ view, onView, onEdit, picker, onTogglePicker, onOpenPages }) {
  const items = [
    { id: "preview", label: "Preview", icon: Eye, onClick: () => onView("preview"), active: view === "preview" },
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, onClick: () => onView("dashboard"), active: view === "dashboard" },
    { id: "code", label: "Code", icon: Code, onClick: onEdit, active: view === "code" },
    { id: "edit", label: "Edit", icon: MousePointerClick, onClick: onTogglePicker, active: !!picker },
  ];

  return (
    <div className="hidden md:flex items-center gap-1 shrink-0">
      <div className="flex items-center gap-0.5 rounded-full border border-border bg-muted/60 p-0.5">
        {items.map((it) => {
          const Icon = it.icon;
          const active = it.active;
          return (
            <button
              key={it.id}
              onClick={it.onClick}
              aria-label={it.label}
              title={it.label}
              className={`flex items-center h-6 rounded-full px-2 text-[12px] font-medium transition-colors [transition-duration:500ms] ease-in-out ${
                active
                  ? "bg-blue-500 text-white shadow-sm shadow-blue-500/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span
                className={`overflow-hidden whitespace-nowrap font-medium transition-all [transition-duration:500ms] ease-in-out ${
                  active ? "max-w-[80px] opacity-100 ml-1.5" : "max-w-0 opacity-0 ml-0"
                }`}
              >
                {it.label}
              </span>
            </button>
          );
        })}
      </div>
      {/* Page overview — standalone icon (opens the pages overlay) */}
      <button
        onClick={onOpenPages}
        aria-label="Pages"
        title="Page overview"
        className="grid place-items-center h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <LayoutGrid className="h-4 w-4" />
      </button>
    </div>
  );
}