import React, { useState } from "react";
import { Clock, CheckCircle2, XCircle, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";

const STATUS_CFG = {
  open: { label: "Open", className: "bg-blue-500/10 text-blue-600" },
  investigating: { label: "Investigating", className: "bg-amber-500/10 text-amber-600" },
  actioned: { label: "Actioned", className: "bg-emerald-500/10 text-emerald-600" },
  dismissed: { label: "Dismissed", className: "bg-muted text-muted-foreground" },
  escalated: { label: "Escalated", className: "bg-destructive/10 text-destructive" },
};

const RESOLUTIONS = [
  { value: "warning", label: "Warning" },
  { value: "suspension", label: "Suspend target" },
  { value: "termination", label: "Terminate target" },
  { value: "no_action", label: "No action (dismiss)" },
  { value: "legal_referral", label: "Legal referral" },
];

export default function AbuseReportRow({ report, onAssign, onResolve, working }) {
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolution, setResolution] = useState("no_action");
  const [note, setNote] = useState("");
  const cfg = STATUS_CFG[report.status] || STATUS_CFG.open;
  const isOverdue = report.sla_due_at && Date.parse(report.sla_due_at) < Date.now() && !["actioned", "dismissed"].includes(report.status);

  const handleResolve = async () => {
    try {
      await onResolve(report.id, resolution, note);
      setResolveOpen(false);
      setNote("");
      toast({ title: "Report resolved" });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not resolve", description: e.response?.data?.error || e.message });
    }
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`text-[10px] ${cfg.className}`}>{cfg.label}</Badge>
            <span className="text-[12px] font-mono text-muted-foreground">{report.category}</span>
            {report.auto_suspended && <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/20">Auto-suspended</Badge>}
            {isOverdue && <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/20">SLA overdue</Badge>}
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            Target: <span className="font-mono">{report.target_type}:{report.target_id}</span>
            {report.sla_due_at && <span className="ml-2">SLA: {new Date(report.sla_due_at).toLocaleDateString()}</span>}
          </div>
          {report.description && <p className="mt-1.5 text-[12px] text-foreground/80 line-clamp-2">{report.description}</p>}
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {report.status === "open" && <Button size="sm" variant="outline" onClick={() => onAssign(report.id)} disabled={working}>Assign to me</Button>}
          {!["actioned", "dismissed"].includes(report.status) && !resolveOpen && <Button size="sm" variant="ghost" onClick={() => setResolveOpen(true)} disabled={working}>Resolve</Button>}
        </div>
      </div>
      {resolveOpen && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground">Resolution:</label>
            <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-[12px]">
              {RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Resolution note (optional)" />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleResolve} disabled={working}>{working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}Confirm</Button>
            <Button size="sm" variant="ghost" onClick={() => setResolveOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {report.status === "actioned" && report.resolution_note && (
        <div className="mt-2 text-[12px] text-muted-foreground bg-muted/50 rounded p-2">Resolution: {report.resolution} — {report.resolution_note}</div>
      )}
    </div>
  );
}