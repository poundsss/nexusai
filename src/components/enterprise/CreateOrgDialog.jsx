import React, { useState } from "react";
import { Loader2, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

// First-run org creation. An org is the container for SSO connections, verified domains,
// group mappings and SCIM records — none of the enterprise surfaces work until it exists.
export default function CreateOrgDialog({ open, onOpenChange, onCreate, working }) {
  const [name, setName] = useState("");
  const [defaultRole, setDefaultRole] = useState("viewer");
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!name.trim()) { setError("Organization name is required"); return; }
    setError(null);
    try {
      await onCreate({ name: name.trim(), default_role: defaultRole });
      setName(""); setDefaultRole("viewer");
      onOpenChange(false);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Building2 className="h-4 w-4" />Create organization</DialogTitle>
          <DialogDescription>
            An organization is the enterprise container for SSO, domains, groups, and SCIM. You can configure it after creation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-[13px] font-medium">Organization name</label>
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" autoFocus />
          </div>
          <div>
            <label className="text-[13px] font-medium">Default role for provisioned users</label>
            <select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value)} className="mt-1 w-full h-9 rounded-md border border-input bg-background px-2 text-[13px]">
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">Applied when no group mapping matches a provisioned user.</p>
          </div>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={working}>Cancel</Button>
          <Button onClick={submit} disabled={working || !name.trim()}>
            {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Building2 className="h-3.5 w-3.5 mr-1.5" />}
            Create organization
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}