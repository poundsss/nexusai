import React from "react";
import { Loader2 } from "lucide-react";

// Shared chrome for account-level pages. A single dense toolbar row instead of a
// large heading block followed by empty space, so every surface reads the same way.
export default function AccountPage({ loading, title, subtitle, actions, children, maxW }) {
  const width = maxW || "max-w-6xl";
  return (
    <>
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className={`${width} mx-auto px-6 min-h-14 py-2.5 flex items-center gap-4`}>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold tracking-tight truncate">{title}</h1>
            {subtitle && <p className="text-[11.5px] text-muted-foreground truncate max-w-2xl">{subtitle}</p>}
          </div>
          {actions && <div className="ml-auto shrink-0">{actions}</div>}
        </div>
      </div>
      <div className={`${width} mx-auto px-6 py-6`}>
        {loading ? (
          <div className="py-20 flex justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          children
        )}
      </div>
    </>
  );
}