import React from "react";

// One run result, explicitly labelled as a simulation (nothing saved) or a persisted cycle.
export default function TrainingResult({ result }) {
  const sim = result.mode === "simulation" || result.persisted === false;
  const verdict = sim ? (result.would_promote ? "Would promote" : "Would not promote") : (result.promoted ? "Promoted" : result.cycle?.status || "Not promoted");
  const code = result.error || result.failure_code || result.cycle?.failure_code || result.promotion?.code || result.cycle?.promotion?.code;
  return (
    <div className={`rounded-md border p-3 text-xs space-y-1 ${sim ? "border-dashed border-brand bg-brand-muted" : "border-border bg-muted"}`}>
      <div className="font-medium">
        {sim ? "Simulation — read-only, nothing was saved" : "Persisted training cycle — results saved"}
      </div>
      <div>{verdict}{code ? ` · ${code}` : ""}</div>
      {result.capture && <div className="text-muted-foreground">Episodes considered {result.capture.considered ?? "—"} · eligible {result.capture.eligible ?? "—"}</div>}
    </div>
  );
}