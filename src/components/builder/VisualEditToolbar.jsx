import React, { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STYLE_OPTIONS, describeChanges } from "@/components/builder/visualEditOptions";

// Hands-on style toolbar for the element picked in the preview. Apply commits a deterministic
// source edit; when the element can't be located exactly, "Ask AI" sends the same change as an edit.
export default function VisualEditToolbar({ element, onApply, onAskAi, onClose }) {
  const [text, setText] = useState(element?.text || "");
  const [classes, setClasses] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setText(element?.text || ""); setClasses({}); setError(null); }, [element]);
  if (!element) return null;

  const changes = { classes, ...(text.trim() && text.trim() !== (element.text || "").trim() ? { text: text.trim() } : {}) };
  const empty = !Object.keys(classes).length && changes.text == null;
  const apply = async () => {
    setBusy(true); setError(null);
    const err = await onApply(changes);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <div className="absolute right-3 top-3 z-20 w-72 rounded-lg border bg-card p-3 shadow-lg space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium">Edit &lt;{element.tag}&gt;</span>
        <button onClick={onClose} aria-label="Close"><X className="w-3.5 h-3.5 text-muted-foreground" /></button>
      </div>
      {element.text ? <Input value={text} onChange={(e) => setText(e.target.value)} className="h-8 text-xs" placeholder="Text" /> : null}
      <div className="grid grid-cols-2 gap-1.5">
        {STYLE_OPTIONS.map((o) => (
          <select key={o.group} value={classes[o.group] || ""} className="h-7 rounded border bg-background px-1"
            onChange={(e) => setClasses((c) => { const n = { ...c }; if (e.target.value) n[o.group] = e.target.value; else delete n[o.group]; return n; })}>
            <option value="">{o.label}</option>
            {o.values.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        ))}
      </div>
      {error && <div className="text-destructive">{error.message}</div>}
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 flex-1" disabled={empty || busy} onClick={apply}>{busy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Apply"}</Button>
        {error?.fallback && <Button size="sm" variant="outline" className="h-7" onClick={() => onAskAi(describeChanges(changes))}>Ask AI</Button>}
      </div>
    </div>
  );
}