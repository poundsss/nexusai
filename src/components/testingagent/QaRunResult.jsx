import React, { useState } from "react";
import { Loader2, RotateCcw, Trash2, AlertOctagon, AlertTriangle, ListChecks } from "lucide-react";

// Per-run detail for the Testing Agent: Issues + Activity tabs, per-test Test Again (smoke only)
// and delete. Severity is mapped ONLY from the existing runtimeVerify error categories — no
// browser-step or invented severity exists here. The Activity tab lists the executed checks in
// order (runtimeVerify.checks[] is internal to the verifier; QaRun.results[] is its persisted
// projection, which is what we render honestly).
const SEVERITY = {
  BUILD_ERROR: { label: "Critical", tone: "text-destructive", icon: AlertOctagon },
  DEPENDENCY_ERROR: { label: "Critical", tone: "text-destructive", icon: AlertOctagon },
  STARTUP_ERROR: { label: "High", tone: "text-rose-600", icon: AlertOctagon },
  RUNTIME_ERROR: { label: "High", tone: "text-rose-600", icon: AlertOctagon },
  BACKEND_ERROR: { label: "High", tone: "text-rose-600", icon: AlertOctagon },
  DATABASE_ERROR: { label: "High", tone: "text-rose-600", icon: AlertOctagon },
  ROUTE_ERROR: { label: "Warning", tone: "text-amber-600", icon: AlertTriangle },
  TIMEOUT: { label: "Warning", tone: "text-amber-600", icon: AlertTriangle },
  RESOURCE_ERROR: { label: "Warning", tone: "text-amber-600", icon: AlertTriangle },
};

// A result is a smoke test (runnable by the existing engine) when its category is one of the
// deterministic QA categories — i.e. it came from generateTestPlan, not an AI "scenario".
const SMOKE_CATEGORIES = new Set(["build", "runtime_smoke", "ui_render", "route", "entity_crud", "backend_function", "integration"]);

export default function QaRunResult({ run, onRerun, onDelete, busyId }) {
  const [tab, setTab] = useState("issues");
  const results = run?.results || [];
  const issues = results.filter((r) => r.status === "failed");
  const isSmoke = (r) => SMOKE_CATEGORIES.has(r.category);

  return (
    <div className="border border-border rounded-md">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/60">
        <button onClick={() => setTab("issues")} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${tab === "issues" ? "text-foreground font-medium bg-muted" : "text-muted-foreground hover:text-foreground"}`}>
          <AlertOctagon className="h-3 w-3" />Issues
          {issues.length > 0 && <span className="rounded bg-destructive/10 text-destructive px-1 text-[10px]">{issues.length}</span>}
        </button>
        <button onClick={() => setTab("activity")} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${tab === "activity" ? "text-foreground font-medium bg-muted" : "text-muted-foreground hover:text-foreground"}`}>
          <ListChecks className="h-3 w-3" />Activity
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => onDelete?.(run.id)} disabled={busyId === run.id} title="Delete run" className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors">
            {busyId === run.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {tab === "issues" ? (
        issues.length === 0 ? (
          <div className="p-3 text-[11px] text-emerald-600">No issues found.</div>
        ) : (
          <ul className="divide-y divide-border/40">
            {issues.map((r, i) => {
              const sev = SEVERITY[r.error_category] || { label: "Warning", tone: "text-amber-600", icon: AlertTriangle };
              const SevIcon = sev.icon;
              return (
                <li key={r.id || i} className="px-2.5 py-1.5 text-[12px]">
                  <div className="flex items-start gap-2">
                    <SevIcon className={`h-3 w-3 shrink-0 mt-0.5 ${sev.tone}`} />
                    <span className={`shrink-0 text-[10px] font-semibold uppercase ${sev.tone}`}>{sev.label}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate">{r.target || r.category}</div>
                      {r.error && <div className="text-muted-foreground break-words">{r.error}</div>}
                      {r.file && <div className="text-muted-foreground/60 font-mono text-[10px] truncate">{r.file}</div>}
                    </div>
                    {isSmoke(r) && (
                      <button onClick={() => onRerun?.(r.id)} disabled={busyId === `rerun:${r.id}`} title="Test Again" className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                        {busyId === `rerun:${r.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        results.length === 0 ? (
          <div className="p-3 text-[11px] text-muted-foreground/60">No activity recorded.</div>
        ) : (
          <ul className="divide-y divide-border/40">
            {results.map((r, i) => (
              <li key={r.id || i} className="px-2.5 py-1.5 text-[11.5px]">
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${r.status === "passed" ? "bg-emerald-500" : r.status === "failed" ? "bg-destructive" : "bg-muted-foreground/40"}`} />
                  <span className="text-[10px] uppercase text-muted-foreground/70 w-28 shrink-0">{r.category}</span>
                  <span className="text-foreground truncate flex-1">{r.target}</span>
                  <span className={`text-[10px] shrink-0 ${r.status === "passed" ? "text-emerald-600" : r.status === "failed" ? "text-destructive" : "text-muted-foreground/60"}`}>{r.status}</span>
                </div>
                {r.error && <div className="ml-[1.35rem] text-muted-foreground break-words mt-0.5">{r.error}</div>}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}