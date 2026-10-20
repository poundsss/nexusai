import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, Check, Split } from "lucide-react";
import { SparklePlus, ModelIcon } from "./ModelMarks";

// "Uses more credits" subtext for the costlier tiers, matching the reference.
function usesMoreCredits(m) {
  const t = (m.quality_tier || "").toLowerCase();
  // The advanced tier is the documented "may use more credits than Auto mode" surface
  // (Opus 5.5 / GPT-6 Astra / Claude Fable 5.1).
  return t === "premium" || t === "flagship" || t === "advanced";
}

// Model selector dropdown for the Builder chat. Lists real catalog models from the backend
// under an "Auto mode" header, with a Nexus AI "coming soon" entry at the bottom.
export default function ModelSelector({ models, value, onChange, disabled, dark = false, onCompare }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = models.find((m) => m.model_id === value);
  const label = !value ? "Auto" : selected?.display_name || value;
  const isAuto = !value;

  const trigger = dark
    ? "border-white/10 text-white/80 hover:text-white hover:border-white/25"
    : "border-border bg-background text-foreground hover:border-foreground/30";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 h-8 min-w-[68px] justify-between rounded-lg border px-2 text-[12px] font-medium transition-colors disabled:opacity-50 ${trigger}`}
        title={selected ? `${selected.display_name} · ${selected.quality_tier}` : "Router chooses the best model"}
      >
        <span className="max-w-[110px] truncate">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 z-50 w-72 rounded-xl border border-border bg-popover shadow-xl overflow-hidden">
          {/* Header */}
          <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-medium text-muted-foreground">Select model</div>

          {/* Auto mode */}
          <button
            onClick={() => { onChange(null); setOpen(false); }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-accent/60 transition-colors"
          >
            <span className="h-7 w-7 rounded-full bg-foreground grid place-items-center shrink-0">
              <SparklePlus className="h-3.5 w-3.5 text-background" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-popover-foreground">Auto mode</div>
              <div className="text-[11px] text-muted-foreground">Matched with the best AI model for each request</div>
            </div>
            {isAuto && <Check className="h-4 w-4 text-foreground shrink-0" />}
          </button>

          <div className="border-t border-border" />

          {/* Compare — pick two models to run side by side */}
          <button
            onClick={() => { setOpen(false); onCompare?.(); }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-accent/60 transition-colors"
          >
            <span className="h-7 w-7 grid place-items-center shrink-0 text-muted-foreground">
              <Split className="h-4 w-4" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-popover-foreground">Compare</div>
              <div className="text-[11px] text-muted-foreground">Choose two models to compare</div>
            </div>
          </button>

          <div className="border-t border-border" />

          {models.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-muted-foreground">No models available</div>
          ) : (
            <div className="py-1">
              {models.map((m) => {
                const active = value === m.model_id;
                return (
                  <button
                    key={m.model_id}
                    onClick={() => { onChange(m.model_id); setOpen(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/60 transition-colors"
                  >
                    <span className="h-7 w-7 grid place-items-center shrink-0">
                      <ModelIcon provider={m.provider} display_name={m.display_name} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] text-popover-foreground truncate">{m.display_name}</div>
                      {usesMoreCredits(m) && (
                        <div className="text-[11px] text-muted-foreground">Uses more credits</div>
                      )}
                    </div>
                    {active && <Check className="h-4 w-4 text-foreground shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}

          <div className="border-t border-border" />

          {/* Nexus AI — our own model, coming soon (not selectable yet) */}
          <div className="w-full flex items-center gap-2.5 px-3 py-2.5 opacity-70">
            <span className="h-7 w-7 rounded-full bg-gradient-to-br from-purple-500 to-indigo-500 grid place-items-center shrink-0">
              <SparklePlus className="h-3.5 w-3.5 text-white" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-popover-foreground">Nexus AI</div>
              <div className="text-[11px] text-muted-foreground">Our own model</div>
            </div>
            <span className="rounded-md bg-violet-100 px-1.5 py-0.5 text-[10.5px] font-medium text-indigo-600 dark:bg-violet-500/15 dark:text-indigo-300 shrink-0">
              coming soon
            </span>
          </div>
        </div>
      )}
    </div>
  );
}