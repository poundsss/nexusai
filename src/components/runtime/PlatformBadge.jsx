import React from "react";

// Platform attribution badge rendered on the published-app HOST page (outside the sandboxed app
// iframe), shown only when the published runtime's `app.badge.visible` flag is true. The flag is
// decided server-side (projectBadge setting + Starter+ entitlement + private-app auto-hide), so
// this component never makes a visibility decision of its own — it only renders what the runtime
// authorized. Positioning is a fixed overlay anchored to the viewport so it floats above the app
// iframe regardless of the app's own layout.
export default function PlatformBadge() {
  return (
    <a
      href="https://base44.com"
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-3 right-3 z-[9999] flex items-center gap-1.5 rounded-full border border-black/10 bg-white/90 px-3 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm backdrop-blur-sm hover:bg-white transition-colors"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
        <path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      </svg>
      Made with Base44
    </a>
  );
}