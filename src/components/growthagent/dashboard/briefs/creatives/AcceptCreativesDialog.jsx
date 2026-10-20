import React from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function AcceptCreativesDialog({ open, onOpenChange, headlines, descriptions, onConfirm }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save selected copy to this brief?</AlertDialogTitle>
          <AlertDialogDescription>
            {headlines.length} headline(s) and {descriptions.length} description(s) will be added to the brief.
            This is a selection only — nothing is launched, published or sent to Google Ads.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 space-y-0.5 overflow-y-auto text-[12px] text-foreground">
          {[...headlines, ...descriptions].map((t, i) => <li key={i} className="truncate">• {t}</li>)}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Save selection</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}