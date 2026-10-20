import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Registers or updates ONE event definition through the existing register_schema action.
//
// A name plus version identifies one definition: submitting an existing pair updates it, a new one
// creates it — exactly what the backend contract already does. Values are bounded and normalized
// server-side, so this only collects the fields that contract accepts.
const TYPES = ["page_view", "session_start", "session_end", "user_action", "conversion", "error", "performance", "custom_event"];
const EMPTY = { event_name: "", event_version: 1, event_type: "custom_event", status: "active", description: "", required_properties: "", property_types: "", strict: false };

// "page: string, count: number" → { page: "string", count: "number" }
const parseTypes = (text) => Object.fromEntries(String(text).split(",").map((p) => p.split(":").map((s) => s.trim())).filter(([k, v]) => k && v).map(([k, v]) => [k, v]));

export default function EventSchemaForm({ initial, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    ...EMPTY, ...(initial || {}),
    required_properties: (initial?.required_properties || []).join(", "),
    property_types: Object.entries(initial?.property_types || {}).map(([k, v]) => `${k}: ${v}`).join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setSaving(true); setError(null);
    try {
      await onSubmit({
        event_name: form.event_name.trim(),
        event_version: Number(form.event_version) || 1,
        event_type: form.event_type,
        status: form.status,
        description: form.description,
        required_properties: form.required_properties.split(",").map((s) => s.trim()).filter(Boolean),
        property_types: parseTypes(form.property_types),
        strict: !!form.strict,
      });
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Could not save the schema");
    } finally { setSaving(false); }
  };

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Row label="Event name">
          <Input className="h-8 text-[12.5px]" value={form.event_name} disabled={!!initial} onChange={(e) => set("event_name", e.target.value)} placeholder="checkout_completed" />
        </Row>
        <Row label="Version">
          <Input className="h-8 text-[12.5px]" type="number" min="1" value={form.event_version} disabled={!!initial} onChange={(e) => set("event_version", e.target.value)} />
        </Row>
        <Row label="Category">
          <Select value={form.event_type} onValueChange={(v) => set("event_type", v)}>
            <SelectTrigger className="h-8 text-[12.5px]"><SelectValue /></SelectTrigger>
            <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
          </Select>
        </Row>
        <Row label="Status">
          <Select value={form.status} onValueChange={(v) => set("status", v)}>
            <SelectTrigger className="h-8 text-[12.5px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active — accepts events</SelectItem>
              <SelectItem value="deprecated">Deprecated — refused at ingestion</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="Required properties">
          <Input className="h-8 text-[12.5px]" value={form.required_properties} onChange={(e) => set("required_properties", e.target.value)} placeholder="order_id, plan" />
        </Row>
        <Row label="Property types">
          <Input className="h-8 text-[12.5px]" value={form.property_types} onChange={(e) => set("property_types", e.target.value)} placeholder="order_id: string, total: number" />
        </Row>
        <Row label="Description">
          <Input className="h-8 text-[12.5px]" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="What this event means" />
        </Row>
        <div className="flex items-center gap-3 pt-1">
          <Switch checked={!!form.strict} onCheckedChange={(v) => set("strict", v)} />
          <Label className="text-[12.5px] text-muted-foreground">Strict — refuse undeclared properties</Label>
        </div>
      </div>
      {error && <p className="text-[12.5px] text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving || !form.event_name.trim()} onClick={submit}>{saving ? "Saving…" : initial ? "Update schema" : "Register schema"}</Button>
        <Button size="sm" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div>
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}