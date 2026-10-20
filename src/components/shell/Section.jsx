import React from "react";

// A product section: small label row + content. No card wrapper — composition
// and hierarchy carry the structure instead of nesting everything in cards.
export default function Section({ title, description, actions, children, className = "" }) {
  return (
    <section className={className}>
      {(title || actions) && (
        <div className="flex items-end gap-3 mb-3">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>}
            {description && <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p>}
          </div>
          {actions && <div className="ml-auto shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}