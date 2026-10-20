import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Schema view for one table: the entity's DECLARED fields (name, type, required, enum),
// exactly as stored on the AppEntity record — no invented schema.
export default function SchemaDialog({ open, entityName, fields, derived = false, onClose }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{entityName} schema</DialogTitle>
        </DialogHeader>
        {derived ? (
          <p className="text-[12px] text-muted-foreground">
            This table has no declared fields in the owning app — the columns below were read from its records.
          </p>
        ) : null}
        <div className="max-h-[55vh] overflow-y-auto scrollbar-thin rounded-md border border-border divide-y divide-border">
          {(fields || []).map(([name, f]) => (
            <div key={name} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{f.type || "string"}</span>
              {f.required && <span className="shrink-0 rounded bg-brand-muted px-1.5 py-0.5 text-[10px] font-medium text-brand">required</span>}
              {(f.enum || []).length > 0 && (
                <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-muted-foreground">{f.enum.join(" · ")}</span>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}