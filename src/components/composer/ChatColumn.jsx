import React from "react";

// Home's hero is content-sized, not a full 48rem-wide box. Its headline sets
// the intrinsic desktop width. Reuse that ruler without changing Home or
// letting long chat messages change the width of the conversation column.
export default function ChatColumn({ children, className = "" }) {
  return (
    <div className={`mx-auto w-full max-w-3xl sm:w-fit ${className}`}>
      <div aria-hidden="true" className="invisible h-0 overflow-hidden whitespace-nowrap text-[2.25rem] font-semibold tracking-tight leading-[1.05] sm:text-[3.25rem]">
        What will you build today?
      </div>
      <div className="min-w-0 [contain:inline-size]">{children}</div>
    </div>
  );
}