import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

const MAX_TEXT = 2000;

// Skill edit dialog — persists through the certified workspaceSkills `update` action
// (patch: name / description / instructions), the same contract the toggle uses.
export default function SkillEditDialog({ open, onOpenChange, skill, onSave }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(skill?.name || "");
      setDescription(skill?.description || "");
      setInstructions(skill?.instructions || "");
    }
  }, [open, skill]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !instructions.trim() || saving) return;
    setSaving(true);
    await onSave({ name: name.trim(), description: description.trim(), instructions });
    setSaving(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit skill</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="skill-name">Name</Label>
            <Input id="skill-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-desc">Description</Label>
            <Input id="skill-desc" value={description} onChange={(e) => setDescription(e.target.value.slice(0, MAX_TEXT))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-instr">Instructions</Label>
            <Textarea id="skill-instr" value={instructions} onChange={(e) => setInstructions(e.target.value.slice(0, MAX_TEXT))} rows={6} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || !instructions.trim() || saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}