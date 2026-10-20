import React, { useCallback, useEffect, useRef } from "react";

// Vertical drag handle between the chat/code panel and the preview. The chat panel sits on the
// LEFT, so dragging right widens it. Desktop-only (hidden below lg). Width lives in the parent
// and is persisted by it; this component just reports the requested new width during a drag.
export default function PanelResizer({ onResize, minWidth = 280, maxWidth = 760, currentWidth = 380 }) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(currentWidth);

  const onMouseDown = useCallback((e) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = currentWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  }, [currentWidth]);

  useEffect(() => {
    const move = (e) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const w = Math.max(minWidth, Math.min(maxWidth, startW.current + delta));
      onResize(w);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onResize, minWidth, maxWidth]);

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={() => onResize(380)}
      className="hidden lg:flex shrink-0 w-px relative cursor-col-resize group z-10 before:absolute before:inset-y-0 before:-inset-x-2 before:z-0"
      aria-label="Resize panel"
      title="Drag to resize · double-click to reset"
    >
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center h-5 w-2.5 rounded-sm bg-muted border border-border opacity-0 group-hover:opacity-100 group-hover:bg-accent group-hover:border-foreground/20 transition-all duration-150">
        <div className="grid grid-cols-2 gap-[1.5px]">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="block h-[1.5px] w-[1.5px] rounded-full bg-foreground/45" />
          ))}
        </div>
      </div>
    </div>
  );
}