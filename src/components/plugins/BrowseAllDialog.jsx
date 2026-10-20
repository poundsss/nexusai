import React from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import ConnectorIcon from "./ConnectorIcon";

// "Browse all →" — the FULL registry (every connector the selected app declares), 2-column
// cards, same real connect flow as the Most popular cards.
export default function BrowseAllDialog({ open, onOpenChange, connectors, connecting, onConnect }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>All connectors</DialogTitle>
          <DialogDescription>Every connector declared in the selected app's registry.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2.5 sm:grid-cols-2 max-h-[60vh] overflow-y-auto scrollbar-thin">
          {(connectors || []).map((c) => (
            <div key={c.name} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <ConnectorIcon name={c.name} className="h-8 w-8" />
                <span className="text-[12.5px] font-medium truncate">{c.label}</span>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground line-clamp-2 min-h-[2.4em]">{c.description}</p>
              <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => onConnect(c.name)} disabled={connecting === c.name}>
                {connecting === c.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
              </Button>
            </div>
          ))}
          {connectors && connectors.length === 0 && (
            <p className="text-[12px] text-muted-foreground col-span-2 py-6 text-center">
              No connectors declared yet.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}