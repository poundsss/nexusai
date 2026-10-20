import React, { useState } from "react";
import { Loader2, Ban, UserX, CheckCircle2, Clock } from "lucide-react";

const STATUS_STYLES = {
  active: { cls: "bg-emerald-500/10 text-emerald-600", Icon: CheckCircle2, label: "Active" },
  suspended: { cls: "bg-amber-500/10 text-amber-600", Icon: Clock, label: "Suspended" },
  deprovisioned: { cls: "bg-muted text-muted-foreground", Icon: UserX, label: "Deprovisioned" },
};

// One SCIM-provisioned user. The external_groups drive role resolution through group mappings.
// Suspend keeps the membership but deactivates it; deprovision removes access entirely.
export default function ScimUserRow({ record, onSuspend, onDeprovision, working }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const style = STATUS_STYLES[record.status] || STATUS_STYLES.active;
  const StatusIcon = style.Icon;
  const isActive = record.status === "active";

  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
      <span className="h-8 w-8 shrink-0 rounded-full bg-muted text-muted-foreground grid place-items-center text-[11px] font-semibold uppercase">
        {record.email?.charAt(0) || "?"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{record.email}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${style.cls}`}>
            <StatusIcon className="h-3 w-3" />{style.label}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="font-mono">ext: {record.external_id}</span>
          {record.display_name && <span>{record.display_name}</span>}
          <span>role: <span className="font-medium text-foreground">{record.mapped_role}</span></span>
          {record.external_groups?.length > 0 && <span className="font-mono">groups: {record.external_groups.join(", ")}</span>}
          {record.last_synced_at && <span>synced {new Date(record.last_synced_at).toLocaleDateString()}</span>}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        {isActive && (
          <button
            onClick={() => onSuspend(record.external_id)}
            disabled={working}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            title="Suspend — keep membership but deactivate"
          >
            {working ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}Suspend
          </button>
        )}
        {record.status !== "deprovisioned" && (
          !confirmOpen ? (
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={working}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-50"
              title="Deprovision — remove access entirely"
            >
              <UserX className="h-3 w-3" />Deprovision
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <button onClick={async () => { await onDeprovision(record.external_id); setConfirmOpen(false); }} disabled={working} className="text-[11px] text-destructive hover:underline disabled:opacity-50">
                {working ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
              </button>
              <button onClick={() => setConfirmOpen(false)} className="text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
            </div>
          )
        )}
      </div>
    </div>
  );
}