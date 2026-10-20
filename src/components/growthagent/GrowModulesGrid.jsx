import React from "react";
import BrandIcon from "@/components/brand/BrandIcon";
import { LayoutDashboard } from "lucide-react";
import { GROW_MODULES } from "@/components/growthagent/growModules";

// The six Grow modules, all visible at once above the chat — adaptive grid (3 / 2 / 1 columns),
// each subcategory its own tile with its own icon. Clicking the module's header opens its
// module-specific dashboard (the real records behind the module); clicking a subcategory tile
// still opens that subcategory's launch-configuration dialog — both existing paths preserved.
function SubIcon({ sub }) {
  if (typeof sub.icon === "string") return <BrandIcon name={sub.icon} className="h-3.5 w-3.5 shrink-0" />;
  const Icon = sub.icon;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

export default function GrowModulesGrid({ onPick, onOpenModule }) {
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {GROW_MODULES.map((m) => (
        <div key={m.id} className="min-w-0 rounded-xl border border-border bg-card p-3.5 shadow-sm">
          <button
            type="button"
            onClick={() => onOpenModule(m)}
            title={`Open ${m.label} dashboard`}
            className="flex w-full items-center gap-2 rounded-lg text-left"
          >
            <m.icon className="h-4 w-4 shrink-0 text-brand" />
            <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{m.label}</p>
            <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {m.subs.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick({ module: m, sub: s })}
                title={s.blurb}
                className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
              >
                <SubIcon sub={s} />
                <span className="min-w-0 truncate">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}