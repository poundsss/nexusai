import React, { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Create a group → role mapping. The external group id comes from the IdP's groups claim;
// the role is what the platform grants to users whose groups include it.
export default function GroupMappingForm({ onCreate, working }) {
  const [form, setForm] = useState({ external_group_id: "", external_group_name: "", role: "viewer", priority: 0 });
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.external_group_id.trim()) { setError("External group ID is required"); return; }
    setError(null);
    try {
      await onCreate({
        external_group_id: form.external_group_id.trim(),
        external_group_name: form.external_group_name.trim(),
        role: form.role,
        priority: Number(form.priority) || 0,
      });
      setForm({ external_group_id: "", external_group_name: "", role: "viewer", priority: 0 });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-border p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="text-[12px] font-medium text-muted-foreground">External group ID</label>
          <Input className="mt-1 h-8 text-[12px]" value={form.external_group_id} onChange={(e) => setForm((f) => ({ ...f, external_group_id: e.target.value }))} placeholder="admins" />
        </div>
        <div>
          <label className="text-[12px] font-medium text-muted-foreground">Display name</label>
          <Input className="mt-1 h-8 text-[12px]" value={form.external_group_name} onChange={(e) => setForm((f) => ({ ...f, external_group_name: e.target.value }))} placeholder="Administrators" />
        </div>
        <div>
          <label className="text-[12px] font-medium text-muted-foreground">Role</label>
          <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-[12px]">
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div>
          <label className="text-[12px] font-medium text-muted-foreground">Priority</label>
          <Input type="number" className="mt-1 h-8 text-[12px]" value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} placeholder="0" />
        </div>
      </div>
      {error && <p className="text-[12px] text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={working || !form.external_group_id.trim()}>
        {working ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
        Add mapping
      </Button>
    </form>
  );
}