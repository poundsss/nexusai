import React, { useState, useRef, useEffect } from "react";
import { X, ChevronDown, Check, Info } from "lucide-react";
import { SparklePlus, ModelIcon } from "./ModelMarks";

// A single model dropdown for the compare modal. `allowAuto` controls whether the "Auto"
// router entry is offered (Model A yes, Model B no — B must be a concrete model).
function CompareSelect({ models, value, onChange, placeholder, allowAuto }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = allowAuto && !value ? { __auto: true } : models.find((m) => m.model_id === value);
  const label = selected?.__auto ? "Auto" : selected?.display_name || (value ? value : null);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 h-10 rounded-lg border border-border bg-card px-3 text-[13px] text-foreground hover:border-foreground/30 transition-colors"
      >
        {selected?.__auto ? (
          <span className="h-5 w-5 rounded-full bg-foreground grid place-items-center shrink-0">
            <SparklePlus className="h-3 w-3 text-background" />
          </span>
        ) : selected ? (
          <span className="shrink-0"><ModelIcon provider={selected.provider} display_name={selected.display_name} /></span>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}
        <span className={`flex-1 text-left truncate ${label ? "text-foreground" : "text-muted-foreground/60"}`}>
          {label || placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1.5 w-full rounded-xl border border-border bg-popover shadow-xl overflow-hidden max-h-64 overflow-y-auto">
          {allowAuto && (
            <button
              onClick={() => { onChange(null); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/60 transition-colors"
            >
              <span className="h-5 w-5 rounded-full bg-foreground grid place-items-center shrink-0">
                <SparklePlus className="h-3 w-3 text-background" />
              </span>
              <span className="flex-1 text-[13px] text-popover-foreground">Auto</span>
              {!value && <Check className="h-4 w-4 text-foreground shrink-0" />}
            </button>
          )}
          {models.map((m) => {
            const active = value === m.model_id;
            const disabled = false;
            return (
              <button
                key={m.model_id}
                onClick={() => { onChange(m.model_id); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/60 transition-colors"
              >
                <span className="shrink-0"><ModelIcon provider={m.provider} display_name={m.display_name} /></span>
                <span className="flex-1 text-[13px] text-popover-foreground truncate">{m.display_name}</span>
                {active && <Check className="h-4 w-4 text-foreground shrink-0" />}
              </button>
            );
          })}
          {models.length === 0 && !allowAuto && (
            <div className="px-3 py-3 text-[12px] text-muted-foreground">No models available</div>
          )}
        </div>
      )}
    </div>
  );
}

// Compare models pop-up: pick two models, then confirm to run the same prompt under both.
export default function CompareModal({ open, models, onClose, onSelect }) {
  const [a, setA] = useState(null); // null = Auto (allowed for A)
  const [b, setB] = useState(null); // required, concrete model
  useEffect(() => { if (open) { setA(null); setB(null); } }, [open]);
  if (!open) return null;

  const canSelect = !!b && a !== b;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[460px] rounded-2xl bg-card border border-border shadow-2xl overflow-hidden">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3.5 right-3.5 grid place-items-center h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Header */}
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-[19px] font-semibold tracking-tight text-foreground">Compare models</h2>
          <p className="mt-1 text-[14px] text-muted-foreground">Choose two models to compare</p>
        </div>
        <div className="h-px bg-border" />

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Model A</label>
            <CompareSelect models={models} value={a} onChange={setA} placeholder="Auto" allowAuto />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">Model B</label>
            <CompareSelect models={models} value={b} onChange={setB} placeholder="Choose a model" allowAuto={false} />
          </div>
          <div className="flex items-start gap-2.5 rounded-lg bg-muted px-3 py-2.5">
            <span className="mt-0.5 grid place-items-center h-4 w-4 rounded-full bg-muted-foreground/30 shrink-0">
              <Info className="h-2.5 w-2.5 text-foreground" />
            </span>
            <p className="text-[12.5px] text-foreground">Comparing builds your message twice, so it uses 2× credits</p>
          </div>
        </div>
        <div className="h-px bg-border" />

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-end gap-2.5">
          <button
            onClick={onClose}
            className="h-9 rounded-lg border border-border bg-card px-4 text-[13px] font-medium text-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!canSelect}
            onClick={() => canSelect && onSelect(a, b)}
            className="h-9 rounded-lg bg-foreground text-background px-4 text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}