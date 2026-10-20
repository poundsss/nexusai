import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

const MAX_STATEMENT = 1000;

// Memory correction dialog — persists through the certified memory `supersede` action: a NEW
// revision replaces the old row, which stays inspectable in the memory history.
export default function MemoryEditDialog({ open, onOpenChange, memory, onSave }) {
  const [statement, setStatement] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setStatement(memory?.statement || ""); setReason(memory?.reason || ""); }
  }, [open, memory]);

  const submit = async (e) => {
    e.preventDefault();
    if (!statement.trim() || saving) return;
    setSaving(true);
    await onSave({ statement: statement.trim(), reason: reason.trim() || null });
    setSaving(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Correct memory</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-1">
          Saves as a new revision — the previous statement stays in the memory history.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="mem-statement">Statement</Label>
              <span className={`text-[11px] tabular-nums ${statement.length >= MAX_STATEMENT ? "text-destructive" : "text-muted-foreground"}`}>
                {statement.length}/{MAX_STATEMENT}
              </span>
            </div>
            <Textarea id="mem-statement" value={statement} onChange={(e) => setStatement(e.target.value.slice(0, MAX_STATEMENT))} rows={3} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mem-reason">Reason (optional)</Label>
            <Input id="mem-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this holds" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!statement.trim() || saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}Save correction
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}