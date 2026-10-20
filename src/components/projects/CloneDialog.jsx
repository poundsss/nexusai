import React, { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// Compact clone form. Calls the existing cloneProject surface (action: "clone"), which copies
// the app's code/pages/backend logic into a SEPARATE project with an empty database. Integrations
// are copied but must be reconnected. No data is copied. Reuses the certified backend verbatim.
export default function CloneDialog({ open, onOpenChange, project, onCloned }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    if (open && project) {
      setName(`${project.name || ""} copy`.trim());
      setError("");
    }
  }, [open, project]);

  const trimmed = name.trim();
  const canSubmit = !!trimmed && trimmed.length <= 120 && !saving;

  const submit = async (e) => {
    e.preventDefault();
    if (!project || !canSubmit) return;
    setSaving(true);
    setError("");
    try {
      const res = await base44.functions.invoke("cloneProject", {
        action: "clone",
        source_project_id: project.id,
        name: trimmed,
      });
      const data = res?.data || {};
      toast({ title: "App cloned", description: data.project?.name || trimmed });
      onCloned?.(data);
      onOpenChange(false);
    } catch (err) {
      setError(err?.message || "Could not clone the app");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-4 w-4" /> Clone app
          </DialogTitle>
          <DialogDescription>
            Creates a separate copy of <span className="font-medium text-foreground">{project?.name}</span>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="clone-name">New app name</Label>
            <Input
              id="clone-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={saving}
              placeholder="My application copy"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Code, pages and backend logic are copied. App data is not copied (the clone starts with an empty database), and connected integrations must be reconnected.
          </p>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm" disabled={saving}>Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {saving ? "Cloning…" : "Clone app"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}