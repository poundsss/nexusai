import React, { useEffect, useRef } from "react";

// Auto-growing textarea for the chat composer: starts at 3 rows and grows with content
// up to 7 rows, then scrolls internally. Keeps the composer compact for short prompts
// while giving room for longer ones without manual resizing.
export default function AutoTextarea({ value, onChange, onPaste, onKeyDown, placeholder, className = "", ...rest }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={onPaste}
      onKeyDown={onKeyDown}
      rows={3}
      placeholder={placeholder}
      className={`w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60 ${className}`}
      style={{ maxHeight: "calc(1.625rem * 7 + 0.5rem)", minHeight: "calc(1.625rem * 2.7 + 0.5rem)" }}
      aria-label="Prompt input"
      {...rest}
    />
  );
}