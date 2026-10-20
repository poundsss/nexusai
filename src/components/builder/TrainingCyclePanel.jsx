import React, { useCallback, useEffect, useState } from "react";
import { FlaskConical, Loader2, Play, Eye } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import TrainingResult from "@/components/builder/TrainingResult";

// Training cycles: a read-only simulation (server-enforced, nothing saved) or a real persisted cycle.
export default function TrainingCyclePanel({ projectId }) {
  const [cycles, setCycles] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    const res = await base44.functions.invoke("productionLearning", { action: "list", project_id: projectId, limit: 5 }).catch(() => null);
    setCycles(res?.data?.cycles || []);
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const run = async (dry) => {
    if (!dry && !window.confirm("Run a real training cycle? Its results are saved and may promote a new routing policy.")) return;
    setBusy(dry ? "sim" : "run");
    try {
      const res = await base44.functions.invoke("productionLearning", { action: "run", project_id: projectId, dry_run: dry });
      setResult(res.data);
      if (!dry) await load();
    } catch (e) {
      setResult({ mode: dry ? "simulation" : "persisted", persisted: !dry, error: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium"><FlaskConical className="w-4 h-4" /> Training cycles</div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(true)}>
            {busy === "sim" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Simulate (read-only)
          </Button>
          <Button size="sm" disabled={!!busy} onClick={() => run(false)}>
            {busy === "run" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run training
          </Button>
        </div>
      </div>
      {result && <TrainingResult result={result} />}
      <div className="text-xs text-muted-foreground">
        {cycles.length ? cycles.map((c) => <div key={c.cycle_id}>v{c.version} · {c.status}{c.failure_code ? ` · ${c.failure_code}` : ""}</div>) : "No saved training cycles yet."}
      </div>
    </div>
  );
}