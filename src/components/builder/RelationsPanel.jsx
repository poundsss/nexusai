import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Save, Trash2, Plus, Link2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// Project-scoped AppRelation (foreign-key) authoring panel. The UI persistence path for the
// `projectRelations` builder endpoint. Edits ONLY relation metadata rows — no entity schema,
// no fields, no version. The backend reuses validateRelationDef + canonical (relations.ts),
// so the UI can never persist a shape the runtime enforcement engine would not accept.
//
// FK field placement follows relations.ts canonical(): many_to_one/one_to_one → FK on
// from_entity; one_to_many → FK on to_entity. The helper text reflects this so the author
// places from_field on the correct entity; the backend rejects a dangling field regardless.

const TYPES = ["many_to_one", "one_to_one", "one_to_many"];
const ON_DELETE = ["restrict", "set_null", "cascade"];

const EMPTY = { name: "", from_entity: "", from_field: "", to_entity: "", type: "many_to_one", on_delete: "restrict", required: false };

const fkEntityOf = (def) => (def.type === "one_to_many" ? def.to_entity : def.from_entity);

export default function RelationsPanel({ projectId, entities, onSaved }) {
  const [rels, setRels] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // null | draft def (new or existing)
  const [saving, setSaving] = useState(false);

  const entityNames = entities.map((e) => e.name);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke("projectRelations", { action: "list", project_id: projectId });
      setRels(res.data?.relations || []);
    } catch (e) {
      toast({ variant: "destructive", title: "Load failed", description: e.response?.data?.error || e.message });
      setRels([]);
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const startAdd = () => {
    const pre = entityNames.length ? { ...EMPTY, from_entity: entityNames[0], to_entity: entityNames[1] || entityNames[0] } : { ...EMPTY };
    setEditing(pre);
  };

  const startEdit = (r) => setEditing({ ...r });

  const cancel = () => setEditing(null);

  const save = async () => {
    const def = editing;
    if (!def) return;
    if (!def.name.trim()) { toast({ variant: "destructive", title: "Name required" }); return; }
    setSaving(true);
    try {
      await base44.functions.invoke("projectRelations", { action: "set", project_id: projectId, relation: def });
      toast({ title: "Relation saved", description: def.name });
      setEditing(null);
      await load();
      onSaved?.();
    } catch (e) {
      toast({ variant: "destructive", title: "Save failed", description: e.response?.data?.error || e.message });
    } finally { setSaving(false); }
  };

  const remove = async (name) => {
    if (!window.confirm(`Delete relation "${name}"?`)) return;
    try {
      await base44.functions.invoke("projectRelations", { action: "delete", project_id: projectId, name });
      toast({ title: "Relation deleted", description: name });
      await load();
      onSaved?.();
    } catch (e) {
      toast({ variant: "destructive", title: "Delete failed", description: e.response?.data?.error || e.message });
    }
  };

  return (
    <div className="px-3 py-2 border-b border-border/40">
      <div className="flex items-center gap-2 mb-2">
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-semibold">Relations</h3>
        <button onClick={startAdd} disabled={!entityNames.length} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50 transition-colors">
          <Plus className="h-3 w-3" />Add
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground/80 mb-2">Foreign-key relationships enforced at runtime on top of ID-reference string fields. The FK field lives on <span className="font-mono">{editing?.type === "one_to_many" ? "to_entity" : "from_entity"}</span>.</p>

      {loading ? (
        <div className="py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : !rels || rels.length === 0 ? (
        <div className="py-3 text-[12px] text-muted-foreground/60">No relations declared yet.</div>
      ) : (
        <div className="space-y-1.5">
          {rels.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[11px]">
              <span className="font-mono font-medium">{r.name}</span>
              <span className="text-muted-foreground">{r.from_entity}.{r.from_field} → {r.to_entity}</span>
              <span className="text-muted-foreground/70">{r.type}{r.required ? " · required" : ""} · {r.on_delete}</span>
              <button onClick={() => startEdit(r)} className="ml-auto text-muted-foreground hover:text-foreground transition-colors">edit</button>
              <button onClick={() => remove(r.name)} className="text-muted-foreground/40 hover:text-destructive transition-colors"><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="mt-2 rounded-md border border-border p-2.5 space-y-2 bg-muted/30">
          <div className="grid grid-cols-2 gap-2">
            <Field label="name">
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="post_author" className={inputCls} />
            </Field>
            <Field label="type">
              <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })} className={inputCls}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="from_entity">
              <select value={editing.from_entity} onChange={(e) => setEditing({ ...editing, from_entity: e.target.value })} className={inputCls}>
                <option value="">—</option>
                {entityNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="to_entity">
              <select value={editing.to_entity} onChange={(e) => setEditing({ ...editing, to_entity: e.target.value })} className={inputCls}>
                <option value="">—</option>
                {entityNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label={`from_field (on ${fkEntityOf(editing) || "—"})`}>
              <input value={editing.from_field} onChange={(e) => setEditing({ ...editing, from_field: e.target.value })} placeholder="author_id" className={inputCls} />
            </Field>
            <Field label="on_delete">
              <select value={editing.on_delete} onChange={(e) => setEditing({ ...editing, on_delete: e.target.value })} className={inputCls}>
                {ON_DELETE.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <label className="col-span-2 flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={!!editing.required} onChange={(e) => setEditing({ ...editing, required: e.target.checked })} className="h-3 w-3" />
              required (FK field must be non-null on create)
            </label>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 rounded-md bg-foreground text-background px-2 py-1 text-[11px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}Save
            </button>
            <button onClick={cancel} className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted transition-colors">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls = "w-full rounded border border-input bg-background px-1.5 py-1 text-[11px] font-mono";

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</span>
      {children}
    </label>
  );
}