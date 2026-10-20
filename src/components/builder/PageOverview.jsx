import React from "react";
import { X, FileCode2, AlertTriangle } from "lucide-react";
import PageThumbnail from "./PageThumbnail";

// Large, Figma-style overview of every page in the application. Pages and routes come from
// the project's own files (see pageRoutes.js); selecting one loads it in the Builder preview.
export default function PageOverview({ pages, srcdoc, bundleError, onSelect, onOpenFile, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-border">
        <span className="text-[13px] font-semibold tracking-tight">Pages</span>
        <span className="text-[11.5px] text-muted-foreground">{pages.length} page{pages.length === 1 ? "" : "s"} in this application</span>
        <button onClick={onClose} className="ml-auto grid place-items-center h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" aria-label="Close page overview">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-6">
        {pages.length === 0 ? (
          <div className="mx-auto max-w-md text-center pt-16">
            <FileCode2 className="h-6 w-6 mx-auto text-muted-foreground" />
            <p className="mt-3 text-[13px] font-medium">No pages yet</p>
            <p className="mt-1 text-[12px] text-muted-foreground">Ask the assistant to add a page and it will appear here.</p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {pages.map((p) => (
              <div key={p.file} className="group rounded-xl border border-border bg-card overflow-hidden shadow-sm hover:border-foreground/25 transition-colors">
                <button
                  onClick={() => p.route && onSelect(p.route)}
                  disabled={!p.route}
                  className="block w-full text-left disabled:cursor-default"
                  aria-label={`Open ${p.name} in the preview`}
                >
                  <PageThumbnail srcdoc={srcdoc} route={p.route} bundleError={bundleError} />
                </button>
                <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium truncate">{p.name}</p>
                    <p className="font-mono text-[10.5px] text-muted-foreground truncate">{p.route || "no route found in source"}</p>
                  </div>
                  <button onClick={() => onOpenFile(p.file)} className="ml-auto shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                    Edit
                  </button>
                </div>
                {!p.route && (
                  <p className="flex items-center gap-1.5 px-3 pb-2 text-[10.5px] text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />Not routed in the app yet
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}