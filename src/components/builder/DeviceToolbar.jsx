import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Minus, Plus, Monitor, Smartphone, Tablet } from "lucide-react";
import { MODELS } from "./deviceModels";

// In-canvas toolbar that floats above the device frame: device-name dropdown (with the
// full model list + Custom + Desktop), the live dimensions, and zoom controls. Mirrors the
// reference screenshot. Only rendered when a device (not desktop) is the active viewport.
export default function DeviceToolbar({ viewport, onViewport, zoom, onZoom }) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [w, setW] = useState("");
  const [h, setH] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setCustomOpen(false); } };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const isDesktop = viewport === "desktop";
  const current = !isDesktop ? viewport : null;
  const isPhone = current && current.width < 600;
  const Icon = isDesktop ? Monitor : isPhone ? Smartphone : Tablet;
  const label = isDesktop ? "Desktop" : (current?.label || "Device");
  const dims = current ? `${current.width} × ${current.height}` : "Responsive";

  const select = (m) => { onViewport(m); setOpen(false); setCustomOpen(false); };
  const applyCustom = () => {
    const cw = parseInt(w, 10); const ch = parseInt(h, 10);
    if (cw > 0 && ch > 0) { onViewport({ label: `Custom ${cw}×${ch}`, width: cw, height: ch }); setOpen(false); setCustomOpen(false); setW(""); setH(""); }
  };

  // Floating pills — each element stands on its own, no shared bar or background strip.
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2">
      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/90 backdrop-blur px-2.5 py-1 text-[11.5px] text-foreground shadow-sm">
        <Icon className="h-3.5 w-3.5" />
        <div ref={ref} className="relative">
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 font-medium hover:opacity-80">
            <span className="max-w-[140px] truncate">{label}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
          {open && (
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-[60] w-64 rounded-xl border border-border bg-popover shadow-lg overflow-hidden">
              <div className="max-h-80 overflow-y-auto scrollbar-thin py-1">
                <button onClick={() => select("desktop")} className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors ${isDesktop ? "bg-muted text-foreground" : "hover:bg-muted text-foreground"}`}>
                  <span>Desktop</span>
                </button>
                <div className="my-1 h-px bg-border" />
                <button onClick={() => setCustomOpen((o) => !o)} className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-muted ${customOpen ? "bg-muted" : ""}`}>
                  <span className="font-medium text-foreground">Custom</span>
                  <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${customOpen ? "rotate-180" : ""}`} />
                </button>
                {customOpen && (
                  <div className="flex items-center gap-1.5 px-3 pb-2">
                    <input value={w} onChange={(e) => setW(e.target.value)} type="number" min="1" placeholder="W" className="h-7 w-16 rounded-md border border-border bg-background px-1.5 text-[11px] outline-none focus:border-foreground/30" />
                    <span className="text-muted-foreground text-[11px]">×</span>
                    <input value={h} onChange={(e) => setH(e.target.value)} type="number" min="1" placeholder="H" className="h-7 w-16 rounded-md border border-border bg-background px-1.5 text-[11px] outline-none focus:border-foreground/30" />
                    <button onClick={applyCustom} className="h-7 px-2 rounded-md bg-foreground text-background text-[11px] font-medium hover:opacity-90">Set</button>
                  </div>
                )}
                <div className="my-1 h-px bg-border" />
                {MODELS.map((m) => {
                  const active = current && current.label === m.label;
                  return (
                    <button key={m.label} onClick={() => select(m)} className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors ${active ? "bg-muted text-foreground" : "hover:bg-muted text-foreground"}`}>
                      <span className="text-[12px]">{m.label}</span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">{m.width}×{m.height}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <span className="rounded-lg border border-border bg-background/90 backdrop-blur px-2.5 py-1 text-[11px] text-foreground tabular-nums shadow-sm">{dims}</span>

      <div className="flex items-center gap-1 rounded-lg border border-border bg-background/90 backdrop-blur px-1.5 py-1 shadow-sm">
        <button onClick={() => onZoom(Math.max(25, zoom - 10))} aria-label="Zoom out" className="grid place-items-center h-5 w-5 rounded-md hover:bg-muted text-foreground">
          <Minus className="h-3 w-3" />
        </button>
        <span className="text-[11px] tabular-nums w-9 text-center">{zoom}%</span>
        <button onClick={() => onZoom(Math.min(200, zoom + 10))} aria-label="Zoom in" className="grid place-items-center h-5 w-5 rounded-md hover:bg-muted text-foreground">
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}