import React, { useState } from "react";
import { AlertTriangle, Clock, ShieldCheck, Loader2, Send, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";

const STATUS_CFG = {
  detected: { label: "Detected", className: "bg-destructive/10 text-destructive" },
  investigating: { label: "Investigating", className: "bg-amber-500/10 text-amber-600" },
  contained: { label: "Contained", className: "bg-blue-500/10 text-blue-600" },
  resolved: { label: "Resolved", className: "bg-emerald-500/10 text-emerald-600" },
  notified: { label: "Notified", className: "bg-emerald-500/10 text-emerald-600" },
};

const SEVERITY_STYLES = {
  critical: "bg-destructive/10 text-destructive border-destructive/20",
  high: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  medium: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  low: "bg-muted text-muted-foreground border-border",
};

export default function BreachRow({ breach, onContain, onResolve, onNotifyRegulator, onNotifyUsers, working }) {
  const [action, setAction] = useState(null);
  const [input, setInput] = useState("");
  const cfg = STATUS_CFG[breach.status] || STATUS_CFG.detected;
  const isOverdue = breach.notification_required && !breach.regulator_notified_at && breach.notification_deadline && Date.parse(breach.notification_deadline) < Date.now();

  const run = async (fn, label) => {
    try { await fn(); setAction(null); setInput(""); toast({ title: label }); }
    catch (e) { toast({ variant: "destructive", title: "Action failed", description: e.response?.data?.error || e.message }); }
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start gap-3">
        <span className={`h-8 w-8 rounded-lg grid place-items-center shrink-0 ${SEVERITY_STYLES[breach.severity] || ""}`}>
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`text-[10px] ${cfg.className}`}>{cfg.label}</Badge>
            <Badge variant="outline" className={`text-[10px] ${SEVERITY_STYLES[breach.severity] || ""}`}>{breach.severity}</Badge>
            {breach.notification_required && <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/20">72h notification</Badge>}
            {isOverdue && <Badge variant="outline" className="text-[10px] bg-destructive/10 text-destructive border-destructive/20">Overdue</Badge>}
          </div>
          <p className="mt-1 text-[12px] text-foreground/80 line-clamp-2">{breach.description}</p>
          <div className="mt-1 text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
            <Clock className="h-3 w-3" />
            <span>detected {new Date(breach.detected_at).toLocaleString()}</span>
            {breach.affected_user_count > 0 && <span>· {breach.affected_user_count} users affected</span>}
            {breach.notification_deadline && <span>· deadline {new Date(breach.notification_deadline).toLocaleString()}</span>}
          </div>
          {breach.root_cause && <div className="mt-1 text-[11px] text-muted-foreground">Root cause: {breach.root_cause}</div>}
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {breach.status === "detected" && (
          <Button size="sm" variant="outline" onClick={() => setAction("contain")} disabled={working}>Contain</Button>
        )}
        {breach.status === "contained" && (
          <Button size="sm" variant="outline" onClick={() => setAction("resolve")} disabled={working}>Resolve</Button>
        )}
        {breach.notification_required && !breach.regulator_notified_at && (
          <Button size="sm" variant="outline" onClick={() => run(() => onNotifyRegulator(breach.id), "Regulator notified")} disabled={working}>
            <Send className="h-3.5 w-3.5 mr-1" />Notify regulator
          </Button>
        )}
        {breach.notification_required && !breach.users_notified_at && (
          <Button size="sm" variant="outline" onClick={() => run(() => onNotifyUsers(breach.id), "Users notified")} disabled={working}>
            <Mail className="h-3.5 w-3.5 mr-1" />Notify users
          </Button>
        )}
      </div>

      {/* Inline action forms */}
      {action === "contain" && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div>
            <Label className="text-[11px]">Root cause</Label>
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="What caused the breach?" className="mt-1 h-9" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => run(() => onContain(breach.id, input), "Breach contained")} disabled={working || !input.trim()}>
              {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}Confirm containment
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAction(null); setInput(""); }}>Cancel</Button>
          </div>
        </div>
      )}
      {action === "resolve" && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div>
            <Label className="text-[11px]">Remediation</Label>
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="How was this resolved?" className="mt-1 h-9" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => run(() => onResolve(breach.id, input), "Breach resolved")} disabled={working || !input.trim()}>
              {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}Confirm resolution
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAction(null); setInput(""); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}