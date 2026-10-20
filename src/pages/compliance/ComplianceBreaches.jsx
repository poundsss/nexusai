import React, { useState } from "react";
import { AlertTriangle, Plus, Loader2 } from "lucide-react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useBreaches } from "@/hooks/useCompliance";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import ErrorState from "@/components/states/ErrorState";
import BreachRow from "@/components/compliance/BreachRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";

const SEVERITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

export default function ComplianceBreaches() {
  const { workspace, capabilities } = useWorkspace();
  const breaches = useBreaches(workspace?.id);
  const canManage = (capabilities || []).includes("breach.manage");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ severity: "medium", description: "", affected_user_count: "", detected_at: "" });

  const handleReport = async (e) => {
    e.preventDefault();
    if (!form.description.trim()) { toast({ variant: "destructive", title: "Description is required" }); return; }
    try {
      await breaches.report({
        severity: form.severity,
        description: form.description.trim(),
        affected_user_count: Number(form.affected_user_count) || 0,
        detected_at: form.detected_at || undefined,
      });
      setShowForm(false);
      setForm({ severity: "medium", description: "", affected_user_count: "", detected_at: "" });
      toast({ title: "Breach reported", description: "The 72-hour notification clock has started for high/critical severity." });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not report", description: e.response?.data?.error || e.message });
    }
  };

  if (breaches.loading) return <AccountPage loading title="Data Breaches" subtitle="Breach response and notification tracking."><div /></AccountPage>;
  if (breaches.error) return <AccountPage title="Data Breaches" subtitle="Breach response and notification tracking."><ErrorState message={breaches.error} onRetry={breaches.reload} /></AccountPage>;

  return (
    <AccountPage
      title="Data Breaches"
      subtitle="Track and manage data breach response. High and critical severity breaches trigger a 72-hour GDPR notification clock."
      actions={canManage && <Button size="sm" onClick={() => setShowForm(!showForm)}><Plus className="h-3.5 w-3.5 mr-1.5" />{showForm ? "Cancel" : "Report breach"}</Button>}
    >
      {/* Report form */}
      {showForm && canManage && (
        <form onSubmit={handleReport} className="mb-5 rounded-xl border border-border bg-card p-4 space-y-3">
          <h3 className="font-medium text-[14px]">Report a Data Breach</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-[12px]">Severity</Label>
              <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-[13px]">
                {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-[12px]">Affected user count</Label>
              <Input type="number" value={form.affected_user_count} onChange={(e) => setForm({ ...form, affected_user_count: e.target.value })} placeholder="0" className="mt-1 h-9" />
            </div>
            <div>
              <Label className="text-[12px]">Detected at (optional)</Label>
              <Input type="datetime-local" value={form.detected_at} onChange={(e) => setForm({ ...form, detected_at: e.target.value })} className="mt-1 h-9" />
            </div>
          </div>
          <div>
            <Label className="text-[12px]">Description</Label>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} placeholder="What happened? Be factual." className="mt-1" />
          </div>
          <Button type="submit" size="sm" disabled={breaches.working}>{breaches.working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}Report breach</Button>
        </form>
      )}

      {/* Breach list */}
      {breaches.breaches.length === 0 ? (
        <EmptyState icon={AlertTriangle} title="No data breaches" description={canManage ? "Report a breach above to start tracking the response." : "No data breaches have been reported."} />
      ) : (
        <div className="space-y-3">
          {breaches.breaches.map((b) => (
            <BreachRow key={b.id} breach={b} onContain={breaches.contain} onResolve={breaches.resolve} onNotifyRegulator={breaches.notifyRegulator} onNotifyUsers={breaches.notifyUsers} working={breaches.working} />
          ))}
        </div>
      )}
    </AccountPage>
  );
}