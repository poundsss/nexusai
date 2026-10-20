import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import GrowProjectPicker from "@/components/growthagent/GrowProjectPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Managed Ads optimization panel: weekly monitoring through the certified report chain,
// recommendations from synced metrics only, member-set guardrails, and approval-gated
// execution through the existing provider seam (fail-closed until credentials are configured).
const CHANNELS = ["google", "zernio:meta", "zernio:tiktok", "zernio:linkedin", "zernio:openai"];

export default function GrowOptimize({ workspace }) {
  const [projectId, setProjectId] = useState("");
  const [channel, setChannel] = useState("google");
  const [recs, setRecs] = useState([]);
  const [guardrail, setGuardrail] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = async (pid, ch) => {
    if (!pid) return;
    setError("");
    try {
      const out = await base44.functions.invoke("managedAds", { action: "recommend_list", project_id: pid, channel: ch });
      setRecs(out.data?.recommendations || []);
    } catch (e) { setError(e.response?.data?.error || e.message); }
  };
  useEffect(() => {
    if (!workspace?.id) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 1 })
      .then((d) => setProjectId(d.projects?.[0]?.id || ""));
  }, [workspace?.id]);
  useEffect(() => { load(projectId, channel); }, [projectId, channel]);

  const act = async (action, args = {}) => {
    if (!projectId) return;
    setBusy(true); setError(""); setNote("");
    try {
      const out = await base44.functions.invoke("managedAds", { action, project_id: projectId, channel, ...args });
      if (action === "guardrail_set") setNote("Guardrail saved for this channel.");
      if (action === "recommend_generate") {
        const blocked = out.data?.blocked;
        setNote(blocked ? `Monitoring is blocked: ${blocked} — nothing was recommended.` : `${out.data?.recommendations?.length || 0} recommendation(s) generated.`);
      }
      if (action === "recommendation_accept") setNote(out.data?.executed ? "Recommendation executed through the provider." : "Already executed.");
      await load(projectId, channel);
    } catch (e) { setError(e.response?.data?.error || e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6 text-foreground bg-card rounded-xl m-4">
      <GrowProjectPicker workspace={workspace} projectId={projectId} onChange={setProjectId} label="Project" />
      <div className="flex flex-wrap items-center gap-2">
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel"
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px]">
          {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Button disabled={busy} onClick={() => act("recommend_generate")}>Generate recommendations</Button>
        <div className="flex items-center gap-1.5">
          <Input className="w-44" placeholder="Max daily budget (micros)" inputMode="numeric" value={guardrail}
            onChange={(e) => setGuardrail(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Max daily budget in micros" />
          <Button variant="outline" disabled={busy || !guardrail} onClick={() => act("guardrail_set", { max_daily_budget_micros: Number(guardrail) })}>Set guardrail</Button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      {!projectId ? <p className="text-sm text-muted-foreground">Select or create a project first.</p>
        : !recs.length ? <p className="text-sm text-muted-foreground">No recommendations yet — generate them from this week's report.</p>
        : recs.map((r) => (
          <div key={`${r.report_id}:${r.campaign_id}`} className="rounded-lg border border-border p-3">
            <p className="font-medium text-[13.5px]">{r.campaign_name} <span className="text-muted-foreground">({r.recommendation.approval_state})</span></p>
            <p className="mt-1 text-[12.5px]">{r.recommendation.suggested_action}: {r.recommendation.reason}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">Basis: {r.recommendation.basis.impressions} impressions, {r.recommendation.basis.clicks} clicks, {r.recommendation.basis.conversions} conversions.</p>
            {r.recommendation.approval_state === "pending" && (
              <Button size="sm" variant="outline" disabled={busy} className="mt-2" onClick={() => act("recommendation_accept", { report_id: r.report_id, campaign_id: r.campaign_id })}>
                Approve &amp; execute
              </Button>
            )}
          </div>
        ))}
    </div>
  );
}