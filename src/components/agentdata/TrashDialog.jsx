import React, { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// Recently Deleted for one table, through the EXISTING certified Entity Trash contract
// (entityTrash list/restore — the same contract the Builder Data pane uses). Restored
// records keep their original id and fields.
export default function TrashDialog({ open, projectId, entityName, fields, onRestored, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    if (!open || !projectId) return;
    setItems(null);
    setError(null);
    try {
      const res = await base44.functions.invoke("entityTrash", { project_id: projectId, action: "list", entity_name: entityName });
      setItems(res.data || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Could not load the trash");
      setItems([]);
    }
  }, [open, projectId, entityName]);

  useEffect(() => { load(); }, [load]);

  const restore = async (id) => {
    setBusyId(id);
    try {
      await base44.functions.invoke("entityTrash", { project_id: projectId, action: "restore", entity_name: entityName, record_id: id });
      toast({ title: "Record restored" });
      await load();
      onRestored?.();
    } catch (e) {
      toast({ variant: "destructive", title: "Restore failed", description: e.response?.data?.error || e.message });
    } finally { setBusyId(null); }
  };

  const label = (item) => {
    const f = Object.keys(fields || {}).find((k) => typeof item[k] === "string" && item[k]);
    return f ? String(item[f]) : item.id;
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{entityName} — Recently Deleted</DialogTitle>
        </DialogHeader>
        {!items ? (
          <div className="grid place-items-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive">{error}</div>
        ) : items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-[12.5px] text-muted-foreground">
            <Trash2 className="mx-auto mb-1.5 h-4 w-4 text-muted-foreground/50" />
            Nothing deleted yet.
          </div>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto scrollbar-thin rounded-md border border-border divide-y divide-border">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-2.5 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{label(item)}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {item.deleted_date ? new Date(item.deleted_date).toLocaleString() : ""}
                </span>
                <Button variant="outline" size="sm" disabled={busyId === item.id} onClick={() => restore(item.id)}>
                  {busyId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}