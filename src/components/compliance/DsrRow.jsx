import React, { useState } from "react";
import { Mail, Clock, CheckCircle2, XCircle, Loader2, KeyRound, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/use-toast";

const STATUS_CONFIG = {
  pending: { label: "Pending", icon: Clock, className: "bg-muted text-muted-foreground" },
  verifying: { label: "Verifying", icon: Mail, className: "bg-blue-500/10 text-blue-600" },
  in_progress: { label: "In Progress", icon: Loader2, className: "bg-blue-500/10 text-blue-600" },
  completed: { label: "Completed", icon: CheckCircle2, className: "bg-emerald-500/10 text-emerald-600" },
  rejected: { label: "Rejected", icon: XCircle, className: "bg-destructive/10 text-destructive" },
  expired: { label: "Expired", icon: AlertCircle, className: "bg-muted text-muted-foreground" },
};

const TYPE_LABELS = {
  access: "Access / Export", deletion: "Deletion", portability: "Portability",
  rectification: "Rectification", restriction: "Restriction", objection: "Objection", opt_out_sale: "Opt-out of Sale",
};

export default function DsrRow({ dsr, onVerify, working, canManage, onComplete, onReject }) {
  const [showVerify, setShowVerify] = useState(false);
  const [token, setToken] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const cfg = STATUS_CONFIG[dsr.status] || STATUS_CONFIG.pending;
  const Icon = cfg.icon;
  const needsVerification = dsr.status === "verifying";
  const isOverdue = dsr.expires_at && Date.parse(dsr.expires_at) < Date.now() && !["completed", "rejected", "expired"].includes(dsr.status);

  const handleVerify = async () => {
    if (!token.trim()) return;
    try {
      const res = await onVerify(dsr.id, token.trim());
      if (res.duplicate) toast({ title: "Already verified" });
      else toast({ title: "Email verified", description: "Your request is now in progress." });
      setShowVerify(false);
      setToken("");
    } catch (e) {
      toast({ variant: "destructive", title: "Verification failed", description: e.response?.data?.error || e.message });
    }
  };

  const handleReject = async () => {
    try {
      await onReject(dsr.id, rejectReason);
      setRejectOpen(false);
      setRejectReason("");
      toast({ title: "Request rejected" });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not reject", description: e.response?.data?.error || e.message });
    }
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <span className={`h-8 w-8 rounded-lg grid place-items-center shrink-0 ${cfg.className}`}><Icon className="h-4 w-4" /></span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-[13px]">{TYPE_LABELS[dsr.request_type] || dsr.request_type}</span>
            <Badge variant="outline" className={`text-[10px] ${cfg.className}`}>{cfg.label}</Badge>
            {isOverdue && <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/20">Overdue</Badge>}
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground flex items-center gap-2 flex-wrap">
            <span className="font-mono truncate">{dsr.email}</span>
            <span>·</span>
            <span>filed {new Date(dsr.created_date).toLocaleDateString()}</span>
            {dsr.expires_at && <><span>·</span><span>deadline {new Date(dsr.expires_at).toLocaleDateString()}</span></>}
          </div>
        </div>
        {needsVerification && !showVerify && (
          <Button size="sm" variant="outline" onClick={() => setShowVerify(true)}><KeyRound className="h-3.5 w-3.5 mr-1.5" />Verify</Button>
        )}
        {canManage && dsr.status === "in_progress" && (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => onComplete(dsr.id)} disabled={working}>Complete</Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRejectOpen(true)} disabled={working}>Reject</Button>
          </div>
        )}
      </div>

      {showVerify && needsVerification && (
        <div className="mt-3 flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-[11px] text-muted-foreground">Enter the verification code from your email</label>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Verification code" className="mt-1 h-9 font-mono" />
          </div>
          <Button size="sm" onClick={handleVerify} disabled={working || !token.trim()}>
            {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}Verify
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowVerify(false)}>Cancel</Button>
        </div>
      )}

      {rejectOpen && canManage && (
        <div className="mt-3 space-y-2">
          <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Reason for rejection (required)" className="h-9" />
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={handleReject} disabled={working || !rejectReason.trim()}>Confirm rejection</Button>
            <Button size="sm" variant="ghost" onClick={() => setRejectOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {dsr.status === "rejected" && dsr.rejection_reason && (
        <div className="mt-2 text-[12px] text-muted-foreground bg-muted/50 rounded p-2">Reason: {dsr.rejection_reason}</div>
      )}
    </div>
  );
}