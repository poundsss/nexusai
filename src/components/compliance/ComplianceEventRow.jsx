import React from "react";
import { ShieldCheck, FileText, Trash2, Download, AlertTriangle, Clock, Database, UserCheck, CheckCircle2 } from "lucide-react";

const EVENT_ICONS = {
  terms_accepted: ShieldCheck,
  dpa_signed: FileText,
  dsr_filed: Download,
  dsr_completed: CheckCircle2,
  dsr_rejected: AlertTriangle,
  breach_detected: AlertTriangle,
  breach_notified: AlertTriangle,
  data_deleted: Trash2,
  retention_applied: Clock,
  retention_policy_changed: Database,
  audit_completed: ShieldCheck,
  subprocessor_added: UserCheck,
  data_exported: Download,
  consent_withdrawn: ShieldCheck,
};

const EVENT_LABELS = {
  terms_accepted: "Terms Accepted",
  dpa_signed: "DPA Signed",
  dsr_filed: "DSR Filed",
  dsr_completed: "DSR Completed",
  dsr_rejected: "DSR Rejected",
  breach_detected: "Breach Detected",
  breach_notified: "Breach Notified",
  data_deleted: "Data Deleted",
  retention_applied: "Retention Applied",
  retention_policy_changed: "Retention Policy Changed",
  audit_completed: "Audit Completed",
  subprocessor_added: "Subprocessor Added",
  data_exported: "Data Exported",
  consent_withdrawn: "Consent Withdrawn",
};

export default function ComplianceEventRow({ event }) {
  const Icon = EVENT_ICONS[event.event_type] || ShieldCheck;
  const label = EVENT_LABELS[event.event_type] || event.event_type.replace(/_/g, " ");

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 text-[12px] border-b border-border/40 last:border-0">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{label}</span>
          <span className="text-muted-foreground font-mono text-[11px]">{event.legal_basis}</span>
        </div>
        {event.description && <p className="mt-0.5 text-muted-foreground line-clamp-2">{event.description}</p>}
        <div className="mt-0.5 text-[11px] text-muted-foreground/60">
          {new Date(event.created_date).toLocaleString()}
          {event.actor_id && <span> · by {event.actor_id.slice(0, 8)}</span>}
        </div>
      </div>
    </div>
  );
}