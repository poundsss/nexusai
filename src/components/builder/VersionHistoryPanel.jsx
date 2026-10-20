import React from "react";
import { ArrowLeft, MoreHorizontal, RotateCcw, Upload, Loader2, GitCompare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// Version History shown in place of the builder chat panel — one card per version, newest first.
export default function VersionHistoryPanel({ versions, onBack, onRestore, onPublish, onCompare, restoring, publishing }) {
  const latestId = versions[0]?.id;
  return (
    <div className="h-full flex flex-col bg-background">
      <div className="shrink-0 flex items-center gap-2 px-3 h-12">
        <button onClick={onBack} aria-label="Back to chat" title="Back to chat" className="grid place-items-center h-7 w-7 rounded-md text-foreground hover:bg-muted transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-[14px] font-semibold tracking-tight">Version History</h2>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-3 space-y-1.5">
        {versions.length === 0 && <p className="px-2 py-4 text-[12px] text-muted-foreground">No versions yet.</p>}
        {versions.map((v) => {
          const current = v.id === latestId;
          const busy = restoring === v.id || publishing === v.id;
          return (
            <div key={v.id} className={`rounded-lg border px-3 py-2.5 transition-colors ${current ? "border-brand/50 bg-brand-muted" : "border-border bg-card hover:bg-muted/40"}`}>
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-[12.5px] font-medium text-foreground" title={v.message}>{v.message || `Version ${v.number}`}</span>
                {current && <span className="shrink-0 rounded-md border border-brand/30 bg-background/60 px-1.5 py-0.5 text-[10.5px] font-medium text-brand">Current</span>}
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" /> : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button aria-label="Version options" className="grid place-items-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted shrink-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      {!current && <DropdownMenuItem disabled={!!restoring || !!publishing} onClick={() => onRestore(v)}><RotateCcw className="h-3.5 w-3.5 mr-2" />Restore this version</DropdownMenuItem>}
                      {!current && <DropdownMenuItem disabled={!!restoring || !!publishing} onClick={() => onPublish(v)}><Upload className="h-3.5 w-3.5 mr-2" />Publish this version</DropdownMenuItem>}
                      <DropdownMenuItem onClick={onCompare}><GitCompare className="h-3.5 w-3.5 mr-2" />Compare changes</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">v{v.number} · {formatDistanceToNow(new Date(v.created_date), { addSuffix: true })}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}