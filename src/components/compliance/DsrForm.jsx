import React, { useState } from "react";
import { Download, Trash2, FileOutput, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";

const REQUEST_TYPES = [
  { value: "access", label: "Access / Export", icon: Download, description: "Receive a copy of the personal data we hold about you." },
  { value: "portability", label: "Data Portability", icon: FileOutput, description: "Receive your data in a machine-readable format." },
  { value: "deletion", label: "Delete My Data", icon: Trash2, description: "Permanently erase your personal data. This is irreversible." },
  { value: "rectification", label: "Correct Data", icon: FileOutput, description: "Fix inaccurate or incomplete personal data." },
  { value: "restriction", label: "Restrict Processing", icon: FileOutput, description: "Ask us to limit how we use your data." },
  { value: "objection", label: "Object to Processing", icon: FileOutput, description: "Object to certain data processing activities." },
];

export default function DsrForm({ onFile, working, defaultEmail }) {
  const [email, setEmail] = useState(defaultEmail || "");
  const [requestType, setRequestType] = useState("access");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isDeletion = requestType === "deletion";

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    if (isDeletion && !confirmOpen) { setConfirmOpen(true); return; }
    try {
      const res = await onFile({ email: email.trim(), request_type: requestType });
      setConfirmOpen(false);
      toast({
        title: "Request submitted",
        description: `A verification email has been sent to ${email.trim()}. Check your inbox and enter the code to verify.`,
      });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not submit request", description: e.response?.data?.error || e.message });
    }
  };

  if (confirmOpen && isDeletion) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-medium text-[14px] text-amber-900 dark:text-amber-200">Confirm permanent deletion</h3>
            <p className="mt-1 text-[12px] text-amber-800 dark:text-amber-300/80">
              This will permanently erase your personal data from this workspace. The action is irreversible. A verification email will be sent to <span className="font-medium">{email}</span> — the deletion only proceeds after you verify.
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="destructive" size="sm" onClick={handleSubmit} disabled={working}>
                {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                Send verification email
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={working}>Cancel</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-card p-4">
      <h3 className="font-medium text-[14px] mb-3">Submit a Data Subject Request</h3>
      <div className="space-y-3">
        <div>
          <Label htmlFor="dsr-email" className="text-[12px]">Email address</Label>
          <Input id="dsr-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="mt-1 h-9" required />
          <p className="mt-1 text-[11px] text-muted-foreground">A verification email will be sent to this address. The request only proceeds after verification.</p>
        </div>
        <div>
          <Label className="text-[12px]">Request type</Label>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {REQUEST_TYPES.map((t) => {
              const Icon = t.icon;
              const selected = requestType === t.value;
              return (
                <button key={t.value} type="button" onClick={() => setRequestType(t.value)}
                  className={`flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors ${selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                  <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${selected ? "text-primary" : "text-muted-foreground"}`} />
                  <div className="min-w-0">
                    <div className={`text-[12px] font-medium ${selected ? "text-foreground" : "text-muted-foreground"}`}>{t.label}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{t.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <Button type="submit" disabled={working || !email.trim()} size="sm">
          {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
          {isDeletion ? "Continue to confirmation" : "Submit request"}
        </Button>
      </div>
    </form>
  );
}