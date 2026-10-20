import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2, Search, Download, MoreVertical, Plus, Trash2, ScrollText,
  SlidersHorizontal, Columns3, Pencil, ChevronLeft,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { downloadCsv } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import RecordDialog from "./RecordDialog";
import SchemaDialog from "./SchemaDialog";
import TrashDialog from "./TrashDialog";

// One authorized table's record manager (the confirmed Superagent → Data record surface).
// PROJECT tables (an owning app's entity) read and mutate ONLY through the certified
// server-authorized contracts — mcpQueryEntityRecords (project.read), mcpMutateEntityRecord
// (project.write, schema-validated) and the Entity Trash (delete → restorable trash) — so no
// second CRUD system exists and every mutation fails closed server-side. PLATFORM tables
// (root agents) are offered exactly what the agent's certified tool_configs grant: reads,
// search, filters, columns and CSV export; writes are not offered (no write permission).
const SYSTEM_KEYS = new Set(["id", "created_date", "updated_date", "owner_id", "created_by_id"]);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fmtCell = (v) => (v === undefined || v === null || v === "" ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

export default function RecordManager({ agentName, entityName, projectId, allowedOps, onBack }) {
  const project = !!projectId;
  const can = (op) => (allowedOps || []).includes(op);
  const canCreate = project && can("create");
  const canUpdate = project && can("update");
  const canDelete = project && can("delete");

  const [fields, setFields] = useState(null); // [[name, def]]
  const [derived, setDerived] = useState(false);
  const [records, setRecords] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({}); // field → { op, value }
  const [hidden, setHidden] = useState({}); // field → true
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editRecord, setEditRecord] = useState(null); // null = closed, {} = add
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  const textFields = useMemo(
    () => (fields || []).filter(([, f]) => !f.type || ["string", "text", "date"].includes(f.type)).map(([n]) => n),
    [fields],
  );
  const visibleFields = useMemo(() => (fields || []).filter(([n]) => !hidden[n]), [fields, hidden]);

  const buildFilter = useCallback(() => {
    const conds = [];
    const searchFields = textFields.length ? textFields : (fields || []).map(([n]) => n);
    if (search.trim()) {
      if (project) {
        const or = searchFields.map((f) => ({ [f]: { $contains: search.trim() } }));
        conds.push(or.length === 1 ? or[0] : { $or: or });
      } else {
        const or = searchFields.map((f) => ({ [f]: { $regex: escapeRe(search.trim()), $options: "i" } }));
        conds.push(or.length === 1 ? or[0] : { $or: or });
      }
    }
    for (const [f, fl] of Object.entries(filters)) {
      if (!fl.value) continue;
      if (fl.op === "contains") {
        conds.push(project ? { [f]: { $contains: fl.value } } : { [f]: { $regex: escapeRe(fl.value), $options: "i" } });
      } else {
        conds.push({ [f]: fl.value });
      }
    }
    if (!conds.length) return null;
    return conds.length === 1 ? conds[0] : { $and: conds };
  }, [project, search, filters, textFields, fields]);

  // Load the entity's declared fields (AppEntity — the certified schema surface) and records.
  const load = useCallback(async () => {
    setRecords(null);
    setError(null);
    try {
      if (project) {
        const page = await base44.entities.AppEntity.filter({ project_id: projectId, name: entityName }, "name", 1);
        const def = (page.items || [])[0];
        if (!def) throw new Error(`Entity "${entityName}" is not declared in the owning app.`);
        setFields(Object.entries(def.fields || {}));
        const res = await base44.functions.invoke("mcpQueryEntityRecords", {
          project_id: projectId, entity: entityName, filter: buildFilter(), sort: "-created_date", limit: 200,
        });
        setRecords(res.data?.records || []);
      } else {
        const ent = base44.entities[entityName];
        if (!ent) throw new Error(`Unknown entity "${entityName}".`);
        const page = await ent.filter(buildFilter() || {}, { sort: "-created_date", limit: 200 });
        setRecords(page.items || []);
        setDerived(true);
        setFields(deriveFields(page.items || []));
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Could not load the table");
      setRecords([]);
    }
  }, [project, projectId, entityName, buildFilter]);
  useEffect(() => { load(); }, [load]);

  const mutate = async (operation, data, recordId) => {
    const res = await base44.functions.invoke("mcpMutateEntityRecord", {
      project_id: projectId, entity: entityName, operation, record_id: recordId || null, data,
    });
    return res.data;
  };

  const saveRecord = async (values) => {
    try {
      if (editRecord?.id) {
        await mutate("update", values, editRecord.id);
        toast({ title: "Record saved" });
      } else {
        await mutate("create", values);
        toast({ title: "Record added" });
      }
      await load();
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
      toast({ variant: "destructive", title: editRecord?.id ? "Save failed" : "Add failed", description: msg });
      throw e;
    }
  };

  const removeOne = async (id) => {
    setBusy(true);
    try {
      await base44.functions.invoke("entityTrash", { project_id: projectId, action: "delete", entity_name: entityName, record_id: id });
      toast({ title: "Moved to Recently Deleted" });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Delete failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  };

  // Delete All: every live record moves to the Entity Trash (restorable) — one certified
  // delete per record, so nothing is lost beyond the documented trash semantics.
  const deleteAll = async () => {
    if (!records || !records.length) { toast({ title: "Nothing to delete", description: `${entityName} has no records.` }); return; }
    if (!window.confirm(`Delete all ${records.length} ${entityName} record(s)? They move to Recently Deleted and can be restored.`)) return;
    setBusy(true);
    try {
      for (const r of records) {
        await base44.functions.invoke("entityTrash", { project_id: projectId, action: "delete", entity_name: entityName, record_id: r.id });
      }
      toast({ title: `${records.length} record(s) moved to Recently Deleted` });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Delete All failed", description: e.response?.data?.error || e.message });
      await load();
    } finally { setBusy(false); }
  };

  const exportCsv = () => {
    if (!records || !records.length) { toast({ title: "Nothing to export", description: `${entityName} has no records yet.` }); return; }
    let cols = (fields || []).map(([n]) => n);
    if (!cols.length) cols = Object.keys(records[0]).filter((k) => !SYSTEM_KEYS.has(k));
    downloadCsv(`${entityName}.csv`, cols, records);
  };

  const activeFilterCount = Object.values(filters).filter((f) => f.value).length;
  const writable = canCreate || canUpdate;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0 gap-1 px-2 text-muted-foreground">
          <ChevronLeft className="h-3.5 w-3.5" />Tables
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium">{entityName}</span>
        {!project && (
          <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">read-only</span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More actions" className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium shadow-sm hover:bg-accent transition-colors">
              More <MoreVertical className="h-3 w-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={exportCsv}><Download className="h-3.5 w-3.5" />Export CSV</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSchemaOpen(true)}><ScrollText className="h-3.5 w-3.5" />Schema</DropdownMenuItem>
            {project && (
              <>
                <DropdownMenuItem onSelect={() => setTrashOpen(true)}><Trash2 className="h-3.5 w-3.5" />Recently Deleted</DropdownMenuItem>
                {canDelete && <DropdownMenuItem onSelect={deleteAll} className="text-destructive"><Trash2 className="h-3.5 w-3.5" />Delete All</DropdownMenuItem>}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Search + Filters + Columns + Add Item */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[160px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${entityName}…`}
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>
        <div className="relative">
          <Button variant="outline" size="sm" onClick={() => setFiltersOpen((v) => !v)} className="gap-1.5 text-[12.5px]">
            <SlidersHorizontal className="h-3.5 w-3.5" />Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
          </Button>
          {filtersOpen && (
            <div className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-md border border-border bg-popover p-2 shadow-md">
              {(fields || []).map(([n, f]) => (
                <div key={n} className="mb-1.5 flex items-center gap-1.5">
                  <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground">{n}</span>
                  <select
                    value={filters[n]?.op || "contains"}
                    onChange={(e) => setFilters((s) => ({ ...s, [n]: { ...(s[n] || { value: "" }), op: e.target.value } }))}
                    className="h-7 w-[86px] shrink-0 rounded border border-input bg-background px-1 text-[11px] outline-none"
                  >
                    <option value="contains">contains</option>
                    <option value="equals">equals</option>
                  </select>
                  <Input
                    value={filters[n]?.value || ""}
                    onChange={(e) => setFilters((s) => ({ ...s, [n]: { ...(s[n] || { op: "contains" }), value: e.target.value } }))}
                    className="h-7 flex-1 text-[11.5px]"
                  />
                </div>
              ))}
              <div className="flex justify-end pt-1">
                <Button variant="ghost" size="sm" onClick={() => { setFilters({}); setFiltersOpen(false); }} className="text-[12px] text-muted-foreground">Clear filters</Button>
              </div>
            </div>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5 text-[12.5px]"><Columns3 className="h-3.5 w-3.5" />Columns</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">Show columns</DropdownMenuLabel>
            {(fields || []).map(([n]) => (
              <DropdownMenuCheckboxItem key={n} checked={!hidden[n]} onCheckedChange={(v) => setHidden((s) => ({ ...s, [n]: !v }))}>
                <span className="font-mono text-[11.5px]">{n}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {canCreate && (
          <Button size="sm" onClick={() => setEditRecord({})} className="gap-1.5 text-[12.5px]"><Plus className="h-3.5 w-3.5" />Add Item</Button>
        )}
      </div>

      {!project && (
        <p className="mb-2 text-[12px] text-muted-foreground">
          Read-only: {agentName} has read access to this table — writes happen through the owning surfaces.
        </p>
      )}

      {/* Records */}
      {records === null ? (
        <div className="grid place-items-center rounded-md border border-border py-10"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[12.5px] text-destructive">{error}</div>
      ) : records.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-[12.5px] text-muted-foreground">
          {search || activeFilterCount ? "No records match the current search or filters." : `No ${entityName} records yet.`}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[480px] text-[12px]">
            <thead className="bg-muted text-left text-muted-foreground">
              <tr>
                {visibleFields.map(([n]) => <th key={n} className="whitespace-nowrap px-3 py-2 font-medium">{n}</th>)}
                <th className="whitespace-nowrap px-3 py-2 font-medium">created</th>
                {canDelete && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => { if (canUpdate) setEditRecord(r); }}
                  className={`border-t border-border/40 transition-colors hover:bg-muted/50 ${canUpdate ? "cursor-pointer" : ""}`}
                >
                  {visibleFields.map(([n]) => (
                    <td key={n} className="max-w-[220px] truncate px-3 py-2">{fmtCell(r[n]) ?? <span className="text-muted-foreground/30">—</span>}</td>
                  ))}
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground/60">{new Date(r.created_date).toLocaleString()}</td>
                  {canDelete && (
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        aria-label="Delete record"
                        onClick={(e) => { e.stopPropagation(); removeOne(r.id); }}
                        className="grid h-6 w-6 place-items-center rounded text-muted-foreground/60 hover:bg-accent hover:text-destructive transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {records.length >= 200 && <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">Showing the first 200 records.</p>}
        </div>
      )}

      <RecordDialog open={!!editRecord} entityName={entityName} fields={fields || []} record={editRecord?.id ? editRecord : null} onSave={saveRecord} onClose={() => setEditRecord(null)} />
      <SchemaDialog open={schemaOpen} entityName={entityName} fields={fields || []} derived={derived} onClose={() => setSchemaOpen(false)} />
      {project && (
        <TrashDialog open={trashOpen} projectId={projectId} entityName={entityName} fields={Object.fromEntries(fields || [])} onRestored={load} onClose={() => setTrashOpen(false)} />
      )}
    </div>
  );
}

// Fallback for tables without declared fields: the union of the loaded rows' own keys
// (the same no-invented-columns fallback the Builder Data pane uses for CSV export).
function deriveFields(rows) {
  const keys = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!SYSTEM_KEYS.has(k)) keys.add(k);
  return [...keys].sort().map((k) => [k, {}]);
}