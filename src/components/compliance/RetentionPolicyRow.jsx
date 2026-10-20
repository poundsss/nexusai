import React, { useState } from "react";
import { Database, Clock, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/use-toast";
import ConfirmDialog from "@/components/enterprise/ConfirmDialog";

const TYPE_LABELS = {
  audit_logs: "Audit Logs", usage_events: "Usage Events", ai_operations: "AI Operations",
  deployments: "Deployments", billing_events: "Billing Events", abuse_reports: "Abuse Reports",
  dsr_records: "DSR Records", user_activity: "User Activity", support_tickets: "Support Tickets",
};

const ACTION_STYLES = {
  delete: "bg-destructive/10 text-destructive",
  anonymize: "bg-blue-500/10 text-blue-600",
  archive: "bg-amber-500/10 text-amber-600",
};

export default function RetentionPolicyRow({ policy, onRemove, working }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const scope = policy.workspace_id ? "Workspace" : "Platform default";

  const handleRemove = async () => {
    try {
      await onRemove(policy.id);
      setConfirmOpen(false);
      toast({ title: "Retention policy removed" });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not remove", description: e.response?.data?.error || e.message });
    }
  };

  return (
    <div className="rounded-lg border border-border p-3 flex items-center gap-3">
      <span className="h-8 w-8 rounded-lg bg-muted grid place-items-center shrink-0"><Database className="h-4 w-4 text-muted-foreground" /></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-[13px]">{TYPE_LABELS[policy.data_type] || policy.data_type}</span>
          <Badge variant="outline" className={`text-[10px] ${ACTION_STYLES[policy.action] || ""}`}>{policy.action}</Badge>
          <Badge variant="outline" className="text-[10px] text-muted-foreground">{scope}</Badge>
        </div>
        <div className="mt-0.5 text-[12px] text-muted-foreground flex items-center gap-2">
          <Clock className="h-3 w-3" />
          <span>{policy.retention_days === 0 ? "Retained indefinitely (legal hold)" : `${policy.retention_days} days`}</span>
          {policy.legal_basis && <span>· {policy.legal_basis}</span>}
        </div>
      </div>
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirmOpen(true)} disabled={working}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
      <ConfirmDialog
        open={confirmOpen} onOpenChange={setConfirmOpen}
        title="Remove retention policy?"
        description="Records will be retained according to the platform default policy for this data type."
        confirmLabel="Remove" destructive working={working} onConfirm={handleRemove}
      />
    </div>
  );
}