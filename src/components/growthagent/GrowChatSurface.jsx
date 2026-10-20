import React, { useLayoutEffect, useRef } from "react";

// One continuous scrolling surface; only the input card floats above it.
export default function GrowChatSurface({ children, composer, scrollRef }) {
  const surfaceRef = useRef(null);
  const composerRef = useRef(null);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const input = composerRef.current;
    const measure = () => {
      surface.style.setProperty("--grow-composer-height", `${input.getBoundingClientRect().height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(input);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={surfaceRef} className="relative flex-1 min-h-0">
      <div ref={scrollRef} className="grow-chat-scroll h-full min-h-0 overflow-y-auto no-scrollbar px-4 sm:px-6">
        {children}
      </div>
      <div ref={composerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 sm:px-6 pt-3 pb-4">
        <div className="pointer-events-auto">{composer}</div>
      </div>
    </div>
  );
}