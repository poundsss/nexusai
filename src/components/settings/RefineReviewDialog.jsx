import React from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// The documented "Review your skill" window: compare the refined version with the original
// text, then Back to original / Save skill / Cancel. Pure presentation — every decision is
// handled by the parent through callbacks; nothing here persists anything.
export default function RefineReviewDialog({ open, loading, original, refined, onBackToOriginal, onSave, onCancel }) {
  const side = (data, title, titleClass, boxClass) => (
    <section className={`rounded-lg border p-3 ${boxClass}`}>
      <h4 className={`text-[12px] font-semibold uppercase tracking-wide mb-2 ${titleClass}`}>{title}</h4>
      <p className="text-[12px] whitespace-pre-wrap"><span className="font-medium">Description: </span>{data.description}</p>
      <p className="text-[12px] whitespace-pre-wrap mt-2"><span className="font-medium">Instructions: </span>{data.instructions}</p>
    </section>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review your skill</DialogTitle>
          <DialogDescription>
            Compare the refined version with your original. Only the description and instructions are adjusted — your intent is preserved.
          </DialogDescription>
        </DialogHeader>
        {loading || !refined ? (
          <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {side(original, "Original", "text-muted-foreground", "border-border")}
            {side(refined, "Refined", "text-brand", "border-brand/40 bg-brand-muted")}
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onBackToOriginal} disabled={loading || !refined}>Back to original</Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button onClick={onSave} disabled={loading || !refined}>Save skill</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}