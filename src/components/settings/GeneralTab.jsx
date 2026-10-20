import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function GeneralTab({ workspace, user }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (workspace) setName(workspace.name || ""); }, [workspace]);

  const save = async () => {
    setSaving(true);
    try {
      await workspaceRead("rename_workspace", { workspace_id: workspace.id, name: name.trim() || workspace.name });
      toast({ title: "Workspace renamed" });
    } catch (e) {
      toast({ title: "Could not save", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="ws-name">Workspace name</Label>
        <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Workspace" className="max-w-md" />
        <Button size="sm" disabled={saving || !name.trim() || name.trim() === workspace?.name} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 max-w-lg">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Owner</div>
          <div className="text-sm">{user?.email}</div>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workspace id</div>
          <div className="font-mono text-xs text-muted-foreground break-all">{workspace?.id}</div>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</div>
          <div className="text-sm capitalize">{workspace?.status || "active"}</div>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Created</div>
          <div className="text-sm">{workspace?.created_date ? new Date(workspace.created_date).toLocaleDateString() : "—"}</div>
        </div>
      </div>
    </div>
  );
}