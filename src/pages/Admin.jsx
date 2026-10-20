import React from "react";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { useAdminConsole } from "@/hooks/useAdminConsole";
import AdminMetrics from "@/components/admin/AdminMetrics";
import AdminTable from "@/components/admin/AdminTable";

const short = (v) => (v ? String(v).slice(0, 10) : "—");
const when = (v) => (v ? new Date(v).toLocaleString() : "—");

// Platform operations console: read-only cross-account visibility. Every value shown here is
// served by the server after it verified the caller is a platform admin; the page performs no
// privileged action of its own.
export default function Admin() {
  const { data, loading, error, reload } = useAdminConsole(20);

  if (loading) {
    return <div className="flex-1 grid place-items-center py-20"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return (
      <div className="max-w-md mx-auto py-20 text-center">
        <ShieldAlert className="h-6 w-6 mx-auto text-muted-foreground" />
        <p className="mt-3 text-[13px] font-medium">Platform console unavailable</p>
        <p className="mt-1 text-[12px] text-muted-foreground">{error}</p>
      </div>
    );
  }

  const d = data;
  return (
    <div className="pb-10">
      <div className="flex items-baseline gap-3 px-4 py-3">
        <h1 className="text-[15px] font-semibold tracking-tight">Platform</h1>
        <span className="text-[11px] text-muted-foreground">read-only · generated {when(d.generated_at)}</span>
        <button onClick={reload} className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors">
          <RefreshCw className="h-3.5 w-3.5" />Refresh
        </button>
      </div>

      <AdminMetrics totals={d.totals} />

      <div className="px-4 mt-4 grid gap-3 lg:grid-cols-2">
        <AdminTable
          title="Workspaces" subtitle="status, credits, reservations"
          columns={[["Name", (r) => r.name], ["Status", (r) => r.status], ["Credits", (r) => (r.credits_balance ?? 0).toLocaleString()], ["Reserved", (r) => (r.reserved_credits ?? 0).toLocaleString()]]}
          rows={d.workspaces}
        />
        <AdminTable
          title="Users"
          columns={[["Email", (r) => r.email], ["Role", (r) => r.role], ["Joined", (r) => short(r.created_date)]]}
          rows={d.users}
        />
        <AdminTable
          title="Projects"
          columns={[["Name", (r) => r.name], ["Status", (r) => r.status], ["Version", (r) => r.version_count ?? 0], ["Build", (r) => r.last_build_status || "—"]]}
          rows={d.projects}
        />
        <AdminTable
          title="AI runs" subtitle="most recent"
          columns={[["Status", (r) => r.status], ["Mode", (r) => r.mode], ["Model", (r) => r.model || "—"], ["Credits", (r) => r.credits_charged ?? 0], ["When", (r) => short(r.created_date)]]}
          rows={d.runs}
        />
        <AdminTable
          title="Run failures" subtitle="failed and stale runs"
          columns={[["Status", (r) => r.status], ["Phase", (r) => r.phase || "—"], ["Error", (r) => r.error || "—"], ["Trace", (r) => r.trace_id || "—"]]}
          rows={d.run_failures} empty="No failures in the recent window."
        />
        <AdminTable
          title="Billing" subtitle="subscriptions"
          columns={[["Plan", (r) => r.plan_code || r.plan_id || "—"], ["Status", (r) => r.status], ["Interval", (r) => r.interval || "—"], ["Renews", (r) => short(r.current_period_end)]]}
          rows={d.billing.subscriptions} empty="No subscriptions."
        />
        <AdminTable
          title="Deployments"
          columns={[["Environment", (r) => r.environment], ["Status", (r) => r.status], ["Version", (r) => r.version_number ?? "—"], ["When", (r) => short(r.created_date)]]}
          rows={d.deployments} empty="No deployments."
        />
        <AdminTable
          title="Integrations" subtitle="MCP connections"
          columns={[["Name", (r) => r.name], ["Status", (r) => r.status], ["Enabled", (r) => (r.enabled ? "yes" : "no")], ["Tools", (r) => r.tool_count ?? "—"]]}
          rows={d.connections.mcp} empty="No MCP connections."
        />
        <AdminTable
          title="Source control" subtitle="GitHub links"
          columns={[["Repository", (r) => r.repo_full_name || r.repo || "—"], ["Branch", (r) => r.branch || "—"], ["Status", (r) => r.status || "—"], ["Synced", (r) => short(r.last_synced_at)]]}
          rows={d.connections.github} empty="No linked repositories."
        />
        <AdminTable
          title="Queue health" subtitle="dead-lettered jobs"
          columns={[["Queue", (r) => r.queue], ["Type", (r) => r.job_type], ["Attempts", (r) => `${r.attempts ?? 0}/${r.max_attempts ?? 0}`], ["Error", (r) => r.error_code || "—"]]}
          rows={d.jobs.dead_letters} empty="No dead-lettered jobs."
        />
        <AdminTable
          title="Background jobs" subtitle="most recent"
          columns={[["Queue", (r) => r.queue], ["Type", (r) => r.job_type], ["Status", (r) => r.status], ["When", (r) => short(r.created_date)]]}
          rows={d.jobs.recent} empty="No jobs."
        />
        <AdminTable
          title="Audit trail"
          columns={[["Action", (r) => r.action], ["Resource", (r) => r.resource || "—"], ["When", (r) => when(r.created_date)]]}
          rows={d.diagnostics.audit} empty="No audit entries."
        />
        <AdminTable
          title="Diagnostics" subtitle="recent trace spans"
          columns={[["Event", (r) => r.event_type], ["Name", (r) => r.name], ["Status", (r) => r.status], ["Attempt", (r) => r.attempt ?? 1], ["Duration", (r) => (r.duration_ms == null ? "—" : `${r.duration_ms}ms`)]]}
          rows={d.diagnostics.traces} empty="No trace spans."
        />
      </div>
    </div>
  );
}