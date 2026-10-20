import React, { useEffect, useState } from "react";
import { ChevronDown, Activity, Hammer, AlertTriangle, FlaskConical } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import QaActivityTab from "./QaActivityTab";

const TABS = [
  { id: "Activity", label: "Activity", icon: Activity },
  { id: "Build", label: "Build", icon: Hammer },
  { id: "QA", label: "QA", icon: FlaskConical },
  { id: "Logs", label: "Logs", icon: AlertTriangle },
];

export default function ActivityBar({ runs, builds, runtimeErrors, openRequest = 0, projectId }) {
  const [open, setOpen] = useState(false);
  // The overflow menu's "Activity monitor" opens this panel.
  useEffect(() => { if (openRequest > 0) setOpen(true); }, [openRequest]);
  const [tab, setTab] = useState("Activity");
  const lastBuild = builds[0];
  const lastRun = runs[0];

  // No permanent bottom bar — the panel only appears when explicitly opened (via the
  // overflow menu's "Activity monitor"), then collapses away to nothing.
  if (!open) return null;

  return (
    <div className="shrink-0 border-t border-border bg-background flex flex-col h-56">
      <div className="h-9 shrink-0 flex items-center gap-1 px-3 text-[11px] text-muted-foreground/80">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setOpen(true); }}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${open && tab === t.id ? "text-foreground font-medium bg-muted" : "hover:text-foreground hover:bg-muted/50"}`}
          >
            {t.label}
            {t.id === "Logs" && runtimeErrors.length > 0 && <span className="rounded bg-destructive/10 text-destructive px-1 text-[10px]">{runtimeErrors.length}</span>}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-3 font-mono text-[10px]">
          {lastBuild && <span className={lastBuild.status === "success" ? "text-emerald-600" : "text-destructive"}>build {lastBuild.status} · {lastBuild.duration_ms}ms</span>}
          {lastRun && <span>{runs.length} runs · last {formatDistanceToNow(new Date(lastRun.created_date), { addSuffix: true })}</span>}
        </span>
        <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors p-1" aria-label="Collapse panel">
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="flex-1 overflow-auto scrollbar-thin border-t border-border font-mono text-[11px]">
          {tab === "Activity" && (runs.length === 0 ? <Empty>No AI runs yet.</Empty> : (
            <table className="w-full"><tbody>{runs.map((r) => (
              <tr key={r.id} className="border-b border-border/40">
                <td className={`px-3 py-1.5 w-24 ${r.status === "COMPLETED" ? "text-emerald-600" : r.status === "FAILED" ? "text-destructive" : "text-brand"}`}>{r.status}</td>
                <td className="px-3 py-1.5 w-16 text-muted-foreground/60">{r.mode}</td>
                <td className="px-3 py-1.5 truncate max-w-[400px] text-foreground">{r.prompt}</td>
                <td className="px-3 py-1.5 text-muted-foreground/60 whitespace-nowrap">{r.model} · {r.input_tokens + r.output_tokens} tok · {r.tool_calls} tools · {Math.round((r.duration_ms || 0) / 1000)}s{r.version_number ? ` · v${r.version_number}` : ""}</td>
              </tr>
            ))}</tbody></table>
          ))}
          {tab === "Build" && (!lastBuild ? <Empty>No builds yet.</Empty> : (
            <div className="p-3 space-y-0.5">{(lastBuild.logs || []).map((l, i) => <div key={i} className={l.startsWith("error") ? "text-destructive" : l.startsWith("warning") ? "text-amber-600" : "text-muted-foreground"}>{l}</div>)}</div>
          ))}
          {tab === "QA" && <QaActivityTab projectId={projectId} />}
          {tab === "Logs" && (runtimeErrors.length === 0 ? <Empty>No runtime errors from the preview.</Empty> : (
            <div className="p-3 space-y-0.5">{runtimeErrors.map((e, i) => <div key={i} className="text-destructive">{e}</div>)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ children }) { return <div className="p-3 text-muted-foreground/60">{children}</div>; }