import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Paperclip, Cable, Link as LinkIcon, FileInput, BookOpen, ChevronRight } from "lucide-react";

// Multicolor Figma mark (the lucide Figma icon is single-color; the reference uses the brand mark).
function FigmaMark({ className = "" }) {
  return (
    <svg viewBox="0 0 38 57" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0Z" fill="#1ABCFE" />
      <path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0Z" fill="#0ACF83" />
      <path d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19Z" fill="#FF7262" />
      <path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5Z" fill="#F24E1E" />
      <path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5Z" fill="#A259FF" />
    </svg>
  );
}

// The "+" trigger opens a two-group floating menu (Files and connections · Starting point).
// Each item routes to a real surface: Attach files → image picker, Add connector → Connections,
// Starting-point items seed the composer prompt (same pattern as the existing Figma chip).
export default function PlusMenu({ dark = false, onAttach, onStart }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  const trigger = dark
    ? "text-white/70 hover:text-white"
    : "text-muted-foreground hover:text-foreground";

  const panel = dark
    ? "bg-[#1c1c1c] border-white/10 text-white shadow-[0_24px_70px_-20px_rgba(0,0,0,0.8)]"
    : "bg-white border-[#e5e5e5] text-black shadow-[0_18px_50px_-20px_rgba(0,0,0,0.25)]";
  const heading = dark ? "text-white/40" : "text-[#666]";
  const sep = dark ? "bg-white/10" : "bg-[#e5e5e5]";
  const rowHover = dark ? "hover:bg-white/[0.07]" : "hover:bg-black/[0.04]";
  const iconWrap = dark ? "text-white/80" : "text-black";

  const run = (fn) => () => { setOpen(false); fn(); };

  const groups = [
    {
      label: "Files and connections",
      items: [
        { key: "attach", label: "Attach files", icon: Paperclip, chevron: true, action: () => onAttach?.() },
        { key: "connector", label: "Add connector", icon: Cable, action: () => navigate("/connections") },
      ],
    },
    {
      label: "Starting point",
      items: [
        { key: "url", label: "Start from URL", icon: LinkIcon, action: () => onStart?.("Build an app based on this URL: ") },
        { key: "migrate", label: "Migrate from another platform", icon: FileInput, action: () => onStart?.("Migrate an existing app from this platform: ") },
        { key: "figma", label: "Import from Figma", icon: FigmaMark, action: () => onStart?.("Build an app from this Figma design: ") },
        { key: "design-system", label: "Create a design system", icon: BookOpen, action: () => onStart?.("Create a design system for ") },
      ],
    },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Add"
        aria-label="Add"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`grid place-items-center h-8 w-8 rounded-lg transition-colors ${trigger}`}
      >
        <Plus className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute left-0 top-[calc(100%+6px)] z-50 w-[248px] rounded-lg border overflow-hidden ${panel}`}
        >
          {groups.map((g, gi) => (
            <div key={g.label}>
              {gi > 0 && <div className={`h-px w-full ${sep}`} />}
              <div className={`px-3 pt-2.5 pb-1 text-[11px] font-medium tracking-wide ${heading}`}>{g.label}</div>
              <div className="pb-1.5">
                {g.items.map((it) => {
                  const Icon = it.icon;
                  return (
                    <button
                      key={it.key}
                      type="button"
                      role="menuitem"
                      onClick={run(it.action)}
                      className={`group flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${rowHover}`}
                    >
                      <span className={`grid place-items-center h-4 w-4 shrink-0 ${iconWrap}`}>
                        <Icon className={it.key === "figma" ? "h-3.5 w-3.5" : "h-4 w-4"} />
                      </span>
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.chevron && <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${dark ? "text-white/40" : "text-[#999]"}`} />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}