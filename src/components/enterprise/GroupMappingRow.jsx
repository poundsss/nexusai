import React, { useState } from "react";
import { Trash2, Loader2 } from "lucide-react";

const ROLE_STYLES = {
  admin: "bg-amber-500/10 text-amber-600",
  editor: "bg-blue-500/10 text-blue-600",
  viewer: "bg-muted text-muted-foreground",
};

// One group → role mapping. The highest-priority matching mapping wins; ties break by role rank.
export default function GroupMappingRow({ mapping, onRemove, working }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] font-medium truncate">{mapping.external_group_id}</span>
          {mapping.external_group_name && <span className="text-[11px] text-muted-foreground truncate">— {mapping.external_group_name}</span>}
        </div>
      </div>
      <span className="text-[11px] text-muted-foreground font-mono">priority {mapping.priority || 0}</span>
      <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${ROLE_STYLES[mapping.role] || ROLE_STYLES.viewer}`}>{mapping.role}</span>
      {!confirmOpen ? (
        <button onClick={() => setConfirmOpen(true)} disabled={working} className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50" title="Remove mapping">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : (
        <div className="flex items-center gap-1.5">
          <button onClick={async () => { await onRemove(mapping.id); setConfirmOpen(false); }} disabled={working} className="text-[11px] text-destructive hover:underline disabled:opacity-50">
            {working ? <Loader2 className="h-3 w-3 animate-spin" /> : "Remove"}
          </button>
          <button onClick={() => setConfirmOpen(false)} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      )}
    </div>
  );
}