import React, { useEffect, useState } from "react";
import { Loader2, ArrowLeftRight, Mail, X } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Transfer Ownership (Danger Zone) — the documented Base44 flow, on the existing confirmation /
// loading / error patterns the rest of the Danger Zone uses. Owner initiates a pending transfer to an
// outside recipient email; a pending transfer shows its recipient + expiry and can be cancelled.
// The existing Move app operation is intentionally NOT offered here — it stays a separate surface.
export default function TransferOwnership({ project }) {
  const [transfer, setTransfer] = useState({
    pending: !!project?.transfer_pending,
    recipient: project?.transfer_recipient_email || "",
    expiresAt: project?.transfer_expires_at || null,
  });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(null); // null | "initiate" | "cancel"
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    setTransfer({
      pending: !!project?.transfer_pending,
      recipient: project?.transfer_recipient_email || "",
      expiresAt: project?.transfer_expires_at || null,
    });
  }, [project?.id, project?.transfer_pending, project?.transfer_recipient_email, project?.transfer_expires_at]);

  // A trashed/archived project cannot enter or complete a transfer; the panel hides itself then.
  const archived = project?.status === "archived" || !!project?.deleted_at;
  if (archived) return null;

  const initiate = async () => {
    const addr = email.trim();
    if (!addr) { toast({ title: "Recipient email required", variant: "destructive" }); return; }
    setBusy("initiate");
    try {
      const res = await base44.functions.invoke("transferProject", { op: "initiate", project_id: project?.id, recipient_email: addr });
      const d = res.data || {};
      setTransfer({ pending: true, recipient: d.recipient_email || addr, expiresAt: d.expires_at || null });
      setEmail("");
      setDialogOpen(false);
      toast({ title: "Transfer started", description: `Pending for ${d.recipient_email || addr}. They have 7 days to accept.` });
    } catch (e) {
      toast({ title: "Could not start transfer", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const cancel = async () => {
    setBusy("cancel");
    try {
      await base44.functions.invoke("transferProject", { op: "decline", project_id: project?.id });
      setTransfer({ pending: false, recipient: "", expiresAt: null });
      toast({ title: "Transfer cancelled" });
    } catch (e) {
      toast({ title: "Could not cancel transfer", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally { setConfirmCancel(false); setBusy(null); }
  };

  const expired = transfer.expiresAt && new Date(transfer.expiresAt).getTime() < Date.now();

  return (
    <>
      {transfer.pending ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium"><Mail className="h-3.5 w-3.5 text-amber-600" />Transfer pending{expired ? " (expired)" : ""}</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground/70 truncate">
              To <span className="font-mono">{transfer.recipient}</span>
              {transfer.expiresAt ? <> · expires <span className="font-mono">{new Date(transfer.expiresAt).toLocaleDateString()}</span></> : null}
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmCancel(true)}>
            {busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium"><ArrowLeftRight className="h-3.5 w-3.5" />Transfer ownership</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground/70">Send this app to someone outside your workspace. They choose where it lands and have 7 days to accept.</p>
          </div>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setDialogOpen(true)}>
            <ArrowLeftRight className="h-3.5 w-3.5" />Transfer
          </Button>
        </div>
      )}

      {/* Initiate dialog — existing AlertDialog pattern, with an email input. */}
      <AlertDialog open={dialogOpen} onOpenChange={(o) => !o && setDialogOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer ownership</AlertDialogTitle>
            <AlertDialogDescription>Enter the recipient's email. They'll be able to accept the transfer into a workspace they own. The app stays editable here until they accept.</AlertDialogDescription>
          </AlertDialogHeader>
          <Input type="email" placeholder="recipient@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!busy} autoFocus />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!!busy || !email.trim()} onClick={(e) => { e.preventDefault(); initiate(); }}>
              {busy === "initiate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Start transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel confirmation — existing AlertDialog pattern. */}
      <AlertDialog open={confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this transfer?</AlertDialogTitle>
            <AlertDialogDescription>The pending transfer to {transfer.recipient} will be cancelled. The app and its data stay unchanged.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Keep</AlertDialogCancel>
            <AlertDialogAction disabled={!!busy} onClick={(e) => { e.preventDefault(); cancel(); }}>
              {busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Cancel transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}