import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { GROW_MODULES } from "@/components/growthagent/growModules";

// Grow module tools grouped into collapsible sections; Connect opens the setup form.
function Group({ module, onConfigure }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between py-2 text-left">
        <span className="text-[13px] text-foreground">{module.label}</span>
        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {module.subs.length}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="mb-1 divide-y divide-border border-l border-border pl-3">
          {module.subs.map((s) => (
            <div key={s.id} className="flex items-center justify-between py-1.5">
              <span className="text-[12.5px] text-muted-foreground">{s.label}</span>
              <button type="button" onClick={() => onConfigure?.(s.id)}
                className="rounded-md border border-border px-2 py-0.5 text-[11.5px] text-foreground hover:bg-accent">
                Connect
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DashModuleTools({ onConfigure }) {
  return (
    <div className="divide-y divide-border border-t border-border">
      {GROW_MODULES.map((m) => <Group key={m.id} module={m} onConfigure={onConfigure} />)}
    </div>
  );
}