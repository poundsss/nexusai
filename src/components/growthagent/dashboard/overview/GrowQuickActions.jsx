import React from "react";
import { ArrowRight, Settings2, Search, Zap } from "lucide-react";

// Quick actions — only flows that already exist: open a module's own dashboard, or open the
// agent-side configure flow (GrowRequestDialog) for that module. No new mutations.
const ACTIONS = [
  { icon: ArrowRight, label: "Open Running Ads", hint: "Accounts, campaigns, weekly reports", open: "running_ads" },
  { icon: ArrowRight, label: "Open Cold Outreach", hint: "Email steps and calls", open: "cold_outreach" },
  { icon: Settings2, label: "Configure email domain", hint: "Certified configure flow", configure: "configure_email" },
  { icon: Zap, label: "Compose a growth request", hint: "Agent-side request composer", configure: "configure_ads" },
];

export default function GrowQuickActions({ onOpen, onConfigure, disabled }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {ACTIONS.map((a) => {
        const Icon = a.icon;
        return (
          <button key={a.label} type="button" disabled={disabled}
            onClick={() => (a.open ? onOpen(a.open) : onConfigure?.(a.configure))}
            className="group flex items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-foreground/25 disabled:opacity-50">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-semibold text-foreground">{a.label}</p>
              <p className="truncate text-[11px] text-muted-foreground">{a.hint}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}