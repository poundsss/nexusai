import React, { useState } from "react";
import { Plus, Loader2, Database, Clock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";

const DATA_TYPES = [
  { value: "audit_logs", label: "Audit Logs", minDays: 365 },
  { value: "usage_events", label: "Usage Events", minDays: 90 },
  { value: "ai_operations", label: "AI Operations", minDays: 180 },
  { value: "deployments", label: "Deployments", minDays: 90 },
  { value: "billing_events", label: "Billing Events", minDays: 2555 },
  { value: "abuse_reports", label: "Abuse Reports", minDays: 365 },
  { value: "dsr_records", label: "DSR Records", minDays: 1095 },
  { value: "user_activity", label: "User Activity", minDays: 365 },
  { value: "support_tickets", label: "Support Tickets", minDays: 365 },
];

const ACTIONS = [
  { value: "delete", label: "Delete" },
  { value: "anonymize", label: "Anonymize" },
  { value: "archive", label: "Archive" },
];

export default function RetentionPolicyForm({ onCreate, working }) {
  const [open, setOpen] = useState(false);
  const [dataType, setDataType] = useState("audit_logs");
  const [days, setDays] = useState("");
  const [action, setAction] = useState("delete");
  const [legalBasis, setLegalBasis] = useState("");

  const selectedType = DATA_TYPES.find((t) => t.value === dataType);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const daysNum = Number(days);
    if (!Number.isFinite(daysNum) || daysNum <= 0) { toast({ variant: "destructive", title: "Enter a valid number of days" }); return; }
    if (selectedType && daysNum < selectedType.minDays) {
      toast({ variant: "destructive", title: `Minimum is ${selectedType.minDays} days`, description: `Legal minimum for ${selectedType.label} is ${selectedType.minDays} days.` });
      return;
    }
    try {
      await onCreate({ data_type: dataType, retention_days: daysNum, action, legal_basis: legalBasis || "contract" });
      setOpen(false); setDays(""); setLegalBasis("");
      toast({ title: "Retention policy created" });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not create policy", description: e.response?.data?.error || e.message });
    }
  };

  if (!open) {
    return <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5 mr-1.5" />New policy</Button>;
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-card p-4 space-y-3">
      <h3 className="font-medium text-[14px]">New Retention Policy</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="text-[12px]">Data type</Label>
          <select value={dataType} onChange={(e) => setDataType(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-[13px]">
            {DATA_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {selectedType && <p className="mt-1 text-[11px] text-muted-foreground">Legal minimum: {selectedType.minDays} days</p>}
        </div>
        <div>
          <Label htmlFor="retention-days" className="text-[12px]">Retention days</Label>
          <Input id="retention-days" type="number" value={days} onChange={(e) => setDays(e.target.value)} placeholder={String(selectedType?.minDays || 365)} className="mt-1 h-9" required />
        </div>
        <div>
          <Label className="text-[12px]">Action at expiry</Label>
          <select value={action} onChange={(e) => setAction(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-[13px]">
            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>
        <div>
          <Label htmlFor="legal-basis" className="text-[12px]">Legal basis</Label>
          <Input id="legal-basis" value={legalBasis} onChange={(e) => setLegalBasis(e.target.value)} placeholder="e.g. tax_law_7y, gdpr_minimization" className="mt-1 h-9" />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={working}>{working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}Create policy</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}