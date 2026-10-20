import React, { useEffect, useState } from "react";
import { Loader2, Play, ShieldCheck } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import QaRunList from "@/components/testingagent/QaRunList";

// Minimal QA surface wired ONLY to the certified `qa` backend (shared/qa.ts). The run list is
// the shared QaRunList component (also used by the Testing Agent page), so there is one
// rendering of the QA control plane and no second list logic. Exposes the existing "run"
// trigger (with optional repair). No QA fields, execution semantics or test infrastructure
// are invented — every column maps 1:1 to the publicQaRun projection the backend returns.
export default function QaActivityTab({ projectId }) {
  const [runs, setRuns] = useState(null);
  const [running, setRunning] = useState(false);
  const [repair, setRepair] = useState(false);

  const load = async () => {
    try {
      const res = await base44.functions.invoke("qa", { action: "list", project_id: projectId, limit: 20 });
      setRuns(res.data?.qa_runs || []);
    } catch (e) {
      setRuns([]);
      toast({ variant: "destructive", title: "Could not load QA runs", description: e.response?.data?.error || e.message });
    }
  };

  useEffect(() => { if (projectId) load(); }, [projectId]);

  const run = async () => {
    if (running) return;
    setRunning(true);
    try {
      const res = await base44.functions.invoke("qa", { action: "run", project_id: projectId, repair });
      const r = res.data?.qa_run;
      toast({ title: `QA ${r?.status || "started"}`, description: r?.terminated_by ? `Stopped: ${r.terminated_by}` : `${r?.passed || 0} passed · ${r?.failed || 0} failed` });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "QA run failed", description: e.response?.data?.error || e.message });
    } finally { setRunning(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40">
        <button
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-2 py-1 text-[11px] font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}Run QA
        </button>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={repair} onChange={(e) => setRepair(e.target.checked)} className="h-3 w-3" />
          <ShieldCheck className="h-3 w-3" />Repair on failure
        </label>
      </div>
      {!runs ? (
        <div className="p-3 text-muted-foreground/60"><Loader2 className="h-3 w-3 animate-spin" /></div>
      ) : (
        <QaRunList runs={runs} />
      )}
    </div>
  );
}