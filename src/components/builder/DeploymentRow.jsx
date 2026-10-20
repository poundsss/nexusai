import React from "react";
import { Loader2, CheckCircle2, XCircle, RotateCcw, MinusCircle } from "lucide-react";

const ACTIVE = ["QUEUED", "BUILDING", "DEPLOYING", "VERIFYING"];

const LOOK = {
  LIVE: { cls: "bg-emerald-500/10 text-emerald-600", Icon: CheckCircle2 },
  FAILED: { cls: "bg-destructive/10 text-destructive", Icon: XCircle },
  CANCELLED: { cls: "bg-muted text-muted-foreground", Icon: MinusCircle },
  ROLLED_BACK: { cls: "bg-amber-500/10 text-amber-600", Icon: RotateCcw },
};

export default function DeploymentRow({ deployment: d, isCurrent, onRollback, onCancel, working }) {
  const active = ACTIVE.includes(d.status);
  const env = d.environment || "production";
  const { cls, Icon } = LOOK[d.status] || { cls: "bg-blue-500/10 text-blue-600", Icon: Loader2 };
  return (
    <div className={`rounded-md border p-2.5 transition-colors ${isCurrent ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${cls}`}>
          <Icon className={`h-3 w-3 ${active ? "animate-spin" : ""}`} />{d.status}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">version {d.version_number}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{env}</span>
        {isCurrent && <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white">LIVE {env}</span>}
        {d.trigger === "rollback" && <span className="text-[11px] text-amber-600">rollback</span>}
        {d.trigger === "promotion" && <span className="text-[11px] text-blue-600">promoted</span>}
        {d.superseded_at && !isCurrent && <span className="text-[11px] text-muted-foreground/60">previous</span>}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{d.artifact_checksum ? d.artifact_checksum.slice(0, 10) : "—"}</span>
      </div>
      {d.verification && <p className="mt-1 text-[11px] text-muted-foreground">{d.verification}</p>}
      {d.failure_summary && <p className="mt-1 text-[11px] text-destructive">{d.failure_summary}</p>}
      {(d.build_diagnostics || []).slice(0, 10).map((line, i) => (
        <p key={i} className="mt-0.5 font-mono text-[10px] text-destructive truncate">{line}</p>
      ))}
      <div className="mt-1.5 flex items-center gap-3 text-[11px]">
        <span className="text-muted-foreground/60">{new Date(d.created_date).toLocaleString()}</span>
        {active && <button onClick={() => onCancel(d.id)} disabled={working} className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">Cancel</button>}
        {d.status === "LIVE" && !isCurrent && <button onClick={() => onRollback(d.id, env)} disabled={working} className="text-foreground underline hover:text-foreground/80 transition-colors disabled:opacity-50">Roll back to this</button>}
      </div>
    </div>
  );
}