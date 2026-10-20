import React, { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { base44 } from "@/api/base44Client";

const call = (projectId, payload) => base44.functions.invoke("entityTrash", { project_id: projectId, ...payload }).then((r) => r.data);

// Compact trash panel for one entity: list (paginated by the control plane), restore one,
// restore all, and permanent delete — the audited trash contract, nothing more.
export default function DataTrashPanel({ projectId, entity, open, onChanged, refreshSignal }) {
  const [rows, setRows] = useState(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!open || !entity) return;
    setError(null);
    try { setRows(await call(projectId, { action: "list", entity_name: entity.name })); }
    catch (e) { setError(String(e?.message || e)); setRows([]); }
  }, [open, entity?.name, projectId]);

  useEffect(() => { load(); }, [load, refreshSignal]);

  if (!open || !entity) return null;

  const act = async (payload) => {
    setWorking(true); setError(null);
    try { await call(projectId, payload); await load(); onChanged?.(); }
    catch (e) { setError(String(e?.message || e)); }
    finally { setWorking(false); }
  };

  const firstField = Object.keys(entity.fields || {})[0];

  return (
    <div className="border-t border-border bg-muted/30">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <p className="text-[11px] font-medium text-muted-foreground">Trash — {entity.name}</p>
        <span className="text-[11px] text-muted-foreground/60">{rows ? `${rows.length} deleted` : ""}</span>
        <button
          onClick={() => act({ action: "restore_many", entity_name: entity.name, query: {} })}
          disabled={working || !rows?.length}
          className="ml-auto inline-flex items-center gap-1 rounded border border-input bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-accent transition-colors disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" />Restore all
        </button>
      </div>
      {error && <p className="px-3 pb-1 text-[11px] text-destructive">{error}</p>}
      <div className="max-h-40 overflow-auto px-3 pb-2">
        {!rows ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" /> : rows.length === 0 ? (
          <p className="py-2 text-[11px] text-muted-foreground/60">Trash is empty.</p>
        ) : (
          <table className="w-full text-[11px]">
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-t border-border/40">
                <td className="max-w-[140px] truncate px-1 py-1 font-mono text-muted-foreground">{r.id}</td>
                <td className="max-w-[200px] truncate px-1 py-1">{firstField && r[firstField] != null ? String(r[firstField]) : ""}</td>
                <td className="whitespace-nowrap px-1 py-1 text-muted-foreground/60">{r.deleted_date ? new Date(r.deleted_date).toLocaleString() : ""}</td>
                <td className="whitespace-nowrap px-1 py-1 text-right">
                  <button onClick={() => act({ action: "restore", entity_name: entity.name, record_id: r.id })} disabled={working} title="Restore" className="text-muted-foreground/50 hover:text-foreground transition-colors disabled:opacity-50">
                    <RotateCcw className="h-3 w-3" />
                  </button>
                  <button onClick={() => act({ action: "permanent", entity_name: entity.name, record_id: r.id })} disabled={working} title="Delete permanently" className="ml-2 text-muted-foreground/50 hover:text-destructive transition-colors disabled:opacity-50">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}