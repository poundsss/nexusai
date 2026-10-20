import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { toLines, toMicros, fromMicros } from "./briefApi";

const area = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-ring";

export default function BriefEditor({ brief, onSave, onCancel }) {
  const [v, setV] = useState({
    headlines: brief.headlines.join("\n"), descriptions: brief.descriptions.join("\n"),
    keywords: brief.keywords.join("\n"), landing_page: brief.landing_page, budget: fromMicros(brief.budget_micros),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });

  const save = async () => {
    if (v.budget !== "" && !(Number(v.budget) > 0)) return setError("Daily budget must be a positive number.");
    if (v.landing_page && !/^https?:\/\//i.test(v.landing_page)) return setError("Landing page must start with http:// or https://");
    setSaving(true); setError(null);
    try {
      await onSave({ headlines: toLines(v.headlines), descriptions: toLines(v.descriptions), keywords: toLines(v.keywords), landing_page: v.landing_page.trim(), budget_micros: toMicros(v.budget) });
    } catch (e) { setError(e.message); setSaving(false); }
  };

  const box = (label, k, rows) => (
    <label className="block text-[11px] text-muted-foreground">{label}
      <textarea rows={rows} value={v[k]} onChange={set(k)} className={`${area} mt-0.5`} />
    </label>
  );
  return (
    <div className="space-y-2 pt-2">
      {box("Headlines (one per line)", "headlines", 3)}
      {box("Descriptions (one per line)", "descriptions", 3)}
      {box("Keywords (one per line)", "keywords", 2)}
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={v.landing_page} onChange={set("landing_page")} placeholder="Landing page URL" className={area} />
        <input value={v.budget} onChange={set("budget")} inputMode="decimal" placeholder="Daily budget (USD)" className={area} />
      </div>
      {error && <p className="text-[11.5px] text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-accent">Cancel</button>
        <button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[12px] text-primary-foreground disabled:opacity-60">
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}Save
        </button>
      </div>
    </div>
  );
}