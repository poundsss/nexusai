import React, { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

const TYPES = ["PERFORMANCE_MAX", "SEARCH", "DEMAND_GEN", "DISPLAY"];
const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-ring";

// Structured inputs only: campaign type, goal, audience, daily budget. Briefs are Google Ads copy plans.
export default function BriefGenerateForm({ busy, onGenerate, prefill }) {
  const [v, setV] = useState({ campaign_type: "PERFORMANCE_MAX", goal: prefill?.goal || "", audience: prefill?.audience || "", budget: "" });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });

  const submit = (e) => {
    e.preventDefault();
    if (!v.goal.trim()) return setError("Add a campaign goal.");
    if (v.budget !== "" && !(Number(v.budget) > 0)) return setError("Daily budget must be a positive number.");
    setError(null);
    onGenerate(v);
  };

  return (
    <form onSubmit={submit} className="grid gap-2 rounded-md border border-border bg-muted/30 p-2.5 sm:grid-cols-2">
      <select value={v.campaign_type} onChange={set("campaign_type")} className={field}>
        {TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
      </select>
      <input value={v.budget} onChange={set("budget")} inputMode="decimal" placeholder="Daily budget (USD, optional)" className={field} />
      <input value={v.goal} onChange={set("goal")} maxLength={400} placeholder="Campaign goal *" className={`${field} sm:col-span-2`} />
      <input value={v.audience} onChange={set("audience")} maxLength={400} placeholder="Audience (optional)" className={`${field} sm:col-span-2`} />
      {prefill && (prefill.goal || prefill.audience) && <p className="text-[11px] text-muted-foreground sm:col-span-2">Goal and audience prefilled from this project's marketing plan — edit freely.</p>}
      {prefill?.suggestedDaily && (
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground sm:col-span-2">
          Suggestion only: ${prefill.suggestedDaily}/day from the plan's ${prefill.monthly}/month. Google's per-currency minimum is checked at launch.
          <button type="button" onClick={() => setV({ ...v, budget: String(prefill.suggestedDaily) })} className="rounded border border-border px-1.5 py-0.5 text-foreground hover:bg-accent">Apply suggestion</button>
        </p>
      )}
      {error && <p className="text-[11.5px] text-destructive sm:col-span-2">{error}</p>}
      <button type="submit" disabled={busy} className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-60 sm:col-span-2">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {busy ? "Generating…" : "Generate brief"}
      </button>
    </form>
  );
}