import React from "react";
import { Eye } from "lucide-react";

// The center zone of the Builder workspace. The app surface (preview/code) is FULL-BLEED —
// no outer card, no page padding — so the application itself is the dominant surface.
// Management views keep a titled panel with their own way back.
export default function CenterCanvas({ view, onView, title, children }) {
  const isAppView = view === "preview" || view === "code" || view === "dashboard";

  if (isAppView) {
    return <div className="h-full min-h-0 min-w-0 bg-muted/30">{children}</div>;
  }

  return (
    <div className="h-full flex flex-col min-w-0 bg-muted/30">
      <div className="h-11 shrink-0 flex items-center gap-2 px-3.5 border-b border-border bg-background">
        <span className="text-[13px] font-semibold tracking-tight">{title}</span>
        <button onClick={() => onView("preview")} className="ml-auto flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors">
          <Eye className="h-3.5 w-3.5" />Back to preview
        </button>
      </div>
      <div className="flex-1 min-h-0 bg-background">{children}</div>
    </div>
  );
}