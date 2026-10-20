import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

// Builder Custom Instructions editor (documented Base44): project-scoped free text, one
// instruction per line, "Save changes". The full value is persisted; only the first 10,000
// characters are injected into the Build prompt (handled server-side). Empty means no injection.
export default function CustomInstructionsDialog({ open, initialValue = "", onClose, onSave }) {
  const [text, setText] = useState(initialValue || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setText(initialValue || ""); }, [open, initialValue]);

  const save = async () => {
    setSaving(true);
    try { await onSave?.(text); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Custom Instructions</DialogTitle>
          <DialogDescription>
            Guide the AI on every Build turn in this app — tone, standards, preferred behavior. One instruction per line. The first 10,000 characters are sent on every Build run; Discuss and Agent runs are unaffected.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={"Use a calm, concise tone.\nPrefer Tailwind utility classes over custom CSS.\nAlways add empty states for lists."}
          className="resize-y font-mono text-[12.5px]"
          aria-label="Custom instructions"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}