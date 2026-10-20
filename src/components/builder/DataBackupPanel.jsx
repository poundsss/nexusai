import React from "react";
import { History, Loader2, RotateCcw, Download, Undo2 } from "lucide-react";
import useDataHistory from "@/hooks/useDataHistory";

// Backup & Restore for one entity: automatic CRUD checkpoints, CSV download, point-in-time
// restore with live progress, and undo. The edit pause is enforced server-side; this panel
// only displays the state the certified surface returns.
export default function DataBackupPanel({ projectId, entity, open }) {
  const active = open && !!entity;
  const { info, checkpoints, nextCursor, loading, working, error, batch, restore, undo, download, more } =
    useDataHistory(projectId, active ? entity.name : null);
  if (!active) return null;
  const ops = batch?.operations || [];
  const runningBatch = ops.some((o) => !["succeeded", "failed"].includes(o.status));

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-3">
      <div className="flex items-center gap-1.5">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-semibold">Backup &amp; Restore</span>
        {info && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
            {info.state === "enabled" ? `${info.retention_days}-day history` : "needs a plan with backups"}
          </span>
        )}
      </div>
      {loading ? (
        <div className="mt-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
      ) : (
        <>
          {error && <p className="mt-2 text-[11.5px] text-destructive">{error}</p>}
          {batch && (
            <div className="mt-2 rounded-md border border-border bg-background px-2.5 py-2 text-[11.5px]">
              <div className="flex items-center gap-2">
                <span className="font-medium">{runningBatch ? "Restoring…" : "Last restore"}</span>
                {batch.restore_to && <span className="text-muted-foreground">to {new Date(batch.restore_to).toLocaleString()}</span>}
                {batch.undo_checkpoint_id && !runningBatch && (
                  <button
                    onClick={undo}
                    disabled={working}
                    className="ml-auto inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    <Undo2 className="h-3 w-3" />Undo restore
                  </button>
                )}
              </div>
              {ops.map((o) => (
                <div key={o.operation_id} className="mt-1 flex items-center gap-2 text-muted-foreground">
                  <span className="font-mono">{o.entity_name}</span>
                  <span>{o.status}</span>
                  {o.status === "succeeded" && (
                    <span>{o.counts?.reverted ?? 0} reverted · {o.counts?.reinserted ?? 0} brought back · {o.counts?.deleted ?? 0} to trash</span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 space-y-1.5">
            {checkpoints.length === 0 && (
              <p className="text-[11.5px] text-muted-foreground/60">No checkpoints yet — they are captured automatically as {entity.name} changes.</p>
            )}
            {checkpoints.map((c) => (
              <div key={c.checkpoint_id} className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-[11.5px]">
                <span className="text-muted-foreground">{new Date(c.data_as_of).toLocaleString()}</span>
                <span className="text-muted-foreground/60">{c.trigger_type === "crud" ? "auto" : c.trigger_type}</span>
                <button
                  onClick={() => restore(c.checkpoint_id)}
                  disabled={working || runningBatch}
                  className="ml-auto inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <RotateCcw className="h-3 w-3" />Restore
                </button>
                <button
                  onClick={() => download(c)}
                  disabled={working}
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <Download className="h-3 w-3" />CSV
                </button>
              </div>
            ))}
            {nextCursor && (
              <button onClick={more} disabled={working} className="text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors disabled:opacity-50">
                Load earlier checkpoints
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}