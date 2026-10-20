import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";

const ROLES = [
  { value: "user", label: "User", description: "Full build access for their own apps" },
  { value: "admin", label: "Admin", description: "Workspace settings, members and billing" },
];

export default function InviteMemberForm({ workspace, onInvited, working }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    try {
      await onInvited({ workspace_id: workspace.id, email: email.trim().toLowerCase(), role });
      toast({ title: "Invitation sent", description: `${email.trim().toLowerCase()} will receive an email with a join link.` });
      setEmail("");
    } catch (e2) {
      setError(e2.response?.data?.error || e2.message);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-border p-3 flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-[200px]">
        <Label htmlFor="invite-email" className="text-[12px]">Email address</Label>
        <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" className="mt-1 h-9" />
      </div>
      <div className="w-[130px]">
        <Label className="text-[12px]">Role</Label>
        <select value={role} onChange={(e) => setRole(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-[13px]">
          {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>
      <Button type="submit" size="sm" disabled={working || !email.trim()}>
        {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
        Send invite
      </Button>
      {error && <p className="w-full text-[12px] text-destructive">{error}</p>}
    </form>
  );
}