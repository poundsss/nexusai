import React, { useState } from "react";
import Section from "@/components/shell/Section";
import DataList from "@/components/shell/DataList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toLocaleString();

// Ordered funnel over two or more event names. The step ordering, the actor counting and the
// conversion arithmetic are the server's; this only names the steps and renders the answer.
export default function AnalyticsFunnelSection({ query }) {
  const [steps, setSteps] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = steps.split(",").map((s) => s.trim()).filter(Boolean);
      setResult(await query("funnel", { steps: list }));
    } catch (e) {
      setResult(null);
      setError(e.response?.data?.error || e.message || "Funnel unavailable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Funnel" description="Comma-separated event names, in order (at least two).">
      <div className="flex items-center gap-2">
        <Input value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="signup_started, signup_completed" className="h-8 max-w-md text-[13px]" />
        <Button size="sm" onClick={run} disabled={busy}>{busy ? "Computing…" : "Compute"}</Button>
      </div>
      {error && <p className="mt-3 text-[13px] text-destructive">{error}</p>}
      {busy && !result && <p className="mt-3 text-[13px] text-muted-foreground">Computing funnel…</p>}
      {result && (
        <div className="mt-4">
          <p className="mb-3 text-[13px] text-muted-foreground">
            {fmt(result.entered)} entered · {fmt(result.completed)} completed · {result.conversion_rate}% overall
          </p>
          <DataList
            empty="No funnel data."
            columns={[
              { key: "step", label: "Step", align: "right", render: (r) => r.step },
              { key: "event_name", label: "Event", mono: true, render: (r) => r.event_name },
              { key: "actors", label: "Actors", align: "right", render: (r) => fmt(r.actors) },
              { key: "conversion_from_previous", label: "From previous", align: "right", render: (r) => `${r.conversion_from_previous}%` },
              { key: "conversion_from_entry", label: "From entry", align: "right", render: (r) => `${r.conversion_from_entry}%` },
            ]}
            rows={result.steps || []}
          />
        </div>
      )}
    </Section>
  );
}