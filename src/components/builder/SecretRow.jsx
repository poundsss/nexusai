import React, { useState } from "react";
import { Trash2, Pencil, Check, X } from "lucide-react";

export default function SecretRow({ secret, busy, onSet, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  const save = async () => { if (!value) return; await onSet(value); setValue(""); setEditing(false); };

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px]">{secret.name}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${secret.is_set ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>{secret.is_set ? "value set" : "no value"}</span>
          {!secret.required && <span className="text-[10px] text-muted-foreground/60">optional</span>}
        </div>
        {secret.description && <p className="text-[11px] text-muted-foreground truncate">{secret.description}</p>}
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="new value" className="rounded-md border border-input bg-background px-2 py-1 text-[12px]" />
          <button onClick={save} disabled={busy || !value} className="rounded-md bg-primary text-primary-foreground p-1.5 hover:bg-primary/90 transition-colors disabled:opacity-50"><Check className="h-3.5 w-3.5" /></button>
          <button onClick={() => { setEditing(false); setValue(""); }} className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted transition-colors"><X className="h-3.5 w-3.5" /></button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button onClick={() => setEditing(true)} disabled={busy} className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted transition-colors"><Pencil className="h-3.5 w-3.5" /></button>
          <button onClick={onDelete} disabled={busy} className="rounded-md border border-border p-1.5 text-destructive hover:bg-destructive/10 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </div>
  );
}