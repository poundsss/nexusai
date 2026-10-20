import React, { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

// SAML connection form. The certificate is a write-only field — it is encrypted at rest on
// the server and never returned. The form only ever sends the value inbound; it never renders
// an existing cert. The fingerprint shown elsewhere is the only visible artifact.
export default function SamlConnectionForm({ open, onOpenChange, onCreate, working }) {
  const [form, setForm] = useState({ name: "", saml_entity_id: "", saml_cert: "", saml_acs_url: "" });
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.name.trim() || !form.saml_entity_id.trim() || !form.saml_cert.trim()) {
      setError("Name, Entity ID, and certificate are required");
      return;
    }
    setError(null);
    try {
      await onCreate({
        protocol: "saml",
        name: form.name.trim(),
        saml_entity_id: form.saml_entity_id.trim(),
        saml_cert: form.saml_cert,
        saml_acs_url: form.saml_acs_url.trim(),
      });
      setForm({ name: "", saml_entity_id: "", saml_cert: "", saml_acs_url: "" });
      onOpenChange(false);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Configure SAML SSO</DialogTitle>
          <DialogDescription>Enter your Identity Provider's details. The certificate is encrypted at rest and never displayed again.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-[13px] font-medium">Connection name</label>
            <Input className="mt-1" value={form.name} onChange={set("name")} placeholder="Okta Production" />
          </div>
          <div>
            <label className="text-[13px] font-medium">IdP Entity ID / Issuer <span className="text-destructive">*</span></label>
            <Input className="mt-1" value={form.saml_entity_id} onChange={set("saml_entity_id")} placeholder="https://idp.acme.com" />
          </div>
          <div>
            <label className="text-[13px] font-medium">ACS URL (optional)</label>
            <Input className="mt-1" value={form.saml_acs_url} onChange={set("saml_acs_url")} placeholder="https://app.nexusai.com/sso/acs" />
          </div>
          <div>
            <label className="text-[13px] font-medium">IdP X.509 Certificate (PEM) <span className="text-destructive">*</span></label>
            <Textarea className="mt-1 font-mono text-[11px]" rows={6} value={form.saml_cert} onChange={set("saml_cert")} placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"} />
            <p className="mt-1 text-[11px] text-muted-foreground">Write-only — encrypted at rest, never returned.</p>
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