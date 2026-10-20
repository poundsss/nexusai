import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Save, ShieldCheck } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";

// G4: per-entity RLS authoring for the FOUR existing operations only (read/create/update/delete).
// Edits only the rule shapes already accepted by shared/rls.ts: true/false/null, Mongo-style filter
// objects, {{user.id|email|role|data.<field>}} templates, and user_condition. The backend reuses
// validateRlsBlock, so the UI can never persist a shape the evaluator would not accept.
//
// Verbatim preservation: an op the user leaves in "Open" mode is stored as ABSENT (the canonical
// open form), which the evaluator treats identically to true/{}/null. A custom filter object is
// round-tripped through JSON.parse/stringify so its structure is preserved byte-for-byte.

const OPS = ["read", "create", "update", "delete"];

// An open-ish value: absent, null, true, or empty object. All are semantically "open" to rls.ts.
const isOpen = (v) => v == null || v === true || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
const isDeny = (v) => v === false;
const isCustom = (v) => v != null && v !== false && v !== true && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;

function modeOf(v) {
  if (isDeny(v)) return "deny";
  if (isCustom(v)) return "custom";
  return "open";
}

export default function EntityPermissions({ projectId, entity, onSaved }) {
  const original = useMemo(() => (entity && entity.rls ? entity.rls : null), [entity?.id, entity?.rls]);
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(original || {})));
  const [text, setText] = useState(() => { const o = {}; for (const op of OPS) o[op] = isCustom(original?.[op]) ? JSON.stringify(original[op], null, 2) : ""; return o; });
  const [saving, setSaving] = useState(false);

  // Re-init when the selected entity changes.
  useEffect(() => {
    setDraft(JSON.parse(JSON.stringify(original || {})));
    const t = {};
    for (const op of OPS) t[op] = isCustom(original?.[op]) ? JSON.stringify(original[op], null, 2) : "";
    setText(t);
  }, [entity?.id]);

  const setMode = (op, mode) => {
    setDraft((d) => {
      const next = { ...d };
      if (mode === "open") delete next[op];
      else if (mode === "deny") next[op] = false;
      else next[op] = text[op] ? safeParse(text[op]) : {};
      return next;
    });
  };

  const setCustomText = (op, value) => {
    setText((t) => ({ ...t, [op]: value }));
    const parsed = safeParse(value);
    if (parsed !== undefined) setDraft((d) => ({ ...d, [op]: parsed }));
  };

  const save = async () => {
    // Build the rls block: only carry keys that are deny or custom; open is omitted (absent = open).
    const rls = {};
    for (const op of OPS) {
      const v = draft[op];
      if (isDeny(v)) rls[op] = false;
      else if (isCustom(v)) rls[op] = v;
      // open ⇒ omitted
    }
    setSaving(true);
    try {
      const res = await base44.functions.invoke("appEntityRls", { project_id: projectId, action: "set", entity_name: entity.name, rls: Object.keys(rls).length ? rls : null });
      toast({ title: "Permissions saved", description: `${entity.name} rules updated` });
      onSaved?.(entity.name, res.data.rls);
    } catch (e) {
      toast({ variant: "destructive", title: "Save failed", description: e.response?.data?.error || e.message });
    } finally { setSaving(false); }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(original || {});

  return (
    <div className="px-3 py-2 border-b border-border/40">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-semibold">Entity Permissions — {entity.name}</h3>
        <button onClick={save} disabled={!dirty || saving} className="ml-auto inline-flex items-center gap-1 rounded-md bg-foreground text-background px-2 py-1 text-[11px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}Save
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground/80 mb-2">Per-operation row-level security. Open = no rule (anyone). Deny = false. Custom = a filter object (e.g. <code className="font-mono">{`{ "created_by_id": "{{user.id}}" }`}</code>).</p>
      <div className="grid sm:grid-cols-2 gap-2">
        {OPS.map((op) => {
          const mode = modeOf(draft[op]);
          return (
            <div key={op} className="rounded-md border border-border p-2">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[11px] font-mono font-medium uppercase">{op}</span>
                <select value={mode} onChange={(e) => setMode(op, e.target.value)} className="ml-auto rounded border border-input bg-background px-1.5 py-0.5 text-[11px]">
                  <option value="open">Open</option>
                  <option value="deny">Deny (false)</option>
                  <option value="custom">Custom filter</option>
                </select>
              </div>
              {mode === "custom" && (
                <textarea
                  value={text[op]}
                  onChange={(e) => setCustomText(op, e.target.value)}
                  spellCheck={false}
                  placeholder='{ "created_by_id": "{{user.id}}" }'
                  className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] font-mono h-20 resize-y scrollbar-thin"
                />
              )}
              {mode === "open" && <span className="text-[11px] text-muted-foreground/70">No rule — operation is open to all authenticated app users.</span>}
              {mode === "deny" && <span className="text-[11px] text-muted-foreground/70">Denied (read/delete blocked; create/update open per evaluator semantics).</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function safeParse(s) {
  try { const v = JSON.parse(s); return (v && typeof v === "object" && !Array.isArray(v)) ? v : undefined; } catch { return undefined; }
}