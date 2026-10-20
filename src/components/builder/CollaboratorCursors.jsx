import React, { useEffect, useState } from "react";

// Live collaborator cursors + element-selection indication drawn OVER the preview canvas. Reads
// only the ephemeral signal data already on each collaborator's actor-room connection (cursor +
// selection). No persistence, no project mutation. Cursor coords are iframe-viewport-relative
// (clientX/clientY inside the sandboxed srcdoc), so they map directly onto the same-sized wrapper.
// Selection boxes resolve the collaborator's {route, elementId} against the live iframe document
// (same-origin srcdoc → contentDocument is accessible) and render only when the route matches the
// current preview route — a route mismatch shows nothing (fail closed). Re-renders on resize and a
// 1s refresh so selection boxes track layout shifts; cursor positions update with the 1s poll.
const PALETTE = ["bg-brand", "bg-emerald-600", "bg-amber-600", "bg-rose-600", "bg-sky-600", "bg-violet-600"];
const colorFor = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return PALETTE[h % PALETTE.length];
};
const ringFor = (id) => {
  const map = ["#6366f1", "#059669", "#d97706", "#e11d48", "#0284c7", "#7c3aed"];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return map[h % map.length];
};

// Resolve a deterministic child-index path (as emitted by the preview picker) back to a live
// element inside the iframe document. Returns its bounding rect (iframe-viewport coords) or null.
function resolveElementRect(doc, elementId) {
  if (!doc || !elementId) return null;
  const parts = String(elementId).split("/");
  let node = doc.documentElement;
  for (const part of parts) {
    const idx = parseInt(part, 10);
    if (!Number.isFinite(idx) || !node || !node.children || !node.children[idx]) return null;
    node = node.children[idx];
  }
  return node ? node.getBoundingClientRect() : null;
}

export default function CollaboratorCursors({ collaborators, iframeRef, route, viewport }) {
  const [, force] = useState(0);

  // Track layout shifts so selection boxes stay aligned on resize / device-frame change.
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 1s refresh so selection boxes track in-iframe reflows that don't fire a parent resize.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const doc = iframeRef?.current?.contentDocument || null;
  const activeRoute = route || "/";

  const cursors = collaborators.filter((c) => c.cursor && (!c.cursor.route || c.cursor.route === activeRoute));
  const selections = collaborators.filter((c) => c.selection && c.selection.route === activeRoute && c.selection.elementId);

  return (
    <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden" aria-hidden="true">
      {selections.map((c) => {
        const rect = resolveElementRect(doc, c.selection.elementId);
        if (!rect) return null;
        const color = ringFor(c.id);
        return (
          <div
            key={`sel-${c.id}`}
            className="absolute rounded-[3px]"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              border: `2px solid ${color}`,
              boxShadow: `0 0 0 2px rgba(0,0,0,0.15)`,
              backgroundColor: "transparent",
            }}
          >
            <span
              className="absolute -top-[18px] left-0 max-w-[160px] truncate rounded px-1.5 py-0.5 text-[9px] font-medium text-white"
              style={{ backgroundColor: color }}
            >
              {c.name || c.id.slice(0, 6)}
            </span>
          </div>
        );
      })}
      {cursors.map((c) => {
        const color = ringFor(c.id);
        const x = Number(c.cursor.x);
        const y = Number(c.cursor.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return (
          <div key={`cur-${c.id}`} className="absolute" style={{ left: x, top: y, transform: "translate(-2px,-2px)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))" }}>
              <path d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z" fill={color} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span
              className="absolute left-[14px] top-[12px] max-w-[140px] truncate rounded px-1.5 py-0.5 text-[9.5px] font-medium text-white whitespace-nowrap"
              style={{ backgroundColor: color }}
            >
              {c.name || c.id.slice(0, 6)}
            </span>
          </div>
        );
      })}
    </div>
  );
}