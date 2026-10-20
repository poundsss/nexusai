import React from "react";
import { ArrowUpFromLine, ArrowDownToLine, CheckCircle2, XCircle, Loader2, Ban } from "lucide-react";

const ACTIVE = ["QUEUED", "RUNNING", "FETCHING", "VALIDATING", "COMMITTING"];

export default function GitSyncRow({ run, onCancel }) {
  const active = ACTIVE.includes(run.status);
  const ok = run.status === "COMPLETED";
  const Icon = run.direction === "export" ? ArrowUpFromLine : ArrowDownToLine;
  const State = active ? Loader2 : ok ? CheckCircle2 : run.status === "CANCELLED" ? Ban : XCircle;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium capitalize">{run.direction}</span>
        {run.auto && <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">auto</span>}
        <span className="font-mono text-[11px] text-muted-foreground">{run.repo_full_name}@{run.branch}</span>
        <span className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${active ? "bg-blue-500/10 text-blue-600" : ok ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive"}`}>
          <State className={`h-3 w-3 ${active ? "animate-spin" : ""}`} />{run.status}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground font-mono">
        {run.commit_sha && <span>commit {run.commit_sha.slice(0, 7)}</span>}
        {run.version_number != null && <span>internal v{run.version_number}</span>}
        {!!run.file_count && <span>{run.file_count} files</span>}
        {run.build_status !== "unknown" && <span>build {run.build_status}</span>}
        {run.security_scan !== "unknown" && <span>security {run.security_scan}</span>}
      </div>

      {active && run.current_phase && <p className="mt-1.5 text-[11px] text-muted-foreground">{run.current_phase}…</p>}
      {run.failure_summary && <p className="mt-1.5 text-[11px] text-destructive">{run.failure_summary}</p>}

      {!!run.changed_files?.length && (
        <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-muted-foreground">
          {run.changed_files.slice(0, 6).map((c) => (
            <li key={c.path}><span className="text-muted-foreground/60">{c.change}</span> {c.path}</li>
          ))}
          {run.changed_files.length > 6 && <li className="text-muted-foreground/60">+{run.changed_files.length - 6} more</li>}
        </ul>
      )}

      {!!run.build_diagnostics?.length && (
        <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-destructive">
          {run.build_diagnostics.slice(0, 4).map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}

      {active && <button onClick={() => onCancel(run.id)} className="mt-2 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted transition-colors">Cancel</button>}
    </div>
  );
}