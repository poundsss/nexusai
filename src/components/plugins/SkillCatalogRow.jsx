import React from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// One row in the "Browse by what you want to do" grid: key, description, catalog meta and
// the Activate action — matching Base44's browse list.
export default function SkillCatalogRow({ skill, activated, busy, onActivate }) {
  const isActivated = !!activated;
  return (
    <div className="flex flex-col rounded-lg border border-border p-3.5">
      <div className="text-[12.5px] font-semibold">/{skill.key}</div>
      <p className="text-[11.5px] text-muted-foreground leading-relaxed mt-1 flex-1">{skill.description}</p>
      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
          <Check className="h-3 w-3" />Base44 · Updated on {skill.updated}
        </span>
        <Button
          size="sm"
          variant={isActivated ? "secondary" : "outline"}
          disabled={isActivated || busy === skill.key}
          onClick={() => onActivate(skill)}
          className="h-6 px-2.5 text-[11px]"
        >
          {busy === skill.key ? <Loader2 className="h-3 w-3 animate-spin" />
            : isActivated ? <><Check className="h-3 w-3" />Activated</>
            : "Activate skill"}
        </Button>
      </div>
    </div>
  );
}