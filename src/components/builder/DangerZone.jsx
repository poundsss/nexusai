import React, { useEffect, useState } from "react";
import { Loader2, AlertTriangle, Power, PowerOff, Trash2, RotateCcw, Archive } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import TransferOwnership from "@/components/builder/TransferOwnership";

// Danger Zone (App Settings) — Unpublish / Republish / Delete / Restore. The four documented
// danger-zone actions, dispatched through the existing projectEdit function and the existing
// authorization + public-serving gates. Confirmation/loading/error follow the patterns the rest
// of the builder already uses (AlertDialog for destructive actions, toast for feedback,
// Loader2 while in-flight). No new entity, permission or status enum value is involved.
export default function DangerZone({ project }) {
  // Local mirror of the danger-zone-relevant fields, so the UI reflects an action immediately
  // without forcing a full builder project reload.
  const [zone, setZone] = useState({
    status: project?.status,
    unpublished: !!project?.unpublished,
    deleted_at: project?.deleted_at || null,
    restorable_until: project?.restorable_until || null,
  });
  const [busy, setBusy] = useState(null); // null | "unpublish" | "republish" | "delete" | "restore"
  const [confirmAction, setConfirmAction] = useState(null);

  useEffect(() => {
    setZone({
      status: project?.status,
      unpublished: !!project?.unpublished,
      deleted_at: project?.deleted_at || null,
      restorable_until: project?.restorable_until || null,
    });
  }, [project?.id, project?.status, project?.unpublished, project?.deleted_at, project?.restorable_until]);

  const call = async (action) => {
    setBusy(action);
    try {
      const res = await base44.functions.invoke("projectEdit", { action, project_id: project?.id });
      const d = res.data || {};
      // Reflect the server's resulting state locally.
      if (action === "unpublish") setZone((z) => ({ ...z, unpublished: true }));
      if (action === "republish") setZone((z) => ({ ...z, unpublished: false }));
      if (action === "delete") setZone((z) => ({ ...z, status: "archived", deleted_at: new Date().toISOString(), restorable_until: d.restorable_until || null, unpublished: false }));
      if (action === "restore") setZone((z) => ({ ...z, status: d.status || "ready", deleted_at: null, restorable_until: null, unpublished: false }));
      toast({ title: { unpublish: "App unpublished", republish: "App republished", delete: "App moved to trash", restore: "App restored" }[action] });
    } catch (e) {
      toast({ title: "Action failed", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const archived = zone.status === "archived";
  const restorable = archived && !!zone.restorable_until;
  const expired = restorable && zone.restorable_until && new Date(zone.restorable_until).getTime() < Date.now();
  const permanentArchive = archived && !zone.restorable_until;

  return (
    <section className="rounded-md border border-destructive/40 p-4 md:col-span-2">
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" />Danger Zone
      </h3>
      <p className="mt-1 text-[12px] text-muted-foreground/70">Take the app offline or remove it. Unpublish keeps everything in place; Delete moves the app to trash for 30 days.</p>

      <div className="mt-3 space-y-3">
        {/* Unpublish / Republish — serving toggle. Not available for archived projects. */}
        {archived ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
            <Archive className="h-3.5 w-3.5" />
            {permanentArchive
              ? "This project is permanently archived and cannot be unpublished or republished."
              : "This project is in the trash — restore it before managing its published state."}
          </div>
        ) : zone.unpublished ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium"><PowerOff className="h-3.5 w-3.5 text-amber-600" />Unpublished — visitors see an offline notice</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">The project, data, settings and domains remain intact. Republish to bring it back online.</p>
            </div>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => call("republish")}>
              {busy === "republish" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}Republish
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium"><Power className="h-3.5 w-3.5 text-emerald-600" />Published — the app is serving</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">Unpublish takes the app offline without deleting it. Everything stays in place.</p>
            </div>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmAction("unpublish")}>
              {busy === "unpublish" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />}Unpublish
            </Button>
          </div>
        )}

        {/* Delete / Restore — destructive, 30-day restorable trash. */}
        {restorable ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium"><Trash2 className="h-3.5 w-3.5 text-destructive" />Deleted — in trash{expired ? " (window expired)" : ""}</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                {expired
                  ? "The 30-day restore window has expired; this app can no longer be restored."
                  : <>Restorable until <span className="font-mono">{zone.restorable_until ? new Date(zone.restorable_until).toLocaleDateString() : ""}</span>. Restoring does not reconnect released resources.</>}
              </p>
            </div>
            <Button size="sm" variant="outline" disabled={!!busy || expired} onClick={() => setConfirmAction("restore")}>
              {busy === "restore" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}Restore
            </Button>
          </div>
        ) : permanentArchive ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
            <Archive className="h-3.5 w-3.5" />This project is permanently archived.
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium"><Trash2 className="h-3.5 w-3.5 text-destructive" />Delete this app</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">Takes the app offline immediately. Restorable for 30 days; released resources (domains, integrations) are not reconnected on restore.</p>
            </div>
            <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => setConfirmAction("delete")}>
              {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}Delete app
            </Button>
          </div>
        )}
        {/* Transfer Ownership — the documented Base44 flow; separate from Move app. */}
        <TransferOwnership project={project} />
      </div>

      {/* Confirmation for destructive actions — the existing AlertDialog pattern. */}
      <AlertDialog open={!!confirmAction} onOpenChange={(o) => !o && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "delete" ? "Delete this app?" : confirmAction === "unpublish" ? "Unpublish this app?" : "Restore this app?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "delete" && "The app goes offline immediately and moves to trash. You can restore it for 30 days, but released resources (custom domains, integrations) are not reconnected automatically."}
              {confirmAction === "unpublish" && "Visitors will see an offline notice. The project, data, settings and domains stay intact, and you can republish any time."}
              {confirmAction === "restore" && "The app returns to its pre-deletion state and resumes serving its last live deployment."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busy}
              onClick={() => { const a = confirmAction; setConfirmAction(null); if (a) call(a); }}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {confirmAction === "delete" ? "Delete" : confirmAction === "unpublish" ? "Unpublish" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}