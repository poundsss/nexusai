import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

// Build / Plan mode selector. Trigger shows the ACTIVE mode label + chevron (matches the
// reference: "Build" ▾ next to the send button). The menu lists both options with a subtitle
// and a checkmark on the active one. Opens upward so it never clips against the composer bar.
const MODES = [
  { id: "build", label: "Build", hint: "Start building immediately" },
  { id: "ask", label: "Plan", hint: "Create a plan before building" },
];

export default function BuildModeMenu({ mode, onChange, dark = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active = MODES.find((m) => m.id === mode) || MODES[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  const trigger = dark
    ? "border-white/10 text-white/90 hover:border-white/25 bg-white/5"
    : "border-border text-foreground hover:border-foreground/30 bg-card";
  const panel = dark
    ? "bg-[#1c1c1c] border-white/10 text-white shadow-[0_24px_70px_-20px_rgba(0,0,0,0.8)]"
    : "bg-white border-[#e5e5e5] text-black shadow-[0_18px_50px_-20px_rgba(0,0,0,0.25)]";
  const rowHover = dark ? "hover:bg-white/[0.07]" : "hover:bg-black/[0.04]";
  const sub = dark ? "text-white/45" : "text-[#757575]";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Mode: ${active.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 h-8 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors ${trigger}`}
      >
        <span>{active.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute right-0 bottom-full mb-2 z-50 w-[240px] rounded-lg border p-1.5 ${panel}`}
        >
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              onClick={() => { onChange(m.id); setOpen(false); }}
              className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${rowHover}`}
            >
              <span className="flex-1">
                <span className="block text-[13.5px] font-semibold leading-tight">{m.label}</span>
                <span className={`block text-[12px] leading-tight mt-0.5 ${sub}`}>{m.hint}</span>
              </span>
              {mode === m.id && <Check className={`h-4 w-4 mt-0.5 shrink-0 ${dark ? "text-white/70" : "text-[#999]"}`} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}