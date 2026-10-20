import React, { useEffect, useState } from "react";
import Section from "@/components/shell/Section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import OperatorPermissionFields from "./OperatorPermissionFields";

// Analytics configuration for ONE application.
//
// Reads the existing `config` action and writes through `update_config`; the server decides whether
// the caller may do either (a read-only operator's save is refused and the refusal is shown as-is)
// and clamps every value it accepts. Only the fields the backend patch supports are offered here —
// nothing is invented client-side, and no credential or internal setting is displayed.
const FIELDS = ["enabled", "require_registered_schemas", "credential_policy", "suppressed_properties", "retention_days", "allow_platform_intelligence", "operator_permissions"];
const pick = (c) => Object.fromEntries(FIELDS.map((k) => [k, c?.[k]]));

export default function AnalyticsConfigSection({ query }) {
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setSaved(false);
    query("config")
      .then((d) => { if (!cancelled) { setForm(pick(d.config)); setError(null); } })
      .catch((e) => { if (!cancelled) { setForm(null); setError(e.response?.data?.error || e.message || "Configuration unavailable"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const d = await query("update_config", {
        ...form,
        retention_days: Number(form.retention_days) || 0,
        operator_permissions: form.operator_permissions || {},
        suppressed_properties: String(form.suppressed_properties || "").split(",").map((s) => s.trim()).filter(Boolean),
      });
      setForm(pick(d.config)); setSaved(true);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Could not save configuration");
    } finally { setSaving(false); }
  };

  if (loading && !form) {
    return <Section title="Configuration"><p className="text-[13px] text-muted-foreground">Loading configuration…</p></Section>;
  }
  if (!form) {
    return <Section title="Configuration"><p className="text-[13px] text-destructive">{error}</p></Section>;
  }

  const suppressed = Array.isArray(form.suppressed_properties) ? form.suppressed_properties.join(", ") : form.suppressed_properties || "";
  return (
    <Section title="Configuration" description="How this application's events are validated, scrubbed and retained.">
      <div className="rounded-lg border border-border divide-y divide-border/60">
        <Toggle label="Collect analytics" hint="When off, the runtime stops accepting new events." checked={!!form.enabled} onChange={(v) => set("enabled", v)} />
        <Toggle label="Require registered schemas" hint="Only event names with an active schema may be ingested." checked={!!form.require_registered_schemas} onChange={(v) => set("require_registered_schemas", v)} />
        <Toggle label="Allow platform intelligence" hint="Records your consent on every event. Nothing consumes it today." checked={!!form.allow_platform_intelligence} onChange={(v) => set("allow_platform_intelligence", v)} />
        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0">
            <Label className="text-[13px]">Credential-like properties</Label>
            <p className="text-[12px] text-muted-foreground mt-0.5">Values are never stored either way.</p>
          </div>
          <div className="ml-auto w-40">
            <Select value={form.credential_policy || "reject"} onValueChange={(v) => set("credential_policy", v)}>
              <SelectTrigger className="h-8 text-[12.5px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="reject">Reject the event</SelectItem>
                <SelectItem value="redact">Redact the value</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Field label="Suppressed properties" hint="Comma-separated property keys dropped at ingestion.">
          <Input className="h-8 text-[12.5px]" value={suppressed} onChange={(e) => set("suppressed_properties", e.target.value)} placeholder="email, phone" />
        </Field>
        <Field label="Retention (days)" hint="0 keeps events indefinitely. The maintenance sweep applies it.">
          <Input className="h-8 text-[12.5px]" type="number" min="0" value={form.retention_days ?? 90} onChange={(e) => set("retention_days", e.target.value)} />
        </Field>
        <OperatorPermissionFields value={form.operator_permissions} onChange={(v) => set("operator_permissions", v)} />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save configuration"}</Button>
        {saved && <span className="text-[12.5px] text-muted-foreground">Configuration saved.</span>}
        {error && <span className="text-[12.5px] text-destructive">{error}</span>}
      </div>
    </Section>
  );
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0">
        <Label className="text-[13px]">{label}</Label>
        <p className="text-[12px] text-muted-foreground mt-0.5">{hint}</p>
      </div>
      <div className="ml-auto"><Switch checked={checked} onCheckedChange={onChange} /></div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0">
        <Label className="text-[13px]">{label}</Label>
        <p className="text-[12px] text-muted-foreground mt-0.5">{hint}</p>
      </div>
      <div className="ml-auto w-48">{children}</div>
    </div>
  );
}