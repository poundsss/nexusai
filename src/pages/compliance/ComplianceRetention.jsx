import React, { useState } from "react";
import { Database, Info, Search, Loader2, AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useRetentionPolicies } from "@/hooks/useCompliance";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import RetentionPolicyForm from "@/components/compliance/RetentionPolicyForm";
import RetentionPolicyRow from "@/components/compliance/RetentionPolicyRow";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";

// Data types the certified `compliance` `find_expired` action knows how to scan. These mirror the
// backend's fixed entityMap (audit_logs, usage_events, ai_operations, deployments, billing_events,
// abuse_reports, dsr_records) — no new data type is invented. find_expired returns { policy, expired }
// where `expired` is a sample of record IDs past their retention cutoff; deletion itself is a
// platform integration point and is NOT invoked here (delete_retention removes a POLICY, not data).
const EXPIRABLE_TYPES = [
  { id: "audit_logs", label: "Audit Logs" },
  { id: "usage_events", label: "Usage Events" },
  { id: "ai_operations", label: "AI Operations" },
  { id: "deployments", label: "Deployments" },
  { id: "billing_events", label: "Billing Events" },
  { id: "abuse_reports", label: "Abuse Reports" },
  { id: "dsr_records", label: "DSR Records" },
];

const LEGAL_MINIMUMS = [
  { type: "Audit Logs", days: 365, basis: "1 year — audit trail retention" },
  { type: "Billing Events", days: 2555, basis: "7 years — tax law" },
  { type: "Abuse Reports", days: 365, basis: "1 year — trust & safety" },
  { type: "DSR Records", days: 1095, basis: "3 years — GDPR accountability" },
  { type: "Usage Events", days: 90, basis: "3 months — operational" },
  { type: "AI Operations", days: 180, basis: "6 months — operational" },
  { type: "Deployments", days: 90, basis: "3 months — operational" },
  { type: "User Activity", days: 365, basis: "1 year — security" },
  { type: "Support Tickets", days: 365, basis: "1 year — support" },
];

export default function ComplianceRetention() {
  const { workspace, capabilities } = useWorkspace();
  const retention = useRetentionPolicies(workspace?.id);
  const canManage = (capabilities || []).includes("retention.manage");
  const canRead = (capabilities || []).includes("compliance.read");
  const [scanType, setScanType] = useState(EXPIRABLE_TYPES[0].id);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [scanError, setScanError] = useState(null);

  // find_expired — the certified compliance.read action. Returns the active policy for the data
  // type and a sample of record IDs past their retention cutoff. Reuses existing permission,
  // loading and error patterns; no data is deleted (deletion is a platform integration point).
  const findExpired = async () => {
    setScanBusy(true); setScanResult(null); setScanError(null);
    try {
      const res = await base44.functions.invoke("compliance", { action: "find_expired", workspace_id: workspace?.id || null, data_type: scanType });
      setScanResult(res.data);
    } catch (e) {
      setScanError(e.response?.data?.error || e.message);
      toast({ variant: "destructive", title: "Scan failed", description: e.response?.data?.error || e.message });
    } finally { setScanBusy(false); }
  };

  if (retention.loading) return <AccountPage loading title="Retention Policies" subtitle="Data retention settings and legal minimums."><div /></AccountPage>;
  if (retention.error) return <AccountPage title="Retention Policies" subtitle="Data retention settings and legal minimums."><ErrorState message={retention.error} onRetry={retention.reload} /></AccountPage>;

  return (
    <AccountPage
      title="Retention Policies"
      subtitle="How long each data type is retained, and what happens at expiry. Legal minimums are enforced server-side."
    >
      {/* Create form */}
      {canManage && <div className="mb-5"><RetentionPolicyForm onCreate={retention.create} working={retention.working} /></div>}

      {/* Active policies */}
      <h3 className="text-[14px] font-semibold mb-3">Active Policies</h3>
      {retention.policies.length === 0 ? (
        <EmptyState icon={Database} title="No retention policies" description={canManage ? "Create a policy above to set retention for a data type." : "No workspace-specific retention policies are configured. The platform defaults apply."} />
      ) : (
        <div className="space-y-2">
          {retention.policies.map((p) => <RetentionPolicyRow key={p.id} policy={p} onRemove={retention.remove} working={retention.working} />)}
        </div>
      )}

      {/* Find expired records (compliance.read) — delete_retention is already exposed per policy
          above via each row's remove action (retention.remove → delete_retention). */}
      {canRead && (
        <div className="mt-6">
          <h3 className="text-[14px] font-semibold mb-3 flex items-center gap-2"><Search className="h-4 w-4 text-muted-foreground" />Find expired records</h3>
          <div className="rounded-lg border border-border p-4">
            <p className="text-[12px] text-muted-foreground mb-3">Scan a data type for records past its retention cutoff. Returns the active policy and a sample of expired record IDs — deletion is a platform integration point and is not triggered here. <span className="font-medium">delete_retention</span> (remove a policy) is the per-row trash action above.</p>
            <div className="flex items-center gap-2">
              <select value={scanType} onChange={(e) => { setScanType(e.target.value); setScanResult(null); setScanError(null); }} className="h-8 rounded-md border border-border bg-background px-2 text-[12.5px]">
                {EXPIRABLE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <Button size="sm" onClick={findExpired} disabled={scanBusy}>
                {scanBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}Find expired
              </Button>
            </div>
            {scanError && (
              <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-[12px] text-muted-foreground">{scanError}</p>
              </div>
            )}
            {scanResult && (
              <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 text-[12.5px]">
                {!scanResult.policy ? (
                  <p className="text-muted-foreground">No active retention policy for <span className="font-mono">{scanType}</span> (or retention_days is 0 — keep indefinitely).</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Policy:</span>
                      <span className="font-mono text-[11.5px] text-muted-foreground">{scanResult.policy.data_type} · {scanResult.policy.retention_days} days · {scanResult.policy.action}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="font-medium">Expired records (sample):</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">{scanResult.expired?.length || 0}</span>
                    </div>
                    {scanResult.expired?.length > 0 && (
                      <ul className="mt-2 max-h-32 overflow-y-auto rounded border border-border bg-background p-2 font-mono text-[10.5px] text-muted-foreground space-y-0.5">
                        {scanResult.expired.slice(0, 50).map((id) => <li key={id} className="truncate">{id}</li>)}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Legal minimums */}
      <div className="mt-6">
        <h3 className="text-[14px] font-semibold mb-3 flex items-center gap-2"><Info className="h-4 w-4 text-muted-foreground" />Legal Minimums</h3>
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/30">
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">Data type</th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground">Minimum days</th>
                <th className="text-left py-2 px-3 font-medium text-muted-foreground hidden sm:table-cell">Basis</th>
              </tr>
            </thead>
            <tbody>
              {LEGAL_MINIMUMS.map((m) => (
                <tr key={m.type} className="border-b border-border/40 last:border-0">
                  <td className="py-2 px-3 font-medium">{m.type}</td>
                  <td className="py-2 px-3 text-right font-mono">{m.days}</td>
                  <td className="py-2 px-3 text-muted-foreground hidden sm:table-cell">{m.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AccountPage>
  );
}