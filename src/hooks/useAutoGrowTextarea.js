import { useLayoutEffect, useRef } from "react";

// Respect the frame's minimum and six-line maximum, including wrapped lines.
export default function useAutoGrowTextarea(value) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    };
    resize();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);
  return ref;
}