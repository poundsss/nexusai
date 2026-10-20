import React, { useEffect, useState } from "react";
import { ShieldCheck, Lock, Copy, Check, Loader2, KeyRound } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// App-level SSO setup (Elite+). The platform owns the OIDC callback, code exchange, identity
// mapping and session minting — this card owns ONLY the per-project configuration: provider,
// public client_id + endpoints, and a client secret stored through the EXISTING projectSecrets
// flow (SSO_CLIENT_SECRET_NAME, encrypted at rest). No callback, no exchange, no session code.
const PROVIDER_LABELS = {
  google: "Google Workspace",
  microsoft: "Microsoft Azure AD",
  github: "GitHub",
  okta: "Okta",
  advanced: "Advanced / Manual OIDC",
};

export default function SsoSettingsCard({ project }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);

  const load = async () => {
    if (!project?.id) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke("projectAuthSettings", { action: "get", project_id: project.id });
      setData(res.data);
    } catch (e) {
      setData({ error: e.response?.data?.error || e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [project?.id]);

  const sso = data?.sso;
  const cfg = sso?.settings || { enabled: false, provider: "", scopes: "", custom_domain_callback: false };
  const allowed = !!sso?.allowed;

  const save = async (patch) => {
    setBusy(true);
    try {
      await base44.functions.invoke("projectAuthSettings", { action: "set", project_id: project.id, settings: { sso: patch } });
      await load();
      toast({ title: "SSO settings saved" });
    } catch (e) {
      toast({ title: "Could not save SSO", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const storeSecret = async () => {
    setBusy(true);
    try {
      await base44.functions.invoke("projectSecrets", {
        action: "set", project_id: project.id, name: "SSO_CLIENT_SECRET", value: secret,
        description: "App-level SSO client secret (Elite+)",
      });
      setSecret("");
      await load();
      toast({ title: "SSO client secret stored" });
    } catch (e) {
      toast({ title: "Could not store the secret", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(sso?.callback_url || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  return (
    <div className="rounded-md border border-border p-3.5 md:col-span-2">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-foreground" />
        <div className="text-[12.5px] font-medium">Single sign-on (SSO)</div>
        <span className="ml-auto text-[10.5px] text-muted-foreground/70">Elite plan or higher · OIDC</span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground/70">
        Let this app's end users sign in through an external identity provider. The platform handles the OIDC callback, code exchange and session — you only configure the provider here.
      </p>

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
      ) : data?.error ? (
        <p className="mt-3 text-[12px] text-amber-600">{data.error}</p>
      ) : !allowed ? (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-600">
          <Lock className="h-3 w-3" />Single sign-on requires the Elite plan or higher.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {/* Enable + provider */}
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <div className="text-[12px] font-medium">Enable SSO</div>
              <p className="text-[11px] text-muted-foreground/70">Show a "Log in with SSO" button on your app's login pages.</p>
            </div>
            <Switch
              checked={!!cfg.enabled}
              disabled={busy}
              onCheckedChange={(v) => save({ ...cfg, enabled: v })}
            />
          </div>

          {/* Callback URL */}
          <div className="rounded-md border border-border p-3">
            <div className="text-[11px] font-medium text-muted-foreground">Redirect URI (register this with your identity provider)</div>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1.5 text-[11px]">{sso?.callback_url || "—"}</code>
              <Button size="sm" variant="outline" onClick={copyCallback} disabled={!sso?.callback_url}>
                {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
            {sso?.custom_domain_available && (
              <label className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <Switch
                  checked={!!cfg.custom_domain_callback}
                  disabled={busy}
                  onCheckedChange={(v) => save({ ...cfg, custom_domain_callback: v })}
                />
                Use this app's custom domain ({sso.custom_domain_hostname}) as the SSO callback
              </label>
            )}
          </div>

          {/* Provider picker */}
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label className="text-[11px]">SSO provider</Label>
              <Select value={cfg.provider || ""} onValueChange={(p) => save({ ...cfg, provider: p, scopes: PROVIDER_DEFAULT_SCOPES[p] || cfg.scopes })} disabled={busy}>
                <SelectTrigger className="mt-1 h-8 text-[12px]"><SelectValue placeholder="Select a provider" /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PROVIDER_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[11px]">Client ID</Label>
              <Input value={cfg.client_id} onChange={(e) => {}} placeholder="Your provider's client ID" className="mt-1 h-8 text-[12px]"
                onBlur={(e) => save({ ...cfg, client_id: e.target.value })} defaultValue={cfg.client_id} key={cfg.client_id} />
            </div>
          </div>

          {/* Provider-specific fields */}
          {cfg.provider === "microsoft" && (
            <div>
              <Label className="text-[11px]">Tenant ID</Label>
              <Input defaultValue={cfg.tenant_id} placeholder="directory tenant ID, common, or organizations" className="mt-1 h-8 text-[12px]"
                onBlur={(e) => save({ ...cfg, tenant_id: e.target.value })} key={cfg.tenant_id} />
            </div>
          )}
          {cfg.provider === "okta" && (
            <div>
              <Label className="text-[11px]">Okta domain</Label>
              <Input defaultValue={cfg.okta_domain} placeholder="your-company (the part before .okta.com)" className="mt-1 h-8 text-[12px]"
                onBlur={(e) => save({ ...cfg, okta_domain: e.target.value })} key={cfg.okta_domain} />
            </div>
          )}
          {cfg.provider === "advanced" && (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <Label className="text-[11px]">Authorize endpoint</Label>
                  <Input defaultValue={cfg.authorize_url} placeholder="https://…" className="mt-1 h-8 text-[12px]"
                    onBlur={(e) => save({ ...cfg, authorize_url: e.target.value })} key={cfg.authorize_url} />
                </div>
                <div>
                  <Label className="text-[11px]">Token endpoint</Label>
                  <Input defaultValue={cfg.token_url} placeholder="https://…" className="mt-1 h-8 text-[12px]"
                    onBlur={(e) => save({ ...cfg, token_url: e.target.value })} key={cfg.token_url} />
                </div>
                <div>
                  <Label className="text-[11px]">Userinfo endpoint</Label>
                  <Input defaultValue={cfg.userinfo_url} placeholder="https://…" className="mt-1 h-8 text-[12px]"
                    onBlur={(e) => save({ ...cfg, userinfo_url: e.target.value })} key={cfg.userinfo_url} />
                </div>
              </div>
              <div className="mt-3">
                <Label className="text-[11px]">Discovery URL</Label>
                <Input defaultValue={cfg.discovery_url} placeholder="https://…/.well-known/openid-configuration" className="mt-1 h-8 text-[12px]"
                  onBlur={(e) => save({ ...cfg, discovery_url: e.target.value })} key={cfg.discovery_url} />
              </div>
            </>
          )}
          {(cfg.provider === "google" || cfg.provider === "okta") && (
            <div>
              <Label className="text-[11px]">Discovery URL</Label>
              <Input defaultValue={cfg.discovery_url} placeholder="Leave default for built-in providers" className="mt-1 h-8 text-[12px]"
                onBlur={(e) => save({ ...cfg, discovery_url: e.target.value })} key={cfg.discovery_url} />
            </div>
          )}
          <div>
            <Label className="text-[11px]">Scopes</Label>
            <Input defaultValue={cfg.scopes} placeholder="openid email profile" className="mt-1 h-8 text-[12px]"
              onBlur={(e) => save({ ...cfg, scopes: e.target.value })} key={cfg.scopes} />
          </div>

          {/* Client secret */}
          <div className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-[11px]">Client secret</Label>
              {sso?.secret_set && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600"><Check className="h-3 w-3" />set</span>}
            </div>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
              placeholder={sso?.secret_set ? "Replace the stored secret" : "Paste the SSO client secret"} className="mt-1.5 h-8 text-[12px]" />
            <Button size="sm" variant="outline" className="mt-2" disabled={busy || !secret} onClick={storeSecret}>
              <KeyRound className="h-3 w-3 mr-1.5" />Store secret
            </Button>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground/70">Stored encrypted as a project secret — never displayed or returned to any client.</p>
          </div>
        </div>
      )}
    </div>
  );
}

const PROVIDER_DEFAULT_SCOPES = {
  google: "openid email profile",
  microsoft: "openid email profile",
  github: "user:email",
  okta: "openid email profile",
  advanced: "openid email profile",
};