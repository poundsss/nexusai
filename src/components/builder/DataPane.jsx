import React, { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Loader2, History, ShieldCheck, MoreHorizontal, Download, Upload, Eraser, Link2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { toast } from "@/components/ui/use-toast";
import { toItem } from "@/lib/runtime/dbBridge";
import { downloadCsv } from "@/lib/csv";
import DataTrashPanel from "@/components/builder/DataTrashPanel";
import DataBackupPanel from "@/components/builder/DataBackupPanel";
import EntityPermissions from "@/components/builder/EntityPermissions";
import RelationsPanel from "@/components/builder/RelationsPanel";

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function DataPane({ projectId, entities, selectedEntity, onSelectEntity, onReload }) {
  const entity = entities.find((e) => e.name === selectedEntity) || entities[0];
  const [rows, setRows] = useState(null);
  const [showTrash, setShowTrash] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showPerms, setShowPerms] = useState(false);
  const [showRelations, setShowRelations] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [menuOpen]);

  const load = useCallback(() => {
    if (!entity) return;
    setRows(null);
    workspaceRead("records", { project_id: projectId, entity_name: entity.name, limit: 200 })
      .then((d) => setRows((d.records || []).map(toItem)))
      .catch(() => setRows([]));
  }, [projectId, entity?.name]);

  useEffect(() => { load(); }, [load]);

  // Delete is recoverable (Entity Trash parity): the record moves to the entity's trash.
  const remove = async (id) => {
    await base44.functions.invoke("entityTrash", { project_id: projectId, action: "delete", entity_name: entity.name, record_id: id });
    setRows((r) => r.filter((x) => x.id !== id));
  };

  // Export CSV: serialize the currently loaded live rows over the entity's declared fields.
  // No new read, no invented columns. Falls back to the union of row keys if the entity has no
  // declared fields, so a schemaless table still exports what is loaded.
  const exportCsv = () => {
    setMenuOpen(false);
    if (!rows || !rows.length) { toast({ title: "Nothing to export", description: `${entity.name} has no records yet.` }); return; }
    let cols = Object.keys(entity.fields || {});
    if (!cols.length) cols = Object.keys(rows[0]);
    downloadCsv(`${entity.name}.csv`, cols, rows);
  };

  // Import CSV: thin builder endpoint that reuses importEntitiesIntoDb (parse + validate +
  // bulkCreate, new rows only, fail-fast). No second parser, no upsert/overwrite.
  const pickCsv = () => { setMenuOpen(false); fileRef.current?.click(); };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const content_base64 = await fileToBase64(file);
      const res = await base44.functions.invoke("appEntityImport", { project_id: projectId, entity_name: entity.name, filename: file.name, content_type: file.type, content_base64 });
      toast({ title: "Import complete", description: `${res.data?.result?.output?.imported ?? res.data?.result?.output?.length ?? 0} row(s) added to ${entity.name}` });
      load();
    } catch (err) {
      toast({ variant: "destructive", title: "Import failed", description: err.response?.data?.error || err.message });
    } finally { setBusy(false); }
  };

  // Clear table: reuse the existing authorized delete primitive, scoped to this project + entity.
  const clearTable = async () => {
    setMenuOpen(false);
    if (!rows || !rows.length) { toast({ title: "Nothing to clear", description: `${entity.name} has no records.` }); return; }
    if (!window.confirm(`Clear all ${rows.length} ${entity.name} record(s)? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await workspaceRead("clear_records", { project_id: projectId, entity_name: entity.name });
      toast({ title: "Table cleared", description: `${entity.name} records removed.` });
      load();
      onReload?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Clear failed", description: err.response?.data?.error || err.message });
    } finally { setBusy(false); }
  };

  if (!entity) return <div className="h-full flex items-center justify-center text-[13px] text-muted-foreground/60">No entities yet. Ask the assistant to add data to your app.</div>;
  const fields = Object.entries(entity.fields || {});
  return (
    <div className="h-full flex flex-col bg-background">
      <div className="h-9 shrink-0 flex items-center gap-1 px-3 border-b border-border overflow-x-auto">
        {entities.map((e) => <button key={e.id} onClick={() => onSelectEntity(e.name)} className={`rounded px-2 py-0.5 text-[12px] font-mono transition-colors ${e.name === entity.name ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{e.name}</button>)}
        <button
          onClick={() => setShowTrash((v) => !v)}
          className={`ml-auto inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${showTrash ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
        >
          <Trash2 className="h-3 w-3" />Trash
        </button>
        <button
          onClick={() => setShowBackup((v) => !v)}
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${showBackup ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
        >
          <History className="h-3 w-3" />Backup
        </button>
        <button
          onClick={() => setShowPerms((v) => !v)}
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${showPerms ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
        >
          <ShieldCheck className="h-3 w-3" />Permissions
        </button>
        <button
          onClick={() => setShowRelations((v) => !v)}
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${showRelations ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
        >
          <Link2 className="h-3 w-3" />Relations
        </button>
        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            disabled={busy}
            aria-label="More actions"
            title="More actions"
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <MoreHorizontal className="h-3 w-3" />}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-md border border-border bg-popover p-1 shadow-md text-[12px]">
              <button onClick={exportCsv} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted transition-colors">
                <Download className="h-3.5 w-3.5" />Export CSV
              </button>
              <button onClick={pickCsv} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted transition-colors">
                <Upload className="h-3.5 w-3.5" />Import CSV
              </button>
              <button onClick={clearTable} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-destructive hover:bg-muted transition-colors">
                <Eraser className="h-3.5 w-3.5" />Clear table
              </button>
            </div>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground/60">{rows ? `${rows.length} records` : ""}</span>
      </div>
      <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
      {showPerms && entity && <EntityPermissions projectId={projectId} entity={entity} onSaved={() => onReload?.()} />}
      {showRelations && <RelationsPanel projectId={projectId} entities={entities} onSaved={() => onReload?.()} />}
      <div className="px-3 py-2 border-b border-border/40 flex flex-wrap gap-1.5">
        {fields.map(([name, f]) => <span key={name} className="rounded border border-border px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">{name}<span className="text-muted-foreground/60">: {f.type}{f.required ? "!" : ""}</span></span>)}
      </div>
      <div className="flex-1 overflow-auto">
        {!rows ? <div className="p-6 text-muted-foreground/60"><Loader2 className="h-4 w-4 animate-spin" /></div> : rows.length === 0 ? (
          <div className="p-8 text-center text-[12px] text-muted-foreground/60">No {entity.name} records yet — create some in the preview.</div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-muted text-left text-muted-foreground"><tr>{fields.map(([n]) => <th key={n} className="px-3 py-1.5 font-medium">{n}</th>)}<th className="px-3 py-1.5 font-medium">created</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-t border-border/40 hover:bg-muted/50 transition-colors">
                {fields.map(([n]) => <td key={n} className="px-3 py-1.5 max-w-[240px] truncate">{r[n] === undefined || r[n] === null ? <span className="text-muted-foreground/30">—</span> : String(r[n])}</td>)}
                <td className="px-3 py-1.5 text-muted-foreground/60 whitespace-nowrap">{new Date(r.created_date).toLocaleString()}</td>
                <td className="px-2 py-1.5 text-right"><button onClick={() => remove(r.id)} className="text-muted-foreground/30 hover:text-destructive transition-colors"><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <DataTrashPanel projectId={projectId} entity={entity} open={showTrash} onChanged={load} refreshSignal={rows ? rows.length : 0} />
      <DataBackupPanel projectId={projectId} entity={entity} open={showBackup} />
    </div>
  );
}