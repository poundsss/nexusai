import React, { useEffect, useState } from "react";
import { Loader2, ArrowLeftRight, Check, X } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import PageHeader from "@/components/states/PageHeader";

// Recipient surface for pending Transfer Ownership requests addressed to the authenticated user.
// The recipient chooses a destination workspace they own and accepts or declines — exactly the
// documented Base44 flow. No real email is sent; the recipient discovers pending transfers here.
export default function Transfers() {
  const [transfers, setTransfers] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [selected, setSelected] = useState({}); // project_id -> target_workspace_id
  const [busy, setBusy] = useState({}); // project_id -> "accept" | "decline"

  const load = async () => {
    const [t, w] = await Promise.all([
      base44.functions.invoke("transferProject", { op: "list_pending" }),
      base44.functions.invoke("transferProject", { op: "my_workspaces" }),
    ]);
    const tList = t.data?.transfers || [];
    const wList = w.data?.workspaces || [];
    setTransfers(tList);
    setWorkspaces(wList);
    // Default the selection to the first owned workspace for each transfer.
    setSelected((prev) => {
      const next = { ...prev };
      for (const tr of tList) if (!next[tr.project_id]) next[tr.project_id] = wList[0]?.id || "";
      return next;
    });
  };

  useEffect(() => { load().catch((e) => toast({ title: "Could not load transfers", description: e.message, variant: "destructive" })); }, []);

  const accept = async (tr) => {
    const target = selected[tr.project_id];
    if (!target) { toast({ title: "Choose a destination workspace", variant: "destructive" }); return; }
    setBusy((b) => ({ ...b, [tr.project_id]: "accept" }));
    try {
      await base44.functions.invoke("transferProject", { op: "accept", project_id: tr.project_id, target_workspace_id: target });
      toast({ title: "App accepted", description: "Ownership transferred to your workspace. AI chat history was cleared on the way over." });
      await load();
    } catch (e) {
      toast({ title: "Could not accept", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally { setBusy((b) => ({ ...b, [tr.project_id]: null })); }
  };

  const decline = async (tr) => {
    setBusy((b) => ({ ...b, [tr.project_id]: "decline" }));
    try {
      await base44.functions.invoke("transferProject", { op: "decline", project_id: tr.project_id });
      toast({ title: "Transfer declined" });
      await load();
    } catch (e) {
      toast({ title: "Could not decline", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally { setBusy((b) => ({ ...b, [tr.project_id]: null })); }
  };

  const loading = transfers === null;

  return (
    <div className="min-h-full max-w-3xl mx-auto px-6 py-10">
      <PageHeader title="Incoming app transfers" subtitle="Ownership transfers sent to your email. Accept into a workspace you own, or decline." />
      <div className="mt-6 space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
        ) : transfers.length === 0 ? (
          <div className="rounded-md border border-border bg-muted/30 px-4 py-8 text-center">
            <ArrowLeftRight className="h-5 w-5 mx-auto text-muted-foreground/50" />
            <p className="mt-2 text-[13px] text-muted-foreground">No pending transfers addressed to you.</p>
          </div>
        ) : (
          transfers.map((tr) => {
            const expired = tr.expires_at && new Date(tr.expires_at).getTime() < Date.now();
            return (
              <div key={tr.project_id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-medium truncate">{tr.name}</h3>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      {expired ? "Expired" : "Expires"} {tr.expires_at ? <span className="font-mono">{new Date(tr.expires_at).toLocaleString()}</span> : "—"}
                    </p>
                  </div>
                  {expired && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">Expired</span>}
                </div>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="flex-1 min-w-0">
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">Destination workspace</label>
                    <Select value={selected[tr.project_id] || ""} onValueChange={(v) => setSelected((s) => ({ ...s, [tr.project_id]: v }))} disabled={expired || workspaces.length === 0}>
                      <SelectTrigger className="w-full"><SelectValue placeholder={workspaces.length ? "Select a workspace" : "No owned workspaces"} /></SelectTrigger>
                      <SelectContent>
                        {workspaces.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={expired || !selected[tr.project_id] || !!busy[tr.project_id]} onClick={() => accept(tr)}>
                      {busy[tr.project_id] === "accept" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Accept
                    </Button>
                    <Button size="sm" variant="outline" disabled={!!busy[tr.project_id]} onClick={() => decline(tr)}>
                      {busy[tr.project_id] === "decline" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}Decline
                    </Button>
                  </div>
                </div>
                {expired && <p className="mt-2 text-[11px] text-muted-foreground/70">This transfer can no longer be accepted. Decline to clear it.</p>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}