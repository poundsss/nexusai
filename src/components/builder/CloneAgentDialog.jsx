import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";

// Clone dialog — the Base44-documented "Clone agent" action. One call into the certified
// agentEditor clone contract (a verbatim copy; only the name differs). The name is the copy's
// identity, so a rename is impossible by design.
export default function CloneAgentDialog({ projectId, agentName, onClose, onSaved }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const clone = async () => {
    setBusy(true);
    try {
      await base44.functions.invoke("agentEditor", { action: "clone", project_id: projectId, original_name: agentName, new_name: name.trim() });
      toast({ title: "Agent cloned", description: `A copy of "${agentName}" was created.` });
      onClose();
      if (onSaved) await onSaved();
    } catch (e) {
      toast({ variant: "destructive", title: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="text-[14px]">Clone agent</DialogTitle></DialogHeader>
        <p className="text-[11.5px] text-muted-foreground">
          A copy of <span className="font-medium text-foreground">{agentName}</span> with the same configuration, connector references and skills.
        </p>
        <Label className="text-[11px]">New agent name</Label>
        <Input className="text-[12px]" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${agentName}-copy`} />
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!name.trim() || busy} onClick={clone}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Clone agent
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}