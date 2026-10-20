import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Same Danger Zone delete as the app settings: goes offline, moves to trash, restorable for 30 days.
export default function DeleteAppDialog({ open, onOpenChange, project, onDeleted }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const confirm = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await base44.functions.invoke("projectEdit", { action: "delete", project_id: project.id });
      toast({ title: "App moved to trash" });
      onOpenChange(false);
      onDeleted?.(project.id);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || "Could not delete the app");
    } finally { setBusy(false); }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{project.name}"?</AlertDialogTitle>
          <AlertDialogDescription>
            The app goes offline immediately and moves to trash. You can restore it from its settings for 30 days; custom domains and integrations are not reconnected automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {busy ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}