import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { briefCall, toMicros } from "./briefApi";
import BriefGenerateForm from "./BriefGenerateForm";
import BriefRow from "./BriefRow";
import usePlanPrefill from "./usePlanPrefill";

// Campaign briefs for the selected project — plans only: no provider call, no launch, no spend.
export default function DashBriefs({ projectId }) {
  const [briefs, setBriefs] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const prefill = usePlanPrefill(projectId, formOpen);

  const load = useCallback(async () => {
    setBriefs(null); setError(null);
    try { setBriefs((await briefCall("brief_list", projectId)).briefs || []); }
    catch (e) { setError(e.message); setBriefs([]); }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const generate = async (v) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await briefCall("brief_generate", projectId, { campaign_type: v.campaign_type, goal: v.goal.trim(), audience: v.audience.trim() });
      // The generate contract has no budget input; the existing brief_update persists it.
      if (v.budget !== "") await briefCall("brief_update", projectId, { brief_id: res.brief.id, budget_micros: toMicros(v.budget) });
      setNotice(res.generation_warning ? "Brief saved, but generation returned no usable copy — edit it below." : "Brief generated and saved.");
      setFormOpen(false);
      await load();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const save = async (briefId, patch) => {
    const res = await briefCall("brief_update", projectId, { brief_id: briefId, ...patch });
    setBriefs((cur) => cur.map((b) => (b.id === briefId ? res.brief : b)));
    setNotice("Brief saved.");
  };

  return (
    <section className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-2 pt-1">
        <h2 className="text-[14px] font-semibold text-foreground">Campaign briefs</h2>
        <button type="button" onClick={() => setFormOpen(!formOpen)} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[12px] hover:bg-accent">
          {formOpen ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}{formOpen ? "Close" : "New brief"}
        </button>
      </div>
      <p className="pb-2 text-[11.5px] text-muted-foreground">Google Ads copy plans. Saving a brief never launches a campaign or spends money.</p>
      {formOpen && (prefill === undefined
        ? <div className="grid place-items-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        : <BriefGenerateForm busy={busy} onGenerate={generate} prefill={prefill} />)}
      {notice && <p className="pt-2 text-[11.5px] text-muted-foreground">{notice}</p>}
      {error && <p className="pt-2 text-[11.5px] text-destructive">{error}</p>}
      {briefs === null ? (
        <div className="grid place-items-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : briefs.length === 0 ? (
        <p className="py-4 text-center text-[12px] text-muted-foreground">No briefs yet for this project.</p>
      ) : (
        <ul className="divide-y divide-border">{briefs.map((b) => <BriefRow key={b.id} brief={b} onSave={save} projectId={projectId} />)}</ul>
      )}
    </section>
  );
}