import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Optional operator permission overrides, stored on the project's analytics configuration.
//
// Each analytics permission key can require a DIFFERENT project-defined permission instead. The
// override is applied server-side when an app-user operator is authorized; a workspace operator is
// still authorized through the platform's own project capability, which no project can override.
const KEYS = [
  { key: "analytics.read", label: "Read analytics", hint: "Overview, events, sessions, funnels, retention, errors, performance." },
  { key: "analytics.export", label: "Export analytics", hint: "Downloading event rows." },
  { key: "analytics.manage", label: "Manage analytics", hint: "Configuration and event schemas." },
];

export default function OperatorPermissionFields({ value, onChange }) {
  const perms = value || {};
  const set = (key, v) => {
    const next = { ...perms };
    if (v.trim()) next[key] = v.trim(); else delete next[key];
    onChange(next);
  };
  return (
    <div className="px-4 py-3 space-y-3">
      <div>
        <Label className="text-[13px]">Operator permission overrides</Label>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          Leave blank to require the standard key. End-users hold none of these unless a role grants them.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {KEYS.map((k) => (
          <div key={k.key}>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{k.label}</Label>
            <Input
              className="mt-1 h-8 text-[12.5px] font-mono"
              value={perms[k.key] || ""}
              placeholder={k.key}
              onChange={(e) => set(k.key, e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground mt-1">{k.hint}</p>
          </div>
        ))}
      </div>
    </div>
  );
}