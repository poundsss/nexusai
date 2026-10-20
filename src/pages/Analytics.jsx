import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { Button } from "@/components/ui/button";
import AccountPage from "@/components/shell/AccountPage";
import Section from "@/components/shell/Section";
import MetricRow from "@/components/shell/MetricRow";
import DataList from "@/components/shell/DataList";
import ErrorState from "@/components/states/ErrorState";
import { RefreshCw } from "lucide-react";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmt = (v) => num(v).toLocaleString();

// Inline proportional bar: a share-of-total readout that stays legible at this density.
function ShareBar({ value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-foreground/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

export default function Analytics() {
  const { user, workspace, loading: wsLoading } = useWorkspace();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("commerce", { action: "summary", workspace_id: workspace.id });
      setData(res.data);
    } catch (e) {
      setError(e.message || "Failed to load usage");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [workspace]);

  const usage = data?.usage || {};
  const byModel = data?.by_model || [];
  const byProject = data?.by_project || [];
  const ops = data?.operations || [];
  const modelCreditTotal = byModel.reduce((s, m) => s + num(m.credits), 0);
  const projectCreditTotal = byProject.reduce((s, p) => s + num(p.credits), 0);

  return (
    <AccountPage
      workspace={workspace} user={user} loading={wsLoading || loading}
      title="Usage"
      subtitle="What your AI runs consumed — credits, operations and tokens, by model and by application."
      actions={<Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Refresh</Button>}
    >
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <div className="space-y-7">
          <MetricRow
            items={[
              { label: "Credits used", value: fmt(usage.total_credits), sub: "across all applications" },
              { label: "AI operations", value: fmt(usage.total_operations), sub: "billed runs" },
              { label: "Input tokens", value: fmt(usage.total_input_tokens), sub: "sent to models" },
              { label: "Output tokens", value: fmt(usage.total_output_tokens), sub: "generated" },
            ]}
          />

          <Section title="By model" description="Which models your builds routed to, and what each cost.">
            <DataList
              empty="No model usage yet — credits appear here after your first AI build."
              columns={[
                { key: "model_id", label: "Model", mono: true, render: (m) => m.model_id || "—" },
                { key: "count", label: "Calls", align: "right", render: (m) => fmt(m.count) },
                { key: "total_tokens", label: "Tokens", align: "right", render: (m) => fmt(m.total_tokens) },
                { key: "credits", label: "Credits", align: "right", render: (m) => fmt(m.credits) },
                { key: "share", label: "Share", align: "right", render: (m) => <ShareBar value={num(m.credits)} total={modelCreditTotal} /> },
              ]}
              rows={byModel}
            />
          </Section>

          <Section title="By application" description="Credit spend attributed to each project you are building.">
            <DataList
              empty="No application usage yet — build an app and its spend shows up here."
              columns={[
                { key: "name", label: "Application", render: (p) => p.name || p.project_id || "—" },
                { key: "count", label: "Runs", align: "right", render: (p) => fmt(p.count) },
                { key: "credits", label: "Credits", align: "right", render: (p) => fmt(p.credits) },
                { key: "share", label: "Share", align: "right", render: (p) => <ShareBar value={num(p.credits)} total={projectCreditTotal} /> },
              ]}
              rows={byProject}
            />
          </Section>

          <Section title="Recent operations" description="The most recent billable AI runs and how they settled.">
            <DataList
              empty="No operations yet."
              columns={[
                { key: "model_id", label: "Model", mono: true, render: (o) => o.model_id || "—" },
                { key: "status", label: "Status", render: (o) => <span className="capitalize text-muted-foreground">{o.status}</span> },
                { key: "credits_charged", label: "Credits", align: "right", render: (o) => fmt(o.credits_charged) },
                { key: "started_at", label: "When", align: "right", render: (o) => <span className="text-muted-foreground">{o.started_at ? new Date(o.started_at).toLocaleString() : "—"}</span> },
              ]}
              rows={ops}
            />
          </Section>
        </div>
      )}
    </AccountPage>
  );
}