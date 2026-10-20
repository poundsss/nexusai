import React, { useEffect, useState } from "react";
import { X, Maximize2, Loader2, AlertCircle } from "lucide-react";

// The ONE attachment preview strip, used by every composer: a thumbnail per image, its upload
// state, and a remove control so an image can be dropped before the prompt is sent. Hovering
// a finished thumbnail reveals two controls — maximize (open a large preview) and remove.
export default function AttachmentStrip({ items, onRemove, dark = false }) {
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e) => { if (e.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  if (!items.length) return null;
  const frame = dark ? "border-white/20 bg-white/10" : "border-border bg-muted";
  const close = dark ? "bg-neutral-900/90 text-white/70 hover:text-white" : "bg-background/90 text-muted-foreground hover:text-foreground";
  const overlay = dark ? "bg-black/50" : "bg-background/40";

  return (
    <>
      <div className="flex flex-wrap gap-2 px-3.5 pb-2">
        {items.map((item) => {
          const ready = (item.url || item.preview) && !item.error;
          return (
            <div
              key={item.id}
              className={`group relative h-14 w-14 overflow-hidden rounded-lg border ${frame}`}
            >
              <img src={item.preview} alt={item.name} className="h-full w-full object-cover" />
              {!item.url && !item.error && (
                <span className="absolute inset-0 grid place-items-center bg-background/60">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                </span>
              )}
              {item.error && (
                <span className="absolute inset-0 grid place-items-center bg-destructive/25" title={item.error}>
                  <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                </span>
              )}
              {ready && (
                <span className={`pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity ${overlay} group-hover:opacity-100`}>
                  <button
                    type="button"
                    onClick={() => setPreview(item.preview)}
                    aria-label={`Preview ${item.name}`}
                    title="Open large preview"
                    className="pointer-events-auto grid place-items-center text-foreground/90 hover:text-foreground"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                aria-label={`Remove ${item.name}`}
                className={`absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full ${close}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        })}
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6"
          onClick={() => setPreview(null)}
        >
          <img
            src={preview}
            alt="Preview"
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setPreview(null)}
            aria-label="Close preview"
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </>
  );
}