import React, { useState } from "react";
import { Loader2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

// OIDC connection form. The client secret is a write-only password field — encrypted at rest
// on the server, never returned. An existing connection shows has_secret=true but never the
// value; this form only ever sends a new secret inbound.
export default function OidcConnectionForm({ open, onOpenChange, onCreate, working }) {
  const [form, setForm] = useState({ name: "", oidc_issuer: "", oidc_client_id: "", oidc_client_secret: "", oidc_scopes: "openid email profile" });
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.name.trim() || !form.oidc_issuer.trim() || !form.oidc_client_id.trim() || !form.oidc_client_secret.trim()) {
      setError("Name, issuer, client ID, and client secret are required");
      return;
    }
    setError(null);
    try {
      await onCreate({
        protocol: "oidc",
        name: form.name.trim(),
        oidc_issuer: form.oidc_issuer.trim(),
        oidc_client_id: form.oidc_client_id.trim(),
        oidc_client_secret: form.oidc_client_secret,
        oidc_scopes: form.oidc_scopes.trim().split(/\s+/).filter(Boolean),
      });
      setForm({ name: "", oidc_issuer: "", oidc_client_id: "", oidc_client_secret: "", oidc_scopes: "openid email profile" });
      onOpenChange(false);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" />Configure OIDC SSO</DialogTitle>
          <DialogDescription>Enter your OpenID Connect provider details. The client secret is encrypted at rest and never displayed again.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-[13px] font-medium">Connection name</label>
            <Input className="mt-1" value={form.name} onChange={set("name")} placeholder="Google Workspace" />
          </div>
          <div>
            <label className="text-[13px] font-medium">Issuer URL <span className="text-destructive">*</span></label>
            <Input className="mt-1" value={form.oidc_issuer} onChange={set("oidc_issuer")} placeholder="https://accounts.google.com" />
          </div>
          <div>
            <label className="text-[13px] font-medium">Client ID <span className="text-destructive">*</span></label>
            <Input className="mt-1" value={form.oidc_client_id} onChange={set("oidc_client_id")} placeholder="your-client-id.apps.googleusercontent.com" />
          </div>
          <div>
            <label className="text-[13px] font-medium">Client secret <span className="text-destructive">*</span></label>
            <Input className="mt-1" type="password" value={form.oidc_client_secret} onChange={set("oidc_client_secret")} placeholder="Write-only — encrypted at rest" />
          </div>
          <div>
            <label className="text-[13px] font-medium">Scopes</label>
            <Input className="mt-1" value={form.oidc_scopes} onChange={set("oidc_scopes")} placeholder="openid email profile" />
            <p className="mt-1 text-[11px] text-muted-foreground">Space-separated. Defaults to openid email profile.</p>
          </div>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={working}>Cancel</Button>
          <Button onClick={submit} disabled={working}>
            {working && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Create connection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}