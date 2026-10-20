import React, { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Lock, FileText, Zap } from "lucide-react";
import { Switch } from "@/components/ui/switch";

// The "…" more menu in the Builder composer toolbar. Opens upward so it never clips.
// Items here are ONLY functions that exist in the app:
//   - Auto approve  : project-scoped toggle (documented Base44), immediate, no Save.
//   - Custom Instructions : opens a textarea dialog (documented Base44). HIDDEN on a branch
//     per the doc ("Freeze Files and Custom Instructions apply to your main app").
//   - Freeze Files : jumps to the code view where per-file freeze exists.
// Auto approve is NOT hidden on a branch — its Base44 branch behavior is UNKNOWN, so it stays.
export default function BuilderMoreMenu({
  onFreezeFiles,
  autoApprove = false,
  onToggleAutoApprove,
  onCustomInstructions,
  onBranch = false,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  const run = (fn) => () => { setOpen(false); fn?.(); };

  return (
    <div className="relative ml-auto" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className="grid place-items-center h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 bottom-full mb-1.5 z-30 w-64 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {/* Auto approve — immediate toggle, no Save */}
          <div className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2">
            <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium leading-tight">Auto approve</div>
              <div className="text-[10.5px] text-muted-foreground leading-tight">Approve low-risk actions automatically</div>
            </div>
            <Switch
              checked={!!autoApprove}
              onCheckedChange={() => onToggleAutoApprove?.()}
              aria-label="Toggle Auto approve"
            />
          </div>

          {/* Custom Instructions — hidden on a branch */}
          {!onBranch && (
            <button
              type="button"
              role="menuitem"
              onClick={run(onCustomInstructions)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-accent transition-colors"
            >
              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span>Custom Instructions</span>
            </button>
          )}

          {/* Freeze Files — opens the multi-select picker. Hidden on a branch per the doc
              ("Freeze Files and Custom Instructions apply to your main app"). */}
          {!onBranch && (
            <button
              type="button"
              role="menuitem"
              onClick={run(onFreezeFiles)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-accent transition-colors"
            >
              <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span>Freeze Files</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}