import React from "react";

// Auth chrome for NexusAI: the same neutral surface, borders and type scale as the
// product shell — no gradients, no glow, no generic template card.
export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[380px]">
        {/* Wordmark */}
        <div className="flex items-center gap-2 mb-8">
          <span className="grid place-items-center h-7 w-7 rounded-md bg-foreground text-background">
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="text-[14px] font-semibold tracking-tight">NexusAI</span>
        </div>

        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-[13px] text-muted-foreground">{subtitle}</p>}

        <div className="mt-6">{children}</div>

        {footer && <p className="mt-6 text-[12.5px] text-muted-foreground">{footer}</p>}
      </div>
    </div>
  );
}