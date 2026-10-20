import React, { useState } from "react";
import { ChevronDown, Check, Palette, Hammer, MessageCircle } from "lucide-react";

export const MODES = [
  { id: "build", label: "Build", icon: Hammer, hint: "Start building immediately" },
  { id: "ask", label: "Ask", icon: MessageCircle, hint: "Discuss before building" },
];

// Build vs Ask selector for a composer toolbar.
export default function ModePicker({ mode, onChange, dark = false, iconOnly = false }) {
  const [open, setOpen] = useState(false);
  const active = MODES.find((m) => m.id === mode) || MODES[0];

  const trigger = dark
    ? "border-white/10 text-white/80 hover:text-white hover:border-white/25"
    : "border-border text-foreground hover:border-foreground/30";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 h-8 rounded-lg border px-2.5 text-[12.5px] transition-colors ${trigger}`}
        title={`Mode: ${active.label}`}
      >
        <Palette className="h-4 w-4" />
        {!iconOnly && <span>{active.label}</span>}
        <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 bottom-full mb-2 w-60 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl z-20">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onChange(m.id); setOpen(false); }}
              className="w-full flex items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-accent transition-colors"
            >
              <m.icon className="h-4 w-4 mt-0.5 shrink-0" />
              <span className="flex-1">
                <span className="block text-[13.5px] font-medium">{m.label}</span>
                <span className="block text-[12px] text-muted-foreground">{m.hint}</span>
              </span>
              {mode === m.id && <Check className="h-4 w-4 mt-0.5 text-brand" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}