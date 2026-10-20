import React, { useRef, useState } from "react";
import { AlertTriangle, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// Base44 parity: "Issues Found" → "Resolve with AI". One click starts exactly one repair run.
export default function IssuesFoundNotice({ errors, onResolve, onDismiss, disabled = false }) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const unique = [...new Set(errors.map((e) => String(e || "").trim()).filter(Boolean))];
  if (!unique.length) return null;

  const resolve = async () => {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    try { await onResolve(unique); } finally { lock.current = false; setBusy(false); }
  };

  return (
    <div className="absolute top-3 right-3 z-20 w-[320px] max-w-[calc(100%-1.5rem)] rounded-lg border bg-background shadow-md">
      <div className="flex items-start gap-2 p-3">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Issues Found</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground line-clamp-2 break-words font-mono">{unique[unique.length - 1]}</p>
          {unique.length > 1 && <p className="mt-0.5 text-[11px] text-muted-foreground">{unique.length} distinct errors</p>}
        </div>
        <button onClick={onDismiss} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="px-3 pb-3">
        <Button size="sm" className="w-full h-8 text-[12px]" onClick={resolve} disabled={busy || disabled}>
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
          Resolve with AI
        </Button>
      </div>
    </div>
  );
}