import React, { useLayoutEffect, useState } from "react";

// One outline for both surfaces: no overlapping borders or separately rounded junctions.
export default function GrowComposerOutline({ container }) {
  const [size, setSize] = useState(null);
  useLayoutEffect(() => {
    const tab = container?.querySelector(".grow-project-tab");
    if (!tab) return;
    const measure = () => {
      const box = container.getBoundingClientRect();
      const band = tab.getBoundingClientRect();
      setSize({ width: box.width, height: box.height, tabWidth: band.width, tabHeight: band.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(tab);
    return () => observer.disconnect();
  }, [container]);
  if (!size) return null;
  const { width, height, tabWidth, tabHeight } = size;
  const right = width - 0.5, bottom = height - 0.5, joinY = tabHeight + 0.5;
  const radius = Math.min(24, width / 4);
  const shoulder = 12, tabRight = tabWidth - 0.5;
  const top = `M 0.5 ${radius + 0.5} A ${radius} ${radius} 0 0 1 ${radius + 0.5} 0.5 H ${tabRight - radius} A ${radius} ${radius} 0 0 1 ${tabRight} ${radius + 0.5}`;
  const wide = width - tabWidth > shoulder + radius;
  const edge = wide
    ? `V ${joinY - shoulder} A ${shoulder} ${shoulder} 0 0 0 ${tabRight + shoulder} ${joinY} H ${right - radius} A ${radius} ${radius} 0 0 1 ${right} ${joinY + radius}`
    : "";
  const outline = `${top} ${edge} V ${bottom - radius} A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom} H ${radius + 0.5} A ${radius} ${radius} 0 0 1 0.5 ${bottom - radius} Z`;
  const band = `${top} ${wide ? `V ${joinY - shoulder} A ${shoulder} ${shoulder} 0 0 0 ${tabRight + shoulder} ${joinY}` : `V ${joinY}`} H 0.5 Z`;
  return (
    <svg aria-hidden="true" focusable="false" className="grow-composer-outline pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${width} ${height}`}>
      <path className="grow-composer-surface" d={outline} />
      <path className="grow-project-surface" d={band} />
    </svg>
  );
}