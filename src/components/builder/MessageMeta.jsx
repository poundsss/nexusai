import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// Footer under an assistant message: when it was written, and a copy action.
export default function MessageMeta({ createdDate, content }) {
  const [copied, setCopied] = useState(false);
  const when = createdDate ? (() => { try { return formatDistanceToNow(new Date(createdDate), { addSuffix: true }); } catch { return null; } })() : null;

  const copy = async () => {
    try { await navigator.clipboard.writeText(content || ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="flex items-center gap-2 pt-0.5 text-[10.5px] text-muted-foreground/70">
      {when && <span>{when}</span>}
      <button onClick={copy} aria-label="Copy message" className="grid place-items-center h-5 w-5 rounded-md hover:bg-muted hover:text-foreground transition-colors">
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}