import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

// Add Item / inline edit form for one record, built from the entity's DECLARED fields
// (the certified AppEntity schema — no invented fields). Validation is re-done server-side
// by the certified mutate contract; the form only shapes input per field type.
export default function RecordDialog({ open, entityName, fields, record, onSave, onClose }) {
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const init = {};
    for (const [name, f] of fields || []) {
      const v = record ? record[name] : f.default;
      init[name] = v === undefined || v === null ? (f.type === "boolean" ? false : "") : v;
    }
    setValues(init);
  }, [open, record, fields]);

  if (!open) return null;

  const set = (name, v) => setValues((s) => ({ ...s, [name]: v }));

  const save = async () => {
    setSaving(true);
    try { await onSave(values); onClose(); }
    finally { setSaving(false); }
  };

  const inputCls = "text-[12.5px]";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{record ? `Edit ${entityName} record` : `Add ${entityName} record`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2.5 max-h-[55vh] overflow-y-auto scrollbar-thin pr-1">
          {(fields || []).map(([name, f]) => (
            <div key={name} className="flex items-center gap-2.5">
              <label className="w-24 shrink-0 truncate text-[12px] text-muted-foreground">
                {name}{f.required && <span className="text-destructive">*</span>}
              </label>
              {(f.enum || []).length ? (
                <select
                  value={values[name] ?? ""}
                  onChange={(e) => set(name, e.target.value)}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-[12.5px] outline-none focus:ring-1 ring-ring"
                >
                  <option value="">—</option>
                  {f.enum.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={!!values[name]}
                  onChange={(e) => set(name, e.target.checked)}
                  className="h-4 w-4 accent-[hsl(var(--brand))]"
                />
              ) : (
                <Input
                  type={f.type === "number" ? "number" : "text"}
                  value={values[name] ?? ""}
                  onChange={(e) => set(name, f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
                  className={`h-8 ${inputCls}`}
                />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={saving} onClick={save}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{record ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}