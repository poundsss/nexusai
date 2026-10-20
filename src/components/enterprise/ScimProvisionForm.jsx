import React, { useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Manually provision a SCIM user. In production this is driven by the IdP/HR system; the
// manual form exists for testing and one-off provisioning. The email must be on a verified
// domain — the backend enforces this, so the form does not duplicate the check.
export default function ScimProvisionForm({ onProvision, working }) {
  const [form, setForm] = useState({ external_id: "", email: "", display_name: "", groups: "" });
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.external_id.trim() || !form.email.trim()) { setError("External ID and email are required"); return; }
    setError(null);
    try {
      await onProvision({
        external_id: form.external_id.trim(),
        email: form.email.trim(),
        display_name: form.display_name.trim(),
        groups: form.groups.trim().split(/[,\s]+/).filter(Boolean),
      });
      setForm({ external_id: "", email: "", display_name: "", groups: "" });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-border p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-[12px] font-medium text-muted-foreground">External ID</label>
          <Input className="mt-1 h-8 text-[12px]" value={form.external_id} onChange={(e) => setForm((f) => ({ ...f, external_id: e.target.value }))} placeholder="idp-user-123" />
        </div>
        <div>
          <label className="text-[12px] font-medium text-muted-foreground">Email (must be on a verified domain)</label>
          <Input className="mt-1 h-8 text-[12px]" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="alice@acme.com" />
        </div>
        <div>
          <label className="text-[12px] font-medium text-muted-foreground">Display name</label>
          <Input className="mt-1 h-8 text-[12px]" value={form.display_name} onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} placeholder="Alice Smith" />
        </div>
        <div>
          <label className="text-[12px] font-medium text-muted-foreground">Groups (comma or space separated)</label>
          <Input className="mt-1 h-8 text-[12px]" value={form.groups} onChange={(e) => setForm((f) => ({ ...f, groups: e.target.value }))} placeholder="admins, engineers" />
        </div>
      </div>
      {error && <p className="text-[12px] text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={working || !form.external_id.trim() || !form.email.trim()}>
        {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5 mr-1.5" />}
        Provision user
      </Button>
    </form>
  );
}