import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const AUTH = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token" },
  { value: "header", label: "Custom header" },
];

export default function NewMcpConnectionDialog({ open, onOpenChange, onCreate, busy }) {
  const [form, setForm] = useState({ name: "", server_url: "", auth_type: "none", auth_header_name: "", secret_name: "", secret_value: "" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const valid = form.name.trim() && /^https:\/\//.test(form.server_url.trim()) && (form.auth_type === "none" || form.secret_name.trim());

  const submit = async () => {
    const res = await onCreate(form);
    if (!res?.error) { setForm({ name: "", server_url: "", auth_type: "none", auth_header_name: "", secret_name: "", secret_value: "" }); onOpenChange(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Add MCP connection</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label className="text-[12px]">Name</Label><Input value={form.name} onChange={set("name")} placeholder="DeepWiki" className="mt-1" /></div>
          <div>
            <Label className="text-[12px]">Server URL (MCP Streamable HTTP)</Label>
            <Input value={form.server_url} onChange={set("server_url")} placeholder="https://mcp.example.com/mcp" className="mt-1 font-mono text-[12px]" />
          </div>
          <div>
            <Label className="text-[12px]">Authentication</Label>
            <div className="mt-1 flex gap-1.5">
              {AUTH.map((a) => (
                <button key={a.value} onClick={() => setForm({ ...form, auth_type: a.value })}
                  className={`rounded-md px-2.5 py-1.5 text-[12px] ring-1 ${form.auth_type === a.value ? "bg-slate-900 text-white ring-slate-900" : "ring-slate-200 text-slate-600"}`}>{a.label}</button>
              ))}
            </div>
          </div>
          {form.auth_type === "header" && <div><Label className="text-[12px]">Header name</Label><Input value={form.auth_header_name} onChange={set("auth_header_name")} placeholder="X-API-Key" className="mt-1" /></div>}
          {form.auth_type !== "none" && (
            <>
              <div><Label className="text-[12px]">Account secret name</Label><Input value={form.secret_name} onChange={set("secret_name")} placeholder="GITHUB_MCP_TOKEN" className="mt-1 font-mono text-[12px]" /></div>
              <div>
                <Label className="text-[12px]">Secret value</Label>
                <Input value={form.secret_value} onChange={set("secret_value")} type="password" className="mt-1" />
                <p className="mt-1 text-[11px] text-slate-400">Stored server-side only. It is never shown again, never sent to the AI and never written to a project.</p>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!valid || !!busy} onClick={submit}>{busy ? "Connecting…" : "Add & test"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}