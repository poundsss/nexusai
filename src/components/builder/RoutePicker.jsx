import React, { useEffect, useRef, useState } from "react";


// The app's address inside the Builder header: clicking it opens the project's REAL page
// list; choosing a page navigates the preview canvas to that route.
export default function RoutePicker({ pages, pathText, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  const routed = (pages || []).filter((p) => p.route);

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Pages"
        title="Open the app's page list"
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors min-w-0"
      >
        <span className="font-mono truncate max-w-[180px]">{pathText || "/projects/…"}</span>
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-40 w-[280px] rounded-lg border border-border bg-popover shadow-md overflow-hidden py-1">
          {routed.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-muted-foreground">No pages detected yet</p>
          ) : routed.map((p) => (
            <button
              key={p.file}
              onClick={() => { onSelect?.(p.route); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted transition-colors"
            >
              <span className="font-mono text-[11.5px] truncate">{p.route}</span>
              <span className="ml-auto text-[10.5px] text-muted-foreground truncate max-w-[110px]">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}