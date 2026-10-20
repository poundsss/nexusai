import React from "react";

// Consistent empty state across the product. Every empty surface gets an icon, a one-line
// explanation, a primary action, and an optional secondary action — never a blank box.
export default function EmptyState({ icon: Icon, title, description, action, secondary }) {
  return (
    <div className="flex flex-col items-center justify-center text-center rounded-xl border border-dashed border-border bg-muted/20 px-6 py-14">
      {Icon && (
        <span className="mb-4 grid place-items-center h-12 w-12 rounded-full bg-muted text-muted-foreground">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      <div className="mt-5 flex items-center gap-2.5">
        {action}
        {secondary}
      </div>
    </div>
  );
}