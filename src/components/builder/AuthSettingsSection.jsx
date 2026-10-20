import React, { useEffect, useState, useCallback } from "react";
import { Loader2, Lock, CheckCircle2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import SsoSettingsCard from "@/components/builder/SsoSettingsCard";

// Deployed-app Authentication settings (P-9.8): which social sign-in providers THIS app's end
// users may use. This is the app's own auth surface — workspace SSO/SAML/OIDC lives elsewhere
// and is never mixed in here. The Google client_id is a public identifier; the client secret is
// written through the EXISTING project-secrets flow (GOOGLE_OAUTH_CLIENT_SECRET) and is never
// displayed, stored in settings, or returned by any read.
export default function AuthSettingsSection({ project }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");

  const load = useCallback(async () => {
    if (!project?.id) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke("projectAuthSettings", { action: "get", project_id: project.id });
      setData(res.data);
      setClientId(res.data?.settings?.google?.client_id || "");
    } catch (e) {
      setData({ error: e.response?.data?.error || e.message });
    } finally {
      setLoading(false);
    }
  }, [project?.id]);

  useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    setBusy(true);
    try {
      const res = await base44.functions.invoke("projectAuthSettings", { action: "set", project_id: project.id, settings: patch });
      setData((d) => (d ? { ...d, settings: res.data.settings, visibility: res.data.visibility ?? d.visibility } : d));
      toast({ title: "Authentication settings saved" });
    } catch (e) {
      toast({ title: "Could not save", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const saveVisibility = async (mode) => {
    setBusy(true);
    try {
      const res = await base44.functions.invoke("projectAuthSettings", { action: "set", project_id: project.id, visibility: mode });
      setData((d) => (d ? { ...d, visibility: res.data.visibility } : d));
      toast({ title: "App visibility saved" });
    } catch (e) {
      toast({ title: "Could not save visibility", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const storeSecret = async () => {
    setBusy(true);
    try {
      await base44.functions.invoke("projectSecrets", {
        action: "set", project_id: project.id, name: "GOOGLE_OAUTH_CLIENT_SECRET", value: secret,
        description: "Google OAuth client secret (deployed-app sign-in)",
      });
      setSecret("");
      await load();
      toast({ title: "Client secret stored" });
    } catch (e) {
      toast({ title: "Could not store the secret", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const google = data?.settings?.google || { enabled: false, client_id: "" };
  const allowed = !!data?.custom_google_allowed;
  const catalog = data?.catalog || {};

  return (
    <section className="rounded-md border border-border p-4 md:col-span-2">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Authentication</h3>
      <p className="text-[12px] text-muted-foreground/70">Sign-in options for this app's end users. Workspace SSO is configured separately.</p>
      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
      ) : data?.error ? (
        <p className="mt-3 text-[12px] text-amber-600">{data.error}</p>
      ) : (
        <div className="mt-3 space-y-4">
        {/* App Visibility — who can open the published app */}
        <div className="rounded-md border border-border p-3.5">
          <div className="text-[12.5px] font-medium">App visibility</div>
          <p className="mt-1 text-[11px] text-muted-foreground/70">Who can open this app. Public needs no sign-in; Private and Workspace require it.</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {[["public", "Public"], ["private", "Private"], ["workspace", "Workspace"]].map(([val, label]) => {
              const activeV = data?.visibility || "public";
              const on = activeV === val;
              return (
                <button
                  key={val}
                  type="button"
                  disabled={busy}
                  onClick={() => saveVisibility(val)}
                  className={`rounded-md px-3 py-1.5 text-[12px] font-medium border transition-colors disabled:opacity-50 ${on ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[10.5px] text-muted-foreground/70">Workspace mode admits only signed-in app users who are members of the owning workspace.</p>
        </div>
        {/* App-level SSO — Elite+ (platform owns the OIDC callback/exchange/session) */}
        <SsoSettingsCard project={project} />

        <div className="grid gap-4 md:grid-cols-2">
          {/* Google — custom OAuth credentials (Builder+) */}
          <div className="rounded-md border border-border p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium">{catalog.google?.label || "Google"}</span>
              <Switch
                checked={!!google.enabled}
                disabled={busy || !allowed}
                onCheckedChange={(v) => save({ google: { enabled: v, client_id: clientId } })}
              />
            </div>
            {!allowed && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600">
                <Lock className="h-3 w-3" />Custom Google OAuth requires the Builder plan or higher.
              </p>
            )}
            <label className="mt-3 block text-[11px] text-muted-foreground">Client ID</label>
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" className="mt-1 h-8 text-[12px]" />
            <Button size="sm" variant="outline" className="mt-2" disabled={busy || !clientId} onClick={() => save({ google: { enabled: google.enabled, client_id: clientId } })}>
              Save client ID
            </Button>
            <label className="mt-4 block text-[11px] text-muted-foreground">
              Client secret{" "}
              {data.google_secret_set && <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3 w-3" />set</span>}
            </label>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={data.google_secret_set ? "Replace the stored secret" : "Paste the Google client secret"} className="mt-1 h-8 text-[12px]" />
            <Button size="sm" variant="outline" className="mt-2" disabled={busy || !secret} onClick={storeSecret}>Store secret</Button>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground/70">Stored encrypted as a project secret — never displayed or returned to any client.</p>
          </div>

          {/* Platform-managed providers — known names, deliberately configured-off */}
          <div className="rounded-md border border-border p-3.5">
            <div className="text-[12.5px] font-medium">Other providers</div>
            <div className="mt-2 space-y-1.5">
              {["microsoft", "facebook", "apple"].map((p) => (
                <div key={p} className="flex items-center justify-between text-[12px]">
                  <span>{catalog[p]?.label || p}</span>
                  <span className="text-[11px] text-muted-foreground/70">Not available yet</span>
                </div>
              ))}
            </div>
            <p className="mt-2.5 text-[10.5px] text-muted-foreground/70">
              These use platform-managed credentials, which this deployment does not provide. They stay off rather than using invented credentials.
            </p>
          </div>
        </div>
        </div>
      )}
    </section>
  );
}