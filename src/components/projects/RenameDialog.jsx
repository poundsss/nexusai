import React, { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// Compact rename form. Calls the existing projectEdit surface (action: "rename"), which
// reuses project.write authorization and the existing project-name validation contract.
export default function RenameDialog({ open, onOpenChange, project, onRenamed }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    if (open && project) {
      setName(project.name || "");
      setError("");
    }
  }, [open, project]);

  const trimmed = name.trim();
  const unchanged = trimmed === (project?.name || "");
  const canSubmit = !!trimmed && trimmed.length <= 120 && !unchanged && !saving;

  const submit = async (e) => {
    e.preventDefault();
    if (!project || !canSubmit) return;
    setSaving(true);
    setError("");
    try {
      const res = await base44.functions.invoke("projectEdit", {
        action: "rename",
        project_id: project.id,
        name: trimmed,
      });
      const data = res?.data || {};
      toast({ title: "App renamed", description: data.name || trimmed });
      onRenamed?.(data);
      onOpenChange(false);
    } catch (err) {
      setError(err?.message || "Could not rename the app");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" /> Rename app
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rename-name">App name</Label>
            <Input
              id="rename-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={saving}
              placeholder="My application"
            />
            <p className="text-[11px] text-muted-foreground">Used as the app's display name. The URL and data are unchanged.</p>
          </div>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm" disabled={saving}>Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}